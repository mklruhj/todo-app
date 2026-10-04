'use strict';
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;
const COOKIE = 'dt_session';

const CATEGORIES = ['Work', 'Study', 'Health', 'Personal', 'Finance', 'Other'];
const PRIORITIES = ['high', 'medium', 'low'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1); // behind the host's load balancer: real client IP + HTTPS detection
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});

/* ---------- Helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s));
// Express 4 does not catch rejected promises; forward them to the error handler.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const scrypt = promisify(crypto.scrypt);
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, Date.now() + SESSION_DAYS * 864e5]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_DAYS * 864e5, path: '/' });
}

const getUser = id => db.get('SELECT * FROM users WHERE id = ?', [id]);
const publicUser = u => ({ id: Number(u.id), name: u.name, email: u.email, theme: u.theme, createdAt: u.created_at });
const rowToTask = r => ({
  id: r.id, title: r.title, category: r.category, priority: r.priority, repeat: r.repeat,
  days: r.days ? String(r.days).split(',').map(Number) : [], start: r.start, end: r.end || undefined, notes: r.notes
});

function validateTask(b) {
  const title = String(b.title || '').trim();
  if (!title || title.length > 120) throw bad('Title is required (max 120 characters)');
  if (!CATEGORIES.includes(b.category)) throw bad('Invalid category');
  if (!PRIORITIES.includes(b.priority)) throw bad('Invalid priority');
  if (!['once', 'weekly'].includes(b.repeat)) throw bad('Invalid repeat');
  if (!isDate(b.start)) throw bad('Invalid start date');
  let days = [];
  if (b.repeat === 'weekly') {
    if (!Array.isArray(b.days)) throw bad('Days are required');
    days = [...new Set(b.days.map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw bad('Pick at least one day');
  }
  const notes = String(b.notes || '').trim().slice(0, 160);
  return { title, category: b.category, priority: b.priority, repeat: b.repeat, days: days.join(','), start: b.start, notes };
}

/* Simple in-memory limiter for auth endpoints: 20 attempts / 15 min per IP */
const attempts = new Map();
function authLimiter(req, res, next) {
  const now = Date.now(), key = req.ip;
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  a.push(now); attempts.set(key, a); next();
}
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (a.every(t => now - t >= 15 * 60e3)) attempts.delete(k); }, 15 * 60e3).unref();

/* ---------- Auth middleware ---------- */
const requireUser = h(async (req, res, next) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = await db.get('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', [token]);
    if (row && Number(row.expires_at) > Date.now()) { req.user = row; req.uid = Number(row.id); req.token = token; return next(); }
    if (row) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  }
  res.status(401).json({ error: 'Not signed in' });
});

/* ---------- Auth routes ---------- */
app.post('/api/auth/register', authLimiter, h(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || name.length > 60) throw bad('Please enter your name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw bad('Please enter a valid email');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [email])) throw new HttpError(409, 'An account with this email already exists');
  let id;
  try {
    id = (await db.run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email, await hashPassword(password)])).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'An account with this email already exists'); // lost a race with a parallel signup
    throw e;
  }
  await startSession(res, id);
  res.status(201).json({ user: publicUser(await getUser(id)) });
}));

app.post('/api/auth/login', authLimiter, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await verifyPassword(String(req.body.password || ''), user.password_hash))) throw new HttpError(401, 'Incorrect email or password');
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await startSession(res, Number(user.id));
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', requireUser, h(async (req, res) => {
  await db.run('DELETE FROM sessions WHERE token = ?', [req.token]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}));

/* ---------- Account ---------- */
app.get('/api/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', requireUser, h(async (req, res) => {
  if (req.body.theme !== undefined) {
    if (!['light', 'dark'].includes(req.body.theme)) throw bad('Invalid theme');
    await db.run('UPDATE users SET theme = ? WHERE id = ?', [req.body.theme, req.uid]);
  }
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > 60) throw bad('Invalid name');
    await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.uid]);
  }
  res.json({ user: publicUser(await getUser(req.uid)) });
}));

