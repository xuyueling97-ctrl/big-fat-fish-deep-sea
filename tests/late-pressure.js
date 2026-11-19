/* 大后期围攻压力测试：满级体型 + 6000 分的场景下，A/B 对比修复前后的存活时间。
   直接跑 `node tests/late-pressure.js`，会各跑 5 轮取中位数。 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8757;
const OUT = path.resolve(__dirname, 'out');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 300000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

/* cap = 掠食者速度上限倍率；chasers = 同时全速追击条数。设为 null 表示不施加该限制（复现旧行为） */
const makeScenario = (cap, chasers) => `
  (() => {
    const g = window.__game;
    const Ctor = g.constructor;
    // 运行时覆盖静态配置，用来做 A/B
    ${cap === null
      ? "Object.defineProperty(Ctor, 'PREDATOR_SPEED_CAP', { value: 99, configurable: true });"
      : `Object.defineProperty(Ctor, 'PREDATOR_SPEED_CAP', { value: ${cap}, configurable: true });`}
    ${chasers === null
      ? "Object.defineProperty(Ctor, 'MAX_CHASERS', { value: 999, configurable: true });"
      : `Object.defineProperty(Ctor, 'MAX_CHASERS', { value: ${chasers}, configurable: true });`}

    g.start();
    const dt = 1 / 60;

    // 用户报告的场景：6000 分、满级体型、后期时间、3 条命
    g.score = 6000;
    g.elapsed = 200;
    g.eats = 120;
    g.player.r = Ctor.MAX_R;
    g.lives = 3;
    g.player.invincible = 0;
    g.player.baseSpeed = 306 * 0.78;
    g.enemies.length = 0;
    for (let i = 0; i < g.enemyTargetCount(); i++) g.spawnEnemy(true);

    // 一个"会玩的人"：躲最近的致命鱼、危急时冲刺、否则去吃猎物
    const step = () => {
      const p = g.player;
      if (!p || !p.alive) return;
      let prey = null, pd = Infinity;
      let threat = null, td = Infinity;
      let lethalCount = 0;
      for (const e of g.enemies) {
        if (e.dead) continue;
        const d = g.ringDist(e.x, e.y, p.x, p.y);
        if (e.r >= p.r * 1.18) {
          if (d < 260) lethalCount++;
          if (d < td) { td = d; threat = e; }
        } else if (e.r <= p.r * 1.08) {
          if (d < pd) { pd = d; prey = e; }
        }
      }
      // 贴脸就冲刺
      if (td < 90 && p.dashCd <= 0) g.dash();
      let tx = p.x, ty = p.y;
      if (threat && td < 260) {
        tx = p.x - g.wrapDelta(threat.x - p.x, g.worldW) * 2.5;
        ty = p.y - g.wrapDelta(threat.y - p.y, g.worldH) * 2.5;
      } else if (prey) {
        tx = p.x + g.wrapDelta(prey.x - p.x, g.worldW);
        ty = p.y + g.wrapDelta(prey.y - p.y, g.worldH);
      } else { tx = g.worldW * 0.5; ty = g.worldH * 0.5; }
      g.setPointer(g.toScreenX(tx) * g.S, g.toScreenY(ty) * g.S);
    };

    // 保持比分/体型不变，只观察"能撑多久"（3 条命耗尽为止）
    const startT = g.elapsed;
    let frames = 0;
    let maxSurround = 0;
    let maxSpd = 0;

    // 记录受伤间隔：被围攻致死的体感来自"连掉几条命"，而不是总时长
    const hurtTimes = [];
    const rawHurt = Object.getPrototypeOf(g).hurt;
    const origHurt2 = rawHurt.bind(g);
    g.hurt = function (e) {
      hurtTimes.push(+g.elapsed.toFixed(2));
      return origHurt2(e);
    };

    while (frames < 60 * 180 && g.state === 'playing') {
      step();
      g.update(dt);
      frames++;
      const p = g.player;
      if (!p || !p.alive) break;
      p.r = Ctor.MAX_R;   // 维持满级，专注观察围攻压力
      g.score = 6000;
      if (frames % 30 === 0) {
        let w380 = 0;
        for (const e of g.enemies) {
          if (e.dead || e.r < p.r * 1.18) continue;
          if (g.ringDist(e.x, e.y, p.x, p.y) < 380) w380++;
          const sp = Math.hypot(e.vx, e.vy) / p.baseSpeed;
          if (sp > maxSpd) maxSpd = sp;
        }
        if (w380 > maxSurround) maxSurround = w380;
      }
    }
    // 相邻两次受伤的最小间隔：越小说明越像"被围死连掉三条命"
    let minGap = null;
    for (let i = 1; i < hurtTimes.length; i++) {
      const gap = +(hurtTimes[i] - hurtTimes[i - 1]).toFixed(2);
      if (minGap === null || gap < minGap) minGap = gap;
    }
    return {
      survivedSec: +(g.elapsed - startT).toFixed(1),
      endState: g.state,
      livesLeft: g.lives,
      hurtCount: hurtTimes.length,
      minHurtGap: minGap,
      maxSurroundWithin380: maxSurround,
      maxPredSpeedRatio: +maxSpd.toFixed(2),
    };
  })()
`;

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const userDataDir = path.join(OUT, 'browser-profile-ab');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--remote-debugging-port=9357',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,720', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9357/json/list', (r) => {
          let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
      });
      const p = list.find((t) => t.type === 'page');
      if (p) ws = p.webSocketDebuggerUrl;
    } catch (e) { /* wait */ }
  }
  const cdp = new CDP(ws);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1800);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(200);

  // 旧行为 vs 新行为，各跑 REPEAT 轮取中位数（单轮随机波动很大）
  const REPEAT = 5;
  const runMany = async (cap, chasers) => {
    const runs = [];
    for (let i = 0; i < REPEAT; i++) {
      runs.push(await cdp.evaluate(makeScenario(cap, chasers)));
    }
    const med = (arr) => {
      const a = [...arr].sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)];
    };
    return {
      runs,
      medianSurvivedSec: med(runs.map((r) => r.survivedSec)),
      medianMaxSurround: med(runs.map((r) => r.maxSurroundWithin380)),
      worstMaxSurround: Math.max(...runs.map((r) => r.maxSurroundWithin380)),
      worstMaxSpeedRatio: Math.max(...runs.map((r) => r.maxPredSpeedRatio)),
    };
  };

  const before = await runMany(null, null);
  await cdp.evaluate('location.reload()');
  await sleep(2200);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const after = await runMany(1.06, 2);

  console.log(JSON.stringify({ before, after }, null, 2));

  proc.kill();
  server.close();
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(0);
  }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
