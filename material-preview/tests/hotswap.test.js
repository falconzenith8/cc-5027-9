// 着色器源码运行中热换（hot-swap）用例：
// 候选先编译 + 资源布局检查、通过后才切换受影响实例；失败保留先前可运行版本；
// 编译任务带编辑版本，晚到的旧结果不覆盖新代码；在用管线延迟回收；
// 静态变体缓存仅相关条目失效；候选与已发布状态可比较。
import { test, assert } from './harness.js';
import { PreviewSceneService, createMaterialRecord } from '../src/core/preview-scene.js';
import {
  TEMPLATE_SOURCE_ID, validateBindingLayout, BindingLayoutError,
  diffBindingLayout, describeBindingLayout,
} from '../src/core/bindings.js';
import { FRAGMENT_SHADER } from '../src/shader/material-templates.js';

console.log('== 资源绑定布局检查 ==');

test('不支持的采样器在布局检查阶段被拒绝，旧绑定组不会交给新管线', () => {
  const layout = [
    { name: 'u_baseColorTex', type: 'sampler2D' },
    { name: 'u_shadowMap', type: 'sampler2D' },
    { name: 'u_tint', type: 'float' },
  ];
  let threw = false;
  try { validateBindingLayout(layout); }
  catch (e) {
    threw = true;
    assert(e instanceof BindingLayoutError, '必须是 BindingLayoutError');
    assert(e.details.unsupported.includes('u_shadowMap'));
  }
  assert(threw, '含未知采样器的候选必须被拒绝');
  // 只声明已知采样器 + 普通 uniform 时通过
  const ok = validateBindingLayout([
    { name: 'u_occlusionTex', type: 'sampler2D' },
    { name: 'u_extra', type: 'vec4' },
  ]);
  assert(ok.samplers.includes('u_occlusionTex') && ok.uniforms.some((u) => u.name === 'u_extra'));
});

test('布局差异按字段级报告 uniform/采样器增删', () => {
  const oldL = [
    { name: 'u_baseColorTex', type: 'sampler2D' },
    { name: 'u_roughness', type: 'float' },
  ];
  const newL = [
    { name: 'u_baseColorTex', type: 'sampler2D' },
    { name: 'u_normalTex', type: 'sampler2D' },
    { name: 'u_tint', type: 'float' },
  ];
  const d = diffBindingLayout(oldL, newL);
  assert(d.samplersAdded.includes('u_normalTex'));
  assert(d.uniformsAdded.some((u) => u.name === 'u_tint'));
  assert(d.uniformsRemoved.some((u) => u.name === 'u_roughness'));
  assert(d.compatible === true);
  assert(describeBindingLayout(newL).samplers.length === 2);
});

console.log('== 运行中热换与回退 ==');

const svc = await PreviewSceneService.create({ width: 96, height: 96 });
const mat = () => svc.getMaterial(svc.currentMaterialId);

// 可编译的候选片元源码（颜色由参数与 uv 决定，便于核对真实画面变化）
const tintedShader = (tint) => `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform float u_tint;
void main() {
  fragColor = vec4(v_uv, 0.4 + u_tint * ${String(tint)}, 1.0);
}
`;

test('热换成功：真实编译并切换，帧采用新版本与新变体 key', async () => {
  const before = svc.renderFrame();
  const st = await svc.applyShaderEdit({ source: tintedShader(0.3) });
  assert(st.hotswap.status === 'published');
  assert(st.hotswap.submittedEdition === 1);
  assert(st.viewportInSync === true, '草稿与已发布一致时画面才算同步');
  const after = svc.renderFrame();
  assert(after.sourceEdition === 1, '帧头必须携带采用的编辑版本');
  assert(after.variantKey !== before.variantKey, '新源码是不同管线');
  assert(!after.png.equals(before.png), '着色结果必须真实变化');
  // 新增材质 uniform 被登记并给出默认值，渲染未因缺 uniform 失败
  assert(mat().bindings.uniformValues.u_tint === 0);
});

