/**
 * json-document.mjs
 *
 * A convenient wrapper around a "document object," following the specification in document.md.
 *
 * This version includes two chunking methods:
 *   1) mergeChunksByTokenCount(...) => merges small chunks into fewer, larger ones (not exceeding maxTokens).
 *   2) splitOversizedChunksByTokenCount(...) => splits only chunks that exceed a size.
 *
 * Both have destructive and non-destructive ("with...") versions.
 */

import { TextDecoder } from 'util';
import { createRequire } from 'module';

// Optional fallback to the tiktoken library if available:
let tiktokenLib = null;
try {
  const require = createRequire(import.meta.url);
  tiktokenLib = require('tiktoken');
} catch (err) {
  // In the browser or tiktoken not installed
}

/**
 * _forceString:
 *   Some encoders return a Uint8Array. Convert that to a true string.
 *   If it’s already a string, we pass it through untouched.
 */
function _forceString(decoded) {
  if (typeof decoded === 'string') {
    return decoded;
  }
  if (decoded instanceof Uint8Array) {
    const dec = new TextDecoder();
    return dec.decode(decoded);
  }
  return String(decoded);
}

export class JSONDocument {
  /**
   * @param {Object}         docObj        - Raw JSON data for this doc (see document.md).
   * @param {JSONDocument|null} parentDoc  - If this chunk references a parent doc, pass it here.
   * @param {Object|null}    tokenCounter  - Optional custom token counter, e.g. {
   *                                          get_encoding(name) {
   *                                            return { encode(text), decode(tokens) };
   *                                          }
   *                                        }
   */
  constructor(docObj, parentDoc = null, tokenCounter = null) {
    if (typeof docObj !== 'object' || docObj === null) {
      throw new Error('JSONDocument requires a non-null object.');
    }
    this._doc = docObj;
    this._parentDoc = parentDoc;
    this._tokenCounter = tokenCounter;

    // Navigation fields for chunk sequences (not serialized):
    this.nextChunk = null;
    this.previousChunk = null;
  }

  /**
   * Create a new "master" JSON document whose chunks are the given array of
   * top-level documents. Each original doc becomes a child object in a specified
   * chunk group (default: "sources"). The parent of each child doc is set to the
   * master's id. The master's id is, by default, a concatenation of all child doc
   * IDs joined by ":". It also sets "content_chunk_group" = that chunk group on the
   * master, so that getResolvedContent() uses those child docs as the doc's content.
   *
   * @param {Object[]} docsArray - Array of raw JSON doc objects (top-level).
   * @param {Object} [options]
   * @param {string} [options.masterDocId] - If omitted, will join child doc IDs with ":".
   * @param {string} [options.docGroupName="sources"] - The chunk group key where child docs go.
   * @return {JSONDocument} A new top-level JSONDocument.
   */
  static createMasterDocFromDocs(docsArray, options = {}) {
    const {
      masterDocId,
      docGroupName = "sources"
    } = options;

    if (!Array.isArray(docsArray) || docsArray.length === 0) {
      throw new Error("Must provide a non-empty array of top-level documents.");
    }

    // If caller did not specify a masterDocId, derive one by joining child IDs.
    let newId = masterDocId;
    if (!newId) {
      // Example join: "docA:docB:docC"
      newId = docsArray.map(d => d.id).join(":");
    }

    // Construct the raw object for the new master doc
    const masterDocObj = {
      id: newId,
      // Mark the new doc to use docGroupName as its main chunk group:
      content_chunk_group: docGroupName,
      chunks: {
        [docGroupName]: []
      }
    };

    // Deep-clone each child doc so we can safely modify it
    for (const oldDoc of docsArray) {
      const childClone = JSON.parse(JSON.stringify(oldDoc));

      // Force the parent to point to the new master doc
      childClone.parent = newId;

      // Edge case: if child doc's id collides with newId, rename it
      // (or do any other collision-handling logic you prefer)
      if (childClone.id === newId) {
        childClone.id = `${childClone.id}_child`;
      }

      masterDocObj.chunks[docGroupName].push(childClone);
    }

    // Wrap the final raw object in JSONDocument and return
    return new JSONDocument(masterDocObj);
  }

