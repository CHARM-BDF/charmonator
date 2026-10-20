// Tabulation (lib/tabulate.mjs) with a stub chat model: windows, prompt
// contents, provenance, key-based merging, schema repair, failed windows.

import { strict as assert } from 'assert';
import {
  mergeRows,
  normalizeTables,
  planWindows,
  replySchema,
  tabulateDocuments
} from '../lib/tabulate.mjs';
import { validateAgainstSchema } from '../lib/schema-validation.mjs';
import { Message, TranscriptFragment } from '../lib/transcript.mjs';

const TABLES = [{
  name: 'surgery',
  description: 'One row per tumor surgery.',
  key: ['surgery_date'],
  columns: [
    { name: 'surgery_date', type: 'date' },
    { name: 'extent', enum: ['Gross total', 'Partial', 'Biopsy only'] }
  ]
}];

function page(n, text, extra = {}) {
  return {
    id: `doc/pages@${n - 1}`,
    content: `<!-- METADATA page_number: ${n} -->\n${text}`,
    metadata: { page_number: n, originating_filename: 'binder.pdf', ...extra }
  };
}

const DOC = {
  id: 'sha-doc',
  metadata: { originating_filename: 'binder.pdf' },
  chunks: {
    pages: [
      page(1, 'Operative note. 2019-08-21: gross total resection.'),
      page(2, 'Discharge summary. s/p resection 2019-08-21.'),
      page(3, '', { transcription_failed: true }),
      page(4, 'Biopsy on 2021-02-03.')
    ]
  }
};

// A stub chat model: replies are produced by `respond(prompt, callIndex)`.
function stubFactory(respond) {
  const prompts = [];
  const factory = () => ({
    system: null,
    temperature: null,
    async extendTranscript(prefix) {
      const prompt = prefix.messages[prefix.messages.length - 1].content;
      prompts.push({ prompt, system: this.system });
      const reply = await respond(prompt, prompts.length - 1);
      return new TranscriptFragment([new Message('assistant', reply)]);
    }
  });
  return { factory, prompts };
}

function targetPagesOf(prompt) {
  return [...prompt.matchAll(/<target-page number="(\d+)">/g)].map(m => Number(m[1]));
}

