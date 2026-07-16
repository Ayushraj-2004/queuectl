'use strict';

function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setConfig(db, key, value) {
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function getAllConfig(db) {
  const rows = db.prepare('SELECT key, value FROM config').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

module.exports = { getConfig, setConfig, getAllConfig };
