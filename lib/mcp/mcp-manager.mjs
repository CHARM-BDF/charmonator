/**
 * mcp-manager.mjs
 *
 * Manages MCP (Model Context Protocol) server lifecycle and tool proxying.
 *
 * Responsibilities:
 * - Start MCP servers from config
 * - Connect via stdio transport
 * - Fetch tool schemas from servers
 * - Proxy tool calls to appropriate server
 * - Handle server shutdown
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { ToolKind, ToolDefinition } from '../tool-definition.mjs';
import { toolRegistry } from '../tools.mjs';

/**
 * Represents a connection to a single MCP server
 */
class MCPServerConnection extends EventEmitter {
  constructor(serverId, config) {
    super();
    this.serverId = serverId;
    this.config = config;
    this.process = null;
    this.tools = new Map();
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.buffer = '';
    this.connected = false;
  }

  /**
   * Start the MCP server process
   */
  async start() {
    const { command, args = [], env = {} } = this.config;

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...env }
        });

        this.process.stdout.on('data', (data) => {
          this._handleData(data.toString());
        });

        this.process.stderr.on('data', (data) => {
          console.error(`[MCP:${this.serverId}] stderr: ${data.toString().trim()}`);
        });

        this.process.on('error', (err) => {
          console.error(`[MCP:${this.serverId}] Process error:`, err.message);
          this.connected = false;
          this.emit('error', err);
        });

        this.process.on('exit', (code, signal) => {
          console.log(`[MCP:${this.serverId}] Process exited (code=${code}, signal=${signal})`);
          this.connected = false;
          this.emit('exit', { code, signal });
        });

        // Initialize the connection
        this._initialize()
          .then(() => {
            this.connected = true;
            resolve();
          })
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Initialize the MCP connection
   */
  async _initialize() {
    // Send initialize request
    const initResult = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: 'charmonator',
        version: '1.0.0'
      }
    });

    console.log(`[MCP:${this.serverId}] Initialized:`, initResult.serverInfo?.name || 'unknown');

    // Send initialized notification
    this._sendNotification('notifications/initialized', {});

    // List available tools
    await this._fetchTools();
  }

  /**
   * Fetch tools from the MCP server
   */
  async _fetchTools() {
    const result = await this._sendRequest('tools/list', {});
    this.tools.clear();

    for (const tool of result.tools || []) {
      this.tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      });
      console.log(`[MCP:${this.serverId}] Discovered tool: ${tool.name}`);
    }

    return this.tools;
  }

  /**
   * Call a tool on this MCP server
   */
  async callTool(toolName, args) {
    if (!this.connected) {
      throw new Error(`MCP server ${this.serverId} is not connected`);
    }

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args
    });

    // Extract content from response
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text);
      return textParts.join('\n') || JSON.stringify(result.content);
    }

    return JSON.stringify(result);
  }

  /**
   * Send a JSON-RPC request
   */
  async _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify(request) + '\n';
      this.process.stdin.write(message);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  _sendNotification(method, params) {
    const notification = {
      jsonrpc: '2.0',
      method,
      params
    };
    const message = JSON.stringify(notification) + '\n';
    this.process.stdin.write(message);
  }

  /**
   * Handle incoming data from the MCP server
   */
  _handleData(data) {
    this.buffer += data;

    // Process complete JSON messages (newline-delimited)
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        this._handleMessage(message);
      } catch (error) {
        console.error(`[MCP:${this.serverId}] Failed to parse message:`, line);
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  _handleMessage(message) {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || 'MCP error'));
      } else {
        resolve(message.result);
      }
    } else if (message.method) {
      // Handle notifications/requests from server
      this.emit('notification', message);
    }
  }

  /**
   * Stop the MCP server
   */
  async stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.connected = false;
    }
  }
}

/**
 * MCPManager - manages all MCP server connections
 */
export class MCPManager {
  constructor() {
    this.servers = new Map();
    this.toolToServer = new Map();  // Maps tool name to server ID
  }

  /**
   * Initialize MCP servers from config
   * @param {Object} config - MCP configuration
   */
  async initialize(config) {
    const mcpConfig = config.mcp || {};
    const serverConfigs = mcpConfig.servers || {};
    const toolMappings = mcpConfig.tools || {};

    // Start all configured servers
    for (const [serverId, serverConfig] of Object.entries(serverConfigs)) {
      try {
        console.log(`[MCPManager] Starting server: ${serverId}`);
        const connection = new MCPServerConnection(serverId, serverConfig);
        await connection.start();
        this.servers.set(serverId, connection);

        // Register discovered tools
        for (const [toolName, toolInfo] of connection.tools) {
          this._registerMCPTool(serverId, toolName, toolInfo);
        }
      } catch (error) {
        console.error(`[MCPManager] Failed to start server ${serverId}:`, error.message);
      }
    }

    // Register explicit tool mappings from config
    for (const [toolAlias, mapping] of Object.entries(toolMappings)) {
      const { server: serverId, tool: remoteName } = mapping;
      const connection = this.servers.get(serverId);
      if (connection) {
        const toolInfo = connection.tools.get(remoteName);
        if (toolInfo) {
          this._registerMCPTool(serverId, remoteName, toolInfo, toolAlias);
        }
      }
    }
  }

  /**
   * Register an MCP tool in the global registry
   */
  _registerMCPTool(serverId, remoteName, toolInfo, alias = null) {
    const toolName = alias || remoteName;

    // Create a ToolDefinition for the MCP tool
    const toolDef = new ToolDefinition({
      kind: ToolKind.MCP,
      name: toolName,
      description: toolInfo.description || `MCP tool: ${remoteName}`,
      input_schema: toolInfo.inputSchema || { type: 'object', properties: {} },
      run: async (args) => {
        return await this.callTool(toolName, args);
      },
      meta: {
        serverId,
        remoteName,
        source: 'mcp'
      }
    });

    toolRegistry.register(toolDef);
    this.toolToServer.set(toolName, serverId);
    console.log(`[MCPManager] Registered MCP tool: ${toolName} (server: ${serverId})`);
  }

  /**
   * Call an MCP tool
   * @param {string} toolName - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<any>} Tool result
   */
  async callTool(toolName, args) {
    const serverId = this.toolToServer.get(toolName);
    if (!serverId) {
      throw new Error(`No MCP server found for tool: ${toolName}`);
    }

    const connection = this.servers.get(serverId);
    if (!connection) {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    // Get the remote tool name (might be different from alias)
    const tool = toolRegistry.getTool(toolName);
    const remoteName = tool?.meta?.remoteName || toolName;

    return await connection.callTool(remoteName, args);
  }

  /**
   * Check if this is an MCP tool
   */
  hasTool(toolName) {
    return this.toolToServer.has(toolName);
  }

  /**
   * Get all MCP tools
   */
  getAllTools() {
    const tools = [];
    for (const [toolName, serverId] of this.toolToServer) {
      const tool = toolRegistry.getTool(toolName);
      if (tool) {
        tools.push({
          name: toolName,
          serverId,
          description: tool.description
        });
      }
    }
    return tools;
  }

  /**
   * Shutdown all MCP servers
   */
  async shutdown() {
    for (const [serverId, connection] of this.servers) {
      console.log(`[MCPManager] Stopping server: ${serverId}`);
      await connection.stop();
    }
    this.servers.clear();
    this.toolToServer.clear();
  }
}

// Singleton instance
export const mcpManager = new MCPManager();
