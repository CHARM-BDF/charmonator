/**
 * routes/charmonator/translator.mjs
 *
 * REST endpoints for NCATS Translator/ARS query processing:
 *   POST /query         - Process a translator query by PK
 *   GET  /environments  - List available ARS environments
 */

import express from 'express';
import {
  URL_DICT,
  processTranslatorData,
  generateCSVContent,
  computeSummaryStats,
  createTranslatorKnowledgeGraph
} from '../../tools/translator/translator_core.mjs';

const router = express.Router();

/**
 * GET /environments
 * Returns the list of available ARS environments.
 */
router.get('/environments', (req, res) => {
  res.json({
    environments: Object.keys(URL_DICT),
    urls: URL_DICT
  });
});

/**
 * POST /query
 * Process a Translator/ARS query by primary key.
 *
 * Body: { pk: string, environment?: string, format?: 'json'|'csv' }
 */
router.post('/query', async (req, res) => {
  try {
    const { pk, environment = 'prod', format = 'json' } = req.body;

    if (!pk || typeof pk !== 'string') {
      return res.status(400).json({ error: 'pk (string) is required in request body' });
    }

    if (environment && !URL_DICT[environment]) {
      return res.status(400).json({
        error: `Invalid environment: "${environment}". Valid options: ${Object.keys(URL_DICT).join(', ')}`
      });
    }

    const processedData = await processTranslatorData(pk, environment);

    if (processedData.length === 0) {
      return res.json({
        pk,
        environment,
        totalRelationships: 0,
        message: 'No results found for this PK'
      });
    }

    if (format === 'csv') {
      const csv = generateCSVContent(processedData);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="translator_${pk}.csv"`);
      return res.send(csv);
    }

    const stats = computeSummaryStats(processedData, pk, environment);
    const knowledgeGraph = createTranslatorKnowledgeGraph(processedData, pk);

    res.json({
      stats,
      knowledgeGraph,
      data: processedData
    });
  } catch (err) {
    console.error('[translator route] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
