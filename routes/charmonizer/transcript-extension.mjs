import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { doTranscriptExtension } from '../../lib/transcript-extension.mjs';
import { jsonSafeFromException } from '../../lib/providers/provider_exception.mjs';

const router = express.Router();
const jobs = {};

function createJobRecord(body) {
  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'pending',
    error: null,
    createdAt: Date.now(),
    requestBody: body,
    finalResult: null
  };
  return jobs[jobId];
}

async function processTranscriptExtensionAsync(job) {
  job.status = 'processing';
  try {
    const result = await doTranscriptExtension(job.requestBody);
    job.finalResult = result;
    job.status = 'complete';
  } catch (err) {
    job.status = 'error';
    job.error = jsonSafeFromException(err);
  }
}

/* POST to start an async extension */
router.post('/', (req, res) => {
  try {
    const job = createJobRecord(req.body);
    processTranscriptExtensionAsync(job).catch(err => {
      job.status = 'error';
      job.error = jsonSafeFromException(err);
    });
    return res.status(202).json({ job_id: job.id });
  } catch (err) {
    const j = jsonSafeFromException(err);
    return res.status(500).json({ error: j });
  }
});

/* GET job status */
router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  return res.json({
    status: job.status,
    error: job.error
  });
});

/* GET final result */
router.get('/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  if (job.status === 'pending' || job.status === 'processing') {
    return res.status(202).json({
      status: job.status
    });
  }
  if (job.status === 'error') {
    return res.status(500).json({
      status: 'error',
      error: job.error
    });
  }
  return res.json(job.finalResult);
});

/* DELETE to cancel/remove job */
router.delete('/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  delete jobs[jobId];
  return res.json({ success: true });
});

export default router;
