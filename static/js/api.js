/* api.js — 前端 API 封装（window.TimeAPI，契约 §7.2）
 *
 * 所有服务端交互集中在此模块：状态轮询、IP 定位、时钟偏移校准、
 * 闹钟与用户城市持久化。失败一律抛出带 message 的 Error（ipLocation 除外，
 * 按契约返回 null）。
 *
 * 语法约束：ES2017 子集（禁 ?. / ?? / #private，无 ES module）。
 */
(function () {
  'use strict';

  var serverOffsetMs = 0;   // serverTime - clientTime，由 syncOffset 校准

  function query(params) {
    var parts = [];
    if (!params) return '';
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function fetchJSON(url, options) {
    return fetch(url, options).then(function (resp) {
      var ct = resp.headers.get('content-type') || '';
      var isJson = ct.indexOf('application/json') >= 0;
      return resp.json().catch(function () { return null; }).then(function (data) {
        if (!resp.ok) {
          var msg = data && typeof data.error === 'string' ? data.error : ('HTTP ' + resp.status);
          throw new Error(msg);
        }
        if (!isJson && (data === null || typeof data !== 'object')) {
          throw new Error('响应不是 JSON: ' + url);
        }
        return data;
      });
    });
  }

  function postJSON(url, body) {
    return fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  window.TimeAPI = {
    /* GET /api/state?lat&lon&tz&cities -> StateDict */
    getState: function (params) {
      return fetchJSON('/api/state' + query(params));
    },

    /* GET /api/ip-location -> {lat,lon,city,source} | null（失败不抛） */
    ipLocation: function () {
      return fetchJSON('/api/ip-location').then(function (data) {
        if (data && typeof data.lat === 'number' && typeof data.lon === 'number') return data;
        return null;
      }).catch(function () { return null; });
    },

    /* GET /api/healthz：用服务端时间校准本地偏移 */
    syncOffset: function () {
      return fetchJSON('/api/healthz').then(function (data) {
        if (data && typeof data.time === 'string') {
          var serverMs = Date.parse(data.time);
          if (!isNaN(serverMs)) {
            serverOffsetMs = serverMs - Date.now();
            return serverOffsetMs;
          }
        }
        return null;
      }).catch(function () { return null; });
    },

    /* 校准后的“当前时间” */
    now: function () {
      return new Date(Date.now() + serverOffsetMs);
    },

    fmt2: function (n) {
      n = Number(n);
      if (isNaN(n)) n = 0;
      return n < 10 ? '0' + n : String(n);
    },

    /* GET /api/cities -> 全量城市（供「+」选择器；契约 §5） */
    cities: function () {
      return fetchJSON('/api/cities').then(function (data) {
        return (data && data.cities) || [];
      });
    },

    alarms: {
      list: function () {
        return fetchJSON('/api/alarms').then(function (data) {
          return (data && data.alarms) || [];
        });
      },
      add: function (a) {
        return postJSON('/api/alarms', {
          hour: a.hour, minute: a.minute, label: a.label || '', repeat_days: a.repeat_days || []
        }).then(function (data) {
          if (data && data.alarm) return data.alarm;
          throw new Error('服务端未返回 alarm');
        });
      },
      toggle: function (id) {
        return fetchJSON('/api/alarms/' + encodeURIComponent(id), { method: 'PATCH' }).then(function (data) {
          if (data && data.alarm) return data.alarm;
          throw new Error('服务端未返回 alarm');
        });
      },
      remove: function (id) {
        return fetchJSON('/api/alarms/' + encodeURIComponent(id), { method: 'DELETE' });
      }
    },

    userCities: {
      get: function () {
        return fetchJSON('/api/user-cities').then(function (data) {
          return (data && data.cities) || [];
        });
      },
      set: function (ids) {
        return postJSON('/api/user-cities', { ids: ids || [] }).then(function (data) {
          return (data && data.cities) || [];
        });
      }
    }
  };
})();
