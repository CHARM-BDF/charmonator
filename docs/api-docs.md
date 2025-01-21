# Charmonator / Charmonizer API Documentation

This document integrates three previously separate files (`api-docs.md`, `document.md`, `transcript.md`) into a single reference. The first sections describe the RESTful endpoints exposed by **Charmonator** and **Charmonizer**. Later sections define the **Transcript JSON Structure** (used for conversation transcripts) and the **Document Object Specification** (used for chunk-based document representations).

---

## Overview of Services

- **Charmonator** handles lower-level LLM interactions (chat, embeddings, tool invocation).
- **Charmonizer** handles more complex data/document transformations, potentially returning JSON “document objects” with chunk-level structures (pages, sentences, etc.).

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
- **Description**: Extends an existing conversation transcript using the specified model. This endpoint returns new messages in the conversation (usually from the assistant, and possibly tool calls and responses).  
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

*(For a full definition of `transcript` and how messages, tool calls, and attachments are structured, see the [Transcript JSON Structure](#transcript-json-structure) section.)*

---

### 3. Convert Image to Markdown

```
POST /convert/image_to_markdown
```
- **Description**: Transcribes/describes an image (data URL or remote URL) into Markdown text.
- **Request Body**:
  ```jsonc
  {
    "imageUrl": "data:image/png;base64,iVBOR...",
    "description": "A scanned tax document",
    "intent": "Extract textual data",
    "graphic_instructions": "Describe diagrams if present",
    "preceding_content": "...",
    "preceding_context": "...",
    "model": "llama-vision-mini"
  }
  ```
- **Response**:
  ```json
  {
    "markdown": "# Transcribed data\n..."
  }
  ```
- **Errors**:
  - 400 if `imageUrl` is missing.
  - 500 on internal errors.

---

### 4. Convert File to Markdown (Quick Approach)

```
POST /convert
```
- **Description**: Converts supported file types (e.g., `.docx`, `.pdf`) to Markdown. (A simpler approach; may not produce chunk-structured output.)
- **Content-Type**: `multipart/form-data`
- **Request**:
  - `file` (file) = file to convert.
- **Response**:
  ```json
  {
    "markdownContent": "# Some Document\n..."
  }
  ```
- **Errors**:
  - 400 if no file is provided or unsupported file type.
  - 500 on conversion failure.

---


## Charmonizer Endpoints

### 6. Convert Document

```
POST /convert/document
```
- **Description**: Converts/transcribes an uploaded document (e.g. PDF) into a [JSON Document Object](#document-object-specification) with chunk-based structure (pages, etc.).  
- **Note**: This is a **long-running** endpoint returning a `job_id`. Currently only PDFs are supported, but the design is general for any type of document.

**Content-Type**: `multipart/form-data` or JSON with base64.  

#### Request Body (typical)

- `file` (file) or `pdf_dataurl` – the PDF.  
- `model` (string, optional) – fallback LLM if OCR confidence is low.  
- `ocr_threshold` (float, optional) – threshold for deciding fallback.  
- `page_numbering` (boolean-ish string, optional) – “true” or “false.”

#### Immediate Response

```json
{ "job_id": "some-uuid" }
```

#### Then Poll

```
GET /convert/document/jobs/{job_id}
GET /convert/document/jobs/{job_id}/result
```

#### Final Result (once complete)

A [Document Object](#document-object-specification).  
The top-level `id` is typically the file’s SHA-256.  
The `content` field is the entire doc text (if generated).  
The `chunks.pages` array holds page-level chunk objects, each with `metadata` for page_number, text_extraction_method, etc.

**Example** final JSON:
```json5
{
  "id": "abcdef1234...sha256",
  "content": "# Full Document\n(Combined text from all pages...)",
  "metadata": {
    "mimetype": "application/pdf",
    "document_sha256": "abcdef1234...",
    "size_bytes": 12345
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
          "model_name": null
        }
      },
      {
        "id": "abcdef1234.../pages@1",
        "parent": "abcdef1234...",
        "start": 1000,
        "length": 900,
        "content": "# Page 2 text in markdown...",
        "metadata": {
          "page_number": 2,
          "text_extraction_method": "vision_model",
          "extraction_confidence": 0.90,
          "model_name": "gpt-4o"
        }
      }
      // ...
    ]
  }
}
```

- **Errors**:
  - 400 if file is missing or unsupported type.
  - 500 on internal errors.

---

### 7. Summarize a Document

```
POST /summarize
```
- **Description**: Summarizes a [Document Object](#document-object-specification) (from e.g. `/convert/document`) in either a single pass or chunk-by-chunk.
- **Note**: This is also a **long-running** endpoint returning `job_id`. It supports **4** summarization methods: `"full"`, `"map"`, `"fold"`, `"delta-fold"`.

#### Request Body

```jsonc
{
  "document": { ... },     // The doc object (id, content, chunks, etc.)
  "model": "gpt-4o",       // which LLM to use
  "method": "full",        // or "map", "fold", "delta-fold"
  "chunk_group": "pages",  // if method != "full"
  "preceding_chunks": 1,   // optional, for chunk-based methods
  "guidance": "Use bullet points only.",   // sub-prompt to shape summary style
  "temperature": 0.7
}
```

#### Immediate Response

```json
{ "job_id": "some-uuid" }
```

#### Then Poll

```
GET /summarize/jobs/{job_id}
GET /summarize/jobs/{job_id}/result
```

#### Final Result

Returns the **document object** again, now with either:
- A `summary` field at the top-level (for `full`, `fold`, `delta-fold`), or
- `summary` fields in each chunk (for `map`), depending on method.

**Example** (if `map`):
```jsonc
{
  "id": "mydoc-sha256",
  "content": "...",
  "chunks": {
    "pages": [
      {
        "id": "mydoc-sha256/pages@0",
        "content": "page1 text",
        "summary": "Page 1 summary..."
      },
      {
        "id": "mydoc-sha256/pages@1",
        "content": "page2 text",
        "summary": "Page 2 summary..."
      }
    ]
  }
}
```

- **Errors**:
  - 400 if missing fields or method unknown
  - 500 on unexpected error

---

## Error Handling

All endpoints produce appropriate HTTP status codes on errors:

- **400** if required fields are missing or invalid.  
- **404** if a requested resource/job is not found.  
- **500** for unexpected server errors.

In such cases, the response typically is:
```json
{ "error": "Some error message" }
```

---

## Transcript JSON Structure

Many conversation-based endpoints in Charmonator (such as `/chat/extend_transcript`) rely on a **Transcript JSON** format. Below is a complete specification for that structure.

### Overview

A transcript is an object with:
```json
{
  "messages": [
    // each element is a message object
  ]
}
```
where **`messages`** is an array of “message” objects in chronological order (oldest first).

### Message Objects

Each message in `transcript.messages` is:
```json
{
  "role": "user" | "assistant" | "system" | "developer" | "tool_call" | "tool_response",
  "content": "...or array..."
}
```
#### `role` Field

- `"user"`: from the end-user  
- `"assistant"`: from the assistant  
- `"system"`: system instructions  
- `"developer"`: developer-level instructions  
- `"tool_call"`: the assistant is calling a tool (function).  
- `"tool_response"`: a tool’s response to that call.

*(In some code bases, LLM function calls might appear with role `"function"`, but here we use `"tool_call"` / `"tool_response"`. )*

#### `content` Field

- May be a **string** (typical message text).
- May be an **array**, which can mix:
  1. Strings
  2. Attachments (images, documents, etc.)
  3. Tool call or tool response objects

##### Attachments

For example:
```json5
{
  "type": "image",
  "url": "data:image/png;base64,iVBOR..."
}
```
or
```json5
{
  "type": "document",
  "filename": "myfile.md",
  "content": "# Some Markdown content"
}
```
  
##### Tool Calls

When `role` is `"tool_call"`, `content` typically holds a single call object:
```json5
{
  "toolName": "calculator",
  "callId": "call-12345",
  "callType": "function",
  "arguments": {
    "expression": "3 + 4"
  },
  "rationale": "We want to compute a sum."
}
```
- **`toolName`**: name of the tool.  
- **`callId`**: unique ID for this call.  
- **`callType`**: typically `"function"`.  
- **`arguments`**: JSON arguments to pass to the tool.  
- **`rationale`**: optional explanation or reasoning.

##### Tool Responses

When `role` is `"tool_response"`, `content` typically holds a single response object:
```json5
{
  "toolName": "calculator",
  "callId": "call-12345",
  "response": "7.0"
}
```
- **`toolName`**: name of the tool invoked.  
- **`callId`**: must match the preceding tool call.  
- **`response`**: textual or JSON result from the tool.

### Example Usage in `extend_transcript`

**Request** to `POST /chat/extend_transcript` might look like:
```json
{
  "model": "gpt-4o",
  "system": "You are a programming assistant...",
  "temperature": 0.7,
  "transcript": {
    "messages": [
      {
        "role": "user",
        "content": "Hi, can you show me how to parse JSON in JavaScript?"
      }
    ]
  },
  "tools": [
    {
      "name": "web_search",
      "description": "Search the web for info",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        }
      }
    }
  ]
}
```

**Response** (suffix of new messages):
```json
{
  "messages": [
    {
      "role": "assistant",
      "content": "Sure, here is a simple example using JSON.parse..."
    }
  ]
}
```

---

## Document Object Specification

Many Charmonizer endpoints (like `/convert/document` and `/summarize`) utilize a **Document Object** format to represent content in chunked form for analysis, summarization, searching, and transformation.

Below is a detailed JSON specification for these “document objects.”

### Key Fields

1. **`id`** (string, required)  
   - Unique ID (e.g. file’s SHA-256, or a chunk ID derived from a parent).
2. **`content`** (string, optional)  
   - Full Markdown text for this document/chunk.  
   - If omitted, the text may be inferred via `parent + start + length` or by reassembling from sub-chunks.
3. **`summary`** (string, optional)  
   - A condensed representation of the content (e.g., from a summarization process).
4. **`parent`** (string, optional)  
   - The `id` of the parent doc from which this chunk is derived.
5. **`start`** (integer, optional)  
   - 0-based index into the parent’s `content` for this chunk’s text.
6. **`length`** (integer, optional)  
   - Number of characters in the parent’s `content` belonging to this chunk.
7. **`content_chunk_group`** (string, optional)  
   - If this doc’s full text is composed by concatenating a sub-chunk group, specify the group name here.
8. **`chunks`** (object, optional)  
   - A mapping from chunk-group-name → array of child document objects. Each child is structured similarly (`id`, `content`, `parent`, etc.).

### Example Structures

#### 1. Original PDF Document with Pages

```json5
{
  "id": "0ab6f8... (sha256)",
  "content": "...the entire PDF in markdown...",
  "chunks": {
    "pages": [
      {
        "id": "0ab6f8.../pages@0",
        "parent": "0ab6f8...",
        "start": 0,
        "length": 1000,
        "content": "# Page 1\nHere is page 1 text..."
      },
      {
        "id": "0ab6f8.../pages@1",
        "parent": "0ab6f8...",
        "start": 1000,
        "length": 900,
        "content": "# Page 2\n..."
      }
    ]
  }
}
```

#### 2. Document Without Direct `content`, Reassembled from “pages”

```json5
{
  "id": "0ab6f8... (sha256)",
  "content_chunk_group": "pages",
  "chunks": {
    "pages": [
      {
        "id": "0ab6f8.../pages@0",
        "parent": "0ab6f8...",
        "start": 0,
        "length": 1000,
        "content": "# Page 1\n..."
      },
      {
        "id": "0ab6f8.../pages@1",
        "parent": "0ab6f8...",
        "start": 1000,
        "length": 900,
        "content": "# Page 2\n..."
      }
    ]
  }
}
```

#### 3. Multi-level Chunking (Pages, Sentences)

```json5
{
  "id": "0ab6f8... (sha256)",
  "content": "...the entire doc in markdown...",
  "chunks": {
    "pages": [
      {
        "id": "0ab6f8.../pages@0",
        "parent": "0ab6f8...",
        "start": 0,
        "length": 1200,
        "chunks": {
          "sentences": [
            {
              "id": "0ab6f8.../pages@0/sentences@0",
              "parent": "0ab6f8.../pages@0",
              "start": 0,
              "length": 60
            },
            {
              "id": "0ab6f8.../pages@0/sentences@1",
              "parent": "0ab6f8.../pages@0",
              "start": 60,
              "length": 100
            }
          ]
        }
      },
      {
        "id": "0ab6f8.../pages@1",
        "parent": "0ab6f8...",
        "start": 1200,
        "length": 950
      }
    ]
  }
}
```

#### 4. Summaries in the Document

```json
{
  "id": "mydoc-sha256",
  "content": "...",
  "summary": "High-level summary if you did a 'full' or 'fold' approach",
  "chunks": {
    "pages": [
      {
        "id": "mydoc-sha256/pages@0",
        "content": "...",
        "summary": "Page 1 summary..."
      },
      {
        "id": "mydoc-sha256/pages@1",
        "content": "...",
        "summary": "Page 2 summary..."
      }
    ]
  }
}
```
*(You can have a top-level `summary`, chunk-level `summary`, or both.)*

### Rules Recap

1. Every document object has an **`id`**.  
2. **`content`** is optional. If absent, use `start/length/parent` or `content_chunk_group`.  
3. **`chunks`** is a mapping from chunk-group-name → sorted array of child objects.  
4. A child chunk references its parent with `parent`, plus `start` + `length` if needed.  
5. Summaries can be added at any level in a `summary` field.

This structure supports single-tier or multi-tier chunking, as well as partial or complete text. It’s used for ingestion, transformation, and summarization pipelines within Charmonizer.

---

**End of integrated API documentation.**
