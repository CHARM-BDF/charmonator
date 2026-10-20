// File: lib/tabulate.mjs
//
// Tabulation: read converted documents (the output of /conversions/documents)
// page by page and extract rows for a set of tables, with every cell traced
// to the page and the quoted text it came from. Apps use it to turn records
// into a fixed table format (see docs/tabulate.md).

import { fetchChatModel } from './core.mjs';
import { callLLM } from '../routes/charmonizer/document-summarize.mjs';

const COLUMN_TYPES = {
  string: 'string',
  integer: 'integer',
  number: 'number',
  boolean: 'boolean',
  // Dates are strings: models get them right more often than ages or offsets,
  // and callers can compute those in code.
  date: 'string'
};

const DATE_PATTERN = '^\\d{4}(-\\d{2}(-\\d{2})?)?$';

const SYSTEM_PROMPT = `
You extract structured rows from the pages of clinical documents.

You will be given one or more TARGET pages, possibly preceded by CONTEXT pages, and a set of tables.
For each table, return one row for each distinct thing the table describes that the TARGET pages state.

Rules:
 - Record only what the TARGET pages state. Context pages are there to help you read the target pages; do not extract rows from them.
 - A page that mentions a past event (for example "status post resection on 2019-08-21") does state that event: extract it.
 - Never guess. Use null for any column the target pages do not state.
 - Dates are YYYY-MM-DD, or YYYY-MM or YYYY when only part of the date is stated.
 - Where a column lists permitted values, use one of them exactly, or null.
 - Every row needs evidence: short quotes copied verbatim from a target page, each naming the target page it is on and the columns it supports. Every non-null column must be supported by at least one quote.
 - If the target pages say nothing for a table, return an empty array for it.

Reply with JSON only, matching the schema you are given.
`.trim();

/**
 * Validate a table spec and fill in defaults. Throws on a malformed spec.
 *
 * A table is { name, description?, instructions?, key?: [column names],
 * columns: [{ name, type?, description?, enum? }] }. Column types are string
 * (the default), integer, number, boolean or date. `key` names the columns that
 * identify a row; rows from different pages with equal keys are merged.
 */
export function normalizeTables(tables) {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error('tables must be a non-empty array');
  }
  const seen = new Set();
  return tables.map(t => {
    if (!t?.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name)) {
      throw new Error(`table name must be an identifier: ${JSON.stringify(t?.name)}`);
    }
    if (seen.has(t.name)) throw new Error(`duplicate table: ${t.name}`);
    seen.add(t.name);
    if (!Array.isArray(t.columns) || t.columns.length === 0) {
      throw new Error(`table ${t.name} has no columns`);
    }
    const colNames = new Set();
    const columns = t.columns.map(c => {
      if (!c?.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) || c.name === 'evidence') {
        throw new Error(`table ${t.name}: bad column name ${JSON.stringify(c?.name)}`);
      }
      if (colNames.has(c.name)) throw new Error(`table ${t.name}: duplicate column ${c.name}`);
      colNames.add(c.name);
      const type = c.type || 'string';
      if (!COLUMN_TYPES[type]) throw new Error(`table ${t.name}: column ${c.name} has unknown type ${type}`);
      return { name: c.name, type, description: c.description || '', enum: c.enum || null };
    });
    const key = t.key || [];
    for (const k of key) {
      if (!colNames.has(k)) throw new Error(`table ${t.name}: key column ${k} is not a column`);
    }
    return { name: t.name, description: t.description || '', instructions: t.instructions || '', key, columns };
  });
}

function columnSchema(col) {
  const s = { type: [COLUMN_TYPES[col.type], 'null'] };
  if (col.type === 'date') s.pattern = DATE_PATTERN;
  if (col.enum) s.enum = [...col.enum, null];
  return s;
}

/**
 * The JSON schema one model reply must satisfy: an array of rows per table,
 * each row carrying its columns plus `evidence`.
 */