  // --------------------------------------------------------------------------
  // Basic getters/setters
  // --------------------------------------------------------------------------
  get id() { return this._doc.id; }
  set id(newId) { this._doc.id = newId; }

  get content() { return this._doc.content; }
  set content(newContent) { this._doc.content = newContent; }

  get parentId() { return this._doc.parent; }
  set parentId(newParentId) { this._doc.parent = newParentId; }

  get start() { return this._doc.start; }
  set start(val) { this._doc.start = val; }

  get length() { return this._doc.length; }
  set length(val) { this._doc.length = val; }

  get contentChunkGroup() { return this._doc.content_chunk_group; }
  set contentChunkGroup(groupName) { this._doc.content_chunk_group = groupName; }

  get chunks() {
    if (!this._doc.chunks) {
      this._doc.chunks = {};
    }
    return this._doc.chunks;
  }

  // --------------------------------------------------------------------------
  // Chunk access
  // --------------------------------------------------------------------------
  getChunksForGroup(groupName) {
    return this._doc.chunks?.[groupName] || [];
  }

  getWrappedChunksForGroup(groupName) {
    const rawArray = this.getChunksForGroup(groupName);
    const wrappers = rawArray.map(chunkObj => new JSONDocument(
      chunkObj,
      this,
      this._tokenCounter
    ));

    // Link them
    for (let i = 0; i < wrappers.length; i++) {
      if (i > 0) {
        wrappers[i].previousChunk = wrappers[i - 1];
      }
      if (i < wrappers.length - 1) {
        wrappers[i].nextChunk = wrappers[i + 1];
      }
    }
    return wrappers;
  }

  setChunksForGroup(groupName, chunkArray) {
    if (!this._doc.chunks) {
      this._doc.chunks = {};
    }
    this._doc.chunks[groupName] = chunkArray;
  }

  addChunkToGroup(groupName, chunkObj) {
    if (!this._doc.chunks) {
      this._doc.chunks = {};
    }
    if (!this._doc.chunks[groupName]) {
      this._doc.chunks[groupName] = [];
    }
    this._doc.chunks[groupName].push(chunkObj);
  }

  // --------------------------------------------------------------------------
  // Content resolution
  // --------------------------------------------------------------------------
  getResolvedContent() {
    if (typeof this._doc.content === 'string') {
      return this._doc.content;
    }

    if (this._parentDoc &&
        Number.isInteger(this._doc.start) &&
        Number.isInteger(this._doc.length)) {
      const parentFullText = this._parentDoc.getResolvedContent();
      const startIdx = this._doc.start;
      const endIdx = startIdx + this._doc.length;
      if (startIdx < 0 || endIdx > parentFullText.length) {
        throw new Error(`Invalid substring [${startIdx},${endIdx}) in parent doc.`);
      }
      return parentFullText.slice(startIdx, endIdx);
    }

    if (this.contentChunkGroup) {
      const groupName = this.contentChunkGroup;
      const rawChunks = this.getChunksForGroup(groupName);

      let combined = '';
      for (const chunkObj of rawChunks) {
        const childDoc = new JSONDocument(chunkObj, this, this._tokenCounter);
        combined += childDoc.getResolvedContent();
      }
      return combined;
    }

    return '';
  }

  // --------------------------------------------------------------------------
  // JSON / raw object access
  // --------------------------------------------------------------------------
  toObject() {
    return this._doc;
  }

  toJSON() {
    return this._doc;
  }

