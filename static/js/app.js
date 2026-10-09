/* app.js — 引导：定位回退链、tab 切换、1Hz 主循环、城市卡片、城市选择器
 *
 * 依赖（script 顺序加载，全局挂 window）：TimeAPI / MapView / AnalogClock，
 * 以及 W4 的 Stopwatch / Timer / Alarms（存在才初始化，缺失不影响本模块）。
 *
 * 时间口径（契约 §6 / 需求 R3）：
 *   - 数字时间以服务端 local_time_short 为权威值；本地 tick 只做插值，
 *     收到新 state 立即校正（stateAtMs 重置）。
 *   - serverOffsetMs 由 TimeAPI.syncOffset() 用 /api/healthz 校准，每 60s 重校。
 *
 * 定位口径（需求 R2）：浏览器 geolocation(8s 超时) → TimeAPI.ipLocation() →
 *   不带 lat/lon 调 /api/state（服务端默认北京，source=default）。
 *   tz 仅在浏览器定位成功时随 lat/lon 传入（IP 城市时区可能与浏览器时区不一致，
 *   交由服务端按坐标推断更可靠）。
 *
 * 语法约束：ES2017 子集。
 */
(function () {
  'use strict';

  var TICK_MS = 1000;
  var RESYNC_TICKS = 60;
  var GEO_TIMEOUT_MS = 8000;
  var SOURCE_LABELS = { browser: '浏览器定位', ip: 'IP 定位', default: '默认位置' };

  var lastState = null;
  var lastStateErr = '';  // 上一条 state 请求错误文案（相同错误不重复打日志）
  var stateAtMs = 0;        // 收到 state 时 TimeAPI.now() 的时刻（插值基准）
  var tickCount = 0;
  var inFlight = false;
  var currentLoc = null;    // {lat, lon, source}
  var browserTz = null;
  var cardMap = {};         // city id -> {el, clock, timeEl, metaEl, sunEl, nameEl, city}
  var locClock = null;
  var locEls = {};
  var allCities = null;     // /api/cities 缓存
  var pickerSel = {};       // city id -> true
  var tabBtns = null;       // boot 时缓存的 tab 按钮列表（切换时不再查询 DOM）
  var tabPanes = null;      // boot 时缓存的 tab pane 列表
  var cardsEl = null;       // #city-cards 容器缓存

  function $(id) { return document.getElementById(id); }

  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  /* ---------- 时间格式化 ---------- */
  function periodPrefix(h) {
    if (h < 12) return '早上';
    if (h < 18) return '下午';
    return '晚上';
  }

  /* "20:40:05" -> "晚上8:40:05" */
  function fmtDigital(hms) {
    if (!hms || hms.indexOf(':') < 0) return '--:--:--';
    var p = hms.split(':');
    var h = parseInt(p[0], 10);
    if (isNaN(h)) h = 0;
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return periodPrefix(h) + h12 + ':' + (p[1] || '00') + ':' + (p[2] || '00');
  }

  /* "06:19" -> "早上6:19"；"17:43" -> "下午5:43"；"--:--" 原样 */
  function fmtSolar(hhmm) {
    if (!hhmm || hhmm.indexOf(':') < 0 || hhmm === '--:--') return '--:--';
    var p = hhmm.split(':');
    var h = parseInt(p[0], 10);
    if (isNaN(h)) return '--:--';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return periodPrefix(h) + h12 + ':' + (p[1] || '00');
  }

  function secsOfDay(hms) {
    var p = (hms || '0:0:0').split(':');
    var h = parseInt(p[0], 10) || 0;
    var m = parseInt(p[1], 10) || 0;
    var s = parseInt(p[2], 10) || 0;
    return h * 3600 + m * 60 + s;
  }

  /* 服务端 HH:MM:SS + 本地插值秒数 -> HH:MM:SS（跨日取模） */
  function shiftHMS(hms, deltaSec) {
    if (!hms || hms.indexOf(':') < 0) return hms || '--:--:--';
    var total = secsOfDay(hms) + deltaSec;
    total = ((total % 86400) + 86400) % 86400;
    return TimeAPI.fmt2(Math.floor(total / 3600)) + ':' +
      TimeAPI.fmt2(Math.floor((total % 3600) / 60)) + ':' +
      TimeAPI.fmt2(total % 60);
  }

  function trimNum(n) {
    var r = Math.round(n * 10) / 10;
    return String(r);
  }

  /* ---------- 定位面板 / 横幅 ---------- */
  function cacheLocEls() {
    locEls = {
      bannerText: $('location-text'),
      city: $('loc-city'),
      time: $('loc-time'),
      meta: $('loc-meta'),
      sun: $('loc-sun')
    };
  }

  function setBannerPending() {
    if (locEls.bannerText) locEls.bannerText.textContent = '正在获取当前位置…';
  }

  function sourceLabel(src) {
    return SOURCE_LABELS[src] || SOURCE_LABELS.default;
  }

  function browserTimezone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return tz || null;
    } catch (e) {
      return null;
    }
  }

  function browserOffsetHours() {
    return -new Date().getTimezoneOffset() / 60;
  }

  /* ---------- state 请求 ---------- */
  function stateParams() {
    var p = {};
    if (currentLoc && typeof currentLoc.lat === 'number' && typeof currentLoc.lon === 'number') {
      p.lat = Math.round(currentLoc.lat * 10000) / 10000;
      p.lon = Math.round(currentLoc.lon * 10000) / 10000;
      if (currentLoc.source === 'browser' && browserTz) p.tz = browserTz;
    }
    return p;
  }

  function fetchState() {
    if (inFlight || !window.TimeAPI) return;
    inFlight = true;
    TimeAPI.getState(stateParams()).then(function (st) {
      inFlight = false;
      lastStateErr = '';   // 恢复正常：下次故障重新打印首条错误
      lastState = st;
      // 插值基准优先用服务端 epoch_ms（与 local_time_short 同一时刻采样），
      // 缺失时退化为本地校准时钟，避免网络/服务端处理延迟带来的抖动。
      stateAtMs = (st && typeof st.epoch_ms === 'number') ? st.epoch_ms : TimeAPI.now().getTime();
      applyState(st);
    }).catch(function (err) {
      inFlight = false;
      // 服务不可用时 1Hz 轮询会把同一错误刷爆控制台：相同文案只报一次
      var msg = errText(err);
      if (msg !== lastStateErr) {
        lastStateErr = msg;
        console.error('获取状态失败: ' + msg);
      }
    });
  }

  function applyState(st) {
    if (window.MapView) MapView.render(st);
    updateLocationPanel(st);
    updateCityCards(st);
    tickDisplay();
  }

  /* ---------- 数字时间 tick（本地插值） ---------- */
  function tickDisplay() {
    if (!lastState) return;
    var elapsed = Math.round((TimeAPI.now().getTime() - stateAtMs) / 1000);
    var loc = lastState.location;
    if (loc && locEls.time) {
      var hms = shiftHMS(loc.local_time_short, elapsed);
      locEls.time.textContent = fmtDigital(hms);
      if (locClock) {
        var p = hms.split(':');
        locClock.setTime(parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, parseInt(p[2], 10) || 0);
      }
    }
    var cities = lastState.cities || [];
    for (var i = 0; i < cities.length; i++) {
      var c = cities[i];
      var card = cardMap[c.id];
      if (!card) continue;
      var s = shiftHMS(c.local_time, elapsed);
      card.timeEl.textContent = fmtDigital(s);
      if (card.clock) {
        var q = s.split(':');
        card.clock.setTime(parseInt(q[0], 10) || 0, parseInt(q[1], 10) || 0, parseInt(q[2], 10) || 0);
      }
    }
  }

  function rollLabel(orig, days) {
    if (days === 0) return orig || '今天';
    if (days > 0) return orig === '昨天' ? '今天' : '明天';
    return orig === '明天' ? '今天' : '昨天';
  }

  function updateLocationPanel(st) {
    var loc = st.location || {};
    if (locEls.city) locEls.city.textContent = loc.name_zh || '--';
    if (locEls.time && loc.local_time_short) locEls.time.textContent = fmtDigital(loc.local_time_short);
    if (locEls.meta) {
      var elapsed = Math.round((TimeAPI.now().getTime() - stateAtMs) / 1000);
      var days = Math.floor((secsOfDay(loc.local_time_short) + elapsed) / 86400);
      var label = rollLabel(loc.date_label, days);
      var lo = typeof loc.utc_offset_hours === 'number' ? loc.utc_offset_hours : 0;
      var d = Math.round((lo - browserOffsetHours()) * 2) / 2;
      locEls.meta.textContent = label + ' ' + (d >= 0 ? '+' : '') + trimNum(d) + '小时';
    }
    if (locEls.sun) locEls.sun.textContent = fmtSolar(loc.sunrise) + ' / ' + fmtSolar(loc.sunset);
    if (locEls.bannerText) {
      var src = currentLoc ? currentLoc.source : (loc.source || 'default');
      locEls.bannerText.textContent = '当前位置：' + (loc.name_zh || '未知位置') + ' · ' + sourceLabel(src);
    }
  }

  /* ---------- 城市卡片 ---------- */
  function createCard(container, c) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'city-card';
    var clockWrap = document.createElement('div');
    clockWrap.className = 'card-clock';
    var name = document.createElement('div');
    name.className = 'card-name';
    var time = document.createElement('div');
    time.className = 'card-time';
    var meta = document.createElement('div');
    meta.className = 'card-meta';
    var sun = document.createElement('div');
    sun.className = 'card-sun';
    el.appendChild(clockWrap);
    el.appendChild(name);
    el.appendChild(time);
    el.appendChild(meta);
    el.appendChild(sun);
    container.appendChild(el);
    var card = {
      el: el, clock: null, timeEl: time, metaEl: meta, sunEl: sun, nameEl: name, city: c
    };
    if (window.AnalogClock) card.clock = window.AnalogClock.init(clockWrap, 76);
    el.addEventListener('click', function () {
      var city = card.city || c;
      if (window.MapView) MapView.focusCity(city.lat, city.lon);
    });
    return card;
  }

  function updateCard(card, c, st) {
    card.city = c;
    card.nameEl.textContent = c.name_zh || c.id;
    if (c.local_time) card.timeEl.textContent = fmtDigital(c.local_time);
    if (card.clock) {
      var p = (c.local_time || '0:0:0').split(':');
      card.clock.setTime(parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, parseInt(p[2], 10) || 0);
    }
    var loc = st.location || {};
    var lo = typeof loc.utc_offset_hours === 'number' ? loc.utc_offset_hours : 0;
    var co = typeof c.utc_offset_hours === 'number' ? c.utc_offset_hours : 0;
    var d = Math.round((co - lo) * 2) / 2;
    card.metaEl.textContent = (c.date_label || '') + ' ' + (d >= 0 ? '+' : '') + trimNum(d) + '小时';
    card.sunEl.textContent = fmtSolar(c.sunrise) + ' / ' + fmtSolar(c.sunset);
    card.el.title = (c.name_en || '') + (c.tz ? ' · ' + c.tz : '') +
      (typeof c.day_length === 'string' ? ' · 昼长 ' + c.day_length : '');
  }

  function updateCityCards(st) {
    var container = cardsEl;
    if (!container) return;
    var cities = st.cities || [];
    var locName = (st.location && st.location.name_zh) || '';
    var seen = {};
    for (var i = 0; i < cities.length; i++) {
      var c = cities[i];
      if (!c || !c.id) continue;
      seen[c.id] = true;
      if (locName && c.name_zh === locName) continue;   // 当前定位已在大面板展示
      var card = cardMap[c.id];
      if (!card) {
        card = createCard(container, c);
        cardMap[c.id] = card;
      }
      updateCard(card, c, st);
    }
    Object.keys(cardMap).forEach(function (id) {
      if (!seen[id]) {
        var old = cardMap[id];
        if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
        delete cardMap[id];
      }
    });
  }

  /* ---------- 定位回退链 ---------- */
  function locate() {
    setBannerPending();
    if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
      locateByIp();
      return;
    }
    var done = false;
    var guard = setTimeout(function () {
      if (done) return;
      done = true;
      locateByIp();
    }, GEO_TIMEOUT_MS + 2000);
    navigator.geolocation.getCurrentPosition(function (pos) {
      if (done) return;
      done = true;
      clearTimeout(guard);
      var crd = pos && pos.coords;
      if (crd && typeof crd.latitude === 'number' && typeof crd.longitude === 'number') {
        currentLoc = { lat: crd.latitude, lon: crd.longitude, source: 'browser' };
      } else {
        currentLoc = { source: 'default' };
      }
      fetchState();
    }, function () {
      if (done) return;
      done = true;
      clearTimeout(guard);
      locateByIp();
    }, { timeout: GEO_TIMEOUT_MS, maximumAge: 60000, enableHighAccuracy: false });
  }

  function locateByIp() {
    if (!window.TimeAPI) return;
    TimeAPI.ipLocation().then(function (loc) {
      if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
        currentLoc = { lat: loc.lat, lon: loc.lon, source: 'ip' };
      } else {
        currentLoc = { source: 'default' };
      }
      fetchState();
    }).catch(function () {
      currentLoc = { source: 'default' };
      fetchState();
    });
  }

  /* ---------- Tab 切换 ---------- */
  function switchTab(btn) {
    var name = btn.getAttribute('data-tab');
    var btns = tabBtns || [];
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i] === btn);
    var panes = tabPanes || [];
    for (var j = 0; j < panes.length; j++) {
      panes[j].classList.toggle('active', panes[j].id === 'tab-' + name);
    }
    if (name === 'world' && window.MapView) MapView.render(lastState);
  }

  function initTabs() {
    tabBtns = document.querySelectorAll('.tab-btn');
    tabPanes = document.querySelectorAll('.tab-pane');
    for (var i = 0; i < tabBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { switchTab(btn); });
      })(tabBtns[i]);
    }
  }

  /* ---------- W4 辅模块 ---------- */
  function initAuxModules() {
    var specs = [
      [window.Stopwatch, 'stopwatch-root'],
      [window.Timer, 'timer-root'],
      [window.Alarms, 'alarms-root']
    ];
    for (var i = 0; i < specs.length; i++) {
      var mod = specs[i][0];
      var root = $(specs[i][1]);
      if (!mod || typeof mod.init !== 'function' || !root) continue;
      try {
        mod.init(root);
      } catch (e) {
        console.error(specs[i][1] + ' 初始化失败: ' + errText(e));
      }
    }
  }

  /* ---------- 城市选择器 ---------- */
  function currentSelectedIds() {
    var sel = {};
    if (lastState && lastState.cities) {
      for (var i = 0; i < lastState.cities.length; i++) {
        if (lastState.cities[i] && lastState.cities[i].id) sel[lastState.cities[i].id] = true;
      }
    }
    return sel;
  }

  function updatePickerCount() {
    var el = $('picker-count');
    if (el) el.textContent = '已选 ' + Object.keys(pickerSel).length + ' 座';
  }

  function renderPickerList(errMsg) {
    var list = $('city-list');
    if (!list) return;
    var search = $('city-search');
    var q = ((search && search.value) || '').trim().toLowerCase();
    list.innerHTML = '';
    var frag = document.createDocumentFragment();
    if (errMsg) {
      var err = document.createElement('li');
      err.className = 'picker-empty';
      err.textContent = errMsg;
      frag.appendChild(err);
      list.appendChild(frag);
      updatePickerCount();
      return;
    }
    var shown = 0;
    if (!allCities) { list.appendChild(frag); updatePickerCount(); return; }
    for (var i = 0; i < allCities.length; i++) {
      var c = allCities[i];
      if (!c || !c.id) continue;
      if (q) {
        var hay = (c.name_zh + ' ' + c.name_en + ' ' + (c.country_zh || '') + ' ' + c.id).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      shown++;
      var li = document.createElement('li');
      li.className = 'picker-item' + (pickerSel[c.id] ? ' selected' : '');
      var check = document.createElement('span');
      check.className = 'picker-check';
      check.textContent = pickerSel[c.id] ? '✓' : '';
      var name = document.createElement('span');
      name.className = 'picker-name';
      name.textContent = c.name_zh || c.id;
      var en = document.createElement('span');
      en.className = 'picker-en';
      en.textContent = (c.name_en || '') + (c.country_zh ? ' · ' + c.country_zh : '');
      li.appendChild(check);
      li.appendChild(name);
      li.appendChild(en);
      (function (city, item, mark) {
        item.addEventListener('click', function () {
          if (pickerSel[city.id]) delete pickerSel[city.id];
          else pickerSel[city.id] = true;
          item.classList.toggle('selected', !!pickerSel[city.id]);
          mark.textContent = pickerSel[city.id] ? '✓' : '';
          updatePickerCount();
        });
      })(c, li, check);
      frag.appendChild(li);
    }
    if (!shown) {
      var empty = document.createElement('li');
      empty.className = 'picker-empty';
      empty.textContent = '没有匹配的城市';
      frag.appendChild(empty);
    }
    list.appendChild(frag);
    updatePickerCount();
  }

  function openPicker() {
    var el = $('city-picker');
    if (!el) return;
    el.classList.remove('hidden');
    var search = $('city-search');
    if (search) { search.value = ''; }
    pickerSel = currentSelectedIds();
    if (allCities) {
      renderPickerList();
    } else if (window.TimeAPI) {
      TimeAPI.cities().then(function (list) {
        allCities = list || [];
        renderPickerList();
      }).catch(function (err) {
        // 拉不到城市列表时给可见反馈，而不是留一个空列表让用户以为没有城市
        renderPickerList('获取城市列表失败：' + errText(err));
      });
    }
  }

  function closePicker() {
    var el = $('city-picker');
    if (el) el.classList.add('hidden');
  }

  function confirmPicker() {
    if (!window.TimeAPI) return;
    var ids = Object.keys(pickerSel);
    TimeAPI.userCities.set(ids).then(function () {
      closePicker();
      fetchState();
    }).catch(function (err) {
      console.error('保存城市失败: ' + errText(err));
    });
  }

  function initPicker() {
    on($('add-city-btn'), 'click', openPicker);
    on($('picker-close'), 'click', closePicker);
    on($('picker-confirm'), 'click', confirmPicker);
    on($('city-search'), 'input', function () { renderPickerList(); });
    var overlay = $('city-picker');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closePicker();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePicker();
    });
  }

  /* ---------- 主循环 ---------- */
  function tick() {
    tickCount++;
    if (tickCount % RESYNC_TICKS === 0) TimeAPI.syncOffset();
    fetchState();
    tickDisplay();
  }

  /* ---------- 引导 ---------- */
  function boot() {
    if (!window.TimeAPI) {
      console.error('api.js 未加载，前端无法工作');
      return;
    }
    browserTz = browserTimezone();
    cacheLocEls();
    cardsEl = $('city-cards');
    if (window.AnalogClock) locClock = window.AnalogClock.init($('location-clock'), 132);
    if (window.MapView) MapView.init($('world-map'));
    if (window.MapView) MapView.render(null);
    initTabs();
    initPicker();
    initAuxModules();
    on($('relocate-btn'), 'click', locate);
    TimeAPI.syncOffset().then(function () {
      locate();
      setInterval(tick, TICK_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
