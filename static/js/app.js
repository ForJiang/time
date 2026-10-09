/* app.js — 启动编排 + 秒边界时钟 + 1Hz 轮询 + 定位升级（契约 §6.2/§6.3）
 *
 * 启动：MapView.init → fetch /data/world_land.json → setLand →
 *       navigator.geolocation.getCurrentPosition（timeout 8s）→ TimeAPI.getState →
 *       秒边界时钟（TimeAPI.now() + Intl.DateTimeFormat 按 state.location.tz）+
 *       1Hz 轮询 /api/state + 定位成功后立即重拉 state。
 * 首帧渲染完成后置 window.__timeReady = true（E2E 同步点）。
 *
 * 时钟禁止用服务端 1Hz 的 local_time 驱动秒位（会抖动）；一律以 TimeAPI.now()
 * 校准到下一秒边界递归 setTimeout，天然不漂移。
 *
 * 语法约束：ES2017 子集（esprima 4 解析；无外部请求、无 eval）。
 */
(function () {
  'use strict';

  var SOURCE_LABELS = {
    browser: '浏览器定位',
    ip: 'IP 定位',
    timezone: '时区定位',
    default: '默认定位'
  };
  var GEO_TIMEOUT_MS = 8000;
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
  function fmtCoord(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return '--';
    var la = Math.abs(lat).toFixed(2) + '°' + (lat >= 0 ? 'N' : 'S');
    var lo = Math.abs(lon).toFixed(2) + '°' + (lon >= 0 ? 'E' : 'W');
    return la + ' ' + lo;
  }

  function hm(v) {
    return (typeof v === 'string' && v) ? v : '--:--';
  }

  function sunText(loc) {
    var sr = loc.sunrise, ss = loc.sunset, dl = loc.day_length;
    var dlText = (typeof dl === 'string' && dl) ? dl : '--:--';
    if ((sr === null || sr === undefined) && (ss === null || ss === undefined)) {
      if (dlText === '24:00') return '极昼 · 昼长 24:00';
      if (dlText === '00:00') return '极夜 · 昼长 00:00';
      return '日出 --:-- · 日落 --:-- · 昼长 ' + dlText;
    }
    return '日出 ' + hm(sr) + ' · 日落 ' + hm(ss) + ' · 昼长 ' + dlText;
  }

  function renderLines() {
    if (!locEl || !sunEl) return;
    var loc = state && state.location;
    if (!loc) {
      locEl.textContent = '';
      sunEl.textContent = '';
      return;
    }
    var name = (typeof loc.name === 'string' && loc.name) ? loc.name : fmtCoord(loc.lat, loc.lon);
    var src = SOURCE_LABELS[loc.source] || '默认定位';
    var tz = (typeof loc.tz === 'string' && loc.tz) ? loc.tz : browserTz();
    locEl.textContent = name + ' · ' + tz + ' · ' + src;
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

  function requestGeo() {
    if (!navigator.geolocation) return;
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        var c = pos && pos.coords;
        if (!c || typeof c.latitude !== 'number' || typeof c.longitude !== 'number') return;
        /* 定位成功：带 lat/lon/tz 立即重拉 state（不等下一轮轮询，REQ-4.3）；
         * 参数记入 lastParams，后续 1Hz 轮询沿用，定位不回退 */
        refresh({ lat: c.latitude, lon: c.longitude, tz: browserTz() });
      }, function () {
        /* 失败/拒绝：沿用服务端回退结果 */
      }, { timeout: GEO_TIMEOUT_MS, maximumAge: 60000, enableHighAccuracy: false });
    } catch (e) { /* 老浏览器无 geolocation：忽略 */ }
  }

  function maybeReady() {
    if (window.__timeReady) return;
    if (!landDone || !stateDone) return;
    if (!state) MapView.render(null);          // 无 state 也保证首帧（底图）上屏
    window.__timeReady = true;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = 0; }
  }

  function boot() {
    clockEl = $('clock');
    locEl = $('loc-line');
    sunEl = $('sun-line');
    MapView.init($('map-canvas'));
    var landP = loadLand();
    requestGeo();
    /* 启动即带浏览器时区作 tz_hint：服务端定位链第三级（浏览器时区→近似坐标，
     * REQ-1.2/契约 §3）由此真正可达；定位成功后 lastParams 升级为 lat/lon/tz */
    var stateP = refresh({ tz: browserTz() }).then(function () {
      stateDone = true;
      maybeReady();
    });
    tick();
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