  // --------------------------------------------------------------------------
  // Merge-chunks method (existing)
  // --------------------------------------------------------------------------
  /**
   * mergeChunksByTokenCount (destructive):
   *   - Merges multiple small chunks into fewer, larger ones (not exceeding maxTokens).
   *   - If a single chunk is bigger than maxTokens alone, it splits that chunk as well.
   *   - Overlapping context is supported with num_overlap_tokens.
   *   - The result is stored under `newGroupName`.
   */
  mergeChunksByTokenCount(
    maxTokens,
    groupName = "pages",
    encodingName = "cl100k_base",
    newGroupName = null,
    num_overlap_tokens = 0
  ) {
    if (!newGroupName) {
      newGroupName = `${groupName}:merged(${maxTokens},${encodingName})`;
    }

    const enc = this._getEncoder(encodingName);
    const chunkDocs = this.getWrappedChunksForGroup(groupName);
    const mergedChunks = [];

    let currentTokens = [];
    let currentTokenCount = 0;

    const pushCurrentMergedChunk = () => {
      if (currentTokenCount > 0) {
        const chunkCount = mergedChunks.length;
        let chunkText = enc.decode(currentTokens);
        chunkText = _forceString(chunkText);

        mergedChunks.push({
          id: `${this.id}/${newGroupName}@${chunkCount}`,
          parent: this.id,
          content: chunkText
        });

        if (num_overlap_tokens > 0) {
          const overlapStart = Math.max(0, currentTokenCount - num_overlap_tokens);
          currentTokens = currentTokens.slice(overlapStart);
          currentTokenCount = currentTokens.length;
        } else {
          currentTokens = [];
          currentTokenCount = 0;
        }
      }
    };

    for (const chunkDoc of chunkDocs) {
      const text = chunkDoc.getResolvedContent() || '';
      const tokens = enc.encode(text);

      if (tokens.length > maxTokens) {
        // If a single chunk is bigger than maxTokens, we split it.
        // Push any accumulated chunk first.
        pushCurrentMergedChunk();

        let startIndex = 0;
        while (startIndex < tokens.length) {
          const endIndex = Math.min(startIndex + maxTokens, tokens.length);
          const sliceTokens = tokens.slice(startIndex, endIndex);
          let sliceText = enc.decode(sliceTokens);
          sliceText = _forceString(sliceText);

          mergedChunks.push({
            id: `${this.id}/${newGroupName}@${mergedChunks.length}`,
            parent: this.id,
            content: sliceText
          });

          if (num_overlap_tokens > 0) {
            const overlapStart = Math.max(0, sliceTokens.length - num_overlap_tokens);
            const overlapTokens = sliceTokens.slice(overlapStart);
            currentTokens = overlapTokens;
            currentTokenCount = overlapTokens.length;
          } else {
            currentTokens = [];
            currentTokenCount = 0;
          }

          startIndex = endIndex - num_overlap_tokens;
          if (startIndex < 0) {
            startIndex = 0;
          }
          if (startIndex >= tokens.length) {
            break;
          }
        }
      } else {
        // If adding this chunk’s tokens would exceed maxTokens,
        // first push the current chunk buffer
        if (currentTokenCount + tokens.length > maxTokens) {
          pushCurrentMergedChunk();
        }
        currentTokens.push(...tokens);
        currentTokenCount += tokens.length;
      }
    }

    // push any leftover
    pushCurrentMergedChunk();
    this.setChunksForGroup(newGroupName, mergedChunks);
    return mergedChunks;
  }

  withMergedChunksByTokenCount(
    maxTokens,
    groupName = "pages",
    encodingName = "cl100k_base",
    newGroupName = null,
    num_overlap_tokens = 0
  ) {
    const clonedDocObj = JSON.parse(JSON.stringify(this._doc));
    const newDoc = new JSONDocument(clonedDocObj, this._parentDoc, this._tokenCounter);
    newDoc.mergeChunksByTokenCount(
      maxTokens,
      groupName,
      encodingName,
      newGroupName,
      num_overlap_tokens
    );
    return newDoc;
  }

