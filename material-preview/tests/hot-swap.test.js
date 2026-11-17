// 运行中着色器热换与回退的端到端用例。
// 覆盖：语法错误、绑定字段改变、快速连续修改、场景切换期间编译完成、
// 实际采用版本核对、资源释放、静态变体缓存继续有效、编辑器保存 ≠ 画面更新。
import { test, assert } from './harness.js';
import { PreviewSceneService } from '../src/core/preview-scene.js';
import { HotSwapService } from '../src/core/hot-swap.js';
import { FRAGMENT_SHADER } from '../src/shader/material-templates.js';

function shader(body, opts = {}) {
  return `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_tangent;
uniform vec4 u_baseColor;
uniform float u_roughness;
uniform sampler2D u_baseColorTex;
uniform sampler2D u_occlusionTex;
${opts.extraUniforms ? opts.extraUniforms + '\n' : ''}out vec4 fragColor;
void main() {
  vec4 c = texture(u_baseColorTex, v_uv) * u_baseColor;
  ${body}
  fragColor = vec4(c.rgb, 1.0);
}`;
}

const GREEN = shader('c.rgb = c.rgb * 0.4 + vec3(0.0, 0.5, 0.1);');
const BLUE = shader('c.rgb = c.rgb * 0.4 + vec3(0.0, 0.1, 0.6);');

console.log('== 热换核心生命周期 ==');

test('候选编译成功后切换所有受影响实例并改变画面', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  const before = svc.renderFrame();
  const result = await svc.hotSwapShader(GREEN);
  assert(result.adopted === true, '合法候选必须被采用');
  assert(result.affectedInstances >= 1, '至少一个材质实例受影响');
  const after = svc.renderFrame();
  assert(after.variantKey === result.variantKey, '画面必须使用实际采用的候选变体');
  assert(!after.png.equals(before.png), '热换后画面必须真实变化');
  const prog = svc.shaderProgramState();
  assert(prog.published.status === 'ok');
  assert(prog.published.matchesCurrentSource === true, '已发布版本必须与当前源码一致');
});

test('语法错误候选被拒绝：保留先前可运行版本且画面不变', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  const good = await svc.hotSwapShader(GREEN);
  assert(good.adopted);
  const frame = svc.renderFrame();
  const broken = GREEN.replace('void main() {', 'void main( {');
  const result = await svc.hotSwapShader(broken);
  assert(result.adopted === false, '语法错误不得被采用');
  assert(result.publishedKept === true, '必须保留先前可运行版本');
  assert(result.diagnostic?.phase === 'parse', `诊断阶段应为 parse，实际 ${result.diagnostic?.phase}`);
  assert(typeof result.reason === 'string' && result.reason.length > 0, '必须给出具体原因');
  const after = svc.renderFrame();
  assert(after.variantKey === frame.variantKey, '失败后画面仍运行旧变体');
  assert(after.png.equals(frame.png), '失败不得改变像素');
  const prog = svc.shaderProgramState();
  assert(prog.published.variantKey === good.variantKey, '已发布版本保持');
  assert(prog.candidate.status === 'rejected');
});

