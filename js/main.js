/* 入口：DOM 绑定、输入、主循环、HUD 同步 */
(() => {
  const canvas = document.getElementById('game');
  const dom = {
    hud: document.getElementById('hud'),
    score: document.getElementById('scoreValue'),
    best: document.getElementById('bestValue'),
    hearts: document.getElementById('hearts'),
    stage: document.getElementById('stageName'),
    growth: document.getElementById('growthFill'),
    dash: document.getElementById('dashFill'),
    combo: document.getElementById('comboTag'),
    powers: document.getElementById('powerTags'),
    dashBtn: document.getElementById('dashBtn'),
    screens: {
      start: document.getElementById('screenStart'),
      pause: document.getElementById('screenPause'),
      over: document.getElementById('screenOver'),
    },
    btnStart: document.getElementById('btnStart'),
    btnPause: document.getElementById('btnPause'),
    btnSound: document.getElementById('btnSound'),
    btnResume: document.getElementById('btnResume'),
    btnRestart: document.getElementById('btnRestart'),
    btnRestartPause: document.getElementById('btnRestartPause'),
    btnSoundPause: document.getElementById('btnSoundPause'),
    overTitle: document.getElementById('overTitle'),
    overText: document.getElementById('overText'),
    finalScore: document.getElementById('finalScore'),
    finalSize: document.getElementById('finalSize'),
    finalEats: document.getElementById('finalEats'),
    newRecord: document.getElementById('newRecord'),
    errorBanner: document.getElementById('errorBanner'),
  };

  const game = new BigFatFish(canvas, dom);
  window.__game = game; // 便于自动化测试

  let lastHud = 0;

  /* ---------- 界面切换 ---------- */
  function showScreen(name) {
    for (const key of Object.keys(dom.screens)) {
      const el = dom.screens[key];
      if (!el) continue;
      el.classList.toggle('is-hidden', key !== name);
    }
    // 暂停时保留 HUD，让玩家能看到当前状态
    const hideHud = name === 'start' || name === 'over';
    dom.hud.classList.toggle('is-hidden', hideHud);
    dom.dashBtn.classList.toggle('is-hidden', hideHud);
  }

  game.onState = (s) => {
    // 状态名与 DOM 面板名不完全一致：paused -> pause
    if (s === 'playing') showScreen(null);
    else if (s === 'paused') showScreen('pause');
    else if (s === 'over') showScreen('over');
  };

  game.onOver = (r) => {
    dom.finalScore.textContent = Utils.formatNumber(r.score);
    dom.finalSize.textContent = r.stage;
    dom.finalEats.textContent = String(r.eats);
    const isNew = r.score > 0 && r.score >= r.best;
    dom.overTitle.textContent = isNew ? '游到最深' : '被吞掉了';
    dom.overText.textContent = isNew
      ? `这一局你吃成了「${r.stage}」，深海记住了你。`
      : `你停在了「${r.stage}」。再吃一口，就能游得更深。`;
    dom.newRecord.hidden = !isNew;
  };

  function startGame() {
    Sfx.unlock();
    Sfx.start();
    game.start();
  }

  function togglePause() {
    if (game.state === 'playing') game.pause();
    else if (game.state === 'paused') game.resume();
  }

  /* ---------- 声音 ---------- */
  function syncSoundUI() {
    const on = Sfx.enabled;
    dom.btnSound.classList.toggle('is-off', !on);
    dom.btnSoundPause.classList.toggle('is-off', !on);
    dom.btnSoundPause.textContent = on ? '声音：开' : '声音：关';
  }
  dom.btnSound.addEventListener('click', () => {
    Sfx.unlock();
    Sfx.toggle();
    Sfx.ui();
    syncSoundUI();
  });
  dom.btnSoundPause.addEventListener('click', () => {
    Sfx.toggle();
    Sfx.ui();
    syncSoundUI();
  });
  syncSoundUI();

  /* ---------- 按钮 ---------- */
  dom.btnStart.addEventListener('click', startGame);
  dom.btnRestart.addEventListener('click', startGame);
  dom.btnRestartPause.addEventListener('click', startGame);
  dom.btnResume.addEventListener('click', () => { Sfx.ui(); game.resume(); });
  dom.btnPause.addEventListener('click', () => { Sfx.ui(); togglePause(); });

  /* ---------- 键盘 ---------- */
  const DASH_KEYS = new Set(['Space', 'ShiftLeft', 'ShiftRight']);
  const BLOCK = new Set([
    'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
  ]);

  window.addEventListener('keydown', (e) => {
    if (BLOCK.has(e.code)) e.preventDefault();

    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (game.state === 'playing' || game.state === 'paused') togglePause();
      return;
    }
    if (e.code === 'Enter') {
      if (game.state === 'menu' || game.state === 'over') startGame();
      return;
    }
    if (DASH_KEYS.has(e.code)) {
      Sfx.unlock();
      if (game.state === 'menu' || game.state === 'over') return;
      game.dash();
      return;
    }
    game.setKey(e.code, true);
  });

  window.addEventListener('keyup', (e) => {
    game.setKey(e.code, false);
  });

  window.addEventListener('blur', () => {
    game.keys.clear();
    if (game.state === 'playing') game.pause();
  });

  /* ---------- 指针 ----------
     鼠标：绝对定位（指哪游哪，PC 原有手感不变）
     触摸：相对拖拽（手指不遮鱼身，单手可玩） */
  let dragging = false;

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    Sfx.unlock();
    // 逐事件按指针类型分流：混合设备（触屏笔记本）用鼠标时仍是绝对跟随
    const isMouse = e.pointerType === 'mouse';
    if (!isMouse) confirmTouch();

    if (game.state !== 'playing') return;
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    const p = pointerPos(e);

    if (isMouse) game.setPointer(p.x, p.y);
    else game.beginDrag(p.x, p.y);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (game.state !== 'playing') return;
    const p = pointerPos(e);

    if (e.pointerType === 'mouse') game.setPointer(p.x, p.y);
    else if (dragging) game.moveDrag(p.x, p.y);
  });

  const endDrag = () => {
    dragging = false;
    game.endDrag();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 触屏冲刺按钮
  dom.dashBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    Sfx.unlock();
    game.dash();
  });

  /* ---------- HUD ---------- */
  const HEART_COUNT = 3;
  for (let i = 0; i < HEART_COUNT; i++) {
    const h = document.createElement('i');
    h.className = 'heart';
    dom.hearts.appendChild(h);
  }

  let lastLives = -1;
  let lastPowerKey = '';

  function updateHud() {
    const s = game.hudSnapshot();

    dom.score.textContent = Utils.formatNumber(s.score);
    dom.best.textContent = Utils.formatNumber(Math.max(s.best, s.score));
    dom.stage.textContent = s.stage;
    dom.growth.style.width = `${(s.progress * 100).toFixed(1)}%`;

    const dashReady = 1 - Utils.clamp(s.dashReady / s.dashMax, 0, 1);
    dom.dash.style.width = `${(dashReady * 100).toFixed(1)}%`;
    dom.dashBtn.classList.toggle('is-empty', dashReady < 0.999);

    if (s.lives !== lastLives) {
      lastLives = s.lives;
      [...dom.hearts.children].forEach((el, i) => {
        el.classList.toggle('is-lost', i >= s.lives);
      });
    }

    if (s.combo > 1) {
      dom.combo.textContent = `连击 ×${s.combo}`;
      dom.combo.classList.add('is-on');
    } else {
      dom.combo.classList.remove('is-on');
    }

    const key = `${s.magnet > 0 ? 'm' : ''}${s.shield > 0 ? 's' : ''}`;
    if (key !== lastPowerKey) {
      lastPowerKey = key;
      dom.powers.innerHTML = '';
      if (s.magnet > 0) {
        dom.powers.insertAdjacentHTML('beforeend',
          `<div class="power-tag">磁力 <em>${s.magnet.toFixed(1)}s</em></div>`);
      }
      if (s.shield > 0) {
        dom.powers.insertAdjacentHTML('beforeend',
          `<div class="power-tag">无敌 <em>${s.shield.toFixed(1)}s</em></div>`);
      }
    } else if (s.magnet > 0 || s.shield > 0) {
      const ems = dom.powers.querySelectorAll('.power-tag em');
      let i = 0;
      if (s.magnet > 0 && ems[i]) ems[i++].textContent = `${s.magnet.toFixed(1)}s`;
      if (s.shield > 0 && ems[i]) ems[i++].textContent = `${s.shield.toFixed(1)}s`;
    }
  }

  /* ---------- 尺寸 ---------- */
  function onResize() {
    game.resize();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 120));
  if (window.ResizeObserver) {
    new ResizeObserver(onResize).observe(canvas);
  }

  /* ---------- 主循环 ---------- */
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;

    // 切标签页回来时避免大步长瞬移
    if (dt > 0.1) dt = 0.1;

    game.update(dt);
    game.draw();

    acc += dt;
    if (acc > 0.06) {
      acc = 0;
      updateHud();
    }

    requestAnimationFrame(frame);
  }

  // 全局兜底错误提示，避免白屏无声
  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
    if (dom.errorBanner) {
      dom.errorBanner.textContent = `运行出错：${e.message}`;
      dom.errorBanner.classList.remove('is-hidden');
    }
  });

  /* ---------- 移动端细节 ---------- */

  // 切到后台（来电、切 App、锁屏）时自动暂停，避免玩家回来发现已被吃掉
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'playing') game.pause();
  });

  // 阻止移动端双击缩放与长按选中，避免误触打断操作
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 320) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  document.addEventListener('gesturestart', (e) => e.preventDefault());

  // 触摸设备的屏幕方向变化后重算布局
  const onOrientation = () => {
    setTimeout(() => {
      game.resize();
      game.endDrag();
      confirmTouch();
    }, 180);
  };
  window.addEventListener('orientationchange', onOrientation);
  if (window.screen && window.screen.orientation) {
    window.screen.orientation.addEventListener?.('change', onOrientation);
  }

  // 触摸能力检测。判据要足够保守，避免触屏笔记本（鼠标为主）误显示触屏 UI：
  // 1) 主指针粗糙且不能悬停 —— 手机/平板的典型特征，最可靠
  // 2) 存在粗糙指针且整体不具备悬停能力 —— 覆盖部分安卓浏览器
  // 3) 真实收到过触摸事件 —— 最终证据，混合设备一旦真的触摸就补上
  // 注意：不能单看 navigator.maxTouchPoints，桌面 Chrome 与触屏笔记本都会报 >0。
  let touchObserved = false;

  function detectTouch() {
    const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
    if (mq('(pointer: coarse)') && mq('(hover: none)')) return true;
    if (mq('(any-pointer: coarse)') && !mq('(any-hover: hover)')) return true;
    return touchObserved;
  }

  function enableTouchUI() {
    game.isTouch = true;
    document.body.classList.add('is-touch');
  }

  // 设备能力会在运行中变化（外接鼠标、模拟器后开触摸模拟），
  // 所以判定不能只在加载时跑一次
  function confirmTouch() {
    if (!detectTouch()) return false;
    enableTouchUI();
    return true;
  }

  // 真实触摸是最强证据：即使媒体查询不可靠也能补上触屏 UI
  function noteTouchInput() {
    touchObserved = true;
    enableTouchUI();
  }

  confirmTouch();

  window.addEventListener('touchstart', noteTouchInput, { passive: true });
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') noteTouchInput();
  }, { passive: true });

  // 供测试与调试查询
  window.__fishDetectTouch = detectTouch;
  window.__fishConfirmTouch = confirmTouch;
  window.__fishNoteTouchInput = noteTouchInput;

  showScreen('start');
  updateHud();
  requestAnimationFrame(frame);

  // 供无头测试查询的关键接口
  window.__fishTest = {
    start: startGame,
    get state() { return game.state; },
    snapshot() { return game.hudSnapshot(); },
    enemyCount() { return game.enemies.length; },
    playerR() { return game.player ? game.player.r : 0; },
    // 模拟自动游玩：优先躲避致命威胁，否则追最近的可食猎物
    autopilot(steps = 120) {
      for (let i = 0; i < steps; i++) {
        const p = game.player;
        let prey = null;
        let pd = Infinity;
        let threat = null;
        let td = Infinity;
        for (const e of game.enemies) {
          const d = Utils.dist(e.x, e.y, p.x, p.y);
          if (e.r <= p.r * 1.08) {
            if (d < pd) { pd = d; prey = e; }
          } else if (e.r >= p.r * 1.18 && d < 170) {
            if (d < td) { td = d; threat = e; }
          }
        }
        let tx = game.vw * 0.5;
        let ty = game.vh * 0.5;
        if (threat) {
          tx = p.x + (p.x - threat.x) * 1.6;
          ty = p.y + (p.y - threat.y) * 1.6;
        } else if (prey) {
          tx = prey.x;
          ty = prey.y;
        }
        tx = Utils.clamp(tx, 20, game.vw - 20);
        ty = Utils.clamp(ty, 20, game.vh - 20);
        game.setPointer(tx * game.S, ty * game.S);
        game.update(1 / 60);
      }
      return this.snapshot();
    },
  };
})();
