/**
 * tests/test-markdown-extract.mjs
 *
 * Tests for markdown text and metadata extraction.
 */

import { extractMarkdown } from '../lib/markdown/extract.mjs';
import assert from 'assert';

console.log('Running markdown extraction tests...\n');

// Test 1: Basic text extraction
{
  console.log('Test 1: Basic text extraction');
  const input = '# Title\n\nThis is a paragraph.\n';
  const result = extractMarkdown(input);
  assert.ok(result.text.includes('Title'), 'Should extract heading text');
  assert.ok(result.text.includes('paragraph'), 'Should extract paragraph text');
  console.log('  PASSED\n');
}

// Test 2: Frontmatter extraction as metadata
{
  console.log('Test 2: Frontmatter extraction as metadata');
  const input = '---\ntitle: Test\ntags:\n  - foo\n  - bar\n---\n\n# Heading\n';
  const result = extractMarkdown(input, { frontmatter: 'metadata' });
  assert.ok(result.metadata.frontmatter, 'Should have frontmatter in metadata');
  assert.strictEqual(result.metadata.frontmatter.title, 'Test', 'Should extract title');
  assert.deepStrictEqual(result.metadata.frontmatter.tags, ['foo', 'bar'], 'Should extract tags');
  console.log('  PASSED\n');
}

// Test 3: Frontmatter drop
{
  console.log('Test 3: Frontmatter drop');
  const input = '---\ntitle: Test\n---\n\n# Heading\n';
  const result = extractMarkdown(input, { frontmatter: 'drop' });
  assert.strictEqual(result.metadata.frontmatter, undefined, 'Should not have frontmatter');
  console.log('  PASSED\n');
}

// Test 4: Wikilink extraction
{
  console.log('Test 4: Wikilink extraction');
  const input = 'See [[Other Note|alias]] and [[Simple Link]].\n';
  const result = extractMarkdown(input);
  assert.ok(result.metadata.links, 'Should have links in metadata');
  assert.strictEqual(result.metadata.links.length, 2, 'Should have 2 links');
  assert.strictEqual(result.metadata.links[0].target, 'Other Note', 'Should extract link target');
  assert.strictEqual(result.metadata.links[0].text, 'alias', 'Should extract link alias');
  console.log('  PASSED\n');
}

// Test 5: Wikilink text_only processing
{
  console.log('Test 5: Wikilink text_only processing');
  const input = 'See [[Other Note|alias]] here.\n';
  const result = extractMarkdown(input, { obsidian: { wikilinks: 'text_only' } });
  assert.ok(result.text.includes('alias'), 'Should include alias text');
  assert.ok(!result.text.includes('[['), 'Should not include wikilink syntax');
  console.log('  PASSED\n');
}

// Test 6: Tag extraction
{
  console.log('Test 6: Tag extraction');
  const input = 'This has #tag1 and #tag2 in the text.\n';
  const result = extractMarkdown(input);
  assert.ok(result.metadata.tags, 'Should have tags in metadata');
  assert.ok(result.metadata.tags.includes('tag1'), 'Should extract tag1');
  assert.ok(result.metadata.tags.includes('tag2'), 'Should extract tag2');
  console.log('  PASSED\n');
}

// Test 7: Heading extraction
{
  console.log('Test 7: Heading extraction');
  const input = '# Main\n\n## Sub1\n\n### Sub2\n';
  const result = extractMarkdown(input);
  assert.ok(result.metadata.headings, 'Should have headings in metadata');
  assert.strictEqual(result.metadata.headings.length, 3, 'Should have 3 headings');
  assert.strictEqual(result.metadata.headings[0].depth, 1, 'First heading should be depth 1');
  assert.strictEqual(result.metadata.headings[0].text, 'Main', 'Should extract heading text');
  console.log('  PASSED\n');
}

// Test 8: Code block preservation
{
  console.log('Test 8: Code block preservation');
  const input = '```js\nconst x = 1;\n```\n';
  const result = extractMarkdown(input, { preserve_code_blocks: true });
  assert.ok(result.text.includes('const x = 1'), 'Should preserve code block content');
  console.log('  PASSED\n');
}

// Test 9: Combined tags from frontmatter and text
{
  console.log('Test 9: Combined tags from frontmatter and text');
  const input = '---\ntags: [frontmatter-tag]\n---\n\nText with #inline-tag\n';
  const result = extractMarkdown(input, { frontmatter: 'metadata' });
  assert.ok(result.metadata.tags.includes('frontmatter-tag'), 'Should have frontmatter tag');
  assert.ok(result.metadata.tags.includes('inline-tag'), 'Should have inline tag');
  console.log('  PASSED\n');
}

console.log('All extraction tests passed!');
