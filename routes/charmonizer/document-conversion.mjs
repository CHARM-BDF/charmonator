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
 * or for boundary detection if needed.
 */
async function fallbackVisionModel(imageBuffer, modelName, jobRec, precedingDataUrl = null) {
  console.log(`[LLM fallback/boundary-check] using model="${modelName}"`);
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;

  // We'll call imageToMarkdown, optionally passing preceding_image_url, describe, and tags.
  // That call can return { markdown, isFirstPage, description?, tags? }
  const result = await imageToMarkdown({
    imageUrl: dataUrl,
    preceding_image_url: precedingDataUrl || '',
    model: modelName,
    description: jobRec.description || 'A document page with text and possibly diagrams.',
    intent: jobRec.intent || 'The intended use of this transcription is not specified, so be as precise as possible.',
    graphic_instructions: jobRec.graphic_instructions,
    describe: jobRec.describe,
    tags: jobRec.tags
  });

  return {
    // The main text from the fallback LLM:
    markdown: result.markdown || '(No fallback output)',
    isFirstPage: !!result.isFirstPage,
    // If describe=true was given, we might get a short description
    description: result.description || '',
    // If tags were provided and matched, we might get them
    tags: result.tags || []
  };
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
    finalDocObject: null,
    error: null,
    pages_total: null,
    pages_converted: 0,
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
 * POST /conversions/documents
 *
 * Accepts:
 *  - "file" (multipart) for the doc (currently PDF only)
 *  - "pdf_dataurl" if uploading inline base64 for a PDF
 *  - "model" => fallback LLM
 *  - "ocr_threshold" => numeric, default=0.7
 *  - "page_numbering" => string "true" or "false", default "true"
 *  - "description" => optional, for passing to the fallback vision model
 *  - "intent" => optional, for passing to the fallback vision model
 *  - "graphic_instructions" => optional, for passing to the fallback vision model
 *  - "detect_document_boundaries" => string "true" or "false", default "false"
 *  - "describe" => string "true" or "false" (optional, default "true")
 *  - "tags" => object (optional)
 *
 * Returns { job_id }, which can be polled:
 *  GET /documents/:jobId
 *  GET /documents/:jobId/result
 */
router.post('/documents', upload.single('file'), async (req, res) => {
  try {
    const {
      ocr_threshold = 0.7,
      model = 'gpt-4o-mini',
      page_numbering = 'true',
      description,
      intent,
      graphic_instructions,
      detect_document_boundaries = 'false',
      describe: describeParam = 'true',
      tags: tagsParam
    } = req.body;

    // Convert "describe" from string to boolean:
    const describe = (String(describeParam).toLowerCase() === 'true');
    // Accept tags as-is or null:
    const tags = tagsParam || null;

    let fileBuffer = null;
    let originalMimetype = null;

    // We'll track the user-facing filename/path:
    let originatingFilename = 'inline_data.pdf'; // default if base64 used
    let originatingFilepath = null;

    // 1) If user uploaded a file (multipart)
    if (req.file) {
      fileBuffer = await fs.promises.readFile(req.file.path);
      originalMimetype = req.file.mimetype || 'application/pdf';
      // capture the provided filename/path
      originatingFilename = req.file.originalname || 'unknown.pdf';
      originatingFilepath = req.file.path;
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
      fileSha256: sha256sum,
      description,
      intent,
      graphic_instructions,
      detect_document_boundaries: String(detect_document_boundaries).toLowerCase() === 'true',
      // Additional fields for describing / tagging
      describe,
      tags,
      // store filename/path
      originatingFilename,
      originatingFilepath
    });

    // Kick off async
    processDocumentAsync(jobRec).catch(err => {
      jobRec.status = 'error';
      jobRec.error = String(err);
      console.error('processDocumentAsync error:', err);
    });

    return res.json({ job_id: jobRec.id });
  } catch (error) {
    console.error('[POST] /documents error:', error);
    return res.status(500).json({ error: String(error) });
  }
});

/**
 * GET /conversions/documents/:jobId
 * Returns minimal job status, including page totals
 */
router.get('/documents/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  res.json({
    job_id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    pages_total: job.pages_total,
    pages_converted: job.pages_converted
  });
});

/**
 * GET /conversions/documents/:jobId/result
 * Returns the final doc object if complete
 */
