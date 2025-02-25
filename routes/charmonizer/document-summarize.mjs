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

<guidance>
<user-provided guidance>
</guidance>
`,
  map: `
You are a document summarization assistant.

The document has been broken down into chunks.

You will produce a summary for exactly one chunk.

(You may also be given some preceding chunks for context, and possibly succeeding chunks.)

When summarizing, follow the provided guidance.

<guidance>
<user-provided guidance>
</guidance>
`,
  fold: `
You are a document summarization assistant.

The document has been broken down into chunks.

You will be provided:
 1. a chunk of the document
 2. an accumulated summary so far.

You must produce an updated accumulated summary in the same format, integrating what’s new from this chunk, but not removing any important information from the accumulated summary.

When summarizing, follow the guidance.

<user-provided guidance>
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

<guidance>
<user-provided guidance>
</guidance>
`,

  //
  // For the second-phase merge of “map-merge” mode:
  //
  'map-merge': `
You are a document summarization assistant.

You are given **two partial summaries**. Your goal is to merge these two summaries into a single, combined summary.

You will also be given extra guidance from the user on how to merge them. Carefully follow that guidance. 

Provide only the merged summary.
`,

  //
  // For merge-only mode (pre-existing summaries):
  //
  'merge': `
You are a document summarization assistant.

You have a set of chunks, each of which already has a partial summary.
Your job is to merge these partial summaries into a single, comprehensive final summary.

You will also be given guidance on how to merge them if the user provides it.

Provide only the merged summary.
`
};

/**
 * Helper that forcibly instructs the model to output valid JSON if `job.jsonSchema` is present.
 */
function buildSystemPrompt(modePrompt, job) {
  const base = modePrompt.replace('<user-provided guidance>', job.guidance || '');
  // If no JSON schema requested, just return base prompt:
  if (!job.jsonSchema) {
    return base;
  }

  // If user provided a JSON schema, embed it in the system instructions:
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

async function processSummarizeAsync(job) {
  job.status = 'processing';

  // Default merge_mode if not set:
  if (!job.merge_mode) {
    job.merge_mode = 'left-to-right';
  }

  const topDoc = new JSONDocument(job.docObject);

  // Initialize chunk counts:
  switch (job.method) {
    case 'full':
      job.chunks_total = 1;
      break;
    case 'map':
    case 'fold':
    case 'delta-fold':
    case 'map-merge':
    case 'merge': {
      const chunkArr = topDoc.getChunksForGroup(job.chunk_group) || [];
      job.chunks_total = chunkArr.length;
      break;
    }
    default:
      throw new Error(`Unsupported summarization method: ${job.method}`);
  }

  console.log(`Starting summarization job ${job.id} with method ${job.method}...`);
  console.log(`  - Document ID: ${topDoc._doc.id || '(no-id)'}`);
  console.log("job:", job); 

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
      case 'merge':
        await runMergeSummarization(job, topDoc);
        break;
      case 'map-merge':
        await runMapMergeSummarization(job, topDoc);
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
 * We also strip triple-backtick code fences before calling JSON.parse.
 */
function parseLLMReply(rawText, job) {
  if (!job.jsonSchema) {
    // not using structured JSON mode, just return raw text
    return rawText;
  }

  let cleaned = rawText;
  try {
    cleaned = cleaned.trim();
    // remove leading ``` or ```json
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '');
    // remove trailing ```
    cleaned = cleaned.replace(/```$/, '').trim();
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
 * Summarize the entire doc with one LLM call, store in top-level doc.annotations.
 */

async function runFullSummarization(job, topDoc) {
  const fullContent = topDoc.getResolvedContent();
  const basePrompt = SYSTEM_PROMPTS.full.replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  const docId = topDoc._doc.id || '(no-id)';
  const docMetadata = JSON.stringify(topDoc._doc.metadata || {}, null, 2);

  const transcript = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `## Document ID: ${docId}\n## Document metadata:\n${docMetadata}\n\n## Full document contents:\n${fullContent}`
    }
  ];

  // ADJUST so we wrap job.jsonSchema with type: 'json_schema'
  const options = job.jsonSchema
    ? { response_format: { type: 'json_schema', json_schema: { name: 'forced-schema', schema: job.jsonSchema } } }
    : {};

  const assistantReply = await callLLM(chatModel, transcript, options);
  const finalData = parseLLMReply(assistantReply, job);

  ensureAnnotations(topDoc._doc);
  topDoc._doc.annotations[job.annotation_field] = finalData;
  job.chunks_completed = 1;
}



