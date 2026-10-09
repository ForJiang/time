/* ============================================================================
 * solar-engine.js — time 项目静态部署版天文引擎（window.TimeSolar）
 *
 * 本文件是 app/solar.py（Meeus《Astronomical Algorithms》第 25 章太阳视位置）
 * 的逐函数忠实移植，供 GitHub Pages 纯静态部署（无 Python 服务端）使用。
 * 数值目标：与 Python 实现同算法、同 IEEE754 双精度、同运算顺序，
 * 期望一致到 ~1e-9（时间字符串精确一致）。
 *
 * 函数对应关系（每个函数注释标明 solar.py 来源）：
 *   julianDay          ← julian_day
 *   solarPosition      ← solar_position
 *   solarElevation     ← solar_elevation
 *   hourAngleSunset    ← hour_angle_sunset
 *   terminatorBands    ← terminator_bands
 *   dayLengthHours     ← day_length_hours
 *   sunriseSunsetLocal ← sunrise_sunset（仅输出当地 HH:MM 展示）
 *
 * 与 Python 行为差异的处理（移植关键点）：
 * 1. 时间表示：内部用 {days, us}（自 Unix 纪元起的整数天 + 当日整数微秒）
 *    表示 UTC 瞬间，等价于 Python datetime 的 (date.toordinal(), microsecond)
 *    字段；全程整数运算，避免浮点毫秒在 ±80 个儒略世纪范围内的精度损失。
 *    `t + timedelta(hours=h)` 的"量化到微秒、半数取偶"语义在 _addHours 中
 *    等价复现（CPython 3.12+ 对 timedelta 用精确有理运算后按半数取偶舍入）。
 * 2. Python 的 `%` 取膜恒非负（fmod 后按符号修正），JS 的 `%` 是截断余数，
 *    所有取模经 _pymod 复现（例如 subsolar_lon 的归一化必须落回 [-180,180)）。
 * 3. Python round() 半数取偶，JS Math.round 半数取正 —— 用 _roundHalfEven
 *    复现；terminator_bands 的 n_intervals = int(round(180/step)) 依赖此
 *    语义（如 step=8 → 180/8=22.5 → 22 行区间，而非 23）。
 * 4. JS 只有 Date 瞬间：naive/aware 的区分在接口上消失（入参统一为 UTC 瞬间
 *    的 Date，等价于 Python 的 naive-as-UTC / aware→UTC）。时区换算用
 *    Intl.DateTimeFormat('en-CA', {...}).formatToParts 取当地墙上时钟字段；
 *    时区偏移 = 当地墙上时间 − UTC 墙上时间（tzdb 偏移均为整秒，故精确）。
 *    当地正午的 UTC 瞬间用不动点迭代 T = wallNoon − offset(T) 求得
 *    （等价于 datetime(...,tzinfo=tz).astimezone(utc)）。
 * 5. 异常映射：Python ValueError → JS RangeError；Python TypeError → JS
 *    TypeError；Python OverflowError（事件时刻超出 datetime 可表示范围，
 *    即 0001-01-01 ~ 9999-12-31 之外）→ JS RangeError。
 *
 * 语法约束：ES2017 子集（禁 ?. / ?? / #private，无 ES module，IIFE 挂 window）。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 模块级常量（一一对应 app/solar.py 顶部常量）
  // ---------------------------------------------------------------------------

  // SUNSET_DEPRESSION_DEG：民用日出日落阈值（蒙气差 34′ + 太阳视半径 16′ = 0.833°）
  var SUNSET_DEPRESSION_DEG = 0.833;
  // J2000_EPOCH_JD：J2000.0 历元的儒略日（2000-01-01 12:00 UTC）
  var J2000_EPOCH_JD = 2451545.0;
  // DAYS_PER_CENTURY：一个儒略世纪的天数
  var DAYS_PER_CENTURY = 36525.0;
  // _JD_EPOCH_ORDINAL_OFFSET：date.toordinal() + 本常量 = 当日 0h 儒略日
  var JD_EPOCH_ORDINAL_OFFSET = 1721424.5;
  // _POLE_COS_EPS：判定"极点"的 |cos(lat)| 阈值
  var POLE_COS_EPS = 1e-12;
  // _ACOS_EPS：acos 参数越界 [-1,1] 的数值容差
  var ACOS_EPS = 1e-12;
  // _SECONDS_PER_DAY
  var SECONDS_PER_DAY = 86400.0;

  // 1970-01-01 00:00 UTC 的 date.toordinal()；Python datetime.min/max 的序号
  var ORDINAL_AT_UNIX_EPOCH = 719163;
  var ORDINAL_MIN = 1;        // 0001-01-01
  var ORDINAL_MAX = 3652059;  // 9999-12-31

  // 时间单位（内部 {days, us} 表示法；us 为当日微秒，[0, 86400e6)）
  var US_PER_MS = 1000;         // 1 毫秒 = 1000 微秒（ms→us 换算，勿用 US_PER_SECOND）
  var MS_PER_SECOND = 1000;
  var MS_PER_MINUTE = 60000;
  var MS_PER_HOUR = 3600000;
  var MS_PER_DAY = 86400000;
  var US_PER_SECOND = 1000000;
  var US_PER_MINUTE = 60000000;
  var US_PER_HOUR = 3600000000;
  var US_PER_DAY = 86400000000;

  // ---------------------------------------------------------------------------
  // 内部工具（对应 solar.py 的 _deg2rad/_rad2deg/_sin_deg/_cos_deg 与
  // Python/JS 语义桥接）
  // ---------------------------------------------------------------------------

  function _deg2rad(d) { return d * Math.PI / 180.0; }        // _deg2rad
  function _rad2deg(r) { return r * 180.0 / Math.PI; }        // _rad2deg
  function _sinDeg(d) { return Math.sin(_deg2rad(d)); }       // _sin_deg
  function _cosDeg(d) { return Math.cos(_deg2rad(d)); }       // _cos_deg

  /* Python 的 a % b（取膜结果与 b 同号，恒非负当 b>0）；JS 的 % 是截断余数，
   * 例如 (-20) % 360：Python → 340，JS → -20。 */
  function _pymod(a, b) {
    var r = a % b;
    if (r !== 0 && (r < 0) !== (b < 0)) { r += b; }
    return r;
  }

  /* Python round()（无 ndigits）：四舍五入、半数取偶。
   * JS Math.round 半数取正，且 terminator_bands 的行数依赖此语义。 */
  function _roundHalfEven(x) {
    var f = Math.floor(x);
    var d = x - f;
    if (d > 0.5) { return f + 1; }
    if (d < 0.5) { return f; }
    return (f % 2 === 0) ? f : f + 1;
  }

  /* 对应 Python 的 float()：数值直接返回；字符串按 Python float(str) 语义转换；
   * 其它类型对应 Python 的 TypeError。 */
  function _toNum(v, name) {
    var t = typeof v;
    if (t === 'number') { return v; }
    if (t === 'string') {
      var n = Number(v);
      if (!isNaN(n)) { return n; }
      throw new TypeError(name + ' 必须是实数，得到 ' + v);
    }
    throw new TypeError(name + ' 必须是实数，得到 ' + t);
  }

  // _check_lat：纬度必须是 [-90, 90] 内的有限实数
  function _checkLat(latDeg) {
    var lat = _toNum(latDeg, '纬度');
    if (!isFinite(lat) || lat < -90.0 || lat > 90.0) {
      throw new RangeError('纬度超出 [-90, 90] 范围: ' + latDeg);
    }
    return lat;
  }

  // _norm_lon：经度归一化到 [-180, 180)
  function _normLon(lonDeg) {
    var lon = _toNum(lonDeg, '经度');
    if (!isFinite(lon)) {
      throw new RangeError('经度必须是有限实数: ' + lonDeg);
    }
    return _pymod(lon + 180.0, 360.0) - 180.0;
  }

  /* _norm_lon_360：经度归一化到 [0, 360)。
   * 注意 JS/Python 的 % 对绝对值极小的负数会舍入回 360.0（如 -1e-16 % 360），
   * 这里显式吸附回 0.0，保证严格满足 [0, 360) 的契约区间。 */
  function _normLon360(lonDeg) {
    var lon = _toNum(lonDeg, '经度');
    if (!isFinite(lon)) {
      throw new RangeError('经度必须是有限实数: ' + lonDeg);
    }
    lon = _pymod(lon, 360.0);
    return lon >= 360.0 ? 0.0 : lon;
  }

  // _zone：校验 IANA 时区名（非法名对应 Python 的 ValueError）
  function _checkTz(tzName) {
    if (typeof tzName !== 'string' || tzName === '') {
      throw new RangeError('非法 IANA 时区名: ' + tzName);
    }
    try {
      _tzFormatter(tzName);
    } catch (exc) {
      throw new RangeError('未知 IANA 时区名: ' + tzName);
    }
    return tzName;
  }

  // ---------------------------------------------------------------------------
  // 时间表示：{days, us}（days = 自 Unix 纪元的天数；us = 当日整数微秒）
  // ---------------------------------------------------------------------------

  function _dateToT(date) {
    if (!(date instanceof Date) && Object.prototype.toString.call(date) !== '[object Date]') {
      throw new TypeError('期望 Date 实例，得到 ' + typeof date);
    }
    var ms = date.getTime();
    if (isNaN(ms)) {
      throw new RangeError('date 不是有效的时间瞬间');
    }
    var days = Math.floor(ms / MS_PER_DAY);
    var msOfDay = ms - days * MS_PER_DAY;   // [0, 86400000) 毫秒，整数
    return { days: days, us: msOfDay * US_PER_MS };
  }

  function _msToT(ms) {
    var m = Math.round(ms);   // tz 偏移为整秒，取整仅为防御
    var days = Math.floor(m / MS_PER_DAY);
    var msOfDay = m - days * MS_PER_DAY;
    return { days: days, us: msOfDay * US_PER_MS };
  }

  /* t → Unix 毫秒时间戳。注意单位：days 项是毫秒列，us（微秒）要 /1000 换算成毫秒
   * （US_PER_MS=1000；勿除以 US_PER_SECOND，那会得到秒而与毫秒列混算）。 */
  function _tToMs(t) { return t.days * MS_PER_DAY + t.us / US_PER_MS; }

  /* 对应 Python datetime 的 hour/minute/second/microsecond 字段
   * （全整数运算，精确）。 */
  function _fieldsFromT(t) {
    var us = t.us;
    var hour = Math.floor(us / US_PER_HOUR);
    us -= hour * US_PER_HOUR;
    var minute = Math.floor(us / US_PER_MINUTE);
    us -= minute * US_PER_MINUTE;
    var second = Math.floor(us / US_PER_SECOND);
    us -= second * US_PER_SECOND;
    return { hour: hour, minute: minute, second: second, microsecond: us };
  }

  /* 对应 Python：t + timedelta(hours=hours)。
   * timedelta 以微秒为单位量化：CPython 3.12+ 先做精确有理运算再按
   * "四舍五入、半数取偶"舍入到整微秒；datetime+timedelta 为精确整数运算。
   * 结果越界（0001-01-01 ~ 9999-12-31 之外）对应 Python 的 OverflowError。 */
  function _addHours(t, hours) {
    var deltaUs = _roundHalfEven(hours * 3600000000.0);
    var total = t.us + deltaUs;                      // 整数，|total| < 1.3e11，精确
    var dayShift = Math.floor(total / US_PER_DAY);   // ∈ {-1, 0, 1}
    return _checkRange({ days: t.days + dayShift, us: total - dayShift * US_PER_DAY });
  }

  function _checkRange(t) {
    var ordinal = t.days + ORDINAL_AT_UNIX_EPOCH;
    if (ordinal < ORDINAL_MIN || ordinal > ORDINAL_MAX ||
        (ordinal === ORDINAL_MAX && t.us > US_PER_DAY - 1)) {
      throw new RangeError('事件时刻超出 datetime 可表示范围（Python: OverflowError）');
    }
    return t;
  }

  /* (t2 - t1) 的整数微秒差；事件间隔恒在数日之内（days 差 ≤ 1），整数运算精确。 */
  function _totalUs(t1, t2) {
    return (t2.days - t1.days) * US_PER_DAY + (t2.us - t1.us);
  }

  // 对应 (t2 - t1).total_seconds()
  function _diffSeconds(t1, t2) { return _totalUs(t1, t2) / 1000000.0; }

  // 对应 (t2 - t1).total_seconds() / 3600.0
  function _diffHours(t1, t2) { return _diffSeconds(t1, t2) / 3600.0; }

  // ---------------------------------------------------------------------------
  // 时区工具（Intl.DateTimeFormat 取当地墙上时钟；对应 Python zoneinfo）
  // ---------------------------------------------------------------------------

  var _TZ_FMT_CACHE = Object.create(null);

  function _tzFormatter(tzName) {
    var fmt = _TZ_FMT_CACHE[tzName];
    if (fmt === undefined) {
      // en-CA 输出数值型年/月/日/时/分/秒；hour12:false 下个别 ICU 版本会把
      // 午夜渲染成 "24"，取 %24 防御。
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tzName,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
      _TZ_FMT_CACHE[tzName] = fmt;
    }
    return fmt;
  }

  /* 某 UTC 瞬间在 tzName 时区的当地墙上时钟字段（年/月/日/时/分/秒）。
   * 对应 Python 的 dt.astimezone(tz) 后的各字段。 */
  function _tzWallFields(ms, tzName) {
    var parts = _tzFormatter(tzName).formatToParts(new Date(ms));
    var out = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var v = parseInt(p.value, 10);
      if (p.type === 'year') { out.year = v; }
      else if (p.type === 'month') { out.month = v; }
      else if (p.type === 'day') { out.day = v; }
      else if (p.type === 'hour') { out.hour = v % 24; }
      else if (p.type === 'minute') { out.minute = v; }
      else if (p.type === 'second') { out.second = v; }
    }
    return out;
  }

  /* 把"墙上时钟"当作 UTC 解释为毫秒时间戳。
   * 首选 Date.UTC（本环境 Chromium 153 实测 setUTCFullYear 的 4+ 参数形式会
   * 丢弃时分秒、直接返回当日 00:00，故不可用；setUTCHours 两步法仅作兜底）。
   * Date.UTC 会把 0-99 的年份映射到 1900-1999：结果年份不符时用
   * setUTCFullYear(年,月,日)（三步形式正常）+ setUTCHours 修正。 */
  function _wallAsUtcMs(year, month, day, hour, minute, second) {
    var ms = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    if (new Date(ms).getUTCFullYear() !== year) {
      var d = new Date(0);
      d.setUTCFullYear(year, month - 1, day);
      d.setUTCHours(hour, minute, second, 0);
      ms = d.getTime();
    }
    return ms;
  }

  /* 时区偏移（毫秒）= 该瞬间在 tz 的当地墙上时间 − UTC 墙上时间。
   * tzdb 偏移均为整秒，故用「墙上字段（秒级）− floor(截断到毫秒的 ms/1000)*1000」
   * 精确求得；new Date(ms) 向零截断，故同样先 Math.trunc 保持一致。 */
  function _tzOffsetMsAt(ms, tzName) {
    var f = _tzWallFields(ms, tzName);
    var wall = _wallAsUtcMs(f.year, f.month, f.day, f.hour, f.minute, f.second);
    var tSec = Math.floor(Math.trunc(ms) / MS_PER_SECOND) * MS_PER_SECOND;
    return wall - tSec;
  }

  /* 对应 sunrise_sunset 中的日期锚点：
   *   datetime(y, m, d, 12, 0, 0, tzinfo=tz).astimezone(timezone.utc)
   * 不动点求解 T = wallNoon − offset(T)。tzdb 不存在"当地正午恰好发生偏移
   * 切换"的时区，三轮迭代足以收敛（对 DST 边界同样正确）。 */
  function _localNoonT(year, month, day, tzName) {
    var wallNoon = _wallAsUtcMs(year, month, day, 12, 0, 0);
    var tMs = wallNoon - _tzOffsetMsAt(wallNoon, tzName);
    tMs = wallNoon - _tzOffsetMsAt(tMs, tzName);
    tMs = wallNoon - _tzOffsetMsAt(tMs, tzName);
    return _msToT(tMs);
  }

  /* 当地墙上时钟的 "HH:MM"（截断到分，对应 Python aware datetime 的
   * strftime('%H:%M')）。 */
  function _fmtHM(t, tzName) {
    var f = _tzWallFields(_tToMs(t), tzName);
    return _pad2(f.hour) + ':' + _pad2(f.minute);
  }

  function _pad2(n) { return n < 10 ? '0' + n : String(n); }

  // ---------------------------------------------------------------------------
  // 核心：儒略日与太阳位置（对应 julian_day / solar_position）
  // ---------------------------------------------------------------------------

  /* 对应 julian_day(dt_utc)：
   *   _JD_EPOCH_ORDINAL_OFFSET + ordinal + seconds / 86400.0
   * 其中 ordinal = date.toordinal()，seconds 由 UTC 时钟字段组装。
   * （与 date.getTime()/86400000 + 2440587.5 等价；此处按 Python 的
   *  运算顺序逐项复现，保证儒略日逐位一致——GMST 对儒略日的灵敏度高达
   *  361°/日，1 ULP 的儒略日偏差会放大成 ~1.7e-7° 的 GMST 偏差。） */
  function _julianDayFromT(t) {
    var f = _fieldsFromT(t);
    var ordinal = t.days + ORDINAL_AT_UNIX_EPOCH;
    var seconds = f.hour * 3600.0 + f.minute * 60.0 + f.second + f.microsecond / 1000000.0;
    return JD_EPOCH_ORDINAL_OFFSET + ordinal + seconds / SECONDS_PER_DAY;
  }

  // 对应 _ut_hours_of_day：当日 UT 小时数（[0, 24)）
  function _utHoursFromT(t) {
    var f = _fieldsFromT(t);
    return f.hour + f.minute / 60.0 + f.second / 3600.0 + f.microsecond / 3.6e9;
  }

  /* 对应 solar_position(dt_utc)：Meeus 第 25 章（含章动与光行差修正）。 */
  function _solarPositionFromT(t) {
    var jd = _julianDayFromT(t);
    var tt = (jd - J2000_EPOCH_JD) / DAYS_PER_CENTURY;   // 儒略世纪（solar.py 的 t）

    // --- 太阳几何位置（Meeus 25.2 / 25.8 / 25.9）---
    var meanLong = 280.46646 + 36000.76983 * tt + 0.0003032 * tt * tt;   // 平黄经 L0
    var meanAnom = 357.52911 + 35999.05029 * tt - 0.0001537 * tt * tt;   // 平近点角 M
    // （轨道偏心率与真近点角在中心差三角级数路径中不显式出现，故不计算）
    var center = (1.914602 - 0.004817 * tt - 0.000014 * tt * tt) * _sinDeg(meanAnom)
      + (0.019993 - 0.000101 * tt) * _sinDeg(2.0 * meanAnom)
      + 0.000289 * _sinDeg(3.0 * meanAnom);                               // 中心差 C
    var trueLong = meanLong + center;                                     // 真黄经

    var omega = 125.04 - 1934.136 * tt;                                   // 升交点平黄经 Ω
    // 视黄经：真黄经 + 黄经章动(−0.00478·sinΩ) + 光行差(−0.00569)
    var apparentLong = trueLong - 0.00569 - 0.00478 * _sinDeg(omega);

    // 视赤赤纬（平 obliquity + 交角章动 0.00256·cosΩ）
    var obliq0 = 23.0 + 26.0 / 60.0 + 21.448 / 3600.0
      - (46.8150 * tt + 0.00059 * tt * tt - 0.001813 * tt * tt * tt) / 3600.0;
    var obliq = obliq0 + 0.00256 * _cosDeg(omega);

    var lam = _deg2rad(apparentLong);
    var eps = _deg2rad(obliq);
    var rightAscension = _rad2deg(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)));
    var declination = _rad2deg(Math.asin(Math.sin(eps) * Math.sin(lam)));

    // --- 格林尼治平恒星时（IAU 1982，度）---
    var gmst = _pymod(280.46061837 + 360.98564736629 * (jd - J2000_EPOCH_JD)
      + 0.000387933 * tt * tt - (tt * tt * tt) / 38710000.0, 360.0);

    // --- 直射点经度 = 视赤经 − GMST（[-180, 180)）---
    var subsolarLon = _pymod(rightAscension - gmst + 180.0, 360.0) - 180.0;

    // --- 时差（分钟）：真太阳时 − 平太阳时 ---
    // 格林尼治真太阳时 = 12 + (GMST − α)/15 ；格林尼治平太阳时 = UT
    var utHours = _utHoursFromT(t);
    var eqHours = 12.0 + (gmst - rightAscension) / 15.0 - utHours;
    var eqMin = _pymod(eqHours * 60.0, 1440.0);
    if (eqMin > 720.0) { eqMin -= 1440.0; }

    return {
      declinationDeg: declination,
      subsolarLat: declination,
      subsolarLon: subsolarLon,
      eqOfTimeMin: eqMin,
      gmstDeg: gmst
    };
  }

  // ---------------------------------------------------------------------------
  // 太阳高度角 / 日落时角（对应 solar_elevation / hour_angle_sunset）
  // ---------------------------------------------------------------------------

  /* 对应 solar_elevation(dt_utc, lat_deg, lon_deg)：几何高度角（不含蒙气差）。 */
  function _solarElevationFromT(t, latDeg, lonDeg) {
    var lat = _checkLat(latDeg);
    var lon = _normLon(lonDeg);
    var pos = _solarPositionFromT(t);
    // 当地时角 = GMST + 东经 − 赤经 = 东经 − 直射点经度（与 GMST/α 严格自洽）
    var hourAngle = lon - pos.subsolarLon;
    var sinH = _sinDeg(lat) * _sinDeg(pos.declinationDeg)
      + _cosDeg(lat) * _cosDeg(pos.declinationDeg) * Math.cos(_deg2rad(hourAngle));
    sinH = Math.max(-1.0, Math.min(1.0, sinH));
    return _rad2deg(Math.asin(sinH));
  }

  /* 对应 _cos_hour_angle：返回日落时角余弦与是否为极点。
   * cos(H0) = (sin(−dep) − sinφ·sinδ) / (cosφ·cosδ) */
  function _cosHourAngle(latDeg, declinationDeg, depressionDeg) {
    var sinPhi = _sinDeg(latDeg);
    var cosPhi = _cosDeg(latDeg);
    var sinDec = _sinDeg(declinationDeg);
    var cosDec = _cosDeg(declinationDeg);
    if (Math.abs(cosPhi) < POLE_COS_EPS) {
      return { cosH0: 0.0, isPole: true };
    }
    return {
      cosH0: (Math.sin(_deg2rad(-depressionDeg)) - sinPhi * sinDec) / (cosPhi * cosDec),
      isPole: false
    };
  }

  /* 对应 hour_angle_sunset 主体（纬度已校验、 depression 已取默认值）。
   * |cosH0| > 1（极昼/极夜）或极点 → null。 */
  function _hourAngleSunsetCore(latDeg, declinationDeg, depressionDeg) {
    var r = _cosHourAngle(latDeg, declinationDeg, depressionDeg);
    if (r.isPole) { return null; }
    if (r.cosH0 < -1.0 - ACOS_EPS || r.cosH0 > 1.0 + ACOS_EPS) { return null; }
    return _rad2deg(Math.acos(Math.max(-1.0, Math.min(1.0, r.cosH0))));
  }

  // 对应 _polar_kind_at_pole：极点处高度恒定 = δ·sign(φ)
  function _polarKindAtPole(latDeg, declinationDeg, depressionDeg) {
    var sinH = _sinDeg(latDeg) * _sinDeg(declinationDeg);
    var threshold = -Math.sin(_deg2rad(depressionDeg));
    // 高度恒 > −dep → 无夜 → polar_day；恒 < −dep → 无日 → polar_night
    return sinH >= threshold ? 'polar_day' : 'polar_night';
  }

  // 对应 _polar_kind：按 cosH0 符号判定极昼/极夜（极点按高度恒定值判定）
  function _polarKind(latDeg, declinationDeg) {
    var r = _cosHourAngle(latDeg, declinationDeg, SUNSET_DEPRESSION_DEG);
    if (r.isPole) {
      return _polarKindAtPole(latDeg, declinationDeg, SUNSET_DEPRESSION_DEG);
    }
    return r.cosH0 < -1.0 ? 'polar_day' : 'polar_night';
  }

  // ---------------------------------------------------------------------------
  // 晨昏线（对应 terminator_bands）
  // ---------------------------------------------------------------------------

  function _terminatorBandsFromT(t, latStepDeg) {
    var step = _toNum(latStepDeg, 'lat_step_deg');
    if (!isFinite(step) || step <= 0.0) {
      throw new RangeError('lat_step_deg 必须是正实数，得到 ' + latStepDeg);
    }

    var pos = _solarPositionFromT(t);
    var decl = pos.declinationDeg;
    var subLon = pos.subsolarLon;
    var sinDec = _sinDeg(decl);
    var cosDec = _cosDeg(decl);
    var sinDep = Math.sin(_deg2rad(-SUNSET_DEPRESSION_DEG));   // sin(−0.833°)

    // n_intervals = int(round(180.0 / step))（Python round 半数取偶）
    var nIntervals = _roundHalfEven(180.0 / step);
    if (nIntervals < 1) { nIntervals = 1; }
    var rows = [];
    for (var i = 0; i <= nIntervals; i++) {
      var lat = -90.0 + i * step;
      if (i === nIntervals) { lat = 90.0; }   // 端点吸附，避免浮点误差
      lat = Math.max(-90.0, Math.min(90.0, lat));
      var sinPhi = _sinDeg(lat);
      var cosPhi = _cosDeg(lat);

      if (Math.abs(cosPhi) < POLE_COS_EPS) {
        rows.push({
          lat: lat, nightStartLon: null, nightEndLon: null,
          kind: _polarKindAtPole(lat, decl, SUNSET_DEPRESSION_DEG)
        });
        continue;
      }

      var cosH0 = (sinDep - sinPhi * sinDec) / (cosPhi * cosDec);
      if (cosH0 < -1.0 - ACOS_EPS) {
        // 全天高度 > −0.833°：无夜
        rows.push({ lat: lat, nightStartLon: null, nightEndLon: null, kind: 'polar_day' });
        continue;
      }
      if (cosH0 > 1.0 + ACOS_EPS) {
        // 全天高度 < −0.833°：无日
        rows.push({ lat: lat, nightStartLon: null, nightEndLon: null, kind: 'polar_night' });
        continue;
      }
      var h0 = _rad2deg(Math.acos(Math.max(-1.0, Math.min(1.0, cosH0))));
      // 夜弧：自日落经线（sub+H0）向东到日出经线（sub−H0）
      var nightStart = _normLon360(subLon + h0);
      var nightEnd = _normLon360(subLon - h0);
      rows.push({
        lat: lat, nightStartLon: nightStart, nightEndLon: nightEnd, kind: 'normal'
      });
    }

    return {
      subsolarLat: pos.subsolarLat,
      subsolarLon: subLon,
      declinationDeg: decl,
      latStepDeg: step,
      rows: rows
    };
  }

  // ---------------------------------------------------------------------------
  // 日出日落 / 昼长（对应 _solar_noon_utc / _hour_angle_rate /
  // _time_at_hour_angle / _day_events / day_length_hours / sunrise_sunset）
  // ---------------------------------------------------------------------------

  /* 对应 _solar_noon_utc：求解太阳中心过当地子午线（当地真太阳时 12:00）的
   * UTC 时刻。不动点迭代 ut_h ≡ 12 − lon/15 − E(t)/60 (mod 24)。 */
  function _solarNoonUtcT(localNoon, lonDeg) {
    var t = localNoon;
    for (var i = 0; i < 6; i++) {
      var pos = _solarPositionFromT(t);
      var target = 12.0 - lonDeg / 15.0 - pos.eqOfTimeMin / 60.0;
      var utH = _utHoursFromT(t);
      var delta = _pymod(target - utH + 12.0, 24.0) - 12.0;
      var tNew = _addHours(t, delta);
      if (Math.abs(_diffSeconds(t, tNew)) < 1e-6) { return tNew; }
      t = tNew;
    }
    return t;
  }

  /* 对应 _hour_angle_rate：当地时角相对 UTC 的推进速率（度/小时）。
   * 以 t 为中心取 ±0.5 小时差分；差分结果按模 360 归一（直射点经度在
   * [-180,180) 表示，UT 接近 00:00 时原始差分会跨经线反号）。 */
  function _hourAngleRateT(t) {
    var p = _solarPositionFromT(t);
    var pNext = _solarPositionFromT(_addHours(t, 0.5));
    return _pymod(p.subsolarLon - pNext.subsolarLon, 360.0) / 0.5;
  }

  /* 对应 _time_at_hour_angle：求当地时角（东经 − 直射点经度）等于 haDeg 的
   * UTC 时刻。以实测时角速率做线性化修正，两轮迭代。 */
  function _timeAtHourAngleT(tNoon, lonDeg, haDeg) {
    var t = _addHours(tNoon, haDeg / 15.0);   // 理想 15°/h 的初始估计
    for (var i = 0; i < 2; i++) {
      var p = _solarPositionFromT(t);
      var ha = _pymod(lonDeg - p.subsolarLon + 180.0, 360.0) - 180.0;
      var rate = _hourAngleRateT(t);
      t = _addHours(t, (_pymod(haDeg - ha + 180.0, 360.0) - 180.0) / rate);
    }
    return t;
  }

  /* 对应 _day_events：求解 dtRef 所在太阳日的真太阳正午、日出、日落 UTC 时刻。
   * 返回 {noon, rise, set, polar}；极昼/极夜时 rise=set=null 且 polar 为
   * "polar_day"/"polar_night"，否则 polar 为空串。 */
  function _dayEvents(dtRef, lat, lon) {
    var tNoon = _solarNoonUtcT(dtRef, lon);
    var tRise = tNoon;
    var tSet = tNoon;
    for (var i = 0; i < 4; i++) {
      tNoon = _solarNoonUtcT(tNoon, lon);
      var declRise = _solarPositionFromT(tRise).declinationDeg;
      var declSet = _solarPositionFromT(tSet).declinationDeg;
      var hRise = _hourAngleSunsetCore(lat, declRise, SUNSET_DEPRESSION_DEG);
      var hSet = _hourAngleSunsetCore(lat, declSet, SUNSET_DEPRESSION_DEG);
      if (hRise === null || hSet === null) {
        // 极昼/极夜：按触发判定的赤纬（日出估计时刻处）区分符号
        return {
          noon: tNoon, rise: null, set: null,
          polar: _polarKind(lat, declRise)
        };
      }
      tRise = _timeAtHourAngleT(tNoon, lon, -hRise);
      tSet = _timeAtHourAngleT(tNoon, lon, hSet);
    }
    return { noon: tNoon, rise: tRise, set: tSet, polar: '' };
  }

  // ---------------------------------------------------------------------------
  // 公开接口（window.TimeSolar；契约 §1 冻结签名）
  // ---------------------------------------------------------------------------

  var TimeSolar = {
    /* julian_day(dt_utc)：date 为 JS Date（UTC 瞬间）。
     * 例：2000-01-01 12:00 UTC → 2451545.0。 */
    julianDay: function (date) {
      return _julianDayFromT(_dateToT(date));
    },

    /* solar_position(dt_utc)：赤纬 / 直射点经纬度 / 时差 / GMST。 */
    solarPosition: function (date) {
      return _solarPositionFromT(_dateToT(date));
    },

    /* solar_elevation(dt, lat, lon)：几何高度角（度，不含蒙气差）。 */
    solarElevation: function (date, latDeg, lonDeg) {
      return _solarElevationFromT(_dateToT(date), latDeg, lonDeg);
    },

    /* hour_angle_sunset(lat, decl, depression=0.833)：
     * H0（度，[0,180]）；|cosH0|>1（极昼/极夜）或极点 → null。 */
    hourAngleSunset: function (latDeg, declinationDeg, depressionDeg) {
      var lat = _checkLat(latDeg);
      var dep = (depressionDeg === undefined) ? SUNSET_DEPRESSION_DEG : _toNum(depressionDeg, 'depression_deg');
      var dec = _toNum(declinationDeg, 'declination_deg');
      if (!isFinite(dec) || !isFinite(dep)) {
        throw new RangeError('declination_deg / depression_deg 必须是有限实数');
      }
      return _hourAngleSunsetCore(lat, dec, dep);
    },

    /* terminator_bands(dt, lat_step=0.5)：按纬度分层的夜弧区间。
     * rows 共 round(180/step)+1 行，lat 从 -90 到 +90（含端点）；
     * nightStartLon/nightEndLon 在极昼/极夜行为 null。 */
    terminatorBands: function (date, latStepDeg) {
      var step = (latStepDeg === undefined) ? 0.5 : latStepDeg;
      return _terminatorBandsFromT(_dateToT(date), step);
    },

    /* day_length_hours(dt, lat, lon)：昼长（小时）；极昼 24.0、极夜 0.0。 */
    dayLengthHours: function (date, latDeg, lonDeg) {
      var t = _dateToT(date);
      var lat = _checkLat(latDeg);
      var lon = _normLon(lonDeg);
      var ev = _dayEvents(t, lat, lon);
      if (ev.rise === null || ev.set === null) {
        return ev.polar === 'polar_day' ? 24.0 : 0.0;
      }
      return _diffHours(ev.rise, ev.set);
    },

    /* sunrise_sunset(dt, lat, lon, tz_name) 的"当地 HH:MM 展示"：
     * 以 date 在 tzName 时区的当地日期为基准日，返回
     * {sunrise, sunset, dayLengthHours}；极昼/极夜对应 null。
     * 处理 UTC/当地日期错位、跨日界线时区（UTC+14/-11）与事件时刻处的
     * 赤纬迭代修正（与 Python 共用 _day_events 迭代结构）。 */
    sunriseSunsetLocal: function (date, latDeg, lonDeg, tzName) {
      var t = _dateToT(date);
      var lat = _checkLat(latDeg);
      var lon = _normLon(lonDeg);
      _checkTz(tzName);
      // 当地日期（对应 dt.astimezone(tz).date()）
      var wall = _tzWallFields(_tToMs(t), tzName);
      // 日期锚点：当地钟表正午对应的 UTC 时刻
      var localNoon = _localNoonT(wall.year, wall.month, wall.day, tzName);
      var ev = _dayEvents(localNoon, lat, lon);
      if (ev.rise === null || ev.set === null) {
        return { sunrise: null, sunset: null, dayLengthHours: null };
      }
      return {
        sunrise: _fmtHM(ev.rise, tzName),
        sunset: _fmtHM(ev.set, tzName),
        dayLengthHours: _diffHours(ev.rise, ev.set)
      };
    }
  };

  // IIFE 挂 window（浏览器 / GitHub Pages 静态部署）
  if (typeof window !== 'undefined') {
    window.TimeSolar = TimeSolar;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.TimeSolar = TimeSolar;
  } else if (typeof global !== 'undefined') {
    global.TimeSolar = TimeSolar;
  }
})();