export function replySchema(tables, targetPages) {
  const properties = {};
  for (const t of tables) {
    const rowProps = {};
    for (const c of t.columns) rowProps[c.name] = columnSchema(c);
    rowProps.evidence = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'quote', 'columns'],
        properties: {
          page: { type: 'integer', enum: targetPages },
          quote: { type: 'string' },
          columns: { type: 'array', items: { type: 'string', enum: t.columns.map(c => c.name) } }
        }
      }
    };
    properties[t.name] = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...t.columns.map(c => c.name), 'evidence'],
        properties: rowProps
      }
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: tables.map(t => t.name),
    properties
  };
}

function describeTables(tables) {
  return tables.map(t => {
    const cols = t.columns.map(c => {
      let line = ` - ${c.name} (${c.type})`;
      if (c.description) line += `: ${c.description}`;
      if (c.enum) line += ` Permitted values: ${c.enum.map(v => JSON.stringify(v)).join(', ')}.`;
      return line;
    }).join('\n');
    let text = `<table name="${t.name}">\n`;
    if (t.description) text += `${t.description}\n`;
    if (t.instructions) text += `${t.instructions}\n`;
    text += `Columns:\n${cols}\n</table>`;
    return text;
  }).join('\n\n');
}

// Page text without the `<!-- METADATA ... -->` lines conversion prepends.
function pageText(page) {
  return String(page.content || '')
    .split('\n')
    .filter(line => !/^<!-- METADATA .* -->$/.test(line.trim()))
    .join('\n')
    .trim();
}

function pagesOf(doc) {
  const pages = doc?.chunks?.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('document has no chunks.pages (convert it with /conversions/documents first)');
  }
  return pages.map((p, i) => ({
    number: p.metadata?.page_number ?? i + 1,
    text: pageText(p),
    failed: Boolean(p.metadata?.transcription_failed)
  }));
}

/**
 * Plan the model calls for one document: windows of `pagesPerWindow` target
 * pages, each preceded by up to `contextPagesBefore` context pages.
 */
export function planWindows(pages, { pagesPerWindow = 1, contextPagesBefore = 1 } = {}) {
  const windows = [];
  for (let i = 0; i < pages.length; i += pagesPerWindow) {
    const target = pages.slice(i, i + pagesPerWindow).filter(p => !p.failed && p.text);
    if (target.length === 0) continue;
    const context = pages.slice(Math.max(0, i - contextPagesBefore), i).filter(p => !p.failed && p.text);
    windows.push({ target, context });
  }
  return windows;
}

function windowPrompt(window, tables, schema, instructions) {
  const parts = [];
  if (instructions) parts.push(`<instructions>\n${instructions}\n</instructions>`);
  parts.push(`<tables>\n${describeTables(tables)}\n</tables>`);
  for (const p of window.context) {
    parts.push(`<context-page number="${p.number}">\n${p.text}\n</context-page>`);
  }
  for (const p of window.target) {
    parts.push(`<target-page number="${p.number}">\n${p.text}\n</target-page>`);
  }
  parts.push(`<schema>\n${JSON.stringify(schema)}\n</schema>`);
  return parts.join('\n\n');
}

function parseReply(text) {
  const cleaned = String(text ?? '').trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function normKey(v) {
  if (v === null || v === undefined) return null;
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Merge rows that share a key. The first non-null value of each column wins;
 * a later, different non-null value is kept under `conflicts`. Rows with any
 * null key column, and all rows of a table without a key, are kept as they are.
 */
export function mergeRows(rows, table) {
  if (!table.key.length) return rows;
  const out = [];
  const byKey = new Map();
  for (const row of rows) {
    const keyVals = table.key.map(k => normKey(row.values[k]));
    if (keyVals.some(v => v === null)) {
      out.push(row);
      continue;
    }
    const k = JSON.stringify(keyVals);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, row);
      out.push(row);
      continue;
    }
    for (const c of table.columns) {
      const a = existing.values[c.name];
      const b = row.values[c.name];
      if (b === null || b === undefined) continue;
      if (a === null || a === undefined) {
        existing.values[c.name] = b;
      } else if (normKey(a) !== normKey(b)) {
        existing.conflicts ??= {};
        existing.conflicts[c.name] ??= [];
        if (!existing.conflicts[c.name].some(v => normKey(v) === normKey(b))) {
          existing.conflicts[c.name].push(b);
        }
      }
    }
    for (const [col, ev] of Object.entries(row.provenance)) {
      existing.provenance[col] = [...(existing.provenance[col] || []), ...ev];
    }
  }
  return out;
}

