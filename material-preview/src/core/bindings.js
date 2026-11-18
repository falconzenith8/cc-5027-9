// 资源绑定布局：热换候选管线在切换前必须通过的绑定兼容性检查，
// 以及为新管线准备对应材料（uniform 默认值与采样器绑定）的逻辑。
// 旧绑定组绝不能直接交给不兼容的新管线 —— 这里集中负责这一约束。
import { Vec4 } from '../shader/value-types.js';

// 运行时能够真实提供纹理数据的采样器（见 render/textures.js 与渲染帧绑定）
export const KNOWN_SAMPLERS = Object.freeze(['u_baseColorTex', 'u_normalTex', 'u_occlusionTex']);

// 引擎逐帧注入的 uniform（模型/视图/相机/灯光），不属于材质参数
export const ENGINE_AUTO_UNIFORMS = Object.freeze([
  'u_model', 'u_viewProj', 'u_normalMat0', 'u_normalMat1', 'u_normalMat2',
  'u_cameraPos', 'u_lightDir', 'u_lightColor',
]);

// 源码身份：模板源码与热换自定义源码分属不同 sourceId
export const TEMPLATE_SOURCE_ID = 'template:fragment';

export class BindingLayoutError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BindingLayoutError';
    this.details = details ?? null;
  }
}

// 从变体的 uniform 声明中分离普通 uniform 与采样器
export function describeBindingLayout(uniformLayout) {
  const samplers = [];
  const uniforms = [];
  for (const item of uniformLayout) {
    if (item.type === 'sampler2D') samplers.push(item.name);
    else uniforms.push(item);
  }
  return {
    samplers: [...samplers].sort(),
    uniforms: [...uniforms].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// 绑定布局检查：候选管线声明的每个采样器都必须是运行时能提供纹理的；
// 普通 uniform 不限制（新增的材质 uniform 由 prepareBindings 补默认值）。
export function validateBindingLayout(uniformLayout) {
  const { samplers } = describeBindingLayout(uniformLayout);
  const unsupported = samplers.filter((name) => !KNOWN_SAMPLERS.includes(name));
  if (unsupported.length) {
    throw new BindingLayoutError(
      `资源绑定布局不兼容：着色器声明了运行时无法提供纹理的采样器 ${unsupported.join(', ')}`
      + `（可用采样器: ${KNOWN_SAMPLERS.join(', ')}），旧绑定组不能交给该新管线`,
      { unsupported, known: [...KNOWN_SAMPLERS] },
    );
  }
  return describeBindingLayout(uniformLayout);
}

// 比较两份绑定布局，给出字段级差异（界面"候选 vs 已发布"比较与日志使用）
export function diffBindingLayout(oldLayout, newLayout) {
  const a = describeBindingLayout(oldLayout ?? []);
  const b = describeBindingLayout(newLayout ?? []);
  const aNames = new Set(a.uniforms.map((u) => u.name));
  const bNames = new Set(b.uniforms.map((u) => u.name));
  return {
    uniformsAdded: b.uniforms.filter((u) => !aNames.has(u.name)),
    uniformsRemoved: a.uniforms.filter((u) => !bNames.has(u.name)),
    samplersAdded: b.samplers.filter((n) => !a.samplers.includes(n)),
    samplersRemoved: a.samplers.filter((n) => !b.samplers.includes(n)),
    compatible: b.samplers.every((n) => KNOWN_SAMPLERS.includes(n)),
  };
}

function defaultValueFor(type) {
  switch (type) {
    case 'float': return 0;
    case 'int': return 0;
    case 'bool': return false;
    case 'vec2': return [0, 0];
    case 'vec3': return [0, 0, 0];
    case 'vec4': return [0, 0, 0, 0];
    default: return 0;
  }
}

// 为候选管线准备对应材料：
//  - 采样器：只绑定变体实际声明、且运行时支持的纹理槽
//  - uniform：保留材质已有值；新出现的材质 uniform 补类型化默认值并显式登记
// 返回新的绑定组（不修改入参），切换发生在调用方拿到绑定组之后的单次赋值。
export function prepareBindings({ variant, material, textures }) {
  const layout = describeBindingLayout(variant.uniformLayout);
  const samplers = {};
  for (const name of layout.samplers) {
    if (name === 'u_baseColorTex') samplers[name] = textures.albedo;
    else if (name === 'u_normalTex') samplers[name] = textures.normal;
    else if (name === 'u_occlusionTex') samplers[name] = textures.occlusion;
  }

  const previous = material.bindings?.uniformValues ?? {};
  const uniformValues = { ...previous };
  const addedUniforms = [];
  for (const u of layout.uniforms) {
    if (ENGINE_AUTO_UNIFORMS.includes(u.name)) continue;
    if (!(u.name in uniformValues)) {
      uniformValues[u.name] = defaultValueFor(u.type);
      addedUniforms.push(u);
    }
  }
  return { samplers, uniformValues, addedUniforms, layout };
}

// 渲染帧使用：把"绑定组中热换新增的材质 uniform"合并进 uniform 集合。
// 模板数值参数（NUMERIC_PARAMS）由调用方先写入且优先级更高，这里只补充参数表
// 之外的新 uniform，避免绑定组的零默认值覆盖材质已调过的参数。
// vec4 以数组存储的值在此物化为 Vec4（渲染器按对象取值）。
export function resolveUniformValues(material) {
  const out = {};
  const values = material.bindings?.uniformValues ?? {};
  const known = new Set(Object.keys(material.params ?? {}));
  for (const [name, value] of Object.entries(values)) {
    if (known.has(name)) continue;
    out[name] = Array.isArray(value) ? new Vec4(...value) : value;
  }
  return out;
}
