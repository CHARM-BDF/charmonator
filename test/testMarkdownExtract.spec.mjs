import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import { extractMarkdown } from '../lib/markdown/extract.mjs';

tags().describe('Markdown extraction tests', function() {

  it('Test 1: Basic text extraction', function() {
    const input = '# Title\n\nThis is a paragraph.\n';
    const result = extractMarkdown(input);
    assert.ok(result.text.includes('Title'), 'Should extract heading text');
    assert.ok(result.text.includes('paragraph'), 'Should extract paragraph text');
  });

  it('Test 2: Frontmatter extraction as metadata', function() {
    const input = [
      '---',
      'title: Test',
      'tags:',
      '  - foo',
      '  - bar',
      '---',
      '',
      '# Heading',
      ''
    ].join('\n');
    const result = extractMarkdown(input, { frontmatter: 'metadata' });
    assert.ok(result.metadata.frontmatter, 'Should have frontmatter in metadata');
    assert.strictEqual(result.metadata.frontmatter.title, 'Test', 'Should extract title');
    assert.deepStrictEqual(result.metadata.frontmatter.tags, ['foo', 'bar'], 'Should extract tags');
  });

  it('Test 3: Frontmatter drop', function() {
    const input = [
      '---',
      'title: Test',
      '---',
      '',
      '# Heading',
      ''
    ].join('\n');
    const result = extractMarkdown(input, { frontmatter: 'drop' });
    assert.strictEqual(result.metadata.frontmatter, undefined, 'Should not have frontmatter');
  });

  it('Test 4: Wikilink extraction', function() {
    const input = 'See [[Other Note|alias]] and [[Simple Link]].\n';
    const result = extractMarkdown(input);
    assert.ok(result.metadata.links, 'Should have links in metadata');
    assert.strictEqual(result.metadata.links.length, 2, 'Should have 2 links');
    assert.strictEqual(result.metadata.links[0].target, 'Other Note', 'Should extract link target');
    assert.strictEqual(result.metadata.links[0].text, 'alias', 'Should extract link alias');
  });

  it('Test 5: Wikilink text_only processing', function() {
    const input = 'See [[Other Note|alias]] here.\n';
    const result = extractMarkdown(input, { obsidian: { wikilinks: 'text_only' } });
    assert.ok(result.text.includes('alias'), 'Should include alias text');
    assert.ok(!result.text.includes('[['), 'Should not include wikilink syntax');
  });

  it('Test 6: Tag extraction', function() {
    const input = 'This has #tag1 and #tag2 in the text.\n';
    const result = extractMarkdown(input);
    assert.ok(result.metadata.tags, 'Should have tags in metadata');
    assert.ok(result.metadata.tags.includes('tag1'), 'Should extract tag1');
    assert.ok(result.metadata.tags.includes('tag2'), 'Should extract tag2');
  });

  it('Test 7: Heading extraction', function() {
    const input = '# Main\n\n## Sub1\n\n### Sub2\n';
    const result = extractMarkdown(input);
    assert.ok(result.metadata.headings, 'Should have headings in metadata');
    assert.strictEqual(result.metadata.headings.length, 3, 'Should have 3 headings');
    assert.strictEqual(result.metadata.headings[0].depth, 1, 'First heading should be depth 1');
    assert.strictEqual(result.metadata.headings[0].text, 'Main', 'Should extract heading text');
  });

  it('Test 8: Code block preservation', function() {
    const input = '```js\nconst x = 1;\n```\n';
    const result = extractMarkdown(input, { preserve_code_blocks: true });
    assert.ok(result.text.includes('const x = 1'), 'Should preserve code block content');
  });

  it('Test 9: Combined tags from frontmatter and text', function() {
    const input = [
      '---',
      'tags: [frontmatter-tag]',
      '---',
      '',
      'Text with #inline-tag',
      ''
    ].join('\n');
    const result = extractMarkdown(input, { frontmatter: 'metadata' });
    assert.ok(result.metadata.tags.includes('frontmatter-tag'), 'Should have frontmatter tag');
    assert.ok(result.metadata.tags.includes('inline-tag'), 'Should have inline tag');
  });

});
