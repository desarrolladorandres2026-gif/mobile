// Service worker de Zipp (sólo se registra en web, ver lib/pwa.ts).
//
// Estrategia deliberadamente simple:
//  - App shell (JS/CSS/imágenes del build): cache-first, para que abrir la
//    PWA sin señal sea instantáneo una vez visitada.
//  - Todo lo demás (empieza por /api/, sockets, etc.): siempre red. Los
//    precios, el estado del pedido y el stock cambian todo el tiempo — cachear
//    eso daría datos incorrectos en vez de una mejora de velocidad.
const CACHE_NAME = 'zipp-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        // Sin red y sin copia en caché: si pedían navegar, muestra el shell
        // ya cacheado para que la app arranque en vez de un error de red.
        if (request.mode === 'navigate') {
          const shell = await cache.match('/');
          if (shell) return shell;
        }
        throw err;
      }
    })
  );
});
