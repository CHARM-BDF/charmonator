/**
 * lib/markdown/chunk.mjs
 *
 * Token-bounded chunking of markdown segments.
 * Produces final chunks suitable for indexing and embedding.
 */

import crypto from 'crypto';
import { countTokensLocal, tokenizeLocal } from '../tokenizer.mjs';
import { segmentMarkdown } from './segment.mjs';
import { normalizeMarkdown } from './normalize.mjs';

/**
 * @typedef {Object} Chunk
 * @property {string} id - Chunk ID
 * @property {string} parent - Parent document ID
 * @property {string} content - Chunk text
 * @property {Object} metadata - Chunk metadata
 * @property {number} metadata.chunk_index
 * @property {number} metadata.token_count
 * @property {string[]} metadata.header_path
 * @property {{ start_line: number, end_line: number }} metadata.span
 */

/**
 * Generate a deterministic group name for chunks
 * @param {string} strategy - Strategy name
 * @param {number} maxTokens - Max tokens per chunk
 * @param {string} encoding - Tokenizer encoding
 * @param {number} overlapTokens - Overlap tokens
 * @returns {string}
 */
export function generateGroupName(strategy, maxTokens, encoding, overlapTokens) {
  return `markdown:${strategy}(${maxTokens},${encoding},overlap=${overlapTokens})`;
}

/**
 * Generate a chunk ID
 * @param {string} parentId - Parent document ID
 * @param {string} groupName - Chunk group name
 * @param {number} index - Chunk index
 * @returns {string}
 */
export function generateChunkId(parentId, groupName, index) {
  return `${parentId}/${groupName}@${index}`;
}

/**
 * Pack segments into token-bounded chunks with overlap
 * @param {Array} segments - Array of segments
 * @param {Object} options - Chunking options
 * @returns {Array} Array of chunks
 */
function packSegments(segments, options) {
  const {
    max_tokens,
    overlap_tokens = 0,
    encoding = 'cl100k_base',
    parent_id,
    group_name
  } = options;

  const chunks = [];
  let currentChunk = {
    texts: [],
    tokens: 0,
    headerPath: [],
    startLine: null,
    endLine: null
  };

  for (const segment of segments) {
    const segmentTokens = countTokensLocal(segment.text, encoding);

    // If this single segment exceeds max_tokens, we need to split it
    if (segmentTokens > max_tokens) {
      // Flush current chunk first
      if (currentChunk.texts.length > 0) {
        chunks.push(finalizeChunk(currentChunk, chunks.length, parent_id, group_name, encoding));
        currentChunk = createNewChunk(currentChunk, overlap_tokens, encoding);
      }

      // Split the oversized segment
      const splitChunks = splitOversizedSegment(segment, max_tokens, encoding);
      for (const splitChunk of splitChunks) {
        chunks.push({
          id: generateChunkId(parent_id, group_name, chunks.length),
          parent: parent_id,
          content: splitChunk.text,
          metadata: {
            chunk_index: chunks.length,
            token_count: splitChunk.tokens,
            header_path: segment.header_path || [],
            span: segment.span
          }
        });
      }

      continue;
    }

    // Check if adding this segment would exceed max_tokens
    if (currentChunk.tokens + segmentTokens > max_tokens && currentChunk.texts.length > 0) {
      // Finalize current chunk
      chunks.push(finalizeChunk(currentChunk, chunks.length, parent_id, group_name, encoding));

      // Start new chunk with overlap from previous
      currentChunk = createNewChunk(currentChunk, overlap_tokens, encoding);
    }

    // Add segment to current chunk
    currentChunk.texts.push(segment.text);
    currentChunk.tokens += segmentTokens;
    currentChunk.headerPath = segment.header_path || currentChunk.headerPath;

    if (currentChunk.startLine === null) {
      currentChunk.startLine = segment.span?.start_line || 1;
    }
    currentChunk.endLine = segment.span?.end_line || currentChunk.endLine;
  }

  // Finalize last chunk
  if (currentChunk.texts.length > 0) {
    chunks.push(finalizeChunk(currentChunk, chunks.length, parent_id, group_name, encoding));
  }

  return chunks;
}

