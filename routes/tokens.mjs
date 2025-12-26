/**
 * routes/tokens.mjs
 *
 * Token counting and tokenization endpoints.
 */

import express from 'express';
import {
  tokenize,
  countTokens,
  isValidEncoding,
  getSupportedEncodings
} from '../lib/tokenizer.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';

const router = express.Router();

/**
 * POST /tokens
 *
 * Tokenize text and return the token strings.
 *
 * Request body:
 *   {
 *     "text": "string to tokenize",
 *     "tokenizer": "cl100k_base",  // optional: explicit tokenizer encoding
 *     "model": "openai:gpt-4o"     // optional: look up tokenizer from model config
 *   }
 *
 * Note: "tokenizer" and "model" are mutually exclusive. If neither is provided,
 * defaults to cl100k_base encoding.
 *
 * Response:
 *   {
 *     "tokens": ["Hello", ",", " world", "!"],
 *     "count": 4,
 *     "encoding": "cl100k_base",
 *     "mode": "local"
 *   }
 */
router.post('/', async (req, res) => {
  try {
    const { text, tokenizer, model } = req.body;

    // Validate text
    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'Field "text" is required and must be a string.'
      });
    }

    // Validate mutual exclusivity
    if (tokenizer && model) {
      return res.status(400).json({
        error: 'Cannot specify both "tokenizer" and "model". Use one or the other.'
      });
    }

    // Validate tokenizer name if provided
    if (tokenizer && !isValidEncoding(tokenizer)) {
      const supported = getSupportedEncodings().join(', ');
      return res.status(400).json({
        error: `Unsupported tokenizer "${tokenizer}". Supported: ${supported}`
      });
    }

    const result = await tokenize(text, { tokenizer, model });

    return res.json({
      tokens: result.tokens,
      count: result.tokens.length,
      encoding: result.encoding,
      mode: result.mode
    });
  } catch (err) {
    const j = jsonSafeFromException(err);
    console.error({
      event: 'Error in POST /tokens',
      stack: err.stack,
      errJson: j
    });
    res.status(500).json(j);
  }
});

/**
 * POST /tokens/count
 *
 * Count tokens in text without returning the individual tokens.
 * Supports both local (tiktoken) and API-based counting.
 *
 * Request body:
 *   {
 *     "text": "string to count tokens in",
 *     "tokenizer": "cl100k_base",  // optional: explicit tokenizer encoding
 *     "model": "openai:gpt-4o"     // optional: look up tokenizer from model config
 *   }
 *
 * Note: "tokenizer" and "model" are mutually exclusive. If neither is provided,
 * defaults to cl100k_base encoding.
 *
 * Response (local mode):
 *   {
 *     "count": 42,
 *     "encoding": "cl100k_base",
 *     "mode": "local"
 *   }
 *
 * Response (API mode):
 *   {
 *     "count": 42,
 *     "encoding": null,
 *     "mode": "api"
 *   }
 */
router.post('/count', async (req, res) => {
  try {
    const { text, tokenizer, model } = req.body;

    // Validate text
    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'Field "text" is required and must be a string.'
      });
    }

    // Validate mutual exclusivity
    if (tokenizer && model) {
      return res.status(400).json({
        error: 'Cannot specify both "tokenizer" and "model". Use one or the other.'
      });
    }

    // Validate tokenizer name if provided
    if (tokenizer && !isValidEncoding(tokenizer)) {
      const supported = getSupportedEncodings().join(', ');
      return res.status(400).json({
        error: `Unsupported tokenizer "${tokenizer}". Supported: ${supported}`
      });
    }

    const result = await countTokens(text, { tokenizer, model });

    return res.json({
      count: result.count,
      encoding: result.encoding,
      mode: result.mode
    });
  } catch (err) {
    const j = jsonSafeFromException(err);
    console.error({
      event: 'Error in POST /tokens/count',
      stack: err.stack,
      errJson: j
    });
    res.status(500).json(j);
  }
});

export default router;
