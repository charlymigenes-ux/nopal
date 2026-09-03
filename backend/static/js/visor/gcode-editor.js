/**
 * Ediciones de último momento sobre el G-code.
 *
 * Reescribe el TEXTO original (no la geometría dibujada), así que lo que se ve
 * en pantalla y lo que se guarda son el mismo archivo. Las líneas que no llevan
 * coordenadas ni S/F se copian tal cual, con sus comentarios, para no perder
 * nada de la cabecera del post-procesador.
 *
 * Las operaciones se aplican SIEMPRE sobre el original, nunca en cadena: así
 * ninguna edición es destructiva y se puede volver atrás cambiando un campo.
 */

export const OPS_VACIAS = {
  offsetX: 0, offsetY: 0,
  scale: 100,            // %
  rotate: 0,             // grados
  mirrorX: false, mirrorY: false,
  toOrigin: false,       // llevar la esquina inferior izquierda a 0,0
  power: { mode: 'mul', value: 100, layer: '*' },   // mul = %, set = valor fijo
  feed: { mode: 'mul', value: 100, layer: '*' },
  passes: 1,
  frame: { enabled: false, power: 5, feed: 3000, repeat: 1, margin: 0 },
  header: '', footer: ''
};

export function hayEdiciones(o) {
  return !!(o.offsetX || o.offsetY || o.scale !== 100 || o.rotate || o.mirrorX ||
    o.mirrorY || o.toOrigin || o.passes > 1 || o.frame.enabled ||
    (o.power.mode === 'mul' ? o.power.value !== 100 : true) ||
    (o.feed.mode === 'mul' ? o.feed.value !== 100 : true) ||
    o.header.trim() || o.footer.trim());
}

/**
 * @param {string} src  texto G-code original
 * @param {object} ops
 * @returns {{text:string, bounds:object|null, warnings:string[]}}
 */
export function applyEdits(src, ops) {
  const o = Object.assign({}, OPS_VACIAS, ops);
  o.power = Object.assign({}, OPS_VACIAS.power, ops.power);
  o.feed = Object.assign({}, OPS_VACIAS.feed, ops.feed);
  o.frame = Object.assign({}, OPS_VACIAS.frame, ops.frame);

  const warnings = [];
  const k = (o.scale || 100) / 100;
  const rad = (o.rotate || 0) * Math.PI / 180;
  const sx = o.mirrorX ? -1 : 1, sy = o.mirrorY ? -1 : 1;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // matriz lineal: espejo -> escala -> rotación
  const lin = {
    a: k * cos * sx, b: -k * sin * sy,
    c: k * sin * sx, d: k * cos * sy
  };
  const flipArcs = (sx * sy) < 0;

  // 1ª pasada: medir con la transformación lineal, sin desplazamiento
  const m = run(src, o, lin, 0, 0, null, warnings);

  // desplazamiento final (incluye "llevar a origen")
  let offX = o.offsetX || 0, offY = o.offsetY || 0;
  if (o.toOrigin && m.bounds) { offX -= m.bounds.minX; offY -= m.bounds.minY; }

  // 2ª pasada: escribir
  const out = [];
  const r = run(src, o, lin, offX, offY, out, warnings, flipArcs);

  let lines = out;

  // pasadas adicionales: se repite el cuerpo de movimiento
  const passes = Math.max(1, Math.round(o.passes || 1));
  if (passes > 1 && r.firstMotion >= 0 && r.lastMotion >= r.firstMotion) {
    const body = lines.slice(r.firstMotion, r.lastMotion + 1);
    const rep = [];
    for (let i = 2; i <= passes; i++) {
      rep.push('; --- pasada ' + i + ' de ' + passes + ' (añadida por el visor) ---');
      for (const l of body) rep.push(l);
    }
    lines = lines.slice(0, r.lastMotion + 1).concat(rep, lines.slice(r.lastMotion + 1));
    if (!r.absolute) warnings.push('Pasadas en modo relativo (G91): se repite el cuerpo tal cual; ' +
      'sólo es correcto si el programa vuelve a su punto de inicio.');
  }

  // desplazamiento en modo relativo: no basta con sumar, hay que insertar el movimiento
  if (!r.absolute && (offX || offY) && r.firstMotion >= 0) {
    const pre = ['; --- desplazamiento añadido por el visor ---',
      'G91', 'G0 X' + fmt(offX) + ' Y' + fmt(offY)];
    const post = ['; --- retorno del desplazamiento ---',
      'G91', 'G0 X' + fmt(-offX) + ' Y' + fmt(-offY)];
    lines = lines.slice(0, r.firstMotion).concat(pre, lines.slice(r.firstMotion), post);
    r.firstMotion += pre.length;
  }

  // encuadre previo
  if (o.frame.enabled) {
    // En absoluto el encuadre va en coordenadas finales; en relativo se traza
    // desde donde ya quedó el cabezal (tras el movimiento de desplazamiento),
    // así que se usan las cotas SIN desplazar.
    const b = r.absolute ? boundsFinal(m.bounds, offX, offY) : m.bounds;
    if (b) {
      const blk = bloqueEncuadre(b, o.frame, r.absolute, r.laserAtFirst);
      const at = Math.max(0, r.firstMotion);
      lines = lines.slice(0, at).concat(blk, lines.slice(at));
    } else warnings.push('No se pudo calcular el encuadre: el archivo no tiene movimientos.');
  }

  if (o.header && o.header.trim()) {
    lines = ['; --- cabecera añadida por el visor ---']
      .concat(o.header.trim().split(/\r?\n/), lines);
  }
  if (o.footer && o.footer.trim()) {
    lines = lines.concat(['; --- pie añadido por el visor ---'], o.footer.trim().split(/\r?\n/));
  }

  if (k !== 1 && r.arcs > 0 && (o.mirrorX !== o.mirrorY)) {
    warnings.push('El archivo tiene arcos G2/G3 y se aplicó espejo + escala: revisa el resultado.');
  }

  return {
    text: lines.join('\n') + '\n',
    bounds: boundsFinal(m.bounds, offX, offY),
    warnings
  };
}

