/* Visor 3D del popup de trabajos en curso.
 *
 * Distinto del de la biblioteca a propósito: la cámara ORBITA alrededor de la
 * pieza (arrastrar gira, rueda acerca, doble clic restablece) en vez de girar
 * el objeto, hay cama con cuadrícula y ejes X/Y/Z, y el trazo se pinta según
 * el avance real del trabajo (lo ya impreso en el color de acento, lo que
 * falta atenuado) con un marcador en la posición actual.
 *
 * Solo lee el G-code: nada de aquí toca la impresora. Sin dependencias más
 * allá de THREE (global, vendorizado).
 */
(function () {
    'use strict';

    const MAX_SEGMENTS = 600000;   // tope para no ahogar el navegador con G-code gigantes
    const CHUNK_LINES = 20000;     // líneas por tanda: deja respirar a la interfaz
    const cache = new Map();       // url -> { positions, count, bounds }
    const meshCache = new Map();   // url -> Float32Array de triángulos
    const CACHE_MAX = 3;

    // ── Lectura del G-code: solo segmentos con extrusión, con su Z real ──
    // Se lee en flujo (por trozos) y, si el archivo es enorme, se dibuja solo
    // 1 de cada `stride` segmentos: la vista previa no necesita los millones,
    // pero el encuadre sí usa TODOS para que la pieza salga completa.
    function makeToolpathParser(stride) {
        let capacity = 60000;
        let positions = new Float32Array(capacity * 6);
        let count = 0, seen = 0;
        let x = 0, y = 0, z = 0, e = 0;
        let absXYZ = true, absE = true;
        const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
        const word = /([GMXYZEF])\s*(-?\d*\.?\d+)/gi;

        function line(raw) {
            const comment = raw.indexOf(';');
            const text = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
            if (!text) return;
            const first = text.charCodeAt(0) | 32;            // minúscula
            if (first !== 103 && first !== 109) return;       // solo G y M

            const vals = {};
            let cmd = '';
            word.lastIndex = 0;
            let m;
            while ((m = word.exec(text)) !== null) {
                const letter = m[1].toUpperCase();
                if (letter === 'G' || letter === 'M') {
                    if (!cmd) cmd = letter + Number(m[2]);
                } else {
                    vals[letter] = parseFloat(m[2]);
                }
            }
            if (!cmd) return;

            if (cmd === 'G90') { absXYZ = true; absE = true; return; }
            if (cmd === 'G91') { absXYZ = false; absE = false; return; }
            if (cmd === 'M82') { absE = true; return; }
            if (cmd === 'M83') { absE = false; return; }
            if (cmd === 'G92') {
                if (vals.X !== undefined) x = vals.X;
                if (vals.Y !== undefined) y = vals.Y;
                if (vals.Z !== undefined) z = vals.Z;
                if (vals.E !== undefined) e = vals.E;
                return;
            }
            // G2/G3 (arcos) se aproximan con su recta al punto final: basta para la vista.
            if (cmd !== 'G0' && cmd !== 'G1' && cmd !== 'G2' && cmd !== 'G3') return;

            const nx = vals.X === undefined ? x : (absXYZ ? vals.X : x + vals.X);
            const ny = vals.Y === undefined ? y : (absXYZ ? vals.Y : y + vals.Y);
            const nz = vals.Z === undefined ? z : (absXYZ ? vals.Z : z + vals.Z);
            const ne = vals.E === undefined ? e : (absE ? vals.E : e + vals.E);
            const extruding = vals.E !== undefined && ne > e + 1e-9 && (nx !== x || ny !== y);

            if (extruding) {
                if (nx < bounds.minX) bounds.minX = nx; if (nx > bounds.maxX) bounds.maxX = nx;
                if (ny < bounds.minY) bounds.minY = ny; if (ny > bounds.maxY) bounds.maxY = ny;
                if (nz < bounds.minZ) bounds.minZ = nz; if (nz > bounds.maxZ) bounds.maxZ = nz;
                if (seen++ % stride === 0 && count < MAX_SEGMENTS) {
                    if (count >= capacity) {
                        capacity *= 2;
                        const grown = new Float32Array(capacity * 6);
                        grown.set(positions);
                        positions = grown;
                    }
                    const o = count * 6;
                    positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
                    positions[o + 3] = nx; positions[o + 4] = ny; positions[o + 5] = nz;
                    count += 1;
                }
            }
            x = nx; y = ny; z = nz; e = ne;
        }

        return {
            line,
            result() {
                if (!count) return { positions: new Float32Array(0), count: 0, bounds: null };
                return { positions: positions.subarray(0, count * 6), count, bounds };
            },
        };
    }

    const tick = () => new Promise(resolve => setTimeout(resolve, 0));

    // Lee la respuesta por trozos (sin armar un string gigante) y avisa el avance.
    async function parseToolpathStream(response, isCancelled, onProgress) {
        const total = Number(response.headers.get('content-length')) || 0;
        // ~45 bytes por movimiento: se estima cuántos habrá para decidir el salto.
        const stride = total ? Math.max(1, Math.ceil((total / 45) / MAX_SEGMENTS)) : 1;
        const parser = makeToolpathParser(stride);
        if (!response.body || !response.body.getReader) {
            const text = await response.text();
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                parser.line(lines[i]);
                if (i % CHUNK_LINES === 0) { if (isCancelled()) return null; await tick(); }
            }
            return parser.result();
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let carry = '', received = 0, chunks = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            carry += decoder.decode(value, { stream: true });
            const lines = carry.split('\n');
            carry = lines.pop();
            for (let i = 0; i < lines.length; i++) parser.line(lines[i]);
            if (isCancelled()) { try { await reader.cancel(); } catch (_) { /* ya cerrado */ } return null; }
            if (onProgress && total) onProgress(Math.min(1, received / total));
            if (++chunks % 6 === 0) await tick();
        }
        if (carry) parser.line(carry);
        return parser.result();
    }

    // ── Mallas: STL (binario/ASCII), OBJ y 3MF (zip + XML) ──
    // Se leen a mano a propósito: los cargadores vendorizados son mínimos
    // (el de 3MF solo devolvía un cubo de relleno) y aquí hace falta la forma real.
    function parseStl(buffer) {
        const view = new DataView(buffer);
        const triangles = view.byteLength >= 84 ? view.getUint32(80, true) : 0;
        // Binario si el tamaño cuadra exactamente con el número de triángulos:
        // muchos binarios empiezan con "solid" en el encabezado.
        if (view.byteLength === 84 + triangles * 50) {
            const out = new Float32Array(triangles * 9);
            for (let i = 0; i < triangles; i++) {
                const o = 84 + i * 50 + 12;
                for (let k = 0; k < 9; k++) out[i * 9 + k] = view.getFloat32(o + k * 4, true);
            }
            return out;
        }
        const text = new TextDecoder().decode(buffer);
        const out = [];
        const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
        let m;
        while ((m = re.exec(text)) !== null) out.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
        return new Float32Array(out);
    }

    function parseObj(text) {
        const v = [];
        const out = [];
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {          // "v "
                const p = line.split(/\s+/);
                v.push(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
            } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {   // "f "
                const idx = line.split(/\s+/).slice(1).map(token => {
                    let n = parseInt(token.split('/')[0], 10);
                    if (n < 0) n = v.length / 3 + n + 1;
                    return n - 1;
                });
                for (let i = 1; i + 1 < idx.length; i++) {                           // abanico
                    for (const k of [idx[0], idx[i], idx[i + 1]]) out.push(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]);
                }
            }
        }
        return new Float32Array(out);
    }

    async function inflateRaw(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function readZip(buffer) {
        const view = new DataView(buffer);
        let eocd = -1;
        for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 70000); i--) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('zip');
        const count = view.getUint16(eocd + 10, true);
        let p = view.getUint32(eocd + 16, true);
        const entries = new Map();
        for (let i = 0; i < count; i++) {
            if (view.getUint32(p, true) !== 0x02014b50) break;
            const method = view.getUint16(p + 10, true);
            const compSize = view.getUint32(p + 20, true);
            const nameLen = view.getUint16(p + 28, true);
            const extraLen = view.getUint16(p + 30, true);
            const commentLen = view.getUint16(p + 32, true);
            const local = view.getUint32(p + 42, true);
            const name = new TextDecoder().decode(new Uint8Array(buffer, p + 46, nameLen));
            entries.set(name.replace(/^\//, ''), { method, compSize, local });
            p += 46 + nameLen + extraLen + commentLen;
        }
        return async function read(name) {
            const entry = entries.get(name.replace(/^\//, ''));
            if (!entry) return null;
            const nameLen = view.getUint16(entry.local + 26, true);
            const extraLen = view.getUint16(entry.local + 28, true);
            const start = entry.local + 30 + nameLen + extraLen;
            const raw = new Uint8Array(buffer, start, entry.compSize);
            return entry.method === 0 ? raw : inflateRaw(raw);
        };
    }

    async function parse3mf(buffer) {
        const read = await readZip(buffer);
        const rels = await read('_rels/.rels');
        let mainPath = '3D/3dmodel.model';
        if (rels) {
            const m = /Target="([^"]+\.model)"/i.exec(new TextDecoder().decode(rels));
            if (m) mainPath = m[1].replace(/^\//, '');
        }
        const docs = new Map();
        async function doc(path) {
            if (!docs.has(path)) {
                const bytes = await read(path);
                docs.set(path, bytes ? new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml') : null);
            }
            return docs.get(path);
        }
        const main = await doc(mainPath);
        if (!main) throw new Error('3mf');
        const unitName = (main.documentElement.getAttribute('unit') || 'millimeter').toLowerCase();
        const unit = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unitName] || 1;
        const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        const parseT = t => { const a = (t || '').trim().split(/\s+/).map(Number); return a.length === 12 && a.every(Number.isFinite) ? a : IDENTITY; };
        // a·b con matrices 3MF (vector fila): primero a, luego b.
        const mul = (a, b) => [
            a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
            a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
            a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
            a[9] * b[0] + a[10] * b[3] + a[11] * b[6] + b[9], a[9] * b[1] + a[10] * b[4] + a[11] * b[7] + b[10], a[9] * b[2] + a[10] * b[5] + a[11] * b[8] + b[11],
        ];
        const out = [];
        async function emit(path, objectId, matrix, depth) {
            if (depth > 6) return;
            const d = await doc(path);
            if (!d) return;
            const obj = Array.from(d.getElementsByTagName('object')).find(o => o.getAttribute('id') === objectId);
            if (!obj) return;
            const mesh = obj.getElementsByTagName('mesh')[0];
            if (mesh) {
                const verts = Array.from(mesh.getElementsByTagName('vertex')).map(e => [+e.getAttribute('x'), +e.getAttribute('y'), +e.getAttribute('z')]);
                for (const tri of Array.from(mesh.getElementsByTagName('triangle'))) {
                    for (const key of ['v1', 'v2', 'v3']) {
                        const q = verts[+tri.getAttribute(key)];
                        if (!q) continue;
                        out.push(
                            (q[0] * matrix[0] + q[1] * matrix[3] + q[2] * matrix[6] + matrix[9]) * unit,
                            (q[0] * matrix[1] + q[1] * matrix[4] + q[2] * matrix[7] + matrix[10]) * unit,
                            (q[0] * matrix[2] + q[1] * matrix[5] + q[2] * matrix[8] + matrix[11]) * unit
                        );
                    }
                }
            }
            for (const comp of Array.from(obj.getElementsByTagName('component'))) {
                const sub = comp.getAttribute('p:path') || comp.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'path');
                await emit(sub ? sub.replace(/^\//, '') : path, comp.getAttribute('objectid'), mul(parseT(comp.getAttribute('transform')), matrix), depth + 1);
            }
        }
        const items = Array.from(main.getElementsByTagName('item'));
        for (const item of items) await emit(mainPath, item.getAttribute('objectid'), parseT(item.getAttribute('transform')), 0);
        if (!out.length) {
            // Sin <build>: se toman todas las mallas tal cual.
            for (const o of Array.from(main.getElementsByTagName('object'))) await emit(mainPath, o.getAttribute('id'), IDENTITY, 0);
        }
        return new Float32Array(out);
    }

    async function parseMesh(url, ext) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('http ' + response.status);
        if (ext === 'obj') return parseObj(await response.text());
        const buffer = await response.arrayBuffer();
        return ext === '3mf' ? parse3mf(buffer) : parseStl(buffer);
    }

    function meshBounds(positions) {
        const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
            if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
            if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
        }
        return b;
    }

    function cssColor(name, fallback) {
        const value = getComputedStyle(document.body).getPropertyValue(name).trim();
        return value || fallback;
    }

    function axisLabel(text, color) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 44px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(0,0,0,.7)';
        ctx.strokeText(text, 32, 34);
        ctx.fillStyle = color;
        ctx.fillText(text, 32, 34);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
        sprite.scale.set(14, 14, 1);
        return sprite;
    }

    function opts_static(o) { return !!(o && o.static); }

    function create(container, options) {
        if ((!container && !opts_static(options)) || !window.THREE || typeof THREE.Scene !== 'function') return null;
        const opts = options || {};
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opts.preserve });
        renderer.setPixelRatio(opts.static ? 1 : Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x000000, 0);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        const canvas = renderer.domElement;
        canvas.className = 'job-viewer-canvas';
        canvas.style.touchAction = 'none';
        canvas.style.cursor = 'grab';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', opts.label || '');
        if (container) container.appendChild(canvas);

        const scene = new THREE.Scene();
        // Luz: ambiente tenue + un foco desde arriba. El foco proyecta la sombra
        // de la pieza sobre la cama y deja un charco de luz que se desvanece
        // hacia los bordes (penumbra completa); un relleno suave, sin sombra,
        // evita que los costados queden negros.
        scene.add(new THREE.AmbientLight(0xffffff, 0.42));
        const keyLight = new THREE.SpotLight(0xffffff, 1.25, 0, 0.5, 1, 1);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.set(opts.static ? 1024 : 2048, opts.static ? 1024 : 2048);
        keyLight.shadow.bias = -0.0004;
        scene.add(keyLight);
        scene.add(keyLight.target);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.22);
        fillLight.position.set(-1.5, 1, 0.8);
        scene.add(fillLight);
        const camera = new THREE.PerspectiveCamera(40, 1, 1, 8000);
        camera.up.set(0, 0, 1);   // Z arriba: coordenadas de la impresora tal cual

        const accent = new THREE.Color(cssColor('--accent-fill', '#22c55e'));
        const soft = new THREE.Color(cssColor('--text-soft', '#94a3b8'));
        const pending = accent.clone().lerp(new THREE.Color(0x0b1410), 0.72);
        // Cama oscura con un matiz del acento: el charco de luz se lee sobre ella.
        const fogColor = new THREE.Color(cssColor('--surface-sunken', '#101a1c')).multiplyScalar(0.55);
        const bedColor = new THREE.Color(cssColor('--surface-sunken', '#101a1c')).lerp(accent, 0.07).multiplyScalar(0.8);

        // Estado de la cámara orbital
        let bedX = (opts.bed && opts.bed[0]) || 220;
        let bedY = (opts.bed && opts.bed[1]) || 220;
        const target = new THREE.Vector3(bedX / 2, bedY / 2, 0);
        const home = { theta: -Math.PI / 4, phi: 1.0, radius: 1 };
        const view = { theta: home.theta, phi: home.phi, radius: 1 };
        let dirty = true;
        let interacted = false;
        let destroyed = false;

        let bedGroup = null;
        let toolpath = null;
        let marker = null;
        let meshObj = null;
        let footprint = null;
        let shadeArr = null, zNormArr = null;
        const shadowDir = new THREE.Vector2(0.55, 0.4);
        let data = null;
        let doneCount = 0;
        let progress = Math.max(0, Math.min(100, Number(opts.progress) || 0));

        function placeCamera() {
            const sinPhi = Math.sin(view.phi);
            camera.position.set(
                target.x + view.radius * sinPhi * Math.cos(view.theta),
                target.y + view.radius * sinPhi * Math.sin(view.theta),
                target.z + view.radius * Math.cos(view.phi)
            );
            camera.lookAt(target);
        }

        function buildBed() {
            if (bedGroup) scene.remove(bedGroup);
            bedGroup = new THREE.Group();
            const size = Math.max(bedX, bedY);

            const plane = new THREE.Mesh(
                new THREE.PlaneGeometry(bedX, bedY),
                new THREE.MeshStandardMaterial({ color: bedColor, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.94 })
            );
            plane.position.set(bedX / 2, bedY / 2, -0.05);
            plane.receiveShadow = true;
            bedGroup.add(plane);

            const gridColor = soft.clone();
            const fine = new THREE.GridHelper(size, Math.round(size / 10), gridColor, gridColor);
            fine.material.transparent = true; fine.material.opacity = 0.22;
            const coarse = new THREE.GridHelper(size, Math.round(size / 50), gridColor, gridColor);
            coarse.material.transparent = true; coarse.material.opacity = 0.5;
            [fine, coarse].forEach(grid => {
                grid.rotation.x = Math.PI / 2;          // la cuadrícula nace en XZ: se acuesta en XY
                grid.position.set(size / 2, size / 2, 0);
                bedGroup.add(grid);
            });

            const axes = [
                { dir: new THREE.Vector3(1, 0, 0), color: 0xef4444, label: 'X' },
                { dir: new THREE.Vector3(0, 1, 0), color: 0x22c55e, label: 'Y' },
                { dir: new THREE.Vector3(0, 0, 1), color: 0x3b82f6, label: 'Z' },
            ];
            axes.forEach(axis => {
                const arrow = new THREE.ArrowHelper(axis.dir, new THREE.Vector3(0, 0, 0), 40, axis.color, 10, 6);
                bedGroup.add(arrow);
                const sprite = axisLabel(axis.label, '#' + new THREE.Color(axis.color).getHexString());
                sprite.position.copy(axis.dir).multiplyScalar(54);
                bedGroup.add(sprite);
            });
            scene.add(bedGroup);
        }

        function frame() {
            // Encuadre: la pieza si la hay, la cama completa si no.
            const b = data && data.bounds;
            if (b) {
                target.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
                const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 30);
                home.radius = span * 2.4;
            } else {
                target.set(bedX / 2, bedY / 2, 0);
                home.radius = Math.max(bedX, bedY) * 1.5;
            }
            view.radius = home.radius;
            scene.fog = new THREE.Fog(fogColor, home.radius * 1.1, home.radius * 3.2);
            positionLights();
            dirty = true;
        }

        // El foco queda arriba de la pieza, algo hacia atrás-izquierda para que la
        // sombra caiga hacia adelante-derecha, y su cono abarca la pieza con margen.
        function positionLights() {
            const b = data && data.bounds;
            const cx = b ? (b.minX + b.maxX) / 2 : bedX / 2;
            const cy = b ? (b.minY + b.maxY) / 2 : bedY / 2;
            const span = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 30) : Math.max(bedX, bedY) * 0.5;
            const height = span * 3.4;
            keyLight.position.set(cx - span * 0.55, cy - span * 0.4, height);
            keyLight.target.position.set(cx, cy, 0);
            keyLight.angle = Math.min(1.1, Math.atan((span * 1.5) / height));
            keyLight.shadow.camera.near = height * 0.25;
            keyLight.shadow.camera.far = height * 2.6;
            keyLight.shadow.camera.updateProjectionMatrix();
            keyLight.target.updateMatrixWorld();
            shadowDir.set(0.55, 0.4);
        }

        // Un trazo de G-code son miles de líneas del mismo color encimadas: de lejos
        // se ve una plasta plana. Para darle volumen, cada tramo lleva (1) un
        // degradado por altura (base oscura → cima clara, deja ver las capas),
        // (2) un sombreado tipo Lambert según hacia dónde mira la pared (la normal
        // sale de su dirección en planta) y (3) un leve contraste entre capas pares
        // e impares.
        const tmpColor = new THREE.Color();
        const lowTone = accent.clone().multiplyScalar(0.42);
        const highTone = accent.clone().lerp(new THREE.Color(0xffffff), 0.35);
        function segmentColor(i, done) {
            const shade = shadeArr[i], zn = zNormArr[i];
            if (done) {
                tmpColor.copy(lowTone).lerp(highTone, zn).multiplyScalar(0.38 + 0.82 * shade);
            } else {
                tmpColor.copy(pending).multiplyScalar((0.55 + 0.45 * shade) * (0.75 + 0.25 * zn));
            }
        }

        function computeSegmentShading() {
            shadeArr = new Float32Array(data.count);
            zNormArr = new Float32Array(data.count);
            const b = data.bounds;
            const zMin = b ? b.minZ : 0, zRange = b ? Math.max(1e-6, b.maxZ - b.minZ) : 1;
            const lx = -0.55, ly = -0.4, ll = Math.hypot(lx, ly);
            for (let i = 0; i < data.count; i++) {
                const o = i * 6;
                const dx = data.positions[o + 3] - data.positions[o];
                const dy = data.positions[o + 4] - data.positions[o + 1];
                const len = Math.hypot(dx, dy) || 1;
                // normal en planta (perpendicular a la dirección del tramo)
                const lam = Math.abs((-dy / len) * (lx / ll) + (dx / len) * (ly / ll));
                const z = (data.positions[o + 2] + data.positions[o + 5]) / 2;
                const layer = Math.round(z / 0.2);
                shadeArr[i] = Math.max(0, Math.min(1, 0.25 + 0.75 * lam)) * ((layer & 1) ? 0.92 : 1);
                zNormArr[i] = Math.max(0, Math.min(1, (z - zMin) / zRange));
            }
        }

        function paintProgress() {
            if (!toolpath || !data || !data.count) return;
            const next = Math.round((progress / 100) * data.count);
            if (next === doneCount) return;
            const colors = toolpath.geometry.attributes.color;
            const from = Math.min(doneCount, next), to = Math.max(doneCount, next);
            const toDone = next > doneCount;
            for (let s = from; s < to; s++) {
                segmentColor(s, toDone);
                for (let v = 0; v < 2; v++) {
                    const o = (s * 2 + v) * 3;
                    colors.array[o] = tmpColor.r; colors.array[o + 1] = tmpColor.g; colors.array[o + 2] = tmpColor.b;
                }
            }
            colors.needsUpdate = true;
            doneCount = next;
            if (marker) {
                const idx = Math.max(0, Math.min(data.count - 1, doneCount - 1)) * 6 + 3;
                marker.position.set(data.positions[idx], data.positions[idx + 1], data.positions[idx + 2]);
                marker.visible = doneCount > 0 && doneCount < data.count;
            }
            dirty = true;
        }

        // Las líneas de un G-code no proyectan sombra en three.js, así que se dibuja
        // la huella: cada tramo desplazado según su altura (más alto, sombra más
        // lejos) en una textura suavizada que se pega sobre la cama.
        function buildFootprintShadow() {
            if (footprint) { scene.remove(footprint); footprint.geometry.dispose(); footprint.material.map.dispose(); footprint.material.dispose(); footprint = null; }
            if (!data || !data.count) return;
            const W = opts.static ? 512 : 1024;
            const H = Math.max(64, Math.round(W * bedY / bedX));
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const ctx = c.getContext('2d');
            if (!ctx) return;
            if ('filter' in ctx) ctx.filter = `blur(${Math.max(3, W * 0.007)}px)`;
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.lineWidth = Math.max(2, W * 0.0045);
            ctx.lineCap = 'round';
            const kx = W / bedX, ky = H / bedY;
            const step = Math.max(1, Math.ceil(data.count / 60000));
            const lift = 0.5;                                      // mm de sombra por mm de altura
            ctx.beginPath();
            for (let i = 0; i < data.count; i += step) {
                const o = i * 6;
                const z = (data.positions[o + 2] + data.positions[o + 5]) / 2;
                const ox = shadowDir.x * z * lift, oy = shadowDir.y * z * lift;
                ctx.moveTo((data.positions[o] + ox) * kx, H - (data.positions[o + 1] + oy) * ky);
                ctx.lineTo((data.positions[o + 3] + ox) * kx, H - (data.positions[o + 4] + oy) * ky);
            }
            ctx.stroke();
            const texture = new THREE.CanvasTexture(c);
            footprint = new THREE.Mesh(
                new THREE.PlaneGeometry(bedX, bedY),
                new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
            );
            footprint.position.set(bedX / 2, bedY / 2, 0.08);
            scene.add(footprint);
        }

        function buildToolpath() {
            if (toolpath) { scene.remove(toolpath); toolpath.geometry.dispose(); toolpath.material.dispose(); toolpath = null; }
            if (marker) { scene.remove(marker); marker = null; }
            buildFootprintShadow();
            if (!data || !data.count) return;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
            computeSegmentShading();
            const colors = new Float32Array(data.count * 6);
            for (let i = 0; i < data.count; i++) {
                segmentColor(i, false);
                for (let v = 0; v < 2; v++) {
                    const o = (i * 2 + v) * 3;
                    colors[o] = tmpColor.r; colors[o + 1] = tmpColor.g; colors[o + 2] = tmpColor.b;
                }
            }
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            toolpath = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
            scene.add(toolpath);
            marker = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
            marker.visible = false;
            scene.add(marker);
            doneCount = 0;
            paintProgress();
        }

        function buildMesh() {
            if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); meshObj.material.dispose(); meshObj = null; }
            if (!data || !data.mesh) return;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(data.mesh, 3));
            geometry.computeVertexNormals();
            const color = accent.clone().lerp(new THREE.Color(0xffffff), 0.2);
            meshObj = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.6, flatShading: true }));
            meshObj.castShadow = true;
            scene.add(meshObj);
        }

        // Bed grande si la pieza no cabe en 220: se sube al múltiplo de 50 siguiente.
        function fitBedToPart() {
            const b = data && data.bounds;
            if (!b) return;
            const need = Math.max(b.maxX, b.maxY);
            if (need > Math.min(bedX, bedY)) {
                const grown = Math.ceil((need + 10) / 50) * 50;
                bedX = Math.max(bedX, grown);
                bedY = Math.max(bedY, grown);
            }
        }

        // ── Interacción ──
        let dragging = false, lastX = 0, lastY = 0;
        const onDown = event => {
            dragging = true; interacted = true;
            lastX = event.clientX; lastY = event.clientY;
            canvas.style.cursor = 'grabbing';
            try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* sin captura: sigue funcionando */ }
        };
        const onMove = event => {
            if (!dragging) return;
            view.theta -= (event.clientX - lastX) * 0.008;
            view.phi = Math.max(0.05, Math.min(1.55, view.phi - (event.clientY - lastY) * 0.008));   // nunca bajo la cama
            lastX = event.clientX; lastY = event.clientY;
            dirty = true;
        };
        const onUp = event => {
            dragging = false;
            canvas.style.cursor = 'grab';
            try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ya soltado */ }
        };
        const onWheel = event => {
            event.preventDefault();
            interacted = true;
            view.radius = Math.max(home.radius * 0.15, Math.min(home.radius * 4, view.radius * (event.deltaY > 0 ? 1.1 : 0.9)));
            dirty = true;
        };
        const reset = () => { view.theta = home.theta; view.phi = home.phi; view.radius = home.radius; dirty = true; };
        if (!opts.static) {
            canvas.addEventListener('pointerdown', onDown);
            canvas.addEventListener('pointermove', onMove);
            canvas.addEventListener('pointerup', onUp);
            canvas.addEventListener('pointercancel', onUp);
            canvas.addEventListener('wheel', onWheel, { passive: false });
            canvas.addEventListener('dblclick', reset);
        }

        function resize() {
            const w = (opts.width) || (container && container.clientWidth) || 320;
            const h = (opts.height) || (container && container.clientHeight) || 240;
            renderer.setSize(w, h, false);
            canvas.style.width = '100%'; canvas.style.height = '100%';
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            dirty = true;
        }
        const observer = (!opts.static && container && typeof ResizeObserver === 'function') ? new ResizeObserver(resize) : null;
        if (observer) observer.observe(container);

        let last = performance.now();
        function loop(now) {
            if (destroyed) return;
            requestAnimationFrame(loop);
            // Giro lento hasta que el usuario toma el control (respeta "reducir movimiento").
            if (!interacted && !reduceMotion && toolpath) {
                view.theta += (now - last) * 0.00012;
                dirty = true;
            }
            last = now;
            if (!dirty) return;
            dirty = false;
            placeCamera();
            renderer.render(scene, camera);
        }

        // ── API ──
        async function load(url) {
            if (!url) { data = null; fitBedToPart(); buildBed(); buildToolpath(); frame(); return 'empty'; }
            let entry = cache.get(url);
            if (!entry) {
                const response = await fetch(url);
                if (!response.ok) throw new Error('http ' + response.status);
                entry = await parseToolpathStream(response, () => destroyed, opts.onProgress);
                if (!entry) return 'cancelled';
                cache.set(url, entry);
                if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
            }
            if (destroyed) return 'cancelled';
            data = entry;
            fitBedToPart(); buildBed(); buildToolpath(); buildMesh(); frame();
            return data.count ? 'ok' : 'empty';
        }

        // Modelo 3D (STL/3MF/OBJ): la pieza se apoya en la cama y se centra en ella.
        async function loadModel(url, ext) {
            let raw = meshCache.get(url);
            if (!raw) {
                raw = await parseMesh(url, ext);
                if (destroyed) return 'cancelled';
                meshCache.set(url, raw);
                if (meshCache.size > CACHE_MAX) meshCache.delete(meshCache.keys().next().value);
            }
            if (!raw.length) return 'empty';
            const b0 = meshBounds(raw);
            const grown = Math.ceil((Math.max(b0.maxX - b0.minX, b0.maxY - b0.minY) + 20) / 50) * 50;
            bedX = Math.max(bedX, grown); bedY = Math.max(bedY, grown);
            const dx = bedX / 2 - (b0.minX + b0.maxX) / 2, dy = bedY / 2 - (b0.minY + b0.maxY) / 2, dz = -b0.minZ;
            const placed = new Float32Array(raw.length);
            for (let i = 0; i < raw.length; i += 3) { placed[i] = raw[i] + dx; placed[i + 1] = raw[i + 1] + dy; placed[i + 2] = raw[i + 2] + dz; }
            data = { positions: new Float32Array(0), count: 0, mesh: placed, bounds: meshBounds(placed) };
            buildBed(); buildToolpath(); buildMesh(); frame();
            return 'ok';
        }

        // Instantánea (para miniaturas): vista isométrica fija, sin giro.
        function snapshotUrl() {
            view.theta = -Math.PI / 4; view.phi = 0.95;
            placeCamera();
            renderer.render(scene, camera);
            return canvas.toDataURL('image/png');
        }

        buildBed();
        frame();
        resize();
        if (!opts.static) requestAnimationFrame(loop);

        return {
            load,
            loadModel,
            snapshotUrl,
            setProgress(value) {
                progress = Math.max(0, Math.min(100, Number(value) || 0));
                paintProgress();
            },
            resetView: reset,
            destroy() {
                destroyed = true;
                if (observer) observer.disconnect();
                if (toolpath) { toolpath.geometry.dispose(); toolpath.material.dispose(); }
                if (meshObj) { meshObj.geometry.dispose(); meshObj.material.dispose(); }
                if (footprint) { footprint.geometry.dispose(); footprint.material.map.dispose(); footprint.material.dispose(); }
                renderer.dispose();
                try { renderer.forceContextLoss(); } catch (_) { /* ya liberado */ }
                canvas.remove();
            },
        };
    }

    // Miniaturas estáticas de la forma real del archivo. Una a la vez (una sola
    // instancia WebGL viva), con caché en memoria por URL.
    const thumbCache = new Map();
    let thumbQueue = Promise.resolve();

    function snapshot(url, ext, size) {
        const key = `${url}|${size || 320}`;
        if (thumbCache.has(key)) return Promise.resolve(thumbCache.get(key));
        const job = thumbQueue.then(async () => {
            if (thumbCache.has(key)) return thumbCache.get(key);
            const viewer = create(null, { static: true, preserve: true, width: size || 320, height: size || 320, progress: 100 });
            if (!viewer) throw new Error('webgl');
            try {
                const kind = ['gcode', 'gco', 'nc', 'bgcode', 'g'].includes(ext) ? 'gcode' : 'model';
                const result = kind === 'gcode' ? await viewer.load(url) : await viewer.loadModel(url, ext);
                if (result !== 'ok') throw new Error(result);
                const dataUrl = viewer.snapshotUrl();
                thumbCache.set(key, dataUrl);
                if (thumbCache.size > 250) thumbCache.delete(thumbCache.keys().next().value);
                return dataUrl;
            } finally {
                viewer.destroy();
            }
        });
        thumbQueue = job.catch(() => {});
        return job;
    }

    window.NopalJobViewer = { create, snapshot, _parse: { gcodeStream: parseToolpathStream, stl: parseStl, obj: parseObj, mf3: parse3mf, bounds: meshBounds } };
})();
