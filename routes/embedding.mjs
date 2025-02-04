// routes/embedding.mjs
import express from 'express';
import { fetchProvider } from '../lib/core.mjs';

const router = express.Router();

/**
 * POST /embedding
 * 
 * Request body:
 *   {
 *     "model": "my-embedding-model",
 *     "text": "string to embed"
 *   }
 * 
 * Response:
 *   {
 *     "embedding": [ 0.0123, 0.0456, ... ]
 *   }
 */
router.post('/', async (req, res) => {
  try {
    const { model, text } = req.body;

    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: 'Field "model" is required.' });
    }
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Field "text" is required and must be a string.' });
    }

    // Load the provider for this model:
    const provider = fetchProvider(model);

    // Check that the provider has an embed() method:
    if (typeof provider.embed !== 'function') {
      return res.status(400).json({ error: `Model "${model}" does not support embeddings.` });
    }

    // Call the provider to get embeddings:
    const embeddingArray = await provider.embed(text);

    // Return the embedding vector:
    return res.json({ embedding: embeddingArray });
  } catch (error) {
    console.error('Error in /embedding:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default router;
