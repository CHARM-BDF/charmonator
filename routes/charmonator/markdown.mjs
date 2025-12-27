/**
 * routes/charmonator/markdown.mjs
 *
 * Markdown processing endpoints for Charmonator.
 * All endpoints are synchronous and deterministic.
 */

import express from 'express';
import crypto from 'crypto';
import {
  normalizeMarkdown,
  extractMarkdown,
  segmentMarkdown,
  chunkMarkdown,
  getStrategies,
  hasStrategy,
  getSupportedTokenizers
} from '../../lib/markdown/index.mjs';
import {
  isValidEncoding,
  getSupportedEncodings,
  resolveTokenizer,
  resolveTokenizerMode
} from '../../lib/tokenizer.mjs';
import { getModelConfig } from '../../lib/config.mjs';
import { jsonSafeFromException } from '../../lib/providers/provider_exception.mjs';

const router = express.Router();

/**
 * Resolve encoding from tokenizer/model params for chunking.
 * For chunking, reject API tokenizer mode (need local encoding).
 * @param {string} tokenizer - Explicit tokenizer name
 * @param {string} model - Model name to look up
 * @returns {{ encoding?: string, error?: string }}
 */
function resolveEncodingForChunking(tokenizer, model) {
  // Mutual exclusivity check
  if (tokenizer && model) {
    return { error: 'Cannot specify both "tokenizer" and "model". Use one or the other.' };
  }

  if (tokenizer) {
    if (!isValidEncoding(tokenizer)) {
      const supported = getSupportedEncodings().join(', ');
      return { error: `Unsupported tokenizer "${tokenizer}". Supported: ${supported}` };
    }
    return { encoding: tokenizer };
  }

  if (model) {
    try {
      const modelConfig = getModelConfig(model);
      const mode = resolveTokenizerMode(modelConfig);
      if (mode === 'api') {
        return {
          error: 'Model uses API tokenizer mode; pass explicit "tokenizer" encoding for deterministic chunking.'
        };
      }
      return { encoding: resolveTokenizer(modelConfig) };
    } catch (err) {
      return { error: `Failed to resolve tokenizer for model "${model}": ${err.message}` };
    }
  }

  // Default
  return { encoding: 'cl100k_base' };
}

/**
 * GET /strategies
 *
 * List supported chunking strategies and their schemas.
 *
 * Response:
 *   {
 *     "strategies": [...],
 *     "supported_tokenizers": ["cl100k_base", "o200k_base"]
 *   }
 */
router.get('/strategies', (req, res) => {
  try {
    const strategies = getStrategies();
    const tokenizers = getSupportedTokenizers();

    return res.json({
      strategies,
      supported_tokenizers: tokenizers
    });
  } catch (err) {
    const j = jsonSafeFromException(err);
    console.error({
      event: 'Error in GET /markdown/strategies',
      stack: err.stack,
      errJson: j
    });
    res.status(500).json(j);
  }
});

/**
 * POST /normalize
 *
 * Normalize markdown in a deterministic way for stable hashing and chunking.
 *
 * Request body:
 *   {
 *     "markdown": "# Title\r\n\r\nSome text...",
 *     "options": {
 *       "line_endings": "lf",
 *       "trim_trailing_whitespace": true,
 *       "collapse_multiple_blank_lines": true,
 *       "ensure_trailing_newline": true,
 *       "frontmatter": "preserve",
 *       "obsidian": { "normalize_callouts": true }
 *     }
 *   }
 *
 * Response:
 *   {
 *     "markdown": "# Title\n\nSome text...\n",
 *     "id": "sha256-of-normalized-markdown"
 *   }
 */
router.post('/normalize', (req, res) => {
  try {
    const { markdown, options = {} } = req.body;

    // Validate markdown
    if (markdown === undefined || markdown === null) {
      return res.status(400).json({
        error: 'Field "markdown" is required.'
      });
    }

    if (typeof markdown !== 'string') {
      return res.status(400).json({
        error: 'Field "markdown" must be a string.'
      });
    }

    const result = normalizeMarkdown(markdown, options);

    return res.json(result);
  } catch (err) {
    const j = jsonSafeFromException(err);
    console.error({
      event: 'Error in POST /markdown/normalize',
      stack: err.stack,
      errJson: j
    });
    res.status(500).json(j);
  }
});

/**
 * POST /extract
 *
 * Extract plain text and metadata from markdown.
 *
 * Request body:
 *   {
 *     "markdown": "---\ntags: [foo]\n---\n# Title\n\nSee [[Note|alias]]...",
 *     "options": {
 *       "frontmatter": "metadata",
 *       "strip_html": true,
 *       "preserve_code_blocks": true,
 *       "obsidian": {
 *         "wikilinks": "text_only",
 *         "tags": "metadata_only"
 *       }
 *     }
 *   }
 *
 * Response:
 *   {
 *     "text": "Title\n\nSee alias...\n",
 *     "metadata": {
 *       "frontmatter": { "tags": ["foo"] },
 *       "tags": ["foo"],
 *       "links": [...],
 *       "headings": [...]
 *     }
 *   }
 */
router.post('/extract', (req, res) => {
  try {
    const { markdown, options = {} } = req.body;

    // Validate markdown
    if (markdown === undefined || markdown === null) {
      return res.status(400).json({
        error: 'Field "markdown" is required.'
      });
    }

    if (typeof markdown !== 'string') {
      return res.status(400).json({
        error: 'Field "markdown" must be a string.'
      });
    }

    const result = extractMarkdown(markdown, options);

    return res.json(result);
  } catch (err) {
    const j = jsonSafeFromException(err);
    console.error({
      event: 'Error in POST /markdown/extract',
      stack: err.stack,
      errJson: j
    });
    res.status(500).json(j);
  }
});

