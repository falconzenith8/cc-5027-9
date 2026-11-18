// 图形管线变体管理器：编译编排、缓存、失败诊断、替代材质、预热预算与取消。
import { preprocess, PreprocessError } from '../shader/preprocessor.js';
import { parse, ParseError } from '../shader/parser.js';
import { Compiler, SemanticError } from '../shader/compiler.js';
import {
  VERTEX_SHADER, FRAGMENT_SHADER, VERTEX_LAYOUT, STRUCT_FIELDS,
} from '../shader/material-templates.js';
import { buildVariantIdentity, normalizeStruct, targetStateFromStruct, sha256Short } from './variant-key.js';
import { TEMPLATE_SOURCE_ID, BindingLayoutError } from './bindings.js';

const RUNTIME_URLS = {
  valueTypes: new URL('../shader/value-types.js', import.meta.url).href,
  builtins: new URL('../shader/builtins.js', import.meta.url).href,
};

// 热换任务的生命周期状态（测试与事件日志据此核对版本采用情况）
export const HotSwapStatus = Object.freeze({
  PUBLISHED: 'published',       // 成功并成为当前材质管线
  REJECTED_STALE: 'stale',      // 编译成功但编辑版本已过期，不得覆盖新代码
  FAILED: 'failed',             // 编译/绑定检查失败，先前可运行版本保留
});

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
    // 链接门控：默认真正 import 生成模块；测试可注入以确定性地推迟/放行链接完成
    this.linkGate = options.linkGate ?? null;
    this.layout = VERTEX_LAYOUT;
    this._fallback = null;
    this._fallbackReady = false;
    // 延迟回收：被源码更新失效、但仍被场景（GPU/渲染帧）引用的旧管线
    this.retired = new Map();     // key -> { variant, retiredAt, reason }
    this.inFlight = 0;            // 仍在进行中的链接任务（管线尚未真正释放）
  }

  get stats() {
    return {
      cachedVariants: this.cache.size,
      failedVariants: this.failures.size,
      totalCompileEvents: this.compilerLog.length,
      retiredVariants: this.retired.size,
      inFlightCompiles: this.inFlight,
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
  // 链接期间任务计入 inFlight：任务未完成前其模块仍可能被采用，不能回收。
  async #link(vertexJs, fragmentJs, stage = 'variant') {
    const vUrl = 'data:text/javascript;base64,' + Buffer.from(vertexJs).toString('base64');
    const fUrl = 'data:text/javascript;base64,' + Buffer.from(fragmentJs).toString('base64');
    this.inFlight++;
    try {
      const doImport = async () => {
        const [vMod, fMod] = await Promise.all([import(vUrl), import(fUrl)]);
        return { vertexModule: vMod, fragmentModule: fMod };
      };
      const work = this.linkGate ? this.linkGate(doImport, stage) : doImport();
      return await work;
    } catch (e) {
      throw new CompileDiagnostic('link', 'link', `生成模块加载失败: ${e.message}`);
    } finally {
      this.inFlight--;
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
        sourceId: TEMPLATE_SOURCE_ID,
        sourceEdition: 0,
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
      sourceId: 'builtin:fallback',
      sourceEdition: 0,
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
        sourceId: 'fault-injection:custom',
        sourceEdition: 0,
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
        sourceId: v.sourceId,
        sourceEdition: v.sourceEdition,
      })),
      retired: [...this.retired.values()].map((r) => ({
        key: r.variant.key,
        sourceId: r.variant.sourceId,
        sourceEdition: r.variant.sourceEdition,
        retiredAt: r.retiredAt,
        reason: r.reason,
      })),
      failures: [...this.failures.entries()].map(([key, f]) => ({
        key,
        struct: f.struct,
        at: f.at,
        sourceId: f.sourceId ?? null,
        sourceEdition: f.sourceEdition ?? null,
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

  // ============ 着色器源码热换 ============

  // 只做"候选编译 + 资源布局检查"，不触碰任何在用管线。
  // 同步阶段（预处理/解析/语义/绑定布局）失败立即抛出带阶段的诊断；
  // 链接（模块 import）异步进行，由调用方在 await 后做编辑版本裁决。
  prepareHotSwap({ fragmentSource, struct, sourceId, sourceEdition, layoutValidator }) {
    const normalized = normalizeStruct(struct, STRUCT_FIELDS);
    const defines = {
      NORMAL_MAP: normalized.NORMAL_MAP,
      BLEND_MODE: normalized.BLEND_MODE,
      LIGHTING: normalized.LIGHTING,
    };
    const vCompiled = this.#compileStage('vertex', VERTEX_SHADER, defines);
    const fCompiled = this.#compileStage('fragment', fragmentSource, defines);
    const uniformLayout = [...vCompiled.uniformNames, ...fCompiled.uniformNames];

    // 资源布局检查在切换前完成：不兼容的绑定组根本不会进入链接/切换
    let bindingLayout;
    try {
      bindingLayout = layoutValidator
        ? layoutValidator(uniformLayout)
        : uniformLayout;
    } catch (e) {
      const diagnostic = e instanceof BindingLayoutError
        ? new CompileDiagnostic('fragment', 'layout', e.message, null)
        : e;
      this.compilerLog.push({
        type: 'hotswap-failed', sourceId, sourceEdition,
        error: diagnostic.message, phase: 'layout', at: now(),
      });
      throw diagnostic;
    }

    const identity = buildVariantIdentity({
      vertexSource: vCompiled.preprocessedSource,
      fragmentSource: fCompiled.preprocessedSource,
      layout: this.layout,
      struct: normalized,
      // 模板源码的热换（如回退）沿用 graphics 身份，正确复用静态变体缓存
      stage: sourceId === TEMPLATE_SOURCE_ID ? 'graphics' : 'hotswap',
    });
    return {
      identity,
      struct: normalized,
      vCompiled,
      fCompiled,
      uniformLayout,
      bindingLayout,
      sourceId,
      sourceEdition,
      // 真正的模块链接延迟到调用方裁决前；调用方持有 job 以支持门控测试
      link: () => this.#link(vCompiled.js, fCompiled.js, 'hotswap'),
    };
  }

  /**
   * 运行中热换：候选先编译并检查资源布局，通过后才链接；
   * 结果带编辑版本，由 isLatest 裁决晚到的旧结果不得覆盖新代码。
   * 失败不改变任何在用管线，只返回诊断（先前可运行版本由调用方继续持有）。
   */
  async compileHotSwap(request, isLatest) {
    let candidate;
    try {
      candidate = this.prepareHotSwap(request);
    } catch (diagnostic) {
      this.#recordHotSwapFailure(request, diagnostic);
      return {
        status: HotSwapStatus.FAILED,
        sourceId: request.sourceId, sourceEdition: request.sourceEdition,
        reason: diagnostic.message, diagnostic,
      };
    }

    // 身份未变（典型：回退到模板源码）直接复用静态变体缓存，不重复链接
    const cached = this.cache.get(candidate.identity.key);
    if (cached) {
      this.compilerLog.push({
        type: 'hotswap-cache-hit', sourceId: request.sourceId,
        sourceEdition: request.sourceEdition, key: cached.key, at: now(),
      });
      return {
        status: HotSwapStatus.PUBLISHED,
        sourceId: request.sourceId, sourceEdition: request.sourceEdition,
        variant: cached, identity: candidate.identity,
        bindingLayout: candidate.bindingLayout, fromCache: true,
      };
    }

    let linked;
    try {
      linked = await candidate.link();
    } catch (diagnostic) {
      this.#recordHotSwapFailure(request, diagnostic);
      return {
        status: HotSwapStatus.FAILED,
        sourceId: request.sourceId, sourceEdition: request.sourceEdition,
        reason: diagnostic.message, diagnostic,
      };
    }

    // 链接返回期间用户已连续保存并提交新版本：旧结果即使成功也不得覆盖
    if (!isLatest(request.sourceEdition)) {
      this.compilerLog.push({
        type: 'hotswap-stale', sourceId: request.sourceId,
        sourceEdition: request.sourceEdition, key: candidate.identity.key, at: now(),
      });
      return {
        status: HotSwapStatus.REJECTED_STALE,
        sourceId: request.sourceId, sourceEdition: request.sourceEdition,
        reason: `编辑版本 ${request.sourceEdition} 已过期，结果丢弃，不覆盖当前代码`,
        identity: candidate.identity,
      };
    }

    const variant = {
      key: candidate.identity.key,
      identity: candidate.identity,
      struct: candidate.struct,
      targetState: targetStateFromStruct(candidate.struct),
      layout: this.layout,
      vertex: { ...candidate.vCompiled, module: linked.vertexModule },
      fragment: { ...candidate.fCompiled, module: linked.fragmentModule },
      uniformLayout: candidate.uniformLayout,
      bindingLayout: candidate.bindingLayout,
      sourceId: request.sourceId,
      sourceEdition: request.sourceEdition,
      createdAt: now(),
      compileMs: candidate.fCompiled.compileMs + candidate.vCompiled.compileMs,
    };
    this.cache.set(variant.key, variant);
    // 同一源码的旧失败条目被新成功结果取代
    for (const [key, f] of this.failures) {
      if (f.sourceId === request.sourceId) this.failures.delete(key);
    }
    this.compilerLog.push({
      type: 'hotswap-compiled', sourceId: request.sourceId,
      sourceEdition: request.sourceEdition, key: variant.key, at: now(),
    });
    return {
      status: HotSwapStatus.PUBLISHED,
      sourceId: request.sourceId, sourceEdition: request.sourceEdition,
      variant, identity: candidate.identity, bindingLayout: candidate.bindingLayout,
    };
  }

  #recordHotSwapFailure(request, diagnostic) {
    const key = `hotswap|${request.sourceId}|e${request.sourceEdition}|${sha256Short(request.fragmentSource)}`;
    this.failures.set(key, {
      diagnostic, struct: request.struct, at: now(),
      sourceId: request.sourceId, sourceEdition: request.sourceEdition,
    });
    this.compilerLog.push({
      type: 'hotswap-failed', sourceId: request.sourceId,
      sourceEdition: request.sourceEdition, key,
      error: diagnostic.message, phase: diagnostic.phase, at: now(),
    });
  }

  /**
   * 源码更新：只使相关条目失效（按 sourceId），其他源码的静态变体缓存继续有效。
   * keepKey 为本次新采用的变体（同 sourceId 的新版本），必须保留。
   * 仍被在用材质引用的变体进入 retired 延迟回收，而不是立刻释放；
   * 未被引用的条目立即回收。
   */
  invalidateSource(sourceId, activeVariantKeys, keepKey = null) {
    const active = new Set(activeVariantKeys);
    const invalidated = [];
    for (const [key, variant] of this.cache) {
      if (variant.sourceId !== sourceId) continue;
      if (key === keepKey) continue; // 新版本自身保留在缓存
      this.cache.delete(key);
      if (active.has(key)) {
        this.retired.set(key, { variant, retiredAt: now(), reason: `source-update:${sourceId}` });
      }
      invalidated.push(key);
    }
    for (const [key, f] of this.failures) {
      if (f.sourceId === sourceId) this.failures.delete(key);
    }
    if (invalidated.length) {
      this.compilerLog.push({
        type: 'source-invalidated', sourceId,
        keys: invalidated, retired: [...this.retired.keys()], at: now(),
      });
    }
    return invalidated;
  }

  // 在用材质完成切换后调用：确认旧管线已无引用，真正释放延迟回收的条目
  releaseRetired(activeVariantKeys) {
    const active = new Set(activeVariantKeys);
    const released = [];
    for (const [key, entry] of this.retired) {
      if (!active.has(key)) {
        this.retired.delete(key);
        released.push(key);
      }
    }
    if (released.length) {
      this.compilerLog.push({ type: 'retired-released', keys: released, at: now() });
    }
    return released;
  }

  // 场景切换期间仍在编译的任务数（资源释放核对使用）
  get pendingWork() {
    return { inFlight: this.inFlight, retired: this.retired.size };
  }
}