app.post('/api/me/password', requireUser, h(async (req, res) => {
  const { current, next: nextPw } = req.body;
  if (!(await verifyPassword(String(current || ''), req.user.password_hash))) throw new HttpError(403, 'Current password is incorrect');
  if (String(nextPw || '').length < 8) throw bad('New password must be at least 8 characters');
  await db.batch([
    ['UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(String(nextPw)), req.uid]],
    ['DELETE FROM sessions WHERE user_id = ? AND token != ?', [req.uid, req.token]], // sign out other devices
  ]);
  res.json({ ok: true });
}));

app.delete('/api/me', requireUser, h(async (req, res) => {
  if (!(await verifyPassword(String(req.body.password || ''), req.user.password_hash))) throw new HttpError(403, 'Password is incorrect');
  await db.batch([
    ['DELETE FROM task_log WHERE user_id = ?', [req.uid]],
    ['DELETE FROM tasks WHERE user_id = ?', [req.uid]],
    ['DELETE FROM sessions WHERE user_id = ?', [req.uid]],
    ['DELETE FROM users WHERE id = ?', [req.uid]],
  ]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}));

/* ---------- Data ---------- */
async function loadData(uid) {
  const tasks = (await db.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at, rowid', [uid])).map(rowToTask);
  const log = {};
  for (const r of await db.all('SELECT task_id, date, status FROM task_log WHERE user_id = ?', [uid])) {
    (log[r.date] = log[r.date] || {})[r.task_id] = r.status;
  }
  return { tasks, log };
}
app.get('/api/data', requireUser, h(async (req, res) => res.json(await loadData(req.uid))));

async function ownTask(uid, id) {
  const t = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [String(id), uid]);
  if (!t) throw new HttpError(404, 'Task not found');
  return t;
}

app.post('/api/tasks', requireUser, h(async (req, res) => {
  const t = validateTask(req.body);
  const id = crypto.randomUUID();
  await db.run(`INSERT INTO tasks (id, user_id, title, category, priority, repeat, days, start, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.uid, t.title, t.category, t.priority, t.repeat, t.days, t.start, t.notes]);
  res.status(201).json({ task: rowToTask(await ownTask(req.uid, id)) });
}));

app.put('/api/tasks/:id', requireUser, h(async (req, res) => {
  await ownTask(req.uid, req.params.id);
  const t = validateTask(req.body);
  await db.run(`UPDATE tasks SET title=?, category=?, priority=?, repeat=?, days=?, start=?, notes=?, end=NULL WHERE id=? AND user_id=?`,
    [t.title, t.category, t.priority, t.repeat, t.days, t.start, t.notes, req.params.id, req.uid]);
  res.json({ task: rowToTask(await ownTask(req.uid, req.params.id)) });
}));

// One-time tasks are deleted with their history. Recurring tasks are stopped (end date set) so history is kept.
app.delete('/api/tasks/:id', requireUser, h(async (req, res) => {
  const t = await ownTask(req.uid, req.params.id);
  if (t.repeat === 'once') {
    await db.batch([
      ['DELETE FROM task_log WHERE task_id = ? AND user_id = ?', [t.id, req.uid]],
      ['DELETE FROM tasks WHERE id = ? AND user_id = ?', [t.id, req.uid]],
    ]);
    return res.json({ deleted: true });
  }
  const end = req.body && req.body.end;
  if (!isDate(end)) throw bad('Invalid end date');
  await db.run('UPDATE tasks SET end = ? WHERE id = ? AND user_id = ?', [end, t.id, req.uid]);
  res.json({ task: rowToTask(await ownTask(req.uid, t.id)) });
}));

/* Set status for one or more tasks: { date, entries: [{ taskId, status: 'done'|'missed'|'pending' }] } */
app.put('/api/log', requireUser, h(async (req, res) => {
  const { date, entries } = req.body;
  if (!isDate(date)) throw bad('Invalid date');
  if (!Array.isArray(entries) || !entries.length || entries.length > 500) throw bad('Invalid entries');
  const owned = new Set((await db.all('SELECT id FROM tasks WHERE user_id = ?', [req.uid])).map(r => r.id));
  const stmts = entries.map(e => {
    if (!owned.has(e.taskId)) throw new HttpError(404, 'Task not found');
    if (e.status === 'pending') return ['DELETE FROM task_log WHERE task_id = ? AND date = ? AND user_id = ?', [e.taskId, date, req.uid]];
    if (e.status === 'done' || e.status === 'missed') return [`INSERT INTO task_log (task_id, user_id, date, status) VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, date) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`, [e.taskId, req.uid, date, e.status]];
    throw bad('Invalid status');
  });
  await db.batch(stmts);
  res.json({ ok: true });
}));

/* ---------- Backup ---------- */
app.get('/api/export', requireUser, h(async (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="daytrack-backup.json"');
  res.json({ app: 'daytrack', version: 1, exportedAt: new Date().toISOString(), ...(await loadData(req.uid)) });
}));

app.post('/api/import', requireUser, h(async (req, res) => {
  const { tasks, log } = req.body || {};
  if (!Array.isArray(tasks) || !log || typeof log !== 'object') throw bad('Invalid backup file');
  const uid = req.uid;
  const stmts = [['DELETE FROM task_log WHERE user_id = ?', [uid]], ['DELETE FROM tasks WHERE user_id = ?', [uid]]];
  const idMap = {};
  for (const raw of tasks) {
    const t = validateTask(raw);
    const id = crypto.randomUUID(); idMap[raw.id] = id;
    stmts.push([`INSERT INTO tasks (id, user_id, title, category, priority, repeat, days, start, end, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, uid, t.title, t.category, t.priority, t.repeat, t.days, t.start, isDate(raw.end) ? raw.end : null, t.notes]]);
  }
  for (const [date, entries] of Object.entries(log)) {
    if (!isDate(date) || !entries || typeof entries !== 'object') continue;
    for (const [oldId, status] of Object.entries(entries)) {
      if (idMap[oldId] && (status === 'done' || status === 'missed')) stmts.push(['INSERT OR REPLACE INTO task_log (task_id, user_id, date, status) VALUES (?,?,?,?)', [idMap[oldId], uid, date, status]]);
    }
  }
  await db.batch(stmts);
  res.json(await loadData(uid));
}));

app.delete('/api/data', requireUser, h(async (req, res) => {
  await db.batch([['DELETE FROM task_log WHERE user_id = ?', [req.uid]], ['DELETE FROM tasks WHERE user_id = ?', [req.uid]]]);
  res.json({ ok: true });
}));

/* ---------- Static + errors ---------- */
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`DayTrack running at http://localhost:${PORT}`)))
  .catch(err => { console.error('Database connection failed:', err.message); process.exit(1); });
