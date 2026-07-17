(() => {
    const PLUGIN_ID = 'arduino-accessories';
    if (window.NopalPluginRegistry?.[PLUGIN_ID]) return;

    const state = {
        accessories: [],   // /api/accessories/status, filtrados a driver === 'arduino'
        boards: [],        // /api/accessories/arduino/discover
        activity: [],       // /api/accessories/activity
        scenes: [],         // /api/accessories/scenes
        builds: [],          // /api/accessories/firmware/builds
        selectedBuild: null, // filename del .bin elegido para flashear
        tab: 'relays',       // 'relays' | 'leds'
        loading: false,
    };

    let root = null;

    const icon = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    const ICON_CPU = '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>';
    const ICON_PLUG = '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z"/>';
    const ICON_LED = '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.5.5.8 1 .8 1.7V16h6.4v-.8c0-.7.3-1.2.8-1.7A6 6 0 0 0 12 3Z"/>';
    const ICON_WIFI_OFF = '<path d="M12 20h.01"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.5a10 10 0 0 1 5-2.5"/><path d="M19 12.5a10 10 0 0 0-3-2.1"/>';
    const ICON_ACTIVITY = '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>';
    const ICON_SCENE = '<path d="M12 2v4M4.9 4.9l2.8 2.8M2 12h4M4.9 19.1l2.8-2.8M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"/>';
    const ICON_INFO = '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>';
    const ICON_DOCS = '<path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14 4v5h5"/>';
    const ICON_GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>';
    const ICON_CLOSE = '<path d="M18 6 6 18M6 6l12 12"/>';
    const ICON_TRASH = '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6"/>';
    const ICON_PENCIL = '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>';
    const ICON_PLAY = '<path d="m7 4 13 8-13 8Z"/>';
    const ICON_PLUS = '<path d="M12 5v14M5 12h14"/>';
    const ICON_REFRESH = '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>';
    const ICON_FLASH = '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>';
    const ICON_UPLOAD = '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>';
    const ICON_WIFI_ON = '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/>';

    const esc = value => typeof window.escapeHtml === 'function' ? window.escapeHtml(value) : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const toast = (message, tone = 'success') => typeof window.showToast === 'function' ? window.showToast(message, tone) : console.log(message);
    const confirmDialog = (message, title = '') => typeof window.appConfirm === 'function' ? window.appConfirm(message, title) : Promise.resolve(window.confirm(message));

    async function api(url, options = {}) {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || 'La operación no se pudo completar.');
        return data;
    }

    function formatRelativeTime(unixSeconds) {
        const diffMs = Date.now() - unixSeconds * 1000;
        const minutes = Math.floor(diffMs / 60000);
        if (minutes < 1) return 'Justo ahora';
        if (minutes < 60) return `Hace ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `Hace ${hours} h`;
        const days = Math.floor(hours / 24);
        return `Hace ${days} d`;
    }

    function formatUptime(ms, firmware) {
        if (!ms || parseFloat(firmware) < 1.2) return 'No disponible en este firmware';
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    function formatHeap(bytes, firmware) {
        if (!bytes || parseFloat(firmware) < 1.2) return 'No disponible en este firmware';
        return `${Math.round(bytes / 1024)} KB libres`;
    }

    function boardDeviceSet() {
        const devices = new Set(state.boards.map(board => board.device));
        const locations = new Set(state.boards.map(board => board.location).filter(Boolean));
        return { devices, locations };
    }

    function accessoryConnected(accessory) {
        const { devices, locations } = boardDeviceSet();
        const config = accessory.config || {};
        return (config.device && devices.has(config.device)) || (config.location && locations.has(config.location));
    }

    function primaryBoard() {
        return state.boards[0] || null;
    }

    // ── Acciones contra la API ──────────────────────────────────────────

    async function refreshAll() {
        state.loading = true;
        render();
        const [statusResult, boardsResult, activityResult, scenesResult] = await Promise.allSettled([
            api('/api/accessories/status'),
            api('/api/accessories/arduino/discover'),
            api('/api/accessories/activity'),
            api('/api/accessories/scenes'),
        ]);
        if (statusResult.status === 'fulfilled') {
            state.accessories = (statusResult.value.accessories || []).filter(item => item.driver === 'arduino');
        }
        if (boardsResult.status === 'fulfilled') state.boards = boardsResult.value.boards || [];
        if (activityResult.status === 'fulfilled') state.activity = activityResult.value.activity || [];
        if (scenesResult.status === 'fulfilled') state.scenes = scenesResult.value.scenes || [];
        state.loading = false;
        render();
    }

    async function togglePower(accessory) {
        try {
            await api('/api/accessories/power', { method: 'POST', body: new URLSearchParams({ id: accessory.id, on: String(!accessory.on) }) });
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function applyLedColor(accessory, hex) {
        const red = parseInt(hex.slice(1, 3), 16);
        const green = parseInt(hex.slice(3, 5), 16);
        const blue = parseInt(hex.slice(5, 7), 16);
        try {
            await api('/api/accessories/led', { method: 'POST', body: new URLSearchParams({ id: accessory.id, r: red, g: green, b: blue }) });
            toast(`${accessory.name}: color actualizado.`);
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function renameAccessory(accessory) {
        const name = window.prompt('Nuevo nombre para el accesorio:', accessory.name);
        if (!name || name === accessory.name) return;
        try {
            await api('/api/accessories/rename', { method: 'POST', body: new URLSearchParams({ id: accessory.id, name }) });
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function removeAccessory(accessory) {
        if (!(await confirmDialog(`¿Eliminar "${accessory.name}"? Se quita del registro de NOPAL, la placa no se ve afectada.`, 'Eliminar accesorio'))) return;
        try {
            await api('/api/accessories/remove', { method: 'POST', body: new URLSearchParams({ id: accessory.id }) });
            toast(`${accessory.name} se eliminó.`);
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function registerFromForm(form) {
        const deviceValue = form.querySelector('#aa-add-device').value;
        const board = state.boards.find(item => item.device === deviceValue);
        if (!board) return toast('Selecciona una placa detectada.', 'error');
        const name = form.querySelector('input[name="name"]').value.trim();
        if (!name) return toast('Ponle un nombre al accesorio.', 'error');
        const isLed = form.querySelector('#aa-add-kind').value === 'led_strip';
        const config = { device: board.device };
        if (board.location) config.location = board.location;
        if (isLed) {
            config.led_mode = form.querySelector('select[name="led_mode"]').value;
        } else {
            config.relay = parseInt(form.querySelector('#aa-add-relay').value, 10);
        }
        const body = new URLSearchParams({
            name,
            kind: isLed ? 'led_strip' : 'relay',
            driver: 'arduino',
            config: JSON.stringify(config),
        });
        try {
            await api('/api/accessories', { method: 'POST', body });
            toast(`${name} se agregó.`);
            closeAddPanel();
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function runScene(scene) {
        try {
            const result = await api(`/api/accessories/scenes/${scene.id}/run`, { method: 'POST' });
            toast(result.success ? `Escena "${scene.name}" ejecutada.` : `"${scene.name}" se ejecutó parcialmente — revisa la conexión de la placa.`, result.success ? 'success' : 'warning');
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function deleteScene(scene) {
        if (!(await confirmDialog(`¿Eliminar la escena "${scene.name}"?`, 'Eliminar escena'))) return;
        try {
            await api(`/api/accessories/scenes/${scene.id}`, { method: 'DELETE' });
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function createSceneFromForm(form) {
        const name = form.querySelector('#aa-scene-name').value.trim();
        if (!name) return toast('Ponle un nombre a la escena.', 'error');
        const actions = [];
        form.querySelectorAll('[data-aa-scene-row]').forEach(row => {
            if (!row.querySelector('[data-aa-scene-include]').checked) return;
            const accessoryId = row.dataset.aaSceneRow;
            const accessory = state.accessories.find(item => item.id === accessoryId);
            if (!accessory) return;
            if (accessory.kind === 'led_strip') {
                const hex = row.querySelector('[data-aa-scene-color]').value;
                actions.push({ accessory_id: accessoryId, color: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] });
            } else {
                const on = row.querySelector('[data-aa-scene-state]').value === 'on';
                actions.push({ accessory_id: accessoryId, on });
            }
        });
        if (!actions.length) return toast('Incluye al menos un accesorio en la escena.', 'error');
        try {
            await api('/api/accessories/scenes', { method: 'POST', body: new URLSearchParams({ name, actions: JSON.stringify(actions) }) });
            toast(`Escena "${name}" creada.`);
            closeSceneModal();
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    // ── Render ──────────────────────────────────────────────────────────

    function moduleHtml() {
        return `
            <section id="arduino-accessories-section" class="view-section aa-section" style="display:none">
                <div class="aa-scroll">
                    <header class="aa-header">
                        <div class="aa-header-icon">${icon(ICON_CPU, 30)}</div>
                        <div class="aa-header-copy">
                            <h1>Accesorios Arduino/ESP32</h1>
                            <span class="aa-header-sub">NOPAL Labs · v1.0.0</span>
                        </div>
                        <div class="aa-header-status" id="aa-header-status"></div>
                        <div class="aa-header-actions">
                            <button type="button" class="aa-btn" id="aa-docs-btn">${icon(ICON_DOCS, 16)}<span>Documentación</span></button>
                            <button type="button" class="aa-btn" id="aa-firmware-btn">${icon(ICON_FLASH, 16)}<span>Firmware</span></button>
                            <button type="button" class="aa-btn" id="aa-config-btn">${icon(ICON_GEAR, 16)}<span>Configuración</span></button>
                            <button type="button" class="aa-btn aa-btn-icon" id="aa-close-btn" title="Cerrar">${icon(ICON_CLOSE, 16)}</button>
                        </div>
                        <div class="aa-header-facts" id="aa-header-facts"></div>
                    </header>

                    <div class="aa-grid">
                        <section class="aa-card aa-span-2">
                            <h2>${icon(ICON_ACTIVITY, 16)}Resumen del sistema</h2>
                            <div class="aa-summary-tiles" id="aa-summary-tiles"></div>
                        </section>

                        <section class="aa-card">
                            <h2>${icon(ICON_WIFI_OFF, 16)}Estado de conexión</h2>
                            <div id="aa-connection-body"></div>
                            <button type="button" class="aa-btn aa-btn-block" id="aa-test-connection-btn">${icon(ICON_REFRESH, 16)}<span>Probar conexión</span></button>
                        </section>
                    </div>

                    <section class="aa-card">
                        <div class="aa-card-title-row">
                            <h2>${icon(ICON_PLUG, 16)}Dispositivos y controles</h2>
                            <button type="button" class="aa-btn aa-btn-accent" id="aa-add-btn">${icon(ICON_PLUS, 16)}<span>Agregar accesorio</span></button>
                        </div>
                        <div class="aa-tabs">
                            <button type="button" class="aa-tab active" data-aa-tab="relays">Relés</button>
                            <button type="button" class="aa-tab" data-aa-tab="leds">Tiras LED</button>
                        </div>
                        <div id="aa-devices-body"></div>
                    </section>

                    <div class="aa-grid">
                        <section class="aa-card">
                            <h2>${icon(ICON_ACTIVITY, 16)}Actividad reciente</h2>
                            <div id="aa-activity-body"></div>
                        </section>

                        <section class="aa-card">
                            <div class="aa-card-title-row">
                                <h2>${icon(ICON_SCENE, 16)}Macros y escenas</h2>
                                <button type="button" class="aa-btn" id="aa-new-scene-btn">${icon(ICON_PLUS, 16)}<span>Nueva escena</span></button>
                            </div>
                            <div id="aa-scenes-body"></div>
                        </section>
                    </div>

                    <section class="aa-card">
                        <h2>${icon(ICON_INFO, 16)}Información del dispositivo</h2>
                        <div id="aa-device-info-body"></div>
                    </section>
                </div>

                <div class="aa-panel-overlay" id="aa-add-panel" hidden>
                    <div class="aa-panel-backdrop" data-aa-close-add></div>
                    <form class="aa-panel-dialog" id="aa-add-form">
                        <div class="aa-panel-header"><span><strong>Agregar accesorio</strong><small>Se registra contra una placa detectada por USB.</small></span><button type="button" data-aa-close-add>×</button></div>
                        <label><span>Placa</span><select name="device" id="aa-add-device"></select></label>
                        <label><span>Tipo</span>
                            <select name="kind" id="aa-add-kind">
                                <option value="relay">Relé</option>
                                <option value="led_strip">Tira LED</option>
                            </select>
                        </label>
                        <label id="aa-add-relay-field"><span>Relé</span><select name="relay" id="aa-add-relay"></select></label>
                        <label id="aa-add-led-field" hidden><span>Tipo de tira</span>
                            <select name="led_mode">
                                <option value="ws2812">WS2812 / NeoPixel</option>
                                <option value="pwm">PWM analógica (RGB)</option>
                            </select>
                        </label>
                        <label><span>Nombre</span><input type="text" name="name" maxlength="60" placeholder="Ej. Luz taller" required></label>
                        <div class="aa-panel-actions"><button type="button" data-aa-close-add>Cancelar</button><button type="submit" class="aa-btn-accent">Agregar</button></div>
                    </form>
                </div>

                <div class="aa-panel-overlay" id="aa-scene-panel" hidden>
                    <div class="aa-panel-backdrop" data-aa-close-scene></div>
                    <form class="aa-panel-dialog" id="aa-scene-form">
                        <div class="aa-panel-header"><span><strong>Nueva escena</strong><small>Aplica varias acciones sobre accesorios registrados de un solo golpe.</small></span><button type="button" data-aa-close-scene>×</button></div>
                        <label><span>Nombre</span><input type="text" id="aa-scene-name" maxlength="60" placeholder="Ej. Taller ON" required></label>
                        <div class="aa-scene-rows" id="aa-scene-rows"></div>
                        <div class="aa-panel-actions"><button type="button" data-aa-close-scene>Cancelar</button><button type="submit" class="aa-btn-accent">Crear escena</button></div>
                    </form>
                </div>

                <div class="aa-panel-overlay" id="aa-docs-panel" hidden>
                    <div class="aa-panel-backdrop" data-aa-close-docs></div>
                    <div class="aa-panel-dialog aa-docs-dialog">
                        <div class="aa-panel-header"><span><strong>Protocolo NOPAL</strong><small>Comandos reales que entiende firmware/nopal_accessory.ino</small></span><button type="button" data-aa-close-docs>×</button></div>
                        <table class="aa-docs-table">
                            <tbody>
                                <tr><td><code>NOPAL:ID?</code></td><td>Identificación: chip, firmware, relés, capacidades de LED, red/OTA (1.3+), uptime, memoria libre.</td></tr>
                                <tr><td><code>NOPAL:NET?</code></td><td>Estado detallado de red: WiFi conectado, modo, IP, punto de acceso de recuperación.</td></tr>
                                <tr><td><code>NOPAL:R{n}?</code></td><td>Consulta el estado del relé n (ON/OFF).</td></tr>
                                <tr><td><code>NOPAL:R{n}:ON</code></td><td>Enciende el relé n.</td></tr>
                                <tr><td><code>NOPAL:R{n}:OFF</code></td><td>Apaga el relé n.</td></tr>
                                <tr><td><code>NOPAL:LED:r,g,b</code></td><td>Fija el color de la tira PWM analógica (0-255 por canal).</td></tr>
                                <tr><td><code>NOPAL:WS:r,g,b</code></td><td>Fija el color sólido de la tira WS2812/NeoPixel completa.</td></tr>
                            </tbody>
                        </table>
                        <p class="aa-docs-note">Comunicación por USB-serie a 115200 baudios, un comando por línea. Desde el firmware 1.3, WiFi y actualización OTA (ElegantOTA) son opcionales — una placa sin WiFi configurado sigue funcionando 100% por USB.</p>
                    </div>
                </div>

                <div class="aa-panel-overlay" id="aa-firmware-panel" hidden>
                    <div class="aa-panel-backdrop" data-aa-close-firmware></div>
                    <div class="aa-panel-dialog aa-firmware-dialog">
                        <div class="aa-panel-header"><span><strong>Firmware</strong><small>NOPAL no compila nada — solo flashea binarios .bin ya exportados desde Arduino IDE (Sketch → Export Compiled Binary).</small></span><button type="button" data-aa-close-firmware>×</button></div>

                        <label><span>Subir binario nuevo (.bin)</span><input type="file" id="aa-firmware-file-input" accept=".bin"></label>

                        <div class="aa-firmware-section-title">Binarios disponibles</div>
                        <div id="aa-firmware-builds-list"></div>

                        <div class="aa-firmware-section-title">Credenciales OTA (ElegantOTA, si aplica)</div>
                        <div class="aa-firmware-ota-creds">
                            <input type="text" id="aa-firmware-ota-user" placeholder="Usuario OTA">
                            <input type="password" id="aa-firmware-ota-pass" placeholder="Contraseña OTA">
                        </div>

                        <div class="aa-firmware-section-title">Placas detectadas</div>
                        <div id="aa-firmware-boards-list"></div>
                    </div>
                </div>
            </section>`;
    }

    function renderHeader() {
        const board = primaryBoard();
        const connected = !!board;
        const statusEl = root.querySelector('#aa-header-status');
        statusEl.innerHTML = `<span class="aa-status-dot${connected ? ' is-on' : ''}"></span><span>${connected ? 'Activo y conectado' : (state.accessories.length ? 'Sin placa conectada' : 'Sin configurar')}</span>`;
        const factsEl = root.querySelector('#aa-header-facts');
        if (!board) {
            factsEl.innerHTML = `<span class="aa-fact">${state.loading ? 'Buscando placas…' : 'Ninguna placa NOPAL detectada por USB ahora mismo.'}</span>`;
            return;
        }
        const wifiFacts = board.wifi
            ? `<span class="aa-fact"><label>WiFi</label><strong>${board.wifi_connected ? `Conectado (${esc(board.ip || '—')})` : 'Sin conexión'}</strong></span>`
            : '';
        factsEl.innerHTML = `
            <span class="aa-fact"><label>Placa</label><strong>${esc(board.chip || '—')}</strong></span>
            <span class="aa-fact"><label>Puerto</label><strong>${esc(board.device)}</strong></span>
            <span class="aa-fact"><label>Firmware</label><strong>v${esc(board.firmware || '—')}</strong></span>
            ${wifiFacts}
            <span class="aa-fact"><label>Estado</label><strong>Activo y conectado</strong></span>`;
    }

    function renderSummary() {
        const relays = state.accessories.filter(item => item.kind !== 'led_strip');
        const leds = state.accessories.filter(item => item.kind === 'led_strip');
        const relaysOn = relays.filter(item => item.on).length;
        const ledsOn = leds.filter(item => item.on).length;
        const anyFailed = state.accessories.some(item => item.on === null);
        const estado = !state.accessories.length ? 'Sin accesorios' : anyFailed ? 'Con errores' : 'Óptimo';
        root.querySelector('#aa-summary-tiles').innerHTML = `
            <div class="aa-tile"><div class="aa-tile-icon">${icon(ICON_PLUG, 22)}</div><strong>${relays.length}</strong><span>Relés</span><small>${relaysOn} activos</small></div>
            <div class="aa-tile"><div class="aa-tile-icon">${icon(ICON_LED, 22)}</div><strong>${leds.length}</strong><span>Tiras LED</span><small>${ledsOn} activas</small></div>
            <div class="aa-tile"><div class="aa-tile-icon">${icon(ICON_WIFI_OFF, 22)}</div><strong>USB</strong><span>Conectividad</span><small>Serie local</small></div>
            <div class="aa-tile"><div class="aa-tile-icon">${icon(anyFailed ? ICON_WIFI_OFF : ICON_ACTIVITY, 22)}</div><strong>${estado}</strong><span>Estado</span><small>${anyFailed ? 'Revisa la conexión' : 'Sin errores'}</small></div>`;
    }

    function renderConnection() {
        const body = root.querySelector('#aa-connection-body');
        if (!state.boards.length) {
            body.innerHTML = `<p class="aa-empty">${state.loading ? 'Buscando…' : 'Ninguna placa conectada por USB.'}</p>`;
            return;
        }
        body.innerHTML = state.boards.map(board => `
            <div class="aa-connection-row">
                <span class="aa-status-dot is-on"></span>
                <div><strong>${esc(board.chip || board.device)}</strong><small>${esc(board.device)}</small></div>
                <span class="aa-connection-latency">${board.latency_ms != null ? `${board.latency_ms} ms` : '—'}</span>
            </div>`).join('');
    }

    function renderAccessoryRow(accessory) {
        const connected = accessoryConnected(accessory);
        const isLed = accessory.kind === 'led_strip';
        const color = Array.isArray(accessory.config?.led_color) ? `#${accessory.config.led_color.map(v => v.toString(16).padStart(2, '0')).join('')}` : '#34f58b';
        return `
            <div class="aa-device-row${connected ? '' : ' is-offline'}" data-aa-accessory="${accessory.id}">
                <span class="aa-status-dot${accessory.on ? ' is-on' : ''}"></span>
                <div class="aa-device-name">
                    <strong>${esc(accessory.name)}</strong>
                    <small>${isLed ? (accessory.config?.led_mode === 'pwm' ? 'PWM RGB' : 'WS2812') : `Relé ${esc(accessory.config?.relay ?? '?')}`}${connected ? '' : ' · Placa no detectada'}</small>
                </div>
                ${isLed
                    ? `<input type="color" class="aa-color-input" value="${color}" data-aa-led="${accessory.id}" ${connected ? '' : 'disabled'}>`
                    : `<label class="aa-switch"><input type="checkbox" data-aa-toggle="${accessory.id}" ${accessory.on ? 'checked' : ''} ${connected ? '' : 'disabled'}><span></span></label>`}
                <button type="button" class="aa-icon-btn" data-aa-rename="${accessory.id}" title="Renombrar">${icon(ICON_PENCIL, 15)}</button>
                <button type="button" class="aa-icon-btn danger" data-aa-remove="${accessory.id}" title="Eliminar">${icon(ICON_TRASH, 15)}</button>
            </div>`;
    }

    function renderDevices() {
        root.querySelectorAll('[data-aa-tab]').forEach(button => button.classList.toggle('active', button.dataset.aaTab === state.tab));
        const list = state.accessories.filter(item => (state.tab === 'leds') === (item.kind === 'led_strip'));
        const body = root.querySelector('#aa-devices-body');
        if (!list.length) {
            body.innerHTML = `<p class="aa-empty">${state.tab === 'leds' ? 'No hay tiras LED registradas todavía.' : 'No hay relés registrados todavía.'}</p>`;
            return;
        }
        body.innerHTML = list.map(renderAccessoryRow).join('');
    }

    function renderActivity() {
        const body = root.querySelector('#aa-activity-body');
        if (!state.activity.length) {
            body.innerHTML = `<p class="aa-empty">Todavía no hay actividad registrada.</p>`;
            return;
        }
        const labels = { power_on: 'se encendió', power_off: 'se apagó', led_color: 'cambió de color', registered: 'se registró', removed: 'se eliminó', renamed: 'se renombró', scene_run: 'se ejecutó' };
        body.innerHTML = `<ul class="aa-activity-list">${state.activity.slice(0, 12).map(entry => `
            <li><span class="aa-status-dot${entry.action === 'power_on' ? ' is-on' : ''}"></span><span class="aa-activity-text"><strong>${esc(entry.name)}</strong> ${esc(labels[entry.action] || entry.action)}</span><small>${formatRelativeTime(entry.timestamp)}</small></li>`).join('')}</ul>`;
    }

    function renderScenes() {
        const body = root.querySelector('#aa-scenes-body');
        if (!state.scenes.length) {
            body.innerHTML = `<p class="aa-empty">Todavía no hay escenas creadas.</p>`;
            return;
        }
        body.innerHTML = state.scenes.map(scene => `
            <div class="aa-scene-row">
                <div><strong>${esc(scene.name)}</strong><small>${scene.actions.length} acción${scene.actions.length === 1 ? '' : 'es'}</small></div>
                <button type="button" class="aa-icon-btn" data-aa-run-scene="${scene.id}" title="Ejecutar">${icon(ICON_PLAY, 15)}</button>
                <button type="button" class="aa-icon-btn danger" data-aa-delete-scene="${scene.id}" title="Eliminar">${icon(ICON_TRASH, 15)}</button>
            </div>`).join('');
    }

    function renderDeviceInfo() {
        const board = primaryBoard();
        const body = root.querySelector('#aa-device-info-body');
        if (!board) {
            body.innerHTML = `<p class="aa-empty">Conecta una placa para ver su información.</p>`;
            return;
        }
        body.innerHTML = `
            <div class="aa-info-grid">
                <div><label>Modelo</label><strong>${esc(board.chip || '—')}</strong></div>
                <div><label>Firmware</label><strong>v${esc(board.firmware || '—')}</strong></div>
                <div><label>Relés</label><strong>${board.relays}</strong></div>
                <div><label>Tira LED</label><strong>${board.ws2812 ? `WS2812 (${board.ws2812_count} px)` : board.pwm_led ? 'PWM RGB' : 'No'}</strong></div>
                <div><label>Uptime</label><strong>${formatUptime(board.uptime_ms, board.firmware)}</strong></div>
                <div><label>Memoria libre</label><strong>${formatHeap(board.free_heap, board.firmware)}</strong></div>
                <div><label>WiFi</label><strong>${board.wifi ? (board.wifi_connected ? `${esc(board.wifi_mode || 'sta')} · ${esc(board.ip || '—')}` : 'Sin conexión') : 'No soportado (fw < 1.3)'}</strong></div>
                <div><label>OTA</label><strong>${board.ota ? 'Disponible' : 'No disponible'}</strong></div>
            </div>
            <p class="aa-docs-note">Voltaje, corriente y temperatura no se muestran: este firmware genérico no trae esos sensores.</p>`;
    }

    function populateAddForm() {
        const deviceSelect = root.querySelector('#aa-add-device');
        deviceSelect.innerHTML = state.boards.length
            ? state.boards.map(board => `<option value="${esc(board.device)}">${esc(board.chip || board.device)} · ${esc(board.device)}</option>`).join('')
            : '<option value="">Ninguna placa detectada</option>';
        updateAddFormFields();
    }

    function updateAddFormFields() {
        const board = state.boards.find(item => item.device === root.querySelector('#aa-add-device').value) || state.boards[0];
        const isLed = root.querySelector('#aa-add-kind').value === 'led_strip';
        root.querySelector('#aa-add-relay-field').hidden = isLed;
        root.querySelector('#aa-add-led-field').hidden = !isLed;
        const relaySelect = root.querySelector('#aa-add-relay');
        const relayCount = Math.max(board?.relays || 0, 1);
        relaySelect.innerHTML = Array.from({ length: relayCount }, (_, index) => `<option value="${index + 1}">Relé ${index + 1}</option>`).join('');
    }

    function openAddPanel() {
        populateAddForm();
        root.querySelector('#aa-add-panel').hidden = false;
    }
    function closeAddPanel() {
        root.querySelector('#aa-add-panel').hidden = true;
        root.querySelector('#aa-add-form').reset();
    }

    function openSceneModal() {
        const rows = root.querySelector('#aa-scene-rows');
        if (!state.accessories.length) {
            rows.innerHTML = `<p class="aa-empty">Registra al menos un accesorio primero.</p>`;
        } else {
            rows.innerHTML = state.accessories.map(accessory => `
                <label class="aa-scene-row-form" data-aa-scene-row="${accessory.id}">
                    <input type="checkbox" data-aa-scene-include>
                    <span>${esc(accessory.name)}</span>
                    ${accessory.kind === 'led_strip'
                        ? `<input type="color" data-aa-scene-color value="#34f58b">`
                        : `<select data-aa-scene-state><option value="on">Encender</option><option value="off">Apagar</option></select>`}
                </label>`).join('');
        }
        root.querySelector('#aa-scene-panel').hidden = false;
    }
    function closeSceneModal() {
        root.querySelector('#aa-scene-panel').hidden = true;
        root.querySelector('#aa-scene-form').reset();
    }

    // ── Firmware ────────────────────────────────────────────────────────

    async function loadFirmwareBuilds() {
        try {
            const data = await api('/api/accessories/firmware/builds');
            state.builds = data.builds || [];
            if (!state.builds.some(build => build.filename === state.selectedBuild)) {
                state.selectedBuild = state.builds[0]?.filename || null;
            }
        } catch (error) { toast(error.message, 'error'); }
    }

    function formatBuildSize(bytes) {
        if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${Math.round(bytes / 1024)} KB`;
    }

    function renderFirmwareBuilds() {
        const list = root.querySelector('#aa-firmware-builds-list');
        if (!state.builds.length) {
            list.innerHTML = `<p class="aa-empty">Todavía no subiste ningún binario .bin.</p>`;
            return;
        }
        list.innerHTML = state.builds.map(build => `
            <label class="aa-firmware-build-row">
                <input type="radio" name="aa-firmware-build" value="${esc(build.filename)}" ${build.filename === state.selectedBuild ? 'checked' : ''}>
                <span>${esc(build.filename)}</span>
                <small>${formatBuildSize(build.size)}</small>
            </label>`).join('');
    }

    function renderFirmwareBoards() {
        const list = root.querySelector('#aa-firmware-boards-list');
        if (!state.boards.length) {
            list.innerHTML = `<p class="aa-empty">Ninguna placa detectada por USB ahora mismo.</p>`;
            return;
        }
        list.innerHTML = state.boards.map(board => `
            <div class="aa-firmware-board-row">
                <div><strong>${esc(board.chip || board.device)}</strong><small>${esc(board.device)} · fw v${esc(board.firmware || '—')}</small></div>
                <button type="button" class="aa-btn" data-aa-flash-usb="${esc(board.device)}" ${state.selectedBuild ? '' : 'disabled'}>${icon(ICON_UPLOAD, 15)}<span>Por USB</span></button>
                <button type="button" class="aa-btn" data-aa-flash-ota="${esc(board.device)}" ${state.selectedBuild && board.wifi_connected && board.ota ? '' : 'disabled'} title="${board.wifi_connected && board.ota ? '' : 'Necesita WiFi conectado y OTA disponible (firmware 1.3+)'}">${icon(ICON_WIFI_ON, 15)}<span>Por WiFi</span></button>
            </div>`).join('');
    }

    function renderFirmwarePanel() {
        renderFirmwareBuilds();
        renderFirmwareBoards();
    }

    async function openFirmwarePanel() {
        root.querySelector('#aa-firmware-panel').hidden = false;
        await loadFirmwareBuilds();
        renderFirmwarePanel();
    }
    function closeFirmwarePanel() {
        root.querySelector('#aa-firmware-panel').hidden = true;
    }

    async function uploadFirmwareFile(file) {
        if (!file) return;
        const form = new FormData();
        form.append('file', file);
        try {
            const result = await api('/api/accessories/firmware/upload', { method: 'POST', body: form });
            state.selectedBuild = result.build?.filename || state.selectedBuild;
            toast(`${file.name} se subió correctamente.`);
            await loadFirmwareBuilds();
            renderFirmwarePanel();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function flashViaUsbAction(device) {
        if (!state.selectedBuild) return toast('Elige un binario primero.', 'error');
        if (!(await confirmDialog(`¿Flashear "${state.selectedBuild}" por USB en ${device}? La placa se reiniciará.`, 'Flashear firmware'))) return;
        toast('Flasheando por USB, esto puede tardar un minuto…');
        try {
            await api('/api/accessories/firmware/flash-usb', { method: 'POST', body: new URLSearchParams({ device, filename: state.selectedBuild }) });
            toast(`Firmware actualizado en ${device}.`);
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    async function flashViaOtaAction(board) {
        if (!state.selectedBuild) return toast('Elige un binario primero.', 'error');
        if (!(await confirmDialog(`¿Flashear "${state.selectedBuild}" por WiFi en ${board.ip}? La placa se reiniciará.`, 'Flashear firmware'))) return;
        const username = root.querySelector('#aa-firmware-ota-user').value;
        const password = root.querySelector('#aa-firmware-ota-pass').value;
        toast('Enviando firmware por WiFi, esto puede tardar…');
        try {
            await api('/api/accessories/firmware/flash-ota', { method: 'POST', body: new URLSearchParams({ ip: board.ip, filename: state.selectedBuild, username, password }) });
            toast(`Firmware actualizado en ${board.ip}.`);
            await refreshAll();
        } catch (error) { toast(error.message, 'error'); }
    }

    function render() {
        if (!root) return;
        renderHeader();
        renderSummary();
        renderConnection();
        renderDevices();
        renderActivity();
        renderScenes();
        renderDeviceInfo();
    }

    function bindEvents() {
        root.querySelector('#aa-close-btn').addEventListener('click', () => window.switchSection?.('dashboard'));
        root.querySelector('#aa-docs-btn').addEventListener('click', () => { root.querySelector('#aa-docs-panel').hidden = false; });
        root.querySelectorAll('[data-aa-close-docs]').forEach(el => el.addEventListener('click', () => { root.querySelector('#aa-docs-panel').hidden = true; }));
        root.querySelector('#aa-config-btn').addEventListener('click', openAddPanel);
        root.querySelector('#aa-add-btn').addEventListener('click', openAddPanel);
        root.querySelectorAll('[data-aa-close-add]').forEach(el => el.addEventListener('click', closeAddPanel));
        root.querySelector('#aa-test-connection-btn').addEventListener('click', refreshAll);
        root.querySelector('#aa-new-scene-btn').addEventListener('click', openSceneModal);
        root.querySelectorAll('[data-aa-close-scene]').forEach(el => el.addEventListener('click', closeSceneModal));

        root.querySelectorAll('[data-aa-tab]').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.aaTab; renderDevices(); }));

        root.querySelector('#aa-add-device').addEventListener('change', updateAddFormFields);
        root.querySelector('#aa-add-kind').addEventListener('change', updateAddFormFields);
        root.querySelector('#aa-add-form').addEventListener('submit', event => { event.preventDefault(); registerFromForm(event.target); });
        root.querySelector('#aa-scene-form').addEventListener('submit', event => { event.preventDefault(); createSceneFromForm(event.target); });

        root.querySelector('#aa-devices-body').addEventListener('change', event => {
            const toggle = event.target.closest('[data-aa-toggle]');
            if (toggle) { const accessory = state.accessories.find(item => item.id === toggle.dataset.aaToggle); if (accessory) togglePower(accessory); }
            const colorInput = event.target.closest('[data-aa-led]');
            if (colorInput) { const accessory = state.accessories.find(item => item.id === colorInput.dataset.aaLed); if (accessory) applyLedColor(accessory, colorInput.value); }
        });
        root.querySelector('#aa-devices-body').addEventListener('click', event => {
            const renameBtn = event.target.closest('[data-aa-rename]');
            if (renameBtn) { const accessory = state.accessories.find(item => item.id === renameBtn.dataset.aaRename); if (accessory) renameAccessory(accessory); }
            const removeBtn = event.target.closest('[data-aa-remove]');
            if (removeBtn) { const accessory = state.accessories.find(item => item.id === removeBtn.dataset.aaRemove); if (accessory) removeAccessory(accessory); }
        });
        root.querySelector('#aa-scenes-body').addEventListener('click', event => {
            const runBtn = event.target.closest('[data-aa-run-scene]');
            if (runBtn) { const scene = state.scenes.find(item => item.id === runBtn.dataset.aaRunScene); if (scene) runScene(scene); }
            const deleteBtn = event.target.closest('[data-aa-delete-scene]');
            if (deleteBtn) { const scene = state.scenes.find(item => item.id === deleteBtn.dataset.aaDeleteScene); if (scene) deleteScene(scene); }
        });

        root.querySelector('#aa-firmware-btn').addEventListener('click', openFirmwarePanel);
        root.querySelectorAll('[data-aa-close-firmware]').forEach(el => el.addEventListener('click', closeFirmwarePanel));
        root.querySelector('#aa-firmware-file-input').addEventListener('change', event => {
            uploadFirmwareFile(event.target.files[0]);
            event.target.value = '';
        });
        root.querySelector('#aa-firmware-builds-list').addEventListener('change', event => {
            const radio = event.target.closest('input[name="aa-firmware-build"]');
            if (radio) { state.selectedBuild = radio.value; renderFirmwareBoards(); }
        });
        root.querySelector('#aa-firmware-boards-list').addEventListener('click', event => {
            const usbBtn = event.target.closest('[data-aa-flash-usb]');
            if (usbBtn) flashViaUsbAction(usbBtn.dataset.aaFlashUsb);
            const otaBtn = event.target.closest('[data-aa-flash-ota]');
            if (otaBtn) {
                const board = state.boards.find(item => item.device === otaBtn.dataset.aaFlashOta);
                if (board) flashViaOtaAction(board);
            }
        });
    }

    function mount() {
        if (document.getElementById('arduino-accessories-section')) return;
        const pluginsContainer = document.querySelector('.nav-category[data-group="plugins"] .nav-category-items');
        const navButton = document.createElement('button');
        navButton.type = 'button';
        navButton.className = 'nav-item';
        navButton.dataset.section = 'arduino-accessories';
        navButton.dataset.pluginNav = PLUGIN_ID;
        navButton.title = 'Accesorios Arduino/ESP32';
        navButton.innerHTML = `${icon(ICON_CPU, 20)}<span>Arduino/ESP32</span>`;
        navButton.addEventListener('click', () => window.switchSection?.('arduino-accessories'));
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
        document.getElementById('arduino-accessories-section')?.remove();
        root = null;
    }

    window.NopalPluginRegistry = window.NopalPluginRegistry || {};
    window.NopalPluginRegistry[PLUGIN_ID] = { mount, unmount, version: '1.0.0' };
    mount();
})();
