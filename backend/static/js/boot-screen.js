// ── Pantalla de carga de NOPAL ──
// Núcleo con el logo al centro y una tarjeta por módulo. NO simula nada: no
// hace peticiones propias de "carga" y observa las que app.js ya dispara al
// arrancar (el interceptor de fetch de app.js llama a begin/observe/fail), de
// modo que cada tarjeta cambia de estado solo cuando su petición real responde.
//
// Se carga ANTES de app.js a propósito: las peticiones iniciales salen en
// cuanto corre app.js, y deben encontrar ya aquí a quien las registre. La
// pantalla en sí solo se muestra cuando app.js confirma que hay sesión
// (NopalBoot.start()); sin sesión se descarta (NopalBoot.cancel()) para no
// tapar el login.
(function () {
    'use strict';

    // Secuencia: el núcleo entra solo y luego se atiende UN módulo a la vez, del
    // más importante al más sencillo (ORDER): la ficha entra, se libera SU
    // petición (las demás peticiones del arranque esperan su turno), se muestra
    // su resultado, se conecta al núcleo y solo entonces empieza el siguiente.
    // Al cerrar ya está todo cargado detrás.
    const CORE_INTRO_MS = 900;       // el núcleo solo, antes de la primera ficha
    const FOCUS_DWELL_MS = 900;      // lo mínimo que una ficha se ve "conectando"
    const LINK_HOLD_MS = 900;        // con el resultado a la vista y la rama ya tendida
    const STEP_TIMEOUT_MS = 9000;    // si un módulo no contesta, se marca ámbar y se sigue
    const FINAL_WAIT_MS = 10000;     // al final, espera a que termine lo que quedó en vuelo
    const HOLD_AFTER_LAST_MS = 1400; // con todo listo, se deja ver antes de cerrar
    const FADE_OUT_MS = 1300;        // desvanecimiento final
    const MAX_VISIBLE_MS = 75000;    // tope global: nunca se queda colgada
    const SETTING_KEY = 'nopalBootScreen';

    // De lo que más importa saber al arrancar a lo más sencillo.
    const ORDER = ['services', 'printers', 'instances', 'tools', 'jobs', 'console', 'library', 'tuna', 'plugins'];

    const tr = (key, fallback) => {
        if (typeof window.t !== 'function') return fallback;
        const value = window.t(key);
        return value && value !== key ? value : fallback;
    };

    // Rutas que se observan. Las demás peticiones pasan sin tocarse.
    const WATCHED = new Set([
        '/api/ai/status',
        '/api/dashboard/summary',
        '/api/printers/status',
        '/api/marlin-printers/registry/status',
        '/api/marlin-printers/jobs/active',
        '/api/elegoo/printers',
        '/api/flashforge/printers',
        '/api/bambu/printers',
        '/api/cameras',
        '/api/spoolman/printers/active-spools',
        '/api/laser/registry',
        '/api/laser/status',
        '/api/laser/usb-ports',
        '/api/laser/jobs/active',
        '/api/laser/queue',
        '/api/printers/queue/count',
        '/api/devices/registry',
        '/api/accessories/scenes',
        '/api/accessories/status',
        '/api/accessories/arduino/discover',
        '/api/models',
        '/api/tunascreen/devices',
        '/api/plugins',
        '/api/plugins/matriz-led/last-sent',
        '/api/plugins/matriz-led/last-sent-history',
    ]);

    // Compuerta: mientras la pantalla está activa, cada petición vigilada espera
    // aquí hasta que le toca su turno (openPaths). Pasado el arranque se abre todo.
    const gateOpen = new Set();
    const parked = Object.create(null);   // ruta -> resolvers de peticiones en espera
    const results = Object.create(null);   // ruta -> { ok, body } (la última respuesta)
    const inflight = Object.create(null);  // ruta -> peticiones en vuelo
    const laserByHost = Object.create(null); // /api/laser/status?host=… (una por máquina)
    let pluginsReady = null;               // { failed } cuando loadInstalledPluginModules termina
    let bootUser = null;                   // usuario con sesión (lo pasa app.js en start)

    let started = false;
    let finished = false;
    let timedOut = false;
    let closing = false;
    let startedAt = 0;
    let overlay = null;
    let cards = {};
    let readyResolve = null;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    let authReadyResolve = null;
    const authReady = new Promise(resolve => { authReadyResolve = resolve; });

    const pathOf = url => String(url || '').split('?')[0];

    function gate(url) {
        const path = pathOf(url);
        if (finished || !WATCHED.has(path) || gateOpen.has(path)) return Promise.resolve();
        return new Promise(resolve => { (parked[path] = parked[path] || []).push(resolve); });
    }

    function openPaths(paths) {
        paths.forEach(path => {
            gateOpen.add(path);
            (parked[path] || []).splice(0).forEach(release => release());
        });
    }

    const openAll = () => openPaths(Array.from(WATCHED));
    const asList = body => (Array.isArray(body) ? body : (body && (body.printers || body.devices || body.lasers || body.plugins || body.scenes || body.jobs)) || []);

    // ── Observación de peticiones (la llama el interceptor de app.js) ──

    // Una vez cerrada la pantalla ya no se observa nada: el polling posterior
    // de app.js no debe acumular respuestas ni clonar cuerpos.
    function wants(url) {
        return !finished && WATCHED.has(pathOf(url));
    }

    function record(url, entry) {
        const path = pathOf(url);
        if (path === '/api/laser/status') {
            // Cada máquina consulta su propio estado: se guarda por host.
            const host = new URLSearchParams(String(url).split('?')[1] || '').get('host') || '';
            laserByHost[host] = entry;
        } else {
            results[path] = entry;
        }
    }

    function begin(url) {
        if (!wants(url)) return;
        const path = pathOf(url);
        inflight[path] = (inflight[path] || 0) + 1;
        refresh();
    }

    async function settle(url, response) {
        const path = pathOf(url);
        inflight[path] = Math.max(0, (inflight[path] || 1) - 1);
        let body = null;
        if (response && response.ok) {
            try { body = await response.json(); } catch (_) { body = null; }
        }
        record(url, { ok: Boolean(response && response.ok), body });
        refresh();
    }

    function observe(url, response) {
        if (!wants(url)) return;
        // El clone se hace de inmediato, antes de que app.js consuma el cuerpo.
        settle(url, response && response.ok ? response.clone() : response);
    }

    function fail(url) {
        if (!wants(url)) return;
        const path = pathOf(url);
        inflight[path] = Math.max(0, (inflight[path] || 1) - 1);
        record(url, { ok: false, body: null });
        refresh();
    }

    window.addEventListener('nopal:plugins-ready', event => {
        pluginsReady = { failed: (event.detail && event.detail.failed) || 0 };
        refresh();
    });

    // ── Estado por módulo ──
    // Cada módulo devuelve null mientras le falte una respuesta real; si no,
    // { state: 'ok'|'warn', rows: [{ label, value, state }] }.

    const row = (label, value, state, kind) => ({ label, value, state: state || 'ok', kind: kind || '' });
    const connected = () => tr('bootConnected', 'Conectada');
    const offline = () => tr('bootOffline', 'Sin conexión');
    const unreachable = () => tr('bootUnreachable', 'No se pudo consultar');

    const done = path => results[path];
    const worst = rows => (rows.some(item => item.state === 'warn') ? 'warn' : 'ok');
    const failed = (...paths) => paths.some(path => done(path) && !done(path).ok);
    const missing = (...paths) => paths.some(path => !done(path));
    const failure = () => ({ state: 'warn', rows: [row(tr('bootNoAnswer', 'Sin respuesta'), unreachable(), 'warn')] });

    function allPrinters() {
        const list = [];
        const klipper = done('/api/printers/status');
        asList(klipper && klipper.body).forEach(p => list.push({ kind: 'printer', name: p.name || `Moonraker (${p.port})`, online: p.status === 'online' }));
        ['/api/marlin-printers/registry/status', '/api/elegoo/printers', '/api/flashforge/printers', '/api/bambu/printers'].forEach(path => {
            const entry = done(path);
            asList(entry && entry.body).forEach(p => list.push({ kind: 'printer', name: p.name || p.device || p.ip || path, online: Boolean(p.online) }));
        });
        return list;
    }

    // Láseres y CNC registrados. null mientras falte el registro o el estado de
    // alguna máquina (cada una tiene su propia consulta); [] si no hay ninguna.
    function laserMachines() {
        const registry = done('/api/laser/registry');
        if (!registry) return null;
        if (!registry.ok) return [];
        const machines = asList(registry.body);
        if (machines.some(m => !laserByHost[m.host])) return null;
        return machines.map(m => {
            const status = laserByHost[m.host];
            return {
                kind: m.kind === 'cnc' ? 'cnc' : 'laser',
                name: m.name || m.host,
                online: Boolean(status.ok && status.body && status.body.connected),
            };
        });
    }

    const MODULES = [
        {
            id: 'printers', pos: [50, 14],
            paths: ['/api/printers/status', '/api/marlin-printers/registry/status', '/api/elegoo/printers', '/api/flashforge/printers', '/api/bambu/printers', '/api/laser/registry', '/api/laser/status', '/api/cameras', '/api/spoolman/printers/active-spools'], icon: 'M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z',
            title: () => tr('bootMachines', 'Máquinas'),
            compute() {
                // Espera a todas las marcas y a cada láser/CNC: la ficha muestra el conjunto.
                if (missing('/api/printers/status', '/api/marlin-printers/registry/status', '/api/elegoo/printers', '/api/flashforge/printers', '/api/bambu/printers')) return null;
                if (failed('/api/printers/status')) return failure();
                const lasers = laserMachines();
                if (lasers === null) return null;
                // Impresoras 3D, láseres y CNC, cada tipo con su color (el mismo del panel).
                const list = [...allPrinters(), ...lasers.filter(m => m.kind === 'laser'), ...lasers.filter(m => m.kind === 'cnc')];
                if (!list.length) return { state: 'ok', rows: [row(tr('bootNone', 'Ninguna registrada'), '—')] };
                const MAX_ROWS = 6;
                const rows = list.slice(0, MAX_ROWS).map(m => row(m.name, m.online ? connected() : offline(), m.online ? 'ok' : 'warn', m.kind));
                if (list.length > MAX_ROWS) rows.push(row(`+${list.length - MAX_ROWS}`, '', 'ok'));
                return { state: list.every(m => !m.online) ? 'warn' : worst(rows), rows };
            },
        },
        {
            id: 'instances', pos: [78, 30], paths: [], icon: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01',
            title: () => tr('bootInstances', 'Instancias'),
            compute() {
                if (missing('/api/printers/status')) return null;
                if (failed('/api/printers/status')) return failure();
                const list = asList(done('/api/printers/status').body);
                if (!list.length) return { state: 'ok', rows: [row('Moonraker', tr('bootNoneDetected', 'Sin detectar'))] };
                const rows = list.slice(0, 3).map(p => row(`Moonraker (${p.port})`, p.status === 'online' ? connected() : offline(), p.status === 'online' ? 'ok' : 'warn'));
                return { state: worst(rows), rows };
            },
        },
        {
            id: 'library', pos: [22, 30], paths: ['/api/models'], icon: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
            title: () => tr('bootLibrary', 'Biblioteca de modelos'),
            compute() {
                if (missing('/api/models')) return null;
                if (failed('/api/models')) return failure();
                const files = asList(done('/api/models').body);
                const isGcode = f => /\.(gcode|gc|nc|ngc|tap|cnc)$/i.test(String((f && (f.name || f.path)) || ''));
                const gcode = files.filter(isGcode).length;
                return {
                    state: 'ok',
                    rows: [
                        row(tr('bootModels3d', 'Modelos 3D'), String(files.length - gcode)),
                        row('G-code', String(gcode)),
                    ],
                };
            },
        },
        {
            id: 'jobs', pos: [14, 52], paths: ['/api/laser/jobs/active', '/api/marlin-printers/jobs/active', '/api/laser/queue', '/api/printers/queue/count'], icon: 'M8 4h8l4 4v12H4V4zM8 12h8M8 16h8',
            title: () => tr('bootJobs', 'Trabajos'),
            compute() {
                if (missing('/api/dashboard/summary', '/api/laser/jobs/active', '/api/marlin-printers/jobs/active')) return null;
                if (failed('/api/dashboard/summary')) return failure();
                const summary = done('/api/dashboard/summary').body || {};
                const rows = [row(tr('bootActiveJobs', 'Activos'), String(((summary.jobs || {}).total_active) || 0))];
                const laser = done('/api/laser/jobs/active');
                if (laser && laser.ok) rows.push(row(tr('bootLaser', 'Láser'), String(asList(laser.body).length)));
                const marlin = done('/api/marlin-printers/jobs/active');
                if (marlin && marlin.ok) rows.push(row('Marlin', String(asList(marlin.body).length)));
                return { state: 'ok', rows };
            },
        },
        {
            id: 'console', pos: [86, 52], paths: [], icon: 'M4 17l6-6-6-6M12 19h8',
            title: () => tr('bootConsole', 'Consola'),
            compute() {
                if (missing('/api/printers/status')) return null;
                if (failed('/api/printers/status')) return failure();
                const list = asList(done('/api/printers/status').body);
                const online = list.filter(p => p.status === 'online').length;
                const rows = [
                    row('Moonraker', list.length ? connected() : tr('bootNoneDetected', 'Sin detectar'), 'ok'),
                    row('Klipper', list.length ? `${online}/${list.length}` : '—', list.length && !online ? 'warn' : 'ok'),
                ];
                return { state: worst(rows), rows };
            },
        },
        {
            id: 'tools', pos: [22, 74],
            paths: ['/api/laser/usb-ports', '/api/devices/registry', '/api/accessories/scenes', '/api/accessories/status', '/api/accessories/arduino/discover'], icon: 'M14.7 6.3a4 4 0 0 0 5 5L21 12.6 11.6 22a2.1 2.1 0 0 1-3-3L18 9.6zM3 3l4 4',
            title: () => tr('bootTools', 'Herramientas'),
            compute() {
                if (missing('/api/accessories/scenes')) return null;
                const machines = laserMachines();
                if (machines === null) return null;
                if (failed('/api/laser/registry')) return failure();
                const lasers = machines.filter(m => m.kind === 'laser');
                const cnc = machines.filter(m => m.kind === 'cnc');
                const on = list => list.filter(m => m.online).length;
                const rows = [
                    row(tr('bootLaser', 'Láser'), lasers.length ? `${on(lasers)}/${lasers.length}` : '—', lasers.length && !on(lasers) ? 'warn' : 'ok', 'laser'),
                    row('CNC', cnc.length ? `${on(cnc)}/${cnc.length}` : '—', cnc.length && !on(cnc) ? 'warn' : 'ok', 'cnc'),
                ];
                const scenes = done('/api/accessories/scenes');
                if (scenes && scenes.ok) rows.push(row(tr('bootAccessories', 'Accesorios'), String(asList(scenes.body).length)));
                return { state: worst(rows), rows };
            },
        },
        {
            id: 'services', pos: [78, 74], paths: ['/api/dashboard/summary'], icon: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
            title: () => tr('bootServices', 'Servicios internos'),
            compute() {
                if (missing('/api/dashboard/summary')) return null;
                if (failed('/api/dashboard/summary')) return failure();
                const summary = done('/api/dashboard/summary').body || {};
                const host = summary.host || {};
                const rows = [
                    row('API', connected()),
                    row(tr('bootHost', 'Equipo'), host.online ? connected() : offline(), host.online ? 'ok' : 'warn'),
                ];
                // Lo que ocupa uploads/ (host.disk_percent) casi siempre da ~0%: lo que
                // interesa es qué tan lleno está el disco, con el espacio libre real.
                if (typeof host.disk_total_bytes === 'number' && typeof host.disk_free_bytes === 'number' && host.disk_total_bytes > 0) {
                    const usedPct = Math.round((1 - host.disk_free_bytes / host.disk_total_bytes) * 100);
                    const free = typeof window.formatSize === 'function' ? window.formatSize(host.disk_free_bytes) : `${Math.round(host.disk_free_bytes / 1e9)} GB`;
                    rows.push(row(tr('bootDisk', 'Disco'), `${usedPct}% · ${free} ${tr('bootFree', 'libres')}`, usedPct >= 90 ? 'warn' : 'ok'));
                }
                return { state: worst(rows), rows };
            },
        },
        {
            id: 'tuna', pos: [38, 90], paths: ['/api/tunascreen/devices'], icon: 'M3 5h18v11H3zM8 20h8M12 16v4',
            title: () => 'TUNA-Screen',
            compute() {
                if (!bootUser) return null;
                if (bootUser.role !== 'admin') {
                    return { state: 'ok', rows: [row(tr('bootAdminOnly', 'Solo administrador'), '—')] };
                }
                if (missing('/api/tunascreen/devices')) return null;
                if (failed('/api/tunascreen/devices')) return failure();
                const devices = asList(done('/api/tunascreen/devices').body);
                return { state: 'ok', rows: [row(tr('bootDevices', 'Dispositivos'), String(devices.length))] };
            },
        },
        {
            id: 'plugins', pos: [62, 90], paths: ['/api/plugins', '/api/plugins/matriz-led/last-sent', '/api/plugins/matriz-led/last-sent-history'], icon: 'M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z',
            title: () => 'Plugins',
            compute() {
                if (missing('/api/plugins')) return null;
                if (failed('/api/plugins')) return failure();
                // Los plugins del frontend se cargan después de pedir el catálogo:
                // hasta que app.js avisa, siguen "en carga".
                if (!pluginsReady) return null;
                const list = asList(done('/api/plugins').body);
                const active = list.filter(p => p.installed && p.enabled).length;
                const available = list.filter(p => !p.installed).length;
                const rows = [row(tr('bootInstalled', 'Instalados'), String(active))];
                if (pluginsReady.failed) rows.push(row(tr('bootFailed', 'Con fallo'), String(pluginsReady.failed), 'warn'));
                rows.push(row(tr('bootAvailable', 'Disponibles'), String(available)));
                return { state: worst(rows), rows };
            },
        },
    ];

    MODULES.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

    // ── Dibujo ──

    const svg = (inner, extra) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${inner}</svg>`;
    const esc = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

    function build() {
        overlay = document.getElementById('boot-overlay');
        if (!overlay) return false;
        overlay.innerHTML = `
            <div class="boot-ai" id="boot-ai" hidden></div>
            <button type="button" class="boot-skip" id="boot-skip">${esc(tr('bootSkip', 'Entrar ya'))}</button>
            <div class="boot-stage" id="boot-stage">
                <svg class="boot-links" id="boot-links" aria-hidden="true"></svg>
                <div class="boot-core" data-state="busy" aria-hidden="true">
                    <span class="boot-core-ripple"></span><span class="boot-core-ripple"></span>
                    <span class="boot-core-ring boot-core-ring-dashed"></span>
                    <span class="boot-core-ring boot-core-ring-arc"></span>
                    <div class="boot-core-body">
                        <svg class="boot-core-logo" viewBox="0 0 32 32" fill="none">
                            <path d="M16 2 L28 9 V23 L16 30 L4 23 V9 Z" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                            <path d="M16 10 v12 M16 14 c0 -3 -3 -4 -3 -4 M16 17 c0 -3 3 -4 3 -4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <circle cx="13" cy="10" r="1" fill="currentColor"/><circle cx="19" cy="10" r="1" fill="currentColor"/>
                        </svg>
                        <strong>NOPAL</strong>
                    </div>
                </div>
                ${MODULES.map(m => `
                    <section class="boot-card" id="boot-card-${m.id}" data-state="pending" style="--x:${m.pos[0]}%;--y:${m.pos[1]}%;--i:${MODULES.indexOf(m)}">
                        <header>${svg(`<path d="${m.icon}"/>`, 'class="boot-card-icon"')}<h3>${esc(m.title())}</h3><span class="boot-card-count"></span></header>
                        <ul class="boot-card-rows"><li class="boot-row boot-row-wait" data-state="pending"><i></i><span>${esc(tr('bootWaiting', 'Esperando respuesta…'))}</span></li></ul>
                    </section>`).join('')}
            </div>
            <div class="boot-progress" role="status" aria-live="polite">
                <span class="boot-progress-label" id="boot-progress-label"></span>
                <div class="boot-progress-track"><div class="boot-progress-fill" id="boot-progress-fill"></div></div>
            </div>
            <div class="boot-tagline">${esc(tr('bootTagline', 'Tu taller, en un solo lugar'))}</div>`;
        cards = {};
        MODULES.forEach(m => { cards[m.id] = document.getElementById(`boot-card-${m.id}`); });
        overlay.querySelector('#boot-skip').addEventListener('click', close);
        return true;
    }

    const painted = Object.create(null);   // id -> firma de lo último pintado

    function paintCard(module, view, fallback) {
        const card = cards[module.id];
        if (!card) return;
        const state = view ? view.state : fallback;
        const signature = view ? JSON.stringify(view) : `wait:${fallback}`;
        if (painted[module.id] === signature) return;   // repintar igual reiniciaría las animaciones
        painted[module.id] = signature;
        card.dataset.state = state;
        const list = card.querySelector('.boot-card-rows');
        if (view) {
            list.innerHTML = view.rows.map(r => `<li class="boot-row" data-state="${r.state}"${r.kind ? ` data-kind="${r.kind}"` : ''}><i></i><span>${esc(r.label)}</span><em>${esc(r.value)}</em></li>`).join('');
        } else if (fallback === 'active') {
            list.innerHTML = `<li class="boot-row boot-row-wait" data-state="active"><i></i><span>${esc(tr('bootConnecting', 'Conectando…'))}</span></li>`;
        } else {
            list.innerHTML = `<li class="boot-row boot-row-wait" data-state="pending"><i></i><span>${esc(tr('bootWaiting', 'Esperando respuesta…'))}</span></li>`;
        }
        const count = card.querySelector('.boot-card-count');
        if (count) count.textContent = view ? `${view.rows.filter(r => r.state === 'ok').length}/${view.rows.length}` : '';
    }

    // Resalta una ficha un momento (al entrar y al mostrar su resultado).
    function focusCard(id) {
        const card = cards[id];
        if (!card) return;
        card.classList.remove('is-focus');
        void card.offsetWidth;   // reinicia la animación
        card.classList.add('is-focus');
        const link = overlay && overlay.querySelector(`[data-link="${id}"]`);
        if (link) { link.classList.remove('is-burst'); void link.getBoundingClientRect(); link.classList.add('is-burst'); }
    }

    function anyInflight() {
        return Object.keys(inflight).some(path => inflight[path] > 0);
    }

    const revealedAt = Object.create(null);   // id -> momento en que la ficha entró
    const resolvedIds = Object.create(null);  // id -> ya mostró su resultado
    const linked = Object.create(null);       // id -> su rama ya se tendió al núcleo
    let lastResolveAt = 0;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Espera a que se cumpla la condición (o venza el plazo, o termine la pantalla).
    async function waitFor(condition, timeoutMs) {
        const limit = performance.now() + timeoutMs;
        while (!finished && !timedOut && performance.now() < limit) {
            if (condition()) return true;
            await sleep(80);
        }
        return !finished && Boolean(condition());
    }

    function showResult(module, view) {
        resolvedIds[module.id] = true;
        paintCard(module, view, null);
        linked[module.id] = true;          // recién ahora se tiende la rama al núcleo
        lastResolveAt = performance.now();
        drawLinks();
        focusCard(module.id);
        refresh();
    }

    // Ficha que entra: aparece "conectando" y su rama aún no existe.
    function enter(module) {
        revealedAt[module.id] = performance.now();
        const card = cards[module.id];
        if (card) card.classList.add('is-in');
        paintCard(module, null, 'active');
        focusCard(module.id);
        refresh();
    }

    // Actualiza lo ya mostrado (llega un dato tardío) y la barra de avance.
    function refresh() {
        if (!started || finished || !overlay) return;
        let resolved = 0;
        MODULES.forEach(module => {
            if (!resolvedIds[module.id]) return;
            resolved += 1;
            const view = module.compute();
            if (view) paintCard(module, view, null);   // si no cambió, paintCard no hace nada
        });
        const label = overlay.querySelector('#boot-progress-label');
        const fill = overlay.querySelector('#boot-progress-fill');
        if (label) label.textContent = `${tr('bootConnectingComponents', 'Conectando componentes…')} ${resolved}/${MODULES.length}`;
        if (fill) fill.style.width = `${Math.round((resolved / MODULES.length) * 100)}%`;
        drawLinks();
    }

    // Modo IA: lo dice el servidor (/api/ai/status), no se da por hecho. Si la IA
    // está apagada o la consulta falla, no se muestra nada.
    function showAiMode() {
        const chip = overlay && overlay.querySelector('#boot-ai');
        const status = done('/api/ai/status');
        if (!chip || !status || !status.ok || !status.body || !status.body.enabled) return;
        const model = status.body.model ? `<small>${esc(status.body.model)}</small>` : '';
        chip.innerHTML = `<span class="ai-mode-pill boot-ai-pill">${svg('<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/>', 'width="16" height="16"')}<span>${esc(tr('aiModeActive', 'Modo IA activado'))}</span></span>${model}`;
        chip.hidden = false;
        requestAnimationFrame(() => chip.classList.add('is-in'));
    }

    // Una ficha tras otra: entra, se libera su petición, se muestra su resultado,
    // se conecta al núcleo y recién entonces sigue la siguiente.
    async function runSequence() {
        await Promise.all([authReady, sleep(CORE_INTRO_MS)]);
        // Después del núcleo y antes de las fichas: se pregunta si el Modo IA está activo.
        openPaths(['/api/ai/status']);
        await waitFor(() => Boolean(done('/api/ai/status')), 4000);
        if (finished || timedOut) return;
        showAiMode();
        for (const module of MODULES) {
            if (finished || timedOut) return;
            enter(module);
            openPaths(module.paths || []);
            if (module.id === 'tuna' && bootUser && bootUser.role === 'admin') {
                // La única petición propia de esta pantalla (la app no la hace al arrancar).
                window.fetch('/api/tunascreen/devices').catch(() => {});
            }
            await waitFor(() => module.compute() !== null, STEP_TIMEOUT_MS);
            const left = FOCUS_DWELL_MS - (performance.now() - revealedAt[module.id]);
            if (left > 0) await sleep(left);
            if (finished || timedOut) return;
            const view = module.compute();
            showResult(module, view || { state: 'warn', rows: [row(tr('bootNoAnswer', 'Sin respuesta'), tr('bootStillConnecting', 'Aún conectando…'), 'warn')] });
            await sleep(LINK_HOLD_MS);
        }
        // Todos los módulos pasaron: se espera a que termine lo que quedó en vuelo
        // para que, al cerrar, el panel de detrás ya esté completo.
        await waitFor(() => !anyInflight() && Boolean(pluginsReady), FINAL_WAIT_MS);
        if (finished || timedOut) return;
        refresh();
        await sleep(HOLD_AFTER_LAST_MS);
        close();
    }

    // La forma de cada rama se sortea en cada arranque (curvatura, hacia qué lado se
    // dobla y cuánto): no hay dos pantallas de carga con el mismo trazado. Se guarda
    // por módulo para que, durante la sesión, la rama no cambie al moverse la ficha.
    const rand = (min, max) => min + Math.random() * (max - min);
    const shapes = Object.create(null);
    function shapeFor(id) {
        if (!shapes[id]) {
            const side = Math.random() < 0.5 ? -1 : 1;
            shapes[id] = {
                exit: rand(0.22, 0.7),       // cuánto avanza recto saliendo de la ficha
                bend1: side * rand(0.04, 0.34),
                near: rand(0.18, 0.5),       // qué tan cerca del núcleo entra la curva
                bend2: -side * rand(0.0, 0.3),
            };
        }
        return shapes[id];
    }

    // Una curva por tarjeta, del borde de la tarjeta al núcleo. Los elementos se
    // crean una vez y después solo se actualizan (trazo y estado): reconstruirlos
    // en cada respuesta reiniciaba la animación de los pulsos.
    function drawLinks() {
        const stage = overlay && overlay.querySelector('#boot-stage');
        const links = overlay && overlay.querySelector('#boot-links');
        const core = overlay && overlay.querySelector('.boot-core');
        if (!stage || !links || !core) return;
        const base = stage.getBoundingClientRect();
        if (!base.width) return;
        const c = core.getBoundingClientRect();
        const cx = c.left + c.width / 2 - base.left;
        const cy = c.top + c.height / 2 - base.top;
        links.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
        MODULES.forEach(module => {
            const card = cards[module.id];
            if (!card || !linked[module.id]) return;
            const r = card.getBoundingClientRect();
            const mx = r.left + r.width / 2 - base.left;
            const my = r.top + r.height / 2 - base.top;
            const dx = cx - mx;
            const dy = cy - my;
            // Sale por el lado de la tarjeta que mira al núcleo.
            const horizontal = Math.abs(dx) * r.height > Math.abs(dy) * r.width;
            const sx = horizontal ? mx + Math.sign(dx) * r.width / 2 : mx;
            const sy = horizontal ? my : my + Math.sign(dy) * r.height / 2;
            const shape = shapeFor(module.id);
            const ex = cx - sx;
            const ey = cy - sy;
            const len = Math.hypot(ex, ey) || 1;
            const nx = -ey / len;   // perpendicular a la recta ficha→núcleo
            const ny = ex / len;
            // Sale recto por el lado de la ficha que mira al núcleo y luego se dobla.
            const c1x = sx + (horizontal ? Math.sign(dx) * len * shape.exit : 0) + nx * len * shape.bend1;
            const c1y = sy + (horizontal ? 0 : Math.sign(dy) * len * shape.exit) + ny * len * shape.bend1;
            const c2x = cx - ex * shape.near + nx * len * shape.bend2;
            const c2y = cy - ey * shape.near + ny * len * shape.bend2;
            const d = `M${sx.toFixed(1)} ${sy.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)}`;
            let group = links.querySelector(`[data-link="${module.id}"]`);
            if (!group) {
                group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                group.setAttribute('class', 'boot-link');
                group.setAttribute('data-link', module.id);
                group.classList.add('is-new');   // la rama se "dibuja" hacia el núcleo al tenderse
                group.innerHTML = '<path class="boot-link-line" pathLength="1"></path><path class="boot-link-pulse"></path>';
                links.appendChild(group);
            }
            group.setAttribute('data-state', card.dataset.state);
            group.querySelectorAll('path').forEach(path => path.setAttribute('d', d));
        });
    }

    // ── Interactividad espacial ──
    // Las fichas no están fijas: siguen al mouse con inercia (resorte con
    // amortiguación), cada una con su propia "profundidad", y el núcleo se mueve un
    // poco en sentido contrario. Las ramas se vuelven a trazar en cada cuadro.
    const drift = { tx: 0, ty: 0, running: false, items: null, core: { x: 0, y: 0, vx: 0, vy: 0 } };
    const MAX_DRIFT_PX = 30;

    function driftEnabled() {
        return window.matchMedia('(min-width: 1101px)').matches
            && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function driftItems() {
        if (!drift.items) {
            drift.items = MODULES.map(module => ({
                card: cards[module.id],
                depth: rand(0.55, 1.5),   // qué tan "cerca" está: más profundidad, más se mueve
                x: 0, y: 0, vx: 0, vy: 0,
            }));
        }
        return drift.items;
    }

    function driftStep() {
        if (finished || !overlay) { drift.running = false; return; }
        let energy = 0;
        const spring = (item, tx, ty, k, damp) => {
            item.vx = (item.vx + (tx - item.x) * k) * damp;
            item.vy = (item.vy + (ty - item.y) * k) * damp;
            item.x += item.vx;
            item.y += item.vy;
            energy += Math.abs(item.vx) + Math.abs(item.vy) + Math.abs(tx - item.x) + Math.abs(ty - item.y);
        };
        driftItems().forEach(item => {
            spring(item, drift.tx * MAX_DRIFT_PX * item.depth, drift.ty * MAX_DRIFT_PX * item.depth, 0.045 + item.depth * 0.02, 0.84);
            if (item.card) item.card.style.translate = `${item.x.toFixed(2)}px ${item.y.toFixed(2)}px`;
        });
        const core = overlay.querySelector('.boot-core');
        spring(drift.core, -drift.tx * MAX_DRIFT_PX * 0.35, -drift.ty * MAX_DRIFT_PX * 0.35, 0.05, 0.86);
        if (core) core.style.translate = `${drift.core.x.toFixed(2)}px ${drift.core.y.toFixed(2)}px`;
        drawLinks();
        if (energy > 0.05) requestAnimationFrame(driftStep);
        else drift.running = false;
    }

    function kickDrift() {
        if (drift.running || finished) return;
        drift.running = true;
        requestAnimationFrame(driftStep);
    }

    function onPointerMove(event) {
        if (!driftEnabled()) return;
        drift.tx = (event.clientX / window.innerWidth - 0.5) * 2;
        drift.ty = (event.clientY / window.innerHeight - 0.5) * 2;
        kickDrift();
    }

    function onPointerLeave() {
        drift.tx = 0;
        drift.ty = 0;
        kickDrift();
    }

    // ── Ciclo de vida ──

    function enabled() {
        try { return localStorage.getItem(SETTING_KEY) !== 'off'; } catch (_) { return true; }
    }

    // La pantalla se monta al cargar este script (antes que app.js y que el
    // panel): lo primero que se ve es el núcleo. start(user) solo confirma que
    // hay sesión; cancel() la quita al instante si no la hay (login a la vista).
    function init() {
        if (!enabled() || !build()) {
            const stray = document.getElementById('boot-overlay');
            if (stray) stray.hidden = true;   // desactivada: no debe quedar el overlay vacío tapando la app
            finish();
            return;
        }
        started = true;
        startedAt = performance.now();
        overlay.style.animation = 'none';   // ya hay quien lo cierre: se apaga la red de seguridad del CSS
        overlay.hidden = false;
        document.body.classList.add('boot-active');
        window.addEventListener('resize', drawLinks);
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('pointermove', onPointerMove);
        overlay.addEventListener('pointerleave', onPointerLeave);
        runSequence();
        // Tope global: si algo no contestó, esa ficha queda en ámbar (nunca se
        // finge que conectó) y se cierra.
        setTimeout(() => {
            if (finished) return;
            timedOut = true;
            openAll();
            MODULES.forEach(module => {
                if (resolvedIds[module.id]) return;
                const card = cards[module.id];
                if (card) card.classList.add('is-in');
                resolvedIds[module.id] = true;
                linked[module.id] = true;
                paintCard(module, module.compute() || { state: 'warn', rows: [row(tr('bootNoAnswer', 'Sin respuesta'), tr('bootStillConnecting', 'Aún conectando…'), 'warn')] }, null);
            });
            refresh();
            setTimeout(close, HOLD_AFTER_LAST_MS);
        }, MAX_VISIBLE_MS);
    }

    // app.js confirma la sesión: recién entonces arranca la secuencia de peticiones.
    function start(user) {
        bootUser = user || null;
        authReadyResolve();
    }

    function onKey(event) {
        if (event.key === 'Escape') close();
    }

    function finish() {
        if (finished) return;
        finished = true;
        window.removeEventListener('resize', drawLinks);
        document.removeEventListener('keydown', onKey);
        document.body.classList.remove('boot-active');
        openAll();            // nada debe quedar retenido
        authReadyResolve();
        readyResolve();
        window.dispatchEvent(new CustomEvent('nopal:boot-done'));
    }

    function close() {
        if (finished) return;
        if (!overlay || overlay.hidden) { finish(); return; }
        openAll();   // al saltarla, lo que siga retenido se libera ya, sin esperar el desvanecimiento
        overlay.classList.add('is-closing');
        setTimeout(() => {
            overlay.hidden = true;
            overlay.classList.remove('is-closing');
            overlay.innerHTML = '';
            finish();
        }, FADE_OUT_MS);
    }

    // Sin sesión (o con el login a la vista) no hay nada que mostrar: se quita
    // al instante, sin esperar la animación de cierre.
    function cancel() {
        if (overlay) { overlay.hidden = true; overlay.innerHTML = ''; }
        started = true;
        finish();
    }

    window.NopalBoot = { wants, gate, begin, observe, fail, start, cancel, ready, enabled };
    init();
})();
