import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import { normalizeMarkdown } from '../lib/markdown/normalize.mjs';

tags().describe('Markdown Normalization Tests', function() {

  it('should convert CRLF line endings to LF', function() {
    const input = '# Title\r\n\r\nParagraph\r\n';
    const result = normalizeMarkdown(input, { line_endings: 'lf' });
    assert.strictEqual(result.markdown, '# Title\n\nParagraph\n');
    assert.ok(result.id, 'Should have an ID');
  });

  it('should convert LF line endings to CRLF', function() {
    const input = '# Title\n\nParagraph\n';
    const result = normalizeMarkdown(input, { line_endings: 'crlf' });
    assert.strictEqual(result.markdown, '# Title\r\n\r\nParagraph\r\n');
  });

  it('should trim trailing whitespace', function() {
    const input = '# Title   \n\nParagraph  \n';
    const result = normalizeMarkdown(input, { trim_trailing_whitespace: true });
    assert.strictEqual(result.markdown, '# Title\n\nParagraph\n');
  });

  it('should collapse multiple blank lines', function() {
    const input = '# Title\n\n\n\nParagraph\n';
    const result = normalizeMarkdown(input, { collapse_multiple_blank_lines: true });
    assert.strictEqual(result.markdown, '# Title\n\nParagraph\n');
  });

  it('should ensure trailing newline', function() {
    const input = '# Title\n\nParagraph';
    const result = normalizeMarkdown(input, { ensure_trailing_newline: true });
    assert.ok(result.markdown.endsWith('\n'), 'Should end with newline');
  });

  it('should preserve frontmatter', function() {
    const input = '---\ntitle: Test\n---\n\n# Title\n';
    const result = normalizeMarkdown(input, { frontmatter: 'preserve' });
    assert.ok(result.markdown.includes('---\ntitle: Test\n---'), 'Should preserve frontmatter');
  });

  it('should drop frontmatter', function() {
    const input = '---\ntitle: Test\n---\n\n# Title\n';
    const result = normalizeMarkdown(input, { frontmatter: 'drop' });
    assert.ok(!result.markdown.includes('---'), 'Should not contain frontmatter');
    assert.ok(result.markdown.includes('# Title'), 'Should still have content');
  });

  it('should generate deterministic IDs for identical input', function() {
    const input = '# Title\n\nParagraph\n';
    const result1 = normalizeMarkdown(input);
    const result2 = normalizeMarkdown(input);
    assert.strictEqual(result1.id, result2.id, 'Same input should produce same ID');
  });

  it('should generate different IDs for different input', function() {
    const result1 = normalizeMarkdown('# Title A\n');
    const result2 = normalizeMarkdown('# Title B\n');
    assert.notStrictEqual(result1.id, result2.id, 'Different content should produce different IDs');
  });

  it('should normalize Obsidian callouts to uppercase', function() {
    const input = '> [!note] My Title\n> Content\n';
    const result = normalizeMarkdown(input, { obsidian: { normalize_callouts: true } });
    assert.ok(result.markdown.includes('[!NOTE]'), 'Should normalize callout type to uppercase');
  });
});
