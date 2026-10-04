'use strict';
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

// Production: set TURSO_DATABASE_URL (libsql://...) and TURSO_AUTH_TOKEN to use a hosted Turso database.
// Local: falls back to a SQLite file on disk (DB_FILE or data/daytrack.db).
// Values pasted into hosting dashboards often carry a stray newline or space, which breaks URL parsing.
let url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined;
if (!url) {
  const file = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'daytrack.db'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  url = 'file:' + file;
}
const client = createClient({ url, authToken });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  theme         TEXT NOT NULL DEFAULT 'light',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL,
  priority   TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
  repeat     TEXT NOT NULL CHECK (repeat IN ('once','weekly')),
  days       TEXT NOT NULL DEFAULT '',          -- comma separated weekday numbers 0-6
  start      TEXT NOT NULL,                     -- YYYY-MM-DD
  end        TEXT,                              -- YYYY-MM-DD, set when a recurring task is stopped
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE TABLE IF NOT EXISTS task_log (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,                     -- YYYY-MM-DD
  status     TEXT NOT NULL CHECK (status IN ('done','missed')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, date)
);
CREATE INDEX IF NOT EXISTS idx_log_user_date ON task_log(user_id, date);
`;

const stmt = (sql, args = []) => ({ sql, args });

module.exports = {
  init: () => client.executeMultiple(SCHEMA),
  get: async (sql, args) => (await client.execute(stmt(sql, args))).rows[0],
  all: async (sql, args) => (await client.execute(stmt(sql, args))).rows,
  run: async (sql, args) => {
    const r = await client.execute(stmt(sql, args));
    return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid === undefined ? undefined : Number(r.lastInsertRowid) };
  },
  // Runs statements atomically: all succeed or none are applied.
  // Child rows are always deleted explicitly, so we never depend on foreign-key cascades.
  batch: (statements) => client.batch(statements.map(([sql, args]) => stmt(sql, args)), 'write'),
};
