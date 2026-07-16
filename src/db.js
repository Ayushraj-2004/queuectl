'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// All state lives under .queuectl/ in the current working directory,
// so `queuectl` behaves like `git` — scoped to wherever you run it from.
const DATA_DIR = path.join(process.cwd(), '.queuectl');
const DB_PATH = path.join(DATA_DIR, 'queue.db');

function getDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);

  // WAL (Write-Ahead Log) mode lets one writer proceed while readers don't
  // block, and lets concurrent writers queue instead of failing immediately.
  db.pragma('journal_mode = WAL');

  // If two worker processes hit the DB at literally the same instant, the
  // loser doesn't get an immediate "database is locked" error — it waits
  // up to 5s for the lock to free, then retries. This is what makes
  // multiple worker processes safe against each other without any
  // application-level mutex.
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            TEXT PRIMARY KEY,
      command       TEXT NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('pending','processing','completed','failed','dead')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_retries   INTEGER NOT NULL DEFAULT 3,
      backoff_base  REAL NOT NULL DEFAULT 2,
      run_at        TEXT,               -- earliest time this job may be claimed (backoff scheduling)
      locked_by     TEXT,               -- worker id currently holding this job (debug/visibility only)
      last_error    TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_state_runat ON jobs (state, run_at);

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed defaults only if absent — never overwrite a user's existing config.
  const seed = db.prepare(
    'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)'
  );
  seed.run('max_retries', '3');
  seed.run('backoff_base', '2');

  return db;
}

module.exports = { getDb, DATA_DIR, DB_PATH };
