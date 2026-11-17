// 程序化三角网格：position/normal/uv/tangent 交错存储 + 索引缓冲。
// 布局与 VERTEX_LAYOUT 约定一致（stride=11）。

function buildTangents(positions, uvs, indices) {
  const vertCount = positions.length / 3;
  const tan1 = new Float32Array(vertCount * 3);
  const tan2 = new Float32Array(vertCount * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const p = (idx) => [positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]];
    const t = (idx) => [uvs[idx * 2], uvs[idx * 2 + 1]];
    const [p1, p2, p3] = [p(a), p(b), p(c)];
    const [w1, w2, w3] = [t(a), t(b), t(c)];
    const x1 = p2[0] - p1[0], x2 = p3[0] - p1[0];
    const y1 = p2[1] - p1[1], y2 = p3[1] - p1[1];
    const z1 = p2[2] - p1[2], z2 = p3[2] - p1[2];
    const s1 = w2[0] - w1[0], s2 = w3[0] - w1[0];
    const tt1 = w2[1] - w1[1], tt2 = w3[1] - w1[1];
    const det = s1 * tt2 - s2 * tt1 || 1;
    const r = 1 / det;
    const tx = (tt2 * x1 - tt1 * x2) * r;
    const ty = (tt2 * y1 - tt1 * y2) * r;
    const tz = (tt2 * z1 - tt1 * z2) * r;
    for (const idx of [a, b, c]) {
      tan1[idx * 3] += tx; tan1[idx * 3 + 1] += ty; tan1[idx * 3 + 2] += tz;
    }
    void s1; void s2; void tan2;
  }
  // 正交化并归一化
  const out = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    const nx = positions[i * 3], ny = positions[i * 3 + 1], nz = positions[i * 3 + 2];
    let tx = tan1[i * 3], ty = tan1[i * 3 + 1], tz = tan1[i * 3 + 2];
    const dot = nx * tx + ny * ty + nz * tz;
    tx -= nx * dot; ty -= ny * dot; tz -= nz * dot;
    const len = Math.hypot(tx, ty, tz) || 1;
    out[i * 3] = tx / len; out[i * 3 + 1] = ty / len; out[i * 3 + 2] = tz / len;
  }
  return out;
}

function assemble(positions, normals, uvs, indices) {
  const tangents = buildTangents(positions, uvs, indices);
  const vertCount = positions.length / 3;
  const vertices = new Float32Array(vertCount * 11);
  for (let i = 0; i < vertCount; i++) {
    vertices.set(positions.slice(i * 3, i * 3 + 3), i * 11);
    vertices.set(normals.slice(i * 3, i * 3 + 3), i * 11 + 3);
    vertices.set(uvs.slice(i * 2, i * 2 + 2), i * 11 + 6);
    vertices.set(tangents.slice(i * 3, i * 3 + 3), i * 11 + 8);
  }
  return { vertices, indices: Uint32Array.from(indices), vertexCount: vertCount, stride: 11 };
}

function makeSphere(seg = 40, rings = 24) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const theta = (s / seg) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      positions.push(x, y, z);
      normals.push(x, y, z);
      uvs.push(s / seg, 1 - r / rings);
    }
  }
  const row = seg + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * row + s, b = a + 1, c = a + row, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return assemble(Float32Array.from(positions), Float32Array.from(normals), Float32Array.from(uvs), indices);
}

function makeCube() {
  const positions = [], normals = [], uvs = [], indices = [];
  const faces = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  for (const f of faces) {
    const base = positions.length / 3;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const uvCorners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let k = 0; k < 4; k++) {
      const [cu, cv] = corners[k];
      positions.push(
        f.n[0] * 0.85 + f.u[0] * cu * 0.85 + f.v[0] * cv * 0.85,
        f.n[1] * 0.85 + f.u[1] * cu * 0.85 + f.v[1] * cv * 0.85,
        f.n[2] * 0.85 + f.u[2] * cu * 0.85 + f.v[2] * cv * 0.85,
      );
      normals.push(...f.n);
      uvs.push(...uvCorners[k]);
    }
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return assemble(Float32Array.from(positions), Float32Array.from(normals), Float32Array.from(uvs), indices);
}

function makeTorus(R = 0.75, r = 0.32, major = 40, minor = 20) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let i = 0; i <= major; i++) {
    const u = (i / major) * Math.PI * 2;
    for (let j = 0; j <= minor; j++) {
      const v = (j / minor) * Math.PI * 2;
      const x = (R + r * Math.cos(v)) * Math.cos(u);
      const y = r * Math.sin(v);
      const z = (R + r * Math.cos(v)) * Math.sin(u);
      positions.push(x, y, z);
      normals.push(Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u));
      uvs.push(i / major, j / minor);
    }
  }
  const row = minor + 1;
  for (let i = 0; i < major; i++) {
    for (let j = 0; j < minor; j++) {
      const a = i * row + j, b = a + row, c = a + 1, d = b + 1;
      indices.push(a, b, c, c, b, d);
    }
  }
  return assemble(Float32Array.from(positions), Float32Array.from(normals), Float32Array.from(uvs), indices);
}

export function createMesh(name) {
  switch (name) {
    case 'sphere': return { name, ...makeSphere() };
    case 'cube': return { name, ...makeCube() };
    case 'torus': return { name, ...makeTorus() };
    default: throw new Error(`未知网格: ${name}`);
  }
}

export const MESH_NAMES = ['sphere', 'cube', 'torus'];
