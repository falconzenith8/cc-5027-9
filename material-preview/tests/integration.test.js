import { test, assert, approx } from './harness.js';
import { PreviewSceneService } from '../src/core/preview-scene.js';
import { normalizeStruct, buildVariantIdentity } from '../src/core/variant-key.js';
import { STRUCT_FIELDS, VERTEX_LAYOUT, VERTEX_SHADER, FRAGMENT_SHADER } from '../src/shader/material-templates.js';
import { preprocess } from '../src/shader/preprocessor.js';
import { encodePNG } from '../src/render/png.js';

console.log('== 变体身份与缓存 ==');

test('不同结构选项产生不同身份；数值参数不参与身份', () => {
  const mk = (struct) => {
    const defines = { NORMAL_MAP: struct.NORMAL_MAP, BLEND_MODE: struct.BLEND_MODE, LIGHTING: struct.LIGHTING };
    const vs = preprocess(VERTEX_SHADER, { defines }).code;
    const fs = preprocess(FRAGMENT_SHADER, { defines }).code;
    return buildVariantIdentity({ vertexSource: vs, fragmentSource: fs, layout: VERTEX_LAYOUT, struct, stage: 'graphics' });
  };
  const a = mk({ NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 2 });
  const b = mk({ NORMAL_MAP: 1, BLEND_MODE: 0, LIGHTING: 2 });
  const c = mk({ NORMAL_MAP: 0, BLEND_MODE: 2, LIGHTING: 2 });
  assert(a.key !== b.key && a.key !== c.key && b.key !== c.key, '三种结构必须互不同 key');
  // 同结构重复构建必须同 key（数值参数不在结构内，天然不影响）
  assert(mk({ NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 2 }).key === a.key);
});

test('非法结构值被拒绝而不是落到默认缓存', () => {
  let threw = false;
  try { normalizeStruct({ NORMAL_MAP: 9, BLEND_MODE: 0, LIGHTING: 2 }, STRUCT_FIELDS); }
  catch (e) { threw = true; assert(e.code === 'INVALID_STRUCT'); }
  assert(threw);
});

console.log('== 端到端管线 ==');

const svc = await PreviewSceneService.create({ width: 128, height: 128 });

test('初始选择材质完成真实编译并渲染出非背景像素', async () => {
  const result = svc.lastCompileResult;
  assert(result.status === 'ok', '首次编译应成功');
  assert(result.fromCache === false, '首次不应命中缓存');
  const frame = svc.renderFrame();
  assert(frame.png.length > 1000, 'PNG 应有实质内容');
  // 画面中必须存在显著区别于背景 (0.09,0.1,0.13) 的像素
  const fb = svc.renderer.framebuffer.color;
  let interesting = 0;
  for (let i = 0; i < fb.length; i += 4) {
    if (Math.abs(fb[i] - 0.09) + Math.abs(fb[i + 1] - 0.1) > 0.25) interesting++;
  }
  assert(interesting > 200, `前景像素过少: ${interesting}`);
});

test('改粗糙度只更新 uniform，不产生新编译', async () => {
  const before = svc.pipeline.stats.cachedVariants;
  svc.setParam('u_roughness', 0.17);
  svc.setParam('u_metallic', 0.63);
  const f1 = svc.renderFrame();
  svc.setParam('u_roughness', 0.91);
  const f2 = svc.renderFrame();
  assert(svc.pipeline.stats.cachedVariants === before, '数值改动不得新增变体');
  assert(f1.variantKey === f2.variantKey, '同一变体 key');
  assert(!f1.png.equals(f2.png), 'uniform 不同画面应真实变化');
});

test('结构切换产生新变体并真实改变画面', async () => {
  const id = svc.currentMaterialId;
  const frameBefore = svc.renderFrame();
  await svc.setStruct('LIGHTING', 0);
  assert(svc.lastCompileResult.status === 'ok' && svc.lastCompileResult.fromCache === false);
  const frameUnlit = svc.renderFrame();
  assert(frameUnlit.variantKey !== frameBefore.variantKey, '无光照是不同管线');
  assert(!frameUnlit.png.equals(frameBefore.png), '画面必须不同');
  // 切回去：应命中已有缓存
  await svc.setStruct('LIGHTING', 2);
  assert(svc.lastCompileResult.fromCache === true, '恢复原结构应缓存命中');
  assert(svc.getMaterial(id).struct.LIGHTING === 2);
});