router.get('/documents/:jobId/result', (req, res) => {
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
 * DELETE /conversions/documents/:jobId
 * Remove the job from memory
 */
router.delete('/documents/:jobId', (req, res) => {
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
 *   - (Optionally) detect doc boundaries with preceding page image if detect_document_boundaries is true
 *   - assemble page chunks, build top-level doc object
 */
async function processDocumentAsync(jobRec) {
  jobRec.status = 'processing';
  const tmpPdfPath = path.join('uploads', `${jobRec.id}.pdf`);
  await fs.promises.writeFile(tmpPdfPath, jobRec.fileBuffer);

  // parse PDF for page count
  const parsed = await pdfParse(jobRec.fileBuffer);
  const numPages = parsed.numpages || 1;

  jobRec.pages_total = numPages;
  jobRec.pages_converted = 0;

  let chunkPages = [];
  let allTextPieces = [];
  let currentStart = 0;

  // We'll store the *previous* page image dataUrl for doc-boundary detection if requested
  let previousPageImageDataUrl = null;

  for (let i = 0; i < numPages; i++) {
    const converter = pdf2picFromPath(tmpPdfPath, {
      density: 300,
      saveFilename: `page_${i}_${jobRec.id}`,
      savePath: 'uploads',
      format: 'png',
      width: 1536,
      height: 1988
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

    // We may store an LLM fallback result's description or tags if used:
    let fallbackDescription = null;
    let fallbackTags = null;

    // If confidence is below threshold, fallback to LLM for text
    // (which also might yield isFirstPage if doc boundary detection is set)
    let isFirstPageDetected = false;
    if (confidence < jobRec.ocr_threshold) {
      const fallbackResult = await fallbackVisionModel(
        pngBuffer,
        jobRec.model,
        jobRec,
        jobRec.detect_document_boundaries ? previousPageImageDataUrl : null
      );
      pageText = fallbackResult.markdown;
      isFirstPageDetected = fallbackResult.isFirstPage;
      textMethod = 'vision_model';
      fallbackModel = jobRec.model;

      // grab description and tags from fallback
      fallbackDescription = fallbackResult.description || null;
      fallbackTags = fallbackResult.tags || [];

      // If we used fallback, let's assume a "confidence"
      confidence = Math.max(confidence, 0.9);
    } else {
      // If we didn't fallback for text but still want doc-boundary detection:
      if (jobRec.detect_document_boundaries) {
        // For the first page, we override to true anyway
        if (i === 0) {
          isFirstPageDetected = true;
        } else {
          const boundaryOnly = await fallbackVisionModel(
            pngBuffer,
            jobRec.model,
            jobRec,
            previousPageImageDataUrl
          );
          isFirstPageDetected = boundaryOnly.isFirstPage;

          // if the boundary check gave us description/tags, store them too
          if (boundaryOnly.description) {
            fallbackDescription = boundaryOnly.description;
          }
          if (boundaryOnly.tags && boundaryOnly.tags.length > 0) {
            fallbackTags = boundaryOnly.tags;
          }
        }
      }
    }

    // For the very first page, always set isFirstPage=true
    if (i === 0) {
      isFirstPageDetected = true;
    }

    // Remove the PNG
    fs.promises.unlink(output.path).catch(() => {});

    // Build a chunk object for the page
    const chunkId = `${jobRec.fileSha256}/pages@${i}`;
    const pageNumber = i + 1;

    const pageChunk = {
      id: chunkId,
      parent: jobRec.fileSha256,
      start: currentStart,
      length: pageText.length,
      content: pageText,
      metadata: {
        page_number: pageNumber,
        text_extraction_method: textMethod,
        extraction_confidence: parseFloat(confidence.toFixed(3)),
        model_name: fallbackModel,
        isFirstPage: isFirstPageDetected,
        // Include original filename/path & file hash
        originating_filename: jobRec.originatingFilename || '',
        originating_filepath: jobRec.originatingFilepath || '',
        originating_file_sha256: jobRec.fileSha256
      }
    };

    if (fallbackTags && fallbackTags.length > 0) {
      pageChunk.metadata.tags = fallbackTags;
    }
    if (fallbackDescription) {
      pageChunk.annotations = { description: fallbackDescription };
    }

    // Prepend metadata as comments in pageChunk.content
    {
      const metaComments = Object.entries(pageChunk.metadata)
        .map(([k, v]) => `<!-- METADATA ${k}: ${v} -->`)
        .join('\n');
      pageChunk.content = `${metaComments}\n${pageChunk.content}`;
    }

    chunkPages.push(pageChunk);
    allTextPieces.push(pageChunk.content);
    currentStart += pageText.length;
    jobRec.pages_converted = i + 1;

    // If doc boundary detection is enabled, prepare preceding image for next iteration
    if (jobRec.detect_document_boundaries) {
      const pageBase64 = pngBuffer.toString('base64');
      previousPageImageDataUrl = `data:image/png;base64,${pageBase64}`;
    }
  }

  await fs.promises.unlink(tmpPdfPath).catch(() => {});

  // Combine all page text
  const combinedContent = allTextPieces.join(
    jobRec.page_numbering ? "\n\n<!-- page boundary -->\n\n" : "\n\n"
  );

  // Top-level doc object
  const topLevelId = jobRec.fileSha256;
  const docObject = {
    id: topLevelId,
    content: combinedContent,
    metadata: {
      mimetype: jobRec.fileMimetype,
      document_sha256: jobRec.fileSha256,
      size_bytes: jobRec.fileBuffer.length,
      originating_filename: jobRec.originatingFilename || '',
      originating_filepath: jobRec.originatingFilepath || ''
    },
    chunks: {
      pages: chunkPages
    }
  };

  jobRec.fileBuffer = null;
  jobRec.finalDocObject = docObject;
  jobRec.status = 'complete';
}

export default router;