/**
 * Extract rows for `tables` from converted documents.
 *
 * @param {Object} args
 * @param {Object[]} args.documents - converted documents (each with chunks.pages)
 * @param {Object[]} args.tables - table specs (see normalizeTables)
 * @param {string} [args.model] - model name; or pass `chatModelFactory`
 * @param {Function} [args.chatModelFactory] - () => chat model (tests, custom setups)
 * @param {string} [args.instructions] - extra instructions for every call
 * @param {number} [args.pagesPerWindow=1]
 * @param {number} [args.contextPagesBefore=1]
 * @param {number} [args.concurrency=4]
 * @param {number} [args.temperature] - unset by default: the model's configured
 *   default applies (some models reject an explicit temperature)
 * @param {Function} [args.onProgress] - ({windows_total, windows_done}) => void
 *
 * @returns {Promise<Object>} { tables: { <name>: [{ values, provenance, conflicts? }] },
 *   windows_total, windows_failed: [{ document, pages, error }] }.
 *   provenance maps each non-null column to [{ document, filename, page, quote }].
 */
export async function tabulateDocuments({
  documents,
  tables,
  model,
  chatModelFactory,
  instructions = '',
  pagesPerWindow = 1,
  contextPagesBefore = 1,
  concurrency = 4,
  temperature = null,
  onProgress = null
}) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('documents must be a non-empty array');
  }
  const specs = normalizeTables(tables);
  const makeModel = chatModelFactory || (() => fetchChatModel(model));
  if (!chatModelFactory && !model) throw new Error('model is required');

  const jobs = [];
  for (const doc of documents) {
    const docId = doc.id || doc.metadata?.document_sha256 || null;
    const filename = doc.metadata?.originating_filename || null;
    for (const w of planWindows(pagesOf(doc), { pagesPerWindow, contextPagesBefore })) {
      jobs.push({ docId, filename, window: w });
    }
  }

  let done = 0;
  const windowsFailed = [];
  const perWindow = await mapWithConcurrency(jobs, concurrency, async (job) => {
    const targetPages = job.window.target.map(p => p.number);
    const schema = replySchema(specs, targetPages);
    const chatModel = makeModel();
    chatModel.system = SYSTEM_PROMPT;
    if (temperature != null) chatModel.temperature = temperature;
    try {
      const reply = await callLLM(chatModel, [
        { role: 'user', content: windowPrompt(job.window, specs, schema, instructions) }
      ], {
        response_format: { type: 'json_schema', json_schema: { name: 'tabulation', schema } },
        num_schema_repair_max_attempts: 2,
        num_defective_reply_max_attempts: 2
      });
      return { job, parsed: parseReply(reply) };
    } catch (err) {
      windowsFailed.push({
        document: job.docId,
        pages: targetPages,
        error: err?.interpretedMessage || err?.message || String(err)
      });
      return { job, parsed: null };
    } finally {
      done += 1;
      if (onProgress) onProgress({ windows_total: jobs.length, windows_done: done });
    }
  });

  const result = {};
  for (const t of specs) {
    const rows = [];
    for (const { job, parsed } of perWindow) {
      for (const raw of parsed?.[t.name] || []) {
        const values = {};
        const provenance = {};
        for (const c of t.columns) values[c.name] = raw[c.name] ?? null;
        for (const ev of raw.evidence || []) {
          for (const col of ev.columns || []) {
            if (values[col] === null || values[col] === undefined) continue;
            (provenance[col] ??= []).push({
              document: job.docId, filename: job.filename, page: ev.page, quote: ev.quote
            });
          }
        }
        rows.push({ values, provenance });
      }
    }
    result[t.name] = mergeRows(rows, t);
  }

  return { tables: result, windows_total: jobs.length, windows_failed: windowsFailed };
}