function boundsFinal(b, ox, oy) {
  if (!b) return null;
  return { minX: b.minX + ox, minY: b.minY + oy, maxX: b.maxX + ox, maxY: b.maxY + oy };
}

/* --------------------------------------------------------------- pasada */

const RE_INTERES = /[XYIJRSFxyijrsf]/;

function run(src, o, lin, offX, offY, out, warnings, flipArcs) {
  const st = {
    x: 0, y: 0,          // posición transformada
    ox: 0, oy: 0,        // posición en coordenadas del archivo original
    wx: 0, wy: 0,        // posición realmente escrita (evita deriva por redondeo)
    absolute: true, unit: 1, motion: 0,
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    firstMotion: -1, lastMotion: -1, arcs: 0,
    layerName: null, power: 0, feed: 0, sawRelative: false,
    laserMode: 0, laserAtFirst: 0
  };

  const lines = src.split('\n');
  for (let li = 0; li < lines.length; li++) {
    let raw = lines[li];
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);

    // comentario al final / línea de sólo comentario
    let code = raw, comment = '';
    const ci = raw.indexOf(';');
    if (ci >= 0) { code = raw.slice(0, ci); comment = raw.slice(ci); }
    if (comment) {
      const mm = /(?:^|\s)(?:layer|capa)\s*[:#]?\s*(.+)$/i.exec(comment.slice(1));
      if (mm) st.layerName = mm[1].trim();
    }

    const words = tokenize(code);
    if (!words.length) { if (out) out.push(raw); continue; }

    // modales
    let g = -1, mCode = -1;
    for (const w of words) {
      if (w.L === 'G') { g = w.v; if (w.v === 90) st.absolute = true; else if (w.v === 91) { st.absolute = false; st.sawRelative = true; } else if (w.v === 20) st.unit = 25.4; else if (w.v === 21) st.unit = 1; }
      else if (w.L === 'M') {
        mCode = w.v;
        if (w.v === 3 || w.v === 4) st.laserMode = w.v;
        else if (w.v === 5) st.laserMode = 0;
      }
    }
    if (g >= 0 && g <= 3) st.motion = g;

    const tieneCoord = words.some(w => 'XYIJR'.includes(w.L));
    const tieneSF = words.some(w => w.L === 'S' || w.L === 'F');

    if (!tieneCoord && !tieneSF) { if (out) out.push(raw); continue; }
    if (!RE_INTERES.test(code)) { if (out) out.push(raw); continue; }

    // --- valores S/F actuales (para identificar la capa igual que el parser) ---
    for (const w of words) {
      if (w.L === 'S') st.power = w.v;
      else if (w.L === 'F') st.feed = w.v;
    }
    const capa = st.layerName !== null ? st.layerName : 'S' + st.power + ' / F' + st.feed;

    // --- transformar coordenadas ---
    let nx = st.x, ny = st.y;
    let vx = null, vy = null, vi = null, vj = null;
    for (const w of words) {
      if (w.L === 'X') vx = w.v * st.unit;
      else if (w.L === 'Y') vy = w.v * st.unit;
      else if (w.L === 'I') vi = w.v * st.unit;
      else if (w.L === 'J') vj = w.v * st.unit;
    }

    let nox = st.ox, noy = st.oy;   // posición original tras esta línea
    if (vx !== null || vy !== null) {
      if (st.absolute) {
        nox = vx !== null ? vx : st.ox;
        noy = vy !== null ? vy : st.oy;
        nx = lin.a * nox + lin.b * noy + offX;
        ny = lin.c * nox + lin.d * noy + offY;
      } else {
        const dx = vx !== null ? vx : 0, dy = vy !== null ? vy : 0;
        nox = st.ox + dx; noy = st.oy + dy;
        nx = st.x + lin.a * dx + lin.b * dy;
        ny = st.y + lin.c * dx + lin.d * dy;
      }
    }

    if (st.motion >= 0 && (vx !== null || vy !== null)) {
      if (st.firstMotion < 0 && out) { st.firstMotion = out.length; st.laserAtFirst = st.laserMode; }
      if (out) st.lastMotion = out.length;
      acota(st, st.x, st.y); acota(st, nx, ny);
    }
    if (st.motion === 2 || st.motion === 3) st.arcs++;

    if (!out) { st.x = nx; st.y = ny; st.ox = nox; st.oy = noy; continue; }

    // --- reescribir la línea ---
    // Ojo: al rotar o hacer espejo, un movimiento que sólo tenía X pasa a tener
    // componente Y (y al revés). Por eso las coordenadas se emiten como grupo y
    // se añaden las palabras que el original no traía.
    const piezas = [];
    let coordHecho = false, ijHecho = false;

    const emitirCoords = () => {
      if (st.absolute) {
        piezas.push('X' + fmt(nx / st.unit));
        piezas.push('Y' + fmt(ny / st.unit));
        st.wx = nx; st.wy = ny;
      } else {
        // el delta se mide contra lo ya escrito: sin deriva acumulada
        const dx = redondea((nx - st.wx) / st.unit);
        const dy = redondea((ny - st.wy) / st.unit);
        if (dx) piezas.push('X' + fmt(dx));
        if (dy) piezas.push('Y' + fmt(dy));
        if (!dx && !dy) piezas.push('X0');
        st.wx += dx * st.unit; st.wy += dy * st.unit;
      }
    };
    const emitirIJ = () => {
      const i0 = vi !== null ? vi : 0, j0 = vj !== null ? vj : 0;
      const ti = lin.a * i0 + lin.b * j0, tj = lin.c * i0 + lin.d * j0;
      piezas.push('I' + fmt(ti / st.unit));
      piezas.push('J' + fmt(tj / st.unit));
    };

    for (const w of words) {
      switch (w.L) {
        case 'G': {
          let v = w.v;
          if (flipArcs && (v === 2 || v === 3)) v = v === 2 ? 3 : 2;
          piezas.push('G' + fmt(v)); break;
        }
        case 'X': case 'Y':
          if (!coordHecho) { coordHecho = true; emitirCoords(); }
          break;
        case 'I': case 'J':
          if (!ijHecho) { ijHecho = true; emitirIJ(); }
          break;
        case 'R': piezas.push('R' + fmt(w.v * Math.abs(escalaMedia(lin)))); break;
        case 'S': piezas.push('S' + fmt(ajusta(w.v, o.power, capa))); break;
        case 'F': piezas.push('F' + fmt(ajusta(w.v, o.feed, capa))); break;
        default: piezas.push(w.L + fmt(w.v));
      }
    }
    out.push(piezas.join(' ') + (comment ? ' ' + comment : ''));
    st.x = nx; st.y = ny; st.ox = nox; st.oy = noy;
  }

  return {
    bounds: isFinite(st.minX) ? { minX: st.minX, minY: st.minY, maxX: st.maxX, maxY: st.maxY } : null,
    firstMotion: st.firstMotion, lastMotion: st.lastMotion,
    absolute: !st.sawRelative, arcs: st.arcs, laserAtFirst: st.laserAtFirst
  };
}

