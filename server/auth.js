// Auth routes: register/login with rate limiting, plus authenticated cloud
// team storage. Mounted on the express app by server/index.js.
const db = require('./db');

const USERNAME_RE = /^[\w][\w\- .]{1,16}[\w]$/;

// in-memory login throttle: 5 failures per key -> 15 min lockout
const attempts = new Map(); // key -> {count, lockedUntil}
function throttled(key) {
  const a = attempts.get(key);
  return a && a.lockedUntil && Date.now() < a.lockedUntil;
}
function recordFailure(key) {
  const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= 5) { a.lockedUntil = Date.now() + 15 * 60 * 1000; a.count = 0; }
  attempts.set(key, a);
}
function recordSuccess(key) { attempts.delete(key); }
setInterval(() => {
  for (const [k, a] of attempts) {
    if (!a.lockedUntil || Date.now() > a.lockedUntil + 3600_000) attempts.delete(k);
  }
}, 3600_000).unref();

function clientKey(req, username) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  return `${ip}|${String(username || '').toLowerCase()}`;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = token && db.verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

function mount(app) {
  app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body || {};
    const name = String(username || '').trim();
    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({ error: 'Username: 3-18 letters, numbers, spaces or dashes' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (db.userExists(name)) return res.status(409).json({ error: 'That name is taken' });
    const key = clientKey(req, name);
    if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    try {
      const user = db.createUser(name, password);
      res.json({ token: db.signToken(user.id, user.username), username: user.username });
    } catch {
      res.status(409).json({ error: 'That name is taken' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const name = String(username || '').trim();
    const key = clientKey(req, name);
    if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const user = db.verifyUser(name, String(password || ''));
    if (!user) {
      recordFailure(key);
      return res.status(401).json({ error: 'Wrong name or password' });
    }
    recordSuccess(key);
    res.json({ token: db.signToken(user.id, user.username), username: user.username });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ username: req.user.username });
  });

  app.get('/api/teams', requireAuth, (req, res) => {
    const data = db.loadTeams(req.user.id);
    res.json({ teams: data ? JSON.parse(data) : null });
  });

  app.put('/api/teams', requireAuth, (req, res) => {
    const teams = req.body && req.body.teams;
    if (!Array.isArray(teams) || teams.length > 100) {
      return res.status(400).json({ error: 'Bad teams payload' });
    }
    const json = JSON.stringify(teams);
    if (json.length > 400_000) return res.status(413).json({ error: 'Teams payload too large' });
    db.saveTeams(req.user.id, json);
    res.json({ ok: true });
  });
}

module.exports = { mount, requireAuth };
