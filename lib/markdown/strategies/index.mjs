/**
 * lib/markdown/strategies/index.mjs
 *
 * Strategy registry for markdown chunking strategies.
 */

import { markdownHeadersStrategy } from './markdown-headers.mjs';
import { markdownBlocksStrategy } from './markdown-blocks.mjs';
import { recursiveSeparatorsStrategy } from './recursive-separators.mjs';
import { slidingWindowStrategy } from './sliding-window.mjs';
import { sentencePackStrategy } from './sentence-pack.mjs';
import { obsidianStrategy } from './obsidian.mjs';

/**
 * @typedef {Object} StrategyDefinition
 * @property {string} id - Strategy identifier
 * @property {string} description - Human-readable description
 * @property {Object} options_schema - JSON Schema for strategy options
 */

/**
 * Registry of all available chunking strategies
 */
const STRATEGIES = {
  markdown_headers: markdownHeadersStrategy,
  markdown_blocks: markdownBlocksStrategy,
  recursive_separators: recursiveSeparatorsStrategy,
  sliding_window: slidingWindowStrategy,
  sentence_pack: sentencePackStrategy,
  obsidian: obsidianStrategy
};

/**
 * Get all registered strategies with their schemas.
 * @returns {StrategyDefinition[]}
 */
export function getStrategies() {
  return Object.values(STRATEGIES).map(strategy => ({
    id: strategy.id,
    description: strategy.description,
    options_schema: strategy.options_schema
  }));
}

/**
 * Get a specific strategy by ID.
 * @param {string} id - Strategy ID
 * @returns {Object} Strategy implementation
 * @throws {Error} If strategy not found
 */
export function getStrategy(id) {
  const strategy = STRATEGIES[id];
  if (!strategy) {
    const available = Object.keys(STRATEGIES).join(', ');
    throw new Error(`Unknown strategy "${id}". Available strategies: ${available}`);
  }
  return strategy;
}

/**
 * Check if a strategy exists.
 * @param {string} id - Strategy ID
 * @returns {boolean}
 */
export function hasStrategy(id) {
  return id in STRATEGIES;
}

/**
 * Get list of supported tokenizer encodings
 * @returns {string[]}
 */
export function getSupportedTokenizers() {
  return ['cl100k_base', 'o200k_base'];
}

export default {
  getStrategies,
  getStrategy,
  hasStrategy,
  getSupportedTokenizers
};
