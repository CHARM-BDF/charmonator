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
GET /models
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

### 2. Extend Transcript

```
POST /chat/extend_transcript
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
  ]
}
```

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
POST /conversion/image
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
POST /conversion/file
```

- **Description**: Converts supported file types (e.g., `.docx`, `.pdf`, `.txt`) to plain Markdown in a single shot. May not produce chunk-level detail (unlike the more complex Charmonizer routes).

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
POST /embedding
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

## Charmonizer Endpoints

### 6. Convert Document (Long-Running with Page Tracking)

```
POST /conversions/documents
```

- **Description**: Converts/transcribes an uploaded PDF into a [JSON Document Object](#document-object-specification) with chunk-based structure (e.g. pages). This is a **long-running** job that returns a `job_id` so you can poll until done.  
- **Currently** supports **PDF**.  
- **Content-Type**: `multipart/form-data` or JSON with base64.

#### Request Body

- **`file`** (multipart) **OR** `pdf_dataurl` (base64) — the PDF data.  
- **`model`** (string, optional) — fallback LLM if OCR confidence is low or if boundary detection is needed.  
- **`ocr_threshold`** (float, optional) — threshold for deciding fallback (default: `0.7`).  
- **`page_numbering`** (string, optional) — `"true"` or `"false"` (default: `"true"`)  
- **`description`, `intent`, `graphic_instructions`** (optional) — context strings for fallback model.  
- **`detect_document_boundaries`** (string, optional) — `"true"` or `"false"` (default: `"false"`)  

#### Immediate Response

```json
{ "job_id": "some-uuid" }
```

#### Poll Job Status

```
GET /conversions/documents/{jobId}
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
GET /conversions/documents/{jobId}/result
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
    "originating_filename": "myfile.pdf"
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
          "isFirstPage": true,
          "tags": ["footnotes"] // example if tags matched
        },
        "annotations": {
          "description": "A short summary of what is on this page"
        }
      },
      // ...
    ]
  }
}
```
- If `describe=true`, each page chunk may include `annotations.description`.  
- If `tags` were provided and a substring matched in the text, `metadata.tags` includes those tag names.

#### Cancel or Delete a Job

```
DELETE /conversions/documents/{jobId}
```
- Removes the job (and any cached data) from the server.

- **Errors**:
  - 400 if file missing/unsupported
  - 500 on internal errors

---

### 7. Summarize a Document (Long-Running)

```
POST /summaries
```

- **Description**: Summarizes a [Document Object](#document-object-specification) in either a single pass or chunk-by-chunk. Returns a `job_id` to poll.

- **Methods**: **`"full"`, `"map"`, `"fold"`, or `"delta-fold"`**.
  - `"full"` = single pass on the entire doc
  - `"map"` = summarize each chunk individually (optionally with some context from before/after each chunk)
  - `"fold"` = iterative accumulation
  - `"delta-fold"` = iterative partial accumulation

- **JSON-Structured Summaries**: Optionally specify `json_schema` to enforce a JSON format.

#### Request Body

```jsonc
{
  "document": { /* The doc object */ },
  "model": "gpt-4o",
  "method": "fold",            // or "full", "map", "delta-fold"
  "chunk_group": "pages",      // required if method != "full"
  "context_chunks_before": 1,  // optional
  "context_chunks_after": 2,   // optional
  "guidance": "Use bullet points only.", // optional instructions
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
  "json_sum": "append",  // default is "append"

  // NEW (Optional) - seeds the accumulation for fold/delta-fold
  // For "fold", can be text or JSON; for "delta-fold", typically an array of "delta" entries
  "initial_summary": "This is the starting summary so far..."
}
```

- **`document`**: The doc object to summarize.  
- **`method`**: `"full"`, `"map"`, `"fold"`, or `"delta-fold"`.  
- **`chunk_group`**: Which chunk group (like `"pages"`) to operate on when method != `"full"`.  
- **`context_chunks_before`**/**`context_chunks_after`**: How many chunks to pass in as context.  
- **`model`**: LLM to use.  
- **`guidance`**: Additional user instructions.  
- **`temperature`**: LLM temperature (float).  
- **`json_schema`**: If given, output is forced to conform to that schema.  
- **`json_sum`**: For `"delta-fold"`, how new deltas combine with the existing summary (usually `"append"`).  
- **`initial_summary`**: *Optional*—If you want to *seed* the accumulated summary for `"fold"` or `"delta-fold"` with an existing summary.  
  - For **fold**, it can be any string/object you want to fold into subsequent chunks.  
  - For **delta-fold**, it is usually an **array**, so you can continue appending new deltas to that array.

#### Immediate Response

```json
{ "job_id": "some-uuid" }
```

#### Polling Job Status

```
GET /summaries/{job_id}
```

**Response** (example):
```json
{
  "status": "processing",
  "chunks_total": 3,
  "chunks_completed": 1
}
```
- **`status`**: `"pending"`, `"processing"`, `"complete"`, or `"error"`.  

#### Retrieving Final Result

```
GET /summaries/{job_id}/result
```
- If still `pending`/`processing`: HTTP 202 + partial status  
- If `error`: HTTP 500 + error message  
- If `complete`: returns the final doc object with summaries stored in `annotations.summary`.

**Example** final doc object:

```jsonc
{
  "id": "mydoc-sha256",
  "content": "...",
  "annotations": {
    "summary": "High-level summary from 'full' or 'fold'"
  },
  "chunks": {
    "pages": [
      {
        "id": "mydoc-sha256/pages@0",
        "content": "...",
        "annotations": {
          "summary": "Page 1 summary..."
        }
      }
    ]
  }
}
```
*(If you requested a `json_schema`, then the `summary` might be structured JSON. If method = `delta-fold`, then `annotations.summary` could be an **array** of delta items.)*

---

### 8. Compute Embeddings for a Document (Long-Running)

```
POST /embeddings
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
GET /embeddings/{jobId}
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
GET /embeddings/{jobId}/result
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
DELETE /embeddings/{jobId}
```
- Removes the job (and any data) from the server.  
- Response: `{ "success": true }`

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

Endpoints like `/chat/extend_transcript` expect or return a **Transcript JSON** format. 

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
        "id": "0ab6f8.../pages@0",
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
