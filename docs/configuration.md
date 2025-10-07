# Synopsis

How to configure charmonator.

# Overview

Charmonator accepts a configuration file.

At minimum, you’ll want to define:

- A "models" object with at least one named model (including "api", "model", and (if needed) "api_key").
- A "server" object with "port" if you wish to change the default port.
- Optionally, define "tools" if you want to enable function-calling / tool usage from your models.

You can store secrets in a separate config.secret.json. During runtime, Charmonator merges the two configs. Then each model can be referenced by its "model identifier" in your requests to charmonator.

Optionally, beside config.json, you may place a config.secret.json dedicated to api keys, so that config.json is easier to manage.

# Reference

By default, the file is located relative to the source tree at ```conf/config.json```.

Below is a complete reference of all recognized keys, along with what they control and the typical defaults/usage.

## Top-level keys

- default_system_message
  - A fallback system prompt if a model does not specify its own "system" message.
  - String.
  - Default: "You are a helpful assistant."

- default_temperature
  - A fallback temperature if a model does not specify its own "temperature."
  - Number in [0.0 - 2.0], though typical usage is 0.0 - 1.0.
  - Default: 0.8.

- server
  - An object containing settings for the HTTP server and path prefixes.
  - Keys within server:
    - port
      - Number for which port to run Charmonator on.
      - Defaults to 5002 if not set (though the code checks for 5003 in some places as well).
    - baseUrl
      - A path prefix for hosting the APIs under some subpath (e.g. "/charm").
      - Default: "" (empty string, meaning root-level).
    - charmonator
      - Object specifying how to publish charmonator endpoints. Typically has:
         - apiPath: default "api/charmonator"
         - apiVersion: default "v1"
      - The final available path to the charmonator endpoints will be baseUrl + apiPath + apiVersion.
    - charmonizer
      - Object specifying how to publish charmonizer endpoints. Typically has:
         - apiPath: default "api/charmonizer"
         - apiVersion: default "v1"
      - The final available path to the charmonizer endpoints will be baseUrl + apiPath + apiVersion.
    - jobsDir
      - A path where charmonizer can store job-related output, e.g. for multi-step summarization.
      - Defaults to "./jobs" or a user-specific directory if not set.

- tools
  - An object that defines named “tools” (a.k.a. function calls) that a model can access.
  - The key is the tool’s name; the value is an object describing how to load it. For example:
```
    {
      "web_search": {
        "code": "../tools/web_search_tool.mjs",
        "class": "WebSearchTool",
        "options": { "default_api": "duckduckgo" }
      },
      "calculator": {
        "code": "../tools/calculator.mjs"
        // If there is a default export with a known class name
      }
    }
```
  - Each tool object typically includes:
    - code: the relative path to the JavaScript module implementing the tool.
    - class: the exported class name (if the file has multiple exports).
    - options: any JSON object with config for that tool.
  - Tools can be referenced by any model under its "tools" array.

