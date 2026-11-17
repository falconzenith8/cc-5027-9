// GLSL 向量/矩阵值类型 —— 软件着色器实际运算的基础。
// 所有着色器变体编译出的 JS 代码都通过这里的类型做真实数值计算。

const COMP = {
  x: 0, r: 0, s: 0,
  y: 1, g: 1, t: 1,
  z: 2, b: 2, p: 2,
  w: 3, a: 3, q: 3,
};

export function isVec(v) {
  return v instanceof Vec2 || v instanceof Vec3 || v instanceof Vec4;
}

class VecBase {
  constructor(n, comps) {
    this.n = n;
    this.d = new Float64Array(n);
    for (let i = 0; i < n; i++) this.d[i] = comps[i] ?? 0;
  }

  get(i) { return this.d[i]; }

  // 支持 .xyz / .rgb / .xxy / 单分量读写，以及左值 swizzle 赋值
  getSwizzle(mask) {
    if (mask.length === 1) return this.d[COMP[mask]];
    const vals = [];
    for (const c of mask) vals.push(this.d[COMP[c]]);
    return makeVec(vals);
  }

  setSwizzle(mask, value) {
    if (mask.length === 1) {
      this.d[COMP[mask]] = isVec(value) ? value.d[0] : value;
      return;
    }
    for (let i = 0; i < mask.length; i++) {
      this.d[COMP[mask[i]]] = isVec(value) ? value.d[i] : value;
    }
  }
}

function defineSwizzles(cls, n) {
  // 只生成 xyzw 族；rgba/stpq 与 xyzw 共享分量槽，通过别名映射处理
  const masks = new Set();
  const letters = 'xyzw';
  for (const a of letters) masks.add(a);
  for (const a of letters) for (const b of letters) masks.add(a + b);
  for (const a of letters) for (const b of letters) for (const c of letters) masks.add(a + b + c);
  for (const a of letters) for (const b of letters) for (const c of letters) for (const d of letters) masks.add(a + b + c + d);

  for (const mask of masks) {
    if (mask.length > n) continue;
    Object.defineProperty(cls.prototype, mask, {
      get() { return this.getSwizzle(mask); },
      set(v) { this.setSwizzle(mask, v); },
      configurable: true,
    });
  }
}

export class Vec2 extends VecBase {
  constructor(x = 0, y = 0) {
    super(2, x instanceof VecBase ? [x.d[0], x.d[1]] : [x, y]);
  }
}
export class Vec3 extends VecBase {
  constructor(x = 0, y = 0, z = 0) {
    super(3, x instanceof VecBase ? [x.d[0], x.d[1], x.d[2] ?? z] : [x, y, z]);
  }
}
export class Vec4 extends VecBase {
  constructor(x = 0, y = 0, z = 0, w = 0) {
    super(4, x instanceof VecBase ? [x.d[0], x.d[1], x.d[2] ?? 0, x.d[3] ?? w] : [x, y, z, w]);
  }
}
defineSwizzles(Vec2, 2);
defineSwizzles(Vec3, 3);
defineSwizzles(Vec4, 4);

// rgba / stpq 别名：映射到 xyzw 同一套属性
const ALIAS = { r: 'x', g: 'y', b: 'z', a: 'w', s: 'x', t: 'y', p: 'z', q: 'w' };
for (const cls of [Vec2, Vec3, Vec4]) {
  const n = cls === Vec2 ? 2 : cls === Vec3 ? 3 : 4;
  const aliases = ['rgba', 'stpq'];
  const seen = new Set();
  for (const fam of aliases) {
    for (let len = 1; len <= n; len++) {
      for (let combo = 0; combo < fam.length ** len; combo++) {
        let alias = '';
        let x = combo;
        for (let i = 0; i < len; i++) { alias = fam[x % fam.length] + alias; x = Math.floor(x / fam.length); }
        if (seen.has(alias)) continue;
        seen.add(alias);
        const target = alias.split('').map((c) => ALIAS[c]).join('');
        Object.defineProperty(cls.prototype, alias, {
          get() { return this.getSwizzle(target); },
          set(v) { this.setSwizzle(target, v); },
          configurable: true,
        });
      }
    }
  }
}

export function makeVec(vals) {
  const n = vals.length;
  if (n === 1) return vals[0];
  if (n === 2) return new Vec2(vals[0], vals[1]);
  if (n === 3) return new Vec3(vals[0], vals[1], vals[2]);
  return new Vec4(vals[0], vals[1], vals[2], vals[3]);
}

export class Mat4 {
  // 列主序，与 GLSL 一致：d[col*4+row]
  constructor(d) {
    this.d = d ? Float64Array.from(d) : new Float64Array(16);
  }

