/**
 * tokenizer.mjs
 *
 * Tokenization abstraction layer supporting both local (tiktoken) and
 * provider API-based token counting.
 */

import { TextDecoder } from 'util';
import { createRequire } from 'module';
import { getModelConfig } from './config.mjs';
import { fetchProvider } from './core.mjs';

// Lazy-load tiktoken (same pattern as json-document.mjs)
let tiktokenLib = null;
function getTiktoken() {
  if (!tiktokenLib) {
    try {
      const require = createRequire(import.meta.url);
      tiktokenLib = require('tiktoken');
    } catch (err) {
      throw new Error(
        'tiktoken library is not available. Install it with: npm install tiktoken'
      );
    }
  }
  return tiktokenLib;
}

// Encoder cache to avoid recreation
const encoderCache = new Map();

/**
 * Supported tiktoken encodings
 */
const SUPPORTED_ENCODINGS = ['cl100k_base', 'o200k_base'];

/**
 * Provider-to-default-encoding mapping
 */
const PROVIDER_DEFAULT_ENCODINGS = {
  'OpenAI': 'o200k_base',
  'OpenAI_Azure': 'o200k_base',
  'Anthropic': 'cl100k_base',
  'Anthropic_Bedrock': 'cl100k_base',
  'Google': 'cl100k_base',
  'ollama': 'cl100k_base'
};

/**
 * Model patterns for encoding selection (for OpenAI models)
 */
const MODEL_ENCODING_PATTERNS = [
  { pattern: /^(gpt-4o|o1|o3|gpt-5)/i, encoding: 'o200k_base' },
  { pattern: /^(gpt-4|gpt-3\.5|text-embedding)/i, encoding: 'cl100k_base' }
];

/**
 * Get or create a tiktoken encoder
 * @param {string} encodingName - The encoding name (e.g., 'cl100k_base')
 * @returns {Object} The encoder object with encode/decode methods
 */
function getEncoder(encodingName) {
  if (!encoderCache.has(encodingName)) {
    const tiktoken = getTiktoken();
    encoderCache.set(encodingName, tiktoken.get_encoding(encodingName));
  }
  return encoderCache.get(encodingName);
}

/**
 * Resolve the tokenizer encoding to use for a given model configuration
 * @param {Object} modelConfig - The model configuration object
 * @returns {string} The encoding name
 */
export function resolveTokenizer(modelConfig) {
  // 1. Explicit tokenizer in config takes precedence
  if (modelConfig.tokenizer) {
    return modelConfig.tokenizer;
  }

  // 2. Infer from model name patterns
  const modelName = modelConfig.model || '';
  for (const { pattern, encoding } of MODEL_ENCODING_PATTERNS) {
    if (pattern.test(modelName)) {
      return encoding;
    }
  }

  // 3. Fall back to provider default
  return PROVIDER_DEFAULT_ENCODINGS[modelConfig.api] || 'cl100k_base';
}

/**
 * Resolve the tokenizer mode (local vs api)
 * @param {Object} modelConfig - The model configuration object
 * @returns {string} Either 'local' or 'api'
 */
export function resolveTokenizerMode(modelConfig) {
  return modelConfig.tokenizer_mode || 'local';
}

/**
 * Tokenize text locally using tiktoken
 * @param {string} text - The text to tokenize
 * @param {string} [encodingName='cl100k_base'] - The encoding to use
 * @returns {number[]} Array of token IDs
 */
export function tokenizeLocal(text, encodingName = 'cl100k_base') {
  const enc = getEncoder(encodingName);
  const tokens = enc.encode(text);
  return Array.from(tokens);
}

/**
 * Convert token IDs to their string representations
 * @param {number[]} tokens - Array of token IDs
 * @param {string} [encodingName='cl100k_base'] - The encoding to use
 * @returns {string[]} Array of token strings
 */
export function decodeTokensToStrings(tokens, encodingName = 'cl100k_base') {
  const enc = getEncoder(encodingName);
  const decoder = new TextDecoder('utf-8', { fatal: false });

  return tokens.map(token => {
    try {
      const bytes = enc.decode_single_token_bytes(token);
      return decoder.decode(bytes);
    } catch (err) {
      // Fallback for tokens that don't decode cleanly
      return `<token:${token}>`;
    }
  });
}

