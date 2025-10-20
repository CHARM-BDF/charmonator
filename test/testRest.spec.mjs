import tags from 'mocha-tags-ultra';
import { strict as assert } from 'assert';
import path from 'path';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const __port = 5003;
const pdfPath = path.join(__dirname, 'data', 'OMIM_660661.pdf');
const pngPath = path.join(__dirname, 'data', 'OMIM_660661.png');
const modelForChat = 'my-openai-model';
const modelForEmbeddings = 'my-openai-emodel';
const modelForTranscription = 'my-openai-vmodel';

const baseCharmonatorUrl = `http://localhost:${__port}/api/charmonator/v1`;
const baseCharmonizerUrl = `http://localhost:${__port}/api/charmonizer/v1`;

// A unitless constant converting the expected time on a good day to
// the upper bound time for failing a test.
const timeoutMargin = 5;

async function pollForComplete(urlStatus, urlResult) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const r = await fetch(urlStatus);
    const data = await r.json();
    if (data.status === 'error') {
      assert.fail(`Error: ${JSON.stringify(data)}`);
    }
    if (data.status === 'complete') {
      break;
    }
  }
  const finalRes = await fetch(urlResult);
  assert(finalRes.status >= 200 && finalRes.status < 300);
  const finalData = await finalRes.json();
  assert(finalData, 'Result should not be empty');
  return [finalData, finalRes];
}

