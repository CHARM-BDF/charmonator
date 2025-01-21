/**
 * JSONDocument.js
 *
 * A convenient wrapper around a "document object," following the specification in document.md.
 * 
 * Key points:
 *  1) No external resolver logic; we assume if a chunk references a parent, we pass it as the
 *     second constructor argument.
 *  2) getWrappedChunksForGroup(groupName): returns an array of JSONDocument objects, each
 *     referencing `this` as its parentDoc. We also populate `chunk.previousChunk` and
 *     `chunk.nextChunk` so you can easily navigate in sequence.
 *  3) If the doc has direct `content`, that is used; otherwise, if it references a parent
 *     doc (with .start & .length), we substring from `parentDoc.content`.
 *  4) If `content_chunk_group` is set, we reassemble that group in getResolvedContent().
 */

export class JSONDocument {
  /**
   * @param {Object} docObj - Raw JSON data for this doc (see document.md).
   * @param {JSONDocument|null} parentDoc - If this chunk references a parent doc, pass it here.
   */
  constructor(docObj, parentDoc = null) {
    if (typeof docObj !== 'object' || docObj === null) {
      throw new Error('JSONDocument requires a non-null object.');
    }
    this._doc = docObj;
    this._parentDoc = parentDoc; 

    // These fields are for convenience if this doc is used as a "chunk."
    // They are not serialized into the underlying JSON:
    this.nextChunk = null;
    this.previousChunk = null;
  }

  // --------------------------------------------------------------------------
  // Basic getters/setters for top-level fields
  // --------------------------------------------------------------------------

  /** The document's unique ID */
  get id() {
    return this._doc.id;
  }
  set id(newId) {
    this._doc.id = newId;
  }

  /** Direct `content` if present. */
  get content() {
    return this._doc.content;
  }
  set content(newContent) {
    this._doc.content = newContent;
  }

  /** The string ID of this doc’s parent (if any). */
  get parentId() {
    return this._doc.parent;
  }
  set parentId(newParentId) {
    this._doc.parent = newParentId;
  }

  /** The `start` offset (for substring references). */
  get start() {
    return this._doc.start;
  }
  set start(val) {
    this._doc.start = val;
  }

  /** The `length` (for substring references). */
  get length() {
    return this._doc.length;
  }
  set length(val) {
    this._doc.length = val;
  }

  /** The content_chunk_group name, if any. */
  get contentChunkGroup() {
    return this._doc.content_chunk_group;
  }
  set contentChunkGroup(groupName) {
    this._doc.content_chunk_group = groupName;
  }

  /** Access the entire `chunks` object, e.g. { pages: [...], sentences: [...], ... }. */
  get chunks() {
    if (!this._doc.chunks) {
      this._doc.chunks = {};
    }
    return this._doc.chunks;
  }

  /**
   * Return the raw chunk array for a given groupName (e.g. "pages"),
   * or an empty array if that group doesn’t exist.
   */
  getChunksForGroup(groupName) {
    return this._doc.chunks?.[groupName] || [];
  }

  /**
   * Return an array of chunk objects **wrapped** as JSONDocument.
   * Each child’s `_parentDoc` is this current doc,
   * and we populate .previousChunk / .nextChunk for easy navigation.
   */
  getWrappedChunksForGroup(groupName) {
    const rawArray = this.getChunksForGroup(groupName);
    // Map each raw chunk object to a new JSONDocument instance.
    const wrappers = rawArray.map(chunkObj => new JSONDocument(chunkObj, this));
    
    // Link them in sequence so you can do chunk.previousChunk / chunk.nextChunk
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

  /**
   * Replace the chunk array for a given group with a new raw array.
   */
  setChunksForGroup(groupName, chunkArray) {
    if (!this._doc.chunks) {
      this._doc.chunks = {};
    }
    this._doc.chunks[groupName] = chunkArray;
  }

  /**
   * Add (push) a new raw chunk object into a group.
   */
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
  // Methods to resolve content
  // --------------------------------------------------------------------------

  /**
   * getResolvedContent():
   *  1) If `this._doc.content` is a string, return it.
   *  2) If we have a parentDoc and start/length are valid, substring from parentDoc.content.
   *  3) If we have `content_chunk_group`, reassemble from those children.
   *  4) Else return ''.
   */
  getResolvedContent() {
    // 1) If direct content is present, just return it
    if (typeof this._doc.content === 'string') {
      return this._doc.content;
    }

    // 2) If there's a parent doc and valid start/length
    if (this._parentDoc && Number.isInteger(this._doc.start) && Number.isInteger(this._doc.length)) {
      const parentFullText = this._parentDoc.getResolvedContent();
      const startIdx = this._doc.start;
      const endIdx = startIdx + this._doc.length;
      if (startIdx < 0 || endIdx > parentFullText.length) {
        throw new Error(`Invalid substring [${startIdx},${endIdx}) in parent doc content length=${parentFullText.length}`);
      }
      return parentFullText.slice(startIdx, endIdx);
    }

    // 3) If we have a content_chunk_group, reassemble from that group
    if (this.contentChunkGroup) {
      const groupName = this.contentChunkGroup;
      const rawChunks = this.getChunksForGroup(groupName);
      // If desired, you could sort by start: rawChunks.sort((a,b)=>(a.start||0)-(b.start||0))

      let combined = '';
      for (const chunkObj of rawChunks) {
        const childDoc = new JSONDocument(chunkObj, this);
        combined += childDoc.getResolvedContent();
      }
      return combined;
    }

    // 4) Fallback
    return '';
  }

  // --------------------------------------------------------------------------
  // JSON / raw object access
  // --------------------------------------------------------------------------

  /** Return the raw underlying JSON object (useful for serialization). */
  toObject() {
    return this._doc;
  }

  /** So that JSON.stringify(thisDoc) returns the raw object. */
  toJSON() {
    return this._doc;
  }
}
