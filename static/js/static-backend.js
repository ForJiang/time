/* static-backend.js — 静态部署版"服务端"（window.StaticBackend）
 *
 * GitHub Pages 纯静态部署（无 Python 服务端）下的 /api/state 等价物：
 * 用 window.TimeSolar（app/solar.py 的 JS 移植）在浏览器本地组装 StateDict，
 * 字段与口径逐项镜像 app/server.py 的 _build_state / app/geo.py 的
 * resolve_location 四级定位回退链（契约 §3/§4/§5）。
 *
 * 定位链（静态版）：
 *   ① 浏览器 Geolocation（app.js 成功后把 lat/lon/tz 传进 buildState）→ browser
 *   ② get.geojs.io IP 定位（HTTPS + CORS，latitude/longitude 为字符串，
 *      自带 timezone 字段；http 部署可回退 ip-api，但 Pages 是 HTTPS，
 *      http 外链会被混合内容拦截，故只用 geojs）→ ip
 *   ③ 浏览器时区 → 内置 TZ_COORDS 表（app/tzcoords.py 的 JS 化，tz-coords.js）→ timezone
 *   ④ 默认北京 → default
 * IP 结果进程内缓存 10 分钟（含否定结果，避免 1Hz 轮询反复敲外网）。
 *
 * 时间基准：静态版无服务端可校准，epoch_ms/时钟一律用设备本地时钟
 * （TimeAPI.now() = new Date()）。
 *
 * 语法约束：ES2017 子集（esprima 解析；无外部请求白名单外的请求、无 eval）。
 */
