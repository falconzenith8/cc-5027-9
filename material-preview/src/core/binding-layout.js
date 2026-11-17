// 资源绑定布局分析：由两个阶段真实声明的接口推出顶点属性、varying 与
// uniform/sampler 绑定。热换候选必须先通过这里，确认新管线需要的绑定组
// 能被当前资源池满足，才允许切换；绑定布局变化会得到新的布局哈希，
// 旧的绑定组绝不会被交给不兼容的新管线。
import { sha256Short } from './variant-key.js';

export class BindingLayoutError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.message).join('; '));
    this.name = 'BindingLayoutError';
    this.errors = errors;
  }
}

// 引擎能够提供的 uniform 名称：数值参数 + 引擎级（含法线矩阵拆分行）
export function defaultUniformProviders(numericParams, engineUniforms) {
  const names = new Set(Object.keys(numericParams));
  for (const u of engineUniforms) {
    if (u === 'u_normalMat') {
      names.add('u_normalMat0'); names.add('u_normalMat1'); names.add('u_normalMat2');
    } else {
      names.add(u);
    }
  }
  return names;
}

function canonical(value) {
  return JSON.stringify(value);
}

function sortByName(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * @param vertexInterface  Compiler.collectInterface() 的顶点阶段结果
 * @param fragmentInterface 片元阶段结果
 * @param options { vertexLayout, uniformProviders:Set<string>, resourceProvider:(name)=>any, requireFragmentOutput:boolean }
 * @returns {{ ok:boolean, errors, layout }}
 */
export function analyzeBindingLayout(vertexInterface, fragmentInterface, options) {
  const errors = [];
  const vertexLayout = options.vertexLayout;
  const uniformProviders = options.uniformProviders ?? new Set();
  const resourceProvider = options.resourceProvider ?? (() => null);
  const layoutByName = new Map(vertexLayout.attributes.map((a) => [a.name, a]));

  // ---- 顶点属性：必须与网格布局的字段、类型一致 ----
  const attributes = [];
  for (const attr of vertexInterface.attributes) {
    const spec = layoutByName.get(attr.name);
    if (!spec) {
      errors.push({
        code: 'UNKNOWN_ATTRIBUTE',
        message: `顶点属性 ${attr.name} 不在当前顶点布局中`,
      });
      continue;
    }
    if (spec.type && spec.type !== attr.type) {
      errors.push({
        code: 'ATTRIBUTE_TYPE',
        message: `顶点属性 ${attr.name} 类型 ${attr.type} 与布局类型 ${spec.type} 不一致`,
      });
      continue;
    }
    attributes.push({
      name: attr.name,
      type: attr.type,
      location: vertexLayout.attributes.indexOf(spec),
      offset: spec.offset,
      size: spec.size,
    });
  }

  // ---- 阶段间 varying：片元输入必须由顶点输出真实产生且类型一致 ----
  const vOut = new Map(vertexInterface.outputs.map((o) => [o.name, o.type]));
  const varyings = [];
  for (const input of fragmentInterface.inputs) {
    const outType = vOut.get(input.name);
    if (outType === undefined) {
      errors.push({
        code: 'VARYING_MISMATCH',
        message: `片元输入 ${input.name} 没有对应的顶点输出`,
      });
      continue;
    }
    if (outType !== input.type) {
      errors.push({
        code: 'VARYING_MISMATCH',
        message: `varying ${input.name} 类型不一致：顶点输出 ${outType}，片元输入 ${input.type}`,
      });
      continue;
    }
    varyings.push({ name: input.name, type: input.type });
  }

  // ---- 片元输出 ----
  const outputs = fragmentInterface.outputs;
  if (options.requireFragmentOutput !== false) {
    if (!outputs.some((o) => o.type === 'vec4')) {
      errors.push({
        code: 'MISSING_FRAGMENT_OUTPUT',
        message: '片元着色器必须声明一个 vec4 输出（如 fragColor）',
      });
    }
  }

  // ---- uniform / sampler 绑定 ----
  const uniforms = [];
  const samplers = [];
  let samplerUnit = 0;
  const allStages = [
    ...vertexInterface.uniforms.map((u) => ({ ...u, stage: 'vertex' })),
    ...fragmentInterface.uniforms.map((u) => ({ ...u, stage: 'fragment' })),
  ];
  for (const u of allStages) {
    if (u.type === 'sampler2D') {
      const resource = resourceProvider(u.name);
      if (resource === null || resource === undefined) {
        errors.push({
          code: 'MISSING_RESOURCE',
          message: `采样器资源缺失：管线要求 ${u.name}，但资源池没有提供`,
        });
        continue;
      }
      samplers.push({ name: u.name, type: u.type, stage: u.stage, unit: samplerUnit++, resource: u.name });
      uniforms.push({ name: u.name, type: u.type, kind: 'sampler', stage: u.stage, unit: samplerUnit - 1 });
      continue;
    }
    if (!uniformProviders.has(u.name)) {
      errors.push({
        code: 'UNKNOWN_UNIFORM',
        message: `管线请求了引擎无法提供的 uniform：${u.name}`,
      });
      continue;
    }
    uniforms.push({ name: u.name, type: u.type, kind: 'uniform', stage: u.stage });
  }

  const layout = {
    hash: sha256Short(canonical({
      attributes: sortByName(attributes),
      varyings: sortByName(varyings),
      uniforms: sortByName(uniforms),
    })),
    attributes: sortByName(attributes),
    varyings: sortByName(varyings),
    uniforms: sortByName(uniforms),
    samplers: sortByName(samplers),
    stages: {
      vertexInputs: vertexInterface.inputs.length,
      vertexOutputs: vertexInterface.outputs.map((o) => ({ ...o })),
      fragmentOutputs: outputs.map((o) => ({ ...o })),
    },
  };

  return { ok: errors.length === 0, errors, layout };
}
