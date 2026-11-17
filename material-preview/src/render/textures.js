// 程序化纹理：基础色、法线（由高度场真实微分得到）、环境光遮蔽。
// 每张纹理都实现 sample(uv) -> Vec4，供编译后着色器的 texture() 调用。
import { Vec4 } from '../shader/value-types.js';

function fract(x) { return x - Math.floor(x); }
function hash2(x, y, seed = 0) {
  return fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123);
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, y, seed) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 17);
    freq *= 2; amp *= 0.5;
  }
  return sum;
}

// 采样器基类：处理重复寻址与双线性过滤
class ProceduralTexture {
  constructor(size, wrap = 'repeat') {
    this.size = size;
    this.wrap = wrap;
    this.pixels = new Float32Array(size * size * 4);
  }

  setPixel(x, y, rgba) {
    const i = (y * this.size + x) * 4;
    this.pixels.set(rgba, i);
  }

  _wrap(v) {
    if (this.wrap === 'repeat') return ((v % 1) + 1) % 1;
    return Math.min(Math.max(v, 0), 1);
  }

  sample(uv) {
    const u = this._wrap(uv.d[0]);
    const v = this._wrap(uv.d[1]);
    const fx = u * this.size - 0.5;
    const fy = v * this.size - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const s = this.size;
    const idx = (x, y) => ((y + s) % s) * s + ((x + s) % s);
    const p = this.pixels;
    const i00 = idx(x0, y0) * 4, i10 = idx(x0 + 1, y0) * 4;
    const i01 = idx(x0, y0 + 1) * 4, i11 = idx(x0 + 1, y0 + 1) * 4;
    const out = new Float32Array(4);
    for (let c = 0; c < 4; c++) {
      const top = p[i00 + c] * (1 - tx) + p[i10 + c] * tx;
      const bot = p[i01 + c] * (1 - tx) + p[i11 + c] * tx;
      out[c] = top * (1 - ty) + bot * ty;
    }
    return new Vec4(out[0], out[1], out[2], out[3]);
  }
}

// 由高度场计算切线空间法线：中心差分后映射回 [0,1]
function normalsFromHeight(size, heightFn, strength) {
  const tex = new ProceduralTexture(size);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = heightFn(x / size, y / size);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = h[y * size + (x - 1 + size) % size];
      const xr = h[y * size + (x + 1) % size];
      const yd = h[((y - 1 + size) % size) * size + x];
      const yu = h[((y + 1) % size) * size + x];
      const dx = (xr - xl) * strength;
      const dy = (yu - yd) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      tex.setPixel(x, y, [nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5, 1]);
    }
  }
  return tex;
}

// ---- 各材质的程序化贴图 ----
function checkerAlbedo(size, c1, c2, cells = 8) {
  const tex = new ProceduralTexture(size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = (Math.floor((x / size) * cells) + Math.floor((y / size) * cells)) % 2 === 0;
    const n = (hash2(x, y, 3) - 0.5) * 0.04;
    const c = on ? c1 : c2;
    tex.setPixel(x, y, [c[0] + n, c[1] + n, c[2] + n, 1]);
  }
  return tex;
}

function noiseAlbedo(size, base, seed) {
  const tex = new ProceduralTexture(size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = fbm(x / size * 6, y / size * 6, seed);
    tex.setPixel(x, y, [
      Math.min(1, base[0] * (0.75 + n * 0.45)),
      Math.min(1, base[1] * (0.75 + n * 0.45)),
      Math.min(1, base[2] * (0.75 + n * 0.45)),
      1,
    ]);
  }
  return tex;
}

function bricksAlbedo(size) {
  const tex = new ProceduralTexture(size);
  const mortar = [0.82, 0.8, 0.76];
  const brick = [0.72, 0.25, 0.18];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const row = Math.floor(v * 8);
    const offset = row % 2 ? 0.5 : 0;
    const bx = fract(u * 6 + offset);
    const by = fract(v * 8);
    const gap = bx < 0.04 || bx > 0.96 || by < 0.06 || by > 0.94;
    const n = (hash2(x, y, 9) - 0.5) * 0.05;
    const c = gap ? mortar : brick;
    tex.setPixel(x, y, [c[0] + n, c[1] + n, c[2] + n, 1]);
  }
  return tex;
}

function flatOcclusion(size, base = 0.95) {
  const tex = new ProceduralTexture(size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = fbm(x / size * 4, y / size * 4, 21) * 0.12;
    const v = Math.min(1, base - n);
    tex.setPixel(x, y, [v, v, v, 1]);
  }
  return tex;
}

// 高度场定义（与法线贴图一一对应，保证法线真实描述表面起伏）
const heightFields = {
  checker: (u, v) => {
    const on = (Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0;
    return (on ? 0.62 : 0.38) + fbm(u * 20, v * 20, 5) * 0.05;
  },
  bricks: (u, v) => {
    const row = Math.floor(v * 8);
    const offset = row % 2 ? 0.5 : 0;
    const bx = fract(u * 6 + offset);
    const by = fract(v * 8);
    const gap = bx < 0.04 || bx > 0.96 || by < 0.06 || by > 0.94;
    return (gap ? 0.25 : 0.7) + fbm(u * 18, v * 18, 7) * 0.04;
  },
  noise: (u, v) => fbm(u * 8, v * 8, 11),
};

export function buildTextureSet(kind, size = 64) {
  const sets = {
    checker: () => ({
      albedo: checkerAlbedo(size, [0.75, 0.78, 0.82], [0.25, 0.28, 0.34]),
      normal: normalsFromHeight(size, heightFields.checker, 2.2),
      occlusion: flatOcclusion(size),
    }),
    bricks: () => ({
      albedo: bricksAlbedo(size),
      normal: normalsFromHeight(size, heightFields.bricks, 2.6),
      occlusion: flatOcclusion(size, 0.92),
    }),
    noise: () => ({
      albedo: noiseAlbedo(size, [0.45, 0.62, 0.5], 13),
      normal: normalsFromHeight(size, heightFields.noise, 2.0),
      occlusion: flatOcclusion(size, 0.9),
    }),
  };
  if (!sets[kind]) throw new Error(`未知纹理集: ${kind}`);
  return sets[kind]();
}

export const TEXTURE_KINDS = ['checker', 'bricks', 'noise'];
