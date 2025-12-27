/**
 * lib/markdown/extract.mjs
 *
 * Extract plain text and metadata from markdown.
 * Produces embedding-friendly / search-friendly text and structured metadata.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import yaml from 'yaml';

/**
 * Default extraction options
 */
const DEFAULT_OPTIONS = {
  frontmatter: 'metadata',      // 'drop' | 'metadata' | 'prepend_text'
  strip_html: true,
  preserve_code_blocks: true,
  obsidian: {
    wikilinks: 'text_only',     // 'preserve' | 'text_only' | 'text_and_target'
    tags: 'metadata_only'       // 'preserve' | 'metadata_only'
  }
};

/**
 * Extract frontmatter YAML from markdown
 * @param {string} markdown - Raw markdown
 * @returns {{ frontmatter: Object|null, body: string }}
 */
function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    try {
      const parsed = yaml.parse(match[1]);
      return {
        frontmatter: parsed || {},
        body: markdown.slice(match[0].length)
      };
    } catch (e) {
      // Invalid YAML, return as-is
      return {
        frontmatter: null,
        body: markdown
      };
    }
  }
  return {
    frontmatter: null,
    body: markdown
  };
}

/**
 * Extract Obsidian wikilinks from text
 * @param {string} text - Text containing wikilinks
 * @returns {Array<{ raw: string, target: string, text: string }>}
 */
function extractWikilinks(text) {
  const links = [];
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    links.push({
      raw: match[0],
      target: match[1].trim(),
      text: (match[2] || match[1]).trim()
    });
  }
  return links;
}

/**
 * Extract Obsidian-style tags from text
 * @param {string} text - Text containing tags
 * @returns {string[]} Array of tag names (without #)
 */
function extractTags(text) {
  const tags = new Set();
  // Match #tag but not inside code blocks or URLs
  const regex = /(?:^|[^&\w])#([\w/-]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tags.add(match[1]);
  }
  return Array.from(tags);
}

/**
 * Extract headings from markdown AST
 * @param {Object} tree - Markdown AST
 * @returns {Array<{ depth: number, text: string }>}
 */
function extractHeadings(tree) {
  const headings = [];
  visit(tree, 'heading', (node) => {
    const text = extractTextFromNode(node);
    headings.push({
      depth: node.depth,
      text
    });
  });
  return headings;
}

/**
 * Extract plain text from an AST node
 * @param {Object} node - AST node
 * @returns {string} Plain text
 */
function extractTextFromNode(node) {
  if (node.type === 'text') {
    return node.value;
  }
  if (node.type === 'inlineCode') {
    return node.value;
  }
  if (node.children) {
    return node.children.map(extractTextFromNode).join('');
  }
  return '';
}

/**
 * Convert AST to plain text with options
 * @param {Object} tree - Markdown AST
 * @param {Object} options - Extraction options
 * @returns {string} Plain text
 */
function astToPlainText(tree, options) {
  const parts = [];

  visit(tree, (node) => {
    switch (node.type) {
      case 'text':
        parts.push(node.value);
        break;

      case 'inlineCode':
        parts.push(node.value);
        break;

      case 'code':
        if (options.preserve_code_blocks) {
          parts.push(node.value);
        }
        parts.push('\n\n');
        break;

      case 'heading':
        // Text is extracted by traversing children
        break;

      case 'paragraph':
        // Text is extracted by traversing children
        break;

      case 'listItem':
        // Text is extracted by traversing children
        break;

      case 'html':
        if (!options.strip_html) {
          parts.push(node.value);
        }
        break;

      case 'break':
        parts.push('\n');
        break;

      case 'thematicBreak':
        parts.push('\n\n');
        break;
    }
  });

  return parts.join('');
}

/**
 * Process wikilinks in text according to options
 * @param {string} text - Text with wikilinks
 * @param {string} mode - 'preserve' | 'text_only' | 'text_and_target'
 * @returns {string} Processed text
 */
function processWikilinks(text, mode) {
  if (mode === 'preserve') {
    return text;
  }

  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, target, displayText) => {
    const text = (displayText || target).trim();
    const targetText = target.trim();

    if (mode === 'text_only') {
      return text;
    }
    if (mode === 'text_and_target') {
      return text === targetText ? text : `${text} (${targetText})`;
    }
    return match;
  });
}

/**
 * Process tags in text according to options
 * @param {string} text - Text with tags
 * @param {string} mode - 'preserve' | 'metadata_only'
 * @returns {string} Processed text
 */
function processTags(text, mode) {
  if (mode === 'preserve') {
    return text;
  }
  if (mode === 'metadata_only') {
    // Remove tags from text (but keep the word if it's part of a larger context)
    return text.replace(/(?:^|[^&\w])#([\w/-]+)/g, (match, tag) => {
      // Keep leading space/char if present
      return match.charAt(0) === '#' ? tag : match.charAt(0) + tag;
    });
  }
  return text;
}

/**
 * Extract plain text and metadata from markdown.
 *
 * @param {string} markdown - Raw markdown text
 * @param {Object} options - Extraction options
 * @param {string} [options.frontmatter='metadata'] - 'drop' | 'metadata' | 'prepend_text'
 * @param {boolean} [options.strip_html=true] - Strip HTML tags
 * @param {boolean} [options.preserve_code_blocks=true] - Keep code block content
 * @param {Object} [options.obsidian] - Obsidian-specific options
 * @param {string} [options.obsidian.wikilinks='text_only'] - 'preserve' | 'text_only' | 'text_and_target'
 * @param {string} [options.obsidian.tags='metadata_only'] - 'preserve' | 'metadata_only'
 * @returns {{ text: string, metadata: Object }}
 */
export function extractMarkdown(markdown, options = {}) {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    obsidian: {
      ...DEFAULT_OPTIONS.obsidian,
      ...options.obsidian
    }
  };

  // Extract frontmatter
  const { frontmatter, body } = parseFrontmatter(markdown);

  // Extract wikilinks before parsing (they're not standard markdown)
  const wikilinks = extractWikilinks(body);

  // Extract tags before parsing
  const allTags = extractTags(body);
  const frontmatterTags = frontmatter?.tags || [];
  const combinedTags = [...new Set([...allTags, ...(Array.isArray(frontmatterTags) ? frontmatterTags : [frontmatterTags])])];

  // Parse markdown to AST
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml']);

  const tree = processor.parse(body);

  // Extract headings
  const headings = extractHeadings(tree);

  // Convert to plain text
  let text = astToPlainText(tree, opts);

  // Process Obsidian wikilinks
  text = processWikilinks(text, opts.obsidian.wikilinks);

  // Process Obsidian tags
  text = processTags(text, opts.obsidian.tags);

  // Handle frontmatter in text output
  if (opts.frontmatter === 'prepend_text' && frontmatter) {
    const frontmatterText = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
    text = frontmatterText + '\n\n' + text;
  }

  // Clean up whitespace
  text = text
    .replace(/\n{3,}/g, '\n\n')  // Collapse multiple newlines
    .trim() + '\n';

  // Build metadata
  const metadata = {
    frontmatter: opts.frontmatter !== 'drop' ? frontmatter : undefined,
    tags: combinedTags.length > 0 ? combinedTags : undefined,
    links: wikilinks.length > 0 ? wikilinks : undefined,
    headings: headings.length > 0 ? headings : undefined
  };

  // Remove undefined values
  Object.keys(metadata).forEach(key => {
    if (metadata[key] === undefined) {
      delete metadata[key];
    }
  });

  return {
    text,
    metadata
  };
}

export default extractMarkdown;
