// convertDocument: the in-process conversion apps call. PDF parsing, page
// rasterization and OCR are mocked, as in testDocumentConversionTempCleanup.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  convertDocument,
  resetPdfProcessingTestDeps,
  setPdfProcessingTestDeps
} from '../routes/charmonizer/document-conversion.mjs';

describe('convertDocument (in-process conversion for apps)', function() {
  let dir;
  beforeEach(function() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charmd-convert-'));
    fs.mkdirSync('uploads', { recursive: true });
  });
  afterEach(function() {
    resetPdfProcessingTestDeps();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mockPdf({ pages = 2, failParse = false } = {}) {
    setPdfProcessingTestDeps({
      parsePdf: async () => { if (failParse) throw new Error('bad XRef entry'); return { numpages: pages }; },
      createPdfConverter: () => async n => {
        const p = path.join(dir, `page_${n}.png`);
        fs.writeFileSync(p, 'png');
        return { path: p };
      },
      readImage: async () => ({ async getBuffer() { return Buffer.from('png'); } }),
      ocrPageBuffer: async () => ({ text: 'Synthetic page text.', qualityScore: 0.99 })
    });
  }

  it('resolves to the converted document and reports its job id', async function() {
    mockPdf({ pages: 2 });
    let jobId = null;
    const doc = await convertDocument({
      fileBuffer: Buffer.from('%PDF-1.4 fixture'), filename: 'synthetic.pdf', model: 'unused',
      describe: false, cache: 'off', onStart: id => { jobId = id; }
    });
    assert.match(jobId, /^[0-9a-f-]{36}$/);
    assert.equal(doc.metadata.originating_filename, 'synthetic.pdf');
    assert.equal(doc.chunks.pages.length, 2);
    assert.deepEqual(doc.chunks.pages.map(p => p.metadata.page_number), [1, 2]);
    assert.match(doc.chunks.pages[0].content, /Synthetic page text\./);
  });

  it('rejects when conversion fails', async function() {
    mockPdf({ failParse: true });
    await assert.rejects(
      convertDocument({ fileBuffer: Buffer.from('%PDF-1.4 fixture'), model: 'unused', cache: 'off' }),
      /conversion failed/
    );
  });

  it('reports pages in order through onPage, also when converted in parallel', async function() {
    // Later pages finish first: page n takes (6 - n) * 15 ms.
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 5 }),
      createPdfConverter: () => async n => {
        const p = path.join(dir, `page_${n}.png`);
        fs.writeFileSync(p, String(n));
        return { path: p };
      },
      readImage: async (p) => ({ async getBuffer() { return fs.readFileSync(p); } }),
      ocrPageBuffer: async (buf) => {
        const n = Number(buf.toString());
        await new Promise(r => setTimeout(r, (6 - n) * 15));
        return { text: `Page ${n} text.`, qualityScore: 0.99 };
      }
    });
    for (const page_concurrency of [1, 3]) {
      const seen = [];
      const doc = await convertDocument({
        fileBuffer: Buffer.from(`%PDF-1.4 fixture ${page_concurrency}`), model: 'unused', describe: false,
        cache: 'off', page_concurrency, onPage: page => seen.push(page.metadata.page_number)
      });
      assert.deepEqual(seen, [1, 2, 3, 4, 5], `page_concurrency ${page_concurrency}`);
      assert.deepEqual(doc.chunks.pages.map(p => p.metadata.page_number), [1, 2, 3, 4, 5]);
      let start = 0;
      for (const p of doc.chunks.pages) {
        assert.equal(p.start, start);
        assert.match(p.content, new RegExp(`Page ${p.metadata.page_number} text`));
        start += p.length;
      }
    }
  });

  it('skips Tesseract when ocr_threshold is above 1', async function() {
    let ocrCalls = 0;
    let visionCalls = 0;
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 2 }),
      createPdfConverter: () => async n => {
        const p = path.join(dir, `page_${n}.png`);
        fs.writeFileSync(p, 'png');
        return { path: p };
      },
      readImage: async () => ({ async getBuffer() { return Buffer.from('png'); } }),
      ocrPageBuffer: async () => { ocrCalls += 1; return { text: 'ocr', qualityScore: 0.99 }; },
      fallbackVisionModel: async () => { visionCalls += 1; return { markdown: 'Vision text.', isFirstPage: false }; }
    });
    const doc = await convertDocument({
      fileBuffer: Buffer.from('%PDF-1.4 vision'), model: 'unused', describe: false, cache: 'off', ocr_threshold: 1.01
    });
    assert.equal(ocrCalls, 0);
    assert.equal(visionCalls, 2);
    assert.ok(doc.chunks.pages.every(p => p.metadata.text_extraction_method === 'vision_model'));
  });

  it('fails the job when a page fails during parallel conversion', async function() {
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 6 }),
      createPdfConverter: () => async n => {
        const p = path.join(dir, `page_${n}.png`);
        fs.writeFileSync(p, String(n));
        return { path: p };
      },
      readImage: async (p) => ({ async getBuffer() { return fs.readFileSync(p); } }),
      ocrPageBuffer: async (buf) => {
        if (buf.toString() === '3') throw new Error('OCR failed on page 3');
        return { text: 'ok', qualityScore: 0.99 };
      }
    });
    await assert.rejects(
      convertDocument({ fileBuffer: Buffer.from('%PDF-1.4 fail'), model: 'unused', describe: false, cache: 'off', page_concurrency: 3 }),
      /conversion failed/
    );
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('checks its arguments', async function() {
    await assert.rejects(convertDocument({ model: 'm' }), /fileBuffer is required/);
    await assert.rejects(convertDocument({ fileBuffer: Buffer.from('x') }), /model is required/);
    await assert.rejects(
      convertDocument({ fileBuffer: Buffer.from('x'), model: 'm', cache: 'sometimes' }),
      /cache must be one of/
    );
    await assert.rejects(
      convertDocument({ fileBuffer: Buffer.from('x'), model: 'm', page_concurrency: 0 }),
      /page_concurrency/
    );
  });
});
