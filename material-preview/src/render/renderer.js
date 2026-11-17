// 软件光栅化器。真实执行编译后的顶点/片元着色器模块，
// 实现透视校正插值、深度测试、discard（alpha test）与混合状态（alpha blend）。
// 这是交付的真实渲染路径：画面像素全部来自着色器运算，没有占位绘制。
import { Mat4, Vec2, Vec3, Vec4 } from '../shader/value-types.js';

function makeUniformAccessor(uniforms) {
  return (name) => {
    if (!(name in uniforms)) throw new Error(`着色器请求了未提供的 uniform: ${name}`);
    return uniforms[name];
  };
}

class Framebuffer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.color = new Float32Array(width * height * 4);
    this.depth = new Float32Array(width * height).fill(1);
  }
  clear(r = 0.09, g = 0.1, b = 0.13) {
    for (let i = 0; i < this.width * this.height; i++) {
      this.color[i * 4] = r; this.color[i * 4 + 1] = g;
      this.color[i * 4 + 2] = b; this.color[i * 4 + 3] = 1;
      this.depth[i] = 1;
    }
  }
}

// 由顶点布局把交错顶点数据切成属性数组
function readAttributes(mesh, vi) {
  const d = mesh.vertices;
  const o = vi * mesh.stride;
  return {
    a_position: new Vec3(d[o], d[o + 1], d[o + 2]),
    a_normal: new Vec3(d[o + 3], d[o + 4], d[o + 5]),
    a_uv: new Vec2(d[o + 6], d[o + 7]),
    a_tangent: new Vec3(d[o + 8], d[o + 9], d[o + 10]),
  };
}

export class SoftwareRenderer {
  constructor(width = 320, height = 240) {
    this.width = width;
    this.height = height;
    this.framebuffer = new Framebuffer(width, height);
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.framebuffer = new Framebuffer(w, h);
  }

  // 运行一个已编译管线变体
  render({ variant, mesh, uniforms, samplers, modelMatrix, viewProjMatrix, normalMatrix }) {
    const fb = this.framebuffer;
    const engineUniforms = {
      ...uniforms,
      u_model: modelMatrix,
      u_viewProj: viewProjMatrix,
      u_normalMat0: new Vec3(normalMatrix[0], normalMatrix[1], normalMatrix[2]),
      u_normalMat1: new Vec3(normalMatrix[3], normalMatrix[4], normalMatrix[5]),
      u_normalMat2: new Vec3(normalMatrix[6], normalMatrix[7], normalMatrix[8]),
    };

    // ---- 顶点阶段：逐顶点运行编译后的顶点着色器 ----
    const vOut = [];
    for (let vi = 0; vi < mesh.vertexCount; vi++) {
      const attrs = readAttributes(mesh, vi);
      const mod = variant.vertex.module.createShaderModule(
        makeUniformAccessor(engineUniforms), samplers, {},
      );
      mod.locals.a_position = attrs.a_position;
      mod.locals.a_normal = attrs.a_normal;
      mod.locals.a_uv = attrs.a_uv;
      mod.locals.a_tangent = attrs.a_tangent;
      mod.run();
      const L = mod.locals;
      vOut.push({
        pos: L.gl_Position,
        worldPos: L.v_worldPos,
        normal: L.v_normal,
        uv: L.v_uv,
        tangent: L.v_tangent,
      });
    }

    // ---- 图元装配 + 光栅化 ----
    const blend = variant.targetState.blend;
    const fShaderFactory = variant.fragment.module.createShaderModule;
    const fAccessor = makeUniformAccessor(uniforms);

    for (let idx = 0; idx < mesh.indices.length; idx += 3) {
      const tri = [mesh.indices[idx], mesh.indices[idx + 1], mesh.indices[idx + 2]].map((i) => vOut[i]);
      this.#rasterTriangle(tri, { fb, blend, fShaderFactory, fAccessor, samplers });
    }
  }

  #rasterTriangle(tri, ctx) {
    const { fb, blend, fShaderFactory, fAccessor, samplers } = ctx;
    // 透视除法 → 屏幕坐标
    const scr = tri.map((v) => {
      const p = v.pos;
      const w = p.d[3] || 1;
      const ndcX = p.d[0] / w, ndcY = p.d[1] / w, ndcZ = p.d[2] / w;
      return {
        x: (ndcX * 0.5 + 0.5) * fb.width,
        y: (1 - (ndcY * 0.5 + 0.5)) * fb.height,
        z: ndcZ,
        w,
      };
    });

