/* 《大肥鱼 · 深海吞食》核心玩法
   坐标系：世界坐标（未缩放），绘制时统一乘以 scale 适配屏幕 */
class BigFatFish {
  static get START_R() { return 13; }
  static get MAX_R() { return 62; }

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
    this.isTouch = false;

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
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || window.innerWidth));
    const h = Math.max(1, Math.round(rect.height || window.innerHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const oldVw = this.vw;
    const oldVh = this.vh;

    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);

    // 以短边为基准缩放，保证不同屏幕下鱼的大小比例一致
    this.S = Utils.clamp(Math.min(w, h) / 620, 0.5, 1.8);
    this.vw = w / this.S;
    this.vh = h / this.S;

    // 按比例迁移已有实体的位置
    if (oldVw > 1 && oldVh > 1 && (oldVw !== this.vw || oldVh !== this.vh)) {
      const kx = this.vw / oldVw;
      const ky = this.vh / oldVh;
      const all = [this.player, ...this.enemies, ...this.powerups].filter(Boolean);
      for (const e of all) { e.x *= kx; e.y *= ky; }
      for (const p of this.particles) { p.x *= kx; p.y *= ky; }
      for (const f of this.floaters) { f.x *= kx; f.y *= ky; }
    }
  }

  reset() {
    this.enemies = [];
    this.particles = [];
    this.floaters = [];
    this.powerups = [];
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
      x: this.vw * 0.5,
      y: this.vh * 0.5,
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
      dashCd: 0,
      dashTime: 0,
      invincible: 0,
      magnet: 0,
      shield: 0,
      eatPulse: 0,
      alive: true,
    };

    const initial = this.state === 'menu' ? 14 : 15;
    for (let i = 0; i < initial; i++) this.spawnEnemy(true);
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

  spawnEnemy(anywhere, forceEdible) {
    const p = this.player;
    const baseR = p ? p.r : BigFatFish.START_R;
    const roll = Math.random();
    // 开局少一些"巨物"，随游戏进程逐步提高压迫感
    const ramp = Utils.clamp(this.elapsed / 75, 0, 1);
    const giantCut = 0.97 + ramp * 0.06;
    let frac;
    if (forceEdible) {
      frac = Utils.rand(0.34, 0.86);
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
    const diff = this.enemyTargetCount();

    let x;
    let y;
    let tries = 0;
    do {
      x = Utils.rand(r, Math.max(r + 1, this.vw - r));
      y = Utils.rand(r, Math.max(r + 1, this.vh - r));
      tries++;
    } while (p && tries < 24 && Utils.dist(x, y, p.x, p.y) < 190);

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
    } else if (forceEdible && p && Math.random() < 0.55) {
      // 补充猎物时优先出现在玩家附近的可视范围内
      const ang = Utils.rand(0, Utils.TAU);
      const dist = Utils.rand(190, 420);
      e.x = Utils.clamp(p.x + Math.cos(ang) * dist, r + 8, Math.max(r + 9, this.vw - r - 8));
      e.y = Utils.clamp(p.y + Math.sin(ang) * dist, r + 8, Math.max(r + 9, this.vh - r - 8));
    } else {
      // 从屏幕边缘外围游入
      const edge = Utils.randInt(0, 3);
      if (edge === 0) { e.x = -r * 1.4; e.y = Utils.rand(0, this.vh); }
      else if (edge === 1) { e.x = this.vw + r * 1.4; e.y = Utils.rand(0, this.vh); }
      else if (edge === 2) { e.x = Utils.rand(0, this.vw); e.y = -r * 1.4; }
      else { e.x = Utils.rand(0, this.vw); e.y = this.vh + r * 1.4; }
    }
    this.enemies.push(e);
    return e;
  }

  enemyTargetCount() {
    return 14 + Math.min(10, Math.floor(this.elapsed / 22));
  }

  spawnPowerup() {
    if (this.powerups.length >= 2) return;
    const kinds = ['glow', 'magnet', 'shield'];
    const kind = Utils.pick(kinds);
    const m = 54;
    let x = this.vw * 0.5;
    let y = this.vh * 0.5;
    const p = this.player;
    // 避开玩家视野中心，避免与玩家鱼叠在一起造成误读
    for (let i = 0; i < 18; i++) {
      x = Utils.rand(m, Math.max(m + 1, this.vw - m));
      y = Utils.rand(m, Math.max(m + 1, this.vh - m));
      if (!p || Utils.dist(x, y, p.x, p.y) > 130) break;
    }
    this.powerups.push({
      kind,
      x, y,
      r: 13,
      life: 13,
      maxLife: 13,
      phase: Utils.rand(0, Utils.TAU),
      born: 0,
    });
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
    this.pointer.x = x / this.S;
    this.pointer.y = y / this.S;
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

    this.shake = Math.max(0, this.shake - dt * 26);
  }

  updatePlayer(dt, running) {
    const p = this.player;
    if (!p) return;

    let nx = 0;
    let ny = 0;

    if (this.state === 'menu') {
      // 待机演示：沿李萨如曲线巡游
      const tt = this.t * 0.34;
      this.pointer.active = true;
      this.pointer.x = this.vw * 0.5 + Math.cos(tt) * this.vw * 0.24;
      this.pointer.y = this.vh * 0.54 + Math.sin(tt * 1.27) * this.vh * 0.17;
      this.pointer.mode = 'pointer';
    }

    if (this.pointer.mode === 'keys' && this.keys.size) {
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
    const m = e.r + 6;
    if (e.x < -m) e.x = this.vw + m;
    else if (e.x > this.vw + m) e.x = -m;
    if (e.y < -m) e.y = this.vh + m;
    else if (e.y > this.vh + m) e.y = -m;
  }

  updateEnemies(dt, running) {
    const p = this.player;
    let threat = 0;

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
        const dx = p.x - e.x;
        const dy = p.y - e.y;
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
        } else if (d < 380) {
          // 掠食者：追击体型较小的玩家
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
      const maxSp = e.speed * 1.9 * diff;
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

      // 太小的鱼失去意义，让它淡出
      if (running && p && e.age > 4 && e.r < p.r * 0.26 && this.enemies.length > 12) {
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
      const d = Utils.dist(p.x, p.y, e.x, e.y);
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
      if (Utils.dist(p.x, p.y, u.x, u.y) < p.r + u.r + 4) {
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
    const gain = Math.round(base * mult * (revenge ? 1.5 : 1));
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

    const hue = revenge ? 6 : 168;
    this.burst(e.x, e.y, Math.round(5 + e.r * 0.5), hue, 0.9);

    const label = this.combo > 1 ? `+${gain} ×${this.combo}` : `+${gain}`;
    const color = revenge ? '#ffb0b8' : this.combo > 2 ? '#ffd76e' : '#b9f7e8';
    this.floater(e.x, e.y - e.r - 6, label, color, this.combo > 4 ? 18 : 15);

    Sfx.eat(e.r);
    if (this.combo > 1) Sfx.combo(this.combo);

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
    const d = Utils.dist(p.x, p.y, e.x, e.y) || 1;
    const kx = (p.x - e.x) / d;
    const ky = (p.y - e.y) / d;
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
    const d = Utils.dist(p.x, p.y, e.x, e.y) || 1;
    const kx = (p.x - e.x) / d;
    const ky = (p.y - e.y) / d;
    p.vx = kx * 390;
    p.vy = ky * 390;

    this.shake = 14;
    this.burst(p.x, p.y, 18, 6, 1.2);
    this.floater(p.x, p.y - p.r - 18, '-1', '#ff8f9c', 20);
    Sfx.hurt();

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

    this.rays.draw(g, this.vw, this.vh, this.t);
    this.motes.draw(g, this.vw, this.vh);
    Render.drawSeafloor(g, this.vw, this.vh, this.t, depth, 0);

    this.drawPowerups(g);
    this.drawEnemies(g);
    this.drawTrail(g);
    if (this.player && this.player.alive) this.drawPlayer(g);
    this.drawParticles(g);

    for (const f of this.floaters) Render.drawFloater(g, f);

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
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.alpha <= 0.02) continue;
      Render.drawFish(g, e, this.t, {
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
      Render.drawGlow(g, p.x, p.y, p.r * 2.6, p.hue, a * 0.5);
    }
    g.globalAlpha = 1;
  }

  drawPlayer(g) {
    const p = this.player;
    let alpha = 1;
    if (p.invincible > 0) {
      alpha = 0.42 + Math.abs(Math.sin(this.t * 22)) * 0.58;
    }

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
  }

  drawParticles(g) {
    for (const p of this.particles) {
      const a = Utils.clamp(p.life / p.maxLife, 0, 1);
      if (p.kind === 'trail') continue;
      if (p.kind === 'bubble') {
        g.globalAlpha = a * 0.8;
        g.strokeStyle = `hsla(${p.hue}, 100%, 84%, 0.95)`;
        g.lineWidth = Math.max(0.7, p.r * 0.35);
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Utils.TAU);
        g.stroke();
      } else {
        g.globalAlpha = a;
        g.fillStyle = `hsla(${p.hue}, 100%, 80%, 0.95)`;
        g.beginPath();
        g.arc(p.x, p.y, p.r * 0.6, 0, Utils.TAU);
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
      const x = u.x;
      const y = u.y + bob;
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

  /* 触摸拖拽的视觉反馈：原点小圈 + 方向指示 */
  drawTouchHint(g) {
    if (!this.drag.active || this.state !== 'playing') return;
    const x = this.drag.ox;
    const y = this.drag.oy;
    const { dx, dy } = this.drag;
    const d = Math.hypot(dx, dy);
    const maxR = 72 * this.S;

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
