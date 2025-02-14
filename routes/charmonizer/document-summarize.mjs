// File: routes/charmonizer/document-summarize.mjs

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { fetchChatModel } from '../../lib/core.mjs';
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
`,
  map: `
You are a document summarization assistant.

The document has been broken down into chunks.

You will produce a summary for exactly one chunk.

(You may also be given some preceding chunks for context, and possibly succeeding chunks.)

When summarizing, follow the provided guidance.
`,
  fold: `
You are a document summarization assistant.

The document has been broken down into chunks.

You will be provided:
 1. a chunk of the document
 2. an accumulated summary so far.

You must produce an updated accumulated summary in the same format, integrating what’s new from this chunk, but not removing any important information from the accumulated summary.

When summarizing, follow the guidance.
`,
  'delta-fold': `
You are a document summarization assistant.

The document has been broken down into chunks.

You will be provided:
 1. a chunk of the document
 2. an existing "accumulating" summary.

You must produce a "delta" summary (only new info from this chunk not in the accumulated summary). 
This "delta" summary is appended to the array that forms the final summary.

Follow the guidance carefully, and return only the new "delta" in valid JSON form.
`,
};

/**
 * Helper that forcibly instructs the model to output valid JSON if `job.jsonSchema` is present.
 */
function buildSystemPrompt(modePrompt, job) {
  const base = modePrompt.replace('<user-provided guidance>', job.guidance || '');
  // If no schema requested, just return base prompt:
  if (!job.jsonSchema) {
    return base;
  }

  // If user provided a JSON schema, instruct the LLM to produce JSON that conforms.
  // We'll embed the schema as a string:
  const schemaString = JSON.stringify(job.jsonSchema, null, 2);

  return (
    base +
    `

The user also requires that your entire response MUST be valid JSON conforming to the following schema:
${schemaString}

**Do not include extraneous commentary**—only valid JSON according to that schema. 
If necessary, fill all required fields. 
`
  );
}

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

    docObject, // the original doc
    ...params, // store summarization params

    summarizedDoc: null, // final doc with summaries

    // Progress tracking:
    chunks_total: 0,
    chunks_completed: 0
  };
  return jobs[jobId];
}

/**
 * The main summarization logic
 */
async function processSummarizeAsync(job) {
  job.status = 'processing';

  // Wrap the top-level doc
  const topDoc = new JSONDocument(job.docObject);

  // Initialize chunk counts:
  switch (job.method) {
    case 'full':
      job.chunks_total = 1;
      break;
    case 'map':
    case 'fold':
    case 'delta-fold': {
      const chunkArr = topDoc.getChunksForGroup(job.chunk_group) || [];
      job.chunks_total = chunkArr.length;
      break;
    }
    default:
      throw new Error(`Unsupported summarization method: ${job.method}`);
  }

  try {
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
    }
    job.summarizedDoc = topDoc.toObject();
    job.status = 'complete';
  } catch (err) {
    job.status = 'error';
    job.error = String(err);
  }
}

/**
 * Helper to ensure we have an annotations object on a doc's raw JSON
 */
function ensureAnnotations(docObj) {
  if (!docObj.annotations) {
    docObj.annotations = {};
  }
}

/**
 * If we are requiring JSON output, parse it. If parse fails, store text + error.
 *
 * MODIFIED: We now strip triple-backtick code fences before calling JSON.parse.
 */
function parseLLMReply(rawText, job) {
  if (!job.jsonSchema) {
    // not using structured JSON mode, just return raw text
    return rawText;
  }

  let cleaned = rawText;
  try {
    cleaned = cleaned.trim();
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, ''); // remove leading ``` or ```json
    cleaned = cleaned.replace(/```$/, '').trim();      // remove trailing backticks
  } catch (_err) {
    cleaned = rawText;
  }

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return {
      __json_parse_error: err.message,
      raw_text: rawText
    };
  }
}

/**
 * Summarize the entire doc with a single LLM call.
 * - Store in top-level doc.annotations[job.annotation_field]
 */
