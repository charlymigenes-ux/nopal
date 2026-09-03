/**
 * Web Worker de parseo. Lee el archivo en streaming y va emitiendo bloques
 * de geometría al hilo principal (transferibles, sin copia) para que el
 * dibujo aparezca mientras el archivo se sigue leyendo.
 */
import { createState, ChunkWriter, parseText, FEED_CAP } from './gcode-parser.js';
import { applyEdits } from './gcode-editor.js';

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'parse') return;

  const t0 = performance.now();
  let editWarnings = [];
  let editMs = 0;

  // ediciones de último momento: se reescribe el texto antes de parsear
  if (msg.ops && msg.text) {
    const te = performance.now();
    const r = applyEdits(msg.text, msg.ops);
    msg.text = r.text;
    editWarnings = r.warnings;
    editMs = performance.now() - te;
  }

  const st = createState();
  const writer = new ChunkWriter((pos, attr, sec, nSeg) => {
    self.postMessage({ type: 'chunk', pos, attr, sec, nSeg },
      [pos.buffer, attr.buffer, sec.buffer]);
  });

  let bytesRead = 0;
  let lastReport = 0;
  const total = msg.size || 0;

  const onProgress = () => {
    const now = performance.now();
    if (now - lastReport < 120) return;
    lastReport = now;
    self.postMessage({
      type: 'progress',
      bytes: bytesRead, total,
      lines: st.lines, segments: st.segments,
      bounds: bounds(st)
    });
  };

  const partes = [];   // se conserva el texto para poder editarlo después
  try {
    if (msg.stream) {
      const reader = msg.stream.getReader();
      const dec = new TextDecoder('utf-8');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        const trozo = dec.decode(value, { stream: true });
        partes.push(trozo);
        parseText(trozo, st, writer, false);
        onProgress();
      }
      const fin = dec.decode();
      if (fin) partes.push(fin);
      parseText(fin, st, writer, true);
    } else {
      bytesRead = msg.text.length;
      partes.push(msg.text);
      parseText(msg.text, st, writer, true);
    }
    writer.flush();

    self.postMessage({
      type: 'done',
      ms: performance.now() - t0,
      editMs,
      warnings: editWarnings,
      text: partes.join(''),
      stats: {
        lines: st.lines,
        segments: st.segments,
        distCut: st.distCut,
        distTravel: st.distTravel,
        seconds: st.seconds,
        maxPower: st.maxPowerSeen,
        maxFeed: st.maxFeed,
        feedCap: FEED_CAP,
        bounds: bounds(st),
        layers: st.layers
      }
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

function bounds(st) {
  if (!isFinite(st.minX)) return null;
  return { minX: st.minX, minY: st.minY, maxX: st.maxX, maxY: st.maxY };
}