test('绑定字段改变：拒绝未知 uniform、缺采样器资源，并给出绑定诊断', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  await svc.hotSwapShader(GREEN);

  const unknownUniform = shader('c.rgb += u_notProvidedByEngine;', {
    extraUniforms: 'uniform vec3 u_notProvidedByEngine;',
  });
  const r1 = await svc.hotSwapShader(unknownUniform);
  assert(r1.adopted === false, '引擎无法提供的 uniform 必须拒绝');
  assert(r1.bindingErrors?.some((e) => e.code === 'UNKNOWN_UNIFORM'), '应给出 UNKNOWN_UNIFORM 绑定错误');

  const missingSampler = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_missingTex;
out vec4 fragColor;
void main(){ fragColor = texture(u_missingTex, v_uv); }`;
  const r2 = await svc.hotSwapShader(missingSampler);
  assert(r2.adopted === false, '缺失采样器资源必须拒绝');
  assert(r2.bindingErrors?.some((e) => e.code === 'MISSING_RESOURCE'), '应给出 MISSING_RESOURCE 绑定错误');
});

test('绑定布局改变时准备新绑定组，旧布局哈希不被复用', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  const twoSamplers = await svc.hotSwapShader(GREEN);
  assert(twoSamplers.adopted);
  const layoutA = twoSamplers.bindingLayoutHash;

  const oneSampler = `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec2 v_uv;
uniform sampler2D u_baseColorTex;
out vec4 fragColor;
void main(){ fragColor = texture(u_baseColorTex, v_uv) + vec4(0.0, 0.05, 0.15, 0.0); }`;
  const r = await svc.hotSwapShader(oneSampler);
  assert(r.adopted, '减少一个采样器仍是合法管线');
  assert(r.bindingLayoutChanged === true, '绑定布局必须被识别为改变');
  assert(r.bindingLayoutHash !== layoutA, '新布局必须产生新哈希');
  const prog = svc.shaderProgramState();
  assert(prog.published.bindingLayout.samplers.length === 1, '已发布绑定组只含新布局的采样器');
  // 画面可渲染：渲染器按新布局绑定采样器，不会把旧绑定组交给新管线
  const frame = svc.renderFrame();
  assert(frame.isFallback === false);
  assert(frame.bindingLayoutHash === r.bindingLayoutHash);
});

test('连续保存：晚返回的旧编译结果被丢弃，不覆盖新代码', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  await svc.hotSwapShader(GREEN);
  const first = svc.submitShaderCandidate(BLUE);
  const second = svc.submitShaderCandidate(GREEN.replace('void main() {', 'void main( {'));
  assert(second.revision > first.revision, '第二次提交必须获得更高修订号');
  const oldResult = await svc.runShaderCandidate(first.task);
  assert(oldResult.adopted === false && oldResult.superseded === true, '旧任务结果必须被丢弃');
  const newResult = await svc.runShaderCandidate(second.task);
  assert(newResult.revision === second.revision, '新任务照常处理（这里是语法错误）');
  assert(newResult.adopted === false, '较新的错误代码不应被采用');
  const prog = svc.shaderProgramState();
  assert(prog.published.variantKey !== null, '先前可运行版本仍在');
  assert(prog.published.matchesCurrentSource === false, '已发布版本与最新编辑器文本不同');
});

test('场景切换期间完成的编译仍按修订号判定，不误发布', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  await svc.hotSwapShader(GREEN);
  const task = svc.submitShaderCandidate(BLUE);
  // 切换材质（场景切换）后，再运行编译任务
  const otherId = [...svc.materials.keys()].find((id) => id !== svc.currentMaterialId);
  await svc.selectMaterial(otherId);
  const result = await svc.runShaderCandidate(task.task);
  // 程序仍归原材质，采用新候选是合法的；关键是修订号未被场景切换重置
  assert(result.revision === task.revision, '修订号保持');
  assert(result.adopted === true, '场景切换不应让合法候选失效');
  const prog = svc.hotSwap.getProgram(task.programId);
  assert(prog.published.revision === task.revision, '已发布修订等于本次任务修订');
  assert(prog.published.sourceHash === prog.candidate.sourceHash, '已发布源码与候选一致');
});

test('编辑器文本保存不等于画面更新', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  const before = svc.renderFrame();
  const accepted = svc.submitShaderCandidate(BLUE);
  assert(accepted.editorTextSaved === true, '文本保存成功');
  const prog = svc.shaderProgramState();
  assert(prog.published.matchesCurrentSource === false, '保存后画面尚未跟上新源码');
  const still = svc.renderFrame();
  assert(still.variantKey === before.variantKey, '未编译前画面仍是旧版本');
  assert(still.png.equals(before.png), '文本保存不得改变像素');
  // 真正编译并发布后才更新
  const result = await svc.runShaderCandidate(accepted.task);
  assert(result.adopted);
  const updated = svc.renderFrame();
  assert(updated.variantKey === result.variantKey);
  assert(svc.shaderProgramState().published.matchesCurrentSource === true);
});

test('仍被在途帧使用的旧管线延迟回收，最后一个引用释放后才删除', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  await svc.hotSwapShader(GREEN);
  const oldVariant = svc.activeVariant;
  svc.pipeline.acquireVariant(oldVariant); // 模拟在途帧
  const result = await svc.hotSwapShader(BLUE);
  assert(result.adopted);
  assert(svc.pipeline.retired.has(oldVariant.key), '旧管线应进入延迟回收表');
  assert(svc.pipeline.cache.has(oldVariant.key), '引用未释放前不得真正删除');
  const release = svc.pipeline.releaseVariant(oldVariant);
  assert(release.released === true, '最后一个引用释放后才回收');
  assert(!svc.pipeline.cache.has(oldVariant.key), '回收后旧条目移除');
  assert(svc.pipeline.retired.size === 0);
});

test('源码更新只失效相关条目，初版静态变体缓存继续有效', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  const staticKey = svc.activeVariant.key;
  assert(svc.pipeline.cache.has(staticKey), '初版静态变体在缓存中');
  await svc.hotSwapShader(GREEN);
  assert(svc.pipeline.cache.has(staticKey), '热换后初版静态变体必须仍然有效');
  await svc.hotSwapShader(BLUE);
  assert(svc.pipeline.cache.has(staticKey), '再次热换后静态变体仍未被误删');
  // 初版静态变体仍可直接命中（结构切换时不会被热换源码污染）
  const staticStruct = svc.getMaterial(svc.currentMaterialId).struct;
  const hit = await svc.pipeline.getOrCreateVariant(staticStruct, { reason: 'test' });
  assert(hit.fromCache === true, '初版静态变体必须继续命中缓存');
  assert(hit.variant.key === staticKey, '命中的就是初版静态变体');
  // 该材质已含自定义源码：结构切换会用新 defines 重编自定义源码，而不是静默退回模板
  const before = svc.pipeline.stats.cachedVariants;
  await svc.setStruct('LIGHTING', staticStruct.LIGHTING === 2 ? 0 : 2);
  const prog = svc.shaderProgramState();
  assert(prog.published.status === 'ok', '结构切换后已发布状态仍然有效');
  assert(prog.published.sourceHash === svc.hotSwap.getProgram(prog.id).candidate.sourceHash,
    '结构切换沿用自定义源码而非模板');
  assert(svc.pipeline.cache.has(staticKey), '结构切换不得删除静态缓存条目');
  void before;
});

test('自定义源码下切换结构选项产生不同变体，切回命中缓存', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  const adopted = await svc.hotSwapShader(GREEN);
  assert(adopted.adopted);
  const keys = new Set();
  for (const [i, lighting] of [2, 1, 0, 2].entries()) {
    await svc.setStruct('LIGHTING', lighting);
    const prog = svc.shaderProgramState();
    assert(prog.published.status === 'ok', `LIGHTING=${lighting} 应成功`);
    assert(prog.published.matchesCurrentSource, `LIGHTING=${lighting} 状态必须与当前宏一致`);
    if (i === 3) {
      assert(svc.lastCompileResult.fromCache === true, '切回原结构应命中热换变体缓存');
    }
    keys.add(prog.published.variantKey);
  }
  assert(keys.size === 3, `三种光照应产生 3 个不同变体，实际 ${keys.size}`);
  const frame = svc.renderFrame();
  assert(frame.isFallback === false);
});

test('回退使用已发布版本，不重新编译', async () => {
  const svc = await PreviewSceneService.create({ width: 96, height: 96 });
  const good = await svc.hotSwapShader(GREEN);
  const eventsBefore = svc.pipeline.compilerLog.length;
  const r = svc.rollbackShader();
  assert(r.rolledBack === true);
  assert(r.key === good.variantKey, '回退目标就是已发布变体');
  assert(svc.pipeline.compilerLog.length === eventsBefore, '回退不触发编译');
});

console.log('== 热换服务单元 ==');

test('候选用源码哈希与绑定布局哈希共同决定身份', async () => {
  const svc = await PreviewSceneService.create({ width: 64, height: 64 });
  const id = svc.currentMaterialId;
  const programId = svc.getMaterial(id).shaderProgramId;
  const hot = new HotSwapService(svc.pipeline, {
    getInstances: (pid) => [...svc.materials.values()].filter((m) => m.shaderProgramId === pid).map((m) => m.shaderInstance),
  });
  const program = hot.createProgram({ id: programId, fragmentSource: FRAGMENT_SHADER });
  const task = hot.submitCandidate(program.id, { fragmentSource: GREEN });
  const result = await hot.runCandidate(task);
  assert(result.adopted);
  const state = hot.describeProgram(program.id);
  assert(state.published.bindingLayoutHash && state.published.bindingLayoutHash.length === 16);
  assert(state.textDiffersFromPublished === false);
});
