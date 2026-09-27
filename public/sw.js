// Offline support without going stale. The page is fetched network-first (a
// deploy shows up on the next load; offline or a stalled connection falls back to
// the cached copy). Everything under assets/<hash>/ is content-addressed by
// build_site.py and never changes, so it is served cache-first, one cache per
// release. Each deploy rewrites RELEASE below, which changes this file's bytes,
// so the browser installs the new worker and precaches the new release.
// Served straight from public/ (local dev) RELEASE is null and everything is
// network-first.
const RELEASE = null;      // build_site.py: 'assets/<hash>'
const PRECACHE = [];       // build_site.py: the release's module files

// maxbittker.github.io is shared by several projects, and so is its CacheStorage.
const PREFIX = 'networkwars-';
const SHELL = `${PREFIX}shell`;
const releaseCache = (hash) => `${PREFIX}${hash}`;
const CURRENT = RELEASE && releaseCache(RELEASE.split('/').pop());
const ROOT = new URL('./', self.location).href;
const NAV_TIMEOUT_MS = 3000;   // then serve the cached page rather than wait

self.addEventListener('install', (event) => event.waitUntil((async () => {
  const page = await fetch(ROOT, { cache: 'no-cache' });
  if (!page.ok) throw new Error(`page: HTTP ${page.status}`);
  // A deploy landing mid-install serves a newer page than this worker's release;
  // fail and let the next navigation install the matching worker instead.
  if (RELEASE && !(await page.clone().text()).includes(`./${RELEASE}/`))
    throw new Error('page and worker are from different releases');
  const shell = await caches.open(SHELL);
  await shell.put(ROOT, page);
  const icon = await fetch('favicon.svg', { cache: 'no-cache' }).catch(() => null);
  if (icon?.ok) await shell.put(new URL('favicon.svg', ROOT).href, icon);
  if (RELEASE) await (await caches.open(CURRENT)).addAll(PRECACHE.map((f) => `${RELEASE}/${f}`));
  await self.skipWaiting();
})()));

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  // Keep this release and the one before it (a tab opened before the deploy may
  // still start review workers from it); keys() lists caches in creation order.
  const older = (await caches.keys())
    .filter((k) => k.startsWith(PREFIX) && k !== SHELL && k !== CURRENT);
  await Promise.all(older.slice(0, -1).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const release = url.pathname.match(/\/assets\/([0-9a-f]{16})\//);
  if (release) return event.respondWith(fromRelease(req, releaseCache(release[1])));
  const navigate = req.mode === 'navigate';
  if (!navigate && !/\.(js|svg|html)$/.test(url.pathname)) return;   // e.g. server.py's /grab
  event.respondWith(networkFirst(event, url.origin + url.pathname, navigate));
});

async function fromRelease(req, name) {
  const hit = await caches.match(req, { cacheName: name, ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await (await caches.open(name)).put(req, res.clone());
  return res;
}

function networkFirst(event, key, navigate) {
  let stored;
  const network = fetch(event.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      stored = caches.open(SHELL).then((c) => c.put(key, copy));
    }
    return res;
  });
  event.waitUntil(network.then(() => stored).catch(() => {}));
  const cached = async () => {
    const shell = await caches.open(SHELL);
    return (await shell.match(key)) || (navigate ? shell.match(ROOT) : undefined);
  };
  return new Promise((resolve) => {
    const timer = navigate && setTimeout(() => cached().then((page) => page && resolve(page)),
      NAV_TIMEOUT_MS);
    network.then(resolve, async () => resolve((await cached()) || Response.error()))
      .finally(() => clearTimeout(timer));
  });
}
