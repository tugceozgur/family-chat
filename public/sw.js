// Service worker: shows push notifications and keeps the app shell available offline.
const CACHE = 'family-chat-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/extras.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network first for the shell so updates show up right away; cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data.json();
  } catch {
    data = { title: 'Family Chat', body: e.data ? e.data.text() : 'New message' };
  }
  e.waitUntil(
    (async () => {
      // Skip the popup if the chat is open on screen right now.
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
      // Stack messages from the same sender into one notification.
      const existing = await self.registration.getNotifications({ tag: data.tag });
      const prior = existing.length ? existing[existing.length - 1].data || {} : {};
      const count = (prior.count || 0) + 1;
      const lines = [...(prior.lines || []), data.body].slice(-5);
      await self.registration.showNotification(data.title, {
        body: count > 1 ? lines.join('\n') : data.body,
        tag: data.tag,
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { count, lines },
      });
      if (self.navigator && self.navigator.setAppBadge) self.navigator.setAppBadge(count).catch(() => {});
    })()
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      if (self.navigator && self.navigator.clearAppBadge) self.navigator.clearAppBadge().catch(() => {});
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if ('focus' in w) {
          w.postMessage('focus');
          return w.focus();
        }
      }
      return self.clients.openWindow('/');
    })()
  );
});
