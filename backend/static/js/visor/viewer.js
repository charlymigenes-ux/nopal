/**
 * GcodeViewer — visor de archivos .gc / .gcode
 *
 * Componente autónomo, sin dependencias y sin build: se monta sobre un
 * elemento contenedor y se comunica por eventos. Pensado para embeberse
 * después en NOPAL sin tocar su interior.
 *
 *   const viewer = new GcodeViewer(document.querySelector('#lienzo'));
 *   viewer.on('loaded', (d) => console.log(d.stats));
 *   await viewer.loadFile(file);
 */
import { Renderer, PALETTE } from './renderer.js';

const GRID_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

export class GcodeViewer {
  constructor(container, opts = {}) {
    this.el = container;
    this.opts = Object.assign({
      workArea: { w: 420, h: 300 },   // área de trabajo de la máquina (mm)
      supersample: 1,                 // >1 dibuja por encima de la pantalla (ver dpr)
      autoHideFill: true,             // oculta el relleno del ráster al cargar (ver _ocultarRelleno)
      rulers: true,
      grid: true,
      workerUrl: new URL('./parser-worker.js', import.meta.url)
    }, opts);

    this.el.classList.add('gv-root');
    // Los lienzos se posicionan en absoluto dentro del contenedor: éste tiene
    // que ser un bloque contenedor. No se le impone nada si ya lo es (así el
    // anfitrión decide su propio layout).
    if (getComputedStyle(this.el).position === 'static') this.el.style.position = 'relative';
    this.bg = mkCanvas(this.el, 'gv-bg');
    this.glCanvas = mkCanvas(this.el, 'gv-gl');
    this.fg = mkCanvas(this.el, 'gv-fg');
    this.ctxBg = this.bg.getContext('2d');
    this.ctxFg = this.fg.getContext('2d');

    this.renderer = new Renderer(this.glCanvas);

    this.view = { scale: 2, tx: 60, ty: 40 };
    // Los grabados ráster de LightBurn van tramados (sólo S0 y S máx.): la
    // imagen la forma el patrón de puntos, no el brillo. A escala de ajuste
    // caben miles de líneas de barrido en pocos cientos de píxeles y se
    // solapan en una mancha. Dibujando por encima de la resolución de
    // pantalla y dejando que el navegador reduzca, el tramado se vuelve a
    // leer como medio tono. opts.supersample lo controla.
    this.dpr = Math.min((window.devicePixelRatio || 1) * (this.opts.supersample || 1), 3);
    this.tool = 'select';
    this.bounds = null;
    this.stats = null;
    this.layers = [];
    this.layerVisible = [];
    this.measure = null;      // {a:[x,y], b:[x,y]}
    this.head = null;         // [x,y] cabezal de simulación
    this.simIndex = Infinity;
    this.chunksCPU = [];      // {pos, sec, cum, base, baseSec, n}
    this.totalSeconds = 0;
    this.pointer = null;
    this.showFrame = false;
    this.listeners = new Map();
    this.dirty = true;
    this.frameReq = null;

    this._bindEvents();
    this._observe();
    this.resize();
  }

