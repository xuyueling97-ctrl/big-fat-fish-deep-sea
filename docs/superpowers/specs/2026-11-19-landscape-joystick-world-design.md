# 《大肥鱼 · 深海吞食》横屏 + 摇杆 + 大地图 设计文档

日期：2026-11-19
状态：已确认，待实现
关联提交：本地首次发布 2fc7bc6 / README 修复 2c44b7c

## 1. 目标

1. **手机端改为横屏**：竖持时用 CSS 旋转画面 90°，配合 `screen.orientation.lock` 兜底。
2. **左下角固定摇杆**：触屏方向输入改为摇杆，冲刺仍由右下按钮负责。
3. **地图放大**：从「地图 = 视口」改为 3 屏 × 3 屏的有限世界，配跟随相机。

不改动：成长曲线、吞食判定、生命值、连击、音效、6 个体型阶段。

## 2. 世界与相机

### 2.1 坐标系

现状 `vw/vh` 既是视口也是世界尺寸，`wrap()` 用视口边界做环形绕回。改造后分成两套：

| 名称 | 含义 |
|---|---|
| `vw` / `vh` | 视口（逻辑像素，已除以 `S`） |
| `worldW` / `worldH` | 世界尺寸 = `vw * 3` / `vh * 3` |
| `cam.x` / `cam.y` | 相机左上角在世界中的坐标 |

所有实体（`player`、`enemies`、`powerups`、`particles`、`floaters`）的 `x/y` 一律为**世界坐标**。

### 2.2 尺寸重算

`resize()` 中在算出 `vw/vh` 后重算 `worldW/worldH`，并复用现有按比例迁移实体的逻辑（把 `kx/ky` 的基准从 `vw/vh` 改为 `worldW/worldH`）。相机位置同步按比例缩放。

### 2.3 相机跟随（前瞻 + 平滑）

```
lookAhead = 0.22 * vw（按速度方向投影）
targetX = player.x + cos(angle) * lookAhead * speedRatio - vw / 2
targetY = player.y + sin(angle) * lookAhead * speedRatio - vh / 2
cam.x += (targetX - cam.x) * damp(6.5, dt)
cam.y += (targetY - cam.y) * damp(6.5, dt)
cam.x = clamp(cam.x, 0, worldW - vw)
cam.y = clamp(cam.y, 0, worldH - vh)
```

`damp` 沿用 `Utils.damp`。相机钳制到世界内，因此玩家靠近世界边缘时会偏离屏幕中心——这是有意的，让玩家感到边界。

### 2.4 环形绕回

`wrap()` 的边界从 `vw/vh` 改为 `worldW/worldH`。

**关键**：玩家自身绕回时，相机必须**瞬时重排**而不是插值，否则会横跨整张地图缓慢平移。判定方式：比较绕回前后的玩家坐标，若发生跳变则按同一位移量平移 `cam`。

## 3. 渲染分层

`draw()` 改为分层绘制，区分「屏幕空间」与「世界空间」：

| 层 | 空间 | 处理 |
|---|---|---|
| 水色渐变 `drawBackground` | 屏幕 | 纯环境色，不随相机滚动 |
| 光柱 `Rays`、浮游微粒 `Motes` | 屏幕 | 氛围层，跟随滚动会显得世界空洞 |
| 海底轮廓 `drawSeafloor` | 世界底部 | 绘制在 `cam.y + vh` 处，游到深处才可见 |
| 鱼群、粒子、飘字、道具 | 世界 | `g.translate(-cam.x, -cam.y)` 后绘制 |
| 暗角 `drawVignette`、危险红晕 | 屏幕 | 后处理 |

### 3.1 视口裁剪

敌鱼数量提升后必须裁剪，否则性能与画面都会被屏幕外的实体拖累。

- `drawEnemies`：跳过 `e.x + e.r < cam.x` / `e.x - e.r > cam.x + vw` 等四条边界外的实体
- 粒子、飘字同理
- 排序逻辑保留（原地按半径排序）

## 4. 摇杆

### 4.1 结构与样式

- DOM 元素 `#stick`，内含底盘 `.stick__base` 与摇杆头 `.stick__knob`
- 仅在 `body.is-touch` 显示；左下角固定，考虑安全区 `env(safe-area-inset-*)`
- 底盘直径约 136px（触屏下），摇杆头约 56px
- 视觉风格与现有 `.dash-btn` 保持一致（半透明、圆角、发光边框）

