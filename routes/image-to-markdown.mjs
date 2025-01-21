/* File: routes/image-to-markdown.mjs */

/*
 An endpoint that takes an image URL and returns a Markdown transcription of the image using a vision model.
 */

import express from 'express';
import {
  TranscriptFragment,
  Message,
  ImageAttachment
} from '../lib/transcript.mjs';

import { fetchChatModel } from '../lib/core.mjs';

/**
 * Helper function to remove or mask large data URLs
 * from an object or array structure before logging.
 */
function maskDataUrls(obj) {
  if (typeof obj === 'string') {
    if (obj.startsWith('data:image')) {
      // Return just a placeholder w/ length
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

const router = express.Router();

/**
 * POST /api/charmonator/v1/convert/image_to_markdown
 *
 * Expects JSON body:
 *   - imageUrl (string, required): data URL or remote image URL
 *   - description (string, optional): high-level description of the image/document
 *   - intent (string, optional): intended use of the transcription, to guide the model
 *   - graphic_instructions (string, optional): additional instructions for interpreting graphics, figures or images
 *   - preceding_content (string, optional): full markdown content preceding this page of the document
 *   - preceding_context (string, optional): a summary of the content preceding this page of the document
 *   - model (string, optional): the vision-capable chat model to use 
 */
router.post('/image_to_markdown', async (req, res) => {
  console.log("LOG: Entered /image_to_markdown route");

  // Mask data URLs in request body before logging
  const safeRequestBody = maskDataUrls(req.body);
  console.log("LOG: Safe request body =>", safeRequestBody);

  try {
    // 1. Extract relevant fields
    const {
      imageUrl,
      description,
      intent,
      graphic_instructions,
      preceding_content,
      preceding_context,
      model,
    } = req.body;

    if (!imageUrl) {
      console.error("LOG: No imageUrl provided.");
      return res.status(400).json({ error: 'No imageUrl provided.' });
    }

    // 2. Create a new TranscriptFragment
    console.log("LOG: Creating a new TranscriptFragment...");
    let transcript = new TranscriptFragment();
    console.log("LOG: transcript (initial) =>", transcript);

    // 3. Add system message instructions
    const systemInstructions =
      'You are an AI that transcribes images into Markdown. ' +
      'Your output should be as close to the original image structure as possible, ' +
      'including headings, lists, tables, or textual placeholders for diagrams.';
    const systemMessage = new Message('system', systemInstructions);
    transcript = transcript.plus(systemMessage);
    console.log("LOG: transcript after adding system =>", transcript);

    // 4. Build user text
    let userText = `Please transcribe the following image into **well-structured**, **well-formatted** Markdown. 
Prioritize matching the layout, headings, etc. from the original image.\n\n`;

    if (description) {
      userText += `**High-level description**: ${description}\n\n`;
    }
    if (intent) {
      userText += `**Intended use**: ${intent}\n\n`;
    }
    if (graphic_instructions) {
      userText += `**Additional instructions for graphics**: ${graphic_instructions}\n\n`;
    }
    if (preceding_content) {
      userText += `**Preceding markdown**:\n${preceding_content}\n\n`;
    }
    if (preceding_context) {
      userText += `**Preceding context**:\n${preceding_context}\n\n`;
    }
    userText += `Return only the transcribed Markdown.\n\n---\n`;

    // 5. Add the user message with the image attachment
    const imageAttachment = new ImageAttachment(imageUrl);
    const userMessage = new Message('user', [ userText, imageAttachment ]);
    transcript = transcript.plus(userMessage);
    console.log("LOG: transcript after adding user =>", transcript);

    // 6. Fetch the chat model (like in extend-transcript.mjs)
    const modelName = model || 'default-vision-model';
    console.log(`LOG: fetchChatModel("${modelName}")`);
    const chatModel = fetchChatModel(modelName);
    console.log("LOG: chatModel =>", chatModel);

    // 7. Optionally set temperature or system if you want:
    // (We'll leave it alone, unless you want to override them.)
    // chatModel.system = "Overriding system message if desired...";
    // chatModel.temperature = 0.7;

    // 8. Now we call `chatModel.extendTranscript(...)`, 
    // just like in extend-transcript.mjs
    // This returns a new TranscriptFragment containing the assistant's messages.
    console.log("LOG: About to call chatModel.extendTranscript(...)");
    const suffix = await chatModel.extendTranscript(transcript);

    // 9. Log the suffix
    console.log("LOG: suffix =>", suffix);

    // 10. Extract the final assistant messages from the suffix
    // The suffix is typically all new messages from the model, but let's find any assistant messages.
    const suffixJson = suffix.toJSON();
    console.log("LOG: suffix.toJSON() =>", maskDataUrls(suffixJson));

    // We'll find the last assistant message or fallback
    const assistantMsg = suffix.messages.find(m => m.role === 'assistant');
    if (!assistantMsg) {
      console.warn("LOG: No assistant message returned.");
      return res.json({ markdown: '(No assistant output returned.)' });
    }

    // 11. Return the final markdown
    const markdown = assistantMsg.content;
    console.log("LOG: Returning markdown =>", markdown);
    res.json({ markdown });

  } catch (error) {
    console.error('Error in /image_to_markdown route:', error);
    res.status(500).json({
      error: 'An unexpected error occurred while transcribing the image.',
    });
  }
});

export default router;