function acota(st, x, y) {
  if (x < st.minX) st.minX = x; if (x > st.maxX) st.maxX = x;
  if (y < st.minY) st.minY = y; if (y > st.maxY) st.maxY = y;
}

function ajusta(v, op, capa) {
  if (!op) return v;
  if (op.layer && op.layer !== '*' && op.layer !== capa) return v;
  if (op.mode === 'set') return op.value;
  return v * (op.value / 100);
}

function redondea(v) { return Math.round(v * 10000) / 10000; }

function escalaMedia(lin) {
  return Math.sqrt(Math.abs(lin.a * lin.d - lin.b * lin.c));
}

function tokenize(code) {
  const words = [];
  const n = code.length;
  let p = 0;
  while (p < n) {
    const ch = code.charCodeAt(p);
    if (ch === 32 || ch === 9 || ch === 13) { p++; continue; }
    if (ch === 40) { const c = code.indexOf(')', p); p = c === -1 ? n : c + 1; continue; }
    let L = code[p].toUpperCase();
    if (!/[A-Z]/.test(L)) { p++; continue; }
    p++;
    while (p < n && (code.charCodeAt(p) === 32 || code.charCodeAt(p) === 9)) p++;
    const start = p;
    if (code[p] === '-' || code[p] === '+') p++;
    while (p < n && code[p] >= '0' && code[p] <= '9') p++;
    if (code[p] === '.') { p++; while (p < n && code[p] >= '0' && code[p] <= '9') p++; }
    if (p === start) { words.push({ L, v: NaN, solo: true }); continue; }
    words.push({ L, v: parseFloat(code.slice(start, p)) });
  }
  return words.filter(w => !w.solo);
}