/**
 * Count tokens locally using tiktoken
 * @param {string} text - The text to count tokens in
 * @param {string} [encodingName='cl100k_base'] - The encoding to use
 * @returns {number} The token count
 */
export function countTokensLocal(text, encodingName = 'cl100k_base') {
  const tokens = tokenizeLocal(text, encodingName);
  return tokens.length;
}

/**
 * Count tokens using provider API (when available)
 * @param {string} text - The text to count tokens in
 * @param {string} modelName - The model name to look up
 * @returns {Promise<number>} The token count
 */
export async function countTokensAPI(text, modelName) {
  const provider = fetchProvider(modelName);

  if (typeof provider.countTokens === 'function') {
    return await provider.countTokens(text);
  }

  // Fallback to local counting if provider doesn't support API counting
  const modelConfig = getModelConfig(modelName);
  const encoding = resolveTokenizer(modelConfig);
  return countTokensLocal(text, encoding);
}

/**
 * Get list of supported tokenizer encodings
 * @returns {string[]} Array of supported encoding names
 */
export function getSupportedEncodings() {
  return [...SUPPORTED_ENCODINGS];
}

/**
 * Check if an encoding name is supported
 * @param {string} encodingName - The encoding name to check
 * @returns {boolean} True if supported
 */
export function isValidEncoding(encodingName) {
  return SUPPORTED_ENCODINGS.includes(encodingName);
}

/**
 * Main tokenization function - handles both modes
 * @param {string} text - The text to tokenize
 * @param {Object} [options={}] - Options object
 * @param {string} [options.tokenizer] - Explicit tokenizer encoding name
 * @param {string} [options.model] - Model name to look up tokenizer from config
 * @returns {Promise<Object>} Result with tokens, encoding, and mode
 */
export async function tokenize(text, options = {}) {
  const { tokenizer, model } = options;

  if (tokenizer) {
    // Explicit tokenizer requested
    const tokens = tokenizeLocal(text, tokenizer);
    return {
      tokens: decodeTokensToStrings(tokens, tokenizer),
      encoding: tokenizer,
      mode: 'local'
    };
  }

  if (model) {
    const modelConfig = getModelConfig(model);
    const encoding = resolveTokenizer(modelConfig);
    const mode = resolveTokenizerMode(modelConfig);

    if (mode === 'api') {
      // API mode doesn't support returning individual tokens
      throw new Error(
        'API mode does not support returning individual tokens. Use /tokens/count instead, or set tokenizer_mode to "local" in model config.'
      );
    }

    const tokens = tokenizeLocal(text, encoding);
    return {
      tokens: decodeTokensToStrings(tokens, encoding),
      encoding,
      mode: 'local'
    };
  }

  // Default to cl100k_base
  const defaultEncoding = 'cl100k_base';
  const tokens = tokenizeLocal(text, defaultEncoding);
  return {
    tokens: decodeTokensToStrings(tokens, defaultEncoding),
    encoding: defaultEncoding,
    mode: 'local'
  };
}

/**
 * Main token counting function - handles both modes
 * @param {string} text - The text to count tokens in
 * @param {Object} [options={}] - Options object
 * @param {string} [options.tokenizer] - Explicit tokenizer encoding name
 * @param {string} [options.model] - Model name to look up tokenizer from config
 * @returns {Promise<Object>} Result with count, encoding, and mode
 */
export async function countTokens(text, options = {}) {
  const { tokenizer, model } = options;

  if (tokenizer) {
    // Explicit tokenizer - always local
    return {
      count: countTokensLocal(text, tokenizer),
      encoding: tokenizer,
      mode: 'local'
    };
  }

  if (model) {
    const modelConfig = getModelConfig(model);
    const encoding = resolveTokenizer(modelConfig);
    const mode = resolveTokenizerMode(modelConfig);

    if (mode === 'api') {
      const count = await countTokensAPI(text, model);
      return {
        count,
        encoding: null, // API doesn't expose encoding
        mode: 'api'
      };
    }

    return {
      count: countTokensLocal(text, encoding),
      encoding,
      mode: 'local'
    };
  }

  // Default
  const defaultEncoding = 'cl100k_base';
  return {
    count: countTokensLocal(text, defaultEncoding),
    encoding: defaultEncoding,
    mode: 'local'
  };
}
