/* map.js — 世界地图 / 晨昏线渲染（window.MapView，契约 §7.2 / §7.4）
 *
 * init(canvas)   拉取陆地数据一次并缓存，构建离屏底图（黑底 + 经纬网格 + 深灰陆地）
 * render(state)  每秒调用：底图一次绘制 + 夜侧叠层 + 白色晨昏线 + 太阳直射点 + 城市点
 * focusCity(lat, lon)  高亮某城市数秒
 *
 * 投影：等距圆柱 x=(lon+180)/360*W, y=(90-lat)/180*H；devicePixelRatio 适配。
 * terminator.rows: [[lat, start, end, kind_code], ...]，361 行；
 *   kind_code 0=normal（自 start 向东到 end 为夜，可跨界），1=polar_day，2=polar_night。
 *
 * 语法约束：ES2017 子集。
 */
(function () {
  'use strict';

  var LAND_URL = '/data/world_land.json';
  var LAND_FILL = '#3a3a3c';
  var NIGHT_FILL = 'rgba(0, 0, 0, 0.45)';
  var FONT_STACK = '-apple-system,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif';
  var HIGHLIGHT_MS = 6000;

  var canvas = null;
  var ctx = null;
  var W = 0, H = 0, dpr = 1;
  var base = null;          // 离屏底图（黑底 + 网格 + 陆地），尺寸变化时重建
  var landPolygons = null;  // 陆地多边形环（拉取一次后缓存）
  var landTried = false;
  var lastState = null;
  var highlight = null;     // {lat, lon, name, until}

  /* ---------- 投影 ---------- */
  function xOf(lon) { return ((lon + 180) / 360) * W; }   // lon ∈ [-180,180]
  /* [0,360) 经度先归一到 [-180,180) 再走 xOf：画布 x=0 对应 180°W，
   * 直接 lon/360*W 会把夜叠层/晨昏线整体平移 180°（昼暮画反）。 */
  function xOf360(lon) {
    var l = ((lon % 360) + 360) % 360;
    if (l >= 180) l -= 360;
    return xOf(l);
  }
  function yOf(lat) { return ((90 - lat) / 180) * H; }

  /* ---------- 尺寸与底图 ---------- */
  function ensureSize() {
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    var ratio = window.devicePixelRatio || 1;
    if (cw < 10 || ch < 10) return false;      // 隐藏/未布局：保留上次尺寸
    if (cw === W && ch === H && ratio === dpr && base) return true;
    W = cw; H = ch; dpr = ratio;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildBase();
    return true;
  }

  function buildBase() {
    if (!base) base = document.createElement('canvas');
    base.width = Math.round(W * dpr);
    base.height = Math.round(H * dpr);
    var g = base.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#000000';
    g.fillRect(0, 0, W, H);
    drawGrid(g);
    drawLand(g);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  function drawGrid(g) {
    var lon, lat, x, y;
    g.lineWidth = 1;
    // 每 10° 弱线
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.beginPath();
    for (lon = -180; lon <= 180; lon += 10) {
      if (lon % 30 === 0) continue;
      x = Math.round(xOf(lon)) + 0.5;
      g.moveTo(x, 0); g.lineTo(x, H);
    }
    for (lat = -80; lat <= 80; lat += 10) {
      if (lat % 30 === 0) continue;
      y = Math.round(yOf(lat)) + 0.5;
      g.moveTo(0, y); g.lineTo(W, y);
    }
    g.stroke();
    // 每 30° 主线
    g.strokeStyle = 'rgba(255,255,255,0.13)';
    g.beginPath();
    for (lon = -180; lon <= 180; lon += 30) {
      x = Math.round(xOf(lon)) + 0.5;
      g.moveTo(x, 0); g.lineTo(x, H);
    }
    for (lat = -60; lat <= 60; lat += 30) {
      y = Math.round(yOf(lat)) + 0.5;
      g.moveTo(0, y); g.lineTo(W, y);
    }
    g.stroke();
  }

  /* 陆地绘制（契约 §8 数据约定：环首=尾，点间为经纬度平面直线；
   * 跨 180° 的相邻点（如南极洲底边 180,-90 → -180,-90）其直线本就落在地图
   * 上下边缘，画出来不可见，因此不做经度展开/平移，原样绘制即可）。
   * 全部环放进同一路径用 evenodd 填充 → 环中环（内陆水体）正确成洞。 */
  function drawLand(g) {
    if (!landPolygons || !landPolygons.length) return;
    g.fillStyle = LAND_FILL;
    g.beginPath();
    for (var i = 0; i < landPolygons.length; i++) traceRing(g, landPolygons[i]);
    g.fill('evenodd');
  }

  function traceRing(g, ring) {
    if (!ring || ring.length < 3) return;
    var started = false;
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (!p || p.length < 2) continue;
      var lon = p[0];
      var lat = p[1];
      if (typeof lon !== 'number' || typeof lat !== 'number' || isNaN(lon) || isNaN(lat)) continue;
      var x = xOf(lon);
      var y = yOf(lat);
      if (!started) { g.moveTo(x, y); started = true; }
      else g.lineTo(x, y);
    }
    if (started) g.closePath();
  }

  function loadLand() {
    if (landTried) return;
    landTried = true;
    fetch(LAND_URL).then(function (resp) {
      if (!resp.ok) throw new Error('land http ' + resp.status);
      return resp.json();
    }).then(function (data) {
      landPolygons = (data && data.polygons) || [];
      if (base) buildBase();
      render(lastState);
    }).catch(function () {
      landPolygons = null;   // 降级：只有经纬网格，功能不受影响
      if (base) buildBase();
      render(lastState);
    });
  }

  /* ---------- 夜侧叠层 ---------- */
  function drawNight(g, st) {
    var term = st.terminator;
    if (!term || !term.rows || !term.rows.length) return;
    var rows = term.rows;
    var step = typeof term.lat_step === 'number' && term.lat_step > 0 ? term.lat_step : 0.5;
    var bandH = Math.max(0.6, (step / 180) * H);
    g.fillStyle = NIGHT_FILL;
    g.beginPath();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || r.length < 4) continue;
      var lat = r[0];
      var s = r[1];
      var e = r[2];
      var kind = r[3];
      if (typeof lat !== 'number') continue;
      var yTop = yOf(lat + step / 2);
      if (kind === 2) { g.rect(0, yTop, W, bandH); continue; }   // 极夜：整行夜
      if (kind === 1) continue;                                   // 极昼：整行日
      if (typeof s !== 'number' || typeof e !== 'number') continue;
      if (Math.abs(s - e) < 0.01) continue;                       // 夜弧退化为零
      var xs = xOf360(s);
      var xe = xOf360(e);
      /* 跨界判定必须在画布坐标空间做：夜弧跨 180° 经线时（如 63°E→124°W），
       * [0,360) 下 s<e 但归一化后 xs>xe，若按 s<=e 走单矩形分支会算出负宽度。 */
      if (xs <= xe) {
        g.rect(xs, yTop, Math.max(0.5, xe - xs), bandH);
      } else {                                                    // 跨 180°
        g.rect(xs, yTop, Math.max(0.5, W - xs), bandH);
        g.rect(0, yTop, Math.max(0.5, xe), bandH);
      }
    }
    g.fill();
  }

  /* ---------- 晨昏线白曲线（夜弧两端边界折线） ---------- */
  function drawTerminator(g, st) {
    var term = st.terminator;
    if (!term || !term.rows || !term.rows.length) return;
    strokeBoundary(g, term.rows, 1);
    strokeBoundary(g, term.rows, 2);
  }

  function strokeBoundary(g, rows, which) {
    var started = false;
    var prevX = 0;
    g.beginPath();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || r.length < 4 || r[3] !== 0 || typeof r[1] !== 'number' || typeof r[2] !== 'number') {
        started = false;                     // 极昼/极夜行无边界，断开折线
        continue;
      }
      var lon = which === 1 ? r[1] : r[2];
      var x = xOf360(lon);
      var y = yOf(r[0]);
      if (!started || Math.abs(x - prevX) > W * 0.5) g.moveTo(x, y);  // 跨界断开
      else g.lineTo(x, y);
      started = true;
      prevX = x;
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 7;
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.lineWidth = 3;
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 1.75;
    g.stroke();
  }

  /* ---------- 太阳直射点 ---------- */
  function drawSun(g, st) {
    var sol = st.solar;
    if (!sol) return;
    var lat = sol.subsolar_lat;
    var lon = sol.subsolar_lon;
    if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) return;
    var x = xOf(lon);
    var y = yOf(lat);
    var r = Math.max(16, Math.min(W, H) * 0.055);
    var grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255, 216, 96, 0.55)');
    grad.addColorStop(0.4, 'rgba(255, 176, 64, 0.20)');
    grad.addColorStop(1, 'rgba(255, 160, 48, 0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffd60a';
    g.beginPath();
    g.arc(x, y, Math.max(2.5, r * 0.15), 0, Math.PI * 2);
    g.fill();
  }

  /* ---------- 城市点 / 当前定位 ---------- */
  function drawCities(g, st) {
    var loc = st.location;
    var hasLoc = loc && typeof loc.lat === 'number' && typeof loc.lon === 'number';
    var cities = st.cities || [];
    var i, c, x, y;
    for (i = 0; i < cities.length; i++) {
      c = cities[i];
      if (!c || typeof c.lat !== 'number' || typeof c.lon !== 'number') continue;
      if (hasLoc && Math.abs(c.lat - loc.lat) < 0.05 && Math.abs(c.lon - loc.lon) < 0.05) continue;
      x = xOf(c.lon);
      y = yOf(c.lat);
      g.fillStyle = c.is_day ? 'rgba(255,255,255,0.92)' : 'rgba(140,140,150,0.8)';
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.fill();
    }
    if (!hasLoc) return;
    x = xOf(loc.lon);
    y = yOf(loc.lat);
    /* 脉冲：重绘为 1Hz，动画环按秒对齐做“节拍”显示（偶数秒亮起），
     * 避免相位随机跳动造成的视觉抖动。 */
    if (Math.floor(Date.now() / 1000) % 2 === 0) {
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(255, 159, 10, 0.30)';
      g.beginPath();
      g.arc(x, y, 11, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = 'rgba(255, 159, 10, 0.12)';
      g.beginPath();
      g.arc(x, y, 16, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#ff9f0a';
    g.beginPath();
    g.arc(x, y, 4.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.arc(x, y, 1.8, 0, Math.PI * 2);
    g.fill();
    if (loc.name_zh) {
      g.font = '11px ' + FONT_STACK;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(loc.name_zh, x + 9, y);
    }
  }

  /* ---------- focusCity 高亮 ---------- */
  function drawHighlight(g) {
    if (!highlight) return;
    if (Date.now() > highlight.until) { highlight = null; return; }
    var x = xOf(highlight.lon);
    var y = yOf(highlight.lat);
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(255,159,10,0.9)';
    g.beginPath();
    g.arc(x, y, 8, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(255,159,10,0.35)';
    g.beginPath();
    g.arc(x, y, 13, 0, Math.PI * 2);
    g.stroke();
    if (highlight.name) {
      g.font = '11px ' + FONT_STACK;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255,159,10,0.95)';
      g.fillText(highlight.name, x + 16, y);
    }
  }

  /* ---------- 对外接口 ---------- */
  function render(state) {
    if (state) lastState = state;
    if (!canvas || !ctx) return;
    if (!ensureSize()) return;
    var g = ctx;
    g.clearRect(0, 0, W, H);
    if (base) g.drawImage(base, 0, 0, W, H);
    var st = lastState;
    if (st) {
      drawNight(g, st);
      drawTerminator(g, st);
      drawSun(g, st);
      drawCities(g, st);
    }
    drawHighlight(g);
  }

  function focusCity(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    var name = null;
    if (lastState && lastState.cities) {
      for (var i = 0; i < lastState.cities.length; i++) {
        var c = lastState.cities[i];
        if (c && Math.abs(c.lat - lat) < 0.01 && Math.abs(c.lon - lon) < 0.01) { name = c.name_zh; break; }
      }
    }
    highlight = { lat: lat, lon: lon, name: name, until: Date.now() + HIGHLIGHT_MS };
    render(lastState);
  }

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvasEl ? canvasEl.getContext('2d') : null;
    if (!ctx) return null;
    ensureSize();
    loadLand();
    window.addEventListener('resize', function () {
      if (ensureSize()) render(lastState);
    });
    return window.MapView;
  }

  window.MapView = { init: init, render: render, focusCity: focusCity };
})();
