// File: routes/charmonizer/document-conversion.mjs

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fromPath as pdf2picFromPath } from 'pdf2pic';
import { Jimp } from 'jimp';
import crypto from 'crypto';
import Tesseract from 'tesseract.js';
import pdfParse from 'pdf-parse';

// For fallback LLM-based extraction:
import { imageToMarkdown } from '../../lib/core.mjs';

/**
 * We'll store job data in memory for demonstration.
 * In production, consider using a database or persistent storage.
 */
const jobs = {};

/**
 * Helper function to truncate large strings for logs
 */
function trunc(str, maxLen = 200) {
  if (!str) return str;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...[truncated]';
}

/**
 * Tesseract-based OCR function:
 * We use Tesseract’s data.confidence (range 0..100).
 */
async function ocrPageBuffer(imageBuffer) {
  console.log(`[OCR] Tesseract starting, buffer length=${imageBuffer.length}`);
  const { data } = await Tesseract.recognize(imageBuffer, 'eng', {});
  const overallConfidence = data.confidence ?? 0;
  const qualityScore = overallConfidence / 100; // scale to 0..1
  console.log(`[OCR] done. confidence=${overallConfidence}, text length=${(data.text||'').length}`);
  return {
    text: data.text?.trim() || '',
    qualityScore
  };
}

/**
 * LLM-based fallback for pages that have below-threshold OCR confidence
 */
async function fallbackVisionModel(imageBuffer, modelName) {
  console.log(`[LLM fallback] using model="${modelName}"`);
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;

  const result = await imageToMarkdown({
    imageUrl: dataUrl,
    model: modelName,
    description: 'Document fallback page for advanced OCR',
    intent: 'Convert page image to Markdown text, including diagrams if present'
  });

  return result.markdown || '(No fallback output)';
}

/**
 * Create an in-memory job record
 */
function createJobRecord(extra) {
  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'pending',
    createdAt: Date.now(),
    finalDocObject: null, // We'll store the doc object here when done
    error: null,
    ...extra
  };
  return jobs[jobId];
}

/**
 * Multer setup for file upload
 */
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // up to 100 MB
});

const router = express.Router();

/**
 * POST /convert/document
 *
 * Accepts:
 *  - "file" (multipart) for the doc (currently PDF only)
 *  - "pdf_dataurl" if uploading inline base64 for a PDF
 *  - "model" => fallback LLM
 *  - "ocr_threshold" => numeric, default=0.7
 *  - "page_numbering" => string "true" or "false", default "true"
 *
 * Returns { job_id }, which can be polled:
 *  GET /jobs/:jobId
 *  GET /jobs/:jobId/result
 */
router.post('/document', upload.single('file'), async (req, res) => {
  try {
    const {
      ocr_threshold = 0.7,
      model = 'gpt-4o',
      page_numbering = 'true'
    } = req.body;

    let fileBuffer = null;
    let originalMimetype = null;

    // 1) If user uploaded a file (multipart)
    if (req.file) {
      fileBuffer = await fs.promises.readFile(req.file.path);
      originalMimetype = req.file.mimetype || 'application/pdf';
      fs.unlink(req.file.path, () => {});
    }
    // 2) Or they provided a base64 pdf_dataurl
    else if (req.body.pdf_dataurl) {
      const dataUrl = req.body.pdf_dataurl;
      if (!dataUrl.startsWith('data:application/pdf;base64,')) {
        return res.status(400).json({
          error: 'pdf_dataurl must be data:application/pdf;base64,...'
        });
      }
      const base64Data = dataUrl.split(';base64,').pop();
      fileBuffer = Buffer.from(base64Data, 'base64');
      originalMimetype = 'application/pdf';
    } else {
      return res.status(400).json({ error: 'No file or pdf_dataurl provided.' });
    }

    // We only handle PDFs for now
    if (!originalMimetype.includes('pdf')) {
      return res.status(400).json({ error: 'Currently only PDFs are supported.' });
    }

    // Compute SHA-256
    const sha256sum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Create job
    const jobRec = createJobRecord({
      fileBuffer,
      ocr_threshold: parseFloat(ocr_threshold),
      model,
      page_numbering: String(page_numbering).toLowerCase() === 'true',
      fileMimetype: originalMimetype,
      fileSha256: sha256sum
    });

    // Kick off async
    processDocumentAsync(jobRec).catch(err => {
      jobRec.status = 'error';
      jobRec.error = String(err);
      console.error('processDocumentAsync error:', err);
    });

    return res.json({ job_id: jobRec.id });
  } catch (error) {
    console.error('[POST] /document error:', error);
    return res.status(500).json({ error: String(error) });
  }
});

