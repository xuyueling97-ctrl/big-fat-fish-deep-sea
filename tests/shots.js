/* 界面截图：开始菜单、暂停、结算，用于视觉验收 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8737;
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 60000);
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

  const userDataDir = path.join(OUT, 'browser-profile-shots');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--remote-debugging-port=9337',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,760', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 80 && !ws; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9337/json/list', (r) => {
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
    width: 1280, height: 760, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(600);

  const shoot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'));
  };

  // 1. 开始菜单
  await shoot('ui-menu.png');

  // 2. 实战画面（跑几秒钟，让鱼群和特效铺开）
  await cdp.evaluate('window.__fishTest.start()');
  await cdp.evaluate('window.__fishTest.autopilot(420)');
  await sleep(400);
  await shoot('ui-playing.png');

  // 3. 暂停界面
  await cdp.evaluate('window.__game.pause()');
  await sleep(400);
  await shoot('ui-paused.png');

  // 4. 结算界面
  await cdp.evaluate(`
    (() => {
      const g = window.__game;
      g.resume();
      g.score = 4820;
      g.eats = 63;
      g.player.r = g.constructor.MAX_R;
      g.lives = 1;
      g.invincible = 0;
      const e = g.enemies.find(x => x.r > g.player.r * 1.18) || g.enemies[0];
      if (e) { e.x = g.player.x; e.y = g.player.y; e.r = g.player.r * 1.6; g.checkCollisions(); }
      return g.state;
    })()
  `);
  await sleep(600);
  await shoot('ui-over.png');

  // 5. 移动端开始菜单
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(700);
  await cdp.evaluate('window.__fishTest.start(); window.__game.pause();');
  await sleep(400);
  await shoot('ui-mobile-pause.png');

  console.log('截图完成: ui-menu.png / ui-playing.png / ui-paused.png / ui-over.png / ui-mobile-pause.png');

  proc.kill();
  server.close();
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(0);
  }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
