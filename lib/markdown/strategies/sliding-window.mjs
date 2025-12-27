/**
 * lib/markdown/strategies/sliding-window.mjs
 *
 * Pure token sliding window strategy (LangChain TokenTextSplitter style).
 * Splits by token count with configurable overlap.
 */

export const slidingWindowStrategy = {
  id: 'sliding_window',
  description: 'Pure token sliding windows (LangChain TokenTextSplitter behavior).',
  options_schema: {
    // No additional options - just max_tokens and overlap_tokens from main config
  },

  /**
   * Validate options for this strategy
   * @param {Object} options - Strategy options
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateOptions(options = {}) {
    // No strategy-specific options to validate
    return {
      valid: true,
      errors: []
    };
  },

  /**
   * Get default options
   * @returns {Object}
   */
  getDefaultOptions() {
    return {};
  }
};

export default slidingWindowStrategy;
