/**
 * stopwatch.js — 秒表 Tab（W4）
 * 契约 §7.2：window.Stopwatch = { init(rootEl) }
 *
 * performance.now() 计时；开始 / 暂停 / 复位 / 计次；
 * 显示 mm:ss.cc（厘秒）；计次列表含单圈时间与累计时间；
 * 大号等宽数字（tabular-nums，见 aux.css）。
 *
 * 语法约束：ES2017 子集（esprima 4 门禁）——禁 ?. / ?? / #private。
 */
(function () {
  "use strict";

  var DISPLAY_MS = 20; // 显示刷新间隔（约 50fps，厘秒足够平滑）

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function fmt2(n) { return (n < 10 ? "0" : "") + n; }

  /** mm:ss.cc（分钟不截断，可自然变 3 位以上） */
  function formatTime(ms) {
    if (ms < 0) { ms = 0; }
    var total = Math.floor(ms);
    var min = Math.floor(total / 60000);
    var sec = Math.floor((total % 60000) / 1000);
    var cs = Math.floor((total % 1000) / 10);
    return fmt2(min) + ":" + fmt2(sec) + "." + fmt2(cs);
  }

  function StopwatchApp(rootEl) {
    this.root = rootEl;
    this.running = false;
    this.accumulated = 0;   // 已暂停累计的毫秒数
    this.startedAt = 0;     // 本次开始的 performance.now()
    this.laps = [];         // [{cum, split}]
    this.displayTimer = null;
    this.build();
    this.bind();
    this.update();
  }

  StopwatchApp.prototype.build = function () {
    var root = this.root;
    root.textContent = "";
    root.setAttribute("data-aux-stopwatch", "1");

    var panel = el("div", "aux-stopwatch");

    var display = el("div", "aux-sw-display");
    this.timeLabel = el("span", "aux-sw-time", "00:00.00");
    display.appendChild(this.timeLabel);
    panel.appendChild(display);

    var buttons = el("div", "aux-sw-buttons");
    this.startBtn = el("button", "aux-sw-btn aux-sw-start", "开始");
    this.startBtn.type = "button";
    this.lapBtn = el("button", "aux-sw-btn aux-sw-lap-btn", "计次");
    this.lapBtn.type = "button";
    this.lapBtn.disabled = true;
    this.resetBtn = el("button", "aux-sw-btn aux-sw-reset", "复位");
    this.resetBtn.type = "button";
    this.resetBtn.disabled = true;
    buttons.appendChild(this.startBtn);
    buttons.appendChild(this.lapBtn);
    buttons.appendChild(this.resetBtn);
    panel.appendChild(buttons);

    this.lapEmpty = el("p", "aux-sw-lap-empty", "还没有计次记录");
    this.lapEmpty.hidden = true;
    panel.appendChild(this.lapEmpty);

    this.lapList = el("ol", "aux-sw-laps");
    panel.appendChild(this.lapList);

    root.appendChild(panel);
  };

  StopwatchApp.prototype.bind = function () {
    var self = this;
    this.startBtn.addEventListener("click", function () { self.onStartPause(); });
    this.lapBtn.addEventListener("click", function () { self.onLap(); });
    this.resetBtn.addEventListener("click", function () { self.onReset(); });
  };

  StopwatchApp.prototype.elapsed = function () {
    if (this.running) {
      return this.accumulated + (performance.now() - this.startedAt);
    }
    return this.accumulated;
  };

  StopwatchApp.prototype.onStartPause = function () {
    if (this.running) {
      // 暂停
      this.accumulated = this.elapsed();
      this.running = false;
      this.stopTicker();
      this.startBtn.textContent = "继续";
      this.startBtn.classList.remove("primary");
    } else {
      // 开始 / 继续
      this.startedAt = performance.now();
      this.running = true;
      this.startTicker();
      this.startBtn.textContent = "暂停";
      this.startBtn.classList.add("primary");
    }
    this.update();
  };

  StopwatchApp.prototype.onLap = function () {
    var cum = this.elapsed();
    var lastCum = this.laps.length ? this.laps[0].cum : 0;
    this.laps.unshift({ cum: cum, split: cum - lastCum });
    this.renderLaps();
    this.update();
  };

  StopwatchApp.prototype.onReset = function () {
    this.running = false;
    this.accumulated = 0;
    this.laps = [];
    this.stopTicker();
    this.startBtn.textContent = "开始";
    this.startBtn.classList.remove("primary");
    this.renderLaps();
    this.update();
  };

  StopwatchApp.prototype.startTicker = function () {
    if (this.displayTimer) { return; }
    var self = this;
    this.displayTimer = setInterval(function () { self.update(); }, DISPLAY_MS);
  };

  StopwatchApp.prototype.stopTicker = function () {
    if (this.displayTimer) {
      clearInterval(this.displayTimer);
      this.displayTimer = null;
    }
  };

  StopwatchApp.prototype.update = function () {
    var ms = this.elapsed();
    this.timeLabel.textContent = formatTime(ms);
    var hasTime = ms > 0;
    this.lapBtn.disabled = !(this.running || hasTime);
    this.resetBtn.disabled = !(this.running || hasTime || this.laps.length > 0);
  };

  StopwatchApp.prototype.renderLaps = function () {
    this.lapList.textContent = "";
    this.lapEmpty.hidden = this.laps.length > 0;
    for (var i = 0; i < this.laps.length; i++) {
      var lap = this.laps[i];
      var no = this.laps.length - i; // 圈数编号（最新的最大）
      var row = el("li", "aux-sw-lap");
      if (i === 0) { row.classList.add("current"); }
      row.appendChild(el("span", "aux-sw-lap-no", "圈 " + no));
      row.appendChild(el("span", "aux-sw-lap-split", formatTime(lap.split)));
      row.appendChild(el("span", "aux-sw-lap-cum", formatTime(lap.cum)));
      this.lapList.appendChild(row);
    }
  };

  window.Stopwatch = {
    init: function (rootEl) {
      if (!rootEl) { return null; }
      if (rootEl.getAttribute("data-aux-stopwatch") === "1") { return null; }
      return new StopwatchApp(rootEl);
    }
  };
})();