## Model-level keys
  - An object containing one or more named models. Each key is the “model identifier” that you will pass to charmonator or your client code.
  - The value is an object describing how to connect to a particular generative model. Each model object supports the following fields:

    - api  (REQUIRED)
      - Which backend to use; must be one of:
        "OpenAI", "OpenAI_Azure", "Anthropic", "ollama", (planned: "Google", etc.)

    - model_type
      - The broad type of the model’s usage, typically "chat" or "text" or "embedding".
      - Used internally to route calls (e.g., chat-based vs. embeddings).

    - model
      - The name of the model to use (e.g. "gpt-4", "gpt-3.5-turbo", "claude-2", …).
      - For Azure OpenAI, this can be set to match the underlying model name, but note that "deployment" is often used (see below).

    - api_key
      - The API key for this model (if relevant). You can omit it here if you plan to store it in conf/config.secret.json or another secure location.

    - system
      - A model-specific system message to inject at the start of chats. Overrides default_system_message if present.
      - String.

    - temperature
      - A model-specific temperature override. If omitted, fallback is default_temperature.
      - Number in [0.0 - 2.0].

    - tools
      - An array of tool names (strings) that you have declared at config.tools.
      - The model will be able to make function calls referencing those tool names.

    - context_size / max_tokens / output_limit
      - (Optional) Fields used by various model providers to specify maximum context length or maximum tokens in the response.
      - For instance, "context_size" might be used for OpenAI or local LLM, "max_tokens" for Anthropic, etc.

    - reasoning
      - (Optional) Object used for advanced control in certain special flavored models. For instance,
        { "effort": "high" }
        - This is mostly relevant if you’re using special “reasoning” model variants from some providers.

    - Additional backend-specific fields:

       - OpenAI_Azure-specific:
         - endpoint: The full Azure endpoint root, e.g. "https://my-azure.openai.azure.com/openai/deployments/"
         - api_version: The date-based API version string, e.g. "2023-07-01-preview"
         - deployment: The deployment name within Azure for the model

       - Ollama-specific:
         - host: The host:port for your local Ollama service, e.g. "http://127.0.0.1:11434"

       - Anthropic-specific:
         - model: e.g. "claude-2"
         - max_tokens: number of tokens to target, for instance 8192

       - (Planned) Google-specific:
         - no stable fields documented yet, but typically includes "model" (such as "gemini-2.0-xyz")

    - Example minimal usage for an OpenAI Chat model might be:
      {
        "api": "OpenAI",
        "model_type": "chat",
        "model": "gpt-3.5-turbo",
        "api_key": "OPENAI_API_KEY",
        "system": "You are a helpful OpenAI assistant."
      }

--------------------------------------------------------------------------------
## Secret config file (config.secret.json)

By default, if you have a file named config.secret.json alongside config.json (e.g. conf/config.secret.json), the server will load it and merge its fields so that secrets (like "api_key") override what’s in the main config.  Using config.secret.json lets you share your main config more freely while reducing the risk of leaking credentials.

To use ```config.secret.json```, under each model requiring api keys, use the "api_key" field to store the api key.  While you are free to put the api_key field in your `config.json`, we recommend putting secrets in the separate file `conf/config.secret.json`, so that you can share your `config.json` more freely.  Here is an example of how to use a `conf/config.secret.json`:

```
{
    "models":
    {
        "my-openai-model": {
            "api_key": "sk-..."
        }
    }
}
```

If you choose an alternative location for your config.json, config.secret.json will be checeked there.

--------------------------------------------------------------------------------
## Environment variable override

- CHARMONATOR_CONFIG
  - If set, the server will load configuration from that JSON file instead of ./conf/config.json.
  - Example: export CHARMONATOR_CONFIG=/path/to/custom-config.json


# Examples

This server loads models from a top-level `"models"` object in `conf/config.json`, where each key is a **model identifier** (e.g. `"gpt-4o"`, `"my-azure-model"`, etc.). 

In all examples, the comments shown in the documentation must be removed to conform with standard JSON parsing.

Each model entry must have at least:

- **`api`**: which backend to use (`"OpenAI"`, `"OpenAI_Azure"`, `"Anthropic"`, or `"ollama"`).
- **`model`**: the model name or deployment name.
- **`api_key`** (where relevant).
- Optionally, a custom **`system`** message, **`temperature`**, **`tools`** array, etc.

Alternatively, you may store your configuration file at a location of your choice specified by the environment variable CHARMONATOR_CONFIG.


### 1) Minimal Example for **OpenAI** (Chat Completion)

```jsonc
{
  "models": {
    "my-openai-model": {
      "api": "OpenAI",
      "model_type": "chat",

      "api_key": "OPENAI_API_KEY_HERE_OR_IN_SECRET_JSON",
      "model": "gpt-3.5-turbo",  // or "gpt-4"

      "temperature": 0.8,
      "context_size": 8192,
      "output_limit": 2048,

      "max_attempts": 2,
      "ms_timeout": 600000,      // 10 minutes per request

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

      "api_key": "AZURE_OPENAI_KEY_HERE_OR_IN_SECRET_JSON",
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

      "api_key": "ANTHROPIC_API_KEY_HERE_OR_IN_SECRET_JSON",
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
