// Tabs, shared notes, shared to-dos, and the end-to-end encrypted Private space.
// Uses $, state, nameOf, fmtTime, fmtDay, markRead, sendVisibility and pref from app.js.
const extras = { notes: [], todos: [], vault: null, key: null, entries: [] };
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};
const when = (ts) => (new Date(ts).toDateString() === new Date().toDateString() ? fmtTime(ts) : fmtDay(ts));
const initial = (uid) => (nameOf(uid) || '?').slice(0, 1).toUpperCase();

// ---------- tabs ----------
window.currentView = 'chat';
function showView(view) {
  window.currentView = view;
  for (const v of ['chat', 'notes', 'todos', 'private']) $('#view-' + v).hidden = v !== view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'chat') {
    $('#badge-chat').hidden = true;
    markRead();
    const box = $('#messages');
    box.scrollTop = box.scrollHeight;
  }
  sendVisibility();
  pref('view', view);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
window.onNewMessage = () => {
  if (window.currentView !== 'chat') $('#badge-chat').hidden = false;
};

window.onAppReady = async () => {
  const [notes, todos, vault] = await Promise.all([api('GET', '/api/notes'), api('GET', '/api/todos'), api('GET', '/api/vault')]);
  extras.notes = notes.items;
  extras.todos = todos.items;
  renderNotes();
  renderTodos();
  await setVault(vault);
  const saved = pref('view');
  if (saved && saved !== 'chat') showView(saved);
};

window.onAppEvent = (ev) => {
  if (ev.type === 'notes') {
    extras.notes = ev.items;
    renderNotes();
  } else if (ev.type === 'todos') {
    extras.todos = ev.items;
    renderTodos();
  } else if (ev.type === 'vault') {
    setVault(ev.vault);
  }
};

// ---------- notes ----------
let editing = null;
function renderNotes() {
  const list = $('#notes-list');
  list.textContent = '';
  if (!extras.notes.length) {
    list.innerHTML = '<p class="empty">No notes yet. Shopping ideas, plans, passwords to the Wi-Fi… anything you both want to keep.</p>';
    return;
  }
  for (const n of extras.notes) {
    const card = document.createElement('button');
    card.className = 'card-item';
    const title = document.createElement('strong');
    title.textContent = n.title || (n.body.split('\n')[0] || '').slice(0, 60) || 'Untitled';
    const body = document.createElement('p');
    body.textContent = n.body.slice(0, 160);
    const meta = document.createElement('small');
    meta.textContent = `${nameOf(n.editedBy || n.by)} · ${when(n.ts)}`;
    card.append(title, body, meta);
    card.addEventListener('click', () => openNote(n));
    list.appendChild(card);
  }
}
function openNote(note) {
  editing = note;
  $('#note-title').value = note ? note.title : '';
  $('#note-body').value = note ? note.body : '';
  $('#note-delete').hidden = !note;
  $('#note-meta').textContent = note ? `Last edited by ${nameOf(note.editedBy || note.by)}, ${when(note.ts)}` : '';
  $('#note-dialog').showModal();
  if (!note) $('#note-title').focus();
}
$('#new-note').addEventListener('click', () => openNote(null));
$('#note-cancel').addEventListener('click', () => $('#note-dialog').close());
$('#note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { title: $('#note-title').value, body: $('#note-body').value };
  if (!body.title.trim() && !body.body.trim()) return $('#note-dialog').close();
  try {
    if (editing) await api('PUT', '/api/notes/' + editing.id, body);
    else await api('POST', '/api/notes', body);
    $('#note-dialog').close();
  } catch (err) {
    alert('Could not save: ' + err.message);
  }
});
$('#note-delete').addEventListener('click', async () => {
  if (!editing || !confirm('Delete this note for both of you?')) return;
  await api('DELETE', '/api/notes/' + editing.id);
  $('#note-dialog').close();
});

// ---------- to-dos ----------
function todoRow(t) {
  const li = document.createElement('li');
  li.className = t.done ? 'done' : '';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = t.done;
  box.addEventListener('change', () => api('PUT', '/api/todos/' + t.id, { done: box.checked, doneBy: null }));
  const text = document.createElement('span');
  text.className = 'todo-text';
  text.textContent = t.text;
  text.addEventListener('click', async () => {
    const next = prompt('Edit to-do', t.text);
    if (next && next.trim() && next !== t.text) api('PUT', '/api/todos/' + t.id, { text: next });
  });
  const who = document.createElement('small');
  who.className = 'who-chip';
  who.title = t.done ? `Done by ${nameOf(t.doneBy)}` : `Added by ${nameOf(t.by)}`;
  who.textContent = t.done ? '✓' + initial(t.doneBy) : initial(t.by);
  const del = document.createElement('button');
  del.className = 'icon-btn del';
  del.setAttribute('aria-label', 'Delete');
  del.textContent = '×';
  del.addEventListener('click', () => api('DELETE', '/api/todos/' + t.id));
  li.append(box, text, who, del);
  return li;
}
function renderTodos() {
  const open = extras.todos.filter((t) => !t.done);
  const done = extras.todos.filter((t) => t.done).sort((a, b) => b.ts - a.ts);
  const list = $('#todo-list');
  list.textContent = '';
  open.forEach((t) => list.appendChild(todoRow(t)));
  if (!open.length) list.innerHTML = '<li class="empty">All done 🎉</li>';
  $('#done-wrap').hidden = !done.length;
  $('#done-summary').textContent = `Done (${done.length})`;
  const doneList = $('#done-list');
  doneList.textContent = '';
  done.forEach((t) => doneList.appendChild(todoRow(t)));
  const badge = $('#badge-todos');
  badge.hidden = !open.length;
  badge.textContent = open.length;
}
$('#todo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#todo-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await api('POST', '/api/todos', { text });
  } catch (err) {
    input.value = text;
    alert('Could not add: ' + err.message);
  }
  input.focus();
});

