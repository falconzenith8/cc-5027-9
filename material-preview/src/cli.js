#!/usr/bin/env node
// 命令行辅助入口。图形界面才是着色器预览的主入口：node src/cli.js serve 后浏览器打开。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PreviewSceneService } from './core/preview-scene.js';
import { PreviewServer } from './server/http-server.js';

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args.flags[key] = true;
      else { args.flags[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0] ?? 'serve';

  if (cmd === 'serve') {
    const port = Number(args.flags.port ?? process.env.PORT ?? 8123);
    const server = new PreviewServer({ port, width: 256, height: 256 });
    const addr = await server.start();
    const actualPort = typeof addr === 'object' ? addr.port : port;
    console.log('材质设计预览已启动');
    console.log(`  图形入口（主）: http://localhost:${actualPort}/`);
    console.log('  命令行仅作辅助，预览/编译/诊断均在图形界面完成');
    const shutdown = () => { server.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const svc = await PreviewSceneService.create({
    width: Number(args.flags.width ?? 256),
    height: Number(args.flags.height ?? 256),
  });

  if (cmd === 'render') {
    if (args.flags.material) await svc.selectMaterial(args.flags.material);
    const frame = svc.renderFrame();
    const out = args.flags.out ?? path.resolve('preview-frame.png');
    await writeFile(out, frame.png);
    console.log(JSON.stringify({
      out, variantKey: frame.variantKey, fallback: frame.isFallback,
      renderMs: Number(frame.renderMs.toFixed(2)),
    }, null, 2));
    return;
  }

  if (cmd === 'bench') {
    const report = await svc.runBenchmark();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'prewarm') {
    const report = await svc.prewarm(undefined, {
      maxVariants: Number(args.flags['max-variants'] ?? 4),
      timeBudgetMs: Number(args.flags['budget-ms'] ?? 2000),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'fault') {
    const broken = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(thisSymbolIsNotDeclared, 0.0, 0.0, 1.0);
}
`;
    const result = await svc.pipeline.compileBroaderSource(broken, {});
    console.log(JSON.stringify({
      status: result.status,
      reason: result.reason,
      diagnostic: result.diagnostic ? {
        stage: result.diagnostic.stage, phase: result.diagnostic.phase,
        message: result.diagnostic.message, sourceLine: result.diagnostic.sourceLine,
      } : null,
    }, null, 2));
    return;
  }

  // 辅助验证：对当前材质做一次热换（图形界面仍是主入口）
  if (cmd === 'hot-swap') {
    const bodyFlag = args.flags.body ?? 'tint';
    const bodies = {
      tint: 'vec4 c = texture(u_baseColorTex, v_uv) * u_baseColor;\n  c.rgb = c.rgb * 0.3 + vec3(0.0, 0.5, 0.1);\n  fragColor = vec4(c.rgb, 1.0);',
      broken: 'vec4 c = tex(u_baseColorTex, v_uv);\n  fragColor = c;',
      rebind: 'fragColor = texture(u_baseColorTex, v_uv) + vec4(0.0, 0.0, 0.2, 0.0);',
    };
    const uniforms = bodyFlag === 'rebind'
      ? `uniform sampler2D u_baseColorTex;`
      : `uniform vec4 u_baseColor;\nuniform sampler2D u_baseColorTex;\nuniform sampler2D u_occlusionTex;`;
    const source = `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_tangent;
${uniforms}
out vec4 fragColor;
void main() {
  ${bodies[bodyFlag] ?? bodies.tint}
}
`;
    const result = await svc.hotSwapShader(source);
    console.log(JSON.stringify({
      adopted: result.adopted,
      superseded: result.superseded ?? false,
      revision: result.revision,
      variantKey: result.variantKey ?? null,
      affectedInstances: result.affectedInstances ?? 0,
      bindingLayoutChanged: result.bindingLayoutChanged ?? false,
      bindingLayoutHash: result.bindingLayoutHash ?? null,
      publishedKept: result.publishedKept ?? null,
      reason: result.reason ?? null,
      diagnostic: result.diagnostic ?? null,
      bindingErrors: result.bindingErrors ?? null,
    }, null, 2));
    return;
  }

  console.log(`未知命令: ${cmd}
可用:
  serve                启动预览服务并打开图形入口（主入口）
  render --out f.png   渲染一帧到 PNG
  bench                固定操作序列：首次卡顿/变体数/复用验证
  prewarm              按预算预热已知场景变体
  fault                故障注入：验证编译诊断与替代材质
  hot-swap [--body tint|broken|rebind]  辅助验证运行中着色器热换`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('运行失败:', e);
  process.exit(1);
});
