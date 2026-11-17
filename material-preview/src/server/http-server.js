// 预览服务 HTTP 层：图形界面的静态入口、控制 API、帧 PNG 流送与 SSE 事件。
// 仅使用 Node 内置模块。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PreviewSceneService } from '../core/preview-scene.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export class PreviewServer {
  constructor(options = {}) {
    this.service = options.service ?? null;
    this.serviceOptions = options;
    this.port = options.port ?? 8123;
    this.sseClients = new Set();
    this.server = null;
  }

  async init() {
    if (!this.service) this.service = await PreviewSceneService.create(this.serviceOptions);
    return this;
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify({ ...event, at: performance.now() })}\n\n`;
    for (const res of this.sseClients) res.write(payload);
  }

  async handleApi(req, res, url) {
    const svc = this.service;
    const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : null;
    const route = url.pathname;

    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    try {
      if (req.method === 'GET' && route === '/api/state') return json(svc.describeState());
      if (req.method === 'GET' && route === '/api/materials') return json(svc.listMaterials());
      if (req.method === 'GET' && route === '/api/pipeline') return json(svc.pipelineSnapshot());

      if (req.method === 'POST' && route === '/api/materials/select') {
        const result = await svc.selectMaterial(body.materialId);
        this.broadcast({ type: 'compile', result: summarizeCompile(result) });
        return json(svc.describeState());
      }
      if (req.method === 'POST' && route === '/api/materials') {
        const rec = svc.registerMaterial({
          name: body.name, struct: body.struct, params: body.params, textureKind: body.textureKind,
        });
        return json(rec);
      }
      if (req.method === 'POST' && route === '/api/struct') {
        const state = await svc.setStruct(body.field, body.value);
        this.broadcast({ type: 'compile', result: svc.lastCompileResult });
        return json(state);
      }
      if (req.method === 'POST' && route === '/api/param') {
        const state = svc.setParam(body.name, body.value);
        return json(state);
      }
      if (req.method === 'POST' && route === '/api/texture') {
        return json(svc.setTextKind(body.kind));
      }
      if (req.method === 'POST' && route === '/api/camera') {
        svc.setCamera(body);
        return json(svc.describeState());
      }

      if (req.method === 'POST' && route === '/api/render') {
        const frame = svc.renderFrame({ width: body?.width, height: body?.height, mesh: body?.mesh });
        this.broadcast({ type: 'frame', seq: frame.seq, renderMs: frame.renderMs, isFallback: frame.isFallback });
        res.writeHead(200, {
          'content-type': 'image/png',
          'x-frame-seq': String(frame.seq),
          'x-render-ms': String(frame.renderMs.toFixed(2)),
          'x-variant-key': frame.variantKey,
          'x-fallback': frame.isFallback ? '1' : '0',
        });
        return res.end(frame.png);
      }

      if (req.method === 'POST' && route === '/api/prewarm') {
        const token = { cancelled: false };
        this._lastPrewarmToken = token;
        const report = await svc.prewarm(body?.needed, {
          maxVariants: body?.maxVariants, timeBudgetMs: body?.timeBudgetMs, cancelToken: token,
        });
        this.broadcast({ type: 'prewarm', report });
        return json(report);
      }
      if (req.method === 'POST' && route === '/api/prewarm/cancel') {
        if (this._lastPrewarmToken) this._lastPrewarmToken.cancelled = true;
        return json({ cancelled: true });
      }

      if (req.method === 'POST' && route === '/api/benchmark') {
        const report = await svc.runBenchmark(body?.sequence);
        return json(report);
      }
      if (req.method === 'POST' && route === '/api/verify-reuse') {
        return json(await svc.verifyReuse(body?.materialId));
      }

      // ---- 运行中着色器热换 ----
      if (req.method === 'GET' && route === '/api/shader') {
        return json(svc.shaderProgramState(url.searchParams.get('materialId') ?? undefined));
      }
      // 仅受理候选源码（文本保存），不改变画面；返回 revision 供后续运行
      if (req.method === 'POST' && route === '/api/shader/candidate') {
        const accepted = svc.submitShaderCandidate(body.source, {
          materialId: body.materialId,
          editVersion: body.editVersion,
        });
        delete accepted.task;
        this.broadcast({ type: 'shader', stage: 'submitted', programId: accepted.programId, revision: accepted.revision });
        return json(accepted);
      }
      // 编译候选并按结果发布或保留旧版本；连续保存时旧任务结果被丢弃
      if (req.method === 'POST' && route === '/api/shader/compile') {
        const result = await svc.hotSwapShader(body.source, {
          materialId: body.materialId,
          editVersion: body.editVersion,
        });
        this.broadcast({
          type: 'shader',
          stage: result.adopted ? 'published' : result.superseded ? 'superseded' : 'rejected',
          revision: result.revision, reason: result.reason ?? null,
        });
        return json({ result, state: svc.describeState() });
      }
      if (req.method === 'POST' && route === '/api/shader/rollback') {
        const r = svc.rollbackShader(body?.materialId);
        return json({ result: r, state: svc.describeState() });
      }

      // 故障注入：提交一段非法 GLSL，验证失败诊断与替代材质路径
      if (req.method === 'POST' && route === '/api/fault-injection') {
        const result = await svc.pipeline.compileBroaderSource(body.source, body.struct);
        this.broadcast({ type: 'fault', status: result.status, reason: result.reason });
        return json({
          status: result.status,
          reason: result.reason,
          diagnostic: result.diagnostic ? {
            stage: result.diagnostic.stage, phase: result.diagnostic.phase,
            message: result.diagnostic.message, sourceLine: result.diagnostic.sourceLine,
          } : null,
        });
      }

      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        this.sseClients.add(res);
        req.on('close', () => this.sseClients.delete(res));
        return;
      }

      json({ error: '未知接口' }, 404);
    } catch (e) {
      json({ error: e.message, code: e.code ?? null }, 400);
    }
  }

  async serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('forbidden');
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('未找到资源');
    }
  }

  async start() {
    await this.init();
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return this.handleApi(req, res, url);
      return this.serveStatic(req, res, url);
    });
    return new Promise((resolve) => {
      this.server.listen(this.port, () => resolve(this.server.address()));
    });
  }

  stop() {
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
    this.server?.close();
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error(`请求体不是合法 JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function summarizeCompile(result) {
  return {
    status: result.status,
    fromCache: result.fromCache ?? false,
    compileMs: result.compileMs ?? null,
    reason: result.reason ?? null,
    key: result.identity?.key ?? null,
  };
}
