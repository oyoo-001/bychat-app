const CACHE_NAME = 'bychat-cache-v1';
const urlsToCache = [
  '/', // Caches the root, which redirects to login or chat
  
  '/login.html',
  '/signup.html',
  '/chat.html',
  '/js/preferences.js', // Include if this file exists
  '/manifest.json',
  // Include your icon paths here:
  '/logo.ico',
  '/favicon.png',
  '/images/vecteezy_massage-icon-3d-render_37297442.png',
  
  // Add any other essential static assets (e.g., specific images, fonts)
];

// Install event: cache files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching assets');
        return cache.addAll(urlsToCache);
      })
      .catch(error => {
        console.error('Service Worker: Caching failed', error);
      })
  );
  self.skipWaiting(); // Force the new service worker to activate immediately
});

// Activate event: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
          return Promise.resolve();
        })
      );
    })
  );
  // Take control of clients immediately
  self.clients.claim();
});

// Fetch event: serve cached content or fetch from network
self.addEventListener('fetch', event => {
  // Only cache GET requests for safety
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          // Cache hit - return response
          if (response) {
            return response;
          }
          // No cache hit - fetch from network
          return fetch(event.request)
            .then(networkResponse => {
              // Check if we received a valid response
              if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                return networkResponse;
              }
              // IMPORTANT: Clone the response. A response is a stream
              // and can only be consumed once. We must consume it once
              // to cache it and once to return the original.
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME)
                .then(cache => {
                  cache.put(event.request, responseToCache);
                });
              return networkResponse;
            })
            .catch(() => {
              // This catch handles network errors
              console.log('Service Worker: Fetch failed, returning offline fallback (if any).');
              // You could return an offline page here if you had one
              // For example: return caches.match('/offline.html');
            });
        })
    );
  }
});