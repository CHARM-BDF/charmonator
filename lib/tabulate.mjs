// File: lib/tabulate.mjs
//
// Tabulation: read converted documents (the output of /conversions/documents)
// page by page and extract rows for a set of tables, with every cell traced
// to the page and the quoted text it came from. Apps use it to turn records
// into a fixed table format (see docs/tabulate.md).

import { fetchChatModel } from './core.mjs';
import { callLLM } from '../routes/charmonizer/document-summarize.mjs';
import { validateAgainstSchema } from './schema-validation.mjs';
import crypto from 'crypto';
import { getCacheStore, resolveCachePolicy } from './result-cache.mjs';

// Tag for tabulation entries in the result cache (conversion entries use their own).
const CACHE_FORMAT = 'charmd-tabulate-v1';

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
      // Duplicate choices make the reply schema invalid; source lists do repeat values.
      return { name: c.name, type, description: c.description || '', enum: c.enum ? [...new Set(c.enum)] : null };
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

function usable(p) {
  return !p.failed && p.text;
}

function toPage(p, i) {
  return {
    number: p.number ?? p.metadata?.page_number ?? i + 1,
    text: p.text ?? pageText(p),
    failed: Boolean(p.failed ?? p.metadata?.transcription_failed)
  };
}

// The rows of one parsed reply, with provenance pointing at this window's document.
function rowsFromReply(parsed, specs, docId, filename) {
  const out = {};
  for (const t of specs) {
    out[t.name] = (parsed?.[t.name] || []).map(raw => {
      const values = {};
      const provenance = {};
      for (const c of t.columns) values[c.name] = raw[c.name] ?? null;
      for (const ev of raw.evidence || []) {
        for (const col of ev.columns || []) {
          if (values[col] === null || values[col] === undefined) continue;
          (provenance[col] ??= []).push({ document: docId, filename, page: ev.page, quote: ev.quote });
        }
      }
      return { values, provenance };
    });
  }
  return out;
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/**
 * An incremental tabulator: feed it pages as they are converted (addPage), and
 * it reads each window as soon as the window's pages are in, `concurrency` at
 * a time. `finish()` waits for every window and returns what tabulateDocuments
 * returns. Same options as tabulateDocuments, plus:
 *
 * @param {Function} [args.onWindow] - called after each window with
 *   { document, filename, pages, rows: { <table>: [{ values, provenance }] }, cached },
 *   the rows before merging, for showing facts as they are found
 * @param {string} [args.cache] - 'use' | 'refresh' | 'off' (default: CHARMD_CACHE).
 *   With 'use', a window whose model, prompt and schema were read before is
 *   answered from charmd's result cache with no model call, so a recorded run
 *   can be replayed. Off when only `chatModelFactory` is given.
 */
export function createTabulator({
  tables,
  model,
  chatModelFactory,
  instructions = '',
  pagesPerWindow = 1,
  contextPagesBefore = 1,
  concurrency = 4,
  temperature = null,
  cache,
  onWindow = null,
  onProgress = null
}) {
  const specs = normalizeTables(tables);
  // A schema that does not compile would otherwise surface as every reply
  // "failing validation", after a full round of model calls and repairs.
  try {
    validateAgainstSchema({}, replySchema(specs, [1]));
  } catch (err) {
    throw new Error(`table spec produces an invalid JSON schema: ${err.message}`);
  }
  if (!chatModelFactory && !model) throw new Error('model is required');
  const makeModel = chatModelFactory || (() => fetchChatModel(model));

  const resolved = resolveCachePolicy(cache);
  if (resolved.error) throw new Error(resolved.error);
  let cachePolicy = model ? resolved.policy : 'off';
  if (cachePolicy !== 'off' && !getCacheStore()) {
    if (resolved.explicit) throw new Error('cache requested but no cache store is configured (set CHARMD_CACHE_DIR or CHARMD_CACHE_S3_URI)');
    cachePolicy = 'off';
  }

  const run = limiter(Math.max(1, concurrency));
  const docs = new Map();
  const pending = [];
  const results = [];
  const windowsFailed = [];
  let total = 0;
  let done = 0;
  let finished = false;

  const cacheKey = (prompt, schema) => crypto.createHash('sha256')
    .update(JSON.stringify([CACHE_FORMAT, String(model), temperature, SYSTEM_PROMPT, prompt, schema]))
    .digest('hex');

  async function readWindow(doc, window) {
    const targetPages = window.target.map(p => p.number);
    const schema = replySchema(specs, targetPages);
    const prompt = windowPrompt(window, specs, schema, instructions);
    const key = cachePolicy === 'off' ? null : cacheKey(prompt, schema);
    let parsed = null;
    let cached = false;
    try {
      if (cachePolicy === 'use') {
        const entry = await getCacheStore().get(key).catch(() => null);
        if (entry?.format === CACHE_FORMAT && entry.reply) {
          parsed = entry.reply;
          cached = true;
        }
      }
      if (!parsed) {
        const chatModel = makeModel();
        chatModel.system = SYSTEM_PROMPT;
        if (temperature != null) chatModel.temperature = temperature;
        const reply = await callLLM(chatModel, [{ role: 'user', content: prompt }], {
          response_format: { type: 'json_schema', json_schema: { name: 'tabulation', schema } },
          num_schema_repair_max_attempts: 2,
          num_defective_reply_max_attempts: 2
        });
        parsed = parseReply(reply);
        if (key) {
          await getCacheStore().put(key, { format: CACHE_FORMAT, created_at: new Date().toISOString(), model, reply: parsed })
            .catch(err => console.warn(JSON.stringify({ event: 'tabulate cache store failed', err: err?.name })));
        }
      }
      const rows = rowsFromReply(parsed, specs, doc.id, doc.filename);
      results.push({ seq: window.seq, rows });
      if (onWindow) {
        try {
          onWindow({ document: doc.id, filename: doc.filename, pages: targetPages, rows, cached });
        } catch (err) {
          console.warn(JSON.stringify({ event: 'onWindow callback failed', err: err?.message }));
        }
      }
    } catch (err) {
      windowsFailed.push({ document: doc.id, pages: targetPages, error: err?.interpretedMessage || err?.message || String(err) });
    } finally {
      done += 1;
      if (onProgress) onProgress({ windows_total: total, windows_done: done });
    }
  }

  function schedule(doc, slotStart) {
    const slot = doc.pages.slice(slotStart, slotStart + pagesPerWindow);
    const target = slot.filter(usable);
    if (!target.length) return;
    const context = doc.pages.slice(Math.max(0, slotStart - contextPagesBefore), slotStart).filter(usable);
    total += 1;
    const window = { target, context, seq: [doc.index, slotStart] };
    pending.push(run(() => readWindow(doc, window)));
  }

  function docFor(document) {
    const id = document?.id ?? document?.metadata?.document_sha256 ?? null;
    if (!docs.has(id)) {
      docs.set(id, { id, index: docs.size, filename: document?.filename ?? document?.metadata?.originating_filename ?? null,
        pages: [], scheduled: 0, ended: false });
    }
    return docs.get(id);
  }

  const tabulator = {
    /** Add a document's next page (a conversion page chunk, or { number, text }). Pages must come in order. */
    addPage(document, page) {
      if (finished) throw new Error('tabulator already finished');
      const doc = docFor(document);
      if (doc.ended) throw new Error('document already ended');
      doc.pages.push(toPage(page, doc.pages.length));
      while (doc.pages.length - doc.scheduled >= pagesPerWindow) {
        schedule(doc, doc.scheduled);
        doc.scheduled += pagesPerWindow;
      }
    },
    /** No more pages for this document: read any partial last window. */
    endDocument(document) {
      const doc = docFor(document);
      if (doc.ended) return;
      if (doc.scheduled < doc.pages.length) schedule(doc, doc.scheduled);
      doc.scheduled = doc.pages.length;
      doc.ended = true;
    },
    /** Add a whole converted document (chunks.pages) and end it. */
    addDocument(document) {
      const pages = document?.chunks?.pages;
      if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error('document has no chunks.pages (convert it with /conversions/documents first)');
      }
      pages.forEach(p => tabulator.addPage(document, p));
      tabulator.endDocument(document);
    },
    /** Wait for every window; merge rows per table. */
    async finish() {
      for (const doc of docs.values()) tabulator.endDocument({ id: doc.id });
      finished = true;
      await Promise.all(pending);
      results.sort((a, b) => a.seq[0] - b.seq[0] || a.seq[1] - b.seq[1]);
      const merged = {};
      for (const t of specs) merged[t.name] = mergeRows(results.flatMap(r => r.rows[t.name]), t);
      return { tables: merged, windows_total: total, windows_failed: windowsFailed };
    }
  };
  return tabulator;
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
 * Also `cache` and `onWindow`, as for createTabulator.
 *
 * @returns {Promise<Object>} { tables: { <name>: [{ values, provenance, conflicts? }] },
 *   windows_total, windows_failed: [{ document, pages, error }] }.
 *   provenance maps each non-null column to [{ document, filename, page, quote }].
 */
export async function tabulateDocuments({ documents, ...options }) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('documents must be a non-empty array');
  }
  const tabulator = createTabulator(options);
  for (const doc of documents) tabulator.addDocument(doc);
  return tabulator.finish();
}
