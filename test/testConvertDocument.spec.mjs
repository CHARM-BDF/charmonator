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

  it('checks its arguments', async function() {
    await assert.rejects(convertDocument({ model: 'm' }), /fileBuffer is required/);
    await assert.rejects(convertDocument({ fileBuffer: Buffer.from('x') }), /model is required/);
    await assert.rejects(
      convertDocument({ fileBuffer: Buffer.from('x'), model: 'm', cache: 'sometimes' }),
      /cache must be one of/
    );
  });
});
