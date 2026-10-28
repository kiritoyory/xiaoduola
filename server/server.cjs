'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const Database = require('better-sqlite3');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const scrypt = promisify(crypto.scrypt);
const app = express();
const port = Number(process.env.PORT || 8787);
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const databasePath = path.join(dataDirectory, 'xiaoduola.sqlite');
const tokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const userRequestTimes = new Map();

fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    api_url TEXT NOT NULL DEFAULT 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model TEXT NOT NULL DEFAULT ''
  );
  INSERT OR IGNORE INTO settings (id) VALUES (1);
`);

const sql = {
  userByEmail: database.prepare('SELECT * FROM users WHERE email = ?'),
  userById: database.prepare('SELECT id, email, is_admin FROM users WHERE id = ?'),
  insertUser: database.prepare('INSERT INTO users (email, password_salt, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'),
  insertSession: database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: database.prepare(`
    SELECT users.id, users.email, users.is_admin
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `),
  deleteSession: database.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  insertInvite: database.prepare('INSERT INTO invites (code_hash, expires_at) VALUES (?, ?)'),
  invite: database.prepare('SELECT code_hash FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?'),
  useInvite: database.prepare('UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'),
  getSettings: database.prepare('SELECT api_url AS apiUrl, model FROM settings WHERE id = 1'),
  updateSettings: database.prepare('UPDATE settings SET api_url = ?, model = ? WHERE id = 1'),
  userCount: database.prepare('SELECT COUNT(*) AS count FROM users'),
  expiredSessions: database.prepare('DELETE FROM sessions WHERE expires_at <= ?')
};

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function passwordHash(password, salt) {
  return scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function createUser(email, password, isAdmin = false) {
  const salt = crypto.randomBytes(16);
  const hashed = await passwordHash(password, salt);
  return sql.insertUser.run(email, salt.toString('hex'), hashed.toString('hex'), isAdmin ? 1 : 0, Date.now()).lastInsertRowid;
}

async function verifyPassword(user, password) {
  const candidate = await passwordHash(password, Buffer.from(user.password_salt, 'hex'));
  const stored = Buffer.from(user.password_hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function validateCredentials(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw Object.assign(new Error('请输入有效的邮箱地址。'), { status: 400 });
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw Object.assign(new Error('密码长度必须为 12 到 128 个字符。'), { status: 400 });
  }
}

function validateHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址。`), { status: 400 });
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址。`), { status: 400 });
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) {
    throw Object.assign(new Error(`${label}不能指向本机地址。`), { status: 400 });
  }
  return url.href;
}

function bearerToken(request) {
  const header = request.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header);
  return match && match[1];
}

function requireUser(request, response, next) {
  const token = bearerToken(request);
  if (!token) return response.status(401).json({ error: '请先登录。' });
  const user = sql.sessionUser.get(hashToken(token), Date.now());
  if (!user) return response.status(401).json({ error: '登录已过期，请重新登录。' });
  request.user = user;
  request.sessionHash = hashToken(token);
  next();
}

function requireAdmin(request, response, next) {
  if (!request.user.is_admin) return response.status(403).json({ error: '只有中央服务器管理员可以修改共享设置。' });
  next();
}

function limitUserRequests(request, response, next) {
  const now = Date.now();
  const start = now - 60_000;
  const recent = (userRequestTimes.get(request.user.id) || []).filter((time) => time > start);
  if (recent.length >= 20) return response.status(429).json({ error: '请求过于频繁，请稍后再试。' });
  recent.push(now);
  userRequestTimes.set(request.user.id, recent);
  next();
}

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb' }));
app.use('/v1/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));

app.get('/health', (_request, response) => response.json({ ok: true }));

app.post('/v1/auth/register', async (request, response, next) => {
  try {
    const email = normalizeEmail(request.body.email);
    const password = request.body.password;
    const inviteCode = String(request.body.inviteCode || '').trim();
    validateCredentials(email, password);
    if (!/^[A-Za-z0-9_-]{24,100}$/.test(inviteCode)) {
      return response.status(400).json({ error: '请输入有效的邀请码。' });
    }
    const codeHash = hashToken(inviteCode);
    if (!sql.invite.get(codeHash, Date.now())) {
      return response.status(400).json({ error: '邀请码无效、已使用或已过期。' });
    }
    if (sql.userByEmail.get(email)) {
      return response.status(409).json({ error: '该邮箱已注册。' });
    }
    const salt = crypto.randomBytes(16);
    const hashed = await passwordHash(password, salt);
    const transaction = database.transaction(() => {
      const id = sql.insertUser.run(email, salt.toString('hex'), hashed.toString('hex'), 0, Date.now()).lastInsertRowid;
      const changed = sql.useInvite.run(Date.now(), codeHash).changes;
      if (!changed) throw Object.assign(new Error('邀请码已被使用。'), { status: 409 });
      return id;
    });
    const userId = transaction();
    const token = crypto.randomBytes(32).toString('base64url');
    sql.insertSession.run(hashToken(token), userId, Date.now() + tokenLifetimeMs);
    response.status(201).json({ token, user: sql.userById.get(userId) });
  } catch (error) {
    next(error);
  }
});

app.post('/v1/auth/login', async (request, response, next) => {
  try {
    const email = normalizeEmail(request.body.email);
    const password = String(request.body.password || '');
    const user = sql.userByEmail.get(email);
    if (!user || !(await verifyPassword(user, password))) {
      return response.status(401).json({ error: '邮箱或密码不正确。' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sql.insertSession.run(hashToken(token), user.id, Date.now() + tokenLifetimeMs);
    response.json({ token, user: sql.userById.get(user.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/v1/me', requireUser, (request, response) => response.json({ user: request.user }));

app.post('/v1/auth/logout', requireUser, (request, response) => {
  sql.deleteSession.run(request.sessionHash);
  response.json({ ok: true });
});

app.get('/v1/admin/settings', requireUser, requireAdmin, (_request, response) => {
  response.json(sql.getSettings.get());
});

app.put('/v1/admin/settings', requireUser, requireAdmin, async (request, response, next) => {
  try {
    const apiUrl = validateHttpUrl(String(request.body.apiUrl || '').trim(), '模型接口地址');
    const model = String(request.body.model || '').trim();
    if (!model || model.length > 160) throw Object.assign(new Error('模型名称不能为空且不能超过 160 个字符。'), { status: 400 });
    sql.updateSettings.run(apiUrl, model);
    response.json(sql.getSettings.get());
  } catch (error) {
    next(error);
  }
});

app.post('/v1/admin/invites', requireUser, requireAdmin, (request, response) => {
  const code = crypto.randomBytes(24).toString('base64url');
  sql.insertInvite.run(hashToken(code), Date.now() + 24 * 60 * 60 * 1000);
  response.status(201).json({ code, expiresInHours: 24 });
});

app.post('/v1/chat', requireUser, limitUserRequests, async (request, response, next) => {
  try {
    const prompt = String(request.body.prompt || '').trim();
    if (!prompt || prompt.length > 12000) throw Object.assign(new Error('问题不能为空，且不能超过 12000 个字符。'), { status: 400 });
    const settings = sql.getSettings.get();
    const apiKey = process.env.BIGMODEL_API_KEY;
    if (!apiKey) throw Object.assign(new Error('中央服务器尚未配置模型密钥，请联系管理员。'), { status: 503 });
    if (!settings.model) throw Object.assign(new Error('中央服务器尚未配置模型，请联系管理员。'), { status: 503 });
    const apiUrl = validateHttpUrl(settings.apiUrl, '模型接口地址');
    const result = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: '你是亲切、严谨的中文学习助手。解题时展示关键步骤，并在不确定时明确说明。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error'
    });
    if (!result.ok) throw Object.assign(new Error(`模型服务返回 HTTP ${result.status}。`), { status: 502 });
    const data = await result.json();
    const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof answer !== 'string' || !answer.trim()) throw Object.assign(new Error('模型服务没有返回可显示的答案。'), { status: 502 });
    response.json({ answer: answer.trim() });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.status ? error.message : '服务器发生错误，请稍后重试。' });
});

function ensureInitialAdmin() {
  if (sql.userCount.get().count > 0) return;
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD || '';
  validateCredentials(email, password);
  return createUser(email, password, true);
}

Promise.resolve(ensureInitialAdmin()).then(() => {
  sql.expiredSessions.run(Date.now());
  app.listen(port, '127.0.0.1', () => {
    console.log(`小哆啦中央服务监听于 127.0.0.1:${port}`);
  });
}).catch((error) => {
  console.error('中央服务无法启动。首次启动前请设置有效的 ADMIN_EMAIL 和至少 12 位 ADMIN_PASSWORD。', error);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  database.close();
  process.exit(0);
});
