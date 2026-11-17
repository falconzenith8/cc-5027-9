// GLSL 预处理器：行控制、#define 宏、条件编译、#include。
// 条件编译是"结构选项"进入着色器源码的真实路径 —— 改结构选项会改变
// 预处理后的源码，进而得到不同的缓存身份与编译产物。

export class PreprocessError extends Error {
  constructor(message, line) {
    super(`预处理错误 (第 ${line} 行): ${message}`);
    this.name = 'PreprocessError';
    this.glslLine = line;
  }
}

function tokenizeMacroExpr(expr) {
  const tokens = [];
  const re = /\s*([()!]|&&|\|\||==|!=|<=|>=|[+\-*/<>]|[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(expr)) !== null) tokens.push(m[1]);
  return tokens;
}

// 只支持常量整数表达式与 defined 宏，足够覆盖 #if / #elif 的结构开关
function evalConstExpr(expr, defines, line) {
  const tokens = tokenizeMacroExpr(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let v = parseAnd();
    while (peek() === '||') { next(); const r = parseAnd(); v = (v || r) ? 1 : 0; }
    return v;
  }
  function parseAnd() {
    let v = parseEq();
    while (peek() === '&&') { next(); const r = parseEq(); v = (v && r) ? 1 : 0; }
    return v;
  }
  function parseEq() {
    let v = parseRel();
    while (peek() === '===' || peek() === '==' || peek() === '!=') {
      const op = next(); const r = parseRel();
      v = (op === '!=' ? v !== r : v === r) ? 1 : 0;
    }
    return v;
  }
  function parseRel() {
    let v = parseUnary();
    while (['<', '>', '<=', '>='].includes(peek())) {
      const op = next(); const r = parseUnary();
      v = ({ '<': v < r, '>': v > r, '<=': v <= r, '>=': v >= r })[op] ? 1 : 0;
    }
    return v;
  }
  function parseUnary() {
    if (peek() === '!') { next(); return parseUnary() ? 0 : 1; }
    if (peek() === '-') { next(); return -parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = next();
    if (t === '(') { const v = parseOr(); if (next() !== ')') throw new PreprocessError('缺少 )', line); return v; }
    if (t === 'defined') {
      let name = next();
      if (name === '(') name = next(), next();
      return Object.prototype.hasOwnProperty.call(defines, name) ? 1 : 0;
    }
    if (/^[0-9]/.test(t)) return parseFloat(t);
    if (/^[A-Za-z_]/.test(t)) {
      const dv = defines[t];
      if (dv === undefined) return 0; // GLSL 规定未定义标识符在 #if 中为 0
      const n = parseFloat(dv.body);
      return Number.isNaN(n) ? 0 : n;
    }
    throw new PreprocessError(`无法解析常量表达式中的 "${t}"`, line);
  }

  const result = parseOr();
  return result ? 1 : 0;
}

function expandMacros(text, defines, line) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { // 行注释保留（词法器也会处理）
      const end = text.indexOf('\n', i);
      if (end === -1) { out += text.slice(i); break; }
      out += text.slice(i, end); i = end; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (Object.prototype.hasOwnProperty.call(defines, word) && !defines[word].isFunctionLike) {
        out += ' ' + defines[word].body + ' ';
      } else if (defines[word]?.isFunctionLike) {
        // 函数式宏：找实参列表
        let k = j;
        while (k < text.length && /\s/.test(text[k])) k++;
        if (text[k] !== '(') { out += word; i = j; continue; }
        let depth = 0, p = k;
        const args = [];
        let cur = '';
        for (; p < text.length; p++) {
          if (text[p] === '(') { if (depth++ === 0) continue; }
          if (text[p] === ')') { if (--depth === 0) { args.push(cur); break; } }
          if (text[p] === ',' && depth === 1) { args.push(cur); cur = ''; continue; }
          cur += text[p];
        }
        if (depth !== 0) throw new PreprocessError(`宏 ${word} 参数括号不闭合`, line);
        const params = defines[word].params;
        if (args.length !== params.length) {
          throw new PreprocessError(`宏 ${word} 参数数量不符：期望 ${params.length}，实际 ${args.length}`, line);
        }
        let body = defines[word].body;
        for (let pi = 0; pi < params.length; pi++) {
          body = body.replace(new RegExp(`\\b${params[pi]}\\b`, 'g'), `(${args[pi].trim()})`);
        }
        out += `(${expandMacros(body, defines, line)})`;
        i = p + 1;
        continue;
      } else {
        out += word;
      }
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * @param source 原始 GLSL 源码
 * @param options { defines: Record<string,string|number>, resolver: (name)->string|null }
 * @returns {{ code: string, defsUsed: string[], includeChain: string[] }}
 */
export function preprocess(source, options = {}) {
  const userDefines = options.defines ?? {};
  const resolver = options.resolver ?? (() => null);
  const defines = {};
  for (const [k, v] of Object.entries(userDefines)) defines[k] = { body: String(v), isFunctionLike: false };

  const defsUsed = new Set();
  const includeChain = [];
  const inputName = options.name ?? '<main>';

  function process(text, name, stack) {
    const lines = text.split('\n');
    const out = [];
    // condition 栈：{ parentActive, active, seenTrue }
    const condStack = [];
    const active = () => condStack.every((c) => c.active);

    for (let li = 0; li < lines.length; li++) {
      const rawLine = lines[li];
      const lineNo = li + 1;
      const trimmed = rawLine.trim();

      if (trimmed.startsWith('#')) {
        const directive = trimmed.slice(1).trim();
        const [cmd, ...restParts] = directive.split(/\s+/);
        const rest = directive.slice(cmd.length).trim();

        if (cmd === 'if') {
          const parent = active();
          const val = parent ? evalConstExpr(rest, defines, lineNo) : 0;
          condStack.push({ parentActive: parent, active: parent && !!val, seenTrue: parent && !!val });
          out.push(`#line ${lineNo} "${name}"`);
          continue;
        }
        if (cmd === 'ifdef' || cmd === 'ifndef') {
          const parent = active();
          const has = Object.prototype.hasOwnProperty.call(defines, restParts[0]);
          const val = cmd === 'ifdef' ? has : !has;
          condStack.push({ parentActive: parent, active: parent && val, seenTrue: parent && val });
          out.push(`#line ${lineNo} "${name}"`);
          continue;
        }
        if (cmd === 'else') {
          const top = condStack[condStack.length - 1];
          if (!top) throw new PreprocessError('#else 没有匹配的 #if', lineNo);
          top.active = top.parentActive && !top.seenTrue;
          if (top.active) top.seenTrue = true;
          out.push(`#line ${lineNo} "${name}"`);
          continue;
        }
        if (cmd === 'elif') {
          const top = condStack[condStack.length - 1];
          if (!top) throw new PreprocessError('#elif 没有匹配的 #if', lineNo);
          const val = top.parentActive && !top.seenTrue && !!evalConstExpr(rest, defines, lineNo);
          top.active = val;
          if (val) top.seenTrue = true;
          out.push(`#line ${lineNo} "${name}"`);
          continue;
        }
        if (cmd === 'endif') {
          if (!condStack.pop()) throw new PreprocessError('#endif 没有匹配的 #if', lineNo);
          out.push(`#line ${lineNo} "${name}"`);
          continue;
        }
        if (!active()) { out.push(''); continue; }

        if (cmd === 'define') {
          const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?\s*(.*)$/);
          if (!m) throw new PreprocessError(`非法 #define: ${rest}`, lineNo);
          const [, macro, paramGroup, , body] = m;
          if (paramGroup !== undefined) {
            const params = paramGroup.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
            defines[macro] = { isFunctionLike: true, params, body: body.trim() };
          } else {
            defines[macro] = { isFunctionLike: false, body: body.trim() };
          }
          defsUsed.add(macro);
          out.push('');
          continue;
        }
        if (cmd === 'undef') {
          delete defines[restParts[0]];
          out.push('');
          continue;
        }
        if (cmd === 'include') {
          const incName = rest.replace(/^["<]/, '').replace(/[>"]$/, '');
          if (stack.includes(incName)) throw new PreprocessError(`循环 #include: ${[...stack, incName].join(' -> ')}`, lineNo);
          const incSource = resolver(incName);
          if (incSource === null || incSource === undefined) {
            throw new PreprocessError(`找不到 include 文件: ${incName}`, lineNo);
          }
          includeChain.push(incName);
          out.push(`#line 1 "${incName}"`);
          out.push(process(incSource, incName, [...stack, incName]));
          out.push(`#line ${lineNo + 1} "${name}"`);
          continue;
        }
        if (cmd === 'line' || cmd === 'pragma' || cmd === 'extension' || cmd === 'version') {
          out.push(''); // 本引擎的行号自管理；version/pragma 由词法器容忍
          continue;
        }
        throw new PreprocessError(`不支持的预处理指令: #${cmd}`, lineNo);
      }

      if (active()) {
        out.push(expandMacros(rawLine, defines, lineNo));
      } else {
        out.push('');
      }
    }
    if (condStack.length) throw new PreprocessError('#if 缺少 #endif', lines.length);
    return out.join('\n');
  }

  const code = process(source, inputName, [inputName]);
  return { code, defsUsed: [...defsUsed], includeChain };
}
