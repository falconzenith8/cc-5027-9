// 材质着色器模板。
// 结构选项（影响编译）通过 #define + 条件编译进入源码；
// 普通数值参数（粗糙度、金属度、颜色、光照强度…）是 uniform，运行时赋值，
// 改它们只更新 uniform，绝不触发重新编译。

export const VERTEX_SHADER = `#version 300 es
// 顶点着色器：所有结构变体共用同一份顶点源码（布局变化由 STRUCT 约定保证）
precision highp float;

in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;
in vec3 a_tangent;

uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform vec3 u_normalMat0; // 法线矩阵按行传入（引擎计算 (M^-1)^T 的 3x3）
uniform vec3 u_normalMat1;
uniform vec3 u_normalMat2;

out vec3 v_worldPos;
out vec3 v_normal;
out vec2 v_uv;
out vec3 v_tangent;

void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_worldPos = world.xyz;
  // 法线矩阵手工基变换（三行分别与法线点积）
  vec3 nn = vec3(
    dot(u_normalMat0, a_normal),
    dot(u_normalMat1, a_normal),
    dot(u_normalMat2, a_normal)
  );
  v_normal = normalize(nn);
  v_tangent = normalize((u_model * vec4(a_tangent, 0.0)).xyz);
  v_uv = a_uv;
  gl_Position = u_viewProj * world;
}
`;

// 结构开关约定（变体的"目标状态"）：
//   NORMAL_MAP   0/1  是否采样法线贴图并重建切线空间法线
//   BLEND_MODE   0/1/2  0=不透明 1=AlphaTest(discard) 2=AlphaBlend
//   LIGHTING     0/1/2  0=无光照(纯自发光) 1=Lambert 2=Blinn-Phong+金属粗糙工作流
// 这些宏的值不同 → 预处理源码不同 → 缓存 key 不同 → 独立编译产物。
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

#ifndef NORMAL_MAP
#define NORMAL_MAP 0
#endif
#ifndef BLEND_MODE
#define BLEND_MODE 0
#endif
#ifndef LIGHTING
#define LIGHTING 2
#endif

in vec3 v_worldPos;
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_tangent;

uniform vec4 u_baseColor;
uniform float u_roughness;   // 数值参数：改动不重编译
uniform float u_metallic;    // 数值参数：改动不重编译
uniform float u_emissive;    // 数值参数：改动不重编译
uniform vec3 u_cameraPos;
uniform vec3 u_lightDir;     // 指向光源的方向
uniform vec3 u_lightColor;
uniform float u_lightIntensity;
uniform float u_alphaCutoff; // 数值参数：改动不重编译
uniform float u_normalScale; // 数值参数：改动不重编译

uniform sampler2D u_baseColorTex;
#if NORMAL_MAP
uniform sampler2D u_normalTex;
#endif
uniform sampler2D u_occlusionTex;

out vec4 fragColor;

vec3 perturbNormal(vec3 n, vec3 t, vec3 sampledNormal, float scale) {
  vec3 mapN = sampledNormal * 2.0 - 1.0;
  mapN.xy = mapN.xy * scale;
  vec3 b = cross(n, t);
  // 切线空间 → 世界空间的手工基变换（避免依赖 mat3 构造器）
  vec3 worldN = t * mapN.x + b * mapN.y + n * mapN.z;
  return normalize(worldN);
}

