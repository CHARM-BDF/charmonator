import express from 'express';
import { fetchChatModel } from '../lib/core.mjs';
import { TranscriptFragment } from '../lib/transcript.mjs';
import { FunctionTool } from '../lib/function.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';
import { ToolKind, ToolDefinition } from '../lib/tool-definition.mjs';
import { toolRegistry } from '../lib/tools.mjs';
import { mcpManager } from '../lib/mcp/mcp-manager.mjs';

const router = express.Router();

router.post('/extension', async (req, res) => {
  console.log(JSON.stringify({
    "event":"request",
    "url":"/transcript/extension"+req.url,
    "body":req.body}))
  let transcriptCopy = null;
  try {
    const {
      model: modelId,
      system,
      temperature,
      transcript: transcriptJson,
      tools,
      client_tools,  // New: array of client-side tool schemas
      ms_client_request_timeout = null,
      max_attempts = null,
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
        chatModel.enableTool(toolSchema?.name)
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
      max_attempts
    }

    // Generate response
    const suffix = await chatModel.extendTranscript(
      incomingTranscript,
      null,
      null,
      invocationOptions
    );

    // Return the suffix as JSON
    return res.json(suffix.toJSON());

  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error extending transcript",
      stack: err.stack,
      errJson: j
    })
    return res.status(500).json(j);
  }
});

export default router;
