// Budget Analysis - Direct comparison between budgeted and non-budgeted summaries
import fs from 'fs';
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:5002/charm/api/charmonizer/v1';
const testDoc = JSON.parse(fs.readFileSync('../testing-data/synthetic-case-7-pages.pdf.doc.json', 'utf8'));

/**
 * Run a single test and return detailed results
 */
async function runTest(name, budget = null) {
  console.log(`\n🧪 Running: ${name}`);
  
  const payload = {
    document: testDoc,
    method: 'delta-fold',
    chunk_group: 'pages',
    model: 'gpt-4o-mini',
    guidance: 'Provide a clinical summary focusing on key medical information.',
    temperature: 0.3,
    annotation_field: 'test_summary',
    ...(budget && { budget, tokens_per_word: 1.33 })
  };

  const response = await fetch(`${BASE_URL}/summaries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  const jobId = result.job_id;
  
  // Wait for completion
  let status = 'pending';
  while (status !== 'complete' && status !== 'error') {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const statusResponse = await fetch(`${BASE_URL}/summaries/${jobId}`);
    const statusData = await statusResponse.json();
    status = statusData.status;
  }

  if (status === 'error') {
    throw new Error('Job failed');
  }

  // Get results
  const resultResponse = await fetch(`${BASE_URL}/summaries/${jobId}/result`);
  const finalDoc = await resultResponse.json();
  const summary = finalDoc.annotations?.test_summary;
  
  // Clean up
  await fetch(`${BASE_URL}/summaries/${jobId}`, { method: 'DELETE' });
  
  // Analyze results
  if (Array.isArray(summary)) {
    let totalWords = 0;
    let totalTokensEst = 0;
    const deltaDetails = [];
    
    summary.forEach((delta, i) => {
      const deltaStr = typeof delta === 'string' ? delta : JSON.stringify(delta);
      const words = deltaStr.trim().split(/\s+/).length;
      const tokensEst = Math.ceil(words * 1.33);
      
      totalWords += words;
      totalTokensEst += tokensEst;
      
      deltaDetails.push({
        chunk: i + 1,
        words: words,
        tokens: tokensEst,
        content: deltaStr.substring(0, 100) + (deltaStr.length > 100 ? '...' : '')
      });
    });
    
    return {
      name,
      budget,
      totalWords,
      totalTokensEst,
      deltaCount: summary.length,
      deltaDetails,
      budgetCompliance: budget ? totalTokensEst <= budget : null,
      utilization: budget ? Math.round((totalTokensEst / budget) * 100) : null
    };
  }
  
  return null;
}

/**
 * Compare budgeted vs non-budgeted results
 */
async function runComparison() {
  console.log('🔬 Budget Feature Analysis');
  console.log('==========================');
  
  const tests = [
    { name: 'Baseline (No Budget)', budget: null },
    { name: 'Tight Budget (100 tokens)', budget: 100 },
    { name: 'Medium Budget (200 tokens)', budget: 200 },
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      const result = await runTest(test.name, test.budget);
      if (result) {
        results.push(result);
      }
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
    }
    
    // Brief pause between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Analysis
  console.log('\n📊 Results Summary');
  console.log('==================');
  
  results.forEach(result => {
    console.log(`\n${result.name}:`);
    console.log(`  Total: ${result.totalWords} words, ~${result.totalTokensEst} tokens`);
    console.log(`  Deltas: ${result.deltaCount} chunks processed`);
    
    if (result.budget) {
      console.log(`  Budget: ${result.totalTokensEst}/${result.budget} tokens (${result.utilization}%)`);
      console.log(`  Compliant: ${result.budgetCompliance ? '✅' : '❌'}`);
    }
    
    console.log(`  Per-chunk breakdown:`);
    result.deltaDetails.forEach(detail => {
      console.log(`    Chunk ${detail.chunk}: ${detail.words} words, ~${detail.tokens} tokens`);
      console.log(`      "${detail.content}"`);
    });
  });
  
  // Comparative analysis
  if (results.length >= 2) {
    console.log('\n🎯 Budget Effectiveness Analysis');
    console.log('================================');
    
    const baseline = results.find(r => !r.budget);
    const budgeted = results.filter(r => r.budget);
    
    if (baseline) {
      console.log(`Baseline summary: ${baseline.totalWords} words (~${baseline.totalTokensEst} tokens)`);
      
      budgeted.forEach(test => {
        const reduction = baseline.totalTokensEst - test.totalTokensEst;
        const reductionPct = Math.round((reduction / baseline.totalTokensEst) * 100);
        
        console.log(`\n${test.name}:`);
        console.log(`  Achieved: ${test.totalTokensEst} tokens (${test.utilization}% of budget)`);
        console.log(`  Reduction: ${reduction} tokens (${reductionPct}% smaller than baseline)`);
        console.log(`  Budget compliance: ${test.budgetCompliance ? '✅ PASS' : '❌ FAIL'}`);
        
        if (test.budgetCompliance) {
          console.log(`  🎉 SUCCESS: Budget constraint successfully enforced!`);
        } else {
          console.log(`  ⚠️  Budget exceeded by ${test.totalTokensEst - test.budget} tokens`);
        }
      });
    }
  }
}

runComparison().catch(console.error);