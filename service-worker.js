/**
 * service-worker.js
 *
 * Cached alle App-Assets für Offline-/Installierbarkeit. Es werden nie
 * Nutzerdaten (Kontoauszüge, Buchungen) über den Service Worker verarbeitet
 * oder übertragen — die Daten bleiben ausschließlich in IndexedDB.
 */
const CACHE_NAME = 'haushaltsbudget-v3';
const CORE_ASSETS = [
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/db.js',
  './js/categorization.js',
  './js/recurring.js',
  './js/budget.js',
  './js/planned.js',
  './js/manual.js',
  './js/pdfParser.js',
  './js/exportData.js',
  './js/app.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
