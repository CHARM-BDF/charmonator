/**
 * lib/markdown/strategies/markdown-headers.mjs
 *
 * Header-aware splitting strategy (LangChain MarkdownHeaderTextSplitter style).
 * Splits by headings and packs sections into token-bounded chunks.
 */

export const markdownHeadersStrategy = {
  id: 'markdown_headers',
  description: 'Header-aware splitting (LangChain-style MarkdownHeaderTextSplitter + token packing).',
  options_schema: {
    max_header_level: {
      type: 'integer',
      min: 1,
      max: 6,
      default: 6,
      description: 'Maximum header level to split on (1-6)'
    },
    include_headers_in_chunk: {
      type: 'boolean',
      default: true,
      description: 'Include header text in chunk content'
    }
  },

  /**
   * Validate options for this strategy
   * @param {Object} options - Strategy options
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateOptions(options = {}) {
    const errors = [];

    if (options.max_header_level !== undefined) {
      const level = options.max_header_level;
      if (!Number.isInteger(level) || level < 1 || level > 6) {
        errors.push('max_header_level must be an integer between 1 and 6');
      }
    }

    if (options.include_headers_in_chunk !== undefined) {
      if (typeof options.include_headers_in_chunk !== 'boolean') {
        errors.push('include_headers_in_chunk must be a boolean');
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
      max_header_level: 6,
      include_headers_in_chunk: true
    };
  }
};

export default markdownHeadersStrategy;
