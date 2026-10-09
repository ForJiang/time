/* static-backend.js — GitHub Pages 静态版后端适配层（猴补 window.TimeAPI）
 *
 * 在 api.js 之后加载，把 window.TimeAPI 的各方法换成「本地实现」：
 *   - getState(params)  由 solar-engine.js（window.TimeSolar）+ localStorage 组装出
 *                      与 Flask app/server.py::_build_state 逐字段一致的 StateDict；
 *   - syncOffset()      静态版本机时钟即权威 → 恒返回 0；
 *   - now()             new Date()；
 *   - ipLocation()      浏览器直连 http://ip-api.com/json/?lang=zh-CN（CORS 允许），
 *                      失败/超时(3s)/10 分钟缓存 → null，与 app/geo.py 语义一致；
 *   - cities()          window.TimeCities（构建脚本生成，别处只读）；
 *   - alarms / userCities   localStorage 持久化（key 前缀 "time-"）。
 *
 * app.js / alarms.js 等都是「调用时解析 TimeAPI.xxx」，故在此打补丁即可生效；
 * fmt2 保留 api.js 原样，不补。
 *
 * 语法约束：ES2017 子集（esprima 4 门禁）——禁 ?. / ?? / #private，无 ES module，IIFE。
 */

(function () {
  'use strict';

  /* =========================================================================
   * 常量
   * ======================================================================= */

  // 默认展示城市（与 app/cities.py::DEFAULT_CITY_IDS 完全一致，顺序一致）
  var DEFAULT_CITY_IDS = [
    'beijing', 'shanghai', 'hongkong', 'tokyo', 'seoul', 'singapore',
    'dubai', 'mumbai', 'moscow', 'istanbul', 'london', 'paris', 'berlin',
    'newyork', 'losangeles', 'saopaulo', 'sydney', 'auckland'
  ];

  // 昼/夜判定阈值（契约 §6：太阳视高度 ≥ -0.833° 记为白昼）
  var DAY_THRESHOLD_DEG = -0.833;

  // 晨昏线 kind → kind_code（契约 §6）
  var KIND_CODES = { normal: 0, polar_day: 1, polar_night: 2 };

  // IUGG 平均地球半径（km），haversine 用（同 app/cities.py）
  var EARTH_RADIUS_KM = 6371.0088;

  // IP 定位（同 app/geo.py）
  var IP_API_URL = 'http://ip-api.com/json/?lang=zh-CN';
  var IP_TIMEOUT_MS = 3000;      // 3 秒超时
  var IP_CACHE_MS = 600000;      // 10 分钟缓存（成功与失败都缓存）

  // localStorage key（统一 "time-" 前缀）
  var LS_ALARMS = 'time-alarms';
  var LS_USER_CITIES = 'time-user-cities';

  /* =========================================================================
   * 通用小工具
   * ======================================================================= */

  function pad2(n) {
    n = Number(n);
    if (isNaN(n)) n = 0;
    return n < 10 ? '0' + n : String(n);
  }

  // 模仿 Python round()（银行家舍入 / round-half-to-even），尽量与 server.py 的
  // round(value, ndigits) 逐位一致（含 2.675 → 2.67 这类二进制表示偏差）。
  function pyRound(x, ndigits) {
    if (typeof x !== 'number' || !isFinite(x)) return x;
    var factor = Math.pow(10, ndigits);
    var scaled = x * factor;
    var floor = Math.floor(scaled);
    var diff = scaled - floor;
    var rounded;
    if (diff > 0.5) rounded = floor + 1;
    else if (diff < 0.5) rounded = floor;
    else rounded = (floor % 2 === 0) ? floor : floor + 1;
    return rounded / factor;
  }

  // _round1：数值 → 1 位小数；非数值原样返回。
  function round1(value) {
    if (typeof value === 'number' && isFinite(value)) return pyRound(value, 1);
    return value;
  }

  // _round_lon_360：夜弧经度 → 2 位小数且严格落在 [0, 360)（359.995→360.0 吸附回 0）。
  function roundLon360(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !isFinite(value)) return null;
    var rounded = pyRound(value, 2);
    return rounded >= 360.0 ? 0.0 : rounded;
  }

  // _round_subsolar_lon：直射点经度 → 1 位小数且严格落在 [-180, 180)（180.0 翻回 -180.0）。
  function roundSubsolarLon(value) {
    var rounded = round1(value);
    if (typeof rounded === 'number' && rounded >= 180.0) return -180.0;
    return rounded;
  }

  function isDay(elevation) {
    if (typeof elevation !== 'number' || !isFinite(elevation)) return false;
    return elevation >= DAY_THRESHOLD_DEG;
  }

  // _fmt_hhmm：solar-engine 已给 "HH:MM" | null，这里只把 null 映射为 "--:--"。
  function fmtHhmm(v) {
    return (typeof v === 'string' && v) ? v : '--:--';
  }

  // _fmt_day_length：day_length_hours → "HH:MM"；极昼 24:00 / 极夜 00:00。
  function fmtDayLength(hours) {
    if (hours === null || hours === undefined) return '--:--';
    if (typeof hours !== 'number' || !isFinite(hours)) return '--:--';
    if (hours >= 24.0) return '24:00';
    if (hours <= 0.0) return '00:00';
    var totalMinutes = Math.round(hours * 60.0);
    return pad2(Math.floor(totalMinutes / 60)) + ':' + pad2(totalMinutes % 60);
  }

  // _day_length_label：solar.day_length_hours 有值 → 直接格式化；否则按 24h/2h 采样推断极昼/极夜。
  function dayLengthLabel(date, lat, lon) {
    var solar = getSolar();
    var hours = solar.dayLengthHours(date, lat, lon);
    if (typeof hours === 'number' && isFinite(hours)) {
      return fmtDayLength(hours);
    }
    var maxElev = -Infinity;
    for (var h = 0; h < 24; h += 2) {
      var e = solar.solarElevation(new Date(date.getTime() + h * 3600000), lat, lon);
      if (typeof e === 'number' && isFinite(e) && e > maxElev) maxElev = e;
    }
    return (maxElev >= DAY_THRESHOLD_DEG) ? '24:00' : '00:00';
  }

  /* =========================================================================
   * 时区处理（Intl.DateTimeFormat 解析各 IANA 时区的当地时间）
   * ======================================================================= */

  var _tzValidCache = {};   // name -> name|null
  var _fmtCache = {};       // name -> Intl.DateTimeFormat

  function makeFormatter(tzName) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tzName, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch (e) {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tzName, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
  }

  function tzFormatter(tzName) {
    var f = _fmtCache[tzName];
    if (!f) {
      f = makeFormatter(tzName);
      _fmtCache[tzName] = f;
    }
    return f;
  }

  // _valid_tz：tz 名合法 → 原样返回，否则 null（不抛异常）。
  function tzValid(name) {
    if (typeof name !== 'string' || !name) return null;
    if (Object.prototype.hasOwnProperty.call(_tzValidCache, name)) return _tzValidCache[name];
    var ok = false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: name });
      ok = true;
    } catch (e) {
      ok = false;
    }
    _tzValidCache[name] = ok ? name : null;
    return _tzValidCache[name];
  }

  // date 在 tzName 时区的「墙钟」各部分（整数）。兼容 h24 的 24:00 午夜（滚动到次日 0 点）。
  function tzParts(date, tzName) {
    var parts = tzFormatter(tzName).formatToParts(date);
    var out = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === 'year') out.year = parseInt(p.value, 10);
      else if (p.type === 'month') out.month = parseInt(p.value, 10);
      else if (p.type === 'day') out.day = parseInt(p.value, 10);
      else if (p.type === 'hour') out.hour = parseInt(p.value, 10);
      else if (p.type === 'minute') out.minute = parseInt(p.value, 10);
      else if (p.type === 'second') out.second = parseInt(p.value, 10);
    }
    if (out.hour === 24) {
      out.hour = 0;
      var nd = new Date(Date.UTC(out.year, out.month - 1, out.day + 1));
      out.year = nd.getUTCFullYear();
      out.month = nd.getUTCMonth() + 1;
      out.day = nd.getUTCDate();
    }
    return out;
  }

  function partsToShort(p) {
    return pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second);
  }

  function partsToFull(p) {
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + ' ' + partsToShort(p);
  }

  // _utc_offset_hours：由墙钟部分（当 UTC 解）+ 真实 UTC 时刻求偏移小时（2 位小数）。
  function offsetFromParts(parts, date) {
    var asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    var realMs = Math.floor(date.getTime() / 1000) * 1000;
    return pyRound((asUTC - realMs) / 3600000, 2);
  }

  function dayNumber(y, m, d) {
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }

  // _date_label：相对参照日期的中文标注：今天 / 明天 / 昨天 / MM-DD。
  function dateLabel(cityParts, refParts) {
    var delta = dayNumber(cityParts.year, cityParts.month, cityParts.day) -
                dayNumber(refParts.year, refParts.month, refParts.day);
    if (delta === 0) return '今天';
    if (delta === 1) return '明天';
    if (delta === -1) return '昨天';
    return pad2(cityParts.month) + '-' + pad2(cityParts.day);
  }

  // server_time_utc：ISO8601、秒精度、UTC（同 now.isoformat(timespec="seconds")）。
  function isoSeconds(date) {
    return date.toISOString().replace(/\.\d+Z$/, '+00:00');
  }

  /* =========================================================================
   * 城市数据 / 大圆距离
   * ======================================================================= */

  function getCities() {
    return (window.TimeCities && window.TimeCities.length) ? window.TimeCities : [];
  }

  var _cityIndexRef = null;
  var _cityIndex = null;

  function cityById(cid) {
    var cities = getCities();
    if (_cityIndexRef !== cities) {
      _cityIndex = {};
      for (var i = 0; i < cities.length; i++) {
        if (cities[i] && cities[i].id) _cityIndex[cities[i].id] = cities[i];
      }
      _cityIndexRef = cities;
    }
    return _cityIndex[cid] || null;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var d2r = Math.PI / 180;
    var phi1 = lat1 * d2r;
    var phi2 = lat2 * d2r;
    var dphi = (lat2 - lat1) * d2r;
    var dlam = (lon2 - lon1) * d2r;
    var a = Math.sin(dphi / 2) * Math.sin(dphi / 2) +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) * Math.sin(dlam / 2);
    if (a > 1) a = 1;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  }

  // nearest_city：大圆距离最近的城市；CITIES 为空时回退北京（同 server.py fallback）。
  function nearestCity(lat, lon) {
    var cities = getCities();
    if (!cities.length) {
      return { id: 'beijing', name_zh: '北京', name_en: 'Beijing',
               lat: 39.9042, lon: 116.4074, tz: 'Asia/Shanghai', country_zh: '中国' };
    }
    var best = cities[0];
    var bestDist = haversineKm(lat, lon, best.lat, best.lon);
    for (var i = 1; i < cities.length; i++) {
      var d = haversineKm(lat, lon, cities[i].lat, cities[i].lon);
      if (d < bestDist) { best = cities[i]; bestDist = d; }
    }
    return best;
  }

  /* =========================================================================
   * localStorage（key 前缀 "time-"；损坏数据按空处理，不抛异常）
   * ======================================================================= */

  function lsGet(key) {
    try { return window.localStorage.getItem(key); }
    catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; }
    catch (e) { return false; }
  }

  /* ---------- 闹钟 ---------- */

  function genId() {
    var crypto = window.crypto || window.msCrypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
      var arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      var s = '';
      for (var i = 0; i < arr.length; i++) {
        var h = arr[i].toString(16);
        s += (h.length < 2 ? '0' : '') + h;
      }
      return s;
    }
    var s2 = '';
    for (var j = 0; j < 32; j++) s2 += Math.floor(Math.random() * 16).toString(16);
    return s2;
  }

  function normalizeAlarm(a) {
    var hour = (typeof a.hour === 'number' && isFinite(a.hour)) ? Math.floor(a.hour) : 0;
    var minute = (typeof a.minute === 'number' && isFinite(a.minute)) ? Math.floor(a.minute) : 0;
    var repeat = [];
    if (Array.isArray(a.repeat_days)) {
      for (var i = 0; i < a.repeat_days.length; i++) {
        var d = a.repeat_days[i];
        if (typeof d === 'number' && isFinite(d) && d >= 0 && d <= 6) repeat.push(Math.floor(d));
      }
    }
    return {
      id: (typeof a.id === 'string' && a.id) ? a.id : genId(),
      hour: hour,
      minute: minute,
      label: (typeof a.label === 'string') ? a.label : '',
      repeat_days: repeat,
      enabled: a.enabled !== false,
      created: (typeof a.created === 'string' && a.created) ? a.created : isoSeconds(new Date())
    };
  }

  function readAlarms() {
    var raw = lsGet(LS_ALARMS);
    if (!raw) return [];
    var data;
    try { data = JSON.parse(raw); }
    catch (e) { return []; }
    var arr = data;
    if (data && typeof data === 'object' && !Array.isArray(data)) arr = data.alarms;
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && typeof arr[i] === 'object') out.push(normalizeAlarm(arr[i]));
    }
    return out;
  }

  function writeAlarms(alarms) {
    lsSet(LS_ALARMS, JSON.stringify({ alarms: alarms }));
  }

  function copyAlarm(a) {
    return {
      id: a.id, hour: a.hour, minute: a.minute, label: a.label,
      repeat_days: a.repeat_days.slice(), enabled: a.enabled, created: a.created
    };
  }

  function validateInt(value, lo, hi, name) {
    if (typeof value === 'boolean' || typeof value !== 'number' ||
        !isFinite(value) || Math.floor(value) !== value) {
      throw new Error(name + ' 必须是整数');
    }
    if (value < lo || value > hi) {
      throw new Error(name + ' 必须在 [' + lo + ', ' + hi + '] 之间');
    }
    return value;
  }

  function validateRepeatDays(value) {
    if (value === null || value === undefined) return [];
    if (typeof value === 'string' || !Array.isArray(value)) {
      throw new Error('repeat_days 必须是 0-6 的整数列表（周一=0 … 周日=6）');
    }
    var seen = {};
    for (var i = 0; i < value.length; i++) {
      seen[validateInt(value[i], 0, 6, 'repeat_days 元素')] = true;
    }
    var out = [];
    for (var k = 0; k <= 6; k++) { if (seen[k]) out.push(k); }
    return out;
  }

  /* ---------- 用户城市 ---------- */

  function readUserCities() {
    var raw = lsGet(LS_USER_CITIES);
    if (!raw) return [];
    var data;
    try { data = JSON.parse(raw); }
    catch (e) { return []; }
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.cities)) {
      data = data.cities;   // 兼容 {"cities":[...]} 旧结构（同 store.UserCitiesStore）
    }
    if (!Array.isArray(data)) return [];
    var out = [];
    for (var i = 0; i < data.length; i++) {
      if (typeof data[i] === 'string') out.push(data[i]);
    }
    return out;
  }

  function writeUserCities(ids) {
    lsSet(LS_USER_CITIES, JSON.stringify(ids));
  }

  /* =========================================================================
   * IP 定位（浏览器直连 ip-api.com；进程内 10 分钟缓存，成功/失败都缓存）
   * ======================================================================= */

  var _ipCache = null;   // {value: {lat,lon,city,source}|null, expiresAt: ms}

  function copyIp(v) {
    return { lat: v.lat, lon: v.lon, city: v.city, source: v.source };
  }

  function parseIp(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.status !== 'success') return null;
    if (payload.lat === null || payload.lat === undefined ||
        payload.lon === null || payload.lon === undefined) return null;
    var lat = Number(payload.lat);
    var lon = Number(payload.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat: lat, lon: lon, city: (payload.city == null ? '' : String(payload.city)), source: 'ip' };
  }

  function fetchWithTimeout(url, ms) {
    var controller = null;
    var opts = undefined;
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      opts = { signal: controller.signal };
    }
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, ms);
    return fetch(url, opts).then(function (resp) {
      clearTimeout(timer);
      return resp;
    }).catch(function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function ipLocation() {
    var nowMs = Date.now();
    if (_ipCache && _ipCache.expiresAt > nowMs) {
      return Promise.resolve(_ipCache.value ? copyIp(_ipCache.value) : null);
    }
    return fetchWithTimeout(IP_API_URL, IP_TIMEOUT_MS).then(function (resp) {
      return resp.json();
    }).then(function (payload) {
      var value = parseIp(payload);
      _ipCache = { value: value, expiresAt: Date.now() + IP_CACHE_MS };
      return value ? copyIp(value) : null;
    }).catch(function () {
      _ipCache = { value: null, expiresAt: Date.now() + IP_CACHE_MS };
      return null;
    });
  }

  /* =========================================================================
   * 定位解析链（同 server.py::_resolve_location）
   *   params.lat/lon（合法）→ source=browser；否则 ipLocation → source=ip；
   *   再否则默认北京 → source=default。tz 参数合法才用，否则最近城市 tz。
   * ======================================================================= */

  function toFiniteNumber(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      if (isFinite(n)) return n;
    }
    return null;
  }

  function normalizeTzParam(tz) {
    if (typeof tz !== 'string') return null;
    tz = tz.trim();
    if (!tz) return null;
    return tzValid(tz);
  }

  function defaultLocation(tzName) {
    var beijing = cityById('beijing');
    if (beijing) return { lat: beijing.lat, lon: beijing.lon, tzName: tzName, source: 'default' };
    var cities = getCities();
    if (cities.length) {
      var c = cities[0];
      return { lat: c.lat, lon: c.lon, tzName: tzName, source: 'default' };
    }
    return { lat: 39.9042, lon: 116.4074, tzName: tzName, source: 'default' };
  }

  function resolveLocation(params) {
    var tzName = normalizeTzParam(params.tz);
    var lat = toFiniteNumber(params.lat);
    var lon = toFiniteNumber(params.lon);
    if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return Promise.resolve({ lat: lat, lon: lon, tzName: tzName, source: 'browser' });
    }
    return ipLocation().then(function (ip) {
      if (ip && typeof ip.lat === 'number' && typeof ip.lon === 'number') {
        return { lat: ip.lat, lon: ip.lon, tzName: tzName, source: 'ip' };
      }
      return defaultLocation(tzName);
    });
  }

  // _requested_cities：?cities= → City 列表（保序去重，非法 id 忽略）。
  // 省略/空 → localStorage user-cities；仍空 → DEFAULT_CITY_IDS。
  function requestedCities(params) {
    var raw = params.cities;
    var ids;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      ids = readUserCities();
      if (!ids.length) ids = DEFAULT_CITY_IDS.slice();
    } else if (typeof raw === 'string') {
      ids = raw.split(',');
    } else if (Array.isArray(raw)) {
      ids = raw;
    } else {
      ids = [];
    }
    var result = [];
    var seen = {};
    for (var i = 0; i < ids.length; i++) {
      var cid = ids[i];
      if (typeof cid === 'string') cid = cid.trim();
      if (!cid || typeof cid !== 'string' || seen[cid]) continue;
      var city = cityById(cid);
      if (!city) continue;
      seen[cid] = true;
      result.push(city);
    }
    return result;
  }

  /* =========================================================================
   * StateDict 组装（逐字段对齐 server.py::_build_state）
   * ======================================================================= */

  function getSolar() {
    return window.TimeSolar;
  }

  function buildState(now, loc, requested) {
    var solar = getSolar();
    var lat = loc.lat;
    var lon = loc.lon;
    var nearest = nearestCity(lat, lon);
    var tz = tzValid(loc.tzName) || tzValid(nearest.tz) || 'Asia/Shanghai';

    var position = solar.solarPosition(now);
    var bands = solar.terminatorBands(now, 0.5);
    var elevation = solar.solarElevation(now, lat, lon);
    var ss = solar.sunriseSunsetLocal(now, lat, lon, tz) || {};

    var locParts = tzParts(now, tz);

    var location = {
      name_zh: nearest.name_zh,
      lat: pyRound(lat, 4),
      lon: pyRound(lon, 4),
      tz: tz,
      source: loc.source,
      local_time: partsToFull(locParts),
      local_time_short: partsToShort(locParts),
      date_label: '今天',   // 定位自身所在时区，恒为今天
      utc_offset_hours: offsetFromParts(locParts, now),
      sunrise: fmtHhmm(ss.sunrise),
      sunset: fmtHhmm(ss.sunset),
      day_length: dayLengthLabel(now, lat, lon),
      solar_elevation: round1(elevation),
      is_day: isDay(elevation)
    };

    var solarSection = {
      subsolar_lat: round1(position.subsolarLat),
      subsolar_lon: roundSubsolarLon(position.subsolarLon),
      declination: round1(position.declinationDeg),
      eq_of_time_min: round1(position.eqOfTimeMin)
    };

    var bRows = bands.rows || [];
    var rows = [];
    for (var i = 0; i < bRows.length; i++) {
      var r = bRows[i] || {};
      rows.push([
        pyRound(r.lat, 2),
        roundLon360(r.nightStartLon),
        roundLon360(r.nightEndLon),
        (KIND_CODES[r.kind] === undefined) ? 0 : KIND_CODES[r.kind]
      ]);
    }
    var terminator = {
      lat_step: bands.latStepDeg,
      subsolar_lat: round1(bands.subsolarLat),
      subsolar_lon: roundSubsolarLon(bands.subsolarLon),
      rows: rows
    };

    var cityEntries = [];
    for (var j = 0; j < requested.length; j++) {
      var city = requested[j];
      var cityTz = tzValid(city.tz) || tz;
      var cityParts = tzParts(now, cityTz);
      var cityElev = solar.solarElevation(now, city.lat, city.lon);
      var citySs = solar.sunriseSunsetLocal(now, city.lat, city.lon, cityTz) || {};
      cityEntries.push({
        id: city.id,
        name_zh: city.name_zh,
        name_en: city.name_en,
        lat: pyRound(city.lat, 1),
        lon: pyRound(city.lon, 1),
        tz: city.tz,
        local_time: partsToShort(cityParts),
        date_label: dateLabel(cityParts, locParts),
        utc_offset_hours: offsetFromParts(cityParts, now),
        sunrise: fmtHhmm(citySs.sunrise),
        sunset: fmtHhmm(citySs.sunset),
        is_day: isDay(cityElev),
        solar_elevation: round1(cityElev)
      });
    }

    return {
      server_time_utc: isoSeconds(now),
      epoch_ms: now.getTime(),
      location: location,
      solar: solarSection,
      terminator: terminator,
      cities: cityEntries
    };
  }

  /* =========================================================================
   * 猴补 window.TimeAPI
   * ======================================================================= */

  if (!window.TimeAPI) {
    window.TimeAPI = {};   // api.js 未加载时的空壳（fmt2 由调用方兜底）
  }
  var api = window.TimeAPI;

  // GET /api/state 语义：params {lat, lon, tz, cities} → StateDict
  api.getState = function (params) {
    params = params || {};
    var now = new Date();
    var requested = requestedCities(params);   // 同步：读 localStorage
    return resolveLocation(params).then(function (loc) {
      return buildState(now, loc, requested);
    });
  };

  // 静态版本机时钟即权威 → 恒 0
  api.syncOffset = function () {
    return Promise.resolve(0);
  };

  api.now = function () {
    return new Date();
  };

  // 浏览器直连 ip-api.com；失败/超时/缓存 → null（不抛异常）
  api.ipLocation = function () {
    return ipLocation();
  };

  // 全量城市（供「+」选择器；契约 §5，全量精度）
  api.cities = function () {
    var cities = getCities();
    var out = [];
    for (var i = 0; i < cities.length; i++) {
      var c = cities[i];
      out.push({
        id: c.id, name_zh: c.name_zh, name_en: c.name_en,
        lat: c.lat, lon: c.lon, tz: c.tz, country_zh: c.country_zh
      });
    }
    return Promise.resolve(out);
  };

  api.alarms = {
    list: function () {
      return Promise.resolve(readAlarms());
    },
    add: function (a) {
      a = a || {};
      try {
        var hour = validateInt(a.hour, 0, 23, 'hour');
        var minute = validateInt(a.minute, 0, 59, 'minute');
        var days = validateRepeatDays(a.repeat_days);
        var label = (a.label === null || a.label === undefined) ? '' : String(a.label);
        var enabled = (a.enabled === false) ? false : true;
        var alarm = {
          id: genId(),
          hour: hour,
          minute: minute,
          label: label,
          repeat_days: days,
          enabled: enabled,
          created: isoSeconds(new Date())
        };
        var alarms = readAlarms();
        alarms.push(alarm);
        writeAlarms(alarms);
        return Promise.resolve(copyAlarm(alarm));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    toggle: function (id) {
      var alarms = readAlarms();
      for (var i = 0; i < alarms.length; i++) {
        if (alarms[i].id === id) {
          alarms[i].enabled = !alarms[i].enabled;
          writeAlarms(alarms);
          return Promise.resolve(copyAlarm(alarms[i]));
        }
      }
      return Promise.resolve(null);
    },
    remove: function (id) {
      var alarms = readAlarms();
      var kept = [];
      var removed = false;
      for (var i = 0; i < alarms.length; i++) {
        if (alarms[i].id === id) removed = true;
        else kept.push(alarms[i]);
      }
      if (removed) writeAlarms(kept);
      return Promise.resolve(removed);
    }
  };

  api.userCities = {
    get: function () {
      return Promise.resolve(readUserCities());
    },
    set: function (ids) {
      var result = [];
      var seen = {};
      if (Array.isArray(ids)) {
        for (var i = 0; i < ids.length; i++) {
          var cid = ids[i];
          if (typeof cid !== 'string' || seen[cid]) continue;
          if (!cityById(cid)) continue;
          seen[cid] = true;
          result.push(cid);
        }
      }
      writeUserCities(result);
      return Promise.resolve(result);
    }
  };

  // fmt2 保留 api.js 原样（契约：无需补）。
})();
