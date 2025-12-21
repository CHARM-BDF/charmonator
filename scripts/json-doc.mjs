#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { JSONDocument } from '../lib/json-document.mjs'; // or wherever your helper lives

function showUsageAndExit() {
  console.log(`
Usage:
  json-doc.js <command> <arguments...>

Commands:
  extract-markdown             <path/to/document.json> [--metadata]
      Reads the JSON file (doc/chunk format) and prints all extracted text/markdown.
      If --metadata is given, print metadata in <!-- --> comments:
        - For top-level content, metadata is printed at the top.
        - If reassembling from a content_chunk_group, metadata is printed per chunk.

  extract-summary              <path/to/document.json> [--field <name>] [--separator <sep>]
      Reads the JSON file and prints doc.annotations.summary (or specified field) if present.
      For delta-fold summaries (arrays), joins elements with separator (default: "\n\n--\n\n").

  merge-chunks-by-count <maxTokens> [<encoding>] <path/to/document.json>
      Merges the "pages" chunk group into larger chunks, each up to maxTokens tokens.
      If <encoding> is omitted, defaults to "cl100k_base".

  concatenate <output.json> <input1.json> [input2.json ...]
      Combines multiple top-level JSON docs into a single new top-level document.

  extract-chunk-annotations   <path/to/document.json> --chunk-group <groupName> [--target <targetAnnotation>] [--metadata]
      For each chunk in the specified chunk group, prints out each member of annotations[<target>]
      (default target: "summary"). If --metadata is provided, prints all metadata for each chunk
      as markdown comments in the format: <!-- METADATA: <key>: <value> -->

  wrap
      Reads from stdin and converts the input into a valid JSON document object.
      The input becomes the document's "content" and its SHA‑256 hash is used as the "id".

Examples:
  json-doc.js extract-markdown mydoc.json
  json-doc.js extract-summary  mydoc.json

  # Merges existing "pages" chunks into 2048-token chunks using default "cl100k_base" encoding
  json-doc.js merge-chunks-by-count 2048 mydoc.json

  # Same but specifying an encoding
  json-doc.js merge-chunks-by-count 2048 cl100k_base mydoc.json

  # Concatenates multiple doc files into a single new doc
  json-doc.js concatenate combined.json doc1.json doc2.json doc3.json

  # Extract annotations from each chunk in the "pages" chunk group, printing the "summary" annotation.
  json-doc.js extract-chunk-annotations mydoc.json --chunk-group pages

  # Wrap content from stdin into a JSON document object
  cat somefile.txt | json-doc.js wrap
`);
  process.exit(1);
}

/**
 * Parses arguments for "extract-markdown" and returns an object:
 *   {
 *     filePath: string,
 *     metadataFlag: boolean
 *   }
 */
function parseExtractMarkdownArgs(args) {
  let filePath = null;
  let metadataFlag = false;
  for (const arg of args) {
    if (arg === '--metadata') {
      metadataFlag = true;
    } else if (arg.startsWith('--')) {
      console.error(`[ERROR] Unknown option: ${arg}`);
      process.exit(1);
    } else {
      if (filePath !== null) {
        console.error('[ERROR] Too many positional arguments for extract-markdown.');
        showUsageAndExit();
      }
      filePath = arg;
    }
  }
  return { filePath, metadataFlag };
}

/**
 * Parses arguments for "extract-summary" and returns an object:
 *   {
 *     filePath: string,
 *     field: string (default: 'summary'),
 *     separator: string (default: '\n\n--\n\n')
 *   }
 */
