// A failed PDF conversion must not leave the temp PDF or page PNGs (case content)
// in uploads/, nor the multipart upload. On main only the success paths removed them.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';
import {
  processPdfDocument,
  resetPdfProcessingTestDeps,
  setPdfProcessingTestDeps
} from '../routes/charmonizer/document-conversion.mjs';

describe('processPdfDocument temp-file cleanup', function() {
  let dir;
  beforeEach(function() { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charmd-cleanup-')); });
  afterEach(function() {
    resetPdfProcessingTestDeps();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup({ failOnPage = null, parseFails = false } = {}) {
    const pdfPath = path.join(dir, 'job.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4 fixture');
    setPdfProcessingTestDeps({
      parsePdf: async () => { if (parseFails) throw new Error('bad XRef entry'); return { numpages: 3 }; },
      createPdfConverter: () => async n => {
        const p = path.join(dir, `page_${n}.png`);
        fs.writeFileSync(p, 'png');
        return { path: p };
      },
      readImage: async () => ({ async getBuffer() { return Buffer.from('png'); } }),
      ocrPageBuffer: async () => {
        if (failOnPage !== null && fs.readdirSync(dir).includes(`page_${failOnPage}.png`)) {
          throw new Error('OCR failed');
        }
        return { text: 'text', qualityScore: 0.99 };
      }
    });
    const jobRec = {
      id: 'cleanup-job', fileBuffer: Buffer.from('%PDF-1.4 fixture'), fileMimetype: 'application/pdf',
      fileSha256: 'sha', originatingFilename: 'x.pdf', continue_on_failure: false, ocr_threshold: 0.7,
      model: 'unused', detect_document_boundaries: false, page_numbering: false, scrutinize: 'none',
      describe: false, tags: null
    };
    return { pdfPath, jobRec };
  }

  const settle = () => new Promise(r => setTimeout(r, 50));

  it('removes the temp PDF and every page PNG when a page fails', async function() {
    const { jobRec } = setup({ failOnPage: 2 });
    await processPdfDocument(jobRec, path.join(dir, 'job.pdf'));
    await settle();
    assert.equal(jobRec.status, 'error');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('removes the temp PDF when parsing fails', async function() {
    const { jobRec } = setup({ parseFails: true });
    await processPdfDocument(jobRec, path.join(dir, 'job.pdf'));
    await settle();
    assert.equal(jobRec.status, 'error');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('still removes everything on success, unlinking the temp PDF once', async function() {
    const { jobRec } = setup();
    const unlinked = [];
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 1 }),
      createPdfConverter: () => async n => {
        const p = path.join(dir, `page_${n}.png`);
        fs.writeFileSync(p, 'png');
        return { path: p };
      },
      readImage: async () => ({ async getBuffer() { return Buffer.from('png'); } }),
      ocrPageBuffer: async () => ({ text: 'text', qualityScore: 0.99 }),
      unlinkFile: async p => { unlinked.push(p); await fs.promises.unlink(p).catch(() => {}); }
    });
    const pdfPath = path.join(dir, 'job.pdf');
    await processPdfDocument(jobRec, pdfPath);
    await settle();
    assert.equal(jobRec.status, 'complete');
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(unlinked.filter(p => p === pdfPath).length, 1);
  });

  it('removes a page PNG the converter wrote before throwing', async function() {
    const { jobRec } = setup();
    jobRec.id = `cleanup-${Date.now()}`;
    const predicted = path.join('uploads', `page_0_${jobRec.id}.1.png`);
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 1 }),
      createPdfConverter: () => async () => {
        fs.writeFileSync(predicted, 'png');
        throw new Error('gm failed after writing');
      }
    });
    await processPdfDocument(jobRec, path.join(dir, 'job.pdf'));
    await settle();
    assert.equal(jobRec.status, 'error');
    assert.equal(fs.existsSync(predicted), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('upload cleanup on failed requests', function() {
  this.timeout(20000);
  useManagedServerFixture();
  const port = Number(process.env.CHARMONATOR_PORT) || 5003;
  const uploads = () => new Set(fs.readdirSync('uploads'));
  const settle = () => new Promise(r => setTimeout(r, 100));

  async function post(url, filename) {
    const form = new FormData();
    form.append('file', Buffer.from('not really a pdf'), { filename, contentType: 'application/pdf' });
    return fetch(`http://localhost:${port}${url}`, { method: 'POST', body: form });
  }

  it('POST /conversions/documents without model returns 400 and leaves no upload', async function() {
    const before = uploads();
    const r = await post('/api/charmonizer/v1/conversions/documents', 'x.pdf');
    assert.equal(r.status, 400);
    await settle();
    assert.deepEqual([...uploads()].filter(f => !before.has(f)), []);
  });

  it('POST /conversion/file that fails returns 500 and leaves no upload', async function() {
    const before = uploads();
    const r = await post('/api/charmonator/v1/conversion/file', 'x.pdf');
    assert.equal(r.status, 500);
    await settle();
    assert.deepEqual([...uploads()].filter(f => !before.has(f)), []);
  });
});
