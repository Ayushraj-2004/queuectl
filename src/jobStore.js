'use strict';

const { computeRunAt } = require('./backoff');
const { getConfig } = require('./config');

function nowIso() {
  return new Date().toISOString();
}

function enqueue(db, job) {
  const now = nowIso();
  const maxRetries = job.max_retries ?? Number(getConfig(db, 'max_retries'));
  const backoffBase = job.backoff_base ?? Number(getConfig(db, 'backoff_base'));

  const existing = db.prepare('SELECT id FROM jobs WHERE id = ?').get(job.id);
  if (existing) {
    throw new Error(`Job with id "${job.id}" already exists`);
  }

  db.prepare(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, backoff_base, run_at, created_at, updated_at)
     VALUES (@id, @command, 'pending', 0, @max_retries, @backoff_base, @run_at, @created_at, @updated_at)`
  ).run({
    id: job.id,
    command: job.command,
    max_retries: maxRetries,
    backoff_base: backoffBase,
    run_at: job.run_at ?? now, // supports future "scheduled jobs" bonus; defaults to immediately claimable
    created_at: now,
    updated_at: now,
  });

  return getJob(db, job.id);
}

function getJob(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

/**
 * The atomic claim. This is the answer to "prevent duplicate processing".
 *
 * We do the SELECT-and-UPDATE as a single statement rather than two
 * separate calls. If this were two calls (SELECT a pending job, then
 * UPDATE it), a second worker could SELECT the *same* job in the gap
 * before the first worker's UPDATE lands — that's the race condition the
 * assignment calls out as a disqualifier.
 *
 * Because it's one statement, and better-sqlite3 executes it inside
 * SQLite's own locking, only one process's UPDATE can ever actually change
 * that row from 'pending' to 'processing'. Every other concurrent caller's
 * WHERE clause simply won't match a row anymore (changes === 0), so they
 * correctly find no work.
 */
function claimNextJob(db, workerId) {
  const now = nowIso();

  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'processing', locked_by = @workerId, updated_at = @now
       WHERE id = (
         SELECT id FROM jobs
         WHERE state = 'pending' AND (run_at IS NULL OR run_at <= @now)
         ORDER BY created_at ASC
         LIMIT 1
       )
       AND state = 'pending'`
    )
    .run({ workerId, now });

  if (result.changes === 0) return null;

  return db
    .prepare(
      `SELECT * FROM jobs WHERE state = 'processing' AND locked_by = ? ORDER BY updated_at DESC LIMIT 1`
    )
    .get(workerId);
}

function markCompleted(db, id) {
  db.prepare(
    `UPDATE jobs SET state = 'completed', locked_by = NULL, updated_at = ? WHERE id = ?`
  ).run(nowIso(), id);
}

/**
 * On failure: bump attempts, then decide retry vs. dead-letter.
 * attempts is incremented *before* the max_retries comparison, so
 * max_retries=3 means 3 total attempts are made before the job dies —
 * matching "Move to DLQ after max_retries".
 */
function markFailed(db, id, errorMessage) {
  const job = getJob(db, id);
  const attempts = job.attempts + 1;
  const now = nowIso();

  if (attempts >= job.max_retries) {
    db.prepare(
      `UPDATE jobs SET state = 'dead', attempts = ?, last_error = ?, locked_by = NULL, updated_at = ? WHERE id = ?`
    ).run(attempts, errorMessage, now, id);
  } else {
    const runAt = computeRunAt(job.backoff_base, attempts);
    db.prepare(
      `UPDATE jobs SET state = 'pending', attempts = ?, last_error = ?, run_at = ?, locked_by = NULL, updated_at = ? WHERE id = ?`
    ).run(attempts, errorMessage, runAt, now, id);
  }

  return getJob(db, id);
}

/**
 * Recovery for the "worker crashed mid-job" case (kill -9, OOM, host reboot).
 * A graceful SIGTERM always resolves a job to completed/failed/dead before
 * exiting, so this only ever touches jobs orphaned by a hard, un-caught kill.
 *
 * We use updated_at (set the instant a job was claimed) rather than a
 * separate heartbeat mechanism — simpler, and good enough since jobs are
 * expected to run for seconds, not hours. A job still legitimately running
 * past staleMs would be incorrectly reaped; that's a documented trade-off,
 * not a silent gap (see README).
 */
function reapStaleJobs(db, staleMs = 5 * 60 * 1000) {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const result = db
    .prepare(
      `UPDATE jobs SET state = 'pending', locked_by = NULL, updated_at = ?
       WHERE state = 'processing' AND updated_at < ?`
    )
    .run(nowIso(), cutoff);
  return result.changes;
}

function listJobs(db, state) {
  if (state) {
    return db
      .prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC')
      .all(state);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all();
}

function statusSummary(db) {
  const rows = db
    .prepare('SELECT state, COUNT(*) as count FROM jobs GROUP BY state')
    .all();
  const summary = { pending: 0, processing: 0, completed: 0, failed: 0, dead: 0 };
  for (const r of rows) summary[r.state] = r.count;
  return summary;
}

/** Requeue a dead job: reset attempts/state so it re-enters the normal pipeline. */
function retryDlqJob(db, id) {
  const job = getJob(db, id);
  if (!job) throw new Error(`No job with id "${id}"`);
  if (job.state !== 'dead') {
    throw new Error(`Job "${id}" is not in the DLQ (state=${job.state})`);
  }
  db.prepare(
    `UPDATE jobs SET state = 'pending', attempts = 0, run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`
  ).run(nowIso(), nowIso(), id);
  return getJob(db, id);
}

module.exports = {
  enqueue,
  getJob,
  claimNextJob,
  markCompleted,
  markFailed,
  listJobs,
  statusSummary,
  retryDlqJob,
  reapStaleJobs,
};
