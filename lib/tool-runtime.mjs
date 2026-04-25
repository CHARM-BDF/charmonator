// tool-runtime.mjs
// Central dispatcher for tool execution

import { toolRegistry } from './tools.mjs';
import { ToolKind } from './tool-definition.mjs';

/**
 * ToolRuntime handles explicit tool execution for server/MCP tools.
 * This is used by the /v1/tools/execute endpoint when clients need to
 * execute server-side tools after receiving a client tool call response.
 */
export class ToolRuntime {
  /**
   * @param {Object} [mcpManager] - Optional MCP manager for proxying MCP tool calls
   */
  constructor(mcpManager = null) {
    this.mcpManager = mcpManager;
  }

  /**
   * Set the MCP manager (for late binding after MCP initialization)
   * @param {Object} mcpManager - The MCP manager instance
   */
  setMCPManager(mcpManager) {
    this.mcpManager = mcpManager;
  }

  /**
   * Execute an array of tool calls
   * @param {Array} toolCalls - Array of tool call objects with toolName, callId, arguments
   * @returns {Promise<Array>} Array of tool response objects
   */
  async executeToolCalls(toolCalls) {
    const responses = [];

    for (const call of toolCalls) {
      const { toolName, callId, arguments: args } = call;

      // Look up the tool
      const tool = toolRegistry.getTool(toolName);

      if (!tool) {
        responses.push({
          toolName,
          callId,
          error: `Tool not found: ${toolName}`
        });
        continue;
      }

      // Reject client tools - they should be executed by the client
      if (tool.kind === ToolKind.CLIENT) {
        responses.push({
          toolName,
          callId,
          error: 'Client tools cannot be executed on the server'
        });
        continue;
      }

      try {
        let result;

        if (tool.kind === ToolKind.MCP) {
          // MCP tools are proxied through the MCP manager
          if (!this.mcpManager) {
            throw new Error('MCP manager not configured');
          }
          // The MCP manager looks up the server from its internal mapping
          result = await this.mcpManager.callTool(toolName, args);
        } else {
          // Server tools are executed directly
          result = await tool.run(args);
        }

        responses.push({
          toolName,
          callId,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      } catch (error) {
        console.error(`[ToolRuntime] Error executing tool ${toolName}:`, error);
        responses.push({
          toolName,
          callId,
          error: error.message
        });
      }
    }

    return responses;
  }

  /**
   * Execute a single tool call
   * @param {string} toolName - Name of the tool
   * @param {string} callId - Unique call identifier
   * @param {Object} args - Tool arguments
   * @returns {Promise<Object>} Tool response object
   */
  async executeTool(toolName, callId, args) {
    const responses = await this.executeToolCalls([{ toolName, callId, arguments: args }]);
    return responses[0];
  }

  /**
   * Check if a tool exists and is executable on the server
   * @param {string} toolName - Name of the tool
   * @returns {boolean} True if tool exists and is server/MCP kind
   */
  canExecute(toolName) {
    const tool = toolRegistry.getTool(toolName);
    return tool && tool.kind !== ToolKind.CLIENT;
  }

  /**
   * Get list of all executable (server/MCP) tools
   * @returns {Array} Array of tool definitions
   */
  getExecutableTools() {
    const serverTools = toolRegistry.getToolsByKind(ToolKind.SERVER);
    const mcpTools = toolRegistry.getToolsByKind(ToolKind.MCP);

    return [
      ...Array.from(serverTools.values()).map(t => t.toProviderFormat?.() || {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema
      }),
      ...Array.from(mcpTools.values()).map(t => t.toProviderFormat?.() || {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema
      })
    ];
  }
}

// Singleton instance
export const toolRuntime = new ToolRuntime();
