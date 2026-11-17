// GLSL 递归下降语法分析器 → AST。
// 支持材质着色器实际需要的子集：uniform/in/out 声明、结构体字段、
// 函数定义（含 out/inout 参数）、控制流、构造器、成员与 swizzle、后缀表达式。

import { tokenize, T } from './lexer.js';

export class ParseError extends Error {
  constructor(message, token) {
    super(`语法错误 (${token?.line ?? '?'}:${token?.col ?? '?'}): ${message}`);
    this.name = 'ParseError';
    this.line = token?.line; this.col = token?.col;
  }
}

const TYPE_NAMES = new Set(['void', 'float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'mat4', 'sampler2D']);

export function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (o = 0) => tokens[pos + o];
  const next = () => tokens[pos++];
  const atOp = (v) => peek().type === 'OP' && peek().value === v;
  const atKw = (v) => peek().kw === v;
  const atIdent = () => peek().type === 'IDENT';

  function expectOp(v) {
    if (!atOp(v)) throw new ParseError(`期望 "${v}"，遇到 "${peek().value}"`, peek());
    return next();
  }
  function expectKw(v) {
    if (!atKw(v)) throw new ParseError(`期望关键字 ${v}，遇到 "${peek().value}"`, peek());
    return next();
  }
  function consumeIdent() {
    // 类型名等关键字在声明位之后仍可能作为普通标识符出现（保守接受）
    if (peek().type !== 'IDENT') throw new ParseError(`期望标识符，遇到 "${peek().value}"`, peek());
    return next().value;
  }

  function parseType() {
    const t = peek();
    if (t.type === 'IDENT' && TYPE_NAMES.has(t.value)) {
      next();
      return { kind: 'builtin', name: t.value };
    }
    if (t.type === 'IDENT' && !t.kw) { // 用户结构体类型名
      next();
      return { kind: 'user', name: t.value };
    }
    throw new ParseError(`期望类型名，遇到 "${t.value}"`, t);
  }

  // ---- 声明 ----
  function parseQualifiers() {
    const qual = [];
    while (['const', 'uniform', 'in', 'out', 'inout'].includes(peek().kw)) qual.push(next().value);
    return qual;
  }

  function parseStruct() {
    expectKw('struct');
    const name = consumeIdent();
    expectOp('{');
    const fields = [];
    while (!atOp('}')) {
      const type = parseType();
      do {
        const field = consumeIdent();
        fields.push({ type, name: field });
        if (atOp(',')) next(); else break;
      } while (true);
      expectOp(';');
    }
    expectOp('}');
    if (atOp(';')) next();
    return { kind: 'struct', name, fields };
  }

  function parseVarDecl(type, qualifiers, firstName = null) {
    const decls = [];
    let name = firstName;
    do {
      if (name === null) name = consumeIdent();
      let init = null;
      if (atOp('=')) { next(); init = parseExpression(); }
      decls.push({ name, init });
      name = null;
      if (atOp(',')) next(); else break;
    } while (true);
    expectOp(';');
    return { kind: 'vardecl', type, qualifiers, decls };
  }

  function parseFunctionOrGlobal() {
    const qualifiers = parseQualifiers();
    if (atIdent() && peek().value === 'precision') {
      next(); // precision
      next(); // highp / mediump / lowp
      parseType();
      expectOp(';');
      return { kind: 'precision' };
    }
    if (atKw('struct')) return parseStruct();
    const type = parseType();
    const name = consumeIdent();

    if (atOp('(')) {
      next();
      const params = [];
      while (!atOp(')')) {
        const pq = parseQualifiers();
        const ptype = parseType();
        const pname = atOp(')') ? null : consumeIdent();
        params.push({ qualifiers: pq, type: ptype, name: pname });
        if (atOp(',')) next();
      }
      expectOp(')');
      if (atOp(';')) { next(); return { kind: 'prototype', returnType: type, name, params }; }
      const body = parseBlock();
      return { kind: 'function', returnType: type, name, params, body };
    }
    return parseVarDecl(type, qualifiers, name);
  }

  function parseBlock() {
    expectOp('{');
    const stmts = [];
    while (!atOp('}')) stmts.push(parseStatement());
    next();
    return { kind: 'block', stmts };
  }

  function parseStatement() {
    const t = peek();

    if (atOp('{')) return parseBlock();
    if (atKw('if')) {
      next(); expectOp('(');
      const test = parseExpression(); expectOp(')');
      const consequent = parseStatement();
      let alternate = null;
      if (atKw('else')) { next(); alternate = parseStatement(); }
      return { kind: 'if', test, consequent, alternate };
    }
    if (atKw('for')) {
      next(); expectOp('(');
      let init = null;
      if (!atOp(';')) {
        if (peek().kw && ['const', 'in', 'out'].includes(peek().kw) || TYPE_NAMES.has(peek().value)) {
          const q = parseQualifiers();
          const ty = parseType();
          init = parseVarDecl(ty, q); // 内部已消费分号
        } else {
          const expr = parseExpression(); expectOp(';');
          init = { kind: 'exprstmt', expr };
        }
      } else next();
      const test = atOp(';') ? null : parseExpression();
      expectOp(';');
      const update = atOp(')') ? null : parseExpression();
      expectOp(')');
      const body = parseStatement();
      return { kind: 'for', init, test, update, body };
    }
    if (atKw('while')) {
      next(); expectOp('(');
      const test = parseExpression(); expectOp(')');
      return { kind: 'while', test, body: parseStatement() };
    }
    if (atKw('do')) {
      next();
      const body = parseStatement();
      expectKw('while'); expectOp('(');
      const test = parseExpression(); expectOp(')'); expectOp(';');
      return { kind: 'dowhile', body, test };
    }
    if (atKw('return')) {
      next();
      const expr = atOp(';') ? null : parseExpression();
      expectOp(';');
      return { kind: 'return', expr };
    }
    if (atKw('discard')) { next(); expectOp(';'); return { kind: 'discard' }; }
    if (atKw('break')) { next(); expectOp(';'); return { kind: 'break' }; }
    if (atKw('continue')) { next(); expectOp(';'); return { kind: 'continue' }; }

    // 局部变量声明
    if (TYPE_NAMES.has(peek().value) || (peek().type === 'IDENT' && !peek().kw && peek(1)?.type === 'IDENT')) {
      const q = parseQualifiers();
      const ty = parseType();
      return parseVarDecl(ty, q);
    }

    const expr = parseExpression();
    expectOp(';');
    return { kind: 'exprstmt', expr };
  }

  // ---- 表达式（优先级爬升）----
  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=']);
  const PREC = {
    '||': 2, '&&': 3,
    '==': 4, '!=': 4,
    '<': 5, '>': 5, '<=': 5, '>=': 5,
    '+': 6, '-': 6,
    '*': 7, '/': 7, '%': 7,
  };

  function parseExpression() {
    const left = parseTernary();
    if (peek().type === 'OP' && ASSIGN_OPS.has(peek().value)) {
      const op = next().value;
      const right = parseExpression(); // 右结合
      return { kind: 'assign', op, left, right, line: left.line };
    }
    return left;
  }

  function parseTernary() {
    const test = parseBinary(0);
    if (atOp('?')) {
      next();
      const cons = parseExpression();
      expectOp(':');
      const alt = parseTernary();
      return { kind: 'ternary', test, cons, alt, line: test.line };
    }
    return test;
  }

  function parseBinary(minPrec) {
    let left = parseUnary();
    while (peek().type === 'OP' && PREC[peek().value] !== undefined && PREC[peek().value] >= minPrec) {
      const op = next().value;
      const p = PREC[op];
      const right = parseBinary(p + 1);
      left = { kind: 'binary', op, left, right, line: left.line };
    }
    return left;
  }

  function parseUnary() {
    if (peek().type === 'OP' && ['-', '+', '!'].includes(peek().value)) {
      const op = next().value;
      return { kind: 'unary', op, expr: parseUnary(), line: peek().line };
    }
    if (peek().type === 'OP' && ['++', '--'].includes(peek().value)) {
      const op = next().value;
      return { kind: 'preinc', op, expr: parseUnary(), line: peek().line };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let expr = parsePrimary();
    while (true) {
      if (atOp('.')) {
        next();
        const member = consumeIdent();
        expr = { kind: 'member', object: expr, member, line: expr.line };
      } else if (atOp('[')) {
        next();
        const index = parseExpression();
        expectOp(']');
        expr = { kind: 'index', object: expr, index, line: expr.line };
      } else if (atOp('++') || atOp('--')) {
        const op = next().value;
        expr = { kind: 'postinc', op, expr, line: expr.line };
      } else if (atOp('(')) {
        // 函数调用（primary 已是 ident 或成员结果）
        if (expr.kind !== 'ident' && expr.kind !== 'member') {
          throw new ParseError('非法的调用目标', peek());
        }
        next();
        const args = [];
        while (!atOp(')')) {
          args.push(parseExpression());
          if (atOp(',')) next();
        }
        expectOp(')');
        expr = { kind: 'call', callee: expr, args, line: expr.line };
      } else break;
    }
    return expr;
  }

  function parsePrimary() {
    const t = peek();

    if (atOp('(')) {
      next();
      const e = parseExpression();
      expectOp(')');
      return e;
    }
    if (t.type === T.INT || t.type === T.FLOAT) {
      next();
      return { kind: 'literal', type: t.type === T.INT ? 'int' : 'float', value: t.value, line: t.line };
    }
    if (atKw('true') || atKw('false')) {
      next();
      return { kind: 'literal', type: 'bool', value: t.value === 'true', line: t.line };
    }
    if (t.type === 'IDENT') {
      next();
      // 构造器：类型名(...)
      if (TYPE_NAMES.has(t.value) && atOp('(')) {
        next(); // 消费 '('
        const args = [];
        while (!atOp(')')) {
          args.push(parseExpression());
          if (atOp(',')) next();
        }
        expectOp(')');
        return { kind: 'constructor', ctype: t.value, args, line: t.line };
      }
      return { kind: 'ident', name: t.value, line: t.line };
    }
    throw new ParseError(`无法解析的表达式开头 "${t.value}"`, t);
  }

  const declarations = [];
  while (peek().type !== 'EOF') declarations.push(parseFunctionOrGlobal());
  return { kind: 'program', declarations };
}
