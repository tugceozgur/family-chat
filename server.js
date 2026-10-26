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
const { default: Anthropic } = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
const BOT = { id: 'claude', name: 'Claude' };

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
  messages: load('messages.json', []), // {id, from, text, image?, ts}
  notes: load('notes.json', []), // {id, title, body, by, ts}
  todos: load('todos.json', []), // {id, text, done, by, doneBy, ts}
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
const displayName = (uid) => (uid === BOT.id ? BOT.name : (USERS.find((u) => userId(u.name) === uid) || {}).name || uid);

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
    bot: BOT,
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

// ---------- photos ----------
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_PATH = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/;
app.post('/api/upload', auth, express.raw({ type: Object.keys(IMAGE_TYPES), limit: '15mb' }), (req, res) => {
  const ext = IMAGE_TYPES[req.headers['content-type']];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send a JPEG, PNG, WebP or GIF' });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ url: '/uploads/' + name });
});
app.get('/uploads/:file', auth, (req, res) => {
  if (!IMAGE_PATH.test('/uploads/' + req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(UPLOAD_DIR, req.params.file), { maxAge: '365d', immutable: true });
});

// ---------- notes and to-dos ----------
function listRoutes(kind, clean) {
  const persist = () => {
    save(kind + '.json', db[kind]);
    broadcast({ type: kind, items: db[kind] });
  };
  app.get('/api/' + kind, auth, (req, res) => res.json({ items: db[kind] }));
  app.post('/api/' + kind, auth, (req, res) => {
    const fields = clean(req.body || {}, req.uid);
    if (!fields) return res.status(400).json({ error: 'empty' });
    const item = { id: crypto.randomBytes(6).toString('hex'), ...fields, by: req.uid, ts: Date.now() };
    db[kind].unshift(item);
    persist();
    res.json(item);
  });
  app.put('/api/' + kind + '/:id', auth, (req, res) => {
    const item = db[kind].find((x) => x.id === req.params.id);
    const fields = item && clean({ ...item, ...req.body }, req.uid);
    if (!fields) return res.status(404).json({ error: 'not found' });
    Object.assign(item, fields, { ts: Date.now() });
    persist();
    res.json(item);
  });
  app.delete('/api/' + kind + '/:id', auth, (req, res) => {
    db[kind] = db[kind].filter((x) => x.id !== req.params.id);
    persist();
    res.json({ ok: true });
  });
}
listRoutes('notes', (b, uid) => {
  const title = String(b.title || '').slice(0, 200).trim();
  const body = String(b.body || '').slice(0, 20000);
  return title || body.trim() ? { title, body, editedBy: uid } : null;
});
listRoutes('todos', (b, uid) => {
  const text = String(b.text || '').slice(0, 500).trim();
  if (!text) return null;
  const done = !!b.done;
  // keep who finished it unless it is being checked off now
  return { text, done, doneBy: done ? b.doneBy || uid : null };
});

// ---------- private space ----------
// End-to-end encrypted in the browser. The server only ever stores ciphertext,
// and @claude never reads it.
db.vault = load('vault.json', { salt: null, check: null, items: [] });
const b64 = (v, max) => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9+/=]+$/.test(v);
const saveVault = () => save('vault.json', db.vault);
app.get('/api/vault', auth, (req, res) => res.json(db.vault));
app.post('/api/vault/setup', auth, (req, res) => {
  const { salt, check } = req.body || {};
  if (db.vault.salt) return res.status(409).json({ error: 'already set up' });
  if (!b64(salt, 64) || !check || !b64(check.iv, 64) || !b64(check.ct, 256)) return res.status(400).json({ error: 'bad data' });
  db.vault = { salt, check: { iv: check.iv, ct: check.ct }, items: [] };
  saveVault();
  broadcast({ type: 'vault', vault: db.vault });
  res.json({ ok: true });
});
app.post('/api/vault/items', auth, (req, res) => {
  const { iv, ct } = req.body || {};
  if (!db.vault.salt || !b64(iv, 64) || !b64(ct, 80000)) return res.status(400).json({ error: 'bad data' });
  const item = { id: crypto.randomBytes(6).toString('hex'), iv, ct, by: req.uid, ts: Date.now() };
  db.vault.items.push(item);
  saveVault();
  broadcast({ type: 'vault', vault: db.vault });
  notifyPrivate(req.uid);
  res.json(item);
});
app.delete('/api/vault/items/:id', auth, (req, res) => {
  db.vault.items = db.vault.items.filter((x) => x.id !== req.params.id);
  saveVault();
  broadcast({ type: 'vault', vault: db.vault });
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
      const image = typeof msg.image === 'string' && IMAGE_PATH.test(msg.image) ? msg.image : undefined;
      if (!text && !image) return;
      const message = { id: nextId++, from: uid, text, image, ts: Date.now(), clientId: msg.clientId };
      db.messages.push(message);
      save('messages.json', db.messages);
      db.reads[uid] = message.id; // you have read your own message
      save('reads.json', db.reads);
      broadcast({ type: 'message', message });
      broadcast({ type: 'typing', from: uid, typing: false });
      notify(message);
      if (/@claude\b/i.test(text)) askClaude(message);
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
async function pushTo(uid, payload) {
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

// The notification never includes private content, only that something was added.
function notifyPrivate(from) {
  for (const user of USERS) {
    const uid = userId(user.name);
    if (uid === from || isLooking(uid)) continue;
    pushTo(uid, JSON.stringify({ title: displayName(from), body: '🔒 Added something to Private', tag: 'family-chat-private' }));
  }
}

async function notify(message) {
  for (const user of USERS) {
    const uid = userId(user.name);
    if (uid === message.from || isLooking(uid)) continue;
    const text = message.text.length > 200 ? message.text.slice(0, 200) + '…' : message.text;
    const payload = JSON.stringify({
      title: displayName(message.from),
      body: message.image ? '📷 Photo' + (text ? ': ' + text : '') : text,
      tag: 'family-chat',
      id: message.id,
    });
    await pushTo(uid, payload);
  }
}

// ---------- @claude ----------
// Someone writes "@claude ..." and Claude answers in the chat, with recent messages as context.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

function postBotMessage(text) {
  const message = { id: nextId++, from: BOT.id, text, ts: Date.now() };
  db.messages.push(message);
  save('messages.json', db.messages);
  broadcast({ type: 'typing', from: BOT.id, typing: false });
  broadcast({ type: 'message', message });
  notify(message);
}

function imageBlock(url) {
  try {
    const file = path.join(UPLOAD_DIR, path.basename(url));
    const ext = path.extname(file).slice(1);
    const mediaType = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: fs.readFileSync(file).toString('base64') } };
  } catch {
    return null;
  }
}

async function askClaude(tagged) {
  if (!anthropic) {
    return postBotMessage('I am not set up yet. Add ANTHROPIC_API_KEY to the server settings and restart, then tag me again.');
  }
  broadcast({ type: 'typing', from: BOT.id, typing: true });
  const keepTyping = setInterval(() => broadcast({ type: 'typing', from: BOT.id, typing: true }), 4000);
  try {
    const idx = db.messages.findIndex((m) => m.id === tagged.id);
    const recent = db.messages.slice(Math.max(0, idx - 30), idx + 1);
    const content = [];
    const fmt = (m) => `[${displayName(m.from)}, ${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')}]`;
    for (const m of recent) {
      const isTagged = m.id === tagged.id;
      // Only the tagged message and the one just before it send their photos, to keep requests small.
      const withPhoto = m.image && (isTagged || m === recent[recent.length - 2]);
      const photo = withPhoto && imageBlock(m.image);
      if (photo) content.push(photo);
      const label = (isTagged ? '>>> TAGGED MESSAGE ' : '') + fmt(m);
      const photoNote = m.image ? (photo ? ' (sent the photo above)' : ' (sent a photo)') : '';
      content.push({ type: 'text', text: `${label}${photoNote} ${m.text}`.trim() });
    }
    const people = USERS.map((u) => u.name).join(' and ');
    const response = await anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system:
        `You are Claude, a helper inside a private family chat between ${people}. ` +
        'Below are the recent chat messages, oldest first. The message marked TAGGED MESSAGE is where someone wrote @claude. ' +
        'Do what that message asks. If it asks nothing beyond tagging you, analyze the message or photo right before it: explain it, check facts, or give useful thoughts. ' +
        'Answer like a friend in a chat: short and warm, in the language of the tagged message, plain text without markdown headings or tables.',
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') return postBotMessage("Sorry, I can't help with that one.");
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    postBotMessage(text || "Hmm, I don't have anything useful to add.");
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('claude: invalid ANTHROPIC_API_KEY');
      postBotMessage('My API key is not valid. Check ANTHROPIC_API_KEY on the server.');
    } else if (err instanceof Anthropic.RateLimitError) {
      postBotMessage('I am getting too many requests right now. Try again in a minute.');
    } else if (err instanceof Anthropic.APIError) {
      console.error('claude: API error', err.status, err.message);
      postBotMessage('Something went wrong on my side. Try again in a bit.');
    } else {
      console.error('claude:', err);
      postBotMessage('Something went wrong on my side. Try again in a bit.');
    }
  } finally {
    clearInterval(keepTyping);
    broadcast({ type: 'typing', from: BOT.id, typing: false });
  }
}

server.listen(PORT, () => {
  console.log(`Family chat on http://localhost:${PORT} for ${USERS.map((u) => u.name).join(', ')}`);
});
