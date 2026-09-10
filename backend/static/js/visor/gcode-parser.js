/**
 * Núcleo de parseo de G-code (se ejecuta dentro del Web Worker).
 * Optimizado para velocidad: escáner de caracteres sin regex ni split(),
 * y volcado por bloques (chunks) para poder dibujar mientras se lee el archivo.
 *
 * Salida por chunk:
 *   pos    Float32Array(4 * nSeg)  -> x1,y1,x2,y2
 *   attr   Uint8Array(8 * nSeg)    -> por vértice: [potencia, tipo, capa, velocidad]
 *
 * tipo: 0 = desplazamiento (G0 / láser apagado), 1 = trabajo (corte/grabado)
 */

export const FEED_CAP = 30000; // mm/min de referencia para normalizar velocidad a 0..255
const CHUNK_SEGMENTS = 120000; // segmentos por bloque enviado al hilo principal
const ARC_TOLERANCE = 0.02;    // mm de flecha máxima al aplanar G2/G3
const MAX_LAYERS = 32;

export function createState() {
  return {
    x: 0, y: 0, z: 0,
    absolute: true,      // G90
    absoluteIJK: false,  // G90.1
    unitScale: 1,        // G21 mm / G20 pulgadas
    feed: 0,
    power: 0,
    maxPowerSeen: 0,
    laserOn: false,      // M3/M4 activos
    motion: 0,           // G modal de movimiento
    offX: 0, offY: 0,    // G92
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    distCut: 0, distTravel: 0, seconds: 0,
    segments: 0, lines: 0,
    maxFeed: 0,
    layerIdx: 0,
    layers: [],          // {name, power, feed, dist, seconds, segments}
    layerKey: new Map(),
    pendingLayerName: null,   // comentario de capa recién leído
    currentLayerName: null,   // capa vigente hasta el próximo comentario
    tail: ''             // resto de línea incompleta entre trozos de texto
  };
}

export class ChunkWriter {
  constructor(emit) {
    this.emit = emit;
    this.pos = new Float32Array(CHUNK_SEGMENTS * 4);
    this.attr = new Uint8Array(CHUNK_SEGMENTS * 8);
    this.sec = new Float32Array(CHUNK_SEGMENTS);   // duración estimada por segmento
    this.n = 0;
  }
  push(x1, y1, x2, y2, power, kind, layer, feedN, secs) {
    const p = this.n * 4, a = this.n * 8;
    this.pos[p] = x1; this.pos[p + 1] = y1; this.pos[p + 2] = x2; this.pos[p + 3] = y2;
    this.attr[a] = power; this.attr[a + 1] = kind; this.attr[a + 2] = layer; this.attr[a + 3] = feedN;
    this.attr[a + 4] = power; this.attr[a + 5] = kind; this.attr[a + 6] = layer; this.attr[a + 7] = feedN;
    this.sec[this.n] = secs;
    if (++this.n >= CHUNK_SEGMENTS) this.flush();
  }
  flush() {
    if (!this.n) return;
    const pos = this.pos.slice(0, this.n * 4);
    const attr = this.attr.slice(0, this.n * 8);
    const sec = this.sec.slice(0, this.n);
    this.emit(pos, attr, sec, this.n);
    this.n = 0;
  }
}

