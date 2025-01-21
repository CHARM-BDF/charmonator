// File: routes/charmonizer/document-summarize.mjs

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { fetchChatModel } from '../../lib/core.mjs';

// We rely on the JSONDocument wrapper from json-document.mjs:
import { JSONDocument } from '../../lib/json-document.mjs';

/**
 * We'll store summarization jobs in memory. For production, use a DB or persistent store.
 */
const jobs = {};

/**
 * Summarization system prompts for each mode:
 */
const SYSTEM_PROMPTS = {
  full: `
You are a document summarization assistant.

The user will provide a full document, and you will summarize its contents.

When summarizing, follow the provided guidance below.

## Guidance for summarization

<user-provided guidance>
`,
  map: `
You are a document summarization assistant.

The document has been broken down into chunks.

You will produce a summary for one chunk.

(You may also be given preceding chunks of the document to help understand the context of the current chunk when producing its summary.)

When summarizing your chunk, summarize only the information contained in that chunk.

When summarizing, follow the provided guidance.

## Guidance for summarization

<user-provided guidance>
`,
  fold: `
You are a document summarization assistant.

The document has been broken down into chunks.

The user will provide you with:

 1. a chunk from the document
 2. an accumulated summary of all the chunks prior to that chunk

You will produce an updated accumulated summary.

This updated accumulated summary will integrate any new relevant information from the current chunk.

(You may also be given preceding chunks of the document to help understanding the context of the current chunk when producing its summary.)

When summarizing, follow the provided guidance, and, remember, only provide the updated accumulated summary.

## Guidance for summarization

<user-provided guidance>
`,
  'delta-fold': `
You are a document summarization assistant.

The document has been broken down into chunks.

The user will provide you with:

 1. a chunk from the document
 2. an accumulating summary of all the chunks prior to that chunk

You will produce a "delta" summary for this chunk:

This "delta" summary should contain only new information contained in this chunk.

(You may also be given preceding chunks of the document to help understanding the context of the current chunk when producing its summary.)

The new accumulating summary will be created by appending the "delta" summary to the old accumulating summary, so maintain consistency in formatting and conventions.

When summarizing, follow the provided guidance, and, remember, only provide the "delta" summary.

## Guidance for summarization

<user-provided guidance>
`,
};

/**
 * Create and store a new job
 */
function createJobRecord(docObject, params) {
  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'pending',
    error: null,
    createdAt: Date.now(),
    docObject,     // the original doc (parsed into JSONDocument if needed)
    ...params,     // store summarization params: method, chunk_group, guidance, etc.
    summarizedDoc: null  // final doc with summaries
  };
  return jobs[jobId];
}

/**
 * The main summarization logic
 */
async function processSummarizeAsync(job) {
  job.status = 'processing';

  // Parse the top-level doc if it's not already a JSONDocument
  // but typically we'll assume the user gave us an object in the "document" param
  // so let's wrap it with JSONDocument:
  const topDoc = new JSONDocument(job.docObject);

  // We'll eventually store the final doc with summaries in job.summarizedDoc
  // Let's proceed based on job.method:
  switch (job.method) {
    case 'full':
      await runFullSummarization(job, topDoc);
      break;
    case 'map':
      await runMapSummarization(job, topDoc);
      break;
    case 'fold':
      await runFoldSummarization(job, topDoc);
      break;
    case 'delta-fold':
      await runDeltaFoldSummarization(job, topDoc);
      break;
    default:
      throw new Error(`Unsupported summarization method: ${job.method}`);
  }

  // done
  job.summarizedDoc = topDoc.toObject(); // store final updated doc
  job.status = 'complete';
}

/**
 * Summarize the *entire doc* with a single LLM call.
 * - doc must fit in context
 */
async function runFullSummarization(job, topDoc) {
  const fullContent = topDoc.getResolvedContent();
  // Build the system prompt
  const systemPrompt = SYSTEM_PROMPTS.full.replace('<user-provided guidance>', job.guidance || '');

  // 1) Create chat model
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  // 2) Build a conversation: system + user => doc text
  let transcript = [];
  transcript.push({ role: 'system', content: systemPrompt });
  // user message is just the doc’s entire text
  transcript.push({ role: 'user', content: fullContent });

  // 3) Send to LLM
  const assistantReply = await callLLM(chatModel, transcript);

  // 4) Store it in top-level doc as `summary`
  topDoc._doc.summary = assistantReply; // place a new field "summary"
}

