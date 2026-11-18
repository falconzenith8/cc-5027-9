// 场景服务：把材质、模型、纹理、管线变体与渲染器串成完整的预览运行时。
// 负责：变体申请与当前/等待状态、uniform 实时更新（不重编译）、
// 场景流送（逐帧渲染 PNG）、预热编排、固定操作序列基准测量与重复进入复用验证。
import { PipelineManager, HotSwapStatus } from './pipeline-manager.js';
import { SoftwareRenderer } from '../render/renderer.js';
import { createMesh, MESH_NAMES } from '../render/meshes.js';
import { buildTextureSet, TEXTURE_KINDS } from '../render/textures.js';
import { encodePNG } from '../render/png.js';
import {
  NUMERIC_PARAMS, STRUCT_FIELDS, ENGINE_UNIFORMS, FRAGMENT_SHADER,
} from '../shader/material-templates.js';
import { Mat4, Vec3, Vec4, perspective, lookAt, rotateY, rotateX } from '../shader/value-types.js';
import {
  TEMPLATE_SOURCE_ID, validateBindingLayout, diffBindingLayout,
  prepareBindings, resolveUniformValues,
} from './bindings.js';

let materialSeq = 0;
let sourceSeq = 0;
function nextCustomSourceId(materialId) {
  return `custom:${materialId}:${++sourceSeq}`;
}

