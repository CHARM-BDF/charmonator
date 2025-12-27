/**
 * lib/markdown/strategies/markdown-blocks.mjs
 *
 * Block-aware splitting strategy.
 * Splits by block elements (paragraphs, lists, code blocks, tables) with token packing.
 */

export const markdownBlocksStrategy = {
  id: 'markdown_blocks',
  description: 'Block-aware splitting (paragraphs, lists, code blocks, tables) + token packing.',
  options_schema: {
    atomic_blocks: {
      type: 'array',
      items: { type: 'string' },
      default: ['code', 'table', 'list_item'],
      description: 'Block types to treat as atomic (will not be split unless oversized)'
    },
    split_oversized_blocks: {
      type: 'boolean',
      default: true,
      description: 'Split blocks that exceed max_tokens'
    }
  },

  /**
   * Validate options for this strategy
   * @param {Object} options - Strategy options
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateOptions(options = {}) {
    const errors = [];
    const validBlockTypes = ['code', 'table', 'list_item', 'paragraph', 'blockquote', 'heading'];

    if (options.atomic_blocks !== undefined) {
      if (!Array.isArray(options.atomic_blocks)) {
        errors.push('atomic_blocks must be an array');
      } else {
        for (const block of options.atomic_blocks) {
          if (!validBlockTypes.includes(block)) {
            errors.push(`Invalid block type "${block}". Valid types: ${validBlockTypes.join(', ')}`);
          }
        }
      }
    }

    if (options.split_oversized_blocks !== undefined) {
      if (typeof options.split_oversized_blocks !== 'boolean') {
        errors.push('split_oversized_blocks must be a boolean');
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
      atomic_blocks: ['code', 'table', 'list_item'],
      split_oversized_blocks: true
    };
  }
};

export default markdownBlocksStrategy;
