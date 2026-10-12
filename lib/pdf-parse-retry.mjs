// file: lib/pdf-parse-retry.mjs
//
// pdf-parse 1.1.1 bundles an old pdf.js whose first parses in a process can fail
// on a valid PDF under Node 24.18+: "bad XRef entry" (sometimes "Illegal character"
// instead), after which parses in the same process succeed. On 24.21 the first two
// calls failed and the third succeeded, deterministically. So on those two errors
// only, try up to MAX_ATTEMPTS in all. Other errors propagate at once, as before;
// on Node versions without the defect nothing changes.

import pdfParse from 'pdf-parse';

export const MAX_ATTEMPTS = 4;
// Errors seen from this defect on valid PDFs; anything else propagates at once.
const FLAKY = /bad XRef entry|Illegal character/i;

export async function parsePdfWithRetry(buffer, options, parse = pdfParse) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await parse(buffer, options);
    } catch (err) {
      lastErr = err;
      if (!FLAKY.test(String(err?.message ?? err))) throw err;
      console.warn(`[pdf-parse] attempt ${attempt}/${MAX_ATTEMPTS} failed (${err?.message}); retrying`);
      await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }
  throw lastErr;
}