/**
 * Summarize each chunk separately. Partial summary is stored in chunk.annotations[job.annotation_field].
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
  const beforeCount = parseInt(job.context_chunks_before || 0, 10);
  const afterCount = parseInt(job.context_chunks_after || 0, 10);

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunkDoc = new JSONDocument(chunkArray[i], topDoc);

    // gather preceding text
    let precedingText = '';
    if (beforeCount > 0) {
      const startIndex = Math.max(0, i - beforeCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk>`;
        })
        .join('\n\n');
    }

    // gather succeeding text
    let succeedingText = '';
    if (afterCount > 0) {
      const endIndex = Math.min(chunkArray.length, i + 1 + afterCount);
      const afterSlice = chunkArray.slice(i + 1, endIndex);
      succeedingText = afterSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk>`;
        })
        .join('\n\n');
    }

    const chunkMetadata = JSON.stringify(thisChunkDoc._doc.metadata || {}, null, 2);
    const chunkText = `<chunk id="${thisChunkDoc._doc.id}">\n${thisChunkDoc.getResolvedContent()}\n</chunk>`;

    let userContent = `## Document ID: ${docId}\n`;
    if (precedingText) {
      userContent += `## Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `## Current chunk metadata:\n${chunkMetadata}\n\n## Current chunk:\n${chunkText}`;
    if (succeedingText) {
      userContent += `\n\n---\n\n## Succeeding chunk(s):\n${succeedingText}`;
    }

    const transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const assistantReply = await callLLM(chatModel, transcript);
    const finalData = parseLLMReply(assistantReply, job);

    ensureAnnotations(thisChunkDoc._doc);
    thisChunkDoc._doc.annotations[job.annotation_field] = finalData;
    chunkArray[i] = thisChunkDoc.toObject();

    job.chunks_completed++;
  }
  topDoc.setChunksForGroup(job.chunk_group, chunkArray);
}

/**
 * "fold" mode: accumulative summarization across each chunk in sequence.
 */
