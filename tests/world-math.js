/* 世界/相机数学自检：环形折叠、最短路径、相机跟随不跳变、大后期围攻压力 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const ctx = { canvas: null };
global.window = { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, matchMedia: () => ({ matches: false }), addEventListener() {} };
global.localStorage = { getItem: () => null, setItem() {} };
global.document = { getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {} }), addEventListener() {} };
global.performance = { now: () => 0 };

// 用假的 canvas 上下文，避免真的画
const stubCtx = new Proxy({}, {
  get: (t, k) => {
    if (k === 'canvas') return { width: 800, height: 600 };
    if (k === 'createLinearGradient' || k === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    return () => {};
  },
  set: () => true,
});

global.Sfx = {
  dash() {}, ui() {}, power() {}, eat() {}, hurt() {},
  combo() {}, grow() {}, secret() {}, over() {}, start() {}, warning() {},
};

const utilsSrc = fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8');
const renderSrc = fs.readFileSync(path.join(ROOT, 'js/render.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');

const sandbox = { window: global.window, document: global.document, localStorage: global.localStorage, performance: global.performance, Math, JSON, console, Sfx: global.Sfx };
const vm = require('vm');
const context = vm.createContext(sandbox);
vm.runInContext(utilsSrc, context);
vm.runInContext(renderSrc, context);
vm.runInContext(gameSrc, context);

const BigFatFish = vm.runInContext('BigFatFish', context);

const fakeCanvas = {
  width: 800, height: 600,
  getContext: () => stubCtx,
  getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
};

const g = new BigFatFish(fakeCanvas, {});
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// --- 1. 世界尺寸 = 3 x 视口 ---
check('世界宽 = 3x 视口', Math.abs(g.worldW - g.vw * 3) < 1e-6, `worldW=${g.worldW.toFixed(1)} vw=${g.vw.toFixed(1)}`);
check('世界高 = 3x 视口', Math.abs(g.worldH - g.vh * 3) < 1e-6, `worldH=${g.worldH.toFixed(1)} vh=${g.vh.toFixed(1)}`);

// --- 2. wrapDelta 折叠正确 ---
check('wrapDelta 零', g.wrapDelta(0, 100) === 0, '');
check('wrapDelta 半周内原样', g.wrapDelta(40, 100) === 40, '');
check('wrapDelta 越过半周折回', Math.abs(g.wrapDelta(60, 100) - (-40)) < 1e-9, `got ${g.wrapDelta(60, 100)}`);
check('wrapDelta 跨整周', Math.abs(g.wrapDelta(140, 100) - 40) < 1e-9, `got ${g.wrapDelta(140, 100)}`);

// --- 3. ringDist 取最短路径 ---
const W = g.worldW;
check('ringDist 相邻点', Math.abs(g.ringDist(10, 50, 30, 50) - 20) < 1e-6, '');
const nearEdge = g.ringDist(W - 10, 50, 10, 50);
check('ringDist 跨边缘取近路', Math.abs(nearEdge - 20) < 1e-6, `got ${nearEdge.toFixed(2)} 期望 20（而不是 ${(W - 20).toFixed(0)}）`);

// --- 4. 相机跟随玩家 ---
g.start();
const dt = 1 / 60;
// 强制玩家静止，相机应稳定在玩家居中位置
g.player.vx = 0; g.player.vy = 0; g.player.speedRatio = 0;
for (let i = 0; i < 200; i++) g.update(dt);
const pCenterX = g.toScreenX(g.player.x);
const pCenterY = g.toScreenY(g.player.y);
check('静止时玩家居中(横向)', Math.abs(pCenterX - g.vw / 2) < 2, `屏幕 x=${pCenterX.toFixed(1)} 期望 ${(g.vw / 2).toFixed(1)}`);
check('静止时玩家居中(纵向)', Math.abs(pCenterY - g.vh / 2) < 2, `屏幕 y=${pCenterY.toFixed(1)} 期望 ${(g.vh / 2).toFixed(1)}`);

// --- 5. 移动时相机跟随（玩家仍在视野中心附近） ---
g.player.x = g.worldW * 0.5;
g.player.y = g.worldH * 0.5;
g.snapCamera();
for (let i = 0; i < 120; i++) {
  g.pointer.mode = 'keys';
  g.keys.clear();
  g.keys.add('KeyD');
  g.update(dt);
}
const sx = g.toScreenX(g.player.x);
check('移动中玩家保持可见', sx > -g.vw * 0.2 && sx < g.vw * 1.2, `屏幕 x=${sx.toFixed(1)}`);
check('相机确实移动了', Math.abs(g.cam.x - (g.worldW * 0.5 - g.vw * 0.5)) > 5, `cam.x=${g.cam.x.toFixed(1)}`);

// --- 6. 环形穿越不产生相机跳变：从右边缘穿到左边缘，屏幕位置应连续 ---
g.player.x = g.worldW - 5;
g.player.y = g.worldH * 0.5;
g.snapCamera();
let maxJump = 0;
let prevSx = g.toScreenX(g.player.x);
for (let i = 0; i < 200; i++) {
  g.pointer.mode = 'keys';
  g.keys.clear();
  g.keys.add('KeyD');
  g.update(dt);
  const cur = g.toScreenX(g.player.x);
  const jump = Math.abs(cur - prevSx);
  if (jump > maxJump) maxJump = jump;
  prevSx = cur;
}
check('穿越边缘无跳变', maxJump < g.vw * 0.35, `单帧最大位移 ${maxJump.toFixed(1)}px（视口宽 ${g.vw.toFixed(0)}）`);

// --- 7. 敌鱼数量按大地图放大 ---
g.start();
const want = g.enemyTargetCount();
check('敌鱼目标数放大', want >= 60 && want <= 96, `want=${want}`);

// --- 8. 开局有鱼且部分在玩家附近 ---
let nearCount = 0;
for (const e of g.enemies) {
  if (g.ringDist(e.x, e.y, g.player.x, g.player.y) < 600) nearCount++;
}
check('开局玩家附近有鱼', nearCount >= 6, `${nearCount}/${g.enemies.length} 条在 600 距离内`);

// --- 9. 视口裁剪：屏幕外鱼不参与绘制（用计数代理验证） ---
let drawn = 0;
const countingCtx = new Proxy(stubCtx, {
  get: (t, k) => {
    if (k === 'beginPath') return () => { drawn++; };
    return stubCtx[k];
  },
  set: () => true,
});
g.g = countingCtx;
g.player.x = 0;
g.player.y = 0;
g.snapCamera();
// 把鱼全放到远处
for (const e of g.enemies) { e.x = g.worldW * 0.75; e.y = g.worldH * 0.75; }
drawn = 0;
g.drawEnemies(countingCtx);
check('屏幕外敌鱼被裁剪', drawn === 0, `绘制调用 ${drawn} 次`);

// --- 10. 绕回后玩家仍在视野内 ---
g.player.x = g.worldW - 2;
g.player.y = g.worldH * 0.5;
g.snapCamera();
g.player.x += 20;
g.wrap(g.player);
g.updateCamera(dt);
const afterWrapSx = g.toScreenX(g.player.x);
check('绕回后玩家可见', afterWrapSx > -50 && afterWrapSx < g.vw + 50, `屏幕 x=${afterWrapSx.toFixed(1)}`);

// --- 10.5 世界边界接缝回归（冲刺「卡一下然后错位」与鼠标失灵的根因） ---

/* 按住方向键游到越过世界边界，返回是否成功穿越 */
function crossSeam(gg, dir) {
  const p = gg.player;
  p.x = dir === 'KeyD' ? gg.worldW - 200 : gg.worldW * 0.5;
  p.y = dir === 'KeyS' ? gg.worldH - 200 : gg.worldH * 0.5;
  p.vx = 0; p.vy = 0;
  gg.snapCamera();
  gg.pointer.mode = 'keys';
  gg.keys.clear();
  gg.keys.add(dir);
  let prevX = p.x;
  let prevY = p.y;
  let crossed = false;
  for (let i = 0; i < 400; i++) {
    gg.update(dt);
    gg.enemies.length = 0;
    gg.powerups.length = 0;
    if (dir === 'KeyD' && p.x < prevX - gg.worldW * 0.5) { crossed = true; break; }
    if (dir === 'KeyS' && p.y < prevY - gg.worldH * 0.5) { crossed = true; break; }
    prevX = p.x;
    prevY = p.y;
  }
  gg.keys.clear();
  return crossed;
}

