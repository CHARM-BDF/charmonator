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

The configuration file is searched in the following order (first found wins):
1. Path specified by `CHARMONATOR_CONFIG` environment variable
2. `~/.charmonator/config.json` (user home directory)
3. `./conf/config.json` (relative to the project)

Below is a complete reference of all recognized keys, along with what they control and the typical defaults/usage.

## Model Aliases

Model entries can be either full configuration objects or **string aliases** that point to another model key. This allows you to create shortcuts or versioned aliases:

```json
{
  "models": {
    "openai:gpt-4o": {
      "api": "OpenAI",
      "model_type": "chat",
      "model": "gpt-4o",
      "api_key": "sk-..."
    },
    "gpt-4o": "openai:gpt-4o",
    "default": "gpt-4o"
  }
}
```

In this example:
- `"gpt-4o"` is an alias for `"openai:gpt-4o"`
- `"default"` is an alias for `"gpt-4o"`, which resolves to `"openai:gpt-4o"`

Aliases are resolved recursively, and circular references are detected and will throw an error.

## Top-level keys

- default_system_message
  - A fallback system prompt if a model does not specify its own "system" message.
  - String.
  - Default: "You are a helpful assistant."

- default_temperature
  - A fallback temperature if a model does not specify its own "temperature."
  - Number in [0.0 - 2.0], though typical usage is 0.0 - 1.0.
  - Default: 0.8.

- ms_client_request_timeout
  - Milliseconds to wait before timing out in order to presume a downstream HTTP call may be crashed.  Note that this is the duration of the whole request.
  - Defaults to 600000 (10 minutes).
  - Timeout events are noted in the stdout log.
  - If specified in a model, model value overrides the global value.

- num_client_request_max_attempts
  - Number of times to attempt each downstream HTTP call. Before any timeout, the first call counts as 1 attempt.
  - Defaults to 2.
  - If specified in a model, model value overrides the global value.

- num_schema_repair_max_attempts
  - Enables schema repair and sets the number of repair attempts to allow after a structured JSON answer fails schema validation.  When enabled and a `json_schema` is set, charmonator will not return invalid data with status 200.  It will retry `num_schema_repair_max_attempts` times, and if unsuccessful, will return status 422, and the error payload will contain the most valid attempt attained.  Default value of num_schema_repair_max_attempts="null" disables schema repair and passes through with status 200 any schema-invalid payloads from an LLM.
  - This applies to schema-repair flows driven by transcript extension requests that use `response_format.type = "json_schema"`, and to `/api/charmonizer/v1/summaries` jobs that set `json_schema`.
  - If specified in a model, model value overrides the global value.
  - If specified in a request, request value overrides model and global values.

- num_defective_reply_max_attempts (rare to change)
  - Very occasionally (less than 1 in 10000 calls), some providers will respond to a request without emitting any messages at all, not even empty ones.  We call this a "defective" response.
  - This parameter configures a retry loop around the situation.
  - This setting does not apply to empty responses.
  - Number of times to attempt each downstream HTTP call.  Before any timeout, the first call counts as 1 attempt.
  - The name "attempts after" is for brevity but it's really the number of total attempts.
  - Defaults to 5.

- server
  - An object containing settings for the HTTP server and path prefixes.
  - Keys within server:
    - port
      - Number for which port to run Charmonator on.
      - Defaults to 5003 if not set.
    - api_key
      - Optional API key to protect the Charmonator server endpoints.
      - Can also be stored in `config.secret.json` under `server.api_key`.
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
  - An object that defines **server-side tools** (a.k.a. function calls) implemented as JS modules.
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

- mcp
  - Optional configuration for MCP (Model Context Protocol) tool servers.
  - MCP tools are discovered from external processes (stdio JSON-RPC) and can be exposed under local tool names.
  - Keys within mcp:
    - servers
      - Map of server id → process config.
      - Each server config:
        - command: executable to run (e.g. "node").
        - args: argv array (e.g. ["./mcp-servers/test-server.mjs"]).
        - env: optional environment variables to pass through.
    - tools
      - Map of local tool name → remote mapping.
      - Each tool mapping:
        - server: server id from `mcp.servers`.
        - tool: remote tool name on that server.

Example:

```jsonc
{
  "mcp": {
    "servers": {
      "test": {
        "command": "node",
        "args": ["./mcp-servers/test-server.mjs"],
        "env": {}
      }
    },
    "tools": {
      "echo": { "server": "test", "tool": "echo" },
      "calc": { "server": "test", "tool": "calculator" }
    }
  }
}
```