async function runFoldSummarization(job, topDoc) {
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  const basePrompt = SYSTEM_PROMPTS.fold.replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  const docId = topDoc._doc.id || '(no-id)';
  let accumulatedSummary = job.initial_summary ?? '';

  const beforeCount = parseInt(job.context_chunks_before || 0, 10);
  const afterCount = parseInt(job.context_chunks_after || 0, 10);

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunkDoc = new JSONDocument(chunkArray[i], topDoc);

    // preceding text
    let precedingText = '';
    if (beforeCount > 0) {
      const startIndex = Math.max(0, i - beforeCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk>`;
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
          return `<chunk id="${chunkDoc._doc.id}">\n${chunkDoc.getResolvedContent()}\n</chunk>`;
        })
        .join('\n\n');
    }

    const chunkMetadata = JSON.stringify(thisChunkDoc._doc.metadata || {}, null, 2);
    const chunkText = `<chunk id="${thisChunkDoc._doc.id}">\n${thisChunkDoc.getResolvedContent()}\n</chunk>`;

    let userContent = `## Document ID: ${docId}\n`;
    if (accumulatedSummary) {
      userContent += `## Current accumulated summary:\n${JSON.stringify(accumulatedSummary, null, 2)}\n\n---\n\n`;
    }
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

    const llmReply = await callLLM(chatModel, transcript);
    const finalObj = parseLLMReply(llmReply, job);
    accumulatedSummary = finalObj;
    job.chunks_completed++;
  }

  ensureAnnotations(topDoc._doc);
  topDoc._doc.annotations[job.annotation_field] = accumulatedSummary;
}

/**
 * "delta-fold": each chunk => produce a "delta" only with new info. 
 * The final doc-level summary is an array of these deltas.
 */
async function runDeltaFoldSummarization(job, topDoc) {
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  const basePrompt = SYSTEM_PROMPTS['delta-fold'].replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  ensureAnnotations(topDoc._doc);

  // If jsonSum=="append", re-use existing summary array if present
  let deltaArray = [];
  if (job.initial_summary && Array.isArray(job.initial_summary)) {
    deltaArray = job.initial_summary;
  } else if (job.jsonSum === 'append' && Array.isArray(topDoc._doc.annotations[job.annotation_field])) {
    deltaArray = topDoc._doc.annotations[job.annotation_field];
  }

  const docId = topDoc._doc.id || '(no-id)';
  const beforeCount = parseInt(job.context_chunks_before || 0, 10);
  const afterCount = parseInt(job.context_chunks_after || 0, 10);

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunkDoc = new JSONDocument(chunkArray[i], topDoc);

    let precedingText = '';
    if (beforeCount > 0) {
      const startIndex = Math.max(0, i - beforeCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="\${chunkDoc._doc.id}">\n\${chunkDoc.getResolvedContent()}\n</chunk>`;
        })
        .join('\n\n');
    }

    let succeedingText = '';
    if (afterCount > 0) {
      const endIndex = Math.min(chunkArray.length, i + 1 + afterCount);
      const afterSlice = chunkArray.slice(i + 1, endIndex);
      succeedingText = afterSlice
        .map(chObj => {
          const chunkDoc = new JSONDocument(chObj, topDoc);
          return `<chunk id="\${chunkDoc._doc.id}">\n\${chunkDoc.getResolvedContent()}\n</chunk>`;
        })
        .join('\n\n');
    }

    const chunkMetadata = JSON.stringify(thisChunkDoc._doc.metadata || {}, null, 2);
    const chunkText = `<chunk id="${thisChunkDoc._doc.id}">\n${thisChunkDoc.getResolvedContent()}\n</chunk>`;

    let userContent = `## Document ID: ${docId}\n`;
    userContent += `## Accumulating summary array (so far):\n${JSON.stringify(deltaArray, null, 2)}\n\n`;
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
    const llmReply = await callLLM(chatModel, transcript);

    const newDelta = parseLLMReply(llmReply, job);

    ensureAnnotations(thisChunkDoc._doc);
    thisChunkDoc._doc.annotations[job.annotation_field_delta] = newDelta;
    chunkArray[i] = thisChunkDoc.toObject();

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

/* ---------------------------------------------------------------
   NEW MODE: "merge" (requires pre-existing summaries in each chunk)
   with a "merge_mode" parameter:
   - 'left-to-right' (default)
   - 'hierarchical'
--------------------------------------------------------------- */
async function runMergeSummarization(job, topDoc) {
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  if (!chunkArray || !Array.isArray(chunkArray) || chunkArray.length === 0) {
    throw new Error(`No chunks found in group "${job.chunk_group}", or chunk array is empty.`);
  }

  const basePrompt = SYSTEM_PROMPTS['merge'];
  const systemPrompt = buildSystemPrompt(basePrompt, job);

  // 1) Collect partial summaries:
  const partialSummaries = chunkArray.map(ch => {
    const ann = ch.annotations || {};
    return ann[job.annotation_field] ?? '';
  });

  // 2) Merge them according to merge_mode
  let mergedSummary;
  if (job.merge_mode === 'hierarchical') {
    mergedSummary = await doHierarchicalMergeOfSummaries(job, partialSummaries);
  } else {
    mergedSummary = await doLeftToRightMergeOfSummaries(job, partialSummaries);
  }

  ensureAnnotations(topDoc._doc);
  topDoc._doc.annotations[job.annotation_field] = mergedSummary;
}

/* ---------------------------------------------------------------
   "map-merge": summarization in two phases:
   1) Summarize each chunk (like "map")
   2) Then iteratively merge partial summaries
--------------------------------------------------------------- */
async function runMapMergeSummarization(job, topDoc) {
  //
  // --- 1) Perform map-style summarization on each chunk ---
  //
  const chunkArray = topDoc.getChunksForGroup(job.chunk_group);
  if (!chunkArray || !Array.isArray(chunkArray)) {
    throw new Error(`No chunk group named "${job.chunk_group}" found on document.`);
  }

  const basePrompt = SYSTEM_PROMPTS.map.replace('<user-provided guidance>', job.guidance || '');
  const systemPrompt = buildSystemPrompt(basePrompt, job);
  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  const docId = topDoc._doc.id || '(no-id)';
  const beforeCount = parseInt(job.context_chunks_before || 0, 10);
  const afterCount = parseInt(job.context_chunks_after || 0, 10);

  for (let i = 0; i < chunkArray.length; i++) {
    const thisChunkDoc = new JSONDocument(chunkArray[i], topDoc);

    let precedingText = '';
    if (beforeCount > 0) {
      const startIndex = Math.max(0, i - beforeCount);
      const precedingSlice = chunkArray.slice(startIndex, i);
      precedingText = precedingSlice
        .map(chObj => new JSONDocument(chObj, topDoc).getResolvedContent())
        .join('\n\n');
    }

    let succeedingText = '';
    if (afterCount > 0) {
      const endIndex = Math.min(chunkArray.length, i + 1 + afterCount);
      const afterSlice = chunkArray.slice(i + 1, endIndex);
      succeedingText = afterSlice
        .map(chObj => new JSONDocument(chObj, topDoc).getResolvedContent())
        .join('\n\n');
    }

    const chunkMetadata = JSON.stringify(thisChunkDoc._doc.metadata || {}, null, 2);
    const chunkText = thisChunkDoc.getResolvedContent();

    let userContent = `## Document ID: ${docId}\n`;
    if (precedingText) {
      userContent += `## Preceding chunk(s):\n${precedingText}\n\n---\n\n`;
    }
    userContent += `## Current chunk metadata:\n${chunkMetadata}\n\n## Current chunk:\n${chunkText}`;
    if (succeedingText) {
      userContent += `\n\n---\n\n## Succeeding chunk(s):\n${succeedingText}`;
    }

    const transcript = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const assistantReply = await callLLM(chatModel, transcript);
    const partialSummary = parseLLMReply(assistantReply, job);

    ensureAnnotations(thisChunkDoc._doc);
    thisChunkDoc._doc.annotations[job.annotation_field] = partialSummary;
    chunkArray[i] = thisChunkDoc.toObject();

    job.chunks_completed++;
  }

  // Save updated chunk-level partials
  topDoc.setChunksForGroup(job.chunk_group, chunkArray);

  //
  // --- 2) Merge partial summaries according to merge_mode ---
  //
  const partialSummaries = chunkArray.map(ch => {
    return ch.annotations?.[job.annotation_field] ?? '';
  });

  let mergedSummary;
  if (job.merge_mode === 'hierarchical') {
    mergedSummary = await doHierarchicalMergeOfSummaries(job, partialSummaries);
  } else {
    mergedSummary = await doLeftToRightMergeOfSummaries(job, partialSummaries);
  }

  ensureAnnotations(topDoc._doc);
  topDoc._doc.annotations[job.annotation_field] = mergedSummary;
}

/**
 * Helper: merges an array of partial summaries left-to-right in one pass.
 */
async function doLeftToRightMergeOfSummaries(job, partialSummaries) {
  if (partialSummaries.length === 0) {
    return '';
  }
  let mergedSummary = partialSummaries[0];
  job.chunks_completed++; // treat first chunk's summary as "processed"

  for (let i = 1; i < partialSummaries.length; i++) {
    mergedSummary = await doPairwiseMergeOfSummaries(
      job,
      mergedSummary,
      partialSummaries[i],
      i
    );
    job.chunks_completed++;
  }
  return mergedSummary;
}

/**
 * Helper: merges an array of partial summaries hierarchically (like merge-sort).
 */
async function doHierarchicalMergeOfSummaries(job, partialSummaries) {
  if (partialSummaries.length === 0) {
    return '';
  }
  if (partialSummaries.length === 1) {
    // We can consider that as one chunk "completed"
    job.chunks_completed++;
    return partialSummaries[0];
  }

  const mid = Math.floor(partialSummaries.length / 2);
  const left = partialSummaries.slice(0, mid);
  const right = partialSummaries.slice(mid);

  // Recursively merge each half
  const mergedLeft = await doHierarchicalMergeOfSummaries(job, left);
  const mergedRight = await doHierarchicalMergeOfSummaries(job, right);

  // Now pairwise merge the two halves
  const final = await doPairwiseMergeOfSummaries(job, mergedLeft, mergedRight, 0);
  job.chunks_completed++; // we performed one more merge step

  return final;
}

/**
 * Helper: merges two partial summaries using job.merge_summaries_guidance.
 */
async function doPairwiseMergeOfSummaries(job, summaryA, summaryB, mergeIndex = 0) {
  const mergePromptBase = SYSTEM_PROMPTS['map-merge']; // or we can reuse it for both "merge" and "map-merge"
  const systemPrompt = buildSystemPrompt(mergePromptBase, job);

  const chatModel = makeChatModel(job.model, systemPrompt, job.temperature);

  const userContent = `
We have two partial summaries that need merging:

--- Summary A ---
${JSON.stringify(summaryA, null, 2)}

--- Summary B ---
${JSON.stringify(summaryB, null, 2)}

Additional user guidance on how to merge:
${job.merge_summaries_guidance || '(No extra merge guidance provided)'}

Please produce a single merged summary:
`;

  const transcript = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  const assistantReply = await callLLM(chatModel, transcript);
  const merged = parseLLMReply(assistantReply, job);

  return merged;
}

/**
 * Helper: create a chat model from a named config
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
 * 
 * Changed to accept an optional `options` object, 
 * which we pass as the fourth argument to `extendTranscript`.
 */
async function callLLM(chatModel, minimalTranscript, options = {}) {
  console.log("minimalTranscript:", minimalTranscript);

  const prefixFrag = {
    messages: minimalTranscript.map(m => ({ role: m.role, content: m.content }))
  };

  const suffixFrag = await chatModel.extendTranscript(prefixFrag, undefined, undefined, options);
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
 *   - method: "full", "map", "fold", "delta-fold", "map-merge", or "merge"
 *   - chunk_group: which chunk group to use (required unless "full")
 *   - context_chunks_before, context_chunks_after: how many prior/succeeding chunks for context
 *   - model: which LLM to use
 *   - guidance: text instructions for summarization
 *   - temperature: numeric
 *   - json_schema: optional (the JSON schema for structured output)
 *   - json_sum: optional, controls how "delta" merges with existing summary (default: "append")
 *   - initial_summary: optional, seeds fold/delta-fold accumulation
 *   - annotation_field: (string) default "summary"
 *   - annotation_field_delta: (string) default "summary_delta"
 *
 *   - merge_summaries_guidance: (string) used by "map-merge" and "merge" modes, with instructions for merging partial summaries
 *   - merge_mode: (string) either "left-to-right" (default) or "hierarchical" for how partial summaries are combined
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

      annotation_field = 'summary',
      annotation_field_delta = 'summary_delta',

      merge_summaries_guidance,
      merge_mode
    } = req.body;

    if (!document || !method) {
      return res.status(400).json({ error: 'document and method are required' });
    }

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

      annotation_field,
      annotation_field_delta,

      merge_summaries_guidance: merge_summaries_guidance || '',
      merge_mode: merge_mode || 'left-to-right'
    });

    // run in background
    processSummarizeAsync(job).catch(err => {
      job.status = 'error';
      job.error = String(err);
      console.error('Summarize job error:', err);
    });

    // Return 202 with job ID
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
