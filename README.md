# Charmonator (and Charmonizer) README

**Note**: Endpoints defined in this repository are not yet stable, so please take caution when upgrading to new versions.


This server exports two RESTful APIs from one httpd: charmonator and charmonizer.

The intent is to provide a simple, unified interface to a variety of generative AI models and data transformation/harmonization tasks.


And, instead of re-implementing these in every language, each language can develop a library that acts as wrappers around these APIs and the core JSON data structures.

For documentation on endpoints, please see [api-docs.md](docs/api-docs.md).

For documentation on the JSON document object schema, please see [document.md](docs/document.md).

## Jump to:

 - [How to install](#how-to-install)
 - [What is charmonator?](#what-is-charmonator)
 - [What is charmonizer?](#what-is-charmonizer)
 - [Configuration management](#configuration-management)
 - [Endpoints](#endpoints)

<a name="how-to-run"></a>
## How to install

### How to configure
Create a config file at `conf/config.json`.

(Make sure the `conf` directory exists: `mkdir -p conf`.)

You can create an example config with `scripts/generate-example-config.js`:

```bash
node scripts/generate-example-config.js > conf/config.json
```

Then, modify it to suit your needs.

### How to configure secrets

The configuration defaults do not include api keys.  Under each model requiring api keys, use the "api_key" field to store the api key.  While you are free to put the api_key field in your `config.json`, we recommend putting secrets in the separate file `conf/config.secret.json`, so that you can share your `config.json` more freely.  Here is an example of how to use a `conf/config.secret.json`:

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

### How to run
Once configured, to run the server, execute:

```
node server.mjs
```

The server will start on the port specified in the config file, and you can begin making requests to the API endpoints in [docs/api-docs.md](./docs/api-docs.md).

### Dependencies

If you are getting errors, you may need to install GraphicsMagick to use endpoints that rely on image processing:

```bash
brew install graphicsmagick
```



<a name="what-is-charmonator"></a>
## What is charmonator?

**Charmonator** is a RESTful abstraction over generative AI models, currently supporting:

 - multimodal chat-based language models
 - text-based embedding models

At the moment, multimodality is limited to text for input and output, and images for input only.

At present, charmonator abstracts over three model-provider backends:

 - OpenAI
 - Anthropic
 - Ollama

Support for Google's generative AI API is planned.

Applications built on top of charmonator should be able to leverage a mixture of these three backends.

Currently, there is initial support for tool-calling, with plans to generalize this support and make it extensible.



<a name="what-is-charmonizer"></a>
## What is charmonizer?

**Charmonizer** is a RESTful interface to more complex interface for "data harmonization", currently supporting:

 - PDF to markdown transcription
 - Document summarization strategies: map, fold, delta-fold
   + These can be summaries from unstructured to structured formats
 - Chunked document embedding

Future versions will support:

 - Complex document / data format conversions, such as:
   + Transformations between structured data formats
 - Document decomposition / chunking

A design goal for charmonizer is to abstract over underlying limits of individual language models, such as context length limits.


## Web app playgrounds

There are two web app playgrounds to test demonstrate these APIs:

 - `public/index.html` - A general-purpose chat app
 - `public/document.html` - A document playground (currently supports conversion from PDF)

These are available when you start the server and navigate to (`http://localhost:5002/charm/`)[http://localhost:5002/charm/], assuming you have /charm/ as the base path prefix and 5002 as the port in you configuration.



<a name="configuration-management"></a>
## Configuration management

The default configuration for the server is read from `conf/config.json` on start-up.

This specifies ports and paths for the charmonator and charmonizer web service.

It also specifies named model descriptions, so that a named model can have model-specific parameters preconfigured, which may include:

 - the specific model provider / backend API
 - any associated access / API keys required
 - model-specific parameters, such as:
   + system / developer messages
   + temperature 
   + reasoning effort



## Endpoints

For more information on currently provided endpoints, see [api-docs.md](./docs/api-docs.md).



