/*
 * Service worker — the smallest one that makes the app installable.
 *
 * It caches NOTHING: every request goes straight to the network, so a new
 * deploy is what the phone sees on the next open (the app is live data and
 * a stale shell would be worse than no offline mode). Its whole job is to
 * exist with a fetch handler, which is what turns the browser's "add to
 * home screen" into a real install (own icon, no browser chrome).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response("אין חיבור לאינטרנט", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
    )
  );
});
