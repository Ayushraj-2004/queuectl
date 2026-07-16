'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./db');

const PID_FILE = path.join(DATA_DIR, 'workers.pid');
const WORKER_SCRIPT = path.join(__dirname, 'worker.js');
const LOG_DIR = path.join(DATA_DIR, 'logs');

function readPids() {
  if (!fs.existsSync(PID_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writePids(pids) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Each worker is a real, independent OS process (child_process.fork),
 * not an in-process async task. That's what makes "3 workers running in
 * parallel" a genuine test of the SQLite atomic-claim locking rather than
 * something that only works because it's all single-threaded JS.
 */
function startWorkers(count) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const existing = readPids().filter(isAlive);
  const spawned = [];

  for (let i = 0; i < count; i++) {
    // Each worker's stdout/stderr goes to its own log file rather than
    // being inherited from the CLI process. Inheriting stdio on a
    // detached, unref'd child means the child keeps that file descriptor
    // open for as long as it runs — which hangs anything (a shell
    // pipeline, a CI runner) that's waiting for the parent's output
    // stream to close. Logging to a file avoids that and gives durable
    // per-worker logs as a bonus (see .queuectl/logs/).
    const logPath = path.join(LOG_DIR, `worker-${Date.now()}-${i}.log`);
    const logFd = fs.openSync(logPath, 'a');

    const child = spawn(process.execPath, [WORKER_SCRIPT], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    spawned.push(child.pid);
  }

  writePids([...existing, ...spawned]);
  return spawned;
}

function stopWorkers() {
  const pids = readPids();
  const stopped = [];
  const stillTracked = [];

  for (const pid of pids) {
    if (isAlive(pid)) {
      process.kill(pid, 'SIGTERM'); // triggers graceful shutdown in worker.js
      stopped.push(pid);
      stillTracked.push(pid); // keep tracking; caller can verify later if needed
    }
  }

  // We clear the file immediately: SIGTERM has been sent, each worker will
  // finish its in-flight job and exit on its own. We don't block the CLI
  // waiting for that.
  writePids([]);
  return stopped;
}

function listRunningWorkers() {
  const pids = readPids().filter(isAlive);
  if (pids.length !== readPids().length) writePids(pids); // prune dead entries
  return pids;
}

module.exports = { startWorkers, stopWorkers, listRunningWorkers };
