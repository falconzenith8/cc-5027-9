// 运行中着色器热换 + 回退。
//
// 一次热换的完整生命周期：
//   1. 候选源码提交（带单调递增的修订号 revision 与编辑版本 editVersion）；
//   2. 后台编译候选：预处理/解析/语义/链接 + 资源绑定布局检查；
//   3. 只有候选可用才原子切换所有受影响的材质实例到新程序；
//   4. 失败或候选无效时保留先前可运行版本，并把具体原因暴露给界面；
//   5. 编译任务携带修订号：用户连续保存后，晚返回的旧任务结果被丢弃，
//      绝不覆盖较新的代码；
//   6. 被替换的旧管线保留到最后一个在途帧释放引用后才真正回收。
//
// 这里不做"重启整个程序"来规避生命周期，也不把编辑器文本保存成功当成
// 画面已更新 —— 发布状态与候选状态分别记录，画面只反映已发布程序。

import { FRAGMENT_SHADER, VERTEX_SHADER } from '../shader/material-templates.js';
import { requestFingerprint } from './variant-key.js';

function now() { return performance.now(); }

// 一次热换请求的身份：源码 + 参与预处理的结构宏。结构改变同样算"代码变了"，
// 只有画面采用的请求哈希等于当前请求哈希，才算画面真的反映了当前代码。
function requestHash(source, defines) {
  return requestFingerprint(source, defines);
}

function diagnosticJson(d) {
  if (!d) return null;
  return {
    stage: d.stage, phase: d.phase, message: d.message, sourceLine: d.sourceLine ?? null,
  };
}

export class HotSwapService {
  constructor(pipeline, options = {}) {
    this.pipeline = pipeline;
    this.getInstances = options.getInstances ?? (() => []);
    this.clock = options.clock ?? (() => performance.now());
    // 每次提交的"编辑版本"由调用方（HTTP 层）提供或本地自增
    this._editVersion = 0;
    // 程序：一个材质实例组共享的可热换着色器单元
    this.programs = new Map(); // programId -> program
    this._programSeq = 0;
    this.events = [];
    this._inflight = 0;
  }

  createProgram(options = {}) {
    const id = options.id ?? `shader-${++this._programSeq}`;
    const fragmentSource = options.fragmentSource ?? FRAGMENT_SHADER;
    const vertexSource = options.vertexSource ?? VERTEX_SHADER;
    const program = {
      id,
      vertexSource,
      fragmentSource,
      defines: { NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 2, ...(options.defines ?? {}) },
      struct: { NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 2, ...(options.struct ?? {}) },
      revision: 0,
      editVersion: 0,
      // 已发布（画面上真正采用）的状态
      published: {
        status: 'unpublished', // unpublished | ok | failed
        variant: null,
        sourceHash: null,
        bindingLayoutHash: null,
        bindingLayout: null,
        revision: 0,
        editVersion: 0,
        publishedAt: null,
        diagnostic: null,
        previousKey: null,
      },
      // 最近一次候选（可能失败）的状态
      candidate: {
        status: 'idle', // idle | compiling | compiled | rejected | superseded
        revision: 0,
        editVersion: 0,
        sourceHash: null,
        bindingLayoutHash: null,
        bindingLayout: null,
        diagnostic: null,
        bindingErrors: null,
        compileMs: null,
        candidateKey: null,
        error: null,
      },
      history: [],
    };
    this.programs.set(id, program);
    return program;
  }

  getProgram(id) {
    const p = this.programs.get(id);
    if (!p) throw new Error(`着色器程序不存在: ${id}`);
    return p;
  }

  _nextEditVersion(hint) {
    if (Number.isFinite(hint) && hint > this._editVersion) this._editVersion = hint;
    this._editVersion += 1;
    return this._editVersion;
  }

