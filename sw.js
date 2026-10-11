/* sw.js — time 静态版 Service Worker（scripts/build_static.py 生成，勿手改）
 * CACHE 名带产物内容哈希：换版自动换缓存名，activate 时删旧缓存。
 * 仅拦截同源 GET：导航 network-first（失败回退缓存，HTML 更新可见），
 * 静态资源 cache-first（离线可用）；跨域（geojs 定位）不拦截、不缓存。 */
const CACHE = 'time-clock-00e7e848';
const PRECACHE = [".nojekyll", "apple-touch-icon.png", "data/world_land.json", "icon-192.png", "icon-512.png", "icon.svg", "index.html", "manifest.json", "static/css/style.css", "static/icon.svg", "static/js/api.js", "static/js/app.js", "static/js/map.js", "static/js/solar-engine.js", "static/js/static-backend.js", "static/js/tz-coords.js", "sw.js"];

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
  if (url.origin !== self.location.origin) return;   // 跨域（geojs）直接放行
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(function () {
      return caches.match(e.request).then(function (r) {
        return r || caches.match('index.html').then(function (r2) {
          return r2 || caches.match('/');
        });
      });
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