function parseExtractSummaryArgs(args) {
  let filePath = null;
  let field = 'summary';
  let separator = '\n\n--\n\n';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--field') {
      if (i + 1 < args.length) {
        field = args[++i];
      } else {
        console.error('[ERROR] Missing value for --field');
        process.exit(1);
      }
    } else if (arg === '--separator') {
      if (i + 1 < args.length) {
        // Handle escape sequences in the separator
        separator = args[++i].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      } else {
        console.error('[ERROR] Missing value for --separator');
        process.exit(1);
      }
    } else if (arg.startsWith('--')) {
      console.error(`[ERROR] Unknown option: ${arg}`);
      process.exit(1);
    } else {
      if (filePath !== null) {
        console.error('[ERROR] Too many positional arguments for extract-summary.');
        showUsageAndExit();
      }
      filePath = arg;
    }
  }
  return { filePath, field, separator };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    showUsageAndExit();
  }

  const [command, ...rest] = args;

  switch (command) {
    case 'extract-markdown': {
      // Parse arguments to handle optional --metadata
      const { filePath, metadataFlag } = parseExtractMarkdownArgs(rest);
      if (!filePath) {
        showUsageAndExit();
      }
      await doExtractMarkdown(filePath, { metadataFlag });
      break;
    }

    case 'extract-summary': {
      const extractSummaryOpts = parseExtractSummaryArgs(rest);
      if (!extractSummaryOpts.filePath) {
        showUsageAndExit();
      }
      await doExtractSummary(extractSummaryOpts.filePath, extractSummaryOpts);
      break;
    }

    case 'merge-chunks-by-count':
      // Expect: merge-chunks-by-count <maxTokens> [<encoding>] <path/to/document.json>
      await doMergeChunksByCount(rest);
      break;

    case 'concatenate': {
      // Expect: concatenate <outputFile> <inputFile1> [inputFile2 ...]
      if (rest.length < 2) {
        console.error('[ERROR] concatenate requires at least one output file and one input file.');
        console.error('Usage: json-doc.js concatenate <output.json> <doc1.json> [doc2.json ...]');
        process.exit(1);
      }
      await doConcatenate(rest[0], rest.slice(1));
      break;
    }

    case 'extract-chunk-annotations':
      await doExtractChunkAnnotations(rest);
      break;

    case 'wrap':
      await doWrap();
      break;

    default:
      console.error(`[ERROR] Unknown command: ${command}`);
      showUsageAndExit();
  }
}

/**
 * Command handler: wrap
 * Reads all data from stdin and converts it into a valid JSON document object.
 * The input text becomes the document's "content" and a SHA‑256 hash of the content is used as the "id".
 */
async function doWrap() {
  let input = '';
  process.stdin.setEncoding('utf8');

  // Read all data from stdin.
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Compute a SHA‑256 hash of the input to serve as a unique id.
  const hash = crypto.createHash('sha256').update(input).digest('hex');

  const docObj = {
    id: hash,
    content: input,
  };

  // Output the JSON document object.
  console.log(JSON.stringify(docObj, null, 2));
}

/**
 * Loads the doc from disk, then prints the top-level doc's resolved Markdown content.
 * If --metadata is given:
 *   - For top-level content, prints docObj.metadata in <!-- --> at the top (if any).
 *   - If docObj is reassembled from a content_chunk_group, prints each chunk’s metadata in <!-- --> before that chunk’s content.
 */
async function doExtractMarkdown(jsonFile, { metadataFlag = false } = {}) {
  const docObj = loadJsonDoc(jsonFile);
  const doc = new JSONDocument(docObj);

  // Check if we reassemble content from a content_chunk_group
  const contentChunkGroup = docObj.content_chunk_group;
  const hasChunkGroup =
    contentChunkGroup &&
    docObj.chunks &&
    Array.isArray(docObj.chunks[contentChunkGroup]);

  if (hasChunkGroup) {
    // If we have to reassemble from a chunk group, print metadata per chunk if requested
    const chunks = docObj.chunks[contentChunkGroup];
    for (const chunkObj of chunks) {
      if (metadataFlag && chunkObj.metadata) {
        // Print chunk metadata as HTML comments
        for (const [key, value] of Object.entries(chunkObj.metadata)) {
          console.log(`<!-- ${key}: ${value} -->`);
        }
      }
      // Get the chunk's resolved content
      const chunkDoc = new JSONDocument(chunkObj);
      console.log(chunkDoc.getResolvedContent());
    }
  } else {
    // Otherwise, just print the doc's top-level resolved content
    if (metadataFlag && docObj.metadata) {
      // Print top-level metadata in HTML comments
      for (const [key, value] of Object.entries(docObj.metadata)) {
        console.log(`<!-- ${key}: ${value} -->`);
      }
    }
    console.log(doc.getResolvedContent());
  }
}

