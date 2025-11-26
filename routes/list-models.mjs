// charmonator/routes/list-models.mjs
import express from 'express';
import { getConfig } from '../lib/config.mjs';
import { getProviderName } from '../lib/core.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';

const router = express.Router();

function listModels() {
    const config = getConfig();
    
    // Extract model information from config
    const models = Object.entries(config.models || {}).map(([id, model]) => ({
      id,
      name: model.name || id,
      model_type: model.model_type || '',
      provider: getProviderName(model),
      model: model.model || '',
      deployment: model.deployment || '',
      context_size: model.context_size || '',
      max_tokens: model.max_tokens || '',
      output_limit: model.output_limit || '',
      description: model.description || ''
    }));
    return { models }
}

router.get('/models', async (req, res) => {
  try {
    return res.json(listModels());
  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error listing models",
      stack: err.stack,
      errJson: j
    })
    return res.status(500).json(j);
  }
});

// Alias endpoint: /options returns the same data as /models
router.get('/options', async (req, res) => {
  try {
    return res.json(listModels());
  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error listing options",
      stack: err.stack,
      errJson: j
    })
    return res.status(500).json(j);
  }
});

export default router;

