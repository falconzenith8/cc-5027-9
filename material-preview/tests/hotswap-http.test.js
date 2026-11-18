// HTTP 层端到端：图形界面按钮调用的真实接口（/api/shader/* 与帧流送）。
// 验证界面不靠固定数据：着色结果帧头携带实际采用的源码身份与编辑版本，
// 编译状态来自后端真实编译/绑定检查。
import { test, assert } from './harness.js';
import { PreviewServer } from '../src/server/http-server.js';

let base;
const server = new PreviewServer({ port: 0, width: 48, height: 48 });
// 启动也放进串行链，避免顶层 await 与 harness 的用例链竞态
test('启动临时预览服务', async () => {
  const addr = await server.start();
  base = `http://localhost:${addr.port}`;
  assert(typeof addr.port === 'number');
});

const post = async (route, body) => {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const ct = res.headers.get('content-type') ?? '';
  return {
    status: res.status,
    headers: res.headers,
    json: ct.includes('application/json') ? await res.json() : null,
    res,
  };
};
const get = async (route) => (await fetch(base + route)).json();

console.log('== 图形入口热换接口（端到端 HTTP）==');

test('保存草稿接口只更新文本，帧头版本不变', async () => {
  const before = await post('/api/render', {});
  const beforeEdition = before.headers.get('x-source-edition');
  const draft = await post('/api/shader/draft', { source: '// draft only\n' });
  assert(draft.json.draft.differsFromPublished === true);
  assert(draft.json.viewportInSync === false);
  const after = await post('/api/render', {});
  assert(after.headers.get('x-source-edition') === beforeEdition, '保存草稿不得改变画面采用版本');
});

test('编译热换接口成功后帧头切换到新源码身份与编辑版本', async () => {
  const shader = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform float u_tint;
void main(){ fragColor = vec4(v_uv, 0.4 + u_tint, 1.0); }
`;
  const r = await post('/api/shader/apply', { source: shader });
  assert(r.status === 200);
  assert(r.json.hotswap.status === 'published');
  assert(r.json.viewportInSync === true);
  const frame = await post('/api/render', {});
  assert(frame.headers.get('x-source-edition') === '1', '帧头必须反映实际采用版本');
  assert(frame.headers.get('x-source-id').startsWith('custom:'), '帧头携带自定义源码身份');
  assert(frame.headers.get('x-fallback') === '0');
});

test('编译失败接口返回具体诊断，帧仍采用先前可运行版本', async () => {
  const goodEdition = (await post('/api/render', {})).headers.get('x-source-edition');
  const broken = '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main(){ fragColor=vec4(ghost,1.0); }\n';
  const r = await post('/api/shader/apply', { source: broken });
  assert(r.json.hotswap.status === 'failed');
  assert(r.json.hotswap.diagnostic.phase === 'semantic');
  assert(r.json.hotswap.diagnostic.message.includes('ghost'));
  const frame = await post('/api/render', {});
  assert(frame.headers.get('x-source-edition') === goodEdition, '失败后帧版本保持不变');
});

test('绑定布局不兼容（未知采样器）在切换前被拒绝', async () => {
  const bad = '#version 300 es\nprecision highp float;\nuniform sampler2D u_shadowMap;\nout vec4 fragColor;\nvoid main(){ fragColor=texture(u_shadowMap,vec2(0.0)); }\n';
  const r = await post('/api/shader/apply', { source: bad });
  assert(r.json.hotswap.status === 'failed');
  assert(r.json.hotswap.diagnostic.phase === 'layout');
});

test('回退接口恢复模板源码，管线快照含热换统计且无延迟回收残留', async () => {
  const r = await post('/api/shader/reset', {});
  assert(r.json.hotswap.status === 'published');
  assert(r.json.sourceId === 'template:fragment');
  const frame = await post('/api/render', {});
  assert(frame.headers.get('x-source-id') === 'template:fragment');
  const snap = await get('/api/pipeline');
  assert(typeof snap.stats.retiredVariants === 'number');
  assert(typeof snap.stats.inFlightCompiles === 'number');
  assert(snap.stats.retiredVariants === 0, '回退后无延迟回收残留');
});

test('状态接口暴露候选与已发布的可比较状态', async () => {
  const s = await get('/api/shader');
  assert('draft' in s && 'published' in s && 'hotswap' in s);
  assert(typeof s.published.edition === 'number');
  assert(typeof s.viewportInSync === 'boolean');
});

test('关闭临时预览服务', () => server.stop());

await import('./harness.js').then((h) => h.summary());