/**
 * Summarize each chunk individually and store summary in chunk.summary.
 * - If user sets preceding_chunks > 0, also include preceding chunk content as context
 */
async function runMapSummarization(job, topDoc) {
  // need chunk_group
  if (!job.chunk_group) {
    throw new Error('For "map" summarization, chunk_group is required.');
  }
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  if (!chunkArray || !Array.isArray(chunkArray)) {
    throw new Error(`No chunk group named "${job.chunk_group}" found on document.`);
  }

  // Build base system prompt
  const systemPrompt = SYSTEM_PROMPTS.map.replace('<user-provided guidance>', job.guidance || '');

  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  // For each chunk, call LLM
  // Optionally use preceding_chunks
  const precedingCount = job.preceding_chunks ? parseInt(job.preceding_chunks, 10) : 0;

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunk = new JSONDocument(chunkArray[i], topDoc);

    // Gather the preceding chunk texts if needed
    let precedingText = '';
    if (precedingCount > 0) {
      const startIndex = Math.max(0, i - precedingCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(ch => new JSONDocument(ch, topDoc).getResolvedContent())
        .join('\n\n');
    }

    // Build user message: put preceding text (if any) + the chunk text
    let userContent = '';
    if (precedingText) {
      userContent += `Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `Current chunk:\n${thisChunk.getResolvedContent()}`;

    // Build conversation
    let transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const assistantReply = await callLLM(chatModel, transcript);

    // Store into the chunk object
    thisChunk._doc.summary = assistantReply;

    // Write it back
    chunkArray[i] = thisChunk.toObject();
  }

  // Overwrite the doc’s chunk array
  topDoc.setChunksForGroup(job.chunk_group, chunkArray);
}

/**
 * "fold" mode:
 *   - We keep an accumulated summary across chunks
 *   - Each new chunk => get the old summary + chunk content => produce an updated summary
 */
async function runFoldSummarization(job, topDoc) {
  if (!job.chunk_group) {
    throw new Error('For "fold" summarization, chunk_group is required.');
  }
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  if (!chunkArray) {
    throw new Error(`No chunk group named "${job.chunk_group}".`);
  }

  const systemPrompt = SYSTEM_PROMPTS.fold.replace('<user-provided guidance>', job.guidance || '');
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  // We'll store the accumulated summary as we go
  let accumulatedSummary = '';
  const precedingCount = job.preceding_chunks ? parseInt(job.preceding_chunks, 10) : 0;

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunk = new JSONDocument(chunkArray[i], topDoc);

    // gather preceding chunk text if needed
    let precedingText = '';
    if (precedingCount > 0) {
      const startIndex = Math.max(0, i - precedingCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(ch => new JSONDocument(ch, topDoc).getResolvedContent())
        .join('\n\n');
    }

    let userContent = '';
    if (accumulatedSummary) {
      userContent += `Accumulated summary so far:\n${accumulatedSummary}\n\n---\n\n`;
    }
    if (precedingText) {
      userContent += `Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `Current chunk:\n${thisChunk.getResolvedContent()}`;

    // build conversation
    let transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];
    const assistantReply = await callLLM(chatModel, transcript);

    accumulatedSummary = assistantReply;
  }

  // store the final accumulated summary at top level doc
  topDoc._doc.summary = accumulatedSummary;
}

/**
 * "delta-fold":
 *   - we keep an accumulating summary
 *   - each chunk => we pass old summary + chunk => produce *only a delta*
 *   - new summary = old summary + delta
 */
