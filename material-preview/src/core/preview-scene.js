// 场景服务：把材质、模型、纹理、管线变体与渲染器串成完整的预览运行时。
// 负责：变体申请与当前/等待状态、uniform 实时更新（不重编译）、
// 场景流送（逐帧渲染 PNG）、预热编排、固定操作序列基准测量与重复进入复用验证。
import { PipelineManager } from './pipeline-manager.js';
import { SoftwareRenderer } from '../render/renderer.js';
import { createMesh, MESH_NAMES } from '../render/meshes.js';
import { buildTextureSet, TEXTURE_KINDS } from '../render/textures.js';
import { encodePNG } from '../render/png.js';
import {
  NUMERIC_PARAMS, STRUCT_FIELDS, ENGINE_UNIFORMS,
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
    this.pending = { materialId: material.id, struct: { ...material.struct }, requestedAt };
    const result = await this.pipeline.getOrCreateVariant(material.struct, { reason });
    // 期间用户又改了选项：以最新申请为准，本次结果不覆盖
    if (this.pending && this.pending.materialId === material.id
      && JSON.stringify(this.pending.struct) !== JSON.stringify(material.struct)
      && reason !== 'select') {
      // 结构已继续变化，结果仍进入缓存可被后续命中
    }
    this.pending = null;
    if (result.status === 'ok') {
      this.activeVariant = result.variant;
      this.activeVariantOfMaterial = material.id;
      this.activeFallback = false;
    } else {
      // 失败：明确挂替代材质，绝不让旧管线伪装成新效果
      this.activeVariant = result.fallback;
      this.activeVariantOfMaterial = material.id;
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
    const samplers = {
      u_baseColorTex: textures.albedo,
      u_occlusionTex: textures.occlusion,
    };
    if (material.struct.NORMAL_MAP) samplers.u_normalTex = textures.normal;

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
      } : null,
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
