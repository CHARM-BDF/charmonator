/**
 * lib/markdown/strategies/recursive-separators.mjs
 *
 * Recursive separator splitting strategy (LangChain RecursiveCharacterTextSplitter style).
 * Recursively splits using a list of separators until chunks are under max_tokens.
 */

export const recursiveSeparatorsStrategy = {
  id: 'recursive_separators',
  description: 'Recursive separator splitter (LangChain RecursiveCharacterTextSplitter behavior, but token-bounded).',
  options_schema: {
    separators: {
      type: 'array',
      items: { type: 'string' },
      default: ['\\n\\n', '\\n', ' ', ''],
      description: 'Ordered list of separators to try (most preferred first)'
    },
    keep_separator: {
      type: 'string',
      enum: ['none', 'prefix', 'suffix'],
      default: 'suffix',
      description: 'Where to keep the separator in split chunks'
    }
  },

  /**
   * Validate options for this strategy
   * @param {Object} options - Strategy options
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateOptions(options = {}) {
    const errors = [];

    if (options.separators !== undefined) {
      if (!Array.isArray(options.separators)) {
        errors.push('separators must be an array');
      } else {
        for (const sep of options.separators) {
          if (typeof sep !== 'string') {
            errors.push('All separators must be strings');
            break;
          }
        }
      }
    }

    if (options.keep_separator !== undefined) {
      const valid = ['none', 'prefix', 'suffix'];
      if (!valid.includes(options.keep_separator)) {
        errors.push(`keep_separator must be one of: ${valid.join(', ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  },

  /**
   * Get default options
   * @returns {Object}
   */
  getDefaultOptions() {
    return {
      separators: ['\n\n', '\n', ' ', ''],
      keep_separator: 'suffix'
    };
  }
};

export default recursiveSeparatorsStrategy;
