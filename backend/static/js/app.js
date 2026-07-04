const modelsGrid = document.getElementById('models');
const printersGrid = document.getElementById('printers-grid');
const printQueue = document.getElementById('print-queue');
const totalModelsEl = document.getElementById('total-models');
const gcodeReadyEl = document.getElementById('gcode-ready');
const storageUsedEl = document.getElementById('storage-used');
const activePrintersEl = document.getElementById('active-printers');
const searchRecentInput = document.getElementById('search-recent');
const searchGcodeInput = document.getElementById('search-gcode');
const searchModelsInput = document.getElementById('search-models');
const uploadInput = document.getElementById('upload-input');
const uploadBtn = document.getElementById('upload-btn');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const themeLabel = document.getElementById('theme-label');
const gcodeFilesList = document.getElementById('gcode-files-list');
const gcodeFileCount = document.getElementById('gcode-file-count');
const gcodeSelectedCount = document.getElementById('gcode-selected-count');
const gcodePreviewTitle = document.getElementById('gcode-preview-title');
const gcodePreviewDescription = document.getElementById('gcode-preview-description');
const gcodePreviewLines = document.getElementById('gcode-preview-lines');
const gcodePreviewSize = document.getElementById('gcode-preview-size');
const gcodePreviewDate = document.getElementById('gcode-preview-date');
const gcodePreviewScene = document.getElementById('gcode-preview');
const modelModal = document.getElementById('model-modal');
const modalClose = document.getElementById('modal-close');
const modalBackdrop = document.querySelector('.modal-backdrop');
let allModels = [];
let allPrinters = [];
let recentPrinterFiles = [];
let selectedGcodeId = null;
let currentScene = null;
let currentRenderer = null;
let currentMesh = null;
let currentAnimationFrame = null;
let selectedModelId = null;
let currentViewMode = localStorage.getItem('viewMode') || 'grid';
const gcodePreviewCache = new Map();

const PALETTE = ['#A3D9B6', '#6EC4A0', '#FFD4B8', '#FF8A4D', '#B8D4BE', '#C4E0C8'];

