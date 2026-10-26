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
import { parsePdfWithRetry } from '../../lib/pdf-parse-retry.mjs';

// For fallback LLM-based extraction:
import { imageToMarkdown } from '../../lib/core.mjs';
import { scrutinizeViaDiff2 } from '../../lib/scrutinize.mjs';
import { jsonSafeFromException, ProviderException } from '../../lib/providers/provider_exception.mjs';
import { summarizeBody } from '../../lib/log-safety.mjs';
import {
  CACHE_FORMAT,
  computeCacheKey,
  getCacheStore,
  normalizeConversionOptions,
  resolveCachePolicy
} from '../../lib/result-cache.mjs';

// Upper bound on replay_pace_ms (10 minutes per page).
const MAX_REPLAY_PACE_MS = 600000;
// Upper bound on page_concurrency (pages converted at once within one document).
const MAX_PAGE_CONCURRENCY = 16;

function buildPdfProcessingDeps() {
  return {
    parsePdf: fileBuffer => parsePdfWithRetry(fileBuffer),
    createPdfConverter: (pdfPath, options) => pdf2picFromPath(pdfPath, options),
    readImage: imagePath => Jimp.read(imagePath),
    ocrPageBuffer,
    fallbackVisionModel,
    unlinkFile: filePath => fs.promises.unlink(filePath)
  };
}

let pdfProcessingDeps = buildPdfProcessingDeps();

export function setPdfProcessingTestDeps(overrides = {}) {
  pdfProcessingDeps = {
    ...buildPdfProcessingDeps(),
    ...overrides
  };
}

