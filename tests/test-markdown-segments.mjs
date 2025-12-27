/**
 * tests/test-markdown-segments.mjs
 *
 * Tests for markdown segmentation functionality.
 */

import { segmentMarkdown, segmentByBlocks, segmentByHeaders } from '../lib/markdown/segment.mjs';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Running markdown segmentation tests...\n');

// Test 1: Basic block segmentation
{
  console.log('Test 1: Basic block segmentation');
  const input = '# Title\n\nParagraph one.\n\nParagraph two.\n';
  const segments = segmentMarkdown(input, 'markdown_blocks');
  assert.ok(segments.length >= 3, 'Should have at least 3 segments (heading + 2 paragraphs)');
  assert.ok(segments.some(s => s.type === 'heading'), 'Should have heading segment');
  assert.ok(segments.some(s => s.type === 'paragraph'), 'Should have paragraph segments');
  console.log(`  Found ${segments.length} segments`);
  console.log('  PASSED\n');
}

// Test 2: Code block segmentation
{
  console.log('Test 2: Code block segmentation');
  const input = '# Code\n\n```js\nconsole.log("hi");\n```\n';
  const segments = segmentMarkdown(input, 'markdown_blocks');
  const codeSegment = segments.find(s => s.type === 'code');
  assert.ok(codeSegment, 'Should have code segment');
  assert.strictEqual(codeSegment.language, 'js', 'Should capture language');
  console.log('  PASSED\n');
}

// Test 3: Header path tracking
{
  console.log('Test 3: Header path tracking');
  const input = '# Main\n\n## Sub\n\nContent\n';
  const segments = segmentMarkdown(input, 'markdown_blocks');
  const contentSegment = segments.find(s => s.type === 'paragraph');
  assert.ok(contentSegment, 'Should have paragraph segment');
  assert.ok(Array.isArray(contentSegment.header_path), 'Should have header_path array');
  console.log(`  Header path: ${JSON.stringify(contentSegment.header_path)}`);
  console.log('  PASSED\n');
}

// Test 4: Line span tracking
{
  console.log('Test 4: Line span tracking');
  const input = '# Title\n\nParagraph\n';
  const segments = segmentMarkdown(input, 'markdown_blocks');
  const heading = segments.find(s => s.type === 'heading');
  assert.ok(heading.span, 'Should have span');
  assert.ok(heading.span.start_line >= 1, 'Should have valid start_line');
  assert.ok(heading.span.end_line >= heading.span.start_line, 'end_line should be >= start_line');
  console.log(`  Heading span: lines ${heading.span.start_line}-${heading.span.end_line}`);
  console.log('  PASSED\n');
}

// Test 5: Header-based segmentation
{
  console.log('Test 5: Header-based segmentation');
  const input = '# Section 1\n\nContent 1.\n\n# Section 2\n\nContent 2.\n';
  const segments = segmentByHeaders(input, { include_headers_in_chunk: true });
  assert.ok(segments.length >= 2, 'Should have at least 2 sections');
  console.log(`  Found ${segments.length} sections`);
  console.log('  PASSED\n');
}

// Test 6: List segmentation
{
  console.log('Test 6: List segmentation');
  const input = '# List\n\n- Item 1\n- Item 2\n- Item 3\n';
  const segments = segmentMarkdown(input, 'markdown_blocks');
  const listSegment = segments.find(s => s.type === 'list' || s.type === 'list_item');
  assert.ok(listSegment, 'Should have list segment');
  console.log(`  List segment type: ${listSegment.type}`);
  console.log('  PASSED\n');
}

// Test 7: Table segmentation
{
  console.log('Test 7: Table segmentation');
  const input = '# Data\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const segments = segmentMarkdown(input, 'markdown_blocks');
  const tableSegment = segments.find(s => s.type === 'table');
  assert.ok(tableSegment, 'Should have table segment');
  console.log('  PASSED\n');
}

// Test 8: Frontmatter handling
{
  console.log('Test 8: Frontmatter handling');
  const input = '---\ntitle: Test\n---\n\n# Title\n';
  const segments = segmentMarkdown(input, 'markdown_blocks');
  const frontmatterSegment = segments.find(s => s.type === 'frontmatter');
  assert.ok(frontmatterSegment, 'Should have frontmatter segment');
  console.log('  PASSED\n');
}

// Test 9: Nested headings fixture
{
  console.log('Test 9: Nested headings fixture file');
  const fixturePath = path.join(__dirname, 'fixtures/markdown/headings-nested.md');
  const input = fs.readFileSync(fixturePath, 'utf8');
  const segments = segmentMarkdown(input, 'markdown_blocks');
  const headings = segments.filter(s => s.type === 'heading');
  assert.ok(headings.length >= 5, 'Should have multiple heading segments');
  console.log(`  Found ${headings.length} headings in fixture`);
  console.log('  PASSED\n');
}

// Test 10: Deterministic output
{
  console.log('Test 10: Deterministic output');
  const input = '# Title\n\nParagraph.\n';
  const segments1 = segmentMarkdown(input, 'markdown_blocks');
  const segments2 = segmentMarkdown(input, 'markdown_blocks');
  assert.deepStrictEqual(segments1, segments2, 'Same input should produce identical segments');
  console.log('  PASSED\n');
}

console.log('All segmentation tests passed!');