  // 提交候选源码：同步返回"已受理"信息，真正的编译在后台完成。
  // 连续保存时，每个提交都带更高的 revision；旧任务晚返回会被丢弃。
  submitCandidate(programId, patch = {}) {
    const program = this.getProgram(programId);
    const fragmentSource = patch.fragmentSource ?? program.fragmentSource;
    const editVersion = this._nextEditVersion(patch.editVersion);
    const revision = program.revision + 1;
    program.revision = revision;
    program.editVersion = editVersion;
    program.candidate = {
      status: 'compiling',
      revision,
      editVersion,
      sourceHash: requestHash(fragmentSource, program.defines),
      bindingLayoutHash: null,
      bindingLayout: null,
      diagnostic: null,
      bindingErrors: null,
      compileMs: null,
      candidateKey: null,
      error: null,
    };
    // 新候选一旦提交，旧源码条目只对本程序相关来源失效；
    // 初版静态变体（结构宏）不受影响，继续有效。
    program.fragmentSource = fragmentSource;
    if (patch.vertexSource) program.vertexSource = patch.vertexSource;
    if (patch.defines) program.defines = { ...program.defines, ...patch.defines };
    if (patch.struct) program.struct = { ...program.struct, ...patch.struct };

    const task = {
      programId,
      revision,
      editVersion,
      fragmentSource,
      vertexSource: program.vertexSource,
      defines: { ...program.defines },
      struct: { ...program.struct },
      startedAt: now(),
    };
    this.events.push({ type: 'candidate-submitted', programId, revision, editVersion, at: now() });
    return task;
  }

  // 执行一个候选任务。返回的状态显式说明：是否被采用、是否被更新版本取代。
  async runCandidate(task) {
    const program = this.getProgram(task.programId);
    this._inflight++;
    let result;
    try {
      result = await this.pipeline.compileSource(task.fragmentSource, {
        vertexSource: task.vertexSource,
        defines: task.defines,
        struct: task.struct,
        stage: 'custom',
        programId: task.programId,
        reason: 'hot-swap',
      });
    } finally {
      this._inflight--;
    }

    // 晚返回检查：只要有更新的提交（或候选状态已不是本次任务），丢弃结果。
    if (task.revision !== program.revision) {
      if (program.candidate.status === 'compiling' && program.candidate.revision === task.revision) {
        program.candidate.status = 'superseded';
      }
      this.events.push({
        type: 'candidate-superseded', programId: program.id,
        revision: task.revision, newestRevision: program.revision, at: now(),
      });
      return {
        adopted: false,
        superseded: true,
        supersededBy: program.revision,
        revision: task.revision,
        newestRevision: program.revision,
        reason: `候选修订 ${task.revision} 已被更新的修订 ${program.revision} 取代，结果丢弃`,
      };
    }

    program.candidate.revision = task.revision;
    program.candidate.editVersion = task.editVersion;
    program.candidate.compileMs = result.compileMs ?? null;
    program.candidate.sourceHash = requestHash(task.fragmentSource, task.defines);

    if (result.status !== 'ok') {
      // 候选不可用：保留已发布版本，只更新候选失败状态与具体原因。
      program.candidate.status = 'rejected';
      program.candidate.diagnostic = diagnosticJson(result.diagnostic);
      program.candidate.bindingErrors = result.bindingErrors ?? null;
      program.candidate.error = result.diagnostic?.message ?? '编译失败';
      program.candidate.candidateKey = null;
      program.history.push({
        revision: task.revision,
        editVersion: task.editVersion,
        adopted: false,
        at: now(),
        reason: program.candidate.error,
      });
      this.events.push({
        type: 'candidate-rejected', programId: program.id, revision: task.revision,
        reason: program.candidate.error, phase: result.diagnostic?.phase ?? null, at: now(),
      });
      return {
        adopted: false,
        superseded: false,
        revision: task.revision,
        candidateRevision: program.candidate.revision,
        staleRelativeToNewest: program.candidate.revision !== program.revision,
        publishedKept: program.published.status === 'ok',
        reason: program.candidate.error,
        diagnostic: program.candidate.diagnostic,
        bindingErrors: program.candidate.bindingErrors,
      };
    }

    // 候选可用：原子切换所有受影响实例。
    const variant = result.variant;
    program.candidate.status = 'compiled';
    program.candidate.candidateKey = variant.key;
    program.candidate.bindingLayoutHash = variant.bindingLayout?.hash ?? null;
    program.candidate.bindingLayout = variant.bindingLayout ?? null;
    const swap = this.publishProgram(program, variant, task);
    const cached = this.pipeline.cache.get(variant.key);
    return {
      adopted: true,
      superseded: false,
      revision: task.revision,
      editVersion: task.editVersion,
      variantKey: variant.key,
      compileMs: result.compileMs ?? null,
      fromCache: !!result.fromCache,
      affectedInstances: swap.affectedInstances,
      retired: swap.retired,
      bindingLayoutChanged: swap.bindingLayoutChanged,
      bindingLayoutHash: variant.bindingLayout?.hash ?? null,
      inUse: cached?.inUse ?? 0,
    };
  }

