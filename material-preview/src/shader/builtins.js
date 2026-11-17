// GLSL 内建函数运行时。编译后的着色器通过 B(...) 命名空间调用这些函数，
// 全部为真实浮点/向量运算，不存在占位实现。
import { Vec2, Vec3, Vec4, isVec, makeVec } from './value-types.js';

const num = (x) => (isVec(x) ? x.d[0] : x);

function componentwise(a, b, fn) {
  const va = isVec(a), vb = isVec(b);
  if (!va && !vb) return fn(a, b);
  const n = (va ? a.n : b.n);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(va ? a.d[i] : a, vb ? b.d[i] : b);
  return makeVec(out);
}

export const builtins = {
  radians: (deg) => (isVec(deg) ? makeVec([...deg.d].map((x) => (x * Math.PI) / 180)) : (deg * Math.PI) / 180),
  degrees: (rad) => (isVec(rad) ? makeVec([...rad.d].map((x) => (x * 180) / Math.PI)) : (rad * 180) / Math.PI),
  sin: (x) => (isVec(x) ? makeVec([...x.d].map(Math.sin)) : Math.sin(x)),
  cos: (x) => (isVec(x) ? makeVec([...x.d].map(Math.cos)) : Math.cos(x)),
  tan: (x) => (isVec(x) ? makeVec([...x.d].map(Math.tan)) : Math.tan(x)),
  pow: (x, y) => componentwise(x, y, Math.pow),
  exp: (x) => (isVec(x) ? makeVec([...x.d].map(Math.exp)) : Math.exp(x)),
  log: (x) => (isVec(x) ? makeVec([...x.d].map(Math.log)) : Math.log(x)),
  sqrt: (x) => (isVec(x) ? makeVec([...x.d].map(Math.sqrt)) : Math.sqrt(x)),
  abs: (x) => (isVec(x) ? makeVec([...x.d].map(Math.abs)) : Math.abs(x)),
  floor: (x) => (isVec(x) ? makeVec([...x.d].map(Math.floor)) : Math.floor(x)),
  ceil: (x) => (isVec(x) ? makeVec([...x.d].map(Math.ceil)) : Math.ceil(x)),
  fract: (x) => componentwise(x, x, (a) => a - Math.floor(a)),
  step: (edge, v) => componentwise(edge, v, (e, x) => (x < e ? 0 : 1)),
  sign: (x) => (isVec(x) ? makeVec([...x.d].map(Math.sign)) : Math.sign(x)),

  min: (a, b) => componentwise(a, b, Math.min),
  max: (a, b) => componentwise(a, b, Math.max),
  mod: (a, b) => componentwise(a, b, (x, y) => x - y * Math.floor(x / y)),

  mix: (a, b, t) => {
    if (isVec(t)) {
      const n = t.n;
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const av = isVec(a) ? a.d[i] : a;
        const bv = isVec(b) ? b.d[i] : b;
        out[i] = av * (1 - t.d[i]) + bv * t.d[i];
      }
      return makeVec(out);
    }
    if (isVec(a)) {
      const out = [...a.d].map((av) => av * (1 - t) + (isVec(b) ? 0 : b) * t);
      if (isVec(b)) for (let i = 0; i < a.n; i++) out[i] = a.d[i] * (1 - t) + b.d[i] * t;
      return makeVec(out);
    }
    return a * (1 - t) + b * t;
  },

  clamp: (x, lo, hi) => {
    const apply = (v, l, h) => Math.min(Math.max(v, l), h);
    if (isVec(x)) return makeVec([...x.d].map((v, i) => apply(v, isVec(lo) ? lo.d[i] : lo, isVec(hi) ? hi.d[i] : hi)));
    return apply(x, lo, hi);
  },

  smoothstep: (e0, e1, x) => {
    const f = (a, b, v) => {
      const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
      return t * t * (3 - 2 * t);
    };
    if (isVec(x)) return makeVec([...x.d].map((v, i) => f(isVec(e0) ? e0.d[i] : e0, isVec(e1) ? e1.d[i] : e1, v)));
    return f(e0, e1, x);
  },

  dot: (a, b) => {
    let s = 0;
    for (let i = 0; i < a.n; i++) s += a.d[i] * b.d[i];
    return s;
  },
  cross: (a, b) => new Vec3(
    a.d[1] * b.d[2] - a.d[2] * b.d[1],
    a.d[2] * b.d[0] - a.d[0] * b.d[2],
    a.d[0] * b.d[1] - a.d[1] * b.d[0],
  ),
  length: (a) => Math.sqrt([...a.d].reduce((s, x) => s + x * x, 0)),
  distance: (a, b) => builtins.length(builtins.minus(a, b)),
  normalize: (a) => {
    const l = builtins.length(a) || 1;
    return makeVec([...a.d].map((x) => x / l));
  },
  reflect: (i, n) => {
    const k = 2 * builtins.dot(i, n);
    return makeVec(i.d.map((x, idx) => x - k * n.d[idx]));
  },

  // 向量构造器（在生成代码里也可直接用 new Vec3，这里供动态场景使用）
  vec2: (x, y) => new Vec2(num(x), y === undefined ? num(x) : num(y)),
  vec3: (x, y, z) => new Vec3(
    num(x),
    y === undefined ? num(x) : num(y),
    z === undefined ? num(x) : num(z),
  ),
  vec4: (x, y, z, w) => {
    if (x instanceof Vec3) return new Vec4(x.d[0], x.d[1], x.d[2], num(y));
    if (x instanceof Vec2 && y instanceof Vec2) return new Vec4(x.d[0], x.d[1], y.d[0], y.d[1]);
    return new Vec4(num(x), y === undefined ? num(x) : num(y), z === undefined ? num(x) : num(z), w === undefined ? num(x) : num(w));
  },

  // 纹理采样：sampler 由引擎提供 {sample(uv)->Vec4}
  texture: (sampler, uv) => sampler.sample(uv),
  texture2D: (sampler, uv) => sampler.sample(uv),

  // 片元丢弃与输出由编译器特殊处理，这里仅占位防止误调用
  discard: () => { throw new Error('discard 必须由编译器降级为控制流，不能直接调用'); },
};

// 运算符辅助（生成代码直接用内联函数，minus 供 distance 用）
builtins.plus = (a, b) => componentwise(a, b, (x, y) => x + y);
builtins.minus = (a, b) => componentwise(a, b, (x, y) => x - y);

// 供生成代码使用的一元负号
export function neg(v) {
  if (isVec(v)) return makeVec([...v.d].map((x) => -x));
  return -v;
}
