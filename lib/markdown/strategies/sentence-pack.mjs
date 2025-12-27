/**
 * lib/markdown/strategies/sentence-pack.mjs
 *
 * Sentence split + token packing strategy.
 * Splits text into sentences and packs them into token-bounded chunks.
 */

export const sentencePackStrategy = {
  id: 'sentence_pack',
  description: 'Sentence split + token packing (LangChain-like sentence splitter).',
  options_schema: {
    locale: {
      type: 'string',
      default: 'en',
      description: 'Locale for sentence boundary detection (e.g., "en", "ja")'
    }
  },

  /**
   * Validate options for this strategy
   * @param {Object} options - Strategy options
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateOptions(options = {}) {
    const errors = [];

    if (options.locale !== undefined) {
      if (typeof options.locale !== 'string') {
        errors.push('locale must be a string');
      } else if (options.locale.length < 2) {
        errors.push('locale must be at least 2 characters');
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
      locale: 'en'
    };
  }
};

export default sentencePackStrategy;
