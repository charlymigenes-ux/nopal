/**
 * Miniaturas generadas con el mismo motor del visor: se parsea el G-code en
 * el Worker y se dibuja la trayectoria real en un lienzo WebGL fuera de
 * pantalla. No depende de ningún servicio del servidor.
 *
 *   import { miniatura } from './visor/thumbnail.js';
 *   img.src = await miniatura('/uploads/gcode/CATOLICOS/cris1.gc');
 *
 * Detalles que importan:
 *  - Se reutiliza UN solo contexto WebGL. Crear uno por miniatura agota el
 *    límite del navegador (~16 contextos) y empieza a perder los antiguos.
 *  - Las miniaturas se generan de una en una (cola). Un ráster grande tarda
 *    ~1 s en parsearse; lanzarlas todas a la vez ahogaría la máquina.
 *  - Se cachean en memoria por URL mientras dure la página.
 */
import { Renderer } from './renderer.js';

const ANCHO = 280;
const ALTO = 210;
const MARGEN = 10;

/**
 * Supermuestreo. Un grabado ráster de LightBurn suele estar TRAMADO: sólo hay
 * dos valores de S (apagado y potencia), y la imagen la forma el patrón de
 * puntos, no el brillo. Un archivo de 130 mm con paso de 0,1 mm son ~1.300
 * líneas de barrido; metidas a pelo en 210 píxeles se solapan y sale una
 * mancha sólida en la que no se reconoce nada.
 *
 * Dibujando 4x más grande y reduciendo con promediado, cada píxel final
 * recibe la media de su zona: el tramado vuelve a leerse como medio tono,
 * que es justo como está pensado para verse.
 */
const SUPER = 4;

const cache = new Map();
let lienzo = null;      // lienzo WebGL grande
let reductor = null;    // lienzo 2D del tamaño final
let renderer = null;
let cola = Promise.resolve();

// Gris claro: en una miniatura interesa la imagen, no de qué capa es cada
// trazo. Con el color de capa (azul, rojo...) un grabado ráster sale como una
// mancha plana de color y no se reconoce el dibujo.
const TINTA = '#c9d6e5';

function motor() {
  if (!renderer) {
    lienzo = document.createElement('canvas');
    lienzo.width = ANCHO * SUPER;
    lienzo.height = ALTO * SUPER;
    reductor = document.createElement('canvas');
    reductor.width = ANCHO;
    reductor.height = ALTO;
    renderer = new Renderer(lienzo);
    // En un grabado ráster la imagen la llevan los huecos sin quemar (los
    // `S0`, que el parser cuenta como desplazamiento). Por eso se dibujan, y
    // en generar() se oculta la capa de relleno, que si no tapa el dibujo.
    renderer.showTravel = true;
    renderer.setLayerColors([TINTA]);
    renderer.travelCol = [0.79, 0.84, 0.90];
  }
  return renderer;
}

function parsear(url) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parser-worker.js', import.meta.url), { type: 'module' });
    const trozos = [];
    let terminado = false;

    const cerrar = () => { if (!terminado) { terminado = true; worker.terminate(); } };

    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'chunk') trozos.push(m);
      else if (m.type === 'done') { cerrar(); resolve({ trozos, stats: m.stats }); }
      else if (m.type === 'error') { cerrar(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { cerrar(); reject(new Error(e.message || 'worker')); };

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (res.body) {
          try {
            worker.postMessage({ type: 'parse', stream: res.body, size: 0 }, [res.body]);
            return null;
          } catch (_) { /* sin streams transferibles: se manda el texto */ }
        }
        return res.text().then((texto) => worker.postMessage({ type: 'parse', text: texto }));
      })
      .catch((err) => { cerrar(); reject(err); });
  });
}

async function generar(url) {
  const { trozos, stats } = await parsear(url);
  const r = motor();
  r.clear();
  for (const t of trozos) r.addChunk(t.pos, t.attr, t.nSeg);
  trozos.length = 0;

  // ocultar el relleno del ráster (misma regla que el visor)
  const capas = stats.layers || [];
  const totalSeg = capas.reduce((n, L) => n + L.segments, 0);
  r.layerVis.fill(1);
  if (totalSeg >= 20000) {
    let idx = -1, max = 0;
    capas.forEach((L, i) => { if (L.segments > max) { max = L.segments; idx = i; } });
    if (idx >= 0 && max / totalSeg >= 0.7) r.layerVis[idx] = 0;
  }

  const b = stats.bounds;
  if (!b || !r.totalSegments) { r.clear(); return ''; }

  const bw = Math.max(1e-3, b.maxX - b.minX);
  const bh = Math.max(1e-3, b.maxY - b.minY);
  const escala = Math.min((ANCHO - MARGEN * 2) / bw, (ALTO - MARGEN * 2) / bh);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  r.feedRescale = stats.maxFeed > 0 ? stats.feedCap / stats.maxFeed : 1;
  // La vista se calcula en el tamaño final y se dibuja a SUPER: el renderer
  // multiplica escala y traslación por ese factor, igual que hace con el dpr.
  r.draw({ scale: escala, tx: ANCHO / 2 - cx * escala, ty: ALTO / 2 + cy * escala }, SUPER);

  // reducción promediando: aquí es donde el tramado se convierte en medio tono
  const ctx = reductor.getContext('2d');
  ctx.clearRect(0, 0, ANCHO, ALTO);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lienzo, 0, 0, ANCHO, ALTO);

  const datos = reductor.toDataURL('image/png');
  r.clear();   // libera la GPU antes de la siguiente
  return datos;
}

/**
 * @param {string} url  ruta del archivo G-code
 * @returns {Promise<string>} data: URL del PNG ('' si el archivo no dibuja nada)
 */
export function miniatura(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  const tarea = cola
    .catch(() => {})                     // un fallo previo no corta la cola
    .then(() => generar(url))
    .then((datos) => { cache.set(url, datos); return datos; });
  cola = tarea.catch(() => {});
  return tarea;
}

export function olvidar(url) {
  if (url) cache.delete(url); else cache.clear();
}
