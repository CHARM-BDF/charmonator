/**
 * lib/markdown/segment.mjs
 *
 * Segment markdown into atomic units that preserve structure.
 * These segments are the building blocks for chunking strategies.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';

/**
 * @typedef {Object} Segment
 * @property {string} type - 'heading'|'paragraph'|'code'|'table'|'list_item'|'blockquote'|'thematic_break'|'frontmatter'
 * @property {string} text - The segment text content
 * @property {number} [depth] - For headings, 1-6
 * @property {string} [language] - For code blocks
 * @property {{ start_line: number, end_line: number }} span - Line numbers
 * @property {string[]} header_path - Breadcrumb of parent headings
 */

/**
 * Convert AST position to line numbers
 * @param {Object} position - AST position object
 * @returns {{ start_line: number, end_line: number }}
 */
function getLineSpan(position) {
  if (!position) {
    return { start_line: 1, end_line: 1 };
  }
  return {
    start_line: position.start.line,
    end_line: position.end.line
  };
}

/**
 * Serialize an AST node back to markdown-like text
 * @param {Object} node - AST node
 * @param {string} originalText - Original markdown text
 * @returns {string}
 */
function nodeToText(node, originalText) {
  if (node.position) {
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    return originalText.slice(start, end);
  }

  // Fallback: reconstruct from node content
  switch (node.type) {
    case 'text':
      return node.value;
    case 'inlineCode':
      return `\`${node.value}\``;
    case 'code':
      return '```' + (node.lang || '') + '\n' + node.value + '\n```';
    case 'heading':
      return '#'.repeat(node.depth) + ' ' + childrenToText(node);
    case 'paragraph':
      return childrenToText(node);
    case 'listItem':
      return childrenToText(node);
    case 'blockquote':
      return childrenToText(node).split('\n').map(l => '> ' + l).join('\n');
    default:
      if (node.children) {
        return childrenToText(node);
      }
      return node.value || '';
  }
}

/**
 * Get text content from node children
 * @param {Object} node - AST node
 * @returns {string}
 */
function childrenToText(node) {
  if (!node.children) return '';
  return node.children.map(child => {
    if (child.type === 'text') return child.value;
    if (child.type === 'inlineCode') return child.value;
    if (child.children) return childrenToText(child);
    return child.value || '';
  }).join('');
}

/**
 * Segment markdown using block-level awareness
 * @param {string} markdown - Raw markdown text
 * @param {Object} options - Segmentation options
 * @returns {Segment[]}
 */
export function segmentByBlocks(markdown, options = {}) {
  const segments = [];
  const headerPath = [];

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml']);

  const tree = processor.parse(markdown);

  // Process frontmatter first if present
  visit(tree, 'yaml', (node) => {
    segments.push({
      type: 'frontmatter',
      text: node.value,
      span: getLineSpan(node.position),
      header_path: []
    });
  });

  // Walk the tree for block elements
  visit(tree, (node, index, parent) => {
    // Only process top-level or direct children of root/document
    if (parent && parent.type !== 'root') {
      return;
    }

    switch (node.type) {
      case 'heading':
        // Update header path
        while (headerPath.length > 0 && headerPath[headerPath.length - 1].depth >= node.depth) {
          headerPath.pop();
        }
        const headingText = childrenToText(node);
        headerPath.push({ depth: node.depth, text: headingText });

        segments.push({
          type: 'heading',
          depth: node.depth,
          text: nodeToText(node, markdown),
          span: getLineSpan(node.position),
          header_path: headerPath.map(h => h.text)
        });
        break;

      case 'paragraph':
        segments.push({
          type: 'paragraph',
          text: nodeToText(node, markdown),
          span: getLineSpan(node.position),
          header_path: headerPath.map(h => h.text)
        });
        break;

      case 'code':
        segments.push({
          type: 'code',
          language: node.lang || undefined,
          text: nodeToText(node, markdown),
          span: getLineSpan(node.position),
          header_path: headerPath.map(h => h.text)
        });
        break;

      case 'table':
        segments.push({
          type: 'table',
          text: nodeToText(node, markdown),
          span: getLineSpan(node.position),
          header_path: headerPath.map(h => h.text)
        });
        break;

      case 'list':
        // For lists, we can either treat as one segment or split by items
        if (options.atomic_blocks?.includes('list_item')) {
          // Split into individual list items
          const listMarker = node.ordered ? '1.' : '-';
          node.children.forEach((item, i) => {
            segments.push({
              type: 'list_item',
              text: nodeToText(item, markdown),
              span: getLineSpan(item.position),
              header_path: headerPath.map(h => h.text)
            });
          });
        } else {
          // Treat entire list as one segment
          segments.push({
            type: 'list',
            text: nodeToText(node, markdown),
            span: getLineSpan(node.position),
            header_path: headerPath.map(h => h.text)
          });
        }
        break;

      case 'blockquote':
        segments.push({
          type: 'blockquote',
          text: nodeToText(node, markdown),
          span: getLineSpan(node.position),
          header_path: headerPath.map(h => h.text)
        });
        break;

      case 'thematicBreak':
        segments.push({
          type: 'thematic_break',
          text: '---',
          span: getLineSpan(node.position),
          header_path: headerPath.map(h => h.text)
        });
        break;

      case 'html':
        segments.push({
          type: 'html',
          text: node.value,
          span: getLineSpan(node.position),
          header_path: headerPath.map(h => h.text)
        });
        break;
    }
  });

  return segments;
}

