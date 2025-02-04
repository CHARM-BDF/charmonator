# Charmonator (and Charmonizer) README

This server exports two RESTful APIs from one httpd: charmonator and charmonizer.

The intent is to provide a simple, unified interface to a variety of generative AI models and data harmonization tasks.

And, instead of re-implementing these in every language, each language can develop a library that acts as wrappers around these APIs and the core JSON data structures.

For documentation on endpoints, please see [docs/api-docs.md]

For documentation on the JSON document object schema, please see [docs/document.md]


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


## Short version: How to run

Create a config file at `conf/config.json` with the following structure.

You can create an example config with `scripts/create-example-config.js`.

Then, modify it to suit your needs.


To run the server, execute:

```
node server.js
```

The server will start on the port specified in the config file, and you can begin making requests to the API endpoints in [docs/api-docs.md](./docs/api-docs.md).


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