test('语法/语义错误：失败保留先前可运行版本并给出具体原因', async () => {
  const goodFrame = svc.renderFrame();
  const broken = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(ghostSymbol, 0.0, 0.0, 1.0);
}`;
  const st = await svc.applyShaderEdit({ source: broken });
  assert(st.hotswap.status === 'failed');
  assert(st.hotswap.diagnostic.phase === 'semantic', '语义阶段诊断');
  assert(st.hotswap.diagnostic.message.includes('ghostSymbol'));
  const nextFrame = svc.renderFrame();
  assert(nextFrame.sourceEdition === 1, '失败后仍采用上一可运行版本');
  assert(nextFrame.variantKey === goodFrame.variantKey, '旧管线未被替换');
  assert(nextFrame.png.equals(goodFrame.png), '画面保持旧版本');
  // 保存成功不等于画面更新：草稿已变，但 viewportInSync 必须为 false
  assert(st.draft.differsFromPublished === true);
  assert(st.viewportInSync === false);
});

test('预处理语法错误同样带阶段诊断且不影响在运行管线', async () => {
  const goodKey = svc.activeVariant.key;
  const bad = `#version 300 es
#if FOO
precision highp float;
out vec4 fragColor;
void main(){ fragColor = vec4(1.0); }
`;
  const st = await svc.applyShaderEdit({ source: bad });
  assert(st.hotswap.status === 'failed');
  assert(st.hotswap.diagnostic.phase === 'preprocess');
  assert(svc.activeVariant.key === goodKey);
});

test('绑定字段改变：为新管线准备新绑定组，新增采样器真实参与渲染', async () => {
  const withNormal = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_normalTex;
out vec4 fragColor;
void main() {
  vec3 n = texture(u_normalTex, v_uv).xyz;
  fragColor = vec4(n, 1.0);
}
`;
  const st = await svc.applyShaderEdit({ source: withNormal });
  assert(st.hotswap.status === 'published');
  assert(st.hotswap.layoutDiff.samplersAdded.includes('u_normalTex'));
  const m = mat();
  assert(Object.keys(m.bindings.samplers).includes('u_normalTex'), '新绑定组必须含新采样器纹理');
  const frame = svc.renderFrame();
  assert(frame.png.length > 500);
  // 再换成不支持的采样器：布局检查失败，绑定组与在用管线维持上一版
  const prevSamplers = { ...m.bindings.samplers };
  const bad = `#version 300 es
precision highp float;
uniform sampler2D u_shadowMap;
out vec4 fragColor;
void main(){ fragColor = texture(u_shadowMap, vec2(0.0)); }
`;
  const st2 = await svc.applyShaderEdit({ source: bad });
  assert(st2.hotswap.status === 'failed');
  assert(st2.hotswap.diagnostic.phase === 'layout');
  assert(svc.renderFrame().variantKey === frame.variantKey);
  assert(JSON.stringify(Object.keys(mat().bindings.samplers)) === JSON.stringify(Object.keys(prevSamplers)));
});

test('保存草稿只更新文本，不触发编译也不改变画面', async () => {
  const frameBefore = svc.renderFrame();
  const cacheBefore = svc.pipeline.stats.cachedVariants;
  const st = svc.saveShaderDraft('// 只是草稿\n' + FRAGMENT_SHADER);
  assert(st.draft.differsFromPublished === true);
  assert(st.viewportInSync === false);
  assert(svc.pipeline.stats.cachedVariants === cacheBefore, '保存草稿不产生编译');
  assert(svc.renderFrame().png.equals(frameBefore.png), '画面不变');
});

console.log('== 编辑版本门控与延迟回收 ==');

