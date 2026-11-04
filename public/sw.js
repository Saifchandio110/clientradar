self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = { title: "ClientRadar", body: "New activity", url: "/" };
  try { if (event.data) d = Object.assign(d, event.data.json()); } catch (e) {}
  event.waitUntil(self.registration.showNotification(String(d.title).slice(0, 100), {
    body: String(d.body).slice(0, 200),
    data: { url: String(d.url || "/") }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = (event.notification.data && event.notification.data.url) || "/";
  if (!(url.startsWith("https://bsky.app/") || url.startsWith("/"))) url = "/";
  event.waitUntil(self.clients.openWindow(url));
});
