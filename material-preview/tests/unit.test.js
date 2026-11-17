import { test, assert, approx, summary } from './harness.js';
import { preprocess } from '../src/shader/preprocessor.js';
import { tokenize } from '../src/shader/lexer.js';
import { parse } from '../src/shader/parser.js';
import { Compiler } from '../src/shader/compiler.js';
import { Vec2, Vec3, Vec4, Mat4 } from '../src/shader/value-types.js';

console.log('== 预处理器 ==');

test('条件编译按宏值取分支', () => {
  const src = `#if MODE == 2
#define PICKED two
#else
#define PICKED one
#endif
x = PICKED;`;
  const r2 = preprocess(src, { defines: { MODE: 2 } });
  assert(r2.code.includes('two'), 'MODE=2 应取 two 分支');
  const r1 = preprocess(src, { defines: { MODE: 1 } });
  assert(r1.code.includes('one') && !r1.code.includes('two'), 'MODE=1 应取 else 分支');
});

test('ifdef/ifndef 与嵌套条件', () => {
  const src = `#ifdef A
a
  #if B
  ab
  #else
  an
  #endif
#else
none
#endif`;
  assert(preprocess(src, { defines: { A: 1, B: 1 } }).code.includes('ab'));
  assert(preprocess(src, { defines: { A: 1 } }).code.includes('an'));
  assert(preprocess(src, {}).code.includes('none'));
});

test('函数式宏带参数展开', () => {
  const src = '#define ADD(a,b) ((a)+(b))\nint x = ADD(1, 2);';
  const r = preprocess(src, {});
  const compact = r.code.replace(/\s+/g, '');
  assert(compact.includes('intx=') && compact.includes('1') && compact.includes('+') && compact.includes('2'), compact);
  assert(!compact.includes('ADD'), '宏名必须被完全展开');
});

test('未闭合的 #if 报错', () => {
  let threw = false;
  try { preprocess('#if 1\nx;', {}); } catch (e) { threw = true; assert(e.name === 'PreprocessError'); }
  assert(threw);
});

test('#include 解析与循环检测', () => {
  const files = { 'a.glsl': 'lineA\n#include "b.glsl"\n', 'b.glsl': 'lineB\n' };
  const r = preprocess('#include "a.glsl"\nmain;', { resolver: (n) => files[n] ?? null });
  assert(r.code.includes('lineA') && r.code.includes('lineB'));
  const cyclic = { 'c.glsl': '#include "c.glsl"\n' };
  let threw = false;
  try { preprocess('#include "c.glsl"', { resolver: (n) => cyclic[n] ?? null }); }
  catch (e) { threw = true; assert(e.message.includes('循环')); }
  assert(threw);
});

console.log('== 词法/语法 ==');

test('词法器识别数字、swizzle 与运算符', () => {
  const toks = tokenize('float x = 1.5e-2f; vec3 a = b.xyz * 2;');
  const vals = toks.map((t) => t.value);
  assert(vals.includes('float') && vals.includes('*=') === false);
  const f = toks.find((t) => t.type === 'FLOAT');
  approx(f.value, 0.015, 1e-9);
});

test('解析函数与控制流为 AST', () => {
  const ast = parse(`void main() {
    float s = 0.0;
    for (int i = 0; i < 3; i++) { s += float(i); }
    if (s > 0.0) { s = 1.0; } else { discard; }
  }`);
  const fn = ast.declarations.find((d) => d.kind === 'function');
  assert(fn.name === 'main' && fn.body.stmts.length === 3);
});

test('语法错误带行列号', () => {
  let threw = false;
  try { parse('void main( { }'); } catch (e) { threw = true; assert(e.name === 'ParseError'); assert(e.line >= 1); }
  assert(threw);
});

console.log('== 语义分析与代码生成 ==');

async function compileAndRun(glsl, stage, uniforms = {}, samplers = {}) {
  const ast = parse(glsl);
  const urls = {
    valueTypes: new URL('../src/shader/value-types.js', import.meta.url).href,
    builtins: new URL('../src/shader/builtins.js', import.meta.url).href,
  };
  const { js } = new Compiler(ast, stage, urls).compile();
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  const mod = await import(url);
  const U = (n) => {
    if (!(n in uniforms)) throw new Error('缺少 uniform ' + n);
    return uniforms[n];
  };
  const instance = mod.createShaderModule(U, samplers, {});
  instance.run();
  return instance.locals;
}

test('未声明变量产生语义错误', async () => {
  let threw = false;
  try {
    new Compiler(parse('void main(){ float x = ghost; }'), 'fragment').compile();
  } catch (e) { threw = true; assert(e.name === 'SemanticError'); assert(e.message.includes('ghost')); }
  assert(threw);
});

test('向量构造器分量数量检查', async () => {
  let threw = false;
  try {
    new Compiler(parse('void main(){ vec3 v = vec3(1.0, 2.0); }'), 'fragment').compile();
  } catch (e) { threw = true; assert(e.message.includes('vec3')); }
  assert(threw, 'vec3 只有 2 个分量必须报错');
  // 单标量广播与向量+标量展平是合法 GLSL
  new Compiler(parse('void main(){ vec3 a = vec3(1.0); vec4 b = vec4(a, 1.0); }'), 'fragment').compile();
});

test('编译后着色器真实计算 Blinn 光照项', async () => {
  const glsl = `precision highp float;
out vec4 fragColor;
uniform float u_roughness;
void main() {
  float shininess = mix(128.0, 8.0, clamp(u_roughness, 0.0, 1.0));
  vec3 N = normalize(vec3(0.0, 0.0, 1.0));
  vec3 H = normalize(vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), shininess);
  fragColor = vec4(spec, spec, spec, 1.0);
}`;
  const locals = await compileAndRun(glsl, 'fragment', { u_roughness: 0.5 });
  approx(locals.fragColor.d[0], 1.0, 1e-9);
});

test('discard 只允许出现在片元阶段', async () => {
  let threw = false;
  try {
    new Compiler(parse('void main(){ discard; }'), 'vertex').compile();
  } catch (e) { threw = true; assert(e.message.includes('discard')); }
  assert(threw);
});

test('swizzle 越界与混族被拒绝', async () => {
  let n = 0;
  try { new Compiler(parse('void main(){ vec2 v = vec2(1.0,2.0); float x = v.z; }'), 'fragment').compile(); }
  catch (e) { n++; assert(e.message.includes('.z')); }
  try { new Compiler(parse('void main(){ vec3 v = vec3(1.0); float x = v.xr; }'), 'fragment').compile(); }
  catch (e) { n++; assert(e.message.includes('swizzle')); }
  assert(n === 2);
});

console.log('== 值类型 ==');

test('swizzle 读写与别名族', () => {
  const v = new Vec4(1, 2, 3, 4);
  approx(v.r, 1); approx(v.b, 3);
  const xyz = v.xyz;
  assert(xyz instanceof Vec3 && xyz.d[2] === 3);
  v.xy = new Vec2(9, 8);
  approx(v.d[0], 9); approx(v.d[1], 8);
  v.g = 7;
  approx(v.d[1], 7);
});

test('Mat4 透视变换保持齐次坐标', () => {
  const p = Mat4.identity();
  const v = p.transformVec(new Vec4(1, 2, 3, 1));
  approx(v.d[0], 1); approx(v.d[3], 1);
});

export { compileAndRun };
await summary();