## Model-level keys
  - An object containing one or more named models. Each key is the “model identifier” that you will pass to charmonator or your client code.
  - The value is an object describing how to connect to a particular generative model. Each model object supports the following fields:

    - api  (REQUIRED)
      - Which backend to use; must be one of:
        "OpenAI", "OpenAI_Azure", "Anthropic", "Anthropic_Bedrock", "ollama", "OpenAI_Compatible", "Google"

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
      - An array of tool names (strings).
      - Entries that match `config.tools` load server-side JS tools.
      - If `config.mcp` is present, entries that do not match `config.tools` are treated as MCP tool names/aliases.

    - num_client_request_max_attempts
      - See top-level key num_client_request_max_attempts.

    - num_schema_repair_max_attempts
      - See top-level key num_schema_repair_max_attempts. This also affects `/summaries` requests that rely on the model.

    - ms_client_request_timeout
      - See top-level key ms_client_request_timeout.

    - context_size / max_tokens / output_limit
      - (Optional) Fields used by various model providers to specify maximum context length or maximum tokens in the response.
      - For instance, "context_size" might be used for OpenAI or local LLM, "max_tokens" for Anthropic, etc.

    - reasoning
      - (Optional) Object used for OpenAI reasoning models (o1, o3, etc.). For instance:
        ```json
        { "effort": "high" }
        ```
      - Valid effort values: "low", "medium", "high"

    - reasoning_effort
      - (Optional) Alternative to `reasoning.effort` for OpenAI reasoning models.
      - Valid values: "low", "medium", "high"

    - verbosity
      - (Optional) Controls verbosity for GPT-5 models.
      - Used when calling gpt-5 or gpt-5-mini.

    - Additional backend-specific fields:

       - OpenAI_Azure-specific:
         - endpoint: The full Azure endpoint root, e.g. "https://my-azure.openai.azure.com/openai/deployments/"
         - api_version: The date-based API version string, e.g. "2023-07-01-preview"
         - deployment: The deployment name within Azure for the model

       - Ollama-specific:
         - host: The host:port for your local Ollama service, e.g. "http://127.0.0.1:11434"
         - num_ctx, think, keep_alive, ollama_options, max_tokens, schema_in_prompt: optional; see "Local models" below.

       - OpenAI_Compatible-specific (LM Studio, llama.cpp, MLX, vLLM, Ollama /v1):
         - base_url (required), api_key (optional), and the quirk flags in "Local models" below.

       - local_only (any api): true or "loopback". See "Local models" below.

       - Anthropic-specific:
         - model: e.g. "claude-3-5-sonnet-latest"
         - max_tokens: number of tokens to target, for instance 8192

       - Anthropic_Bedrock-specific:
         - aws_region: AWS region (e.g., "us-east-1")
         - aws_access_key: AWS access key ID
         - aws_secret_key: AWS secret access key
         - aws_session_token: (optional) session token for temporary static credentials
         - aws_profile: (optional) named AWS profile, including SSO profiles
         - aws_auth: (optional) "static" | "profile" | "default_chain" to force a mode
         - model: Bedrock model ID (e.g., "us.anthropic.claude-3-5-haiku-20241022-v1:0")
         - All aws_* strings support ${ENV_VAR} interpolation; see "Bedrock authentication" below.

       - Google-specific:
         - model: the Gemini model name (e.g. "gemini-2.0-flash", "gemini-1.5-pro")
         - api_key: your Google AI API key (or set GOOGLE_AI_API_KEY env var)
         - system: system instruction for the model
         - generationConfig: (optional) object with generation parameters

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

      // Optional: system message
      "system": "You are a helpful assistant."
    }
  }
}
```

Here:
- `api`: `"OpenAI"` signals use of standard OpenAI Chat endpoints.
- `model`: an OpenAI model name like `"gpt-4o"` or `"gpt-4"`.
- `api_key`: your secret key from your OpenAI account.
- `model_type`: typically `"chat"`.
- `system`: an optional system message used as context for the model.
- `tools`: if you want to enable tools, supply an array of tool names from your config.

#### OpenAI Reasoning Models (o1, o3, etc.)

```jsonc
{
  "models": {
    "my-o3-model": {
      "api": "OpenAI",
      "model_type": "chat",

      "api_key": "OPENAI_API_KEY_HERE_OR_IN_SECRET_JSON",
      "model": "o3",

      "reasoning_effort": "high",  // "low", "medium", or "high"
      "context_size": 128000,
      "output_limit": 16384
    }
  }
}
```

For reasoning models:
- `reasoning_effort`: controls how much reasoning the model performs ("low", "medium", "high")
- Alternatively, use `"reasoning": { "effort": "high" }`
- Note: `temperature` and `stream` are not supported for reasoning models

#### OpenAI GPT-5 Models

```jsonc
{
  "models": {
    "my-gpt5-model": {
      "api": "OpenAI",
      "model_type": "chat",

      "api_key": "OPENAI_API_KEY_HERE_OR_IN_SECRET_JSON",
      "model": "gpt-5",

      "reasoning_effort": "medium",
      "verbosity": "normal"  // optional verbosity control
    }
  }
}
```

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
      "model": "claude-3-5-sonnet-latest",   // or "claude-3-opus-latest"

      "temperature": 0.8,
      "max_tokens": 8192,

      "system": "You are a helpful assistant with full knowledge of current events."
    }
  }
}
```