    const minX = Math.max(0, Math.floor(Math.min(scr[0].x, scr[1].x, scr[2].x)));
    const maxX = Math.min(fb.width - 1, Math.ceil(Math.max(scr[0].x, scr[1].x, scr[2].x)));
    const minY = Math.max(0, Math.floor(Math.min(scr[0].y, scr[1].y, scr[2].y)));
    const maxY = Math.min(fb.height - 1, Math.ceil(Math.max(scr[0].y, scr[1].y, scr[2].y)));

    const area = (scr[1].x - scr[0].x) * (scr[2].y - scr[0].y)
               - (scr[2].x - scr[0].x) * (scr[1].y - scr[0].y);
    if (Math.abs(area) < 1e-9) return;

    // 1/w 透视校正权重
    const invW = scr.map((s) => 1 / s.w);

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5, cy = py + 0.5;
        const w0 = ((scr[1].x - cx) * (scr[2].y - cy) - (scr[2].x - cx) * (scr[1].y - cy)) / area;
        const w1 = ((scr[2].x - cx) * (scr[0].y - cy) - (scr[0].x - cx) * (scr[2].y - cy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        // 透视校正插值
        const persp = w0 * invW[0] + w1 * invW[1] + w2 * invW[2];
        const b0 = (w0 * invW[0]) / persp;
        const b1 = (w1 * invW[1]) / persp;
        const b2 = (w2 * invW[2]) / persp;
        const depth = b0 * scr[0].z + b1 * scr[1].z + b2 * scr[2].z;

        const pi = py * fb.width + px;
        if (depth < -1 || depth > 1) continue;
        if (depth >= fb.depth[pi]) continue;

        const vary = this.#interpolate(tri, b0, b1, b2);
        const frag = fShaderFactory(fAccessor, samplers, {});
        frag.locals.v_worldPos = vary.worldPos;
        frag.locals.v_normal = vary.normal;
        frag.locals.v_uv = vary.uv;
        frag.locals.v_tangent = vary.tangent;
        frag.run();
        if (frag.locals.__discard) continue; // AlphaTest 丢弃

        const c = frag.locals.fragColor;
        if (!c) continue;
        if (!blend.enabled) {
          fb.depth[pi] = depth;
          fb.color.set([c.d[0], c.d[1], c.d[2], 1], pi * 4);
        } else {
          // AlphaBlend：不写深度（targetState 已声明 depthWrite=false）
          const a = Math.min(Math.max(c.d[3], 0), 1);
          const o = pi * 4;
          fb.color[o] = c.d[0] * a + fb.color[o] * (1 - a);
          fb.color[o + 1] = c.d[1] * a + fb.color[o + 1] * (1 - a);
          fb.color[o + 2] = c.d[2] * a + fb.color[o + 2] * (1 - a);
          fb.color[o + 3] = Math.max(fb.color[o + 3], a);
        }
      }
    }
  }

  #interpolate(tri, b0, b1, b2) {
    const lerpVec = (key, Ctor) => {
      const a = tri[0][key], b = tri[1][key], c = tri[2][key];
      const vals = [];
      for (let i = 0; i < a.n; i++) vals.push(a.d[i] * b0 + b.d[i] * b1 + c.d[i] * b2);
      return new Ctor(...vals);
    };
    return {
      worldPos: lerpVec('worldPos', Vec3),
      normal: lerpVec('normal', Vec3),
      uv: lerpVec('uv', Vec2),
      tangent: lerpVec('tangent', Vec3),
    };
  }

  // 输出 8-bit RGBA
  toByteFrame() {
    const out = Buffer.alloc(this.width * this.height * 4);
    const s = this.framebuffer.color;
    for (let i = 0, j = 0; i < s.length; i += 4, j += 4) {
      out[j] = clampByte(s[i]);
      out[j + 1] = clampByte(s[i + 1]);
      out[j + 2] = clampByte(s[i + 2]);
      out[j + 3] = 255;
    }
    return out;
  }

  clear(...args) { this.framebuffer.clear(...args); }
}

function clampByte(v) {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return Math.round(x * 255);
}

export { Mat4 };