  // ---------------------------------------------------------------- eventos
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
    return this;
  }
  emit(name, data) { const l = this.listeners.get(name); if (l) for (const f of l) f(data); }

  // ------------------------------------------------------------------ carga
  async loadFile(file) {
    this.emit('loadstart', { name: file.name, size: file.size });
    if (file.stream && supportsStreamTransfer()) {
      try {
        const stream = file.stream();
        return await this._run({ type: 'parse', stream, size: file.size }, [stream]);
      } catch (_) { /* cae al modo texto */ }
    }
    return this._run({ type: 'parse', text: await file.text() });
  }

  async loadUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('No se pudo cargar ' + url + ' (' + res.status + ')');
    const size = Number(res.headers.get('content-length')) || 0;
    const name = url.split('/').pop();
    this.emit('loadstart', { name, size });
    if (res.body && supportsStreamTransfer()) {
      try {
        return await this._run({ type: 'parse', stream: res.body, size }, [res.body]);
      } catch (_) { /* cae al modo texto */ }
    }
    return this._run({ type: 'parse', text: await res.text() });
  }

  loadText(text, name = 'texto.gcode') {
    this.emit('loadstart', { name, size: text.length });
    return this._run({ type: 'parse', text });
  }

  /**
   * Aplica ediciones de último momento y vuelve a dibujar.
   * Siempre parten del texto ORIGINAL, así que no se acumulan ni son destructivas.
   * @param {object} ops  ver OPS_VACIAS en gcode-editor.js
   */
  applyEdits(ops) {
    if (!this.sourceText) return Promise.reject(new Error('No hay archivo cargado'));
    this.ops = ops;
    return this._run({ type: 'parse', text: this.sourceText, ops });
  }

  /** Texto G-code actualmente en pantalla (con las ediciones aplicadas). */
  getText() { return this.text || this.sourceText || ''; }
  getSourceText() { return this.sourceText || ''; }

  _run(msg, transfer) {
    this.reset();
    if (this.worker) this.worker.terminate();
    this.worker = new Worker(this.opts.workerUrl, { type: 'module' });
    this.t0 = performance.now();
    this.firstPaint = false;

    return new Promise((resolve, reject) => {
      this.worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'chunk') {
          this._addChunk(m);
          if (!this.firstPaint) {
            this.firstPaint = true;
            this.emit('firstpaint', { ms: performance.now() - this.t0 });
          }
          this.dirty = true; this._schedule();
        } else if (m.type === 'progress') {
          if (m.bounds && !this.bounds) {
            this.bounds = m.bounds;
            if (!msg.ops) this.zoomToFit();   // al editar se conserva el encuadre actual
          }
          this.emit('progress', m);
        } else if (m.type === 'done') {
          this.text = m.text;
          if (!msg.ops) { this.sourceText = m.text; this.ops = null; }
          this.stats = m.stats;
          this.bounds = m.stats.bounds;
          this.layers = m.stats.layers.map((L, i) => Object.assign({ color: PALETTE[i % PALETTE.length] }, L));
          this.layerVisible = this.layers.map(() => true);
          if (!msg.ops && this.opts.autoHideFill) this._ocultarRelleno();
          this.totalSeconds = m.stats.seconds;
          this.renderer.feedRescale = m.stats.maxFeed > 0
            ? m.stats.feedCap / m.stats.maxFeed : 1;
          if (!msg.ops) this.zoomToFit();
          this.dirty = true; this._schedule();
          this.emit('loaded', {
            stats: m.stats, ms: m.ms, editMs: m.editMs || 0,
            warnings: m.warnings || [], edited: !!msg.ops,
            totalMs: performance.now() - this.t0
          });
          resolve(m.stats);
        } else if (m.type === 'error') {
          this.emit('error', m); reject(new Error(m.message));
        }
      };
      this.worker.onerror = (e) => { this.emit('error', { message: e.message }); reject(e); };
      this.worker.postMessage(msg, transfer || []);
    });
  }

  _addChunk(m) {
    this.renderer.addChunk(m.pos, m.attr, m.nSeg);
    const cum = new Float32Array(m.nSeg);
    const base = this.chunksCPU.length ? last(this.chunksCPU).base + last(this.chunksCPU).n : 0;
    const baseSec = this.chunksCPU.length ? last(this.chunksCPU).endSec : 0;
    let acc = 0;
    for (let i = 0; i < m.nSeg; i++) { acc += m.sec[i]; cum[i] = acc; }
    this.chunksCPU.push({ pos: m.pos, cum, base, n: m.nSeg, baseSec, endSec: baseSec + acc });
  }

  /**
   * En un grabado ráster la imagen la llevan los HUECOS sin quemar (los `S0`,
   * que aquí son desplazamientos); los trazos de quemado forman una mancha
   * casi sólida que tapa el dibujo. Al cargar se oculta esa capa de relleno
   * para que se vea la imagen, y el usuario puede volver a encenderla con su
   * ojo. En trabajos vectoriales (pocos segmentos, varias capas repartidas)
   * no se toca nada.
   */
  _ocultarRelleno() {
    const total = this.layers.reduce((n, L) => n + L.segments, 0);
    if (total < 20000) return -1;
    let idx = -1, max = 0;
    this.layers.forEach((L, i) => { if (L.segments > max) { max = L.segments; idx = i; } });
    if (idx < 0 || max / total < 0.7) return -1;
    this.setLayerVisible(idx, false);
    return idx;
  }

  reset() {
    this.renderer.clear();
    this.chunksCPU = [];
    this.bounds = null; this.stats = null; this.layers = []; this.layerVisible = [];
    this.measure = null; this.head = null; this.simIndex = Infinity;
    this.renderer.drawLimit = Infinity;
    this.totalSeconds = 0;
    this.dirty = true; this._schedule();
  }

  // ------------------------------------------------------------------ vista
  resize() {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    this.w = w; this.h = h;
    for (const c of [this.bg, this.glCanvas, this.fg]) {
      c.style.width = w + 'px'; c.style.height = h + 'px';
      c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr);
    }
    this.ctxBg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctxFg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this._needsFit && w >= 20 && h >= 20) { this.zoomToFit(); return; }
    this.dirty = true; this._schedule();
  }

  zoomToFit(pad = 0.08) {
    // Si el contenedor aún no tiene tamaño (pestaña oculta, panel plegado),
    // se deja pendiente y se reencuadra en cuanto aparezca.
    if (!this.w || !this.h || this.w < 20 || this.h < 20) { this._needsFit = true; return; }
    this._needsFit = false;
    const b = this.bounds || {
      minX: 0, minY: 0, maxX: this.opts.workArea.w, maxY: this.opts.workArea.h
    };
    const bw = Math.max(1e-3, b.maxX - b.minX), bh = Math.max(1e-3, b.maxY - b.minY);
    const m = this.opts.rulers ? { l: 46, t: 34, r: 12, b: 12 } : { l: 8, t: 8, r: 8, b: 8 };
    const availW = Math.max(20, this.w - m.l - m.r), availH = Math.max(20, this.h - m.t - m.b);
    const s = Math.min(availW / (bw * (1 + pad)), availH / (bh * (1 + pad)));
    this.view.scale = s;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.view.tx = m.l + availW / 2 - cx * s;
    this.view.ty = m.t + availH / 2 + cy * s;
    this._viewChanged();
  }

  zoomBy(factor, cx, cy) {
    const px = cx ?? this.w / 2, py = cy ?? this.h / 2;
    const wx = (px - this.view.tx) / this.view.scale;
    const wy = (this.view.ty - py) / this.view.scale;
    this.view.scale = clamp(this.view.scale * factor, 0.02, 8000);
    this.view.tx = px - wx * this.view.scale;
    this.view.ty = py + wy * this.view.scale;
    this._viewChanged();
  }

  toWorld(px, py) {
    return [(px - this.view.tx) / this.view.scale, (this.view.ty - py) / this.view.scale];
  }
  toScreen(x, y) {
    return [this.view.tx + x * this.view.scale, this.view.ty - y * this.view.scale];
  }
  _viewChanged() {
    this.dirty = true; this._schedule();
    this.emit('view', { scale: this.view.scale });
  }

  // -------------------------------------------------------------- controles
  setTool(t) { this.tool = t; this.el.dataset.tool = t; if (t !== 'measure') { this.measure = null; this.dirty = true; this._schedule(); } }
  setColorMode(m) { this.renderer.mode = m; this.dirty = true; this._schedule(); }
  setShowTravel(v) { this.renderer.showTravel = !!v; this.dirty = true; this._schedule(); }
  setLayerVisible(i, v) {
    this.layerVisible[i] = !!v;
    this.renderer.layerVis[i] = v ? 1 : 0;
    this.dirty = true; this._schedule();
  }
  setLayerColor(i, hex) {
    this.layers[i].color = hex;
    this.renderer.setLayerColors(this.layers.map(l => l.color));
    this.dirty = true; this._schedule();
  }
  setWorkArea(w, h) { this.opts.workArea = { w, h }; this.dirty = true; this._schedule(); }
  setShowFrame(v) { this.showFrame = !!v; this.dirty = true; this._schedule(); }

  /** t: 0..1 sobre el tiempo estimado total. */
  setSimProgress(t) {
    if (!this.renderer.totalSegments) return;
    if (t >= 1) {
      this.renderer.drawLimit = Infinity; this.head = null; this.simIndex = Infinity;
    } else {
      const target = this.totalSeconds * clamp(t, 0, 1);
      const idx = this.segmentAtTime(target);
      this.renderer.drawLimit = idx;
      this.head = this.pointAtIndex(idx - 1);
      this.simIndex = idx;
    }
    this.dirty = true; this._schedule();
    this.emit('sim', {
      t, index: this.simIndex, seconds: this.totalSeconds * clamp(t, 0, 1), head: this.head
    });
  }

  segmentAtTime(sec) {
    let ch = null;
    for (const c of this.chunksCPU) { if (sec <= c.endSec) { ch = c; break; } ch = c; }
    if (!ch) return 0;
    let lo = 0, hi = ch.n - 1, rel = sec - ch.baseSec;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ch.cum[mid] < rel) lo = mid + 1; else hi = mid; }
    return ch.base + lo + 1;
  }

  pointAtIndex(i) {
    if (i < 0) return null;
    for (const c of this.chunksCPU) {
      if (i < c.base + c.n) {
        const k = (i - c.base) * 4;
        return [c.pos[k + 2], c.pos[k + 3]];
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ pintar
  _schedule() {
    if (this.frameReq) return;
    this.frameReq = requestAnimationFrame(() => { this.frameReq = null; this._paint(); });
  }

  _paint() {
    if (!this.dirty) return;
    this.dirty = false;
    this._paintGrid();
    this.renderer.draw(this.view, this.dpr);
    this._paintOverlay();
  }

  _paintGrid() {
    const ctx = this.ctxBg, w = this.w, h = this.h, v = this.view;
    ctx.clearRect(0, 0, w, h);
    if (!this.opts.grid) return;

    const m = this.opts.rulers ? { l: 46, t: 34 } : { l: 0, t: 0 };
    let step = GRID_STEPS[0];
    for (const s of GRID_STEPS) { step = s; if (s * v.scale >= 28) break; }
    const major = step * 5;

    const x0 = (0 - v.tx) / v.scale, x1 = (w - v.tx) / v.scale;
    const y0 = (v.ty - h) / v.scale, y1 = (v.ty - 0) / v.scale;

    // retícula
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      const st = pass ? major : step;
      if (!pass && step * v.scale < 6) continue;
      ctx.strokeStyle = pass ? 'rgba(148,163,184,0.20)' : 'rgba(148,163,184,0.075)';
      ctx.beginPath();
      for (let x = Math.ceil(x0 / st) * st; x <= x1; x += st) {
        if (pass === 0 && Math.abs(x % major) < st * 0.01) continue;
        const sx = Math.round(v.tx + x * v.scale) + 0.5;
        ctx.moveTo(sx, m.t); ctx.lineTo(sx, h);
      }
      for (let y = Math.ceil(y0 / st) * st; y <= y1; y += st) {
        if (pass === 0 && Math.abs(y % major) < st * 0.01) continue;
        const sy = Math.round(v.ty - y * v.scale) + 0.5;
        ctx.moveTo(m.l, sy); ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }

    // área de trabajo
    const wa = this.opts.workArea;
    if (wa && wa.w && wa.h) {
      const p0 = this.toScreen(0, 0), p1 = this.toScreen(wa.w, wa.h);
      ctx.strokeStyle = 'rgba(56,189,248,0.35)';
      ctx.setLineDash([6, 5]); ctx.lineWidth = 1;
      ctx.strokeRect(p0[0], p1[1], p1[0] - p0[0], p0[1] - p1[1]);
      ctx.setLineDash([]);
    }

    // ejes
    const o = this.toScreen(0, 0);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(239,68,68,0.75)';
    ctx.beginPath(); ctx.moveTo(m.l, o[1]); ctx.lineTo(w, o[1]); ctx.stroke();
    ctx.strokeStyle = 'rgba(34,197,94,0.75)';
    ctx.beginPath(); ctx.moveTo(o[0], h); ctx.lineTo(o[0], m.t); ctx.stroke();

    if (this.opts.rulers) this._paintRulers(step, major, m);
  }

  _paintRulers(step, major, m) {
    const ctx = this.ctxBg, w = this.w, h = this.h, v = this.view;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, m.t);
    ctx.fillRect(0, 0, m.l, h);
    ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, m.t + 0.5); ctx.lineTo(w, m.t + 0.5);
    ctx.moveTo(m.l + 0.5, 0); ctx.lineTo(m.l + 0.5, h);
    ctx.stroke();

    ctx.fillStyle = '#8b98a9';
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';

    const x0 = (m.l - v.tx) / v.scale, x1 = (w - v.tx) / v.scale;
    ctx.strokeStyle = 'rgba(148,163,184,0.45)';
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      const sx = Math.round(v.tx + x * v.scale) + 0.5;
      const isMajor = Math.abs(x % major) < step * 0.01;
      ctx.moveTo(sx, m.t); ctx.lineTo(sx, m.t - (isMajor ? 8 : 4));
      if (isMajor) ctx.fillText(fmtNum(x), sx, m.t - 10);
    }
    const y0 = (v.ty - h) / v.scale, y1 = (v.ty - m.t) / v.scale;
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const sy = Math.round(v.ty - y * v.scale) + 0.5;
      const isMajor = Math.abs(y % major) < step * 0.01;
      ctx.moveTo(m.l, sy); ctx.lineTo(m.l - (isMajor ? 8 : 4), sy);
      if (isMajor) {
        ctx.save(); ctx.translate(m.l - 12, sy); ctx.rotate(-Math.PI / 2);
        ctx.fillText(fmtNum(y), 0, 0); ctx.restore();
      }
    }
    ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#5c6b7a';
    ctx.fillText('mm', 6, m.t - 10);
  }

  _paintOverlay() {
    const ctx = this.ctxFg;
    ctx.clearRect(0, 0, this.w, this.h);

    // encuadre del trabajo
    if (this.bounds && this.showFrame) {
      const p0 = this.toScreen(this.bounds.minX, this.bounds.minY);
      const p1 = this.toScreen(this.bounds.maxX, this.bounds.maxY);
      ctx.strokeStyle = '#eab308'; ctx.setLineDash([7, 4]); ctx.lineWidth = 1.5;
      ctx.strokeRect(p0[0], p1[1], p1[0] - p0[0], p0[1] - p1[1]);
      ctx.setLineDash([]);
    }

    // cabezal
    if (this.head) {
      const [sx, sy] = this.toScreen(this.head[0], this.head[1]);
      ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx - 11, sy); ctx.lineTo(sx - 3, sy);
      ctx.moveTo(sx + 3, sy); ctx.lineTo(sx + 11, sy);
      ctx.moveTo(sx, sy - 11); ctx.lineTo(sx, sy - 3);
      ctx.moveTo(sx, sy + 3); ctx.lineTo(sx, sy + 11);
      ctx.stroke();
    }

    // medición
    if (this.measure && this.measure.b) {
      const a = this.toScreen(...this.measure.a), b = this.toScreen(...this.measure.b);
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); ctx.fillStyle = '#38bdf8'; ctx.fill(); }
      const dx = this.measure.b[0] - this.measure.a[0], dy = this.measure.b[1] - this.measure.a[1];
      const d = Math.hypot(dx, dy);
      const label = d.toFixed(3) + ' mm   Δx ' + dx.toFixed(2) + '  Δy ' + dy.toFixed(2);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(2,6,23,0.85)';
      ctx.fillRect(mx - tw / 2 - 6, my - 24, tw + 12, 19);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(label, mx - tw / 2, my - 10);
    }
  }

  // ------------------------------------------------------------ interacción
  _bindEvents() {
    const el = this.fg;
    let dragging = false, lastX = 0, lastY = 0, moved = false, spaceDown = false;

    el.addEventListener('contextmenu', e => e.preventDefault());

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      dragging = true; moved = false; lastX = e.offsetX; lastY = e.offsetY;
      if (this.tool === 'measure' && e.button === 0) {
        this.measure = { a: this.toWorld(e.offsetX, e.offsetY), b: null };
      }
    });

    el.addEventListener('pointermove', (e) => {
      const wp = this.toWorld(e.offsetX, e.offsetY);
      this.pointer = wp;
      this.emit('pointer', { x: wp[0], y: wp[1] });

      if (!dragging) return;
      const dx = e.offsetX - lastX, dy = e.offsetY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      lastX = e.offsetX; lastY = e.offsetY;

      const panning = e.buttons === 4 || e.buttons === 2 || spaceDown ||
        this.tool === 'pan' || (this.tool !== 'measure' && e.buttons === 1 && e.shiftKey);
      if (this.tool === 'measure' && e.buttons === 1 && this.measure) {
        this.measure.b = wp;
        this.dirty = true; this._schedule();
      } else if (panning) {
        this.view.tx += dx; this.view.ty += dy;
        this._viewChanged();
      } else if (this.tool === 'select' && e.buttons === 1) {
        this.view.tx += dx; this.view.ty += dy;
        this._viewChanged();
      }
    });

    el.addEventListener('pointerup', (e) => {
      dragging = false;
      if (!moved && this.tool === 'zoom') this.zoomBy(e.button === 2 ? 1 / 1.4 : 1.4, e.offsetX, e.offsetY);
      if (!moved && this.tool === 'origin') {
        const wp = this.toWorld(e.offsetX, e.offsetY);
        this.emit('origin', { x: wp[0], y: wp[1] });
      }
    });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.pow(1.0016, -e.deltaY);
      this.zoomBy(f, e.offsetX, e.offsetY);
    }, { passive: false });

    el.addEventListener('dblclick', () => this.zoomToFit());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') spaceDown = true;
      if (e.key === 'f' || e.key === 'F') this.zoomToFit();
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
  }

  _observe() {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    if (this.ro) this.ro.disconnect();
    this.renderer.clear();
    this.el.innerHTML = '';
  }
}

function mkCanvas(parent, cls) {
  const c = document.createElement('canvas');
  c.className = cls;
  parent.appendChild(c);
  return c;
}
let _streamTransfer = null;
/** ¿El navegador permite transferir un ReadableStream al worker? (Chrome 87+) */
function supportsStreamTransfer() {
  if (_streamTransfer !== null) return _streamTransfer;
  try {
    const s = new ReadableStream();
    const { port1, port2 } = new MessageChannel();
    port1.postMessage(s, [s]);
    port1.close(); port2.close();
    _streamTransfer = true;
  } catch (_) { _streamTransfer = false; }
  return _streamTransfer;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function last(a) { return a[a.length - 1]; }
function fmtNum(n) {
  const r = Math.round(n * 1000) / 1000;
  return Math.abs(r) < 1e-9 ? '0' : String(r);
}
