(() => {
    const PLUGIN_ID = 'shape-creator';
    if (window.NopalPluginRegistry?.[PLUGIN_ID]) return;

    const tools = [
        ['select', 'Seleccionar', '<path d="m5 3 14 9-6 2-3 6Z"/>'],
        ['rectangle', 'Rectángulo', '<rect x="4" y="5" width="16" height="14" rx="2"/>'],
        ['square', 'Cuadrado', '<rect x="4" y="4" width="16" height="16" rx="1"/>'],
        ['circle', 'Círculo', '<circle cx="12" cy="12" r="8"/>'],
        ['ellipse', 'Elipse', '<ellipse cx="12" cy="12" rx="9" ry="6"/>'],
        ['line', 'Línea', '<path d="m5 19 14-14"/>'],
        ['polygon', 'Polígono', '<path d="m7 3 10 0 5 9-5 9H7l-5-9Z"/>'],
        ['text', 'Texto', '<path d="M5 4h14M12 4v16M8 20h8"/>'],
        ['duplicate', 'Duplicar', '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'],
        ['align', 'Alinear', '<path d="M4 4v16M8 7h9M8 12h12M8 17h7"/>'],
        ['group', 'Agrupar', '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/><path d="M14 7h3v3M10 17H7v-3"/>'],
        ['ungroup', 'Desagrupar', '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6"/>'],
        ['delete', 'Borrar', '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6"/>']
    ];

    const state = {
        tool: 'select',
        machine: { name: 'NOPAL 600 PRO', host: '', kind: 'laser', width: 600, height: 600, connected: false },
        machines: [],
        zoom: 1,
        viewport: { x: 0, y: 0, width: 600, height: 600 },
        shapes: [],
        selectedId: null,
        selectedIds: [],
        interaction: null,
        generatedGcode: '',
        preview: false,
        layers: [{ id: 1, name: '01', color: '#34f58b', mode: 'cut', output: true }],
        activeLayerId: 1,
        material: 'Madera contrachapada',
        power: 80,
        speed: 1800,
        operation: 'cut',
        airAssist: false,
        scaleLinked: true,
        history: [],
        historyIndex: -1
    };

    let root = null;
    let svg = null;
    let shapesLayer = null;
    let selectionLayer = null;
    let layoutObserver = null;
    let nextShapeId = 1;
    let nextGroupId = 1;

    const icon = (body, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const round = value => Number(Number(value).toFixed(2));
    const esc = value => typeof window.escapeHtml === 'function' ? window.escapeHtml(value) : String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const toast = (message, tone = 'success') => typeof window.showToast === 'function' ? window.showToast(message, tone) : console.log(message);
    const selectedShape = () => state.shapes.find(shape => shape.id === state.selectedId) || null;
    const selectedShapes = () => state.shapes.filter(shape => state.selectedIds.includes(shape.id));
    const activeLayer = () => state.layers.find(layer => layer.id === state.activeLayerId) || state.layers[0];

    function historySnapshot() {
        return JSON.stringify({
            shapes: state.shapes,
            selectedId: state.selectedId,
            selectedIds: state.selectedIds,
            layers: state.layers,
            activeLayerId: state.activeLayerId,
            operation: state.operation,
            material: state.material,
            power: state.power,
            speed: state.speed,
            airAssist: state.airAssist
        });
    }

    function updateHistoryButtons() {
        if (!root) return;
        root.querySelector('#sc-undo-btn').disabled = state.historyIndex <= 0;
        root.querySelector('#sc-redo-btn').disabled = state.historyIndex >= state.history.length - 1;
    }

    function pushHistory(force = false) {
        const snapshot = historySnapshot();
        if (!force && state.history[state.historyIndex] === snapshot) return;
        state.history = state.history.slice(0, state.historyIndex + 1);
        state.history.push(snapshot);
        if (state.history.length > 60) state.history.shift();
        state.historyIndex = state.history.length - 1;
        updateHistoryButtons();
    }

    function restoreHistory(index) {
        if (index < 0 || index >= state.history.length) return;
        const snapshot = JSON.parse(state.history[index]);
        Object.assign(state, snapshot);
        state.historyIndex = index;
        nextShapeId = Math.max(0, ...state.shapes.map(shape => shape.id)) + 1;
        nextGroupId = Math.max(0, ...state.shapes.map(shape => shape.groupId || 0)) + 1;
        const materialSelect = root.querySelector('#sc-material-select');
        if ([...materialSelect.options].some(option => option.value === state.material)) materialSelect.value = state.material;
        root.querySelector('#sc-power-input').value = state.power;
        root.querySelector('#sc-speed-input').value = state.speed;
        root.querySelector('#sc-air-assist-input').checked = state.airAssist;
        root.querySelectorAll('[data-sc-operation]').forEach(button => button.classList.toggle('active', button.dataset.scOperation === state.operation));
        renderLayers(); renderShapes(); updateHistoryButtons();
    }

    function undo() { restoreHistory(state.historyIndex - 1); }
    function redo() { restoreHistory(state.historyIndex + 1); }

    function moduleHtml() {
        return `
            <section id="shape-creator-section" class="view-section sc-section" style="display:none">
                <main class="sc-shell">
                    <aside class="sc-toolbar" aria-label="Herramientas de dibujo">
                        ${tools.map(([id, label, body], index) => `${index === 8 || index === 12 ? '<span class="sc-tool-separator"></span>' : ''}<button type="button" class="sc-tool${id === 'select' ? ' active' : ''}${id === 'delete' ? ' danger' : ''}" data-sc-tool="${id}" title="${label}">${icon(body)}<span>${label}</span></button>`).join('')}
                        <div class="sc-align-menu" id="sc-align-menu" hidden>
                            <strong>Alinear selección</strong>
                            <div>
                                <button type="button" data-sc-align="left" title="Izquierda">${icon('<path d="M4 3v18M8 7h11M8 17h7"/>',17)}</button>
                                <button type="button" data-sc-align="hcenter" title="Centro horizontal">${icon('<path d="M12 3v18M5 7h14M7 17h10"/>',17)}</button>
                                <button type="button" data-sc-align="right" title="Derecha">${icon('<path d="M20 3v18M5 7h11M9 17h7"/>',17)}</button>
                                <button type="button" data-sc-align="top" title="Arriba">${icon('<path d="M3 4h18M7 8v11M17 8v7"/>',17)}</button>
                                <button type="button" data-sc-align="vcenter" title="Centro vertical">${icon('<path d="M3 12h18M7 5v14M17 7v10"/>',17)}</button>
                                <button type="button" data-sc-align="bottom" title="Abajo">${icon('<path d="M3 20h18M7 5v11M17 9v7"/>',17)}</button>
                            </div>
                        </div>
                    </aside>
                    <div class="sc-main-column">
                        <section class="sc-work-card">
                            <header class="sc-work-header">
                                <div>
                                    <div class="sc-title-row">${icon('<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>', 27)}<h1>CREADOR DE FORMAS</h1></div>
                                    <div class="sc-work-label">ÁREA DE TRABAJO <strong id="sc-work-dimensions">600 × 600 mm</strong></div>
                                </div>
                                <div class="sc-document-actions">
                                    <button type="button" id="sc-undo-btn" title="Deshacer" disabled>${icon('<path d="M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6"/>', 18)}</button>
                                    <button type="button" id="sc-redo-btn" title="Rehacer" disabled>${icon('<path d="m15 7 5 5-5 5M19 12h-8a6 6 0 0 0-6 6"/>', 18)}</button>
                                    <button type="button" id="sc-import-btn" title="Importar DXF">${icon('<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>', 18)}<span>Importar DXF</span></button>
                                    <button type="button" class="primary" id="sc-save-btn" title="Guardar en galería">${icon('<path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 21v-8h8v8"/>', 18)}<span>Guardar</span></button>
                                    <input type="file" id="sc-dxf-input" accept=".dxf,application/dxf,text/plain" hidden>
                                </div>
                                <label class="sc-machine-picker">
                                    ${icon('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M16 3v18M8 8h8M8 16h8"/>')}
                                    <span><strong id="sc-machine-name">NOPAL 600 PRO</strong><small id="sc-machine-dimensions">600 × 600 mm</small></span>
                                    <select id="sc-machine-select" aria-label="Seleccionar máquina"></select>
                                    ${icon('<path d="m8 10 4 4 4-4"/>', 17)}
                                </label>
                            </header>
                            <div class="sc-canvas-wrap" id="sc-canvas-wrap">
                                <div class="sc-ruler sc-ruler-horizontal" id="sc-ruler-horizontal"></div>
                                <div class="sc-ruler sc-ruler-vertical" id="sc-ruler-vertical"></div>
                                <div class="sc-ruler-corner">mm</div>
                                <svg id="sc-canvas" viewBox="0 0 600 600" preserveAspectRatio="xMidYMid meet" aria-label="Lienzo de formas">
                                    <defs>
                                        <pattern id="sc-minor-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="rgba(52,245,139,.09)" stroke-width=".45"/></pattern>
                                        <pattern id="sc-major-grid" width="50" height="50" patternUnits="userSpaceOnUse"><rect width="50" height="50" fill="url(#sc-minor-grid)"/><path d="M50 0H0V50" fill="none" stroke="rgba(52,245,139,.22)" stroke-width=".8"/></pattern>
                                    </defs>
                                    <rect class="sc-bed" width="600" height="600" fill="url(#sc-major-grid)"/>
                                    <g id="sc-shapes-layer"></g>
                                    <g id="sc-selection-layer"></g>
                                </svg>
                                <div class="sc-axis"><span class="sc-axis-y">Y</span><i></i><span class="sc-axis-x">X</span></div>
                                <div class="sc-zoom-controls">
                                    <button type="button" data-sc-zoom="out" title="Alejar">${icon('<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4M8 11h6"/>', 18)}</button>
                                    <span id="sc-zoom-label">100%</span>
                                    <button type="button" data-sc-zoom="in" title="Acercar">${icon('<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4M8 11h6M11 8v6"/>', 18)}</button>
                                    <button type="button" data-sc-zoom="fit" title="Ajustar">${icon('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>', 18)}</button>
                                </div>
                                <div class="sc-pointer-readout" id="sc-pointer-readout">X 0.00 · Y 0.00</div>
                            </div>
                        </section>

                        <section class="sc-panels">
                            <article class="sc-panel sc-properties-panel">
                                <div class="sc-panel-title-row"><h2>PROPIEDADES</h2><button type="button" class="sc-scale-link active" id="sc-scale-link" title="Mantener proporción">${icon('<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/>', 16)}<span>Escala ligada</span></button></div>
                                <div class="sc-property-grid">
                                    ${[['x','X (mm)'],['y','Y (mm)'],['width','Ancho (mm)'],['height','Alto (mm)'],['rotation','Rotación (°)'],['lineWidth','Grosor de línea (mm)']].map(([key,label]) => `<label><span>${label}</span><input type="number" step="0.1" data-sc-property="${key}" value="0" ${key === 'lineWidth' ? 'min="0.01"' : ''}></label>`).join('')}
                                </div>
                                <label class="sc-text-property" id="sc-text-property" hidden><span>Contenido del texto</span><input type="text" id="sc-text-input" maxlength="120" placeholder="Escribe el texto..."></label>
                                <button type="button" class="sc-reset-btn" id="sc-reset-properties">${icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>', 15)} Restablecer valores</button>
                            </article>
                            <article class="sc-panel sc-operation-panel">
                                <h2>OPERACIÓN</h2>
                                <div class="sc-operation-list">
                                    <button class="active" data-sc-operation="cut">${icon('<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4"/>')}<span>Corte</span></button>
                                    <button data-sc-operation="engrave">${icon('<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>')}<span>Grabado</span></button>
                                    <button data-sc-operation="dot">${icon('<circle cx="5" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="19" cy="5" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="19" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/><circle cx="19" cy="19" r="1" fill="currentColor"/>')}<span>Punteado</span></button>
                                </div>
                            </article>
                            <article class="sc-panel sc-material-panel">
                                <h2>MATERIAL</h2>
                                <label><select id="sc-material-select"><option>Madera contrachapada</option><option>MDF</option><option>Acrílico</option><option>Cartón</option><option>Aluminio anodizado</option><option>Personalizado</option></select></label>
                                <label><span>Potencia (%)</span><input id="sc-power-input" type="number" min="0" max="100" value="80"></label>
                                <label><span>Velocidad (mm/min)</span><input id="sc-speed-input" type="number" min="1" value="1800"></label>
                                <label class="sc-air-assist"><input id="sc-air-assist-input" type="checkbox"><span>Asistencia de aire</span><small>M8 al iniciar · M9 al terminar</small></label>
                            </article>
                            <article class="sc-panel sc-layers-panel">
                                <h2>CAPAS</h2>
                                <div class="sc-layer-head"><span>#</span><span>Color</span><span>Modo</span><span>Salida</span></div>
                                <div id="sc-layers-list"></div>
                                <div class="sc-layer-actions"><button data-sc-layer-action="add">+ Añadir</button><button data-sc-layer-action="duplicate">${icon(tools[8][2],16)}</button><button class="danger" data-sc-layer-action="delete">${icon(tools[12][2],16)}</button></div>
                            </article>
                            <article class="sc-panel sc-actions-panel">
                                <h2>ACCIONES</h2>
                                <button class="primary" id="sc-generate-btn">${icon('<path d="M4 18c4-7 6 3 10-4s6-3 6-8M4 6v4h4M16 4h4v4"/>')}<span>Generar trayecto</span></button>
                                <button id="sc-preview-btn">${icon('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>')}<span>Vista previa</span></button>
                                <button id="sc-queue-btn">${icon('<path d="m7 4 13 8-13 8Z"/><path d="M3 4v16"/>')}<span>Enviar a cola</span></button>
                            </article>
                        </section>

                        <footer class="sc-statusbar">
                            <div><span>POSICIÓN</span><strong id="sc-status-position">X0.00 Y0.00</strong></div>
                            <div><span>TRAYECTO / PROGRESO</span><strong id="sc-status-path">0 mm / 0%</strong><i><b id="sc-status-progress"></b></i></div>
                            <div><span>TIEMPO ESTIMADO</span><strong id="sc-status-estimated">--:--</strong></div>
                            <div><span>FORMAS</span><strong id="sc-status-shapes">0</strong></div>
                            <div><span>MÁQUINA</span><strong class="sc-machine-status" id="sc-status-machine">● Sin conexión</strong></div>
                        </footer>
                        <div class="sc-save-modal" id="sc-save-modal" hidden>
                            <div class="sc-save-backdrop" data-sc-close-save></div>
                            <form class="sc-save-dialog" id="sc-save-form">
                                <div class="sc-save-dialog-header"><div>${icon('<path d="M5 3h12l2 2v16H5zM8 3v6h8V3"/>')}<span><strong>Guardar en galería</strong><small>El diseño se guardará como SVG editable.</small></span></div><button type="button" data-sc-close-save>×</button></div>
                                <label><span>Nombre del archivo</span><input id="sc-save-name" type="text" maxlength="80" value="diseño-formas" required></label>
                                <label><span>Carpeta</span><select id="sc-save-folder"><option value="">Galería / raíz</option></select></label>
                                <div class="sc-save-dialog-actions"><button type="button" data-sc-close-save>Cancelar</button><button type="submit" class="primary" id="sc-save-confirm">Guardar SVG</button></div>
                            </form>
                        </div>
                    </div>
                </main>
            </section>`;
    }

    function mount() {
        if (document.getElementById('shape-creator-section')) return;
        const pluginsContainer = document.querySelector('.nav-category[data-group="plugins"] .nav-category-items');
        const navButton = document.createElement('button');
        navButton.type = 'button';
        navButton.className = 'nav-item';
        navButton.dataset.section = 'shape-creator';
        navButton.dataset.pluginNav = PLUGIN_ID;
        navButton.title = 'Creador de formas';
        navButton.innerHTML = `${icon('<rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17.5" cy="6.5" r="3.5"/><path d="m4 20 4-7 4 7Z"/><path d="M15 14h6v6h-6z"/>', 20)}<span>Creador de formas</span>`;
        navButton.addEventListener('click', () => window.switchSection?.('shape-creator'));
        pluginsContainer?.appendChild(navButton);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = moduleHtml();
        root = wrapper.firstElementChild;
        const content = document.querySelector('.content');
        content?.insertBefore(root, document.getElementById('gcode-editor-section'));
        svg = root.querySelector('#sc-canvas');
        shapesLayer = root.querySelector('#sc-shapes-layer');
        selectionLayer = root.querySelector('#sc-selection-layer');
        bindEvents();
        renderLayers();
        fitCanvas();
        loadMachines();
        pushHistory(true);
        layoutObserver = new ResizeObserver(() => positionRulers());
        layoutObserver.observe(root.querySelector('#sc-canvas-wrap'));
        requestAnimationFrame(positionRulers);
        window.applySidebarOrder?.();
    }

    function unmount() {
        layoutObserver?.disconnect();
        layoutObserver = null;
        document.querySelector(`[data-plugin-nav="${PLUGIN_ID}"]`)?.remove();
        document.getElementById('shape-creator-section')?.remove();
        root = svg = shapesLayer = selectionLayer = null;
    }

    function pointFromEvent(event) {
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const transformed = point.matrixTransform(svg.getScreenCTM().inverse());
        return { x: clamp(round(transformed.x), 0, state.machine.width), y: clamp(round(transformed.y), 0, state.machine.height) };
    }

    function newShape(type, point) {
        const layer = activeLayer();
        const shape = { id: nextShapeId++, type, x: point.x, y: point.y, width: 0.1, height: 0.1, rotation: 0, lineWidth: 0.1, layerId: layer.id, text: 'Texto' };
        state.shapes.push(shape);
        state.selectedId = shape.id;
        state.selectedIds = [shape.id];
        return shape;
    }

    function shapeMarkup(shape) {
        const layer = state.layers.find(item => item.id === shape.layerId) || state.layers[0];
        const color = layer.color;
        const cx = shape.x + shape.width / 2;
        const cy = shape.y + shape.height / 2;
        const transform = `rotate(${shape.rotation} ${cx} ${cy})`;
        const common = `data-shape-id="${shape.id}" class="sc-shape${state.selectedIds.includes(shape.id) ? ' selected' : ''}" stroke="${color}" stroke-width="${Math.max(shape.lineWidth, .7)}" transform="${transform}"`;
        if (shape.type === 'circle' || shape.type === 'ellipse') return `<ellipse ${common} cx="${cx}" cy="${cy}" rx="${Math.abs(shape.width / 2)}" ry="${Math.abs(shape.height / 2)}"/>`;
        if (shape.type === 'line') return `<line ${common} x1="${shape.x}" y1="${shape.y}" x2="${shape.x + shape.width}" y2="${shape.y + shape.height}"/>`;
        if (shape.type === 'polygon') {
            const points = Array.from({ length: 6 }, (_, index) => { const angle = Math.PI / 3 * index; return `${cx + Math.cos(angle) * shape.width / 2},${cy + Math.sin(angle) * shape.height / 2}`; }).join(' ');
            return `<polygon ${common} points="${points}"/>`;
        }
        if (shape.type === 'text') return `<text ${common} x="${shape.x}" y="${shape.y + Math.max(shape.height, 18)}" font-size="${Math.max(shape.height, 18)}">${esc(shape.text)}</text>`;
        return `<rect ${common} x="${shape.x}" y="${shape.y}" width="${Math.abs(shape.width)}" height="${Math.abs(shape.height)}"/>`;
    }

    function renderShapes() {
        if (!shapesLayer) return;
        shapesLayer.innerHTML = state.shapes.filter(shape => (state.layers.find(layer => layer.id === shape.layerId)?.output ?? true)).map(shapeMarkup).join('');
        renderSelection();
        updatePropertyFields();
        root.querySelector('#sc-status-shapes').textContent = state.shapes.length;
        state.generatedGcode = '';
        root.querySelector('#sc-status-progress').style.width = '0%';
    }

    function renderSelection() {
        const shape = selectedShape();
        if (!shape || !selectionLayer) { if (selectionLayer) selectionLayer.innerHTML = ''; return; }
        const x = Math.min(shape.x, shape.x + shape.width);
        const y = Math.min(shape.y, shape.y + shape.height);
        const width = Math.abs(shape.width);
        const height = Math.abs(shape.height);
        const points = { nw:[x,y], n:[x+width/2,y], ne:[x+width,y], e:[x+width,y+height/2], se:[x+width,y+height], s:[x+width/2,y+height], sw:[x,y+height], w:[x,y+height/2] };
        const secondary = selectedShapes().filter(item => item.id !== shape.id).map(item => `<rect class="sc-selection-box secondary" x="${Math.min(item.x,item.x+item.width)}" y="${Math.min(item.y,item.y+item.height)}" width="${Math.abs(item.width)}" height="${Math.abs(item.height)}"/>`).join('');
        selectionLayer.innerHTML = `${secondary}<rect class="sc-selection-box" x="${x}" y="${y}" width="${width}" height="${height}"/>${Object.entries(points).map(([handle, coords]) => `<rect class="sc-resize-handle" data-sc-handle="${handle}" x="${coords[0]-4}" y="${coords[1]-4}" width="8" height="8"/>`).join('')}<g class="sc-size-label"><rect x="${x + width/2 - 28}" y="${y - 29}" width="56" height="20" rx="8"/><text x="${x + width/2}" y="${y - 15}">${width.toFixed(1)} mm</text></g>`;
    }

    function updatePropertyFields() {
        const shape = selectedShape();
        root?.querySelectorAll('[data-sc-property]').forEach(input => {
            input.disabled = !shape;
            input.value = shape ? round(shape[input.dataset.scProperty]) : '0';
        });
        const position = shape ? `X${shape.x.toFixed(2)} Y${shape.y.toFixed(2)}` : 'X0.00 Y0.00';
        if (root) root.querySelector('#sc-status-position').textContent = position;
        const textProperty = root?.querySelector('#sc-text-property');
        if (textProperty) textProperty.hidden = shape?.type !== 'text';
        const textInput = root?.querySelector('#sc-text-input');
        if (textInput && shape?.type === 'text' && document.activeElement !== textInput) textInput.value = shape.text || '';
    }

    function selectTool(tool) {
        if (['duplicate', 'align', 'group', 'ungroup', 'delete'].includes(tool)) { runToolAction(tool); return; }
        state.tool = tool;
        root.querySelectorAll('[data-sc-tool]').forEach(button => button.classList.toggle('active', button.dataset.scTool === tool));
        root.querySelector('#sc-canvas-wrap').dataset.tool = tool;
    }

    function runToolAction(action) {
        if (action === 'delete') return deleteSelected();
        const selection = selectedShapes();
        if (!selection.length) return toast('Selecciona una forma primero.', 'warning');
        if (action === 'duplicate') {
            const newGroup = selection.length > 1 ? nextGroupId++ : null;
            const copies = selection.map(shape => ({ ...shape, id: nextShapeId++, groupId: newGroup, x: clamp(shape.x + 12, 0, state.machine.width - Math.abs(shape.width)), y: clamp(shape.y + 12, 0, state.machine.height - Math.abs(shape.height)) }));
            state.shapes.push(...copies); state.selectedIds = copies.map(shape => shape.id); state.selectedId = copies.at(-1).id; renderShapes(); pushHistory();
        } else if (action === 'align') {
            const menu = root.querySelector('#sc-align-menu'); menu.hidden = !menu.hidden;
        } else if (action === 'group') {
            if (selection.length < 2) return toast('Selecciona dos o más formas con Mayús.', 'warning');
            const groupId = nextGroupId++; selection.forEach(shape => { shape.groupId = groupId; }); renderShapes(); pushHistory(); toast(`${selection.length} formas agrupadas.`);
        } else if (action === 'ungroup') {
            const groupIds = new Set(selection.map(shape => shape.groupId).filter(Boolean));
            if (!groupIds.size) return toast('La selección no pertenece a un grupo.', 'warning');
            state.shapes.forEach(shape => { if (groupIds.has(shape.groupId)) delete shape.groupId; }); renderShapes(); pushHistory(); toast('Grupo separado.');
        }
    }

    function alignSelection(mode) {
        const selection = selectedShapes();
        if (!selection.length) return;
        const minX = Math.min(...selection.map(shape => Math.min(shape.x, shape.x + shape.width)));
        const maxX = Math.max(...selection.map(shape => Math.max(shape.x, shape.x + shape.width)));
        const minY = Math.min(...selection.map(shape => Math.min(shape.y, shape.y + shape.height)));
        const maxY = Math.max(...selection.map(shape => Math.max(shape.y, shape.y + shape.height)));
        selection.forEach(shape => {
            const width = Math.abs(shape.width), height = Math.abs(shape.height);
            if (mode === 'left') shape.x = selection.length === 1 ? 0 : minX;
            if (mode === 'hcenter') shape.x = (selection.length === 1 ? state.machine.width/2 : (minX+maxX)/2) - width/2;
            if (mode === 'right') shape.x = (selection.length === 1 ? state.machine.width : maxX) - width;
            if (mode === 'top') shape.y = selection.length === 1 ? 0 : minY;
            if (mode === 'vcenter') shape.y = (selection.length === 1 ? state.machine.height/2 : (minY+maxY)/2) - height/2;
            if (mode === 'bottom') shape.y = (selection.length === 1 ? state.machine.height : maxY) - height;
            shape.x = round(shape.x); shape.y = round(shape.y);
        });
        root.querySelector('#sc-align-menu').hidden = true;
        renderShapes(); pushHistory();
    }

    function deleteSelected() {
        if (!state.selectedIds.length) return;
        state.shapes = state.shapes.filter(shape => !state.selectedIds.includes(shape.id));
        state.selectedId = null;
        state.selectedIds = [];
        renderShapes(); pushHistory();
    }

    function onPointerDown(event) {
        if (event.button !== 0) return;
        const point = pointFromEvent(event);
        const handle = event.target.closest?.('[data-sc-handle]')?.dataset.scHandle;
        const targetId = Number(event.target.closest?.('[data-shape-id]')?.dataset.shapeId || 0);
        if (handle && selectedShape()) {
            state.interaction = { mode: 'resize', handle, start: point, snapshot: { ...selectedShape() } };
        } else if (state.tool === 'select') {
            if (targetId) {
                const target = state.shapes.find(shape => shape.id === targetId);
                const targetIds = target?.groupId ? state.shapes.filter(shape => shape.groupId === target.groupId).map(shape => shape.id) : [targetId];
                if (event.shiftKey) {
                    const allSelected = targetIds.every(id => state.selectedIds.includes(id));
                    state.selectedIds = allSelected ? state.selectedIds.filter(id => !targetIds.includes(id)) : [...new Set([...state.selectedIds, ...targetIds])];
                } else if (!state.selectedIds.includes(targetId)) {
                    state.selectedIds = targetIds;
                }
                state.selectedId = state.selectedIds.includes(targetId) ? targetId : (state.selectedIds.at(-1) || null);
                state.interaction = state.selectedId ? { mode: 'move', start: point, snapshots: selectedShapes().map(shape => ({ ...shape })) } : null;
            } else { state.selectedId = null; state.selectedIds = []; state.interaction = null; }
            renderShapes();
        } else {
            const shape = newShape(state.tool, point);
            if (state.tool === 'text') { shape.width = 70; shape.height = 22; renderShapes(); pushHistory(); selectTool('select'); return; }
            state.interaction = { mode: 'draw', start: point, shapeId: shape.id };
            renderShapes();
        }
        svg.setPointerCapture?.(event.pointerId);
    }

    function onPointerMove(event) {
        const point = pointFromEvent(event);
        root.querySelector('#sc-pointer-readout').textContent = `X ${point.x.toFixed(2)} · Y ${point.y.toFixed(2)}`;
        if (!state.interaction) return;
        const interaction = state.interaction;
        const shape = interaction.mode === 'draw' ? state.shapes.find(item => item.id === interaction.shapeId) : selectedShape();
        if (!shape) return;
        if (interaction.mode === 'move') {
            const dx = point.x - interaction.start.x;
            const dy = point.y - interaction.start.y;
            interaction.snapshots.forEach(snapshot => {
                const current = state.shapes.find(item => item.id === snapshot.id);
                if (!current) return;
                current.x = round(clamp(snapshot.x + dx, 0, state.machine.width - Math.abs(current.width)));
                current.y = round(clamp(snapshot.y + dy, 0, state.machine.height - Math.abs(current.height)));
            });
        } else if (interaction.mode === 'draw') {
            const dx = point.x - interaction.start.x;
            const dy = point.y - interaction.start.y;
            if (shape.type === 'line') { shape.width = round(dx); shape.height = round(dy); }
            else {
                const constrained = shape.type === 'square' || shape.type === 'circle';
                const width = constrained ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx);
                const height = constrained ? width : Math.abs(dy);
                shape.x = round(dx < 0 ? interaction.start.x - width : interaction.start.x);
                shape.y = round(dy < 0 ? interaction.start.y - height : interaction.start.y);
                shape.width = round(width); shape.height = round(height);
            }
        } else if (interaction.mode === 'resize') {
            resizeShape(shape, interaction.snapshot, interaction.handle, point);
        }
        renderShapes();
    }

    function resizeShape(shape, snapshot, handle, point) {
        const left = snapshot.x, top = snapshot.y, right = snapshot.x + snapshot.width, bottom = snapshot.y + snapshot.height;
        let nextLeft = left, nextTop = top, nextRight = right, nextBottom = bottom;
        if (handle.includes('w')) nextLeft = point.x;
        if (handle.includes('e')) nextRight = point.x;
        if (handle.includes('n')) nextTop = point.y;
        if (handle.includes('s')) nextBottom = point.y;
        if (handle === 'n' || handle === 's') { nextLeft = left; nextRight = right; }
        if (handle === 'e' || handle === 'w') { nextTop = top; nextBottom = bottom; }
        shape.x = round(Math.min(nextLeft, nextRight)); shape.y = round(Math.min(nextTop, nextBottom));
        shape.width = round(Math.max(1, Math.abs(nextRight - nextLeft))); shape.height = round(Math.max(1, Math.abs(nextBottom - nextTop)));
        if (shape.type === 'square' || shape.type === 'circle') shape.height = shape.width = Math.max(shape.width, shape.height);
    }

    function onPointerUp() {
        if (state.interaction?.mode === 'draw') selectTool('select');
        if (state.interaction) pushHistory();
        state.interaction = null;
    }

    function setZoom(nextZoom) {
        state.zoom = clamp(nextZoom, .35, 5);
        const width = state.machine.width / state.zoom;
        const height = state.machine.height / state.zoom;
        state.viewport.x = clamp((state.machine.width - width) / 2, 0, Math.max(0, state.machine.width - width));
        state.viewport.y = clamp((state.machine.height - height) / 2, 0, Math.max(0, state.machine.height - height));
        state.viewport.width = width; state.viewport.height = height;
        svg.setAttribute('viewBox', `${state.viewport.x} ${state.viewport.y} ${width} ${height}`);
        root.querySelector('#sc-zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;
        renderRulers();
    }

    function renderRulers() {
        if (!root) return;
        const horizontal = root.querySelector('#sc-ruler-horizontal');
        const vertical = root.querySelector('#sc-ruler-vertical');
        const marks = Array.from({ length: 11 }, (_, index) => index);
        horizontal.innerHTML = marks.map(index => { const value = state.viewport.x + state.viewport.width * index / 10; return `<span style="left:${index*10}%"><i></i><b>${Math.round(value)}</b></span>`; }).join('');
        vertical.innerHTML = marks.map(index => { const canvasY = state.viewport.y + state.viewport.height * index / 10; const value = state.machine.height - canvasY; return `<span style="top:${index*10}%"><i></i><b>${Math.round(value)}</b></span>`; }).join('');
        requestAnimationFrame(positionRulers);
    }

    function positionRulers() {
        if (!root || !svg) return;
        const wrap = root.querySelector('#sc-canvas-wrap');
        const availableWidth = svg.clientWidth, availableHeight = svg.clientHeight;
        if (!availableWidth || !availableHeight) return;
        const scale = Math.min(availableWidth / state.viewport.width, availableHeight / state.viewport.height);
        const contentWidth = state.viewport.width * scale, contentHeight = state.viewport.height * scale;
        const contentLeft = 46 + (availableWidth - contentWidth) / 2;
        const contentTop = 30 + (availableHeight - contentHeight) / 2;
        const horizontal = root.querySelector('#sc-ruler-horizontal');
        const vertical = root.querySelector('#sc-ruler-vertical');
        const corner = root.querySelector('.sc-ruler-corner');
        Object.assign(horizontal.style, { left: `${contentLeft}px`, top: `${contentTop - 30}px`, width: `${contentWidth}px`, right: 'auto' });
        Object.assign(vertical.style, { left: `${contentLeft - 46}px`, top: `${contentTop}px`, height: `${contentHeight}px`, bottom: 'auto' });
        Object.assign(corner.style, { left: `${contentLeft - 46}px`, top: `${contentTop - 30}px` });
        const rightGap = Math.max(0, wrap.clientWidth - contentLeft - contentWidth);
        const bottomGap = Math.max(0, wrap.clientHeight - contentTop - contentHeight);
        Object.assign(root.querySelector('.sc-axis').style, { left: `${contentLeft + 12}px`, bottom: `${bottomGap + 12}px` });
        Object.assign(root.querySelector('.sc-zoom-controls').style, { right: `${rightGap + 14}px`, bottom: `${bottomGap + 14}px` });
        Object.assign(root.querySelector('#sc-pointer-readout').style, { left: `${contentLeft + 8}px`, top: `${contentTop + 8}px` });
    }

    function fitCanvas() { state.zoom = 1; state.viewport = { x: 0, y: 0, width: state.machine.width, height: state.machine.height }; if (svg) { svg.setAttribute('viewBox', `0 0 ${state.machine.width} ${state.machine.height}`); root.querySelector('#sc-zoom-label').textContent = '100%'; renderRulers(); } }

    async function loadMachines() {
        const select = root.querySelector('#sc-machine-select');
        try {
            const response = await fetch('/api/laser/registry');
            const data = await response.json();
            state.machines = (data.lasers || []).map(item => ({ name: item.name || item.host, host: item.host, kind: item.kind || 'laser', width: Number(item.work_area?.width) || 600, height: Number(item.work_area?.height) || 600 }));
        } catch (error) { console.error(error); }
        if (!state.machines.length) state.machines = [state.machine];
        select.innerHTML = state.machines.map((machine, index) => `<option value="${index}">${esc(machine.name)}</option>`).join('');
        await selectMachine(0);
    }

    async function selectMachine(index) {
        state.machine = { ...state.machines[index], connected: false };
        root.querySelector('#sc-machine-name').textContent = state.machine.name;
        root.querySelector('#sc-machine-dimensions').textContent = `${state.machine.width} × ${state.machine.height} mm`;
        root.querySelector('#sc-work-dimensions').textContent = `${state.machine.width} × ${state.machine.height} mm`;
        const bed = root.querySelector('.sc-bed'); bed.setAttribute('width', state.machine.width); bed.setAttribute('height', state.machine.height);
        fitCanvas(); renderShapes();
        if (!state.machine.host) return updateMachineStatus(false);
        try {
            const response = await fetch(`/api/laser/status?host=${encodeURIComponent(state.machine.host)}`);
            const status = await response.json(); updateMachineStatus(!!status.connected);
        } catch (_) { updateMachineStatus(false); }
    }

    function updateMachineStatus(connected) {
        state.machine.connected = connected;
        const element = root.querySelector('#sc-status-machine');
        element.textContent = connected ? '● Conectada' : '● Sin conexión';
        element.classList.toggle('connected', connected);
    }

    function renderLayers() {
        const list = root.querySelector('#sc-layers-list');
        list.innerHTML = state.layers.map(layer => `<button type="button" class="sc-layer-row${layer.id === state.activeLayerId ? ' active' : ''}" data-sc-layer-id="${layer.id}"><span>${esc(layer.name)}</span><input type="color" value="${layer.color}" data-sc-layer-color="${layer.id}" title="Color"><span>${layer.mode === 'cut' ? 'Corte' : layer.mode === 'engrave' ? 'Grabado' : 'Punteado'}</span><input type="checkbox" ${layer.output ? 'checked' : ''} data-sc-layer-output="${layer.id}" aria-label="Salida"></button>`).join('');
    }

    function setOperation(mode, record = true) {
        state.operation = mode; activeLayer().mode = mode;
        root.querySelectorAll('[data-sc-operation]').forEach(button => button.classList.toggle('active', button.dataset.scOperation === mode));
        renderLayers(); renderShapes();
        if (record) pushHistory();
    }

    function shapePathLength(shape) {
        if (shape.type === 'circle') return Math.PI * Math.abs(shape.width);
        if (shape.type === 'ellipse') { const a = Math.abs(shape.width/2), b = Math.abs(shape.height/2); return Math.PI * (3*(a+b)-Math.sqrt((3*a+b)*(a+3*b))); }
        if (shape.type === 'line') return Math.hypot(shape.width, shape.height);
        if (shape.type === 'polygon') return 3 * Math.abs(shape.width);
        return 2 * (Math.abs(shape.width) + Math.abs(shape.height));
    }

    function pointsForShape(shape) {
        let points;
        if (shape.type === 'line') points = [[shape.x, shape.y], [shape.x + shape.width, shape.y + shape.height]];
        if (shape.type === 'circle' || shape.type === 'ellipse' || shape.type === 'polygon') {
            const segments = shape.type === 'polygon' ? 6 : 36, cx = shape.x + shape.width/2, cy = shape.y + shape.height/2;
            points = Array.from({length: segments + 1}, (_, index) => { const angle = Math.PI * 2 * index / segments; return [cx + Math.cos(angle)*shape.width/2, cy + Math.sin(angle)*shape.height/2]; });
        }
        if (!points) points = [[shape.x,shape.y],[shape.x+shape.width,shape.y],[shape.x+shape.width,shape.y+shape.height],[shape.x,shape.y+shape.height],[shape.x,shape.y]];
        if (!shape.rotation) return points;
        const centerX = shape.x + shape.width / 2, centerY = shape.y + shape.height / 2;
        const radians = shape.rotation * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
        return points.map(([x, y]) => [centerX + (x-centerX)*cosine - (y-centerY)*sine, centerY + (x-centerX)*sine + (y-centerY)*cosine]);
    }

    function generateToolpath() {
        const outputShapes = state.shapes.filter(shape => state.layers.find(layer => layer.id === shape.layerId)?.output && shape.type !== 'text');
        if (!outputShapes.length) { toast('Agrega al menos una forma vectorial.', 'warning'); return ''; }
        const lines = ['; NOPAL Shape Creator', `; Machine: ${state.machine.name}`, 'G21', 'G90', 'M4'];
        if (state.airAssist) lines.push('M8 ; Air assist on');
        outputShapes.forEach(shape => {
            const layer = state.layers.find(item => item.id === shape.layerId) || state.layers[0];
            const power = layer.mode === 'engrave' ? Math.round(state.power * 8) : Math.round(state.power * 10);
            const points = pointsForShape(shape);
            lines.push(`; Shape ${shape.id} ${shape.type} / ${layer.mode}`, `G0 X${points[0][0].toFixed(3)} Y${points[0][1].toFixed(3)}`);
            points.slice(1).forEach(point => lines.push(`G1 X${point[0].toFixed(3)} Y${point[1].toFixed(3)} F${state.speed} S${power}`));
        });
        if (state.airAssist) lines.push('M9 ; Air assist off');
        lines.push('M5', 'G0 X0 Y0');
        state.generatedGcode = lines.join('\n');
        const distance = outputShapes.reduce((sum, shape) => sum + shapePathLength(shape), 0);
        const seconds = Math.max(1, Math.round(distance / state.speed * 60));
        root.querySelector('#sc-status-path').textContent = `${distance.toFixed(1)} mm / 100%`;
        root.querySelector('#sc-status-progress').style.width = '100%';
        root.querySelector('#sc-status-estimated').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
        toast('Trayecto generado correctamente.');
        return state.generatedGcode;
    }

    async function sendToQueue() {
        const gcode = state.generatedGcode || generateToolpath();
        if (!gcode) return;
        const filename = `formas-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.gcode`;
        try {
            const upload = new FormData();
            upload.append('file', new File([gcode], filename, { type: 'text/plain' }));
            upload.append('type', 'gcode'); upload.append('path', 'Creador de Formas');
            const uploadResponse = await fetch('/api/upload', { method: 'POST', body: upload });
            if (!uploadResponse.ok) throw new Error('No se pudo guardar el G-Code.');
            const queue = new FormData(); queue.append('path', `Creador de Formas/${filename}`); queue.append('kind', state.machine.kind === 'cnc' ? 'cnc' : 'laser');
            const queueResponse = await fetch('/api/laser/queue/add', { method: 'POST', body: queue });
            if (!queueResponse.ok) throw new Error('No se pudo agregar el trabajo a la cola.');
            toast('Trabajo enviado a la cola.');
        } catch (error) { toast(error.message, 'error'); }
    }

    function designToSvg() {
        const body = state.shapes.map(shape => {
            const layer = state.layers.find(item => item.id === shape.layerId) || state.layers[0];
            const style = `fill="none" stroke="${layer.color}" stroke-width="${shape.lineWidth}"`;
            const cx = shape.x + shape.width / 2, cy = shape.y + shape.height / 2;
            const transform = `transform="rotate(${shape.rotation} ${cx} ${cy})"`;
            if (shape.type === 'circle' || shape.type === 'ellipse') return `<ellipse ${style} ${transform} cx="${cx}" cy="${cy}" rx="${Math.abs(shape.width/2)}" ry="${Math.abs(shape.height/2)}"/>`;
            if (shape.type === 'line') return `<line ${style} ${transform} x1="${shape.x}" y1="${shape.y}" x2="${shape.x+shape.width}" y2="${shape.y+shape.height}"/>`;
            if (shape.type === 'polygon') { const points = pointsForShape({...shape, rotation: 0}).slice(0, -1).map(point => point.join(',')).join(' '); return `<polygon ${style} ${transform} points="${points}"/>`; }
            if (shape.type === 'text') return `<text ${style} ${transform} x="${shape.x}" y="${shape.y + shape.height}" font-size="${shape.height}">${esc(shape.text)}</text>`;
            return `<rect ${style} ${transform} x="${shape.x}" y="${shape.y}" width="${Math.abs(shape.width)}" height="${Math.abs(shape.height)}"/>`;
        }).join('\n  ');
        const metadata = esc(JSON.stringify({ generator: 'NOPAL Shape Creator', version: 1, machine: state.machine.name, layers: state.layers }));
        return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${state.machine.width}mm" height="${state.machine.height}mm" viewBox="0 0 ${state.machine.width} ${state.machine.height}">\n  <metadata>${metadata}</metadata>\n  ${body}\n</svg>`;
    }

    async function loadGalleryFolders() {
        const select = root.querySelector('#sc-save-folder');
        select.innerHTML = '<option value="">Galería / raíz</option>';
        const queue = [{ path: '', depth: 0 }];
        const folders = [];
        while (queue.length && folders.length < 100) {
            const current = queue.shift();
            try {
                const response = await fetch(`/api/browse?type=model&path=${encodeURIComponent(current.path)}`);
                if (!response.ok) continue;
                const data = await response.json();
                (data.folders || []).forEach(folder => {
                    folders.push({ path: folder.path, depth: current.depth });
                    if (current.depth < 3) queue.push({ path: folder.path, depth: current.depth + 1 });
                });
            } catch (error) { console.error(error); }
        }
        select.insertAdjacentHTML('beforeend', folders.map(folder => `<option value="${esc(folder.path)}">${'— '.repeat(folder.depth + 1)}${esc(folder.path)}</option>`).join(''));
    }

    async function openSaveDialog() {
        if (!state.shapes.length) return toast('Agrega al menos una forma antes de guardar.', 'warning');
        const modal = root.querySelector('#sc-save-modal');
        modal.hidden = false;
        root.querySelector('#sc-save-name').focus();
        await loadGalleryFolders();
    }

    function closeSaveDialog() { root.querySelector('#sc-save-modal').hidden = true; }

    async function saveDesign(event) {
        event.preventDefault();
        const rawName = root.querySelector('#sc-save-name').value.trim();
        const filename = `${rawName.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g, '').trim() || 'diseño-formas'}.svg`;
        const folder = root.querySelector('#sc-save-folder').value;
        const button = root.querySelector('#sc-save-confirm');
        button.disabled = true; button.textContent = 'Guardando...';
        try {
            const form = new FormData();
            form.append('file', new File([designToSvg()], filename, { type: 'image/svg+xml' }));
            form.append('type', 'model'); form.append('path', folder);
            const response = await fetch('/api/upload', { method: 'POST', body: form });
            if (!response.ok) throw new Error('No se pudo guardar el diseño.');
            closeSaveDialog();
            toast(`${filename} se guardó en la galería.`);
            if (typeof window.loadModelsFolder === 'function') window.loadModelsFolder('');
        } catch (error) { toast(error.message, 'error'); }
        finally { button.disabled = false; button.textContent = 'Guardar SVG'; }
    }

    function valuesFromDxf(tokens, code) { return tokens.filter(pair => pair.code === code).map(pair => Number(pair.value)).filter(Number.isFinite); }

    function parseDxf(text) {
        const lines = text.replace(/\r/g, '').split('\n');
        const pairs = [];
        for (let index = 0; index + 1 < lines.length; index += 2) pairs.push({ code: Number(lines[index].trim()), value: lines[index + 1].trim() });
        const imported = [];
        for (let index = 0; index < pairs.length && imported.length < 1000; index++) {
            if (pairs[index].code !== 0) continue;
            const type = pairs[index].value.toUpperCase();
            let end = index + 1;
            while (end < pairs.length && pairs[end].code !== 0) end++;
            const tokens = pairs.slice(index + 1, end);
            if (type === 'LINE') {
                const x1 = valuesFromDxf(tokens, 10)[0], y1 = valuesFromDxf(tokens, 20)[0], x2 = valuesFromDxf(tokens, 11)[0], y2 = valuesFromDxf(tokens, 21)[0];
                if ([x1,y1,x2,y2].every(Number.isFinite)) imported.push({ type: 'line', x: x1, y: y1, width: x2-x1, height: y2-y1 });
            } else if (type === 'CIRCLE') {
                const x = valuesFromDxf(tokens, 10)[0], y = valuesFromDxf(tokens, 20)[0], radius = valuesFromDxf(tokens, 40)[0];
                if ([x,y,radius].every(Number.isFinite) && radius > 0) imported.push({ type: 'circle', x: x-radius, y: y-radius, width: radius*2, height: radius*2 });
            } else if (type === 'LWPOLYLINE') {
                const xs = valuesFromDxf(tokens, 10), ys = valuesFromDxf(tokens, 20), closed = (valuesFromDxf(tokens, 70)[0] || 0) & 1;
                const count = Math.min(xs.length, ys.length);
                for (let point = 0; point < count - 1; point++) imported.push({ type: 'line', x: xs[point], y: ys[point], width: xs[point+1]-xs[point], height: ys[point+1]-ys[point] });
                if (closed && count > 2) imported.push({ type: 'line', x: xs[count-1], y: ys[count-1], width: xs[0]-xs[count-1], height: ys[0]-ys[count-1] });
            }
            index = end - 1;
        }
        return imported;
    }

    async function importDxfFile(file) {
        const MAX_DXF_BYTES = 2 * 1024 * 1024;
        if (!file) return;
        if (!/\.dxf$/i.test(file.name)) return toast('Selecciona un archivo DXF.', 'warning');
        if (file.size > MAX_DXF_BYTES) return toast('El DXF supera el límite de 2 MB.', 'error');
        try {
            const imported = parseDxf(await file.text());
            if (!imported.length) throw new Error('No se encontraron líneas, círculos o polilíneas compatibles.');
            const minX = Math.min(...imported.map(shape => Math.min(shape.x, shape.x + shape.width)));
            const minY = Math.min(...imported.map(shape => Math.min(shape.y, shape.y + shape.height)));
            const maxX = Math.max(...imported.map(shape => Math.max(shape.x, shape.x + shape.width)));
            const maxY = Math.max(...imported.map(shape => Math.max(shape.y, shape.y + shape.height)));
            const sourceWidth = maxX-minX, sourceHeight = maxY-minY;
            if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth > 100000 || sourceHeight > 100000) throw new Error('Las dimensiones del DXF no son válidas.');
            const scale = Math.min(1, state.machine.width*.9/Math.max(sourceWidth,1), state.machine.height*.9/Math.max(sourceHeight,1));
            const offsetX = (state.machine.width-sourceWidth*scale)/2, offsetY = (state.machine.height-sourceHeight*scale)/2;
            const importedIds = [];
            imported.forEach(item => { const shape = { ...item, id: nextShapeId++, x: round((item.x-minX)*scale+offsetX), y: round((item.y-minY)*scale+offsetY), width: round(item.width*scale), height: round(item.height*scale), rotation: 0, lineWidth: .1, layerId: state.activeLayerId, text: '' }; state.shapes.push(shape); importedIds.push(shape.id); });
            state.selectedId = importedIds.at(-1) || null;
            state.selectedIds = importedIds.length <= 50 ? importedIds : [state.selectedId];
            renderShapes(); pushHistory();
            toast(`${imported.length} entidades DXF importadas.`);
        } catch (error) { toast(error.message, 'error'); }
    }

    function bindEvents() {
        root.addEventListener('click', event => {
            const toolButton = event.target.closest('[data-sc-tool]'); if (toolButton) selectTool(toolButton.dataset.scTool);
            const operation = event.target.closest('[data-sc-operation]'); if (operation) setOperation(operation.dataset.scOperation);
            const zoom = event.target.closest('[data-sc-zoom]')?.dataset.scZoom; if (zoom) zoom === 'fit' ? fitCanvas() : setZoom(state.zoom * (zoom === 'in' ? 1.2 : .8));
            const layerRow = event.target.closest('[data-sc-layer-id]'); if (layerRow && !event.target.matches('input')) { state.activeLayerId = Number(layerRow.dataset.scLayerId); setOperation(activeLayer().mode, false); renderLayers(); }
            const layerAction = event.target.closest('[data-sc-layer-action]')?.dataset.scLayerAction; if (layerAction) handleLayerAction(layerAction);
            const alignMode = event.target.closest('[data-sc-align]')?.dataset.scAlign; if (alignMode) alignSelection(alignMode);
            if (event.target.closest('[data-sc-close-save]')) closeSaveDialog();
        });
        svg.addEventListener('pointerdown', onPointerDown); svg.addEventListener('pointermove', onPointerMove); svg.addEventListener('pointerup', onPointerUp); svg.addEventListener('pointercancel', onPointerUp);
        root.querySelectorAll('[data-sc-property]').forEach(input => {
            input.addEventListener('input', () => {
                const selection = selectedShapes(); if (!selection.length) return;
                const key = input.dataset.scProperty, value = Number(input.value); if (!Number.isFinite(value)) return;
                selection.forEach(shape => {
                    const oldWidth = Math.max(Math.abs(shape.width), .001), oldHeight = Math.max(Math.abs(shape.height), .001);
                    shape[key] = ['width','height','lineWidth'].includes(key) ? Math.max(key === 'lineWidth' ? .01 : 1, value) : value;
                    if (state.scaleLinked && key === 'width') shape.height = round(shape.width * oldHeight / oldWidth);
                    if (state.scaleLinked && key === 'height') shape.width = round(shape.height * oldWidth / oldHeight);
                });
                renderShapes();
            });
            input.addEventListener('change', () => pushHistory());
        });
        root.querySelector('#sc-machine-select').addEventListener('change', event => selectMachine(Number(event.target.value)));
        root.querySelector('#sc-material-select').addEventListener('change', event => { state.material = event.target.value; pushHistory(); });
        root.querySelector('#sc-power-input').addEventListener('input', event => { state.power = clamp(Number(event.target.value) || 0, 0, 100); state.generatedGcode = ''; });
        root.querySelector('#sc-power-input').addEventListener('change', pushHistory);
        root.querySelector('#sc-speed-input').addEventListener('input', event => { state.speed = Math.max(1, Number(event.target.value) || 1); state.generatedGcode = ''; });
        root.querySelector('#sc-speed-input').addEventListener('change', pushHistory);
        root.querySelector('#sc-air-assist-input').addEventListener('change', event => { state.airAssist = event.target.checked; state.generatedGcode = ''; pushHistory(); });
        root.querySelector('#sc-scale-link').addEventListener('click', event => { state.scaleLinked = !state.scaleLinked; const button = event.currentTarget; button.classList.toggle('active', state.scaleLinked); button.querySelector('span').textContent = state.scaleLinked ? 'Escala ligada' : 'Escala libre'; });
        root.querySelector('#sc-text-input').addEventListener('input', event => { const texts = selectedShapes().filter(shape => shape.type === 'text'); if (texts.length) { texts.forEach(shape => { shape.text = event.target.value; }); renderShapes(); } });
        root.querySelector('#sc-text-input').addEventListener('change', pushHistory);
        root.querySelector('#sc-reset-properties').addEventListener('click', () => { const selection = selectedShapes(); if (!selection.length) return; selection.forEach(shape => { shape.rotation = 0; shape.lineWidth = .1; }); renderShapes(); pushHistory(); });
        root.querySelector('#sc-undo-btn').addEventListener('click', undo);
        root.querySelector('#sc-redo-btn').addEventListener('click', redo);
        root.querySelector('#sc-import-btn').addEventListener('click', () => root.querySelector('#sc-dxf-input').click());
        root.querySelector('#sc-dxf-input').addEventListener('change', async event => { await importDxfFile(event.target.files?.[0]); event.target.value = ''; });
        root.querySelector('#sc-save-btn').addEventListener('click', openSaveDialog);
        root.querySelector('#sc-save-form').addEventListener('submit', saveDesign);
        root.querySelector('#sc-generate-btn').addEventListener('click', generateToolpath);
        root.querySelector('#sc-preview-btn').addEventListener('click', () => { state.preview = !state.preview; root.classList.toggle('is-preview', state.preview); toast(state.preview ? 'Vista previa activada.' : 'Vista previa desactivada.'); });
        root.querySelector('#sc-queue-btn').addEventListener('click', sendToQueue);
        root.querySelector('#sc-layers-list').addEventListener('change', event => {
            const colorId = Number(event.target.dataset.scLayerColor || 0), outputId = Number(event.target.dataset.scLayerOutput || 0);
            if (colorId) state.layers.find(layer => layer.id === colorId).color = event.target.value;
            if (outputId) state.layers.find(layer => layer.id === outputId).output = event.target.checked;
            renderShapes(); pushHistory();
        });
        document.addEventListener('keydown', onKeyDown);
    }

    function onKeyDown(event) {
        if (!root?.classList.contains('active') || ['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); runToolAction('duplicate'); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); state.selectedIds = state.shapes.map(shape => shape.id); state.selectedId = state.selectedIds.at(-1) || null; renderShapes(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
        if (event.key === 'Escape') selectTool('select');
    }

    function handleLayerAction(action) {
        if (action === 'add') {
            const id = Math.max(...state.layers.map(layer => layer.id)) + 1;
            const colors = ['#38bdf8','#f472b6','#f59e0b','#a78bfa'];
            state.layers.push({ id, name: String(id).padStart(2,'0'), color: colors[(id-2)%colors.length], mode: state.operation, output: true }); state.activeLayerId = id;
        } else if (action === 'duplicate') {
            const source = activeLayer(), id = Math.max(...state.layers.map(layer => layer.id)) + 1;
            state.layers.push({ ...source, id, name: String(id).padStart(2,'0') }); state.activeLayerId = id;
        } else if (action === 'delete') {
            if (state.layers.length === 1) return toast('Debe existir al menos una capa.', 'warning');
            const removed = state.activeLayerId; state.layers = state.layers.filter(layer => layer.id !== removed); state.shapes = state.shapes.filter(shape => shape.layerId !== removed); state.activeLayerId = state.layers[0].id; state.selectedId = null; state.selectedIds = [];
        }
        renderLayers(); renderShapes(); pushHistory();
    }

    window.NopalPluginRegistry = window.NopalPluginRegistry || {};
    window.NopalPluginRegistry[PLUGIN_ID] = { mount, unmount, version: '1.1.1' };
    mount();
})();