const DEMO_QUEUE = [
    { id: 456, name: 'bracket_v1', progress: 72, time: '7hr', status: 'green' },
    { id: 457, name: 'gear_v2', progress: 45, time: '6hr', status: 'green' },
    { id: 458, name: 'mount_plate', progress: 91, time: '0m', status: 'green' },
    { id: 459, name: 'fan_duct', progress: 28, time: '4hr', status: 'orange' },
];

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)} GB`;
}

function hashColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
}

function formatDate(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp * 1000);
    const locale = currentLanguage === 'es' ? 'es-ES' : 'en-US';
    return date.toLocaleString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatEstimatedTime(minutes) {
    if (!minutes || Number.isNaN(minutes)) return '—';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function parseGcodePath(content, maxSegments = 2500) {
    const lines = content.split(/\r?\n/);
    let x = 0, y = 0, z = 0, e = 0;
    let absolute = true;
    let lastPoint = new THREE.Vector3(0, 0, 0);
    let hasLastPoint = false;
    const points = [];
    let segments = 0;

    const parseValue = token => {
        return parseFloat(token.slice(1));
    };

    for (const raw of lines) {
        const line = raw.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        const code = parts[0].toUpperCase();
        if (code === 'G90') {
            absolute = true;
            continue;
        }
        if (code === 'G91') {
            absolute = false;
            continue;
        }
        if (code === 'G92') {
            for (let i = 1; i < parts.length; i++) {
                const token = parts[i].toUpperCase();
                if (token.startsWith('X')) x = parseValue(token);
                if (token.startsWith('Y')) y = parseValue(token);
                if (token.startsWith('Z')) z = parseValue(token);
                if (token.startsWith('E')) e = parseValue(token);
            }
            continue;
        }
        if (code !== 'G0' && code !== 'G1') continue;

        let nx = x;
        let ny = y;
        let nz = z;
        let ne = e;

        for (let i = 1; i < parts.length; i++) {
            const token = parts[i].toUpperCase();
            if (token.length < 2) continue;
            const letter = token[0];
            const value = parseValue(token);
            if (Number.isNaN(value)) continue;
            if (letter === 'X') nx = absolute ? value : x + value;
            if (letter === 'Y') ny = absolute ? value : y + value;
            if (letter === 'Z') nz = absolute ? value : z + value;
            if (letter === 'E') ne = absolute ? value : e + value;
        }

        const moved = nx !== x || ny !== y || nz !== z;
        if (moved) {
            const currentPoint = new THREE.Vector3(nx, ny, nz);
            if (!hasLastPoint) {
                lastPoint = currentPoint.clone();
                hasLastPoint = true;
            }
            if (segments < maxSegments) {
                points.push(lastPoint.clone(), currentPoint.clone());
                segments += 1;
            }
            lastPoint.copy(currentPoint);
            x = nx;
            y = ny;
            z = nz;
        }
        e = ne;

        if (segments >= maxSegments) break;
    }

    return points;
}

function createGcodeLine(fileUrl, points) {
    const geometry = new THREE.BufferGeometry();
    const flattened = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
        flattened[index * 3] = point.x;
        flattened[index * 3 + 1] = point.y;
        flattened[index * 3 + 2] = point.z;
    });
    geometry.setAttribute('position', new THREE.BufferAttribute(flattened, 3));
    const material = new THREE.LineBasicMaterial({ color: 0xa855f7, linewidth: 2 });
    const line = new THREE.LineSegments(geometry, material);
    return line;
}

async function getGcodePreviewScene(fileUrl, maxSegments = 2500) {
    if (gcodePreviewCache.has(fileUrl)) {
        return gcodePreviewCache.get(fileUrl).clone();
    }
    try {
        const response = await fetch(fileUrl);
        const text = await response.text();
        const points = parseGcodePath(text, maxSegments);
        if (points.length === 0) return null;
        const line = createGcodeLine(fileUrl, points);
        gcodePreviewCache.set(fileUrl, line);
        return line.clone();
    } catch (error) {
        console.error('G-code preview load error:', error);
        return null;
    }
}

function setupPreviewControls(renderer, camera, scene, mesh) {
    let isDragging = false;
    const pointer = new THREE.Vector2();
    const rotation = { x: 0, y: 0 };
    const onPointerDown = event => {
        isDragging = true;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = event => {
        if (!isDragging) return;
        const deltaX = event.clientX - pointer.x;
        const deltaY = event.clientY - pointer.y;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        rotation.y += deltaX * 0.005;
        rotation.x += deltaY * 0.005;
        if (mesh) {
            mesh.rotation.y = rotation.y;
            mesh.rotation.x = rotation.x;
        }
    };
    const onPointerUp = event => {
        isDragging = false;
        renderer.domElement.releasePointerCapture(event.pointerId);
    };
    const onWheel = event => {
        event.preventDefault();
        const delta = Math.sign(event.deltaY) * 0.12;
        camera.position.z += delta;
        camera.position.z = Math.max(2, Math.min(60, camera.position.z));
        camera.updateProjectionMatrix();
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
}

async function renderGcodeThumbnail(thumb, fileUrl) {
    if (!thumb || !window.THREE || typeof window.THREE.Scene !== 'function') return;
    thumb.innerHTML = '';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    thumb.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x888888, 1));

    const line = await getGcodePreviewScene(fileUrl, 1500);
    if (!line) {
        thumb.innerHTML = `<div class="thumb-placeholder">G-code</div>`;
        return;
    }

    scene.add(line);
    const box = new THREE.Box3().setFromObject(line);
    const center = new THREE.Vector3();
    box.getCenter(center);
    line.position.sub(center);

    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    camera.position.set(maxDim * 1.2, maxDim * 0.8, maxDim * 1.6);
    camera.lookAt(0, 0, 0);

    const resize = () => {
        const width = thumb.clientWidth || 120;
        const height = thumb.clientHeight || 120;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    };
    const animate = () => {
        requestAnimationFrame(animate);
        line.rotation.y += 0.004;
        renderer.render(scene, camera);
    };
    resize();
    animate();
}

async function renderGcodePreview(container, fileUrl) {
    if (!container || !window.THREE || typeof window.THREE.Scene !== 'function') return;
    container.innerHTML = '';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    container.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x999999, 1.2));

    const line = await getGcodePreviewScene(fileUrl, 5000);
    if (!line) {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;padding:1rem;text-align:center;">No se pudo generar la vista previa 3D.</div>';
        return;
    }

    scene.add(line);
    const box = new THREE.Box3().setFromObject(line);
    const center = new THREE.Vector3();
    box.getCenter(center);
    line.position.sub(center);

    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    camera.position.set(maxDim * 1.7, maxDim * 1.1, maxDim * 1.5);
    camera.lookAt(0, 0, 0);

    const resize = () => {
        const width = container.clientWidth || 320;
        const height = container.clientHeight || 320;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    };

    setupPreviewControls(renderer, camera, scene, line);

    const animate = () => {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    };
    resize();
    animate();
}

async function renderStandardModelPreview(container, fileUrl) {
    if (!container || !window.THREE || typeof window.THREE.Scene !== 'function') return;
    container.innerHTML = '';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    container.appendChild(renderer.domElement);

    const directional = new THREE.DirectionalLight(0xffffff, 0.9);
    directional.position.set(5, 5, 5);
    scene.add(directional);
    scene.add(new THREE.AmbientLight(0x888888, 1.1));

    const extension = (fileUrl || '').toLowerCase();
    const isStl = extension.endsWith('.stl');
    const isThreeMf = extension.endsWith('.3mf');
    const isObj = extension.endsWith('.obj');

    const onError = () => {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;padding:1rem;text-align:center;">Vista previa no disponible</div>';
    };

    const onLoad = (object) => {
        const material = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.4, roughness: 0.35 });
        object.traverse((child) => {
            if (child.isMesh) {
                child.material = material;
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        const box = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        box.getCenter(center);
        object.position.sub(center);

        scene.add(object);

        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        camera.position.set(maxDim * 1.8, maxDim * 1.2, maxDim * 1.4);
        camera.lookAt(0, 0, 0);

        setupPreviewControls(renderer, camera, scene, object);

        const animate = () => {
            requestAnimationFrame(animate);
            renderer.render(scene, camera);
        };
        animate();
    };

    if (isStl) {
        const loader = new THREE.STLLoader();
        loader.load(fileUrl, (geometry) => {
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.4, roughness: 0.35 }));
            onLoad(mesh);
        }, undefined, onError);
    } else if (isThreeMf) {
        const loader = new THREE.ThreeMFLoader();
        loader.load(fileUrl, onLoad, undefined, onError);
    } else {
        onError();
    }
}

function renderSelectedPreview(model) {
    const previewImage = document.getElementById('preview-image');
    if (!previewImage) return;
    previewImage.innerHTML = '';
    previewImage.style.backgroundImage = 'linear-gradient(180deg, rgba(15,23,42,1) 0%, rgba(31,41,55,1) 100%)';

    const fileUrl = model.file_url;
    const extension = (fileUrl || '').toLowerCase();
    if (extension.endsWith('.gcode')) {
        renderGcodePreview(previewImage, fileUrl);
        return;
    }

    if (extension.endsWith('.stl') || extension.endsWith('.3mf') || extension.endsWith('.obj')) {
        renderStandardModelPreview(previewImage, fileUrl);
        return;
    }

    previewImage.innerHTML = '<div class="preview-image-placeholder">No preview</div>';
}

function getPrinterDisplayName(printer) {
    return printer?.name || printer?.printer_info?.hostname || 'Impresora';
}

function getPrinterWebUrl(printer) {
    const port = printer?.port || printer?.printer_info?.port;
    if (port) {
        return `http://127.0.0.1:${port}`;
    }
    return 'http://127.0.0.1:7125';
}

function getThemeColors(theme) {
    const defaults = THEME_PALETTES[theme] || THEME_PALETTES.light;
    return {
        accent: localStorage.getItem('themeColorAccent') || defaults.accent,
        surface: localStorage.getItem('themeColorSurface') || defaults.surface,
        bg: defaults.bg || defaults.surface,
        sidebar: defaults.sidebar || defaults.surface,
        text: localStorage.getItem('themeColorText') || defaults.text,
        muted: localStorage.getItem('themeColorMuted') || defaults.muted,
    };
}

function syncThemePaletteInputs(theme) {
    const defaults = THEME_PALETTES[theme] || THEME_PALETTES.light;
    if (settingsColorAccent && !localStorage.getItem('themeColorAccent')) settingsColorAccent.value = defaults.accent;
    if (settingsColorSurface && !localStorage.getItem('themeColorSurface')) settingsColorSurface.value = defaults.surface;
    if (settingsColorText && !localStorage.getItem('themeColorText')) settingsColorText.value = defaults.text;
    if (settingsColorMuted && !localStorage.getItem('themeColorMuted')) settingsColorMuted.value = defaults.muted;
}