/* 鼠标压在鱼身上测它自己的漂移速度。必须清空敌鱼/道具并把速度归零：
   bounce() 会随机推开玩家、残余惯性也会被误读成「鼠标失灵」。 */
function mouseOnFishSpeed(gg, frames = 150) {
  gg.player.vx = 0;
  gg.player.vy = 0;
  gg.pointer.mode = 'pointer';
  let maxSp = 0;
  for (let i = 0; i < frames; i++) {
    gg.setPointer(gg.toScreenX(gg.player.x) * gg.S, gg.toScreenY(gg.player.y) * gg.S);
    gg.update(dt);
    gg.enemies.length = 0;
    gg.powerups.length = 0;
    maxSp = Math.max(maxSp, Math.hypot(gg.player.vx, gg.player.vy));
  }
  return +maxSp.toFixed(1);
}

// 穿越瞬间玩家屏幕位置应连续（扣除正常前进量）；修复前跳变恒等于 2*(r+6) px
for (const r of [13, 30, 62]) {
  const gg = new BigFatFish(fakeCanvas, {});
  gg.start();
  gg.player.r = r;
  gg.player.x = gg.worldW - 2;
  gg.player.y = gg.worldH * 0.5;
  gg.snapCamera();
  gg.pointer.mode = 'keys';
  gg.keys.clear();
  gg.keys.add('KeyD');
  let prevSx = gg.toScreenX(gg.player.x);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    gg.update(dt);
    gg.enemies.length = 0;
    const sx = gg.toScreenX(gg.player.x);
    const j = sx - prevSx;
    if (Math.abs(j) > Math.abs(worst)) worst = j;
    prevSx = sx;
  }
  const pure = +(worst - gg.player.baseSpeed * dt).toFixed(1);
  check(`穿越时玩家屏幕不跳变 r=${r}`, Math.abs(pure) < 15,
    `纯跳变 ${pure}px（修复前约 ${-(2 * (r + 6))}px）`);
}