Here:
- `api`: `"Anthropic"` signals that we're using the Anthropic client (Claude).
- `api_key`: your Claude/Anthropic key.
- `model`: e.g. `"claude-3-5-sonnet-latest"`, `"claude-3-opus-latest"`, etc.
- `max_tokens`: optional override for token usage.

---

### 3b) Example for **Anthropic via AWS Bedrock**

You can also access Anthropic Claude models through AWS Bedrock by using `"api": "Anthropic_Bedrock"`. This uses AWS credentials instead of an Anthropic API key:

```jsonc
{
  "models": {
    "my-bedrock-claude": {
      "api": "Anthropic_Bedrock",
      "model_type": "chat",

      // AWS credentials
      "aws_region": "us-east-1",
      "aws_access_key": "YOUR_AWS_ACCESS_KEY",
      "aws_secret_key": "YOUR_AWS_SECRET_KEY",

      // Bedrock model ID - use inference profile ID for newer models
      "model": "us.anthropic.claude-3-5-haiku-20241022-v1:0",

      "temperature": 0.8,
      "max_tokens": 8192,
      "context_size": 200000,

      "system": "You are a helpful assistant running on AWS Bedrock."
    }
  }
}
```

Here:
- `api`: `"Anthropic_Bedrock"` signals use of the Anthropic Bedrock SDK.
- `aws_region`: the AWS region where Bedrock is available (e.g., `"us-east-1"`).
- `aws_access_key`: your AWS access key ID.
- `aws_secret_key`: your AWS secret access key.
- `model`: the Bedrock model ID (see below for format details).

#### Bedrock authentication

Static keys are one of three ways to authenticate. Accounts that only allow SSO (no long-lived
keys), and containers running under an ECS task role, use the other two:

| Field | Meaning |
| --- | --- |
| `aws_region` | Bedrock region. Unset or empty: the SDK default (`AWS_REGION`, else `us-east-1`). |
| `aws_access_key`, `aws_secret_key` | Static credentials. Used only when both are non-empty. |
| `aws_session_token` | Optional session token to accompany temporary static credentials. |
| `aws_profile` | Named profile from `~/.aws/config`, e.g. an SSO profile (run `aws sso login --profile NAME` first). Resolved with the AWS SDK's `fromIni`, which handles SSO, `role_arn` and `credential_process` profiles. |
| `aws_auth` | Optional explicit mode: `"static"`, `"profile"` or `"default_chain"`. |

Every one of these strings supports `${ENV_VAR}` interpolation (an unset variable becomes empty).

Without `aws_auth`, the mode is chosen as follows:

1. **static** if `aws_access_key` and `aws_secret_key` are both non-empty (the original behaviour);
2. **profile** if `aws_profile` is non-empty;
3. **default_chain** otherwise: no credentials are passed, and the Bedrock SDK uses the AWS
   default provider chain: environment variables, `AWS_PROFILE`/SSO/ini files, the **ECS task
   role** (container credentials endpoint), then EC2 instance metadata.

For an ECS task role, configure no keys and no profile:

```jsonc
"claude-bedrock": {
  "api": "Anthropic_Bedrock",
  "model_type": "chat",
  "aws_region": "${AWS_REGION}",
  "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "temperature": null
}
```

For a developer laptop on an SSO-only account, add `"aws_profile": "${AWS_PROFILE}"` (or a literal profile name).

