import { strict as assert } from 'assert';

import {
  processPdfDocument,
  resetPdfProcessingTestDeps,
  setPdfProcessingTestDeps
} from '../routes/charmonizer/document-conversion.mjs';
import { useManagedServerFixture } from './support/managed-server-fixture.mjs';

describe('processPdfDocument continue_on_failure', function() {
  useManagedServerFixture();

  afterEach(function() {
    resetPdfProcessingTestDeps();
  });

  it('should preserve transcription before and after a content-filtered page via the loopback image endpoint', async function() {
    setPdfProcessingTestDeps({
      parsePdf: async () => ({ numpages: 3 }),
      createPdfConverter: () => async pageNumber => ({ path: `mock-page-${pageNumber}.png` }),
      readImage: async imagePath => ({
        async getBuffer() {
          return Buffer.from(imagePath, 'utf8');
        }
      }),
      ocrPageBuffer: async () => ({
        text: 'ignored OCR text',
        qualityScore: 0.05
      }),
      unlinkFile: async () => {}
    });

    const jobRec = {
      id: 'job-fixture',
      fileBuffer: Buffer.from('%PDF-1.4 mock fixture', 'utf8'),
      fileMimetype: 'application/pdf',
      fileSha256: 'fixture-sha',
      originatingFilename: 'fixture.pdf',
      continue_on_failure: true,
      ocr_threshold: 0.7,
      model: 'test-policy-conversion-image-page-loopback',
      detect_document_boundaries: false,
      page_numbering: true,
      scrutinize: 'none',
      describe: true,
      tags: null
    };

    await processPdfDocument(jobRec, '/tmp/mock-input.pdf');

    assert.equal(jobRec.status, 'complete');
    assert.equal(jobRec.pages_total, 3);
    assert.equal(jobRec.pages_converted, 3);
    assert.equal(jobRec.fileBuffer, null);

    const docObject = jobRec.finalDocObject;
    assert.equal(docObject.metadata.transcription_status, 'partial');
    assert.equal(docObject.metadata.pages_failed, 1);
    assert.equal(docObject.metadata.pages_successful, 2);
    assert.equal(docObject.metadata.continue_on_failure_used, true);
    assert.equal(docObject.chunks.pages.length, 3);

    const [page1, page2, page3] = docObject.chunks.pages;
    assert.match(page1.content, /transcribed:mock-page-1\.png/);
    assert.equal(page1.metadata.page_number, 1);
    assert.equal(page1.metadata.text_extraction_method, 'vision_model');
    assert.equal(page1.metadata.transcription_failed, undefined);
    assert.equal(page1.annotations, undefined);

    assert.equal(page2.metadata.page_number, 2);
    assert.equal(page2.metadata.transcription_failed, true);
    assert.equal(page2.metadata.error_message, 'image blocked by content safety');
    assert.match(page2.content, /Transcription Failed/);

    assert.match(page3.content, /transcribed:mock-page-3\.png/);
    assert.equal(page3.metadata.page_number, 3);
    assert.equal(page3.metadata.text_extraction_method, 'vision_model');
    assert.equal(page3.metadata.transcription_failed, undefined);
    assert.equal(page3.annotations, undefined);

    const page1Offset = docObject.content.indexOf('transcribed:mock-page-1.png');
    const failedPageOffset = docObject.content.indexOf('Transcription Failed');
    const page3Offset = docObject.content.indexOf('transcribed:mock-page-3.png');
    assert.ok(page1Offset >= 0);
    assert.ok(failedPageOffset > page1Offset);
    assert.ok(page3Offset > failedPageOffset);
  });
});