/**
 * Segment markdown by headers (creating sections)
 * @param {string} markdown - Raw markdown text
 * @param {Object} options - Segmentation options
 * @returns {Segment[]}
 */
export function segmentByHeaders(markdown, options = {}) {
  const maxHeaderLevel = options.max_header_level || 6;
  const includeHeadersInChunk = options.include_headers_in_chunk !== false;

  const segments = [];
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml']);

  const tree = processor.parse(markdown);
  const lines = markdown.split('\n');

  // Build section structure
  const sections = [];
  let currentSection = {
    header: null,
    headerPath: [],
    content: [],
    startLine: 1,
    endLine: lines.length
  };

  visit(tree, (node, index, parent) => {
    if (parent && parent.type !== 'root') return;

    if (node.type === 'heading' && node.depth <= maxHeaderLevel) {
      // Save previous section
      if (currentSection.content.length > 0 || currentSection.header) {
        currentSection.endLine = node.position.start.line - 1;
        sections.push({ ...currentSection });
      }

      // Update header path
      const newPath = [...currentSection.headerPath];
      while (newPath.length > 0 && newPath[newPath.length - 1].depth >= node.depth) {
        newPath.pop();
      }
      const headingText = childrenToText(node);
      newPath.push({ depth: node.depth, text: headingText });

      // Start new section
      currentSection = {
        header: {
          depth: node.depth,
          text: nodeToText(node, markdown),
          span: getLineSpan(node.position)
        },
        headerPath: newPath,
        content: [],
        startLine: node.position.start.line,
        endLine: lines.length
      };
    } else if (node.type !== 'yaml') {
      currentSection.content.push({
        node,
        text: nodeToText(node, markdown),
        span: getLineSpan(node.position)
      });
    }
  });

  // Save last section
  if (currentSection.content.length > 0 || currentSection.header) {
    sections.push(currentSection);
  }

  // Convert sections to segments
  for (const section of sections) {
    const headerPath = section.headerPath.map(h => h.text);

    if (section.header && includeHeadersInChunk) {
      // Include header with content
      const allContent = [section.header.text];
      for (const item of section.content) {
        allContent.push(item.text);
      }

      segments.push({
        type: 'section',
        depth: section.header?.depth,
        text: allContent.join('\n\n'),
        span: {
          start_line: section.startLine,
          end_line: section.endLine
        },
        header_path: headerPath
      });
    } else {
      // Header and content as separate segments
      if (section.header) {
        segments.push({
          type: 'heading',
          depth: section.header.depth,
          text: section.header.text,
          span: section.header.span,
          header_path: headerPath
        });
      }

      for (const item of section.content) {
        segments.push({
          type: 'content',
          text: item.text,
          span: item.span,
          header_path: headerPath
        });
      }
    }
  }

  return segments;
}

/**
 * Segment markdown into atomic units.
 *
 * @param {string} markdown - Raw markdown text
 * @param {string} strategy - Strategy name ('markdown_blocks' | 'markdown_headers')
 * @param {Object} options - Strategy-specific options
 * @returns {Segment[]}
 */
export function segmentMarkdown(markdown, strategy, options = {}) {
  switch (strategy) {
    case 'markdown_blocks':
      return segmentByBlocks(markdown, options);

    case 'markdown_headers':
      return segmentByHeaders(markdown, options);

    default:
      // Default to block-level segmentation
      return segmentByBlocks(markdown, options);
  }
}

export default segmentMarkdown;
