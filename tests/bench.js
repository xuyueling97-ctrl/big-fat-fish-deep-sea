/* 性能基准：预热 + 多次取中位数，区分真实负载与极端负载 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8734;
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 300000);
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
  const userDataDir = path.join(OUT, 'browser-profile-bench');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--remote-debugging-port=9336',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--window-size=1280,720', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 80 && !ws; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9336/json/list', (r) => {
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
  await sleep(2000);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);

  const result = await cdp.evaluate(`
    (() => {
      const g = window.__game;
      const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

      // 建立指定敌人数量、且播放中的稳定场景
      function setup(enemyCount, withParticles) {
        g.start();
        g.enemies.length = 0;
        g.particles.length = 0;
        g.floaters.length = 0;
        for (let i = 0; i < enemyCount; i++) g.spawnEnemy(true);
        g.elapsed = 60;
        if (withParticles) {
          // 持续补充粒子，模拟吞食连击 + 冲刺拖尾的高峰
          for (let i = 0; i < 120; i++) {
            g.burst(g.vw / 2, g.vh / 2, 4, 168, 1);
            g.ribbon(g.vw / 2, g.vh / 2, 168);
          }
        }
      }

      // 预热：让 JIT 编译路径稳定
      setup(18);
      for (let i = 0; i < 120; i++) { g.update(1 / 60); g.draw(); }

      function bench(enemyCount, rounds, framesPerRound, withParticles) {
        const samples = [];
        let peakParticles = 0;
        setup(enemyCount, withParticles);
        for (let r = 0; r < rounds; r++) {
          const t0 = performance.now();
          for (let i = 0; i < framesPerRound; i++) {
            // 每帧都在制造新粒子，维持高密度
            if (withParticles && i % 3 === 0) g.burst(g.vw / 2, g.vh / 2, 3, 168, 1);
            g.update(1 / 60);
            g.draw();
            peakParticles = Math.max(peakParticles, g.particles.length);
          }
          samples.push((performance.now() - t0) / framesPerRound);
        }
        return {
          enemies: enemyCount,
          withParticles: !!withParticles,
          medianMs: +median(samples).toFixed(2),
          minMs: +Math.min(...samples).toFixed(2),
          maxMs: +Math.max(...samples).toFixed(2),
          peakParticles,
        };
      }

      const real = bench(18, 7, 60, false);
      const realParticles = bench(18, 5, 40, true);
      const heavy = bench(45, 5, 40, false);
      const extreme = bench(75, 5, 30, false);
      const extremeParticles = bench(60, 5, 30, true);

      // 拆解开销：只更新不绘制 vs 只绘制不更新
      setup(18);
      let t0 = performance.now();
      for (let i = 0; i < 300; i++) g.update(1 / 60);
      const updateOnly = (performance.now() - t0) / 300;

      setup(18);
      t0 = performance.now();
      for (let i = 0; i < 300; i++) g.draw();
      const drawOnly = (performance.now() - t0) / 300;

      return {
        real, realParticles, heavy, extreme, extremeParticles,
        updateOnlyMs: +updateOnly.toFixed(2),
        drawOnlyMs: +drawOnly.toFixed(2),
      };
    })()
  `);

  console.log(JSON.stringify(result, null, 2));
  proc.kill();
  server.close();
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(0);
  }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