describe('tabulate', function () {
  it('rejects malformed table specs', function () {
    assert.throws(() => normalizeTables([]), /non-empty/);
    assert.throws(() => normalizeTables([{ name: 'a b', columns: [{ name: 'x' }] }]), /identifier/);
    assert.throws(() => normalizeTables([{ name: 't', columns: [{ name: 'evidence' }] }]), /bad column/);
    assert.throws(() => normalizeTables([{ name: 't', columns: [{ name: 'x', type: 'blob' }] }]), /unknown type/);
    assert.throws(() => normalizeTables([{ name: 't', key: ['y'], columns: [{ name: 'x' }] }]), /not a column/);
  });

  it('builds a reply schema that admits nulls, enums and partial dates', function () {
    const schema = replySchema(normalizeTables(TABLES), [1]);
    const ok = { surgery: [{ surgery_date: '2019-08', extent: null, evidence: [{ page: 1, quote: 'q', columns: ['surgery_date'] }] }] };
    assert.deepEqual(validateAgainstSchema(ok, schema), []);
    const badDate = { surgery: [{ surgery_date: '08/21/2019', extent: null, evidence: [] }] };
    assert.notDeepEqual(validateAgainstSchema(badDate, schema), []);
    const badPage = { surgery: [{ surgery_date: null, extent: null, evidence: [{ page: 2, quote: 'q', columns: [] }] }] };
    assert.notDeepEqual(validateAgainstSchema(badPage, schema), []);
  });

  it('plans one window per page with a context page, skipping failed and empty pages', function () {
    const pages = DOC.chunks.pages.map((p, i) => ({
      number: i + 1, text: p.content, failed: Boolean(p.metadata.transcription_failed)
    }));
    const windows = planWindows(pages, { pagesPerWindow: 1, contextPagesBefore: 1 });
    assert.deepEqual(windows.map(w => w.target.map(p => p.number)), [[1], [2], [4]]);
    assert.deepEqual(windows.map(w => w.context.map(p => p.number)), [[], [1], []]);
  });

  it('extracts rows with provenance and merges rows that share a key', async function () {
    const { factory, prompts } = stubFactory((prompt) => {
      const [n] = targetPagesOf(prompt);
      const rows = {
        1: [{ surgery_date: '2019-08-21', extent: 'Gross total',
          evidence: [{ page: 1, quote: '2019-08-21: gross total resection', columns: ['surgery_date', 'extent'] }] }],
        2: [{ surgery_date: '2019-08-21', extent: null,
          evidence: [{ page: 2, quote: 's/p resection 2019-08-21', columns: ['surgery_date'] }] }],
        4: [{ surgery_date: '2021-02-03', extent: 'Biopsy only',
          evidence: [{ page: 4, quote: 'Biopsy on 2021-02-03', columns: ['surgery_date', 'extent'] }] }]
      }[n];
      return JSON.stringify({ surgery: rows });
    });

    const progress = [];
    const out = await tabulateDocuments({
      documents: [DOC], tables: TABLES, chatModelFactory: factory, instructions: 'Patient is synthetic.',
      onProgress: p => progress.push(p.windows_done)
    });

    assert.equal(out.windows_total, 3);
    assert.deepEqual(out.windows_failed, []);
    assert.deepEqual(progress.sort(), [1, 2, 3]);
    const rows = out.tables.surgery;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].values, { surgery_date: '2019-08-21', extent: 'Gross total' });
    assert.deepEqual(rows[0].provenance.surgery_date.map(e => e.page), [1, 2]);
    assert.deepEqual(rows[0].provenance.extent, [
      { document: 'sha-doc', filename: 'binder.pdf', page: 1, quote: '2019-08-21: gross total resection' }
    ]);
    assert.equal(rows[0].conflicts, undefined);

    // The prompt carries instructions, the table, the context page and the
    // target page, without conversion's METADATA lines.
    const second = prompts.find(p => targetPagesOf(p.prompt)[0] === 2).prompt;
    assert.match(second, /<instructions>\nPatient is synthetic\./);
    assert.match(second, /<table name="surgery">/);
    assert.match(second, /<context-page number="1">\nOperative note/);
    assert.doesNotMatch(second, /METADATA/);
    assert.match(prompts[0].system, /TARGET pages/);
  });

  it('records conflicting values instead of overwriting', function () {
    const [spec] = normalizeTables(TABLES);
    const merged = mergeRows([
      { values: { surgery_date: '2019-08-21', extent: 'Gross total' }, provenance: { extent: [{ page: 1 }] } },
      { values: { surgery_date: '2019-08-21 ', extent: 'Partial' }, provenance: { extent: [{ page: 2 }] } },
      { values: { surgery_date: null, extent: 'Partial' }, provenance: {} }
    ], spec);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].values.extent, 'Gross total');
    assert.deepEqual(merged[0].conflicts, { extent: ['Partial'] });
    assert.deepEqual(merged[0].provenance.extent.map(e => e.page), [1, 2]);
  });

  it('repairs an invalid reply, and reports a window that never validates', async function () {
    const { factory, prompts } = stubFactory((prompt) => {
      const [n] = targetPagesOf(prompt);
      if (prompt.includes('ValidationErrors')) {
        return JSON.stringify({ surgery: [] });
      }
      if (n === 1) return '{"surgery": [{"surgery_date": "Aug 21"}]}';
      if (n === 2) return JSON.stringify({ surgery: [] });
      return 'not json';
    });
    const out = await tabulateDocuments({
      documents: [DOC], tables: TABLES, chatModelFactory: factory, concurrency: 1
    });
    // Page 1's reply was repaired; page 4's "not json" was too, since the
    // repair prompt is answered with a valid reply. Nothing failed.
    assert.deepEqual(out.windows_failed, []);
    assert.ok(prompts.some(p => p.prompt.includes('ValidationErrors')));

    const { factory: alwaysBad } = stubFactory(() => 'not json');
    const failed = await tabulateDocuments({
      documents: [DOC], tables: TABLES, chatModelFactory: alwaysBad, concurrency: 2
    });
    assert.equal(failed.windows_failed.length, 3);
    assert.deepEqual(failed.windows_failed.map(f => f.pages).sort(), [[1], [2], [4]]);
    assert.deepEqual(failed.tables.surgery, []);
  });

  it('drops duplicate enum values, and checks the schema before any model call', async function () {
    const [spec] = normalizeTables([{ name: 't', columns: [{ name: 'x', enum: ['a', 'b', 'a'] }] }]);
    assert.deepEqual(spec.columns[0].enum, ['a', 'b']);
    let called = 0;
    const factory = () => ({ async extendTranscript() { called += 1; throw new Error('unreachable'); } });
    await assert.rejects(
      tabulateDocuments({
        documents: [DOC], chatModelFactory: factory,
        // Equal objects survive Set-based de-duplication but still make the enum invalid.
        tables: [{ name: 't', columns: [{ name: 'x', enum: [{ v: 1 }, { v: 1 }] }] }]
      }),
      /invalid JSON schema/
    );
    assert.equal(called, 0);
  });

  it('requires documents with pages', async function () {
    await assert.rejects(
      tabulateDocuments({ documents: [{ id: 'x' }], tables: TABLES, chatModelFactory: () => ({}) }),
      /chunks\.pages/
    );
  });
});
