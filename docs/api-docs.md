# Charmonator / Charmonizer API Documentation

This document describes the **RESTful endpoints** exposed by **Charmonator** and **Charmonizer**, as well as the underlying JSON structures for transcripts and documents.

---

## Overview of Services

- **Charmonator** handles lower-level LLM interactions (chat, embeddings, tool invocation).  
- **Charmonizer** handles more complex data/document transformations, potentially returning JSON “document objects” with chunk-level structures (pages, sentences, etc.), along with summarization, boundary detection, etc.

### Base URLs

- **Charmonator**:  
  ```
  http://<server>:<port>/<base-url-prefix>/api/charmonator/v1
  ```
- **Charmonizer**:  
  ```
  http://<server>:<port>/<base-url-prefix>/api/charmonizer/v1
  ```
*(Adjust `<server>`, `<port>`, `<base-url-prefix>` to match your deployment.)*

---

## Charmonator Endpoints

### 1. List Available Models

```
GET api/charmonator/v1/models
```

- **Description**: Lists all configured AI models for the server.

- **Response**:
  ```json
  {
    "models": [
      {
        "id": "gpt-4o",
        "name": "GPT-4 (Optimized)",
        "description": "OpenAI GPT-4 with custom settings"
      },
      {
        "id": "claude",
        "name": "Claude",
        "description": "Anthropic Claude model"
      }
    ]
  }
  ```

- **Errors**:
  - 500 if an unexpected error occurs.

---

### 2. Transcript Extension

```
POST api/charmonator/v1/transcript/extension
```

