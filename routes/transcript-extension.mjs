import express from 'express';
import { doTranscriptExtension } from '../lib/transcript-extension.mjs';

const router = express.Router();

router.post('/extension', async (req, res) => {
  console.log(JSON.stringify({
    event: 'request',
    url: '/transcript/extension' + req.url,
    body: req.body
  }));
  return doTranscriptExtension(req, res);
});

export default router;
