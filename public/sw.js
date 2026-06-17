const STATIC_CACHE = "cstd-alpha-static-v3";
const DYNAMIC_CACHE = "cstd-alpha-dynamic-v1";
const STATIC_ASSETS = ["/", "/manifest.webmanifest", "/favicon.svg", "/app-icon.svg", "/app-icon-192.png", "/app-icon-512.png", "/app-icon-maskable-512.png"];
const MAX_DYNAMIC_CACHE_ENTRIES = 80;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      for (const asset of STATIC_ASSETS) {
        try { await cache.add(asset); } catch { /* skip failed asset */ }
      }
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE && key !== DYNAMIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  const isStaticAsset = STATIC_ASSETS.includes(url.pathname);

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then(response => {
        if (response.ok) event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.put(request, response.clone())));
        return response;
      })),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          event.waitUntil(
            caches.open(DYNAMIC_CACHE).then(async (cache) => {
              await cache.put(request, clone);
              await trimCache(cache);
            }),
          );
        }
        return response;
      }).catch(() => cached);

      return fetchPromise.then((response) => (response && response.ok) ? response : cached || response);
    }),
  );
});

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_DYNAMIC_CACHE_ENTRIES) return;
  const removable = keys.filter((request) => !STATIC_ASSETS.includes(new URL(request.url).pathname));
  await Promise.all(removable.slice(0, Math.max(0, removable.length - MAX_DYNAMIC_CACHE_ENTRIES)).map((request) => cache.delete(request)));
}