tags().describe('testAllCharmonatorEndpoints', function() {
  it('should list available models', async function() {
    const url = `${baseCharmonatorUrl}/models`;
    const r = await fetch(url);
    assert(r.status >= 200 && r.status < 300);
    const data = await r.json();
    assert(Array.isArray(data.models), 'models should be an array');
  });

  tags('llm').it('should extend transcript', async function() {
    const url = `${baseCharmonatorUrl}/transcript/extension`
    const body = {
      model: modelForChat,
      system: 'You are a helpful test system.',
      temperature: 0.1,
      transcript: {
        messages: [
          { role: 'user', content: 'Hello. How are you?' }
        ]
      }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert(r.status >= 200 && r.status < 300);
    const data = await r.json();
    assert(Array.isArray(data.messages), 'response should contain messages array');
  });

  tags('llm').it('should convert image to markdown with llm', async function() {
    const url = `${baseCharmonatorUrl}/conversion/image`
    this.timeout(13000*timeoutMargin);
    const imgB64 = fs.readFileSync(pngPath).toString('base64');
    const body = {
      imageUrl: `data:image/png;base64,${imgB64}`,
      describe: true,
      model: modelForTranscription
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    assert(r.status >= 200 && r.status < 300);
    assert(data.markdown, 'Should return markdown');
  });

  // NOTE: this endpoint does not OCR!!
  it('should convert pdf to markdown synchronously without OCR', async function() {
    const url = `${baseCharmonatorUrl}/conversion/file`
    const form = new FormData();
    form.append('file', fs.createReadStream(pdfPath));
    form.append('ocr_threshold', "1.0")
    const r = await fetch(url, {
      method: 'POST',
      body: form
    });
    const data = await r.json();
    assert(r.status >= 200 && r.status < 300);
    assert(data.markdownContent, 'Should return markdownContent');
  });

  tags('llm').it('should generate embedding', async function() {
    const url = `${baseCharmonatorUrl}/embedding`
    const body = {
      model: modelForEmbeddings,
      text: 'Test embedding text'
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert(r.status >= 200 && r.status < 300);
    const data = await r.json();
    assert(Array.isArray(data.embedding), 'Should return embedding array');
  });
});

tags().describe('testAllCharmonizerEndpoints', function() {
  tags('llm').it('should convert pdf to doc object with LLM (long-running)', async function() {
    const url = `${baseCharmonizerUrl}/conversions/documents`
    this.timeout(24000*timeoutMargin);
    const form = new FormData();
    form.append('file', fs.createReadStream(pdfPath));
    // optionally specify a model if we want fallback
    form.append('model', modelForTranscription);
    form.append('ocr_threshold', "1.0")

    let r = await fetch(url, {
      method: 'POST',
      body: form
    });
    assert(r.status >= 200 && r.status < 300);
    let text = await r.text();
    let data = JSON.parse(text)
    const jobId = data.job_id;
    const urlStatus = `${baseCharmonizerUrl}/conversions/documents/${jobId}`;
    const urlResult = `${baseCharmonizerUrl}/conversions/documents/${jobId}/result`;
    const [finalDoc, finalRes] = await pollForComplete(urlStatus, urlResult);
    assert(finalDoc.id, 'Should have doc id');
  });

  tags('llm').it('should convert pdf to doc object without LLM (long-running)', async function() {
    const url = `${baseCharmonizerUrl}/conversions/documents`
    this.timeout(5000*timeoutMargin);
    const form = new FormData();
    form.append('file', fs.createReadStream(pdfPath));
    // optionally specify a model if we want fallback
    form.append('model', modelForTranscription);
    form.append('ocr_threshold', "0.5")

    let r = await fetch(url, {
      method: 'POST',
      body: form
    });
    assert(r.status >= 200 && r.status < 300);
    let text = await r.text();
    let data = JSON.parse(text)
    const jobId = data.job_id;
    const urlStatus = `${baseCharmonizerUrl}/conversions/documents/${jobId}`;
    const urlResult = `${baseCharmonizerUrl}/conversions/documents/${jobId}/result`;
    const [finalDoc, finalRes] = await pollForComplete(urlStatus, urlResult);
    assert(finalDoc.id, 'Should have doc id');
  });

  tags('llm').it('should summarize a doc object (long-running)', async function() {
    const url = `${baseCharmonizerUrl}/summaries`
    this.timeout(2000*timeoutMargin);
    // For simplicity, reuse a minimal doc object
    const minimalDoc = {
      id: 'test-doc-1',
      content: 'This is some sample text to summarize. Enough to test.'
    };
    const body = {
      document: minimalDoc,
      model: modelForChat,
      method: 'full',
      guidance: 'Give a short summary',
      temperature: 0.1
    };
    let r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert(r.status >= 200 && r.status < 300);
    let data = await r.json();
    const jobId = data.job_id;
    const urlStatus = `${url}/${jobId}`;
    const urlResult = `${url}/${jobId}/result`;
    const [finalDoc, finalRes] = await pollForComplete(urlStatus, urlResult);
    assert(finalDoc.id, 'Should have doc id');
  });

  tags('llm').it('should compute embeddings for a doc object (long-running)', async function() {
    const url = `${baseCharmonizerUrl}/embeddings`
    this.timeout(2000*timeoutMargin)
    const minimalDoc = {
      id: 'test-doc-2',
      content: 'Another set of text to embed.'
    };
    const body = {
      document: minimalDoc,
      model: modelForEmbeddings,
      chunk_group: 'all'
    };
    let r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert(r.status >= 200 && r.status < 300);
    let data = await r.json();
    const jobId = data.job_id;
    const urlStatus = `${url}/${jobId}`;
    const urlResult = `${url}/${jobId}/result`;
    const [finalDoc, finalRes] = await pollForComplete(urlStatus, urlResult);
    assert(finalDoc.id, 'Should have doc id');
  });

  it('should chunk a doc object', async function() {
    const url = `${baseCharmonizerUrl}/chunkings`
    this.timeout(2000*timeoutMargin);
    const minimalDoc = {
      id: 'test-doc-chunk',
      content: 'This text is somewhat long and we want to break it into chunks.'
    };
    const body = {
      document: minimalDoc,
      strategy: 'merge_and_split',
      chunk_size: 10,
      chunk_group: 'all'
    };
    let r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert(r.status >= 200 && r.status < 300);
    let data = await r.json();
    const jobId = data.job_id;
    const urlStatus = `${url}/${jobId}`;
    const urlResult = `${url}/${jobId}/result`;

    const [finalDoc, finalRes] = await pollForComplete(urlStatus, urlResult);

    assert(finalRes.status >= 200 && finalRes.status < 300);
    assert(Array.isArray(finalDoc.chunks), 'Should have a chunks array');
  });
});