async function runFullSummarization(job, topDoc) {
  const fullContent = topDoc.getResolvedContent();
  const basePrompt = SYSTEM_PROMPTS.full.replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  // (Added) Also include top-level doc ID:
  const docId = topDoc._doc.id || '(no-id)';
  const docMetadata = JSON.stringify(topDoc._doc.metadata || {}, null, 2);

  // (Modified user content) Now includes doc ID:
  let transcript = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `## Document ID: ${docId}\n## Document metadata:\n${docMetadata}\n\n## Full document contents:\n${fullContent}`
    }
  ];

  const assistantReply = await callLLM(chatModel, transcript);
  const finalData = parseLLMReply(assistantReply, job);

  ensureAnnotations(topDoc._doc);
  topDoc._doc.annotations[job.annotation_field] = finalData;
  job.chunks_completed = 1;
}

/**
 * Summarize each chunk in chunk.annotations[job.annotation_field],
 * while optionally passing in preceding/succeeding chunk text for context.
 */
async function runMapSummarization(job, topDoc) {
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  if (!chunkArray || !Array.isArray(chunkArray)) {
    throw new Error(`No chunk group named "${job.chunk_group}" found on document.`);
  }
  const basePrompt = SYSTEM_PROMPTS.map.replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  const docId = topDoc._doc.id || '(no-id)';
  const beforeCount = job.context_chunks_before ? parseInt(job.context_chunks_before, 10) : 0;
  const afterCount = job.context_chunks_after ? parseInt(job.context_chunks_after, 10) : 0;

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunk = new JSONDocument(chunkArray[i], topDoc);

    // Gather preceding text:
    let precedingText = '';
    if (beforeCount > 0) {
      const startIndex = Math.max(0, i - beforeCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk><!-- id="${chunkDoc._doc.id}" -->`;
        })
        .join('\n\n');
    }

    // Gather succeeding text:
    let succeedingText = '';
    if (afterCount > 0) {
      const endIndex = Math.min(chunkArray.length, i + 1 + afterCount);
      const afterSlice = chunkArray.slice(i + 1, endIndex);
      succeedingText = afterSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk><!-- id="${chunkDoc._doc.id}" -->`;
        })
        .join('\n\n');
    }

    const chunkMetadata = JSON.stringify(thisChunk._doc.metadata || {}, null, 2);
    const chunkText = `<chunk id="${thisChunk._doc.id}">\n${thisChunk.getResolvedContent()}\n</chunk><!-- id="${thisChunk._doc.id}" -->`;

    let userContent = `## Document ID: ${docId}\n`;
    if (precedingText) {
      userContent += `## Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `## Current chunk metadata:\n${chunkMetadata}\n\n## Current chunk:\n${chunkText}`;
    if (succeedingText) {
      userContent += `\n\n---\n\n## Succeeding chunk(s):\n${succeedingText}`;
    }

    let transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const assistantReply = await callLLM(chatModel, transcript);
    const finalData = parseLLMReply(assistantReply, job);

    if (!thisChunk._doc.annotations) {
      thisChunk._doc.annotations = {};
    }
    thisChunk._doc.annotations[job.annotation_field] = finalData;

    chunkArray[i] = thisChunk.toObject();
    job.chunks_completed++;
  }
  topDoc.setChunksForGroup(job.chunk_group, chunkArray);
}

/**
 * "fold": keep an accumulated summary, store final in top-level doc.annotations[job.annotation_field].
 * Also pass preceding & succeeding chunk text around the current chunk.
 *
 * If job.initial_summary is present, seed the accumulation with that.
 */
async function runFoldSummarization(job, topDoc) {
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  const basePrompt = SYSTEM_PROMPTS.fold.replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  const docId = topDoc._doc.id || '(no-id)';

  // -- NEW: use initial_summary if provided, else empty string --
  let accumulatedSummary = job.initial_summary ?? '';

  const beforeCount = job.context_chunks_before ? parseInt(job.context_chunks_before, 10) : 0;
  const afterCount = job.context_chunks_after ? parseInt(job.context_chunks_after, 10) : 0;

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunk = new JSONDocument(chunkArray[i], topDoc);

    // preceding text
    let precedingText = '';
    if (beforeCount > 0) {
      const startIndex = Math.max(0, i - beforeCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk><!-- id="${chunkDoc._doc.id}" -->`;
        })
        .join('\n\n');
    }

    // succeeding text
    let succeedingText = '';
    if (afterCount > 0) {
      const endIndex = Math.min(chunkArray.length, i + 1 + afterCount);
      const afterSlice = chunkArray.slice(i + 1, endIndex);
      succeedingText = afterSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk><!-- id="${chunkDoc._doc.id}" -->`;
        })
        .join('\n\n');
    }

    const chunkMetadata = JSON.stringify(thisChunk._doc.metadata || {}, null, 2);
    const chunkText = `<chunk id="${thisChunk._doc.id}">\n${thisChunk.getResolvedContent()}\n</chunk><!-- id="${thisChunk._doc.id}" -->`;

    let userContent = `## Document ID: ${docId}\n`;
    if (accumulatedSummary) {
      const stringified = JSON.stringify(accumulatedSummary, null, 2);
      userContent += `## Current accumulated summary:\n${stringified}\n\n---\n\n`;
    }
    if (precedingText) {
      userContent += `## Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `## Current chunk metadata:\n${chunkMetadata}\n\n## Current chunk:\n${chunkText}`;
    if (succeedingText) {
      userContent += `\n\n---\n\n## Succeeding chunk(s):\n${succeedingText}`;
    }

    console.log("## userContent", userContent);

    let transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];
    const llmReply = await callLLM(chatModel, transcript);

    const finalObj = parseLLMReply(llmReply, job);
    accumulatedSummary = finalObj;
    job.chunks_completed++;
  }

  ensureAnnotations(topDoc._doc);
  topDoc._doc.annotations[job.annotation_field] = accumulatedSummary;
}