  // --------------------------------------------------------------------------
  // NEW: splitOversizedChunksByTokenCount
  // --------------------------------------------------------------------------
  /**
   * splitOversizedChunksByTokenCount (destructive):
   *   - For each chunk in `groupName`:
   *       - If its token count <= maxTokens, copy as-is into the new group.
   *       - If its token count > maxTokens, split it into multiple sub-chunks
   *         (each of size <= maxTokens).
   *   - Does *not* merge smaller chunks together; only splits bigger ones.
   *   - The resulting chunks are stored under `newGroupName`.
   *
   * @param {number} maxTokens
   * @param {string} [groupName="pages"]
   * @param {string} [encodingName="cl100k_base"]
   * @param {string|null} [newGroupName=null]
   * @returns {Object[]} The array of newly created raw chunk objects.
   */
  splitOversizedChunksByTokenCount(
    maxTokens,
    groupName = "pages",
    encodingName = "cl100k_base",
    newGroupName = null
  ) {
    if (!newGroupName) {
      newGroupName = `${groupName}:splitOversized(${maxTokens},${encodingName})`;
    }
    const enc = this._getEncoder(encodingName);
    const chunkDocs = this.getWrappedChunksForGroup(groupName);

    const outputChunks = [];

    for (const chunkDoc of chunkDocs) {
      const text = chunkDoc.getResolvedContent() || '';
      const tokens = enc.encode(text);

      if (tokens.length <= maxTokens) {
        // Copy chunk unchanged
        outputChunks.push({
          ...chunkDoc.toObject(),  // shallow copy or direct copy
          // Possibly ensure we change the id to reflect the new group name:
          id: `${this.id}/${newGroupName}@${outputChunks.length}`
        });
      } else {
        // Split this one chunk into multiple sub-chunks
        let startIndex = 0;
        while (startIndex < tokens.length) {
          const endIndex = Math.min(startIndex + maxTokens, tokens.length);
          const sliceTokens = tokens.slice(startIndex, endIndex);
          let sliceText = enc.decode(sliceTokens);
          sliceText = _forceString(sliceText);

          outputChunks.push({
            id: `${this.id}/${newGroupName}@${outputChunks.length}`,
            parent: this.id,
            content: sliceText
          });

          startIndex = endIndex; // no overlap here
        }
      }
    }

    // Store the new chunk array destructively
    this.setChunksForGroup(newGroupName, outputChunks);
    return outputChunks;
  }

  /**
   * withSplitOversizedChunksByTokenCount (purely functional):
   *   - Clones this document
   *   - Calls splitOversizedChunksByTokenCount on the clone
   *   - Returns the new doc (the original doc is unchanged).
   */
  withSplitOversizedChunksByTokenCount(
    maxTokens,
    groupName = "pages",
    encodingName = "cl100k_base",
    newGroupName = null
  ) {
    const clonedDocObj = JSON.parse(JSON.stringify(this._doc));
    const newDoc = new JSONDocument(clonedDocObj, this._parentDoc, this._tokenCounter);
    newDoc.splitOversizedChunksByTokenCount(maxTokens, groupName, encodingName, newGroupName);
    return newDoc;
  }

  // --------------------------------------------------------------------------
  // tokenCount
  // --------------------------------------------------------------------------
  tokenCount(encodingName = "cl100k_base") {
    const enc = this._getEncoder(encodingName);
    const text = this.getResolvedContent() || '';
    return enc.encode(text).length;
  }

  // --------------------------------------------------------------------------
  // _getEncoder
  // --------------------------------------------------------------------------
  _getEncoder(encodingName) {
    if (this._tokenCounter && typeof this._tokenCounter.get_encoding === 'function') {
      return this._tokenCounter.get_encoding(encodingName);
    }
    if (!tiktokenLib) {
      throw new Error(
        `No tokenCounter was provided, and "tiktoken" is not available. ` +
        `If running in the browser, you must supply a tokenCounter.`
      );
    }
    return tiktokenLib.get_encoding(encodingName);
  }
}
