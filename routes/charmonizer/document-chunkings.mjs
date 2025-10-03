// File: routes/charmonizer/document-chunkings.mjs

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { JSONDocument } from '../../lib/json-document.mjs';
import { jsonSafeFromException } from '../../lib/providers/provider_exception.mjs';

/**
 * In-memory store for chunking jobs.
 * For production, store in a DB or persistent store.
 */
const chunkingJobs = {};

/**
 * Helper to create a new chunking job record in memory.
 */
function createChunkingJob(document, strategy, chunkSize, chunkGroup) {
  const jobId = uuidv4();
  chunkingJobs[jobId] = {
    job_id: jobId,
    status: 'pending',
    error: null,
    progress: 0,  // 0..100
    createdAt: Date.now(),

    // Save the request data:
    request: {
      document,
      strategy,
      chunk_size: chunkSize,
      chunk_group: chunkGroup
    },

    chunks: null  // final chunk results when done
  };
  return chunkingJobs[jobId];
}

/**
 * runChunkingJob(job) processes the chunking in background.
 */
async function runChunkingJob(job) {
  try {
    job.status = 'in_progress';
    job.progress = 0;

    const { document, strategy, chunk_size, chunk_group } = job.request;

    // Wrap user doc in JSONDocument
    const topDoc = new JSONDocument(document);

    // If the doc has no chunk groups, or the chunk_group doesn’t exist:
    // we create chunk_group with a single chunk containing getResolvedContent().
    if (!topDoc._doc.chunks) {
      topDoc._doc.chunks = {};
    }
    if (!topDoc._doc.chunks[chunk_group]) {
      const fullText = topDoc.getResolvedContent() || '';
      topDoc._doc.chunks[chunk_group] = [
        {
          id: `${topDoc.id}/${chunk_group}@0`,
          parent: topDoc.id,
          content: fullText
        }
      ];
    }

    // Grab the filename from top-level metadata if available
    let filename = 'Document';
    if (document.metadata && document.metadata.originating_filename) {
      filename = document.metadata.originating_filename;
    } else if (document.metadata && document.metadata.filename) {
      filename = document.metadata.filename;
    }

    // For "merge_and_split" strategy:
    if (strategy === 'merge_and_split') {
      if (!chunk_size || chunk_size < 1) {
        throw new Error('Invalid chunk_size for merge_and_split (must be > 0).');
      }

      // mergeChunksByTokenCount does both merging and splitting around maxTokens
      // We'll store results in a new group, e.g. chunk_group + ":mergedAndSplit"
      const newGroupName = `${chunk_group}:mergedAndSplit`;
      const newChunks = topDoc.mergeChunksByTokenCount(
        chunk_size,
        chunk_group,        // source group
        'cl100k_base',      // Tiktoken encoding
        newGroupName        // new group name
      );

      job.progress = 100;

      // Transform them to the design’s { chunk_index, chunk_data } array
      job.chunks = newChunks.map((chunkObj, idx) => ({
        chunk_index: idx + 1,
        chunk_data: {
          title: `${filename} (Part ${idx + 1})`,
          body: chunkObj.content
        }
      }));

      job.status = 'complete';

    } else if (strategy === 'split_by_token_count') {
      if (!chunk_size || chunk_size < 1) {
        throw new Error('Invalid chunk_size for split_by_token_count (must be > 0).');
      }

      // mergeChunksByTokenCount does both merging and splitting around maxTokens
      // We'll store results in a new group, e.g. chunk_group + ":mergedAndSplit"
      const newGroupName = `${chunk_group}:splitByTokenCount`;
      const newChunks = topDoc.splitOversizedChunksByTokenCount(
        chunk_size,
        chunk_group,        // source group
        'cl100k_base',      // Tiktoken encoding
        newGroupName        // new group name
      );

      job.progress = 100;

      // Transform them to the design’s { chunk_index, chunk_data } array
      job.chunks = newChunks.map((chunkObj, idx) => ({
        chunk_index: idx + 1,
        chunk_data: {
          title: `${filename} (Part ${idx + 1})`,
          body: chunkObj.content
        }
      }));

      job.status = 'complete';

    } else {
      throw new Error(`Unsupported strategy: ${strategy}`);
    }

  } catch (err) {
    job.status = 'error';
    const j = jsonSafeFromException(err)
    console.error({"event":"Error chunking",
      stack: err.stack,
      errJson: j
    })
    job.error = j;
    job.progress = 100;
  }
}


const router = express.Router();

/**
 * POST /charmonizer/v1/chunkings
 *
 * Request body example:
 *  {
 *    "document": { ... },
 *    "strategy": "merge_and_split",
 *    "chunk_size": 1000,
 *    "chunk_group": "pages"
 *  }
 */
router.post('/', async (req, res) => {
  try {
    const {
      document,
      strategy,
      chunk_size,
      chunk_group
    } = req.body;

    // Basic validation
    if (!document || typeof document !== 'object') {
      return res.status(400).json({ error: 'Field "document" must be a JSON object.' });
    }
    if (!strategy || typeof strategy !== 'string') {
      return res.status(400).json({ error: 'Field "strategy" must be a string.' });
    }
    if (strategy === 'merge_and_split' || strategy === 'split_by_token_count') {
      if (typeof chunk_size !== 'number' || chunk_size <= 0) {
        return res.status(400).json({ error: 'chunk_size must be a positive number.' });
      }
    } else {
      return res.status(400).json({ error: `Unsupported strategy: ${strategy}` });
    }

    // If chunk_group not provided, default to 'all'
    const finalChunkGroup = chunk_group || 'all';

    // Create job record
    const job = createChunkingJob(document, strategy, chunk_size, finalChunkGroup);

    // Start async
    runChunkingJob(job).catch(err => {
      job.status = 'error';
      job.error = String(err);
      job.progress = 100;
    });

    // Return 201 Created
    return res.status(201).json({
      job_id: job.job_id,
      status: job.status
    });

  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error in POST /charmonizer/v1/chunkings",
      stack: err.stack,
      errJson: j
    })
    res.status(500).json(j);
  }
});

/**
 * GET /charmonizer/v1/chunkings/:job_id
 * Returns the job status and progress.
 */
router.get('/:job_id', (req, res) => {
  const { job_id } = req.params;
  const job = chunkingJobs[job_id];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }

  const out = {
    job_id: job.job_id,
    status: job.status,
    progress: job.progress
  };
  if (job.status === 'error') {
    out.error = job.error;
  }
  res.json(out);
});

/**
 * GET /charmonizer/v1/chunkings/:job_id/result
 *
 * If complete, returns { job_id, chunks: [...] }
 * If still in progress, returns 409
 * If error, returns 409 with error
 * If job not found, 404
 */
router.get('/:job_id/result', (req, res) => {
  const { job_id } = req.params;
  const job = chunkingJobs[job_id];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }

  if (job.status !== 'complete') {
    if (job.status === 'error') {
      return res.status(409).json({
        job_id: job.job_id,
        status: 'error',
        error: job.error
      });
    }
    return res.status(409).json({ error: 'Job not complete yet' });
  }

  // Return final chunk array
  res.json({
    job_id: job.job_id,
    chunks: job.chunks
  });
});

export default router;