/**
 * "delta-fold":
 *   - each chunk => produce "delta" JSON
 *   - keep an array of deltas in doc.annotations[job.annotation_field]
 *   - store chunk-level deltas in chunk.annotations[job.annotation_field_delta]
 *   - also pass preceding & succeeding chunk text
 *
 * If job.initial_summary is an array, start with that.
 */
async function runDeltaFoldSummarization(job, topDoc) {
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  const basePrompt = SYSTEM_PROMPTS['delta-fold'].replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  ensureAnnotations(topDoc._doc);

  // If jsonSum=="append", re-use existing summary array if present...
  // But if job.initial_summary is present (and an array), we start there:
  let deltaArray = [];
  if (job.initial_summary && Array.isArray(job.initial_summary)) {
    deltaArray = job.initial_summary;
  } else if (job.jsonSum === 'append' && Array.isArray(topDoc._doc.annotations[job.annotation_field])) {
    deltaArray = topDoc._doc.annotations[job.annotation_field];
  }

  const docId = topDoc._doc.id || '(no-id)';
  const beforeCount = job.context_chunks_before ? parseInt(job.context_chunks_before, 10) : 0;
  const afterCount = job.context_chunks_after ? parseInt(job.context_chunks_after, 10) : 0;

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunk = new JSONDocument(chunkArray[i], topDoc);

    // preceding text
    let precedingText = '';
    if (beforeCount > 0) {
      const startIndex = Math.max(0, i - beforeCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk><!-- id="${chunkDoc._doc.id}" -->`;
        })
        .join('\n\n');
    }

    // succeeding text
    let succeedingText = '';
    if (afterCount > 0) {
      const endIndex = Math.min(chunkArray.length, i + 1 + afterCount);
      const afterSlice = chunkArray.slice(i + 1, endIndex);
      succeedingText = afterSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk><!-- id="${chunkDoc._doc.id}" -->`;
        })
        .join('\n\n');
    }

    const chunkMetadata = JSON.stringify(thisChunk._doc.metadata || {}, null, 2);
    const chunkText = `<chunk id="${thisChunk._doc.id}">\n${thisChunk.getResolvedContent()}\n</chunk><!-- id="${thisChunk._doc.id}" -->`;

    let userContent = `## Document ID: ${docId}\n`;
    userContent += `## Accumulating summary array (so far):\n${JSON.stringify(deltaArray, null, 2)}\n\n`;
    if (precedingText) {
      userContent += `## Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `## Current chunk metadata:\n${chunkMetadata}\n\n## Current chunk:\n${chunkText}`;
    if (succeedingText) {
      userContent += `\n\n---\n\n## Succeeding chunk(s):\n${succeedingText}`;
    }

    console.log("** delta-fold userContent **");
    console.log(userContent);

    let transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];
    const llmReply = await callLLM(chatModel, transcript);

    const newDelta = parseLLMReply(llmReply, job);

    if (!thisChunk._doc.annotations) {
      thisChunk._doc.annotations = {};
    }
    // Store chunk-level delta in job.annotation_field_delta (default: "summary_delta")
    thisChunk._doc.annotations[job.annotation_field_delta] = newDelta;
    chunkArray[i] = thisChunk.toObject();

    if (job.jsonSum === 'append') {
      deltaArray = deltaArray.concat(newDelta);
    } else {
      deltaArray.push(newDelta);
    }
    job.chunks_completed++;
  }

  topDoc.setChunksForGroup(job.chunk_group, chunkArray);
  topDoc._doc.annotations[job.annotation_field] = deltaArray;
}

