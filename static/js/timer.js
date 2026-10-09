/**
 * timer.js — 计时器 Tab（W4）
 * 契约 §7.2：window.Timer = { init(rootEl) }
 *
 * HH/MM/SS 三个数字输入 + 预设 chips（1/3/5/10/25 分钟）；
 * 开始 / 暂停 / 复位；SVG 圆环进度；结束时蜂鸣 + 视觉闪烁。
 *
 * 语法约束：ES2017 子集（esprima 4 门禁）——禁 ?. / ?? / #private。
 */
(function () {
  "use strict";

  var TICK_MS = 50;          // 倒计时刷新间隔
  var BEEP_CYCLE_MS = 1200;  // 结束蜂鸣循环周期
  var AUTO_STOP_MS = 30000;  // 结束提示自动停止（防无限噪音）
  var RING_RADIUS = 90;      // SVG 圆环半径（viewBox 200x200）
  var RING_C = 2 * Math.PI * RING_RADIUS;
  var PRESETS = [1, 3, 5, 10, 25]; // 分钟

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function fmt2(n) { return (n < 10 ? "0" : "") + n; }

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (isNaN(n)) { return fallback; }
    if (n < min) { return min; }
    if (n > max) { return max; }
    return n;
  }

  /** HH:MM:SS（不足 1 小时显示 MM:SS） */
  function formatDuration(ms) {
    if (ms < 0) { ms = 0; }
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) {
      return fmt2(h) + ":" + fmt2(m) + ":" + fmt2(s);
    }
    return fmt2(m) + ":" + fmt2(s);
  }

  // ---------------- WebAudio 蜂鸣（与 alarms.js 独立，避免跨模块依赖） ----------------

  function Beeper() {
    this.ctx = null;
    this.timer = null;
    this.nodes = [];
  }

  Beeper.prototype.ensureCtx = function () {
    if (!this.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { return null; }
      try { this.ctx = new AC(); } catch (err) { return null; }
    }
    if (this.ctx.state === "suspended" && typeof this.ctx.resume === "function") {
      this.ctx.resume();
    }
    return this.ctx;
  };

  Beeper.prototype.beepOnce = function () {
    var ctx = this.ensureCtx();
    if (!ctx) { return; }
    var t0 = ctx.currentTime + 0.02;
    for (var i = 0; i < 3; i++) {
      this.tone(ctx, t0 + i * 0.26, 0.14, 1046, 0.22);
    }
  };

  Beeper.prototype.tone = function (ctx, start, dur, freq, vol) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(vol, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
    this.nodes.push(osc);
  };

  Beeper.prototype.startLoop = function () {
    if (this.timer) { return; }
    this.beepOnce();
    var self = this;
    this.timer = setInterval(function () { self.beepOnce(); }, BEEP_CYCLE_MS);
  };

  Beeper.prototype.stopLoop = function () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (var i = 0; i < this.nodes.length; i++) {
      try { this.nodes[i].stop(); } catch (err) { /* 已停止则忽略 */ }
    }
    this.nodes = [];
  };

  // ---------------- 计时器模块 ----------------

  function TimerApp(rootEl) {
    this.root = rootEl;
    this.totalMs = 5 * 60 * 1000;  // 上次设置的时长（默认 5 分钟）
    this.remainingMs = this.totalMs;
    this.running = false;
    this.endAt = 0;                // 运行中的结束时刻（Date.now() 基准）
    this.finished = false;         // 结束响铃/闪烁中
    this.tickTimer = null;
    this.autoStopTimer = null;
    this.beeper = new Beeper();
    this.build();
    this.bind();
    this.update();
  }

  TimerApp.prototype.build = function () {
    var root = this.root;
    root.textContent = "";
    root.setAttribute("data-aux-timer", "1");

    var panel = el("div", "aux-timer");

    // 圆环 + 中央时间
    var ringWrap = el("div", "aux-tm-ring-wrap");
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "aux-tm-ring");
    svg.setAttribute("viewBox", "0 0 200 200");
    var bg = document.createElementNS(NS, "circle");
    bg.setAttribute("class", "aux-tm-ring-bg");
    bg.setAttribute("cx", "100");
    bg.setAttribute("cy", "100");
    bg.setAttribute("r", String(RING_RADIUS));
    this.fgCircle = document.createElementNS(NS, "circle");
    this.fgCircle.setAttribute("class", "aux-tm-ring-fg");
    this.fgCircle.setAttribute("cx", "100");
    this.fgCircle.setAttribute("cy", "100");
    this.fgCircle.setAttribute("r", String(RING_RADIUS));
    this.fgCircle.setAttribute("stroke-dasharray", String(RING_C));
    this.fgCircle.setAttribute("stroke-dashoffset", "0");
    svg.appendChild(bg);
    svg.appendChild(this.fgCircle);
    ringWrap.appendChild(svg);
    this.timeLabel = el("div", "aux-tm-time", "05:00");
    ringWrap.appendChild(this.timeLabel);
    this.stateLabel = el("div", "aux-tm-state", "");
    ringWrap.appendChild(this.stateLabel);
    panel.appendChild(ringWrap);

    // 时长输入
    var inputs = el("div", "aux-tm-inputs");
    this.hourInput = this.numberField(inputs, "时", 0, 99);
    this.minInput = this.numberField(inputs, "分", 0, 59);
    this.secInput = this.numberField(inputs, "秒", 0, 59);
    this.minInput.value = "5";
    panel.appendChild(inputs);

    this.formError = el("p", "aux-form-error", "");
    this.formError.hidden = true;
    panel.appendChild(this.formError);

    // 预设
    var presets = el("div", "aux-tm-presets");
    this.presetChips = [];
    for (var i = 0; i < PRESETS.length; i++) {
      var chip = el("button", "aux-preset-chip", PRESETS[i] + " 分钟");
      chip.type = "button";
      chip.setAttribute("data-min", String(PRESETS[i]));
      presets.appendChild(chip);
      this.presetChips.push(chip);
    }
    panel.appendChild(presets);

    // 按钮
    var buttons = el("div", "aux-tm-buttons");
    this.primaryBtn = el("button", "aux-tm-btn aux-tm-start", "开始");
    this.primaryBtn.type = "button";
    this.resetBtn = el("button", "aux-tm-btn aux-tm-reset", "复位");
    this.resetBtn.type = "button";
    buttons.appendChild(this.primaryBtn);
    buttons.appendChild(this.resetBtn);
    panel.appendChild(buttons);

    root.appendChild(panel);
  };

  TimerApp.prototype.numberField = function (parent, label, min, max) {
    var wrap = el("label", "aux-tm-field");
    var input = el("input", "aux-tm-num");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = "0";
    wrap.appendChild(input);
    wrap.appendChild(el("span", "aux-tm-unit", label));
    parent.appendChild(wrap);
    return input;
  };

  TimerApp.prototype.bind = function () {
    var self = this;
    this.primaryBtn.addEventListener("click", function () { self.onPrimary(); });
    this.resetBtn.addEventListener("click", function () { self.onReset(); });

    this.presetChips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        if (self.running || self.finished) { return; }
        var mins = parseInt(chip.getAttribute("data-min"), 10);
        self.hourInput.value = "0";
        self.minInput.value = String(mins);
        self.secInput.value = "0";
        self.applyInputs();
      });
    });

    var onChange = function () { if (!self.running && !self.finished) { self.applyInputs(); } };
    this.hourInput.addEventListener("change", onChange);
    this.minInput.addEventListener("change", onChange);
    this.secInput.addEventListener("change", onChange);

    // 首次用户交互时预热 AudioContext（浏览器自动播放策略）
    this.root.addEventListener("pointerdown", function once() {
      self.beeper.ensureCtx();
      self.root.removeEventListener("pointerdown", once);
    });
  };

  /** 读取输入框 → 更新 totalMs / remainingMs / 显示（非运行态）。 */
  TimerApp.prototype.applyInputs = function () {
    var h = clampInt(this.hourInput.value, 0, 99, 0);
    var m = clampInt(this.minInput.value, 0, 59, 0);
    var s = clampInt(this.secInput.value, 0, 59, 0);
    this.hourInput.value = String(h);
    this.minInput.value = String(m);
    this.secInput.value = String(s);
    this.totalMs = (h * 3600 + m * 60 + s) * 1000;
    this.remainingMs = this.totalMs;
    this.showError("");
    this.update();
  };

  TimerApp.prototype.onPrimary = function () {
    if (this.finished) {
      // 结束响铃中 → 停止提示
      this.stopFinished();
      return;
    }
    if (this.running) {
      // 暂停
      this.remainingMs = Math.max(0, this.endAt - Date.now());
      this.running = false;
      this.stopTicker();
      this.primaryBtn.textContent = "继续";
      this.primaryBtn.classList.remove("primary");
      this.stateLabel.textContent = "已暂停";
      this.setInputsDisabled(true);
      this.update();
      return;
    }
    // 开始 / 继续
    if (this.remainingMs <= 0) {
      this.applyInputs();
      if (this.remainingMs <= 0) {
        this.showError("请设置大于 0 的倒计时时长");
        return;
      }
    }
    this.endAt = Date.now() + this.remainingMs;
    this.running = true;
    this.startTicker();
    this.primaryBtn.textContent = "暂停";
    this.primaryBtn.classList.add("primary");
    this.stateLabel.textContent = "倒计时中";
    this.setInputsDisabled(true);
    this.update();
  };

  TimerApp.prototype.onReset = function () {
    this.stopFinished();
    this.running = false;
    this.stopTicker();
    this.remainingMs = this.totalMs;
    this.primaryBtn.textContent = "开始";
    this.primaryBtn.classList.remove("primary");
    this.stateLabel.textContent = "";
    this.setInputsDisabled(false);
    this.update();
  };

  TimerApp.prototype.startTicker = function () {
    if (this.tickTimer) { return; }
    var self = this;
    this.tickTimer = setInterval(function () { self.tick(); }, TICK_MS);
  };

  TimerApp.prototype.stopTicker = function () {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  };

  TimerApp.prototype.tick = function () {
    this.remainingMs = Math.max(0, this.endAt - Date.now());
    if (this.remainingMs <= 0) {
      this.finish();
      return;
    }
    this.update();
  };

  TimerApp.prototype.finish = function () {
    this.running = false;
    this.remainingMs = 0;
    this.stopTicker();
    this.finished = true;
    this.update();
    this.root.classList.add("finished");
    this.primaryBtn.textContent = "停止";
    this.primaryBtn.classList.add("danger");
    this.stateLabel.textContent = "时间到";
    this.beeper.startLoop();
    var self = this;
    this.autoStopTimer = setTimeout(function () { self.stopFinished(); }, AUTO_STOP_MS);
  };

  TimerApp.prototype.stopFinished = function () {
    if (!this.finished) { return; }
    this.finished = false;
    this.beeper.stopLoop();
    this.root.classList.remove("finished");
    this.primaryBtn.textContent = "开始";
    this.primaryBtn.classList.remove("danger");
    this.stateLabel.textContent = "";
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    this.setInputsDisabled(false);
    this.update();
  };

  TimerApp.prototype.setInputsDisabled = function (disabled) {
    this.hourInput.disabled = disabled;
    this.minInput.disabled = disabled;
    this.secInput.disabled = disabled;
    for (var i = 0; i < this.presetChips.length; i++) {
      this.presetChips[i].disabled = disabled;
    }
  };

  TimerApp.prototype.showError = function (msg) {
    if (msg) {
      this.formError.textContent = msg;
      this.formError.hidden = false;
    } else {
      this.formError.hidden = true;
    }
  };

  TimerApp.prototype.update = function () {
    var ms = this.remainingMs;
    this.timeLabel.textContent = formatDuration(ms);
    var progress = this.totalMs > 0 ? (ms / this.totalMs) : 0;
    if (progress < 0) { progress = 0; }
    if (progress > 1) { progress = 1; }
    // 剩余越多，offset 越小（圆环从满到空）
    this.fgCircle.setAttribute("stroke-dashoffset", String(RING_C * (1 - progress)));
  };

  window.Timer = {
    init: function (rootEl) {
      if (!rootEl) { return null; }
      if (rootEl.getAttribute("data-aux-timer") === "1") { return null; }
      return new TimerApp(rootEl);
    }
  };
})();
