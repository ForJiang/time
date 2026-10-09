/* static-api.js — 静态部署版 window.TimeAPI（契约 §6.2 同接口）
 *
 * 与 Flask 版 api.js 的差异只有取数来源：getState 不再 fetch /api/state，
 * 而是调用 window.StaticBackend.buildState 在浏览器本地组装 StateDict
 * （天文计算由 solar-engine.js 完成，定位链由 static-backend.js 完成）。
 * now() 用设备本地时钟（静态版无服务端可校准偏移）。
 * 任何失败返回 null（与 Flask 版网络失败语义一致），绝不抛到调用方。
 */
(function () {
  'use strict';

  function getState(params) {
    return window.StaticBackend.buildState(params || {}).then(function (st) {
      return st;
    }).catch(function () {
      return null;
    });
  }

  function now() {
    return new Date();
  }

  function fmt2(n) {
    n = Math.floor(Number(n));
    if (!isFinite(n) || n < 0) n = 0;
    if (n > 99) n = 99;
    return n < 10 ? '0' + n : '' + n;
  }

  window.TimeAPI = {
    getState: getState,
    now: now,
    fmt2: fmt2
  };
})();
