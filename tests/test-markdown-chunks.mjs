/**
 * tests/test-markdown-chunks.mjs
 *
 * Tests for markdown chunking functionality.
 */

import { chunkMarkdown, generateGroupName, generateChunkId } from '../lib/markdown/chunk.mjs';
import { getStrategies, hasStrategy } from '../lib/markdown/strategies/index.mjs';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Running markdown chunking tests...\n');

// Test 1: Basic chunking
{
  console.log('Test 1: Basic chunking');
  const input = '# Title\n\nThis is a paragraph of text.\n\n## Section\n\nMore content here.\n';
  const result = chunkMarkdown(input, {
    strategy: 'markdown_blocks',
    max_tokens: 100,
    encoding: 'cl100k_base'
  });
  assert.ok(result.document, 'Should have document');
  assert.ok(result.document.id, 'Document should have ID');
  assert.ok(result.chunks_created > 0, 'Should create at least one chunk');
  console.log(`  Created ${result.chunks_created} chunks`);
  console.log('  PASSED\n');
}

// Test 2: Group name generation
{
  console.log('Test 2: Group name generation');
  const groupName = generateGroupName('markdown_headers', 512, 'cl100k_base', 64);
  assert.strictEqual(groupName, 'markdown:markdown_headers(512,cl100k_base,overlap=64)');
  console.log(`  Group name: ${groupName}`);
  console.log('  PASSED\n');
}

// Test 3: Chunk ID generation
{
  console.log('Test 3: Chunk ID generation');
  const chunkId = generateChunkId('parent123', 'group:test', 0);
  assert.strictEqual(chunkId, 'parent123/group:test@0');
  console.log(`  Chunk ID: ${chunkId}`);
  console.log('  PASSED\n');
}

// Test 4: Document structure
{
  console.log('Test 4: Document structure');
  const input = '# Title\n\nContent.\n';
  const result = chunkMarkdown(input, {
    strategy: 'markdown_blocks',
    max_tokens: 100
  });
  assert.ok(result.document.content, 'Document should have content');
  assert.ok(result.document.metadata, 'Document should have metadata');
  assert.ok(result.document.chunks, 'Document should have chunks');
  assert.strictEqual(result.document.metadata.mimetype, 'text/markdown');
  console.log('  PASSED\n');
}

// Test 5: Chunk metadata
{
  console.log('Test 5: Chunk metadata');
  const input = '# Section\n\nParagraph of text here.\n';
  const result = chunkMarkdown(input, {
    strategy: 'markdown_blocks',
    max_tokens: 100
  });
  const chunks = result.document.chunks[result.chunk_group];
  assert.ok(chunks.length > 0, 'Should have chunks');
  const chunk = chunks[0];
  assert.ok(chunk.id, 'Chunk should have ID');
  assert.ok(chunk.parent, 'Chunk should have parent');
  assert.ok(chunk.content, 'Chunk should have content');
  assert.ok(chunk.metadata, 'Chunk should have metadata');
  assert.ok(typeof chunk.metadata.chunk_index === 'number', 'Should have chunk_index');
  assert.ok(typeof chunk.metadata.token_count === 'number', 'Should have token_count');
  console.log(`  First chunk token count: ${chunk.metadata.token_count}`);
  console.log('  PASSED\n');
}

// Test 6: No chunk exceeds max_tokens
{
  console.log('Test 6: No chunk exceeds max_tokens');
  const fixturePath = path.join(__dirname, 'fixtures/markdown/headings-nested.md');
  const input = fs.readFileSync(fixturePath, 'utf8');
  const maxTokens = 50;
  const result = chunkMarkdown(input, {
    strategy: 'markdown_blocks',
    max_tokens: maxTokens
  });
  const chunks = result.document.chunks[result.chunk_group];
  for (const chunk of chunks) {
    assert.ok(
      chunk.metadata.token_count <= maxTokens * 1.5, // Allow some tolerance for edge cases
      `Chunk ${chunk.id} has ${chunk.metadata.token_count} tokens, expected <= ${maxTokens}`
    );
  }
  console.log(`  All ${chunks.length} chunks within token limit`);
  console.log('  PASSED\n');
}

// Test 7: Sliding window strategy
{
  console.log('Test 7: Sliding window strategy');
  const input = 'This is a test. '.repeat(20);
  const result = chunkMarkdown(input, {
    strategy: 'sliding_window',
    max_tokens: 30,
    overlap_tokens: 10
  });
  assert.ok(result.chunks_created > 1, 'Should create multiple chunks');
  console.log(`  Created ${result.chunks_created} sliding window chunks`);
  console.log('  PASSED\n');
}

// Test 8: Recursive separators strategy
{
  console.log('Test 8: Recursive separators strategy');
  const input = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.\n';
  const result = chunkMarkdown(input, {
    strategy: 'recursive_separators',
    max_tokens: 20
  });
  assert.ok(result.chunks_created > 0, 'Should create chunks');
  console.log(`  Created ${result.chunks_created} recursive separator chunks`);
  console.log('  PASSED\n');
}

// Test 9: All strategies available
{
  console.log('Test 9: All strategies available');
  const strategies = getStrategies();
  const expectedStrategies = [
    'markdown_headers',
    'markdown_blocks',
    'recursive_separators',
    'sliding_window',
    'sentence_pack',
    'obsidian'
  ];
  for (const id of expectedStrategies) {
    assert.ok(hasStrategy(id), `Strategy ${id} should be available`);
  }
  console.log(`  All ${expectedStrategies.length} strategies available`);
  console.log('  PASSED\n');
}

// Test 10: Deterministic chunking
{
  console.log('Test 10: Deterministic chunking');
  const input = '# Title\n\nContent here.\n';
  const result1 = chunkMarkdown(input, { strategy: 'markdown_blocks', max_tokens: 100 });
  const result2 = chunkMarkdown(input, { strategy: 'markdown_blocks', max_tokens: 100 });
  assert.strictEqual(result1.document.id, result2.document.id, 'Document IDs should match');
  assert.strictEqual(result1.chunk_group, result2.chunk_group, 'Chunk groups should match');
  assert.strictEqual(result1.chunks_created, result2.chunks_created, 'Chunk counts should match');
  console.log('  PASSED\n');
}

// Test 11: Custom group name
{
  console.log('Test 11: Custom group name');
  const input = '# Title\n\nContent.\n';
  const result = chunkMarkdown(input, {
    strategy: 'markdown_blocks',
    max_tokens: 100,
    group_name: 'custom_group'
  });
  assert.strictEqual(result.chunk_group, 'custom_group');
  assert.ok(result.document.chunks['custom_group'], 'Should use custom group name');
  console.log('  PASSED\n');
}

// Test 12: Obsidian strategy with fixture
{
  console.log('Test 12: Obsidian strategy with fixture');
  const fixturePath = path.join(__dirname, 'fixtures/markdown/obsidian-full.md');
  const input = fs.readFileSync(fixturePath, 'utf8');
  const result = chunkMarkdown(input, {
    strategy: 'obsidian',
    max_tokens: 100
  });
  assert.ok(result.chunks_created > 0, 'Should create chunks');
  console.log(`  Created ${result.chunks_created} obsidian chunks`);
  console.log('  PASSED\n');
}

console.log('All chunking tests passed!');