void main() {
  vec4 texColor = texture(u_baseColorTex, v_uv);
  vec4 albedo4 = texColor * u_baseColor;

#if BLEND_MODE == 1
  // AlphaTest：片元丢弃，深度写入保持开启 —— 与 AlphaBlend 是不同的管线状态
  if (albedo4.a < u_alphaCutoff) {
    discard;
  }
  albedo4.a = 1.0;
#endif

  vec3 N = normalize(v_normal);
#if NORMAL_MAP
  vec3 sampledN = texture(u_normalTex, v_uv).xyz;
  N = perturbNormal(N, normalize(v_tangent), sampledN, u_normalScale);
#endif

  vec3 albedo = albedo4.rgb;
  float occlusion = texture(u_occlusionTex, v_uv).r;

#if LIGHTING == 0
  // 无光照：自发光直通
  vec3 color = albedo * (0.25 + u_emissive);
#elif LIGHTING == 1
  // Lambert 漫反射
  vec3 L = normalize(u_lightDir);
  float ndl = max(dot(N, L), 0.0);
  vec3 color = albedo * u_lightColor * u_lightIntensity * ndl * occlusion;
  color = color + albedo * 0.08;
#else
  // Blinn-Phong + 金属/粗糙工作流
  vec3 L = normalize(u_lightDir);
  vec3 V = normalize(u_cameraPos - v_worldPos);
  vec3 H = normalize(L + V);
  float ndl = max(dot(N, L), 0.0);
  float ndh = max(dot(N, H), 0.0);

  vec3 diffuseColor = albedo * (1.0 - u_metallic);
  vec3 specularColor = mix(vec3(0.04), albedo, u_metallic);
  float shininess = mix(128.0, 8.0, clamp(u_roughness, 0.0, 1.0));

  vec3 diffuse = diffuseColor * u_lightColor * u_lightIntensity * ndl;
  vec3 specular = specularColor * u_lightColor * u_lightIntensity
                * pow(ndh, shininess) * ndl;
  vec3 ambient = albedo * 0.12 * occlusion;
  vec3 emissiveCol = albedo * u_emissive;
  vec3 color = ambient + (diffuse + specular) * occlusion + emissiveCol;
#endif

  float outAlpha = 1.0;
#if BLEND_MODE == 2
  outAlpha = albedo4.a;
#endif
  fragColor = vec4(color, outAlpha);
}
`;

// 结构选项的合法域：管线缓存据此防止"结构不同的材质共用同一缓存条目"
export const STRUCT_FIELDS = {
  NORMAL_MAP: { values: [0, 1], label: '法线贴图' },
  BLEND_MODE: { values: [0, 1, 2], labels: { 0: '不透明', 1: 'Alpha 测试', 2: 'Alpha 混合' }, label: '透明模式' },
  LIGHTING: { values: [0, 1, 2], labels: { 0: '无光照', 1: 'Lambert', 2: 'Blinn-Phong PBR' }, label: '光照模型' },
};

// 数值参数（uniform）清单与默认值 —— 与结构选项严格分开
export const NUMERIC_PARAMS = {
  u_baseColor: { type: 'vec4', default: [0.8, 0.8, 0.85, 1.0], label: '基础色', kind: 'color' },
  u_roughness: { type: 'float', default: 0.5, min: 0.02, max: 1, label: '粗糙度' },
  u_metallic: { type: 'float', default: 0.0, min: 0, max: 1, label: '金属度' },
  u_emissive: { type: 'float', default: 0.0, min: 0, max: 2, label: '自发光' },
  u_lightIntensity: { type: 'float', default: 1.1, min: 0, max: 3, label: '光照强度' },
  u_alphaCutoff: { type: 'float', default: 0.5, min: 0, max: 1, label: 'Alpha 截断' },
  u_normalScale: { type: 'float', default: 1.0, min: 0, max: 2, label: '法线强度' },
};

// 引擎级 uniform（不暴露给材质数值面板）
export const ENGINE_UNIFORMS = ['u_model', 'u_viewProj', 'u_normalMat', 'u_cameraPos', 'u_lightDir', 'u_lightColor'];

// 顶点布局：所有变体必须匹配的属性约定（布局是缓存身份的一部分）
export const VERTEX_LAYOUT = Object.freeze({
  stride: 11, // position(3) normal(3) uv(2) tangent(3)
  attributes: [
    { name: 'a_position', offset: 0, size: 3, type: 'vec3' },
    { name: 'a_normal', offset: 3, size: 3, type: 'vec3' },
    { name: 'a_uv', offset: 6, size: 2, type: 'vec2' },
    { name: 'a_tangent', offset: 8, size: 3, type: 'vec3' },
  ],
});
