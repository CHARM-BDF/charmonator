# JSON Document Object Specification

This document defines the JSON structure used to represent documents (and their parts) in our system. It covers the complete set of fields, key invariants, and processing assumptions that the code enforces. This specification applies both to full documents (for example, those produced from file conversions) and to document “chunks” (subdivisions of a document such as pages, paragraphs, or sentences).

---

## Overview

A **JSON Document Object** is a JSON representation of a piece of content (for example, the full text of a document or a chunk of a document). It is designed to support downstream processing tasks such as summarization, embedding, and conversion. The document object may represent either an entire document or a portion of a document (a “chunk”) and is structured to allow hierarchical composition.

Key points include:

- **Uniqueness:** Every document object has a unique `id` (typically derived from a hash such as SHA‑256).
- **Content Representation:** A document object may contain its full text in the `content` field or refer to a substring of its parent’s content via the `start` and `length` fields.
- **Hierarchy:** Documents may contain child documents (chunks) organized by logical groups (for example, pages) in the `chunks` field.
- **Metadata and Annotations:** Additional information (e.g. extraction confidence, page number, summarization results) is stored in the `metadata` and `annotations` fields.
- **Embeddings:** Optionally, document objects may have an `embeddings` field mapping model names to embedding vectors.

The JSON document object wrapper library (see *lib/json-document.mjs*) also supports helper functions (e.g. `getResolvedContent()`, `mergeChunksByTokenCount()`, `tokenCount()`) that enforce these invariants.

---

## Key Fields and Their Invariants

Each JSON document object is an object with the following keys:

### 1. `id` (string, required)
- **Description:** A unique identifier for the document.
- **Invariant:** Must be a non-empty string. For file‐based documents, this is typically a SHA‑256 hash of the file’s contents (or a compound id for chunks).

### 2. `content` (string, optional)
- **Description:** Contains the full text of the document.
- **Invariant:** If present, it must be a string.  
  **Note:** For a document object representing a *chunk*, `content` may be omitted; in that case, the chunk must specify:
  - A **parent** document (via the `parent` field)
  - The numeric **`start`** offset and **`length`** which specify a substring of the parent’s resolved content.

### 3. `parent` (string, optional)
- **Description:** The `id` of the parent document if this object represents a chunk.
- **Invariant:** If this object is a chunk (i.e. it does not hold full content itself), then the `parent` field must be provided and be a valid string matching an existing document object’s `id`.

### 4. `start` and `length` (integers, optional)
- **Description:** Used only when `content` is not directly provided.  
  - `start`: The starting index (0-based) into the parent’s resolved content.
  - `length`: The number of characters that this chunk represents.
- **Invariant:** If present, both must be nonnegative integers. The sum `start + length` must not exceed the length of the parent’s resolved content.

### 5. `chunks` (object, optional)
- **Description:** A mapping from chunk-group names to an ordered array of child document objects.
- **Invariant:** If present, `chunks` is an object whose keys are strings (for example, `"pages"`, `"paragraphs"`, etc.) and whose values are arrays of JSON document objects. The ordering of the array is significant.
  
  **Note:** At runtime the system wraps these raw chunk objects into helper objects that provide properties such as `previousChunk` and `nextChunk` for navigation. These pointers are not part of the persisted JSON.

### 6. `annotations` (object, optional)
- **Description:** A free-form dictionary for storing processing annotations.
- **Usage:** For example, summarization endpoints will add fields such as `annotations.summary` or, in some cases, per-chunk summaries in `annotations.summary_delta`.
- **Invariant:** If present, must be an object. There is no strict schema enforced here; however, downstream processes expect that if a summary is produced it will be stored in `annotations.summary`.

### 7. `metadata` (object, optional)
- **Description:** A free-form dictionary for metadata about the document.
- **Common Metadata Fields:**
  - `filename` or `originating_filename`: The original file name.
  - `mimetype`: The MIME type of the document (e.g., `"application/pdf"`).
  - `document_sha256`: A hash of the document file.
  - For chunks: `page_number`, `text_extraction_method`, `extraction_confidence`, etc.
- **Invariant:** If present, must be an object. Metadata may be added by file conversion, summarization, or embedding processes.

### 8. `embeddings` (object, optional)
- **Description:** A mapping from model names to numeric arrays representing embedding vectors.
- **Invariant:** When present, `embeddings` is an object where keys are model identifiers and values are arrays of numbers.

### 9. `content_chunk_group` (string, optional)
- **Description:** A directive indicating that this document’s resolved content should be reassembled by concatenating the child chunks in the specified chunk group.
- **Invariant:** If set, then the `getResolvedContent()` method will ignore a missing direct `content` field and instead traverse `chunks[content_chunk_group]` in order to assemble the full content.

---

## Helper Methods and Processing Assumptions

