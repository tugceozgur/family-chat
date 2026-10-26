const $ = (s) => document.querySelector(s);
const state = {
  me: null,
  users: [],
  messages: [],
  reads: {},
  online: [],
  typing: {}, // uid -> {draft, timer}
  ws: null,
  outbox: [],
  vapidPublicKey: null,
};
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pref = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {}
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

// ---------- boot ----------
async function boot() {
  const res = await fetch('/api/me');
  if (res.status === 401) return showLogin();
  const data = await res.json();
  state.me = data.me;
  state.users = data.users;
  state.vapidPublicKey = data.vapidPublicKey;
  showChat();
}

function showLogin() {
  $('#chat').hidden = true;
  $('#login').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: form.get('name'), password: form.get('password') }),
  });
  if (!res.ok) {
    $('#login-error').textContent = (await res.json()).error || 'Could not log in';
    return;
  }
  $('#login-error').textContent = '';
  boot();
});

async function showChat() {
  $('#login').hidden = true;
  $('#chat').hidden = false;
  const peers = state.users.filter((u) => u.id !== state.me.id);
  $('#peer-name').textContent = peers.map((p) => p.name).join(', ') || 'Just you';
  const res = await fetch('/api/messages');
  const data = await res.json();
  state.messages = data.messages;
  state.reads = data.reads;
  render(true);
  connect();
  updateNotifyBanner();
  $('#live-typing').checked = pref('liveTyping') === '1';
}

// ---------- websocket ----------
let retry = 0;
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  state.ws = ws;
  ws.onopen = async () => {
    retry = 0;
    sendVisibility();
    // catch up on anything missed while disconnected
    const res = await fetch('/api/messages');
    if (res.ok) {
      const data = await res.json();
      mergeMessages(data.messages);
      state.reads = data.reads;
      render();
    }
    for (const m of state.outbox) ws.send(JSON.stringify(m));
    markRead();
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    state.online = [];
    updateStatus();
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function handle(ev) {
  if (ev.type === 'message') {
    state.outbox = state.outbox.filter((m) => m.clientId !== ev.message.clientId);
    mergeMessages([ev.message]);
    if (ev.message.from !== state.me.id) clearTyping(ev.message.from);
    render();
    markRead();
  } else if (ev.type === 'typing') {
    if (ev.from === state.me.id) return;
    if (ev.typing) setTyping(ev.from, ev.draft);
    else clearTyping(ev.from);
  } else if (ev.type === 'read') {
    state.reads[ev.from] = ev.upTo;
    render();
  } else if (ev.type === 'presence') {
    state.online = ev.online;
    updateStatus();
  }
}

function mergeMessages(list) {
  for (const m of list) {
    const pendingIdx = state.messages.findIndex((x) => x.pending && x.clientId && x.clientId === m.clientId);
    if (pendingIdx >= 0) state.messages.splice(pendingIdx, 1);
    if (!state.messages.some((x) => x.id === m.id)) state.messages.push(m);
  }
  state.messages.sort((a, b) => (a.pending ? Infinity : a.id) - (b.pending ? Infinity : b.id));
}

// ---------- typing ----------
function setTyping(uid, draft) {
  clearTimeout(state.typing[uid] && state.typing[uid].timer);
  state.typing[uid] = { draft, timer: setTimeout(() => clearTyping(uid), 6000) };
  renderTyping();
}
function clearTyping(uid) {
  if (!state.typing[uid]) return;
  clearTimeout(state.typing[uid].timer);
  delete state.typing[uid];
  renderTyping();
}
function renderTyping() {
  const ids = Object.keys(state.typing);
  const box = $('#typing');
  box.hidden = ids.length === 0;
  if (!ids.length) return;
  const uid = ids[0];
  const name = nameOf(uid);
  const draft = state.typing[uid].draft;
  const text = $('#typing-text');
  text.className = '';
  if (draft) {
    text.textContent = `${name}: ${draft}`;
    text.className = 'typing-text-live';
  } else {
    text.textContent = `${name} is typing…`;
  }
  stickToBottom();
}

let lastTypingSent = 0;
let stopTypingTimer;
$('#input').addEventListener('input', () => {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
  const live = $('#live-typing').checked;
  const now = Date.now();
  if (!input.value.trim()) {
    wsSend({ type: 'typing', typing: false });
    lastTypingSent = 0;
    return;
  }
  // With live typing, send every change (lightly throttled); otherwise a ping every 2.5s.
  if (now - lastTypingSent > (live ? 150 : 2500)) {
    wsSend({ type: 'typing', typing: true, draft: live ? input.value : undefined });
    lastTypingSent = now;
  } else if (live) {
    clearTimeout(state.liveFlush);
    state.liveFlush = setTimeout(() => wsSend({ type: 'typing', typing: true, draft: input.value }), 160);
  }
  clearTimeout(stopTypingTimer);
  stopTypingTimer = setTimeout(() => {
    wsSend({ type: 'typing', typing: false });
    lastTypingSent = 0;
  }, 4000);
});

// ---------- sending ----------
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
$('#input').addEventListener('keydown', (e) => {
  // Enter sends on desktop; on phones the return key adds a new line.
  if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
    e.preventDefault();
    send();
  }
});
function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  const clientId = Math.random().toString(36).slice(2) + Date.now();
  const out = { type: 'send', text, clientId };
  state.outbox.push(out);
  state.messages.push({ id: 'p' + clientId, clientId, from: state.me.id, text, ts: Date.now(), pending: true });
  wsSend(out);
  input.value = '';
  input.style.height = 'auto';
  clearTimeout(stopTypingTimer);
  clearTimeout(state.liveFlush);
  lastTypingSent = 0;
  render(true);
  input.focus();
}

