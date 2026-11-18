import { createHash } from 'node:crypto';

// 变体身份。身份必须覆盖：
//  1. 预处理后顶点/片元源码（结构宏已展开）—— 源代码身份
//  2. 顶点属性布局 —— 布局身份
//  3. 渲染目标状态（混合/深度写入等由结构选项决定的管线状态）—— 目标状态身份
// 4. 编译器版本 —— 代码生成器升级后旧条目自动失效
export const COMPILER_VERSION = 1;

export function sha256Short(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function targetStateFromStruct(struct) {
  // 与 BLEND_MODE 对应的固定函数状态：结构不同 → 状态不同 → 身份不同
  const blend = {
    0: { enabled: false, depthWrite: true },
    1: { enabled: false, depthWrite: true },  // alpha test 仍是不透明管线
    2: { enabled: true, depthWrite: false, srcFactor: 'SRC_ALPHA', dstFactor: 'ONE_MINUS_SRC_ALPHA' },
  }[struct.BLEND_MODE];
  return {
    blend,
    lighting: struct.LIGHTING,
    normalMap: struct.NORMAL_MAP,
  };
}

export function buildVariantIdentity({ vertexSource, fragmentSource, layout, struct, stage }) {
  const structCanonical = JSON.stringify(struct, Object.keys(struct).sort());
  const target = targetStateFromStruct(struct);
  const material = {
    compilerVersion: COMPILER_VERSION,
    stage,
    struct: structCanonical,
    layoutHash: sha256Short(JSON.stringify(layout)),
    targetStateHash: sha256Short(JSON.stringify(target)),
    vertexHash: sha256Short(vertexSource),
    fragmentHash: sha256Short(fragmentSource),
  };
  material.key = [
    'v' + COMPILER_VERSION,
    stage,
    's' + sha256Short(structCanonical),
    'l' + material.layoutHash,
    't' + material.targetStateHash,
    'vs' + material.vertexHash,
    'fs' + material.fragmentHash,
  ].join('|');
  return material;
}

// 规范化结构选项：只接受 STRUCT_FIELDS 中声明的合法值，
// 非法组合直接拒绝，而不是悄悄落到默认条目（防止误用同一缓存）
export function normalizeStruct(input, structFields) {
  const out = {};
  for (const [field, spec] of Object.entries(structFields)) {
    const raw = input?.[field] ?? spec.values[0];
    const v = Number(raw);
    if (!spec.values.includes(v)) {
      const err = new Error(`结构选项 ${field} 的值 ${raw} 不合法，合法值: ${spec.values.join('/')}`);
      err.code = 'INVALID_STRUCT';
      throw err;
    }
    out[field] = v;
  }
  return out;
}
