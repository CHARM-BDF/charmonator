#!/usr/bin/env node

/**
 * create-default-config.js
 *
 * A simple script to generate a basic config.json object with:
 *  - default server settings,
 *  - two sample tools,
 *  - three example models (OpenAI, Anthropic, Ollama).
 * 
 * Instead of writing to a file, it prints the JSON to stdout.
 */

const defaultConfig = {
  "default_system_message": "You are a helpful assistant.",
  "default_temperature": 0.8,

  "server": {
    "port": 5002,
    "baseUrl": "/charm",
    "charmonator": {
      "apiPath": "api/charmonator",
      "apiVersion": "v1"
    },
    "charmonizer": {
      "apiPath": "api/charmonizer",
      "apiVersion": "v1"
    },
    "jobsDir": "./jobs"
  },

  "tools": {
    "web_search": {
      "code": "./tools/web_search_tool.mjs",
      "class": "WebSearchTool",
      "options": {
        "default_api": "duckduckgo"
      }
    },
    "calculator": {
      "code": "./tools/calculator.mjs"
    }
  },

  "models": {
    "my-openai-model": {
      "api": "OpenAI",
      "model_type": "chat",

      // Provide your real key here:
      "api_key": "OPENAI_API_KEY_HERE",
      "model": "gpt-3.5-turbo",

      "temperature": 0.7,
      "context_size": 4096,
      "system": "You are a standard OpenAI-based model example."
    },

    "my-anthropic-model": {
      "api": "Anthropic",
      "model_type": "chat",

      // Provide your real key here:
      "api_key": "ANTHROPIC_API_KEY_HERE",
      "model": "claude-2",

      "temperature": 0.7,
      "max_tokens": 8192,
      "system": "You are a Claude-based model example."
    },

    "my-ollama-model": {
      "api": "ollama",
      "model_type": "chat",

      // Typically no key needed for Ollama:
      "host": "http://127.0.0.1:11434",
      "model": "llama2-7b-uncensored",

      "temperature": 0.6,
      "system": "You are a locally hosted model using Ollama."
    }
  }
};

console.log(JSON.stringify(defaultConfig, null, 2));
