/* 无头浏览器冒烟测试：加载页面、捕获异常、跑自动游玩、截图 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8731;
const OUT = path.resolve(__dirname, 'out');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

// 极简 CDP 客户端
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();

  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  // 固定临时配置目录，每次启动前清掉上次残留，避免无限制累积
  const userDataDir = path.join(OUT, 'browser-profile-smoke');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const proc = spawn(edge, [
    '--headless=new',
    '--remote-debugging-port=9333',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,720',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let procErr = '';
  proc.stderr.on('data', (d) => { procErr += d.toString(); });

  // 等待调试端口
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9333/json/list', (r) => {
          let b = '';
          r.on('data', (c) => b += c);
          r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
      });
      const page = list.find((t) => t.type === 'page');
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* 继续等待 */ }
  }
  if (!wsUrl) {
    console.error('无法连接调试端口');
    console.error(procErr.slice(-2000));
    proc.kill();
    server.close();
    process.exit(1);
  }

  const cdp = new CDP(wsUrl);
  await cdp.ready;

  const consoleErrors = [];
  const pageErrors = [];

  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2200);

  const report = {};
  report.title = await cdp.evaluate('document.title');
  report.hasGame = await cdp.evaluate('typeof window.__game === "object"');
  report.state0 = await cdp.evaluate('window.__game && window.__game.state');
  report.canvasSize = await cdp.evaluate('(() => { const c = document.getElementById("game"); return c.width + "x" + c.height; })()');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);

  // 开始游戏
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(600);
  report.stateAfterStart = await cdp.evaluate('window.__game.state');
  report.enemies = await cdp.evaluate('window.__fishTest.enemyCount()');
  report.r0 = await cdp.evaluate('window.__fishTest.playerR()');

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'start.png'), Buffer.from(shot.data, 'base64'));

  // 模拟自动游玩
  const snap = await cdp.evaluate('window.__fishTest.autopilot(900)');
  report.afterAutopilot = snap;
  report.r1 = await cdp.evaluate('window.__fishTest.playerR()');

  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'play.png'), Buffer.from(shot2.data, 'base64'));

  // 强制游戏结束，验证结算界面
  await cdp.evaluate('(() => { const g = window.__game; g.player.r = g.constructor.START_R; g.invincible = 0; g.lives = 1; const big = g.enemies.find(e => e.r > g.player.r) || g.enemies[0]; if (big) { big.x = g.player.x; big.y = g.player.y; big.r = g.player.r * 1.8; g.checkCollisions(); } return g.state; })()');
  await sleep(500);
  report.stateAfterHurt = await cdp.evaluate('window.__game.state');

  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'over.png'), Buffer.from(shot3.data, 'base64'));

  report.overTitle = await cdp.evaluate('document.getElementById("overTitle").textContent');
  report.finalScoreText = await cdp.evaluate('document.getElementById("finalScore").textContent');
  report.overVisible = await cdp.evaluate('!document.getElementById("screenOver").classList.contains("is-hidden")');

  // 重新开始
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(400);
  report.restartState = await cdp.evaluate('window.__game.state');
  report.restartLives = await cdp.evaluate('window.__game.lives');
  report.restartR = await cdp.evaluate('window.__fishTest.playerR()');

  // 暂停
  await cdp.evaluate('window.__game.pause()');
  await sleep(200);
  report.pausedState = await cdp.evaluate('window.__game.state');
  report.pauseVisible = await cdp.evaluate('!document.getElementById("screenPause").classList.contains("is-hidden")');
  await cdp.evaluate('window.__game.resume()');
  await sleep(150);
  report.resumeState = await cdp.evaluate('window.__game.state');

  // 冲刺
  report.dashOk = await cdp.evaluate('window.__game.dash()');
  report.dashCd = await cdp.evaluate('+window.__game.player.dashCd.toFixed(3)');

  // 移动端视口
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(500);
  const shot4 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'mobile.png'), Buffer.from(shot4.data, 'base64'));
  report.mobileState = await cdp.evaluate('window.__game.state');
  report.mobileVw = await cdp.evaluate('Math.round(window.__game.vw) + "x" + Math.round(window.__game.vh)');

  // PC 端不能被误判为触屏：鼠标操作时不应出现触屏 UI
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(400);
  report.desktop = await cdp.evaluate(`(() => {
    const dashBtn = document.getElementById('dashBtn');
    const dashCs = getComputedStyle(dashBtn);
    const hintTouch = getComputedStyle(document.querySelector('.hint-touch'));
    const hintDesktop = getComputedStyle(document.querySelector('.hint-desktop'));
    return {
      isTouchMode: document.body.classList.contains('is-touch'),
      dashBtnDisplay: dashCs.display,
      touchHintDisplay: hintTouch.display,
      desktopHintDisplay: hintDesktop.display,
    };
  })()`);

  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;

  console.log(JSON.stringify(report, null, 2));

  cdp.ws.close();
  proc.kill();
  server.close();
  // 浏览器完全退出后再删配置目录，否则文件占用会失败
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    process.exit(0);
  }, 800);
})().catch((e) => {
  console.error('测试脚本失败:', e);
  process.exit(1);
});