/**
 * POST /segments
 *
 * Segment markdown into atomic units.
 *
 * Request body:
 *   {
 *     "markdown": "# Title\n\nPara 1.\n\n```js\nconsole.log('hi')\n```\n",
 *     "strategy": "markdown_blocks",
 *     "options": {
 *       "atomic_blocks": ["code", "table", "list_item"]
 *     }
 *   }
 *
 * Response:
 *   {
 *     "segments": [
 *       { "type": "heading", "depth": 1, "text": "# Title", "span": {...}, "header_path": [...] },
 *       { "type": "paragraph", "text": "Para 1.", "span": {...}, "header_path": [...] },
 *       { "type": "code", "language": "js", "text": "...", "span": {...}, "header_path": [...] }
 *     ]
 *   }
 */
router.post('/segments', (req, res) => {
  try {
    const { markdown, strategy = 'markdown_blocks', options = {} } = req.body;

    // Validate markdown
    if (markdown === undefined || markdown === null) {
      return res.status(400).json({
        error: 'Field "markdown" is required.'
      });
    }

    if (typeof markdown !== 'string') {
      return res.status(400).json({
        error: 'Field "markdown" must be a string.'
      });
    }

    // Validate strategy
    if (!hasStrategy(strategy)) {
      const available = getStrategies().map(s => s.id).join(', ');
      return res.status(400).json({
        error: `Unknown strategy "${strategy}". Available strategies: ${available}`
      });
    }

    const segments = segmentMarkdown(markdown, strategy, options);

    return res.json({ segments });
  } catch (err) {
    const j = jsonSafeFromException(err);
    console.error({
      event: 'Error in POST /markdown/segments',
      stack: err.stack,
      errJson: j
    });
    res.status(500).json(j);
  }
});

/**
 * POST /chunks
 *
 * Chunk markdown into token-bounded chunks.
 * Returns a Document Object with a new chunk group.
 *
 * Request body (Option A - raw markdown):
 *   {
 *     "markdown": "# Title\n\nPara 1...\n",
 *     "strategy": "markdown_headers",
 *     "max_tokens": 512,
 *     "overlap_tokens": 64,
 *     "tokenizer": "cl100k_base",
 *     "options": { ... },
 *     "group_name": null
 *   }
 *
 * Request body (Option B - existing document):
 *   {
 *     "document": { "id": "...", "content": "..." },
 *     "strategy": "obsidian",
 *     "max_tokens": 512,
 *     ...
 *   }
 *
 * Response:
 *   {
 *     "document": { "id": "...", "content": "...", "chunks": {...} },
 *     "chunk_group": "markdown:markdown_headers(512,cl100k_base,overlap=64)",
 *     "chunks_created": 5,
 *     "warnings": []
 *   }
 */
router.post('/chunks', (req, res) => {
  try {
    const {
      markdown,
      document,
      strategy = 'markdown_blocks',
      max_tokens,
      overlap_tokens = 0,
      tokenizer,
      model,
      options = {},
      group_name
    } = req.body;

    // Validate input: need either markdown or document
    if (!markdown && !document) {
      return res.status(400).json({
        error: 'Field "markdown" or "document" is required.'
      });
    }

    if (markdown && document) {
      return res.status(400).json({
        error: 'Cannot specify both "markdown" and "document". Use one or the other.'
      });
    }

    // Get the markdown content
    let markdownContent;
    if (markdown) {
      if (typeof markdown !== 'string') {
        return res.status(400).json({
          error: 'Field "markdown" must be a string.'
        });
      }
      markdownContent = markdown;
    } else {
      if (!document.content || typeof document.content !== 'string') {
        return res.status(400).json({
          error: 'Document must have a "content" field with string value.'
        });
      }
      markdownContent = document.content;
    }

    // Validate max_tokens
    if (max_tokens === undefined || max_tokens === null) {
      return res.status(400).json({
        error: 'Field "max_tokens" is required.'
      });
    }

    if (!Number.isInteger(max_tokens) || max_tokens <= 0) {
      return res.status(400).json({
        error: 'Field "max_tokens" must be a positive integer.'
      });
    }

    // Validate overlap_tokens
    if (overlap_tokens !== undefined) {
      if (!Number.isInteger(overlap_tokens) || overlap_tokens < 0) {
        return res.status(400).json({
          error: 'Field "overlap_tokens" must be a non-negative integer.'
        });
      }

      if (overlap_tokens >= max_tokens) {
        return res.status(400).json({
          error: 'Field "overlap_tokens" must be less than "max_tokens".'
        });
      }
    }

    // Validate strategy
    if (!hasStrategy(strategy)) {
      const available = getStrategies().map(s => s.id).join(', ');
      return res.status(400).json({
        error: `Unknown strategy "${strategy}". Available strategies: ${available}`
      });
    }

    // Resolve encoding
    const encodingResult = resolveEncodingForChunking(tokenizer, model);
    if (encodingResult.error) {
      return res.status(400).json({
        error: encodingResult.error
      });
    }

    const encoding = encodingResult.encoding;

    // Perform chunking
    const result = chunkMarkdown(markdownContent, {
      strategy,
      max_tokens,
      overlap_tokens,
      encoding,
      group_name,
      strategy_options: options
    });

    return res.json(result);
  } catch (err) {
    const j = jsonSafeFromException(err);
    console.error({
      event: 'Error in POST /markdown/chunks',
      stack: err.stack,
      errJson: j
    });
    res.status(500).json(j);
  }
});

export default router;
