// File: core.mjs

import fetch from 'node-fetch';
import { getModelConfig, getConfig, getServerPort, getFullCharmonatorApiPrefix } from './config.mjs';

import { OpenAIProvider } from './providers/provider_openai.mjs';
import { AnthropicProvider } from './providers/provider_anthropic.mjs';
import { OllamaProvider } from './providers/provider_ollama.mjs';

// Import other providers as needed

export function createDefaultChatProvider() {
  const cfg = getConfig();
  const defaultModelName = cfg.default_chat_model;
  const modelConfig = getModelConfig(defaultModelName);
  return fetchProvider(modelConfig);
}

export function fetchProvider(modelConfigOrName) {
  const modelConfig = typeof modelConfigOrName === 'string'
    ? getModelConfig(modelConfigOrName)
    : modelConfigOrName;

  const ProviderClass = fetchProviderConstructor(modelConfig);
  return new ProviderClass(modelConfig);
}

function fetchProviderConstructor(modelConfig) {
  const apiName = modelConfig.api;

  switch (apiName) {
    case 'OpenAI':
      return OpenAIProvider;

    case 'Anthropic':
      return AnthropicProvider;

    case 'ollama':
      return OllamaProvider;

    // Add cases for other providers
    default:
      throw new Error(`Unknown API: ${apiName}`);
  }
}

export function fetchChatModel(modelConfigOrName) {
  const provider = fetchProvider(modelConfigOrName);
  return provider.createChatModel();
}

/**
 * Calls the `image_to_markdown` RESTful endpoint with the provided arguments.
 *
 * @param {Object} args - Arguments for the function.
 * @param {string} args.imageUrl - The data URL or remote URL of the image.
 * @param {string} [args.description] - A high-level description of the image/document.
 * @param {string} [args.intent] - The intended use of the transcription.
 * @param {string} [args.graphic_instructions] - Instructions for interpreting graphics.
 * @param {string} [args.preceding_content] - Markdown content preceding this page of the document.
 * @param {string} [args.preceding_context] - Summary of preceding context.
 * @param {string} [args.model] - The vision-capable model to use.
 *
 * @returns {Promise<Object>} The result containing the transcribed Markdown.
 */
export async function imageToMarkdown({
  imageUrl,
  description,
  intent,
  graphic_instructions,
  preceding_content,
  preceding_context,
  model,
}) {
  if (!imageUrl) {
    throw new Error('imageUrl is required');
  }

  // Load config
  const cfg = getConfig();

  // We need a fully-qualified URL for node-fetch:
  // e.g. "http://localhost:5002" plus "/ai2/api/charmonator/v1" etc.
  // If your config stores them separately, build it carefully:
  const port = getServerPort();
  const absoluteUrl = `http://localhost:${port}`;
  const fullUrl = absoluteUrl + getFullCharmonatorApiPrefix() + '/convert/image_to_markdown';

  // Prepare JSON body
  const payload = {
    imageUrl,
    description,
    intent,
    graphic_instructions,
    preceding_content,
    preceding_context,
    model,
  };

  try {
    // Now fetch with the absolute URL
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error calling image_to_markdown:', error);
    throw error;
  }
}

/**
 * Calls the `extend_transcript` endpoint and wraps it as `extendTranscript`.
 *
 * @param {string} model - The model identifier.
 * @param {Object} transcriptPrefix - The prefix transcript to extend.
 *
 * @returns {Promise<Object>} The extended transcript.
 */
export async function extendTranscript(model, transcriptPrefix) {
  if (!model || !transcriptPrefix) {
    throw new Error('Both model and transcriptPrefix are required');
  }

  // Load config
  const cfg = getConfig();

  // Construct the full endpoint URL
  const port = getServerPort();
  const absoluteUrl = `http://localhost:${port}`;
  const fullUrl = absoluteUrl + getFullCharmonatorApiPrefix() + '/chat/extend_transcript';

  // Prepare payload
  const payload = {
    model,
    transcript: transcriptPrefix,
  };

  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error calling extend_transcript:', error);
    throw error;
  }
}