function fmt(v) {
  if (!isFinite(v)) return '0';
  let s = (Math.round(v * 10000) / 10000).toFixed(4);
  s = s.replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

/* ------------------------------------------------------------- encuadre */

function bloqueEncuadre(b, f, absolute, laserMode) {
  const mg = f.margin || 0;
  const x0 = b.minX - mg, y0 = b.minY - mg, x1 = b.maxX + mg, y1 = b.maxY + mg;
  const rep = Math.max(1, Math.round(f.repeat || 1));
  const L = ['; --- encuadre añadido por el visor (' + rep + 'x, S' + f.power + ' F' + f.feed + ') ---'];
  L.push('M' + (laserMode || 4));
  if (absolute) {
    L.push('G90');
    L.push('G0 X' + fmt(x0) + ' Y' + fmt(y0) + ' S0');
    for (let i = 0; i < rep; i++) {
      L.push('G1 X' + fmt(x1) + ' Y' + fmt(y0) + ' F' + fmt(f.feed) + ' S' + fmt(f.power));
      L.push('G1 X' + fmt(x1) + ' Y' + fmt(y1));
      L.push('G1 X' + fmt(x0) + ' Y' + fmt(y1));
      L.push('G1 X' + fmt(x0) + ' Y' + fmt(y0));
    }
    L.push('G1 S0');
  } else {
    const w = x1 - x0, h = y1 - y0;
    L.push('G91');
    L.push('G0 X' + fmt(x0) + ' Y' + fmt(y0) + ' S0');
    for (let i = 0; i < rep; i++) {
      L.push('G1 X' + fmt(w) + ' F' + fmt(f.feed) + ' S' + fmt(f.power));
      L.push('G1 Y' + fmt(h));
      L.push('G1 X' + fmt(-w));
      L.push('G1 Y' + fmt(-h));
    }
    L.push('G1 S0');
    L.push('G0 X' + fmt(-x0) + ' Y' + fmt(-y0));
  }
  // se deja el láser como estaba antes del encuadre
  L.push(laserMode ? 'M' + laserMode : 'M5');
  L.push('; --- fin del encuadre ---');
  return L;
}