(function () {
  'use strict';

  var DAY_THRESHOLD_DEG = -0.833;
  var GEOJS_URL = 'https://get.geojs.io/v1/ip/geo.json';
  var IP_TIMEOUT_MS = 3000;
  var CACHE_MS = 600000;
  var DEFAULT_LOC = { lat: 39.9042, lon: 116.4074, name: '北京', tz: 'Asia/Shanghai' };
  /* FALLBACK_TZ：tz_hint 缺失/非法时的回退时区（与 app/geo.py 的 FALLBACK_TZ='UTC' 一致；
   * 注意默认定位用 DEFAULT_TZ='Asia/Shanghai'，两者不同） */
  var FALLBACK_TZ = 'UTC';
  var WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var LON_STEP = 1.0;
  var TWILIGHT_DEG = 6.0;

  var TZ_COORDS = (typeof window !== 'undefined' && window.TZ_COORDS) || {};

  /* IP 定位缓存（成功/失败都缓存，键固定——静态版只有"本机 IP"一个键） */
  var ipCache = { at: 0, value: null, has: false };

  /* _valid_tz：Intl 能解析的时区名才采用；非法 → null（镜像 server.py，
   * 调用方随后落到 FALLBACK_TZ）。 */
  function validTz(tz) {
    if (typeof tz !== 'string' || !tz) return null;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
      return tz;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 基础工具（镜像 server.py 的 _round2/_round_subsolar_lon/_fmt_* ）
  // ---------------------------------------------------------------------------

  function round2(x) {
    var v = Number(x);
    if (!isFinite(v)) return null;
    return Math.round(v * 100) / 100;
  }

  /* _round4：定位坐标 → 4 位小数（镜像 server.py _round4，契约 §5 示例量级） */
  function round4(x) {
    var v = Number(x);
    if (!isFinite(v)) return null;
    return Math.round(v * 10000) / 10000;
  }

  /* _round_subsolar_lon：2 位小数；进位到 180.0 时按环形语义吸附回 -180.0 */
  function roundSubsolarLon(v) {
    var r = round2(v);
    if (r !== null && r >= 180.0) return -180.0;
    return r;
  }

  /* _fmt_day_length：极昼 24:00 / 极夜 00:00 / 常规 HH:MM（先化分钟再整除，
   * 与 Python 的 int(round(h*60)) 一致，23.999h 正确得 24:00 而非 23:60） */
  function fmtDayLength(hours) {
    var v = Number(hours);
    if (!isFinite(v)) return '--:--';
    if (v >= 24.0) return '24:00';
    if (v <= 0.0) return '00:00';
    var total = Math.round(v * 60);
    var h = Math.floor(total / 60);
    var m = total % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* 当地墙上时钟字段（Intl，hourCycle h23 避免午夜报 24） */
  function wallFields(date, tz) {
    try {
      var f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      var parts = f.formatToParts(date);
      var o = {};
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type !== 'literal') o[parts[i].type] = parts[i].value;
      }
      if (o.year && o.month && o.day) {
        return {
          year: +o.year, month: +o.month, day: +o.day,
          hour: o.hour ? +o.hour : 0, minute: +o.minute, second: +o.second
        };
      }
    } catch (e) { /* 时区非法：调用方已校验，这里兜底 null */ }
    return null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* local_time："HH:MM:SS"（定位时区） */
  function fmtHMS(date, tz) {
    var w = wallFields(date, tz);
    if (!w) return '--:--:--';
    return pad2(w.hour) + ':' + pad2(w.minute) + ':' + pad2(w.second);
  }

  /* sunrise/sunset → "HH:MM"（dt 为 Date 瞬间，归算到 tz 后取时分） */
  function fmtHM(dt, tz) {
    if (!dt) return null;
    var w = wallFields(dt, tz);
    if (!w) return null;
    return pad2(w.hour) + ':' + pad2(w.minute);
  }

  /* date_label："2026-10-10 周六" */
  function dateLabel(date, tz) {
    var w = wallFields(date, tz);
    if (!w) return '';
    var weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    return w.year + '-' + pad2(w.month) + '-' + pad2(w.day) + ' ' + WEEKDAYS_CN[weekday];
  }

  /* utc_offset_hours：当地墙上时间 − UTC 墙上时间（tzdb 偏移均为整秒，精确；
   * 2 位小数与 server.py _utc_offset_hours 的 round(..., 2) 同口径） */
  function utcOffsetHours(date, tz) {
    var w = wallFields(date, tz);
    if (!w) return 0;
    var wallMs = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    var seconds = Math.round((wallMs - date.getTime()) / 1000);
    return Math.round((seconds / 3600) * 100) / 100;
  }

  /* server_time_utc：ISO8601 秒级 +00:00（镜像 Python isoformat） */
  function isoSeconds(date) {
    return date.toISOString().slice(0, 19) + '+00:00';
  }

  // ---------------------------------------------------------------------------
  // 定位回退链（镜像 app/geo.py resolve_location）
  // ---------------------------------------------------------------------------

  /* geojs IP 定位：{lat, lon, city, tz} | null；3s 超时，10 分钟缓存（含否定）。
   * 比 geo.py 的 _fetch 多两道校验（lat/lon 越界、非数字直接判不可用落入下一级）：
   * geojs 是第三方免费服务，静态版没有服务端那道 _as_float 之前的人工审查，
   * 从严处理属安全偏离（geo.py 只拒非有限值）。 */
  function ipLocation() {
    var nowMs = Date.now();
    if (ipCache.has && nowMs - ipCache.at < CACHE_MS) {
      return Promise.resolve(ipCache.value);
    }
    var timer = null;
    var timeoutP = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(null); }, IP_TIMEOUT_MS);
    });
    var fetchP = fetch(GEOJS_URL).then(function (resp) {
      if (!resp || !resp.ok) return null;
      return resp.json();
    }).then(function (d) {
      if (!d || typeof d !== 'object') return null;
      var lat = parseFloat(d.latitude);
      var lon = parseFloat(d.longitude);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
      return {
        lat: lat, lon: lon,
        city: (typeof d.city === 'string') ? d.city : '',
        tz: (typeof d.timezone === 'string') ? d.timezone : ''
      };
    }).catch(function () { return null; });
    return Promise.race([fetchP, timeoutP]).then(function (v) {
      if (timer) clearTimeout(timer);
      ipCache.at = Date.now();
      ipCache.value = v;
      ipCache.has = true;
      return v;
    });
  }

  function tzLocation(tzName) {
    if (typeof tzName !== 'string' || !tzName) return null;
    var e = TZ_COORDS[tzName];
    if (!e) return null;
    return { lat: e[0], lon: e[1], name: e[2], tz: tzName };
  }

  /* 四级链：browser → ip → timezone → default（与 geo.py resolve_location
   * 逐字镜像：tz 只用校验过的 tz_hint，缺失/非法回退 FALLBACK_TZ='UTC'；
   * 浏览器时区由 app.js 启动时作为 tz_hint 传入，链内不自行读 Intl。
   * 唯一偏离：server.py 对越界 lat/lon 回 400，静态版无 HTTP 层可回，
   * 越界坐标按"不可用"落入下一级（IP → 时区 → 默认）。 */
  function resolveLocation(params) {
    var p = params || {};
    var lat = (typeof p.lat === 'number' && isFinite(p.lat)) ? p.lat : null;
    var lon = (typeof p.lon === 'number' && isFinite(p.lon)) ? p.lon : null;
    var tz = validTz(p.tz);

    if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return Promise.resolve({
        lat: lat, lon: lon, name: '', tz: tz || FALLBACK_TZ, source: 'browser'
      });
    }
    return ipLocation().then(function (ip) {
      if (ip) {
        return {
          lat: ip.lat, lon: ip.lon, name: ip.city || '',
          tz: validTz(ip.tz) || tz || FALLBACK_TZ, source: 'ip'
        };
      }
      if (tz !== null) {
        var hit = tzLocation(tz);
        if (hit) {
          return { lat: hit.lat, lon: hit.lon, name: hit.name, tz: tz, source: 'timezone' };
        }
      }
      return {
        lat: DEFAULT_LOC.lat, lon: DEFAULT_LOC.lon, name: DEFAULT_LOC.name,
        tz: DEFAULT_LOC.tz, source: 'default'
      };
    });
  }

  // ---------------------------------------------------------------------------
  // StateDict 组装（镜像 server.py _build_state，契约 §5）
  // ---------------------------------------------------------------------------

  /* 曲线量化：lon/lat 都舍入到 2 位小数（与 server.py _build_state 的
   * [[_round2(lon_i), _round2(lat_i)]] 逐字对齐——原来只舍 lat）。
   * 生产 LON_STEP=1.0 下 lon 为整数，round2 是恒等变换（零行为变化）；
   * 非整数步长时两侧 lon 双精度值本就逐位相同（solar-engine.js 与 solar.py
   * 都是 -180 + i*step 同序运算），补上 lon 舍入后连"round 半偶 vs
   * Math.round 半上"的平局分歧也不存在，镜像不留缺口。curve6 的 None 原样保留。 */
  function quantizeCurve(points) {
    var out = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      out.push([round2(p[0]), p[1] === null || p[1] === undefined ? null : round2(p[1])]);
    }
    return out;
  }

  /* buildState({lat, lon, tz}) → Promise<StateDict>；任何失败抛错由调用方降级 */
  function buildState(params) {
    var date = new Date();
    return resolveLocation(params).then(function (loc) {
      /* tz 归一化（镜像 server.py：_valid_tz 失败落 FALLBACK_TZ='UTC'，
       * 且响应里的 tz 报归一化后的值） */
      var tz = validTz(loc.tz) || FALLBACK_TZ;
      var pos = window.TimeSolar.solarPosition(date);
      var curves = window.TimeSolar.terminatorCurves(date, LON_STEP, TWILIGHT_DEG);
      var elevation = window.TimeSolar.solarElevation(date, loc.lat, loc.lon);
      var ss = window.TimeSolar.sunriseSunsetLocal(date, loc.lat, loc.lon, tz);
      var dl = window.TimeSolar.dayLengthHours(date, loc.lat, loc.lon);
      return {
        epoch_ms: date.getTime(),
        server_time_utc: isoSeconds(date),
        location: {
          lat: round4(loc.lat),
          lon: round4(loc.lon),
          name: loc.name,
          tz: tz,
          source: loc.source,
          local_time: fmtHMS(date, tz),
          date_label: dateLabel(date, tz),
          utc_offset_hours: utcOffsetHours(date, tz),
          is_day: elevation >= DAY_THRESHOLD_DEG,
          solar_elevation: round2(elevation),
          sunrise: fmtHM(ss.sunrise, tz),
          sunset: fmtHM(ss.sunset, tz),
          day_length: fmtDayLength(dl)
        },
        solar: {
          subsolar_lat: round2(pos.declinationDeg),
          subsolar_lon: roundSubsolarLon(pos.subsolarLonDeg),
          declination: round2(pos.declinationDeg),
          eq_of_time_min: round2(pos.eqOfTimeMin)
        },
        terminator: {
          lon_step: curves.lonStepDeg,
          count: curves.curve0.length,
          night_north: curves.nightNorth,
          curve0: quantizeCurve(curves.curve0),
          curve6: quantizeCurve(curves.curve6)
        }
      };
    });
  }

  /* 只导出 buildState：它就是静态版的 /api/state 等价物，也是 static-api.js
   * 的唯一取数缝；定位链/格式化助手均为内部实现，无外部消费者。 */
  window.StaticBackend = {
    buildState: buildState
  };
})();