// 逐任务门控：每个热换链接独立排队，测试可确定性地控制完成顺序
function makeGatedService() {
  const queue = [];
  // 只门控热换链接；普通变体/初始编译直接放行，避免构造期死锁
  const linkGate = (doImport, stage) => (stage === 'hotswap'
    ? new Promise((resolve, reject) => queue.push({ run: () => doImport().then(resolve, reject) }))
    : doImport());
  const svcG = new PreviewSceneService({ width: 48, height: 48, linkGate });
  return { svcG, queue, release: () => queue.shift().run() };
}

test('连续保存：晚返回的旧编辑不得覆盖新代码', async () => {
  const { svcG, queue, release } = makeGatedService();
  await svcG.ready;
  const shader = (c) => `#version 300 es
precision highp float;
out vec4 fragColor;
void main(){ fragColor = vec4(${c}, 1.0); }
`;
  const pOld = svcG.applyShaderEdit({ source: shader('1.0, 0.0, 0.0') }); // 编辑 1
  const pNew = svcG.applyShaderEdit({ source: shader('0.0, 1.0, 0.0') }); // 编辑 2
  assert(svcG.pipeline.pendingWork.inFlight === 2, '两个链接任务都在进行中');
  release(); // 先放行旧编辑
  const oldState = await pOld;
  assert(oldState.hotswap.status === 'stale', '旧结果必须被判过期');
  assert(svcG.renderFrame().sourceEdition === 0, '旧结果未发布，画面仍是原管线');
  release(); // 再放行新编辑
  const newState = await pNew;
  assert(newState.hotswap.status === 'published');
  assert(newState.hotswap.publishedEdition === 2);
  const frame = svcG.renderFrame();
  assert(frame.sourceEdition === 2, '实际采用最新编辑版本');
  assert(svcG.pipeline.pendingWork.inFlight === 0);
});

test('场景切换期间编译完成：不影响另一材质，完成后版本正确采用', async () => {
  const { svcG, queue, release } = makeGatedService();
  await svcG.ready;
  const ids = [...svcG.materials.keys()];
  const other = createMaterialRecord({ name: '热换期间切换目标' });
  svcG.registerMaterial(other);

  const p = svcG.applyShaderEdit({ materialId: ids[0], source: tintedShader(0.5) });
  // 编译进行中切换到别的材质（场景切换）
  svcG.selectMaterial(other.id);
  assert(svcG.currentMaterialId === other.id);
  assert(queue.length === 1, '热换链接仍在进行');
  release();
  const st = await p;
  assert(st.hotswap.status === 'published', '编译完成后仍发布到原材质');
  assert(st.materialId === ids[0]);
  // 原材质切回时采用的就是热换版本，无需重编
  await svcG.selectMaterial(ids[0]);
  const frame = svcG.renderFrame();
  assert(frame.materialId === ids[0]);
  assert(frame.sourceEdition === 1);
  assert(svcG.lastCompileResult?.fromCache === true, '切回命中已发布变体缓存');
});

test('旧源码更新只失效相关条目；其他材质的静态变体缓存继续有效', async () => {
  const local = await PreviewSceneService.create({ width: 48, height: 48 });
  const ids = [...local.materials.keys()];
  await local.selectMaterial(ids[1]);
  await local.selectMaterial(ids[0]);
  const cacheBefore = local.pipeline.stats.cachedVariants;
  assert(cacheBefore >= 2, '预置材质应已有多条静态变体缓存');

  await local.applyShaderEdit({ source: tintedShader(0.2) });
  await local.applyShaderEdit({ source: tintedShader(0.4) }); // 同 sourceId 再更新
  const snap = local.pipeline.snapshot();
  // 模板变体（其他材质在用）仍然保留在缓存
  const templateLeft = snap.variants.filter((v) => v.sourceId === TEMPLATE_SOURCE_ID).length;
  assert(templateLeft >= 1, '不相关源码的静态变体缓存不得失效');
  // 同一自定义 sourceId 同时只有最新一条在缓存
  const customSourceId = local.getMaterial(local.currentMaterialId).sourceId;
  const custom = snap.variants.filter((v) => v.sourceId === customSourceId && !v.isFallback);
  assert(custom.length === 1, '旧自定义条目被失效，只留最新');
  assert(custom[0].sourceEdition === 2);
});

