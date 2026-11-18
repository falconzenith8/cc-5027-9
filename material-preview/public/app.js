// 材质预览图形界面逻辑。所有画面来自后端真实编译+光栅化的 PNG 流，
// 界面只负责发起编译/渲染、展示变体身份与诊断，不做任何假渲染。

const $ = (id) => document.getElementById(id);
const api = async (route, body) => {
  const res = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : res;
};
const get = async (route) => (await fetch(route)).json();

let state = null;
let autoRotate = false;
let rotateTimer = null;
let busy = false;

const faultExample = `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  // 未声明符号 + 类型错误，用于验证编译诊断
  fragColor = vec4(undefinedSymbol, v_uv, 1.0, 1.0);
}
`;
$('faultSource').value = faultExample;

function setGlobal(kind, text) {
  const dot = $('globalDot');
  dot.className = 'dot ' + (kind ?? '');
  $('globalText').textContent = text;
}

function logEvent(html, cls = '') {
  const box = $('eventLog');
  const line = document.createElement('div');
  line.className = 'event-line ' + cls;
  line.innerHTML = html;
  box.prepend(line);
  while (box.children.length > 40) box.lastChild.remove();
}

function renderMaterialList() {
  const box = $('materialList');
  box.innerHTML = '';
  for (const m of state.currentMaterial ? [state.currentMaterial] : []) void m;
  get('/api/materials').then((materials) => {
    box.innerHTML = '';
    for (const m of materials) {
      const el = document.createElement('div');
      el.className = 'material-item' + (m.id === state.currentMaterial.id ? ' active' : '');
      el.innerHTML = `<div class="mname">${m.name}</div>
        <div class="mstruct">N:${m.struct.NORMAL_MAP} B:${m.struct.BLEND_MODE} L:${m.struct.LIGHTING} · ${m.textureKind}</div>`;
      el.onclick = () => selectMaterial(m.id);
      box.appendChild(el);
    }
  });
}

function renderStructControls() {
  const box = $('structControls');
  box.innerHTML = '';
  const schema = state.structSchema;
  const cur = state.currentMaterial.struct;
  for (const [field, spec] of Object.entries(schema)) {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const v of spec.values) {
      const btn = document.createElement('button');
      btn.className = cur[field] === v ? 'on' : '';
      btn.textContent = spec.labels?.[v] ?? String(v);
      btn.onclick = async () => {
        if (busy) return;
        busy = true; setGlobal('busy', `编译变体：${spec.label}=${v}`);
        try {
          state = await api('/api/struct', { field, value: v });
          logEvent(`结构变更 <b>${field}=${v}</b> → 申请新变体`, 'compiled');
          await refreshAll(true);
        } catch (e) {
          logEvent(`结构变更被拒绝：<b>${e.message}</b>`, 'failed');
          setGlobal('err', e.message);
        } finally { busy = false; }
      };
      seg.appendChild(btn);
    }
    wrap.innerHTML = `<label>${spec.label} <span class="tag danger">编译期</span></label>`;
    wrap.appendChild(seg);
    box.appendChild(wrap);
  }
}