// ---------- private (end-to-end encrypted) ----------
// The passphrase never leaves the phone. It is turned into an AES key with PBKDF2,
// and only encrypted text is sent to the server, so neither the server nor @claude can read it.
const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const CHECK_TEXT = 'family-chat-private-v1';

async function deriveKey(passphrase, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations: 600000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function decryptText(key, { iv, ct }) {
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct)));
}

// Remember the key on this device in IndexedDB. It is stored as a non-extractable CryptoKey,
// so page scripts can use it but cannot read the raw key out.
function idb(mode, fn) {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('family-chat', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('keys');
      open.onsuccess = () => {
        const tx = open.result.transaction('keys', mode);
        const req = fn(tx.objectStore('keys'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => resolve(null);
      };
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
const rememberKey = (salt, key) => idb('readwrite', (s) => s.put(key, salt));
const forgetKey = (salt) => idb('readwrite', (s) => s.delete(salt));
const recallKey = (salt) => idb('readonly', (s) => s.get(salt));

async function setVault(vault) {
  extras.vault = vault;
  if (!extras.key && vault.salt) {
    const saved = await recallKey(vault.salt);
    if (saved) {
      try {
        if ((await decryptText(saved, vault.check)) === CHECK_TEXT) extras.key = saved;
      } catch {}
    }
  }
  if (extras.key && vault.salt) await decryptEntries();
  renderVault();
}
async function decryptEntries() {
  extras.entries = [];
  for (const item of extras.vault.items) {
    try {
      extras.entries.push({ ...item, text: await decryptText(extras.key, item) });
    } catch {
      extras.entries.push({ ...item, text: '⚠️ Could not decrypt this one' });
    }
  }
}
function renderVault() {
  const firstTime = !extras.vault.salt;
  const unlocked = !!extras.key && !firstTime;
  $('#vault-gate').hidden = unlocked;
  $('#vault-open').hidden = !unlocked;
  $('#vault-lock').hidden = !unlocked;
  $('#vault-pass2').hidden = !firstTime;
  $('#vault-pass2').required = firstTime;
  $('#vault-submit').textContent = firstTime ? 'Create private space' : 'Unlock';
  $('#vault-intro').textContent = firstTime
    ? 'Pick a passphrase together and both use the same one. Everything here is encrypted on your phone before it is sent, so the server and Claude only ever see scrambled text. If you both forget the passphrase, nobody can recover what is in here.'
    : 'Enter your shared passphrase. It never leaves this phone.';
  if (!unlocked) return;
  const list = $('#vault-list');
  list.textContent = '';
  if (!extras.entries.length) list.innerHTML = '<p class="empty">Nothing here yet. Only the two of you can read what you write.</p>';
  for (const e of [...extras.entries].reverse()) {
    const card = document.createElement('div');
    card.className = 'card-item vault-item';
    const body = document.createElement('p');
    body.textContent = e.text;
    const meta = document.createElement('small');
    meta.textContent = `${nameOf(e.by)} · ${when(e.ts)}`;
    const del = document.createElement('button');
    del.className = 'icon-btn del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', async () => {
      if (confirm('Delete this for both of you?')) await api('DELETE', '/api/vault/items/' + e.id);
    });
    card.append(del, body, meta);
    list.appendChild(card);
  }
}

$('#vault-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#vault-pass').value;
  const err = $('#vault-error');
  err.textContent = '';
  const btn = $('#vault-submit');
  btn.disabled = true;
  try {
    if (!extras.vault.salt) {
      if (pass.length < 8) throw new Error('Use at least 8 characters.');
      if (pass !== $('#vault-pass2').value) throw new Error('The two passphrases do not match.');
      const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
      const key = await deriveKey(pass, salt);
      await api('POST', '/api/vault/setup', { salt, check: await encryptText(key, CHECK_TEXT) });
      extras.key = key;
      if ($('#vault-remember').checked) await rememberKey(salt, key);
      await setVault(await api('GET', '/api/vault'));
    } else {
      const key = await deriveKey(pass, extras.vault.salt);
      let ok = false;
      try {
        ok = (await decryptText(key, extras.vault.check)) === CHECK_TEXT;
      } catch {}
      if (!ok) throw new Error('That passphrase is not right.');
      extras.key = key;
      if ($('#vault-remember').checked) await rememberKey(extras.vault.salt, key);
      await setVault(extras.vault);
    }
    $('#vault-pass').value = '';
    $('#vault-pass2').value = '';
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});
$('#vault-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('#vault-text');
  const text = box.value.trim();
  if (!text || !extras.key) return;
  try {
    await api('POST', '/api/vault/items', await encryptText(extras.key, text));
    box.value = '';
  } catch (ex) {
    alert('Could not save: ' + ex.message);
  }
});
$('#vault-lock').addEventListener('click', async () => {
  extras.key = null;
  extras.entries = [];
  if (extras.vault.salt) await forgetKey(extras.vault.salt);
  renderVault();
});
$('#logout').addEventListener('click', () => extras.vault && extras.vault.salt && forgetKey(extras.vault.salt));