/**
 * Loads the doc from disk, then prints doc.annotations[field] if present.
 * For delta-fold summaries (arrays), joins elements with the specified separator.
 * Handles delta-fold format where elements may be JSON strings like '{"delta":"text"}'.
 */
async function doExtractSummary(jsonFile, { field = 'summary', separator = '\n\n--\n\n' } = {}) {
  const docObj = loadJsonDoc(jsonFile);

  // If there's no 'annotations' or the specified field, we just note that.
  if (!docObj.annotations || docObj.annotations[field] === undefined) {
    console.log(`(No summary found in doc.annotations.${field})`);
    return;
  }

  const summary = docObj.annotations[field];

  if (Array.isArray(summary)) {
    // Delta-fold summaries are arrays - extract text and join with separator
    const extractedDeltas = summary.map(extractDeltaText).filter(text => text && text.trim());
    console.log(extractedDeltas.join(separator));
  } else if (typeof summary === 'object') {
    // If it's an object with delta key, extract it
    if (summary.delta !== undefined) {
      console.log(summary.delta);
    } else {
      // Otherwise pretty-print as JSON
      console.log(JSON.stringify(summary, null, 2));
    }
  } else {
    // String or other primitive - try to parse as JSON delta, else print directly
    const extracted = extractDeltaText(summary);
    console.log(extracted);
  }
}

/**
 * Helper to extract text from various delta-fold formats:
 * - String containing JSON: '{"delta":"text"}' -> 'text'
 * - Object with delta: {delta: 'text'} -> 'text'
 * - Plain string: 'text' -> 'text'
 */
function extractDeltaText(item) {
  if (typeof item === 'string') {
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(item);
      if (parsed && typeof parsed.delta === 'string') {
        return parsed.delta;
      }
      // If parsed but no delta key, stringify back
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch (e) {
      // Not JSON, return as-is
      return item;
    }
  } else if (item && typeof item === 'object') {
    if (typeof item.delta === 'string') {
      return item.delta;
    }
    return JSON.stringify(item);
  }
  return String(item);
}

/**
 * Command handler: merge-chunks-by-count
 * Expects:
 *   merge-chunks-by-count <maxTokens> [<encoding>] <path/to/document.json>
 */
async function doMergeChunksByCount(args) {
  if (args.length < 2) {
    showUsageAndExit();
  }

  const maxTokens = parseInt(args[0], 10);
  if (isNaN(maxTokens) || maxTokens < 1) {
    console.error('[ERROR] <maxTokens> must be a positive integer.');
    process.exit(1);
  }

  let encodingName = 'cl100k_base';
  let fileArgIndex = 1;

  // Check if we have 3 arguments
  if (args.length >= 3) {
    // If the second argument doesn't end with .json, treat it as an encoding
    if (!args[1].toLowerCase().endsWith('.json')) {
      encodingName = args[1];
      fileArgIndex = 2;
    }
  }

  const jsonFile = args[fileArgIndex];
  if (!jsonFile) {
    showUsageAndExit();
  }

  const docObj = loadJsonDoc(jsonFile);
  const doc = new JSONDocument(docObj);

  // Merge
  const newChunks = doc.mergeChunksByTokenCount(maxTokens, 'pages', encodingName);

  // Overwrite the file with updated JSON
  fs.writeFileSync(jsonFile, JSON.stringify(doc.toObject(), null, 2), 'utf-8');

  console.log(`Merged chunk group "pages" into new group using maxTokens=${maxTokens}, encoding="${encodingName}".`);

  // Total number of chunks:
  if (docObj.chunks && docObj.chunks.pages) {
    console.log(`  Old chunks: ${docObj.chunks.pages.length}`);
  }
  console.log(`  New chunks: ${newChunks.length}`);

  console.log(`File updated: ${jsonFile}`);
}

/**
 * Command handler: concatenate
 * Combines multiple top-level JSON docs into a new top-level doc
 * and writes the result to outputFile.
 */