/** Detecta nombre de capa en comentarios típicos (LightBurn, Lightburn-GRBL, LaserGRBL). */
function readComment(st, c) {
  const m = /(?:^|\s)(?:layer|capa)\s*[:#]?\s*(.+)$/i.exec(c);
  if (m) st.pendingLayerName = m[1].trim();
}

function layerFor(st) {
  // Un "; Layer C29" vale hasta el siguiente comentario de capa, no sólo para
  // el primer movimiento: antes el resto del archivo caía en una capa
  // inventada "S650 / F2200" y se veían dos capas con los mismos valores.
  if (st.pendingLayerName !== null) {
    st.currentLayerName = st.pendingLayerName;
    st.pendingLayerName = null;
  }
  const name = st.currentLayerName;
  const key = name !== null ? 'n:' + name : 's:' + st.power + '/' + st.feed;
  let idx = st.layerKey.get(key);
  if (idx === undefined) {
    if (st.layers.length >= MAX_LAYERS) return st.layerIdx;
    idx = st.layers.length;
    st.layerKey.set(key, idx);
    st.layers.push({
      name: name || 'S' + st.power + ' / F' + st.feed,
      power: st.power, feed: st.feed, dist: 0, seconds: 0, segments: 0
    });
  } else if (name !== null) {
    const L = st.layers[idx];
    if (st.power > L.power) L.power = st.power;
    if (st.feed && (!L.feed || st.feed < L.feed)) L.feed = st.feed;
  }
  st.layerIdx = idx;
  return idx;
}

/**
 * Procesa un trozo de texto manteniendo el estado entre llamadas.
 * @param {string} text fragmento (puede cortar una línea por la mitad)
 * @param {object} st   estado del parser
 * @param {ChunkWriter} w
 * @param {boolean} last true si es el último trozo del archivo
 */
export function parseText(text, st, w, last) {
  if (st.tail) { text = st.tail + text; st.tail = ''; }
  const n = text.length;
  let i = 0;

  while (i < n) {
    let eol = text.indexOf('\n', i);
    if (eol === -1) {
      if (!last) { st.tail = text.slice(i); return; }
      eol = n;
    }

    let g = -1, mCode = -1;
    let hasX = false, hasY = false, hasZ = false, hasI = false, hasJ = false, hasR = false;
    let vX = 0, vY = 0, vZ = 0, vI = 0, vJ = 0, vR = 0;

    let p = i;
    while (p < eol) {
      const ch = text.charCodeAt(p);
      if (ch === 32 || ch === 9 || ch === 13) { p++; continue; }
      if (ch === 59) { readComment(st, text.slice(p + 1, eol)); break; }          // ;
      if (ch === 40) {                                                            // (
        const close = text.indexOf(')', p);
        const end = (close === -1 || close > eol) ? eol : close;
        readComment(st, text.slice(p + 1, end));
        p = end + 1; continue;
      }
      let letter = ch;
      if (letter >= 97 && letter <= 122) letter -= 32;
      p++;
      while (p < eol && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p++;
      let neg = false;
      let c = text.charCodeAt(p);
      if (c === 45) { neg = true; p++; c = text.charCodeAt(p); }
      else if (c === 43) { p++; c = text.charCodeAt(p); }
      let val = 0, digits = 0;
      while (p < eol) {
        c = text.charCodeAt(p);
        if (c >= 48 && c <= 57) { val = val * 10 + (c - 48); p++; digits++; } else break;
      }
      if (c === 46) {
        p++;
        let frac = 0.1;
        while (p < eol) {
          c = text.charCodeAt(p);
          if (c >= 48 && c <= 57) { val += (c - 48) * frac; frac *= 0.1; p++; digits++; } else break;
        }
      }
      if (!digits) continue;
      if (neg) val = -val;

      switch (letter) {
        case 71: g = val; break;               // G
        case 77: mCode = val; break;           // M
        case 88: vX = val; hasX = true; break; // X
        case 89: vY = val; hasY = true; break; // Y
        case 90: vZ = val; hasZ = true; break; // Z
        case 73: vI = val; hasI = true; break; // I
        case 74: vJ = val; hasJ = true; break; // J
        case 82: vR = val; hasR = true; break; // R
        case 70: st.feed = val; break;         // F
        case 83: st.power = val; break;        // S
        default: break;
      }
    }

    st.lines++;
    i = eol + 1;

    if (g === 90) { st.absolute = true; continue; }
    if (g === 91) { st.absolute = false; continue; }
    if (g === 20) { st.unitScale = 25.4; continue; }
    if (g === 21) { st.unitScale = 1; continue; }
    if (g === 92) {
      const s = st.unitScale;
      if (hasX) st.offX = st.x - vX * s;
      if (hasY) st.offY = st.y - vY * s;
      continue;
    }
    if (mCode === 3 || mCode === 4) st.laserOn = true;
    else if (mCode === 5 || mCode === 2 || mCode === 30) st.laserOn = false;

    if (g >= 0 && g <= 3) st.motion = g;
    else if (g > 3) continue; // G4, G28, G54... no generan trazo
    if (!(hasX || hasY || hasZ || hasI || hasJ)) continue;

    const motion = st.motion;
    const s = st.unitScale;
    const px = st.x, py = st.y;
    let nx = px, ny = py, nz = st.z;
    if (st.absolute) {
      if (hasX) nx = vX * s + st.offX;
      if (hasY) ny = vY * s + st.offY;
      if (hasZ) nz = vZ * s;
    } else {
      if (hasX) nx = px + vX * s;
      if (hasY) ny = py + vY * s;
      if (hasZ) nz = st.z + vZ * s;
    }

    if (st.power > st.maxPowerSeen) st.maxPowerSeen = st.power;
    if (st.feed > st.maxFeed) st.maxFeed = st.feed;

    const cutting = motion !== 0 && st.laserOn && st.power > 0;
    const kind = cutting ? 1 : 0;
    const layer = cutting ? layerFor(st) : st.layerIdx;
    const powB = st.maxPowerSeen > 0
      ? Math.min(255, Math.round(255 * st.power / st.maxPowerSeen)) : 0;
    const feedB = Math.min(255, Math.round(255 * (st.feed / FEED_CAP)));

    if (motion === 2 || motion === 3) {
      emitArc(st, w, px, py, nx, ny, vI * s, vJ * s, hasR ? vR * s : null,
        hasI || hasJ, motion === 2, powB, kind, layer, feedB);
    } else {
      addSeg(st, w, px, py, nx, ny, powB, kind, layer, feedB);
    }

    st.x = nx; st.y = ny; st.z = nz;
  }

  if (last && st.tail) { const t = st.tail; st.tail = ''; parseText(t + '\n', st, w, true); }
}

function addSeg(st, w, x1, y1, x2, y2, powB, kind, layer, feedB) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;

  if (x1 < st.minX) st.minX = x1; if (x1 > st.maxX) st.maxX = x1;
  if (y1 < st.minY) st.minY = y1; if (y1 > st.maxY) st.maxY = y1;
  if (x2 < st.minX) st.minX = x2; if (x2 > st.maxX) st.maxX = x2;
  if (y2 < st.minY) st.minY = y2; if (y2 > st.maxY) st.maxY = y2;

  if (kind) st.distCut += len; else st.distTravel += len;
  const f = st.feed > 0 ? st.feed : 1000;
  const secs = len / (f / 60);
  st.seconds += secs;
  const L = st.layers[layer];
  if (L && kind) { L.dist += len; L.seconds += secs; L.segments++; }
  st.segments++;
  w.push(x1, y1, x2, y2, powB, kind, layer, feedB, secs);
}

function emitArc(st, w, x1, y1, x2, y2, i, j, r, hasIJ, cw, powB, kind, layer, feedB) {
  let cx, cy;
  if (hasIJ) {
    cx = (st.absoluteIJK ? 0 : x1) + i;
    cy = (st.absoluteIJK ? 0 : y1) + j;
  } else if (r !== null) {
    const dx = x2 - x1, dy = y2 - y1;
    const d = Math.hypot(dx, dy);
    if (!d) { addSeg(st, w, x1, y1, x2, y2, powB, kind, layer, feedB); return; }
    let h = r * r - (d / 2) * (d / 2);
    h = h > 0 ? Math.sqrt(h) : 0;
    const sign = (r < 0) === cw ? 1 : -1;
    cx = x1 + dx / 2 + sign * h * (-dy / d);
    cy = y1 + dy / 2 + sign * h * (dx / d);
  } else {
    addSeg(st, w, x1, y1, x2, y2, powB, kind, layer, feedB); return;
  }

  const rad = Math.hypot(x1 - cx, y1 - cy);
  if (!isFinite(rad) || rad < 1e-9) { addSeg(st, w, x1, y1, x2, y2, powB, kind, layer, feedB); return; }
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const a2 = Math.atan2(y2 - cy, x2 - cx);
  let sweep = a2 - a1;
  if (cw) { while (sweep >= 0) sweep -= Math.PI * 2; }
  else { while (sweep <= 0) sweep += Math.PI * 2; }
  if (Math.abs(sweep) < 1e-9) sweep = cw ? -Math.PI * 2 : Math.PI * 2;

  const stepAng = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE / rad)));
  let steps = Math.ceil(Math.abs(sweep) / (stepAng || 0.2));
  steps = Math.max(2, Math.min(2000, steps));
  let px = x1, py = y1;
  for (let k = 1; k <= steps; k++) {
    const a = a1 + sweep * (k / steps);
    const qx = k === steps ? x2 : cx + rad * Math.cos(a);
    const qy = k === steps ? y2 : cy + rad * Math.sin(a);
    addSeg(st, w, px, py, qx, qy, powB, kind, layer, feedB);
    px = qx; py = qy;
  }
}
