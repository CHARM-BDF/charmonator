# Tabulation

`lib/tabulate.mjs` reads converted documents page by page and extracts rows for a set of tables you define, tracing every cell to the page and the quoted text it came from. It is a library for apps (see [apps.md](apps.md#apps-outside-the-charmd-tree)), not an HTTP endpoint: an app supplies its own tables and turns the rows into whatever format it serves.

```javascript
const { tabulateDocuments } = await ctx.importCharmd('lib/tabulate.mjs');

const { tables, windows_total, windows_failed } = await tabulateDocuments({
  documents,                 // converted documents (chunks.pages), e.g. from convertDocument
  tables: [{
    name: 'surgery',
    description: 'One row per tumor-directed surgery.',
    key: ['surgery_date'],   // rows from different pages with equal keys are merged
    columns: [
      { name: 'surgery_date', type: 'date' },
      { name: 'extent', enum: ['Gross total', 'Partial', 'Biopsy only'] }
    ]
  }],
  model: 'bedrock:claude-sonnet-5',
  instructions: 'These are the records of one pediatric patient.'
});

// tables.surgery[0]:
// { values: { surgery_date: '2019-08-21', extent: 'Gross total' },
//   provenance: { surgery_date: [{ document, filename, page: 3, quote: '...' }, ...],
//                 extent: [{ ... }] },
//   conflicts: { extent: ['Partial'] } }   // only when pages disagree
```

## Tables

A table is `{ name, description?, instructions?, key?, columns }`. A column is `{ name, type?, description?, enum? }`:

| `type` | value |
| --- | --- |
| `string` (default) | text |
| `integer`, `number`, `boolean` | JSON numbers and booleans |
| `date` | `YYYY-MM-DD`, or `YYYY-MM` / `YYYY` when only part of a date is stated |

Every column is nullable: the model answers `null` for anything the page does not state. `enum` limits a column to the listed values (or `null`). Names are identifiers; `evidence` is reserved.

Ask for what the document says rather than what you will compute. Models are better at copying a date than at counting days, so extract dates and compute ages or intervals in code.

## How it reads

 - **Windows.** Each model call reads `pagesPerWindow` target pages (default 1) and up to `contextPagesBefore` preceding pages for context (default 1), with up to `concurrency` calls at once (default 4). Rows come only from target pages. Pages whose transcription failed, and empty pages, are skipped.
 - **Structured output.** Each reply must match a JSON schema built from the tables, with `evidence` on every row: quotes, each naming its page and the columns it supports. The schema is sent as `response_format` and also in the prompt, since some providers ignore `response_format`. Invalid replies go through charmd's schema-repair loop (two attempts).
 - **Merging.** Within a table that has a `key`, rows whose key columns are all non-null and equal (ignoring case and spacing) are merged: each column keeps its first non-null value, a different later value is listed under `conflicts`, and provenance is combined. Rows with a null key column, and all rows of a table without a key, are kept as they are.
 - **Failures.** A window that still fails after retries is listed in `windows_failed` (`{ document, pages, error }`) and contributes no rows; the other windows' rows are still returned. Callers should report failed windows rather than present the tables as complete.

## Streaming

`createTabulator(options)` takes the same options and reads windows as their pages arrive, so extraction can run while a document is still being converted:

```javascript
const tab = createTabulator({ tables, model, onWindow: w => showFacts(w.rows) });
await convertDocument({ fileBuffer, model, onPage: page => tab.addPage({ id: page.parent, filename }, page) });
tab.endDocument({ id: docId });          // reads a partial last window
const { tables: rows } = await tab.finish();
```

`onWindow({ document, filename, pages, rows, cached })` is called after each window with its rows before merging. Pages of a document must be added in order; `addDocument(doc)` adds a whole converted document.

## Cache

With charmd's result cache configured (`CHARMD_CACHE_DIR` or `CHARMD_CACHE_S3_URI`), `cache: 'use'` answers a window that was read before (same model, prompt, page text and schema) from the cache with no model call, and stores new answers; `refresh` re-reads and overwrites; `off` does neither. The default follows `CHARMD_CACHE`. Together with the conversion cache this makes a recorded run replayable with no model calls. Caching needs a `model` name, so it is off when only `chatModelFactory` is given.

`onProgress({ windows_total, windows_done })` is called after each window. `chatModelFactory` replaces `model` when you need a custom or stub model (see `test/testTabulate.spec.mjs`).

## Privacy

Provenance quotes are document text. Treat the result like the documents themselves: it carries whatever protected information they do.
