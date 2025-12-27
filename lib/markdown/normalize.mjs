/**
 * lib/markdown/normalize.mjs
 *
 * Deterministic markdown normalization for stable hashing and chunking.
 * No LLM work - purely syntactic cleanup.
 */

import crypto from 'crypto';

/**
 * Default normalization options
 */
const DEFAULT_OPTIONS = {
  line_endings: 'lf',
  trim_trailing_whitespace: true,
  collapse_multiple_blank_lines: true,
  ensure_trailing_newline: true,
  frontmatter: 'preserve',
  obsidian: {
    normalize_callouts: false
  }
};

/**
 * Normalize line endings to LF or CRLF
 * @param {string} text - Input text
 * @param {string} mode - 'lf' or 'crlf'
 * @returns {string} Text with normalized line endings
 */
function normalizeLineEndings(text, mode = 'lf') {
  // First normalize all line endings to LF
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Convert to CRLF if requested
  if (mode === 'crlf') {
    normalized = normalized.replace(/\n/g, '\r\n');
  }

  return normalized;
}

/**
 * Trim trailing whitespace from each line
 * @param {string} text - Input text
 * @returns {string} Text with trailing whitespace removed
 */
function trimTrailingWhitespace(text) {
  return text.split('\n').map(line => line.trimEnd()).join('\n');
}

/**
 * Collapse multiple consecutive blank lines into a single blank line
 * @param {string} text - Input text
 * @returns {string} Text with collapsed blank lines
 */
function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Ensure text ends with exactly one newline
 * @param {string} text - Input text
 * @returns {string} Text with trailing newline
 */
function ensureTrailingNewline(text) {
  return text.trimEnd() + '\n';
}

/**
 * Extract frontmatter from markdown
 * @param {string} text - Input markdown
 * @returns {{ frontmatter: string|null, body: string }} Frontmatter and body separated
 */
function extractFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (match) {
    return {
      frontmatter: match[1],
      body: text.slice(match[0].length)
    };
  }
  return {
    frontmatter: null,
    body: text
  };
}

/**
 * Normalize Obsidian callouts to canonical format
 * @param {string} text - Input text
 * @returns {string} Text with normalized callouts
 */
function normalizeObsidianCallouts(text) {
  // Normalize callout syntax: > [!TYPE] with optional title
  // Canonicalize spacing and casing of type
  return text.replace(
    /^(>\s*)\[!(\w+)\](\s*.*)?$/gm,
    (match, prefix, type, title) => {
      const normalizedType = type.toUpperCase();
      const normalizedTitle = title ? title.trim() : '';
      return normalizedTitle
        ? `${prefix}[!${normalizedType}] ${normalizedTitle}`
        : `${prefix}[!${normalizedType}]`;
    }
  );
}

/**
 * Normalize markdown in a deterministic way for stable hashing and chunking.
 *
 * @param {string} markdown - Raw markdown text
 * @param {Object} options - Normalization options
 * @param {string} [options.line_endings='lf'] - 'lf' or 'crlf'
 * @param {boolean} [options.trim_trailing_whitespace=true] - Remove trailing whitespace
 * @param {boolean} [options.collapse_multiple_blank_lines=true] - Collapse multiple blank lines
 * @param {boolean} [options.ensure_trailing_newline=true] - Ensure trailing newline
 * @param {string} [options.frontmatter='preserve'] - 'preserve' or 'drop'
 * @param {Object} [options.obsidian] - Obsidian-specific options
 * @param {boolean} [options.obsidian.normalize_callouts=false] - Normalize callout formatting
 * @returns {{ markdown: string, id: string }} Normalized markdown and SHA-256 hash ID
 */
export function normalizeMarkdown(markdown, options = {}) {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    obsidian: {
      ...DEFAULT_OPTIONS.obsidian,
      ...options.obsidian
    }
  };

  let result = markdown;

  // Step 1: Normalize line endings first (for consistent processing)
  result = normalizeLineEndings(result, 'lf');

  // Step 2: Handle frontmatter
  let frontmatter = null;
  if (opts.frontmatter === 'drop') {
    const { body } = extractFrontmatter(result);
    result = body;
  } else {
    // Preserve frontmatter - extract and reattach after processing body
    const extracted = extractFrontmatter(result);
    frontmatter = extracted.frontmatter;
    result = extracted.body;
  }

  // Step 3: Trim trailing whitespace
  if (opts.trim_trailing_whitespace) {
    result = trimTrailingWhitespace(result);
  }

  // Step 4: Collapse multiple blank lines
  if (opts.collapse_multiple_blank_lines) {
    result = collapseBlankLines(result);
  }

  // Step 5: Normalize Obsidian callouts if requested
  if (opts.obsidian && opts.obsidian.normalize_callouts) {
    result = normalizeObsidianCallouts(result);
  }

  // Step 6: Reattach frontmatter if preserved
  if (frontmatter !== null) {
    result = `---\n${frontmatter}\n---\n${result}`;
  }

  // Step 7: Ensure trailing newline
  if (opts.ensure_trailing_newline) {
    result = ensureTrailingNewline(result);
  }

  // Step 8: Final line ending normalization
  result = normalizeLineEndings(result, opts.line_endings);

  // Generate deterministic ID from normalized content
  const id = crypto.createHash('sha256').update(result).digest('hex');

  return {
    markdown: result,
    id
  };
}

export default normalizeMarkdown;
