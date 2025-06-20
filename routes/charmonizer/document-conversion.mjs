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
import { scrutinizeViaDiff2 } from '../../lib/scrutinize.mjs';

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
 * Create an error placeholder page when continue_on_failure is enabled
 */
function createErrorPage(pageIndex, error, jobRec) {
  const pageNumber = pageIndex + 1;
  const chunkId = `${jobRec.fileSha256}/pages@${pageIndex}`;
  const timestamp = new Date().toISOString();
  
  const errorContent = `<!-- TRANSCRIPTION FAILURE -->
<!-- This page failed to transcribe due to an error -->

# Transcription Failed

**Error Type:** ${error.name || 'Unknown'}
**Error Message:** ${error.message || String(error)}
**Timestamp:** ${timestamp}
**Model:** ${jobRec.model || 'Unknown'}

---

*This content was generated because the --continue-on-failure flag was used and the transcription process encountered an error.*`;

  const pageChunk = {
    id: chunkId,
    parent: jobRec.fileSha256,
    start: 0, // Will be updated by caller
    length: errorContent.length,
    content: errorContent,
    metadata: {
      page_number: pageNumber,
      text_extraction_method: 'error_placeholder',
      extraction_confidence: 0,
      model_name: jobRec.model,
      isFirstPage: pageIndex === 0,
      originating_filename: jobRec.originatingFilename || '',
      originating_file_sha256: jobRec.fileSha256,
      transcription_failed: true,
      error_type: error.name || 'unknown',
      error_message: error.message || String(error)
    },
    annotations: {
      description: 'This page contains a transcription failure notice because the original transcription process failed.'
    }
  };

  // Prepend metadata as comments
  const metaComments = Object.entries(pageChunk.metadata)
    .map(([k, v]) => `<!-- METADATA ${k}: ${v} -->`)
    .join('\n');
  pageChunk.content = `${metaComments}\n${pageChunk.content}`;

  return pageChunk;
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

  if(jobRec.scrutinize == 'none') {
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
  } else if(jobRec.scrutinize == 'diff2') {
    const results = [];
    for (let i = 0; i < 2; i++) {
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
      results.push(result);
    }
    const markdown = scrutinizeViaDiff2(results.map(r => r.markdown))
    return {
      // The main text from the fallback LLM:
      markdown: markdown || '(No fallback output)',
      isFirstPage: !!results[0].isFirstPage,
      // If describe=true was given, we might get a short description
      description: results[0].description || '',
      // If tags were provided and matched, we might get them
      tags: results[0].tags || []
    };
  } else {
    throw Error(`unrecognized value for .scrutinize: ${jobRec.scrutinize}`)
  }
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
  limits: { fileSize: 1000 * 1024 * 1024 } // up to 1000 MB
});

const router = express.Router();

/**
 * POST /conversions/documents
 *
 * Accepts:
 *  - "file" (multipart) for the doc (currently PDF or DOCX)
 *  - "pdf_dataurl" if uploading inline base64 for a PDF
 *  - "model" => fallback LLM
 *  - "ocr_threshold" => numeric, default=0.7
 *  - "scrutinize" => string, default="none"
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
      scrutinize = "none",
      model = null,
      page_numbering = 'true',
      description,
      intent,
      graphic_instructions,
      detect_document_boundaries = 'false',
      describe: describeParam = 'true',
      tags: tagsParam,
      continue_on_failure = 'false'
    } = req.body;

    if (!model) {
      return res.status(400).json({ error: 'model is required' });
    }

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

    // We only handle PDF or .docx here
    // MIME for docx often has 'officedocument.wordprocessingml.document'
    if (!originalMimetype.includes('pdf')
        && !originalMimetype.includes('officedocument.wordprocessingml.document')) {
      return res.status(400).json({ error: 'Currently only PDF or DOCX are supported.' });
    }

    // Compute SHA-256
    const sha256sum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Create job
    const jobRec = createJobRecord({
      fileBuffer,
      ocr_threshold: parseFloat(ocr_threshold),
      scrutinize: scrutinize,
      model,
      page_numbering: String(page_numbering).toLowerCase() === 'true',
      fileMimetype: originalMimetype,
      fileSha256: sha256sum,
      description,
      intent,
      graphic_instructions,
      detect_document_boundaries: String(detect_document_boundaries).toLowerCase() === 'true',
      continue_on_failure: String(continue_on_failure).toLowerCase() === 'true',
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
 * processDocumentAsync => For PDF or DOCX:
 *   - detect PDF vs .docx
 *   - if PDF, parse page count, run OCR/fallback
 *   - if DOCX, parse with mammoth, chunk by form-feed
 *   - assemble page chunks, build top-level doc object
 */