export function resetPdfProcessingTestDeps() {
  pdfProcessingDeps = buildPdfProcessingDeps();
}

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
 * Tell an in-process caller (convertDocument's onPage) about a committed page.
 * A failing callback must not fail the conversion.
 */
function notifyPage(jobRec, pageChunk) {
  jobRec.pages_notified = (jobRec.pages_notified || 0) + 1;
  if (!jobRec.onPage) return;
  try {
    jobRec.onPage(pageChunk);
  } catch (err) {
    console.warn(JSON.stringify({ event: 'onPage callback failed', err: err?.message }));
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create a conversion job record and start converting it. `fields` are the job
 * record's fields (see the POST handler); `cachePolicy` must already be resolved.
 * Returns the record and a promise that settles when the job has finished
 * (status "complete" or "error"); the promise never rejects.
 */
function launchConversionJob(fields) {
  const jobRec = createJobRecord(fields);

  if (jobRec.cachePolicy !== 'off') {
    jobRec.cacheKey = computeCacheKey({
      fileBuffer: jobRec.fileBuffer,
      options: normalizeConversionOptions(jobRec),
      model: jobRec.model
    });
    jobRec.cacheInfo = { policy: jobRec.cachePolicy, key: jobRec.cacheKey, hit: null, stored: false };
  }

  // Kick off async
  const done = runConversionJob(jobRec).catch(err => {
    jobRec.status = 'error';
    const j = jsonSafeFromException(err)
    console.error({"event":"processDocumentAsync error",
      stack: err.stack,
      errJson: j
    })
    jobRec.error = j;
  });
  return { jobRec, done };
}

/**
 * Convert a document in-process, for apps (see docs/apps.md). Takes the options
 * of POST /conversions/documents as JavaScript values and resolves to the same
 * document object GET /documents/:jobId/result returns. The job is an ordinary
 * conversion job, so GET /documents/:jobId and /pages report on it while it runs;
 * `onStart(jobId)` is called with its id as soon as it exists, and
 * `onPage(page)` with each page chunk, in page order, as soon as it is done.
 * `page_concurrency` converts up to that many pages at once (pages are still
 * committed and reported in order; ignored with detect_document_boundaries).
 * On a cache hit, `replay_pace_ms` reports the cached pages that many ms apart,
 * so a recorded run can be shown at a readable pace.
 * Rejects with the job's error if conversion fails.
 */
export async function convertDocument({
  fileBuffer,
  mimetype = 'application/pdf',
  filename = 'inline_data.pdf',
  model,
  ocr_threshold = 0.7,
  scrutinize = 'none',
  page_numbering = true,
  description,
  intent,
  graphic_instructions,
  detect_document_boundaries = false,
  describe = true,
  tags = null,
  continue_on_failure = false,
  cache,
  page_concurrency = 1,
  replay_pace_ms = null,
  onStart = null,
  onPage = null
} = {}) {
  if (!fileBuffer) throw new Error('convertDocument: fileBuffer is required');
  if (!model) throw new Error('convertDocument: model is required');
  if (!Number.isInteger(page_concurrency) || page_concurrency < 1 || page_concurrency > MAX_PAGE_CONCURRENCY) {
    throw new Error(`convertDocument: page_concurrency must be an integer from 1 to ${MAX_PAGE_CONCURRENCY}`);
  }
  const cacheResolution = resolveCachePolicy(cache);
  if (cacheResolution.error) throw new Error(cacheResolution.error);
  let cachePolicy = cacheResolution.policy;
  if (cachePolicy !== 'off' && !getCacheStore()) {
    if (cacheResolution.explicit) {
      throw new Error('cache requested but no cache store is configured (set CHARMD_CACHE_DIR or CHARMD_CACHE_S3_URI)');
    }
    cachePolicy = 'off';
  }

  const { jobRec, done } = launchConversionJob({
    fileBuffer,
    ocr_threshold: parseFloat(ocr_threshold),
    scrutinize,
    model,
    page_numbering: Boolean(page_numbering),
    fileMimetype: mimetype,
    fileSha256: crypto.createHash('sha256').update(fileBuffer).digest('hex'),
    description,
    intent,
    graphic_instructions,
    detect_document_boundaries: Boolean(detect_document_boundaries),
    continue_on_failure: Boolean(continue_on_failure),
    describe: Boolean(describe),
    tags,
    originatingFilename: filename,
    originatingFilepath: null,
    cachePolicy,
    replayPaceMs: replay_pace_ms,
    page_concurrency,
    onPage
  });
  if (onStart) onStart(jobRec.id);
  await done;
  if (jobRec.status !== 'complete') {
    const err = new Error(`conversion failed: ${jobRec.error?.message || jobRec.error?.interpretedMessage || jobRec.status}`);
    err.details = jobRec.error;
    throw err;
  }
  // Pages not reported while converting (DOCX, or a cache hit without replay).
  const pages = jobRec.finalDocObject?.chunks?.pages || [];
  for (const page of pages.slice(jobRec.pages_notified || 0)) notifyPage(jobRec, page);
  return jobRec.finalDocObject;
}

/**
 * Render one page of a PDF to PNG, as conversion does, for apps that need the
 * page image after conversion (e.g. to locate quotes on it, lib/locate.mjs).
 * The temp PDF and PNG are removed before returning.
 * @returns {Promise<Buffer>} the page as PNG
 */
export async function renderPdfPage(fileBuffer, pageNumber, { width = 1536 } = {}) {
  if (!Buffer.isBuffer(fileBuffer)) throw new Error('renderPdfPage: fileBuffer must be a Buffer');
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('renderPdfPage: pageNumber must be a positive integer');
  const deps = pdfProcessingDeps;
  const id = uuidv4();
  await fs.promises.mkdir('uploads', { recursive: true });
  const tmpPdfPath = path.join('uploads', `render_${id}.pdf`);
  let pngPath = path.join('uploads', `render_${id}.${pageNumber}.png`);
  try {
    await fs.promises.writeFile(tmpPdfPath, fileBuffer);
    const converter = deps.createPdfConverter(tmpPdfPath, {
      density: 300,
      saveFilename: `render_${id}`,
      savePath: 'uploads',
      format: 'png',
      width,
      preserveAspectRatio: true
    });
    const output = await converter(pageNumber);
    if (!output?.path) throw new Error(`no image for page ${pageNumber}`);
    pngPath = output.path;
    const image = await deps.readImage(output.path);
    return await image.getBuffer('image/png');
  } finally {
    Promise.resolve(deps.unlinkFile(tmpPdfPath)).catch(() => {});
    Promise.resolve(deps.unlinkFile(pngPath)).catch(() => {});
  }
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
 *  - "cache" => "use" | "refresh" | "off" (optional; multipart/JSON field or ?cache= query).
 *               Default "off", or "use" when env CHARMD_CACHE=on. See docs/api-docs.md.
 *  - "replay_pace_ms" => integer ms per page (optional). Only on a cache hit: pages are
 *               revealed one every replay_pace_ms, then the job completes.
 *  - "page_concurrency" => integer 1-16, default 1: pages converted at once. Pages are
 *               still added to the result (and to /pages) in order. Forced to 1 with
 *               detect_document_boundaries, which compares each page with the one before.
 *  - "ocr_threshold" above 1 skips Tesseract entirely (every page goes to the model).
 *
 * Returns { job_id }, which can be polled:
 *  GET /documents/:jobId
 *  GET /documents/:jobId/result
 *  GET /documents/:jobId/pages?after=N   (pages completed so far; live, cached or replayed)
 */
router.post('/documents', upload.single('file'), async (req, res) => {
  console.log(JSON.stringify({
    "event":"request",
    "url":"/documents"+req.url,
    "body":summarizeBody(req.body)}))
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
      continue_on_failure = 'false',
      page_concurrency = '1'
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

    // Cache / replay options (additive; absent => main's behaviour).
    const cacheResolution = resolveCachePolicy(req.body.cache ?? req.query.cache);
    if (cacheResolution.error) {
      return res.status(400).json({ error: cacheResolution.error });
    }
    let cachePolicy = cacheResolution.policy;
    if (cachePolicy !== 'off' && !getCacheStore()) {
      if (cacheResolution.explicit) {
        return res.status(400).json({
          error: 'cache requested but no cache store is configured (set CHARMD_CACHE_DIR or CHARMD_CACHE_S3_URI)'
        });
      }
      console.warn('[cache] CHARMD_CACHE=on but no cache store configured; continuing without cache');
      cachePolicy = 'off';
    }
    const replayRaw = req.body.replay_pace_ms ?? req.query.replay_pace_ms;
    let replayPaceMs = null;
    if (replayRaw !== undefined && replayRaw !== null && replayRaw !== '') {
      replayPaceMs = Number(replayRaw);
      if (!Number.isInteger(replayPaceMs) || replayPaceMs < 0 || replayPaceMs > MAX_REPLAY_PACE_MS) {
        return res.status(400).json({
          error: `replay_pace_ms must be an integer between 0 and ${MAX_REPLAY_PACE_MS}`
        });
      }
    }

    const pageConcurrency = Number(page_concurrency);
    if (!Number.isInteger(pageConcurrency) || pageConcurrency < 1 || pageConcurrency > MAX_PAGE_CONCURRENCY) {
      return res.status(400).json({ error: `page_concurrency must be an integer from 1 to ${MAX_PAGE_CONCURRENCY}` });
    }

    // Compute SHA-256
    const sha256sum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const { jobRec } = launchConversionJob({
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
      originatingFilepath,
      cachePolicy,
      replayPaceMs,
      page_concurrency: pageConcurrency
    });

    return res.json({ job_id: jobRec.id });
  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"[POST] /documents error",
      stack: err.stack,
      errJson: j
    })
    return res.status(500).json(j);
  } finally {
    // The multipart upload (case content) is read into memory above; remove it on every
    // path, including the early 400s (main removed it only once read).
    if (req.file?.path) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
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
  refreshReplay(job);
  const body = {
    job_id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    pages_total: job.pages_total,
    pages_converted: job.pages_converted
  };
  // Extra fields only when the request opted into the cache, so the response
  // shape is unchanged for callers that do not use it.
  if (job.cacheInfo) {
    body.cache = { ...job.cacheInfo };
    body.replay_pace_ms = job.replay ? job.replay.paceMs : null;
  }
  res.json(body);
});

/**
 * GET /conversions/documents/:jobId/pages?after=N[&limit=M]
 *
 * Page chunks completed so far, for live, cached and replayed jobs alike.
 * `after=N` skips the first N pages (pages are 1-based, so it returns page N+1 on).
 * Each page has the same shape as an entry of the final result's chunks.pages.
 * Response:
 *   { job_id, status, pages_total, pages_converted, after, next_after, pages: [...] }
 * Poll with after=next_after until status is "complete" (or "error") and no pages remain.
 */
router.get('/documents/:jobId/pages', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  const after = req.query.after === undefined ? 0 : Number(req.query.after);
  if (!Number.isInteger(after) || after < 0) {
    return res.status(400).json({ error: 'after must be a non-negative integer' });
  }
  let limit = null;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
  }
  refreshReplay(job);
  const done = pagesSoFar(job);
  const slice = done.slice(after, limit ? after + limit : undefined);
  res.json({
    job_id: job.id,
    status: job.status,
    error: job.error,
    pages_total: job.pages_total,
    pages_converted: job.pages_converted,
    after,
    next_after: after + slice.length,
    pages: slice
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
  refreshReplay(job);
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
 * Pages finished so far for any job: live (still processing), replayed, or complete.
 */
function pagesSoFar(job) {
  if (job.status === 'complete' && job.finalDocObject?.chunks?.pages) {
    return job.finalDocObject.chunks.pages;
  }
  if (job.replay) {
    return job.replay.pages.slice(0, job.pages_converted || 0);
  }
  return job.livePages ? job.livePages.slice(0, job.pages_converted || job.livePages.length) : [];
}

/**
 * Advance a replayed job to where its clock says it should be. Page k (1-based)
 * is revealed at start + k * pace; the job completes once all pages are out.
 * Computed on read, so no timers are left running.
 */
function refreshReplay(job, now = Date.now()) {
  const r = job.replay;
  if (!r || r.done) return;
  const total = r.pages.length;
  const revealed = r.paceMs > 0
    ? Math.min(total, Math.floor((now - r.startedAt) / r.paceMs))
    : total;
  job.pages_converted = revealed;
  if (revealed >= total) {
    job.finalDocObject = r.doc;
    job.status = 'complete';
    r.done = true;
  }
}

/**
 * Re-label a cached result with this request's filename: everything else in a
 * cached result is a function of the cache key, but the filename is not part of it.
 */
function retargetFilename(doc, newName) {
  const copy = JSON.parse(JSON.stringify(doc));
  const oldName = copy?.metadata?.originating_filename ?? '';
  if (oldName === newName) return copy;
  const oldLine = `<!-- METADATA originating_filename: ${oldName} -->`;
  const newLine = `<!-- METADATA originating_filename: ${newName} -->`;
  const fix = str => (typeof str === 'string' ? str.split(oldLine).join(newLine) : str);
  if (copy.metadata) copy.metadata.originating_filename = newName;
  copy.content = fix(copy.content);
  for (const page of copy?.chunks?.pages || []) {
    if (page.metadata && 'originating_filename' in page.metadata) {
      page.metadata.originating_filename = newName;
    }
    page.content = fix(page.content);
  }
  return copy;
}

function shortKey(key) {
  return key ? key.slice(0, 12) : null;
}

/**
 * Serve a job from cache if its policy allows and the entry exists; otherwise
 * convert it live and (policy "use" or "refresh") store the result.
 */
async function runConversionJob(jobRec) {
  if (jobRec.cachePolicy === 'use') {
    let entry = null;
    try {
      entry = await getCacheStore().get(jobRec.cacheKey);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'cache lookup failed', key: shortKey(jobRec.cacheKey), err: err?.name }));
    }
    if (entry && entry.format === CACHE_FORMAT && entry.result) {
      const doc = retargetFilename(entry.result, jobRec.originatingFilename || '');
      const pages = doc?.chunks?.pages || [];
      jobRec.cacheInfo.hit = true;
      jobRec.fileBuffer = null;
      jobRec.pages_total = pages.length;
      console.log(JSON.stringify({
        event: 'cache hit', key: shortKey(jobRec.cacheKey), pages: pages.length, replay_pace_ms: jobRec.replayPaceMs
      }));
      if (jobRec.onPage) {
        // In-process caller: report pages as they are "converted", at the replay pace.
        jobRec.status = 'processing';
        jobRec.pages_converted = 0;
        jobRec.livePages = [];
        for (const page of pages) {
          if (jobRec.replayPaceMs) await sleep(jobRec.replayPaceMs);
          jobRec.livePages.push(page);
          jobRec.pages_converted += 1;
          notifyPage(jobRec, page);
        }
        jobRec.finalDocObject = doc;
        jobRec.status = 'complete';
      } else if (jobRec.replayPaceMs) {
        jobRec.status = 'processing';
        jobRec.pages_converted = 0;
        jobRec.replay = { startedAt: Date.now(), paceMs: jobRec.replayPaceMs, pages, doc, done: false };
        refreshReplay(jobRec);
      } else {
        jobRec.pages_converted = pages.length;
        jobRec.finalDocObject = doc;
        jobRec.status = 'complete';
      }
      return;
    }
    jobRec.cacheInfo.hit = false;
    console.log(JSON.stringify({ event: 'cache miss', key: shortKey(jobRec.cacheKey) }));
  } else if (jobRec.cachePolicy === 'refresh') {
    jobRec.cacheInfo.hit = false;
  }

  await processDocumentAsync(jobRec);

  if (jobRec.cachePolicy === 'use' || jobRec.cachePolicy === 'refresh') {
    const doc = jobRec.finalDocObject;
    // Only clean, complete results are cached; partial/failed transcriptions
    // (continue_on_failure placeholders) would otherwise replay forever.
    if (jobRec.status === 'complete' && doc && !doc.metadata?.transcription_status) {
      try {
        await getCacheStore().put(jobRec.cacheKey, {
          format: CACHE_FORMAT,
          key: jobRec.cacheKey,
          created_at: new Date().toISOString(),
          model: jobRec.model,
          pages_total: doc.chunks?.pages?.length ?? null,
          result: doc
        });
        jobRec.cacheInfo.stored = true;
        console.log(JSON.stringify({ event: 'cache store', key: shortKey(jobRec.cacheKey) }));
      } catch (err) {
        console.warn(JSON.stringify({ event: 'cache store failed', key: shortKey(jobRec.cacheKey), err: err?.name }));
      }
    }
  }
}

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
  try {
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
    }
  } finally {
    // Written above for every file type; processPdfDocument also removes it.
    await fs.promises.unlink(tmpPdfPath).catch(() => {});
  }
}