  static identity() {
    const m = new Mat4();
    m.d[0] = m.d[5] = m.d[10] = m.d[15] = 1;
    return m;
  }

  static multiply(a, b) {
    const out = new Mat4();
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a.d[k * 4 + r] * b.d[c * 4 + k];
        out.d[c * 4 + r] = s;
      }
    }
    return out;
  }

  // m * vec4
  transformVec(v) {
    const x = v.d[0], y = v.d[1], z = v.d[2], w = v.d[3];
    const d = this.d;
    return new Vec4(
      d[0] * x + d[4] * y + d[8] * z + d[12] * w,
      d[1] * x + d[5] * y + d[9] * z + d[13] * w,
      d[2] * x + d[6] * y + d[10] * z + d[14] * w,
      d[3] * x + d[7] * y + d[11] * z + d[15] * w,
    );
  }

  // 法线变换：(M^-1)^T 的 3x3
  normalMatrix() {
    const d = this.d;
    const inv = new Float64Array(9);
    const a00 = d[0], a01 = d[4], a02 = d[8];
    const a10 = d[1], a11 = d[5], a12 = d[9];
    const a20 = d[2], a21 = d[6], a22 = d[10];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (Math.abs(det) < 1e-12) det = 1e-12;
    const idet = 1 / det;
    inv[0] = b01 * idet;
    inv[1] = (-a22 * a01 + a02 * a21) * idet;
    inv[2] = (a12 * a01 - a02 * a11) * idet;
    inv[3] = b11 * idet;
    inv[4] = (a22 * a00 - a02 * a20) * idet;
    inv[5] = (-a12 * a00 + a02 * a10) * idet;
    inv[6] = b21 * idet;
    inv[7] = (-a21 * a00 + a01 * a20) * idet;
    inv[8] = (a11 * a00 - a01 * a10) * idet;
    return inv; // 行主序 3x3
  }
}

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Mat4();
  const d = m.d;
  d[0] = f / aspect;
  d[5] = f;
  d[10] = (far + near) * nf;
  d[11] = -1;
  d[14] = 2 * far * near * nf;
  d[15] = 0;
  return m;
}

export function lookAt(eye, center, up) {
  const z = normalize3(sub3(eye, center));
  const x = normalize3(cross3(up, z));
  const y = cross3(z, x);
  const m = Mat4.identity();
  const d = m.d;
  d[0] = x.d[0]; d[4] = x.d[1]; d[8] = x.d[2];
  d[1] = y.d[0]; d[5] = y.d[1]; d[9] = y.d[2];
  d[2] = z.d[0]; d[6] = z.d[1]; d[10] = z.d[2];
  d[12] = -dot3(x, eye);
  d[13] = -dot3(y, eye);
  d[14] = -dot3(z, eye);
  return m;
}

export function translate(v) {
  const m = Mat4.identity();
  m.d[12] = v.d[0]; m.d[13] = v.d[1]; m.d[14] = v.d[2];
  return m;
}
export function scale(v) {
  const m = Mat4.identity();
  m.d[0] = v.d[0]; m.d[5] = v.d[1]; m.d[10] = v.d[2];
  return m;
}
export function rotateY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = Mat4.identity();
  m.d[0] = c; m.d[2] = -s; m.d[8] = s; m.d[10] = c;
  return m;
}
export function rotateX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = Mat4.identity();
  m.d[5] = c; m.d[6] = s; m.d[9] = -s; m.d[10] = c;
  return m;
}

// ---- vec3 自由函数（引擎内部与 GLSL builtin 共用）----
export function sub3(a, b) { return new Vec3(a.d[0] - b.d[0], a.d[1] - b.d[1], a.d[2] - b.d[2]); }
export function add3(a, b) { return new Vec3(a.d[0] + b.d[0], a.d[1] + b.d[1], a.d[2] + b.d[2]); }
export function mul3(a, s) { return new Vec3(a.d[0] * s, a.d[1] * s, a.d[2] * s); }
export function dot3(a, b) { return a.d[0] * b.d[0] + a.d[1] * b.d[1] + a.d[2] * b.d[2]; }
export function cross3(a, b) {
  return new Vec3(
    a.d[1] * b.d[2] - a.d[2] * b.d[1],
    a.d[2] * b.d[0] - a.d[0] * b.d[2],
    a.d[0] * b.d[1] - a.d[1] * b.d[0],
  );
}
export function length3(a) { return Math.sqrt(dot3(a, a)); }
export function normalize3(a) {
  const l = length3(a) || 1;
  return mul3(a, 1 / l);
}
