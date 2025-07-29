// extend-transcript.mjs
import express from 'express';
import { fetchChatModel } from '../lib/core.mjs';
import { TranscriptFragment } from '../lib/transcript.mjs';
import { FunctionTool } from '../lib/function.mjs';
import { jsonSafeFromException } from '../lib/providers/provider_exception.mjs';
import Ajv from 'ajv';

const router = express.Router();

router.post('/extension', async (req, res) => {
  let transcriptCopy = null;
  try {
    const {
      model: modelId,
      system,
      temperature,
      transcript: transcriptJson,
      tools,
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

    // In case you need to register ephemeral tools:
    // (Example placeholder; adjust or remove as needed.)
    if (tools) {
      tools.forEach(toolConfig => {
        const tool = new FunctionTool(async (args) => {
          // In real implementation, do the actual tool work here.
          return { result: 'Tool execution placeholder' };
        });
        tool.name = toolConfig.name;
        tool.description = toolConfig.description;
        tool.input_schema = toolConfig.input_schema;
        chatModel.addTool(tool);
      });
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

    const numAttempts = 1+(invocationOptions.num_attempts_to_correct_schema || 0);

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
      const schema = invocationOptions.response_format.json_schema.schema;
      const data = JSON.parse(suffix.toJSON().messages[0].content)
      const isValid = validateAgainstSchema(data, schema);
      if (isValid) {
        validOutput = suffix.toJSON();
        break;
      } else if (attempt < (numAttempts - 1)) {
        mostValidOutput = data;
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

    if (validOutput) {
      res.json(validOutput)
    } else {
      // 422, Unprocessable Content, https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/422
      res.status(422).json({
        'error': 'The response could not be validated after multiple attempts.',
        'mostValidOutput': mostValidOutput,
        'finalResponse': suffix ? suffix.toJSON() : null
      });
    }
    return res.json(validResponse || suffix.toJSON());

  } catch (err) {
    const j = jsonSafeFromException(err)
    console.error({"event":"Error extending transcript",
      stack: err.stack,
      errJson: j
    })
    // Expand all inner objects to a depth of 10 for debugging:
    console.error('Transcript', JSON.stringify(transcriptCopy, null, 10));
    return res.status(500).json(j);
  }
});

function validateAgainstSchema(response, schema) {
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  return validate(response);
}

export default router;
