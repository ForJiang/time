/* clock.js — 模拟表盘（window.AnalogClock，契约 §7.2）
 *
 * AnalogClock.init(el, size) -> handle{ setTime(h,m,s), canvas, size }
 * 黑底圆盘 + 白色阿拉伯数字 1-12 + 刻度 + 白时针/分针 + 橙色秒针（带配重尾部）。
 * 数字时间由 app.js 负责，本模块只画表盘。
 *
 * 语法约束：ES2017 子集。
 */
(function () {
  'use strict';

  var FONT_STACK = '-apple-system,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif';
  var SECOND_COLOR = '#ff9f0a';

  function init(el, size) {
    if (!el) return null;
    size = size || 132;
    var dpr = window.devicePixelRatio || 1;
    var canvas = document.createElement('canvas');
    canvas.className = 'analog-clock';
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    el.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    /* 跨显示器拖动后 devicePixelRatio 可能变化（Retina ↔ 非 Retina）：
     * 尺寸不变时也要按新 dpr 重建画布，否则表盘会被拉伸发虚。 */
    function syncDpr() {
      var r = window.devicePixelRatio || 1;
      if (r === dpr) return;
      dpr = r;
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    }

    function setTime(h, m, s) {
      syncDpr();
      draw(ctx, size, dpr, h, m, s);
    }

    setTime(0, 0, 0);
    return { canvas: canvas, size: size, setTime: setTime };
  }

  function draw(ctx, size, dpr, h, m, s) {
    var R = size / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // 表盘底
    var bg = ctx.createRadialGradient(R, R * 0.82, R * 0.1, R, R, R * 1.05);
    bg.addColorStop(0, '#1c1c1e');
    bg.addColorStop(1, '#000000');
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.stroke();

    // 刻度：60 分秒小刻度 + 12 个大刻度
    var i, ang, x1, y1, x2, y2;
    for (i = 0; i < 60; i++) {
      ang = (i * 6 - 90) * Math.PI / 180;
      var major = (i % 5 === 0);
      var r1 = major ? R * 0.80 : R * 0.87;
      x1 = R + Math.cos(ang) * r1; y1 = R + Math.sin(ang) * r1;
      x2 = R + Math.cos(ang) * R * 0.93; y2 = R + Math.sin(ang) * R * 0.93;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineWidth = major ? 2 : 1;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.28)';
      ctx.stroke();
    }

    // 阿拉伯数字 1-12
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 ' + Math.round(R * 0.24) + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 1; i <= 12; i++) {
      ang = (i * 30 - 90) * Math.PI / 180;
      var rn = R * 0.66;
      ctx.fillText(String(i), R + Math.cos(ang) * rn, R + Math.sin(ang) * rn);
    }

    // 指针角度
    var hh = ((h % 12) + m / 60 + s / 3600) * 30;
    var mm = (m + s / 60) * 6;
    var ss = s * 6;

    // 时针
    hand(ctx, R, R, hh, R * 0.50, Math.max(2.5, R * 0.075), 'rgba(255,255,255,0.95)');
    // 分针
    hand(ctx, R, R, mm, R * 0.72, Math.max(2, R * 0.055), 'rgba(255,255,255,0.95)');
    // 秒针（橙色 + 尾部配重）
    hand(ctx, R, R, ss, R * 0.78, Math.max(1.2, R * 0.032), SECOND_COLOR, R * 0.20);

    // 中心轴
    ctx.beginPath();
    ctx.arc(R, R, Math.max(2, R * 0.05), 0, Math.PI * 2);
    ctx.fillStyle = SECOND_COLOR;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(R, R, Math.max(0.8, R * 0.02), 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
  }

  /* deg: 12 点方向为 0，顺时针；tail: 反向配重长度 */
  function hand(ctx, cx, cy, deg, len, width, color, tail) {
    var ang = (deg - 90) * Math.PI / 180;
    var x = cx + Math.cos(ang) * len;
    var y = cy + Math.sin(ang) * len;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    if (tail) {
      ctx.moveTo(cx - Math.cos(ang) * tail, cy - Math.sin(ang) * tail);
      ctx.lineTo(x, y);
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  window.AnalogClock = { init: init };
})();
