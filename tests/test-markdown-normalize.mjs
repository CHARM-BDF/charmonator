/**
 * tests/test-markdown-normalize.mjs
 *
 * Tests for markdown normalization functionality.
 */

import { normalizeMarkdown } from '../lib/markdown/normalize.mjs';
import assert from 'assert';

console.log('Running markdown normalization tests...\n');

// Test 1: Line ending normalization (CRLF -> LF)
{
  console.log('Test 1: Line ending normalization (CRLF -> LF)');
  const input = '# Title\r\n\r\nParagraph\r\n';
  const result = normalizeMarkdown(input, { line_endings: 'lf' });
  assert.strictEqual(result.markdown, '# Title\n\nParagraph\n');
  assert.ok(result.id, 'Should have an ID');
  console.log('  PASSED\n');
}

// Test 2: Line ending normalization (LF -> CRLF)
{
  console.log('Test 2: Line ending normalization (LF -> CRLF)');
  const input = '# Title\n\nParagraph\n';
  const result = normalizeMarkdown(input, { line_endings: 'crlf' });
  assert.strictEqual(result.markdown, '# Title\r\n\r\nParagraph\r\n');
  console.log('  PASSED\n');
}

// Test 3: Trailing whitespace trimming
{
  console.log('Test 3: Trailing whitespace trimming');
  const input = '# Title   \n\nParagraph  \n';
  const result = normalizeMarkdown(input, { trim_trailing_whitespace: true });
  assert.strictEqual(result.markdown, '# Title\n\nParagraph\n');
  console.log('  PASSED\n');
}

// Test 4: Multiple blank line collapsing
{
  console.log('Test 4: Multiple blank line collapsing');
  const input = '# Title\n\n\n\nParagraph\n';
  const result = normalizeMarkdown(input, { collapse_multiple_blank_lines: true });
  assert.strictEqual(result.markdown, '# Title\n\nParagraph\n');
  console.log('  PASSED\n');
}

// Test 5: Ensure trailing newline
{
  console.log('Test 5: Ensure trailing newline');
  const input = '# Title\n\nParagraph';
  const result = normalizeMarkdown(input, { ensure_trailing_newline: true });
  assert.ok(result.markdown.endsWith('\n'), 'Should end with newline');
  console.log('  PASSED\n');
}

// Test 6: Frontmatter preservation
{
  console.log('Test 6: Frontmatter preservation');
  const input = '---\ntitle: Test\n---\n\n# Title\n';
  const result = normalizeMarkdown(input, { frontmatter: 'preserve' });
  assert.ok(result.markdown.includes('---\ntitle: Test\n---'), 'Should preserve frontmatter');
  console.log('  PASSED\n');
}

// Test 7: Frontmatter dropping
{
  console.log('Test 7: Frontmatter dropping');
  const input = '---\ntitle: Test\n---\n\n# Title\n';
  const result = normalizeMarkdown(input, { frontmatter: 'drop' });
  assert.ok(!result.markdown.includes('---'), 'Should not contain frontmatter');
  assert.ok(result.markdown.includes('# Title'), 'Should still have content');
  console.log('  PASSED\n');
}

// Test 8: Deterministic ID generation
{
  console.log('Test 8: Deterministic ID generation');
  const input = '# Title\n\nParagraph\n';
  const result1 = normalizeMarkdown(input);
  const result2 = normalizeMarkdown(input);
  assert.strictEqual(result1.id, result2.id, 'Same input should produce same ID');
  console.log('  PASSED\n');
}

// Test 9: Different content produces different IDs
{
  console.log('Test 9: Different content produces different IDs');
  const result1 = normalizeMarkdown('# Title A\n');
  const result2 = normalizeMarkdown('# Title B\n');
  assert.notStrictEqual(result1.id, result2.id, 'Different content should produce different IDs');
  console.log('  PASSED\n');
}

// Test 10: Obsidian callout normalization
{
  console.log('Test 10: Obsidian callout normalization');
  const input = '> [!note] My Title\n> Content\n';
  const result = normalizeMarkdown(input, { obsidian: { normalize_callouts: true } });
  assert.ok(result.markdown.includes('[!NOTE]'), 'Should normalize callout type to uppercase');
  console.log('  PASSED\n');
}

console.log('All normalization tests passed!');