function updateFavicon(url) {
    if (!url) return;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = url;
}

function applyTheme(theme) {
    const resolvedTheme = ['dark', 'green'].includes(theme) ? theme : 'light';
    document.body.classList.remove('dark', 'green');
    document.body.classList.add(resolvedTheme);
    document.body.setAttribute('data-theme', resolvedTheme);

    const colors = getThemeColors(resolvedTheme);
    document.documentElement.style.setProperty('--accent', colors.accent);
    document.documentElement.style.setProperty('--surface', colors.surface);
    document.documentElement.style.setProperty('--text', colors.text);
    document.documentElement.style.setProperty('--text-muted', colors.muted);
    document.documentElement.style.setProperty('--black', colors.text);
    document.documentElement.style.setProperty('--card-bg', colors.surface);
    document.documentElement.style.setProperty('--bg', colors.bg);
    document.documentElement.style.setProperty('--sidebar-bg', colors.sidebar);

    if (themeToggle) {
        themeToggle.setAttribute('aria-pressed', String(resolvedTheme === 'dark'));
    }
    if (themeIcon) {
        const icons = {
            light: '☀️',
            dark: '🌙',
            green: '🌿',
        };
        themeIcon.textContent = icons[resolvedTheme] || '☀️';
    }
    if (themeLabel) {
        const labelKeys = {
            light: 'lightMode',
            dark: 'darkMode',
            green: 'greenMode',
        };
        themeLabel.textContent = t(labelKeys[resolvedTheme] || 'lightMode');
    }
}

function initializeTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const themeValue = savedTheme || (prefersDark ? 'dark' : 'light');
    applyTheme(themeValue);
    const savedFavicon = localStorage.getItem('themeFaviconUrl');
    if (savedFavicon) updateFavicon(savedFavicon);
}

function filterModels(query) {
    if (!query) return allModels;
    return allModels.filter(model => model.name.toLowerCase().includes(query.toLowerCase()));
}

function updateStats(models) {
    const total = models.length;
    const usedBytes = models.reduce((sum, model) => sum + model.size, 0);
    const gcodeReady = models.filter(m => m.name.toLowerCase().endsWith('.stl')).length;

    if (totalModelsEl) totalModelsEl.textContent = total.toLocaleString();
    if (gcodeReadyEl) gcodeReadyEl.textContent = gcodeReady.toLocaleString();
    if (activePrintersEl) activePrintersEl.textContent = DEMO_QUEUE.length.toLocaleString();
    
    // Fetch storage information
    fetch('/api/storage')
        .then(res => res.json())
        .then(data => {
            const used = formatSize(data.used);
            const available = formatSize(data.free);
            if (storageUsedEl) {
                storageUsedEl.textContent = `${used} / ${available}`;
            }
        })
        .catch(err => {
            console.error('Error fetching storage info:', err);
            if (storageUsedEl) storageUsedEl.textContent = formatSize(usedBytes);
        });
}

function getJobVisualState(status) {
    if (status === 'completed') return 'printing';
    if (status === 'cancelled') return 'paused';
    if (status === 'error' || status === 'klippy_shutdown') return 'error';
    return 'idle';
}

function getJobStatusLabel(status) {
    const labels = {
        completed: t('completed'),
        cancelled: t('cancelled'),
        error: t('errorLoading'),
        klippy_shutdown: t('errorLoading'),
    };
    return labels[status] || status;
}

function filterRecentPrinterFiles(query) {
    if (!query) return recentPrinterFiles;
    const needle = query.toLowerCase();
    return recentPrinterFiles
        .map(group => ({
            ...group,
            jobs: group.jobs.filter(job => job.filename.toLowerCase().includes(needle)),
        }))
        .filter(group => group.jobs.length > 0);
}

