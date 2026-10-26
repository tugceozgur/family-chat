// Family chat: a tiny private chat server for a few people.
// Live updates over WebSockets, notifications over Web Push, data in JSON files.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// USERS="Serdar:secret1,Ali:secret2" (name:password pairs)
const USERS = (process.env.USERS || 'Me:me,You:you')
  .split(',')
  .map((pair) => pair.trim())
  .filter(Boolean)
  .map((pair) => {
    const i = pair.indexOf(':');
    return { name: pair.slice(0, i).trim(), password: pair.slice(i + 1) };
  });
const userId = (name) => name.toLowerCase();

// ---------- storage ----------
function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}
const pendingWrites = new Map();
function save(file, value) {
  // Coalesce bursts of writes into one write per file.
  clearTimeout(pendingWrites.get(file));
  pendingWrites.set(
    file,
    setTimeout(() => {
      const tmp = path.join(DATA_DIR, file + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, path.join(DATA_DIR, file));
    }, 50)
  );
}

const secrets = load('secrets.json', null) || {
  session: crypto.randomBytes(32).toString('hex'),
  vapid: webpush.generateVAPIDKeys(),
};
save('secrets.json', secrets);
const SESSION_SECRET = process.env.SESSION_SECRET || secrets.session;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || secrets.vapid.publicKey;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || secrets.vapid.privateKey;
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:family-chat@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

const db = {
  messages: load('messages.json', []), // {id, from, text, ts}
  reads: load('reads.json', {}), // userId -> last read message id
  subs: load('subscriptions.json', {}), // userId -> [PushSubscription]
};
let nextId = db.messages.length ? db.messages[db.messages.length - 1].id + 1 : 1;

// ---------- sessions (signed cookie) ----------
const sign = (value) => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
function makeToken(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, iat: Date.now() })).toString('base64url');
  return payload + '.' + sign(payload);
}
function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { uid } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return USERS.find((u) => userId(u.name) === uid) ? uid : null;
  } catch {
    return null;
  }
}
const displayName = (uid) => (USERS.find((u) => userId(u.name) === uid) || {}).name || uid;

// ---------- http ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

function auth(req, res, next) {
  const uid = readToken(req.cookies.session);
  if (!uid) return res.status(401).json({ error: 'not logged in' });
  req.uid = uid;
  next();
}

const loginAttempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const recent = (loginAttempts.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  const { name = '', password = '' } = req.body || {};
  const user = USERS.find((u) => userId(u.name) === userId(String(name).trim()));
  const ok =
    user &&
    String(password).length === user.password.length &&
    crypto.timingSafeEqual(Buffer.from(String(password)), Buffer.from(user.password));
  if (!ok) {
    loginAttempts.set(ip, [...recent, Date.now()]);
    return res.status(401).json({ error: 'Wrong name or password' });
  }
  res.cookie('session', makeToken(userId(user.name)), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 365 * 24 * 3600e3,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    me: { id: req.uid, name: displayName(req.uid) },
    users: USERS.map((u) => ({ id: userId(u.name), name: u.name })),
    vapidPublicKey: VAPID_PUBLIC,
  });
});

app.get('/api/messages', auth, (req, res) => {
  const before = Number(req.query.before) || Infinity;
  const older = db.messages.filter((m) => m.id < before);
  res.json({ messages: older.slice(-100), hasMore: older.length > 100, reads: db.reads });
});

app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  const list = (db.subs[req.uid] || []).filter((s) => s.endpoint !== sub.endpoint);
  db.subs[req.uid] = [...list, sub];
  save('subscriptions.json', db.subs);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  db.subs[req.uid] = (db.subs[req.uid] || []).filter((s) => s.endpoint !== endpoint);
  save('subscriptions.json', db.subs);
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// ---------- websockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set(); // {ws, uid, visible}

server.on('upgrade', (req, socket, head) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    })
  );
  const uid = readToken(cookies.session);
  if (!uid || !req.url.startsWith('/ws')) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, uid));
});

function broadcast(event, exceptWs) {
  const data = JSON.stringify(event);
  for (const c of clients) if (c.ws !== exceptWs && c.ws.readyState === 1) c.ws.send(data);
}
const online = () => [...new Set([...clients].map((c) => c.uid))];
const isLooking = (uid) => [...clients].some((c) => c.uid === uid && c.visible);

wss.on('connection', (ws, uid) => {
  const client = { ws, uid, visible: true, alive: true };
  clients.add(client);
  broadcast({ type: 'presence', online: online() });

  ws.on('pong', () => (client.alive = true));
  ws.on('close', () => {
    clients.delete(client);
    broadcast({ type: 'presence', online: online() });
    broadcast({ type: 'typing', from: uid, typing: false });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'send') {
      const text = String(msg.text || '').slice(0, 4000).trim();
      if (!text) return;
      const message = { id: nextId++, from: uid, text, ts: Date.now(), clientId: msg.clientId };
      db.messages.push(message);
      save('messages.json', db.messages);
      db.reads[uid] = message.id; // you have read your own message
      save('reads.json', db.reads);
      broadcast({ type: 'message', message });
      broadcast({ type: 'typing', from: uid, typing: false });
      notify(message);
    } else if (msg.type === 'typing') {
      // draft is only included when the sender turned on "live typing"
      const draft = typeof msg.draft === 'string' ? msg.draft.slice(0, 500) : undefined;
      broadcast({ type: 'typing', from: uid, typing: !!msg.typing, draft }, ws);
    } else if (msg.type === 'read') {
      const upTo = Number(msg.upTo);
      if (upTo > (db.reads[uid] || 0) && upTo < nextId) {
        db.reads[uid] = upTo;
        save('reads.json', db.reads);
        broadcast({ type: 'read', from: uid, upTo });
      }
    } else if (msg.type === 'visibility') {
      client.visible = !!msg.visible;
    }
  });

  ws.send(JSON.stringify({ type: 'presence', online: online() }));
});

// Drop dead connections (phones that went to sleep without closing).
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 30e3);

// ---------- push ----------
async function notify(message) {
  for (const user of USERS) {
    const uid = userId(user.name);
    if (uid === message.from || isLooking(uid)) continue;
    const payload = JSON.stringify({
      title: displayName(message.from),
      body: message.text.length > 200 ? message.text.slice(0, 200) + '…' : message.text,
      tag: 'family-chat',
      id: message.id,
    });
    for (const sub of db.subs[uid] || []) {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 24 * 3600, urgency: 'high' });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.subs[uid] = db.subs[uid].filter((s) => s.endpoint !== sub.endpoint);
          save('subscriptions.json', db.subs);
        } else {
          console.error('push failed', err.statusCode || err.message);
        }
      }
    }
  }
}

server.listen(PORT, () => {
  console.log(`Family chat on http://localhost:${PORT} for ${USERS.map((u) => u.name).join(', ')}`);
});