// 不同体型的鱼若在不同时刻/不同阈值折返，鱼群会在接缝处「错位剪切」
for (const r of [13, 62]) {
  const gg = new BigFatFish(fakeCanvas, {});
  gg.start();
  const p = gg.player;
  p.r = r;
  gg.enemies.length = 0;
  const ref = {
    x: 0, y: 0, vx: 0, vy: 0, r: r * 0.5, baseHue: 200, hue: 200, threat: 0,
    angle: 0, dirRight: true, bulge: 1, phase: 0, wobSpeed: 6, wander: 0,
    speed: 0, speedRatio: 0, age: 99, alpha: 1, fadeIn: false, mouth: 0, tailSwing: 0,
  };
  gg.enemies.push(ref);
  ref.x = gg.worldW - 300;
  ref.y = gg.worldH * 0.5;
  p.x = gg.worldW - 400;
  p.y = gg.worldH * 0.5;
  gg.snapCamera();
  gg.pointer.mode = 'keys';
  gg.keys.clear();
  gg.keys.add('KeyD');
  let prevRel = null;
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    gg.update(dt);
    gg.enemies = gg.enemies.filter((e) => e === ref);
    const rel = gg.toScreenX(ref.x) - gg.toScreenX(p.x);
    if (prevRel !== null) worst = Math.max(worst, Math.abs(rel - prevRel));
    prevRel = rel;
  }
  check(`玩家与敌鱼相对位移不跳变 r=${r}`, worst < 15,
    `最大相对跳变 ${worst.toFixed(1)}px（修复前 ${r === 13 ? 34 : 132}px）`);
}

// 相机只收敛到「相差整张地图」的等价解时，鼠标反算会差一整圈 → 鱼朝固定方向狂游
{
  const gg = new BigFatFish(fakeCanvas, {});
  gg.start();
  gg.player.r = 62;
  const before = mouseOnFishSpeed(gg, 60);
  check('穿越前鼠标压鱼身上不游动', before < 5, `${before}px/s`);
  const crossed = crossSeam(gg, 'KeyD');
  const after = mouseOnFishSpeed(gg);
  check('横向穿越后鼠标操控仍有效', crossed && after < 5,
    `${after}px/s（修复前 238.7px/s）`);
}

{
  const gg = new BigFatFish(fakeCanvas, {});
  gg.start();
  gg.player.r = 62;
  const crossed = crossSeam(gg, 'KeyS');
  const after = mouseOnFishSpeed(gg);
  check('纵向穿越后鼠标操控仍有效', crossed && after < 5,
    `${after}px/s（修复前 390px/s）`);
}

// 连续多次穿越后，相机必须仍和玩家处于同一个世界带
{
  const gg = new BigFatFish(fakeCanvas, {});
  gg.start();
  const p = gg.player;
  p.r = 62;
  gg.snapCamera();
  gg.pointer.mode = 'keys';
  gg.keys.clear();
  gg.keys.add('KeyD');
  let seams = 0;
  let prevX = p.x;
  for (let i = 0; i < 60 * 60; i++) {
    gg.update(dt);
    gg.enemies.length = 0;
    if (p.x < prevX - gg.worldW * 0.5) seams++;
    prevX = p.x;
  }
  gg.keys.clear();
  const offset = Math.abs((p.x - gg.cam.x) / gg.worldW);
  check('多次穿越后相机与玩家同带', offset < 0.4,
    `${seams} 次穿越，偏移 ${offset.toFixed(2)} 个世界`);
  const seamPointerSpeed = mouseOnFishSpeed(gg);
  check('多次穿越后鼠标操控仍有效', seamPointerSpeed < 5, `${seamPointerSpeed}px/s`);
}

