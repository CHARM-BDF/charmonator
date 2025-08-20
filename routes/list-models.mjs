// charmonator/routes/list-models.mjs
import express from 'express';
import { getConfig } from '../lib/config.mjs';

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
    console.error('Error listing models:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
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
    
  } catch (error) {
    console.error('Error listing models:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

export default router;

