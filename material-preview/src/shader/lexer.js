// GLSL 词法分析器。带行列追踪，编译诊断可以定位回原始源码位置。

export const T = {
  INT: 'INT', FLOAT: 'FLOAT', IDENT: 'IDENT',
  // 关键字在 token 上以 kw 字段标记，type 仍是 IDENT
  OP: 'OP',
};

const KEYWORDS = new Set([
  'const', 'uniform', 'in', 'out', 'inout',
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard',
  'true', 'false', 'struct',
  'void', 'float', 'int', 'bool',
  'vec2', 'vec3', 'vec4', 'mat4', 'sampler2D',
]);

const MULTI_OPS = ['<=', '>=', '==', '!=', '&&', '||', '++', '--', '+=', '-=', '*=', '/='];
const SINGLE_OPS = new Set('+-*/%=<>!.,;:()[]{}?');

export class LexError extends Error {
  constructor(message, line, col) {
    super(`词法错误 (${line}:${col}): ${message}`);
    this.name = 'LexError';
    this.line = line; this.col = col;
  }
}

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1, col = 1;
  const n = source.length;

  const advance = (count = 1) => {
    for (let k = 0; k < count; k++) {
      if (source[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };

  while (i < n) {
    const c = source[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    // 行注释
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') advance();
      continue;
    }
    // 块注释
    if (c === '/' && source[i + 1] === '*') {
      advance(2);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) advance();
      if (i >= n) throw new LexError('未闭合的块注释', line, col);
      advance(2);
      continue;
    }
    // 预处理器残留行（#line 等）跳过整行
    if (c === '#') {
      while (i < n && source[i] !== '\n') advance();
      continue;
    }

    // 数字字面量：支持 1, 1.0, .5, 1e-3, 后缀 f/F
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i; const startCol = col; const startLine = line;
      let isFloat = false;
      while (i < n && /[0-9]/.test(source[i])) advance();
      if (source[i] === '.') {
        isFloat = true; advance();
        while (i < n && /[0-9]/.test(source[i])) advance();
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true; advance();
        if (source[i] === '+' || source[i] === '-') advance();
        while (i < n && /[0-9]/.test(source[i])) advance();
      }
      if (source[i] === 'f' || source[i] === 'F') { isFloat = true; advance(); }
      const text = source.slice(start, i).replace(/[fF]$/, '');
      tokens.push({
        type: isFloat ? T.FLOAT : T.INT,
        value: isFloat ? parseFloat(text) : parseInt(text, 10),
        line: startLine, col: startCol, text,
      });
      continue;
    }

    // 标识符 / 关键字
    if (/[A-Za-z_]/.test(c)) {
      const start = i; const startCol = col; const startLine = line;
      while (i < n && /[A-Za-z0-9_]/.test(source[i])) advance();
      const text = source.slice(start, i);
      tokens.push({
        type: T.IDENT,
        value: text,
        kw: KEYWORDS.has(text) ? text : null,
        line: startLine, col: startCol,
      });
      continue;
    }

    // 运算符
    const two = source.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: T.OP, value: two, line, col });
      advance(2);
      continue;
    }
    if (SINGLE_OPS.has(c)) {
      tokens.push({ type: T.OP, value: c, line, col });
      advance();
      continue;
    }

    throw new LexError(`无法识别的字符 "${c}"`, line, col);
  }

  tokens.push({ type: 'EOF', value: '', line, col });
  return tokens;
}
