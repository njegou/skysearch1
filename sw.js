/* SkySearch — service worker
   v2 : cache versionné, navigation network-first (pour ne plus servir
   une version périmée de l'app), assets cache-first, polices en
   stale-while-revalidate, repli hors ligne propre. */

const VERSION = 'v6.1.0';
const APP_CACHE = `skysearch-app-${VERSION}`;
const RUNTIME_CACHE = `skysearch-runtime-${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './aeroports.html',
  './docs.html',
  './objectif.html',
  './contact.html',
  './style.css',
  './app.js',
  './aeroports.js',
  './contact.js',
  './data.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  './icon-maskable.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== APP_CACHE && k !== RUNTIME_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isFontRequest(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

/* Les appels aux fournisseurs de vols ne doivent JAMAIS être mis en cache ici :
   les données sont vivantes, et une réponse cachée porterait un statut périmé.
   L'app gère elle-même un cache court de 90 s en mémoire. */
const API_HOSTS = ['aerodatabox.p.rapidapi.com', 'api.aviationstack.com'];
function isApiRequest(url) {
  return API_HOSTS.some(h => url.hostname === h) || url.pathname.includes('/aerodatabox') || url.pathname.includes('/aviationstack');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Navigation : réseau d'abord, cache en secours.
  //    Évite de servir indéfiniment une ancienne version de l'app.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(APP_CACHE).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // 2. Données de vol : jamais de cache, toujours le réseau.
  if (isApiRequest(url)) return;

  // 3. Polices externes : stale-while-revalidate.
  if (isFontRequest(url)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(req).then(cached => {
          const network = fetch(req)
            .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // 4. Requêtes vers d'autres origines (FlightAware, FR24…) : réseau direct.
  if (url.origin !== self.location.origin) return;

  // 5. Assets locaux : cache d'abord, réseau ensuite.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req)
        .then(res => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