function renderNumericControls() {
  const box = $('numericControls');
  box.innerHTML = '';
  const schema = state.numericSchema;
  const params = state.currentMaterial.params;
  for (const [name, spec] of Object.entries(schema)) {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    if (spec.kind === 'color') {
      const rgba = params[name];
      const hex = '#' + rgba.slice(0, 3).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
      wrap.innerHTML = `<label>${spec.label} <b>${rgba.map((c) => c.toFixed(2)).join(', ')}</b></label>`;
      const input = document.createElement('input');
      input.type = 'color'; input.value = hex;
      input.oninput = async () => {
        const rgb = [0, 2, 4].map((o) => parseInt(input.value.slice(1 + o, 3 + o), 16) / 255);
        state = await api('/api/param', { name, value: [...rgb, rgba[3]] });
        renderNumericControls();
        scheduleFrame();
      };
      wrap.appendChild(input);
    } else {
      wrap.innerHTML = `<label>${spec.label} <b>${Number(params[name]).toFixed(3)}</b>
        <span class="tag ok">uniform</span></label>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = spec.min; input.max = spec.max; input.step = (spec.max - spec.min) / 200;
      input.value = params[name];
      input.oninput = async () => {
        state = await api('/api/param', { name, value: Number(input.value) });
        wrap.querySelector('b').textContent = Number(input.value).toFixed(3);
        scheduleFrame();
      };
      wrap.appendChild(input);
    }
    box.appendChild(wrap);
  }
}

function renderTextureAndMesh() {
  const tbox = $('textureControls');
  tbox.innerHTML = '';
  for (const kind of state.textures) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (state.currentMaterial.textureKind === kind ? ' primary' : '');
    btn.textContent = kind;
    btn.onclick = async () => { state = await api('/api/texture', { kind }); await refreshAll(false); };
    tbox.appendChild(btn);
  }
  const mbox = $('meshControls');
  mbox.innerHTML = '';
  for (const name of state.meshes) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = name;
    btn.onclick = () => requestFrame(name);
    mbox.appendChild(btn);
  }
}

function renderCompileCard() {
  const lc = state.lastCompile;
  const av = state.activeVariant;
  const statusEl = $('compileStatus');
  if (state.pending) {
    statusEl.innerHTML = '<span class="status-pill busy">等待编译</span>';
    $('pendingState').textContent = JSON.stringify(state.pending.struct);
  } else if (av?.isFallback || lc?.status === 'fallback') {
    statusEl.innerHTML = '<span class="status-pill fallback">替代材质</span>';
    $('pendingState').textContent = '无（上次编译失败）';
  } else {
    statusEl.innerHTML = '<span class="status-pill ok">变体生效中</span>';
    $('pendingState').textContent = '无';
  }
  $('compileSource').textContent = lc ? (lc.fromCache ? '缓存命中（未重编译）' : '新编译') : '—';
  $('compileMs').textContent = lc?.compileMs != null ? `${lc.compileMs.toFixed(2)} ms` : '—';
  $('variantKey').textContent = av?.key ?? '—';
  $('cacheCount').textContent = `（${state.pipeline.cachedVariants} 个成功 / ${state.pipeline.failedVariants} 个失败）`;
  $('fallbackBanner').classList.toggle('hidden', !(av?.isFallback || lc?.status === 'fallback'));
  setGlobal(av?.isFallback ? 'err' : 'ok', av?.isFallback ? '替代材质生效中（见诊断）' : '管线变体正常');
}

async function renderVariantList() {
  const snap = await get('/api/pipeline');
  const box = $('variantList');
  box.innerHTML = '';
  for (const v of snap.variants) {
    const el = document.createElement('div');
    el.className = 'variant' + (v.isFallback ? ' fallback' : '');
    el.innerHTML = `<div class="vk">${v.key}</div>
      <div class="vs">${v.isFallback ? '替代材质' : 'N=' + v.struct?.NORMAL_MAP + ' B=' + v.struct?.BLEND_MODE + ' L=' + v.struct?.LIGHTING}
      · ${v.compileMs?.toFixed?.(1) ?? '?'}ms · ${v.uniformLayout.length} uniforms</div>`;
    box.appendChild(el);
  }
  for (const f of snap.failures) {
    const el = document.createElement('div');
    el.className = 'variant fallback';
    el.innerHTML = `<div class="vk">${f.key}</div>
      <div class="vs">失败：[${f.diagnostic.phase}] ${f.diagnostic.message}</div>`;
    box.appendChild(el);
  }
}

let frameQueued = false;
function scheduleFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; requestFrame(); });
}

async function requestFrame(mesh) {
  const size = Number($('resolutionSelect').value);
  try {
    const res = await api('/api/render', { width: size, height: size, mesh });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = $('viewport');
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    $('frameMeta').textContent =
      `#${res.headers.get('x-frame-seq')} · ${res.headers.get('x-render-ms')}ms · `
      + `${res.headers.get('x-source-id')}@e${res.headers.get('x-source-edition')} · `
      + (res.headers.get('x-fallback') === '1' ? '替代材质帧' : '真实变体裁剪帧');
  } catch (e) {
    setGlobal('err', '渲染失败: ' + e.message);
    logEvent(`渲染异常：<b>${e.message}</b>`, 'failed');
  }
}

// ---- 着色器源码热换（运行中替换）----
function renderShaderPanel(shader) {
  if (!shader) return;
  $('shaderDraft').value = shader.draft.source;
  $('shaderPublished').value = shader.published.source;
  $('publishedEdition').textContent = `版本 ${shader.published.edition}`;
  $('draftFlag').textContent = shader.draft.differsFromPublished ? '草稿未发布' : '与已发布一致';
  $('draftFlag').className = 'tag ' + (shader.draft.differsFromPublished ? 'danger' : 'ok');

  const pill = $('hotswapPill');
  const meta = $('hotswapMeta');
  const hs = shader.hotswap;
  if (!hs) { pill.className = 'status-pill'; pill.textContent = '—'; meta.textContent = '未提交'; return; }
  const map = {
    compiling: ['compiling', '编译中…'],
    published: ['published', '已发布并生效'],
    failed: ['failed', '编译失败（保留旧版本）'],
    stale: ['stale', '旧结果已过期丢弃'],
  };
  const [cls, label] = map[hs.status] ?? ['', hs.status];
  pill.className = 'status-pill ' + cls;
  pill.textContent = label;
  meta.textContent = `提交版本 ${hs.submittedEdition} / 已发布 ${hs.publishedEdition}`
    + (hs.reason ? ` · ${hs.reason}` : '');

  const box = $('hotswapResult');
  if (hs.status === 'published') {
    box.classList.remove('hidden', 'fail'); box.classList.add('ok');
    const d = hs.layoutDiff;
    const lines = [`已发布编辑版本 ${hs.submittedEdition}，流送视窗已更新为该着色结果。`];
    if (d) {
      const fmt = (arr) => arr.map((u) => (u.name ? `${u.name}:${u.type}` : u)).join(', ') || '无';
      lines.push(`新增 uniform: ${fmt(d.uniformsAdded)}`);
      lines.push(`移除 uniform: ${fmt(d.uniformsRemoved)}`);
      lines.push(`新增采样器: ${d.samplersAdded.join(', ') || '无'}`);
      lines.push(`移除采样器: ${d.samplersRemoved.join(', ') || '无'}`);
    }
    box.textContent = lines.join('\n');
  } else if (hs.status === 'failed' && hs.diagnostic) {
    box.classList.remove('hidden', 'ok'); box.classList.add('fail');
    box.textContent = `阶段: ${hs.diagnostic.stage}/${hs.diagnostic.phase}\n`
      + `行: ${hs.diagnostic.sourceLine ?? '?'}\n诊断: ${hs.diagnostic.message}\n`
      + '当前画面仍为先前可运行版本，新效果未生效。';
  } else if (hs.status === 'stale') {
    box.classList.remove('hidden', 'ok', 'fail');
    box.textContent = `编辑版本 ${hs.submittedEdition} 返回时已过期，结果被丢弃，未覆盖更新的代码。`;
  } else {
    box.classList.add('hidden');
  }
}

$('saveDraftBtn').onclick = async () => {
  try {
    const shader = await api('/api/shader/draft', { source: $('shaderDraft').value });
    state.shader = shader;
    renderShaderPanel(shader);
    logEvent('着色器草稿已保存（<b>未编译，画面不变</b>）', 'cache-hit');
  } catch (e) {
    logEvent(`保存草稿失败：<b>${e.message}</b>`, 'failed');
  }
};

$('applyShaderBtn').onclick = async () => {
  if (busy) return;
  busy = true; setGlobal('busy', '编译候选着色器并检查资源布局…');
  try {
    const shader = await api('/api/shader/apply', { source: $('shaderDraft').value });
    state.shader = shader;
    renderShaderPanel(shader);
    if (shader.hotswap.status === 'published') {
      logEvent(`着色器热换发布 <b>版本 ${shader.hotswap.submittedEdition}</b>，视窗更新`, 'compiled');
    } else if (shader.hotswap.status === 'failed') {
      logEvent(`热换失败：<b>${shader.hotswap.diagnostic?.message ?? shader.hotswap.reason}</b>，旧版本保留`, 'failed');
    } else {
      logEvent(`热换结果：<b>${shader.hotswap.status}</b>`, 'failed');
    }
    await refreshAll(true); // 真实重新出帧：画面与编译状态来自后端实际运算
  } catch (e) {
    logEvent(`热换请求异常：<b>${e.message}</b>`, 'failed');
    setGlobal('err', e.message);
  } finally { busy = false; }
};

$('resetShaderBtn').onclick = async () => {
  if (busy) return;
  busy = true; setGlobal('busy', '回退模板着色器（真实重编译）…');
  try {
    const shader = await api('/api/shader/reset', {});
    state.shader = shader;
    renderShaderPanel(shader);
    logEvent('已回退到模板着色器', 'cache-hit');
    await refreshAll(true);
  } catch (e) {
    logEvent(`回退失败：<b>${e.message}</b>`, 'failed');
  } finally { busy = false; }
};

// 切换材质后重新载入该材质的候选/已发布源码
function refreshShaderPanel() {
  get('/api/shader').then((shader) => { state.shader = shader; renderShaderPanel(shader); });
}

async function selectMaterial(id) {
  if (busy) return;
  busy = true; setGlobal('busy', '切换材质并申请变体…');
  try {
    state = await api('/api/materials/select', { materialId: id });
    logEvent(`切换材质 <b>${id}</b>：${state.lastCompile.fromCache ? '缓存命中' : '新编译'}`,
      state.lastCompile.fromCache ? 'cache-hit' : 'compiled');
    await refreshAll(true);
  } catch (e) {
    logEvent(`切换失败：<b>${e.message}</b>`, 'failed');
    setGlobal('err', e.message);
  } finally { busy = false; }
}

async function refreshAll(render) {
  renderMaterialList();
  renderStructControls();
  renderNumericControls();
  renderTextureAndMesh();
  renderCompileCard();
  renderVariantList();
  refreshShaderPanel();
  if (render) await requestFrame();
}

// ---- 全局按钮 ----
$('renderBtn').onclick = () => requestFrame();
$('newMaterialBtn').onclick = async () => {
  const created = await api('/api/materials', {
    name: `材质 ${Date.now() % 10000}`,
    struct: state.currentMaterial.struct,
    textureKind: state.currentMaterial.textureKind,
  });
  await selectMaterial(created.id);
};
$('prewarmBtn').onclick = async () => {
  const report = await api('/api/prewarm', { maxVariants: 4, timeBudgetMs: 1500 });
  const el = $('prewarmReport');
  el.classList.remove('hidden');
  el.textContent = JSON.stringify(report, null, 2);
  logEvent(`预热完成：新编译 <b>${report.compiled}</b>，命中 ${report.cached}，跳过 ${report.skipped}`, 'compiled');
  renderVariantList();
};
$('prewarmCancelBtn').onclick = async () => {
  await api('/api/prewarm/cancel', {});
  logEvent('已请求取消预热', 'failed');
};
$('benchBtn').onclick = async () => {
  const report = await api('/api/benchmark', {});
  const el = $('prewarmReport');
  el.classList.remove('hidden');
  el.textContent = JSON.stringify(report, null, 2);
  logEvent(`基准：首次卡顿 <b>${report.firstSwitchJankMs}ms</b>，新变体 ${report.newVariants}，缓存命中 ${report.cacheHits}`, 'compiled');
  await refreshAll(true);
};
$('reuseBtn').onclick = async () => {
  const r = await api('/api/verify-reuse', {});
  const el = $('prewarmReport');
  el.classList.remove('hidden');
  el.textContent = JSON.stringify(r, null, 2);
  logEvent(`复用验证：第二次申请缓存命中=<b>${r.reused}</b>，像素一致=${r.identicalPixels}`,
    r.reused ? 'cache-hit' : 'failed');
};
$('faultBtn').onclick = async () => {
  try {
    const r = await api('/api/fault-injection', { source: $('faultSource').value });
    const el = $('faultResult');
    el.classList.remove('hidden');
    el.textContent = `状态: ${r.status}\n阶段: ${r.diagnostic?.stage}/${r.diagnostic?.phase}\n行: ${r.diagnostic?.sourceLine ?? '?'}\n诊断: ${r.diagnostic?.message ?? r.reason}`;
    logEvent(`故障注入：<b>${r.status}</b> — ${r.diagnostic?.message}`, 'failed');
  } catch (e) {
    logEvent(`故障演练请求异常：${e.message}`, 'failed');
  }
  await refreshAll(true);
};
$('autoRotateBtn').onclick = () => {
  autoRotate = !autoRotate;
  $('autoRotateBtn').textContent = '自动旋转：' + (autoRotate ? '开' : '关');
  if (rotateTimer) clearInterval(rotateTimer);
  if (autoRotate) {
    rotateTimer = setInterval(async () => {
      const yaw = (Number($('yaw').value) + 0.12) % (Math.PI * 2);
      $('yaw').value = yaw;
      await api('/api/camera', { yaw, pitch: Number($('pitch').value) });
      await requestFrame();
    }, 400);
  }
};
$('yaw').oninput = async (e) => {
  await api('/api/camera', { yaw: Number(e.target.value), pitch: Number($('pitch').value) });
  scheduleFrame();
};
$('pitch').oninput = async (e) => {
  await api('/api/camera', { pitch: Number(e.target.value), yaw: Number($('yaw').value) });
  scheduleFrame();
};
$('resolutionSelect').onchange = () => requestFrame();

// SSE：编译/帧/预热事件实时推送
try {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'compile') logEvent(`编译事件：<b>${data.result?.status}</b> 缓存=${data.result?.fromCache}`, 'compiled');
    if (data.type === 'prewarm') logEvent(`预热事件：编译 ${data.report?.compiled} / 跳过 ${data.report?.skipped}`, 'cache-hit');
    if (data.type === 'fault') logEvent(`SSE 故障事件：<b>${data.reason}</b>`, 'failed');
    if (data.type === 'hotswap') {
      const s = data.state;
      if (s?.status === 'published') logEvent(`SSE 热换发布：版本 <b>${s.publishedEdition}</b> 已生效`, 'compiled');
      else if (s?.status === 'failed') logEvent(`SSE 热换失败：<b>${s.reason}</b>，旧版本保留`, 'failed');
    }
  };
} catch { /* 无 SSE 时界面仍可手动操作 */ }

// 启动
get('/api/state').then(async (s) => {
  state = s;
  $('yaw').value = 0.7; $('pitch').value = 0.35;
  await refreshAll(true);
}).catch((e) => setGlobal('err', '初始化失败: ' + e.message));
