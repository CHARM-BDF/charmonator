# Charmonator (and Charmonizer) README

This server exports two RESTful APIs from one web server: charmonator and charmonizer.


**Charmonator** is a RESTful abstraction over generative AI models, currently supporting:

 - multimodal chat-based language models
 - text-based embedding models

At the moment, multimodality is limited to text for input and output, and pictures for input only.

At present, charmonator abstracts over three model-provider backends:

 - OpenAI
 - Anthropic
 - Ollama

Support for Google's generative AI API is planned.

Applications built on top of charmonator should be able to leverage a mixture of these three backends.

Currently, there is initial support for tool-calling, with plans to generalize this support and make it extensible.


**Charmonizer** is a RESTful interface to more complex interface for "data harmonization", currently supporting:

 - PDF to markdown transcription

Future versions will support:

 - Parameterized document summarization
 - Complex document / data format conversions, such as:
   + Transformations from unstructured data into structured data 
   + Transformations between structured data formats
 - Document decomposition / chunking
 - Document / chunk embedding
 - Converting documents (or collections of documents) into vector stores for semantic search

A design goal for charmonizer is to abstract over underlying limits of individual language models, such as context-length limits.


## Schemas

Apart from the service, charmonator also 



## Configuration management

The default configuration for the server is read from `conf/config.json` on start-up.

This specifies ports and paths for the charmonator and charmonizer web service.

It also specifies named model descriptions, so that a named model can have model-specific parameters preconfigured, which may include:

 - the specific model provider / backend API
 - any associated access / API keys required

 - system messages
 - temperature 


## Endpoints

For more information on currently provided endpoints, see [api-docs.md](./docs/api-docs.md).


## TODOs


### TODO: Create an "apps" entry in config file, and move public/ to an entry for a "playground" app/


### TODO: Create helper scripts for modifying the configuration file for common scenarios

 - A helper script that creates an entry for an OpenAI model given an OpenAI key and a model name.
 - A helper script that creates an entry for an Ollama model given its local model name
 - A helper script that creates an entry for an Anthropic model given an Anthropic key and a model name.