/**
 * If PDF, do the original OCR + fallback approach
 */
export async function processPdfDocument(jobRec, tmpPdfPath) {
  const deps = pdfProcessingDeps;

  try {
    const parsed = await deps.parsePdf(jobRec.fileBuffer);
    const numPages = parsed.numpages || 1;
    jobRec.pages_total = numPages;
    jobRec.pages_converted = 0;

    let chunkPages = [];
    let allTextPieces = [];
    let currentStart = 0;
    // Exposed for GET /documents/:jobId/pages while the job is still running.
    jobRec.livePages = chunkPages;

    // Convert one page. Returns its chunk (start is assigned on commit) and, when
    // boundary detection is on, the page image for the next page's comparison.
    const convertPage = async (i, previousPageImageDataUrl) => {
      let pageChunk;
      let pagePngPath = null;
      let imageDataUrl = null;
      
      try {
        // Recorded before conversion so a converter that writes the PNG and then throws
        // still gets it removed; pdf2pic names it <savePath>/<saveFilename>.<page>.<format>.
        pagePngPath = path.join('uploads', `page_${i}_${jobRec.id}.${i + 1}.png`);
        const converter = deps.createPdfConverter(tmpPdfPath, {
          density: 300,
          saveFilename: `page_${i}_${jobRec.id}`,
          savePath: 'uploads',
          format: 'png',
          width: 1536,
          height: 1988
        });
        const output = await converter(i + 1); // pdf2pic is 1-based index
        if (output?.path) pagePngPath = output.path;
        if (!output?.path) {
          throw new Error(`No path from pdf2pic for page ${i}`);
        }

        // read as PNG
        const image = await deps.readImage(output.path);
        const pngBuffer = await image.getBuffer('image/png');

        // Tesseract OCR; skipped when no confidence could pass the threshold
        // (ocr_threshold > 1 sends every page to the vision model).
        const ocr = jobRec.ocr_threshold > 1
          ? { text: '', qualityScore: 0 }
          : await deps.ocrPageBuffer(pngBuffer);
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
          const fallbackResult = await deps.fallbackVisionModel(
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
              const boundaryOnly = await deps.fallbackVisionModel(
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
          imageDataUrl = `data:image/png;base64,${pageBase64}`;
        }
      } catch (pageError) {
        console.error(`[Page ${i + 1}] Processing failed:`, pageError.message);
        
        if (pageError instanceof ProviderException
          && pageError.interpretedErrorType == 'content_filter_violation'
          && jobRec.continue_on_failure)
        {
          console.log(`[Page ${i + 1}] Creating error placeholder due to --continue-on-failure flag`);
          pageChunk = createErrorPage(i, pageError, jobRec);
        } else {
          // Re-throw the error to maintain current behavior when flag not set
          throw pageError;
        }
      } finally {
        // The page PNG holds case content: remove it whether or not the page succeeded.
        if (pagePngPath) {
          Promise.resolve(deps.unlinkFile(pagePngPath)).catch(() => {});
        }
      }

      return { pageChunk, imageDataUrl };
    };

    // Pages are committed strictly in order, whatever order they finish in.
    const commit = (pageChunk, i) => {
      pageChunk.start = currentStart;
      chunkPages.push(pageChunk);
      allTextPieces.push(pageChunk.content);
      currentStart += pageChunk.length;
      jobRec.pages_converted = i + 1;
      notifyPage(jobRec, pageChunk);
    };

    // Boundary detection compares each page with the one before, so it is sequential.
    const concurrency = jobRec.detect_document_boundaries
      ? 1 : Math.max(1, Math.min(numPages, Number(jobRec.page_concurrency) || 1));
    if (concurrency === 1) {
      let previous = null;
      for (let i = 0; i < numPages; i++) {
        const { pageChunk, imageDataUrl } = await convertPage(i, previous);
        previous = imageDataUrl;
        commit(pageChunk, i);
      }
    } else {
      const finished = new Array(numPages);
      let next = 0;
      let toCommit = 0;
      let failure = null;
      const worker = async () => {
        while (!failure && next < numPages) {
          const i = next++;
          try {
            finished[i] = (await convertPage(i, null)).pageChunk;
          } catch (err) {
            failure ??= err;
            return;
          }
          while (toCommit < numPages && finished[toCommit]) {
            commit(finished[toCommit], toCommit);
            finished[toCommit] = null;
            toCommit++;
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (failure) throw failure;
    }

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
      const j = jsonSafeFromException(err)
      console.error({"event":"PDF processing failed",
        stack: err.stack,
        errJson: j
      })
      jobRec.error = j;
    }
  } finally {
    // The temp PDF holds case content: remove it on failure too (main only did on success).
    await Promise.resolve(deps.unlinkFile(tmpPdfPath)).catch(() => {});
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
    jobRec.livePages = chunkPages;

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
    const j = jsonSafeFromException(err)
    console.error({"event":"DOCX processing failed",
      stack: err.stack,
      errJson: j
    })
    jobRec.error = j;
  } finally {
    await fs.promises.unlink(tmpDocxPath).catch(() => {});
  }
}

export default router;
