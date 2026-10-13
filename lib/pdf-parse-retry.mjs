// file: lib/pdf-parse-retry.mjs
//
// pdf-parse 1.1.1 bundles pdf.js 1.10, which misreads a PDF held in a Node Buffer
// that is a view into a larger ArrayBuffer (byteOffset != 0):
//
//  - its fake worker clones the input with `new value.constructor(value)`, which
//    for a Buffer is `new Buffer(buf)`: a copy that Node places in its shared
//    allocation pool whenever it is smaller than Buffer.poolSize / 2;
//  - Stream.makeSubStream then does `new Stream(this.bytes.buffer, start, ...)`,
//    dropping the byteOffset, so every substream (xref, object and content
//    streams) is read from the wrong bytes of the pool.
//
// The result is a parse error that depends on where the copy lands in the pool:
// "bad XRef entry", "Illegal character", "Invalid number", ... It looks like a
// first-parse flake because the pool offset is often 0 early in a process. Node
// 24.18 raised Buffer.poolSize from 8 KiB to 64 KiB, so PDFs under 32 KiB (not
// just under 4 KiB) are affected there, hence "breaks on Node 24.18+".
//
// The fix: hand pdf-parse a plain Uint8Array copy. pdf.js then clones it with
// `new Uint8Array(value)`, which owns its ArrayBuffer at offset 0. The retry on
// the known messages stays as a backstop; other errors propagate at once.

import pdfParse from 'pdf-parse';

export const MAX_ATTEMPTS = 4;
// Errors seen from this defect on valid PDFs; anything else propagates at once.
const FLAKY = /bad XRef entry|Illegal character|Invalid number/i;

// A Uint8Array (not a Buffer) that owns its bytes, so pdf.js never sees a pooled Buffer.
export function toOwnedBytes(buffer) {
  if (buffer instanceof Uint8Array) return new Uint8Array(buffer);
  return buffer;
}

export async function parsePdfWithRetry(buffer, options, parse = pdfParse) {
  const bytes = toOwnedBytes(buffer);
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await parse(bytes, options);
    } catch (err) {
      lastErr = err;
      if (!FLAKY.test(String(err?.message ?? err))) throw err;
      console.warn(`[pdf-parse] attempt ${attempt}/${MAX_ATTEMPTS} failed (${err?.message}); retrying`);
      await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }
  throw lastErr;
}