function defaultNumericParams() {
  const out = {};
  for (const [k, spec] of Object.entries(NUMERIC_PARAMS)) {
    out[k] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
  return out;
}

// 一份"材质"= 结构选项（决定变体身份）+ 数值参数（只写 uniform）+ 纹理选择
// 热换相关字段：publishedShader（已发布源码与编辑版本）、shaderDraft（编辑器草稿）、
// bindings（按当前管线资源布局准备的绑定组）、hotswap（最近一次热换状态）
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
    sourceId: TEMPLATE_SOURCE_ID,
    publishedShader: {
      sourceId: TEMPLATE_SOURCE_ID,
      source: partial.fragmentSource ?? FRAGMENT_SHADER,
      edition: 0,
      at: performance.now(),
    },
    shaderDraft: { source: partial.fragmentSource ?? FRAGMENT_SHADER, savedAt: performance.now() },
    bindings: null,
    hotswap: null,
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
    // 每个材质当前在用的变体 key —— 延迟回收时据此判断旧管线是否仍被引用
    this.activeVariantByMaterial = new Map();
    this.pending = null; // { materialId, struct, requestedAt }
    this.lastFrame = null;
    this.camera = { distance: 3.2, yaw: 0.7, pitch: 0.35 };
    this.lightDir = new Vec3(0.45, 0.75, 0.5);
    this.lightColor = new Vec3(1.0, 0.97, 0.92);
    this.eventLog = [];
    this._frameSeq = 0;

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
    // 材质已发布自定义源码：直接复用其热换变体（仍在缓存中），不退回模板管线
    if (m.sourceId !== TEMPLATE_SOURCE_ID) {
      return this.#restorePublishedVariant(m);
    }
    return this.requestVariant(m, 'select');
  }

  // 重新采用材质已发布的热换变体（场景切回路径）：命中缓存即零重编译
  async #restorePublishedVariant(material) {
    const key = this.activeVariantByMaterial.get(material.id);
    const variant = key ? this.pipeline.cache.get(key) : null;
    if (variant) {
      this.#adoptVariant(material, variant);
      this.activeFallback = false;
      this.lastCompileResult = {
        status: 'ok', fromCache: true, compileMs: null, reason: null, identity: variant.identity,
      };
      this.eventLog.push({ type: 'hotswap-restore', materialId: material.id, key: variant.key, at: performance.now() });
      return { status: 'ok', variant, identity: variant.identity, fromCache: true };
    }
    // 缓存已被回收等极端情况：按已发布源码重新热换编译
    return this.applyShaderEdit({ materialId: material.id, source: material.publishedShader.source });
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
    this.eventLog.push({ type: 'struct-change', field, value, at: performance.now() });
    // 材质在用自定义源码：结构变化必须带着新结构重编该源码，而不是退回模板变体
    if (m.sourceId !== TEMPLATE_SOURCE_ID) {
      await this.applyShaderEdit({ source: m.publishedShader.source });
    } else {
      await this.requestVariant(m, `struct:${field}`);
    }
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
    this.pending = { materialId: material.id, struct: { ...material.struct }, requestedAt };
    const result = await this.pipeline.getOrCreateVariant(material.struct, { reason });
    this.pending = null;
    if (result.status === 'ok') {
      this.#adoptVariant(material, result.variant);
      this.activeFallback = false;
    } else {
      // 失败：明确挂替代材质，绝不让旧管线伪装成新效果
      this.activeVariant = result.fallback;
      this.activeVariantOfMaterial = material.id;
      this.activeVariantByMaterial.set(material.id, result.fallback.key);
      this.activeFallback = true;
      this.lastFailure = { reason: result.reason, diagnostic: result.diagnostic, at: performance.now() };
    }
    this.lastCompileResult = {
      status: result.status,
      fromCache: result.fromCache ?? false,
      compileMs: result.compileMs ?? null,
      reason: result.reason ?? null,
      identity: result.identity,
    };
    return result;
  }

  // 切换到一个已通过编译与绑定检查的变体：先按新管线资源布局准备材料，
  // 再做单次指针切换；旧管线若被源码更新失效则进入/离开延迟回收。
  #adoptVariant(material, variant) {
    const previousKey = this.activeVariantByMaterial.get(material.id) ?? null;
    const textures = this.getTextures(material.textureKind);
    material.bindings = prepareBindings({ variant, material, textures });
    this.activeVariant = variant;
    this.activeVariantOfMaterial = material.id;
    this.activeVariantByMaterial.set(material.id, variant.key);
    // 旧变体若已被源码失效（在 retired 中），现在确认无引用后真正释放
    if (previousKey && previousKey !== variant.key) {
      this.pipeline.releaseRetired(this.#allActiveVariantKeys());
    }
  }

  #allActiveVariantKeys() {
    return [...this.activeVariantByMaterial.values(), ...(this.activeVariant ? [this.activeVariant.key] : [])];
  }

  // 保存编辑器草稿：只更新文本与编辑版本，绝不代表画面已更新
  saveShaderDraft(source) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('着色器源码不能为空');
    const material = this.getMaterial(this.currentMaterialId);
    material.shaderDraft = { source, savedAt: performance.now() };
    this.eventLog.push({ type: 'shader-draft-saved', materialId: material.id, at: performance.now() });
    return this.getShaderState();
  }

  /**
   * 运行中热换：候选先编译并检查资源布局，通过后才切换受影响材质。
   * 编译任务携带编辑版本；连续保存后晚返回的旧结果不覆盖新代码。
   * 失败保留先前可运行版本，并返回具体原因。
   */
  async applyShaderEdit(options = {}) {
    const material = options.materialId
      ? this.getMaterial(options.materialId)
      : this.getMaterial(this.currentMaterialId);
    const source = options.source ?? material.shaderDraft.source;
    material.shaderDraft = { source, savedAt: performance.now() };

    // 每次提交单调递增的编辑版本；编译任务携带它做新旧裁决
    material._nextEdition = (material._nextEdition ?? material.publishedShader.edition ?? 0) + 1;
    const submittedEdition = material._nextEdition;
    material.hotswap = {
      status: 'compiling', submittedEdition,
      candidateSource: source, startedAt: performance.now(),
    };
    this.eventLog.push({
      type: 'shader-hotswap-start', materialId: material.id,
      edition: submittedEdition, at: performance.now(),
    });

    const wasCustom = material.sourceId !== TEMPLATE_SOURCE_ID;
    // 回退到模板时沿用模板 sourceId（命中静态缓存）；否则为该材质的自定义源码流，
    // 首次脱离模板时分配独立 sourceId，后续编辑复用同一 sourceId 做相关条目失效
    const targetSourceId = options.resetToTemplate
      ? TEMPLATE_SOURCE_ID
      : (wasCustom ? material.sourceId : nextCustomSourceId(material.id));
    const request = {
      fragmentSource: source,
      struct: { ...material.struct },
      sourceId: targetSourceId,
      sourceEdition: submittedEdition,
      layoutValidator: validateBindingLayout,
    };
    // 版本裁决：只有仍是该材质最新提交的任务才允许发布
    const result = await this.pipeline.compileHotSwap(
      request,
      (ed) => material.hotswap?.submittedEdition === ed,
    );

    // 期间又有新提交：无论成功失败都不得改动已发布状态。
    // 任务自身的过期结论记录在 lastSettled，材质的 hotswap 仍属于最新任务。
    if (material.hotswap.submittedEdition !== submittedEdition) {
      material.lastSettled = {
        status: 'stale', submittedEdition,
        finishedAt: performance.now(),
        reason: `编辑版本 ${submittedEdition} 已过期，结果未发布`,
      };
      this.eventLog.push({
        type: 'shader-hotswap-stale', materialId: material.id,
        edition: submittedEdition, at: performance.now(),
      });
      return { ...this.getShaderState(material.id), hotswap: material.lastSettled };
    }

    if (result.status === HotSwapStatus.FAILED) {
      material.hotswap = {
        ...material.hotswap,
        status: 'failed', finishedAt: performance.now(),
        reason: result.reason,
        diagnostic: result.diagnostic ? {
          stage: result.diagnostic.stage, phase: result.diagnostic.phase,
          message: result.diagnostic.message, sourceLine: result.diagnostic.sourceLine,
        } : null,
      };
      this.lastFailure = {
        reason: result.reason, diagnostic: result.diagnostic, at: performance.now(),
      };
      this.eventLog.push({
        type: 'shader-hotswap-failed', materialId: material.id,
        edition: submittedEdition, reason: result.reason, at: performance.now(),
      });
      // 先前可运行版本原封不动（activeVariant 未被触碰）
      return this.getShaderState(material.id);
    }

    if (result.status === HotSwapStatus.REJECTED_STALE) {
      material.hotswap = {
        ...material.hotswap, status: 'stale', finishedAt: performance.now(), reason: result.reason,
      };
      return this.getShaderState(material.id);
    }

    // 发布成功。顺序很重要：先为新管线准备材料并切换采用，再失效同源码旧条目 ——
    // 否则旧 sourceId 的失效会把刚入缓存的新变体一并删掉。
    const previousLayout = this.activeVariantOfMaterial === material.id && this.activeVariant
      ? this.activeVariant.uniformLayout
      : null;
    const layoutDiff = diffBindingLayout(previousLayout, result.variant.uniformLayout);

    // 为新管线准备对应材料后，单次切换受影响材质（旧绑定组不交给不兼容管线）
    this.#adoptVariant(material, result.variant);
    this.activeFallback = false;
    material.sourceId = request.sourceId;
    // 切换完成后再失效同一源码的旧缓存条目（其他源码的静态变体缓存继续有效）；
    // 仍被其他材质引用的旧管线进入延迟回收，无引用的立即释放
    if (wasCustom) {
      this.pipeline.invalidateSource(material.sourceId, this.#allActiveVariantKeys(), result.variant.key);
      this.pipeline.releaseRetired(this.#allActiveVariantKeys());
    }
    material.publishedShader = {
      sourceId: request.sourceId, source,
      edition: submittedEdition, at: performance.now(),
    };
    material.hotswap = {
      status: 'published', submittedEdition, publishedEdition: submittedEdition,
      finishedAt: performance.now(), bindingLayout: result.bindingLayout, layoutDiff,
    };
    this.lastCompileResult = {
      status: 'ok', fromCache: result.fromCache ?? false, compileMs: result.variant.compileMs,
      reason: null, identity: result.identity,
    };
    this.eventLog.push({
      type: 'shader-hotswap-published', materialId: material.id,
      edition: submittedEdition, key: result.variant.key,
      layoutChanged: layoutDiff.uniformsAdded.length
        || layoutDiff.uniformsRemoved.length
        || layoutDiff.samplersAdded.length
        || layoutDiff.samplersRemoved.length,
      at: performance.now(),
    });
    return this.getShaderState(material.id);
  }

  // 回退到模板着色器：同样走"先编译再切换"，不通过重启程序回避生命周期
  async resetShader() {
    const material = this.getMaterial(this.currentMaterialId);
    const customSourceId = material.sourceId;
    const state = await this.applyShaderEdit({ source: FRAGMENT_SHADER, resetToTemplate: true });
    // 自定义源码的残留条目现在确定无引用，显式失效并释放
    if (customSourceId !== TEMPLATE_SOURCE_ID) {
      this.pipeline.invalidateSource(customSourceId, this.#allActiveVariantKeys());
      this.pipeline.releaseRetired(this.#allActiveVariantKeys());
    }
    return state;
  }

  // 候选（编辑器草稿）与已发布状态的显式比较：保存成功不等于画面已更新
  getShaderState(materialId = this.currentMaterialId) {
    const material = this.getMaterial(materialId);
    const draftSource = material.shaderDraft?.source ?? material.publishedShader.source;
    const published = material.publishedShader;
    const activeVariant = this.activeVariantOfMaterial === material.id ? this.activeVariant : null;
    return {
      materialId: material.id,
      sourceId: material.sourceId,
      draft: {
        source: draftSource,
        savedAt: material.shaderDraft?.savedAt ?? null,
        differsFromPublished: draftSource !== published.source,
      },
      published: {
        source: published.source,
        edition: published.edition,
        at: published.at,
        variantKey: activeVariant?.key ?? null,
        uniformLayout: activeVariant?.uniformLayout ?? null,
      },
      hotswap: material.hotswap ? {
        status: material.hotswap.status,
        submittedEdition: material.hotswap.submittedEdition,
        publishedEdition: material.hotswap.publishedEdition ?? published.edition,
        reason: material.hotswap.reason ?? null,
        diagnostic: material.hotswap.diagnostic ?? null,
        layoutDiff: material.hotswap.layoutDiff ?? null,
      } : null,
      // 画面是否真的已更新：草稿与已发布源码一致即同步（初始模板也算）；
      // 草稿一旦偏离已发布（仅保存未编译）则立即失步，直到下次成功热换
      viewportInSync: draftSource === published.source,
    };
  }

  // 已知场景需求的预热（默认只预热三份在用材质，而非 18 个全组合）
  prewarm(needed, budget) {
    const list = needed ?? [...this.materials.values()].map((m) => m.struct);
    return this.pipeline.prewarm(list, budget);
  }

  buildUniforms(material) {
    const u = {};
    for (const [name, spec] of Object.entries(NUMERIC_PARAMS)) {
      const raw = material.params[name] ?? spec.default;
      u[name] = spec.type === 'vec4' ? new Vec4(...raw) : raw;
    }
    // 热换引入的材质 uniform（模板参数表之外）：按准备好的绑定组取值
    Object.assign(u, resolveUniformValues(material));
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
    const variant = this.activeVariant;
    if (!variant) throw new Error('没有可用管线变体');

    const textures = this.getTextures(material.textureKind);
    // 绑定组按当前管线资源布局准备：只交它声明的采样器，
    // 布局改变后的新管线绝不会收到旧绑定组
    const samplers = material.bindings?.samplers ?? {
      u_baseColorTex: textures.albedo,
      u_occlusionTex: textures.occlusion,
      ...(material.struct.NORMAL_MAP ? { u_normalTex: textures.normal } : {}),
    };

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
    const t0 = performance.now();
    this.renderer.render({
      variant, mesh, uniforms, samplers,
      modelMatrix: model, viewProjMatrix: viewProj, normalMatrix: normalMat,
    });
    const renderMs = performance.now() - t0;

    const bytes = this.renderer.toByteFrame();
    const frame = {
      seq: ++this._frameSeq,
      png: encodePNG(bytes, w, h),
      width: w, height: h,
      renderMs,
      variantKey: variant.key,
      isFallback: !!variant.isFallback,
      materialId: material.id,
      sourceId: variant.sourceId,
      sourceEdition: variant.sourceEdition,
      struct: { ...material.struct },
    };
    this.lastFrame = frame;
    return frame;
  }

  describeState() {
    const material = this.getMaterial(this.currentMaterialId);
    return {
      currentMaterial: {
        id: material.id, name: material.name,
        struct: material.struct, params: material.params, textureKind: material.textureKind,
      },
      activeVariant: this.activeVariant ? {
        key: this.activeVariant.key,
        isFallback: !!this.activeVariant.isFallback,
        targetState: this.activeVariant.targetState,
        uniformLayout: this.activeVariant.uniformLayout,
        ofMaterial: this.activeVariantOfMaterial,
        sourceId: this.activeVariant.sourceId,
        sourceEdition: this.activeVariant.sourceEdition,
      } : null,
      shader: this.getShaderState(),
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
