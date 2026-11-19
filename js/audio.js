/* 程序化音效：全部用 WebAudio 合成，无需任何音频文件 */
const Sfx = (() => {
  let ctx = null;
  let master = null;
  let enabled = true;
  let unlocked = false;

  const LS_KEY = 'bigfatfish.sound';

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  function unlock() {
    init();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    unlocked = true;
  }

  function load() {
    try {
      const v = localStorage.getItem(LS_KEY);
      if (v === '0') enabled = false;
    } catch (e) { /* 忽略隐私模式下的异常 */ }
  }

  function persist() {
    try {
      localStorage.setItem(LS_KEY, enabled ? '1' : '0');
    } catch (e) { /* 忽略 */ }
  }

  function setEnabled(v) {
    enabled = !!v;
    persist();
    if (master) master.gain.value = enabled ? 0.32 : 0;
  }

  function toggle() {
    setEnabled(!enabled);
    return enabled;
  }

  // 基础音：一段带包络的振荡器
  function tone(opts) {
    if (!enabled || !ctx || !unlocked) return;
    const {
      type = 'sine', freq = 440, freqEnd = null, dur = 0.12,
      gain = 0.3, delay = 0, attack = 0.006, detune = 0,
    } = opts;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    }
    if (detune) osc.detune.setValueAtTime(detune, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // 噪声爆点，用于吞食、撞击
  function noise(opts) {
    if (!enabled || !ctx || !unlocked) return;
    const { dur = 0.18, gain = 0.2, filter = 1200, delay = 0, type = 'lowpass' } = opts;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bq = ctx.createBiquadFilter();
    bq.type = type;
    bq.frequency.setValueAtTime(filter, t0);
    bq.frequency.exponentialRampToValueAtTime(Math.max(80, filter * 0.35), t0 + dur);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bq);
    bq.connect(g);
    g.connect(master);
    src.start(t0);
  }

  const api = {
    load,
    unlock,
    init,
    get enabled() { return enabled; },
    setEnabled,
    toggle,

    eat(level) {
      const base = 300 + Math.min(level, 10) * 28;
      tone({ type: 'sine', freq: base, freqEnd: base * 1.9, dur: 0.1, gain: 0.24 });
      noise({ dur: 0.1, gain: 0.1, filter: 1800 });
    },
    combo(n) {
      const step = Math.min(n, 12);
      tone({ type: 'triangle', freq: 620 * Math.pow(1.06, step), dur: 0.09, gain: 0.16 });
    },
    grow() {
      tone({ type: 'sine', freq: 220, freqEnd: 660, dur: 0.34, gain: 0.2 });
      tone({ type: 'triangle', freq: 330, freqEnd: 880, dur: 0.3, gain: 0.1, delay: 0.05 });
    },
    hurt() {
      tone({ type: 'sawtooth', freq: 260, freqEnd: 70, dur: 0.3, gain: 0.22 });
      noise({ dur: 0.24, gain: 0.16, filter: 900 });
    },
    dash() {
      noise({ dur: 0.22, gain: 0.12, filter: 2600, type: 'bandpass' });
      tone({ type: 'sine', freq: 900, freqEnd: 320, dur: 0.16, gain: 0.1 });
    },
    power() {
      [0, 0.07, 0.14].forEach((d, i) =>
        tone({ type: 'triangle', freq: 520 + i * 200, dur: 0.16, gain: 0.14, delay: d }));
    },
    over() {
      [440, 330, 262, 196].forEach((f, i) =>
        tone({ type: 'sine', freq: f, freqEnd: f * 0.92, dur: 0.38, gain: 0.2, delay: i * 0.16 }));
    },
    start() {
      [392, 523, 659].forEach((f, i) =>
        tone({ type: 'triangle', freq: f, dur: 0.2, gain: 0.16, delay: i * 0.09 }));
    },
    ui() {
      tone({ type: 'sine', freq: 560, freqEnd: 720, dur: 0.07, gain: 0.12 });
    },
    warning() {
      tone({ type: 'square', freq: 150, dur: 0.12, gain: 0.1 });
    },
    // 彩蛋：一串上扬的碎光琶音
    secret() {
      const notes = [523, 659, 784, 1046, 1318, 1568];
      notes.forEach((f, i) => {
        tone({ type: 'triangle', freq: f, dur: 0.22, gain: 0.15, delay: i * 0.075 });
        tone({ type: 'sine', freq: f * 2, dur: 0.18, gain: 0.06, delay: i * 0.075 });
      });
      noise({ dur: 0.5, gain: 0.07, filter: 5200, type: 'bandpass', delay: 0.42 });
    },
  };

  api.load();
  return api;
})();
