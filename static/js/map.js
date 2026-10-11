/* map.js — 全屏等距圆柱世界地图 + 晨昏线渲染（window.MapView，契约 §6.2/§6.3）
 *
 * init(canvas)     绑定画布、按 DPR 适配、构建离屏底图、注册 resize、启动定位标记脉冲
 * setLand(geojson) 注入陆地数据（world_land.json 内容）并重建底图
 * render(state)    每秒调用：底图 + 夜/蒙影三段叠加 + 白色晨昏线 + 定位标记（同步上屏）
 * resize()         尺寸/DPR 变化时重建离屏画布并重绘
 *
 * 投影（§6.3 cover）：scale = max(W/360, H/180)，x = W/2 + lon·scale，y = H/2 − lat·scale。
 * 颜色：海 #000；陆 #2e2e2e；经线每 30° #161616；夜 rgba(0,0,0,0.55)；
 *       蒙影两级 rgba(0,0,0,0.22)→rgba(0,0,0,0.40)；晨昏线 #ffffff 1.5px + 柔光；
 *       定位标记 = 脉冲扩散环 + 中心单点（run-011：双静态环已删，脉冲环按用户要求保留）。
 * 昼夜判定（§5 night_north）：每列三段——昼（lat0 向日侧，无叠加）/
 *       蒙影（lat0→lat6；curve6 为 null 时延至列末端）/ 夜（lat6→列末端；null 时该列无夜区）。
 *
 * 性能：底图（黑+网格+陆地）与场景（底图+夜+晨昏线）各一张离屏画布；
 *       1Hz render 只重建场景离屏；脉冲环由 rAF 逐帧驱动（reduced-motion 时停）。
 *
 * 语法约束：ES2017 子集（esprima 4 解析；无外部请求、无 eval）。
 */
