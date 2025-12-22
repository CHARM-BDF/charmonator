#!/usr/bin/env node
/**
 * test-server.mjs
 *
 * A test MCP (Model Context Protocol) server for development and testing.
 *
 * Provides the following tools:
 * - echo: Echo back an input message
 * - calculator: Basic arithmetic operations
 * - read_file: Read file contents
 * - write_file: Write content to a temp file
 *
 * Usage:
 *   node mcp-servers/test-server.mjs
 *
 * Communication:
 *   Uses stdio transport (JSON-RPC over stdin/stdout)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

// Server information
const SERVER_INFO = {
  name: 'test-mcp-server',
  version: '1.0.0'
};

// Tool definitions
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided message',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to echo back'
        }
      },
      required: ['message']
    }
  },
  {
    name: 'calculator',
    description: 'Perform basic arithmetic operations: add, subtract, multiply, divide',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'subtract', 'multiply', 'divide'],
          description: 'The arithmetic operation to perform'
        },
        a: {
          type: 'number',
          description: 'First operand'
        },
        b: {
          type: 'number',
          description: 'Second operand'
        }
      },
      required: ['operation', 'a', 'b']
    }
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read'
        },
        encoding: {
          type: 'string',
          description: 'File encoding (default: utf-8)',
          enum: ['utf-8', 'ascii', 'base64']
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the temp directory',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Name for the temp file'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file'
        }
      },
      required: ['filename', 'content']
    }
  }
];

// Tool implementations
const TOOL_HANDLERS = {
  echo: async (args) => {
    return { message: args.message };
  },

  calculator: async (args) => {
    const { operation, a, b } = args;

    let result;
    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        if (b === 0) {
          throw new Error('Division by zero');
        }
        result = a / b;
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    return { operation, a, b, result };
  },

  read_file: async (args) => {
    const filePath = args.path;
    const encoding = args.encoding || 'utf-8';

    try {
      const content = fs.readFileSync(filePath, encoding);
      return {
        path: filePath,
        content: content,
        size: content.length
      };
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  },

  write_file: async (args) => {
    const { filename, content } = args;

    // Write to temp directory for safety
    const tempDir = os.tmpdir();
    const safeName = path.basename(filename);  // Prevent path traversal
    const filePath = path.join(tempDir, `mcp-test-${safeName}`);

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      return {
        path: filePath,
        size: content.length,
        success: true
      };
    } catch (error) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }
};

/**
 * MCP Server class
 */
class MCPServer {
  constructor() {
    this.initialized = false;
    this.capabilities = {};
  }

  /**
   * Handle incoming JSON-RPC messages
   */
  async handleMessage(message) {
    const { id, method, params } = message;

    // Handle requests (has id)
    if (id !== undefined) {
      try {
        const result = await this.handleRequest(method, params || {});
        return { jsonrpc: '2.0', id, result };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: error.message
          }
        };
      }
    }

    // Handle notifications (no id)
    this.handleNotification(method, params || {});
    return null;  // Notifications don't return a response
  }

  /**
   * Handle a JSON-RPC request
   */
  async handleRequest(method, params) {
    switch (method) {
      case 'initialize':
        return this.handleInitialize(params);

      case 'tools/list':
        return this.handleListTools();

      case 'tools/call':
        return this.handleCallTool(params);

      case 'ping':
        return {};

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Handle notifications
   */
  handleNotification(method, params) {
    switch (method) {
      case 'notifications/initialized':
        this.initialized = true;
        console.error('[MCP Test Server] Received initialized notification');
        break;

      case 'notifications/cancelled':
        // Handle cancellation if needed
        break;

      default:
        console.error(`[MCP Test Server] Unknown notification: ${method}`);
    }
  }

  /**
   * Handle initialize request
   */
  handleInitialize(params) {
    this.capabilities = {
      tools: {}
    };

    return {
      protocolVersion: '2024-11-05',
      capabilities: this.capabilities,
      serverInfo: SERVER_INFO
    };
  }

  /**
   * Handle tools/list request
   */
  handleListTools() {
    return { tools: TOOLS };
  }

  /**
   * Handle tools/call request
   */
  async handleCallTool(params) {
    const { name, arguments: args } = params;

    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    console.error(`[MCP Test Server] Calling tool: ${name}`);

    try {
      const result = await handler(args || {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const server = new MCPServer();

  // Set up readline for stdio communication
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  console.error('[MCP Test Server] Starting...');

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);
      const response = await server.handleMessage(message);

      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (error) {
      console.error('[MCP Test Server] Error processing message:', error.message);
      // Send error response if we can parse the id
      try {
        const parsed = JSON.parse(line);
        if (parsed.id !== undefined) {
          const errorResponse = {
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32700,
              message: 'Parse error'
            }
          };
          process.stdout.write(JSON.stringify(errorResponse) + '\n');
        }
      } catch {
        // Ignore parsing errors for error response
      }
    }
  });

  rl.on('close', () => {
    console.error('[MCP Test Server] Stdin closed, exiting');
    process.exit(0);
  });

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    console.error('[MCP Test Server] Received SIGTERM, shutting down');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.error('[MCP Test Server] Received SIGINT, shutting down');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[MCP Test Server] Fatal error:', error);
  process.exit(1);
});