// wrap 必须把坐标折回 [0, worldW) / [0, worldH)，不能靠 +2m 余量
{
  const gg = new BigFatFish(fakeCanvas, {});
  let inRange = true;
  for (let i = 0; i < 1000; i++) {
    const e = { x: (Math.random() - 0.5) * gg.worldW * 6, y: (Math.random() - 0.5) * gg.worldH * 6, r: 10 };
    gg.wrap(e);
    if (e.x < 0 || e.x >= gg.worldW || e.y < 0 || e.y >= gg.worldH) inRange = false;
  }
  check('wrap 后坐标落在世界范围内', inRange, '1000 次随机采样');
}

// --- 11. 致命鱼配额：鱼群不会随长时间游玩被大鱼塞满 ---
g.start();
g.player.r = g.constructor.MAX_R;
g.elapsed = 200;
g.enemies.length = 0;
for (let i = 0; i < g.enemyTargetCount(); i++) g.spawnEnemy(true);
// 反复吃小鱼再补鱼，模拟很长时间的游玩
for (let round = 0; round < 400; round++) {
  const p = g.player;
  p.r = g.constructor.MAX_R;
  p.invincible = 5;
  const prey = g.enemies.find((e) => !e.dead && e.r <= p.r * 1.08);
  if (prey) { prey.x = p.x; prey.y = p.y; g.checkCollisions(); }
  g.update(dt);
}
const lethal = g.lethalCount();
const cap = g.lethalCap();
check('致命鱼数量不超过配额', lethal <= cap, `lethal=${lethal} cap=${cap} 总数=${g.enemies.length}`);

// 走真实的 updateSpawns 补充逻辑（含 minPrey 保底），再看占比是否稳定
for (let i = 0; i < 60 * 60; i++) {
  const p = g.player;
  p.invincible = 5;
  p.r = g.constructor.MAX_R;
  g.update(dt);
}
const lethal2 = g.lethalCount();
check('致命鱼占比稳定在配额附近', lethal2 / Math.max(1, g.enemies.length) <= 0.42,
  `占比 ${(lethal2 / Math.max(1, g.enemies.length) * 100).toFixed(1)}%（配额 ${g.constructor.LETHAL_RATIO * 100}%）`);

// --- 12. 掠食者速度不超过玩家基础速度的硬上限 ---
g.start();
g.player.r = g.constructor.MAX_R;
g.elapsed = 220;
g.enemies.length = 0;
for (let i = 0; i < g.enemyTargetCount(); i++) g.spawnEnemy(true);
let worstRatio = 0;
for (let i = 0; i < 60 * 30; i++) {
  g.player.invincible = 5; // 不被吃掉，专测速度
  g.update(dt);
  const p = g.player;
  for (const e of g.enemies) {
    if (e.dead || e.r < p.r * 1.18) continue;
    const ratio = Math.hypot(e.vx, e.vy) / p.baseSpeed;
    if (ratio > worstRatio) worstRatio = ratio;
  }
}
check('掠食者速度受玩家速度约束', worstRatio <= g.constructor.PREDATOR_SPEED_CAP + 0.05,
  `最快 ${worstRatio.toFixed(2)}× 玩家基础速度（上限 ${g.constructor.PREDATOR_SPEED_CAP}）`);

// --- 13. 受伤冲击波把周围大鱼推开 ---
g.start();
g.player.r = g.constructor.MAX_R;
g.player.invincible = 0;
const P = g.player;
// 清空并手工摆 3 条贴脸的大鱼
g.enemies.length = 0;
const ring = [];
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2;
  const e = {
    x: P.x + Math.cos(a) * 30, y: P.y + Math.sin(a) * 30,
    vx: 0, vy: 0, r: P.r * 1.4, baseHue: 200, hue: 200, threat: 1,
    angle: 0, dirRight: true, bulge: 1, phase: 0, wobSpeed: 6,
    wander: 0, speed: 60, speedRatio: 0, age: 1, alpha: 1, fadeIn: false,
    mouth: 0, tailSwing: 0,
  };
  g.enemies.push(e);
  ring.push(e);
}
const beforeDists = ring.map((e) => g.ringDist(e.x, e.y, P.x, P.y));
g.hurt(ring[0]);
const afterDists = ring.map((e) => g.ringDist(e.x, e.y, P.x, P.y));
const pushedAway = afterDists.filter((d, i) => d > beforeDists[i] + 40).length;
check('受伤冲击波推开周围大鱼', pushedAway === ring.length - 1,
  `${pushedAway}/${ring.length - 1} 条被推开（被撞的那条除外）`);

console.log('');
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   ' + r.detail : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
