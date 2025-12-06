// routes/conversion-router.mjs

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import PptxParser from 'node-pptx-parser';

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
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Generate unique filename while preserving the original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  fileFilter: (req, file, cb) => {
    // Allowed text/doc extensions:
    const allowedExtensions = [
      '.txt', '.md', '.docx', '.pptx', '.pdf', '.py', '.js', '.java',
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
 * Accepts a single file. Supports .pdf, .docx, .pptx, .txt, .md, etc.
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
    } else if (ext === '.pptx') {
      // Parse PPTX and preserve slide structure
      const parser = new PptxParser(file.path);
      const parsedContent = await parser.parse();

      /**
       * Helper to extract text from parsed XML elements recursively
       * @param {object} element - Parsed XML element
       * @returns {string[]} Array of text strings found
       */
      function extractTextFromElement(element) {
        const texts = [];

        if (!element) return texts;

        // Handle text nodes
        if (element['a:t']) {
          const textArray = Array.isArray(element['a:t']) ? element['a:t'] : [element['a:t']];
          textArray.forEach(t => {
            if (typeof t === 'string') {
              texts.push(t);
            } else if (t && t._) {
              texts.push(t._);
            }
          });
        }

        // Recursively search in child elements
        for (const key in element) {
          if (typeof element[key] === 'object' && !key.startsWith('$')) {
            const children = Array.isArray(element[key]) ? element[key] : [element[key]];
            children.forEach(child => {
              texts.push(...extractTextFromElement(child));
            });
          }
        }

        return texts;
      }

      /**
       * Extract table data from a graphic frame
       * @param {object} graphicFrame - Parsed graphic frame XML
       * @returns {string|null} Markdown table or null if no table found
       */
      function extractTableFromGraphicFrame(graphicFrame) {
        try {
          const graphic = graphicFrame['a:graphic'] ? graphicFrame['a:graphic'][0] : null;
          if (!graphic) return null;

          const graphicData = graphic['a:graphicData'] ? graphic['a:graphicData'][0] : null;
          if (!graphicData) return null;

          const tbl = graphicData['a:tbl'] ? graphicData['a:tbl'][0] : null;
          if (!tbl) return null;

          // Extract table rows
          const tblGrid = tbl['a:tblGrid'] ? tbl['a:tblGrid'][0] : null;
          const rows = [];

          // Process table rows (a:tr elements)
          const trElements = tbl['a:tr'] || [];
          trElements.forEach(tr => {
            const row = [];
            const cells = tr['a:tc'] || [];

            cells.forEach(cell => {
              // Extract text from each cell
              const txBody = cell['a:txBody'] ? cell['a:txBody'][0] : null;
              if (txBody) {
                const cellTexts = extractTextFromElement(txBody);
                row.push(cellTexts.join(' ').trim() || '');
              } else {
                row.push('');
              }
            });

            if (row.length > 0) {
              rows.push(row);
            }
          });

          if (rows.length === 0) return null;

          // Convert to markdown table
          const maxCols = Math.max(...rows.map(r => r.length));

          // Pad rows to have equal columns
          const paddedRows = rows.map(row => {
            while (row.length < maxCols) {
              row.push('');
            }
            return row;
          });

          // Build markdown table
          let markdown = '';

          // First row (header)
          if (paddedRows.length > 0) {
            markdown += '| ' + paddedRows[0].join(' | ') + ' |\n';
            markdown += '| ' + paddedRows[0].map(() => '---').join(' | ') + ' |\n';

            // Remaining rows (data)
            for (let i = 1; i < paddedRows.length; i++) {
              markdown += '| ' + paddedRows[i].join(' | ') + ' |\n';
            }
          }

          return markdown;
        } catch (err) {
          console.error('Error extracting table:', err);
          return null;
        }
      }

      /**
       * Extract shapes/text elements from a slide
       * @param {object} slideParsed - Parsed slide XML
       * @returns {Array} Array of text elements with metadata
       */
      function extractSlideElements(slideParsed) {
        const elements = [];

        if (!slideParsed || !slideParsed['p:sld']) return elements;

        const sld = slideParsed['p:sld'];
        const cSld = sld['p:cSld'] ? sld['p:cSld'][0] : null;
        const spTree = cSld && cSld['p:spTree'] ? cSld['p:spTree'][0] : null;

        if (!spTree) return elements;

        // Extract shapes (p:sp elements contain text)
        const shapes = spTree['p:sp'] || [];
        shapes.forEach((shape, idx) => {
          const nvSpPr = shape['p:nvSpPr'] ? shape['p:nvSpPr'][0] : null;
          const cNvPr = nvSpPr && nvSpPr['p:cNvPr'] ? nvSpPr['p:cNvPr'][0] : null;
          const nvPr = nvSpPr && nvSpPr['p:nvPr'] ? nvSpPr['p:nvPr'][0] : null;

          // Determine element type
          let elementType = 'text';
          if (nvPr && nvPr['p:ph']) {
            const ph = nvPr['p:ph'][0];
            const phType = ph.$ && ph.$.type;
            if (phType === 'title' || phType === 'ctrTitle') {
              elementType = 'title';
            } else if (phType === 'subTitle') {
              elementType = 'subtitle';
            } else if (phType === 'body') {
              elementType = 'body';
            }
          }

          // Extract text
          const txBody = shape['p:txBody'] ? shape['p:txBody'][0] : null;
          if (txBody) {
            const texts = extractTextFromElement(txBody);
            if (texts.length > 0) {
              elements.push({
                type: elementType,
                text: texts.join('\n').trim()
              });
            }
          }
        });

        // Extract tables from graphic frames (p:graphicFrame elements contain tables)
        const graphicFrames = spTree['p:graphicFrame'] || [];
        graphicFrames.forEach(frame => {
          const tableMarkdown = extractTableFromGraphicFrame(frame);
          if (tableMarkdown) {
            elements.push({
              type: 'table',
              text: tableMarkdown
            });
          }
        });

        return elements;
      }

      // Sort slides by their numeric order (extract number from path like slide1.xml, slide2.xml)
      const sortedSlides = parsedContent.slides.sort((a, b) => {
        const numA = parseInt(a.path.match(/slide(\d+)/)?.[1] || '0');
        const numB = parseInt(b.path.match(/slide(\d+)/)?.[1] || '0');
        return numA - numB;
      });

      // Format slides with clear separation
      const slideTexts = sortedSlides.map((slide, index) => {
        const slideNum = index + 1;
        let slideContent = `<!-- SLIDE: ${slideNum} -->\n\n`;

        const elements = extractSlideElements(slide.parsed);

        elements.forEach((element, elemIdx) => {
          // Add type comment
          slideContent += `<!-- TYPE: ${element.type} -->\n`;

          // Use ## for titles, ### for subtitles, tables as-is, plain text for body/text
          if (element.type === 'title') {
            slideContent += `## ${element.text}\n\n`;
          } else if (element.type === 'subtitle') {
            slideContent += `### ${element.text}\n\n`;
          } else if (element.type === 'table') {
            // Tables are already formatted as markdown
            slideContent += `${element.text}\n\n`;
          } else {
            // body or text elements - use plain text
            slideContent += `${element.text}\n\n`;

            // Add separator after body/text elements if not the last element
            if (elemIdx < elements.length - 1) {
              slideContent += `---\n\n`;
            }
          }
        });

        return slideContent.trimEnd() + '\n';
      });

      // Join all slides with double-line separators
      markdownContent = slideTexts.join('\n---\n---\n\n');

      // Post-conversion transformation: Convert bullet characters to markdown bullets
      markdownContent = markdownContent.replace(/^• /gm, ' - ');
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