/**
 * Create a new chunk with overlap from the previous chunk
 * @param {Object} previousChunk - Previous chunk
 * @param {number} overlapTokens - Number of overlap tokens
 * @param {string} encoding - Tokenizer encoding
 * @returns {Object} New chunk state
 */
function createNewChunk(previousChunk, overlapTokens, encoding) {
  if (overlapTokens <= 0 || previousChunk.texts.length === 0) {
    return {
      texts: [],
      tokens: 0,
      headerPath: previousChunk.headerPath,
      startLine: null,
      endLine: null
    };
  }

  // Get overlap text from end of previous chunk
  const fullText = previousChunk.texts.join('\n\n');
  const tokens = tokenizeLocal(fullText, encoding);

  if (tokens.length <= overlapTokens) {
    // Entire previous chunk is overlap
    return {
      texts: [fullText],
      tokens: tokens.length,
      headerPath: previousChunk.headerPath,
      startLine: previousChunk.startLine,
      endLine: previousChunk.endLine
    };
  }

  // For simplicity, approximate overlap by character ratio
  // This provides a good approximation without requiring token decoding
  const charRatio = overlapTokens / tokens.length;
  const overlapText = fullText.slice(-Math.floor(fullText.length * charRatio));

  return {
    texts: [overlapText],
    tokens: overlapTokens,
    headerPath: previousChunk.headerPath,
    startLine: previousChunk.startLine,
    endLine: previousChunk.endLine
  };
}

/**
 * Finalize a chunk into the output format
 * @param {Object} chunkState - Current chunk state
 * @param {number} index - Chunk index
 * @param {string} parentId - Parent document ID
 * @param {string} groupName - Group name
 * @param {string} encoding - Tokenizer encoding
 * @returns {Chunk}
 */
function finalizeChunk(chunkState, index, parentId, groupName, encoding) {
  const content = chunkState.texts.join('\n\n');
  return {
    id: generateChunkId(parentId, groupName, index),
    parent: parentId,
    content,
    metadata: {
      chunk_index: index,
      token_count: countTokensLocal(content, encoding),
      header_path: chunkState.headerPath,
      span: {
        start_line: chunkState.startLine || 1,
        end_line: chunkState.endLine || 1
      }
    }
  };
}

/**
 * Split an oversized segment into multiple chunks
 * @param {Object} segment - Segment to split
 * @param {number} maxTokens - Max tokens per chunk
 * @param {string} encoding - Tokenizer encoding
 * @returns {Array<{ text: string, tokens: number }>}
 */
function splitOversizedSegment(segment, maxTokens, encoding) {
  const text = segment.text;
  const chunks = [];

  // Try splitting by paragraphs first
  const paragraphs = text.split(/\n\n+/);

  if (paragraphs.length > 1) {
    let current = { texts: [], tokens: 0 };

    for (const para of paragraphs) {
      const paraTokens = countTokensLocal(para, encoding);

      if (paraTokens > maxTokens) {
        // Flush current
        if (current.texts.length > 0) {
          chunks.push({
            text: current.texts.join('\n\n'),
            tokens: current.tokens
          });
          current = { texts: [], tokens: 0 };
        }
        // Split paragraph further
        const subChunks = splitBySentences(para, maxTokens, encoding);
        chunks.push(...subChunks);
      } else if (current.tokens + paraTokens > maxTokens) {
        // Flush and start new
        if (current.texts.length > 0) {
          chunks.push({
            text: current.texts.join('\n\n'),
            tokens: current.tokens
          });
        }
        current = { texts: [para], tokens: paraTokens };
      } else {
        current.texts.push(para);
        current.tokens += paraTokens;
      }
    }

    if (current.texts.length > 0) {
      chunks.push({
        text: current.texts.join('\n\n'),
        tokens: current.tokens
      });
    }

    return chunks;
  }

  // Fall back to sentence splitting
  return splitBySentences(text, maxTokens, encoding);
}

/**
 * Split text by sentences
 * @param {string} text - Text to split
 * @param {number} maxTokens - Max tokens per chunk
 * @param {string} encoding - Tokenizer encoding
 * @returns {Array<{ text: string, tokens: number }>}
 */
