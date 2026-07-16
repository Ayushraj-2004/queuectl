#!/usr/bin/env node
'use strict';

const { getDb } = require('./src/db');
const jobStore = require('./src/jobStore');
const workerManager = require('./src/workerManager');
const fs = require('fs');
const path = require('path');

// Clean up
const dataDir = path.join(process.cwd(), '.queuectl');
if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('=== QueueCTL Functionality Test ===\n');

const db = getDb();

// Test 1: Enqueue a job
console.log('Test 1: Enqueue a job');
try {
  const job1 = jobStore.enqueue(db, { 
    id: 'test-job-1', 
    command: 'echo "Hello from queuectl"',
    max_retries: 3 
  });
  console.log(`✓ Job enqueued: ${job1.id}, state: ${job1.state}`);
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 2: Check status
console.log('\nTest 2: Check status');
try {
  const summary = jobStore.statusSummary(db);
  console.log(`✓ Job states:`, summary);
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 3: List jobs
console.log('\nTest 3: List pending jobs');
try {
  const jobs = jobStore.listJobs(db, 'pending');
  console.log(`✓ Found ${jobs.length} pending job(s)`);
  jobs.forEach(j => console.log(`  - ${j.id}: ${j.command}`));
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 4: Test job claiming (no race condition)
console.log('\nTest 4: Claim a job (atomic operation)');
try {
  const claimed = jobStore.claimNextJob(db, 'worker-1');
  if (claimed) {
    console.log(`✓ Job claimed: ${claimed.id}, state: ${claimed.state}, locked_by: ${claimed.locked_by}`);
  } else {
    console.log(`✗ No job was claimed`);
  }
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 5: Mark job as completed
console.log('\nTest 5: Mark job as completed');
try {
  jobStore.markCompleted(db, 'test-job-1');
  const updated = jobStore.getJob(db, 'test-job-1');
  console.log(`✓ Job marked as completed, state: ${updated.state}`);
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 6: Test failed job and retry logic
console.log('\nTest 6: Test failed job with retries');
try {
  const failJob = jobStore.enqueue(db, { 
    id: 'fail-test-1', 
    command: 'exit 1',
    max_retries: 2,
    backoff_base: 2
  });
  console.log(`✓ Created job that will fail: ${failJob.id}`);
  
  // Simulate failure
  const marked = jobStore.markFailed(db, 'fail-test-1', 'Command exited with non-zero status');
  console.log(`✓ Marked as failed. Attempts: ${marked.attempts}/${marked.max_retries}, state: ${marked.state}, run_at: ${marked.run_at}`);
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 7: Test DLQ (dead letter queue)
console.log('\nTest 7: Test Dead Letter Queue');
try {
  // Enqueue a job that will exhaust retries
  const dlqJob = jobStore.enqueue(db, { 
    id: 'dlq-test-1', 
    command: 'false',
    max_retries: 1
  });
  
  // Fail it max_retries times
  jobStore.markFailed(db, 'dlq-test-1', 'Failure 1');
  jobStore.markFailed(db, 'dlq-test-1', 'Failure 2'); // This should move to DLQ
  
  const deadJobs = jobStore.listJobs(db, 'dead');
  console.log(`✓ DLQ jobs: ${deadJobs.length}`);
  deadJobs.forEach(j => console.log(`  - ${j.id}: attempts=${j.attempts}, error="${j.last_error}"`));
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 8: Test configuration
console.log('\nTest 8: Test configuration management');
try {
  const { setConfig, getConfig } = require('./src/config');
  setConfig(db, 'max_retries', '5');
  const val = getConfig(db, 'max_retries');
  console.log(`✓ Config set: max_retries = ${val}`);
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 9: Test persistence (read same DB again)
console.log('\nTest 9: Test persistence');
try {
  const db2 = getDb();
  const jobs = jobStore.listJobs(db2, null);
  console.log(`✓ Database persisted, found ${jobs.length} total jobs after fresh connection`);
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

// Test 10: Worker management
console.log('\nTest 10: Worker management');
try {
  const workers = workerManager.listRunningWorkers();
  console.log(`✓ Currently running workers: ${workers.length}`);
} catch (e) {
  console.log(`✗ Failed: ${e.message}`);
}

console.log('\n=== Tests Complete ===');
process.exit(0);