### 4.2 输入语义

新增 `pointer.mode === 'stick'`，`updatePlayer` 中：

```
nx = stick.dx, ny = stick.dy   // 已归一化的方向
力度 = clamp(距离 / 底盘半径, 0, 1)
死区 15%：距离 < 0.15 * 底盘半径 时视为无输入
```

输出用「方向 × 力度」而非纯单位向量，让玩家能微调速度（与现有拖拽的 `ease` 语义一致）。

### 4.3 与拖拽并存

保留画布上的相对拖拽作为备选输入：手指按在摇杆**之外**的区域仍可拖拽移动。理由：
- 多一种操作方式，不会让老玩家困惑
- 现有测试的拖拽断言可保留，降低回归风险

按下摇杆区域时**不触发**画布拖拽（事件在摇杆元素上 `stopPropagation`）。

### 4.4 冲刺

仍然只由右下角 `.dash-btn` 触发。摇杆不参与冲刺。

## 5. 强制横屏

### 5.1 CSS 旋转

触屏设备竖持时，把 `#stage` 旋转 90°：

```css
@media (orientation: portrait) {
  body.is-touch #stage {
    position: fixed;
    width: 100vh;
    height: 100vw;
    transform: rotate(90deg) translateY(-100%);
    transform-origin: top left;
  }
}
```

### 5.2 尺寸取值

不能用 `getBoundingClientRect()` 取尺寸——旋转后它返回轴对齐包围盒，宽高会颠倒。改用 `offsetWidth` / `offsetHeight`（布局尺寸，不受 transform 影响）。

### 5.3 指针坐标反解

旋转 90° 后，屏幕坐标到画布局部坐标的换算：

```
lx = clientY - rect.top
ly = rect.width - (clientX - rect.left)
```

`rect` 仍需来自 `getBoundingClientRect()`，但只取其原点与宽高关系，不当作未旋转矩形使用。实现时以实测为准，不靠推理。

### 5.4 方向锁定

尝试 `screen.orientation.lock('landscape')` 并在全屏状态下调用。Android 有效，iOS Safari 不支持——此时靠 CSS 旋转兜底，玩家手感一致。

## 6. 数值配套

| 项目 | 现状 | 调整 |
|---|---|---|
| 敌鱼目标数 | `14 + min(10, elapsed/22)` | `(14 + min(10, elapsed/22)) * 4.5`，上限 96 |
| 开局刷鱼 | 全屏随机 | 60% 落在玩家 1 屏范围内 |
| 补充猎物 | 玩家 190~420 距离 | 保持，但改为世界坐标下判定 |
| 道具刷新 | 全屏随机（≥2 个不再刷） | 玩家 1 屏范围内随机 |
| 道具上限 | 2 | 3（大地图需要更多补给） |

## 7. 涉及文件

| 文件 | 改动 |
|---|---|
| `js/game.js` | 世界尺寸、相机、`wrap` 边界、摇杆输入分支、生成逻辑、渲染分层 |
| `js/render.js` | `drawSeafloor` 支持世界坐标偏移 |
| `js/main.js` | 摇杆事件、旋转坐标换算、`resize` 尺寸取值 |
| `style.css` | 摇杆样式、旋转规则、横屏布局微调 |
| `index.html` | 摇杆 DOM 结构 |
| `tests/mobile.js` | 摇杆断言；保留拖拽断言 |
| `README.md` | 操作说明改为摇杆 + 横屏 |

## 8. 验证标准

1. 无头浏览器 6 设备视口：`isTouchMode` 为真、HUD 与摇杆/冲刺按钮均在视口内、无滚动条
2. 摇杆：模拟触摸拖动，玩家位移方向与拖动方向一致，松手后停止
3. 相机：玩家移动时世界跟随滚动，玩家靠近世界边缘时相机停止并贴边
4. 环形绕回：玩家越过世界边缘后从对面出现，且画面不出现横跨地图的平移
5. 旋转：竖屏视口下点击摇杆与冲刺按钮，命中判定正确
6. 可玩性：自动驾驶 900 步，得分与体型成长正常
7. 性能：`tests/bench.js` 帧耗时仍在 16.7ms 预算内
8. 控制台零报错

## 9. 风险

**旋转状态下的指针坐标换算是最高风险点**。错一处会导致摇杆和按钮点不准。验证方式：在无头浏览器中用竖屏视口实测点击坐标与实际命中的 DOM 元素，不依赖推理。
