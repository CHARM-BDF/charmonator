// tools-execute.mjs
// Endpoint for explicit server/MCP tool execution

import express from 'express';
import { toolRuntime } from '../../lib/tool-runtime.mjs';

const router = express.Router();

/**
 * POST /v1/tools/execute
 *
 * Execute one or more server/MCP tools explicitly.
 * This is used by clients to execute server-side tools after receiving
 * a transcript that ends with client tool calls.
 *
 * Request body:
 * {
 *   "toolCalls": [
 *     { "toolName": "calculator", "callId": "call-123", "arguments": { "expression": "2+2" } },
 *     { "toolName": "web_search", "callId": "call-456", "arguments": { "query": "weather" } }
 *   ]
 * }
 *
 * Response:
 * {
 *   "toolResponses": [
 *     { "toolName": "calculator", "callId": "call-123", "content": "4" },
 *     { "toolName": "web_search", "callId": "call-456", "content": "..." }
 *   ]
 * }
 */
router.post('/execute', async (req, res) => {
  try {
    const { toolCalls } = req.body;

    // Validate request
    if (!toolCalls) {
      return res.status(400).json({
        error: 'Missing required field: toolCalls'
      });
    }

    if (!Array.isArray(toolCalls)) {
      return res.status(400).json({
        error: 'toolCalls must be an array'
      });
    }

    // Validate each tool call has required fields
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      if (!call.toolName) {
        return res.status(400).json({
          error: `toolCalls[${i}] missing required field: toolName`
        });
      }
      if (!call.callId) {
        return res.status(400).json({
          error: `toolCalls[${i}] missing required field: callId`
        });
      }
    }

    console.log(`[ToolsExecute] Executing ${toolCalls.length} tool(s):`,
      toolCalls.map(tc => tc.toolName).join(', '));

    // Execute the tools
    const toolResponses = await toolRuntime.executeToolCalls(toolCalls);

    console.log(`[ToolsExecute] Completed. Responses:`,
      toolResponses.map(tr => tr.error ? `${tr.toolName}:ERROR` : `${tr.toolName}:OK`).join(', '));

    return res.json({ toolResponses });
  } catch (error) {
    console.error('[ToolsExecute] Error:', error);
    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * GET /v1/tools/list
 *
 * List all executable (server/MCP) tools.
 *
 * Response:
 * {
 *   "tools": [
 *     { "name": "calculator", "description": "...", "input_schema": {...} },
 *     ...
 *   ]
 * }
 */
router.get('/list', async (req, res) => {
  try {
    const tools = toolRuntime.getExecutableTools();
    return res.json({ tools });
  } catch (error) {
    console.error('[ToolsExecute] Error listing tools:', error);
    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

export default router;
