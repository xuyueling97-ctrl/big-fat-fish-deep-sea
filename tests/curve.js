/* 长期成长曲线：用无头浏览器驱动自动游玩，采样成长与得分随时间的变化 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8732;
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 120000);
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
  const userDataDir = path.join(OUT, 'browser-profile-curve');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--remote-debugging-port=9334',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,720', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9334/json/list', (r) => {
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

  // 在页面内跑一个长模拟：按固定步长推进，每 10 秒记录一次
  const result = await cdp.evaluate(`
    (() => {
      const g = window.__game;
      g.start();
      const samples = [];
      const dt = 1 / 60;
      let deaths = 0;
      const gameOverAt = [];

      const autopilotStep = () => {
        const p = g.player;
        if (!p || !p.alive) return;
        // 真实的玩家只会躲"真正致命"的鱼，其余时间都在吃。
        // 世界是环形的，距离必须走最短路径，否则跨边界时会把近处的鱼当成很远。
        let prey = null, pd = Infinity;
        let threat = null, td = Infinity;
        for (const e of g.enemies) {
          const d = g.ringDist(e.x, e.y, p.x, p.y);
          if (e.r <= p.r * 1.08) { if (d < pd) { pd = d; prey = e; } }
          else if (e.r >= p.r * 1.18 && d < 165) { if (d < td) { td = d; threat = e; } }
        }
        let tx = p.x, ty = p.y;
        if (threat) {
          // 沿最短路径的反方向躲开
          tx = p.x - g.wrapDelta(threat.x - p.x, g.worldW) * 1.6;
          ty = p.y - g.wrapDelta(threat.y - p.y, g.worldH) * 1.6;
        } else if (prey) {
          tx = p.x + g.wrapDelta(prey.x - p.x, g.worldW);
          ty = p.y + g.wrapDelta(prey.y - p.y, g.worldH);
        } else {
          tx = g.worldW * 0.5;
          ty = g.worldH * 0.5;
        }
        // setPointer 收的是画布局部坐标，先投影到屏幕再换算
        const sx = g.toScreenX(tx);
        const sy = g.toScreenY(ty);
        g.setPointer(sx * g.S, sy * g.S);
      };

      for (let step = 0; step < 60 * 180; step++) {
        if (g.state !== 'playing') break;
        autopilotStep();
        g.update(dt);
        if (step % (60 * 10) === 0) {
          samples.push({
            t: Math.round(g.elapsed),
            score: Math.round(g.score),
            r: +g.player.r.toFixed(1),
            stage: g.stageName(),
            lives: g.lives,
            eats: g.eats,
          });
        }
      }
      return {
        samples,
        endState: g.state,
        totalTime: +g.elapsed.toFixed(1),
        finalScore: Math.round(g.score),
        finalR: +g.player.r.toFixed(1),
        finalStage: g.stageName(),
        needs: g.lives,
        eats: g.eats,
      };
    })()
  `);

  console.log(JSON.stringify(result, null, 2));

  proc.kill();
  server.close();
  // 浏览器完全退出后再删配置目录，否则文件占用会失败
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(0);
  }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