- **Description**: Extends an existing conversation transcript using a specified model. This endpoint returns new messages in the conversation (usually from the assistant, possibly with tool calls/responses).  
- **Uses**: [Transcript JSON Structure](#transcript-json-structure)

#### Request Body (example)

```jsonc
{
  "model": "gpt-4o",
  "system": "You are a helpful assistant.",
  "temperature": 0.7,
  "transcript": {
    "messages": [
      { "role": "user", "content": "Who won the World Cup?" },
      { "role": "assistant", "content": "Argentina in 2022." }
    ]
  },
  "tools": [
    {
      "name": "web_search",
      "description": "Search the web for info",
      "input_schema": {
        "type": "object",
        "properties": { "query": { "type": "string" } }
      }
    }
  ],
  "options": {
    "stream": false,
    "response_format": { "type": "json_object" }
  }
}
```

- **`model`** (string, required): The model ID to use.  
- **`system`** (string, optional): The system or developer instructions.  
- **`temperature`** (number, optional): Sampling temperature.  
- **`transcript`** (object, required): The partial transcript so far.  
- **`tools`** (array, optional): Additional ephemeral tools to register.  
- **`ms_client_request_timeout`** (number, optional): Override configured time limit for downstream HTTP client calls, in milliseconds.  See [configuration.md](configuration.md#top-level-keys) for details.
- **`max_timeout`** (number, optional): Override configured number of attempts for each downstream HTTP client call.  See [configuration.md](configuration.md#top-level-keys) for details.
- **`options`** (object, optional):  
  - **`stream`** (boolean, optional): If `true`, the server may return partial chunks.  
  - **`response_format`** (object, optional): If supported, requests the model output in a specific format (e.g., JSON mode or structured JSON schema).  
    - *Note:* Some models (e.g. certain Anthropic or older local models) may **ignore** `response_format` and emit a warning if they do not support it.

> **Important:** Historically, you could pass `stream` as a top-level boolean. It remains supported for backward compatibility, but it is now recommended to pass both `stream` and `response_format` inside the `options` object.  

#### Response (example)

```json
{
  "messages": [
    { "role": "assistant", "content": "Argentina won in 2022." }
  ]
}
```

- **Errors**:
  - 400 if required fields are missing.
  - 500 on unexpected errors.

*(See [Transcript JSON Structure](#transcript-json-structure) below.)*

---

### 3. Convert Image to Markdown

```
POST api/charmonator/v1/conversion/image
```

- **Description**:  
  - Transcribes or describes an image (data URL or remote URL) into Markdown.  
  - Determines whether it is likely the **first page** of a document.  
  - Optionally generates a short `"description"` of the image contents (1–3 sentences).  
  - Optionally matches tags (provided by the user) in the resulting Markdown text.

- **Request Body**:
  ```jsonc
  {
    "imageUrl": "data:image/png;base64,iVBOR...", // Required
    "preceding_image_url": "data:image/png;base64,iVBOR...", // Optional
    "description": "A scanned tax document",    // Additional context
    "intent": "Extract textual data",
    "graphic_instructions": "Describe diagrams if present",
    "preceding_content": "...",
    "preceding_context": "...",
    "model": "llama-vision-mini",
    "describe": true, // (optional, default true)
    "tags": {         // (optional) map of tagName -> substring
      "footnotes": "Footnote",
      "signature": "Signed by"
    }
  }
  ```
  - **`imageUrl`**: (required) data URL or remote URL for the image.  
  - **`preceding_image_url`**: (optional) helps detect if this is first page.  
  - **`describe`**: (boolean, default = `true`) if set, the response includes a `"description"` field.  
  - **`tags`**: (object, optional) map from tag name → substring. If provided, any matching tag names will be returned in the `"tags"` array if the substring is found in the transcription.

- **Response**:
  ```jsonc
  {
    "markdown": "# Transcribed data\n...",
    "isFirstPage": false,
    "description": "1-3 sentence summary of the image contents.", // only if "describe" = true
    "tags": ["footnotes"] // only if "tags" was provided
  }
  ```
  - **`markdown`**: the transcription in Markdown.  
  - **`isFirstPage`**: boolean indicating if this page is likely the first page of a new document.  
  - **`description`**: present only if `describe` is `true`.  
  - **`tags`**: present only if the user provided `tags`. Contains an array of tag names that matched.

- **Errors**:
  - 400 if `imageUrl` is missing.
  - 500 on internal server errors.

---

### 4. Convert File to Markdown

```
POST api/charmonator/v1/conversion/file
```

- **Description**: Converts supported file types (e.g., `.docx`, `.pptx`, `.pdf`, `.txt`) to plain Markdown in a single shot. May not produce chunk-level detail (unlike the more complex Charmonizer routes).

- **Content-Type**: `multipart/form-data`

- **Request**:
  - `file` = the file to convert.

- **Response**:
  ```json
  {
    "markdownContent": "# Some Document\n..."
  }
  ```

- **Errors**:
  - 400 if no file or if file type is unsupported.
  - 500 on conversion failure.

---

### 5. Generate Embedding

```
POST api/charmonator/v1/embedding
```

- **Description**: Creates an embedding vector for the given text.

- **Request Body**:
  ```jsonc
  {
    "model": "gpt-4o-embedding",
    "text": "This is some text to embed."
  }
  ```
- **Response**:
  ```json
  {
    "embedding": [ 0.123, -0.045, 1.234, ... ]
  }
  ```
- **Notes**:
  - The `model` must refer to a configured model that supports embeddings.

- **Errors**:
  - 400 if required fields are missing.
  - 400 if the specified model does not support embeddings.
  - 500 on unexpected server errors.

---

### 6. Document Operations

These endpoints provide synchronous operations on JSON Document Objects (wrapping, combining, extracting content, and chunk manipulation).

#### 6a. Wrap Content into Document

```
POST api/charmonator/v1/documents
```

- **Description**: Wraps raw content into a valid document object with a generated ID.

- **Request Body**:
  ```json
  {
    "content": "Raw text content to wrap into a document..."
  }
  ```
  - **`content`** (string or object, required): The content to wrap. If an object, it will be JSON-stringified.

- **Response**:
  ```json
  {
    "document": {
      "id": "sha256hash...",
      "content": "Raw text content to wrap into a document..."
    }
  }
  ```
  - **`id`**: SHA-256 hash of the content string.

- **Errors**:
  - 400 if `content` is missing.
  - 500 on unexpected errors.

---

#### 6b. Combine Documents

```
POST api/charmonator/v1/documents/combine
```

- **Description**: Combines multiple documents into a single master document with a chunk group containing the source documents.

- **Request Body**:
  ```json
  {
    "documents": [
      { "id": "doc1", "content": "..." },
      { "id": "doc2", "content": "..." }
    ],
    "master_id": null,
    "group_name": "sources"
  }
  ```
  - **`documents`** (array, required): Array of document objects to combine.
  - **`master_id`** (string, optional): ID for the master document. Auto-generated if null.
  - **`group_name`** (string, optional): Name for the chunk group containing sources. Defaults to `"sources"`.

- **Response**:
  ```json
  {
    "document": {
      "id": "master-doc-id",
      "content_chunk_group": "sources",
      "chunks": {
        "sources": [ /* array of source documents */ ]
      }
    }
  }
  ```

- **Errors**:
  - 400 if `documents` is missing, not an array, or empty.
  - 500 on unexpected errors.

---

#### 6c. Extract Markdown from Document

```
POST api/charmonator/v1/documents/markdown
```

- **Description**: Extracts markdown/text content from a document. If the document has a `content_chunk_group`, content is reassembled from chunks.

- **Request Body**:
  ```json
  {
    "document": { /* doc.json object */ },
    "include_metadata": false
  }
  ```
  - **`document`** (object, required): The document object to extract from.
  - **`include_metadata`** (boolean, optional): If `true`, prepends metadata as HTML comments. Defaults to `false`.

- **Response**:
  ```json
  {
    "markdown": "# Extracted content...\n\n..."
  }
  ```

- **Response with `include_metadata: true`**:
  ```
  <!-- title: My Document -->
  <!-- author: John Doe -->
  # Extracted content...
  ```

- **Errors**:
  - 400 if `document` is missing.
  - 500 on unexpected errors.

---

#### 6d. Extract Summary from Document

```
POST api/charmonator/v1/documents/summary
```

- **Description**: Extracts a summary annotation from a document. Handles delta-fold format (arrays of `{"delta": "..."}` strings) by extracting and joining the delta values.

- **Request Body**:
  ```json
  {
    "document": { /* doc.json object */ },
    "field": "summary",
    "separator": "\n\n--\n\n"
  }
  ```
  - **`document`** (object, required): The document object.
  - **`field`** (string, optional): The annotation field to extract. Defaults to `"summary"`.
  - **`separator`** (string, optional): Separator for joining delta-fold arrays. Defaults to `"\n\n--\n\n"`.

- **Response** (simple string summary):
  ```json
  {
    "summary": "The extracted summary text..."
  }
  ```

- **Response** (delta-fold array summary):
  ```json
  {
    "summary": "First delta content...\n\n--\n\nSecond delta content...\n\n--\n\nThird delta content..."
  }
  ```

- **Response** (no summary found):
  ```json
  {
    "summary": null,
    "message": "No summary found in annotations"
  }
  ```

- **Errors**:
  - 400 if `document` is missing.
  - 500 on unexpected errors.

---

#### 6e. Merge Chunks by Token Count

```
POST api/charmonator/v1/documents/chunks/merge
```

- **Description**: Merges small chunks into larger ones up to a maximum token count. Creates a new chunk group with the merged results.

- **Request Body**:
  ```json
  {
    "document": { /* doc.json object */ },
    "max_tokens": 2048,
    "encoding": "cl100k_base",
    "chunk_group": "pages",
    "new_group_name": null,
    "overlap_tokens": 0
  }
  ```
  - **`document`** (object, required): The document object with chunks to merge.
  - **`max_tokens`** (number, required): Maximum tokens per merged chunk.
  - **`encoding`** (string, optional): Tiktoken encoding name. Defaults to `"cl100k_base"`.
  - **`chunk_group`** (string, optional): Source chunk group to merge. Defaults to `"pages"`.
  - **`new_group_name`** (string, optional): Name for the new chunk group. Auto-generated if null (e.g., `"pages:merged(2048,cl100k_base)"`).
  - **`overlap_tokens`** (number, optional): Number of tokens to overlap between chunks. Defaults to `0`.

- **Response**:
  ```json
  {
    "document": { /* modified doc.json with new chunk group */ },
    "old_chunk_count": 100,
    "new_chunk_count": 15,
    "new_group_name": "pages:merged(2048,cl100k_base)"
  }
  ```

- **Errors**:
  - 400 if `document` is missing or `max_tokens` is invalid.
  - 500 on unexpected errors.

---

#### 6f. Extract Chunk Annotations

```
POST api/charmonator/v1/documents/chunks/annotations
```

- **Description**: Extracts annotations from each chunk in a specified chunk group. Useful for retrieving per-chunk summaries or other annotations.

- **Request Body**:
  ```json
  {
    "document": { /* doc.json object */ },
    "chunk_group": "pages",
    "target": "summary",
    "include_metadata": false
  }
  ```
  - **`document`** (object, required): The document object.
  - **`chunk_group`** (string, required): The chunk group to extract annotations from.
  - **`target`** (string, optional): The annotation field to extract from each chunk. Defaults to `"summary"`.
  - **`include_metadata`** (boolean, optional): If `true`, includes chunk metadata in the response. Defaults to `false`.

- **Response**:
  ```json
  {
    "annotations": [
      {
        "annotation": "Summary for chunk 1..."
      },
      {
        "annotation": "Summary for chunk 2..."
      },
      {
        "annotation": null
      }
    ]
  }
  ```

- **Response with `include_metadata: true`**:
  ```json
  {
    "annotations": [
      {
        "metadata": { "page_number": 1 },
        "annotation": "Summary for chunk 1..."
      },
      {
        "metadata": { "page_number": 2 },
        "annotation": "Summary for chunk 2..."
      }
    ]
  }
  ```

- **Errors**:
  - 400 if `document` or `chunk_group` is missing.
  - 400 if the specified `chunk_group` does not exist in the document.
  - 500 on unexpected errors.

---

## Charmonizer Endpoints

### 7. Convert Document (Long-Running with Page Tracking)

```
POST api/charmonizer/v1/conversions/documents
```

- **Description**: Converts/transcribes an uploaded PDF into a [JSON Document Object](#document-object-specification) with chunk-based structure (e.g. pages). This is a **long-running** job that returns a `job_id` so you can poll until done.  
- **Currently** supports **PDF**.  
- **Content-Type**: `multipart/form-data` or JSON with base64.

#### Request Body

- **`file`** (multipart) **OR** `pdf_dataurl` (base64) — the PDF data.  
- **`model`** (string, optional) — fallback LLM if OCR confidence is low or if boundary detection is needed.  
- **`ocr_threshold`** (float, optional) — threshold for deciding fallback (default: `0.7`).  
- **`scrutinize`** (string, optional) - Specify a method to scrutinize the image text.  (default: "none")
- **`page_numbering`** (string, optional) — `"true"` or `"false"` (default: `"true"`)  
- **`description`, `intent`, `graphic_instructions`** (optional) — context strings for fallback model.  
- **`detect_document_boundaries`** (string, optional) — `"true"` or `"false"` (default: `"false"`)  
- **`continue_on_failure`** (string, optional) — `"true"` or `"false"` (default: `"false"`) — when enabled, individual page failures (e.g., content filtering violations) create error placeholder pages rather than failing the entire job  

#### Immediate Response

```json
{ "job_id": "some-uuid" }
```

#### Poll Job Status

```
GET api/charmonizer/v1/conversions/documents/{jobId}
```

**Response** (example):
```json
{
  "job_id": "3f8c0edf-bb80-4c4f-a837-915d1a70ec75",
  "status": "processing",
  "error": null,
  "createdAt": 1676677712765,
  "pages_total": 10,
  "pages_converted": 3
}
```
- `status` can be `"pending"`, `"processing"`, `"complete"`, or `"error"`.  
- `pages_total` is the total pages recognized.  
- `pages_converted` is how many pages have been processed so far.

#### Poll Final Result

```
GET api/charmonizer/v1/conversions/documents/{jobId}/result
```
- If `pending`/`processing`, returns **202** + partial status.
- If `error`, returns **500** + an error message.
- If `complete`, returns the final [Document Object](#document-object-specification).

**Example** final doc object:
```json5
{
  "id": "abcdef1234...sha256",
  "content": "# Full Document\n(Combined text from all pages...)",
  "metadata": {
    "mimetype": "application/pdf",
    "document_sha256": "abcdef1234...",
    "size_bytes": 12345,
    "originating_filename": "myfile.pdf",
    // Optional fields when continue_on_failure=true and some pages failed:
    // "transcription_status": "partial",
    // "pages_failed": 2,
    // "pages_successful": 8,
    // "continue_on_failure_used": true
  },
  "chunks": {
    "pages": [
      {
        "id": "abcdef1234.../pages@0",
        "parent": "abcdef1234...",
        "start": 0,
        "length": 1000,
        "content": "# Page 1 text in markdown...",
        "metadata": {
          "page_number": 1,
          "text_extraction_method": "ocr",
          "extraction_confidence": 0.95,
          "model_name": null,
          "isFirstPage": true
        },
        "annotations": {
          "description": "A short summary of what is on this page"
        }
      },
      // Example of a failed page when continue_on_failure=true:
      // {
      //   "id": "abcdef1234.../pages@2",
      //   "parent": "abcdef1234...",
      //   "start": 2000,
      //   "length": 600,
      //   "content": "<!-- TRANSCRIPTION FAILURE -->\n# Transcription Failed\n...",
      //   "metadata": {
      //     "page_number": 3,
      //     "text_extraction_method": "error_placeholder",
      //     "extraction_confidence": 0,
      //     "transcription_failed": true,
      //     "error_type": "content_filter_violation",
      //     "error_message": "Content was filtered due to policy violations"
      //   }
      // }
      // ...
    ]
  }
}
```
- If `describe=true`, each page chunk may include `annotations.description`.  
- If `tags` were provided and a substring matched in the text, `metadata.tags` includes those tag names.

#### Cancel or Delete a Job

```
DELETE api/charmonizer/v1/conversions/documents/{jobId}
```
- Removes the job (and any cached data) from the server.

- **Errors**:
  - 400 if file missing/unsupported
  - 500 on internal errors

---

### 8. Summarize a Document (Long-Running)

```
POST api/charmonizer/v1/summaries
```

- **Description**: Summarizes a [Document Object](#document-object-specification) in either a single pass or chunk-by-chunk. Returns a `job_id` to poll.

- **Methods**: **`"full"`, `"map"`, `"fold"`, `"delta-fold"`, `"map-merge"`, or `"merge"`**.
  - `"full"` = single pass on the entire doc
  - `"map"` = summarize each chunk individually (optionally with some context from before/after each chunk) *(supports budget constraints)*
  - `"fold"` = iterative accumulation *(supports budget constraints)*
  - `"delta-fold"` = iterative partial accumulation
  - `"map-merge"` = first summarize each chunk individually, then iteratively merge those chunk-level summaries
  - **`"merge"`** = merges **pre-existing** chunk-level summaries into a single top-level summary; assumes each chunk already has a summary in `annotations[annotation_field]`.

- **Budgeted Summarization** *(map and fold methods)*:
  - When `tokens_budget` is specified, the system dynamically allocates a per-chunk token budget.
  - For each chunk, the remaining budget is divided by remaining chunks: `floor(remaining_tokens / remaining_chunks)`.
  - The system converts token limits to word limits (models follow word limits better) and adds explicit constraints to prompts.
  - A `SmoothedRatioEstimator` learns the actual words-to-tokens ratio online, improving estimates as chunks are processed.
  - Budget statistics are stored in `{chunk_group}_stats` for observability.
  - Typical margin of error is plus or minus one chunk worth of tokens.
  - Actual margin of error is prompt-dependent and must be assessed and guarded by caller if needed.

- **`merge_mode`** (string, optional) – **applies to `"merge"` and `"map-merge"`**:
  - `"left-to-right"` (default) – merges summaries in a simple linear pass  
  - `"hierarchical"` – merges summaries in pairs (like merge-sort), potentially producing more balanced merges

- **JSON-Structured Summaries**: Optionally specify `json_schema` to enforce a JSON format.

#### Request Body

```jsonc
{
  "document": { /* The doc object */ },
  "model": "gpt-4o",
  "method": "merge",          // or "full", "map", "fold", "delta-fold", "map-merge"
  "merge_mode": "hierarchical", // optional, default is "left-to-right" if omitted
  "chunk_group": "pages",     // required if method != "full"
  "context_chunks_before": 1,
  "context_chunks_after": 2,
  "guidance": "Use bullet points only.",
  "temperature": 0.7,

  // optional JSON schema for structured output
  "json_schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "summary_points": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["title", "summary_points"]
  },

  // optional, controls how "delta" merges with existing summary in "delta-fold"
  "json_sum": "append",

  // optional seed for fold/delta-fold
  "initial_summary": "Some starting content...",

  // optional fields for storing the result in custom annotation keys:
  "annotation_field": "summary",
  "annotation_field_delta": "summary_delta",

  // For "map-merge" or "merge" only
  "merge_summaries_guidance": "Explain how to combine partial summaries, preserving all points.",

  // Budget constraints (supported for "map" and "fold" methods)
  "tokens_budget": 1000                  // optional, maximum tokens allowed for final summary
}
```

**Example: Budgeted Map Summarization**

```jsonc
{
  "document": { /* 10-page medical case document */ },
  "method": "map",
  "chunk_group": "pages",
  "model": "gpt-4o-mini",
  "guidance": "Provide concise clinical summaries focusing on key diagnostic findings.",
  "temperature": 0.3,
  "tokens_budget": 500,                  // Limit entire summary to 500 tokens, +- one chunk
  "annotation_field": "clinical_summary"
}
```

- **`document`**: The doc object to summarize.  
- **`method`**: `"full"`, `"map"`, `"fold"`, `"delta-fold"`, `"map-merge"`, or `"merge"`.  
- **`merge_mode`**: (optional) `"left-to-right"` or `"hierarchical"` — how to merge chunk-level summaries for `"merge"`/`"map-merge"`. Defaults to `"left-to-right"`.  
- **`chunk_group`**: Which chunk group to operate on when method != `"full"`.  
- **`context_chunks_before`**/**`context_chunks_after`**: How many chunks to pass in as context.  
- **`model`**: LLM to use.  
- **`guidance`**: Additional user instructions for summarizing.  
- **`temperature`**: LLM sampling temperature (float).  
- **`json_schema`**: If given, output is forced to conform to that schema.  
- **`json_sum`**: For `"delta-fold"`, how new deltas combine with the existing summary (usually `"append"`).  
- **`initial_summary`**: For `"fold"` / `"delta-fold"`, seeds the accumulation.  
- **`annotation_field`**: The doc-level or chunk-level annotations key where the summary is stored (default: `"summary"`).  
- **`annotation_field_delta`**: For `"delta-fold"`, the chunk-level key for each partial "delta" (default: `"summary_delta"`).
- **`merge_summaries_guidance`**: (string) used by `"map-merge"` or `"merge"`, providing instructions on how to combine partial summaries.
- **`tokens_budget`**: (number, optional) Maximum tokens allowed for the final summary. Supported for `"map"` and `"fold"` methods.

#### Immediate Response

```json
{ "job_id": "some-uuid" }
```

#### Polling Job Status

```
GET api/charmonizer/v1/summaries/{job_id}
```

**Response** (example):
```json
{
  "status": "processing",
  "chunks_total": 5,
  "chunks_completed": 2
}
```
- **`status`**: `"pending"`, `"processing"`, `"complete"`, or `"error"`.  
- **`chunks_total`**: The total number of chunks or steps to process.  
- **`chunks_completed`**: How many chunks or steps are finished so far.

#### Retrieving Final Result

```
GET api/charmonizer/v1/summaries/{job_id}/result
```
- If still `pending`/`processing`: HTTP 202 + partial status  
- If `error`: HTTP 500 + error message  
- If `complete`: returns the final doc object with the summary stored in the annotation fields specified.

**Example** final doc object:

```jsonc
{
  "id": "mydoc-sha256",
  "content": "...",
  "annotations": {
    "summary": "High-level summary from 'full', 'fold', 'merge', or the final merged summary if 'map-merge'."
  },
  "chunks": {
    "pages": [
      {
        "id": "mydoc-sha256/pages@0",
        "content": "...",
        "annotations": {
          "summary": "Chunk-level summary..."
        }
      }
    ]
  }
}
```
*(If you requested a `json_schema`, then the `summary` might be structured JSON. If method = `delta-fold`, then `annotations.summary` could be an **array** of deltas, and each chunk’s partial summary is in `annotations.summary_delta`. For `map-merge`, the final top-level summary is stored in `annotations.summary`, while each chunk also has a partial summary. For `merge`, chunk summaries must already exist, and the endpoint simply merges them into a single doc-level summary, optionally controlled by `merge_mode`.)*

---

### 9. Compute Embeddings for a Document (Long-Running)

```
POST api/charmonizer/v1/embeddings
```

- **Description**: Computes embeddings for all chunks in a specified group (usually `"pages"`). Returns a `job_id` to poll for completion.

#### Request Body

```jsonc
{
  "document": { ... },
  "model": "my-embedding-model",
  "chunk_group": "pages"
}
```

- **`document`**: A [Document Object](#document-object-specification).  
- **`model`**: Embedding model name.  
- **`chunk_group`**: Which chunk group to embed (e.g. `"pages"`).

#### Immediate Response

```json
{ "job_id": "some-uuid" }
```

#### Poll Job Status

```
GET api/charmonizer/v1/embeddings/{jobId}
```
**Response** (example):
```json
{
  "status": "processing",
  "chunks_total": 5,
  "chunks_completed": 2,
  "error": null
}
```

#### Poll Final Result

```
GET api/charmonizer/v1/embeddings/{jobId}/result
```
- If `pending`/`processing`, returns **202** + partial status.  
- If `error`, returns **500** with an error.  
- If `complete`, returns the final doc object with an `embeddings` field in each chunk.

**Example**:

```json5
{
  "id": "mydoc-sha256",
  "content": "...",
  "chunks": {
    "pages": [
      {
        "id": "mydoc-sha256/pages@0",
        "content": "...",
        "embeddings": {
          "my-embedding-model": [0.0123, 0.0456, -0.789, ...]
        }
      }
    ]
  }
}
```

---

#### Cancel or Delete a Job

```
DELETE api/charmonizer/v1/embeddings/{jobId}
```
- Removes the job (and any data) from the server.  
- Response: `{ "success": true }`

---

### 10. Document Chunkings (Long-Running)

```
POST api/charmonizer/v1/chunkings
```
- **Description**: Splits or merges existing chunks in a [Document Object](#document-object-specification), returning a `job_id` to poll until the chunking operation is complete.  
- **Currently** supports a single strategy: `"merge_and_split"`.  
- **Content-Type**: `application/json`.

#### Request Body

```jsonc
{
  "document": { /* The doc object */ },
  "strategy": "merge_and_split",
  "chunk_size": 1000,
  "chunk_group": "pages"
}
```

- **`document`** (object, required): The [Document Object](#document-object-specification) you want to re-chunk.
- **`strategy`** (string, required): Currently only `"merge_and_split"`.
- **`chunk_size`** (number, required for `merge_and_split`): Maximum token count for each new chunk.
- **`chunk_group`** (string, optional): The existing chunk group to read from. Defaults to `"all"` if not provided.

#### Immediate Response

```json
{
  "job_id": "some-uuid",
  "status": "pending"
}
```

- The `status` will quickly move to `"in_progress"` once processing begins.

#### Poll Job Status

```
GET api/charmonizer/v1/chunkings/{job_id}
```

**Response** (example):
```json
{
  "job_id": "some-uuid",
  "status": "in_progress",
  "progress": 35,
  "error": null
}
```
- **`status`** can be `"pending"`, `"in_progress"`, `"complete"`, or `"error"`.
- **`progress`**: integer 0–100 indicating approximate progress.
- **`error`**: present if `status` is `"error"`.

#### Poll Final Result

```
GET api/charmonizer/v1/chunkings/{job_id}/result
```

- If `status` is still `"pending"` or `"in_progress"`, returns **409** with `{"error":"Job not complete yet"}`.
- If `status` is `"error"`, returns **409** with `{"status":"error","error":"..."}`.
- If `status` is `"complete"`, returns:

```json
{
  "job_id": "some-uuid",
  "chunks": [
    {
      "chunk_index": 1,
      "chunk_data": {
        "title": "Document (part 1)",
        "body": "Text for chunk 1..."
      }
    },
    {
      "chunk_index": 2,
      "chunk_data": {
        "title": "Document (part 2)",
        "body": "Text for chunk 2..."
      }
    }
    // ...
  ]
}
```

- **`chunks`** is an array of the newly created chunks. Each entry has:
  - **`chunk_index`** (number): 1-based index of this chunk.
  - **`chunk_data`** (object): Contains a `title` and `body` string for the chunk.

*(Currently, the result is returned in a simplified array form rather than a full [Document Object](#document-object-specification).)*

---

## Error Handling

All endpoints produce appropriate HTTP status codes on errors:

- **400** if required fields are missing or invalid  
- **404** if a resource/job is not found  
- **500** for unexpected server errors  

The response typically:
```json
{ "error": "Error message" }
```

---

## Transcript JSON Structure

Endpoints like `api/charmonator/v1/transcript/extension` expect or return a **Transcript JSON** format.

### Overview

```json
{
  "messages": [
    // each element is a message object
  ]
}
```
where **`messages`** is an array in chronological order.

### Message Objects

```jsonc
{
  "role": "user" | "assistant" | "system" | "developer" | "tool_call" | "tool_response",
  "content": "... or an array of text/attachments ..."
}
```
- For `tool_call` or `tool_response`, `content` may contain special objects describing calls/responses.

See the server’s code or additional docs for usage examples.

---

## Document Object Specification

Many Charmonizer endpoints (like `/conversions/documents`, `/summaries`, `/embeddings`) use a **JSON Document Object** to represent content in chunked form for analysis, summarization, or embedding.

### Key Fields

1. **`id`** (string, required)  
   - A unique ID (e.g. file’s SHA-256).
2. **`content`** (string, optional)  
   - Full Markdown text for this doc.  
3. **`parent`** (string, optional)  
   - The `id` of a parent doc if this is a chunk.  
4. **`start`** (integer, optional), **`length`** (integer, optional)  
   - If referencing a parent’s substring.  
5. **`chunks`** (object, optional)  
   - A map from chunk-group-name (like `"pages"`) to an array of child objects (which are also doc objects).  
6. **`annotations`** (object, optional)  
   - A free-form dictionary of annotations about the doc/chunk.  
7. **`metadata`** (object, optional)  
   - A free-form dictionary of metadata about the doc/chunk (e.g. `filename`, `page_number`, `tags`, etc.).  
8. **`embeddings`** (object, optional)  
   - A map from model-name → numeric array.

### Example

```json5
{
  "id": "0ab6f8... (sha256)",
  "content": "...the entire doc in markdown...",
  "metadata": {
    "filename": "mydoc.pdf"
  },
  "chunks": {
    "pages": [
      {
        "id": "0ab6f8abcdef1234567890/pages@0",
        "content": "# Page 1 text...",
        "metadata": {
          "page_number": 1,
          "tags": ["footnotes"]
        },
        "annotations": {
          "description": "1-3 sentences summarizing the page"
        }
      }
    ]
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
