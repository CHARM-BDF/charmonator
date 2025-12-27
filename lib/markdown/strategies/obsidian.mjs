/**
 * lib/markdown/strategies/obsidian.mjs
 *
 * Obsidian-aware markdown splitting strategy.
 * Handles wikilinks, tags, callouts, and frontmatter with token packing.
 */

export const obsidianStrategy = {
  id: 'obsidian',
  description: 'Obsidian-aware Markdown splitting (wikilinks, tags, callouts) + token packing.',
  options_schema: {
    frontmatter: {
      type: 'string',
      enum: ['drop', 'metadata', 'prepend_text'],
      default: 'metadata',
      description: 'How to handle YAML frontmatter'
    },
    wikilinks: {
      type: 'string',
      enum: ['preserve', 'text_only', 'text_and_target'],
      default: 'text_only',
      description: 'How to process [[wikilinks|with aliases]]'
    },
    tags: {
      type: 'string',
      enum: ['preserve', 'metadata_only'],
      default: 'metadata_only',
      description: 'How to process #tags'
    }
  },

  /**
   * Validate options for this strategy
   * @param {Object} options - Strategy options
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateOptions(options = {}) {
    const errors = [];

    if (options.frontmatter !== undefined) {
      const valid = ['drop', 'metadata', 'prepend_text'];
      if (!valid.includes(options.frontmatter)) {
        errors.push(`frontmatter must be one of: ${valid.join(', ')}`);
      }
    }

    if (options.wikilinks !== undefined) {
      const valid = ['preserve', 'text_only', 'text_and_target'];
      if (!valid.includes(options.wikilinks)) {
        errors.push(`wikilinks must be one of: ${valid.join(', ')}`);
      }
    }

    if (options.tags !== undefined) {
      const valid = ['preserve', 'metadata_only'];
      if (!valid.includes(options.tags)) {
        errors.push(`tags must be one of: ${valid.join(', ')}`);
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
      frontmatter: 'metadata',
      wikilinks: 'text_only',
      tags: 'metadata_only'
    };
  }
};

export default obsidianStrategy;
