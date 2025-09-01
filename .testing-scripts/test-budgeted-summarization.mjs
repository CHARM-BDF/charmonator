// Test cases for budgeted summarization feature
// Tests various budget sizes with synthetic-case-7-pages.pdf.doc.json

import fs from 'fs';
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:5002/charm/api/charmonizer/v1';

// Load test document
const testDoc = JSON.parse(fs.readFileSync('../testing-data/synthetic-case-7-pages.pdf.doc.json', 'utf8'));

console.log(`Testing with document: ${testDoc.metadata.originating_filename}`);
console.log(`Pages available: ${testDoc.chunks.pages.length}`);

/**
 * Run a summarization test with specific budget
 * @param {string} testName - Name of the test
 * @param {number|null} budget - Budget in tokens (null for no budget)
 * @param {number} tokensPerWord - Tokens per word ratio
 * @param {number} timeoutMs - Timeout in milliseconds
 */
async function runBudgetTest(testName, budget, tokensPerWord = 1.33, timeoutMs = 300000) {
  console.log(`\n=== ${testName} ===`);
  console.log(`Budget: ${budget || 'unlimited'} tokens`);
  console.log(`Tokens per word: ${tokensPerWord}`);
  console.log(`Expected words per chunk: ${budget ? Math.floor(budget / testDoc.chunks.pages.length / tokensPerWord) : 'unlimited'}`);

  const payload = {
    document: testDoc,
    method: 'delta-fold',
    chunk_group: 'pages',
    model: 'gpt-4o-mini', // Use faster model for testing
    guidance: 'Provide a clinical summary focusing on key medical information.',
    temperature: 0.3,
    annotation_field: 'budget_test_summary',
    annotation_field_delta: 'budget_test_delta',
    ...(budget && { budget, tokens_per_word: tokensPerWord })
  };

  const startTime = Date.now();

  try {
    // Start summarization job
    console.log('Starting summarization job...');
    const response = await fetch(`${BASE_URL}/summaries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const jobId = result.job_id;
    console.log(`Job ID: ${jobId}`);

    // Poll for completion
    let status = 'pending';
    let iterations = 0;
    const maxIterations = timeoutMs / 2000; // Check every 2 seconds

    while (status !== 'complete' && status !== 'error' && iterations < maxIterations) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      iterations++;

      const statusResponse = await fetch(`${BASE_URL}/summaries/${jobId}`);
      if (!statusResponse.ok) {
        throw new Error(`Failed to check status: ${statusResponse.status}`);
      }

      const statusData = await statusResponse.json();
      status = statusData.status;
      
      console.log(`Status: ${status} (${statusData.chunks_completed}/${statusData.chunks_total} chunks)`);
    }

    if (status === 'error') {
      const errorResponse = await fetch(`${BASE_URL}/summaries/${jobId}`);
      const errorData = await errorResponse.json();
      throw new Error(`Job failed: ${errorData.error}`);
    }

    if (status !== 'complete') {
      throw new Error(`Job timed out after ${timeoutMs}ms`);
    }

    // Get results
    const resultResponse = await fetch(`${BASE_URL}/summaries/${jobId}/result`);
    if (!resultResponse.ok) {
      throw new Error(`Failed to get results: ${resultResponse.status}`);
    }

    const finalDoc = await resultResponse.json();
    const summary = finalDoc.annotations?.budget_test_summary;
    
    if (!summary) {
      throw new Error('No summary found in results');
    }

    const elapsedTime = Date.now() - startTime;
    console.log(`Completed in ${Math.round(elapsedTime / 1000)}s`);

    // Analyze results
    analyzeResults(testName, summary, budget, tokensPerWord);

    // Clean up job
    await fetch(`${BASE_URL}/summaries/${jobId}`, { method: 'DELETE' });

    return summary;

  } catch (error) {
    console.error(`Test failed: ${error.message}`);
    return null;
  }
}

/**
 * Analyze summarization results
 */
function analyzeResults(testName, summary, budget, tokensPerWord) {
  console.log('\n--- Results Analysis ---');
  
  if (Array.isArray(summary)) {
    console.log(`Summary type: Array with ${summary.length} deltas`);
    
    let totalWords = 0;
    let totalTokensEst = 0;
    
    summary.forEach((delta, i) => {
      const deltaStr = typeof delta === 'string' ? delta : JSON.stringify(delta);
      const words = deltaStr.trim().split(/\s+/).length;
      const tokensEst = Math.ceil(words * tokensPerWord);
      
      totalWords += words;
      totalTokensEst += tokensEst;
      
      console.log(`  Delta ${i + 1}: ${words} words, ~${tokensEst} tokens`);
      if (deltaStr.length < 200) {
        console.log(`    Content: "${deltaStr.substring(0, 150)}${deltaStr.length > 150 ? '...' : ''}"`);
      }
    });
    
    console.log(`\nTotal: ${totalWords} words, ~${totalTokensEst} tokens`);
    
    if (budget) {
      const budgetCompliance = totalTokensEst <= budget;
      const utilizationPct = Math.round((totalTokensEst / budget) * 100);
      
      console.log(`Budget compliance: ${budgetCompliance ? 'PASS' : 'FAIL'}`);
      console.log(`Budget utilization: ${utilizationPct}% (${totalTokensEst}/${budget})`);
      
      if (!budgetCompliance) {
        console.log(`⚠️  BUDGET EXCEEDED by ${totalTokensEst - budget} tokens`);
      } else if (utilizationPct < 70) {
        console.log(`ℹ️  Low utilization - could potentially use more budget`);
      }
    }
  } else {
    console.log('Summary type: Single value');
    console.log(`Content: ${typeof summary === 'string' ? summary.substring(0, 200) : JSON.stringify(summary).substring(0, 200)}...`);
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🧪 Starting Budget Summarization Tests');
  console.log('=====================================');

  const tests = [
    // Test 1: No budget (baseline)
    { name: 'Baseline (No Budget)', budget: null },
    
    // Test 2: Very tight budget - should force very short summaries
    { name: 'Very Tight Budget (70 tokens)', budget: 70 },
    
    // Test 3: Small budget - roughly 10 words per page
    { name: 'Small Budget (150 tokens)', budget: 150 },
    
    // Test 4: Medium budget - roughly 25 words per page  
    { name: 'Medium Budget (350 tokens)', budget: 350 },
    
    // Test 5: Large budget - roughly 50 words per page
    { name: 'Large Budget (700 tokens)', budget: 700 },
    
    // Test 6: Different tokens per word ratio
    { name: 'Medium Budget + Different Ratio', budget: 350, tokensPerWord: 1.5 },
    
    // Test 7: Edge case - budget smaller than page count
    { name: 'Extreme Budget (5 tokens)', budget: 5 }
  ];

  const results = {};
  
  for (const test of tests) {
    const result = await runBudgetTest(
      test.name, 
      test.budget, 
      test.tokensPerWord || 1.33,
      600000 // 10 minute timeout
    );
    results[test.name] = result;
    
    // Brief pause between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n🏁 All Tests Complete');
  console.log('====================');
  
  // Summary comparison
  console.log('\nComparative Analysis:');
  Object.entries(results).forEach(([name, summary]) => {
    if (summary && Array.isArray(summary)) {
      const totalWords = summary.reduce((sum, delta) => {
        const deltaStr = typeof delta === 'string' ? delta : JSON.stringify(delta);
        return sum + deltaStr.trim().split(/\s+/).length;
      }, 0);
      console.log(`${name}: ${totalWords} total words`);
    }
  });
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(console.error);
}

export { runBudgetTest, runAllTests };