// charmonator/routes/list-models.mjs
import express from 'express';
import { getConfig } from '../lib/config.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';

const router = express.Router();

router.get('/models', async (req, res) => {
  try {
    const config = getConfig();
    
    // Extract model information from config
    const models = Object.entries(config.models || {}).map(([id, model]) => ({
      id,
      name: model.name || id,
      description: model.description || ''
    }));

    res.json({ models });
    
  } catch (error) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error listing models",
      stack: err.stack,
      errJson: j
    })
    res.status(500).json(j);
  }
});

// Alias endpoint: /options returns the same data as /models
router.get('/options', async (req, res) => {
  try {
    const config = getConfig();
    
    // Extract model information from config
    const models = Object.entries(config.models || {}).map(([id, model]) => ({
      id,
      name: model.name || id,
      description: model.description || ''
    }));

    res.json({ models });
    
  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error listing options",
      stack: err.stack,
      errJson: j
    })
    res.status(500).json(j);
  }
});

export default router;