/**
 * GET /convert/document/jobs/:jobId
 * Returns minimal job status
 */
router.get('/document/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  res.json({
    job_id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt
  });
});

/**
 * GET /convert/document/jobs/:jobId/result
 * Returns the final doc object if complete
 */
router.get('/document/jobs/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  if (job.status === 'pending' || job.status === 'processing') {
    return res.status(202).json({ status: job.status });
  }
  if (job.status === 'error') {
    return res.status(500).json({ status: 'error', error: job.error });
  }

  // If complete, return the doc object
  return res.json(job.finalDocObject);
});

/**
 * DELETE /convert/document/jobs/:jobId
 * Remove the job from memory
 */
router.delete('/document/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  delete jobs[jobId];
  res.json({ success: true });
});

/**
 * processDocumentAsync => For PDF:
 *   - parse page count
 *   - For each page, convert to PNG, run OCR or fallback LLM
 *   - assemble page chunks, build top-level doc object
 */
async function processDocumentAsync(jobRec) {
  jobRec.status = 'processing';
  const tmpPdfPath = path.join('uploads', `${jobRec.id}.pdf`);
  await fs.promises.writeFile(tmpPdfPath, jobRec.fileBuffer);

  // parse PDF for page count
  const parsed = await pdfParse(jobRec.fileBuffer);
  const numPages = parsed.numpages || 1;

  let chunkPages = []; // array of page-chunks

  // We'll accumulate the entire doc's text in a big array
  let allTextPieces = [];
  let currentStart = 0;

  for (let i = 0; i < numPages; i++) {
    const converter = pdf2picFromPath(tmpPdfPath, {
      density: 150,
      saveFilename: `page_${i}_${jobRec.id}`,
      savePath: 'uploads',
      format: 'png'
    });
    const output = await converter(i + 1); // pdf2pic is 1-based page indexing
    if (!output?.path) {
      console.warn(`[processDocumentAsync] no path from pdf2pic for page ${i}`);
      continue;
    }

    // read as PNG
    const image = await Jimp.read(output.path);
    const pngBuffer = await image.getBuffer('image/png');

    // Tesseract
    const ocr = await ocrPageBuffer(pngBuffer);
    let pageText = ocr.text;
    let textMethod = 'ocr';
    let confidence = ocr.qualityScore;
    let fallbackModel = null;

    if (confidence < jobRec.ocr_threshold) {
      pageText = await fallbackVisionModel(pngBuffer, jobRec.model);
      textMethod = 'vision_model';
      fallbackModel = jobRec.model;
      // we can set confidence=1.0 or something
      confidence = Math.max(confidence, 0.9);
    }

    // Remove the PNG
    fs.promises.unlink(output.path).catch(() => {});

    // Build a chunk object for the page
    const chunkId = `${jobRec.fileSha256}/pages@${i}`;
    const pageNumber = i + 1;

    const pageChunk = {
      id: chunkId,
      parent: jobRec.fileSha256,
      // If we want substring references, do:
      start: currentStart,
      length: pageText.length,
      content: pageText,
      metadata: {
        page_number: pageNumber,
        text_extraction_method: textMethod,
        extraction_confidence: parseFloat(confidence.toFixed(3)),
        model_name: fallbackModel
      }
    };

    chunkPages.push(pageChunk);

    // Accumulate text
    allTextPieces.push(pageText);
    currentStart += pageText.length;
  }

  await fs.promises.unlink(tmpPdfPath).catch(() => {});

  // Combine all page text
  const combinedContent = allTextPieces.join(
    jobRec.page_numbering ? "\n\n<!-- page boundary -->\n\n" : "\n\n"
  );

  // Top-level doc object
  const topLevelId = jobRec.fileSha256; // or whatever naming
  const docObject = {
    id: topLevelId,
    content: combinedContent,
    metadata: {
      mimetype: jobRec.fileMimetype,
      document_sha256: jobRec.fileSha256,
      size_bytes: jobRec.fileBuffer.length,
      // other top-level metadata fields if desired
    },
    chunks: {
      pages: chunkPages
    }
  };

  // Done
  jobRec.fileBuffer = null;
  jobRec.finalDocObject = docObject;
  jobRec.status = 'complete';
}

export default router;
