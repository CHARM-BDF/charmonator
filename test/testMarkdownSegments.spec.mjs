import { strict as assert } from 'assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { segmentMarkdown, segmentByBlocks, segmentByHeaders } from '../lib/markdown/segment.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Markdown Segmentation Tests', function() {

  it('Test 1: Basic block segmentation', function() {
    const input = '# Title\n\nParagraph one.\n\nParagraph two.\n';
    const segments = segmentMarkdown(input, 'markdown_blocks');
    assert.ok(segments.length >= 3, 'Should have at least 3 segments (heading + 2 paragraphs)');
    assert.ok(segments.some(s => s.type === 'heading'), 'Should have heading segment');
    assert.ok(segments.some(s => s.type === 'paragraph'), 'Should have paragraph segments');
  });

  it('Test 2: Code block segmentation', function() {
    const input = '# Code\n\n```js\nconsole.log("hi");\n```\n';
    const segments = segmentMarkdown(input, 'markdown_blocks');
    const codeSegment = segments.find(s => s.type === 'code');
    assert.ok(codeSegment, 'Should have code segment');
    assert.strictEqual(codeSegment.language, 'js', 'Should capture language of code segment');
  });

  it('Test 3: Header path tracking', function() {
    const input = '# Main\n\n## Sub\n\nContent\n';
    const segments = segmentMarkdown(input, 'markdown_blocks');
    const contentSegment = segments.find(s => s.type === 'paragraph');
    assert.ok(contentSegment, 'Should have paragraph segment');
    assert.ok(Array.isArray(contentSegment.header_path), 'Should have a header_path array');
  });

  it('Test 4: Line span tracking', function() {
    const input = '# Title\n\nParagraph\n';
    const segments = segmentMarkdown(input, 'markdown_blocks');
    const heading = segments.find(s => s.type === 'heading');
    assert.ok(heading.span, 'Heading should have a span property');
    assert.ok(heading.span.start_line >= 1, 'Should have a valid start_line');
    assert.ok(heading.span.end_line >= heading.span.start_line, 'end_line should be >= start_line');
  });

  it('Test 5: Header-based segmentation', function() {
    const input = '# Section 1\n\nContent 1.\n\n# Section 2\n\nContent 2.\n';
    const segments = segmentByHeaders(input, { include_headers_in_chunk: true });
    assert.ok(segments.length >= 2, 'Should have at least 2 distinct sections');
  });

  it('Test 6: List segmentation', function() {
    const input = '# List\n\n- Item 1\n- Item 2\n- Item 3\n';
    const segments = segmentMarkdown(input, 'markdown_blocks');
    const listSegment = segments.find(s => s.type === 'list' || s.type === 'list_item');
    assert.ok(listSegment, 'Should have list or list_item segment');
  });

  it('Test 7: Table segmentation', function() {
    const input = '# Data\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    const segments = segmentMarkdown(input, 'markdown_blocks');
    const tableSegment = segments.find(s => s.type === 'table');
    assert.ok(tableSegment, 'Should have table segment');
  });

  it('Test 8: Frontmatter handling', function() {
    const input = '---\ntitle: Test\n---\n\n# Title\n';
    const segments = segmentMarkdown(input, 'markdown_blocks');
    const frontmatterSegment = segments.find(s => s.type === 'frontmatter');
    assert.ok(frontmatterSegment, 'Should have frontmatter segment');
  });

  it('Test 9: Nested headings fixture', function() {
    const fixturePath = path.join(__dirname, 'fixtures', 'markdown', 'headings-nested.md');
    const input = fs.readFileSync(fixturePath, 'utf8');
    const segments = segmentMarkdown(input, 'markdown_blocks');
    const headings = segments.filter(s => s.type === 'heading');
    assert.ok(headings.length >= 5, 'Should detect multiple heading segments');
  });

  it('Test 10: Deterministic output', function() {
    const input = '# Title\n\nParagraph.\n';
    const segments1 = segmentMarkdown(input, 'markdown_blocks');
    const segments2 = segmentMarkdown(input, 'markdown_blocks');
    assert.deepStrictEqual(segments1, segments2, 'Same input must produce identical segmentation output');
  });

});
