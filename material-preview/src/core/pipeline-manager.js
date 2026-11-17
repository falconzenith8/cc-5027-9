// 图形管线变体管理器：编译编排、缓存、失败诊断、替代材质、预热预算与取消。
import { preprocess, PreprocessError } from '../shader/preprocessor.js';
import { parse, ParseError } from '../shader/parser.js';
import { Compiler, SemanticError } from '../shader/compiler.js';
import {
  VERTEX_SHADER, FRAGMENT_SHADER, VERTEX_LAYOUT, STRUCT_FIELDS,
} from '../shader/material-templates.js';
import { buildVariantIdentity, normalizeStruct, targetStateFromStruct, sha256Short } from './variant-key.js';

const RUNTIME_URLS = {
  valueTypes: new URL('../shader/value-types.js', import.meta.url).href,
  builtins: new URL('../shader/builtins.js', import.meta.url).href,
};

export class CompileDiagnostic extends Error {
  constructor(stage, phase, message, sourceLine) {
    super(message);
    this.name = 'CompileDiagnostic';
    this.stage = stage;      // vertex | fragment
    this.phase = phase;      // preprocess | parse | semantic | link
    this.sourceLine = sourceLine ?? null;
  }
}

// 替代材质（fallback）：固定的品红色无光照着色器，视觉上一眼可辨。
// 它走的是同一条真实编译路径，只是源码简单且经过自检，不是"假装成功"。
const FALLBACK_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_tangent;
uniform sampler2D u_baseColorTex;
uniform sampler2D u_occlusionTex;
out vec4 fragColor;
void main() {
  vec2 cell = floor(fract(v_uv) * 8.0);
  float sum = cell.x + cell.y;
  float on = mod(sum, 2.0);
  vec3 magenta = mix(vec3(0.9, 0.05, 0.7), vec3(0.6, 0.0, 0.45), on);
  fragColor = vec4(magenta, 1.0);
}
`;

function now() { return performance.now(); }

export class PipelineManager {
  constructor(options = {}) {
    this.cache = new Map();       // key -> 成功的 PipelineVariant
    this.failures = new Map();    // key -> { diagnostic, struct, at }
    this.compilerLog = [];        // 全部编译事件（成功/失败/缓存命中）
    this.resolver = options.resolver ?? (() => null);
    this.layout = VERTEX_LAYOUT;
    this._fallback = null;
    this._fallbackReady = false;
  }

  get stats() {
    return {
      cachedVariants: this.cache.size,
      failedVariants: this.failures.size,
      totalCompileEvents: this.compilerLog.length,
    };
  }

  // 预处理 + 解析 + 语义 + 代码生成 + 模块链接，任何阶段失败都带诊断
  #compileStage(stageName, source, defines) {
    const started = now();
    let pre;
    try {
      pre = preprocess(source, { defines, resolver: this.resolver });
    } catch (e) {
      if (e instanceof PreprocessError) throw new CompileDiagnostic(stageName, 'preprocess', e.message, e.glslLine);
      throw e;
    }
    let ast;
    try {
      ast = parse(pre.code);
    } catch (e) {
      if (e instanceof ParseError) throw new CompileDiagnostic(stageName, 'parse', e.message, e.line);
      throw e;
    }
    let result;
    try {
      result = new Compiler(ast, stageName, RUNTIME_URLS).compile();
    } catch (e) {
      if (e instanceof SemanticError) throw new CompileDiagnostic(stageName, 'semantic', e.message, e.line);
      throw e;
    }
    return {
      ...result,
      preprocessedSource: pre.code,
      definesUsed: pre.defsUsed,
      includeChain: pre.includeChain,
      compileMs: now() - started,
    };
  }

  // 链接：用 data URL 真实加载生成的 ES 模块（Node 原生 import），
  // 失败（如生成代码有 bug）同样作为 link 阶段诊断保留。
  async #link(vertexJs, fragmentJs) {
    const vUrl = 'data:text/javascript;base64,' + Buffer.from(vertexJs).toString('base64');
    const fUrl = 'data:text/javascript;base64,' + Buffer.from(fragmentJs).toString('base64');
    try {
      const [vMod, fMod] = await Promise.all([import(vUrl), import(fUrl)]);
      return { vertexModule: vMod, fragmentModule: fMod };
    } catch (e) {
      throw new CompileDiagnostic('link', 'link', `生成模块加载失败: ${e.message}`);
    }
  }

  /**
   * 编译（或从缓存取）一个管线变体。
   * @returns {{ status:'ok'|'fallback'|'failed', variant?, fallback?, reason? }}
   */
  async getOrCreateVariant(rawStruct, context = {}) {
    const struct = normalizeStruct(rawStruct, STRUCT_FIELDS);
    const defines = {
      NORMAL_MAP: struct.NORMAL_MAP,
      BLEND_MODE: struct.BLEND_MODE,
      LIGHTING: struct.LIGHTING,
    };

    const vCompiled = this.#compileStage('vertex', VERTEX_SHADER, defines);
    const fCompiled = this.#compileStage('fragment', FRAGMENT_SHADER, defines);

    const identity = buildVariantIdentity({
      vertexSource: vCompiled.preprocessedSource,
      fragmentSource: fCompiled.preprocessedSource,
      layout: this.layout,
      struct,
      stage: 'graphics',
    });

    // 缓存命中：身份完全一致才复用；数值参数不参与身份（它不影响编译结构）
    const hit = this.cache.get(identity.key);
    if (hit) {
      this.compilerLog.push({ type: 'cache-hit', key: identity.key, struct, at: now(), reason: context.reason ?? 'switch' });
      return { status: 'ok', variant: hit, identity, fromCache: true };
    }
    // 已知失败：不重复编译，直接给替代材质并附上原诊断
    const knownFail = this.failures.get(identity.key);
    if (knownFail && !context.forceRetry) {
      this.compilerLog.push({ type: 'failure-cache-hit', key: identity.key, struct, at: now() });
      return {
        status: 'fallback',
        fallback: await this.#getFallback(),
        identity,
        reason: knownFail.diagnostic.message,
        diagnostic: knownFail.diagnostic,
      };
    }

    const started = now();
    try {
      const linked = await this.#link(vCompiled.js, fCompiled.js);
      const variant = {
        key: identity.key,
        identity,
        struct,
        targetState: targetStateFromStruct(struct),
        layout: this.layout,
        vertex: { ...vCompiled, module: linked.vertexModule },
        fragment: { ...fCompiled, module: linked.fragmentModule },
        uniformLayout: [...vCompiled.uniformNames, ...fCompiled.uniformNames],
        createdAt: now(),
        compileMs: now() - started,
      };
      this.cache.set(identity.key, variant);
      this.failures.delete(identity.key);
      this.compilerLog.push({
        type: 'compiled', key: identity.key, struct,
        ms: variant.compileMs, at: now(), reason: context.reason ?? 'switch',
      });
      return { status: 'ok', variant, identity, fromCache: false, compileMs: variant.compileMs };
    } catch (e) {
      const diagnostic = e instanceof CompileDiagnostic ? e
        : new CompileDiagnostic('fragment', 'link', String(e?.message ?? e));
      this.failures.set(identity.key, { diagnostic, struct, at: now(), sourceKey: identity.key });
      this.compilerLog.push({
        type: 'failed', key: identity.key, struct,
        error: diagnostic.message, phase: diagnostic.phase, at: now(),
      });
      const fallback = await this.#getFallback();
      return { status: 'fallback', fallback, identity, reason: diagnostic.message, diagnostic };
    }
  }

  // 替代材质独立编译；它若也失败则返回硬失败（调用方必须显式处理，不能静默用旧管线）
  async #getFallback() {
    if (this._fallbackReady) return this._fallback;
    const vCompiled = this.#compileStage('vertex', VERTEX_SHADER, {});
    const fCompiled = this.#compileStage('fragment', FALLBACK_FRAGMENT, {});
    const identity = buildVariantIdentity({
      vertexSource: vCompiled.preprocessedSource,
      fragmentSource: fCompiled.preprocessedSource,
      layout: this.layout,
      struct: { __fallback: true },
      stage: 'fallback',
    });
    const linked = await this.#link(vCompiled.js, fCompiled.js);
    this._fallback = {
      key: identity.key,
      identity,
      struct: null,
      targetState: { blend: { enabled: false, depthWrite: true }, fallback: true },
      layout: this.layout,
      vertex: { ...vCompiled, module: linked.vertexModule },
      fragment: { ...fCompiled, module: linked.fragmentModule },
      uniformLayout: [...vCompiled.uniformNames, ...fCompiled.uniformNames],
      isFallback: true,
      createdAt: now(),
    };
    this._fallbackReady = true;
    return this._fallback;
  }

  /**
   * 预热：只编译"已知场景需求"清单里的变体，受预算与取消令牌约束。
   * 不会一启动就枚举全部 2×3×3=18 种组合。
   */
  async prewarm(neededStructs, budget = {}) {
    const maxVariants = budget.maxVariants ?? neededStructs.length;
    const deadline = budget.timeBudgetMs ? now() + budget.timeBudgetMs : Infinity;
    const token = budget.cancelToken ?? { cancelled: false };
    const report = { requested: neededStructs.length, compiled: 0, cached: 0, skipped: 0, failed: 0, cancelled: false, items: [] };

    for (const raw of neededStructs) {
      if (token.cancelled) { report.cancelled = true; report.skipped += neededStructs.length - report.items.length; break; }
      if (report.compiled + report.cached >= maxVariants) { report.skipped++; report.items.push({ struct: raw, outcome: 'budget-exceeded' }); continue; }
      if (now() > deadline) { report.skipped++; report.items.push({ struct: raw, outcome: 'time-exceeded' }); continue; }

      let struct;
      try { struct = normalizeStruct(raw, STRUCT_FIELDS); }
      catch (e) { report.skipped++; report.items.push({ struct: raw, outcome: 'invalid', error: e.message }); continue; }

      const r = await this.getOrCreateVariant(struct, { reason: 'prewarm' });
      if (r.status === 'ok') {
        if (r.fromCache) report.cached++; else report.compiled++;
        report.items.push({ struct, outcome: r.fromCache ? 'cached' : 'compiled', ms: r.compileMs });
      } else {
        report.failed++;
        report.items.push({ struct, outcome: 'fallback', error: r.reason });
      }
    }
    return report;
  }

  // 注入一段有问题的片元源码（演示/测试用）：验证失败诊断与替代材质路径
  async compileBroaderSource(customFragmentSource, struct = {}) {
    const defines = { NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 0, ...struct };
    const vCompiled = this.#compileStage('vertex', VERTEX_SHADER, defines);
    let fCompiled;
    try {
      fCompiled = this.#compileStage('fragment', customFragmentSource, defines);
    } catch (diagnostic) {
      const key = 'broken|' + sha256Short(customFragmentSource);
      this.failures.set(key, { diagnostic, struct, at: now(), sourceKey: key });
      this.compilerLog.push({ type: 'failed', key, error: diagnostic.message, phase: diagnostic.phase, at: now() });
      return { status: 'fallback', fallback: await this.#getFallback(), reason: diagnostic.message, diagnostic };
    }
    const identity = buildVariantIdentity({
      vertexSource: vCompiled.preprocessedSource,
      fragmentSource: fCompiled.preprocessedSource,
      layout: this.layout, struct: defines, stage: 'custom',
    });
    try {
      const linked = await this.#link(vCompiled.js, fCompiled.js);
      const variant = {
        key: identity.key, identity, struct: defines,
        targetState: targetStateFromStruct(defines), layout: this.layout,
        vertex: { ...vCompiled, module: linked.vertexModule },
        fragment: { ...fCompiled, module: linked.fragmentModule },
        uniformLayout: [...vCompiled.uniformNames, ...fCompiled.uniformNames],
        createdAt: now(), compileMs: 0,
      };
      this.cache.set(identity.key, variant);
      return { status: 'ok', variant, identity, fromCache: false };
    } catch (e) {
      const diagnostic = new CompileDiagnostic('link', 'link', String(e?.message ?? e));
      return { status: 'fallback', fallback: await this.#getFallback(), reason: diagnostic.message, diagnostic };
    }
  }

  snapshot() {
    return {
      stats: this.stats,
      variants: [...this.cache.values()].map((v) => ({
        key: v.key,
        struct: v.struct,
        targetState: v.targetState,
        isFallback: !!v.isFallback,
        compileMs: v.compileMs,
        uniformLayout: v.uniformLayout,
      })),
      failures: [...this.failures.entries()].map(([key, f]) => ({
        key,
        struct: f.struct,
        at: f.at,
        diagnostic: {
          stage: f.diagnostic.stage,
          phase: f.diagnostic.phase,
          message: f.diagnostic.message,
          sourceLine: f.diagnostic.sourceLine,
        },
      })),
      log: this.compilerLog.slice(-50),
    };
  }
}
