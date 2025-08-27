// Quick budget test to see debug output
import fs from 'fs';
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:5002/charm/api/charmonizer/v1';
const testDoc = JSON.parse(fs.readFileSync('../testing-data/synthetic-case-7-pages.pdf.doc.json', 'utf8'));

async function quickTest() {
  console.log('Quick Budget Test with 150 tokens');
  
  const payload = {
    document: testDoc,
    method: 'delta-fold',
    chunk_group: 'pages',
    model: 'gpt-4o-mini',
    guidance: 'Provide a clinical summary focusing on key medical information.',
    temperature: 0.3,
    annotation_field: 'quick_test',
    annotation_field_delta: 'quick_delta',
    budget: 150,
    tokens_per_word: 1.33
  };

  const response = await fetch(`${BASE_URL}/summaries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  const jobId = result.job_id;
  console.log(`Job ID: ${jobId}`);
  
  // Just wait for it to start processing
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Check server.log for debug output
  console.log('Check server.log or console for [BUDGET DEBUG] messages');
  
  return jobId;
}

quickTest().catch(console.error);