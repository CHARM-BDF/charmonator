import { fetchChatModel } from './core.mjs';
import { TranscriptFragment } from './transcript.mjs';
import { validateAgainstSchema, requestToRepair } from './schema-validation.mjs';
import { jsonSafeFromException } from './providers/provider_exception.mjs';
import { toolRegistry } from './tools.mjs';
import { mcpManager } from './mcp/mcp-manager.mjs';
import { getConfig } from './config.mjs';

export function isTranscriptMessageDefective(msg) {
  return (!msg || !msg.content || msg.content.length===0)
}

function resolveDefectiveReplyAttemptCount(invocationOptions, chatModel, config) {
  return (
    invocationOptions.num_defective_reply_max_attempts
    ?? chatModel.num_defective_reply_max_attempts
    ?? config.num_defective_reply_max_attempts
  );
}

async function getNondefectiveSuffix(chatModel, transcript, invocationOptions, config) {
  let numAttemptsLeft = resolveDefectiveReplyAttemptCount(invocationOptions, chatModel, config);

  while (numAttemptsLeft >= 0) {
    numAttemptsLeft -= 1;

    const suffix = await chatModel.extendTranscript(
      transcript,
      null,
      null,
      invocationOptions
    );
    const lastMsg = suffix?.messages?.[suffix.messages.length - 1];

    if (isTranscriptMessageDefective(lastMsg)) {
      console.log({
        event: 'Defective reply from LLM, retrying',
        nAttemptsLeft: numAttemptsLeft
      });
      continue;
    }

    if (lastMsg.role !== 'assistant') {
      console.log({ event: "Warning: last reply from the LLM isn't assistant?" });
    }

    return suffix;
  }

  return null;
}

export async function doTranscriptExtension(input, res = null) {
  const req = res ? input : null;
  const body = res ? input.body : input;

  let transcriptCopy = null;
  const abortController = new globalThis.AbortController();
  const onDisconnect = () => {
    if (res && !abortController.signal.aborted && !res.writableEnded) {
      abortController.abort(new Error('Client disconnected'));
      console.log('[transcript-extension] Client disconnected; aborting request work');
    }
  };

  if (req && res) {
    req.once('aborted', onDisconnect);
    res.once('close', onDisconnect);
  }
  const config = getConfig()
  try {
    const {
      model: modelId,
      system,
      temperature,
      transcript: transcriptJson,
      tools,
      client_tools,
      ms_client_request_timeout = null,
      num_client_request_max_attempts = null,
      num_defective_reply_max_attempts = null,
      num_schema_repair_max_attempts = null,
      options
    } = body;

    transcriptCopy = transcriptJson;

    if (!modelId || !transcriptJson?.messages) {
      if (res) {
        return res.status(400).json({
          error: 'Missing required fields: model and transcript.messages'
        });
      }
      throw new Error('Missing required fields: model and transcript.messages');
    }

    const chatModel = fetchChatModel(modelId);

    if (system) {
      chatModel.system = system;
    }
    if (temperature != null) {
      chatModel.temperature = temperature;
    }

    if (tools) {
      tools.forEach((toolConfig) => {
        const tool = toolRegistry.getTool(toolConfig.name);
        if (!tool) {
          throw new Error(`Tool ${toolConfig.name} not found`);
        }
        chatModel.addTool(tool);
      });
    }

    if (client_tools && Array.isArray(client_tools)) {
      client_tools.forEach((toolSchema) => {
        if (toolSchema?.name) {
          chatModel.enableTool(toolSchema.name);
        }
      });
      console.log(`[transcript-extension] Registered ${client_tools.length} client tool(s)`);
    }

    if (mcpManager && mcpManager.getAllTools) {
      const mcpTools = mcpManager.getAllTools();
      for (const mcpTool of mcpTools) {
        toolRegistry.getTool(mcpTool.name);
      }
      console.log(`[transcript-extension] Registered ${mcpTools.length} MCP tool(s)`);
    }

    const incomingTranscript = TranscriptFragment.fromJSON(transcriptJson);
    const options2 = options || {};
    const invocationOptions = {
      ...options2,
      ms_client_request_timeout,
      num_client_request_max_attempts,
      num_defective_reply_max_attempts,
      num_schema_repair_max_attempts,
      abort_signal: abortController.signal
    };

    const numAttempts =
      1 + (invocationOptions.num_schema_repair_max_attempts ?? chatModel.num_schema_repair_max_attempts ?? config.num_schema_repair_max_attempts);
    let validOutput = null;
    let mostValidOutput = null;
    let suffix = null;
    let attempt = 0;

    for (attempt = 0; attempt < numAttempts; attempt++) {
      suffix = await getNondefectiveSuffix(
        chatModel,
        incomingTranscript,
        invocationOptions,
        config
      );
      if (!suffix) {
        throw new Error('Exhausted num_defective_reply_max_attempts.  Something seems to be wrong with this model or prompt.');
      }

      const schema = invocationOptions?.response_format?.json_schema?.schema;
      if (!schema) {
        if (res) {
          if (abortController.signal.aborted || res.destroyed) {
            return;
          }
          return res.json(suffix.toJSON());
        }
        return suffix.toJSON();
      }

      console.log(JSON.stringify({
        event: 'received response',
        response: suffix.toJSON()
      }));

      let data = suffix.toJSON().messages[0].content;
      let isValid = !schema;
      let msgsError = [];

      try {
        data = JSON.parse(data);
      } catch (err) {
        console.log({
          event: 'Error extending transcript: parsing json',
          bytes: data ? data.length : 0,
          err,
          content: data
        });
        throw err;
      }

      try {
        msgsError = validateAgainstSchema(data, schema);
        isValid = msgsError.length <= 0;
      } catch (err) {
        console.log({
          event: 'Error extending transcript: validating',
          bytes: data ? data.length : 0,
          err,
          content: data
        });
      }

      if (!isValid) {
        console.log(JSON.stringify({
          event: 'ran validateAgainstSchema',
          isValid,
          msgsError,
          data
        }));
      }

      if (isValid) {
        validOutput = suffix.toJSON();
        break;
      }

      if (attempt < (numAttempts - 1)) {
        mostValidOutput = data;
        console.log(JSON.stringify({
          event: 'attempting repair',
          attempt,
          numAttempts,
          data: suffix.toJSON()
        }));
        invocationOptions.repairs = requestToRepair(suffix, msgsError);
      }
    }

    if (res) {
      if (abortController.signal.aborted || res.destroyed) {
        return;
      }
      res.set('x-num-repair-attempts', String(attempt));
      if (validOutput) {
        return res.json(validOutput);
      }
      return res.status(422).json({
        error: 'The response could not be validated after multiple attempts.',
        mostValidOutput,
        finalResponse: suffix ? suffix.toJSON() : null
      });
    }

    if (!validOutput) {
      throw new Error('The response could not be validated after multiple attempts.');
    }
    return validOutput;
  } catch (err) {
    if (res) {
      if (abortController.signal.aborted) {
        return;
      }
      const j = jsonSafeFromException(err);
      console.error({
        event: 'Error extending transcript',
        stack: err.stack,
        errJson: j
      });
      console.error('Transcript', JSON.stringify(transcriptCopy, null, 10));
      return res.status(500).json(j);
    }
    throw err;
  } finally {
    if (req && res) {
      req.off('aborted', onDisconnect);
      res.off('close', onDisconnect);
    }
  }
}
