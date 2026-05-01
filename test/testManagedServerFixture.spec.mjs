import { strict as assert } from 'assert';
import { format } from 'util';
import { createAndStart } from '../lib/server.mjs';
import { ToolKind } from '../lib/tool-definition.mjs';
import { toolRegistry } from '../lib/tools.mjs';

describe('Managed server fixture lifecycle', function() {
  it('should clear MCP tool registrations across repeated createAndStart cycles', async function() {
    this.timeout(15000);

    const originalWarn = console.warn;
    const originalLog = console.log;
    const duplicateWarnings = [];
    const logMessages = [];
    let firstProcesses = null;
    let secondProcesses = null;

    console.warn = (...args) => {
      const message = format(...args);
      if (message.includes('already registered')) {
        duplicateWarnings.push(message);
      }
      originalWarn(...args);
    };
    console.log = (...args) => {
      logMessages.push(format(...args));
      originalLog(...args);
    };

    try {
      firstProcesses = await createAndStart();

      const firstMcpTools = toolRegistry.getToolsByKind(ToolKind.MCP);
      assert.deepEqual(
        Array.from(firstMcpTools.keys()).sort(),
        ['calc', 'calculator', 'echo', 'read_file', 'write_file']
      );

      await firstProcesses.cleanup();
      firstProcesses = null;

      assert.equal(toolRegistry.getToolsByKind(ToolKind.MCP).size, 0);
      assert.equal(toolRegistry.getTool('echo'), undefined);
      assert.equal(toolRegistry.getTool('calc'), undefined);

      const secondStartLogIndex = logMessages.length;
      const secondStartWarningIndex = duplicateWarnings.length;
      secondProcesses = await createAndStart();

      const secondMcpTools = toolRegistry.getToolsByKind(ToolKind.MCP);
      assert.deepEqual(
        Array.from(secondMcpTools.keys()).sort(),
        ['calc', 'calculator', 'echo', 'read_file', 'write_file']
      );
      const secondStartLogs = logMessages.slice(secondStartLogIndex);
      const secondStartWarnings = duplicateWarnings.slice(secondStartWarningIndex);

      assert(
        secondStartLogs.some(message => message.includes('All Registered Tools: []')),
        'Second startup should begin with an empty tool registry'
      );
      assert.deepEqual(secondStartWarnings, [
        '[ToolRegistry] Tool "echo" already registered; skipping duplicate.'
      ]);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
      if (secondProcesses?.cleanup) {
        await secondProcesses.cleanup();
      }
      if (firstProcesses?.cleanup) {
        await firstProcesses.cleanup();
      }
    }
  });
});
