# time — 晨昏线世界时钟（静态部署版）

本目录由 `scripts/build_static.py` 生成，**勿手改**（改动 web/ 或 web-static/ 后重新生成）。

- 天文计算在浏览器本地完成（`js/solar-engine.js`，app/solar.py 的 JS 移植）；
- 接口层 `js/static-backend.js` 猴补 `window.TimeAPI`，与 Flask 版行为一致；
- 闹钟/城市选择持久化用 localStorage；定位回退链：浏览器 Geolocation → ip-api.com → 默认北京；
- 零外部 CDN/字体/图片依赖，唯一外网请求是 ip-api.com 定位（失败静默降级）。
