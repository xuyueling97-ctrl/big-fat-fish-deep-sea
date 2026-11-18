/* 渲染层：鱼体绘制、发光、背景粒子与光束 */
const Render = (() => {
  const { TAU, clamp } = Utils;

  /* ---------- 鱼的外形 ----------
     s = 半长（横向半径）；鱼头朝 +x，尾巴在 -x */
  function fishBodyPath(g, s, bulge) {
    g.beginPath();
    // 身体：头圆尾细的梭形
    g.moveTo(s * 0.98, 0);
    g.bezierCurveTo(s * 0.92, -s * bulge * 0.62, s * 0.34, -s * bulge * 0.86, -s * 0.24, -s * bulge * 0.44);
    g.bezierCurveTo(-s * 0.5, -s * bulge * 0.26, -s * 0.62, -s * bulge * 0.3, -s * 0.72, -s * bulge * 0.4);
    g.lineTo(-s * 0.7, 0);
    g.lineTo(-s * 0.72, s * bulge * 0.4);
    g.bezierCurveTo(-s * 0.62, s * bulge * 0.3, -s * 0.5, s * bulge * 0.26, -s * 0.24, s * bulge * 0.44);
    g.bezierCurveTo(s * 0.34, s * bulge * 0.86, s * 0.92, s * bulge * 0.62, s * 0.98, 0);
    g.closePath();
  }

  /* 绘制一条鱼
     opts: { hue, glow, alpha, mouth (0..1), tailPhase, spike (bool), eyeScale } */
  function drawFish(g, fish, t, opts) {
    const o = opts || {};
    const s = fish.r;
    const alpha = o.alpha === undefined ? 1 : o.alpha;
    if (alpha <= 0.01 || s < 0.6) return;

    const hue = o.hue === undefined ? fish.hue : o.hue;
    const facing = Math.cos(fish.angle) >= 0 ? 1 : -1;
    const bulge = fish.bulge || 1;
    const wob = Math.sin(t * (fish.wobSpeed || 6) + (fish.phase || 0));
    const spike = o.spike ? 1 : 0;

    // 先做水平镜像，再按镜像后的角度旋转，鱼头才会正确朝向游动方向
    let tilt = facing === 1 ? fish.angle : Math.PI - fish.angle;
    tilt = Math.atan2(Math.sin(tilt), Math.cos(tilt));
    tilt = clamp(tilt, -0.62, 0.62);

    g.save();
    g.translate(fish.x, fish.y);
    g.scale(facing, 1);
    g.rotate(tilt);

    // 尾摆角度随速度增强
    const tailAngle = wob * (0.28 + (fish.speedRatio || 0) * 0.4) + (fish.tailSwing || 0);

    // ---- 尾鳍 ----
    g.save();
    g.translate(-s * 0.66, 0);
    g.rotate(tailAngle);
    g.globalAlpha = alpha * 0.92;
    const tg = g.createLinearGradient(0, 0, -s * 0.85, 0);
    tg.addColorStop(0, `hsla(${hue}, 82%, 58%, 0.95)`);
    tg.addColorStop(1, `hsla(${hue + 24}, 88%, 68%, 0.45)`);
    g.fillStyle = tg;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(-s * 0.4, -s * 0.34 * bulge, -s * 0.92, -s * 0.46 * bulge);
    g.quadraticCurveTo(-s * 0.72, 0, -s * 0.92, s * 0.46 * bulge);
    g.quadraticCurveTo(-s * 0.4, s * 0.34 * bulge, 0, 0);
    g.closePath();
    g.fill();
    g.restore();

    // ---- 背鳍 ----
    g.globalAlpha = alpha * 0.85;
    const fi = g.createLinearGradient(0, -s * bulge * 0.6, 0, -s * bulge * 1.15);
    fi.addColorStop(0, `hsla(${hue + 12}, 85%, 62%, 0.9)`);
    fi.addColorStop(1, `hsla(${hue + 40}, 92%, 74%, 0.28)`);
    g.fillStyle = fi;
    g.beginPath();
    g.moveTo(s * 0.3, -s * bulge * 0.62);
    if (spike) {
      // 掠食者背刺
      for (let i = 0; i < 4; i++) {
        const x0 = s * 0.28 - i * s * 0.24;
        g.lineTo(x0 + s * 0.1, -s * bulge * (0.95 + 0.22 * (1 - i / 4)));
        g.lineTo(x0 - s * 0.06, -s * bulge * (0.66 + 0.06 * i));
      }
    } else {
      g.quadraticCurveTo(s * 0.02, -s * bulge * 1.16, -s * 0.34, -s * bulge * 0.58);
    }
    g.closePath();
    g.fill();

    // ---- 腹鳍 ----
    g.globalAlpha = alpha * 0.55;
    g.fillStyle = `hsla(${hue + 30}, 88%, 72%, 0.8)`;
    g.beginPath();
    g.moveTo(s * 0.08, s * bulge * 0.5);
    g.quadraticCurveTo(-s * 0.1, s * bulge * 0.96, -s * 0.4, s * bulge * 0.56);
    g.closePath();
    g.fill();

    // ---- 身体 ----
    g.globalAlpha = alpha;
    const bg = g.createLinearGradient(s * 0.5, -s * bulge * 0.8, -s * 0.4, s * bulge * 0.85);
    bg.addColorStop(0, `hsl(${hue - 6}, 88%, 72%)`);
    bg.addColorStop(0.42, `hsl(${hue}, 84%, 57%)`);
    bg.addColorStop(1, `hsl(${hue + 22}, 72%, 34%)`);
    g.fillStyle = bg;
    fishBodyPath(g, s, bulge);
    g.fill();

    // 高光
    g.globalAlpha = alpha * 0.4;
    const hl = g.createRadialGradient(s * 0.42, -s * bulge * 0.34, 0, s * 0.42, -s * bulge * 0.34, s * 0.72);
    hl.addColorStop(0, 'rgba(255,255,255,0.95)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl;
    fishBodyPath(g, s, bulge);
    g.fill();

    // 腹部亮带
    g.globalAlpha = alpha * 0.34;
    g.fillStyle = `hsla(${hue + 44}, 100%, 86%, 0.9)`;
    g.beginPath();
    g.ellipse(-s * 0.02, s * bulge * 0.36, s * 0.5, s * bulge * 0.13, -0.06, 0, TAU);
    g.fill();

    // ---- 眼睛 ----
    const eyeX = s * 0.56;
    const eyeY = -s * bulge * 0.16;
    const eyeR = Math.max(0.85, s * 0.175 * (o.eyeScale || 1));
    g.globalAlpha = alpha;
    g.fillStyle = 'rgba(255,255,255,0.97)';
    g.beginPath();
    g.arc(eyeX, eyeY, eyeR, 0, TAU);
    g.fill();
    g.fillStyle = '#04212b';
    g.beginPath();
    g.arc(eyeX + eyeR * 0.22, eyeY - eyeR * 0.04, eyeR * 0.56, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.arc(eyeX + eyeR * 0.46, eyeY - eyeR * 0.34, eyeR * 0.2, 0, TAU);
    g.fill();

    // ---- 嘴 ----
    const mouth = o.mouth === undefined ? 0 : o.mouth;
    if (mouth > 0.02) {
      g.globalAlpha = alpha;
      g.fillStyle = 'rgba(9, 26, 33, 0.82)';
      g.beginPath();
      g.moveTo(s * 0.94, s * bulge * 0.06);
      g.quadraticCurveTo(s * 0.72, -s * bulge * (0.12 + mouth * 0.4), s * 0.6, s * bulge * 0.06);
      g.quadraticCurveTo(s * 0.74, s * bulge * (0.3 + mouth * 0.3), s * 0.94, s * bulge * 0.06);
      g.fill();
    }

    // ---- 掠食者轮廓光 ----
    if (o.danger) {
      g.globalAlpha = alpha * 0.9;
      g.strokeStyle = `hsla(${hue - 8}, 100%, 62%, 0.85)`;
      g.lineWidth = Math.max(1, s * 0.07);
      fishBodyPath(g, s, bulge);
      g.stroke();
    } else if (o.peer) {
      // 体型接近：淡白描边，提示"撞不赢也吃不下"
      g.globalAlpha = alpha * 0.4;
      g.strokeStyle = 'rgba(232, 251, 255, 0.9)';
      g.lineWidth = Math.max(0.8, s * 0.045);
      g.setLineDash([Math.max(2, s * 0.16), Math.max(2.5, s * 0.14)]);
      fishBodyPath(g, s, bulge);
      g.stroke();
      g.setLineDash([]);
    }

    g.restore();
  }

  /* ---------- 预渲染发光贴图 ----------
     每帧为几十个粒子新建径向渐变开销很大，改为生成一次后 drawImage 复用 */
  const glowCache = new Map();

  function glowSprite(hue) {
    const key = Math.round(hue / 12) * 12;
    let cv = glowCache.get(key);
    if (cv) return cv;

    const size = 64;
    cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const c = cv.getContext('2d');
    const h = ((key % 360) + 360) % 360;
    const grd = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, `hsla(${h}, 100%, 84%, 0.95)`);
    grd.addColorStop(0.35, `hsla(${h}, 100%, 70%, 0.45)`);
    grd.addColorStop(1, `hsla(${h}, 100%, 60%, 0)`);
    c.fillStyle = grd;
    c.fillRect(0, 0, size, size);

    glowCache.set(key, cv);
    return cv;
  }

  function drawGlow(g, x, y, radius, hue, alpha, mode) {
    const sprite = glowSprite(hue);
    const prev = g.globalAlpha;
    const prevOp = g.globalCompositeOperation;
    g.globalAlpha = alpha;
    if (mode) g.globalCompositeOperation = mode;
    g.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
    g.globalAlpha = prev;
    g.globalCompositeOperation = prevOp;
  }

  /* ---------- 环境粒子（浮游生物 / 气泡） ---------- */
  class Motes {
    constructor(count) {
      this.items = [];
      this.resize(count);
    }
    resize(count) {
      this.items.length = 0;
      for (let i = 0; i < count; i++) this.items.push(this.spawn(true));
    }
    spawn(anywhere) {
      return {
        x: Math.random(),
        y: anywhere ? Math.random() : 1.04,
        r: Utils.rand(0.6, 2.6),
        sp: Utils.rand(0.008, 0.045),
        drift: Utils.rand(-0.012, 0.012),
        a: Utils.rand(0.18, 0.75),
        ph: Utils.rand(0, Utils.TAU),
        glow: Math.random() < 0.34,
        hue: Utils.rand(150, 205),
        kind: Math.random() < 0.22 ? 'bubble' : 'mote',
      };
    }
    update(dt, t, heightN) {
      for (const p of this.items) {
        p.y -= p.sp * dt * (p.kind === 'bubble' ? 1.9 : 1);
        p.x += (p.drift + Math.sin(t * 0.5 + p.ph) * 0.006) * dt;
        if (p.y < -0.05) {
          Object.assign(p, this.spawn(false));
        }
        if (p.x < -0.05) p.x = 1.04;
        if (p.x > 1.05) p.x = -0.04;
      }
    }
    draw(g, w, h) {
      for (const p of this.items) {
        const x = p.x * w;
        const y = p.y * h;
        if (p.kind === 'bubble') {
          g.globalAlpha = p.a * 0.45;
          g.strokeStyle = 'rgba(190, 245, 255, 0.9)';
          g.lineWidth = 0.9;
          g.beginPath();
          g.arc(x, y, p.r * 1.9, 0, TAU);
          g.stroke();
        } else if (p.glow) {
          const r = p.r * 6;
          drawGlow(g, x, y, r, p.hue, p.a * 0.75);
        } else {
          g.globalAlpha = p.a;
          g.fillStyle = 'rgba(190, 235, 250, 0.8)';
          g.beginPath();
          g.arc(x, y, p.r * 0.55, 0, TAU);
          g.fill();
        }
      }
      g.globalAlpha = 1;
    }
  }

  /* ---------- 光柱 ---------- */
  class Rays {
    constructor() {
      this.items = [];
      for (let i = 0; i < 5; i++) {
        this.items.push({
          x: Utils.rand(0.05, 0.95),
          w: Utils.rand(0.03, 0.11),
          a: Utils.rand(0.05, 0.13),
          ph: Utils.rand(0, TAU),
          sp: Utils.rand(0.1, 0.26),
        });
      }
    }
    draw(g, w, h, t) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const r of this.items) {
        const sway = Math.sin(t * r.sp + r.ph) * 0.07;
        const x = (r.x + sway) * w;
        const halfW = r.w * w * 0.5;
        const grd = g.createLinearGradient(x, 0, x + halfW * 0.6, h);
        grd.addColorStop(0, `rgba(150, 235, 255, ${r.a})`);
        grd.addColorStop(0.55, `rgba(120, 210, 240, ${r.a * 0.35})`);
        grd.addColorStop(1, 'rgba(90, 180, 220, 0)');
        g.fillStyle = grd;
        g.beginPath();
        g.moveTo(x - halfW * 0.5, -10);
        g.lineTo(x + halfW, -10);
        g.lineTo(x + halfW * 2.1, h + 10);
        g.lineTo(x - halfW * 1.5, h + 10);
        g.closePath();
        g.fill();
      }
      g.restore();
    }
  }

  /* ---------- 背景水色 ---------- */
  function drawBackground(g, w, h, depthN, t) {
    // 越深越暗、越蓝
    const topL = 26 - depthN * 14;
    const topS = 62;
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, `hsl(193, ${topS}%, ${clamp(topL, 6, 30)}%)`);
    bg.addColorStop(0.52, `hsl(${204 + depthN * 6}, 68%, ${clamp(16 - depthN * 9, 3, 18)}%)`);
    bg.addColorStop(1, `hsl(${218 + depthN * 4}, 74%, ${clamp(8 - depthN * 5, 2, 10)}%)`);
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
  }

  /* ---------- 海底轮廓 ---------- */
  function drawSeafloor(g, w, h, t, depthN, offset) {
    const baseY = h * (0.94 + depthN * 0.02) + offset;
    g.save();
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, baseY);
    const steps = 7;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * w;
      const y = baseY - Math.sin(i * 1.7 + t * 0.35) * h * 0.022 - (i % 2) * h * 0.016;
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    const grd = g.createLinearGradient(0, baseY - h * 0.09, 0, h);
    grd.addColorStop(0, `hsla(200, 72%, ${8 - depthN * 4}%, 0.92)`);
    grd.addColorStop(1, 'rgba(2, 10, 15, 0.99)');
    g.fillStyle = grd;
    g.fill();
    g.restore();
  }

  /* ---------- 前景暗角 ---------- */
  function drawVignette(g, w, h) {
    const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.78);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(1, 8, 12, 0.62)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }

  /* ---------- 漂浮分数文字 ---------- */
  function drawFloater(g, f) {
    const p = f.life / f.maxLife;
    const alpha = clamp(p * 1.6, 0, 1);
    const scale = 0.86 + Utils.easeOutBack(clamp(1 - p, 0, 1)) * 0.22;
    g.save();
    g.globalAlpha = alpha;
    g.translate(f.x, f.y);
    g.scale(scale, scale);
    g.font = `800 ${f.size}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(3, 18, 26, 0.72)';
    g.strokeText(f.text, 0, 0);
    g.fillStyle = f.color;
    g.fillText(f.text, 0, 0);
    g.restore();
  }

  return {
    drawFish, drawBackground, drawSeafloor, drawVignette,
    drawFloater, drawGlow, Motes, Rays, fishBodyPath,
  };
})();