async function processDocumentAsync(jobRec) {
  jobRec.status = 'processing';
  const tmpPdfPath = path.join('uploads', `${jobRec.id}.pdf`);
  await fs.promises.writeFile(tmpPdfPath, jobRec.fileBuffer);

  // Decide PDF vs DOCX vs error:
  const mime = jobRec.fileMimetype.toLowerCase();

  // If it's PDF:
  if (mime.includes('pdf')) {
    // Original PDF logic in helper:
    await processPdfDocument(jobRec, tmpPdfPath);
  }
  // If it's .docx:
  else if (mime.includes('officedocument.wordprocessingml.document')) {
    await processDocxDocument(jobRec);
  }
  else {
    // Not PDF or DOCX => error out
    jobRec.status = 'error';
    jobRec.error = `Unsupported file type: ${jobRec.fileMimetype}`;
    return;
  }
}

/**
 * If PDF, do the original OCR + fallback approach
 */
async function processPdfDocument(jobRec, tmpPdfPath) {
  try {
    const parsed = await pdfParse(jobRec.fileBuffer);
    const numPages = parsed.numpages || 1;
    jobRec.pages_total = numPages;
    jobRec.pages_converted = 0;

    let chunkPages = [];
    let allTextPieces = [];
    let currentStart = 0;

    let previousPageImageDataUrl = null;

    for (let i = 0; i < numPages; i++) {
      let pageChunk;
      
      try {
        const converter = pdf2picFromPath(tmpPdfPath, {
          density: 300,
          saveFilename: `page_${i}_${jobRec.id}`,
          savePath: 'uploads',
          format: 'png',
          width: 1536,
          height: 1988
        });
        const output = await converter(i + 1); // pdf2pic is 1-based index
        if (!output?.path) {
          throw new Error(`No path from pdf2pic for page ${i}`);
        }

        // read as PNG
        const image = await Jimp.read(output.path);
        const pngBuffer = await image.getBuffer('image/png');

        // Tesseract OCR
        const ocr = await ocrPageBuffer(pngBuffer);
        let pageText = ocr.text;
        let textMethod = 'ocr';
        let confidence = ocr.qualityScore;
        let fallbackModel = null;

        // Possibly store fallback's short desc/tags if used:
        let fallbackDescription = null;
        let fallbackTags = null;

        // if confidence < threshold => fallback
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

          fallbackDescription = fallbackResult.description || null;
          fallbackTags = fallbackResult.tags || [];

          confidence = Math.max(confidence, 0.9);
        } else {
          // if doc-boundary detection is on but no fallback for text
          if (jobRec.detect_document_boundaries) {
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

              if (boundaryOnly.description) {
                fallbackDescription = boundaryOnly.description;
              }
              if (boundaryOnly.tags && boundaryOnly.tags.length > 0) {
                fallbackTags = boundaryOnly.tags;
              }
            }
          }
        }

        if (i === 0) {
          isFirstPageDetected = true;
        }

        fs.promises.unlink(output.path).catch(() => {});

        const chunkId = `${jobRec.fileSha256}/pages@${i}`;
        const pageNumber = i + 1;

        pageChunk = {
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
            originating_filename: jobRec.originatingFilename || '',
            // originating_filepath: jobRec.originatingFilepath || '',
            originating_file_sha256: jobRec.fileSha256
          }
        };

        if (fallbackTags && fallbackTags.length > 0) {
          pageChunk.metadata.tags = fallbackTags;
        }
        if (fallbackDescription) {
          pageChunk.annotations = { description: fallbackDescription };
        }

        // Prepend metadata as comments
        const metaComments = Object.entries(pageChunk.metadata)
          .map(([k, v]) => `<!-- METADATA ${k}: ${v} -->`)
          .join('\n');
        pageChunk.content = `${metaComments}\n${pageChunk.content}`;

        if (jobRec.detect_document_boundaries) {
          const pageBase64 = pngBuffer.toString('base64');
          previousPageImageDataUrl = `data:image/png;base64,${pageBase64}`;
        }
      } catch (pageError) {
        console.error(`[Page ${i + 1}] Processing failed:`, pageError.message);
        
        if (jobRec.continue_on_failure) {
          console.log(`[Page ${i + 1}] Creating error placeholder due to --continue-on-failure flag`);
          pageChunk = createErrorPage(i, pageError, jobRec);
          pageChunk.start = currentStart;
        } else {
          // Re-throw the error to maintain current behavior when flag not set
          throw pageError;
        }
      }

      chunkPages.push(pageChunk);
      allTextPieces.push(pageChunk.content);
      currentStart += pageChunk.length;
      jobRec.pages_converted = i + 1;
    }

    await fs.promises.unlink(tmpPdfPath).catch(() => {});

    const combinedContent = allTextPieces.join(
      jobRec.page_numbering ? "\n\n<!-- page boundary -->\n\n" : "\n\n"
    );

    // Check if any pages failed transcription
    const failedPages = chunkPages.filter(page => page.metadata.transcription_failed);
    const hasFailedPages = failedPages.length > 0;

    const topLevelId = jobRec.fileSha256;
    const docObject = {
      id: topLevelId,
      content: combinedContent,
      metadata: {
        mimetype: jobRec.fileMimetype,
        document_sha256: jobRec.fileSha256,
        size_bytes: jobRec.fileBuffer.length,
        originating_filename: jobRec.originatingFilename || '',
        // originating_filepath: jobRec.originatingFilepath || ''
        ...(hasFailedPages && {
          transcription_status: 'partial',
          pages_failed: failedPages.length,
          pages_successful: chunkPages.length - failedPages.length,
          continue_on_failure_used: jobRec.continue_on_failure
        })
      },
      chunks: {
        pages: chunkPages
      }
    };

    jobRec.fileBuffer = null;
    jobRec.finalDocObject = docObject;
    jobRec.status = 'complete';
  } catch (err) {
    if (jobRec.continue_on_failure) {
      console.log(`[PDF Processing] Job failed, but continue_on_failure=true. Creating fallback document...`);
      
      // Create a fallback document with a single error page
      const errorPage = createErrorPage(0, err, jobRec);
      errorPage.start = 0;
      
      const combinedContent = errorPage.content;
      const topLevelId = jobRec.fileSha256;
      const docObject = {
        id: topLevelId,
        content: combinedContent,
        metadata: {
          mimetype: jobRec.fileMimetype,
          document_sha256: jobRec.fileSha256,
          size_bytes: jobRec.fileBuffer.length,
          originating_filename: jobRec.originatingFilename || '',
          transcription_status: 'failed',
          pages_failed: jobRec.pages_total || 1,
          pages_successful: 0,
          continue_on_failure_used: jobRec.continue_on_failure,
          transcription_error: {
            error_type: 'job_error',
            error_message: `PDF processing failed: ${err.message}`,
            timestamp: new Date().toISOString(),
            model_used: jobRec.model,
            failure_point: 'job_processing'
          }
        },
        chunks: {
          pages: [errorPage]
        }
      };
      
      jobRec.fileBuffer = null;
      jobRec.finalDocObject = docObject;
      jobRec.status = 'complete';
    } else {
      jobRec.status = 'error';
      jobRec.error = `PDF processing failed: ${err.message}`;
    }
  }
}