// ---------- read receipts ----------
function markRead() {
  if (document.visibilityState !== 'visible') return;
  const last = [...state.messages].reverse().find((m) => !m.pending);
  if (last && last.id > (state.reads[state.me.id] || 0)) {
    state.reads[state.me.id] = last.id;
    wsSend({ type: 'read', upTo: last.id });
  }
}
function sendVisibility() {
  wsSend({ type: 'visibility', visible: document.visibilityState === 'visible' });
}
document.addEventListener('visibilitychange', () => {
  sendVisibility();
  if (document.visibilityState === 'visible') {
    markRead();
    if (state.ws && state.ws.readyState > 1) connect();
    navigator.serviceWorker && navigator.serviceWorker.ready.then((r) => r.getNotifications().then((ns) => ns.forEach((n) => n.close())));
  }
});

// ---------- rendering ----------
const nameOf = (uid) => (state.users.find((u) => u.id === uid) || {}).name || uid;
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};

function nearBottom() {
  const el = $('#messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function stickToBottom(force) {
  const el = $('#messages');
  if (force || nearBottom()) el.scrollTop = el.scrollHeight;
}

function render(forceScroll) {
  const wasNear = nearBottom();
  const box = $('#messages');
  box.textContent = '';
  let lastDay = '';
  let prev = null;
  for (const m of state.messages) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = fmtDay(m.ts);
      box.appendChild(d);
      lastDay = day;
      prev = null;
    }
    const el = document.createElement('div');
    el.className = 'msg ' + (m.from === state.me.id ? 'mine' : 'theirs') + (m.pending ? ' pending' : '');
    if (prev && (prev.from !== m.from || m.ts - prev.ts > 5 * 60e3)) el.classList.add('gap');
    el.textContent = m.text;
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = m.pending ? 'sending…' : fmtTime(m.ts);
    el.appendChild(t);
    box.appendChild(el);
    prev = m;
  }
  // "Seen" under my latest message once everyone else has read it
  const myLast = [...state.messages].reverse().find((m) => m.from === state.me.id && !m.pending);
  const last = state.messages[state.messages.length - 1];
  if (myLast && last === myLast) {
    const peers = state.users.filter((u) => u.id !== state.me.id);
    const seenBy = peers.filter((p) => (state.reads[p.id] || 0) >= myLast.id);
    const s = document.createElement('div');
    s.className = 'seen';
    s.textContent = seenBy.length && seenBy.length === peers.length ? 'Seen' : 'Delivered';
    box.appendChild(s);
  }
  if (!state.messages.length) {
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = 'Say hi 👋';
    box.appendChild(d);
  }
  stickToBottom(forceScroll || wasNear);
}

function updateStatus() {
  const peers = state.users.filter((u) => u.id !== state.me.id);
  const on = peers.some((p) => state.online.includes(p.id));
  $('#peer-dot').classList.toggle('on', on);
  const connected = state.ws && state.ws.readyState === 1;
  $('#peer-status').textContent = !connected ? 'Connecting…' : on ? 'Online' : 'Offline';
}

// ---------- notifications ----------
function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    updateNotifyBanner();
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(state.vapidPublicKey),
    });
  }
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub),
  });
  pref('pushOff', '0');
  updateNotifyBanner();
  return true;
}

async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
  pref('pushOff', '1');
  updateNotifyBanner();
}

async function updateNotifyBanner() {
  const banner = $('#notify-banner');
  const btn = $('#notify-btn');
  const text = $('#notify-text');
  const help = $('#push-help');
  const toggle = $('#push-toggle');
  btn.hidden = false;
  if (isIOS && !isStandalone) {
    banner.hidden = false;
    btn.hidden = true;
    text.textContent = 'For notifications on iPhone: tap Share ⬆︎ then "Add to Home Screen", and open the app from there.';
    help.textContent = text.textContent;
    toggle.disabled = true;
    return;
  }
  if (!pushSupported()) {
    banner.hidden = true;
    toggle.disabled = true;
    help.textContent = 'This browser does not support notifications.';
    return;
  }
  const sub = await currentSubscription();
  const granted = Notification.permission === 'granted';
  toggle.disabled = Notification.permission === 'denied';
  toggle.checked = granted && !!sub;
  if (Notification.permission === 'denied') {
    banner.hidden = false;
    btn.hidden = true;
    text.textContent = 'Notifications are blocked. Allow them for this site in your phone settings.';
    help.textContent = text.textContent;
    return;
  }
  help.textContent = '';
  if (granted && !sub && pref('pushOff') !== '1') {
    // permission kept but subscription lost (e.g. reinstall): quietly re-subscribe
    enablePush().catch(() => (banner.hidden = false));
    return;
  }
  if (granted && sub) {
    // keep the server's copy fresh
    fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  }
  banner.hidden = granted || pref('pushOff') === '1';
  text.textContent = 'Turn on notifications to hear about new messages.';
}

function pushFailed(err) {
  console.error(err);
  alert('Could not turn on notifications on this device: ' + err.message);
  updateNotifyBanner();
}
$('#notify-btn').addEventListener('click', () => enablePush().catch(pushFailed));
$('#push-toggle').addEventListener('change', (e) => (e.target.checked ? enablePush() : disablePush()).catch(pushFailed));
$('#live-typing').addEventListener('change', (e) => pref('liveTyping', e.target.checked ? '1' : '0'));
$('#menu-btn').addEventListener('click', () => {
  updateNotifyBanner();
  $('#menu').showModal();
});
$('#close-menu').addEventListener('click', () => $('#menu').close());
$('#logout').addEventListener('click', async () => {
  await disablePush().catch(() => {});
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// Re-sync when the service worker tells us a notification was tapped.
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data === 'focus') markRead();
});

setInterval(updateStatus, 3000);
boot();