  // 结构选项编译出的静态变体也应登记为"已发布"，界面才能如实显示当前画面来源。
  // 静态变体不代表编辑器里可能已保存的自定义源码，sourceHash 用模板源码哈希。
  notePublished(programId, variant, options = {}) {
    const program = this.getProgram(programId);
    const previous = program.published.variant;
    if (previous && previous.key !== variant.key) {
      this.pipeline.retireVariant(previous, options.retireReason ?? 'published-replaced');
    }
    const sourceText = options.sourceText ?? program.fragmentSource;
    program.published = {
      status: 'ok',
      variant,
      sourceText,
      sourceHash: options.sourceHash ?? requestHash(sourceText, program.defines),
      bindingLayoutHash: variant.bindingLayout?.hash ?? null,
      bindingLayout: variant.bindingLayout ?? null,
      revision: program.revision,
      editVersion: program.editVersion,
      publishedAt: now(),
      diagnostic: null,
      previousKey: previous?.key ?? null,
    };
    return program.published;
  }

  // 静态编译失败：画面挂替代材质，已发布状态如实标记失败并附诊断。
  noteFailed(programId, diagnostic) {
    const program = this.getProgram(programId);
    program.published.status = 'failed';
    program.published.diagnostic = diagnosticJson(diagnostic);
    return program.published;
  }

  // 发布：把程序与所有绑定该程序的实例一起切到新变体。
  // 资源绑定布局变化时，旧绑定组不会交给新管线；旧变体按引用计数延迟回收。
  publishProgram(program, variant, task) {
    this.pipeline.adoptVariant(variant);
    // 源码更新只让"编辑文本不同"的旧条目失效；同一份源码在不同结构下的
    // 变体（结构切换产物）继续有效，切回原结构可命中缓存。
    this.pipeline.invalidateSourceEntries(
      (entry) => entry.programId === program.id
        && entry.key !== variant.key
        && entry.variantSourceText !== undefined
        && entry.variantSourceText !== task.fragmentSource,
    );
    const previous = program.published.variant;
    const previousLayoutHash = program.published.bindingLayoutHash;
    const newLayoutHash = variant.bindingLayout?.hash ?? null;
    const bindingLayoutChanged = previousLayoutHash !== null && previousLayoutHash !== newLayoutHash;

    // 所有受影响实例一起切换（一次性采用新变体）
    const instances = this.getInstances(program.id);
    const sameAsPrevious = previous?.key === variant.key;
    // 只有源码文本真的变化才退休旧管线；同一源码在不同结构下的变体保留在缓存，
    // 切回原结构时可命中并复用（仍受引用计数与容量管理约束）。
    const sourceReplaced = previous && previous.variantSourceText !== task.fragmentSource;
    for (const inst of instances) {
      if (previous && !sameAsPrevious && sourceReplaced) {
        this.pipeline.retireVariant(previous, 'hot-swapped');
      }
      inst.variant = variant;
      inst.programId = program.id;
      inst.revision = task.revision;
      inst.editVersion = task.editVersion;
    }
    // 若当前没有登记实例，也确保被源码替换的旧管线在无人引用时可回收
    if (!instances.length && previous && !sameAsPrevious && sourceReplaced) {
      this.pipeline.retireVariant(previous, 'hot-swapped');
    }

    program.published = {
      status: 'ok',
      variant,
      sourceText: program.fragmentSource,
      sourceHash: program.candidate.sourceHash,
      bindingLayoutHash: newLayoutHash,
      bindingLayout: variant.bindingLayout ?? null,
      revision: task.revision,
      editVersion: task.editVersion,
      publishedAt: now(),
      diagnostic: null,
      previousKey: previous?.key ?? null,
    };
    program.history.push({
      revision: task.revision,
      editVersion: task.editVersion,
      adopted: true,
      at: now(),
      variantKey: variant.key,
      bindingLayoutChanged,
    });
    this.events.push({
      type: 'published', programId: program.id, revision: task.revision,
      variantKey: variant.key, bindingLayoutChanged,
      affectedInstances: instances.length, at: now(),
    });

    // 新布局：重新准备与新管线兼容的绑定组（而不是复用旧绑定组）
    const bindings = this.prepareBindings(variant);

    return {
      affectedInstances: instances.length,
      retired: previous?.key ?? null,
      bindingLayoutChanged,
      bindings,
    };
  }

