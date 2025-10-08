// routes/conversion-router.mjs

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

import { fetchChatModel } from '../lib/core.mjs';
import { TranscriptFragment, Message, ImageAttachment } from '../lib/transcript.mjs';

// [ADDED for .doc.json support]
import { JSONDocument } from '../lib/json-document.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';

/**
 * Helper function to remove or mask large data URLs
 * from an object or array structure before logging.
 */
function maskDataUrls(obj) {
  if (typeof obj === 'string') {
    if (obj.startsWith('data:image')) {
      // Return a short placeholder w/ length
      return `[DATA_URL length=${obj.length}]`;
    }
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.map((item) => maskDataUrls(item));
  } else if (obj && typeof obj === 'object') {
    // Recursively mask properties
    const copy = {};
    for (const [key, value] of Object.entries(obj)) {
      copy[key] = maskDataUrls(value);
    }
    return copy;
  }
  // For primitives (number, boolean, null, etc.), just return as-is
  return obj;
}

// Multer setup for file uploads in /conversion/file
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    // Allowed text/doc extensions:
    const allowedExtensions = [
      '.txt', '.md', '.docx', '.pdf', '.py', '.js', '.java',
      '.c', '.cpp', '.cs', '.rb', '.go', '.rs', '.php',
      '.html', '.css', '.json', '.xml', '.sh', '.bat'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File extension not allowed: ${file.originalname}`));
    }
  },
});

const router = express.Router();

/**
 * Helper to strip triple-backtick fences around JSON
 */
function stripJsonCodeFence(str) {
  return str.replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/i, '$1').trim();
}

/** ============================================================================
 * POST /conversion/image
 * ----------------------------------------------------------------------------
 * Accepts JSON body:
 *  - imageUrl (string, required): data URL or remote URL
 *  - preceding_image_url (string, optional): for context
 *  - description, intent, graphic_instructions, preceding_content, preceding_context (optional)
 *  - model (string, optional)
 *  - describe (boolean, optional) => default: true
 *  - tags (object or JSON string, optional)
 *
 * Returns:
 *  {
 *    "markdown": "...",
 *    "isFirstPage": false,
 *    "description": "...", // if describe=true
 *    "tags": ["someTag"]   // if present
 *  }
 * ============================================================================
 */
router.post('/image', async (req, res) => {
  console.log("[POST] /conversion/image  -- converting image to markdown");

  // Mask data URLs in request body before logging
  const safeRequestBody = maskDataUrls(req.body);
  console.log("Request body (masked) =>", safeRequestBody);

  try {
    let {
      imageUrl,
      preceding_image_url,
      description,
      intent,
      graphic_instructions,
      preceding_content,
      preceding_context,
      model,
      describe = true,
      tags
    } = req.body;

    // If tags came in as a JSON string, parse it:
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch {
        console.warn('[conversion/image] Unable to parse tags as JSON, ignoring.');
        tags = null;
      }
    }

    if (!imageUrl) {
      return res.status(400).json({ error: 'No "imageUrl" provided.' });
    }

    const systemInstructions =
      `You are an AI that precisely transcribes images into github-formatted markdown under user guidance.\n\n` +
      `For text formatted into multiple columns, correctly sequence the content of the columns into the logical order for reading.` +
      `You also try to determine if the current page is likely the *first page of a document*.\n\n` +
      `Return a valid JSON object with keys "markdown" (string) and "isFirstPage" (boolean).\n\n` +
      `If the user requests a description, add a "description" field (string) as a short description of the page.\n\n` +
      `If the user requests tagging, add a "tags" field (array of strings) providing the user-defined tags that "describe" this page.\n\n` +
      `Beyond the image provided, the user may provide additional context to help interpret the image.\n\n` +
      `The user may also provide additional instructions on how to interpret graphical content and figures.\n\n` +
      `Do NOT wrap the JSON in triple backticks. Return ONLY raw JSON.`;

    let transcript = new TranscriptFragment();
    transcript = transcript.plus(new Message('system', systemInstructions));

    // Build user request text
    let userText = `Please accurately transcribe this image into well-structured markdown word for word.  Also decide if this is likely the first page of a document. If there are tables, preserve tabular structure using github-formatted-markdown tables when possible. When proper preservation of the structure as a table is not possible, reformat the content to preserve information and understanding as precisely as possible.\n\n`;

    userText += `Output must be raw JSON with at least { "markdown": "...", "isFirstPage": ... }\n\n`;

    if (description) {
      userText += `**Context: High-level user-provided description**: ${description}\n\n`;
    }
    if (intent) {
      userText += `**Context: Intended use of this transcription**: ${intent}\n\n`;
    }
    if (graphic_instructions) {
      userText += `**Additional instructions for graphics**: ${graphic_instructions}\n\n`;
    }
    if (preceding_content) {
      userText += `**Context: Markdown from transcribing the preceding page**:\n${preceding_content}\n\n`;
    }
    if (preceding_context) {
      userText += `**Context: A short description of the document that precedes this page**:\n${preceding_context}\n\n`;
    }
    // TODO: Fix the preceding page bug to actually clearly differentiate this page from the current page:
    if (preceding_image_url) {
      userText += `**Context**: Note that a preceding page image is provided in addition to the current page.\n\n`;
    }

    if (tags) {
      userText += `**The user also requests tagging with the following tags** (according to their definitions):\n`;
      for (const [tagName, tagDef] of Object.entries(tags)) {
        userText += `- Tag "${tagName}": ${tagDef}\n`;
      }
      userText += `\nWhen you return the JSON, you may include "tags": ["tag1","tag2",...] if the page content meets those definitions.\n\n`;
    }

    if (describe) {
      userText += `Please include a "description" field with 1–3 sentences summarizing the page.\n`;
    } else {
      userText += `No short description needed.\n\n`;
    }

    userText += `Return your answer as raw JSON (no code fences), with keys: "markdown", "isFirstPage", optional "description", optional "tags".\n`;

    // Construct user message
    const userContent = [ userText ];
    if (preceding_image_url) {
      userContent.push(new ImageAttachment(preceding_image_url));
    }
    userContent.push(new ImageAttachment(imageUrl));

    const userMessage = new Message('user', userContent);
    transcript = transcript.plus(userMessage);

    // 4. Choose model or default
    const modelName = model || 'llama-vision-mini';
    const chatModel = fetchChatModel(modelName);

    // 5. Call extendTranscript
    const suffix = await chatModel.extendTranscript(transcript);

    // 6. Extract final assistant message
    const assistantMsg = suffix.messages.find(m => m.role === 'assistant');
    if (!assistantMsg) {
      console.warn("No assistant message returned from model.");
      return res.json({ markdown: '(No assistant output returned.)', isFirstPage: false });
    }

    let textOutput = '';
    if (Array.isArray(assistantMsg.content)) {
      for (const item of assistantMsg.content) {
        if (typeof item === 'string') {
          textOutput += item;
        } else if (item && item.text) {
          textOutput += item.text;
        }
      }
    } else {
      textOutput = assistantMsg.content || '';
    }
    textOutput = stripJsonCodeFence(textOutput);

    let parsed = { markdown: '', isFirstPage: false };
    try {
      parsed = JSON.parse(textOutput);

      if (typeof parsed.markdown !== 'string') {
        parsed.markdown = String(parsed.markdown || '');
      }
      if (typeof parsed.isFirstPage !== 'boolean') {
        parsed.isFirstPage = false;
      }
    } catch (err) {
      console.warn("Failed to parse JSON from assistant. Using fallback.");
      parsed.markdown = textOutput;
      parsed.isFirstPage = false;
    }

    const responsePayload = {
      markdown: parsed.markdown,
      isFirstPage: parsed.isFirstPage
    };

    if (describe) {
      responsePayload.description = (typeof parsed.description === 'string')
        ? parsed.description
        : '';
    }
    if (Array.isArray(parsed.tags)) {
      responsePayload.tags = parsed.tags;
    }

    res.json(responsePayload);

  } catch (error) {
    const j = jsonSafeFromException(error)
    console.error({"event": "Error during /conversion/image",
      stack: error.stack,
      errJson: j
    })
    res.status(500).json(j);
    return
    // TODO: confirm that the above supersedes the below.
    /*
    console.error('Error during /conversion/image:', error);

    // Handle enhanced errors from providers
    if (error.interpretedErrorType && error.httpStatus && error.userMessage) {
      // This is an enhanced error from a provider
      const response = {
        error: error.userMessage,
        errorType: error.interpretedErrorType,
        provider: error.provider || 'unknown'
      };
      
      // Add additional context for specific error types
      if (error.interpretedErrorType === 'content_filter_violation') {
        response.details = 'The image content was flagged by content filtering policies. Please ensure the image contains appropriate content and try again.';
      }
      
      return res.status(error.httpStatus).json(response);
    }
    
    // Fallback for non-enhanced errors
    res.status(500).json({
      error: error.message || 'An unexpected error occurred while transcribing the image.',
      errorType: 'unknown_error'
    });
    */
  }
});


/** ============================================================================
 * POST /conversion/file  [multipart/form-data]
 * ----------------------------------------------------------------------------
 * Accepts a single file. Supports .pdf, .docx, .txt, .md, etc.
 * Returns extracted or converted Markdown text.
 *
 * Returns:
 *  {
 *    "markdownContent": "..."
 *  }
 * ============================================================================
 */
router.post('/file', upload.single('file'), async (req, res) => {
  console.log("[POST] /conversion/file  -- converting doc to markdown");
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    let markdownContent = '';
    const ext = path.extname(file.originalname).toLowerCase();

    if (ext === '.pdf') {
      const dataBuffer = await fs.promises.readFile(file.path);
      const pdfData = await pdfParse(dataBuffer);
      markdownContent = pdfData.text;
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: file.path });
      markdownContent = result.value;
    } 
    // [ADDED for .doc.json support]
    else if (ext === '.json' && file.originalname.endsWith('.doc.json')) {
      // If the filename ends with ".doc.json", assume it's a JSON Document Object
      const fileData = await fs.promises.readFile(file.path, 'utf8');
      const docObj = JSON.parse(fileData);
      const doc = new JSONDocument(docObj);
      markdownContent = doc.getResolvedContent();
    }
    // For everything else text-like
    else {
      const fileContent = await fs.promises.readFile(file.path, 'utf8');
      markdownContent = fileContent;
    }

    // Clean up uploaded file
    fs.unlink(file.path, (err) => {
      if (err) console.error(`Failed to delete temp upload file: ${file.path}`, err);
    });

    res.json({ markdownContent });
  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error converting file",
      stack: err.stack,
      errJson: j
    })
    res.status(500).json(j);
  }
});

export default router;