#### Bedrock Model IDs vs. Inference Profiles

Bedrock has two types of model identifiers:

1. **Direct model IDs** (older models): `anthropic.claude-3-haiku-20240307-v1:0`
2. **Inference profile IDs** (newer models): `us.anthropic.claude-haiku-4-5-20251001-v1:0`

**Important:** Newer models like Claude Haiku 4.5 **require** inference profile IDs (with the `us.` or `global.` prefix). Using the direct model ID will result in an error.

Common model IDs for Bedrock:

| Model | Inference Profile ID |
|-------|---------------------|
| Claude 3.5 Haiku | `us.anthropic.claude-3-5-haiku-20241022-v1:0` |
| Claude 3.5 Sonnet | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` |
| Claude 3 Opus | `us.anthropic.claude-3-opus-20240229-v1:0` |
| Claude 3 Haiku | `us.anthropic.claude-3-haiku-20240307-v1:0` |
| Claude Haiku 4.5 | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |

To list available inference profiles in your region, use:
```bash
aws bedrock list-inference-profiles --region us-east-1 --output table
```

#### AWS IAM Permissions

The AWS IAM user must have the following permissions:

1. **`bedrock:InvokeModel`** - Required for all model invocations
2. **`bedrock:InvokeModelWithResponseStream`** - Required for streaming (automatically used)

You can attach the `AmazonBedrockFullAccess` managed policy, or create a custom policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:*::foundation-model/*"
    }
  ]
}
```

#### Streaming

Charmonator automatically uses streaming for all Bedrock requests. This is required for newer models like Claude Haiku 4.5, which do not support non-streaming invocation.

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
      "model": "llama3.2",

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

### Local models

charmd can run on local models only, with nothing sent off the machine: a laptop reading a record, or a site without
cloud access. Two backends cover the local servers:

- `"api": "ollama"`: Ollama's native API (`/api/chat`, `/api/embed`).
- `"api": "OpenAI_Compatible"`: any server speaking OpenAI Chat Completions and Embeddings at `base_url`: LM Studio,
  llama.cpp's `llama-server`, `mlx_lm.server` / `mlx_vlm.server`, vLLM, and Ollama's own `/v1`.

`OpenAI_Compatible` is a separate api rather than a `base_url` on `"OpenAI"` because the OpenAI provider guesses from
the model name (`o*` and `gpt-5*` drop `temperature` and add `reasoning_effort`), sends the system prompt as role
`developer`, and lets the SDK read `OPENAI_BASE_URL`/`OPENAI_API_KEY` from the environment. None of that is right for a
local server. `OpenAI_Compatible` guesses nothing: each server quirk is a flag, and it only ever contacts `base_url`.
There is no fallback to a remote endpoint, and a missing `base_url` is an error.

Both backends send page images as data URLs (Ollama gets the bare base64 it expects), translate `response_format`
(`json_schema`) to what the server takes, and implement `embed` for `POST /embedding` and charmonizer embeddings.

#### `OpenAI_Compatible` fields

| Field | Default | Meaning |
| --- | --- | --- |
| `base_url` | (required) | e.g. `http://127.0.0.1:1234/v1`. `${ENV}` interpolated. |
| `api_key` | `"not-needed"` | `${ENV}` interpolated; set it when the server requires a token (LM Studio with auth on). |
| `model` | (required) | The id the server knows the model by. |
| `max_tokens` | none | Output cap when a request gives no `max_output_tokens`. Set one: see the note below. |
| `max_tokens_param` | `"max_tokens"` | `"max_completion_tokens"` for servers that want that name; `"none"` to never send a cap. |
| `supports_json_schema` | `true` | `false`: send `response_format: {"type":"json_object"}`, put the schema in the prompt, validate the reply here and re-ask (`json_fallback_attempts`, default 2 tries in all). |
| `json_fallback` | `"json_object"` | `"none"`: with `supports_json_schema: false`, send no `response_format` at all (servers that reject it). |
| `schema_in_prompt` | `false` | `true`: also state the schema in the last user message when `json_schema` is sent. |
| `send_strict` | `true` | `false`: drop `json_schema.strict`. |
| `system_role` | `"system"` | `"developer"` if a server wants it. |
| `image_detail` | omitted | `"low"`/`"high"`/`"auto"`, sent only if set. |
| `extra_body` | none | Merged into every chat request, e.g. `{"chat_template_kwargs": {"enable_thinking": false}}` (llama.cpp, vLLM) or `{"reasoning_effort": "low"}` (gpt-oss). OpenAI-only parameters (`reasoning`, `reasoning_effort`, `verbosity`) are never sent unless put here. |
| `strip_think` | `true` | Remove a leading `<think>...</think>` from replies of servers that inline reasoning. |
| `embedding_dimensions` | none | Sent as `dimensions` on `/embeddings`. |
| `ms_client_request_timeout` | 600000 | Per call, as for every model. The SDK's own retries are off; `num_client_request_max_attempts` applies. |

