/**
 * lib/markdown/index.mjs
 *
 * Main exports for markdown processing module.
 * Provides deterministic markdown normalization, extraction, segmentation, and chunking.
 */

// Core functions
export { normalizeMarkdown } from './normalize.mjs';
export { extractMarkdown } from './extract.mjs';
export { segmentMarkdown, segmentByBlocks, segmentByHeaders } from './segment.mjs';
export { chunkMarkdown, generateGroupName, generateChunkId } from './chunk.mjs';

// Strategy registry
export {
  getStrategies,
  getStrategy,
  hasStrategy,
  getSupportedTokenizers
} from './strategies/index.mjs';

// Re-export individual strategies for direct access
export { markdownHeadersStrategy } from './strategies/markdown-headers.mjs';
export { markdownBlocksStrategy } from './strategies/markdown-blocks.mjs';
export { recursiveSeparatorsStrategy } from './strategies/recursive-separators.mjs';
export { slidingWindowStrategy } from './strategies/sliding-window.mjs';
export { sentencePackStrategy } from './strategies/sentence-pack.mjs';
export { obsidianStrategy } from './strategies/obsidian.mjs';

// Import for default export
import { normalizeMarkdown as _normalizeMarkdown } from './normalize.mjs';
import { extractMarkdown as _extractMarkdown } from './extract.mjs';
import { segmentMarkdown as _segmentMarkdown } from './segment.mjs';
import { chunkMarkdown as _chunkMarkdown } from './chunk.mjs';
import {
  getStrategies as _getStrategies,
  getStrategy as _getStrategy,
  hasStrategy as _hasStrategy,
  getSupportedTokenizers as _getSupportedTokenizers
} from './strategies/index.mjs';

export default {
  normalizeMarkdown: _normalizeMarkdown,
  extractMarkdown: _extractMarkdown,
  segmentMarkdown: _segmentMarkdown,
  chunkMarkdown: _chunkMarkdown,
  getStrategies: _getStrategies,
  getStrategy: _getStrategy,
  hasStrategy: _hasStrategy,
  getSupportedTokenizers: _getSupportedTokenizers
};