test('AlphaTest 的 discard 与 AlphaBlend 的混合是不同目标状态', async () => {
  await svc.setStruct('BLEND_MODE', 1);
  const testState = svc.activeVariant.targetState;
  assert(testState.blend.enabled === false && testState.blend.depthWrite === true);
  await svc.setStruct('BLEND_MODE', 2);
  const blendState = svc.activeVariant.targetState;
  assert(blendState.blend.enabled === true && blendState.blend.depthWrite === false);
  await svc.setStruct('BLEND_MODE', 0);
});

test('法线贴图开关改变预处理源码与变体', async () => {
  const off = (await svc.pipeline.getOrCreateVariant({ NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 2 })).identity.key;
  const on = (await svc.pipeline.getOrCreateVariant({ NORMAL_MAP: 1, BLEND_MODE: 0, LIGHTING: 2 })).identity.key;
  assert(off !== on);
  // 第二次取同一变体必须命中
  const again = await svc.pipeline.getOrCreateVariant({ NORMAL_MAP: 1, BLEND_MODE: 0, LIGHTING: 2 });
  assert(again.fromCache === true);
});

test('编译失败保留诊断并挂替代材质，旧管线不伪装', async () => {
  const broken = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(ghostSymbol, 0.0, 0.0, 1.0);
}`;
  const result = await svc.pipeline.compileBroaderSource(broken, {});
  assert(result.status === 'fallback', '失败必须走 fallback');
  assert(result.diagnostic.phase === 'semantic', '应记录语义阶段诊断');
  assert(result.diagnostic.message.includes('ghostSymbol'));
  assert(result.fallback.isFallback === true);
  const snap = svc.pipeline.snapshot();
  assert(snap.failures.length >= 1, '失败条目必须保留在诊断表');
});

test('预热受预算与取消约束，不枚举全部组合', async () => {
  const fresh = await PreviewSceneService.create({ width: 64, height: 64 });
  const token = { cancelled: true };
  const report = await fresh.prewarm(
    [{ NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 0 }, { NORMAL_MAP: 1, BLEND_MODE: 1, LIGHTING: 1 }],
    { maxVariants: 1, cancelToken: token },
  );
  assert(report.cancelled === true, '预取消令牌必须生效');
  assert(report.compiled === 0, '取消后不应有编译');

  const report2 = await fresh.prewarm(
    [{ NORMAL_MAP: 0, BLEND_MODE: 0, LIGHTING: 0 }, { NORMAL_MAP: 1, BLEND_MODE: 1, LIGHTING: 1 }],
    { maxVariants: 1 },
  );
  assert(report2.compiled === 1 && report2.skipped === 1, '预算只允许 1 个变体');
});

test('固定操作序列基准报告首次卡顿与复用', async () => {
  const r = await svc.runBenchmark();
  assert(typeof r.firstSwitchJankMs === 'number');
  assert(r.newVariants >= 1);
  assert(r.cacheHits >= 1, '重复进入场景必须出现缓存命中');
});

test('重复进入同场景：缓存命中且像素逐位一致', async () => {
  const r = await svc.verifyReuse();
  assert(r.reused === true, '第二次申请必须复用');
  assert(r.identicalPixels === true, '同变体同输入画面必须一致');
});

test('三个模型都能完成真实渲染', async () => {
  for (const mesh of ['sphere', 'cube', 'torus']) {
    const f = svc.renderFrame({ mesh, width: 96, height: 96 });
    assert(f.png.length > 500, `${mesh} 渲染失败`);
  }
});

test('PNG 编码头合法且尺寸正确', () => {
  const png = encodePNG(Buffer.alloc(8 * 8 * 4, 200), 8, 8);
  assert(png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert(png.readUInt32BE(16) === 8 && png.readUInt32BE(20) === 8);
});

test('法线贴图采样器仅在 NORMAL_MAP=1 时绑定', async () => {
  const mat = svc.getMaterial(svc.currentMaterialId);
  mat.struct.NORMAL_MAP = 0;
  await svc.requestVariant(mat, 'test');
  const tex0 = svc.getTextures(mat.textureKind);
  assert(tex0.normal, '纹理集始终含法线数据');
  const has0 = svc.activeVariant.uniformLayout.some((u) => u.name === 'u_normalTex');
  assert(has0 === false, '关闭法线时变体不该有该 uniform');
  mat.struct.NORMAL_MAP = 1;
  await svc.requestVariant(mat, 'test');
  const has1 = svc.activeVariant.uniformLayout.some((u) => u.name === 'u_normalTex');
  assert(has1 === true, '开启法线时变体必须声明该 uniform');
});

await import('./harness.js').then((h) => h.summary());
