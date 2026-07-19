(() => {
    const PLUGIN_ID = 'camera-viewer';
    if (window.NopalPluginRegistry?.[PLUGIN_ID]) return;

    const state = {
        cameras: [],   // /api/cameras
        loading: false,
    };

    // Estado de la pestaña USB -- separado de `state` porque es efímero (se
    // resetea al cerrar el panel de alta, nunca se persiste), a diferencia
    // de `state.cameras` que refleja lo ya registrado.
    const usbState = {
        devices: [],        // /api/cameras/usb/discover
        loadingDevices: false,
        selectedDevice: null,
        purpose: 'monitoring',
        boundType: '',
        boundId: '',
        boundOptions: [],   // impresoras/láser/CNC ya registrados, para "Timelapse de un dispositivo"
        loadingBoundOptions: false,
    };

    let root = null;

    const icon = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    const ICON_CAMERA = '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>';
    const ICON_PLUS = '<path d="M12 5v14M5 12h14"/>';
    const ICON_TRASH = '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6"/>';
    const ICON_CLOSE = '<path d="M18 6 6 18M6 6l12 12"/>';
    const ICON_USB = '<path d="M12 2v9"/><path d="m8 6 4-4 4 4"/><circle cx="12" cy="17" r="3"/><path d="M12 14v-3"/><path d="m9 9-2 2"/><path d="m15 9 2 2"/>';
    const ICON_REFRESH = '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>';

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
        const onvifUrl = form.onvif_url.value.trim();
        const username = form.username.value.trim();
        const password = form.password.value;
        if (!name || !username || (!host && !onvifUrl)) {
            toast('Indicá la IP de la cámara o la URL completa del servicio ONVIF.', 'error');
            return;
        }
        const submitBtn = root.querySelector('#cv-add-onvif-submit-btn');
        const originalLabel = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = onvifUrl ? 'Conectando…' : (port ? 'Conectando…' : 'Buscando puerto…');
        try {
            // GetCapabilities + GetProfiles + GetStreamUri contra el dispositivo real
            // -- tarda unos segundos, más todavía si hay que escanear el puerto.
            const params = { name, username, password };
            if (onvifUrl) {
                // URL completa a mano -- salta el autoscan de puerto/path,
                // para cámaras que no publican ONVIF en /onvif/device_service.
                params.onvif_url = onvifUrl;
            } else {
                params.host = host;
                if (port) params.port = port;
            }
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

    // ── Pestaña USB (detectar → elegir propósito → confirmar) ──────────────
    // Mini-flujo guiado dentro del mismo panel de alta -- no un modal de
    // varios pasos como el asistente de impresoras, la superficie acá es
    // mucho más chica (un solo dispositivo típico, sin credenciales que
    // pedir). El registro real lo sirve el propio NOPAL vía ffmpeg (ver
    // usb_camera_service.py) -- una vez agregada, la cámara USB se comporta
    // igual que cualquier otra en el grid.

    const BOUND_DEVICE_SOURCES = [
        { type: 'bambu', label: 'Bambu Lab', url: '/api/bambu/printers', listKey: 'printers' },
        { type: 'elegoo', label: 'Elegoo', url: '/api/elegoo/printers', listKey: 'printers' },
        { type: 'flashforge', label: 'FlashForge', url: '/api/flashforge/printers', listKey: 'printers' },
        { type: 'marlin', label: 'Marlin', url: '/api/marlin-printers/registry/status', listKey: 'printers' },
        { type: 'klipper', label: 'Klipper', url: '/api/printers/status', listKey: 'printers' },
        { type: 'laser', label: 'Láser/CNC', url: '/api/laser/registry/status', listKey: 'lasers' },
    ];

    async function loadUsbDevices() {
        usbState.loadingDevices = true;
        renderUsbTab();
        try {
            const result = await api('/api/cameras/usb/discover');
            usbState.devices = result.devices || [];
        } catch (error) {
            toast(error.message, 'error');
            usbState.devices = [];
        }
        usbState.loadingDevices = false;
        renderUsbTab();
    }

    async function loadBoundDeviceOptions() {
        usbState.loadingBoundOptions = true;
        renderUsbTab();
        const options = [];
        await Promise.all(BOUND_DEVICE_SOURCES.map(async source => {
            try {
                const data = await api(source.url);
                const list = data[source.listKey] || [];
                list.forEach(entry => {
                    const id = entry.id ?? entry.device ?? entry.host ?? entry.name;
                    if (id == null) return;
                    if (source.type === 'laser') {
                        // /api/laser/registry/status junta láser y CNC -- se
                        // distinguen acá para no ofrecer un CNC como si fuera láser.
                        options.push({ type: entry.kind === 'cnc' ? 'cnc' : 'laser', id: String(id), name: entry.name || id, brandLabel: entry.kind === 'cnc' ? 'CNC' : 'Láser' });
                        return;
                    }
                    options.push({ type: source.type, id: String(id), name: entry.name || id, brandLabel: source.label });
                });
            } catch (error) {
                // Una marca sin nada registrado (o con error puntual) no debe
                // tumbar el resto de la lista -- se omite en silencio.
            }
        }));
        usbState.boundOptions = options;
        usbState.loadingBoundOptions = false;
        renderUsbTab();
    }

    function selectUsbDevice(device) {
        usbState.selectedDevice = device;
        usbState.purpose = 'monitoring';
        usbState.boundType = '';
        usbState.boundId = '';
        renderUsbTab();
    }

    function renderUsbDeviceListHtml() {
        if (usbState.loadingDevices) return '<p class="cv-empty">Buscando webcams conectadas…</p>';
        if (!usbState.devices.length) {
            return '<p class="cv-empty">No se detectó ninguna webcam USB. Conectala y tocá "Buscar de nuevo".</p>';
        }
        const registeredPaths = new Set(state.cameras.map(camera => camera.device_path).filter(Boolean));
        return usbState.devices.map(device => {
            const already = registeredPaths.has(device.device_path);
            const selected = usbState.selectedDevice && usbState.selectedDevice.device_path === device.device_path;
            return `
                <button type="button" class="cv-usb-device-item${selected ? ' selected' : ''}${already ? ' registered' : ''}" data-cv-usb-device="${esc(device.device_path)}" ${already ? 'disabled' : ''}>
                    ${icon(ICON_USB, 16)}
                    <span class="cv-usb-device-item-text">
                        <strong>${esc(device.name)}</strong>
                        <small>${esc(device.device_path)}${device.vendor_id ? ` · ${esc(device.vendor_id)}:${esc(device.product_id)}` : ''}</small>
                    </span>
                    ${already ? '<span class="cv-usb-badge">Ya registrada</span>' : ''}
                </button>`;
        }).join('');
    }

    function renderUsbDetailHtml() {
        const device = usbState.selectedDevice;
        if (!device) return '';
        const boundSection = usbState.purpose === 'timelapse' ? `
            <label>
                <span>¿Qué dispositivo vas a filmar?</span>
                <select id="cv-usb-bound-select" ${usbState.loadingBoundOptions ? 'disabled' : ''}>
                    <option value="">${usbState.loadingBoundOptions ? 'Cargando dispositivos…' : 'Elegí un dispositivo'}</option>
                    ${usbState.boundOptions.map(opt => `<option value="${esc(opt.type)}::${esc(opt.id)}" ${usbState.boundType === opt.type && usbState.boundId === opt.id ? 'selected' : ''}>${esc(opt.brandLabel)} — ${esc(opt.name)}</option>`).join('')}
                </select>
                <p class="cv-usb-hint">La captura automática de frames durante la impresión y el armado del video todavía no están implementados -- por ahora esto solo guarda la asociación para cuando esa función esté lista.</p>
            </label>` : '';
        const noteSection = usbState.purpose === 'other' ? `
            <label><span>¿Para qué la vas a usar?</span><input type="text" id="cv-usb-note-input" maxlength="140" placeholder="Ej. vigilar el taller"></label>` : '';
        return `
            <label><span>Nombre</span><input type="text" id="cv-usb-name-input" maxlength="60" value="${esc(device.name)}"></label>
            <div class="cv-usb-purpose">
                <span>¿Para qué la vas a usar?</span>
                <label class="cv-usb-radio"><input type="radio" name="cv-usb-purpose" value="monitoring" ${usbState.purpose === 'monitoring' ? 'checked' : ''}><span>Monitoreo general</span></label>
                <label class="cv-usb-radio"><input type="radio" name="cv-usb-purpose" value="timelapse" ${usbState.purpose === 'timelapse' ? 'checked' : ''}><span>Timelapse de un dispositivo</span></label>
                <label class="cv-usb-radio"><input type="radio" name="cv-usb-purpose" value="other" ${usbState.purpose === 'other' ? 'checked' : ''}><span>Otra función</span></label>
            </div>
            ${boundSection}
            ${noteSection}`;
    }

    function updateUsbSubmitEnabled() {
        const btn = root.querySelector('#cv-add-usb-submit-btn');
        if (!btn) return;
        const nameOk = !!usbState.selectedDevice;
        const boundOk = usbState.purpose !== 'timelapse' || (usbState.boundType && usbState.boundId);
        btn.disabled = !(nameOk && boundOk);
    }

    function renderUsbTab() {
        const listEl = root.querySelector('#cv-usb-device-list');
        const detailEl = root.querySelector('#cv-usb-detail');
        if (!listEl || !detailEl) return;
        listEl.innerHTML = renderUsbDeviceListHtml();
        detailEl.hidden = !usbState.selectedDevice;
        detailEl.innerHTML = renderUsbDetailHtml();
        if (usbState.purpose === 'timelapse' && !usbState.boundOptions.length && !usbState.loadingBoundOptions) {
            loadBoundDeviceOptions();
        }
        updateUsbSubmitEnabled();
    }

    async function submitUsbRegistration() {
        const device = usbState.selectedDevice;
        if (!device) return;
        const nameInput = root.querySelector('#cv-usb-name-input');
        const name = (nameInput?.value || device.name).trim();
        const noteInput = root.querySelector('#cv-usb-note-input');
        const params = { name: name || device.name, device_path: device.device_path, purpose: usbState.purpose };
        if (usbState.purpose === 'timelapse') {
            params.bound_device_type = usbState.boundType;
            params.bound_device_id = usbState.boundId;
        }
        if (usbState.purpose === 'other' && noteInput?.value.trim()) {
            params.purpose_note = noteInput.value.trim();
        }
        const submitBtn = root.querySelector('#cv-add-usb-submit-btn');
        submitBtn.disabled = true;
        try {
            await api('/api/cameras/usb/register', { method: 'POST', body: new URLSearchParams(params) });
            closeAddPanel();
            toast(`${params.name}: cámara agregada.`);
            await refreshAll();
        } catch (error) {
            toast(error.message, 'error');
            submitBtn.disabled = false;
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
        root.querySelector('#cv-add-form-usb').hidden = tab !== 'usb';
        if (tab === 'usb') loadUsbDevices();
    }

    function openAddPanel() {
        root.querySelector('#cv-add-panel').hidden = false;
    }
    function resetUsbState() {
        usbState.devices = [];
        usbState.loadingDevices = false;
        usbState.selectedDevice = null;
        usbState.purpose = 'monitoring';
        usbState.boundType = '';
        usbState.boundId = '';
        usbState.boundOptions = [];
        usbState.loadingBoundOptions = false;
    }
    function closeAddPanel() {
        root.querySelector('#cv-add-panel').hidden = true;
        root.querySelector('#cv-add-form-url').reset();
        root.querySelector('#cv-add-form-onvif').reset();
        resetUsbState();
        renderUsbTab();
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
                            <button type="button" class="cv-add-tab" data-cv-add-tab="usb">${icon(ICON_USB, 14)}<span>USB</span></button>
                        </div>
                        <form class="cv-add-form" id="cv-add-form-url">
                            <label><span>Nombre</span><input type="text" name="name" maxlength="60" placeholder="Ej. Cámara cama" required></label>
                            <label><span>URL del stream</span><input type="text" name="stream_url" placeholder="http://192.168.1.50:8080/stream  o  rtsp://usuario:clave@192.168.1.50:554/..." required></label>
                            <div class="cv-panel-actions"><button type="button" data-cv-close-add>Cancelar</button><button type="submit" class="cv-btn-accent">Agregar</button></div>
                        </form>
                        <form class="cv-add-form" id="cv-add-form-onvif" hidden>
                            <label><span>Nombre</span><input type="text" name="name" maxlength="60" placeholder="Ej. Cámara cama" required></label>
                            <label><span>IP de la cámara</span><input type="text" name="host" placeholder="192.168.1.50"></label>
                            <label><span>Puerto ONVIF <small>(opcional: si no lo sabés, lo buscamos solos)</small></span><input type="number" name="port" min="1" max="65535" placeholder="Dejalo vacío para autodetectar"></label>
                            <p class="cv-onvif-or">— o, si tu cámara no usa el path estándar —</p>
                            <label><span>URL completa del servicio ONVIF <small>(reemplaza IP + puerto)</small></span><input type="text" name="onvif_url" placeholder="http://192.168.1.50:8899/onvif/device_service"></label>
                            <label><span>Usuario</span><input type="text" name="username" placeholder="admin" required></label>
                            <label><span>Contraseña</span><input type="password" name="password" required></label>
                            <div class="cv-panel-actions"><button type="button" data-cv-close-add>Cancelar</button><button type="submit" class="cv-btn-accent" id="cv-add-onvif-submit-btn">Conectar</button></div>
                        </form>
                        <div class="cv-add-form" id="cv-add-form-usb" hidden>
                            <div class="cv-usb-list-header">
                                <span>Webcams detectadas</span>
                                <button type="button" class="cv-icon-btn" id="cv-usb-rescan-btn" title="Buscar de nuevo">${icon(ICON_REFRESH, 14)}</button>
                            </div>
                            <div id="cv-usb-device-list" class="cv-usb-device-list"></div>
                            <div id="cv-usb-detail" hidden></div>
                            <div class="cv-panel-actions"><button type="button" data-cv-close-add>Cancelar</button><button type="button" class="cv-btn-accent" id="cv-add-usb-submit-btn" disabled>Agregar</button></div>
                        </div>
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

        const usbForm = root.querySelector('#cv-add-form-usb');
        usbForm.querySelector('#cv-usb-device-list').addEventListener('click', event => {
            const btn = event.target.closest('[data-cv-usb-device]:not([disabled])');
            if (!btn) return;
            const device = usbState.devices.find(d => d.device_path === btn.dataset.cvUsbDevice);
            if (device) selectUsbDevice(device);
        });
        usbForm.addEventListener('change', event => {
            if (event.target.name === 'cv-usb-purpose') {
                usbState.purpose = event.target.value;
                renderUsbTab();
                return;
            }
            if (event.target.id === 'cv-usb-bound-select') {
                const [type, id] = (event.target.value || '').split('::');
                usbState.boundType = type || '';
                usbState.boundId = id || '';
                updateUsbSubmitEnabled();
            }
        });
        usbForm.querySelector('#cv-add-usb-submit-btn').addEventListener('click', submitUsbRegistration);
        usbForm.querySelector('#cv-usb-rescan-btn').addEventListener('click', loadUsbDevices);
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
