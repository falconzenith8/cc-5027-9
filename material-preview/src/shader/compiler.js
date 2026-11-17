// 语义分析 + 代码生成。
// 一遍 AST 遍历同时完成：符号表构建、类型检查（未声明变量、参数数量、swizzle
// 合法性、赋值兼容性、discard 位置等）与 JS 模块代码生成。
// 任何错误都抛出带行列号的 SemanticError，编译失败不会产生可执行产物。

export class SemanticError extends Error {
  constructor(message, line, col) {
    super(`语义错误 (${line ?? '?'}:${col ?? '?'}): ${message}`);
    this.name = 'SemanticError';
    this.line = line; this.col = col;
  }
}

const VEC_TYPES = { vec2: 2, vec3: 3, vec4: 4 };
const SCALAR_TYPES = new Set(['float', 'int', 'bool']);

// 内建函数签名：参数类型用表达式描述；返回类型由 resolveBuiltin 推断
const BUILTIN_FUNCS = new Set([
  'radians', 'degrees', 'sin', 'cos', 'tan', 'pow', 'exp', 'log', 'sqrt',
  'abs', 'floor', 'ceil', 'fract', 'step', 'sign', 'min', 'max', 'mod',
  'mix', 'clamp', 'smoothstep', 'dot', 'cross', 'length', 'distance',
  'normalize', 'reflect', 'texture', 'texture2D',
]);

function isNumeric(t) { return t === 'float' || t === 'int'; }
function typeName(t) { return typeof t === 'string' ? t : `${t.name}`; }

export class Compiler {
  constructor(ast, stage, runtimeUrls) {
    this.ast = ast;
    this.stage = stage; // 'vertex' | 'fragment'
    this.runtimeUrls = runtimeUrls;
    this.structs = new Map();
    this.funcs = new Map();
    this.scopes = [new Map()];
    this.currentFn = null;
    this.fnReturnType = null;
    this.loopDepth = 0;
    this.fnIndex = 0;
    this.codeLines = [];
    this.tmpCount = 0;
    this.diagnostics = [];
    // 内建变量：gl_Position / fragColor / 顶点 in 属性按阶段预登记
    this.builtinVars = stage === 'vertex'
      ? { gl_Position: 'vec4', gl_PointSize: 'float' }
      : { gl_FragCoord: 'vec4', gl_FrontFacing: 'bool' };
  }

  tmp(prefix = 't') { return `_${prefix}${this.tmpCount++}`; }

  error(msg, node) {
    const line = node?.line ?? null;
    throw new SemanticError(msg, line, null);
  }

