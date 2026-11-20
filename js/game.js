/* 《大肥鱼 · 深海吞食》核心玩法
   坐标系：世界坐标（未缩放），绘制时统一乘以 scale 适配屏幕 */
class BigFatFish {
  static get START_R() { return 13; }
  static get MAX_R() { return 62; }

  // 地图按「屏」计：3x3 屏的世界，探索感足够又不至于找不到鱼
  static get WORLD_SCREENS() { return 3; }

  // 同时全速追击玩家的掠食者上限，避免后期被多条大鱼无解围死
  static get MAX_CHASERS() { return 2; }

  // 掠食者速度上限（相对玩家基础速度）。略高于 1 才有压迫感，
  // 但必须留出被甩开的可能，否则玩家没有操作空间。
  static get PREDATOR_SPEED_CAP() { return 1.06; }

  // 致命鱼在鱼群里的占比上限。玩家永远吃不到它们，不设配额的话
  // 每吃掉一条小鱼都会按同样的概率补进一条大鱼，占比会一路涨到一半以上，
  // 大后期就变成"整片海都是比你大的鱼"，被围攻时无路可走。
  static get LETHAL_RATIO() { return 0.3; }

  // 受伤时把周围大鱼震开的半径，给玩家留出脱离包围的窗口
  static get HURT_PUSH_RADIUS() { return 240; }

  // 冲击波在最内圈把大鱼推开的距离（按距离线性衰减到 0）
  static get HURT_PUSH_DIST() { return 170; }

  static get STAGES() {
    return [
      { at: 0.00, name: '鱼苗' },
      { at: 0.17, name: '小鱼' },
      { at: 0.34, name: '中鱼' },
      { at: 0.52, name: '大鱼' },
      { at: 0.72, name: '巨鱼' },
      { at: 0.90, name: '深海之王' },
    ];
  }

  constructor(canvas, dom) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.dom = dom || {};

    this.dpr = 1;
    this.S = 1;
    this.w = 1;
    this.h = 1;
    this.vw = 1;
    this.vh = 1;
    // 世界比视口大：玩家在大地图里游，相机只跟随其中一块
    this.worldW = 1;
    this.worldH = 1;
    this.cam = { x: 0, y: 0 };

    this.state = 'menu';
    this.t = 0;
    this.elapsed = 0;
    this.shake = 0;
    this.threatLevel = 0;

    this.motes = new Render.Motes(110);
    this.rays = new Render.Rays();

    this.player = null;
    this.enemies = [];
    this.particles = [];
    this.floaters = [];
    this.powerups = [];

    this.keys = new Set();
    this.pointer = { x: 0, y: 0, active: false, mode: 'pointer' };
    this.drag = { active: false, ox: 0, oy: 0, dx: 0, dy: 0 };
    // 摇杆：nx/ny 为归一化方向，mag 为力度 0..1
    this.stick = { active: false, nx: 0, ny: 0, mag: 0 };
    this.isTouch = false;
    // 彩蛋开关由 main.js 写入（开始界面连点标题解锁），只影响每局开局的一条锦鲤
    this.eggUnlocked = false;

    this.best = this.loadBest();
    this.onHud = null;
    this.onState = null;
    this.onOver = null;