/**
 * If DOCX, parse with Mammoth, then trivially "split pages" by form-feed (\f).
 */
async function processDocxDocument(jobRec) {
  const tmpDocxPath = path.join('uploads', `${jobRec.id}.docx`);
  await fs.promises.writeFile(tmpDocxPath, jobRec.fileBuffer);

  try {
    // Use mammoth to extract raw text
    const mammoth = await import('mammoth'); // ensure mammoth is installed
    const result = await mammoth.extractRawText({ path: tmpDocxPath });
    let docxText = result.value || '';

    // Simple "page" splitting by form-feed
    const pages = docxText.split(/\f/g);
    jobRec.pages_total = pages.length;
    jobRec.pages_converted = 0;

    let chunkPages = [];
    let allTextPieces = [];
    let currentStart = 0;

    for (let i = 0; i < pages.length; i++) {
      const pageText = pages[i].trim();
      const pageNumber = i + 1;

      const chunkId = `${jobRec.fileSha256}/pages@${i}`;
      const pageChunk = {
        id: chunkId,
        parent: jobRec.fileSha256,
        start: currentStart,
        length: pageText.length,
        content: "",
        metadata: {
          page_number: pageNumber,
          text_extraction_method: "mammoth",
          extraction_confidence: 1.0,
          model_name: null,
          isFirstPage: (i === 0),
          originating_filename: jobRec.originatingFilename || '',
          // originating_filepath: jobRec.originatingFilepath || '',
          originating_file_sha256: jobRec.fileSha256
        }
      };

      // Prepend metadata lines
      const metaComment =
        `<!-- METADATA page_number: ${pageNumber} -->\n` +
        `<!-- METADATA text_extraction_method: mammoth -->\n` +
        `<!-- METADATA originating_filename: ${jobRec.originatingFilename || ''} -->\n` ;
      pageChunk.content = metaComment + pageText;

      chunkPages.push(pageChunk);
      allTextPieces.push(pageChunk.content);
      currentStart += pageText.length;
      jobRec.pages_converted++;
    }

    // Combine for top-level `content`
    const combinedContent = allTextPieces.join(
      jobRec.page_numbering ? "\n\n<!-- page boundary -->\n\n" : "\n\n"
    );

    const topLevelId = jobRec.fileSha256;
    const docObject = {
      id: topLevelId,
      content: combinedContent,
      metadata: {
        mimetype: jobRec.fileMimetype,
        document_sha256: jobRec.fileSha256,
        size_bytes: jobRec.fileBuffer.length,
        originating_filename: jobRec.originatingFilename || '',
        // originating_filepath: jobRec.originatingFilepath || ''
      },
      chunks: {
        pages: chunkPages
      }
    };

    jobRec.fileBuffer = null;
    jobRec.finalDocObject = docObject;
    jobRec.status = 'complete';
  } catch (err) {
    jobRec.status = 'error';
    jobRec.error = `DOCX processing failed: ${err.message}`;
  } finally {
    await fs.promises.unlink(tmpDocxPath).catch(() => {});
  }
}

export default router;