#### Ollama fields (all optional; absent, the request is as on `main`)

`num_ctx` (context window; Ollama's default is often too small for a page image plus prompt), `max_tokens` (sent as
`num_predict`; a request's `max_output_tokens` is ignored by this provider, as on `main`), `think` (`false` turns reasoning off on thinking models),
`keep_alive`, `ollama_options` (merged into `options`, e.g. `{"top_k": 20}`), `schema_in_prompt`,
`embedding_dimensions`. Calls time out after `ms_client_request_timeout` (Node's built-in fetch would give up after
300 s without response headers, which a non-streamed reply from a slow model can exceed).

#### Set `max_tokens`, and consider `schema_in_prompt`

Local servers generate until the model stops or the cap is hit. Under grammar-constrained decoding (`json_schema`),
a small model can open a string and never close it: `qwen3-vl:8b` filled one field with 34 KB of text and ran 115 s
before stopping at `max_tokens: 8192`, and without a cap it ran past five minutes. Stating the schema in the prompt as
well (`schema_in_prompt: true`, Ollama's own recommendation) fixed it: 0.6 s and a valid object.

#### `local_only`

`"local_only": true` on a model (any api) means its endpoint must resolve to a loopback or private address
(127/8, ::1, RFC 1918, link-local, 100.64/10, fc00::/7); `"loopback"` allows loopback only. Every address the host
resolves to must qualify. With a violation, the server refuses to start, each call is refused (HTTP 403,
`interpretedErrorType: "local_only_violation"`) before anything is sent, and `GET /readyz` reports
`checks.local_only` and answers 503. Under `local_only`, images must be data URLs, because LM Studio, llama.cpp and
vLLM will fetch an `http(s)` image URL themselves. Cloud apis (`OpenAI`, `Anthropic`, ...) fail the check by
definition. The guard catches misconfiguration; it cannot see a proxy, or a "local" server that forwards elsewhere.

#### Examples

```jsonc
{
  "models": {
    // Ollama, native API: vision model for document conversion.
    "local-vision": {
      "api": "ollama", "model_type": "chat",
      "host": "http://127.0.0.1:11434",
      "model": "qwen3-vl:8b-instruct-q4_K_M",
      "temperature": 0, "num_ctx": 16384, "max_tokens": 8192, "schema_in_prompt": true,
      "local_only": true
    },
    // Ollama embeddings (e.g. matching findings to HPO terms).
    "local-embed": {
      "api": "ollama", "model_type": "embedding",
      "host": "http://127.0.0.1:11434", "model": "qwen3-embedding:latest", "local_only": true
    },
    // Ollama through its OpenAI-compatible /v1.
    "local-vision-v1": {
      "api": "OpenAI_Compatible", "model_type": "chat",
      "base_url": "http://127.0.0.1:11434/v1", "model": "qwen3-vl:8b-instruct-q4_K_M",
      "temperature": 0, "max_tokens": 8192, "schema_in_prompt": true, "local_only": "loopback"
    },
    // LM Studio (`lms server start`, `lms load google/gemma-4-26b-a4b-qat -c 16384`).
    // With "Require API token" on, put the token in an env var, never in the config.
    "lmstudio-vision": {
      "api": "OpenAI_Compatible", "model_type": "chat",
      "base_url": "http://127.0.0.1:1234/v1", "api_key": "${LM_STUDIO_API_KEY}",
      "model": "google/gemma-4-26b-a4b-qat",
      "temperature": 0, "max_tokens": 8192, "local_only": "loopback"
    },
    "lmstudio-embed": {
      "api": "OpenAI_Compatible", "model_type": "embedding",
      "base_url": "http://127.0.0.1:1234/v1", "api_key": "${LM_STUDIO_API_KEY}",
      "model": "text-embedding-nomic-embed-text-v1.5", "local_only": "loopback"
    },
    // llama.cpp: llama-server -hf ggml-org/Qwen2.5-VL-7B-Instruct-GGUF --host 127.0.0.1 --port 8081 -c 16384 --jinja
    // (-hf fetches the model and its mmproj once; afterwards it runs offline from the cache.)
    "llamacpp-vision": {
      "api": "OpenAI_Compatible", "model_type": "chat",
      "base_url": "http://127.0.0.1:8081/v1", "model": "qwen2.5-vl-7b",
      "temperature": 0, "max_tokens": 8192, "schema_in_prompt": true, "local_only": "loopback"
    },
    // MLX: mlx_vlm.server --model mlx-community/GLM-4.6V-Flash-bf16 --host 127.0.0.1 --port 8082
    // mlx_vlm.server accepts response_format but does not enforce it (replies arrive in code fences),
    // so let charmd put the schema in the prompt and validate.
    "mlx-vision": {
      "api": "OpenAI_Compatible", "model_type": "chat",
      "base_url": "http://127.0.0.1:8082/v1", "model": "mlx-community/GLM-4.6V-Flash-bf16",
      "temperature": 0, "max_tokens": 8192,
      "supports_json_schema": false, "json_fallback": "none",
      "local_only": "loopback"
    },
    // vLLM: vllm serve Qwen/Qwen2.5-VL-7B-Instruct --port 8000
    "vllm-vision": {
      "api": "OpenAI_Compatible", "model_type": "chat",
      "base_url": "http://127.0.0.1:8000/v1", "model": "Qwen/Qwen2.5-VL-7B-Instruct",
      "temperature": 0, "max_tokens": 8192, "local_only": true
    }
  }
}
```

For document conversion, pass the model name as `model` to `POST /api/charmonizer/v1/conversions/documents`; pages go
to the vision model when OCR confidence is below `ocr_threshold` (`1.01` sends every page). The server must be bound to
`127.0.0.1` (as above) for `"loopback"`; Ollama and LM Studio bind there by default, `mlx_vlm.server` binds `0.0.0.0`
unless told otherwise.

Zero egress also needs the OCR language data on disk. Document conversion runs Tesseract on every page first, and
tesseract.js downloads `eng.traineddata` from a CDN into the working directory the first time unless the file is
already there (the `Dockerfile` bakes it in). On a laptop, run one conversion while online, or place the file in
charmd's working directory, before going offline.

---

### 5) Example for **Google** (Gemini)

```jsonc
{
  "models": {
    "my-gemini-model": {
      "api": "Google",
      "model_type": "chat",

      "api_key": "GOOGLE_AI_API_KEY_HERE_OR_IN_SECRET_JSON",
      "model": "gemini-2.0-flash",  // or "gemini-1.5-pro"

      // Optional: system instruction
      "system": "You are a helpful assistant powered by Google Gemini.",

      // Optional: generation config
      "generationConfig": {
        "temperature": 0.7,
        "maxOutputTokens": 8192
      }
    }
  }
}
```

Here:
- `api`: `"Google"` signals use of the Google Generative AI SDK.
- `model`: a Gemini model name like `"gemini-2.0-flash"` or `"gemini-1.5-pro"`.
- `api_key`: your Google AI API key (can also be set via `GOOGLE_AI_API_KEY` environment variable).
- `system`: an optional system instruction.
- `generationConfig`: optional object with parameters like `temperature`, `maxOutputTokens`, etc.

---

### Additional `config.json` Structure

When building a complete `config.json`, you may also include:

- **Top-level** fields:
  ```jsonc
  {
    "default_system_message": "You are a helpful assistant.",
    "default_temperature": 0.8,
    
    "server": {
      "port": 5003,
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

# Unit Testing

To run the unit tests, a set of two models are expected for performing the essential operations.  The following suffices:
```
  "my-unittest-model": {
    "api": "OpenAI",
    "model_type": "chat",
    "model": "o3",
    "deployment": "o3",
    "api_version": "2024-12-01-preview",
    "reasoning_effort": "low",
    "context_size": 128000,
    "output_limit": 16384
  },
  "my-unittest-emodel": {
    "api": "OpenAI",
    "model_type": "chat",
    "model": "text-embedding-3-small",
    "temperature": 0.8,
    "context_size": 8192,
    "output_limit": 2048
  }
```

The server must be running in the background before running tests:
```
  node server.mjs &
```

The essential CLI commands are documented in package json.  Run them with:
```
  npm run test...
```
