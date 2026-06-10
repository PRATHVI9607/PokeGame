// SQLite persistence: accounts + cloud-saved teams. The DB file lives next to
// the repo by default; override with DATABASE_PATH (e.g. a mounted disk).
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'pokearena.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  passhash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS user_teams (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// signing secret survives restarts so sessions stay valid
function getSecret() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('secret');
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('secret', secret);
  return secret;
}
const SECRET = process.env.SESSION_SECRET || getSecret();

// ---------- password hashing (scrypt, constant-time compare) ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function createUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passhash = hashPassword(password, salt);
  const info = db.prepare(
    'INSERT INTO users (username, passhash, salt, created_at) VALUES (?, ?, ?, ?)',
  ).run(username, passhash, salt, Date.now());
  return { id: info.lastInsertRowid, username };
}

function verifyUser(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row) {
    // burn comparable time so missing users aren't distinguishable
    hashPassword(password, 'dummysaltdummysalt');
    return null;
  }
  const candidate = Buffer.from(hashPassword(password, row.salt), 'hex');
  const actual = Buffer.from(row.passhash, 'hex');
  if (candidate.length !== actual.length || !crypto.timingSafeEqual(candidate, actual)) return null;
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, username: row.username };
}

function userExists(username) {
  return !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
}

// ---------- session tokens (HMAC-signed, 30 days) ----------
const TOKEN_TTL = 30 * 24 * 3600 * 1000;

function signToken(userId, username) {
  const payload = Buffer.from(JSON.stringify({ u: userId, n: username, e: Date.now() + TOKEN_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.u || !data.n || Date.now() > data.e) return null;
    return { id: data.u, username: data.n };
  } catch {
    return null;
  }
}

// ---------- team storage ----------
function saveTeams(userId, teamsJson) {
  db.prepare(`
    INSERT INTO user_teams (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(userId, teamsJson, Date.now());
}
function loadTeams(userId) {
  const row = db.prepare('SELECT data FROM user_teams WHERE user_id = ?').get(userId);
  return row ? row.data : null;
}

module.exports = { createUser, verifyUser, userExists, signToken, verifyToken, saveTeams, loadTeams };
