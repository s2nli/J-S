const CACHE_NAME = "codex-studys-shell-v24";
const SHELL_FILES = ["./index.html", "./batch.html", "./app.js", "./profile.js", "./vibrant.js", "./manifest.json", "./assets/icon-192.png", "./assets/vibrante-icon-192.png", "./assets/vibrante-icon-512.png", "./assets/mj-icon-192.png", "./assets/mj-icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Never cache or intercept course-API calls: they carry short-lived stream/PDF links.
  if (url.pathname.startsWith("/api/")) return;

  // Network-first for page navigations so UI/logic updates (like the popups) land on the very next visit.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  // Network-first for the live course data so listings stay fresh when online.
  if (url.pathname.endsWith("batches.json")) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Network-first for the app's own scripts so a new deploy is picked up immediately (cache only as offline fallback).
  if (/\/(app|profile|vibrant)\.js$/.test(url.pathname)) {
    event.respondWith(
      fetch(event.request, { cache: "no-cache" })
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for the rest of the app shell.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => cached))
  );
});