async function doConcatenate(outputFile, inputFiles) {
  // Load each input doc
  const docsArray = inputFiles.map(loadJsonDoc);

  // Create a new master doc from all loaded docs
  // This sets each child doc's parent to the master doc's id
  // and places them under the chunk group "sources" by default.
  const masterDoc = JSONDocument.createMasterDocFromDocs(docsArray);

  // Write to outputFile
  fs.writeFileSync(
    outputFile,
    JSON.stringify(masterDoc.toObject(), null, 2),
    'utf-8'
  );

  console.log(`Concatenated ${docsArray.length} documents into: ${outputFile}`);
}

/**
 * Command handler: extract-chunk-annotations
 * For each chunk in the specified chunk group, prints out each member of annotations[<target>].
 * If --metadata is specified, prints all metadata for each chunk as Markdown comments.
 *
 * Expected options:
 *   <path/to/document.json> --chunk-group <groupName> [--target <targetAnnotation>] [--metadata]
 */
async function doExtractChunkAnnotations(args) {
  let jsonFile = null;
  let chunkGroup = null;
  let target = 'summary';
  let metadataFlag = false;

  // Simple command-line option parsing.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--chunk-group') {
      if (i + 1 < args.length) {
        chunkGroup = args[++i];
      } else {
        console.error('[ERROR] Missing value for --chunk-group');
        process.exit(1);
      }
    } else if (arg === '--target') {
      if (i + 1 < args.length) {
        target = args[++i];
      } else {
        console.error('[ERROR] Missing value for --target');
        process.exit(1);
      }
    } else if (arg === '--metadata') {
      metadataFlag = true;
    } else if (arg.startsWith('--')) {
      console.error(`[ERROR] Unknown option: ${arg}`);
      process.exit(1);
    } else {
      if (jsonFile === null) {
        jsonFile = arg;
      } else {
        console.error(`[ERROR] Unexpected positional argument: ${arg}`);
        process.exit(1);
      }
    }
  }

  if (!jsonFile) {
    console.error('[ERROR] JSON file path is required.');
    process.exit(1);
  }
  if (!chunkGroup) {
    console.error('[ERROR] --chunk-group option is required.');
    process.exit(1);
  }

  const docObj = loadJsonDoc(jsonFile);
  if (!docObj.chunks || !docObj.chunks[chunkGroup]) {
    console.error(`[ERROR] Chunk group "${chunkGroup}" not found in document.`);
    process.exit(1);
  }

  const chunks = docObj.chunks[chunkGroup];
  for (const chunk of chunks) {
    // If metadata flag is on, render each metadata key/value as a markdown comment.
    if (metadataFlag && chunk.metadata) {
      for (const key in chunk.metadata) {
        console.log(`<!-- METADATA: ${key}: ${chunk.metadata[key]} -->`);
      }
    }

    // Retrieve the target annotation.
    if (chunk.annotations && chunk.annotations[target] !== undefined) {
      const annotationValue = chunk.annotations[target];
      if (Array.isArray(annotationValue)) {
        annotationValue.forEach(item => console.log(item));
      } else {
        console.log(annotationValue);
      }
    }
    // Separate each chunk's output by a blank line.
    console.log('');
  }
}

/**
 * Helper to load JSON from file into an object. Exits on error.
 */
function loadJsonDoc(jsonFile) {
  if (!fs.existsSync(jsonFile)) {
    console.error(`[ERROR] File not found: ${jsonFile}`);
    process.exit(1);
  }

  let rawData;
  try {
    rawData = fs.readFileSync(path.resolve(jsonFile), 'utf-8');
  } catch (err) {
    console.error(`[ERROR] Could not read file: ${jsonFile}`);
    console.error(err);
    process.exit(1);
  }

  let docObj;
  try {
    docObj = JSON.parse(rawData);
  } catch (err) {
    console.error(`[ERROR] Could not parse JSON in file: ${jsonFile}`);
    console.error(err);
    process.exit(1);
  }
  return docObj;
}

// Kick off
main().catch(err => {
  console.error('[ERROR] Uncaught exception in script:', err);
  process.exit(1);
});