While the JSON document object is defined as above, the following helper functions in our codebase (typically in *lib/json-document.mjs*) impose additional behavior:

- **`getResolvedContent()`**
  - If `content` is present, it is returned.
  - Otherwise, if the document has a parent and valid `start`/`length`, the method returns the appropriate substring from the parent’s resolved content.
  - Otherwise, if `content_chunk_group` is specified, the function will iterate over the corresponding array in `chunks` and concatenate each child’s resolved content.

- **`mergeChunksByTokenCount(maxTokens, …)`**
  - This method concatenates chunks in a specified group (for example, `"pages"`) into larger merged chunks, ensuring that the merged content does not exceed a specified token limit.
  - The merged chunks are then stored under a new chunk group name (which can be derived from the original group name and the max token count).

- **`tokenCount(encodingName)`**
  - Returns the number of tokens in the resolved content according to a given token encoding (e.g., using the `tiktoken` library).

These helper methods assume that the invariants above hold (for example, that if a document is a chunk then its parent, start, and length are set correctly).

---

## Examples

### Example 1: A Full Document Object (from a PDF Conversion)

Below is an example of a document object created from a PDF file. Notice that the top-level document contains a full `content` field (assembled from individual page chunks) and a `chunks` property with a `"pages"` array. Each page chunk includes metadata such as `page_number`, extraction confidence, and a reference to its parent.

```json
{
  "id": "0ab6f8abcdef1234567890",
  "content": "# Full Document\n\n<!-- page boundary -->\n\n<!-- METADATA page_number: 1 -->\nPage 1 text in markdown...\n\n<!-- page boundary -->\n\n<!-- METADATA page_number: 2 -->\nPage 2 text in markdown...",
  "metadata": {
    "mimetype": "application/pdf",
    "document_sha256": "0ab6f8abcdef1234567890",
    "size_bytes": 123456,
    "originating_filename": "myfile.pdf"
  },
  "chunks": {
    "pages": [
      {
        "id": "0ab6f8abcdef1234567890/pages@0",
        "parent": "0ab6f8abcdef1234567890",
        "start": 0,
        "length": 1000,
        "content": "<!-- METADATA page_number: 1 -->\nPage 1 text in markdown...",
        "metadata": {
          "page_number": 1,
          "text_extraction_method": "ocr",
          "extraction_confidence": 0.95,
          "model_name": null,
          "isFirstPage": true
        },
        "annotations": {
          "description": "A short summary of page 1."
        }
      },
      {
        "id": "0ab6f8abcdef1234567890/pages@1",
        "parent": "0ab6f8abcdef1234567890",
        "start": 1000,
        "length": 1100,
        "content": "<!-- METADATA page_number: 2 -->\nPage 2 text in markdown...",
        "metadata": {
          "page_number": 2,
          "text_extraction_method": "ocr",
          "extraction_confidence": 0.92,
          "model_name": null,
          "isFirstPage": false
        }
      }
    ]
  },
  "annotations": {
    "summary": "Overall summary of the document..."
  }
}
```

### Example 2: A Chunk Document Object

This example shows a document object that represents a single chunk (for example, a page or a paragraph). Notice that the `content` field is not provided directly; instead, the chunk specifies `start` and `length` and a `parent` reference. (In practice, the helper method `getResolvedContent()` uses the parent’s full text to extract the chunk’s content.)

```json
{
  "id": "0ab6f8abcdef1234567890/pages@2",
  "parent": "0ab6f8abcdef1234567890",
  "start": 2100,
  "length": 950,
  "metadata": {
    "page_number": 3,
    "text_extraction_method": "ocr",
    "extraction_confidence": 0.88,
    "model_name": "gpt-4o-mini",
    "isFirstPage": false
  },
  "annotations": {
    "description": "A brief summary of page 3."
  }
}
```

---

## Additional Considerations

- **Linking of Chunks:**  
  When a document object’s chunk group is wrapped at runtime (using `getWrappedChunksForGroup()`), the system adds two non-persisted fields to each wrapped chunk:
  - `previousChunk`: Points to the immediately preceding chunk.
  - `nextChunk`: Points to the immediately following chunk.

- **Content Assembly:**  
  If a document object does not have a direct `content` field but has a `content_chunk_group` defined, the resolved content is produced by concatenating the results of `getResolvedContent()` for each child in the corresponding chunk array.

- **Embeddings:**  
  The `embeddings` field is not automatically generated but is populated by dedicated endpoints (such as the document embeddings endpoint). When present, it contains a mapping from a model name to its computed embedding vector.

---

## Summary

This specification defines the structure and invariants for JSON document objects used throughout the system. By following these guidelines, all components (including file conversion, summarization, embedding, and tool-based processing) can consistently generate and manipulate document objects. Please refer to this document when developing new processing functions or extending the API.

```