/**
 * Helper: create a chat model
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
 * Helper: call the LLM with minimal transcript
 */
async function callLLM(chatModel, minimalTranscript) {
  let prefixFrag = {
    messages: minimalTranscript.map(m => ({ role: m.role, content: m.content }))
  };

  const suffixFrag = await chatModel.extendTranscript(prefixFrag);
  const lastMsg = suffixFrag.messages[suffixFrag.messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') {
    return '(No output from LLM?)';
  }
  return lastMsg.content;
}

const router = express.Router();

/**
 * POST /summaries
 *
 * Request fields:
 *   - document: the doc object
 *   - method: "full", "map", "fold", or "delta-fold"
 *   - chunk_group: which chunk group to use (pages, paragraphs, etc.) for map/fold/delta-fold
 *   - context_chunks_before: how many prior chunks to pass in as context
 *   - context_chunks_after: how many subsequent chunks to pass in as context
 *   - model: which LLM to use
 *   - guidance: text instructions
 *   - temperature: numeric
 *   - json_schema: optional (the JSON schema for structured output)
 *   - json_sum: optional, controls how "delta" merges with existing summary (default: "append")
 *   - initial_summary: optional, seeds fold/delta-fold accumulation
 *
 *   - annotation_field: (string) default "summary"; doc-level or chunk-level summary field
 *   - annotation_field_delta: (string) default "summary_delta"; chunk-level field for "delta-fold" partial summaries
 */
router.post('/', async (req, res) => {
  try {
    const {
      document,
      method,
      chunk_group,
      context_chunks_before,
      context_chunks_after,
      model,
      guidance,
      temperature,
      json_schema,
      json_sum,
      initial_summary,

      // NEW fields controlling the annotation names to store into:
      annotation_field = 'summary',
      annotation_field_delta = 'summary_delta'
    } = req.body;

    if (!document || !method) {
      return res.status(400).json({ error: 'document and method are required' });
    }

    // create the job
    const job = createJobRecord(document, {
      method,
      chunk_group,
      context_chunks_before,
      context_chunks_after,
      model: model || 'gpt-4o',
      guidance: guidance || '',
      temperature: temperature || 0.7,
      jsonSchema: json_schema || null,
      jsonSum: json_sum || 'append',
      initial_summary: initial_summary ?? null,

      // store the annotation fields
      annotation_field,
      annotation_field_delta
    });

    // run in background
    processSummarizeAsync(job).catch(err => {
      job.status = 'error';
      job.error = String(err);
      console.error('Summarize job error:', err);
    });

    // Return 202 with Location
    return res
      .status(202)
      .location(`/summaries/${job.id}`)
      .json({ job_id: job.id });
  } catch (error) {
    console.error('POST /summaries error:', error);
    res.status(500).json({ error: String(error) });
  }
});

/**
 * GET /summaries/:jobId
 */
router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }

  if (job.status === 'pending' || job.status === 'processing') {
    return res.json({
      status: job.status,
      chunks_total: job.chunks_total,
      chunks_completed: job.chunks_completed
    });
  }
  if (job.status === 'error') {
    return res.json({
      status: 'error',
      error: job.error,
      chunks_total: job.chunks_total,
      chunks_completed: job.chunks_completed
    });
  }
  // complete
  return res.json({
    status: 'complete',
    chunks_total: job.chunks_total,
    chunks_completed: job.chunks_completed
  });
});

/**
 * GET /summaries/:jobId/result
 */
router.get('/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  if (job.status === 'pending' || job.status === 'processing') {
    return res.status(202).json({
      status: job.status,
      chunks_total: job.chunks_total,
      chunks_completed: job.chunks_completed
    });
  }
  if (job.status === 'error') {
    return res.status(500).json({
      status: 'error',
      error: job.error,
      chunks_total: job.chunks_total,
      chunks_completed: job.chunks_completed
    });
  }
  // if complete:
  return res.json(job.summarizedDoc || {});
});

/**
 * DELETE /summaries/:jobId
 */
router.delete('/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobs[jobId]) {
    return res.status(404).json({ error: 'No such job_id' });
  }
  delete jobs[jobId];
  res.json({ success: true });
});

export default router;
