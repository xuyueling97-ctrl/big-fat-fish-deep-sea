/* 通用数学与工具函数 */
const Utils = (() => {
  const TAU = Math.PI * 2;

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const dist2 = (ax, ay, bx, by) => {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  };

  // 角度插值，正确处理 ±π 环绕
  const angleLerp = (a, b, t) => {
    let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return a + d * t;
  };

  // 色相插值（0-360 环绕）
  const hueLerp = (a, b, t) => {
    let d = ((b - a + 180) % 360 + 360) % 360 - 180;
    return ((a + d * t) % 360 + 360) % 360;
  };

  // 与帧率无关的指数逼近系数
  const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeOutBack = (t) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  };

  const formatNumber = (n) => Math.round(n).toLocaleString('en-US');

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  return {
    TAU, clamp, lerp, rand, randInt, pick, dist, dist2,
    angleLerp, hueLerp, damp, easeOutCubic, easeOutBack,
    formatNumber, shuffle,
  };
})();
