(() => {
    const PLUGIN_ID = 'camera-viewer';
    if (window.NopalPluginRegistry?.[PLUGIN_ID]) return;

    const state = {
        cameras: [],   // /api/cameras
        loading: false,
    };

    let root = null;

    const icon = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    const ICON_CAMERA = '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>';
    const ICON_PLUS = '<path d="M12 5v14M5 12h14"/>';
    const ICON_TRASH = '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6"/>';
    const ICON_CLOSE = '<path d="M18 6 6 18M6 6l12 12"/>';

    const esc = value => typeof window.escapeHtml === 'function' ? window.escapeHtml(value) : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const toast = (message, tone = 'success') => typeof window.showToast === 'function' ? window.showToast(message, tone) : console.log(message);
    const confirmDialog = (message, title = '') => typeof window.appConfirm === 'function' ? window.appConfirm(message, title) : Promise.resolve(window.confirm(message));

    async function api(url, options = {}) {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || 'La operación no se pudo completar.');
        return data;
    }

    // ── Acciones contra la API ──────────────────────────────────────────

    async function refreshAll() {
        state.loading = true;
        render();
        try {
            const result = await api('/api/cameras');
            state.cameras = result.cameras || [];
        } catch (error) {
            toast(error.message, 'error');
        }
        state.loading = false;
        render();
    }

    async function addCamera(event) {
        event.preventDefault();
        const form = event.target;
        const name = form.name.value.trim();
        const streamUrl = form.stream_url.value.trim();
        if (!name || !streamUrl) return;
        try {
            await api('/api/cameras', { method: 'POST', body: new URLSearchParams({ name, stream_url: streamUrl }) });
            closeAddPanel();
            toast(`${name}: cámara agregada.`);
            await refreshAll();
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    async function addCameraOnvif(event) {
        event.preventDefault();
        const form = event.target;
        const name = form.name.value.trim();
        const host = form.host.value.trim();
        const port = form.port.value.trim();
        const username = form.username.value.trim();
        const password = form.password.value;
        if (!name || !host || !username) return;
        const submitBtn = root.querySelector('#cv-add-onvif-submit-btn');
        const originalLabel = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = port ? 'Conectando…' : 'Buscando puerto…';
        try {
            // GetCapabilities + GetProfiles + GetStreamUri contra el dispositivo real
            // -- tarda unos segundos, más todavía si hay que escanear el puerto.
            const params = { name, host, username, password };
            if (port) params.port = port;
            await api('/api/cameras/onvif', { method: 'POST', body: new URLSearchParams(params) });
            closeAddPanel();
            toast(`${name}: cámara agregada.`);
            await refreshAll();
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
        }
    }

    async function removeCamera(camera) {
        if (!(await confirmDialog(`¿Eliminar "${camera.name}"? Solo se quita del registro de NOPAL, la cámara y su stream no se ven afectados.`, 'Eliminar cámara'))) return;
        try {
            await api('/api/cameras/remove', { method: 'POST', body: new URLSearchParams({ id: camera.id }) });
            await refreshAll();
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    // ── Render ───────────────────────────────────────────────────────────

    function watchStream(img) {
        const baseSrc = img.src;
        const scheduleRetry = () => {
            if (!document.body.contains(img)) return;
            setTimeout(() => {
                if (!document.body.contains(img)) return;
                const separator = baseSrc.includes('?') ? '&' : '?';
                img.src = `${baseSrc}${separator}_retry=${Date.now()}`;
            }, 5000);
        };
        img.addEventListener('error', () => {
            img.closest('.cv-card')?.classList.add('is-offline');
            scheduleRetry();
        });
        img.addEventListener('load', () => {
            img.closest('.cv-card')?.classList.remove('is-offline');
        });
    }

    function renderGrid() {
        const grid = root.querySelector('#cv-grid');
        if (!state.cameras.length) {
            grid.innerHTML = `<p class="cv-empty">${state.loading ? 'Cargando…' : 'Todavía no agregaste ninguna cámara.'}</p>`;
            return;
        }
        grid.innerHTML = state.cameras.map(camera => `
            <div class="cv-card" data-cv-camera="${camera.id}" title="Ver en grande">
                <div class="cv-stream-wrap">
                    <img class="cv-stream" src="${esc(camera.stream_url)}" alt="${esc(camera.name)}" loading="lazy">
                    <span class="cv-stream-status">Sin señal · reintentando…</span>
                </div>
                <div class="cv-card-footer">
                    <strong>${esc(camera.name)}</strong>
                    <button type="button" class="cv-icon-btn danger" data-cv-remove="${camera.id}" title="Eliminar">${icon(ICON_TRASH, 15)}</button>
                </div>
            </div>`).join('');
        grid.querySelectorAll('.cv-stream').forEach(watchStream);
    }

    function render() {
        renderGrid();
    }

    function switchAddTab(tab) {
        root.querySelectorAll('[data-cv-add-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.cvAddTab === tab));
        root.querySelector('#cv-add-form-url').hidden = tab !== 'url';
        root.querySelector('#cv-add-form-onvif').hidden = tab !== 'onvif';
    }

    function openAddPanel() {
        root.querySelector('#cv-add-panel').hidden = false;
    }
    function closeAddPanel() {
        root.querySelector('#cv-add-panel').hidden = true;
        root.querySelector('#cv-add-form-url').reset();
        root.querySelector('#cv-add-form-onvif').reset();
        switchAddTab('url');
    }

    function openLightbox(camera) {
        root.querySelector('#cv-lightbox-title').textContent = camera.name;
        root.querySelector('#cv-lightbox-img').src = camera.stream_url;
        root.querySelector('#cv-lightbox').hidden = false;
    }
    function closeLightbox() {
        root.querySelector('#cv-lightbox').hidden = true;
        // Corta la conexión del stream grande al cerrar -- un MJPEG queda
        // abierto indefinidamente si no se le vacía el src.
        root.querySelector('#cv-lightbox-img').src = '';
    }

    function moduleHtml() {
        return `
            <section id="camera-viewer-section" class="view-section cv-section" style="display:none">
                <div class="cv-scroll">
                    <header class="cv-header">
                        <div class="cv-header-icon">${icon(ICON_CAMERA, 30)}</div>
                        <div class="cv-header-copy">
                            <h1>Cámaras</h1>
                            <span class="cv-header-sub">NOPAL Labs · v1.0.0</span>
                        </div>
                        <button type="button" class="cv-btn cv-btn-accent" id="cv-add-btn">${icon(ICON_PLUS, 16)}<span>Agregar cámara</span></button>
                    </header>

                    <div class="cv-grid" id="cv-grid"></div>
                </div>

                <div class="cv-panel-overlay" id="cv-add-panel" hidden>
                    <div class="cv-panel-backdrop" data-cv-close-add></div>
                    <div class="cv-panel-dialog">
                        <div class="cv-panel-header"><span><strong>Agregar cámara</strong><small>Un stream MJPEG directo, o resolvela sola por ONVIF (recomendado si tu cámara lo soporta: no hace falta saber el formato de URL RTSP).</small></span><button type="button" data-cv-close-add>${icon(ICON_CLOSE, 16)}</button></div>
                        <div class="cv-add-tabs">
                            <button type="button" class="cv-add-tab active" data-cv-add-tab="url">URL directa</button>
                            <button type="button" class="cv-add-tab" data-cv-add-tab="onvif">ONVIF</button>
                        </div>
                        <form class="cv-add-form" id="cv-add-form-url">
                            <label><span>Nombre</span><input type="text" name="name" maxlength="60" placeholder="Ej. Cámara cama" required></label>
                            <label><span>URL del stream</span><input type="text" name="stream_url" placeholder="http://192.168.1.50:8080/stream  o  rtsp://usuario:clave@192.168.1.50:554/..." required></label>
                            <div class="cv-panel-actions"><button type="button" data-cv-close-add>Cancelar</button><button type="submit" class="cv-btn-accent">Agregar</button></div>
                        </form>
                        <form class="cv-add-form" id="cv-add-form-onvif" hidden>
                            <label><span>Nombre</span><input type="text" name="name" maxlength="60" placeholder="Ej. Cámara cama" required></label>
                            <label><span>IP de la cámara</span><input type="text" name="host" placeholder="192.168.1.50" required></label>
                            <label><span>Puerto ONVIF <small>(opcional: si no lo sabés, lo buscamos solos)</small></span><input type="number" name="port" min="1" max="65535" placeholder="Dejalo vacío para autodetectar"></label>
                            <label><span>Usuario</span><input type="text" name="username" placeholder="admin" required></label>
                            <label><span>Contraseña</span><input type="password" name="password" required></label>
                            <div class="cv-panel-actions"><button type="button" data-cv-close-add>Cancelar</button><button type="submit" class="cv-btn-accent" id="cv-add-onvif-submit-btn">Conectar</button></div>
                        </form>
                    </div>
                </div>

                <div class="cv-panel-overlay" id="cv-lightbox" hidden>
                    <div class="cv-panel-backdrop" data-cv-close-lightbox></div>
                    <div class="cv-lightbox-dialog">
                        <div class="cv-lightbox-header">
                            <strong id="cv-lightbox-title"></strong>
                            <button type="button" data-cv-close-lightbox>${icon(ICON_CLOSE, 18)}</button>
                        </div>
                        <img id="cv-lightbox-img" class="cv-lightbox-img" alt="">
                    </div>
                </div>
            </section>`;
    }

    function bindEvents() {
        root.querySelector('#cv-add-btn').addEventListener('click', openAddPanel);
        root.querySelectorAll('[data-cv-close-add]').forEach(el => el.addEventListener('click', closeAddPanel));
        root.querySelectorAll('[data-cv-add-tab]').forEach(btn => btn.addEventListener('click', () => switchAddTab(btn.dataset.cvAddTab)));
        root.querySelector('#cv-add-form-url').addEventListener('submit', addCamera);
        root.querySelector('#cv-add-form-onvif').addEventListener('submit', addCameraOnvif);
        root.querySelectorAll('[data-cv-close-lightbox]').forEach(el => el.addEventListener('click', closeLightbox));
        root.querySelector('#cv-grid').addEventListener('click', event => {
            const removeBtn = event.target.closest('[data-cv-remove]');
            if (removeBtn) {
                const camera = state.cameras.find(item => item.id === removeBtn.dataset.cvRemove);
                if (camera) removeCamera(camera);
                return;
            }
            const card = event.target.closest('.cv-card');
            if (!card) return;
            const camera = state.cameras.find(item => item.id === card.dataset.cvCamera);
            if (camera) openLightbox(camera);
        });
    }

    function mount() {
        if (document.getElementById('camera-viewer-section')) return;
        const pluginsContainer = document.querySelector('.nav-category[data-group="plugins"] .nav-category-items');
        const navButton = document.createElement('button');
        navButton.type = 'button';
        navButton.className = 'nav-item';
        navButton.dataset.section = 'camera-viewer';
        navButton.dataset.pluginNav = PLUGIN_ID;
        navButton.title = 'Cámaras';
        navButton.innerHTML = `${icon(ICON_CAMERA, 20)}<span>Cámaras</span>`;
        navButton.addEventListener('click', () => window.switchSection?.('camera-viewer'));
        pluginsContainer?.appendChild(navButton);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = moduleHtml();
        root = wrapper.firstElementChild;
        const content = document.querySelector('.content');
        content?.insertBefore(root, document.getElementById('gcode-editor-section'));

        bindEvents();
        refreshAll();
        window.applySidebarOrder?.();
    }

    function unmount() {
        document.querySelector(`[data-plugin-nav="${PLUGIN_ID}"]`)?.remove();
        document.getElementById('camera-viewer-section')?.remove();
        root = null;
    }

    window.NopalPluginRegistry = window.NopalPluginRegistry || {};
    window.NopalPluginRegistry[PLUGIN_ID] = { mount, unmount, version: '1.0.0' };
    mount();
})();