test('仍被 GPU 使用的旧管线延迟回收，切换后真正释放', async () => {
  const local = await PreviewSceneService.create({ width: 48, height: 48 });
  await local.applyShaderEdit({ source: tintedShader(0.1) });
  const firstKey = local.activeVariant.key;
  // 第二次热换：第一次的管线在 #adoptVariant 前仍是在用管线
  await local.applyShaderEdit({ source: tintedShader(0.7) });
  const secondKey = local.activeVariant.key;
  assert(secondKey !== firstKey);
  // 切换发生在新绑定组准备好之后；旧管线此刻已无材质引用，应已释放
  assert(local.pipeline.retired.has(firstKey) === false, '无引用旧管线应立即回收');
  assert(local.pipeline.stats.retiredVariants === 0);

  // 手工构造"仍被引用"场景：失效时把旧 key 声明为活跃 -> 进入 retired
  const oldVariant = local.pipeline.cache.get(secondKey);
  local.pipeline.cache.set(secondKey, oldVariant);
  local.pipeline.invalidateSource(oldVariant.sourceId, [secondKey]);
  assert(local.pipeline.retired.has(secondKey), '仍引用的旧管线必须延迟回收而不是释放');
  const released = local.pipeline.releaseRetired([]); // 无任何活跃引用
  assert(released.includes(secondKey) && !local.pipeline.retired.has(secondKey));
});

test('失败后再次提交修正版本可恢复发布，失败诊断被成功结果清退', async () => {
  const local = await PreviewSceneService.create({ width: 48, height: 48 });
  const bad = `#version 300 es
precision highp float;
out vec4 fragColor;
void main(){ fragColor = vec4(noSuchThing, 1.0); }
`;
  const fail = await local.applyShaderEdit({ source: bad });
  assert(fail.hotswap.status === 'failed');
  assert(local.pipeline.stats.failedVariants >= 1);
  const ok = await local.applyShaderEdit({ source: tintedShader(0.9) });
  assert(ok.hotswap.status === 'published');
  assert(local.renderFrame().sourceEdition === 2);
  const snap = local.pipeline.snapshot();
  assert(snap.failures.filter((f) => f.sourceId === local.getMaterial(local.currentMaterialId).sourceId).length === 0,
    '同源码旧失败条目应被成功结果清退');
});

test('回退到模板着色器走真实重编译，不依赖重启且帧恢复模板身份', async () => {
  const local = await PreviewSceneService.create({ width: 48, height: 48 });
  const templateFrame = local.renderFrame();
  await local.applyShaderEdit({ source: tintedShader(0.6) });
  assert(local.renderFrame().sourceId !== TEMPLATE_SOURCE_ID);
  const st = await local.resetShader();
  assert(st.hotswap.status === 'published');
  const frame = local.renderFrame();
  assert(frame.sourceId === TEMPLATE_SOURCE_ID, '帧头恢复模板源码身份');
  assert(frame.variantKey === templateFrame.variantKey, '回退后命中原模板变体');
});

test('热换状态可比较候选与已发布，保存成功不谎报画面已更新', async () => {
  const local = await PreviewSceneService.create({ width: 48, height: 48 });
  const initial = local.getShaderState();
  assert(initial.draft.differsFromPublished === false);
  local.saveShaderDraft(tintedShader(0.3));
  const drafting = local.getShaderState();
  assert(drafting.draft.differsFromPublished === true);
  assert(drafting.viewportInSync === false, '仅保存草稿时画面未更新');
  const applied = await local.applyShaderEdit({});
  assert(applied.viewportInSync === true, '编译发布后画面才与草稿一致');
  assert(applied.published.edition === 1);
});

await import('./harness.js').then((h) => h.summary());
