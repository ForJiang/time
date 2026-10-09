/* sw.js — time 静态版 Service Worker（scripts/build_static.py 生成，勿手改）
 * 缓存优先（静态资源）+ 导航网络优先（失败回退缓存），换版本时清理旧缓存。 */
const CACHE = 'time-static-1791566224';
const PRECACHE = ["data/world_land.json", "icon.svg", "index.html", "static/css/aux.css", "static/css/style.css", "static/js/alarms.js", "static/js/api.js", "static/js/app.js", "static/js/cities-data.js", "static/js/clock.js", "static/js/map.js", "static/js/solar-engine.js", "static/js/static-backend.js", "static/js/stopwatch.js", "static/js/timer.js"];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      if (k !== CACHE) return caches.delete(k);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // 定位 API 等外链不走缓存
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(function () {
      return caches.match('index.html').then(function (r) { return r || caches.match('/'); });
    }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) {
    return hit || fetch(e.request).then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    });
  }));
});
