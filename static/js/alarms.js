/**
 * alarms.js — 闹钟 Tab（W4）
 * 契约 §7.2：window.Alarms = { init(rootEl) }
 *
 * 数据降级链：window.TimeAPI.alarms.*（W3 api.js）→ fetch 直连 /api/alarms →
 * 内存模式（仅本次会话有效，UI 有明显提示）。
 * 到点响铃：本地 500ms 检查（TimeAPI.now() 校准时间或本机时间）；
 * repeat_days 为空 = 每天，否则含当天（周一=0 … 周日=6）才响；
 * 每个闹钟每分钟只响一次（lastFiredKey）。
 * 响铃：WebAudio 三声循环蜂鸣（可手动停止）+ Notification（已授权才用）。
 *
 * 语法约束：ES2017 子集（esprima 4 门禁）——禁 ?. / ?? / #private。
 */
(function () {
  "use strict";

  var WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]; // 索引 0=周一 … 6=周日
  var TICK_MS = 500;       // 响铃检查间隔
  var REFRESH_MS = 15000;  // 列表轮询间隔
  var BEEP_CYCLE_MS = 1500; // 蜂鸣循环周期（内含三声）

  // ---------------- 小工具 ----------------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function fmt2(n) { return (n < 10 ? "0" : "") + n; }

  function hhmm(alarm) { return fmt2(alarm.hour) + ":" + fmt2(alarm.minute); }

  function weekdayIndex(date) { return (date.getDay() + 6) % 7; } // JS 周日=0 → 周一=0

  function nowDate() {
    if (window.TimeAPI && typeof window.TimeAPI.now === "function") {
      var d = window.TimeAPI.now();
      if (d instanceof Date) { return d; }
    }
    return new Date();
  }

  function apiFetch(method, path, body) {
    var opts = {
      method: method,
      headers: { "Content-Type": "application/json" }
    };
    if (body !== undefined) { opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (resp) {
      return resp.json().then(function (data) {
        if (!resp.ok) {
          throw new Error((data && data.error) || ("HTTP " + resp.status));
        }
        return data;
      });
    });
  }

  function normalizeAlarms(payload) {
    if (Array.isArray(payload)) { return payload; }
    if (payload && Array.isArray(payload.alarms)) { return payload.alarms; }
    return [];
  }

  // ---------------- WebAudio 蜂鸣 ----------------

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

  Beeper.prototype.warmUp = function () { this.ensureCtx(); };

  Beeper.prototype.beepOnce = function () {
    var ctx = this.ensureCtx();
    if (!ctx) { return; }
    // 上一轮三声（约 0.9s）已播放完毕，可安全释放引用，避免长时间响铃时节点累积
    this.nodes = [];
    var t0 = ctx.currentTime + 0.02;
    for (var i = 0; i < 3; i++) {
      this.tone(ctx, t0 + i * 0.3, 0.16, 880, 0.22);
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

  // ---------------- 闹钟模块 ----------------

  function AlarmsApp(rootEl) {
    this.root = rootEl;
    this.alarms = [];
    this.memoryMode = false;
    this.memoryReason = "";
    this.ringing = {};        // id -> true
    this.lastFired = {};      // id -> "YYYYMMDDHHmm"
    this.beeper = new Beeper();
    this.selectedDays = [];   // 表单中选中的星期（周一=0）
    this.tickTimer = null;
    this.refreshTimer = null;
    this.build();
    this.bind();
    this.load();
    this.startTimers();
  }

  AlarmsApp.prototype.build = function () {
    var root = this.root;
    root.textContent = "";
    root.setAttribute("data-aux-alarms", "1");

    var panel = el("div", "aux-alarms");

    // 头部：标题 + 全部停止
    var head = el("div", "aux-alarms-head");
    head.appendChild(el("h2", "aux-title", "闹钟"));
    this.stopAllBtn = el("button", "aux-stop-all", "停止全部响铃");
    this.stopAllBtn.type = "button";
    this.stopAllBtn.hidden = true;
    head.appendChild(this.stopAllBtn);
    panel.appendChild(head);

    // 降级提示条
    this.notice = el("div", "aux-notice");
    this.notice.hidden = true;
    this.noticeText = el("span", "aux-notice-text", "");
    this.retryBtn = el("button", "aux-notice-retry", "重试连接");
    this.retryBtn.type = "button";
    this.notice.appendChild(this.noticeText);
    this.notice.appendChild(this.retryBtn);
    panel.appendChild(this.notice);

    // 列表
    this.list = el("ul", "aux-alarm-list");
    panel.appendChild(this.list);
    this.emptyHint = el("p", "aux-empty", "没有闹钟，在下方添加一个");
    this.emptyHint.hidden = true;
    panel.appendChild(this.emptyHint);

    // 添加表单
    var form = el("form", "aux-alarm-form");
    var row = el("div", "aux-alarm-form-row");
    this.timeInput = el("input", "aux-time-input");
    this.timeInput.type = "time";
    this.timeInput.value = "07:00";
    this.timeInput.required = true;
    this.labelInput = el("input", "aux-label-input");
    this.labelInput.type = "text";
    this.labelInput.maxLength = 30;
    this.labelInput.placeholder = "标签（可选）";
    row.appendChild(this.timeInput);
    row.appendChild(this.labelInput);
    form.appendChild(row);

    var daysRow = el("div", "aux-alarm-form-days");
    daysRow.appendChild(el("span", "aux-alarm-days-label", "重复"));
    this.dayChips = [];
    for (var d = 0; d < 7; d++) {
      var chip = el("button", "aux-day-chip", WEEKDAYS[d]);
      chip.type = "button";
      chip.setAttribute("data-day", String(d));
      chip.setAttribute("aria-pressed", "false");
      daysRow.appendChild(chip);
      this.dayChips.push(chip);
    }
    daysRow.appendChild(el("span", "aux-alarm-days-hint", "不选 = 每天"));
    form.appendChild(daysRow);
    this.formError = el("p", "aux-form-error", "");
    this.formError.hidden = true;
    form.appendChild(this.formError);

    this.saveBtn = el("button", "aux-save-btn", "保存闹钟");
    this.saveBtn.type = "submit";
    form.appendChild(this.saveBtn);
    panel.appendChild(form);

    root.appendChild(panel);
  };

  AlarmsApp.prototype.bind = function () {
    var self = this;

    this.stopAllBtn.addEventListener("click", function () { self.stopAll(); });

    this.retryBtn.addEventListener("click", function () {
      self.notice.hidden = true;
      self.load();
    });

    // 首次用户交互时预热 AudioContext（浏览器自动播放策略）
    this.root.addEventListener("pointerdown", function once() {
      self.beeper.warmUp();
      self.root.removeEventListener("pointerdown", once);
    });

    // 星期 chips 多选
    this.dayChips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var day = parseInt(chip.getAttribute("data-day"), 10);
        var idx = self.selectedDays.indexOf(day);
        if (idx === -1) {
          self.selectedDays.push(day);
          chip.classList.add("selected");
          chip.setAttribute("aria-pressed", "true");
        } else {
          self.selectedDays.splice(idx, 1);
          chip.classList.remove("selected");
          chip.setAttribute("aria-pressed", "false");
        }
        self.selectedDays.sort();
      });
    });

    // 表单提交
    this.root.querySelector(".aux-alarm-form").addEventListener("submit", function (evt) {
      evt.preventDefault();
      self.onSave();
    });

    // 页面重新可见时刷新列表
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && Object.keys(self.ringing).length === 0) {
        self.load();
      }
    });
  };

  AlarmsApp.prototype.startTimers = function () {
    var self = this;
    this.tickTimer = setInterval(function () { self.tick(); }, TICK_MS);
    this.refreshTimer = setInterval(function () {
      if (Object.keys(self.ringing).length === 0) { self.load(); }
    }, REFRESH_MS);
  };

  // ---------------- 数据层 ----------------

  AlarmsApp.prototype.load = function () {
    var self = this;
    var api = window.TimeAPI && window.TimeAPI.alarms;
    var p;
    if (api && typeof api.list === "function") {
      p = Promise.resolve(api.list());
    } else {
      p = apiFetch("GET", "/api/alarms").then(normalizeAlarms);
    }
    return p.then(function (data) {
      self.alarms = normalizeAlarms(data).filter(function (a) {
        return a && typeof a.hour === "number" && typeof a.minute === "number";
      });
      self.exitMemoryMode();
      self.render();
    }).catch(function (err) {
      self.enterMemoryMode(err);
    });
  };

  AlarmsApp.prototype.enterMemoryMode = function (err) {
    if (!this.memoryMode) {
      this.memoryMode = true;
      this.memoryReason = (err && err.message) ? err.message : "未知错误";
      this.noticeText.textContent =
        "服务端不可用（" + this.memoryReason + "），闹钟仅在本次会话有效";
      this.notice.hidden = false;
    }
    this.render();
  };

  AlarmsApp.prototype.exitMemoryMode = function () {
    if (this.memoryMode) {
      this.memoryMode = false;
      this.notice.hidden = true;
    }
  };

  AlarmsApp.prototype.onSave = function () {
    var self = this;
    var raw = (this.timeInput.value || "").trim();
    var m = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (!m) {
      this.showFormError("请输入有效的时间（HH:MM）");
      return;
    }
    var hour = parseInt(m[1], 10);
    var minute = parseInt(m[2], 10);
    if (hour > 23 || minute > 59) {
      this.showFormError("时间超出范围（00:00 – 23:59）");
      return;
    }
    this.showFormError("");
    var label = (this.labelInput.value || "").trim();
    var days = this.selectedDays.slice();
    this.saveBtn.disabled = true;

    if (this.memoryMode) {
      this.alarms.push({
        id: "local-" + Date.now(),
        hour: hour,
        minute: minute,
        label: label,
        repeat_days: days,
        enabled: true,
        created: new Date().toISOString()
      });
      this.saveBtn.disabled = false;
      this.resetForm();
      this.render();
      return;
    }

    var api = window.TimeAPI && window.TimeAPI.alarms;
    var p;
    if (api && typeof api.add === "function") {
      p = Promise.resolve(api.add({
        hour: hour, minute: minute, label: label, repeat_days: days
      }));
    } else {
      p = apiFetch("POST", "/api/alarms", {
        hour: hour, minute: minute, label: label, repeat_days: days
      });
    }
    p.then(function () {
      self.saveBtn.disabled = false;
      self.resetForm();
      return self.load();
    }).catch(function (err) {
      self.saveBtn.disabled = false;
      self.enterMemoryMode(err);
    });
  };

  AlarmsApp.prototype.resetForm = function () {
    this.timeInput.value = "07:00";
    this.labelInput.value = "";
    this.selectedDays = [];
    this.dayChips.forEach(function (chip) {
      chip.classList.remove("selected");
      chip.setAttribute("aria-pressed", "false");
    });
  };

  AlarmsApp.prototype.showFormError = function (msg) {
    if (msg) {
      this.formError.textContent = msg;
      this.formError.hidden = false;
    } else {
      this.formError.hidden = true;
    }
  };

  AlarmsApp.prototype.toggleAlarm = function (id) {
    var self = this;
    var alarm = this.findById(id);
    if (!alarm) { return; }
    var wasEnabled = alarm.enabled !== false; // 旧值：若为 true，toggle 后即关闭
    if (this.memoryMode) {
      alarm.enabled = !wasEnabled;
      if (!alarm.enabled) { this.stopRinging(id); }
      this.render();
      return;
    }
    var api = window.TimeAPI && window.TimeAPI.alarms;
    var p;
    if (api && typeof api.toggle === "function") {
      p = Promise.resolve(api.toggle(id));
    } else {
      p = apiFetch("PATCH", "/api/alarms/" + encodeURIComponent(id));
    }
    p.then(function () {
      if (wasEnabled) { self.stopRinging(id); } // 被关闭 → 停止其响铃
      return self.load();
    }).catch(function (err) {
      self.enterMemoryMode(err);
    });
  };

  AlarmsApp.prototype.removeAlarm = function (id) {
    var self = this;
    this.stopRinging(id);
    if (this.memoryMode) {
      this.alarms = this.alarms.filter(function (a) { return a.id !== id; });
      this.render();
      return;
    }
    var api = window.TimeAPI && window.TimeAPI.alarms;
    var p;
    if (api && typeof api.remove === "function") {
      p = Promise.resolve(api.remove(id));
    } else {
      p = apiFetch("DELETE", "/api/alarms/" + encodeURIComponent(id));
    }
    p.then(function () { return self.load(); }).catch(function (err) {
      self.enterMemoryMode(err);
    });
  };

  AlarmsApp.prototype.findById = function (id) {
    for (var i = 0; i < this.alarms.length; i++) {
      if (this.alarms[i].id === id) { return this.alarms[i]; }
    }
    return null;
  };

  // ---------------- 渲染 ----------------

  AlarmsApp.prototype.render = function () {
    var self = this;
    this.list.textContent = "";
    this.emptyHint.hidden = this.alarms.length > 0;

    this.alarms.forEach(function (alarm) {
      var item = el("li", "aux-alarm-item");
      item.setAttribute("data-id", alarm.id);
      if (alarm.enabled === false) { item.classList.add("disabled"); }
      if (self.ringing[alarm.id]) { item.classList.add("ringing"); }

      // 开关
      var toggle = el("button", "aux-switch");
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", alarm.enabled === false ? "false" : "true");
      toggle.title = alarm.enabled === false ? "已关闭" : "已开启";
      var track = el("span", "aux-switch-track");
      track.appendChild(el("span", "aux-switch-knob"));
      toggle.appendChild(track);
      toggle.addEventListener("click", function () { self.toggleAlarm(alarm.id); });

      // 主体
      var body = el("div", "aux-alarm-body");
      body.appendChild(el("div", "aux-alarm-time", hhmm(alarm)));
      var sub = el("div", "aux-alarm-sub");
      var label = el("span", "aux-alarm-label", alarm.label || "闹钟");
      sub.appendChild(label);
      sub.appendChild(el("span", "aux-alarm-days", self.daysText(alarm)));
      body.appendChild(sub);

      // 操作
      var ops = el("div", "aux-alarm-ops");
      if (self.ringing[alarm.id]) {
        var stopBtn = el("button", "aux-alarm-stop", "停止");
        stopBtn.type = "button";
        stopBtn.addEventListener("click", function () { self.stopRinging(alarm.id); });
        ops.appendChild(stopBtn);
      }
      var delBtn = el("button", "aux-alarm-del", "删除");
      delBtn.type = "button";
      delBtn.title = "删除闹钟";
      delBtn.addEventListener("click", function () { self.removeAlarm(alarm.id); });
      ops.appendChild(delBtn);

      item.appendChild(toggle);
      item.appendChild(body);
      item.appendChild(ops);
      self.list.appendChild(item);
    });

    var anyRinging = Object.keys(this.ringing).length > 0;
    this.stopAllBtn.hidden = !anyRinging;
  };

  AlarmsApp.prototype.daysText = function (alarm) {
    var days = alarm.repeat_days || [];
    if (!days.length) { return "每天"; }
    return days.slice().sort().map(function (d) { return WEEKDAYS[d] || "?"; }).join(" ");
  };

  // ---------------- 响铃逻辑 ----------------

  AlarmsApp.prototype.tick = function () {
    var date = nowDate();
    var minuteKey = date.getFullYear() + fmt2(date.getMonth() + 1) + fmt2(date.getDate()) +
      fmt2(date.getHours()) + fmt2(date.getMinutes());
    var today = weekdayIndex(date);
    var fired = false;
    for (var i = 0; i < this.alarms.length; i++) {
      var a = this.alarms[i];
      if (!a || a.enabled === false) { continue; }
      if (a.hour !== date.getHours() || a.minute !== date.getMinutes()) { continue; }
      var days = a.repeat_days || [];
      if (days.length && days.indexOf(today) === -1) { continue; }
      if (this.lastFired[a.id] === minuteKey) { continue; }
      this.lastFired[a.id] = minuteKey;
      this.startRinging(a);
      fired = true;
    }
    if (fired) { this.render(); }
  };

  AlarmsApp.prototype.startRinging = function (alarm) {
    if (this.ringing[alarm.id]) { return; }
    this.ringing[alarm.id] = true;
    this.beeper.startLoop();
    this.notify(alarm);
    this.render();
  };

  AlarmsApp.prototype.stopRinging = function (id) {
    if (!this.ringing[id]) { return; }
    delete this.ringing[id];
    if (Object.keys(this.ringing).length === 0) {
      this.beeper.stopLoop();
    }
    this.render();
  };

  AlarmsApp.prototype.stopAll = function () {
    this.ringing = {};
    this.beeper.stopLoop();
    this.render();
  };

  AlarmsApp.prototype.notify = function (alarm) {
    if (typeof window.Notification !== "function") { return; }
    if (window.Notification.permission !== "granted") { return; }
    try {
      var n = new window.Notification("闹钟 " + hhmm(alarm), {
        body: alarm.label || "时间到了"
      });
      n.onclick = function () {
        if (window.focus) { window.focus(); }
        n.close();
      };
    } catch (err) { /* 通知失败不影响响铃 */ }
  };

  // ---------------- 对外 ----------------

  window.Alarms = {
    init: function (rootEl) {
      if (!rootEl) { return null; }
      if (rootEl.getAttribute("data-aux-alarms") === "1") { return null; }
      return new AlarmsApp(rootEl);
    }
  };
})();