(function () {
  'use strict';

  var LAND_FILL = '#2e2e2e';
  var GRID_COLOR = '#161616';
  var NIGHT_LEVELS = ['rgba(0, 0, 0, 0.22)', 'rgba(0, 0, 0, 0.40)', 'rgba(0, 0, 0, 0.55)'];
  var LINE_COLOR = '#ffffff';
  var MARKER_R = 3;             // 定位标记中心点半径（CSS px）
  var PULSE_MS = 2400;          // 脉冲环周期：从 MARKER_R 扩到 PULSE_R_MAX 后淡出重来
  var PULSE_R_MAX = 15;         // 脉冲环最大半径（CSS px）

  var canvas = null;
  var ctx = null;
  var W = 0, H = 0, dpr = 1, scale = 1;
  var base = null;              // 离屏：黑底 + 经线网格 + 陆地
  var scene = null;             // 离屏：底图 + 夜/蒙影 + 晨昏线
  var baseCtx = null, sceneCtx = null;
  var landPolygons = null;
  var lastState = null;
  var rafId = 0;
  var pulseEnabled = true;      // prefers-reduced-motion: reduce 时为 false（禁脉冲）
  var listenersBound = false;   // init 重复调用时不重复注册监听（防泄漏）

  /* ---------- 投影（§6.3 cover） ---------- */
  function xOf(lon) { return W / 2 + lon * scale; }
  function yOf(lat) { return H / 2 - lat * scale; }

  /* ---------- 尺寸 / 离屏画布 ---------- */
  function makeOffscreen() {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * dpr));
    c.height = Math.max(1, Math.round(H * dpr));
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas: c, ctx: g };
  }

  function ensureSize() {
    var cw = canvas ? canvas.clientWidth : 0;
    var ch = canvas ? canvas.clientHeight : 0;
    var ratio = window.devicePixelRatio || 1;
    if (cw < 10 || ch < 10) return false;            // 隐藏/未布局：保留上次尺寸
    if (cw === W && ch === H && Math.abs(ratio - dpr) < 0.01 && base && scene) return true;
    W = cw; H = ch; dpr = ratio;
    scale = Math.max(W / 360, H / 180);
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var b = makeOffscreen();
    base = b.canvas; baseCtx = b.ctx;
    var s = makeOffscreen();
    scene = s.canvas; sceneCtx = s.ctx;
    buildBase();
    return true;
  }

  /* ---------- 底图：黑底 + 30° 经线 + 陆地 ---------- */
  function buildBase() {
    if (!baseCtx) return;
    var g = baseCtx;
    /* fillRect 已整幅不透明覆盖，无需先 clearRect */
    g.fillStyle = '#000000';
    g.fillRect(0, 0, W, H);
    drawGrid(g);
    drawLand(g);
  }

  function drawGrid(g) {
    var lon, x;
    g.lineWidth = 1;
    g.strokeStyle = GRID_COLOR;
    g.beginPath();
    for (lon = -180; lon <= 180; lon += 30) {
      x = Math.round(xOf(lon)) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, H);
    }
    g.stroke();
  }

  /* 陆地：全部环放进同一路径 evenodd 填充（环中环正确成洞）。
   * 数据契约（§2）保证相邻点 |Δlon| ≤ 180，跨 180° 的边本落在图幅边缘，原样绘制即可。 */
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
      var lon = p[0], lat = p[1];
      if (typeof lon !== 'number' || typeof lat !== 'number' || !isFinite(lon) || !isFinite(lat)) continue;
      var x = xOf(lon), y = yOf(lat);
      if (!started) { g.moveTo(x, y); started = true; }
      else g.lineTo(x, y);
    }
    if (started) g.closePath();
  }

  /* ---------- 夜 / 蒙影三段叠加 ---------- */
  function drawNight(g, st) {
    var term = st && st.terminator;
    if (!term || !term.curve0 || !term.curve0.length) return;
    var c0 = term.curve0;
    var c6 = term.curve6 || [];
    var step = (typeof term.lon_step === 'number' && term.lon_step > 0) ? term.lon_step : 1;
    var nightUp = !!term.night_north;               // 夜半球在北（lat > lat0）
    var colW = step * scale;
    var endLat = nightUp ? 90 : -90;                // 列末端纬度
    var bands = [[], [], []];                       // 0 蒙影浅 / 1 蒙影深 / 2 夜

    for (var i = 0; i < c0.length; i++) {
      var p0 = c0[i];
      if (!p0 || typeof p0[1] !== 'number' || !isFinite(p0[1])) continue;
      var lon = p0[0];
      if (typeof lon !== 'number' || !isFinite(lon)) continue;
      var lat0 = p0[1];
      var x = xOf(lon);
      var lat6 = null;
      var p6 = c6[i];
      if (p6 && typeof p6[1] === 'number' && isFinite(p6[1])) lat6 = p6[1];

      var segs;
      if (lat6 === null) {
        /* 该列无 −6° 交点：蒙影延至列末端，无夜区 */
        var midN = lat0 + (endLat - lat0) / 2;
        segs = [[lat0, midN, 0], [midN, endLat, 1]];
      } else {
        var mid = (lat0 + lat6) / 2;
        segs = [[lat0, mid, 0], [mid, lat6, 1], [lat6, endLat, 2]];
      }
      for (var k = 0; k < segs.length; k++) {
        var la = segs[k][0], lb = segs[k][1], lvl = segs[k][2];
        var ya = yOf(la), yb = yOf(lb);
        var top = ya < yb ? ya : yb;
        var bot = ya < yb ? yb : ya;
        if (bot - top < 0.01) continue;
        bands[lvl].push([x, top, colW, bot - top]);
      }
    }

    for (var l = 0; l < 3; l++) {
      var rects = bands[l];
      if (!rects.length) continue;
      g.fillStyle = NIGHT_LEVELS[l];
      g.beginPath();
      for (var j = 0; j < rects.length; j++) {
        g.rect(rects[j][0], rects[j][1], rects[j][2], rects[j][3]);
      }
      g.fill();
    }
  }

  /* ---------- 晨昏线白折线（连接全部 curve0） ---------- */
  function drawTerminator(g, st) {
    var term = st && st.terminator;
    if (!term || !term.curve0 || !term.curve0.length) return;
    var c0 = term.curve0;
    g.beginPath();
    var started = false;
    for (var i = 0; i < c0.length; i++) {
      var p = c0[i];
      if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !isFinite(p[1])) {
        started = false;
        continue;
      }
      var x = xOf(p[0]), y = yOf(p[1]);
      if (!started) { g.moveTo(x, y); started = true; }
      else g.lineTo(x, y);
    }
    if (!started) return;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 1.5;
    /* 柔光 + 锐利两遍 */
    g.shadowColor = 'rgba(255, 255, 255, 0.85)';
    g.shadowBlur = 6;
    g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    g.stroke();
    g.shadowBlur = 0;
    g.shadowColor = 'transparent';
    g.strokeStyle = LINE_COLOR;
    g.stroke();
  }

  /* ---------- 定位标记：脉冲扩散环 + 中心单点（run-010/011：双环已删，脉冲环恢复） ---------- */
  function markerPos(st) {
    var loc = st && st.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return null;
    if (!isFinite(loc.lat) || !isFinite(loc.lon)) return null;
    return { x: xOf(loc.lon), y: yOf(loc.lat) };
  }

  function drawMarker(g, t) {
    var m = markerPos(lastState);
    if (!m) return;
    if (m.x < -24 || m.x > W + 24 || m.y < -24 || m.y > H + 24) return;
    /* 脉冲环：从点半径扩到 PULSE_R_MAX，透明度同步淡出 */
    if (pulseEnabled && typeof t === 'number') {
      var phase = (t % PULSE_MS) / PULSE_MS;
      var r = MARKER_R + phase * (PULSE_R_MAX - MARKER_R);
      g.save();
      g.globalAlpha = 0.55 * (1 - phase);
      g.strokeStyle = LINE_COLOR;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(m.x, m.y, r, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
    /* 中心单点 + 一层柔光兜住可见度 */
    g.save();
    g.shadowColor = 'rgba(255, 255, 255, 0.9)';
    g.shadowBlur = 6;
    g.fillStyle = LINE_COLOR;
    g.beginPath();
    g.arc(m.x, m.y, MARKER_R, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  /* ---------- 场景合成与上屏 ---------- */
  function buildScene() {
    if (!sceneCtx) return;
    var g = sceneCtx;
    /* base 整幅不透明（buildBase 全幅 fillRect），直接覆盖即等于清屏 */
    if (base) g.drawImage(base, 0, 0, W, H);
    if (lastState) {
      drawNight(g, lastState);
      drawTerminator(g, lastState);
    }
  }

  function blit(t) {
    if (!ctx) return;
    /* scene 整幅不透明，无需 clearRect（每帧热路径，省一次全画布清除） */
    if (scene) ctx.drawImage(scene, 0, 0, W, H);
    drawMarker(ctx, t);
  }

  /* 脉冲循环：有状态且页面可见时逐帧 blit（脉冲环动画的唯一驱动） */
  function frame(t) {
    rafId = window.requestAnimationFrame(frame);
    if (!canvas || !ctx || document.hidden) return;
    if (!lastState) return;                 // 无状态时静止（底图已在 render/init 时上屏）
    blit(t);
  }

  /* 脉冲循环按需启停：prefers-reduced-motion 关闭时不能继续空转 60fps 全画布 blit，
   * 重新开启时也要能拉起循环（否则改回去后脉冲再也不动）。 */
  function startLoop() {
    if (!rafId) rafId = window.requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  /* ---------- 对外接口 ---------- */
  function render(state) {
    if (state) lastState = state;
    if (!canvas || !ctx) return;
    if (!ensureSize()) return;
    buildScene();
    blit(pulseEnabled ? (window.performance && performance.now ? performance.now() : 0) : null);
  }

  function setLand(geojson) {
    var polys = geojson && geojson.polygons;
    landPolygons = (polys && polys.length) ? polys : null;
    if (baseCtx) {
      buildBase();
      if (lastState) render(lastState);
      else { buildScene(); blit(null); }
    }
  }

  function resize() {
    if (!canvas || !ctx) return;
    ensureSize();
    render(lastState);
  }

  /* 当前是否允许脉冲（prefers-reduced-motion: reduce 时禁止）；读失败按允许处理 */
  function motionAllowed() {
    if (!window.matchMedia) return true;
    try {
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      return !(mq && mq.matches);
    } catch (e) {
      return true;
    }
  }

  function init(canvasEl) {
    canvas = canvasEl || null;
    ctx = canvas ? canvas.getContext('2d') : null;
    if (!ctx) return null;
    if (!listenersBound) {
      listenersBound = true;
      window.addEventListener('resize', function () { resize(); });
      window.addEventListener('orientationchange', function () { resize(); });
      if (window.matchMedia) {
        try {
          var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
          if (mq && mq.addEventListener) {
            mq.addEventListener('change', function (e) {
              pulseEnabled = !e.matches;
              if (pulseEnabled) startLoop(); else stopLoop();
              render(lastState);
            });
          }
        } catch (e) { /* 老浏览器无 matchMedia：保持默认允许脉冲 */ }
      }
    }
    pulseEnabled = motionAllowed();
    ensureSize();
    buildScene();
    blit(null);
    if (pulseEnabled) startLoop();
    return window.MapView;
  }

  window.MapView = {
    init: init,
    setLand: setLand,
    render: render,
    resize: resize
  };
})();
