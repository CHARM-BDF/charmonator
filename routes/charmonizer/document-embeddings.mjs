// routes/charmonizer/document-embeddings.mjs

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { JSONDocument } from '../../lib/json-document.mjs';
import { embedding } from '../../lib/core.mjs';
import { jsonSafeFromException } from '../../lib/providers/provider_exception.mjs';

/**
 * We'll store embedding jobs in-memory, keyed by job ID.
 * For production, store these in a DB or persistent store.
 */
const jobs = {};

/**
 * Create a new job record.
 */
function createJobRecord(docObject, modelName, chunkGroup) {
  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'pending',
    error: null,
    createdAt: Date.now(),

    // user-provided:
    docObject,
    modelName,
    chunkGroup,

    // progress info
    chunks_total: 0,
    chunks_completed: 0,

    // result
    finalDocObject: null
  };
  return jobs[jobId];
}

/**
 * processEmbeddingAsync() does the heavy lifting in the background:
 *  1. wraps doc object in JSONDocument
 *  2. enumerates chunkGroup array
 *  3. calls embedding() on each chunk's text
 *  4. stores embedding in chunkObj.embeddings[modelName]
 *  5. repeats until done, or error
 */
async function processEmbeddingAsync(job) {
  job.status = 'processing';

  try {
    const topDoc = new JSONDocument(job.docObject);
    const chunkGroupName = job.chunkGroup || 'pages';

    // retrieve the chunk array
    const chunkArray = topDoc.getChunksForGroup(chunkGroupName);
    if (!chunkArray || !Array.isArray(chunkArray)) {
      throw new Error(`No chunk group named "${chunkGroupName}" found on document.`);
    }

    job.chunks_total = chunkArray.length;

    // For each chunk, fetch an embedding:
    for (let i = 0; i < chunkArray.length; i++) {
      const chunkObj = chunkArray[i];
      const chunkDoc = new JSONDocument(chunkObj, topDoc);
      const text = chunkDoc.getResolvedContent() || '';
      
      const vector = await embedding(job.modelName, text);
      
      // Attach embedding to the raw chunk
      chunkObj.embeddings = chunkObj.embeddings || {};
      chunkObj.embeddings[job.modelName] = vector;
      
      // Now just stick chunkObj back into the array, no .toObject() needed
      chunkArray[i] = chunkObj;
      
      // done
      job.chunks_completed = i + 1;

    }

    // store updated chunk array back in doc
    topDoc.setChunksForGroup(chunkGroupName, chunkArray);

    // The final doc is now done:
    job.finalDocObject = topDoc.toObject();
    job.status = 'complete';
  } catch (err) {
    job.status = 'error';
    const j = jsonSafeFromException(err)
    console.error({"event":"[Embeddings] job error",
      stack: err.stack,
      errJson: j
    })
    job.error = j;
  }
}

// Express Router
const router = express.Router();

/**
 * POST /embeddings
 * 
 * Creates a new job to compute embeddings for the specified chunk group
 * in the provided JSON document, using the specified model.
 *
 * Request body fields:
 *   - document (JSON)  : the doc object
 *   - model   (string) : model name to use for embedding
 *   - chunk_group (string) optional, default 'pages'
 * 
 * Response:
 *   202 + { "job_id": "uuid" }
 */
router.post('/', (req, res) => {
  try {
    const { document, model, chunk_group } = req.body;
    if (!document) {
      return res.status(400).json({ error: 'Missing "document" in request body.' });
    }
    if (!model) {
      return res.status(400).json({ error: 'Missing "model" in request body.' });
    }

    // create a job
    const job = createJobRecord(document, model, chunk_group || 'pages');

    // run in background
    processEmbeddingAsync(job).catch(err => {
      job.status = 'error';
      const j = jsonSafeFromException(err)
      console.error({"event":"[Embeddings] Async error in job",
        stack: err.stack,
        errJson: j
      })
      job.error = j;
    });

    // return job id to client
    return res.status(202).json({ job_id: job.id });
  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"[POST /embeddings] error",
      stack: err.stack,
      errJson: j
    })
    return res.status(500).json({ error: j });
  }
});

/**
 * GET /embeddings/:jobId
 * 
 * Returns status info:
 *  {
 *    status: "pending" | "processing" | "complete" | "error",
 *    chunks_total,
 *    chunks_completed,
 *    error: <if error>
 *  }
 */
router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }

  return res.json({
    status: job.status,
    chunks_total: job.chunks_total,
    chunks_completed: job.chunks_completed,
    error: job.error
  });
});

/**
 * GET /embeddings/:jobId/result
 *
 * If job complete => returns final JSON doc object.
 * If job pending/processing => 202 with partial progress.
 * If job error => 500 with { status:'error', error:... }
 */
router.get('/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }

  if (job.status === 'pending' || job.status === 'processing') {
    return res.status(202).json({
      status: job.status,
      chunks_total: job.chunks_total,
      chunks_completed: job.chunks_completed
    });
  }
  if (job.status === 'error') {
    return res.status(500).json({
      status: 'error',
      error: job.error,
      chunks_total: job.chunks_total,
      chunks_completed: job.chunks_completed
    });
  }
  // complete:
  return res.json(job.finalDocObject);
});

/**
 * DELETE /embeddings/:jobId
 * 
 * Cancel or remove the job. Freed from memory.
 */
router.delete('/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  delete jobs[jobId];
  return res.json({ success: true });
});

export default router;