async function runDeltaFoldSummarization(job, topDoc) {
  if (!job.chunk_group) {
    throw new Error('For "delta-fold" summarization, chunk_group is required.');
  }
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  if (!chunkArray) {
    throw new Error(`No chunk group named "${job.chunk_group}".`);
  }

  const systemPrompt = SYSTEM_PROMPTS['delta-fold'].replace('<user-provided guidance>', job.guidance || '');
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  let accumulated = '';
  const precedingCount = job.preceding_chunks ? parseInt(job.preceding_chunks, 10) : 0;

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunk = new JSONDocument(chunkArray[i], topDoc);

    // gather preceding chunk text if needed
    let precedingText = '';
    if (precedingCount > 0) {
      const startIndex = Math.max(0, i - precedingCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(ch => new JSONDocument(ch, topDoc).getResolvedContent())
        .join('\n\n');
    }

    let userContent = '';
    if (accumulated) {
      userContent += `Accumulated summary so far:\n${accumulated}\n\n---\n\n`;
    }
    if (precedingText) {
      userContent += `Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `Current chunk:\n${thisChunk.getResolvedContent()}`;

    let transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];
    const llmReply = await callLLM(chatModel, transcript);

    // The reply is the "delta" summary
    let deltaSummary = llmReply;
    accumulated = accumulated + '\n' + deltaSummary;
  }

  topDoc._doc.summary = accumulated;
}

/**
 * Helper: create a chat model from `core.mjs` with system message + temp
 */
function makeChatModel(modelName, systemText, temperature) {
  const chatModel = fetchChatModel(modelName);
  chatModel.system = systemText;
  if (temperature != null) {
    chatModel.temperature = parseFloat(temperature);
  }
  return chatModel;
}

/**
 * Helper: call the LLM with the minimal "transcript"
 *   using `chatModel.extendTranscript()` style
 */
async function callLLM(chatModel, minimalTranscript) {
  // minimalTranscript is an array of {role, content} objects
  // We convert that into the model’s internal "TranscriptFragment"
  // or we can build a quick approach:
  let prefixFrag = {
    messages: minimalTranscript.map(m => ({
      role: m.role,
      content: m.content
    }))
  };

  const suffixFrag = await chatModel.extendTranscript(prefixFrag);
  // The LLM’s final assistant message is typically at the end
  const lastMsg = suffixFrag.messages[suffixFrag.messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') {
    // fallback
    return '(No output from LLM?)';
  }
  return lastMsg.content;
}

const router = express.Router();

/**
 * POST /api/charmonizer/v1/summarize
 *
 * Expects JSON body:
 * {
 *   "document": { ... } - the doc object from e.g. /convert/document
 *   "method": "full" | "map" | "fold" | "delta-fold"
 *   "chunk_group": string (if method != "full")
 *   "preceding_chunks": number (optional, for map/fold/delta-fold)
 *   "model": string (which LLM to use)
 *   "guidance": string (prompt instructions)
 *   "temperature": number
 * }
 *
 * Returns { job_id }
 */
router.post('/summarize', async (req, res) => {
  try {
    const {
      document,
      method,
      chunk_group,
      preceding_chunks,
      model,
      guidance,
      temperature
    } = req.body;

    if (!document || !method) {
      return res.status(400).json({ error: 'document and method are required' });
    }
    // create job
    const job = createJobRecord(document, {
      method,
      chunk_group,
      preceding_chunks,
      model: model || 'gpt-4o',  // default
      guidance: guidance || '',
      temperature: temperature || 0.7
    });

    // Kick off in background
    processSummarizeAsync(job).catch(err => {
      job.status = 'error';
      job.error = String(err);
      console.error('Summarize job error:', err);
    });

    return res.json({ job_id: job.id });
  } catch (error) {
    console.error('POST /summarize error:', error);
    res.status(500).json({ error: String(error) });
  }
});

/**
 * GET /api/charmonizer/v1/summarize/jobs/:jobId
 * returns minimal job status
 */
router.get('/summarize/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  if (job.status === 'pending' || job.status === 'processing') {
    return res.json({ status: job.status });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error });
  }
  // if complete
  return res.json({ status: 'complete' });
});

/**
 * GET /api/charmonizer/v1/summarize/jobs/:jobId/result
 * if complete => return doc
 * else => 202 or 500
 */
router.get('/summarize/jobs/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  if (job.status === 'pending' || job.status === 'processing') {
    return res.status(202).json({ status: job.status });
  }
  if (job.status === 'error') {
    return res.status(500).json({ status: 'error', error: job.error });
  }
  // if complete:
  // The final doc with summaries is in job.summarizedDoc
  return res.json(job.summarizedDoc || {});
});

/**
 * DELETE /api/charmonizer/v1/summarize/jobs/:jobId
 * remove job from memory
 */
router.delete('/summarize/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  delete jobs[jobId];
  res.json({ success: true });
});

export default router;