  pushScope() { this.scopes.push(new Map()); }
  popScope() { this.scopes.pop(); }
  declare(name, type, qualifiers = [], node) {
    const top = this.scopes[this.scopes.length - 1];
    if (top.has(name)) this.error(`变量 "${name}" 重复声明`, node);
    top.set(name, { type, qualifiers });
  }
  lookup(name, node) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    this.error(`未声明的标识符 "${name}"`, node);
  }

  // ---------- 类型推导 ----------
  // 归一化：声明类型是 {kind,name} 对象，字面量是字符串；统一转成类型名/结构体对象
  normType(t) {
    if (t === null || t === undefined) return t;
    if (typeof t === 'string') return t;
    if (t.kind === 'builtin') return t.name;
    return t; // 结构体类型对象
  }

  typeOf(node) {
    switch (node.kind) {
      case 'literal': return node.type;
      case 'ident': return this.normType(this.lookup(node.name, node).type);
      case 'member': {
        const objT = this.typeOf(node.object);
        if (typeof objT === 'object' && objT.kind === 'struct') {
          const f = this.structs.get(objT.name).fields.find((x) => x.name === node.member);
          if (!f) this.error(`结构体 ${objT.name} 没有字段 ${node.member}`, node);
          return this.normType(f.type);
        }
        if (VEC_TYPES[objT]) {
          const mask = node.member;
          if (!/^[xyzwrgba]+$/.test(mask) && !/^[stpq]+$/.test(mask)) {
            this.error(`非法 swizzle "${mask}"`, node);
          }
          if (mask.length === 1) return 'float';
          return mask.length === 2 ? 'vec2' : mask.length === 3 ? 'vec3' : 'vec4';
        }
        this.error(`类型 ${typeName(objT)} 不支持成员访问`, node);
        break;
      }
      case 'index': {
        const t = this.typeOf(node.object);
        if (VEC_TYPES[t]) return 'float';
        this.error('仅向量支持下标访问', node);
        break;
      }
      case 'binary': {
        const lt = this.typeOf(node.left);
        const rt = this.typeOf(node.right);
        if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(node.op)) return 'bool';
        if (lt === 'float' || rt === 'float' || VEC_TYPES[lt] || VEC_TYPES[rt]) {
          return VEC_TYPES[lt] ? lt : VEC_TYPES[rt] ? rt : 'float';
        }
        return lt;
      }
      case 'unary':
        return this.typeOf(node.expr);
      case 'assign':
        return this.typeOf(node.left);
      case 'ternary':
        return this.typeOf(node.cons);
      case 'constructor':
        return node.ctype;
      case 'call':
        return this.resolveCallType(node);
      default:
        this.error(`无法推导类型的节点 ${node.kind}`, node);
    }
  }

  resolveCallType(node) {
    if (node.callee.kind === 'member') {
      // 仅支持 sampler2D 上没有方法；保留扩展点
      this.error('不支持的成员函数调用', node);
    }
    const name = node.callee.name;
    if (this.funcs.has(name)) return this.normType(this.funcs.get(name).returnType);
    if (BUILTIN_FUNCS.has(name)) {
      if (name === 'texture' || name === 'texture2D') return 'vec4';
      if (name === 'dot' || name === 'length' || name === 'distance') return 'float';
      if (name === 'cross' || name === 'reflect') return 'vec3';
      if (name === 'normalize') return this.typeOf(node.args[0]);
      if (name === 'vec2' || name === 'vec3' || name === 'vec4') return name;
      // 逐分量函数（step/min/max/clamp/mix/abs...）：返回"最大"的那个参数类型
      let t = 'float';
      for (const a of node.args) {
        const at = this.typeOf(a);
        if (VEC_TYPES[at] && (!VEC_TYPES[t] || VEC_TYPES[at] > VEC_TYPES[t])) t = at;
      }
      return t;
    }
    this.error(`调用未声明的函数 "${name}"`, node);
  }

  // ---------- 编译入口 ----------
  compile() {
    // 第一遍：收集 struct 与函数签名
    for (const d of this.ast.declarations) {
      if (d.kind === 'struct') this.structs.set(d.name, d);
      if (d.kind === 'function') {
        if (this.funcs.has(d.name)) this.error(`函数 "${d.name}" 重复定义`, d);
        this.funcs.set(d.name, d);
      }
    }
    if (!this.funcs.has('main')) this.error('着色器缺少 main 函数', this.ast);
    const main = this.funcs.get('main');
    if (main.params.length !== 0 || main.returnType.name !== 'void') {
      this.error('main 必须是 void main()', main);
    }

    // 全局变量（uniform 等）登记到全局作用域；同时登记内建变量与 in/out 接口
    for (const d of this.ast.declarations) {
      if (d.kind === 'vardecl') {
        for (const v of d.decls) {
          this.declare(v.name, d.type, d.qualifiers, d);
          if (d.qualifiers.includes('in')) this.ioNames ??= [];
        }
      }
    }
    for (const [name, type] of Object.entries(this.builtinVars)) {
      this.scopes[0].set(name, { type: { kind: 'builtin', name: type }, qualifiers: ['builtin'] });
    }

    // 生成运行时代码。导入路径默认相对，链接时由调用方覆盖为绝对 file URL。
    const urls = this.runtimeUrls ?? {
      valueTypes: './value-types.js',
      builtins: './builtins.js',
    };
    const out = [];
    out.push(`import { Vec2, Vec3, Vec4, Mat4, isVec, makeVec } from ${JSON.stringify(urls.valueTypes)};`);
    out.push(`import { builtins as B, neg } from ${JSON.stringify(urls.builtins)};`);
    out.push('');
    out.push('export function createShaderModule(uniforms, samplers, io) {');
    out.push('  const locals = Object.create(null);');
    out.push('  const U = uniforms;');
    out.push('  function S(name){ return samplers[name]; }');

    for (const d of this.ast.declarations) {
      if (d.kind === 'function') out.push(this.genFunction(d));
      if (d.kind === 'vardecl' && !d.qualifiers.includes('uniform')) {
        for (const v of d.decls) {
          if (v.init) out.push(`  locals.${v.name} = ${this.genExpr(v.init)};`);
        }
      }
    }

    out.push('  return {');
    out.push(`    stage: ${JSON.stringify(this.stage)},`);
    out.push('    locals,');
    out.push('    run() { locals.__discard = false; fn_main(); return { locals, io }; },');
    out.push('  };');
    out.push('}');

    return {
      js: out.join('\n'),
      uniformNames: this.collectUniforms(),
      interface: this.collectInterface(),
    };
  }

  collectUniforms() {
    const names = [];
    for (const d of this.ast.declarations) {
      if (d.kind === 'vardecl' && d.qualifiers.includes('uniform')) {
        for (const v of d.decls) names.push({ name: v.name, type: d.type.name });
      }
    }
    return names;
  }

  // 阶段接口：热换候选的链接一致性与资源绑定布局都基于这份真实声明生成。
  collectInterface() {
    const attributes = [];
    const inputs = [];
    const outputs = [];
    const uniforms = [];
    for (const d of this.ast.declarations) {
      if (d.kind !== 'vardecl') continue;
      for (const v of d.decls) {
        const entry = { name: v.name, type: d.type.name };
        if (d.qualifiers.includes('uniform')) uniforms.push(entry);
        if (d.qualifiers.includes('in')) {
          if (this.stage === 'vertex') attributes.push(entry);
          else inputs.push(entry);
        }
        if (d.qualifiers.includes('out')) outputs.push(entry);
      }
    }
    return { attributes, inputs, outputs, uniforms };
  }

  // ---------- 函数生成 ----------
  genFunction(fn) {
    const lines = [];
    const jsName = fn.name === 'main' ? 'fn_main' : `fn_${fn.name}_${this.fnIndex++}`;
    fn.jsName = jsName;
    lines.push(`  function ${jsName}(${fn.params.map((p, i) => `arg${i}`).join(', ')}) {`);

    this.pushScope();
    fn.params.forEach((p, i) => {
      if (p.name) this.declare(p.name, p.type, p.qualifiers, p);
      // 所有用户变量都落在 locals 上；out/inout 用盒子传递并在结尾写回
      const boxed = p.qualifiers.some((q) => q === 'out' || q === 'inout');
      lines.push(`    locals.${p.name ?? `_p${i}`} = ${boxed ? `arg${i}.value` : `arg${i}`};`);
    });
    this.currentFn = fn;
    this.fnReturnType = fn.returnType;
    lines.push(this.genStmt(fn.body, 1));
    // 写回 out/inout
    fn.params.forEach((p, i) => {
      if (p.name && p.qualifiers.some((q) => q === 'out' || q === 'inout')) {
        lines.push(`    arg${i}.value = locals.${p.name};`);
      }
    });
    lines.push('  }');
    this.popScope();
    return lines.join('\n');
  }

  indent(level) { return '  '.repeat(level); }

  // ---------- 语句生成 ----------
  genStmt(node, level) {
    const ind = this.indent(level);
    const block = (b) => b.kind === 'block' ? this.genStmt(b, level) : this.genStmt(b, level + 1);

    switch (node.kind) {
      case 'block': {
        const lines = [`${ind}{`];
        this.pushScope();
        for (const s of node.stmts) lines.push(this.genStmt(s, level + 1));
        this.popScope();
        lines.push(`${ind}}`);
        return lines.join('\n');
      }
      case 'vardecl': {
        const out = [];
        for (const v of node.decls) {
          this.declare(v.name, node.type, node.qualifiers, node);
          if (node.qualifiers.includes('uniform')) continue; // uniform 来自 U
          if (v.init) {
            const initCode = this.genExpr(v.init);
            const it = this.typeOf(v.init);
            if (!this.assignable(node.type, it)) {
              this.error(`无法用 ${typeName(it)} 初始化 ${typeName(node.type)} "${v.name}"`, v.init);
            }
            out.push(`${ind}locals.${v.name} = ${initCode};`);
          } else {
            out.push(`${ind}locals.${v.name} = ${this.defaultValue(node.type)};`);
          }
        }
        return out.join('\n');
      }
      case 'exprstmt':
        return `${ind}${this.genExpr(node.expr)};`;
      case 'if':
        return `${ind}if (${this.genTruth(node.test)}) {\n${block(node.consequent)}\n${ind}}${
          node.alternate ? ` else {\n${block(node.alternate)}\n${ind}}` : ''
        }`;
      case 'for': {
        this.pushScope();
        if (node.init?.kind === 'vardecl') {
          // 声明式 for 头提升到外层块，保持局部作用域语义
          const decl = this.genStmt(node.init, 0).trim();
          this.loopDepth++;
          const body = block(node.body);
          this.loopDepth--;
          const test = node.test ? this.genTruth(node.test) : 'true';
          const upd = node.update ? this.genExpr(node.update) : '';
          this.popScope();
          return `${ind}{\n${this.indent(level + 1)}${decl}\n${this.indent(level + 1)}for (; ${test}; ${upd}) {\n${body}\n${this.indent(level + 1)}}\n${ind}}`;
        }
        const initPart = node.init ? `${this.genExpr(node.init.expr)};` : ';';
        const test = node.test ? this.genTruth(node.test) : 'true';
        const upd = node.update ? this.genExpr(node.update) : '';
        this.loopDepth++;
        const body = block(node.body);
        this.loopDepth--;
        this.popScope();
        return `${ind}for (${initPart} ${test}; ${upd}) {\n${body}\n${ind}}`;
      }
      case 'while': {
        this.loopDepth++;
        const body = block(node.body);
        this.loopDepth--;
        return `${ind}while (${this.genTruth(node.test)}) {\n${body}\n${ind}}`;
      }
      case 'dowhile': {
        this.loopDepth++;
        const body = block(node.body);
        this.loopDepth--;
        return `${ind}do {\n${body}\n${ind}} while (${this.genTruth(node.test)});`;
      }
      case 'return': {
        if (node.expr) {
          const rt = this.typeOf(node.expr);
          if (!this.assignable(this.fnReturnType, rt)) {
            this.error(`返回值类型 ${typeName(rt)} 与函数返回类型 ${typeName(this.fnReturnType)} 不兼容`, node.expr);
          }
        }
        return `${ind}return${node.expr ? ` ${this.genExpr(node.expr)}` : ''};`;
      }
      case 'break':
        if (!this.loopDepth) this.error('break 只能出现在循环内', node);
        return `${ind}break;`;
      case 'continue':
        if (!this.loopDepth) this.error('continue 只能出现在循环内', node);
        return `${ind}continue;`;
      case 'discard':
        if (this.stage !== 'fragment') this.error('discard 只能用于片元着色器', node);
        return `${ind}locals.__discard = true; return;`;
      default:
        this.error(`不支持的语句 ${node.kind}`, node);
    }
  }

  assignable(target, source) {
    if (target.kind === 'struct' || source.kind === 'struct') return target.name === source.name;
    const T = target.name, S = typeof source === 'string' ? source : source.name;
    if (T === S) return true;
    if (T === 'float' && (S === 'int' || S === 'float')) return true; // 隐式 int→float
    if (VEC_TYPES[T] && VEC_TYPES[S]) return VEC_TYPES[T] === VEC_TYPES[S];
    if (SCALAR_TYPES.has(T) && SCALAR_TYPES.has(S)) return true;
    return false;
  }

  defaultValue(type) {
    const name = type.name ?? type;
    if (name === 'float' || name === 'int') return '0';
    if (name === 'bool') return 'false';
    if (VEC_TYPES[name]) return `new ${name[0].toUpperCase()}${name.slice(1)}()`;
    if (name === 'mat4') return 'Mat4.identity()';
    return 'null';
  }

  // 布尔语境：GLSL 没有隐式标量转换歧义，这里直接生成真值表达式
  genTruth(node) {
    const t = this.typeOf(node);
    const code = this.genExpr(node);
    return t === 'bool' ? code : `((${code}) !== 0)`;
  }

  // ---------- 表达式生成 ----------
  genExpr(node) {
    switch (node.kind) {
      case 'literal':
        if (node.type === 'bool') return node.value ? 'true' : 'false';
        return node.type === 'float' ? String(node.value) : String(node.value);
      case 'ident': {
        const info = this.lookup(node.name, node);
        if (info.qualifiers.includes('uniform')) return `U(${JSON.stringify(node.name)})`;
        if (info.qualifiers.includes('builtin')) return `locals.${node.name}`;
        return `locals.${node.name}`;
      }
      case 'member': {
        const obj = this.genExpr(node.object);
        const objT = this.typeOf(node.object);
        if (typeof objT === 'object' && objT.kind === 'struct') return `${obj}.${node.member}`;
        // 向量 swizzle：走 getter
        this.checkSwizzle(objT, node.member, node);
        return `${obj}.${node.member}`;
      }
      case 'index':
        return `${this.genExpr(node.object)}.d[${this.genExpr(node.index)}]`;
      case 'unary':
        return node.op === '-' ? `neg(${this.genExpr(node.expr)})` : `${node.op}(${this.genExpr(node.expr)})`;
      case 'preinc':
      case 'postinc': {
        const t = this.typeOf(node.expr);
        const target = this.genExpr(node.expr);
        if (VEC_TYPES[t]) {
          if (node.kind === 'preinc') {
            return `(${target} = B.${node.op[0] === '+' ? 'plus' : 'minus'}(${target}, ${this.vecOne(t)}), ${target})`;
          }
          const tmp = this.tmp('inc');
          return `(const ${tmp} = ${target}, ${target} = B.${node.op[0] === '+' ? 'plus' : 'minus'}(${target}, ${this.vecOne(t)}), ${tmp})`;
        }
        if (node.kind === 'preinc') return `(${target} ${node.op[0]}= 1, ${target})`;
        {
          const tmp = this.tmp('inc');
          return `(const ${tmp} = ${target}, ${target} ${node.op[0]}= 1, ${tmp})`;
        }
      }
      case 'binary':
        return this.genBinary(node);
      case 'assign':
        return this.genAssign(node);
      case 'ternary':
        return `((${this.genTruth(node.test)}) ? (${this.genExpr(node.cons)}) : (${this.genExpr(node.alt)}))`;
      case 'constructor':
        return this.genConstructor(node);
      case 'call':
        return this.genCall(node);
      default:
        this.error(`不支持的表达式 ${node.kind}`, node);
    }
  }

  vecOne(t) { return `B.${t}(1)`; }

  checkSwizzle(vecType, mask, node) {
    const n = VEC_TYPES[vecType];
    const families = ['xyzw', 'rgba', 'stpq'];
    const fam = families.find((f) => mask.split('').every((c) => f.includes(c)));
    if (!fam) this.error(`swizzle "${mask}" 混用了命名族或含非法字符`, node);
    for (const c of mask) {
      if (fam.indexOf(c) >= n) this.error(`${vecType} 没有分量 .${c}`, node);
    }
    if (mask.length > 4) this.error('swizzle 最多 4 个分量', node);
  }

  genBinary(node) {
    const l = this.genExpr(node.left);
    const r = this.genExpr(node.right);
    const op = node.op;
    if (['&&', '||'].includes(op)) return `((${this.genTruth(node.left)}) ${op} (${this.genTruth(node.right)}))`;
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
      const lt = this.typeOf(node.left);
      if (VEC_TYPES[lt]) {
        // 逐分量比较后做逻辑合取（all-lessThan 语义）
        const n = VEC_TYPES[lt];
        const jsOp = op === '==' ? '===' : op === '!=' ? '!==' : op;
        const parts = [];
        for (let i = 0; i < n; i++) parts.push(`(${l}.d[${i}] ${jsOp} ${r}.d[${i}])`);
        const joiner = op === '!=' ? ' || ' : ' && ';
        return `(${parts.join(joiner)})`;
      }
      return `(${l} ${op === '==' ? '===' : op === '!=' ? '!==' : op} ${r})`;
    }
    // 算术：JS 对向量/矩阵对象无运算符重载，必须走运行时
    const lt = this.typeOf(node.left);
    const rt = this.typeOf(node.right);
    if (op === '*' && lt === 'mat4' && rt === 'vec4') {
      return `${l}.transformVec(${r})`;
    }
    if (op === '*' && lt === 'vec4' && rt === 'mat4') {
      this.error('本引擎仅支持 mat4 * vec4（列向量约定）', node);
    }
    if (VEC_TYPES[lt] || VEC_TYPES[rt]) {
      if (op === '*') return this.genVecMul(lt, rt, l, r);
      if (op === '/') return this.genVecDiv(lt, rt, l, r);
      const fn = op === '+' ? 'B.plus' : op === '-' ? 'B.minus' : null;
      if (fn) return `${fn}(${l}, ${r})`;
      this.error(`向量类型不支持运算符 ${op}`, node);
    }
    return `(${l} ${op} ${r})`;
  }

  genVecMul(lt, rt, l, r) {
    // 逐分量乘法（GLSL vec * vec 与 vec * scalar 都支持）
    const n = VEC_TYPES[lt] ?? VEC_TYPES[rt];
    const parts = [];
    for (let i = 0; i < n; i++) {
      const le = VEC_TYPES[lt] ? `${l}.d[${i}]` : l;
      const re = VEC_TYPES[rt] ? `${r}.d[${i}]` : r;
      parts.push(`${le} * ${re}`);
    }
    return `makeVec([${parts.join(', ')}])`;
  }
  genVecDiv(lt, rt, l, r) {
    const n = VEC_TYPES[lt] ?? VEC_TYPES[rt];
    const parts = [];
    for (let i = 0; i < n; i++) {
      const le = VEC_TYPES[lt] ? `${l}.d[${i}]` : l;
      const re = VEC_TYPES[rt] ? `${r}.d[${i}]` : r;
      parts.push(`${le} / ${re}`);
    }
    return `makeVec([${parts.join(', ')}])`;
  }

  genAssign(node) {
    const target = node.left;
    const lcode = this.genExpr(target);
    const rcode = this.genExpr(node.right);
    const lt = this.typeOf(target);
    const rt = this.typeOf(node.right);
    if (!this.assignable(typeof lt === 'string' ? { name: lt } : lt, rt)) {
      this.error(`不能将 ${typeName(rt)} 赋值给 ${typeName(lt)}`, node);
    }
    if (node.op === '=') {
      // swizzle 写回：value-types 的 setter 已支持
      return `(${lcode} = ${rcode})`;
    }
    if (VEC_TYPES[lt]) {
      const fn = { '+=': 'B.plus', '-=': 'B.minus' }[node.op];
      if (fn) return `(${lcode} = ${fn}(${lcode}, ${rcode}))`;
      if (node.op === '*=') return `(${lcode} = ${this.genVecMul(lt, rt, lcode, rcode)})`;
      if (node.op === '/=') return `(${lcode} = ${this.genVecDiv(lt, rt, lcode, rcode)})`;
    }
    return `(${lcode} ${node.op[0]}= ${rcode})`;
  }

  genConstructor(node) {
    const ct = node.ctype;
    const args = node.args.map((a) => ({ code: this.genExpr(a), type: this.typeOf(a) }));
    if (VEC_TYPES[ct]) {
      // GLSL 构造器展平规则：向量参数按分量展开，标量占一个分量
      const comps = [];
      for (const a of args) {
        if (VEC_TYPES[a.type]) for (let i = 0; i < VEC_TYPES[a.type]; i++) comps.push(`${a.code}.d[${i}]`);
        else comps.push(a.code);
      }
      // 单标量构造：vec3(1.0) 等价于 vec3(1.0,1.0,1.0)
      if (comps.length === 1) {
        const only = comps[0];
        for (let i = 1; i < VEC_TYPES[ct]; i++) comps.push(only);
      }
      if (comps.length !== VEC_TYPES[ct]) {
        this.error(`${ct} 构造器需要 ${VEC_TYPES[ct]} 个分量，实际得到 ${comps.length}`, node);
      }
      return `new ${ct[0].toUpperCase()}${ct.slice(1)}(${comps.join(', ')})`;
    }
    if (ct === 'mat4') {
      if (args.length === 0) return 'Mat4.identity()';
      this.error('mat4 仅支持默认构造', node);
    }
    if (SCALAR_TYPES.has(ct)) {
      if (args.length !== 1) this.error(`${ct} 构造器需要 1 个参数`, node);
      if (ct === 'float') return `(+(${args[0].code}))`;
      if (ct === 'int') return `((${args[0].code}) | 0)`;
      return `(!!(${args[0].code}))`;
    }
    this.error(`不支持的构造器 ${ct}`, node);
  }

  genCall(node) {
    const name = node.callee.name;
    const args = node.args.map((a) => this.genExpr(a));

    if (this.funcs.has(name)) {
      const fn = this.funcs.get(name);
      if (fn.params.length !== node.args.length) {
        this.error(`函数 ${name} 参数数量不符：期望 ${fn.params.length}，实际 ${node.args.length}`, node);
      }
      // 类型检查 + out/inout 装箱
      const passed = fn.params.map((p, i) => {
        const at = this.typeOf(node.args[i]);
        if (!this.assignable(p.type, at)) this.error(`函数 ${name} 第 ${i + 1} 个参数类型不兼容`, node.args[i]);
        if (p.qualifiers.some((q) => q === 'out' || q === 'inout')) {
          if (node.args[i].kind !== 'ident' && node.args[i].kind !== 'member') {
            this.error('out/inout 实参必须是可写左值', node.args[i]);
          }
          return `{ value: ${args[i]} }`;
        }
        return args[i];
      });
      return `${fn.jsName}(${passed.join(', ')})`;
    }

    if (name === 'texture' || name === 'texture2D') {
      if (node.args.length !== 2) this.error('texture() 需要 sampler 与 uv 两个参数', node);
      const samplerNode = node.args[0];
      const st = this.typeOf(samplerNode);
      if (st.name !== 'sampler2D' && st !== 'sampler2D') this.error('texture() 第一个参数必须是 sampler2D', node);
      if (samplerNode.kind !== 'ident') this.error('sampler 必须是具名 uniform', samplerNode);
      return `B.texture(S(${JSON.stringify(samplerNode.name)}), ${this.genExpr(node.args[1])})`;
    }

    if (!BUILTIN_FUNCS.has(name)) this.error(`未知函数 "${name}"`, node);
    return `B.${name}(${args.join(', ')})`;
  }
}
