# time · 无世界时钟

> 全屏世界时钟：实时晨昏线 + 秒级时钟 + 四级定位
>
> Fullscreen world clock with a live day/night terminator, second-level clock and 4-level geolocation

English intro at the bottom: [English](#english)

**在线使用：https://forjiang.github.io/time/**

全屏等距圆柱投影世界地图上，一条白色晨昏线随太阳实时移动：夜半球压 55% 暗幕，民用蒙影带（太阳高度 0° → −6°）逐像素渐变过渡。页面中央是不漂移的秒级时钟，按定位时区显示；下方两行信息：定位地与时区、日出/日落/昼长。纯静态部署，无任何服务端。

## 功能特性

| | |
| --- | --- |
| **全屏世界地图** | 等距圆柱投影（cover 适配）：黑海、深灰陆地（内置手绘轮廓 `data/world_land.json`，约 141KB）、每 30° 一条经线网格 |
| **实时晨昏线** | 按经度列（每列 1°）解算太阳高度 0° 与 −6° 两条曲线；白色 1.5px 柔光线 + 夜幕 + 蒙影渐变带，每秒重绘 |
| **居中秒级时钟** | 按定位时区用 `Intl.DateTimeFormat` 显示 HH:MM:SS；每次 tick 校准到下一个整秒边界（递归 `setTimeout`），长期不漂移；后台标签页被节流后回前台立即补刷 |
| **四级定位回退** | ① 浏览器 Geolocation 高精度（超时降精度重试一次，拒绝授权不重试）→ ② IP 定位（get.geojs.io，HTTPS，进程内缓存 10 分钟）→ ③ 浏览器时区查内置 265 个 IANA 时区坐标表 → ④ 默认北京 |
| **日出日落信息行** | 日出 / 日落 / 昼长；极昼显示 `24:00`（Midnight sun）、极夜显示 `00:00`（Polar night） |
| **橙色脉冲定位标记** | 扩散环 + 中心点由 rAF 驱动；`prefers-reduced-motion: reduce` 时停用 |
| **PWA 可安装** | manifest + Service Worker（`sw.js`），可添加到主屏幕、离线可用 |
| **优雅降级** | 陆地数据加载失败 → 只显示经纬网格与晨昏线，功能不受影响；`Intl` 不可用 → 按 UTC 偏移回退显示 |
| **隐私** | 无追踪、无日志、无 Cookie；唯一的对外请求是第②级 IP 定位（失败自动落到时区推断） |

## 它是怎么工作的

```
浏览器（纯静态站点，GitHub Pages）
 ├─ app.js        启动编排：时钟先行 → 地图延后初始化 → 拉陆地数据 → 请求定位 → 1Hz 轮询刷新
 ├─ solar-engine.js  天文引擎：Meeus《Astronomical Algorithms》第 25 章太阳视位置的逐函数 JS 移植，
 │                   与 Python 原始实现同算法、同 IEEE754 双精度、同运算顺序，期望一致到 ~1e-9；
 │                   儒略日全程整数运算（天 + 微秒），复现 Python 的取模/舍入语义（半数取偶等）
 ├─ map.js        渲染：底图/场景两张离屏画布，1Hz 只重建场景层；DPR 适配，resize 重建
 ├─ static-backend.js  静态版"服务端"：在浏览器本地组装状态字典，镜像 Python 版的四级定位回退链
 ├─ api.js        window.TimeAPI 契约层：任何失败返回 null，绝不抛到调用方
 └─ sw.js         Service Worker 离线缓存
```

> Python 服务端版（`app/solar.py` / `app/server.py` / `app/geo.py`，Flask + 同一 Meeus 算法的原始实现）不在本仓库；本仓库是它的纯静态 JS 移植部署版，天文数值与 Python 版逐项同口径。

## 文件结构

```
time/
├── index.html              # 页面骨架：地图画布 + 时钟 + 两行信息
├── sw.js                   # Service Worker 离线缓存
├── manifest.json           # PWA 清单（standalone，黑色主题）
├── data/world_land.json    # 手绘陆地轮廓（多边形集合）
└── static/
    ├── css/style.css       # 样式
    └── js/
        ├── solar-engine.js    # Meeus 太阳算法 JS 移植（太阳位置/晨昏线/日出日落/昼长）
        ├── tz-coords.js       # 265 个 IANA 时区坐标表（构建产物，勿手改）
        ├── static-backend.js  # 静态版"服务端"：状态组装 + 四级定位链
        ├── api.js             # TimeAPI 契约层
        ├── map.js             # 全屏地图 + 夜/蒙影/晨昏线渲染
        └── app.js             # 启动编排 + 秒边界时钟 + 定位升级 + 1Hz 轮询
```

## 本地运行

任一静态服务器均可（必须 `http://` 打开，`file://` 会被浏览器安全策略拦住）：

```bash
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000
```

## License

GPL-3.0 © 2026 ForJiang — [github.com/ForJiang](https://github.com/ForJiang) · [forjiang.github.io](https://forjiang.github.io)

---

## English

**time** is a fullscreen world clock: a live day/night terminator drawn across a hand-drawn world map, a drift-free seconds-precision clock in the center, and 4-level location fallback — deployed as a fully static site on GitHub Pages, no server involved.

Live: **https://forjiang.github.io/time/**

### Highlights

- **Fullscreen equirectangular map** — black sea, dark-gray hand-drawn land polygons (`data/world_land.json`, ~141 KB), 30° meridian grid.
- **Real-time terminator** — solved per longitude column (1° step) as two curves: solar elevation 0° and −6° (civil twilight). White glowing 1.5 px line, 55% night shading, per-pixel twilight gradient, redrawn every second.
- **Centered second-level clock** — shown in the located time zone via `Intl.DateTimeFormat`; each tick recalibrates to the next second boundary (recursive `setTimeout`), so it never drifts; instantly resyncs when a throttled background tab returns to the foreground.
- **4-level location fallback** — ① browser Geolocation, high accuracy (one lower-accuracy retry on timeout; no retry on permission denial) → ② IP geolocation via get.geojs.io (HTTPS, cached in-process for 10 minutes) → ③ browser time zone looked up in a built-in table of 265 IANA zones → ④ default to Beijing.
- **Sunrise line** — sunrise / sunset / day length; polar day shows `24:00` (Midnight sun), polar night `00:00` (Polar night).
- **Orange pulsing location marker** — rAF-driven expanding ring; disabled under `prefers-reduced-motion: reduce`.
- **Installable PWA** — manifest + service worker; works offline once cached.
- **Graceful degradation** — missing land data falls back to grid + terminator only; missing `Intl` falls back to UTC-offset formatting.

### How it works

`solar-engine.js` is a function-by-function JS port of the Python solar engine (Meeus, *Astronomical Algorithms*, ch. 25): same algorithm, same IEEE754 double precision, same operation order — expected agreement to ~1e-9. Julian days use integer math (days + microseconds), and Python semantics (non-negative modulo, banker's rounding) are reproduced exactly. The Python server edition (`app/solar.py` / `app/server.py` / `app/geo.py`) is not in this repository — this repo is its pure-static JS deployment mirror with identical numeric behavior.

`static-backend.js` assembles the state dict locally in the browser, mirroring the Python edition's 4-level location fallback chain. `api.js` is the `window.TimeAPI` contract layer — any failure resolves to `null`, never thrown to callers.

### Local run

```bash
python3 -m http.server 8000
# open http://127.0.0.1:8000
```

### License

GPL-3.0 © 2026 ForJiang — [GitHub](https://github.com/ForJiang) · [Website](https://forjiang.github.io)
