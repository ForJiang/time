/* app.js — 启动编排 + 秒边界时钟 + 1Hz 轮询 + 定位升级（契约 §6.2/§6.3）
 *
 * 启动：MapView.init → fetch /data/world_land.json → setLand →
 *       navigator.geolocation.getCurrentPosition（timeout 8s）→ TimeAPI.getState →
 *       秒边界时钟（TimeAPI.now() + Intl.DateTimeFormat 按 state.location.tz）+
 *       1Hz 轮询 /api/state + 定位成功后立即重拉 state + 切回前台立即重同步时钟。
 * 首帧渲染完成后置 window.__timeReady = true（E2E 同步点）。
 *
 * 时钟禁止用服务端 1Hz 的 local_time 驱动秒位（会抖动）；一律以 TimeAPI.now()
 * 校准到下一秒边界递归 setTimeout，天然不漂移。
 *
 * 语法约束：ES2017 子集（esprima 4 解析；无外部请求、无 eval）。
 */
(function () {
  'use strict';

  var GEO_TIMEOUT_MS = 15000;          // 高精度定位超时（GPS/WiFi 精定位冷启动可能较慢）
  var GEO_FALLBACK_TIMEOUT_MS = 6000;  // 降精度重试超时（高精度失败时的兜底）
  var POLL_MS = 1000;
  var READY_FALLBACK_MS = 12000;      // 数据迟迟不到也放行（避免 E2E/白屏卡死）

  var clockEl = null, locEl = null, sunEl = null;
  var state = null;
  var lastParams = {};             // 最近一次定位参数：browser 升级后持续复用，
                                   // 否则 1Hz 轮询会把定位打回服务端回退（违背“沿用”语义）
  var clockTimer = 0;
  var pollTimer = 0;
  var landDone = false;
  var stateDone = false;
  var readyTimer = 0;
  var tzName = '';

  function $(id) { return document.getElementById(id); }

  function browserTz() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return tz || 'UTC';
    } catch (e) {
      return 'UTC';
    }
  }

  /* ---------- 信息行 ---------- */
  /* 坐标显示：浏览器定位（GPS/WiFi 级）显示 4 位小数（~11m），
   * IP 等粗来源保持 2 位（~1km）不虚标精度。 */
  function fmtCoord(lat, lon, digits) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return '--';
    var d = (typeof digits === 'number') ? digits : 2;
    var la = Math.abs(lat).toFixed(d) + '°' + (lat >= 0 ? 'N' : 'S');
    var lo = Math.abs(lon).toFixed(d) + '°' + (lon >= 0 ? 'E' : 'W');
    return la + ' ' + lo;
  }

  function hm(v) {
    return (typeof v === 'string' && v) ? v : '--:--';
  }

  function sunText(loc) {
    var sr = loc.sunrise, ss = loc.sunset, dl = loc.day_length;
    var dlText = (typeof dl === 'string' && dl) ? dl : '--:--';
    if ((sr === null || sr === undefined) && (ss === null || ss === undefined)) {
      if (dlText === '24:00') return 'Midnight sun · 24:00 day';
      if (dlText === '00:00') return 'Polar night · 00:00 day';
      return 'Sunrise --:-- · Sunset --:-- · Day length ' + dlText;
    }
    return 'Sunrise ' + hm(sr) + ' · Sunset ' + hm(ss) + ' · Day length ' + dlText;
  }

  function renderLines() {
    if (!locEl || !sunEl) return;
    var loc = state && state.location;
    if (!loc) {
      locEl.textContent = '';
      sunEl.textContent = '';
      return;
    }
    // 定位来源标注已按用户要求移除；无城市名（browser/ip 源）时回退显示坐标
    var name = (typeof loc.name === 'string' && loc.name) ? loc.name : fmtCoord(loc.lat, loc.lon, loc.source === 'browser' ? 4 : 2);
    var tz = (typeof loc.tz === 'string' && loc.tz) ? loc.tz : browserTz();
    locEl.textContent = name + ' · ' + tz;
    sunEl.textContent = sunText(loc);
  }

  /* ---------- 时钟（秒边界，不漂移） ---------- */
  function tzParts(d, tz) {
    try {
      var f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, hourCycle: 'h23',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      var parts = f.formatToParts(d);
      var o = {};
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type !== 'literal') o[parts[i].type] = parts[i].value;
      }
      if (o.hour && o.minute && o.second) {
        return { h: o.hour, m: o.minute, s: o.second };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /* Intl 不可用时的降级：UTC 时间 + 服务端 utc_offset_hours */
  function offsetFallback(d) {
    var off = 0;
    var loc = state && state.location;
    if (loc && typeof loc.utc_offset_hours === 'number' && isFinite(loc.utc_offset_hours)) {
      off = loc.utc_offset_hours;
    }
    var t = new Date(d.getTime() + off * 3600000);
    return TimeAPI.fmt2(t.getUTCHours()) + ':' + TimeAPI.fmt2(t.getUTCMinutes()) + ':' + TimeAPI.fmt2(t.getUTCSeconds());
  }

  function updateClock() {
    if (!clockEl) return;
    var loc = state && state.location;
    var tz = (loc && typeof loc.tz === 'string' && loc.tz) ? loc.tz : (tzName || browserTz());
    tzName = tz;
    var d = TimeAPI.now();
    var p = tzParts(d, tz);
    clockEl.textContent = p ? (p.h + ':' + p.m + ':' + p.s) : offsetFallback(d);
  }

  function tick() {
    updateClock();
    var now = TimeAPI.now().getTime();
    /* 校准到下一个整秒边界（+5ms 余量防定时器早触发），每次按当前时间重算，不累积漂移 */
    var delay = 1000 - (now % 1000) + 5;
    clockTimer = setTimeout(tick, delay);
  }

  /* 后台标签页的 setTimeout 会被浏览器节流（Chrome 隐藏 5 分钟后降到分钟级），
   * 回到前台时先作废挂起的旧定时器再立即补刷一次，避免时钟停走/跳变。 */
  function onVisibility() {
    if (document.hidden) return;
    if (clockTimer) {
      clearTimeout(clockTimer);
      clockTimer = 0;
    }
    tick();
  }

  /* ---------- 状态 ---------- */
  function applyState(st) {
    state = st;
    MapView.render(st);
    renderLines();
    updateClock();
  }

  function refresh(params) {
    if (params) lastParams = params;
    return TimeAPI.getState(lastParams).then(function (st) {
      if (st) applyState(st);
      return st;
    });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { refresh(null); }, POLL_MS);
  }

  /* ---------- 启动 ---------- */
  function loadLand() {
    return fetch('data/world_land.json').then(function (resp) {
      if (!resp || !resp.ok) throw new Error('land http ' + (resp ? resp.status : '?'));
      return resp.json();
    }).then(function (data) {
      if (data && data.polygons && data.polygons.length) MapView.setLand(data);
    }).catch(function () {
      /* 降级：无陆地轮廓，仅经纬网格与晨昏线，功能不受影响 */
    }).then(function () {
      landDone = true;
      maybeReady();
    });
  }

  /* 高精度定位 + 降精度重试（run-014，用户要求"定位更准确"）：
   * ① 首选 enableHighAccuracy（GPS/WiFi 精定位，不用廉价 IP 粗定位）、
   *    maximumAge=0（不接受过期缓存位置）；
   * ② 若超时/不可用（非拒绝授权），降精度重试一次——粗定位仍优于服务端城市级；
   * ③ 拒绝授权（code 1）不重试，直接沿用服务端回退。 */
  function requestGeo() {
    if (!navigator.geolocation) return;
    var done = false;
    var onSuccess = function (pos) {
      var c = pos && pos.coords;
      if (!c || typeof c.latitude !== 'number' || typeof c.longitude !== 'number') return;
      done = true;
      /* 定位成功：带 lat/lon/tz 立即重拉 state（不等下一轮轮询，REQ-4.3）；
       * 参数记入 lastParams，后续 1Hz 轮询沿用，定位不回退 */
      refresh({ lat: c.latitude, lon: c.longitude, tz: browserTz() });
    };
    var onError = function (err) {
      if (done) return;
      if (err && err.code === 1) return;   // PERMISSION_DENIED：不重试
      try {
        navigator.geolocation.getCurrentPosition(onSuccess, function () {}, {
          timeout: GEO_FALLBACK_TIMEOUT_MS, maximumAge: 120000, enableHighAccuracy: false
        });
      } catch (e) { /* 忽略：沿用服务端回退 */ }
    };
    try {
      navigator.geolocation.getCurrentPosition(onSuccess, onError, {
        timeout: GEO_TIMEOUT_MS, maximumAge: 0, enableHighAccuracy: true
      });
    } catch (e) { /* 老浏览器无 geolocation：忽略 */ }
  }

  function maybeReady() {
    if (window.__timeReady) return;
    if (!landDone || !stateDone) return;
    if (!state) MapView.render(null);          // 无 state 也保证首帧（底图）上屏
    window.__timeReady = true;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = 0; }
  }

  /* 地图初始化延后到 boot 关键路径之外：无头/GPU 争用下 getContext 可能把
   * 渲染主线程堵死数十秒（连 setTimeout 都无法触发），时钟/状态/__timeReady
   * 不能陪葬。init 期间到达的状态在 init 后立即补渲染；后续 1Hz 轮询兜底。 */
  function initMap() {
    try {
      MapView.init($('map-canvas'));
      if (state) MapView.render(state);
    } catch (e) { /* 地图初始化失败：降级为无背景，时钟照常 */ }
  }

  function boot() {
    clockEl = $('clock');
    locEl = $('loc-line');
    sunEl = $('sun-line');
    /* 时钟优先启动 */
    tick();
    document.addEventListener('visibilitychange', onVisibility);
    setTimeout(initMap, 0);
    var landP = loadLand();
    requestGeo();
    /* 启动即带浏览器时区作 tz_hint：服务端定位链第三级（浏览器时区→近似坐标，
     * REQ-1.2/契约 §3）由此真正可达；定位成功后 lastParams 升级为 lat/lon/tz */
    var stateP = refresh({ tz: browserTz() }).then(function () {
      stateDone = true;
      maybeReady();
    });
    startPolling();
    /* 兜底：数据请求悬挂超过 READY_FALLBACK_MS 也放行同步点 */
    readyTimer = setTimeout(function () {
      landDone = true;
      stateDone = true;
      maybeReady();
    }, READY_FALLBACK_MS);
    return Promise.all([landP, stateP]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  } else {
    boot();
  }
})();