function renderRecentPrinterFiles(groups) {
    if (!modelsGrid) return;

    if (!groups || groups.length === 0) {
        modelsGrid.innerHTML = `<div class="empty-state">${t('noPrintersFound')}</div>`;
        return;
    }

    modelsGrid.innerHTML = `
        <div class="recent-printer-groups">
            ${groups.map(group => `
                <div class="recent-printer-group">
                    <h3 class="recent-printer-group-title">${group.printer}</h3>
                    <div class="recent-printer-jobs">
                        ${group.jobs.length === 0
                            ? `<div class="empty-state-small">${t('noFilesFound')}</div>`
                            : group.jobs.map(job => {
                                const visualState = getJobVisualState(job.status);
                                const durationMinutes = job.print_duration ? Math.round(job.print_duration / 60) : 0;
                                return `
                                    <div class="recent-job-card" data-file-url="${job.file_url || ''}" title="${job.file_url ? t('open') : ''}">
                                        <div class="recent-job-thumb">
                                            ${job.thumbnail_url
                                                ? `<img src="${job.thumbnail_url}" alt="${job.filename}" loading="lazy" onerror="this.closest('.recent-job-thumb').classList.add('no-thumb')">`
                                                : ''}
                                            <svg class="recent-job-thumb-fallback" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                        </div>
                                        <div class="recent-job-info">
                                            <div class="printer-status-line ${visualState}">
                                                <span class="printer-status-dot ${visualState}"></span>${getJobStatusLabel(job.status)}
                                            </div>
                                            <h4 class="recent-job-name" title="${job.filename}">${job.filename}</h4>
                                            <div class="recent-job-meta">
                                                <span>${formatDate(job.end_time)}</span>
                                                <span>${formatEstimatedTime(durationMinutes)}</span>
                                            </div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    modelsGrid.querySelectorAll('.recent-job-card').forEach(card => {
        const fileUrl = card.dataset.fileUrl;
        if (!fileUrl) return;
        card.addEventListener('click', () => window.open(fileUrl, '_blank'));
    });
}

async function loadRecentPrinterFiles() {
    try {
        const response = await fetch('/api/printers/recent-files');
        if (!response.ok) throw new Error('No se pudo cargar el historial de impresoras');
        const data = await response.json();
        recentPrinterFiles = data.printers || [];
        renderRecentPrinterFiles(recentPrinterFiles);
    } catch (error) {
        console.error(error);
        if (modelsGrid) modelsGrid.innerHTML = `<div class="empty-state">${t('errorLoadingModels')}</div>`;
    }
}

function renderGcodeFileList(models) {
    if (!gcodeFilesList) return;

    const gcodeModels = models.filter(model => model.extension === '.gcode');
    gcodeFileCount.textContent = gcodeModels.length.toLocaleString();
    gcodeSelectedCount.textContent = selectedGcodeId ? '1' : '0';

    if (gcodeModels.length === 0) {
        gcodeFilesList.innerHTML = `<div class="empty-state">No hay archivos G-code disponibles.</div>`;
        return;
    }

    gcodeFilesList.innerHTML = gcodeModels.map(model => {
        const size = formatSize(model.size);
        const date = formatDate(model.modified);
        const isActive = selectedGcodeId === model.id;
        return `
            <div class="gcode-file-item ${isActive ? 'active' : ''}" data-model-id="${model.id}">
                <div class="file-info">
                    <strong>${model.name}</strong>
                    <span>${size} · ${date}</span>
                </div>
                <div class="file-actions">
                    <button type="button" class="file-action" data-action="preview" title="Preview">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    gcodeFilesList.querySelectorAll('.gcode-file-item').forEach(item => {
        item.addEventListener('click', () => {
            const modelId = Number(item.dataset.modelId);
            const model = allModels.find(entry => entry.id === modelId);
            if (model) {
                selectGcodePreview(model);
            }
        });
    });
}

function getGcodeLineCount(fileUrl) {
    return fetch(fileUrl)
        .then(response => response.text())
        .then(text => text.split(/\r?\n/).filter(Boolean).length)
        .catch(() => 0);
}

async function selectGcodePreview(model) {
    if (!model) return;
    selectedGcodeId = model.id;
    const fileUrl = model.file_url;
    if (gcodePreviewTitle) gcodePreviewTitle.textContent = model.name;
    if (gcodePreviewDescription) gcodePreviewDescription.textContent = model.description || 'Vista previa en tiempo real para G-code.';
    if (gcodePreviewSize) gcodePreviewSize.textContent = formatSize(model.size);
    if (gcodePreviewDate) gcodePreviewDate.textContent = formatDate(model.modified);
    if (gcodeSelectedCount) gcodeSelectedCount.textContent = '1';

    if (gcodePreviewLines) {
        const lineCount = await getGcodeLineCount(fileUrl);
        gcodePreviewLines.textContent = lineCount.toLocaleString();
    }

    if (gcodePreviewScene) {
        renderGcodePreview(gcodePreviewScene, fileUrl);
    }
    renderGcodeFileList(allModels);
}

function updateGcodeSearch(query) {
    const filtered = filterModels(query).filter(model => model.extension === '.gcode');
    if (!gcodeFilesList) return;
    if (filtered.length === 0) {
        gcodeFilesList.innerHTML = `<div class="empty-state">No se encontraron archivos G-code.</div>`;
        gcodeFileCount.textContent = '0';
        return;
    }
    gcodeFilesList.innerHTML = filtered.map(model => {
        const size = formatSize(model.size);
        const date = formatDate(model.modified);
        const isActive = selectedGcodeId === model.id;
        return `
            <div class="gcode-file-item ${isActive ? 'active' : ''}" data-model-id="${model.id}">
                <div class="file-info">
                    <strong>${model.name}</strong>
                    <span>${size} · ${date}</span>
                </div>
                <div class="file-actions">
                    <button type="button" class="file-action" data-action="preview" title="Preview">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
    gcodeFileCount.textContent = filtered.length.toLocaleString();
    gcodeFilesList.querySelectorAll('.gcode-file-item').forEach(item => {
        item.addEventListener('click', () => {
            const modelId = Number(item.dataset.modelId);
            const model = allModels.find(entry => entry.id === modelId);
            if (model) {
                selectGcodePreview(model);
            }
        });
    });
}

function renderThumbPreview(thumb, fileUrl = '', isGcode = false) {
    if (!thumb || !window.THREE || typeof window.THREE.Scene !== 'function') return;

    const placeholder = thumb.querySelector('.thumb-placeholder');
    if (placeholder) placeholder.remove();
    thumb.innerHTML = '';

    const previewFileUrl = fileUrl || thumb.dataset.fileUrl || '';
    if (isGcode && previewFileUrl) {
        renderGcodeThumbnail(thumb, previewFileUrl);
        return;
    }

    const THREE = window.THREE;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    thumb.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(1, 1, 1);
    scene.add(light);

    const ambient = new THREE.AmbientLight(0x404040, 1.3);
    scene.add(ambient);

    const geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const material = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.35, roughness: 0.35 });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    camera.position.set(1.6, 1.2, 2.2);
    camera.lookAt(0, 0, 0);

    const resize = () => {
        const width = thumb.clientWidth || 140;
        const height = thumb.clientHeight || 140;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    };

    const animate = () => {
        requestAnimationFrame(animate);
        mesh.rotation.y += 0.015;
        mesh.rotation.x += 0.008;
        renderer.render(scene, camera);
    };

    resize();
    animate();
    window.addEventListener('resize', resize);
}

function openModelModal(fileUrl, filename, model = {}) {
    if (!modelModal) return;
    
    modelModal.classList.add('active');
    document.getElementById('modal-filename').textContent = filename;
    document.getElementById('modal-tags').textContent = (model.tags || ['#modelo3D', '#impresion3D']).join(' ');
    document.getElementById('modal-material').textContent = model.material || 'PLA';
    document.getElementById('modal-time').textContent = model.estimated_time || formatEstimatedTime(model.estimated_time_minutes);
    
    const downloadBtn = document.getElementById('modal-download');
    downloadBtn.onclick = () => {
        const link = document.createElement('a');
        link.href = fileUrl;
        link.download = filename;
        link.click();
    };

    const modalViewer = document.getElementById('modal-viewer');
    modalViewer.innerHTML = '';

    const sendBtn = document.getElementById('modal-send-printer');
    if (sendBtn) {
        sendBtn.onclick = () => {
            const preferredPrinter = allPrinters.find(printer => printer.status === 'online') || allPrinters[0] || null;
            const url = getPrinterWebUrl(preferredPrinter);
            window.open(url, '_blank', 'noopener,noreferrer');
        };
    }

    // Wait for the modal to render before initializing Three.js
    setTimeout(() => {
        initializeThreeViewer(modalViewer, fileUrl);
    }, 100);
}

function initializeThreeViewer(modalViewer, fileUrl) {
    const extension = (fileUrl || '').toLowerCase();
    const isGcode = extension.endsWith('.gcode');
    const isStl = extension.endsWith('.stl');
    const isThreeMf = extension.endsWith('.3mf');

    if (!fileUrl) {
        modalViewer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #888; text-align: center; padding: 1rem;">Vista previa 3D no disponible para este archivo</div>';
        return;
    }

    if (isGcode) {
        renderGcodePreview(modalViewer, fileUrl);
        return;
    }

    const width = modalViewer.clientWidth || 400;
    const height = modalViewer.clientHeight || 400;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0xf0f0f0);
    modalViewer.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(1, 1, 1);
    scene.add(light);

    const ambient = new THREE.AmbientLight(0x404040, 1.4);
    scene.add(ambient);

    const onLoad = (object) => {
        const material = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.4, roughness: 0.4 });
        object.traverse((child) => {
            if (child.isMesh) {
                child.material = material;
            }
        });

        const box = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        box.getCenter(center);
        object.position.sub(center);

        scene.add(object);

        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        camera.position.set(maxDim * 1.8, maxDim * 1.2, maxDim * 1.4);
        camera.lookAt(0, 0, 0);

        currentScene = scene;
        currentRenderer = renderer;
        currentMesh = object;

        const animate = () => {
            currentAnimationFrame = requestAnimationFrame(animate);
            if (currentMesh) {
                currentMesh.rotation.y += 0.005;
            }
            renderer.render(scene, camera);
        };
        animate();
    };

    const onError = (error) => {
        console.error('Error loading model:', error);
        modalViewer.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #888;">Error al cargar el modelo</div>';
    };

    if (isGcode) {
        renderGcodePreview(modalViewer, fileUrl);
        return;
    }

    if (isStl) {
        const loader = new THREE.STLLoader();
        loader.load(fileUrl, (geometry) => {
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.4, roughness: 0.4 }));
            onLoad(mesh);
        }, undefined, onError);
    } else if (isThreeMf) {
        const loader = new THREE.ThreeMFLoader();
        loader.load(fileUrl, onLoad, undefined, onError);
    }

    const handleResize = () => {
        const newWidth = modalViewer.clientWidth || 400;
        const newHeight = modalViewer.clientHeight || 400;
        renderer.setSize(newWidth, newHeight);
        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
    };

    window.addEventListener('resize', handleResize);
}

function closeModelModal() {
    if (!modelModal) return;
    modelModal.classList.remove('active');

    const modalViewer = document.getElementById('modal-viewer');
    if (currentAnimationFrame) {
        cancelAnimationFrame(currentAnimationFrame);
    }
    if (currentRenderer) {
        currentRenderer.dispose();
        modalViewer.innerHTML = '';
    }
    currentScene = null;
    currentRenderer = null;
    currentMesh = null;
    currentAnimationFrame = null;
}

function renderPrintQueue() {
    if (!printQueue) return;

    printQueue.innerHTML = DEMO_QUEUE.map(job => `
        <div class="queue-item">
            <div class="queue-header">
                <span class="queue-name">Print #${job.id} — ${job.name}</span>
                <span class="queue-time">${job.time}</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill ${job.status}" style="width: ${job.progress}%"></div>
            </div>
        </div>
    `).join('');
}

async function loadModels() {
    try {
        const response = await fetch('/api/models');
        if (!response.ok) throw new Error('No se pudo cargar la biblioteca');
        allModels = await response.json();
        updateStats(allModels);
        renderGcodeFileList(allModels);
        if (document.getElementById('models-section')?.classList.contains('active')) {
            renderModelsFullPage(allModels);
        }
    } catch (error) {
        console.error(error);
        const modelsFullGrid = document.getElementById('models-full');
        if (modelsFullGrid) modelsFullGrid.innerHTML = `<div class="empty-state">${t('errorLoadingModels')}</div>`;
    }
}

function updateViewMode(mode) {
    currentViewMode = mode;
    localStorage.setItem('viewMode', mode);
    
    if (modelsGrid) {
        if (mode === 'list') {
            modelsGrid.classList.add('list-view');
        } else {
            modelsGrid.classList.remove('list-view');
        }
    }
    
    // Update button states
    const gridBtn = document.getElementById('view-grid');
    const listBtn = document.getElementById('view-list');
    if (gridBtn) {
        gridBtn.classList.toggle('btn-view-toggle-active', mode === 'grid');
    }
    if (listBtn) {
        listBtn.classList.toggle('btn-view-toggle-active', mode === 'list');
    }
    
    renderRecentPrinterFiles(recentPrinterFiles);
}

async function loadPrinters() {
    try {
        const response = await fetch('/api/printers/status');
        if (!response.ok) throw new Error('No se pudo cargar el estado de impresoras');
        const data = await response.json();
        allPrinters = data.printers || [];
        renderPrinters(allPrinters);
        updateActivePrintersCount();
    } catch (error) {
        console.error(error);
        if (printersGrid) {
            printersGrid.innerHTML = `<div class="empty-state">${t('errorLoadingModels')}</div>`;
        }
    }
}

const PRINTER_CONE_COLORS = {
    printing: '#22C55E',
    paused: '#F59E0B',
    error: '#F97316',
    idle: '#64748B',
};

function getPrinterVisualState(stateValue, isOnline) {
    if (stateValue === 'printing') return 'printing';
    if (stateValue === 'paused') return 'paused';
    if (!isOnline || ['error', 'shutdown', 'disconnected'].includes(stateValue)) return 'error';
    return 'idle';
}

function printerIllustrationSvg(visualState) {
    const cone = PRINTER_CONE_COLORS[visualState];
    return `
        <svg width="120" height="100" viewBox="0 0 120 100" fill="none">
            <rect x="14" y="10" width="92" height="62" rx="4" stroke="#475569" stroke-width="3"/>
            <line x1="14" y1="28" x2="106" y2="28" stroke="#475569" stroke-width="3"/>
            <rect x="52" y="23" width="16" height="10" rx="2" fill="#1e293b" stroke="#64748b" stroke-width="2"/>
            <path d="M58 33 L62 33 L60 39 Z" fill="#64748b"/>
            <path d="M60 39 L71 66 L49 66 Z" fill="${cone}"/>
            <rect x="28" y="66" width="64" height="6" rx="2" fill="#1e293b" stroke="#475569" stroke-width="2"/>
            <rect x="18" y="74" width="84" height="16" rx="4" fill="#1e293b" stroke="#334155" stroke-width="2"/>
            <circle cx="28" cy="82" r="2" fill="#22c55e"/>
        </svg>
    `;
}

function printerBadgesHtml(visualState) {
    if (visualState === 'paused') {
        return `
            <div class="printer-badge printer-badge-paused" title="${t('paused')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>
            </div>
        `;
    }

    if (visualState === 'error') {
        return `
            <div class="printer-badge printer-badge-error" title="${t('errorLoading')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor"/><rect x="11" y="6" width="2" height="7" rx="1" fill="#1e293b"/><circle cx="12" cy="16" r="1.2" fill="#1e293b"/></svg>
            </div>
            <div class="printer-badge printer-badge-warning" title="${t('errorLoading')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3 L22 20 H2 Z" fill="currentColor"/><rect x="11" y="10" width="2" height="5" rx="1" fill="#1e293b"/><circle cx="12" cy="17" r="1.1" fill="#1e293b"/></svg>
            </div>
        `;
    }

    return '';
}

function renderPrinters(printers) {
    if (!printersGrid) return;

    if (!printers || printers.length === 0) {
        printersGrid.innerHTML = `<div class="empty-state">${t('noPrintersFound')}</div>`;
        return;
    }

    printersGrid.innerHTML = printers.map(printer => {
        const stateValue = (printer.state || printer.printer_info?.state || '').toString().toLowerCase();
        const normalizedStatus = printer.status === 'online' || ['ready', 'printing', 'paused', 'busy', 'standby'].includes(stateValue) ? 'online' : 'offline';
        const isOnline = normalizedStatus === 'online';
        const statusText = isOnline ? t('online') : t('offline');
        const stateKey = stateValue === 'ready' ? 'idle' : stateValue;
        const stateDisplay = t(stateKey) !== stateKey ? t(stateKey) : (stateValue || t('idle'));
        const visualState = getPrinterVisualState(stateValue, isOnline);

        const data = printer.data || printer.status?.status || {};
        let bedTemp = '--';
        let extruderTemp = '--';

        if (data.heater_bed && typeof data.heater_bed.temperature === 'number') {
            bedTemp = Math.round(data.heater_bed.temperature * 10) / 10;
        }
        if (data.extruder && typeof data.extruder.temperature === 'number') {
            extruderTemp = Math.round(data.extruder.temperature * 10) / 10;
        }

        const BED_MAX_TEMP = 110;
        const EXTRUDER_MAX_TEMP = 260;
        const bedPercent = typeof bedTemp === 'number' ? Math.min(100, Math.round((bedTemp / BED_MAX_TEMP) * 100)) : 0;
        const extruderPercent = typeof extruderTemp === 'number' ? Math.min(100, Math.round((extruderTemp / EXTRUDER_MAX_TEMP) * 100)) : 0;

        const printerName = printer.name || printer.printer_info?.name || printer.printer_info?.hostname || `Printer ${printer.port || ''}`;
        const overallPercent = Math.round((bedPercent + extruderPercent) / 2);

        return `
            <div class="printer-card ${normalizedStatus}">
                <div class="printer-card-top">
                    <h3 class="printer-name">${printerName}</h3>
                    <div class="printer-status-icon ${normalizedStatus}" title="${statusText}">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-dasharray="2 4"/>
                            <circle cx="12" cy="4" r="2" fill="currentColor"/>
                        </svg>
                    </div>
                </div>

                <div class="printer-status-line ${visualState}">
                    <span class="printer-status-dot ${visualState}"></span>${stateDisplay}
                </div>

                <div class="printer-illustration printer-illustration-${visualState}">
                    ${printerIllustrationSvg(visualState)}
                    ${printerBadgesHtml(visualState)}
                </div>

                <div class="printer-temps">
                    <div class="temp-item">
                        <div class="temp-label">${t('bedTemp')}</div>
                        <div class="temp-value">${bedTemp}<span class="temp-unit">°C</span></div>
                    </div>
                    <div class="temp-item">
                        <div class="temp-label">${t('extruderTemp')}</div>
                        <div class="temp-value">${extruderTemp}<span class="temp-unit">°C</span></div>
                    </div>
                </div>

                <div class="printer-progress">
                    <div class="printer-progress-labels">
                        <span>${bedPercent}%</span>
                        <span>${extruderPercent}%</span>
                    </div>
                    <div class="temp-progress"><div class="temp-progress-fill" style="width: ${overallPercent}%"></div></div>
                </div>
            </div>
        `;
    }).join('');
}

function updateActivePrintersCount() {
    if (activePrintersEl) {
        const onlineCount = allPrinters.filter(printer => {
            const stateValue = (printer.state || printer.printer_info?.state || '').toString().toLowerCase();
            return printer.status === 'online' || ['ready', 'printing', 'paused', 'busy', 'standby'].includes(stateValue);
        }).length;
        activePrintersEl.textContent = onlineCount.toLocaleString();
    }
}

// Modal event listeners
if (modalClose) {
    modalClose.addEventListener('click', closeModelModal);
}

if (modalBackdrop) {
    modalBackdrop.addEventListener('click', closeModelModal);
}

if (searchRecentInput) {
    searchRecentInput.addEventListener('input', event => {
        renderRecentPrinterFiles(filterRecentPrinterFiles(event.target.value));
    });
}

if (searchGcodeInput) {
    searchGcodeInput.addEventListener('input', event => {
        updateGcodeSearch(event.target.value);
    });
}

if (searchModelsInput) {
    searchModelsInput.addEventListener('input', event => {
        renderModelsFullPage(filterModels(event.target.value));
    });
}

if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => uploadInput.click());

    uploadInput.addEventListener('change', async event => {
        const file = event.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error('Error al subir el archivo.');
            await response.json();
            uploadInput.value = '';
            loadModels();
        } catch (error) {
            console.error(error);
            alert('No se pudo subir el archivo.');
        }
    });
}

// ── Navigation ──
function switchSection(sectionName) {
    // Hide all sections
    const sections = document.querySelectorAll('.view-section');
    sections.forEach(section => {
        section.style.display = 'none';
        section.classList.remove('active');
    });

    // Show selected section
    const selectedSection = document.getElementById(`${sectionName}-section`);
    if (selectedSection) {
        selectedSection.style.display = '';
        selectedSection.classList.add('active');
    }

    // Update nav buttons
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.classList.remove('active');
        if (item.dataset.section === sectionName) {
            item.classList.add('active');
        }
    });

    // Handle models section
    if (sectionName === 'models') {
        renderModelsFullPage(allModels);
    }
    if (sectionName === 'gcode') {
        renderGcodeFileList(allModels);
        if (selectedGcodeId) {
            const model = allModels.find(entry => entry.id === selectedGcodeId);
            if (model) selectGcodePreview(model);
        }
    }
}

// Add click listeners to nav items
const navItems = document.querySelectorAll('.nav-item');
navItems.forEach(item => {
    item.addEventListener('click', () => {
        const section = item.dataset.section;
        switchSection(section);
    });
});

function renderModelsFullPage(models) {
    const modelsFullGrid = document.getElementById('models-full');
    if (!modelsFullGrid) return;
    
    if (models.length === 0) {
        modelsFullGrid.innerHTML = `<div class="empty-state">${t('noFilesFound')}</div>`;
        return;
    }

    const sorted = [...models].sort((a, b) => (b.modified || 0) - (a.modified || 0));
    const selected = sorted.find(item => item.id === selectedModelId) || sorted[0];
    selectedModelId = selected?.id || selectedModelId;

    const rows = sorted.map(model => {
        const isSelected = model.id === selectedModelId;
        const sizeText = formatSize(model.size);
        const dateText = formatDate(model.modified);
        const materialLabel = (model.tags || ['Material'])[0].replace('#', '') || 'Material';
        const isGcode = model.extension === '.gcode';
        const typeLabel = isGcode ? 'G-code' : t('model3D');
        const rowClass = isSelected ? 'selected' : '';

        return `
            <tr class="${rowClass}" data-model-id="${model.id}">
                <td class="model-name">
                    <svg class="${isGcode ? 'orange-bg' : 'green-bg'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h3l2-2h4l2 2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M8 11h8"/><path d="M8 15h8"/></svg>
                    <div>
                        <strong>${model.name}</strong>
                        <div class="preview-meta">${model.description || typeLabel}</div>
                    </div>
                </td>
                <td>${typeLabel}</td>
                <td><span class="tag-pill">${materialLabel}</span></td>
                <td>${sizeText}</td>
                <td>${dateText}</td>
            </tr>
        `;
    }).join('');

    modelsFullGrid.innerHTML = `
        <table class="models-table">
            <thead>
                <tr>
                    <th>${t('columnName')}</th>
                    <th>${t('columnType')}</th>
                    <th>${t('material')}</th>
                    <th>${t('columnSize')}</th>
                    <th>${t('columnDate')}</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;

    modelsFullGrid.querySelectorAll('tbody tr').forEach(row => {
        row.addEventListener('click', () => {
            const modelId = Number(row.dataset.modelId);
            const model = allModels.find(entry => entry.id === modelId);
            if (model) {
                selectPreviewModel(model);
            }
        });
    });

    if (selected) {
        selectPreviewModel(selected, false);
    }
}

function selectPreviewModel(model, rerender = true) {
    if (!model) return;
    selectedModelId = model.id;
    const previewTitle = document.getElementById('preview-filename');
    const previewType = document.getElementById('preview-type');
    const previewSize = document.getElementById('preview-size');
    const previewDate = document.getElementById('preview-date');
    const previewChipMain = document.getElementById('preview-chip-main');
    const previewChipSecondary = document.getElementById('preview-chip-secondary');
    const previewImage = document.getElementById('preview-image');

    if (previewTitle) previewTitle.textContent = model.name;
    if (previewType) previewType.textContent = `Tipo: ${model.extension?.replace('.', '').toUpperCase() || '—'}`;
    if (previewSize) previewSize.textContent = `Tamaño: ${formatSize(model.size)}`;
    if (previewDate) previewDate.textContent = `Modificado: ${formatDate(model.modified)}`;
    if (previewChipMain) previewChipMain.textContent = model.tags?.[0] ? `#${model.tags[0].replace('#', '')}` : '#A3D9B6';
    if (previewChipSecondary) previewChipSecondary.textContent = model.tags?.[1] ? `#${model.tags[1].replace('#', '')}` : '#FF8A4D';
    if (previewImage) {
        previewImage.innerHTML = '';
        previewImage.style.backgroundImage = 'linear-gradient(180deg, rgba(15,23,42,1) 0%, rgba(31,41,55,1) 100%)';
    }

    renderSelectedPreview(model);

    if (rerender) {
        renderModelsFullPage(allModels);
    }
}

// View mode switcher for full models page
const viewGridFull = document.getElementById('view-grid-full');
const viewListFull = document.getElementById('view-list-full');

if (viewGridFull) {
    viewGridFull.addEventListener('click', () => {
        document.getElementById('models-full').classList.remove('list-view');
        viewGridFull.classList.add('btn-view-toggle-active');
        viewListFull.classList.remove('btn-view-toggle-active');
    });
}
if (viewListFull) {
    viewListFull.addEventListener('click', () => {
        document.getElementById('models-full').classList.add('list-view');
        viewListFull.classList.add('btn-view-toggle-active');
        viewGridFull.classList.remove('btn-view-toggle-active');
    });
}

// Settings controls
const settingsTheme = document.getElementById('settings-theme');
const settingsLanguage = document.getElementById('settings-language');
const settingsPreviewQuality = document.getElementById('settings-preview-quality');
const settingsAutoRefresh = document.getElementById('settings-autorefresh');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsStatus = document.getElementById('settings-status');
const settingsColorAccent = document.getElementById('settings-color-accent');
const settingsColorSurface = document.getElementById('settings-color-surface');
const settingsColorText = document.getElementById('settings-color-text');
const settingsColorMuted = document.getElementById('settings-color-muted');
const settingsFaviconUrl = document.getElementById('settings-favicon-url');
const faviconPreviewImg = document.getElementById('favicon-preview-img');

const THEME_PALETTES = {
    light: {
        accent: '#52525b',
        surface: '#ffffff',
        bg: '#f4f4f5',
        sidebar: '#ffffff',
        text: '#18181b',
        muted: '#71717a',
    },
    dark: {
        accent: '#a1a1aa',
        surface: '#27272a',
        bg: '#18181b',
        sidebar: '#121214',
        text: '#fafafa',
        muted: '#a1a1aa',
    },
    green: {
        accent: '#22c55e',
        surface: '#1e293b',
        bg: '#0f172a',
        sidebar: '#0b1220',
        text: '#f1f5f9',
        muted: '#94a3b8',
    },
};

function loadSettingsPanel() {
    const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const savedLanguage = localStorage.getItem('language') || 'es';
    const savedQuality = localStorage.getItem('previewQuality') || 'standard';
    const savedAutoRefresh = localStorage.getItem('autoRefreshPrinters');
    const savedAccent = localStorage.getItem('themeColorAccent');
    const savedSurface = localStorage.getItem('themeColorSurface');
    const savedText = localStorage.getItem('themeColorText');
    const savedMuted = localStorage.getItem('themeColorMuted');
    const savedFavicon = localStorage.getItem('themeFaviconUrl');

    if (settingsTheme) settingsTheme.value = savedTheme;
    if (settingsLanguage) settingsLanguage.value = savedLanguage;
    if (settingsPreviewQuality) settingsPreviewQuality.value = savedQuality;
    if (settingsAutoRefresh) settingsAutoRefresh.checked = savedAutoRefresh !== 'false';

    syncThemePaletteInputs(savedTheme);

    const palette = {
        accent: savedAccent || THEME_PALETTES[savedTheme].accent,
        surface: savedSurface || THEME_PALETTES[savedTheme].surface,
        text: savedText || THEME_PALETTES[savedTheme].text,
        muted: savedMuted || THEME_PALETTES[savedTheme].muted,
    };

    if (settingsColorAccent) settingsColorAccent.value = palette.accent;
    if (settingsColorSurface) settingsColorSurface.value = palette.surface;
    if (settingsColorText) settingsColorText.value = palette.text;
    if (settingsColorMuted) settingsColorMuted.value = palette.muted;
    if (settingsFaviconUrl) settingsFaviconUrl.value = savedFavicon || '';
    if (faviconPreviewImg) {
        faviconPreviewImg.src = savedFavicon || '';
    }
    setActiveThemeCard(savedTheme);
}

function getAutoRefreshEnabled() {
    const savedAutoRefresh = localStorage.getItem('autoRefreshPrinters');
    return savedAutoRefresh !== 'false';
}

function setupPrinterRefresh() {
    if (window.printerRefreshInterval) {
        clearInterval(window.printerRefreshInterval);
    }
    if (getAutoRefreshEnabled()) {
        window.printerRefreshInterval = setInterval(loadPrinters, 5000);
    }
}

function saveSettings() {
    if (settingsTheme) {
        const themeValue = settingsTheme.value;
        localStorage.setItem('theme', themeValue);
        applyTheme(themeValue);
    }
    if (settingsLanguage) {
        const languageValue = settingsLanguage.value;
        setLanguage(languageValue);
        if (langDisplay) langDisplay.textContent = languageValue.toUpperCase();
    }
    if (settingsPreviewQuality) {
        localStorage.setItem('previewQuality', settingsPreviewQuality.value);
    }
    if (settingsAutoRefresh) {
        localStorage.setItem('autoRefreshPrinters', settingsAutoRefresh.checked ? 'true' : 'false');
    }
    if (settingsColorAccent) {
        localStorage.setItem('themeColorAccent', settingsColorAccent.value);
    }
    if (settingsColorSurface) {
        localStorage.setItem('themeColorSurface', settingsColorSurface.value);
    }
    if (settingsColorText) {
        localStorage.setItem('themeColorText', settingsColorText.value);
    }
    if (settingsColorMuted) {
        localStorage.setItem('themeColorMuted', settingsColorMuted.value);
    }
    if (settingsFaviconUrl) {
        const faviconUrl = settingsFaviconUrl.value.trim();
        localStorage.setItem('themeFaviconUrl', faviconUrl);
        if (faviconPreviewImg) faviconPreviewImg.src = faviconUrl;
        updateFavicon(faviconUrl);
    }
    setupPrinterRefresh();
    if (settingsStatus) {
        settingsStatus.textContent = t('settingsSaved');
        setTimeout(() => {
            if (settingsStatus) settingsStatus.textContent = '';
        }, 2000);
    }
}

// Language switcher
const langToggle = document.getElementById('lang-toggle');
const langDisplay = document.getElementById('lang-display');
if (langToggle) {
    langToggle.addEventListener('click', () => {
        const newLang = currentLanguage === 'es' ? 'en' : 'es';
        setLanguage(newLang);
        if (langDisplay) langDisplay.textContent = newLang.toUpperCase();
    });
}

if (settingsTheme) {
    settingsTheme.addEventListener('change', () => {
        const selectedTheme = settingsTheme.value;
        setActiveThemeCard(selectedTheme);
        syncThemePaletteInputs(selectedTheme);
        saveSettings();
    });
}
if (settingsLanguage) {
    settingsLanguage.addEventListener('change', saveSettings);
}
if (settingsPreviewQuality) {
    settingsPreviewQuality.addEventListener('change', saveSettings);
}
if (settingsAutoRefresh) {
    settingsAutoRefresh.addEventListener('change', saveSettings);
}
if (settingsColorAccent) {
    settingsColorAccent.addEventListener('change', saveSettings);
}
if (settingsColorSurface) {
    settingsColorSurface.addEventListener('change', saveSettings);
}
if (settingsColorText) {
    settingsColorText.addEventListener('change', saveSettings);
}
if (settingsColorMuted) {
    settingsColorMuted.addEventListener('change', saveSettings);
}
if (settingsFaviconUrl) {
    settingsFaviconUrl.addEventListener('input', () => {
        if (faviconPreviewImg) faviconPreviewImg.src = settingsFaviconUrl.value.trim();
    });
}
if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', saveSettings);
}

const themeOptionCards = document.querySelectorAll('.theme-option-card');
function setActiveThemeCard(theme) {
    themeOptionCards.forEach(card => {
        card.classList.toggle('active', card.dataset.theme === theme);
    });
}
if (themeOptionCards.length) {
    themeOptionCards.forEach(card => {
        card.addEventListener('click', () => {
            const selectedTheme = card.dataset.theme;
            if (settingsTheme) settingsTheme.value = selectedTheme;
            setActiveThemeCard(selectedTheme);
            syncThemePaletteInputs(selectedTheme);
            saveSettings();
        });
    });
}
if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const currentTheme = settingsTheme ? settingsTheme.value : document.body.getAttribute('data-theme');
        const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('theme', nextTheme);
        if (settingsTheme) {
            settingsTheme.value = nextTheme;
        }
        applyTheme(nextTheme);
    });
}

initializeTheme();
loadSettingsPanel();
setActiveThemeCard(localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
setupPrinterRefresh();

// View mode switcher
const viewGridBtn = document.getElementById('view-grid');
const viewListBtn = document.getElementById('view-list');

if (viewGridBtn) {
    viewGridBtn.addEventListener('click', () => updateViewMode('grid'));
}
if (viewListBtn) {
    viewListBtn.addEventListener('click', () => updateViewMode('list'));
}

// Initialize view mode
if (currentViewMode === 'list') {
    updateViewMode('list');
}

// Update language display on load
langDisplay.textContent = currentLanguage.toUpperCase();
updatePageLanguage();

renderPrintQueue();
loadModels();
loadPrinters();
loadRecentPrinterFiles();

// Refresh printers every 5 seconds
setInterval(loadPrinters, 5000);
