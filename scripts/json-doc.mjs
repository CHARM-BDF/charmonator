#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { JSONDocument } from '../lib/json-document.mjs'; // or wherever your helper lives


function showUsageAndExit() {
  console.log(`
Usage:
  json-doc.js <command> <arguments...>

Commands:
  extract-markdown             <path/to/document.json>
      Reads the JSON file (doc/chunk format) and prints all extracted text/markdown.

  extract-summary              <path/to/document.json>
      Reads the JSON file and prints doc.annotations.summary if present.

  merge-chunks-by-count <maxTokens> [<encoding>] <path/to/document.json>
      Merges the "pages" chunk group into larger chunks, each up to maxTokens tokens.
      If <encoding> is omitted, defaults to "cl100k_base".

Examples:
  json-doc.js extract-markdown mydoc.json
  json-doc.js extract-summary  mydoc.json

  # Merges existing "pages" chunks into 2048-token chunks using default "cl100k_base" encoding
  json-doc.js merge-chunks-by-count 2048 mydoc.json

  # Same but specifying an encoding
  json-doc.js merge-chunks-by-count 2048 cl100k_base mydoc.json
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    showUsageAndExit();
  }

  const [command, ...rest] = args;

  switch (command) {
    case 'extract-markdown':
      if (rest.length < 1) {
        showUsageAndExit();
      }
      await doExtractMarkdown(rest[0]);
      break;

    case 'extract-summary':
      if (rest.length < 1) {
        showUsageAndExit();
      }
      await doExtractSummary(rest[0]);
      break;

    case 'merge-chunks-by-count':
      // Expect: merge-chunks-by-count <maxTokens> [<encoding>] <path/to/document.json>
      await doMergeChunksByCount(rest);
      break;

    default:
      console.error(`[ERROR] Unknown command: ${command}`);
      showUsageAndExit();
  }
}

/**
 * Loads the doc from disk, then prints the top-level doc's resolved Markdown content.
 */
async function doExtractMarkdown(jsonFile) {
  const docObj = loadJsonDoc(jsonFile);
  const doc = new JSONDocument(docObj);

  const content = doc.getResolvedContent();
  console.log(content);
}

/**
 * Loads the doc from disk, then prints doc.annotations.summary if present.
 */
async function doExtractSummary(jsonFile) {
  const docObj = loadJsonDoc(jsonFile);

  // If there's no 'annotations' or 'summary', we just note that.
  if (docObj.annotations && docObj.annotations.summary) {
    console.log(docObj.annotations.summary);
  } else {
    console.log('(No summary found in doc.annotations.summary)');
  }
}

/**
 * Command handler: merge-chunks-by-count
 */
async function doMergeChunksByCount(args) {
  // We need at least 2 arguments: <maxTokens>, <doc.json>
  // Possibly 3: <maxTokens>, <encoding>, <doc.json>
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
  console.log(`  Old chunks: ${docObj.chunks.pages.length}`);
  console.log(`  New chunks: ${newChunks.length}`);

  console.log(`File updated: ${jsonFile}`);
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
