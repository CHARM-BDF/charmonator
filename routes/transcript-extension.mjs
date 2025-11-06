import express from 'express';
import { fetchChatModel } from '../lib/core.mjs';
import { TranscriptFragment } from '../lib/transcript.mjs';
import { FunctionTool } from '../lib/function.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';
import { ToolKind, ToolDefinition } from '../lib/tool-definition.mjs';
import { toolRegistry } from '../lib/tools.mjs';
import { mcpManager } from '../lib/mcp/mcp-manager.mjs';
import Ajv from 'ajv';

const router = express.Router();

const num_attempts_to_correct_schema_default = 5;

router.post('/extension', async (req, res) => {
  console.log(JSON.stringify({
    "event":"request",
    "url":"/transcript/extension"+req.url,
    "body":req.body}))
  let transcriptCopy = null;
  const abortController = new globalThis.AbortController();
  const onDisconnect = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      abortController.abort(new Error('Client disconnected'));
      console.log('[transcript-extension] Client disconnected; aborting request work');
    }
  };

  req.once('aborted', onDisconnect);
  res.once('close', onDisconnect);
  try {
    const {
      model: modelId,
      system,
      temperature,
      transcript: transcriptJson,
      tools,
      client_tools,  // New: array of client-side tool schemas
      ms_client_request_timeout = null,
      num_client_request_max_attempts = null,
      // New: Accept an "options" object that can contain response_format, stream, etc.
      options
    } = req.body;

    transcriptCopy = transcriptJson;

    // Basic validation
    if (!modelId || !transcriptJson?.messages) {
      return res.status(400).json({
        error: 'Missing required fields: model and transcript.messages'
      });
    }

    // Create chat model
    const chatModel = fetchChatModel(modelId);

    // Set configuration
    if (system) chatModel.system = system;
    if (temperature != null) chatModel.temperature = temperature;

    // Register ephemeral server tools (legacy, with placeholder implementation)
    if (tools) {
      tools.forEach(toolConfig => {
        const tool2 = toolRegistry.getTool(toolConfig.name)
        if (!tool2) {
          throw new Error(`Tool ${toolConfig.name} not found`);
        }
        chatModel.addTool(tool2);

        // const tool = new FunctionTool(async (args) => {
        //   // In real implementation, do the actual tool work here.
        //   return { result: 'Tool execution placeholder' };
        // });
        // tool.name = toolConfig.name;
        // tool.description = toolConfig.description;
        // tool.input_schema = toolConfig.input_schema;
        // tool.kind = ToolKind.SERVER;  // Explicit server kind
        // chatModel.addTool(tool);
      });
    }

    // Register client-side tools (schema only, no server-side execution)
    if (client_tools && Array.isArray(client_tools)) {
      client_tools.forEach(toolSchema => {
        // const clientTool = new ToolDefinition({
        //   kind: ToolKind.CLIENT,
        //   name: toolSchema.name,
        //   description: toolSchema.description,
        //   input_schema: toolSchema.input_schema,
        //   run: undefined,  // Client tools have no server-side run
        //   meta: { source: 'request' }
        // });
        // chatModel.addTool(clientTool);
        if (toolSchema?.name) {
          chatModel.enableTool(toolSchema.name)
        }
      });
      console.log(`[transcript-extension] Registered ${client_tools.length} client tool(s)`);
    }

    // Register MCP tools if available
    if (mcpManager && mcpManager.getAllTools) {
      const mcpTools = mcpManager.getAllTools();
      for (const mcpTool of mcpTools) {
        const tool = toolRegistry.getTool(mcpTool.name);
      }
      console.log(`[transcript-extension] Registered ${mcpTools.length} MCP tool(s)`);
    }

    // Convert incoming transcript to internal format
    const incomingTranscript = TranscriptFragment.fromJSON(transcriptJson);

    // If no options object was provided, default to empty
    const options2 = options || {}
    const invocationOptions = {
      ...options2,
      ms_client_request_timeout,
      num_client_request_max_attempts,
      abort_signal: abortController.signal
    }

    // *** Loop for repair attempt of JSON Schema Structured Output.  Will return early for unstructured output. ***
    const numAttempts = 1+(invocationOptions.num_attempts_to_correct_schema || num_attempts_to_correct_schema_default);
    let validOutput = null;
    let mostValidOutput = null;
    let suffix = null;
    for (let attempt = 0; attempt < numAttempts; attempt++) {
      suffix = await chatModel.extendTranscript(
        incomingTranscript,
        null,
        null,
        invocationOptions
      );
      const schema = invocationOptions?.response_format?.json_schema?.schema;
      if(!schema) {
        // Bail out because we're not doing Structured Output
        res.json(suffix.toJSON())
        return;
      }
      console.log(JSON.stringify({"event":"received response",
        "response": suffix.toJSON()
      }))
      let data = null
      let isValid = !schema
      try {
        data = suffix.toJSON().messages[0].content
        if(schema) {
            data = JSON.parse(data)
            isValid = validateAgainstSchema(data, schema);
        }
      } catch(err) {
        console.error({
          "event":"Error extending transcript: parsing json",
          "bytes": data ? data.length : 0
        })
      }
      /*
      // Example of how to exercise "attempting repair"
      const schema2 = JSON.parse(JSON.stringify(schema))
      delete schema2['items']['properties'].current_usage_status;
      const isValid = validateAgainstSchema(data, schema2);
      */
      if (isValid) {
        validOutput = suffix.toJSON();
        break;
      } else if (attempt < (numAttempts - 1)) {
        mostValidOutput = data;
        console.log(JSON.stringify({"event": "attempting repair", attempt, numAttempts, "data":suffix.toJSON()}))
        const incorrectResponse = JSON.stringify(suffix.toJSON(), null, 2);
        invocationOptions.repairs = `
          We have tried to use Structured Output to decode the following JSON Response.
          However, the Response does not yet correspond to its JsonSchema.
          Fix the Response so that it is fully valid according to JsonSchema, while preserving as much of its content as is reasonably possible.
          <Response>
          \`\`\`json
          ${incorrectResponse}
          \`\`\`
          </Response>
        `;
      }
    }

    if (abortController.signal.aborted || res.destroyed) {
      return;
    }
    if (validOutput) {
      return res.json(validOutput);
    }
    // 422, Unprocessable Content, https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/422
    return res.status(422).json({
      error: 'The response could not be validated after multiple attempts.',
      mostValidOutput,
      finalResponse: suffix ? suffix.toJSON() : null
    });

  } catch (err) {
    if (abortController.signal.aborted) {
      return;
    }
    const j = jsonSafeFromException(err)
    console.error({"event":"Error extending transcript",
      stack: err.stack,
      errJson: j
    })
    // Expand all inner objects to a depth of 10 for debugging:
    console.error('Transcript', JSON.stringify(transcriptCopy, null, 10));
    return res.status(500).json(j);
  } finally {
    req.off('aborted', onDisconnect);
    res.off('close', onDisconnect);
  }
});

function validateAgainstSchema(response, schema) {
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  return validate(response);
}

export default router;
