/* 移动端兼容性测试：真实触摸事件、多设备视口、横竖屏切换、后台暂停 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8740;
const OUT = path.resolve(__dirname, 'out');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
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

// 通过 CDP 派发真实触摸序列
async function touchDrag(cdp, from, to, steps = 8) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        id: 1,
      }],
    });
    await sleep(16);
  }
}

async function touchEnd(cdp, at) {
  // CDP 要求 touchPoints 至少 1 个，空数组会报 -32602
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: at.x, y: at.y, id: 1 }],
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, r));

  const userDataDir = path.join(OUT, 'browser-profile-mobile');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--remote-debugging-port=9340',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 80 && !ws; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9340/json/list', (r) => {
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(m.params.entry.text);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1800);

  const report = { devices: [], touch: null, orientation: null, background: null, errors };

  const DEVICES = [
    { name: 'iPhone 12 (390x844)', w: 390, h: 844, dpr: 3, mobile: true },
    { name: 'iPhone SE (375x667)', w: 375, h: 667, dpr: 2, mobile: true },
    { name: 'Pixel 5 竖屏 (393x851)', w: 393, h: 851, dpr: 2.75, mobile: true },
    { name: 'iPhone 12 横屏 (844x390)', w: 844, h: 390, dpr: 3, mobile: true },
    { name: 'iPad (768x1024)', w: 768, h: 1024, dpr: 2, mobile: true },
    { name: '小屏横屏 (667x375)', w: 667, h: 375, dpr: 2, mobile: true },
  ];

  for (const d of DEVICES) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: d.mobile,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(350);

    // 触摸能力只在加载时判定，模拟环境是加载后才开启触摸的，
    // 这里按真实触摸路径补判定，再进入 playing 状态测量 HUD
    await cdp.evaluate('window.__fishConfirmTouch && window.__fishConfirmTouch(); window.__fishTest.start();');
    await sleep(450);

    const info = await cdp.evaluate(`(() => {
      const g = window.__game;
      const safe = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return { visible: false };
        return {
          visible: true,
          left: Math.round(r.left), top: Math.round(r.top),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
          inViewport: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
        };
      };
      return {
        viewport: window.innerWidth + 'x' + window.innerHeight,
        canvas: g.canvas.width + 'x' + g.canvas.height,
        logical: Math.round(g.vw) + 'x' + Math.round(g.vh),
        scale: +g.S.toFixed(2),
        state: g.state,
        isTouchMode: document.body.classList.contains('is-touch'),
        hud: safe(document.getElementById('hud')),
        meter: safe(document.querySelector('.meter')),
        dashBtn: safe(document.getElementById('dashBtn')),
        score: safe(document.querySelector('.stat')),
        hearts: safe(document.querySelector('.hud__tools')),
        touchHintShown: getComputedStyle(document.querySelector('.hint-touch')).display !== 'none',
        desktopHintHidden: getComputedStyle(document.querySelector('.hint-desktop')).display === 'none',
        noScroll: document.documentElement.scrollHeight <= window.innerHeight + 2,
        noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 2,
      };
    })()`);
    report.devices.push({ ...d, ...info });

    // 每个设备截图一张（playing 状态，能看到 HUD 与冲刺按钮）
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const safeName = d.name.replace(/[^\w]/g, '_');
    fs.writeFileSync(path.join(OUT, `mobile-${safeName}.png`), Buffer.from(shot.data, 'base64'));
  }

  // ---- 触摸拖拽操控测试（竖屏 iPhone 12） ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(300);

  await cdp.evaluate('window.__fishTest.start()');
  await sleep(400);

  // 记录拖动前的玩家位置，然后向右上方拖动
  const before = await cdp.evaluate('({x: window.__game.player.x, y: window.__game.player.y})');
  // 手指按在屏幕下半部分（避开鱼），向上滑动
  await touchDrag(cdp, { x: 195, y: 600 }, { x: 195, y: 420 }, 12);
  await sleep(120);
  const during = await cdp.evaluate(`({
    x: window.__game.player.x,
    y: window.__game.player.y,
    dragActive: window.__game.drag.active,
    mode: window.__game.pointer.mode,
    dx: Math.round(window.__game.drag.dx),
    dy: Math.round(window.__game.drag.dy),
    vx: Math.round(window.__game.player.vx),
    vy: Math.round(window.__game.player.vy),
    rotated: document.body.classList.contains('is-rotated'),
  })`);
  await touchEnd(cdp, { x: 195, y: 420 });
  await sleep(300);
  const after = await cdp.evaluate(`({
    x: window.__game.player.x,
    y: window.__game.player.y,
    dragActive: window.__game.drag.active,
  })`);

  report.touch = {
    beforeX: Math.round(before.x),
    duringX: Math.round(during.x),
    beforeY: Math.round(before.y),
    duringY: Math.round(during.y),
    // 竖屏触屏现在会被强制旋转成横屏，屏幕「向上滑」映射到画布 -x 而不是 -y，
    // 所以断言要按舞台是否旋转来选轴，否则会误判为「没动」。
    rotated: during.rotated,
    movedUp: during.rotated
      ? during.x < before.x - 5
      : during.y < before.y - 5,
    dragActiveDuringTouch: during.dragActive,
    dragMode: during.mode,
    dragDx: during.dx,
    dragDy: during.dy,
    // 旋转态下屏幕向上 = 画布向左，所以 vx 为负
    velocityInDirection: during.rotated ? during.vx < 0 : during.vy < 0,
    dragReleasedAfterEnd: after.dragActive === false,
    stateStillPlaying: await cdp.evaluate('window.__game.state'),
  };

  // 截图：拖拽进行中的视觉反馈
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(300);
  await touchDrag(cdp, { x: 195, y: 620 }, { x: 300, y: 470 }, 10);
  await sleep(100);
  const dragShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'mobile-drag-feedback.png'), Buffer.from(dragShot.data, 'base64'));
  await touchEnd(cdp, { x: 300, y: 470 });

  // ---- 冲刺按钮点击测试 ----
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(300);
  const dashRect = await cdp.evaluate(`(() => {
    const r = document.getElementById('dashBtn').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: dashRect.x, y: dashRect.y, id: 1 }],
  });
  await sleep(120);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(100);
  report.dashByTouch = await cdp.evaluate(`({
    dashCd: +window.__game.player.dashCd.toFixed(2),
    dashActive: window.__game.player.dashTime > 0 || window.__game.player.dashCd > 0,
  })`);

  // ---- 横竖屏切换 ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(300);
  const portraitLogical = await cdp.evaluate('Math.round(window.__game.vw) + "x" + Math.round(window.__game.vh)');
  const portraitState = await cdp.evaluate('window.__game.state');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
  await sleep(400);
  const landscapeLogical = await cdp.evaluate('Math.round(window.__game.vw) + "x" + Math.round(window.__game.vh)');
  const landscapeState = await cdp.evaluate('window.__game.state');
  const playerInView = await cdp.evaluate(`(() => {
    const g = window.__game;
    // 世界比视口大，玩家位置要用相机投影后判断是否在视野内
    const sx = g.toScreenX(g.player.x);
    const sy = g.toScreenY(g.player.y);
    return sx > -60 && sx < g.vw + 60 && sy > -60 && sy < g.vh + 60;
  })()`);
  const landscapeWorld = await cdp.evaluate(`({
    ratioW: +(window.__game.worldW / window.__game.vw).toFixed(2),
    ratioH: +(window.__game.worldH / window.__game.vh).toFixed(2),
  })`);
  report.orientation = {
    portraitLogical, landscapeLogical,
    portraitState, landscapeState,
    playerInViewAfterRotate: playerInView,
    worldScreens: landscapeWorld,
  };

  // ---- 竖屏强制横屏：舞台旋转 + 摇杆命中 ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(600);
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(400);
  const rotateInfo = await cdp.evaluate(`(() => {
    const g = window.__game;
    const sr = document.getElementById('stick').getBoundingClientRect();
    const mr = document.querySelector('.meter').getBoundingClientRect();
    return {
      isRotated: document.body.classList.contains('is-rotated'),
      logical: Math.round(g.vw) + 'x' + Math.round(g.vh),
      stickVisible: getComputedStyle(document.getElementById('stick')).display !== 'none',
      stickW: Math.round(sr.width),
      stickInViewport: sr.left >= -1 && sr.top >= -1 && sr.right <= innerWidth + 1 && sr.bottom <= innerHeight + 1,
      overlapsMeter: !(sr.right <= mr.left || sr.left >= mr.right || sr.bottom <= mr.top || sr.top >= mr.bottom),
      knob: { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2, radius: sr.width / 2 },
    };
  })()`);
  // 旋转态下向下推摇杆，应映射到画布 +x
  await touchDrag(cdp, { x: rotateInfo.knob.x, y: rotateInfo.knob.y },
    { x: rotateInfo.knob.x, y: rotateInfo.knob.y + rotateInfo.knob.radius * 0.85 }, 8);
  await sleep(400);
  const rotatedStick = await cdp.evaluate(`({
    mode: window.__game.pointer.mode,
    nx: +window.__game.stick.nx.toFixed(2),
    ny: +window.__game.stick.ny.toFixed(2),
  })`);
  await touchEnd(cdp, { x: rotateInfo.knob.x, y: rotateInfo.knob.y + rotateInfo.knob.radius * 0.85 });
  report.rotateStick = {
    isRotated: rotateInfo.isRotated,
    logical: rotateInfo.logical,
    stickVisible: rotateInfo.stickVisible,
    stickW: rotateInfo.stickW,
    stickInViewport: rotateInfo.stickInViewport,
    overlapsMeter: rotateInfo.overlapsMeter,
    mode: rotatedStick.mode,
    nx: rotatedStick.nx, ny: rotatedStick.ny,
    // 屏幕向下 = 画布向右
    mappedToCanvasX: rotatedStick.nx > 0.9 && Math.abs(rotatedStick.ny) < 0.2,
  };
  await sleep(200);

  // ---- 横屏摇杆操控测试 ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
  await sleep(500);
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(400);
  const knob = await cdp.evaluate(`(() => {
    const r = document.getElementById('stick').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, radius: r.width / 2 };
  })()`);
  const sBefore = await cdp.evaluate('window.__game.player.x');
  await touchDrag(cdp, { x: knob.x, y: knob.y }, { x: knob.x + knob.radius * 0.85, y: knob.y }, 8);
  await sleep(500);
  const sDuring = await cdp.evaluate(`({
    x: window.__game.player.x,
    mode: window.__game.pointer.mode,
    mag: +window.__game.stick.mag.toFixed(2),
    dragActive: window.__game.drag.active,
    knobMoved: document.getElementById('stickKnob').style.transform.includes('translate'),
  })`);
  await touchEnd(cdp, { x: knob.x + knob.radius * 0.85, y: knob.y });
  await sleep(200);
  const sAfter = await cdp.evaluate('window.__game.stick.active');
  report.stick = {
    movedRight: sDuring.x > sBefore + 5,
    mode: sDuring.mode,
    mag: sDuring.mag,
    draggingNotTriggered: sDuring.dragActive === false,
    knobMoved: sDuring.knobMoved,
    releasedAfterEnd: sAfter === false,
  };

  // ---- 点触屏控件不能黑屏一闪 ----
  // 根因：给 canvas.width 赋值（哪怕同值）会清空位图。主循环的 frame() 在上一帧末尾
  // 就重新注册了自己，rAF 批次里总排第一；点摇杆/冲刺按钮会经 touchstart →
  // noteTouchInput → syncOrientation → rAF(resize)，resize 排在同一帧的 draw 之后，
  // 于是清空后当帧不再重绘，合成出一帧全黑。
  // 断言：点这两个控件时，画布不能被清成空白。
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(400);
  report.noBlackFlash = await cdp.evaluate(`(async () => {
    const g = window.__game;
    const rawRaf = window.requestAnimationFrame.bind(window);
    let pending = [];
    let scheduled = false;
    let lumaSamples = [];

    function luma() {
      const c = g.canvas, ctx = g.g;
      if (!(c.width > 8 && c.height > 8)) return null;
      let sum = 0, n = 0;
      for (let fx = 1; fx <= 6; fx++) {
        for (let fy = 1; fy <= 6; fy++) {
          const d = ctx.getImageData(Math.round(c.width * fx / 7), Math.round(c.height * fy / 7), 1, 1).data;
          sum += (d[0] + d[1] + d[2]) / 3; n++;
        }
      }
      return sum / n;
    }

    function drive(ts) {
      scheduled = false;
      const batch = pending;
      pending = [];
      for (const cb of batch) { try { cb(ts); } catch (e) {} }
      // 批次结束 = 浏览器即将合成，此刻读到的就是真正上屏的内容
      const v = luma();
      if (v !== null) lumaSamples.push(+v.toFixed(1));
      if (pending.length && !scheduled) { scheduled = true; rawRaf(drive); }
    }
    window.requestAnimationFrame = function (cb) {
      pending.push(cb);
      if (!scheduled) { scheduled = true; rawRaf(drive); }
      return pending.length;
    };

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = {};

    for (const sel of ['#stick', '#dashBtn']) {
      lumaSamples = [];
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: y,
      }));
      try {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t],
        }));
      } catch (e) { /* Touch 构造不支持时忽略 */ }
      await wait(700);
      el.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
      }));
      await wait(200);

      const valid = lumaSamples.filter((v) => v >= 0);
      results[sel] = {
        frames: valid.length,
        minLuma: valid.length ? Math.min(...valid) : null,
        blackFrames: valid.filter((v) => v < 6).length,
      };
    }

    window.requestAnimationFrame = rawRaf;
    return {
      stick: results['#stick'],
      dashBtn: results['#dashBtn'],
      noBlackFrame: results['#stick'].blackFrames === 0 && results['#dashBtn'].blackFrames === 0,
    };
  })()`);

  // ---- 后台自动暂停 ----
  await cdp.evaluate('window.__fishTest.start()');
  await sleep(300);
  await cdp.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
  // 直接调用处理逻辑更可靠：模拟页面隐藏
  report.background = await cdp.evaluate(`(() => {
    const g = window.__game;
    g.start();
    const wasPlaying = g.state === 'playing';
    // 模拟切后台
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const afterHidden = g.state;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    return { wasPlaying, afterHidden, pausedOnHide: afterHidden === 'paused' };
  })()`);

  console.log(JSON.stringify(report, null, 2));

  proc.kill();
  server.close();
  setTimeout(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(0);
  }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
