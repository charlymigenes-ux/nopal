/**
 * Renderer WebGL2 para trayectorias G-code.
 * - Geometría en bloques (VBO por chunk) para poder dibujar mientras se parsea.
 * - Un solo draw call por bloque: soporta millones de segmentos a 60 fps.
 * - Rango de dibujo por índice de segmento -> simulación gratis (el orden del
 *   buffer es el orden del archivo).
 */

const VS = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec4 a_attr;              // x: potencia, y: tipo(0 viaje /1 trabajo), z: capa, w: velocidad
uniform vec2  u_res;
uniform float u_scale;       // px por mm
uniform vec2  u_trans;       // px
uniform float u_layerVis[32];
uniform float u_showTravel;
out vec4 v_attr;
out float v_drop;
void main() {
  float sx = u_trans.x + a_pos.x * u_scale;
  float sy = u_trans.y - a_pos.y * u_scale;
  gl_Position = vec4((sx / u_res.x) * 2.0 - 1.0, 1.0 - (sy / u_res.y) * 2.0, 0.0, 1.0);
  v_attr = a_attr;
  int li = int(a_attr.z * 255.0 + 0.5);
  float vis = u_layerVis[li];
  bool travel = a_attr.y * 255.0 < 0.5;
  v_drop = (travel ? (1.0 - u_showTravel) : (1.0 - vis));
}`;

const FS = `#version 300 es
precision highp float;
in vec4 v_attr;
in float v_drop;
uniform int   u_mode;        // 0 capa, 1 potencia, 2 velocidad
uniform vec3  u_layerCol[32];
uniform vec3  u_travelCol;
uniform float u_feedRescale;
uniform float u_dim;
out vec4 outColor;

vec3 ramp(float t) {           // azul -> cian -> amarillo -> rojo
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.15, 0.35, 0.95);
  vec3 c1 = vec3(0.10, 0.85, 0.90);
  vec3 c2 = vec3(0.98, 0.85, 0.20);
  vec3 c3 = vec3(0.95, 0.25, 0.20);
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.67) return mix(c1, c2, (t - 0.34) / 0.33);
  return mix(c2, c3, (t - 0.67) / 0.33);
}

void main() {
  if (v_drop > 0.5) discard;
  bool travel = v_attr.y * 255.0 < 0.5;
  vec3 col;
  float a = 1.0;
  if (travel) { col = u_travelCol; a = 0.55; }
  else if (u_mode == 1) col = ramp(v_attr.x);
  else if (u_mode == 2) col = ramp(clamp(v_attr.w * u_feedRescale, 0.0, 1.0));
  else {
    int li = int(v_attr.z * 255.0 + 0.5);
    col = u_layerCol[li];
    col *= mix(0.45, 1.0, v_attr.x);   // la potencia modula el brillo
  }
  outColor = vec4(col * u_dim, a * u_dim);
}`;

export const PALETTE = [
  '#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316', '#ec4899',
  '#14b8a6', '#8b5cf6', '#84cc16', '#f59e0b', '#0ea5e9', '#d946ef', '#10b981', '#fb7185',
  '#60a5fa', '#facc15', '#4ade80', '#c084fc', '#38bdf8', '#fdba74', '#f472b6', '#2dd4bf',
  '#a3e635', '#fcd34d', '#93c5fd', '#e879f9', '#5eead4', '#bef264', '#fca5a5', '#cbd5e1'
];

function hexToRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true, alpha: true, depth: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 no disponible en este navegador');
    this.gl = gl;

    this.prog = link(gl, VS, FS);
    gl.useProgram(this.prog);
    this.loc = {
      res: gl.getUniformLocation(this.prog, 'u_res'),
      scale: gl.getUniformLocation(this.prog, 'u_scale'),
      trans: gl.getUniformLocation(this.prog, 'u_trans'),
      mode: gl.getUniformLocation(this.prog, 'u_mode'),
      travelCol: gl.getUniformLocation(this.prog, 'u_travelCol'),
      showTravel: gl.getUniformLocation(this.prog, 'u_showTravel'),
      feedRescale: gl.getUniformLocation(this.prog, 'u_feedRescale'),
      dim: gl.getUniformLocation(this.prog, 'u_dim'),
      layerVis: gl.getUniformLocation(this.prog, 'u_layerVis'),
      layerCol: gl.getUniformLocation(this.prog, 'u_layerCol')
    };
    this.aPos = gl.getAttribLocation(this.prog, 'a_pos');
    this.aAttr = gl.getAttribLocation(this.prog, 'a_attr');

    this.chunks = [];
    this.totalSegments = 0;
    this.mode = 0;
    this.showTravel = true;
    this.drawLimit = Infinity;   // nº de segmentos a dibujar (simulación)
    this.feedRescale = 1;
    this.dim = 1;
    this.layerVis = new Float32Array(32).fill(1);
    this.layerCol = new Float32Array(32 * 3);
    this.setLayerColors(PALETTE);
    this.travelCol = hexToRgb('#7b8794');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setLayerColors(hexList) {
    for (let i = 0; i < 32; i++) {
      const c = hexToRgb(hexList[i % hexList.length]);
      this.layerCol[i * 3] = c[0]; this.layerCol[i * 3 + 1] = c[1]; this.layerCol[i * 3 + 2] = c[2];
    }
  }

  addChunk(pos, attr, nSeg) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bp = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bp);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    const ba = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ba);
    gl.bufferData(gl.ARRAY_BUFFER, attr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.aAttr);
    gl.vertexAttribPointer(this.aAttr, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindVertexArray(null);
    this.chunks.push({ vao, nSeg, start: this.totalSegments, bp, ba });
    this.totalSegments += nSeg;
  }

  clear() {
    const gl = this.gl;
    for (const c of this.chunks) {
      gl.deleteVertexArray(c.vao); gl.deleteBuffer(c.bp); gl.deleteBuffer(c.ba);
    }
    this.chunks = [];
    this.totalSegments = 0;
    this.drawLimit = Infinity;
  }

  /** @param {{scale:number, tx:number, ty:number}} view  px por mm y traslación en px CSS */
  draw(view, dpr) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.chunks.length) return;

    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.res, w, h);
    gl.uniform1f(this.loc.scale, view.scale * dpr);
    gl.uniform2f(this.loc.trans, view.tx * dpr, view.ty * dpr);
    gl.uniform1i(this.loc.mode, this.mode);
    gl.uniform1f(this.loc.showTravel, this.showTravel ? 1 : 0);
    gl.uniform1f(this.loc.feedRescale, this.feedRescale);
    gl.uniform1f(this.loc.dim, this.dim);
    gl.uniform3fv(this.loc.travelCol, this.travelCol);
    gl.uniform1fv(this.loc.layerVis, this.layerVis);
    gl.uniform3fv(this.loc.layerCol, this.layerCol);

    const limit = this.drawLimit;
    for (const c of this.chunks) {
      if (c.start >= limit) break;
      const count = Math.min(c.nSeg, limit - c.start);
      gl.bindVertexArray(c.vao);
      gl.drawArrays(gl.LINES, 0, count * 2);
    }
    gl.bindVertexArray(null);
  }
}

function link(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
