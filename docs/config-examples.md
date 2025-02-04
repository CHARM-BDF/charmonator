## Example `config.json` Entries for Each Backend

This server loads models from a top-level `"models"` object in `conf/config.json`, where each key is a **model identifier** (e.g. `"gpt-4o"`, `"my-azure-model"`, etc.). Each model entry must have at least:

- **`api`**: which backend to use (`"OpenAI"`, `"OpenAI_Azure"`, `"Anthropic"`, or `"ollama"`).
- **`model`**: the model name or deployment name.
- **`api_key`** (where relevant).
- Optionally, a custom **`system`** message, **`temperature`**, **`tools`** array, etc.

> **Note**: In all examples below, you’ll see `"api_key"` fields. Be sure to set them to your actual keys in practice. For any environment-based or secret management, you can read them in from environment variables or a secure store.

### 1) Minimal Example for **OpenAI** (Chat Completion)

```jsonc
{
  "models": {
    "my-openai-model": {
      "api": "OpenAI",
      "model_type": "chat",

      "api_key": "OPENAI_API_KEY_HERE",
      "model": "gpt-3.5-turbo",  // or "gpt-4"

      "temperature": 0.8,
      "context_size": 8192,
      "output_limit": 2048,

      // Optional: system message
      "system": "You are a helpful assistant."
    }
  }
}
```

Here:
- `api`: `"OpenAI"` signals use of standard OpenAI Chat endpoints.
- `model`: an OpenAI model name like `"gpt-3.5-turbo"` or `"gpt-4"`.
- `api_key`: your secret key from your OpenAI account.
- `model_type`: typically `"chat"`.
- `system`: an optional system message used as context for the model.
- `tools`: if you want to enable tools, supply an array of tool names from your config.

---

### 2) Example for **Azure OpenAI**

To use Azure’s flavor of OpenAI, you can set `"api": "OpenAI_Azure"`, plus additional fields like `"endpoint"` and `"deployment"`. For example:

```jsonc
{
  "models": {
    "my-azure-model": {
      "api": "OpenAI_Azure",
      "model_type": "chat",

      "api_key": "AZURE_OPENAI_KEY_HERE",
      "endpoint": "https://my-azure-openai-resource.openai.azure.com/openai/deployments/",
      "api_version": "2023-07-01-preview",

      "deployment": "my-gpt4-deployment-name",  
      "model": "gpt-4",     // can be used if needed, or just rely on `deployment`

      "temperature": 0.7,
      "system": "You are an Azure-hosted model with potential limited context."
    }
  }
}
```

Here:
- `api`: `"OpenAI_Azure"`.
- `endpoint`: your Azure OpenAI endpoint base URL (often ends in `.azure.com/openai/deployments/`).
- `deployment`: the name of your model deployment within Azure.
- `api_version`: the date-based API version from Azure.
- `api_key`: your Azure key from the portal.

---

### 3) Example for **Anthropic** (Claude)

```jsonc
{
  "models": {
    "my-claude-model": {
      "api": "Anthropic",
      "model_type": "chat",

      "api_key": "ANTHROPIC_API_KEY_HERE",
      "model": "claude-2",   // or "claude-instant-1"

      "temperature": 0.8,
      "max_tokens": 8192,

      "system": "You are a helpful assistant with full knowledge of current events."
    }
  }
}
```

Here:
- `api`: `"Anthropic"` signals that we’re using the Anthropic client (Claude).
- `api_key`: your Claude/Anthropic key.
- `model`: e.g. `"claude-2"`, `"claude-instant-1"`, etc.
- `max_tokens`: optional override for token usage.

---

### 4) Example for **Ollama** 

```jsonc
{
  "models": {
    "my-ollama-model": {
      "api": "ollama",
      "model_type": "chat",

      // No api_key needed for Ollama by default:
      // Some local Ollama distributions may not require a key.

      "host": "http://127.0.0.1:11434",
      "model": "llama2-7b-uncensored", 

      "temperature": 0.6,

      // You can embed a system message as well
      "system": "You are a locally hosted LLM using Ollama."

      // "tools": ["web_search", ...] - if you want to enable a tool
    }
  }
}
```

Here:
- `api`: `"ollama"` means local calls to an Ollama server at `host`.
- `model`: the local model name installed under Ollama.
- Usually no `api_key` is needed, though you do specify the `host` where Ollama is running.

---

### Additional `config.json` Structure

When building a complete `config.json`, you may also include:

- **Top-level** fields:
  ```jsonc
  {
    "default_system_message": "You are a helpful assistant.",
    "default_temperature": 0.8,
    
    "server": {
      "port": 5002,
      "baseUrl": "/ai2",
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

    // Tools can be declared here, so you can reference them in a model’s "tools" array:
    "tools": {
      "web_search": {
        "code": "../tools/web_search_tool.mjs",
        "class": "WebSearchTool",
        "options": { "default_api": "duckduckgo" }
      },
      "calculator": {
        "code": "../tools/calculator.mjs"
        // if there's a default export class named "CalculatorTool"
      }
    },

    // Then define "models"...
    "models": {
      // ... examples from above ...
    }
  }
  ```
  
- The **`tools`** section declares each tool (or toolbox). In a given model’s entry, you can specify an array of tool names like:  
  ```jsonc
  {
    "models": {
      "gpt-4-with-tools": {
        "api": "OpenAI",
        "api_key": "OPENAI_API_KEY",
        "model": "gpt-4",
        "tools": ["web_search", "calculator"]
      }
    }
  }
  ```

- The code will then automatically load and enable those named tools for that model.

---

**In summary**, each **model** key in `config.json` must specify:
- `"api"`: which backend,
- `"model"`: actual model name / deployment,
- `"api_key"` if needed,
- optional fields like `"system"`, `"temperature"`, `"tools"`, etc.

The snippet examples above should get you started for each major backend.