    this.resize();
    this.reset();
  }

  /* ================= 生命周期 ================= */

  loadBest() {
    try { return parseInt(localStorage.getItem('bigfatfish.best') || '0', 10) || 0; }
    catch (e) { return 0; }
  }

  saveBest(v) {
    try { localStorage.setItem('bigfatfish.best', String(v)); } catch (e) { /* 忽略 */ }
  }

  resize() {
    // 注意：旋转状态下 getBoundingClientRect() 返回的是轴对齐包围盒，宽高会颠倒，
    // 所以这里必须用 offsetWidth/offsetHeight 取布局尺寸。
    const rect = this.canvas.getBoundingClientRect();
    const layoutW = this.canvas.offsetWidth;
    const layoutH = this.canvas.offsetHeight;
    const w = Math.max(1, Math.round(layoutW || rect.width || window.innerWidth));
    const h = Math.max(1, Math.round(layoutH || rect.height || window.innerHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextW = Math.round(w * dpr);
    const nextH = Math.round(h * dpr);

    // 给 canvas.width/height 赋值（哪怕赋的是同一个数）会清空整个位图。
    // 主循环 frame() 在上一帧末尾就重新注册了自己，rAF 批次里总排在最前；
    // 事件回调里注册的 resize 排在它后面，于是同一帧内变成「先 draw 再清空」，
    // 合成出去就是一帧全黑 —— 这就是点摇杆/冲刺按钮时「黑屏一瞬间」。
    // 所以尺寸没变时绝不能碰 canvas.width/height。
    const bitmapChanged = this.canvas.width !== nextW || this.canvas.height !== nextH;

    this.w = w;
    this.h = h;
    this.dpr = dpr;

    const oldS = this.S;
    const oldVw = this.vw;
    const S = Utils.clamp(Math.min(w, h) / 620, 0.5, 1.8);

    // 布局与缩放都没变化：位图不用重建，世界也不用迁移，直接返回
    if (!bitmapChanged && S === oldS) return;

    if (bitmapChanged) {
      this.canvas.width = nextW;
      this.canvas.height = nextH;
    }

    // 以短边为基准缩放，保证不同屏幕下鱼的大小比例一致
    this.S = S;
    this.vw = w / this.S;
    this.vh = h / this.S;

    const oldWorldW = this.worldW;
    const oldWorldH = this.worldH;
    this.worldW = this.vw * BigFatFish.WORLD_SCREENS;
    this.worldH = this.vh * BigFatFish.WORLD_SCREENS;

    // 按比例迁移已有实体的位置（含相机），避免改窗口大小后世界错位
    if (oldWorldW > 1 && oldWorldH > 1 && (oldWorldW !== this.worldW || oldWorldH !== this.worldH)) {
      const kx = this.worldW / oldWorldW;
      const ky = this.worldH / oldWorldH;
      const all = [this.player, ...this.enemies, ...this.powerups].filter(Boolean);
      for (const e of all) { e.x *= kx; e.y *= ky; }
      for (const p of this.particles) { p.x *= kx; p.y *= ky; }
      for (const f of this.floaters) { f.x *= kx; f.y *= ky; }
      this.cam.x *= kx;
      this.cam.y *= ky;
    } else if (oldVw <= 1) {
      this.snapCamera();
    }
  }

  /* ================= 相机 ================= */

  /* 把任意差值折回 [-size/2, size/2)，用于环形世界的最短路径计算与渲染定位 */
  wrapDelta(d, size) {
    return d - Math.round(d / size) * size;
  }

  /* 环形世界下的两点实际距离（跨边缘时取更近的那一侧） */
  ringDist(ax, ay, bx, by) {
    const dx = this.wrapDelta(bx - ax, this.worldW);
    const dy = this.wrapDelta(by - ay, this.worldH);
    return Math.hypot(dx, dy);
  }

  /* 相机目标：玩家居中，并按移动方向做前瞻偏移，让前方水域多露出来一些。
     世界是环形的，所以相机不做边界钳制——越钳制越会在穿越处产生跳变。 */
  cameraTarget() {
    const p = this.player;
    if (!p) return { x: 0, y: 0 };
    const ahead = Math.min(this.vw, this.vh) * 0.22 * p.speedRatio;
    return {
      x: p.x + Math.cos(p.angle) * ahead - this.vw * 0.5,
      y: p.y + Math.sin(p.angle) * ahead - this.vh * 0.5,
    };
  }

  /* 立即对齐相机（开局、尺寸变化时用，避免插值造成长距离平移） */
  snapCamera() {
    const t = this.cameraTarget();
    this.cam.x = t.x;
    this.cam.y = t.y;
  }

  updateCamera(dt) {
    const t = this.cameraTarget();
    const k = Utils.damp(6.5, dt);
    // 走最短路径：玩家绕过边缘时相机跟着跨过去，而不是倒着横穿整张地图
    this.cam.x += this.wrapDelta(t.x - this.cam.x, this.worldW) * k;
    this.cam.y += this.wrapDelta(t.y - this.cam.y, this.worldH) * k;
    // 把相机折回玩家所在的世界带。相机插值只会收敛到「相差整张地图」的等价解，
    // 不归一化的话 cam 会一直停在另一个世界带里，setPointer 的世界坐标反算就会差一整圈。
    const p = this.player;
    if (p) {
      this.cam.x = p.x + this.wrapDelta(this.cam.x - p.x, this.worldW);
      this.cam.y = p.y + this.wrapDelta(this.cam.y - p.y, this.worldH);
    }
  }

  /* 世界坐标 → 屏幕坐标（环形折叠，只返回视野内最近的那一份） */
  toScreenX(x) { return this.wrapDelta(x - this.cam.x, this.worldW); }
  toScreenY(y) { return this.wrapDelta(y - this.cam.y, this.worldH); }

  reset() {
    this.enemies = [];
    this.particles = [];
    this.floaters = [];
    this.powerups = [];
    // 输入状态必须清空：菜单待机会留下 pointer.active 与旧的世界坐标，
    // 不清掉的话开局鱼会自己朝那个陈旧目标游过去。
    this.pointer.active = false;
    this.pointer.mode = 'pointer';
    this.keys.clear();
    this.drag.active = false;
    this.drag.dx = 0;
    this.drag.dy = 0;
    this.stick.active = false;
    this.stick.nx = 0;
    this.stick.ny = 0;
    this.stick.mag = 0;
    this.elapsed = 0;
    this.shake = 0;
    this.threatLevel = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.score = 0;
    this.eats = 0;
    this.lives = 3;
    this.spawnTimer = 0;
    this.powerTimer = Utils.rand(9, 14);
    this._lastStage = 0;

    this.player = {
      x: this.worldW * 0.5,
      y: this.worldH * 0.5,
      vx: 0,
      vy: 0,
      r: BigFatFish.START_R,
      angle: 0,
      dirRight: true,
      hue: 168,
      bulge: 1,
      phase: 0,
      wobSpeed: 7,
      mouth: 0,
      speedRatio: 0,
      baseSpeed: 306,
      dashCd: 0,
      dashTime: 0,
      invincible: 0,
      magnet: 0,
      shield: 0,
      eatPulse: 0,
      alive: true,
    };

    // 世界放大到 9 屏后，只刷十几条鱼会显得整片海是空的。
    // 开局先铺满目标密度的 7 成，其余交给 updateSpawns 逐步补足（约 10 秒填满），
    // 既避免开局空旷，也不会一次性生成上百条拖慢首帧。
    const initial = Math.max(15, Math.round(this.enemyTargetCount() * 0.7));
    for (let i = 0; i < initial; i++) this.spawnEnemy(true);
    // 彩蛋：解锁后每局开场白送一条金鳞锦鲤（吃掉给一笔额外分数）
    if (this.eggUnlocked) this.spawnGoldenKoi();
    this.snapCamera();
  }

  /* 金鳞锦鲤：不参与普通刷怪，也不受"太小的鱼淡出"规则影响 */
  spawnGoldenKoi() {
    const p = this.player;
    const e = {
      x: p.x,
      y: p.y,
      vx: 0, vy: 0,
      r: BigFatFish.START_R * 0.62,
      baseHue: 45,
      hue: 45,
      threat: 0,
      angle: Utils.rand(0, Utils.TAU),
      dirRight: true,
      bulge: 1.16,
      phase: Utils.rand(0, Utils.TAU),
      wobSpeed: Utils.rand(4, 6),
      wander: Utils.rand(0, Utils.TAU),
      speed: 78,
      speedRatio: 0,
      age: 0,
      alpha: 1,
      fadeIn: false,
      mouth: 0,
      tailSwing: 0,
      golden: true,
    };
    this.placeNearPlayer(e, 200, 320);
    this.enemies.push(e);
    return e;
  }

  start() {
    this.state = 'playing';
    this.reset();
    if (this.onState) this.onState('playing');
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    if (this.onState) this.onState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    if (this.onState) this.onState('playing');
  }

  gameOver() {
    this.state = 'over';
    this.player.alive = false;
    this.burst(this.player.x, this.player.y, 26, 168, 1.7);
    if (this.score > this.best) {
      this.best = Math.round(this.score);
      this.saveBest(this.best);
    }
    if (this.onState) this.onState('over');
    if (this.onOver) {
      this.onOver({
        score: Math.round(this.score),
        best: this.best,
        eats: this.eats,
        stage: this.stageName(),
      });
    }
  }

  /* ================= 生成 ================= */

  stageIndex() {
    const p = this.player;
    if (!p) return 0;
    const f = (p.r - BigFatFish.START_R) / (BigFatFish.MAX_R - BigFatFish.START_R);
    const st = BigFatFish.STAGES;
    let idx = 0;
    for (let i = 0; i < st.length; i++) if (f >= st[i].at) idx = i;
    return idx;
  }

  stageName() {
    return BigFatFish.STAGES[this.stageIndex()].name;
  }

  /* 场上致命鱼（比玩家大、撞到会掉命）的条数 */
  lethalCount() {
    const p = this.player;
    if (!p) return 0;
    let n = 0;
    for (const e of this.enemies) if (!e.dead && e.r >= p.r * 1.18) n++;
    return n;
  }

  /* 致命鱼配额：按鱼群目标数量的比例给一个硬上限 */
  lethalCap() {
    return Math.max(3, Math.round(this.enemyTargetCount() * BigFatFish.LETHAL_RATIO));
  }

  spawnEnemy(anywhere, forceEdible) {
    const p = this.player;
    const baseR = p ? p.r : BigFatFish.START_R;
    // 致命鱼已经满额时，新刷的一律是可吃的鱼。
    // 玩家永远吃不掉大鱼，所以这里必须挡一道，否则大鱼会越积越多。
    const lethalFull = !forceEdible && this.lethalCount() >= this.lethalCap();
    const roll = Math.random();
    // 开局少一些"巨物"，随游戏进程逐步提高压迫感
    const ramp = Utils.clamp(this.elapsed / 75, 0, 1);
    const giantCut = 0.97 + ramp * 0.06;
    let frac;
    if (forceEdible) {
      frac = Utils.rand(0.34, 0.86);
    } else if (lethalFull) {
      frac = Utils.rand(0.34, 0.98);
    } else if (roll < 0.52) {
      frac = Utils.rand(0.34, 0.92);
    } else if (roll < 0.80) {
      frac = Utils.rand(1.20, 1.72);
    } else if (roll < giantCut) {
      frac = Utils.rand(0.92, 1.20);
    } else {
      frac = Utils.rand(1.72, 2.4);
    }

    let r = Utils.clamp(baseR * frac, 5, BigFatFish.MAX_R * 1.75);
    // 困难度用时间推导，不能用 enemyTargetCount()。
    // 后者在改成大地图后返回的是"鱼的数量"（63~96），拿它当困难度会把鱼速放大到 3.8 倍，
    // 导致掠食者比玩家还快，一局撑不过 40 秒。
    const diff = this.difficultyIndex();

    let x;
    let y;
    let tries = 0;
    do {
      x = Utils.rand(r, Math.max(r + 1, this.worldW - r));
      y = Utils.rand(r, Math.max(r + 1, this.worldH - r));
      tries++;
    } while (p && tries < 24 && this.ringDist(x, y, p.x, p.y) < 190);

    const coolHue = Utils.rand(150, 315);
    const e = {
      x, y,
      vx: 0, vy: 0,
      r,
      baseHue: coolHue,
      hue: coolHue,
      threat: 0,
      angle: Utils.rand(0, Utils.TAU),
      dirRight: true,
      bulge: Utils.rand(0.86, 1.12),
      phase: Utils.rand(0, Utils.TAU),
      wobSpeed: Utils.rand(5, 9),
      wander: Utils.rand(0, Utils.TAU),
      speed: Utils.rand(52, 96) * (1 + diff * 0.045),
      speedRatio: 0,
      age: 0,
      alpha: 0,
      fadeIn: true,
      mouth: 0,
      tailSwing: 0,
    };
    if (anywhere) {
      e.alpha = 1;
      e.fadeIn = false;
      // 开局：大部分鱼刷在玩家附近，避免大地图一开始满眼空旷
      if (p && Math.random() < 0.6) {
        this.placeNearPlayer(e, 190, 520);
      }
    } else if (forceEdible && p && Math.random() < 0.55) {
      // 补充猎物时优先出现在玩家附近的可视范围内
      this.placeNearPlayer(e, 190, 420);
    } else {
      // 从当前视野边缘外围游入（相对相机，不是相对世界边界）
      const edge = Utils.randInt(0, 3);
      const cx = this.cam.x;
      const cy = this.cam.y;
      if (edge === 0) { e.x = cx - r * 1.4; e.y = Utils.rand(cy, cy + this.vh); }
      else if (edge === 1) { e.x = cx + this.vw + r * 1.4; e.y = Utils.rand(cy, cy + this.vh); }
      else if (edge === 2) { e.x = Utils.rand(cx, cx + this.vw); e.y = cy - r * 1.4; }
      else { e.x = Utils.rand(cx, cx + this.vw); e.y = cy + this.vh + r * 1.4; }
      this.wrapPos(e);
    }
    this.enemies.push(e);
    return e;
  }

  /* 把实体放到玩家周围一段距离内，并保证落在世界范围内（环形世界，用取模而非钳制） */
  placeNearPlayer(e, minD, maxD) {
    const p = this.player;
    const ang = Utils.rand(0, Utils.TAU);
    const dist = Utils.rand(minD, maxD);
    e.x = p.x + Math.cos(ang) * dist;
    e.y = p.y + Math.sin(ang) * dist;
    this.wrapPos(e);
  }

  /* 只把坐标折回世界范围，不处理相机（用于生成阶段的坐标归位） */
  wrapPos(e) {
    // 必须与 wrapDelta/toScreen 用同一个周期（worldW），否则实体的「逻辑位置」
    // 和渲染时的「屏幕位置」会按不同周期折叠，穿越边界时凭空多跳 2m 像素。
    e.x -= Math.floor(e.x / this.worldW) * this.worldW;
    e.y -= Math.floor(e.y / this.worldH) * this.worldH;
  }

  /* 困难度索引：只随游戏时长增长（14 → 24），与鱼的数量无关。
     鱼速、鱼群规模都要基于这个值推导，不要再各自读取别的量。 */
  difficultyIndex() {
    return 14 + Math.min(10, Math.floor(this.elapsed / 22));
  }

  enemyTargetCount() {
    // 世界放大到 9 屏，鱼的数量也要跟上，否则大地图会空得离谱
    return Math.min(96, Math.round(this.difficultyIndex() * 4.5));
  }

  spawnPowerup() {
    if (this.powerups.length >= 3) return;
    const kinds = ['glow', 'magnet', 'shield'];
    const kind = Utils.pick(kinds);
    const p = this.player;
    // 大地图里道具必须刷在玩家附近，否则永远遇不到
    for (let i = 0; i < 18; i++) {
      const ang = Utils.rand(0, Utils.TAU);
      const dist = Utils.rand(160, Math.min(this.vw, this.vh) * 0.85);
      const x = p.x + Math.cos(ang) * dist;
      const y = p.y + Math.sin(ang) * dist;
      const u = { kind, x, y, r: 13, life: 13, maxLife: 13, phase: Utils.rand(0, Utils.TAU), born: 0 };
      this.wrapPos(u);
      if (this.ringDist(u.x, u.y, p.x, p.y) > 130) {
        this.powerups.push(u);
        return u;
      }
    }
    return null;
  }

  /* ================= 特效 ================= */

  burst(x, y, n, hue, power) {
    const p = power || 1;
    for (let i = 0; i < n; i++) {
      const a = Utils.rand(0, Utils.TAU);
      const sp = Utils.rand(30, 170) * p;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: Utils.rand(1.1, 3.4) * p,
        life: Utils.rand(0.45, 0.95),
        maxLife: 0.95,
        hue: hue + Utils.rand(-16, 16),
        kind: Math.random() < 0.65 ? 'bubble' : 'spark',
        drag: Utils.rand(1.6, 3.2),
      });
    }
  }

  ribbon(x, y, hue) {
    this.particles.push({
      x, y,
      vx: Utils.rand(-8, 8),
      vy: Utils.rand(-8, 8),
      r: Utils.rand(2.5, 5.5),
      life: 0.55,
      maxLife: 0.55,
      hue,
      kind: 'trail',
      drag: 2.4,
    });
  }

  floater(x, y, text, color, size) {
    this.floaters.push({
      x, y, text,
      color: color || '#ffd76e',
      size: size || 15,
      life: 0.95,
      maxLife: 0.95,
      vy: -46,
    });
  }

  /* ================= 输入 ================= */

  setPointer(x, y) {
    // 传入的是画布局部坐标（逻辑像素），转成世界坐标。
    // 相机可能与玩家相差整张地图（环形世界的等价解），所以按最短路径相对玩家折算，
    // 否则鼠标放在鱼身上时反算出的目标点会差一整圈，鱼会朝固定方向一直游。
    let wx = x / this.S + this.cam.x;
    let wy = y / this.S + this.cam.y;
    const p = this.player;
    if (p) {
      wx = p.x + this.wrapDelta(wx - p.x, this.worldW);
      wy = p.y + this.wrapDelta(wy - p.y, this.worldH);
    }
    this.pointer.x = wx;
    this.pointer.y = wy;
    this.pointer.active = true;
    this.pointer.mode = 'pointer';
  }

  /* 触屏相对拖拽：手指按下处为原点，拖动方向与距离决定游动方向。
     这样手指永远不会挡住鱼身，也不会被误认为"瞬移到手指位置"。 */
  beginDrag(x, y) {
    this.drag.active = true;
    this.drag.ox = x;
    this.drag.oy = y;
    this.drag.dx = 0;
    this.drag.dy = 0;
    this.pointer.mode = 'drag';
  }

  moveDrag(x, y) {
    if (!this.drag.active) return;
    this.drag.dx = x - this.drag.ox;
    this.drag.dy = y - this.drag.oy;
  }

  endDrag() {
    this.drag.active = false;
    this.drag.dx = 0;
    this.drag.dy = 0;
    if (this.state !== 'playing') this.pointer.mode = 'pointer';
  }

  /* 摇杆输入：dx/dy 是相对底盘中心的位移（像素），radius 是底盘半径。
     死区 15%，超出半径按满力处理。 */
  setStick(dx, dy, radius) {
    const dist = Math.hypot(dx, dy);
    const dead = radius * 0.15;
    if (dist <= dead) {
      this.stick.active = false;
      this.stick.nx = 0;
      this.stick.ny = 0;
      this.stick.mag = 0;
      return;
    }
    const mag = Math.min(1, dist / radius);
    this.stick.active = true;
    this.stick.nx = dx / dist;
    this.stick.ny = dy / dist;
    this.stick.mag = mag;
    this.pointer.mode = 'stick';
  }

  releaseStick() {
    this.stick.active = false;
    this.stick.nx = 0;
    this.stick.ny = 0;
    this.stick.mag = 0;
    if (this.pointer.mode === 'stick') this.pointer.mode = 'pointer';
  }

  setKey(code, down) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    if (down) this.pointer.mode = 'keys';
    else if (this.keys.size === 0) this.pointer.mode = 'pointer';
  }

  dash() {
    const p = this.player;
    if (this.state !== 'playing' || !p || p.dashCd > 0) return false;
    p.dashCd = 1.65;
    p.dashTime = 0.28;
    p.invincible = Math.max(p.invincible, 0.32);
    Sfx.dash();
    this.burst(p.x, p.y, 8, p.hue, 0.8);
    return true;
  }

  /* ================= 更新 ================= */

  update(dt) {
    this.t += dt;
    this.motes.update(dt, this.t);

    const running = this.state === 'playing';
    if (running) this.elapsed += dt;

    if (running || this.state === 'menu') this.updatePlayer(dt, running);
    this.updateEnemies(dt, running);
    this.updateParticles(dt, running);
    this.updatePowerups(dt, running);
    this.updateFloaters(dt);

    if (running) this.updateSpawns(dt);

    this.updateCamera(dt);
    this.shake = Math.max(0, this.shake - dt * 26);
  }

  updatePlayer(dt, running) {
    const p = this.player;
    if (!p) return;

    let nx = 0;
    let ny = 0;

    if (this.state === 'menu') {
      // 待机演示：沿李萨如曲线巡游（围绕世界中心，让相机也跟着动起来）
      const tt = this.t * 0.34;
      this.pointer.active = true;
      this.pointer.x = this.worldW * 0.5 + Math.cos(tt) * this.vw * 0.34;
      this.pointer.y = this.worldH * 0.5 + Math.sin(tt * 1.27) * this.vh * 0.28;
      this.pointer.mode = 'pointer';
    }

    if (this.pointer.mode === 'stick' && this.stick.active) {
      // 摇杆：方向 × 力度，推得越远游得越快
      nx = this.stick.nx * this.stick.mag;
      ny = this.stick.ny * this.stick.mag;
    } else if (this.pointer.mode === 'keys' && this.keys.size) {
      let kx = 0;
      let ky = 0;
      if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) kx -= 1;
      if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) kx += 1;
      if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) ky -= 1;
      if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) ky += 1;
      const len = Math.hypot(kx, ky);
      if (len > 0) { nx = kx / len; ny = ky / len; }
    } else if (this.pointer.mode === 'drag') {
      // 相对拖拽：拖动距离归一化后即为推力方向
      const { dx, dy } = this.drag;
      const d = Math.hypot(dx, dy);
      if (d > 4) {
        // 72px 拖满即全速，手感上"轻轻一划"就能动起来
        const ease = Math.min(1, d / (72 * this.S));
        nx = (dx / d) * ease;
        ny = (dy / d) * ease;
      }
    } else if (this.pointer.active) {
      const dx = this.pointer.x - p.x;
      const dy = this.pointer.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > 3) {
        const ease = Math.min(1, d / 60);
        nx = (dx / d) * ease;
        ny = (dy / d) * ease;
      }
    }

    // 体型越大越笨重：成长带来的代价
    const growN = Utils.clamp((p.r - BigFatFish.START_R) / (BigFatFish.MAX_R - BigFatFish.START_R), 0, 1);
    const baseSpeed = 306 * (1 - growN * 0.22);
    // 掠食者的速度上限要以此为准，不能让大鱼跑得比玩家还快
    p.baseSpeed = baseSpeed;

    p.dashCd = Math.max(0, p.dashCd - dt);
    p.dashTime = Math.max(0, p.dashTime - dt);
    p.invincible = Math.max(0, p.invincible - dt);
    p.magnet = Math.max(0, p.magnet - dt);
    p.shield = Math.max(0, p.shield - dt);
    p.eatPulse = Math.max(0, p.eatPulse - dt * 3.4);
    p.mouth = Math.max(0, p.mouth - dt * 4);

    const dashing = p.dashTime > 0;
    const maxSpeed = dashing ? baseSpeed * 2.45 : baseSpeed;
    const desiredVx = nx * maxSpeed;
    const desiredVy = ny * maxSpeed;
    const k = Utils.damp(dashing ? 16 : 11, dt);
    p.vx += (desiredVx - p.vx) * k;
    p.vy += (desiredVy - p.vy) * k;

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const sp = Math.hypot(p.vx, p.vy);
    p.speedRatio = Utils.clamp(sp / (baseSpeed * 1.6), 0, 1);

    if (sp > 6) {
      const a = Math.atan2(p.vy, p.vx);
      p.angle = Utils.angleLerp(p.angle, a, Utils.damp(9, dt));
      p.dirRight = Math.cos(p.angle) >= 0;
    }

    if (dashing) {
      p.tailSwing = Math.sin(this.t * 34) * 0.16;
      if (Math.random() < 0.9) this.ribbon(p.x - Math.cos(p.angle) * p.r * 0.7,
        p.y - Math.sin(p.angle) * p.r * 0.7, p.hue);
    } else {
      p.tailSwing = Utils.lerp(p.tailSwing || 0, 0, Utils.damp(8, dt));
    }

    this.wrap(p);

    if (running) this.checkCollisions();
  }

  wrap(e) {
    // 环形世界：越界即从对面穿回。相机用最短路径跟随，因此这里无需动相机。
    // 周期必须与 wrapDelta/toScreen 一致（worldW），不能带上 e.r 的余量：
    // 一旦周期不同，实体每次穿越都会在屏幕上多跳 2*(r+6) 像素。
    e.x -= Math.floor(e.x / this.worldW) * this.worldW;
    e.y -= Math.floor(e.y / this.worldH) * this.worldH;
  }

  /* 挑出可以全速追击的掠食者：只取离玩家最近的几条（见 MAX_CHASERS）。
     其余掠食者仍会靠近，但速度被压低，围上来时才有缝可钻。 */
  pickActiveChasers() {
    const p = this.player;
    const set = new Set();
    if (!p || !p.alive) return set;

    const list = [];
    for (const e of this.enemies) {
      if (e.dead || e.golden) continue;
      if (e.r < p.r * 1.18) continue; // 撞不死的鱼不占追击名额
      const d = this.ringDist(e.x, e.y, p.x, p.y);
      if (d > 380) continue;
      list.push({ e, d });
    }
    if (list.length > BigFatFish.MAX_CHASERS) {
      list.sort((a, b) => a.d - b.d);
      list.length = BigFatFish.MAX_CHASERS;
    }
    for (const it of list) set.add(it.e);
    return set;
  }

  updateEnemies(dt, running) {
    const p = this.player;
    let threat = 0;

    // 大后期一次涌上来七八条掠食者会形成无解的合围：玩家往哪躲都会撞上另一条。
    // 所以只让最近的两条真正全速追击，其余的减速逼近，给玩家留出一条可读的缝。
    const chasers = this.pickActiveChasers();

    for (const e of this.enemies) {
      e.age += dt;

      // 淡入
      if (e.fadeIn) {
        e.alpha = Math.min(1, e.alpha + dt * 2.4);
        if (e.alpha >= 1) e.fadeIn = false;
      } else if (e.alpha < 1 && e.fadeOut !== true) {
        e.alpha = Math.min(1, e.alpha + dt * 2.4);
      }

      // 危险度随玩家体型实时变化（颜色随之过渡）
      let target = 0;
      if (p && p.alive) {
        if (e.r >= p.r * 1.18) target = 1;        // 致命：红橙警戒
        else if (e.r > p.r * 1.08) target = 0.45; // 体型接近：保留原色但升温
      }
      const blended = target > e.threat;
      e.threat = Utils.lerp(e.threat, target, Utils.damp(blended ? 3.2 : 7, dt));
      // 危险色：红橙
      const warnHue = 6;
      e.hue = Utils.hueLerp(e.baseHue, warnHue, e.threat);

      let ax = 0;
      let ay = 0;

      if (p && p.alive) {
        // 环形世界：走最短路径，否则鱼会绕整张地图追玩家
        const dx = this.wrapDelta(p.x - e.x, this.worldW);
        const dy = this.wrapDelta(p.y - e.y, this.worldH);
        const d = Math.hypot(dx, dy) || 1;

        if (e.threat < 0.6) {
          // 可被吞食：靠近玩家时逃窜（速度上限低于玩家，追得上但需要操作）
          const fleeRange = 118 + e.r * 1.5;
          if (d < fleeRange) {
            const w = 1 - d / fleeRange;
            e.vx -= (dx / d) * 200 * w * dt;
            e.vy -= (dy / d) * 200 * w * dt;
            e.vx += (-dy / d) * 70 * w * dt;
            e.vy += (dx / d) * 70 * w * dt;
          }
          if (p.magnet > 0) {
            const pull = 210;
            e.vx += (dx / d) * pull * dt;
            e.vy += (dy / d) * pull * dt;
          }
        } else if (d < 380 && chasers.has(e)) {
          // 掠食者：只有被选中的那几条主动追击玩家。
          // 如果所有大鱼都追过来，它们会从四面八方聚成一团把玩家围死；
          // 让其余大鱼保持漫游，玩家面对的才始终是 1~2 条可读、可操作的威胁。
          const chase = 1 - d / 380;
          const power = e.r > p.r * 1.55 ? 92 : 132;
          ax += (dx / d) * power * chase;
          ay += (dy / d) * power * chase;
        }

        if (e.threat > 0.5) {
          const near = Utils.clamp(1 - d / 300, 0, 1);
          threat = Math.max(threat, near * e.threat);
        }
      }

      // 漫游
      e.wander += Utils.rand(-1.1, 1.1) * dt * 2.2;
      ax += Math.cos(e.wander) * e.speed * 0.55;
      ay += Math.sin(e.wander) * e.speed * 0.55;

      const diff = 1 + Math.min(this.elapsed, 180) / 180 * 0.42;
      let maxSp = e.speed * 1.9 * diff;
      if (p && p.alive && p.baseSpeed && e.r >= p.r * 1.18) {
        // 硬上限：掠食者最多比玩家基础速度略快一点。
        // 没有这条约束时，大后期大鱼能跑到玩家上限的 1.4 倍，
        // 玩家在物理上无法逃跑，只能靠冲刺续命——也就是"被围攻必死"。
        maxSp = Math.min(maxSp, p.baseSpeed * BigFatFish.PREDATOR_SPEED_CAP);
      }
      e.vx += ax * dt;
      e.vy += ay * dt;

      const sp = Math.hypot(e.vx, e.vy);
      if (sp > maxSp) {
        e.vx = (e.vx / sp) * maxSp;
        e.vy = (e.vy / sp) * maxSp;
      }
      e.speedRatio = Utils.clamp(sp / (e.speed * 2.2), 0, 1);

      e.x += e.vx * dt;
      e.y += e.vy * dt;

      if (sp > 4) {
        e.angle = Utils.angleLerp(e.angle, Math.atan2(e.vy, e.vx), Utils.damp(5, dt));
        e.dirRight = Math.cos(e.angle) >= 0;
      }

      this.wrap(e);

      // 太小的鱼失去意义，让它淡出（彩蛋锦鲤例外，它要留到被吃掉）
      if (running && p && !e.golden && e.age > 4 && e.r < p.r * 0.26 && this.enemies.length > 12) {
        e.alpha -= dt * 1.2;
        if (e.alpha < 0) e.dead = true;
      }
    }

    this.threatLevel = Utils.lerp(this.threatLevel, threat, Utils.damp(8, dt));
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  updateParticles(dt, running) {
    for (const p of this.particles) {
      p.life -= dt;
      const d = Utils.damp(p.drag || 2, dt);
      p.vx += (0 - p.vx) * d;
      p.vy += (0 - p.vy) * d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'bubble') p.y -= 34 * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  updatePowerups(dt, running) {
    for (const u of this.powerups) {
      u.life -= dt;
      u.born += dt;
      if (u.life <= 0) u.dead = true;
    }
    this.powerups = this.powerups.filter((u) => !u.dead);
  }

  updateFloaters(dt) {
    for (const f of this.floaters) {
      f.life -= dt;
      f.y += f.vy * dt;
      f.vy *= 0.96;
    }
    this.floaters = this.floaters.filter((f) => f.life > 0);
  }

  updateSpawns(dt) {
    this.spawnTimer -= dt;
    const want = this.enemyTargetCount();

    // 保证场上始终有足够的猎物，否则玩家会陷入"没东西可吃"的空转
    const p = this.player;
    const preyCount = this.enemies.filter((e) => !e.dead && e.r <= p.r * 1.08).length;
    const minPrey = 5;

    if (this.spawnTimer <= 0) {
      if (preyCount < minPrey) {
        this.spawnEnemy(false, true);
        this.spawnTimer = Utils.rand(0.18, 0.4);
      } else if (this.enemies.length < want) {
        this.spawnEnemy(false);
        this.spawnTimer = Utils.rand(0.3, 0.8);
      }
    }

    this.powerTimer -= dt;
    if (this.powerTimer <= 0) {
      this.spawnPowerup();
      this.powerTimer = Utils.rand(13, 21);
    }

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
  }

  /* ================= 碰撞与吞食 ================= */

  checkCollisions() {
    const p = this.player;
    if (!p || !p.alive) return;

    // 吃掉 / 被撞
    for (const e of this.enemies) {
      if (e.dead || e.alpha < 0.4) continue;
      // 环形世界：跨越边缘的相邻实体也算碰到，取最短路径距离
      const ddx = this.wrapDelta(e.x - p.x, this.worldW);
      const ddy = this.wrapDelta(e.y - p.y, this.worldH);
      const d = Math.hypot(ddx, ddy);
      const touch = d < p.r * 0.95 + e.r * 0.62;
      if (!touch) continue;

      // 体型接近时互相弹开，不给惩罚，避免"看一眼就死"
      const edible = e.r <= p.r * 1.08;
      const lethal = e.r >= p.r * 1.18;

      if (edible) {
        this.eat(e, false);
      } else if (p.shield > 0) {
        this.eat(e, true);
      } else if (lethal) {
        if (p.invincible <= 0) this.hurt(e);
      } else {
        this.bounce(e);
      }
    }

    // 拾取强化
    for (const u of this.powerups) {
      if (u.dead) continue;
      const udx = this.wrapDelta(u.x - p.x, this.worldW);
      const udy = this.wrapDelta(u.y - p.y, this.worldH);
      if (Math.hypot(udx, udy) < p.r + u.r + 4) {
        this.collect(u);
      }
    }
  }

  eat(e, revenge) {
    const p = this.player;
    e.dead = true;
    this.eats++;

    this.combo = Math.min(this.combo + 1, 12);
    this.comboTimer = 2.3;
    const mult = 1 + Math.min(this.combo - 1, 9) * 0.4;

    const ratio = Utils.clamp(e.r / p.r, 0.05, 2.6);
    const base = Math.round(4 + 26 * ratio);
    let gain = Math.round(base * mult * (revenge ? 1.5 : 1));
    // 彩蛋锦鲤：额外一笔固定奖励，并配一段专属音效
    if (e.golden) gain += 500;
    this.score += gain;

    // 成长：体型越大收益越小，保证一局有足够长的成长曲线
    const diminish = Math.max(0, 1 - p.r / (BigFatFish.MAX_R * 1.06));
    const grow = (e.r * 0.075 + 0.2) * diminish * (revenge ? 1.6 : 1);
    const before = p.r;
    p.r = Math.min(BigFatFish.MAX_R, p.r + Math.max(0.1, grow));
    if (p.r - before > 1.1) Sfx.grow();

    p.mouth = 1;
    p.eatPulse = 1;
    this.shake = Math.max(this.shake, Math.min(6, e.r * 0.12));

    const hue = revenge ? 6 : e.golden ? 45 : 168;
    this.burst(e.x, e.y, Math.round(6 + e.r * 0.5), hue, e.golden ? 1.6 : 0.9);

    const label = e.golden
      ? `金鳞锦鲤 +${gain}`
      : this.combo > 1 ? `+${gain} ×${this.combo}` : `+${gain}`;
    const color = e.golden ? '#ffd76e' : revenge ? '#ffb0b8' : this.combo > 2 ? '#ffd76e' : '#b9f7e8';
    this.floater(e.x, e.y - e.r - 6, label, color, e.golden || this.combo > 4 ? 18 : 15);

    if (e.golden) Sfx.secret();
    else {
      Sfx.eat(e.r);
      if (this.combo > 1) Sfx.combo(this.combo);
    }

    if (this.stageIndex() !== this._lastStage) {
      const idx = this.stageIndex();
      if (this._lastStage !== undefined && idx > this._lastStage) {
        this.floater(p.x, p.y - p.r - 24, `进化 · ${this.stageName()}`, '#5ff0d0', 20);
        this.burst(p.x, p.y, 22, 168, 1.5);
        Sfx.power();
      }
      this._lastStage = idx;
    }
  }

  bounce(e) {
    const p = this.player;
    const dx = this.wrapDelta(p.x - e.x, this.worldW);
    const dy = this.wrapDelta(p.y - e.y, this.worldH);
    const d = Math.hypot(dx, dy) || 1;
    const kx = dx / d;
    const ky = dy / d;
    p.vx = kx * 210;
    p.vy = ky * 210;
    e.vx = -kx * 150;
    e.vy = -ky * 150;
    this.shake = Math.max(this.shake, 3);
    Sfx.ui();
  }

  hurt(e) {
    const p = this.player;
    this.lives--;
    this.combo = 0;
    this.comboTimer = 0;
    p.invincible = 1.5;
    p.dashTime = 0;

    // 被撞退
    const hdx = this.wrapDelta(p.x - e.x, this.worldW);
    const hdy = this.wrapDelta(p.y - e.y, this.worldH);
    const d = Math.hypot(hdx, hdy) || 1;
    const kx = hdx / d;
    const ky = hdy / d;
    p.vx = kx * 390;
    p.vy = ky * 390;

    this.shake = 14;
    this.burst(p.x, p.y, 18, 6, 1.2);
    this.floater(p.x, p.y - p.r - 18, '-1', '#ff8f9c', 20);
    Sfx.hurt();

    // 冲击波：把身边的大鱼直接震开一段距离，给玩家一个脱离包围的窗口。
    // 这里改坐标而不是改速度——速度会被 maxSp 钳制掉，推不动。
    // 没有这一下，1.5 秒无敌刚结束就会被同一群鱼再次撞上，
    // 连续掉光三条命，这才是"被围攻致死"的体感来源。
    for (const o of this.enemies) {
      if (o.dead || o === e) continue;
      if (o.r < p.r * 1.18) continue;
      const odx = this.wrapDelta(o.x - p.x, this.worldW);
      const ody = this.wrapDelta(o.y - p.y, this.worldH);
      const od = Math.hypot(odx, ody);
      if (od > BigFatFish.HURT_PUSH_RADIUS || od < 0.001) continue;
      // 越近推得越远，刚好在半径边缘的几乎不动
      const k = 1 - od / BigFatFish.HURT_PUSH_RADIUS;
      const push = BigFatFish.HURT_PUSH_DIST * k;
      o.x += (odx / od) * push;
      o.y += (ody / od) * push;
      o.vx = 0;
      o.vy = 0;
      this.wrap(o);
    }

    if (this.lives <= 0) this.gameOver();
  }

  collect(u) {
    const p = this.player;
    u.dead = true;
    Sfx.power();
    this.burst(u.x, u.y, 16, 150, 1.2);

    if (u.kind === 'glow') {
      const gain = 150;
      this.score += gain;
      this.floater(u.x, u.y - 16, `荧光 +${gain}`, '#9ff7ff', 17);
    } else if (u.kind === 'magnet') {
      p.magnet = 9;
      this.floater(u.x, u.y - 16, '磁力 9s', '#9fd0ff', 17);
    } else {
      p.shield = 7;
      this.floater(u.x, u.y - 16, '无敌 7s', '#ffe08a', 17);
    }
  }

  /* ================= 绘制 ================= */

  draw() {
    const g = this.g;
    const dpr = this.dpr;
    const S = this.S;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#031019';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const sc = dpr * S;
    g.setTransform(sc, 0, 0, sc, 0, 0);

    const depth = Utils.clamp((this.player ? this.player.r : 13) - BigFatFish.START_R, 0, 1)
      / (BigFatFish.MAX_R - BigFatFish.START_R);

    Render.drawBackground(g, this.vw, this.vh, depth, this.t);

    g.save();
    if (this.shake > 0.1) {
      g.translate(Utils.rand(-this.shake, this.shake) * 0.5, Utils.rand(-this.shake, this.shake) * 0.5);
    }

    // 环境层：光柱与浮游微粒固定在屏幕上，不随相机滚动，避免世界看起来是空的
    this.rays.draw(g, this.vw, this.vh, this.t);
    this.motes.draw(g, this.vw, this.vh);

    // 海底轮廓画在世界底部：只有游到世界下半部分才看得见，制造纵深
    const floorOffset = (this.worldH - this.vh) - this.cam.y;
    if (floorOffset > -this.vh && floorOffset < this.vh * 2) {
      Render.drawSeafloor(g, this.vw, this.vh, this.t, depth, floorOffset);
    }

    // 世界层：实体按环形折叠到视野内最近的一份再绘制
    this.drawPowerups(g);
    this.drawEnemies(g);
    this.drawTrail(g);
    if (this.player && this.player.alive) this.drawPlayer(g);
    this.drawParticles(g);

    for (const f of this.floaters) {
      const sx = this.toScreenX(f.x);
      const sy = this.toScreenY(f.y);
      if (sx + 80 < 0 || sx - 80 > this.vw || sy + 40 < 0 || sy - 40 > this.vh) continue;
      Render.drawFloater(g, { x: sx, y: sy, text: f.text, color: f.color, size: f.size, life: f.life, maxLife: f.maxLife });
    }

    this.drawTouchHint(g);

    g.restore();

    if (this.threatLevel > 0.02) {
      const a = this.threatLevel * 0.34;
      const grd = g.createRadialGradient(this.vw / 2, this.vh / 2, Math.min(this.vw, this.vh) * 0.3,
        this.vw / 2, this.vh / 2, Math.max(this.vw, this.vh) * 0.72);
      grd.addColorStop(0, 'rgba(255,60,80,0)');
      grd.addColorStop(1, `rgba(255,42,74,${a})`);
      g.fillStyle = grd;
      g.fillRect(0, 0, this.vw, this.vh);
    }

    Render.drawVignette(g, this.vw, this.vh);
  }

  drawEnemies(g) {
    // 只按直径分档排序，避免每帧做完整比较排序的额外开销
    const list = this.enemies;
    list.sort((a, b) => a.r - b.r);
    const scratch = this._fishScratch || (this._fishScratch = {});
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.alpha <= 0.02) continue;
      // 视口裁剪：屏幕外的鱼不参与绘制
      const sx = this.toScreenX(e.x);
      const sy = this.toScreenY(e.y);
      if (sx + e.r < 0 || sx - e.r > this.vw || sy + e.r < 0 || sy - e.r > this.vh) continue;
      scratch.x = sx;
      scratch.y = sy;
      scratch.r = e.r;
      scratch.angle = e.angle;
      scratch.dirRight = e.dirRight;
      scratch.bulge = e.bulge;
      scratch.phase = e.phase;
      scratch.wobSpeed = e.wobSpeed;
      scratch.speedRatio = e.speedRatio;
      scratch.tailSwing = e.tailSwing;
      // 金鳞锦鲤自带一圈金色光晕，远远就能认出来
      if (e.golden) {
        Render.drawGlow(g, sx, sy, e.r * 4.4, 45,
          Utils.clamp(e.alpha, 0, 1) * (0.7 + Math.sin(this.t * 3.2) * 0.18), 'lighter');
      }
      Render.drawFish(g, scratch, this.t, {
        alpha: Utils.clamp(e.alpha, 0, 1),
        hue: e.hue,
        danger: e.threat > 0.72,
        spike: e.threat > 0.72,
        peer: e.threat > 0.25 && e.threat <= 0.72,
      });
    }
  }

  drawTrail(g) {
    for (const p of this.particles) {
      if (p.kind !== 'trail') continue;
      const a = Utils.clamp(p.life / p.maxLife, 0, 1);
      const sx = this.toScreenX(p.x);
      const sy = this.toScreenY(p.y);
      if (sx + p.r * 3 < 0 || sx - p.r * 3 > this.vw || sy + p.r * 3 < 0 || sy - p.r * 3 > this.vh) continue;
      Render.drawGlow(g, sx, sy, p.r * 2.6, p.hue, a * 0.5);
    }
    g.globalAlpha = 1;
  }

  drawPlayer(g) {
    const p = this.player;
    let alpha = 1;
    if (p.invincible > 0) {
      alpha = 0.42 + Math.abs(Math.sin(this.t * 22)) * 0.58;
    }

    // 世界坐标 → 屏幕坐标：整体平移后，下面的绘制仍按玩家自身坐标书写
    const sx = this.toScreenX(p.x);
    const sy = this.toScreenY(p.y);
    g.save();
    g.translate(sx - p.x, sy - p.y);

    // 玩家专属标识：一圈缓慢旋转的虚线光环，与敌鱼彻底区分
    g.save();
    g.globalAlpha = alpha * 0.5;
    g.strokeStyle = 'rgba(150, 255, 240, 0.75)';
    g.lineWidth = 1.1;
    g.setLineDash([3, 7]);
    g.beginPath();
    g.arc(p.x, p.y, p.r * 1.28, this.t * 0.5, this.t * 0.5 + Utils.TAU);
    g.stroke();
    g.restore();

    // 外发光
    const pulse = 1 + p.eatPulse * 0.14;
    const glowR = p.r * (2.35 + p.eatPulse * 0.3);
    Render.drawGlow(g, p.x, p.y, glowR, p.hue, alpha * 0.85);

    // 无敌护盾
    if (p.shield > 0) {
      const a = p.shield < 2 ? 0.35 + Math.abs(Math.sin(this.t * 12)) * 0.4 : 0.55;
      g.globalAlpha = a;
      g.strokeStyle = 'rgba(255, 224, 138, 0.9)';
      g.lineWidth = Math.max(1.1, p.r * 0.08);
      g.beginPath();
      g.arc(p.x, p.y, p.r * 1.42 * pulse, 0, Utils.TAU);
      g.stroke();
      g.globalAlpha = a * 0.18;
      g.fillStyle = 'rgba(255, 214, 110, 0.5)';
      g.beginPath();
      g.arc(p.x, p.y, p.r * 1.42 * pulse, 0, Utils.TAU);
      g.fill();
    }

    // 磁力环
    if (p.magnet > 0) {
      g.globalAlpha = 0.4;
      g.strokeStyle = 'rgba(159, 208, 255, 0.85)';
      g.lineWidth = 1;
      g.setLineDash([6, 10]);
      g.beginPath();
      g.arc(p.x, p.y, p.r * 2.6, this.t * 0.9, this.t * 0.9 + Utils.TAU);
      g.stroke();
      g.setLineDash([]);
    }

    g.globalAlpha = alpha;
    Render.drawFish(g, {
      x: p.x,
      y: p.y,
      r: p.r * pulse,
      hue: p.hue,
      angle: p.angle,
      dirRight: p.dirRight,
      bulge: 1.02,
      phase: p.phase,
      wobSpeed: 6.4,
      speedRatio: p.speedRatio,
      tailSwing: p.tailSwing,
    }, this.t, { alpha, mouth: p.mouth, eyeScale: 1.05, hue: p.hue });
    g.globalAlpha = 1;
    g.restore();
  }

  drawParticles(g) {
    for (const p of this.particles) {
      const a = Utils.clamp(p.life / p.maxLife, 0, 1);
      if (p.kind === 'trail') continue;
      const sx = this.toScreenX(p.x);
      const sy = this.toScreenY(p.y);
      if (sx + p.r * 2 < 0 || sx - p.r * 2 > this.vw || sy + p.r * 2 < 0 || sy - p.r * 2 > this.vh) continue;
      if (p.kind === 'bubble') {
        g.globalAlpha = a * 0.8;
        g.strokeStyle = `hsla(${p.hue}, 100%, 84%, 0.95)`;
        g.lineWidth = Math.max(0.7, p.r * 0.35);
        g.beginPath();
        g.arc(sx, sy, p.r, 0, Utils.TAU);
        g.stroke();
      } else {
        g.globalAlpha = a;
        g.fillStyle = `hsla(${p.hue}, 100%, 80%, 0.95)`;
        g.beginPath();
        g.arc(sx, sy, p.r * 0.6, 0, Utils.TAU);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  drawPowerups(g) {
    for (const u of this.powerups) {
      const t = this.t;
      const bob = Math.sin(t * 2.2 + u.phase) * 3;
      const fade = u.life < 2.5 ? 0.35 + Math.abs(Math.sin(t * 8)) * 0.65 : 1;
      const x = this.toScreenX(u.x);
      const y = this.toScreenY(u.y) + bob;
      if (x + u.r * 4 < 0 || x - u.r * 4 > this.vw || y + u.r * 4 < 0 || y - u.r * 4 > this.vh) continue;
      const pulse = 1 + Math.sin(t * 3.4 + u.phase) * 0.08;
      const tint = u.kind === 'glow' ? 178 : u.kind === 'magnet' ? 212 : 44;

      g.save();
      g.globalAlpha = fade;
      Render.drawGlow(g, x, y, u.r * 3.4 * pulse, tint, 0.85 * fade, 'lighter');

      g.fillStyle = 'rgba(4, 22, 30, 0.85)';
      g.strokeStyle = `hsla(${tint}, 100%, 80%, 0.98)`;
      g.lineWidth = 1.8;
      g.beginPath();
      g.arc(x, y, u.r * pulse, 0, Utils.TAU);
      g.fill();
      g.stroke();

      // 缓慢旋转的外圈刻度，读起来像一个"可拾取物"
      g.globalAlpha = fade * 0.55;
      g.strokeStyle = `hsla(${tint}, 100%, 84%, 0.9)`;
      g.lineWidth = 1.1;
      g.setLineDash([2, 5]);
      g.beginPath();
      g.arc(x, y, u.r * pulse * 1.42, -t * 0.8, -t * 0.8 + Utils.TAU);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = fade;

      g.strokeStyle = `hsla(${tint}, 100%, 88%, 1)`;
      g.fillStyle = `hsla(${tint}, 100%, 88%, 1)`;
      g.lineWidth = 2;
      g.lineCap = 'round';
      g.lineJoin = 'round';

      if (u.kind === 'glow') {
        // 四角星 + 中心点
        g.beginPath();
        g.moveTo(x, y - u.r * 0.6);
        g.quadraticCurveTo(x + u.r * 0.1, y - u.r * 0.1, x + u.r * 0.62, y);
        g.quadraticCurveTo(x + u.r * 0.1, y + u.r * 0.1, x, y + u.r * 0.6);
        g.quadraticCurveTo(x - u.r * 0.1, y + u.r * 0.1, x - u.r * 0.62, y);
        g.quadraticCurveTo(x - u.r * 0.1, y - u.r * 0.1, x, y - u.r * 0.6);
        g.closePath();
        g.fill();
      } else if (u.kind === 'magnet') {
        // U 形磁铁
        g.lineWidth = u.r * 0.3;
        g.beginPath();
        g.moveTo(x - u.r * 0.42, y - u.r * 0.34);
        g.lineTo(x - u.r * 0.42, y + u.r * 0.06);
        g.arc(x, y + u.r * 0.06, u.r * 0.42, Math.PI, 0, true);
        g.lineTo(x + u.r * 0.42, y - u.r * 0.34);
        g.stroke();
        // 磁极
        g.lineWidth = u.r * 0.32;
        g.beginPath();
        g.moveTo(x - u.r * 0.42, y - u.r * 0.46);
        g.lineTo(x - u.r * 0.42, y - u.r * 0.26);
        g.moveTo(x + u.r * 0.42, y - u.r * 0.46);
        g.lineTo(x + u.r * 0.42, y - u.r * 0.26);
        g.stroke();
      } else {
        // 盾牌
        g.beginPath();
        g.moveTo(x, y - u.r * 0.58);
        g.lineTo(x + u.r * 0.46, y - u.r * 0.32);
        g.lineTo(x + u.r * 0.4, y + u.r * 0.16);
        g.quadraticCurveTo(x + u.r * 0.24, y + u.r * 0.52, x, y + u.r * 0.62);
        g.quadraticCurveTo(x - u.r * 0.24, y + u.r * 0.52, x - u.r * 0.4, y + u.r * 0.16);
        g.lineTo(x - u.r * 0.46, y - u.r * 0.32);
        g.closePath();
        g.stroke();
        g.beginPath();
        g.moveTo(x - u.r * 0.14, y + u.r * 0.02);
        g.lineTo(x - u.r * 0.01, y + u.r * 0.17);
        g.lineTo(x + u.r * 0.2, y - u.r * 0.16);
        g.stroke();
      }
      g.restore();
    }
    g.globalAlpha = 1;
  }

  /* 触摸拖拽的视觉反馈：原点小圈 + 方向指示。
     drag.ox/oy/dx/dy 都是画布 CSS 像素，而绘制上下文已按 dpr*S 缩放，
     所以必须先除以 S 换回逻辑坐标，否则提示圈会偏移到错误位置。 */
  drawTouchHint(g) {
    if (!this.drag.active || this.state !== 'playing') return;
    const x = this.drag.ox / this.S;
    const y = this.drag.oy / this.S;
    const dx = this.drag.dx / this.S;
    const dy = this.drag.dy / this.S;
    const d = Math.hypot(dx, dy);
    // 拖满全速的距离是 72*S 个 CSS 像素，即 72 个逻辑像素
    const maxR = 72;

    g.save();
    g.globalAlpha = 0.42;
    g.strokeStyle = 'rgba(150, 245, 235, 0.95)';
    g.lineWidth = 1.6;
    g.beginPath();
    g.arc(x, y, maxR * 0.55, 0, Utils.TAU);
    g.stroke();

    g.globalAlpha = 0.25;
    g.fillStyle = 'rgba(120, 235, 225, 0.5)';
    g.beginPath();
    g.arc(x, y, maxR * 0.55, 0, Utils.TAU);
    g.fill();

    if (d > 6) {
      // 拖柄：跟随手指，限制在圈内
      const k = Math.min(1, d / maxR);
      const hx = x + (dx / d) * maxR * 0.55 * k;
      const hy = y + (dy / d) * maxR * 0.55 * k;
      g.globalAlpha = 0.75;
      g.fillStyle = 'rgba(180, 255, 248, 0.95)';
      g.beginPath();
      g.arc(hx, hy, maxR * 0.2, 0, Utils.TAU);
      g.fill();
    }
    g.restore();
  }

  /* ================= HUD 数据 ================= */

  hudSnapshot() {
    const p = this.player;
    const st = this.stageIndex();
    const stages = BigFatFish.STAGES;
    const f = p
      ? (p.r - BigFatFish.START_R) / (BigFatFish.MAX_R - BigFatFish.START_R)
      : 0;
    const lo = stages[st].at;
    const hi = st < stages.length - 1 ? stages[st + 1].at : 1;
    const progress = Utils.clamp((f - lo) / Math.max(0.0001, hi - lo), 0, 1);

    return {
      state: this.state,
      score: Math.round(this.score),
      best: this.best,
      lives: this.lives,
      stage: stages[st].name,
      progress,
      combo: this.state === 'playing' ? this.combo : 0,
      comboTimer: this.comboTimer,
      dashReady: p ? p.dashCd : 0,
      dashMax: 1.65,
      magnet: p ? p.magnet : 0,
      shield: p ? p.shield : 0,
      eating: this.eats,
    };
  }
}