  // 依据管线真实声明的采样器清单，准备与之兼容的绑定组。
  prepareBindings(variant) {
    const samplers = variant.bindingLayout?.samplers ?? [];
    return {
      layoutHash: variant.bindingLayout?.hash ?? null,
      samplers: samplers.map((s) => ({ name: s.name, unit: s.unit, resource: s.resource })),
      ready: samplers.every((s) => s.resource),
    };
  }

  // 显式回退到已发布版本（不重新编译），用于演示/测试。
  rollback(programId) {
    const program = this.getProgram(programId);
    const published = program.published.variant;
    if (!published) return { rolledBack: false, reason: '没有可回退的已发布版本' };
    // 回退把编辑器源码同步回已发布源码，并清空未采用的候选状态。
    if (program.published.sourceText) program.fragmentSource = program.published.sourceText;
    program.candidate = {
      status: 'rolled-back',
      revision: program.revision,
      editVersion: program.editVersion,
      sourceHash: program.published.sourceHash,
      bindingLayoutHash: program.published.bindingLayoutHash,
      bindingLayout: program.published.bindingLayout,
      diagnostic: null,
      bindingErrors: null,
      compileMs: null,
      candidateKey: published.key,
      error: null,
    };
    this.events.push({ type: 'rolled-back', programId, key: published.key, at: now() });
    return { rolledBack: true, key: published.key, variant: published };
  }

  describeProgram(programId) {
    const program = this.getProgram(programId);
    const pub = program.published;
    const cand = program.candidate;
    const currentSourceHash = requestHash(program.fragmentSource, program.defines);
    return {
      id: program.id,
      source: program.fragmentSource,
      revision: program.revision,
      editVersion: program.editVersion,
      published: {
        status: pub.status,
        revision: pub.revision,
        editVersion: pub.editVersion,
        variantKey: pub.variant?.key ?? null,
        sourceHash: pub.sourceHash,
        bindingLayoutHash: pub.bindingLayoutHash,
        bindingLayout: pub.bindingLayout,
        publishedAt: pub.publishedAt,
        previousKey: pub.previousKey,
        // 画面是否真的反映了当前代码：只有已发布且发布版本哈希等于当前源码哈希
        matchesCurrentSource: pub.status === 'ok' && pub.sourceHash === currentSourceHash,
      },
      candidate: {
        status: cand.status,
        revision: cand.revision,
        editVersion: cand.editVersion,
        sourceHash: cand.sourceHash,
        candidateKey: cand.candidateKey,
        bindingLayoutHash: cand.bindingLayoutHash,
        bindingLayout: cand.bindingLayout,
        compileMs: cand.compileMs,
        diagnostic: cand.diagnostic,
        bindingErrors: cand.bindingErrors,
        error: cand.error,
      },
      editorTextSaved: true, // 文本已保存不等于画面已更新，单独暴露
      textDiffersFromPublished: currentSourceHash !== pub.sourceHash,
      history: program.history.slice(-20),
      events: this.events.filter((e) => e.programId === program.id).slice(-30),
    };
  }

  stats() {
    return {
      programs: this.programs.size,
      inflight: this._inflight,
      pipeline: this.pipeline.stats,
    };
  }
}
