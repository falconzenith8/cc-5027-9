// 场景服务：把材质、模型、纹理、管线变体与渲染器串成完整的预览运行时。
// 负责：变体申请与当前/等待状态、uniform 实时更新（不重编译）、
// 场景流送（逐帧渲染 PNG）、预热编排、固定操作序列基准测量与重复进入复用验证。
import { PipelineManager } from './pipeline-manager.js';
import { HotSwapService } from './hot-swap.js';
import { SoftwareRenderer } from '../render/renderer.js';
import { createMesh, MESH_NAMES } from '../render/meshes.js';
import { buildTextureSet, TEXTURE_KINDS } from '../render/textures.js';
import { encodePNG } from '../render/png.js';
import {
  NUMERIC_PARAMS, STRUCT_FIELDS, ENGINE_UNIFORMS, FRAGMENT_SHADER,
} from '../shader/material-templates.js';
import { Mat4, Vec3, Vec4, perspective, lookAt, rotateY, rotateX } from '../shader/value-types.js';

let materialSeq = 0;

function defaultNumericParams() {
  const out = {};
  for (const [k, spec] of Object.entries(NUMERIC_PARAMS)) {
    out[k] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
  return out;
}

// 一份"材质"= 结构选项（决定变体身份）+ 数值参数（只写 uniform）+ 纹理选择
export function createMaterialRecord(partial = {}) {
  return {
    id: `mat-${++materialSeq}`,
    name: partial.name ?? `材质 ${materialSeq}`,
    struct: {
      NORMAL_MAP: partial.struct?.NORMAL_MAP ?? 0,
      BLEND_MODE: partial.struct?.BLEND_MODE ?? 0,
      LIGHTING: partial.struct?.LIGHTING ?? 2,
    },
    params: { ...defaultNumericParams(), ...(partial.params ?? {}) },
    textureKind: partial.textureKind ?? 'checker',
    shaderProgramId: partial.shaderProgramId ?? null,
  };
}

export class PreviewSceneService {
  constructor(options = {}) {
    this.pipeline = new PipelineManager(options);
    this.renderer = new SoftwareRenderer(options.width ?? 256, options.height ?? 256);
    this.meshes = new Map(MESH_NAMES.map((n) => [n, createMesh(n)]));
    this.textureCache = new Map();
    this.materials = new Map();
    this.currentMaterialId = null;
    // 当前生效的变体（可能是 fallback）；等待中的申请单独记录
    this.activeVariant = null;
    this.activeVariantOfMaterial = null;
    this.pending = null; // { materialId, struct, requestedAt }
    this.lastFrame = null;
    this.camera = { distance: 3.2, yaw: 0.7, pitch: 0.35 };
    this.lightDir = new Vec3(0.45, 0.75, 0.5);
    this.lightColor = new Vec3(1.0, 0.97, 0.92);
    this.eventLog = [];
    this._frameSeq = 0;

    // 热换：每份材质所属的着色器程序与"实例"引用（渲染器从实例取已发布变体）
    this.hotSwap = new HotSwapService(this.pipeline, {
      getInstances: (programId) => [...this.materials.values()]
        .filter((m) => m.shaderProgramId === programId)
        .map((m) => m.shaderInstance),
    });
    this._programByMaterial = new Map();

    // 预置三份材质，覆盖不同结构组合
    this.registerMaterial(createMaterialRecord({
      name: '陶瓷球（PBR 不透明）', textureKind: 'noise',
      struct: { NORMAL_MAP: 1, BLEND_MODE: 0, LIGHTING: 2 },
      params: { u_roughness: 0.32, u_metallic: 0.05 },
    }));
    this.registerMaterial(createMaterialRecord({
      name: '砖墙（Lambert + Alpha 测试）', textureKind: 'bricks',
      struct: { NORMAL_MAP: 1, BLEND_MODE: 1, LIGHTING: 1 },
      params: { u_alphaCutoff: 0.5, u_normalScale: 1.2 },
    }));
    this.registerMaterial(createMaterialRecord({
      name: '玻璃环（Blinn 混合透明）', textureKind: 'checker',
      struct: { NORMAL_MAP: 0, BLEND_MODE: 2, LIGHTING: 2 },
      params: { u_roughness: 0.08, u_metallic: 0.0, u_baseColor: [0.6, 0.8, 0.95, 0.45] },
    }));
    // 首次变体编译是异步的；暴露 ready 承诺，调用方在渲染前 await
    this.ready = this.selectMaterial(this.materials.keys().next().value);
  }

  static async create(options) {
    const svc = new PreviewSceneService(options);
    await svc.ready;
    return svc;
  }

  registerMaterial(record) {
    if (!record.shaderProgramId) {
      const program = this.hotSwap.createProgram({
        fragmentSource: FRAGMENT_SHADER,
        struct: record.struct,
        defines: {
          NORMAL_MAP: record.struct.NORMAL_MAP,
          BLEND_MODE: record.struct.BLEND_MODE,
          LIGHTING: record.struct.LIGHTING,
        },
      });
      record.shaderProgramId = program.id;
    }
    record.shaderInstance = record.shaderInstance ?? { variant: null, programId: record.shaderProgramId };
    this.materials.set(record.id, record);
    return record;
  }

  listMaterials() {
    return [...this.materials.values()].map((m) => ({
      id: m.id, name: m.name, struct: m.struct, textureKind: m.textureKind,
      params: m.params, isActive: m.id === this.currentMaterialId,
    }));
  }

  getMaterial(id) {
    const m = this.materials.get(id);
    if (!m) throw new Error(`材质不存在: ${id}`);
    return m;
  }

  selectMaterial(id) {
    const m = this.getMaterial(id);
    this.currentMaterialId = id;
    this.eventLog.push({ type: 'select', materialId: id, at: performance.now() });
    return this.requestVariant(m, 'select');
  }

  // 结构选项变更：产生新的变体申请（真实编译路径）
  async setStruct(field, value) {
    const m = this.getMaterial(this.currentMaterialId);
    const v = Number(value);
    if (!STRUCT_FIELDS[field].values.includes(v)) {
      throw new Error(`结构选项 ${field} 非法值 ${value}`);
    }
    if (m.struct[field] === v) return this.describeState();
    m.struct[field] = v;
    // 结构宏变化也同步到材质的着色器程序，之后热换候选沿用同一套结构开关。
    if (m.shaderProgramId) {
      const program = this.hotSwap.getProgram(m.shaderProgramId);
      program.struct = { ...program.struct, [field]: v };
      program.defines = { ...program.defines, [field]: v };
    }
    this.eventLog.push({ type: 'struct-change', field, value, at: performance.now() });
    await this.requestVariant(m, `struct:${field}`);
    return this.describeState();
  }

  // 数值参数变更：只更新 uniform 并重新出帧，明确不触发编译
  setParam(name, value) {
    const m = this.getMaterial(this.currentMaterialId);
    if (!(name in NUMERIC_PARAMS)) throw new Error(`未知数值参数 ${name}`);
    const spec = NUMERIC_PARAMS[name];
    if (spec.type === 'vec4') {
      if (!Array.isArray(value) || value.length !== 4) throw new Error(`${name} 需要 4 分量数组`);
      m.params[name] = value.map(Number);
    } else {
      m.params[name] = Number(value);
    }
    this.eventLog.push({ type: 'param-change', name, at: performance.now() });
    return this.describeState();
  }

  setTextureKind(kind) {
    if (!TEXTURE_KINDS.includes(kind)) throw new Error(`未知纹理 ${kind}`);
    this.getMaterial(this.currentMaterialId).textureKind = kind;
    return this.describeState();
  }

  setCamera(patch) {
    Object.assign(this.camera, patch);
  }

  getTextures(kind) {
    if (!this.textureCache.has(kind)) this.textureCache.set(kind, buildTextureSet(kind, 64));
    return this.textureCache.get(kind);
  }

  // 申请变体：记录"等待中"，编译完成后切换；失败则挂替代材质并保留诊断
  async requestVariant(material, reason) {
    const requestedAt = performance.now();
    const program = material.shaderProgramId ? this.hotSwap.getProgram(material.shaderProgramId) : null;
    const isCustom = !!(program && program.fragmentSource !== FRAGMENT_SHADER);

    // 已有自定义源码、且不是结构变更：直接采用程序已发布的变体，不能用模板覆盖它
    if (isCustom && !reason.startsWith('struct:')) {
      if (program.published.status === 'ok' && program.published.variant) {
        const variant = program.published.variant;
        material.shaderInstance.variant = variant;
        this.activeVariant = variant;
        this.activeVariantOfMaterial = material.id;
        this.activeFallback = false;
        this.lastCompileResult = {
          status: 'ok', fromCache: true, compileMs: null, reason: null, identity: variant.identity,
        };
        return { status: 'ok', variant, identity: variant.identity, fromCache: true };
      }
    }

    // 自定义源码遇结构变更：用新的 defines 重新编译同一份源码，失败保留旧版本
    if (isCustom && reason.startsWith('struct:')) {
      this.pending = { materialId: material.id, struct: { ...material.struct }, requestedAt };
      const task = this.hotSwap.submitCandidate(program.id, {});
      const result = await this.hotSwap.runCandidate(task);
      this.pending = null;
      if (result.adopted) {
        const variant = program.published.variant;
        this.activeVariant = variant;
        this.activeVariantOfMaterial = material.id;
        this.activeFallback = false;
        this.lastCompileResult = {
          status: 'ok', fromCache: !!result.fromCache, compileMs: result.compileMs ?? null,
          reason: null, identity: variant.identity,
        };
        return { status: 'ok', variant, identity: variant.identity, fromCache: !!result.fromCache };
      }
      // 失败：保留先前可运行版本；不让旧管线伪装成新结构效果
      this.lastFailure = {
        reason: result.reason, diagnostic: result.diagnostic ?? null,
        bindingErrors: result.bindingErrors ?? null, at: performance.now(),
      };
      this.lastCompileResult = {
        status: 'rejected', fromCache: false, compileMs: null, reason: result.reason, identity: null,
      };
      return { status: 'rejected', reason: result.reason, diagnostic: result.diagnostic, fromCache: false, identity: null };
    }

    this.pending = { materialId: material.id, struct: { ...material.struct }, requestedAt };
    const result = await this.pipeline.getOrCreateVariant(material.struct, { reason });
    this.pending = null;
    if (result.status === 'ok') {
      this.activeVariant = result.variant;
      this.activeVariantOfMaterial = material.id;
      this.activeFallback = false;
      if (program) this.hotSwap.notePublished(program.id, result.variant);
    } else {
      // 失败：明确挂替代材质，绝不让旧管线伪装成新效果
      this.activeVariant = result.fallback;
      this.activeVariantOfMaterial = material.id;
      this.activeFallback = true;
      this.lastFailure = { reason: result.reason, diagnostic: result.diagnostic, at: performance.now() };
      if (program) this.hotSwap.noteFailed(program.id, result.diagnostic);
    }
    // 材质实例采用该变体（与热换共享同一个实例字段，渲染只认实例上的已发布变体）
    material.shaderInstance.variant = this.activeVariant;
    material.shaderInstance.struct = { ...material.struct };
    this.lastCompileResult = {
      status: result.status,
      fromCache: result.fromCache ?? false,
      compileMs: result.compileMs ?? null,
      reason: result.reason ?? null,
      identity: result.identity,
    };
    return result;
  }

  // 已知场景需求的预热（默认只预热三份在用材质，而非 18 个全组合）
  prewarm(needed, budget) {
    const list = needed ?? [...this.materials.values()].map((m) => m.struct);
    return this.pipeline.prewarm(list, budget);
  }

  // ---- 运行中着色器热换 ----

  // 同步受理候选源码（编辑文本已保存），编译在后台进行，不会立刻改变画面。
  submitShaderCandidate(fragmentSource, options = {}) {
    const material = this.getMaterial(options.materialId ?? this.currentMaterialId);
    const programId = material.shaderProgramId;
    const task = this.hotSwap.submitCandidate(programId, {
      fragmentSource,
      editVersion: options.editVersion,
    });
    this.eventLog.push({
      type: 'shader-candidate-submitted', materialId: material.id,
      programId, revision: task.revision, at: performance.now(),
    });
    // 候选提交只代表文本已保存；画面仍由已发布变体渲染，直到 runShaderCandidate 成功发布。
    return {
      accepted: true,
      materialId: material.id,
      programId,
      revision: task.revision,
      editVersion: task.editVersion,
      // 关键区分：文本保存 ≠ 画面已更新
      editorTextSaved: true,
      publishedRevision: this.hotSwap.getProgram(programId).published.revision,
      activeVariantKey: material.shaderInstance.variant?.key ?? null,
      task,
    };
  }

  // 运行已受理的候选任务，成功则切换所有受影响实例；失败保留先前可运行版本。
  async runShaderCandidate(task, options = {}) {
    const result = await this.hotSwap.runCandidate(task);
    if (result.adopted) {
      const program = this.hotSwap.getProgram(task.programId);
      this.activeVariant = program.published.variant;
      this.activeVariantOfMaterial = this._materialIdOfProgram(task.programId);
      this.activeFallback = false;
      this.lastCompileResult = {
        status: 'ok',
        fromCache: !!result.fromCache,
        compileMs: result.compileMs ?? null,
        reason: null,
        identity: program.published.variant.identity,
      };
    } else if (!result.superseded) {
      // 保留旧版本运行：activeVariant 不改变；只记录候选失败原因。
      this.lastFailure = {
        reason: result.reason,
        diagnostic: result.diagnostic ?? null,
        bindingErrors: result.bindingErrors ?? null,
        at: performance.now(),
      };
    }
    this.eventLog.push({
      type: result.adopted ? 'shader-candidate-published' : result.superseded ? 'shader-candidate-superseded' : 'shader-candidate-rejected',
      programId: task.programId, revision: task.revision, at: performance.now(),
    });
    void options;
    return result;
  }

  // 一步完成：提交 + 编译 + 条件发布。返回结果明确 adopted / 具体失败原因。
  async hotSwapShader(fragmentSource, options = {}) {
    const task = this.submitShaderCandidate(fragmentSource, options).task;
    return this.runShaderCandidate(task, options);
  }

  shaderProgramState(materialId = this.currentMaterialId) {
    const material = this.getMaterial(materialId);
    return this.hotSwap.describeProgram(material.shaderProgramId);
  }

  rollbackShader(materialId = this.currentMaterialId) {
    const material = this.getMaterial(materialId);
    const r = this.hotSwap.rollback(material.shaderProgramId);
    if (r.rolledBack && r.variant) {
      material.shaderInstance.variant = r.variant;
      if (material.id === this.currentMaterialId) {
        this.activeVariant = r.variant;
        this.activeVariantOfMaterial = material.id;
        this.activeFallback = !!r.variant.isFallback;
        this.lastCompileResult = {
          status: 'ok', fromCache: true, compileMs: null, reason: null, identity: r.variant.identity,
        };
      }
    }
    return r;
  }

  _materialIdOfProgram(programId) {
    for (const m of this.materials.values()) {
      if (m.shaderProgramId === programId) return m.id;
    }
    return null;
  }

  buildUniforms(material) {
    const u = {};
    for (const [name, spec] of Object.entries(NUMERIC_PARAMS)) {
      const raw = material.params[name] ?? spec.default;
      u[name] = spec.type === 'vec4' ? new Vec4(...raw) : raw;
    }
    const eye = new Vec3(
      this.camera.distance * Math.cos(this.camera.pitch) * Math.sin(this.camera.yaw),
      this.camera.distance * Math.sin(this.camera.pitch),
      this.camera.distance * Math.cos(this.camera.pitch) * Math.cos(this.camera.yaw),
    );
    u.u_cameraPos = eye;
    u.u_lightDir = this.lightDir;
    u.u_lightColor = this.lightColor;
    return u;
  }

  renderFrame(options = {}) {
    const material = this.getMaterial(this.currentMaterialId);
    const mesh = this.meshes.get(options.mesh ?? material.mesh ?? 'sphere');
    // 渲染只采用"已发布"变体：热换候选未切换前，画面仍是上一份可运行版本。
    const instance = material.shaderInstance;
    const variant = instance?.variant ?? this.activeVariant;
    if (!variant) throw new Error('没有可用管线变体');

    const textures = this.getTextures(material.textureKind);
    const samplers = {
      u_baseColorTex: textures.albedo,
      u_occlusionTex: textures.occlusion,
    };
    // 采样器绑定按管线的真实绑定布局准备；新布局需要新绑定组，不复用旧组。
    const requiredSamplers = variant.bindingLayout?.samplers?.map((s) => s.name)
      ?? ['u_baseColorTex', 'u_occlusionTex'];
    for (const name of requiredSamplers) {
      if (name === 'u_normalTex') samplers[name] = textures.normal;
      else if (name === 'u_baseColorTex') samplers[name] = textures.albedo;
      else if (name === 'u_occlusionTex') samplers[name] = textures.occlusion;
    }

    const w = options.width ?? this.renderer.width;
    const h = options.height ?? this.renderer.height;
    this.renderer.resize(w, h);
    this.renderer.clear();

    const aspect = w / h;
    const proj = perspective(Math.PI / 4, aspect, 0.1, 50);
    const eye = new Vec3(
      this.camera.distance * Math.cos(this.camera.pitch) * Math.sin(this.camera.yaw),
      this.camera.distance * Math.sin(this.camera.pitch),
      this.camera.distance * Math.cos(this.camera.pitch) * Math.cos(this.camera.yaw),
    );
    const view = lookAt(eye, new Vec3(0, 0, 0), new Vec3(0, 1, 0));
    const viewProj = Mat4.multiply(proj, view);
    const model = Mat4.multiply(rotateY(this.camera.yaw * 0.4), rotateX(0.15));
    const normalMat = model.normalMatrix();

    const uniforms = this.buildUniforms(material);
    // 在途帧持有引用；热换期间被替换的旧管线不会在此之前回收
    this.pipeline.acquireVariant(variant);
    let renderMs;
    try {
      const t0 = performance.now();
      this.renderer.render({
        variant, mesh, uniforms, samplers,
        modelMatrix: model, viewProjMatrix: viewProj, normalMatrix: normalMat,
      });
      renderMs = performance.now() - t0;
    } finally {
      this.pipeline.releaseVariant(variant);
    }

    const bytes = this.renderer.toByteFrame();
    const frame = {
      seq: ++this._frameSeq,
      png: encodePNG(bytes, w, h),
      width: w, height: h,
      renderMs,
      variantKey: variant.key,
      isFallback: !!variant.isFallback,
      bindingLayoutHash: variant.bindingLayout?.hash ?? null,
      materialId: material.id,
      struct: { ...material.struct },
    };
    this.lastFrame = frame;
    return frame;
  }

  describeState() {
    const material = this.getMaterial(this.currentMaterialId);
    const programId = material.shaderProgramId;
    return {
      currentMaterial: {
        id: material.id, name: material.name,
        struct: material.struct, params: material.params, textureKind: material.textureKind,
        shaderProgramId: programId,
      },
      activeVariant: this.activeVariant ? {
        key: this.activeVariant.key,
        isFallback: !!this.activeVariant.isFallback,
        targetState: this.activeVariant.targetState,
        uniformLayout: this.activeVariant.uniformLayout,
        bindingLayoutHash: this.activeVariant.bindingLayout?.hash ?? null,
        ofMaterial: this.activeVariantOfMaterial,
      } : null,
      shaderProgram: programId ? this.hotSwap.describeProgram(programId) : null,
      hotSwap: this.hotSwap.stats(),
      pending: this.pending,
      lastCompile: this.lastCompileResult ?? null,
      lastFailure: this.lastFailure ?? null,
      pipeline: this.pipeline.stats,
      numericSchema: NUMERIC_PARAMS,
      structSchema: STRUCT_FIELDS,
      engineUniforms: ENGINE_UNIFORMS,
      textures: TEXTURE_KINDS,
      meshes: MESH_NAMES,
    };
  }

  pipelineSnapshot() { return this.pipeline.snapshot(); }

  // ---- 固定操作序列基准：首次切换卡顿、变体数量、重复进入复用 ----
  async runBenchmark(sequence) {
    const ops = sequence ?? this._defaultSequence();
    const report = { startedAt: performance.now(), operations: [], variantsCompiled: 0, cacheHits: 0, fallbacks: 0 };
    const cacheBefore = this.pipeline.stats.cachedVariants;

    for (const op of ops) {
      const t0 = performance.now();
      if (op.action === 'select') await this.selectMaterial(op.materialId);
      if (op.action === 'struct') await this.setStruct(op.field, op.value);
      if (op.action === 'param') this.setParam(op.name, op.value);
      if (op.action === 'frame') this.renderFrame();
      const elapsed = performance.now() - t0;
      const lc = this.lastCompileResult;
      report.operations.push({
        op, elapsedMs: Number(elapsed.toFixed(2)),
        compile: lc ? {
          status: lc.status, fromCache: lc.fromCache,
          compileMs: lc.compileMs ? Number(lc.compileMs.toFixed(2)) : null,
        } : null,
        fallback: !!this.activeFallback,
      });
      if (lc?.status === 'ok' && !lc.fromCache) report.variantsCompiled++;
      if (lc?.fromCache) report.cacheHits++;
      if (this.activeFallback) report.fallbacks++;
    }
    report.totalDurationMs = Number((performance.now() - report.startedAt).toFixed(2));
    report.cacheSizeAfter = this.pipeline.stats.cachedVariants;
    report.newVariants = report.cacheSizeAfter - cacheBefore;
    report.firstSwitchJankMs = report.operations.find((o) => o.compile && !o.compile.fromCache)?.elapsedMs ?? null;
    return report;
  }

  _defaultSequence() {
    const ids = [...this.materials.keys()];
    const ops = [];
    // 首次进入三个场景（应产生编译）
    for (const id of ids) ops.push({ action: 'select', materialId: id });
    // 数值参数抖动（不应产生编译）
    ops.push({ action: 'param', name: 'u_roughness', value: 0.12 });
    ops.push({ action: 'param', name: 'u_roughness', value: 0.88 });
    ops.push({ action: 'frame' });
    // 结构切换（产生新变体）
    ops.push({ action: 'struct', field: 'LIGHTING', value: 0 });
    ops.push({ action: 'struct', field: 'LIGHTING', value: 2 });
    // 重复进入相同场景（应命中缓存）
    for (const id of ids) ops.push({ action: 'select', materialId: id });
    ops.push({ action: 'frame' });
    return ops;
  }

  // 重复进入场景验证：同一结构两次申请，第二次必须缓存命中且像素一致
  async verifyReuse(materialId = this.currentMaterialId) {
    await this.selectMaterial(materialId);
    const first = this.lastCompileResult;
    const frameA = this.renderFrame();
    // 再次申请同一变体：走场景自己的变体申请，保持 activeVariant 一致
    await this.requestVariant(this.getMaterial(materialId), 'reuse-b');
    const second = this.lastCompileResult;
    const frameB = this.renderFrame();
    return {
      materialId,
      firstFromCache: first.fromCache,
      secondFromCache: second.fromCache,
      reused: !!second.fromCache && first.identity.key === second.identity.key,
      identicalPixels: frameA.png.equals(frameB.png),
      variantKey: second.identity.key,
    };
  }
}
