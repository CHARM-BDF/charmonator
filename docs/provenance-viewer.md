# Provenance viewer

`public/viewer/provenance.html` is an embeddable page that shows documents and the facts extracted from them, each fact linked to the page and quote it came from. It is served by charmd at `/viewer/provenance.html` and is meant to be opened directly or put in an `<iframe>` by a portal. pdf.js is served by charmd too (`/viewer/pdfjs/`, from the pinned `pdfjs-dist` dependency), so the page loads nothing from outside the deployment.

It shows three things:

 - **Pages:** a tray of every page, the page image (rendered from the original PDF when there is one) beside its transcription, and the facts found on that page. Selecting a fact highlights its quotes in the transcription.
 - **Tables:** any tables the data includes. A cell with sources opens its first source page with the quote highlighted.
 - **Warnings**, listed at the bottom.

An app supplies the data; the viewer knows nothing about any particular table format. See `apps/pcx30` in the private PCX apps for an example (`GET /apps/pcx30/v1/convert/:job/view`).

## Opening it

    /viewer/provenance.html?data=/apps/my-app/v1/jobs/123/view

| Parameter | |
| --- | --- |
| `data` | URL of the view JSON. Must be on the same origin as the viewer. Required |
| `replay_ms` | reveal pages one at a time, this many milliseconds apart, with facts and table cells appearing as their pages are read (a stage replay of recorded results). A Pause/Play button appears |
| `poll_ms` | while the data says `"status": "running"`, refetch this often (default 3000, minimum 1000) |
| `doc`, `page` | open at this document (index from 0) and page number |
| `theme` | `light` or `dark`; otherwise the browser's preference |
| `highlight` | where a document has `locate_url`: `select` (default) boxes the selected fact's quotes, or a table cell's source, on the page image; `auto` boxes every fact's quotes on the page; `off` none |

The viewer fetches `data` and any `pdf_url` with the browser's credentials, so whatever authentication protects the app protects the view.

## The view JSON

```json
{
  "status": "complete",
  "title": "Conversion · SYN-0001",
  "subtitle": "4 files",
  "documents": [
    { "id": "sha256-of-file", "filename": "binder.pdf", "pdf_url": "/apps/my-app/v1/jobs/123/files/0",
      "pages": [ { "number": 1, "text": "Transcribed page text…" } ] }
  ],
  "facts": [
    { "id": "surgery-0-p20", "document": "sha256-of-file", "page": 20,
      "label": "Surgery", "detail": "surgery date: 2019-08-22 · extent: near-total",
      "quotes": ["Near-total resection was achieved"] }
  ],
  "tables": [
    { "name": "surgery", "title": "Surgeries", "columns": ["age_at_surgery_days", "extent"],
      "rows": [ { "cells": { "age_at_surgery_days": "214", "extent": "Gross/Near total resection" },
                  "sources": { "age_at_surgery_days": [ { "document": "sha256-of-file", "page": 20, "quote": "Date of service: 08/22/2019" } ] } } ],
      "note": "optional text under the table" }
  ],
  "warnings": [ { "message": "the records disagree on birth date" } ]
}
```

 - `status` is `complete`, `running` or `error` (the viewer shows `error`). While `running`, the viewer shows `progress.label` and polls; documents, pages and facts may arrive over time (send what exists so far) and the viewer follows the newest page until the user moves to another (a Follow button resumes). Send `tables` when complete.
 - `documents[].pdf_url` is optional; without it the viewer shows the transcription alone. It must be same-origin.
 - `documents[].locate_url` is optional: a same-origin endpoint the viewer POSTs `{ "document": "<id>", "page": 20, "quotes": ["…"] }` to, answering `{ "boxes": [{ "quote": "…", "found": true, "box": [x0, y0, x1, y1] }] }` with the box in fractions of the page's width and height (charmd's `lib/locate.mjs` produces exactly this). The viewer draws the boxes over the page image.
 - Facts and sources refer to documents by `id` and to pages by `number`.
 - Quotes are found in the page text ignoring case, spacing and punctuation, so a quote copied from a transcription matches even if line breaks differ. A quote that cannot be found is listed with its fact but not highlighted.
 - `tables` and `warnings` are optional.

Everything in the view JSON is shown as text; nothing is interpreted as HTML.
