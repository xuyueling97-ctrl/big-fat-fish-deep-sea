/* 稳定性与性能测试：长时间运行、多种分辨率、帧耗时采样 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8733;
const OUT = path.resolve(__dirname, 'out');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 180000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, r));
  // 固定临时配置目录，启动前清掉上次残留，避免无限制累积
  const userDataDir = path.join(OUT, 'browser-profile-stability');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--remote-debugging-port=9335',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9335/json/list', (r) => {
          let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
      });
      const p = list.find((t) => t.type === 'page');
      if (p) ws = p.webSocketDebuggerUrl;
    } catch (e) { /* wait */ }
  }
  const cdp = new CDP(ws);
  await cdp.ready;
  const errors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1800);

  const report = { resolutions: [], perf: null, stress: null, errors };

  for (const [w, h, dpr, label] of [
    [1440, 900, 1, 'desktop'],
    [1920, 1080, 1, 'fullhd'],
    [844, 390, 2, 'phone-landscape'],
    [390, 844, 2, 'phone-portrait'],
    [1024, 768, 1.5, 'tablet'],
  ]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: dpr, mobile: dpr > 1,
    });
    await cdp.evaluate('window.__fishTest.start()');
    await sleep(500);
    await cdp.evaluate('window.__fishTest.autopilot(240)');
    const info = await cdp.evaluate(`(() => {
      const g = window.__game;
      return {
        canvas: g.canvas.width + 'x' + g.canvas.height,
        logical: Math.round(g.vw) + 'x' + Math.round(g.vh),
        scale: +g.S.toFixed(2),
        playerOnScreen: g.player.x > 0 && g.player.x < g.vw && g.player.y > 0 && g.player.y < g.vh,
        hudInViewport: (() => {
          const r = document.getElementById('hud').getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1;
        })(),
        dashBtnRect: (() => {
          const el = document.getElementById('dashBtn');
          const r = el.getBoundingClientRect();
          return { right: Math.round(r.right), bottom: Math.round(r.bottom), vw: window.innerWidth, vh: window.innerHeight };
        })(),
        state: g.state,
      };
    })()`);
    report.resolutions.push({ label, w, h, dpr, ...info });
  }

  // 帧耗时：直接测量 draw 的耗时（模拟 200 帧）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(300);
  report.perf = await cdp.evaluate(`(() => {
    const g = window.__game;
    // 灌满实体以模拟后期高负载
    for (let i = 0; i < 60; i++) g.spawnEnemy(false);
    for (let i = 0; i < 200; i++) g.burst(g.vw / 2, g.vh / 2, 6, 168, 1);
    const t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) { g.update(1 / 60); g.draw(); }
    const total = performance.now() - t0;
    return {
      frames: N,
      msPerFrame: +(total / N).toFixed(2),
      enemies: g.enemies.length,
      particles: g.particles.length,
    };
  })()`);

  // 压力：连续 8 分钟游戏时间，检查是否崩溃 / 对象泄漏
  report.stress = await cdp.evaluate(`(() => {
    const g = window.__game;
    g.start();
    const dt = 1 / 60;
    const frames = 60 * 60 * 8;
    let maxParticles = 0, maxEnemies = 0;
    for (let i = 0; i < frames; i++) {
      if (g.state !== 'playing') { g.start(); }
      // 傻瓜式操作：随机游走，让 AI 不去干涉
      const p = g.player;
      let preys = [];
      for (const e of g.enemies) if (e.r <= p.r * 1.08) preys.push(e);
      let tx = g.vw * 0.5, ty = g.vh * 0.5;
      if (preys.length) {
        let best = preys[0], bd = Infinity;
        for (const e of preys) {
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          if (d < bd) { bd = d; best = e; }
        }
        tx = best.x; ty = best.y;
      }
      g.setPointer(Math.max(20, Math.min(g.vw - 20, tx)) * g.S, Math.max(20, Math.min(g.vh - 20, ty)) * g.S);
      g.update(dt);
      if (i % 30 === 0) g.draw();
      maxParticles = Math.max(maxParticles, g.particles.length);
      maxEnemies = Math.max(maxEnemies, g.enemies.length);
    }
    return {
      finalState: g.state,
      maxParticles,
      maxEnemies,
      enemiesNow: g.enemies.length,
      floatersNow: g.floaters.length,
      particlesNow: g.particles.length,
      powerupsNow: g.powerups.length,
    };
  })()`);

  console.log(JSON.stringify(report, null, 2));
  proc.kill();
  server.close();
  // 浏览器完全退出后再删配置目录，否则文件占用会失败
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(0);
  }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