function splitBySentences(text, maxTokens, encoding) {
  // Simple sentence boundary detection
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let current = { texts: [], tokens: 0 };

  for (const sentence of sentences) {
    const sentTokens = countTokensLocal(sentence, encoding);

    if (sentTokens > maxTokens) {
      // Flush current
      if (current.texts.length > 0) {
        chunks.push({
          text: current.texts.join(' '),
          tokens: current.tokens
        });
        current = { texts: [], tokens: 0 };
      }
      // Split by words as last resort
      const wordChunks = splitByWords(sentence, maxTokens, encoding);
      chunks.push(...wordChunks);
    } else if (current.tokens + sentTokens > maxTokens) {
      if (current.texts.length > 0) {
        chunks.push({
          text: current.texts.join(' '),
          tokens: current.tokens
        });
      }
      current = { texts: [sentence], tokens: sentTokens };
    } else {
      current.texts.push(sentence);
      current.tokens += sentTokens;
    }
  }

  if (current.texts.length > 0) {
    chunks.push({
      text: current.texts.join(' '),
      tokens: current.tokens
    });
  }

  return chunks;
}

/**
 * Split text by words (last resort)
 * @param {string} text - Text to split
 * @param {number} maxTokens - Max tokens per chunk
 * @param {string} encoding - Tokenizer encoding
 * @returns {Array<{ text: string, tokens: number }>}
 */
function splitByWords(text, maxTokens, encoding) {
  const words = text.split(/\s+/);
  const chunks = [];
  let current = { words: [], tokens: 0 };

  for (const word of words) {
    const wordTokens = countTokensLocal(word, encoding);

    if (current.tokens + wordTokens > maxTokens) {
      if (current.words.length > 0) {
        const chunkText = current.words.join(' ');
        chunks.push({
          text: chunkText,
          tokens: countTokensLocal(chunkText, encoding)
        });
      }
      current = { words: [word], tokens: wordTokens };
    } else {
      current.words.push(word);
      current.tokens += wordTokens;
    }
  }

  if (current.words.length > 0) {
    const chunkText = current.words.join(' ');
    chunks.push({
      text: chunkText,
      tokens: countTokensLocal(chunkText, encoding)
    });
  }

  return chunks;
}

/**
 * Sliding window chunking (TokenTextSplitter style)
 * @param {string} markdown - Raw markdown
 * @param {Object} options - Chunking options
 * @returns {Array} Array of chunks
 */
function chunkSlidingWindow(markdown, options) {
  const {
    max_tokens,
    overlap_tokens = 0,
    encoding = 'cl100k_base',
    parent_id,
    group_name
  } = options;

  const tokens = tokenizeLocal(markdown, encoding);
  const stride = max_tokens - overlap_tokens;
  const chunks = [];

  for (let i = 0; i < tokens.length; i += stride) {
    const windowTokens = tokens.slice(i, i + max_tokens);

    // Decode tokens back to text
    // Approximate by character position
    const startChar = Math.floor((i / tokens.length) * markdown.length);
    const endChar = Math.floor(((i + windowTokens.length) / tokens.length) * markdown.length);
    const text = markdown.slice(startChar, endChar);

    chunks.push({
      id: generateChunkId(parent_id, group_name, chunks.length),
      parent: parent_id,
      content: text,
      metadata: {
        chunk_index: chunks.length,
        token_count: windowTokens.length,
        header_path: [],
        span: { start_line: 1, end_line: 1 } // Approximate
      }
    });

    if (i + max_tokens >= tokens.length) break;
  }

  return chunks;
}

/**
 * Recursive separator chunking (RecursiveCharacterTextSplitter style)
 * @param {string} markdown - Raw markdown
 * @param {Object} options - Chunking options
 * @returns {Array} Array of chunks
 */
