/* ============================================================================
 * solar-engine.js — "无世界时钟" 静态部署版天文引擎（window.TimeSolar）
 *
 * 本文件是 app/solar.py（Meeus《Astronomical Algorithms》第 25 章太阳视位置）
 * 的逐函数忠实移植，供 GitHub Pages 纯静态部署（无 Python 服务端）使用。
 * 数值目标：与 Python 实现同算法、同 IEEE754 双精度、同运算顺序，
 * 期望一致到 ~1e-9（时间字符串精确一致）。
 *
 * 函数对应关系（每个函数注释标明 solar.py 来源）：
 *   julianDay            ← julian_day
 *   solarPosition        ← solar_position
 *   solarElevation       ← solar_elevation
 *   terminatorCurves     ← terminator_curves   （按经度列求解，契约 §1.1）
 *   hourAngleSunset      ← hour_angle_sunset
 *   dayLengthHours       ← day_length_hours
 *   sunriseSunsetLocal   ← sunrise_sunset      （返回当地时区 Date 对象）
 *
 * 内部私有函数与 solar.py 私有函数一一对应：
 *   _normLon ← _norm_lon（含 −180 → 180 端点映射）
 *   _checkLat ← _check_lat        _checkTz ← _zone
 *   _deg2rad/_rad2deg/_sinDeg/_cosDeg ← _deg2rad/_rad2deg/_sin_deg/_cos_deg
 *   _wrap180 ← _wrap180           _inLatRange ← _in_lat_range
 *   _clampLat ← _clamp_lat        _utHoursFromT ← _ut_hours_of_day
 *   _columnLat0 ← _column_lat0    _columnLat6 ← _column_lat6
 *   _cosHourAngle ← _cos_hour_angle
 *   _polarKind ← _polar_kind      _polarKindAtPole ← _polar_kind_at_pole
 *   _solarNoonUtcT ← _solar_noon_utc
 *   _hourAngleRateT ← _hour_angle_rate
 *   _timeAtHourAngleT ← _time_at_hour_angle
 *   _dayEvents ← _day_events
 *
 * 与 Python 行为差异的处理（移植关键点 / 语义桥接点）：
 * 1. 时间表示：内部用 {days, us}（自 Unix 纪元起的整数天 + 当日整数微秒）
 *    表示 UTC 瞬间，等价于 Python datetime 的 (date.toordinal(), microsecond)
 *    字段；全程整数运算，避免浮点毫秒在 ±80 个儒略世纪范围内的精度损失。
 *    `t + timedelta(hours=h)` 的"量化到微秒、半数取偶"语义在 _addHours 中
 *    等价复现（CPython 3.12+ 对 timedelta 用精确有理运算后按半数取偶舍入）。
 * 2. Python 的 `%` 取膜恒非负（fmod 后按符号修正），JS 的 `%` 是截断余数，
 *    所有取模经 _pymod 复现。受影响点：
 *      - subsolar_lon 的归一化 _norm_lon（必须落回 [-180, 180]）；
 *      - gmst 的 `% 360.0`、eq_of_time 的 `% 1440.0`；
 *      - 晨昏线 wrap(a) = ((a+180) mod 360) − 180（每个候选只 wrap 一次，
 *        严禁 ±180 归一切换——那会翻转 A·sinφ + B·cosφ = sin d 的符号，
 *        得到 +6° 等值线而不是 −6° 晨昏蒙影线，旧版视觉相似但语义错误的坑）；
 *      - _solar_noon_utc 的 `((target − ut_h + 12) mod 24) − 12`；
 *      - _hour_angle_rate 的差分 `% 360.0`（直射点经度在 [-180,180] 表示，
 *        UT 接近 00:00 时原始差分会跨经线反号，必须归一）；
 *      - _time_at_hour_angle 的时角残差归一。
 * 3. Python round() 半数取偶，JS Math.round 半数取正 —— 用 _roundHalfEven
 *    复现；terminator_curves 的 n = int(round(360/lon_step)) 依赖此语义。
 * 4. JS 只有 Date 瞬间：naive/aware 的区分在接口上消失（入参统一为 UTC 瞬间
 *    的 Date，等价于 Python 的 naive-as-UTC / aware→UTC）。时区换算用
 *    Intl.DateTimeFormat('en-CA', {...}).formatToParts 取当地墙上时钟字段；
 *    时区偏移 = 当地墙上时间 − UTC 墙上时间（tzdb 偏移均为整秒，故精确）。
 *    当地正午的 UTC 瞬间用不动点迭代 T = wallNoon − offset(T) 求得
 *    （等价于 datetime(...,tzinfo=tz).astimezone(utc)）。
 * 5. 异常映射：Python ValueError → JS RangeError；Python TypeError（入参不是
 *    datetime/Date）→ JS TypeError；Python OverflowError（事件时刻超出
 *    datetime 可表示范围，即 0001-01-01 ~ 9999-12-31 之外）→ JS RangeError。
 *    curve0 无解对应 Python 的 AssertionError（数学上不可达）。
 *
 * 与旧版（v1，纬度行扫描夜弧）的区别：本版的 terminatorCurves 严格按
 * app/solar.py 的按经度列算法（_column_lat0 / _column_lat6）求解，
 * 输出 curve0（elev=0°）/ curve6（elev=−twilight°）两条 [lon,lat] 折线；
 * curve6 可为 null（该经度列整列昼/蒙影、无真夜，分点附近出现）。
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
  // JD_EPOCH_ORDINAL_OFFSET：date.toordinal() + 本常量 = 当日 0h 儒略日
  var JD_EPOCH_ORDINAL_OFFSET = 1721424.5;
  // POLE_COS_EPS：判定"极点"的 |cos(lat)| 阈值
  var POLE_COS_EPS = 1e-12;
  // ACOS_EPS：acos 参数越界 [-1,1] 的数值容差
  var ACOS_EPS = 1e-12;
  // LAT_RANGE_EPS：晨昏线候选纬度落入 [-90,90] 的边界容差（度）
  var LAT_RANGE_EPS = 1e-9;
  // SECONDS_PER_DAY
  var SECONDS_PER_DAY = 86400.0;

  // 1970-01-01 00:00 UTC 的 date.toordinal()；Python datetime.min/max 的序号
  var ORDINAL_AT_UNIX_EPOCH = 719163;
  var ORDINAL_MIN = 1;        // 0001-01-01
  var ORDINAL_MAX = 3652059;  // 9999-12-31

  // 时间单位（内部 {days, us} 表示法；us 为当日微秒，[0, 86400e6)）
  var US_PER_MS = 1000;         // 1 毫秒 = 1000 微秒（ms→us 换算，勿用 US_PER_SECOND）
  var MS_PER_SECOND = 1000;
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
   * JS Math.round 半数取正，且 terminator_curves 的列数依赖此语义。 */
  function _roundHalfEven(x) {
    var f = Math.floor(x);
    var d = x - f;
    if (d > 0.5) { return f + 1; }
    if (d < 0.5) { return f; }
    return (f % 2 === 0) ? f : f + 1;
  }

  /* 对应 Python 的 float()：数值直接返回；布尔按 Number(v) 换算（Python 的
   * float(True)=1.0、float(False)=0.0，布尔实参在 Python 侧合法）；字符串按
   * Python float(str) 语义转换。
   * solar.py 中所有 float() 失败路径（_check_lat/_norm_lon/terminator_curves
   * 的实参校验）都收敛为 ValueError，故这里统一抛 RangeError（见文件头 5）。 */
  function _toNum(v, name) {
    var t = typeof v;
    if (t === 'number' || t === 'boolean') { return Number(v); }
    if (t === 'string') {
      var n = Number(v);
      if (!isNaN(n)) { return n; }
      throw new RangeError(name + ' 必须是实数，得到 ' + v);
    }
    throw new RangeError(name + ' 必须是实数，得到 ' + t);
  }

  // _check_lat：纬度必须是 [-90, 90] 内的有限实数（Python ValueError）
  function _checkLat(latDeg) {
    var lat = _toNum(latDeg, '纬度');
    if (!isFinite(lat) || lat < -90.0 || lat > 90.0) {
      throw new RangeError('纬度超出 [-90, 90] 范围: ' + latDeg);
    }
    return lat;
  }

  /* _norm_lon：经度归一化到 [-180, 180]。
   * 忠实复现 Python：((lon + 180.0) % 360.0) - 180.0，且结果恰为 −180.0 时
   * 映射为 180.0（Python 的端点归一处，subsolar_lon 归一化依赖此语义）。 */
  function _normLon(lonDeg) {
    var lon = _toNum(lonDeg, '经度');
    if (!isFinite(lon)) {
      throw new RangeError('经度必须是有限实数，得到 ' + lonDeg);
    }
    lon = _pymod(lon + 180.0, 360.0) - 180.0;
    return lon === -180.0 ? 180.0 : lon;
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

  // ---------------------------------------------------------------------------
  // 核心：儒略日与太阳位置（对应 julian_day / solar_position）
  // ---------------------------------------------------------------------------

  /* 对应 julian_day(dt_utc)：
   *   JD_EPOCH_ORDINAL_OFFSET + ordinal + seconds / 86400.0
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

  /* 对应 solar_position(dt_utc)：Meeus 第 25 章（含章动与光行差修正）。
   * 返回 {declinationDeg, subsolarLonDeg, eqOfTimeMin, gmstDeg}（对应
   * SolarPosition 的四个字段）。 */
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

    // --- 格林尼治平恒星时（IAU 1982，度）：Python 的 `% 360.0`（恒非负）---
    var gmst = _pymod(280.46061837 + 360.98564736629 * (jd - J2000_EPOCH_JD)
      + 0.000387933 * tt * tt - (tt * tt * tt) / 38710000.0, 360.0);

    // --- 直射点经度 = _norm_lon(视赤经 − GMST)：[-180, 180]，−180 映射为 180 ---
    var subsolarLon = _pymod(rightAscension - gmst + 180.0, 360.0) - 180.0;
    if (subsolarLon === -180.0) { subsolarLon = 180.0; }

    // --- 时差（分钟）：真太阳时 − 平太阳时 ---
    // 格林尼治真太阳时 = 12 + (GMST − α)/15 ；格林尼治平太阳时 = UT
    var utHours = _utHoursFromT(t);
    var eqHours = 12.0 + (gmst - rightAscension) / 15.0 - utHours;
    var eqMin = _pymod(eqHours * 60.0, 1440.0);   // Python 的 `% 1440.0`
    if (eqMin > 720.0) { eqMin -= 1440.0; }

    return {
      declinationDeg: declination,
      subsolarLonDeg: subsolarLon,
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
    // 当地时角 = 东经 − 直射点经度（与 GMST/α 严格自洽）
    var hourAngle = lon - pos.subsolarLonDeg;
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

  /* 对应 hour_angle_sunset 主体（纬度已校验、depression 已取默认值）。
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
  // 晨昏线（按经度列求解，对应 terminator_curves / _column_lat0 / _column_lat6，
  // 契约 §1.1）
  // ---------------------------------------------------------------------------

  /* 对应 _wrap180：wrap(a) = ((a+180) mod 360) − 180，结果 ∈ [−180, 180)。
   * 对整个候选角度只做一次 wrap；不得再对结果做 ±180 归一切换
   * （那会翻转 A·sinφ + B·cosφ = sin d 的符号）。 */
  function _wrap180(a) { return _pymod(a + 180.0, 360.0) - 180.0; }

  // 对应 _in_lat_range：候选纬度是否落在 [-90, 90]（含边界容差）
  function _inLatRange(phi) {
    return -90.0 - LAT_RANGE_EPS <= phi && phi <= 90.0 + LAT_RANGE_EPS;
  }

  // 对应 _clamp_lat：把纬度吸附到 [-90, 90]（仅边界容差内的数值会被改动）
  function _clampLat(phi) {
    if (phi < -90.0) { return -90.0; }
    if (phi > 90.0) { return 90.0; }
    return phi;
  }

  /* 对应 _column_lat0：解 A·sinφ + B·cosφ = 0。
   * 候选 wrap(−θ)、wrap(180−θ)，保留 [−90,90] 的。恰有一个在区间内（一般情况）；
   * 仅当 δ=0（分点瞬间，测度零）两个都在（±90），此时取 wrap(−θ)
   * （day 列得 −90、night 列得 +90，语义正确）。 */
  function _columnLat0(thetaDeg) {
    var cand1 = _wrap180(-thetaDeg);
    var cand2 = _wrap180(180.0 - thetaDeg);
    // δ=0 退化时两个候选都在区间内（±90）——取 wrap(−θ) 的 cand1 即满足契约
    // 语义（day 列得 −90、night 列得 +90），无需对 has1&has2 特判。
    if (_inLatRange(cand1)) { return _clampLat(cand1); }
    if (_inLatRange(cand2)) { return _clampLat(cand2); }
    // 数学上不可达：两个解相差 180°，闭半圆 [-90,90] 必含其一。
    throw new Error('curve0 无解（不应发生，对应 Python AssertionError）');
  }

  /* 对应 _column_lat6：解 A·sinφ + B·cosφ = sin d（d=−twilight），返回 lat6 或 null。
   * 候选 φ1 = wrap(asin(sin d/R) − θ)、φ2 = wrap(180 − asin(sin d/R) − θ)；
   * 每个候选只 wrap 一次（禁止 ±180 归一切换——会翻转等式符号）。
   * |sin d| > R → null（该列最低高度 −asin(R) > −twilight，整列昼/蒙影）；
   * 0 个候选落区间 → null；≥1 个 → 取夜半球侧且最靠近 lat0 的。 */
  function _columnLat6(thetaDeg, rValue, sinD, lat0, nightNorth) {
    if (Math.abs(sinD) > rValue) {
      return null;  // 整列昼/蒙影，无真夜
    }
    var ratio = Math.max(-1.0, Math.min(1.0, sinD / rValue));
    var alpha = _rad2deg(Math.asin(ratio));
    var cand1 = _wrap180(alpha - thetaDeg);
    var cand2 = _wrap180(180.0 - alpha - thetaDeg);
    var cands = [];
    if (_inLatRange(cand1)) { cands.push(cand1); }
    if (_inLatRange(cand2)) { cands.push(cand2); }
    if (cands.length === 0) { return null; }
    // 夜半球侧：night_north 时 φ > lat0，否则 φ < lat0
    var nightSide = [];
    for (var i = 0; i < cands.length; i++) {
      if (nightNorth ? cands[i] > lat0 : cands[i] < lat0) { nightSide.push(cands[i]); }
    }
    var pool = nightSide.length > 0 ? nightSide : cands;
    // 对应 Python min(pool, key=lambda c: abs(c - lat0))：并列取第一个
    var best = pool[0];
    var bestD = Math.abs(pool[0] - lat0);
    for (var j = 1; j < pool.length; j++) {
      var d = Math.abs(pool[j] - lat0);
      if (d < bestD) { best = pool[j]; bestD = d; }
    }
    return _clampLat(best);
  }

  /* 对应 terminator_curves(dt_utc, lon_step_deg=1.0, twilight_deg=6.0)：
   * 按经度列逐列求解 curve0（elev=0°）与 curve6（elev=−twilight°）。
   * 返回 {subsolarLatDeg, subsolarLonDeg, declinationDeg, nightNorth,
   *       lonStepDeg, curve0: [[lon,lat0]...], curve6: [[lon,lat6|null]...]}。 */
  function _terminatorCurvesFromT(t, lonStepDeg, twilightDeg) {
    var step = _toNum(lonStepDeg, 'lon_step_deg');
    var twilight = _toNum(twilightDeg, 'twilight_deg');
    if (!isFinite(step) || step <= 0.0) {
      throw new RangeError('lon_step_deg 必须是正实数，得到 ' + lonStepDeg);
    }
    if (!isFinite(twilight) || twilight < 0.0) {
      throw new RangeError('twilight_deg 必须是非负实数，得到 ' + twilightDeg);
    }

    var pos = _solarPositionFromT(t);
    var decl = pos.declinationDeg;
    var subLon = pos.subsolarLonDeg;
    // 夜半球侧：δ < 0 → 夜在北侧（lat > lat0）；δ ≥ 0 → 夜在南侧（lat < lat0）
    var nightNorth = decl < 0.0;
    var sinDec = _sinDeg(decl);
    var cosDec = _cosDeg(decl);
    var sinD = Math.sin(_deg2rad(-twilight));  // sin(−twilight°)

    // n = max(int(round(360.0 / step)), 1)（Python round 半数取偶）
    var n = Math.max(_roundHalfEven(360.0 / step), 1);
    var curve0 = [];
    var curve6 = [];
    for (var i = 0; i <= n; i++) {
      var lon = -180.0 + i * step;
      if (i === n) { lon = 180.0; }   // 端点吸附，避免浮点累积误差
      // i < n 时 i·step ≤ 360 − step/2（n = round(360/step)，实数域），
      // 故 lon ∈ [−180, 180) 恒成立，无需额外 clamp（端点吸附已覆盖 i = n）。

      // 该经度列的方程 A·sinφ + B·cosφ = sin d（H = lon − subsolar_lon）
      var hourAngle = lon - subLon;
      var aValue = sinDec;
      var bValue = cosDec * Math.cos(_deg2rad(hourAngle));
      var rValue = Math.hypot(aValue, bValue);
      var thetaDeg = _rad2deg(Math.atan2(bValue, aValue));

      var lat0 = _columnLat0(thetaDeg);
      var lat6 = _columnLat6(thetaDeg, rValue, sinD, lat0, nightNorth);
      curve0.push([lon, lat0]);
      curve6.push([lon, lat6]);
    }

    return {
      subsolarLatDeg: decl,
      subsolarLonDeg: subLon,
      declinationDeg: decl,
      nightNorth: nightNorth,
      lonStepDeg: step,
      curve0: curve0,
      curve6: curve6
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
   * [-180,180) 表示，UT 接近 00:00 时原始差分会跨经线反号）。
   * pos 可传入调用方已算得的 _solarPositionFromT(t)（纯函数，值相同），
   * 避免 _timeAtHourAngleT 内重复计算一次；缺省时本函数自行计算。 */
  function _hourAngleRateT(t, pos) {
    if (pos === undefined) { pos = _solarPositionFromT(t); }
    var pNext = _solarPositionFromT(_addHours(t, 0.5));
    return _pymod(pos.subsolarLonDeg - pNext.subsolarLonDeg, 360.0) / 0.5;
  }

  /* 对应 _time_at_hour_angle：求当地时角（东经 − 直射点经度）等于 haDeg 的
   * UTC 时刻。以实测时角速率做线性化修正，两轮迭代。 */
  function _timeAtHourAngleT(tNoon, lonDeg, haDeg) {
    var t = _addHours(tNoon, haDeg / 15.0);   // 理想 15°/h 的初始估计
    for (var i = 0; i < 2; i++) {
      var p = _solarPositionFromT(t);
      var ha = _pymod(lonDeg - p.subsolarLonDeg + 180.0, 360.0) - 180.0;
      var rate = _hourAngleRateT(t, p);   // 复用已算出的 p，省一次位置计算
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
  // 公开接口（window.TimeSolar；契约 §1.2 冻结签名）
  // ---------------------------------------------------------------------------

  var TimeSolar = {
    /* julian_day(dt_utc)：date 为 JS Date（UTC 瞬间）。
     * 例：2000-01-01 12:00 UTC → 2451545.0。 */
    julianDay: function (date) {
      return _julianDayFromT(_dateToT(date));
    },

    /* solar_position(dt_utc)：赤纬 / 直射点经度 / 时差 / GMST。
     * 返回 {declinationDeg, subsolarLonDeg, eqOfTimeMin, gmstDeg}。 */
    solarPosition: function (date) {
      return _solarPositionFromT(_dateToT(date));
    },

    /* solar_elevation(dt, lat, lon)：几何高度角（度，不含蒙气差）。 */
    solarElevation: function (date, latDeg, lonDeg) {
      return _solarElevationFromT(_dateToT(date), latDeg, lonDeg);
    },

    /* terminator_curves(dt, lon_step_deg=1.0, twilight_deg=6.0)：
     * 按经度列求解的晨昏线。curve0/curve6 各 round(360/lon_step)+1 项，
     * lon_i = −180 + i·lon_step（含两端）；curve6 项为 [lon, lat6|null]
     * （null = 该列整列昼/蒙影、无真夜，前端必须按 null 语义处理）。 */
    terminatorCurves: function (date, lonStepDeg, twilightDeg) {
      var step = (lonStepDeg === undefined) ? 1.0 : lonStepDeg;
      var twi = (twilightDeg === undefined) ? 6.0 : twilightDeg;
      return _terminatorCurvesFromT(_dateToT(date), step, twi);
    },

    /* hour_angle_sunset(lat, decl, depression=0.833)：
     * H0（度，[0,180]）；|cosH0|>1（极昼/极夜）或极点 → null。 */
    hourAngleSunset: function (latDeg, declinationDeg, depressionDeg) {
      var lat = _checkLat(latDeg);
      var dep = (depressionDeg === undefined) ? SUNSET_DEPRESSION_DEG
        : _toNum(depressionDeg, 'depression_deg');
      var dec = _toNum(declinationDeg, 'declination_deg');
      if (!isFinite(dec) || !isFinite(dep)) {
        throw new RangeError('declination_deg / depression_deg 必须是有限实数');
      }
      return _hourAngleSunsetCore(lat, dec, dep);
    },

    /* day_length_hours(dt, lat, lon)：昼长（小时）；极昼 24.0、极夜 0.0。
     * 以查询时刻所在的太阳日为基准（不动点迭代收敛到距它最近的太阳正午）。 */
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

    /* sunrise_sunset(dt, lat, lon, tz_name)：以 date 在 tzName 时区的当地
     * 日期为基准日，返回 {sunrise, sunset}（当地时区的 Date 对象，即
     * Python 中 t.astimezone(tz) 的同一瞬间；展示层自行格式化）。
     * 极昼/极夜对应 null。正确处理 UTC 日期与当地日期不一致、跨日界线 /
     * 跨子午线的情况，以及事件时刻处的赤纬迭代修正。 */
    sunriseSunsetLocal: function (date, latDeg, lonDeg, tzName) {
      var t = _dateToT(date);
      var lat = _checkLat(latDeg);
      var lon = _normLon(lonDeg);
      _checkTz(tzName);
      // 当地日期（对应 dt.astimezone(tz).date()）
      var wall = _tzWallFields(_tToMs(t), tzName);
      // 日期锚点：当地钟表正午对应的 UTC 时刻（与真太阳正午相差不超过数小时）
      var localNoon = _localNoonT(wall.year, wall.month, wall.day, tzName);
      var ev = _dayEvents(localNoon, lat, lon);
      if (ev.rise === null || ev.set === null) {
        return { sunrise: null, sunset: null };
      }
      return {
        sunrise: new Date(_tToMs(ev.rise)),
        sunset: new Date(_tToMs(ev.set))
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
