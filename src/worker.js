'use strict';

const { execSync } = require('child_process');
const { getDb } = require('./db');
const jobStore = require('./jobStore');

const POLL_INTERVAL_MS = 500;
const workerId = `worker-${process.pid}`;
const db = getDb();

let shuttingDown = false;
let currentJobId = null;

function log(msg) {
  // Prefixed so multi-worker output is distinguishable when run in foreground.
  console.log(`[${workerId}] ${msg}`);
}

function executeJob(job) {
  currentJobId = job.id;
  log(`processing job ${job.id}: ${job.command}`);
  try {
    // execSync throws if the command exits non-zero OR isn't found — both
    // cases the assignment wants treated as failure-and-retry.
    execSync(job.command, { stdio: 'pipe', timeout: 60_000 });
    jobStore.markCompleted(db, job.id);
    log(`job ${job.id} completed`);
  } catch (err) {
    const message = err.stderr?.toString().trim() || err.message;
    const updated = jobStore.markFailed(db, job.id, message);
    if (updated.state === 'dead') {
      log(`job ${job.id} exhausted retries (${updated.attempts}) -> moved to DLQ: ${message}`);
    } else {
      log(`job ${job.id} failed (attempt ${updated.attempts}/${updated.max_retries}), retry at ${updated.run_at}: ${message}`);
    }
  } finally {
    currentJobId = null;
  }
}

function pollLoop() {
  if (shuttingDown) {
    log('shutdown complete');
    process.exit(0);
  }

  const job = jobStore.claimNextJob(db, workerId);
  if (job) {
    executeJob(job);
    setImmediate(pollLoop); // no wait — check for more work right away
  } else {
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

// Graceful shutdown: we only set a flag here. Because job execution is
// synchronous (execSync), a SIGTERM arriving mid-job is handled by Node
// only after the current execSync call returns — so the in-flight job
// always finishes before pollLoop sees shuttingDown=true and exits.
// We never kill mid-job.
function handleShutdownSignal(signal) {
  log(`received ${signal}, finishing current job (if any) then exiting...`);
  shuttingDown = true;
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

const reaped = jobStore.reapStaleJobs(db);
if (reaped > 0) log(`reaped ${reaped} stale job(s) orphaned by a crashed worker`);

log('started');
pollLoop();