function chunkRecursiveSeparators(markdown, options) {
  const {
    max_tokens,
    overlap_tokens = 0,
    encoding = 'cl100k_base',
    parent_id,
    group_name,
    separators = ['\n\n', '\n', ' ', '']
  } = options;

  const segments = recursiveSplit(markdown, separators, max_tokens, encoding);
  return packSegments(
    segments.map((text, i) => ({
      text,
      header_path: [],
      span: { start_line: 1, end_line: 1 }
    })),
    { max_tokens, overlap_tokens, encoding, parent_id, group_name }
  );
}

/**
 * Recursively split text using separators
 * @param {string} text - Text to split
 * @param {string[]} separators - Ordered list of separators
 * @param {number} maxTokens - Max tokens per segment
 * @param {string} encoding - Tokenizer encoding
 * @returns {string[]} Array of text segments
 */
function recursiveSplit(text, separators, maxTokens, encoding) {
  if (countTokensLocal(text, encoding) <= maxTokens) {
    return [text];
  }

  if (separators.length === 0) {
    // Last resort: split by character count
    const segments = [];
    const approxChars = maxTokens * 4;
    for (let i = 0; i < text.length; i += approxChars) {
      segments.push(text.slice(i, i + approxChars));
    }
    return segments;
  }

  const [sep, ...remainingSeps] = separators;

  if (sep === '') {
    return recursiveSplit(text, remainingSeps, maxTokens, encoding);
  }

  const parts = text.split(sep);
  const segments = [];

  for (const part of parts) {
    if (countTokensLocal(part, encoding) <= maxTokens) {
      segments.push(part);
    } else {
      segments.push(...recursiveSplit(part, remainingSeps, maxTokens, encoding));
    }
  }

  return segments;
}

/**
 * Chunk markdown into token-bounded chunks.
 *
 * @param {string} markdown - Raw markdown text
 * @param {Object} options - Chunking options
 * @param {string} options.strategy - Chunking strategy
 * @param {number} options.max_tokens - Maximum tokens per chunk
 * @param {number} [options.overlap_tokens=0] - Overlap tokens between chunks
 * @param {string} [options.encoding='cl100k_base'] - Tokenizer encoding
 * @param {string} [options.group_name] - Optional custom group name
 * @param {Object} [options.strategy_options] - Strategy-specific options
 * @returns {{ document: Object, chunk_group: string, chunks_created: number, warnings: string[] }}
 */
export function chunkMarkdown(markdown, options) {
  const {
    strategy = 'markdown_blocks',
    max_tokens,
    overlap_tokens = 0,
    encoding = 'cl100k_base',
    group_name,
    strategy_options = {}
  } = options;

  // Normalize markdown first
  const { markdown: normalizedMarkdown, id: parentId } = normalizeMarkdown(markdown);

  // Generate group name if not provided
  const finalGroupName = group_name || generateGroupName(strategy, max_tokens, encoding, overlap_tokens);

  const warnings = [];
  let chunks;

  switch (strategy) {
    case 'sliding_window':
      chunks = chunkSlidingWindow(normalizedMarkdown, {
        max_tokens,
        overlap_tokens,
        encoding,
        parent_id: parentId,
        group_name: finalGroupName
      });
      break;

    case 'recursive_separators':
      chunks = chunkRecursiveSeparators(normalizedMarkdown, {
        max_tokens,
        overlap_tokens,
        encoding,
        parent_id: parentId,
        group_name: finalGroupName,
        separators: strategy_options.separators
      });
      break;

    case 'markdown_headers':
    case 'markdown_blocks':
    case 'sentence_pack':
    case 'obsidian':
    default:
      // Use segmentation-based chunking
      const segments = segmentMarkdown(normalizedMarkdown, strategy, strategy_options);
      chunks = packSegments(segments, {
        max_tokens,
        overlap_tokens,
        encoding,
        parent_id: parentId,
        group_name: finalGroupName
      });
      break;
  }

  // Build document object
  const document = {
    id: parentId,
    content: normalizedMarkdown,
    metadata: {
      mimetype: 'text/markdown',
      chunking: {
        strategy,
        max_tokens,
        overlap_tokens,
        encoding
      }
    },
    chunks: {
      [finalGroupName]: chunks
    }
  };

  return {
    document,
    chunk_group: finalGroupName,
    chunks_created: chunks.length,
    warnings
  };
}

export default chunkMarkdown;
