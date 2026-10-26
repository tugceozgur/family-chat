#!/usr/bin/env node
// Family chat connector for Claude Desktop (MCP over stdio).
// Logs in to the chat with your own name and password, then lets Claude read and send
// messages and manage the shared Notes and To-dos. The Private tab is never touched:
// it is encrypted with your passphrase, which this connector does not have.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const WebSocket = require('ws');

const BASE = (process.env.CHAT_URL || 'https://chat.tugce.ai').replace(/\/$/, '');
const NAME = process.env.CHAT_NAME;
const PASSWORD = process.env.CHAT_PASSWORD;

let cookie = null;
let me = null;

async function login() {
  if (!NAME || !PASSWORD) throw new Error('Set CHAT_NAME and CHAT_PASSWORD in the Claude Desktop config.');
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error('Login failed: ' + ((await res.json().catch(() => ({}))).error || res.status));
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  me = await api('GET', '/api/me');
}

async function api(method, path, body, retried) {
  if (!cookie && path !== '/api/me') await login();
  const res = await fetch(BASE + path, {
    method,
    headers: { Cookie: cookie || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    await login();
    return api(method, path, body, true);
  }
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return res.json();
}

const nameOf = (uid) => {
  if (me && me.bot && uid === me.bot.id) return me.bot.name;
  const u = me && me.users.find((x) => x.id === uid);
  return u ? u.name : uid;
};
const stamp = (ts) => new Date(ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const text = (s) => ({ content: [{ type: 'text', text: s }] });

// Messages are sent over the chat's live connection, exactly like the app does.
async function sendMessage(body) {
  if (!cookie) await login();
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
    const clientId = 'mcp-' + Date.now() + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('The chat did not confirm the message in time.'));
    }, 10000);
    ws.on('open', () => {
      // Count as "not looking" so the other person still gets a notification.
      ws.send(JSON.stringify({ type: 'visibility', visible: false }));
      ws.send(JSON.stringify({ type: 'send', text: body, clientId }));
    });
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw);
      if (ev.type === 'message' && ev.message.clientId === clientId) {
        clearTimeout(timer);
        ws.close();
        resolve(ev.message);
      }
    });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      reject(new Error('Could not connect to the chat: ' + res.statusCode));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const server = new McpServer({ name: 'family-chat', version: '1.0.0' });

server.registerTool(
  'read_messages',
  {
    title: 'Read family chat messages',
    description: 'Read recent messages from the family chat, oldest first. Photos are shown as [photo].',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(30).describe('How many recent messages to return'),
      since_hours: z.number().positive().optional().describe('Only messages from the last N hours'),
    },
  },
  async ({ limit, since_hours }) => {
    const { messages, reads } = await api('GET', '/api/messages');
    let list = messages;
    if (since_hours) list = list.filter((m) => m.ts >= Date.now() - since_hours * 3600e3);
    list = list.slice(-limit);
    if (!list.length) return text('No messages in that time.');
    const lines = list.map((m) => `[${stamp(m.ts)}] ${nameOf(m.from)}: ${m.image ? '[photo] ' : ''}${m.text}`.trim());
    const others = me.users.filter((u) => u.id !== me.me.id);
    const seen = others.map((u) => `${u.name} has read up to message ${reads[u.id] || 0}`).join('; ');
    return text(`You are logged in as ${me.me.name}.\n${lines.join('\n')}\n\n(${seen}; latest message is ${list[list.length - 1].id})`);
  }
);

server.registerTool(
  'send_message',
  {
    title: 'Send a family chat message',
    description:
      'Send a message to the family chat as the logged-in person. The other person gets a phone notification. ' +
      'Only send what the user asked you to send.',
    inputSchema: { text: z.string().min(1).max(4000).describe('The message to send') },
  },
  async ({ text: body }) => {
    const m = await sendMessage(body);
    return text(`Sent at ${stamp(m.ts)} as ${nameOf(m.from)}: ${m.text}`);
  }
);

server.registerTool(
  'list_todos',
  {
    title: 'List shared to-dos',
    description: 'List the shared to-do list. Each item has an id you can use to check it off, edit or delete it.',
    inputSchema: { include_done: z.boolean().default(false).describe('Also list finished items') },
  },
  async ({ include_done }) => {
    const { items } = await api('GET', '/api/todos');
    const list = items.filter((t) => include_done || !t.done);
    if (!list.length) return text(include_done ? 'The to-do list is empty.' : 'Nothing left to do.');
    return text(
      list
        .map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}  (id ${t.id}, added by ${nameOf(t.by)}${t.done ? `, done by ${nameOf(t.doneBy)}` : ''})`)
        .join('\n')
    );
  }
);

server.registerTool(
  'add_todo',
  {
    title: 'Add a to-do',
    description: 'Add an item to the shared to-do list.',
    inputSchema: { text: z.string().min(1).max(500) },
  },
  async ({ text: t }) => {
    const item = await api('POST', '/api/todos', { text: t });
    return text(`Added "${item.text}" (id ${item.id}).`);
  }
);

server.registerTool(
  'update_todo',
  {
    title: 'Check off or edit a to-do',
    description: 'Mark a to-do as done or not done, or change its text. Get the id from list_todos.',
    inputSchema: {
      id: z.string(),
      done: z.boolean().optional(),
      text: z.string().min(1).max(500).optional(),
    },
  },
  async ({ id, done, text: t }) => {
    const body = {};
    if (done !== undefined) Object.assign(body, { done, doneBy: null });
    if (t) body.text = t;
    const item = await api('PUT', '/api/todos/' + id, body);
    return text(`"${item.text}" is now ${item.done ? 'done' : 'open'}.`);
  }
);

server.registerTool(
  'delete_todo',
  {
    title: 'Delete a to-do',
    description: 'Delete a to-do for both people. Only do this when the user asks.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    await api('DELETE', '/api/todos/' + id);
    return text('Deleted.');
  }
);

server.registerTool(
  'list_notes',
  {
    title: 'List shared notes',
    description: 'List the shared notes with their full text.',
    inputSchema: {},
  },
  async () => {
    const { items } = await api('GET', '/api/notes');
    if (!items.length) return text('There are no notes yet.');
    return text(
      items
        .map((n) => `## ${n.title || 'Untitled'}  (id ${n.id}, last edited by ${nameOf(n.editedBy || n.by)}, ${stamp(n.ts)})\n${n.body}`)
        .join('\n\n')
    );
  }
);

server.registerTool(
  'save_note',
  {
    title: 'Create or update a note',
    description: 'Create a new shared note, or update an existing one by passing its id. When updating, pass the full new text.',
    inputSchema: {
      id: z.string().optional().describe('Leave out to create a new note'),
      title: z.string().max(200).optional(),
      body: z.string().max(20000).optional(),
    },
  },
  async ({ id, title, body }) => {
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (body !== undefined) fields.body = body;
    const note = id ? await api('PUT', '/api/notes/' + id, fields) : await api('POST', '/api/notes', fields);
    return text(`${id ? 'Updated' : 'Created'} note "${note.title || 'Untitled'}" (id ${note.id}).`);
  }
);

server.registerTool(
  'delete_note',
  {
    title: 'Delete a note',
    description: 'Delete a shared note for both people. Only do this when the user asks.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    await api('DELETE', '/api/notes/' + id);
    return text('Deleted.');
  }
);

server.connect(new StdioServerTransport()).catch((err) => {
  console.error(err);
  process.exit(1);
});
