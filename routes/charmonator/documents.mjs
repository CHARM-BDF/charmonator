/**
 * routes/charmonator/documents.mjs
 *
 * REST endpoints for document operations (json-doc functionality):
 *   POST /documents                    - Wrap raw content into a document
 *   POST /documents/combine            - Concatenate multiple documents
 *   POST /documents/markdown           - Extract markdown from document
 *   POST /documents/summary            - Extract summary annotation
 *   POST /documents/chunks/merge       - Merge chunks by token count
 *   POST /documents/chunks/annotations - Extract chunk annotations
 */

import express from 'express';
import crypto from 'crypto';
import { JSONDocument } from '../../lib/json-document.mjs';

const router = express.Router();

/**
 * Helper to extract text from various delta-fold formats:
 * - String containing JSON: '{"delta":"text"}' -> 'text'
 * - Object with delta: {delta: 'text'} -> 'text'
 * - Plain string: 'text' -> 'text'
 */
function extractDeltaText(item) {
  if (typeof item === 'string') {
    try {
      const parsed = JSON.parse(item);
      if (parsed && typeof parsed.delta === 'string') {
        return parsed.delta;
      }
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch (e) {
      return item;
    }
  } else if (item && typeof item === 'object') {
    if (typeof item.delta === 'string') {
      return item.delta;
    }
    return JSON.stringify(item);
  }
  return String(item);
}

/**
 * POST /documents
 * Wrap raw content into a valid document object.
 */
router.post('/', (req, res) => {
  try {
    const { content } = req.body;

    if (content === undefined || content === null) {
      return res.status(400).json({ error: 'content is required' });
    }

    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    const hash = crypto.createHash('sha256').update(contentStr).digest('hex');

    res.json({
      document: {
        id: hash,
        content: contentStr
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /documents/combine
 * Combine multiple documents into a single master document.
 */
router.post('/combine', (req, res) => {
  try {
    const { documents, master_id = null, group_name = 'sources' } = req.body;

    if (!documents || !Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ error: 'documents array is required and must not be empty' });
    }

    const masterDoc = JSONDocument.createMasterDocFromDocs(documents, {
      masterDocId: master_id,
      docGroupName: group_name
    });

    res.json({
      document: masterDoc.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /documents/markdown
 * Extract markdown/text content from a document.
 */
router.post('/markdown', (req, res) => {
  try {
    const { document, include_metadata = false } = req.body;

    if (!document) {
      return res.status(400).json({ error: 'document is required' });
    }

    const doc = new JSONDocument(document);
    let markdown = '';

    // Check if we need to reassemble from a content_chunk_group
    const contentChunkGroup = document.content_chunk_group;
    const hasChunkGroup =
      contentChunkGroup &&
      document.chunks &&
      Array.isArray(document.chunks[contentChunkGroup]);

    if (hasChunkGroup) {
      const chunks = document.chunks[contentChunkGroup];
      for (const chunkObj of chunks) {
        if (include_metadata && chunkObj.metadata) {
          for (const [key, value] of Object.entries(chunkObj.metadata)) {
            markdown += `<!-- ${key}: ${value} -->\n`;
          }
        }
        const chunkDoc = new JSONDocument(chunkObj, doc);
        markdown += chunkDoc.getResolvedContent() + '\n';
      }
    } else {
      if (include_metadata && document.metadata) {
        for (const [key, value] of Object.entries(document.metadata)) {
          markdown += `<!-- ${key}: ${value} -->\n`;
        }
      }
      markdown += doc.getResolvedContent();
    }

    res.json({ markdown: markdown.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /documents/summary
 * Extract summary annotation from a document (handles delta-fold arrays).
 */
router.post('/summary', (req, res) => {
  try {
    const { document, field = 'summary', separator = '\n\n--\n\n' } = req.body;

    if (!document) {
      return res.status(400).json({ error: 'document is required' });
    }

    const annotations = document.annotations;
    if (!annotations || annotations[field] === undefined) {
      return res.json({ summary: null, message: `No ${field} found in annotations` });
    }

    const summary = annotations[field];
    let result;

    if (Array.isArray(summary)) {
      // Delta-fold format - extract and join
      const extracted = summary.map(extractDeltaText).filter(t => t && t.trim());
      result = extracted.join(separator);
    } else if (typeof summary === 'object' && summary.delta !== undefined) {
      result = summary.delta;
    } else if (typeof summary === 'object') {
      result = JSON.stringify(summary, null, 2);
    } else {
      result = String(summary);
    }

    res.json({ summary: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /documents/chunks/merge
 * Merge small chunks into larger ones (up to max_tokens).
 */
router.post('/chunks/merge', (req, res) => {
  try {
    const {
      document,
      max_tokens,
      encoding = 'cl100k_base',
      chunk_group = 'pages',
      new_group_name = null,
      overlap_tokens = 0
    } = req.body;

    if (!document) {
      return res.status(400).json({ error: 'document is required' });
    }
    if (!max_tokens || typeof max_tokens !== 'number' || max_tokens < 1) {
      return res.status(400).json({ error: 'max_tokens must be a positive integer' });
    }

    const doc = new JSONDocument(document);
    const oldChunks = doc.getChunksForGroup(chunk_group);
    const oldCount = oldChunks ? oldChunks.length : 0;

    const newChunks = doc.mergeChunksByTokenCount(
      max_tokens,
      chunk_group,
      encoding,
      new_group_name,
      overlap_tokens
    );

    const actualNewGroupName = new_group_name || `${chunk_group}:merged(${max_tokens},${encoding})`;

    res.json({
      document: doc.toObject(),
      old_chunk_count: oldCount,
      new_chunk_count: newChunks.length,
      new_group_name: actualNewGroupName
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /documents/chunks/annotations
 * Extract annotations from each chunk in a chunk group.
 */
router.post('/chunks/annotations', (req, res) => {
  try {
    const {
      document,
      chunk_group,
      target = 'summary',
      include_metadata = false
    } = req.body;

    if (!document) {
      return res.status(400).json({ error: 'document is required' });
    }
    if (!chunk_group) {
      return res.status(400).json({ error: 'chunk_group is required' });
    }

    if (!document.chunks || !document.chunks[chunk_group]) {
      return res.status(400).json({ error: `Chunk group "${chunk_group}" not found in document` });
    }

    const chunks = document.chunks[chunk_group];
    const annotations = [];

    for (const chunk of chunks) {
      const entry = {};

      if (include_metadata && chunk.metadata) {
        entry.metadata = chunk.metadata;
      }

      if (chunk.annotations && chunk.annotations[target] !== undefined) {
        const annotationValue = chunk.annotations[target];
        if (Array.isArray(annotationValue)) {
          entry.annotation = annotationValue.map(extractDeltaText).join('\n');
        } else {
          entry.annotation = extractDeltaText(annotationValue);
        }
      } else {
        entry.annotation = null;
      }

      annotations.push(entry);
    }

    res.json({ annotations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
