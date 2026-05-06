import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import { Message, TranscriptFragment } from '../lib/transcript.mjs';
import {
  buildStructuredOutputOptions,
  callLLM
} from '../routes/charmonizer/document-summarize.mjs';

class FakeChatModel {
  constructor(outputs) {
    this.outputs = [...outputs];
    this.calls = [];
  }

  async extendTranscript(prefix, _callOnOutput, _suffix, options) {
    this.calls.push({
      prefix: prefix.toJSON ? prefix.toJSON() : prefix,
      options
    });

    const content = this.outputs.shift();
    return new TranscriptFragment([
      new Message('assistant', content)
    ]);
  }
}

tags().describe('Summaries schema repair', function() {
  it('should repair invalid structured summary replies before returning', async function() {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        status: {
          type: 'string',
          enum: ['known', 'unknown']
        }
      },
      required: ['name', 'status'],
      additionalProperties: false
    };
    const chatModel = new FakeChatModel([
      JSON.stringify({ name: 123, status: 'bad' }),
      JSON.stringify({ name: 'Alice', status: 'unknown' })
    ]);
    const options = buildStructuredOutputOptions(
      { jsonSchema: schema },
      {
        num_defective_reply_max_attempts: 0,
        num_schema_repair_max_attempts: 1
      }
    );

    const reply = await callLLM(chatModel, [
      { role: 'system', content: 'You are a summarizer.' },
      { role: 'user', content: 'Summarize the document.' }
    ], options);

    assert.deepEqual(JSON.parse(reply), { name: 'Alice', status: 'unknown' });
    assert.equal(chatModel.calls.length, 2);

    const secondCallMessages = chatModel.calls[1].prefix.messages;
    assert.equal(secondCallMessages.length, 4);
    assert.equal(secondCallMessages[2].role, 'assistant');
    assert.equal(secondCallMessages[2].content, JSON.stringify({ name: 123, status: 'bad' }));
    assert.equal(secondCallMessages[3].role, 'user');
    assert.match(secondCallMessages[3].content, /ValidationErrors/);
    assert.match(secondCallMessages[3].content, /"keyword": "type"/);
    assert.match(secondCallMessages[3].content, /must be string/);
  });

  it('should add structured output options for summaries json_schema requests', function() {
    const schema = {
      type: 'array',
      items: { type: 'string' }
    };
    const options = buildStructuredOutputOptions(
      { jsonSchema: schema },
      {
        stream: false,
        num_schema_repair_max_attempts: 2
      }
    );

    assert.deepEqual(options, {
      stream: false,
      num_schema_repair_max_attempts: 2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'forced-schema',
          schema
        }
      }
    });
  });
});
