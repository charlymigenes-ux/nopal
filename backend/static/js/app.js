const modelsGrid = document.getElementById('models');
const printersGrid = document.getElementById('printers-grid');
const printQueue = document.getElementById('print-queue');
const totalModelsEl = document.getElementById('total-models');
const gcodeReadyEl = document.getElementById('gcode-ready');
const storageUsedEl = document.getElementById('storage-used');
const storageTotalEl = document.getElementById('storage-total');
const activePrintersEl = document.getElementById('active-printers');
const searchRecentInput = document.getElementById('search-recent');
const searchGcodeInput = document.getElementById('search-gcode');
const searchModelsInput = document.getElementById('search-models');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
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
const dashboardPrinterThemeMode = new Map(); // port(String) -> 'warm' | 'cool'
let recentPrinterFiles = [];
let selectedGcodeId = null;
let currentScene = null;
let currentRenderer = null;
let currentMesh = null;
let currentAnimationFrame = null;
let selectedModelId = null;
let currentViewMode = localStorage.getItem('viewMode') || 'grid';
let printersViewMode = localStorage.getItem('printersViewMode') || 'grid';
const gcodePreviewCache = new Map();

const PALETTE = ['#A3D9B6', '#6EC4A0', '#FFD4B8', '#FF8A4D', '#B8D4BE', '#C4E0C8'];

const NOPAL_LOGO_SVG = `<svg viewBox="0 0 32 32" width="20" height="20" fill="none">
    <path d="M16 2 L28 9 V23 L16 30 L4 23 V9 Z" fill="rgba(34,197,94,0.1)" stroke="#22C55E" stroke-width="2"/>
    <path d="M16 10 v12 M16 14 c0 -3 -3 -4 -3 -4 M16 17 c0 -3 3 -4 3 -4" stroke="#22C55E" stroke-width="2" stroke-linecap="round" fill="none"/>
    <circle cx="13" cy="10" r="1" fill="#22C55E"/>
    <circle cx="19" cy="10" r="1" fill="#22C55E"/>
</svg>`;


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
    const segments = [];

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
        if (code !== 'G0' && code !== 'G1' && code !== 'G00' && code !== 'G01') continue;

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
            } else {
                segments.push(lastPoint.clone(), currentPoint.clone());
            }
            lastPoint.copy(currentPoint);
            x = nx;
            y = ny;
            z = nz;
        }
        e = ne;
    }

    // Muestrea segmentos distribuidos en todo el archivo (no solo el inicio),
    // para que la vista previa represente la pieza completa.
    const segmentCount = segments.length / 2;
    if (segmentCount <= maxSegments) {
        return segments;
    }

    const stride = Math.ceil(segmentCount / maxSegments);
    const sampled = [];
    for (let i = 0; i < segmentCount; i += stride) {
        sampled.push(segments[i * 2], segments[i * 2 + 1]);
    }
    return sampled;
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
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    thumb.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x888888, 1));

    const line = await getGcodePreviewScene(fileUrl, 2500);
    if (!line) {
        thumb.innerHTML = `<div class="thumb-placeholder">G-code</div>`;
        return;
    }

    scene.add(line);
    const box = new THREE.Box3().setFromObject(line);
    const center = new THREE.Vector3();
    box.getCenter(center);
    line.position.sub(center);

    // Vista plana (en planta): el corte/grabado láser es esencialmente 2D (plano XY),
    // así que una cámara ortográfica de arriba hacia abajo muestra el trazo real sin
    // distorsión de perspectiva.
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, 1);
    const viewSize = maxDim * 1.15;
    const camera = new THREE.OrthographicCamera(-viewSize / 2, viewSize / 2, viewSize / 2, -viewSize / 2, 0.1, maxDim * 10 + 100);
    camera.position.set(0, 0, maxDim * 5 + 50);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);

    const resize = () => {
        const width = thumb.clientWidth || 120;
        const height = thumb.clientHeight || 120;
        renderer.setSize(width, height);
        const aspect = width / height || 1;
        const halfHeight = viewSize / 2;
        const halfWidth = halfHeight * aspect;
        camera.left = -halfWidth;
        camera.right = halfWidth;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.updateProjectionMatrix();
    };
    resize();
    renderer.render(scene, camera);
}

async function renderGcodePreview(container, fileUrl) {
    if (!container || !window.THREE || typeof window.THREE.Scene !== 'function') return;
    container.innerHTML = '';

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    container.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x999999, 1.2));

    const line = await getGcodePreviewScene(fileUrl, 9000);
    if (!line) {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;padding:1rem;text-align:center;">No se pudo generar la vista previa.</div>';
        return;
    }

    scene.add(line);
    const box = new THREE.Box3().setFromObject(line);
    const center = new THREE.Vector3();
    box.getCenter(center);
    line.position.sub(center);

    // Vista plana (en planta): el corte/grabado láser ocurre en el plano XY, así
    // que una cámara ortográfica de arriba hacia abajo muestra el trazo real a
    // escala, sin la distorsión de perspectiva de una vista 3D inclinada.
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, 1);
    const view = { size: maxDim * 1.15, offsetX: 0, offsetY: 0 };
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, maxDim * 10 + 100);
    camera.position.set(0, 0, maxDim * 5 + 50);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);

    const applyFrustum = (width, height) => {
        const aspect = width / height || 1;
        const halfHeight = view.size / 2;
        const halfWidth = halfHeight * aspect;
        camera.left = -halfWidth + view.offsetX;
        camera.right = halfWidth + view.offsetX;
        camera.top = halfHeight + view.offsetY;
        camera.bottom = -halfHeight + view.offsetY;
        camera.updateProjectionMatrix();
    };

    const resize = () => {
        const width = container.clientWidth || 320;
        const height = container.clientHeight || 320;
        renderer.setSize(width, height);
        applyFrustum(width, height);
    };

    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    const onPointerDown = event => {
        isDragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = event => {
        if (!isDragging) return;
        const height = container.clientHeight || 320;
        const scale = view.size / height;
        view.offsetX -= (event.clientX - lastX) * scale;
        view.offsetY += (event.clientY - lastY) * scale;
        lastX = event.clientX;
        lastY = event.clientY;
        applyFrustum(container.clientWidth || 320, height);
    };
    const onPointerUp = event => {
        isDragging = false;
        renderer.domElement.releasePointerCapture(event.pointerId);
    };
    const onWheel = event => {
        event.preventDefault();
        const factor = event.deltaY > 0 ? 1.1 : 0.9;
        view.size = Math.max(maxDim * 0.08, Math.min(maxDim * 8, view.size * factor));
        applyFrustum(container.clientWidth || 320, container.clientHeight || 320);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

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

const CUSTOM_THEME_STORAGE_KEY = 'customThemeColors';

function getCustomTheme() {
    try {
        return JSON.parse(localStorage.getItem(CUSTOM_THEME_STORAGE_KEY) || 'null');
    } catch (error) {
        return null;
    }
}

function saveCustomTheme(colors) {
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(colors));
}

function deleteCustomTheme() {
    localStorage.removeItem(CUSTOM_THEME_STORAGE_KEY);
}

function getThemeColors(theme) {
    if (theme === 'custom') {
        const custom = getCustomTheme();
        if (custom) {
            return {
                accent: custom.accent,
                surface: custom.surface,
                bg: custom.surface,
                sidebar: custom.surface,
                text: custom.text,
                muted: custom.muted,
            };
        }
    }
    const defaults = THEME_PALETTES[theme] || THEME_PALETTES.light;
    return {
        accent: defaults.accent,
        surface: defaults.surface,
        bg: defaults.bg || defaults.surface,
        sidebar: defaults.sidebar || defaults.surface,
        text: defaults.text,
        muted: defaults.muted,
    };
}

function applyTheme(theme) {
    let resolvedTheme = theme === 'custom' && getCustomTheme() ? 'custom' : theme;
    if (!['dark', 'green', 'custom'].includes(resolvedTheme)) resolvedTheme = 'light';
    document.body.classList.remove('dark', 'green', 'custom', 'light');
    document.body.classList.add(resolvedTheme);
    document.body.setAttribute('data-theme', resolvedTheme);
    applyCustomThemeBackground();

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
        if (resolvedTheme === 'green') {
            themeIcon.innerHTML = NOPAL_LOGO_SVG;
        } else if (resolvedTheme === 'custom') {
            themeIcon.textContent = '🎨';
        } else {
            const icons = {
                light: '☀️',
                dark: '🌙',
            };
            themeIcon.textContent = icons[resolvedTheme] || '☀️';
        }
    }
}

function initializeTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const themeValue = savedTheme || (prefersDark ? 'dark' : 'light');
    applyTheme(themeValue);
}

function updateBreadcrumb(section, path) {
    const breadcrumbEl = document.getElementById(`${section}-breadcrumb`);
    if (!breadcrumbEl) return;

    const goTo = section === 'gcode' ? loadGcodeFolder : loadModelsFolder;
    const segments = path ? path.split('/') : [];
    let accPath = '';

    const crumbs = [`<button type="button" class="breadcrumb-segment" data-path="">${t('root')}</button>`];
    segments.forEach(segment => {
        accPath = accPath ? `${accPath}/${segment}` : segment;
        crumbs.push(`<span class="breadcrumb-sep">/</span><button type="button" class="breadcrumb-segment" data-path="${accPath}">${segment}</button>`);
    });

    breadcrumbEl.innerHTML = `<span class="breadcrumb-label">${t('currentPath')}:</span> ${crumbs.join('')}`;
    breadcrumbEl.querySelectorAll('.breadcrumb-segment').forEach(btn => {
        btn.addEventListener('click', () => goTo(btn.dataset.path));
    });
}

function folderRowHtml(folder, colspan) {
    return `
        <tr class="folder-row" data-folder-path="${folder.path}">
            <td class="model-name" colspan="${colspan}">
                <svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <strong>${folder.name}</strong>
            </td>
            <td class="folder-actions-cell">
                <button type="button" class="folder-action-btn" data-action="rename" title="${t('renameFolder')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button type="button" class="folder-action-btn" data-action="delete" title="${t('deleteFolder')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
            </td>
        </tr>
    `;
}

function wireFolderRows(container, section, reloadFn) {
    container.querySelectorAll('tr.folder-row').forEach(row => {
        row.addEventListener('click', event => {
            if (event.target.closest('.folder-action-btn')) return;
            reloadFn(row.dataset.folderPath);
        });

        row.querySelectorAll('.folder-action-btn').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                const path = row.dataset.folderPath;
                if (btn.dataset.action === 'rename') renameFolder(section, path);
                if (btn.dataset.action === 'delete') deleteFolder(section, path);
            });
        });
    });
}

async function renameFolder(section, path) {
    const currentName = path.split('/').pop();
    const newName = prompt(t('renameFolderPrompt'), currentName);
    if (!newName || !newName.trim() || newName.trim() === currentName) return;

    const formData = new FormData();
    formData.append('path', path);
    formData.append('new_name', newName.trim());
    formData.append('type', section);

    try {
        const response = await fetch('/api/folders', { method: 'PATCH', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo renombrar la carpeta.');
        }
        if (section === 'gcode') loadGcodeFolder(currentGcodePath);
        else loadModelsFolder(currentModelsPath);
    } catch (error) {
        console.error(error);
        appAlert(error.message, '', 'danger');
    }
}

async function deleteFolder(section, path) {
    if (!confirm(t('deleteFolderConfirm'))) return;

    try {
        const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}&type=${section}`, { method: 'DELETE' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo eliminar la carpeta.');
        }
        if (section === 'gcode') loadGcodeFolder(currentGcodePath);
        else loadModelsFolder(currentModelsPath);
    } catch (error) {
        console.error(error);
        appAlert(error.message, '', 'danger');
    }
}

function updateStats(models) {
    const total = models.length;
    const usedBytes = models.reduce((sum, model) => sum + model.size, 0);
    const gcodeReady = models.filter(m => m.name.toLowerCase().endsWith('.stl')).length;

    if (totalModelsEl) totalModelsEl.textContent = total.toLocaleString();
    if (gcodeReadyEl) gcodeReadyEl.textContent = gcodeReady.toLocaleString();

    // Fetch storage information
    fetch('/api/storage')
        .then(res => res.json())
        .then(data => {
            const used = formatSize(data.used);
            const available = formatSize(data.free);
            if (storageUsedEl) storageUsedEl.textContent = used;
            if (storageTotalEl) storageTotalEl.textContent = `/ ${available}`;
            const diskFreeText = `${t('diskFree')}: ${available}`;
            const modelsDiskFreeEl = document.getElementById('models-disk-free');
            const gcodeDiskFreeEl = document.getElementById('gcode-disk-free');
            if (modelsDiskFreeEl) modelsDiskFreeEl.textContent = diskFreeText;
            if (gcodeDiskFreeEl) gcodeDiskFreeEl.textContent = diskFreeText;
        })
        .catch(err => {
            console.error('Error fetching storage info:', err);
            if (storageUsedEl) storageUsedEl.textContent = formatSize(usedBytes);
            if (storageTotalEl) storageTotalEl.textContent = '';
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

let currentGcodePath = '';
let currentGcodeData = { folders: [], files: [] };

async function loadGcodeFolder(path = currentGcodePath) {
    currentGcodePath = path;
    try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}&type=gcode`);
        if (!response.ok) throw new Error('No se pudo cargar la carpeta');
        currentGcodeData = await response.json();
    } catch (error) {
        console.error(error);
        currentGcodeData = { folders: [], files: [] };
    }
    updateBreadcrumb('gcode', currentGcodePath);
    renderGcodeTable();
}

function renderGcodeTable(filterQuery = '') {
    const gcodeTable = document.getElementById('gcode-table');
    if (!gcodeTable) return;

    const query = filterQuery.toLowerCase();
    const folders = currentGcodeData.folders.filter(f => !query || f.name.toLowerCase().includes(query));
    const files = currentGcodeData.files.filter(f => !query || f.name.toLowerCase().includes(query));

    if (folders.length === 0 && files.length === 0) {
        gcodeTable.innerHTML = `<div class="empty-state">${t('noFilesFound')}</div>`;
        return;
    }

    const sortedFiles = [...files].sort((a, b) => (b.modified || 0) - (a.modified || 0));
    if (!selectedGcodeId || !sortedFiles.some(entry => entry.id === selectedGcodeId)) {
        selectedGcodeId = sortedFiles[0]?.id || null;
    }

    const folderRows = folders.map(folder => folderRowHtml(folder, 3)).join('');

    const fileRows = sortedFiles.map(model => {
        const isSelected = model.id === selectedGcodeId;
        return `
            <tr class="${isSelected ? 'selected' : ''}" data-model-id="${model.id}">
                <td class="model-name">
                    <svg class="orange-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h3l2-2h4l2 2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M8 11h8"/><path d="M8 15h8"/></svg>
                    <strong>${model.name}</strong>
                </td>
                <td><span class="tag-pill">MDF</span></td>
                <td>${formatSize(model.size)}</td>
                <td>${formatDate(model.modified)}</td>
            </tr>
        `;
    }).join('');

    gcodeTable.innerHTML = `
        <table class="models-table">
            <thead>
                <tr>
                    <th>${t('columnName')}</th>
                    <th>${t('material')}</th>
                    <th>${t('columnSize')}</th>
                    <th>${t('columnDate')}</th>
                </tr>
            </thead>
            <tbody>${folderRows}${fileRows}</tbody>
        </table>
    `;

    wireFolderRows(gcodeTable, 'gcode', loadGcodeFolder);

    gcodeTable.querySelectorAll('tbody tr[data-model-id]').forEach(row => {
        row.addEventListener('click', () => {
            const model = currentGcodeData.files.find(entry => entry.id === row.dataset.modelId);
            if (model) selectGcodePreview(model);
        });
    });

    const selectedModel = sortedFiles.find(entry => entry.id === selectedGcodeId);
    if (selectedModel) selectGcodePreview(selectedModel, false);
}

function getGcodeLineCount(fileUrl) {
    return fetch(fileUrl)
        .then(response => response.text())
        .then(text => text.split(/\r?\n/).filter(Boolean).length)
        .catch(() => 0);
}

async function selectGcodePreview(model, rerender = true) {
    if (!model) return;
    selectedGcodeId = model.id;
    const fileUrl = model.file_url;
    if (gcodePreviewTitle) gcodePreviewTitle.textContent = model.name;
    if (gcodePreviewDescription) gcodePreviewDescription.textContent = model.description || 'Vista previa en tiempo real para G-code.';
    if (gcodePreviewSize) gcodePreviewSize.textContent = formatSize(model.size);
    if (gcodePreviewDate) gcodePreviewDate.textContent = formatDate(model.modified);

    if (gcodePreviewLines) {
        const lineCount = await getGcodeLineCount(fileUrl);
        gcodePreviewLines.textContent = lineCount.toLocaleString();
    }

    if (gcodePreviewScene) {
        renderGcodePreview(gcodePreviewScene, fileUrl);
    }

    if (rerender) {
        renderGcodeTable();
    }
}

function updateGcodeSearch(query) {
    renderGcodeTable(query);
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

    const activeJobs = (allPrinters || []).filter(printer => {
        const jobState = printer.job?.state;
        return jobState === 'printing' || jobState === 'paused';
    });

    if (!activeJobs.length) {
        printQueue.innerHTML = `<div class="empty-state-small">${t('noActivePrints')}</div>`;
        return;
    }

    printQueue.innerHTML = activeJobs.map(printer => {
        const printerName = printer.name || `Printer ${printer.port}`;
        const filename = printer.job.filename || '—';
        const progress = printer.job.progress || 0;
        const remainingMinutes = printer.job.estimated_remaining != null ? Math.round(printer.job.estimated_remaining / 60) : null;
        const statusClass = printer.job.state === 'paused' ? 'orange' : 'green';
        return `
            <div class="queue-item">
                <div class="queue-header">
                    <span class="queue-name">${escapeHtml(printerName)} — ${escapeHtml(filename)}</span>
                    <span class="queue-time">${remainingMinutes != null ? formatEstimatedTime(remainingMinutes) : '—'}</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill ${statusClass}" style="width: ${progress}%"></div>
                </div>
            </div>
        `;
    }).join('');
}

async function loadModels() {
    try {
        const response = await fetch('/api/models');
        if (!response.ok) throw new Error('No se pudo cargar la biblioteca');
        allModels = await response.json();
        updateStats(allModels);
    } catch (error) {
        console.error(error);
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

function renderSystemStats(data) {
    const container = document.getElementById('printer-modal-stats');
    if (!container) return;

    if (!data || !data.mcu) {
        container.innerHTML = `<div class="empty-state-small">${t('noSystemStats')}</div>`;
        return;
    }

    const { mcu } = data;

    container.innerHTML = `
        <div class="system-stats-body system-stats-body-mcu-only">
            <div class="system-stats-block">
                <div class="system-stats-block-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/><line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="15" x2="22" y2="15"/><line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="15" x2="4" y2="15"/></svg>
                    <span>MCU <small>${mcu.name || '—'}</small></span>
                </div>
                <div class="system-stats-rows">
                    <div class="system-stats-row"><span>${t('hostVersion')}</span><strong>${mcu.version || '—'}</strong></div>
                    <div class="system-stats-row"><span>${t('mcuLoad')}</span><strong>${mcu.load != null ? mcu.load.toFixed(2) : '—'}</strong></div>
                    <div class="system-stats-row"><span>${t('mcuAwake')}</span><strong>${mcu.awake != null ? mcu.awake.toFixed(2) : '—'}</strong></div>
                    <div class="system-stats-row"><span>${t('mcuFrequency')}</span><strong>${mcu.freq_mhz != null ? mcu.freq_mhz + ' MHz' : '—'}</strong></div>
                    <div class="system-stats-row"><span>${t('temperature')}</span><strong>${mcu.temp != null ? mcu.temp.toFixed(1) + ' °C' : '—'}</strong></div>
                </div>
            </div>
        </div>
    `;
}

const TEMP_SERIES_COLORS = ['#ec4899', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#eab308'];

const HEAT_COLOR_STOPS = [
    { p: 0, c: [96, 165, 250] },   // azul (frío)
    { p: 25, c: [248, 250, 252] }, // blanco (ambiente)
    { p: 50, c: [250, 204, 21] },  // amarillo
    { p: 75, c: [249, 115, 22] },  // naranja
    { p: 100, c: [239, 68, 68] },  // rojo (caliente)
];

function heatColor(percent) {
    const clamped = Math.max(0, Math.min(100, percent || 0));
    let lower = HEAT_COLOR_STOPS[0];
    let upper = HEAT_COLOR_STOPS[HEAT_COLOR_STOPS.length - 1];
    for (let i = 0; i < HEAT_COLOR_STOPS.length - 1; i++) {
        if (clamped >= HEAT_COLOR_STOPS[i].p && clamped <= HEAT_COLOR_STOPS[i + 1].p) {
            lower = HEAT_COLOR_STOPS[i];
            upper = HEAT_COLOR_STOPS[i + 1];
            break;
        }
    }
    const range = upper.p - lower.p || 1;
    const t = (clamped - lower.p) / range;
    const r = Math.round(lower.c[0] + (upper.c[0] - lower.c[0]) * t);
    const g = Math.round(lower.c[1] + (upper.c[1] - lower.c[1]) * t);
    const b = Math.round(lower.c[2] + (upper.c[2] - lower.c[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
}

function heatColorForSensor(current, key) {
    const max = (key || '').includes('bed') ? 120 : 280;
    return heatColor(((current || 0) / max) * 100);
}

function temperatureRowIcon(kind) {
    if (kind === 'heater') {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9a6 6 0 1 0 12 0 6 6 0 0 0-12 0Z"/><path d="M12 3v3"/><path d="M12 15v6"/></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4v10.5a4 4 0 1 0 4 0V4a2 2 0 0 0-4 0Z"/></svg>';
}

function drawTemperatureChart(canvas, series, sensors) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    const keys = Object.keys(series).filter(key => series[key] && series[key].length > 1);
    if (!keys.length) return;

    const padding = { top: 10, right: 10, bottom: 20, left: 32 };
    const plotWidth = Math.max(width - padding.left - padding.right, 1);
    const plotHeight = Math.max(height - padding.top - padding.bottom, 1);

    const allValues = keys.reduce((acc, key) => acc.concat(series[key]), []);
    const minValue = Math.min(0, Math.floor(Math.min(...allValues) / 10) * 10);
    const maxValue = Math.max(40, Math.ceil(Math.max(...allValues) / 10) * 10);

    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.fillStyle = 'rgba(148,163,184,0.85)';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.lineWidth = 1;
    const steps = 2;
    for (let i = 0; i <= steps; i++) {
        const value = minValue + ((maxValue - minValue) * i) / steps;
        const y = padding.top + plotHeight - (plotHeight * i) / steps;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        ctx.fillText(String(Math.round(value)), 4, y + 3);
    }

    keys.forEach((key, index) => {
        const values = series[key];
        ctx.strokeStyle = TEMP_SERIES_COLORS[index % TEMP_SERIES_COLORS.length];
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        values.forEach((value, i) => {
            const x = padding.left + (plotWidth * i) / (values.length - 1 || 1);
            const y = padding.top + plotHeight - ((value - minValue) / (maxValue - minValue || 1)) * plotHeight;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    });

    const sampleCount = Math.max(...keys.map(key => series[key].length));
    const now = Date.now();
    const labelCount = 5;
    ctx.fillStyle = 'rgba(148,163,184,0.85)';
    for (let i = 0; i <= labelCount; i++) {
        const idx = Math.round((sampleCount - 1) * (i / labelCount));
        const secondsAgo = sampleCount - 1 - idx;
        const time = new Date(now - secondsAgo * 1000);
        const label = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const x = padding.left + (plotWidth * idx) / (sampleCount - 1 || 1);
        ctx.fillText(label, Math.min(Math.max(x - 14, padding.left), width - 32), height - 5);
    }
}

async function setTemperatureTarget(port, heater, target) {
    try {
        const formData = new FormData();
        formData.append('port', port);
        formData.append('heater', heater);
        formData.append('target', target);
        const response = await fetch('/api/system/temperature-target', { method: 'POST', body: formData });
        if (!response.ok) throw new Error('No se pudo actualizar la temperatura objetivo');
    } catch (error) {
        console.error(error);
    }
}

let temperatureCardCollapsed = false;
let temperatureCardThemeMode = null; // 'warm' | 'cool' | null

function renderTemperaturesCard(data, port) {
    const container = document.getElementById('printer-modal-temperatures');
    if (!container) return;

    const sensors = data?.sensors || [];
    if (!sensors.length) {
        container.innerHTML = '';
        return;
    }

    if (temperatureCardThemeMode === 'cool') {
        const stillCooling = sensors.some(sensor => sensor.kind === 'heater' && (sensor.current || 0) > 40);
        if (!stillCooling) temperatureCardThemeMode = null;
    }

    const rows = sensors.map((sensor, index) => {
        const color = TEMP_SERIES_COLORS[index % TEMP_SERIES_COLORS.length];
        const stateLabel = sensor.kind === 'heater' ? (sensor.target > 0 ? t('printing') : 'off') : '';
        const targetCell = sensor.kind === 'heater'
            ? `<div class="temp-target-input-wrap">
                    <input type="number" class="temp-target-input" data-heater="${sensor.key}" value="${sensor.target ?? 0}" step="1" min="0">
                    <span class="temp-target-unit">°C</span>
                </div>`
            : '';
        return `
            <div class="temp-table-row">
                <div class="temp-row-name">
                    <span class="temp-row-icon" style="color:${color}">${temperatureRowIcon(sensor.kind)}</span>
                    <span>${sensor.label}</span>
                </div>
                <div class="temp-row-state">${stateLabel}</div>
                <div class="temp-row-current" style="${sensor.current != null ? `color:${heatColorForSensor(sensor.current, sensor.key)}` : ''}">${sensor.current != null ? sensor.current.toFixed(1) + '°C' : '—'}</div>
                <div class="temp-row-target">${targetCell}</div>
            </div>
        `;
    }).join('');

    const themeClass = temperatureCardThemeMode === 'warm' ? ' temp-card-warm' : temperatureCardThemeMode === 'cool' ? ' temp-card-cool' : '';
    container.innerHTML = `
        <div class="temp-card${themeClass}">
            <div class="temp-card-header">
                <div class="temp-card-header-left">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4v10.5a4 4 0 1 0 4 0V4a2 2 0 0 0-4 0Z"/></svg>
                    <span>${t('temperatures')}</span>
                </div>
                <div class="temp-card-header-actions">
                    <button type="button" class="temp-cool-pill" id="temp-cool-btn">${t('tempCool')}</button>
                    <button type="button" class="temp-preset-pill" id="temp-preset-btn">${t('tempPreset')}</button>
                    <button type="button" class="temp-icon-btn" id="temp-config-btn" title="Configuración">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                    </button>
                    <button type="button" class="temp-icon-btn" id="temp-collapse-btn" title="Colapsar">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>
            </div>
            <div class="temp-card-body" id="temp-card-body" ${temperatureCardCollapsed ? 'hidden' : ''}>
                <div class="temp-table">
                    <div class="temp-table-head">
                        <div>${t('columnName')}</div>
                        <div>${t('status')}</div>
                        <div>${t('tempActual')}</div>
                        <div>${t('tempTarget')}</div>
                    </div>
                    ${rows}
                </div>
                <div class="temp-chart-wrap">
                    <canvas id="temp-chart-canvas"></canvas>
                </div>
            </div>
        </div>
    `;

    const canvas = document.getElementById('temp-chart-canvas');
    const seriesData = data.history?.series || {};
    if (canvas && !temperatureCardCollapsed) {
        requestAnimationFrame(() => drawTemperatureChart(canvas, seriesData, sensors));
    }

    container.querySelectorAll('.temp-target-input').forEach(input => {
        input.addEventListener('change', () => {
            const target = parseFloat(input.value) || 0;
            setTemperatureTarget(port, input.dataset.heater, target);
        });
    });

    const collapseBtn = document.getElementById('temp-collapse-btn');
    const body = document.getElementById('temp-card-body');
    if (collapseBtn && body) {
        collapseBtn.classList.toggle('collapsed', temperatureCardCollapsed);
        collapseBtn.addEventListener('click', () => {
            temperatureCardCollapsed = !temperatureCardCollapsed;
            body.hidden = temperatureCardCollapsed;
            collapseBtn.classList.toggle('collapsed', temperatureCardCollapsed);
            if (!temperatureCardCollapsed && canvas) {
                requestAnimationFrame(() => drawTemperatureChart(canvas, seriesData, sensors));
            }
        });
    }

    const heaterSensors = sensors.filter(sensor => sensor.kind === 'heater');

    const coolBtn = document.getElementById('temp-cool-btn');
    if (coolBtn) {
        coolBtn.addEventListener('click', () => {
            temperatureCardThemeMode = 'cool';
            heaterSensors.forEach(sensor => setTemperatureTarget(port, sensor.key, 0));
            setTimeout(() => loadPrinterTemperatures(port), 400);
        });
    }

    const presetBtn = document.getElementById('temp-preset-btn');
    if (presetBtn) {
        presetBtn.addEventListener('click', async () => {
            temperatureCardThemeMode = 'warm';
            try {
                const response = await fetch('/api/system/temperature-presets');
                const presets = await response.json();
                heaterSensors.forEach(sensor => {
                    if (presets[sensor.key] != null) {
                        setTemperatureTarget(port, sensor.key, presets[sensor.key]);
                    }
                });
                setTimeout(() => loadPrinterTemperatures(port), 400);
            } catch (error) {
                console.error(error);
            }
        });
    }

    const configBtn = document.getElementById('temp-config-btn');
    if (configBtn) {
        configBtn.addEventListener('click', () => openTempPresetsModal(heaterSensors));
    }
}

async function openTempPresetsModal(heaterSensors) {
    const modal = document.getElementById('temp-presets-modal');
    const fieldsEl = document.getElementById('temp-presets-fields');
    if (!modal || !fieldsEl) return;

    let presets = {};
    try {
        const response = await fetch('/api/system/temperature-presets');
        presets = await response.json();
    } catch (error) {
        console.error(error);
    }

    fieldsEl.innerHTML = heaterSensors.map(sensor => `
        <div class="temp-presets-field">
            <label for="temp-preset-input-${escapeHtml(sensor.key)}">${escapeHtml(sensor.label)}</label>
            <div class="temp-target-input-wrap">
                <input type="number" id="temp-preset-input-${escapeHtml(sensor.key)}" data-heater="${escapeHtml(sensor.key)}" value="${presets[sensor.key] ?? ''}" step="1" min="0">
                <span class="temp-target-unit">°C</span>
            </div>
        </div>
    `).join('');

    modal.classList.add('active');
}

function closeTempPresetsModal() {
    const modal = document.getElementById('temp-presets-modal');
    if (modal) modal.classList.remove('active');
}

const tempPresetsCancelBtn = document.getElementById('temp-presets-cancel-btn');
if (tempPresetsCancelBtn) tempPresetsCancelBtn.addEventListener('click', closeTempPresetsModal);

const tempPresetsBackdrop = document.getElementById('temp-presets-modal-backdrop');
if (tempPresetsBackdrop) tempPresetsBackdrop.addEventListener('click', closeTempPresetsModal);

const tempPresetsSaveBtn = document.getElementById('temp-presets-save-btn');
if (tempPresetsSaveBtn) {
    tempPresetsSaveBtn.addEventListener('click', async () => {
        const fieldsEl = document.getElementById('temp-presets-fields');
        if (!fieldsEl) return;
        const presets = {};
        fieldsEl.querySelectorAll('input[data-heater]').forEach(input => {
            const value = parseFloat(input.value);
            if (!Number.isNaN(value)) presets[input.dataset.heater] = value;
        });
        try {
            const formData = new FormData();
            formData.append('presets', JSON.stringify(presets));
            await fetch('/api/system/temperature-presets', { method: 'POST', body: formData });
            closeTempPresetsModal();
        } catch (error) {
            console.error(error);
        }
    });
}

async function loadPrinterTemperatures(port) {
    const container = document.getElementById('printer-modal-temperatures');
    if (container && container.contains(document.activeElement) && document.activeElement.classList.contains('temp-target-input')) {
        return;
    }
    try {
        const response = await fetch(`/api/system/temperatures?port=${port}`);
        if (!response.ok) throw new Error('No se pudo cargar la temperatura');
        const data = await response.json();
        renderTemperaturesCard(data, port);
    } catch (error) {
        console.error(error);
        if (container) container.innerHTML = '';
    }
}

const TOPBAR_GAUGE_CIRCUMFERENCE = 2 * Math.PI * 24;

function renderTopbarServerStats(data) {
    const container = document.getElementById('topbar-server-stats');
    if (!container) return;

    const host = data?.host;
    if (!host) {
        container.innerHTML = '';
        return;
    }

    const cpuPercent = Math.max(0, Math.min(100, host.cpu_percent || 0));
    const memPercent = Math.max(0, Math.min(100, host.mem_percent || 0));
    const tempValue = host.temp != null ? host.temp : null;
    const TEMP_GAUGE_MAX = 90;
    const tempPercent = tempValue != null ? Math.max(0, Math.min(100, (tempValue / TEMP_GAUGE_MAX) * 100)) : 0;
    const cpuOffset = TOPBAR_GAUGE_CIRCUMFERENCE - (cpuPercent / 100) * TOPBAR_GAUGE_CIRCUMFERENCE;
    const memOffset = TOPBAR_GAUGE_CIRCUMFERENCE - (memPercent / 100) * TOPBAR_GAUGE_CIRCUMFERENCE;
    const tempOffset = TOPBAR_GAUGE_CIRCUMFERENCE - (tempPercent / 100) * TOPBAR_GAUGE_CIRCUMFERENCE;
    const networkLine = host.network_interface
        ? `${host.network_interface}${host.network_ip ? ` (${host.network_ip})` : ''} : ${t('hostBandwidth')}: ${host.bandwidth_kbps} kB/s , ${t('hostReceived')}: ${host.rx_gb} GB , ${t('hostTransmitted')}: ${host.tx_gb} GB`
        : '—';

    container.innerHTML = `
        <div class="topbar-host-block">
            <div class="topbar-host-title">Host <small>${host.cpu_desc || ''}${host.cpu_bits ? `, ${host.cpu_bits}` : ''}</small></div>
            <div class="topbar-host-lines">
                <span>${t('hostVersion')}: <strong>${host.version || '—'}</strong></span>
                <span>${t('hostOs')}: <strong>${host.os || '—'}</strong></span>
                <span>${t('hostLoad')}: <strong>${cpuPercent}%</strong>, ${t('memory')}: <strong>${host.mem_used_gb} GB / ${host.mem_total_gb} GB</strong> , ${t('temperature')}: <strong>${host.temp != null ? host.temp.toFixed(1) + '°C' : '—'}</strong></span>
                <span>${networkLine}</span>
            </div>
        </div>
        <div class="topbar-host-gauges">
            <div class="topbar-gauge">
                <svg viewBox="0 0 60 60">
                    <circle class="gauge-track" cx="30" cy="30" r="24"/>
                    <circle class="gauge-fill gauge-fill-cpu" cx="30" cy="30" r="24" stroke-dasharray="${TOPBAR_GAUGE_CIRCUMFERENCE}" stroke-dashoffset="${cpuOffset}"/>
                </svg>
                <span class="gauge-value">${cpuPercent}</span>
                <span class="gauge-label">Cpu</span>
            </div>
            <div class="topbar-gauge">
                <svg viewBox="0 0 60 60">
                    <circle class="gauge-track" cx="30" cy="30" r="24"/>
                    <circle class="gauge-fill gauge-fill-mem" cx="30" cy="30" r="24" stroke-dasharray="${TOPBAR_GAUGE_CIRCUMFERENCE}" stroke-dashoffset="${memOffset}"/>
                </svg>
                <span class="gauge-value">${memPercent}</span>
                <span class="gauge-label">${t('memory')}.</span>
            </div>
            <div class="topbar-gauge">
                <svg viewBox="0 0 60 60">
                    <circle class="gauge-track" cx="30" cy="30" r="24"/>
                    <circle class="gauge-fill gauge-fill-temp" cx="30" cy="30" r="24" stroke-dasharray="${TOPBAR_GAUGE_CIRCUMFERENCE}" stroke-dashoffset="${tempOffset}"/>
                </svg>
                <span class="gauge-value">${tempValue != null ? Math.round(tempValue) : '—'}</span>
                <span class="gauge-label">${t('temperature')}</span>
            </div>
        </div>
    `;
}

async function loadTopbarServerStats() {
    const container = document.getElementById('topbar-server-stats');
    if (!container) return;

    try {
        const response = await fetch('/api/system/stats');
        if (!response.ok) throw new Error('No se pudo cargar el estado del servidor');
        const data = await response.json();
        renderTopbarServerStats(data);
    } catch (error) {
        console.error(error);
        container.innerHTML = '';
    }
}

let toolheadCardCollapsed = false;
let toolheadJogStep = 25;
let toolheadPort = null;

async function sendPrinterGcode(port, script) {
    try {
        const formData = new FormData();
        formData.append('port', port);
        formData.append('command', script);
        const response = await fetch('/api/console/command', { method: 'POST', body: formData });
        return response.ok;
    } catch (error) {
        console.error(error);
        return false;
    }
}

function renderToolheadCard(data, port) {
    const container = document.getElementById('printer-modal-toolhead');
    if (!container) return;

    const position = data?.position || { x: 0, y: 0, z: 0 };
    const target = data?.gcode_position || position;
    const zOffset = data?.z_offset || 0;
    const speedPercent = Math.round((data?.speed_factor || 1) * 100);
    const isAbsolute = data?.absolute_coordinates !== false;
    const modeLabel = isAbsolute ? t('positionAbsolute') : t('positionRelative');

    container.innerHTML = `
        <div class="temp-card toolhead-card">
            <div class="temp-card-header">
                <div class="temp-card-header-left">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                    <span>${t('toolhead')}</span>
                </div>
                <div class="temp-card-header-actions">
                    <button type="button" class="temp-icon-btn" id="toolhead-collapse-btn" title="Colapsar">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>
            </div>
            <div class="temp-card-body" id="toolhead-card-body" ${toolheadCardCollapsed ? 'hidden' : ''}>
                <div class="toolhead-position-mode">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/></svg>
                    <span>${t('positionLabel')}: ${modeLabel}</span>
                </div>

                <div class="toolhead-position-row">
                    <div class="toolhead-position-field">
                        <div class="toolhead-position-field-top">
                            <span class="toolhead-position-letter">X</span>
                            <span class="toolhead-position-target">[${target.x.toFixed(2)}]</span>
                        </div>
                        <div class="toolhead-position-box"><span class="toolhead-position-value">${position.x.toFixed(2)}</span></div>
                    </div>
                    <div class="toolhead-position-field">
                        <div class="toolhead-position-field-top">
                            <span class="toolhead-position-letter">Y</span>
                            <span class="toolhead-position-target">[${target.y.toFixed(2)}]</span>
                        </div>
                        <div class="toolhead-position-box"><span class="toolhead-position-value">${position.y.toFixed(2)}</span></div>
                    </div>
                    <div class="toolhead-position-field">
                        <div class="toolhead-position-field-top">
                            <span class="toolhead-position-letter">Z</span>
                            <span class="toolhead-position-target">[${target.z.toFixed(2)}]</span>
                        </div>
                        <div class="toolhead-position-box"><span class="toolhead-position-value">${position.z.toFixed(3)}</span></div>
                    </div>
                </div>

                <div class="toolhead-jog-row">
                    <button type="button" class="toolhead-jog-btn" data-axis="X" data-dir="-1" title="X-">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <div class="toolhead-jog-col">
                        <button type="button" class="toolhead-jog-btn" data-axis="Y" data-dir="1" title="Y+">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
                        </button>
                        <button type="button" class="toolhead-jog-btn" data-axis="Y" data-dir="-1" title="Y-">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                    </div>
                    <button type="button" class="toolhead-jog-btn" data-axis="X" data-dir="1" title="X+">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                    <div class="toolhead-jog-col">
                        <button type="button" class="toolhead-jog-btn" data-axis="Z" data-dir="1" title="Z+">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
                        </button>
                        <button type="button" class="toolhead-jog-btn" data-axis="Z" data-dir="-1" title="Z-">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                    </div>
                    <div class="toolhead-jog-actions">
                        <button type="button" class="toolhead-home-all-btn" id="toolhead-home-all-btn" title="G28">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                            <span>${t('homeAll')}</span>
                        </button>
                        <button type="button" class="toolhead-motors-off-btn" id="toolhead-motors-off-btn" title="M84">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                        </button>
                    </div>
                </div>

                <div class="toolhead-axis-home-row">
                    <button type="button" id="toolhead-home-x-btn">X</button>
                    <button type="button" id="toolhead-home-y-btn">Y</button>
                    <button type="button" id="toolhead-home-z-btn">Z</button>
                </div>

                <div class="toolhead-steps-row" id="toolhead-jog-steps">
                    <button type="button" class="toolhead-step-btn" data-step="1">1</button>
                    <button type="button" class="toolhead-step-btn" data-step="10">10</button>
                    <button type="button" class="toolhead-step-btn" data-step="25">25</button>
                    <button type="button" class="toolhead-step-btn active" data-step="50">50</button>
                    <button type="button" class="toolhead-step-btn" data-step="100">100</button>
                    <button type="button" class="toolhead-step-btn" data-step="200">200</button>
                </div>

                <div class="toolhead-zoffset-row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 8.5 12 15l10-6.5z"/><path d="M2 15.5 12 22l10-6.5"/></svg>
                    <span id="toolhead-zoffset-label">${t('zOffset')}: ${zOffset.toFixed(3)}</span>
                </div>
                <div class="toolhead-zoffset-buttons">
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="-0.05">−0.05</button>
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="-0.025">−0.025</button>
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="-0.01">−0.01</button>
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="-0.005">↓ −0.005</button>
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="0.005">↑ +0.005</button>
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="0.01">+0.01</button>
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="0.025">+0.025</button>
                    <button type="button" class="toolhead-zoffset-btn" data-adjust="0.05">+0.05</button>
                </div>

                <div class="toolhead-speed-row">
                    <span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        ${t('speedFactor')}
                    </span>
                    <span class="toolhead-speed-badge" id="toolhead-speed-value">${speedPercent} %</span>
                </div>
                <div class="toolhead-speed-slider-row">
                    <button type="button" id="toolhead-speed-minus">−</button>
                    <input type="range" id="toolhead-speed-slider" min="20" max="200" value="${speedPercent}">
                    <button type="button" id="toolhead-speed-plus">+</button>
                </div>
            </div>
        </div>
    `;

    const collapseBtn = document.getElementById('toolhead-collapse-btn');
    const body = document.getElementById('toolhead-card-body');
    if (collapseBtn && body) {
        collapseBtn.classList.toggle('collapsed', toolheadCardCollapsed);
        collapseBtn.addEventListener('click', () => {
            toolheadCardCollapsed = !toolheadCardCollapsed;
            body.hidden = toolheadCardCollapsed;
            collapseBtn.classList.toggle('collapsed', toolheadCardCollapsed);
        });
    }

    container.querySelectorAll('#toolhead-jog-steps .toolhead-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            toolheadJogStep = parseFloat(btn.dataset.step);
            container.querySelectorAll('#toolhead-jog-steps .toolhead-step-btn').forEach(b => b.classList.toggle('active', b === btn));
        });
        if (btn.classList.contains('active')) toolheadJogStep = parseFloat(btn.dataset.step);
    });

    container.querySelectorAll('.toolhead-jog-btn[data-axis]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const axis = btn.dataset.axis;
            const dir = parseInt(btn.dataset.dir, 10);
            const distance = (toolheadJogStep * dir).toFixed(3);
            const feed = axis === 'Z' ? 600 : 3000;
            await sendPrinterGcode(port, `G91\nG1 ${axis}${distance} F${feed}\nG90`);
            loadPrinterToolhead(port);
        });
    });

    const homeAllBtn = document.getElementById('toolhead-home-all-btn');
    if (homeAllBtn) homeAllBtn.addEventListener('click', async () => {
        await sendPrinterGcode(port, 'G28');
        loadPrinterToolhead(port);
    });

    ['x', 'y', 'z'].forEach(axis => {
        const btn = document.getElementById(`toolhead-home-${axis}-btn`);
        if (btn) btn.addEventListener('click', async () => {
            await sendPrinterGcode(port, `G28 ${axis.toUpperCase()}`);
            loadPrinterToolhead(port);
        });
    });

    const motorsOffBtn = document.getElementById('toolhead-motors-off-btn');
    if (motorsOffBtn) motorsOffBtn.addEventListener('click', async () => {
        await sendPrinterGcode(port, 'M84');
    });

    container.querySelectorAll('.toolhead-zoffset-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const adjust = parseFloat(btn.dataset.adjust);
            await sendPrinterGcode(port, `SET_GCODE_OFFSET Z_ADJUST=${adjust} MOVE=1`);
            loadPrinterToolhead(port);
        });
    });

    const speedSlider = document.getElementById('toolhead-speed-slider');
    const speedValue = document.getElementById('toolhead-speed-value');
    const applySpeed = async (value) => {
        speedSlider.value = value;
        if (speedValue) speedValue.textContent = `${value} %`;
        await sendPrinterGcode(port, `M220 S${value}`);
    };
    if (speedSlider) {
        speedSlider.addEventListener('input', () => {
            if (speedValue) speedValue.textContent = `${speedSlider.value} %`;
        });
        speedSlider.addEventListener('change', () => applySpeed(speedSlider.value));
    }
    const speedMinusBtn = document.getElementById('toolhead-speed-minus');
    if (speedMinusBtn) speedMinusBtn.addEventListener('click', () => applySpeed(Math.max(20, parseInt(speedSlider.value, 10) - 10)));
    const speedPlusBtn = document.getElementById('toolhead-speed-plus');
    if (speedPlusBtn) speedPlusBtn.addEventListener('click', () => applySpeed(Math.min(200, parseInt(speedSlider.value, 10) + 10)));
}

async function loadPrinterToolhead(port) {
    const container = document.getElementById('printer-modal-toolhead');
    if (container && container.contains(document.activeElement) && document.activeElement.id === 'toolhead-speed-slider') {
        return;
    }
    try {
        const response = await fetch(`/api/system/toolhead?port=${port}`);
        if (!response.ok) throw new Error('No se pudo cargar la posición del cabezal');
        const data = await response.json();
        renderToolheadCard(data, port);
    } catch (error) {
        console.error(error);
        if (container) container.innerHTML = '';
    }
}

const printerModal = document.getElementById('printer-modal');

let printerModalTemperatureInterval = null;
let printerModalToolheadInterval = null;

function closePrinterModal() {
    if (!printerModal) return;
    printerModal.classList.remove('active');
    if (printerModalTemperatureInterval) {
        clearInterval(printerModalTemperatureInterval);
        printerModalTemperatureInterval = null;
    }
    if (printerModalToolheadInterval) {
        clearInterval(printerModalToolheadInterval);
        printerModalToolheadInterval = null;
    }
}

async function openPrinterModal(printer) {
    if (!printerModal) return;

    const stateValue = (printer.state || printer.printer_info?.state || '').toString().toLowerCase();
    const normalizedStatus = printer.status === 'online' || ['ready', 'printing', 'paused', 'busy', 'standby'].includes(stateValue) ? 'online' : 'offline';
    const isOnline = normalizedStatus === 'online';
    const stateKey = stateValue === 'ready' ? 'idle' : stateValue;
    const stateDisplay = t(stateKey) !== stateKey ? t(stateKey) : (stateValue || t('idle'));
    const visualState = getPrinterVisualState(stateValue, isOnline);
    const printerName = printer.name || printer.printer_info?.name || printer.printer_info?.hostname || `Printer ${printer.port || ''}`;

    const modalContent = document.getElementById('printer-modal-content');
    const modalImage = document.getElementById('printer-modal-image');
    const modalName = document.getElementById('printer-modal-name');
    const modalStatusLine = document.getElementById('printer-modal-status-line');
    const modalStatusDot = document.getElementById('printer-modal-status-dot');
    const modalStatusText = document.getElementById('printer-modal-status-text');
    const statsContainer = document.getElementById('printer-modal-stats');
    const temperaturesContainer = document.getElementById('printer-modal-temperatures');
    const toolheadContainer = document.getElementById('printer-modal-toolhead');

    if (modalContent) modalContent.className = `modal-content printer-modal-content ${visualState}`;
    if (modalImage) modalImage.src = PRINTER_STATE_IMAGES[visualState];
    if (modalName) modalName.textContent = printerName;
    if (modalStatusLine) modalStatusLine.className = `printer-status-line ${visualState}`;
    if (modalStatusDot) modalStatusDot.className = `printer-status-dot ${visualState}`;
    if (modalStatusText) modalStatusText.textContent = stateDisplay;
    if (statsContainer) statsContainer.innerHTML = `<div class="empty-state-small">${t('noSystemStats')}</div>`;
    if (temperaturesContainer) temperaturesContainer.innerHTML = '';
    if (toolheadContainer) toolheadContainer.innerHTML = '';

    printerModal.classList.add('active');

    if (printerModalTemperatureInterval) {
        clearInterval(printerModalTemperatureInterval);
        printerModalTemperatureInterval = null;
    }
    if (printerModalToolheadInterval) {
        clearInterval(printerModalToolheadInterval);
        printerModalToolheadInterval = null;
    }

    try {
        const response = await fetch(`/api/system/stats?port=${printer.port}`);
        if (!response.ok) throw new Error('No se pudo cargar las estadísticas del sistema');
        const data = await response.json();
        renderSystemStats(data);
    } catch (error) {
        console.error(error);
        if (statsContainer) statsContainer.innerHTML = `<div class="empty-state-small">${t('noSystemStats')}</div>`;
    }

    if (printer.port) {
        loadPrinterTemperatures(printer.port);
        printerModalTemperatureInterval = setInterval(() => loadPrinterTemperatures(printer.port), 4000);
        loadPrinterToolhead(printer.port);
        printerModalToolheadInterval = setInterval(() => loadPrinterToolhead(printer.port), 3000);
    }
}

async function loadPrinters() {
    try {
        const response = await fetch('/api/printers/status');
        if (!response.ok) throw new Error('No se pudo cargar el estado de impresoras');
        const data = await response.json();
        allPrinters = data.printers || [];
        renderPrinters(allPrinters);
        updateActivePrintersCount();
        renderPrintQueue();
    } catch (error) {
        console.error(error);
        if (printersGrid) {
            printersGrid.innerHTML = `<div class="empty-state">${t('errorLoadingModels')}</div>`;
        }
    }
}

const PRINTER_STATE_IMAGES = {
    printing: '/static/img/printer_ready.png',
    paused: '/static/img/printer_atencion.png',
    error: '/static/img/printer_Alert.png',
    idle: '/static/img/printer_ready.png',
};

function getPrinterVisualState(stateValue, isOnline) {
    if (stateValue === 'printing') return 'printing';
    if (stateValue === 'paused') return 'paused';
    if (!isOnline || ['error', 'shutdown', 'disconnected'].includes(stateValue)) return 'error';
    return 'idle';
}

function printerIllustrationImg(visualState) {
    return `<img src="${PRINTER_STATE_IMAGES[visualState]}" alt="" loading="lazy">`;
}

const PRINTER_STATUS_SORT_ORDER = { printing: 0, paused: 1, error: 2, idle: 3 };

function getPrinterSortPriority(printer) {
    const stateValue = (printer.state || printer.printer_info?.state || '').toString().toLowerCase();
    const normalizedStatus = printer.status === 'online' || ['ready', 'printing', 'paused', 'busy', 'standby'].includes(stateValue) ? 'online' : 'offline';
    const isOnline = normalizedStatus === 'online';
    if (!isOnline) return 4;
    const visualState = getPrinterVisualState(stateValue, isOnline);
    return PRINTER_STATUS_SORT_ORDER[visualState] ?? 3;
}


const LASER_STATE_IMAGES = {
    printing: '/static/img/Laser_ready.png',
    paused: '/static/img/Laser_atention.png',
    error: '/static/img/Laser_error.png',
    idle: '/static/img/Laser_ready.png',
    offline: '/static/img/Laser_ready.png',
};

function laserIllustrationImg(visualState) {
    return `<img src="${LASER_STATE_IMAGES[visualState]}" alt="" loading="lazy">`;
}

function getLaserVisualState(status) {
    if (!status || !status.connected) return 'offline';
    const state = (status.state || '').toLowerCase();
    if (state === 'run') return 'printing';
    if (state === 'hold') return 'paused';
    if (state === 'alarm' || state === 'door') return 'error';
    return 'idle';
}

function laserHostLabel(host) {
    if (!host) return '';
    const registeredName = registeredLaserMap.get(host);
    if (registeredName) return registeredName;
    return host.startsWith('usb:') ? host.slice(4) : host;
}

function laserDashboardSortPriority(status) {
    const visualState = getLaserVisualState(status);
    if (visualState === 'offline') return 4;
    return PRINTER_STATUS_SORT_ORDER[visualState] ?? 3;
}

function laserDashboardCardHtml(entry) {
    const { host, status } = entry;
    const visualState = getLaserVisualState(status);
    const isOnline = visualState !== 'offline';
    const statusText = isOnline ? t('online') : t('offline');
    const stateLabel = isOnline ? (status.state || t('idle')) : t('laserOffline');
    const position = isOnline ? `X${status.x.toFixed(1)} Y${status.y.toFixed(1)} Z${status.z.toFixed(1)}` : '—';
    const feedSpeed = isOnline ? `${status.feed} / ${status.speed}` : '—';
    const hostLabel = laserHostLabel(host);

    return `
        <div class="printer-card printer-card-type-laser laser-dashboard-card ${isOnline ? 'online' : 'offline'} ${visualState}" data-laser-host="${escapeHtml(host)}">
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${t('laser')}</h3>
                    ${hostLabel ? `<p class="printer-name-sub">${escapeHtml(hostLabel)}</p>` : ''}
                </div>
                <div class="printer-status-icon ${isOnline ? 'online' : 'offline'}" title="${statusText}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                </div>
            </div>

            <div class="printer-status-line ${visualState}">
                <span class="printer-status-dot ${visualState}"></span>${stateLabel}
            </div>

            <div class="printer-illustration printer-illustration-${visualState}">
                ${laserIllustrationImg(visualState)}
            </div>

            ${visualState === 'printing' || visualState === 'paused' ? `
                <div class="printer-temps">
                    <div class="temp-item">
                        <div class="temp-label">${t('laserPosition')}</div>
                        <div class="temp-value laser-dashboard-metric">${position}</div>
                    </div>
                    <div class="temp-item">
                        <div class="temp-label">${t('laserFeedSpeed')}</div>
                        <div class="temp-value laser-dashboard-metric">${feedSpeed}</div>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

let dashboardLaserEntries = [];

async function refreshDashboardLaserCard() {
    try {
        const registryResponse = await fetch('/api/laser/registry');
        const registryData = await registryResponse.json();
        const lasers = registryData.lasers || [];
        dashboardLaserEntries = await Promise.all(lasers.map(async laser => {
            try {
                const response = await fetch(`/api/laser/status?host=${encodeURIComponent(laser.host)}`);
                const status = await response.json();
                return { host: laser.host, status };
            } catch (error) {
                return { host: laser.host, status: { connected: false } };
            }
        }));
    } catch (error) {
        console.error(error);
        dashboardLaserEntries = [];
    }
    renderPrinters(allPrinters);
}

function isShowOfflineMachinesEnabled() {
    return localStorage.getItem('showOfflineMachines') !== 'false';
}

function updatePrintersViewMode(mode) {
    printersViewMode = mode;
    localStorage.setItem('printersViewMode', mode);
    if (printersGrid) printersGrid.classList.toggle('list-view', mode === 'list');
    const gridBtn = document.getElementById('view-grid-printers');
    const listBtn = document.getElementById('view-list-printers');
    if (gridBtn) gridBtn.classList.toggle('btn-view-toggle-active', mode === 'grid');
    if (listBtn) listBtn.classList.toggle('btn-view-toggle-active', mode === 'list');
}

function renderPrinters(printersInput) {
    if (!printersGrid) return;

    printersGrid.classList.toggle('list-view', printersViewMode === 'list');
    const showOffline = isShowOfflineMachinesEnabled();
    const printers = printersInput || [];

    const printerEntries = printers.map(printer => {
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
        const portKey = String(printer.port);
        if (dashboardPrinterThemeMode.get(portKey) === 'cool') {
            const stillCooling = (typeof bedTemp === 'number' && bedTemp > 40) || (typeof extruderTemp === 'number' && extruderTemp > 40);
            if (!stillCooling) dashboardPrinterThemeMode.delete(portKey);
        }
        const themeMode = visualState === 'idle' ? dashboardPrinterThemeMode.get(portKey) : null;
        const themeModeClass = themeMode ? ` printer-card-${themeMode}` : '';

        const html = `
            <div class="printer-card printer-card-type-3d ${normalizedStatus} ${visualState}${themeModeClass}" data-port="${printer.port}">
                <div class="printer-card-top">
                    <div>
                        <h3 class="printer-name">${t('printerType3D')}</h3>
                        <p class="printer-name-sub">${escapeHtml(printerName)}</p>
                    </div>
                    <div class="printer-status-icon ${normalizedStatus}" title="${statusText}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
                        </svg>
                    </div>
                </div>

                <div class="printer-status-line ${visualState}">
                    <span class="printer-status-dot ${visualState}"></span>${stateDisplay}
                </div>

                <div class="printer-illustration printer-illustration-${visualState}">
                    ${printerIllustrationImg(visualState)}
                </div>

                ${visualState === 'printing' || visualState === 'paused' || visualState === 'idle' ? `
                    <div class="printer-temps">
                        <div class="temp-item">
                            <div class="temp-label">${t('bedTemp')}</div>
                            <div class="temp-value" style="color:${heatColor(bedPercent)}">${bedTemp}<span class="temp-unit">°C</span></div>
                        </div>
                        <div class="temp-item">
                            <div class="temp-label">${t('extruderTemp')}</div>
                            <div class="temp-value" style="color:${heatColor(extruderPercent)}">${extruderTemp}<span class="temp-unit">°C</span></div>
                        </div>
                    </div>
                ` : ''}

                ${visualState === 'printing' || visualState === 'paused' ? `
                    <div class="printer-progress">
                        <div class="printer-progress-labels">
                            <span>${bedPercent}%</span>
                            <span>${extruderPercent}%</span>
                        </div>
                        <div class="temp-progress"><div class="temp-progress-fill" style="width: ${overallPercent}%"></div></div>
                    </div>
                ` : ''}

                ${visualState === 'idle' ? `
                    <div class="printer-quick-actions">
                        <button type="button" class="printer-quick-action-btn" data-quick-action="cool" data-port="${printer.port}">${t('tempCool')}</button>
                        <button type="button" class="printer-quick-action-btn printer-quick-action-btn-accent" data-quick-action="preheat" data-port="${printer.port}">${t('tempPreset')}</button>
                    </div>
                ` : ''}
            </div>
        `;

        return { isOnline, sortPriority: getPrinterSortPriority(printer), html };
    });

    const laserEntries = dashboardLaserEntries.map(entry => {
        const isOnline = getLaserVisualState(entry.status) !== 'offline';
        return {
            isOnline,
            sortPriority: laserDashboardSortPriority(entry.status),
            html: laserDashboardCardHtml(entry),
        };
    });

    let combined = [...printerEntries, ...laserEntries];
    if (!showOffline) combined = combined.filter(entry => entry.isOnline);
    combined.sort((a, b) => a.sortPriority - b.sortPriority);

    printersGrid.innerHTML = combined.length
        ? combined.map(entry => entry.html).join('')
        : `<div class="empty-state">${t('noPrintersFound')}</div>`;

    printersGrid.querySelectorAll('.printer-card[data-port]').forEach(card => {
        card.addEventListener('click', () => {
            const port = Number(card.dataset.port);
            const printer = allPrinters.find(p => p.port === port);
            if (printer) openPrinterModal(printer);
        });
    });

    printersGrid.querySelectorAll('.printer-card[data-laser-host]').forEach(card => {
        card.addEventListener('click', async () => {
            const host = card.dataset.laserHost;
            try {
                const formData = new FormData();
                formData.append('host', host);
                await fetch('/api/laser/host', { method: 'POST', body: formData });
            } catch (error) {
                console.error(error);
            }
            switchSection('laser');
        });
    });

    printersGrid.querySelectorAll('.printer-quick-action-btn').forEach(btn => {
        btn.addEventListener('click', async (event) => {
            event.stopPropagation();
            const port = btn.dataset.port;
            const action = btn.dataset.quickAction;
            try {
                if (action === 'cool') {
                    dashboardPrinterThemeMode.set(port, 'cool');
                    await Promise.all([
                        setTemperatureTarget(port, 'heater_bed', 0),
                        setTemperatureTarget(port, 'extruder', 0),
                    ]);
                } else if (action === 'preheat') {
                    dashboardPrinterThemeMode.set(port, 'warm');
                    const response = await fetch('/api/system/temperature-presets');
                    const presets = await response.json();
                    const tasks = [];
                    if (presets.heater_bed != null) tasks.push(setTemperatureTarget(port, 'heater_bed', presets.heater_bed));
                    if (presets.extruder != null) tasks.push(setTemperatureTarget(port, 'extruder', presets.extruder));
                    await Promise.all(tasks);
                }
                loadPrinters();
            } catch (error) {
                console.error(error);
            }
        });
    });
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

const printerModalClose = document.getElementById('printer-modal-close');
const printerModalBackdrop = printerModal ? printerModal.querySelector('.modal-backdrop') : null;
if (printerModalClose) {
    printerModalClose.addEventListener('click', closePrinterModal);
}
if (printerModalBackdrop) {
    printerModalBackdrop.addEventListener('click', closePrinterModal);
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
        renderModelsFullPage(event.target.value);
    });
}

function renderUploadingRow(tableContainerId, filename) {
    const container = document.getElementById(tableContainerId);
    const tbody = container ? container.querySelector('tbody') : null;
    if (!tbody) return null;

    const row = document.createElement('tr');
    row.className = 'uploading-row';
    row.innerHTML = `
        <td class="model-name" colspan="10">
            <svg class="green-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h3l2-2h4l2 2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M8 11h8"/><path d="M8 15h8"/></svg>
            <div class="uploading-info">
                <strong>${filename}</strong>
                <div class="upload-progress-track"><div class="upload-progress-fill" style="width:0%"></div></div>
            </div>
        </td>
    `;
    tbody.insertBefore(row, tbody.firstChild);
    return row;
}

function wireUploadButton(btnId, inputId, type, getPath, tableContainerId, onDone) {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;

    btn.addEventListener('click', () => input.click());

    input.addEventListener('change', () => {
        const file = input.files[0];
        if (!file) return;

        const row = renderUploadingRow(tableContainerId, file.name);
        const progressFill = row ? row.querySelector('.upload-progress-fill') : null;

        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', getPath());
        formData.append('type', type);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');

        xhr.upload.addEventListener('progress', event => {
            if (event.lengthComputable && progressFill) {
                progressFill.style.width = `${Math.round((event.loaded / event.total) * 100)}%`;
            }
        });

        xhr.addEventListener('load', () => {
            input.value = '';
            if (xhr.status >= 200 && xhr.status < 300) {
                loadModels();
                onDone();
            } else {
                if (row) row.remove();
                appAlert('No se pudo subir el archivo.', '', 'danger');
            }
        });

        xhr.addEventListener('error', () => {
            if (row) row.remove();
            appAlert('No se pudo subir el archivo.', '', 'danger');
        });

        xhr.send(formData);
    });
}

function wireCreateFolderButton(btnId, type, getPath, onDone) {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener('click', async () => {
        const name = prompt(t('newFolderPrompt'));
        if (!name || !name.trim()) return;

        const formData = new FormData();
        formData.append('path', getPath());
        formData.append('name', name.trim());
        formData.append('type', type);

        try {
            const response = await fetch('/api/folders', {
                method: 'POST',
                body: formData,
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || 'No se pudo crear la carpeta.');
            }
            onDone();
        } catch (error) {
            console.error(error);
            appAlert(error.message || 'No se pudo crear la carpeta.', '', 'danger');
        }
    });
}

function wireReloadButton(btnId, onDone) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
        loadModels();
        onDone();
    });
}

function wireSettingsButton(btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => switchSection('settings'));
}

function stripSectionPrefix(id, section) {
    const prefix = section === 'gcode' ? 'gcode/' : 'models/';
    return id && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function downloadFile(model) {
    if (!model) return;
    const link = document.createElement('a');
    link.href = model.file_url;
    link.download = model.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

async function renameFile(section, model, reloadFn) {
    if (!model) return;
    const extension = model.extension || '';
    const currentBase = extension && model.name.toLowerCase().endsWith(extension.toLowerCase())
        ? model.name.slice(0, model.name.length - extension.length)
        : model.name;
    const newName = prompt(t('renameFilePrompt'), currentBase);
    if (!newName || !newName.trim()) return;

    const formData = new FormData();
    formData.append('path', stripSectionPrefix(model.id, section));
    formData.append('new_name', newName.trim());
    formData.append('type', section);

    try {
        const response = await fetch('/api/files', { method: 'PATCH', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo renombrar el archivo.');
        }
        reloadFn();
    } catch (error) {
        console.error(error);
        appAlert(error.message || 'No se pudo renombrar el archivo.', '', 'danger');
    }
}

async function deleteFile(section, model, reloadFn, clearSelection) {
    if (!model) return;
    if (!confirm(t('deleteFileConfirm'))) return;

    const relPath = stripSectionPrefix(model.id, section);

    try {
        const response = await fetch(`/api/files?path=${encodeURIComponent(relPath)}&type=${section}`, { method: 'DELETE' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo eliminar el archivo.');
        }
        clearSelection();
        reloadFn();
    } catch (error) {
        console.error(error);
        appAlert(error.message || 'No se pudo eliminar el archivo.', '', 'danger');
    }
}

let moveFileSection = 'model';
let moveFileTargetModel = null;
let moveFileBrowsePath = '';
let moveFileBrowseData = { folders: [], files: [] };
let moveFileReloadFn = null;
let moveFileClearSelection = null;

function closeMoveFileModal() {
    const modal = document.getElementById('move-file-modal');
    if (modal) modal.classList.remove('active');
}

function renderMoveFileBrowser() {
    const breadcrumbEl = document.getElementById('move-file-breadcrumb');
    const listEl = document.getElementById('move-file-folder-list');
    if (!breadcrumbEl || !listEl) return;

    const segments = moveFileBrowsePath ? moveFileBrowsePath.split('/') : [];
    let accPath = '';
    const crumbs = [`<button type="button" class="breadcrumb-segment" data-path="">${t('root')}</button>`];
    segments.forEach(segment => {
        accPath = accPath ? `${accPath}/${segment}` : segment;
        crumbs.push(`<span class="breadcrumb-sep">/</span><button type="button" class="breadcrumb-segment" data-path="${accPath}">${segment}</button>`);
    });
    breadcrumbEl.innerHTML = crumbs.join('');
    breadcrumbEl.querySelectorAll('.breadcrumb-segment').forEach(btn => {
        btn.addEventListener('click', () => loadMoveFileFolder(btn.dataset.path));
    });

    const folders = moveFileBrowseData.folders || [];
    if (!folders.length) {
        listEl.innerHTML = `<div class="empty-state-small">${t('noFilesFound')}</div>`;
        return;
    }

    listEl.innerHTML = folders.map(folder => `
        <button type="button" class="move-file-folder-row" data-path="${folder.path}">
            <svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none" width="16" height="16"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>${folder.name}</span>
        </button>
    `).join('');
    listEl.querySelectorAll('.move-file-folder-row').forEach(btn => {
        btn.addEventListener('click', () => loadMoveFileFolder(btn.dataset.path));
    });
}

async function loadMoveFileFolder(path) {
    moveFileBrowsePath = path;
    try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}&type=${moveFileSection}`);
        if (!response.ok) throw new Error('No se pudo cargar la carpeta');
        moveFileBrowseData = await response.json();
    } catch (error) {
        console.error(error);
        moveFileBrowseData = { folders: [], files: [] };
    }
    renderMoveFileBrowser();
}

function openMoveFileModal(section, model, reloadFn, clearSelection) {
    if (!model) return;
    moveFileSection = section;
    moveFileTargetModel = model;
    moveFileReloadFn = reloadFn;
    moveFileClearSelection = clearSelection;

    const nameEl = document.getElementById('move-file-current-name');
    if (nameEl) nameEl.textContent = model.name;

    const startPath = stripSectionPrefix(model.id, section).split('/').slice(0, -1).join('/');
    loadMoveFileFolder(startPath);

    const modal = document.getElementById('move-file-modal');
    if (modal) modal.classList.add('active');
}

async function confirmMoveFile() {
    if (!moveFileTargetModel) return;
    const relPath = stripSectionPrefix(moveFileTargetModel.id, moveFileSection);

    const formData = new FormData();
    formData.append('path', relPath);
    formData.append('destination', moveFileBrowsePath);
    formData.append('type', moveFileSection);

    try {
        const response = await fetch('/api/files/move', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo mover el archivo.');
        }
        closeMoveFileModal();
        if (moveFileClearSelection) moveFileClearSelection();
        if (moveFileReloadFn) moveFileReloadFn();
    } catch (error) {
        console.error(error);
        appAlert(error.message || 'No se pudo mover el archivo.', '', 'danger');
    }
}

document.getElementById('move-file-modal-backdrop')?.addEventListener('click', closeMoveFileModal);
document.getElementById('move-file-modal-close')?.addEventListener('click', closeMoveFileModal);
document.getElementById('move-file-confirm-btn')?.addEventListener('click', confirmMoveFile);

function wireFileActionButtons(downloadBtnId, renameBtnId, moveBtnId, deleteBtnId, section, getModel, reloadFn, clearSelection) {
    const downloadBtn = document.getElementById(downloadBtnId);
    const renameBtn = document.getElementById(renameBtnId);
    const moveBtn = document.getElementById(moveBtnId);
    const deleteBtn = document.getElementById(deleteBtnId);

    if (downloadBtn) downloadBtn.addEventListener('click', () => downloadFile(getModel()));
    if (renameBtn) renameBtn.addEventListener('click', () => renameFile(section, getModel(), reloadFn));
    if (moveBtn) moveBtn.addEventListener('click', () => openMoveFileModal(section, getModel(), reloadFn, clearSelection));
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteFile(section, getModel(), reloadFn, clearSelection));
}

wireUploadButton('upload-btn-models', 'upload-input-models', 'model', () => currentModelsPath, 'models-full', () => loadModelsFolder(currentModelsPath));
wireUploadButton('upload-btn-gcode', 'upload-input-gcode', 'gcode', () => currentGcodePath, 'gcode-table', () => loadGcodeFolder(currentGcodePath));
wireCreateFolderButton('create-folder-btn-models', 'model', () => currentModelsPath, () => loadModelsFolder(currentModelsPath));
wireCreateFolderButton('create-folder-btn-gcode', 'gcode', () => currentGcodePath, () => loadGcodeFolder(currentGcodePath));
wireReloadButton('reload-btn-models', () => loadModelsFolder(currentModelsPath));
wireReloadButton('reload-btn-gcode', () => loadGcodeFolder(currentGcodePath));
wireSettingsButton('settings-btn-models');
wireSettingsButton('settings-btn-gcode');
wireFileActionButtons(
    'preview-download-btn', 'preview-rename-btn', 'preview-move-btn', 'preview-delete-btn', 'model',
    () => currentModelsData.files.find(entry => entry.id === selectedModelId),
    () => loadModelsFolder(currentModelsPath),
    () => { selectedModelId = null; }
);
wireFileActionButtons(
    'gcode-download-btn', 'gcode-rename-btn', 'gcode-move-btn', 'gcode-delete-btn', 'gcode',
    () => currentGcodeData.files.find(entry => entry.id === selectedGcodeId),
    () => loadGcodeFolder(currentGcodePath),
    () => { selectedGcodeId = null; }
);

const gcodeSendLaserBtn = document.getElementById('gcode-send-laser-btn');
if (gcodeSendLaserBtn) {
    gcodeSendLaserBtn.addEventListener('click', async () => {
        const model = currentGcodeData.files.find(entry => entry.id === selectedGcodeId);
        if (!model) return;

        const relPath = stripSectionPrefix(model.id, 'gcode');
        const labelEl = gcodeSendLaserBtn.querySelector('span');
        const originalLabel = labelEl ? labelEl.textContent : '';

        try {
            const formData = new FormData();
            formData.append('path', relPath);
            const response = await fetch('/api/laser/queue/add', { method: 'POST', body: formData });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || 'No se pudo agregar a la cola del láser.');
            }
            if (labelEl) {
                labelEl.textContent = t('sendToLaserAdded');
                setTimeout(() => { labelEl.textContent = originalLabel; }, 1800);
            }
            refreshLaserQueue();
        } catch (error) {
            console.error(error);
            appAlert(error.message || 'No se pudo agregar a la cola del láser.', '', 'danger');
        }
    });
}

// ── Console & Macros ──
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function populatePrinterSelect(selectEl, preferredPort) {
    if (!selectEl) return null;
    const previousValue = preferredPort || parseInt(selectEl.value, 10) || null;
    const options = allPrinters.map(printer => {
        const name = getPrinterDisplayName(printer);
        return `<option value="${printer.port}">${name} (${printer.port})</option>`;
    }).join('');
    selectEl.innerHTML = options || `<option value="">${t('noPrintersFound')}</option>`;

    const validPorts = allPrinters.map(p => p.port);
    const nextPort = (previousValue && validPorts.includes(previousValue)) ? previousValue : (validPorts[0] || null);
    if (nextPort) selectEl.value = nextPort;
    return nextPort;
}

let consolePollInterval = null;
let consoleSelectedPort = null;

function renderConsoleLog(messages) {
    const logEl = document.getElementById('console-log');
    if (!logEl) return;
    if (!messages || !messages.length) {
        logEl.innerHTML = `<div class="empty-state-small">${t('noSystemStats')}</div>`;
        return;
    }
    const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
    logEl.innerHTML = messages.map(msg => {
        const time = msg.time ? new Date(msg.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        const typeClass = msg.type === 'command' ? 'console-line-command' : 'console-line-response';
        return `<div class="console-line ${typeClass}"><span class="console-line-time">${time}</span><span class="console-line-message">${escapeHtml(msg.message || '')}</span></div>`;
    }).join('');
    if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function refreshConsoleLog() {
    if (!consoleSelectedPort) return;
    try {
        const response = await fetch(`/api/console/messages?port=${consoleSelectedPort}&count=100`);
        if (!response.ok) throw new Error('No se pudo cargar la consola');
        const data = await response.json();
        renderConsoleLog(data.messages || []);
    } catch (error) {
        console.error(error);
    }
}

function stopConsolePolling() {
    if (consolePollInterval) {
        clearInterval(consolePollInterval);
        consolePollInterval = null;
    }
}

function startConsolePolling() {
    stopConsolePolling();
    refreshConsoleLog();
    consolePollInterval = setInterval(refreshConsoleLog, 2500);
}

function loadConsoleSection() {
    const selectEl = document.getElementById('console-printer-select');
    consoleSelectedPort = populatePrinterSelect(selectEl, consoleSelectedPort);
    startConsolePolling();
}

const consolePrinterSelect = document.getElementById('console-printer-select');
if (consolePrinterSelect) {
    consolePrinterSelect.addEventListener('change', () => {
        consoleSelectedPort = parseInt(consolePrinterSelect.value, 10) || null;
        startConsolePolling();
    });
}

const consoleClearBtn = document.getElementById('console-clear-btn');
if (consoleClearBtn) {
    consoleClearBtn.addEventListener('click', () => {
        const logEl = document.getElementById('console-log');
        if (logEl) logEl.innerHTML = '';
    });
}

const consoleInputForm = document.getElementById('console-input-form');
if (consoleInputForm) {
    consoleInputForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('console-input');
        const command = input?.value.trim();
        if (!command || !consoleSelectedPort) return;
        input.value = '';
        try {
            const formData = new FormData();
            formData.append('port', consoleSelectedPort);
            formData.append('command', command);
            const response = await fetch('/api/console/command', { method: 'POST', body: formData });
            if (!response.ok) throw new Error('No se pudo enviar el comando');
            refreshConsoleLog();
        } catch (error) {
            console.error(error);
        }
    });
}

let macrosSelectedPort = null;

function macroLabel(name) {
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderMacrosGrid(macros) {
    const gridEl = document.getElementById('macros-grid');
    if (!gridEl) return;
    if (!macros || !macros.length) {
        gridEl.innerHTML = `<div class="empty-state">${t('noMacros')}</div>`;
        return;
    }
    gridEl.innerHTML = macros.map(macro => `
        <button type="button" class="macro-btn" data-macro="${macro}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            <span>${macroLabel(macro)}</span>
        </button>
    `).join('');

    gridEl.querySelectorAll('.macro-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!macrosSelectedPort) return;
            btn.disabled = true;
            try {
                const formData = new FormData();
                formData.append('port', macrosSelectedPort);
                formData.append('macro', btn.dataset.macro);
                const response = await fetch('/api/macros/run', { method: 'POST', body: formData });
                if (!response.ok) throw new Error('No se pudo ejecutar el macro');
            } catch (error) {
                console.error(error);
                appAlert(error.message || 'No se pudo ejecutar el macro.', '', 'danger');
            } finally {
                btn.disabled = false;
            }
        });
    });
}

async function loadMacrosForSelectedPrinter() {
    const gridEl = document.getElementById('macros-grid');
    if (!macrosSelectedPort) {
        if (gridEl) gridEl.innerHTML = `<div class="empty-state">${t('noPrintersFound')}</div>`;
        return;
    }
    try {
        const response = await fetch(`/api/macros?port=${macrosSelectedPort}`);
        if (!response.ok) throw new Error('No se pudo cargar los macros');
        const data = await response.json();
        renderMacrosGrid(data.macros || []);
    } catch (error) {
        console.error(error);
        if (gridEl) gridEl.innerHTML = `<div class="empty-state">${t('noMacros')}</div>`;
    }
}

function loadMacrosSection() {
    const selectEl = document.getElementById('macros-printer-select');
    macrosSelectedPort = populatePrinterSelect(selectEl, macrosSelectedPort);
    loadMacrosForSelectedPrinter();
}

const macrosPrinterSelect = document.getElementById('macros-printer-select');
if (macrosPrinterSelect) {
    macrosPrinterSelect.addEventListener('change', () => {
        macrosSelectedPort = parseInt(macrosPrinterSelect.value, 10) || null;
        loadMacrosForSelectedPrinter();
    });
}

// ── Generic in-app confirm modal (reemplaza confirm() nativo) ──
const APP_DIALOG_ICONS = {
    danger: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    warning: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    success: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
    info: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showAppDialog(message, title, options = {}) {
    const { type = 'danger', okLabel = null, cancelLabel = null, showCancel = true } = options;
    return new Promise(resolve => {
        const modal = document.getElementById('app-confirm-modal');
        const content = document.getElementById('app-confirm-content');
        const iconEl = document.getElementById('app-confirm-icon');
        const titleEl = document.getElementById('app-confirm-title');
        const messageEl = document.getElementById('app-confirm-message');
        const okBtn = document.getElementById('app-confirm-ok-btn');
        const cancelBtn = document.getElementById('app-confirm-cancel-btn');
        const backdrop = document.getElementById('app-confirm-backdrop');

        if (!modal || !okBtn || !cancelBtn || !backdrop) {
            if (showCancel) {
                resolve(window.confirm(message));
            } else {
                window.alert(message);
                resolve(true);
            }
            return;
        }

        if (content) content.className = `modal-content app-confirm-modal-content app-confirm-type-${type}`;
        if (iconEl) iconEl.innerHTML = APP_DIALOG_ICONS[type] || '';
        if (titleEl) titleEl.textContent = title || '';
        if (messageEl) messageEl.textContent = message;
        const okSpan = okBtn.querySelector('span');
        if (okSpan) okSpan.textContent = okLabel || t('confirmAction');
        const cancelSpan = cancelBtn.querySelector('span');
        if (cancelSpan) cancelSpan.textContent = cancelLabel || t('cancelAction');
        cancelBtn.hidden = !showCancel;
        modal.classList.add('active');

        const cleanup = (result) => {
            modal.classList.remove('active');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            backdrop.removeEventListener('click', onCancel);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        if (showCancel) backdrop.addEventListener('click', onCancel);
    });
}

function appConfirm(message, title = '', type = 'danger') {
    return showAppDialog(message, title, { type, showCancel: true });
}

function appAlert(message, title = '', type = 'success') {
    return showAppDialog(message, title, { type, showCancel: false, okLabel: t('understood') });
}

// ── Toasts (notificaciones flotantes) ──
function showToast(message, tone = 'success') {
    let container = document.getElementById('app-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'app-toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `app-toast app-toast-${tone}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

// ── Detección de controladoras láser por USB ──
let knownUsbPorts = null;
let registeredLaserMap = new Map();

async function refreshRegisteredLasers() {
    try {
        const response = await fetch('/api/laser/registry');
        const data = await response.json();
        registeredLaserMap = new Map((data.lasers || []).map(entry => [entry.host, entry.name]));
    } catch (error) {
        console.error(error);
    }
}

function renderUsbPorts(ports, newDevices) {
    const container = document.getElementById('usb-ports-list');
    if (!container) return;
    if (!ports.length) {
        container.innerHTML = `<div class="empty-state-small">${t('laserUsbPortsEmpty')}</div>`;
        return;
    }
    container.innerHTML = ports.map(port => {
        const host = `usb:${port.device}`;
        const registeredName = registeredLaserMap.get(host);
        const actionHtml = registeredName
            ? `<div class="usb-port-registered">
                    <span class="usb-port-registered-badge">${escapeHtml(registeredName)}</span>
                    <button type="button" class="theme-option-icon-btn usb-port-rename-btn" data-host="${escapeHtml(host)}" data-name="${escapeHtml(registeredName)}" title="${escapeHtml(t('usbPortRename'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </button>
                    <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger usb-port-unlink-btn" data-host="${escapeHtml(host)}" title="${escapeHtml(t('usbPortUnlink'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
               </div>`
            : `<button type="button" class="btn-file-action usb-port-add-btn" data-device="${escapeHtml(port.device)}" data-chip="${escapeHtml(port.chip)}">${escapeHtml(t('usbPortAdd'))}</button>`;
        return `
            <div class="usb-port-item ${newDevices.has(port.device) ? 'usb-port-item-new' : ''}">
                <div class="usb-port-item-info">
                    <strong>${escapeHtml(port.device)}</strong>
                    <span>${escapeHtml(port.chip)}${port.description ? ' · ' + escapeHtml(port.description) : ''}</span>
                </div>
                <span class="usb-port-vidpid">${escapeHtml(port.vid_pid)}</span>
                ${actionHtml}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.usb-port-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openUsbClassifyModal(btn.dataset.device, btn.dataset.chip);
        });
    });

    container.querySelectorAll('.usb-port-rename-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const newName = prompt(t('usbRegisterNamePrompt'), btn.dataset.name);
            if (!newName || !newName.trim()) return;
            try {
                const formData = new FormData();
                formData.append('host', btn.dataset.host);
                formData.append('name', newName.trim());
                formData.append('transport', btn.dataset.host.startsWith('usb:') ? 'usb' : 'network');
                await fetch('/api/laser/registry', { method: 'POST', body: formData });
                refreshUsbPorts();
                if (document.getElementById('laser-host-select')) loadLaserHostSelector();
            } catch (error) {
                console.error(error);
            }
        });
    });

    container.querySelectorAll('.usb-port-unlink-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!(await appConfirm(t('usbUnlinkConfirm'), t('usbPortUnlink')))) return;
            try {
                const formData = new FormData();
                formData.append('host', btn.dataset.host);
                await fetch('/api/laser/registry/remove', { method: 'POST', body: formData });
                refreshUsbPorts();
                if (document.getElementById('laser-host-select')) loadLaserHostSelector();
            } catch (error) {
                console.error(error);
            }
        });
    });
}

async function refreshUsbPorts() {
    try {
        await refreshRegisteredLasers();
        const response = await fetch('/api/laser/usb-ports');
        const data = await response.json();
        const ports = data.ports || [];
        const currentDevices = new Set(ports.map(p => p.device));
        const newDevices = new Set();

        if (knownUsbPorts !== null) {
            currentDevices.forEach(device => {
                if (!knownUsbPorts.has(device)) {
                    newDevices.add(device);
                    const port = ports.find(p => p.device === device);
                    showToast(`${t('laserUsbPortDetected')}: ${port.chip} (${device})`);
                }
            });
        }

        knownUsbPorts = currentDevices;
        renderUsbPorts(ports, newDevices);
    } catch (error) {
        console.error(error);
    }
}

let usbClassifyTarget = null;

function openUsbClassifyModal(device, chip) {
    usbClassifyTarget = { device, chip };
    const label = document.getElementById('usb-classify-device-label');
    if (label) label.textContent = `${chip} · ${device}`;
    const modal = document.getElementById('usb-classify-modal');
    if (modal) modal.classList.add('active');
}

function closeUsbClassifyModal() {
    const modal = document.getElementById('usb-classify-modal');
    if (modal) modal.classList.remove('active');
}

async function handleUsbClassifyLaser() {
    const target = usbClassifyTarget;
    closeUsbClassifyModal();
    if (!target) return;

    showToast(t('usbTestingGrbl'));
    try {
        const formData = new FormData();
        formData.append('device', target.device);
        const response = await fetch('/api/laser/usb-ports/test', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('usbTestFailed'));
        }

        const confirmed = await appConfirm(
            `${t('usbRegisterConfirm')} (${target.chip}, ${target.device})`,
            t('usbClassifyLaser'),
            'info'
        );
        if (!confirmed) return;

        const defaultName = target.chip === 'CH340' || target.chip === 'CH340K' ? 'Sculpfun' : target.chip;
        const name = prompt(t('usbRegisterNamePrompt'), defaultName);
        if (!name || !name.trim()) return;

        const registerData = new FormData();
        registerData.append('host', `usb:${target.device}`);
        registerData.append('name', name.trim());
        registerData.append('transport', 'usb');
        await fetch('/api/laser/registry', { method: 'POST', body: registerData });

        showToast(`${name.trim()}: ${t('usbRegisterSuccess')}`);
        refreshUsbPorts();
        if (document.getElementById('laser-host-select')) loadLaserHostSelector();
    } catch (error) {
        console.error(error);
        showToast(error.message || t('usbTestFailed'), 'error');
    }
}

function handleUsbClassifyPrinter() {
    closeUsbClassifyModal();
    showToast(t('usbPrinterNotSupported'), 'error');
}

const usbClassifyLaserBtn = document.getElementById('usb-classify-laser-btn');
if (usbClassifyLaserBtn) usbClassifyLaserBtn.addEventListener('click', handleUsbClassifyLaser);

const usbClassifyPrinterBtn = document.getElementById('usb-classify-printer-btn');
if (usbClassifyPrinterBtn) usbClassifyPrinterBtn.addEventListener('click', handleUsbClassifyPrinter);

const usbClassifyCancelBtn = document.getElementById('usb-classify-cancel-btn');
if (usbClassifyCancelBtn) usbClassifyCancelBtn.addEventListener('click', closeUsbClassifyModal);

const usbClassifyBackdrop = document.getElementById('usb-classify-backdrop');
if (usbClassifyBackdrop) usbClassifyBackdrop.addEventListener('click', closeUsbClassifyModal);

// ── Laser (GRBL) ──
let laserPollInterval = null;

function renderLaserStatus(data) {
    const dot = document.getElementById('laser-status-dot');
    const text = document.getElementById('laser-status-text');
    const pill = document.getElementById('laser-state-pill');
    const position = document.getElementById('laser-position');
    const feedSpeed = document.getElementById('laser-feed-speed');
    const illustrationWrap = document.getElementById('laser-illustration-wrap');
    const illustration = document.getElementById('laser-illustration');
    if (!dot || !text) return;

    const visualState = getLaserVisualState(data);
    if (illustration) illustration.src = LASER_STATE_IMAGES[visualState];
    if (illustrationWrap) illustrationWrap.classList.toggle('offline', visualState === 'offline');

    if (!data || !data.connected) {
        dot.classList.remove('online');
        text.textContent = t('laserOffline');
        if (pill) pill.textContent = '';
        if (position) position.textContent = '—';
        if (feedSpeed) feedSpeed.textContent = '—';
        return;
    }

    dot.classList.add('online');
    text.textContent = t('laserOnline');
    if (pill) {
        pill.textContent = data.state || '';
        pill.className = `laser-state-pill state-${(data.state || '').toLowerCase()}`;
    }
    if (position) position.textContent = `X${data.x.toFixed(2)} Y${data.y.toFixed(2)} Z${data.z.toFixed(2)}`;
    if (feedSpeed) feedSpeed.textContent = `${data.feed} / ${data.speed}`;
}

async function refreshLaserStatus() {
    try {
        const response = await fetch('/api/laser/status');
        const data = await response.json();
        renderLaserStatus(data);
    } catch (error) {
        console.error(error);
        renderLaserStatus(null);
    }
}

function renderLaserJob(job) {
    const pauseBtn = document.getElementById('laser-pause-btn');
    const resumeBtn = document.getElementById('laser-resume-btn');
    const cancelBtn = document.getElementById('laser-cancel-btn');
    const progressWrap = document.getElementById('laser-job-progress');
    const progressFill = document.getElementById('laser-job-progress-fill');
    const progressText = document.getElementById('laser-job-progress-text');
    const errorEl = document.getElementById('laser-job-error');
    if (!pauseBtn) return;

    const state = job?.state || 'idle';
    const isActive = state === 'running' || state === 'paused';

    pauseBtn.hidden = state !== 'running';
    resumeBtn.hidden = state !== 'paused';
    cancelBtn.hidden = !isActive;

    if (progressWrap) progressWrap.hidden = !isActive && state !== 'completed' && state !== 'error' && state !== 'cancelled';
    if (progressFill) {
        const percent = job?.total ? Math.round((job.current / job.total) * 100) : 0;
        progressFill.style.width = `${percent}%`;
    }
    if (progressText) progressText.textContent = `${job?.current || 0} / ${job?.total || 0}`;
    if (errorEl) errorEl.textContent = job?.error || '';

    document.querySelectorAll('.laser-jog-btn, .laser-step-btn, #laser-unlock-btn, #laser-goto-btn, #laser-fire-btn, #laser-fire-power-input, #laser-air-btn').forEach(el => {
        el.disabled = isActive;
    });
}

async function refreshLaserJob() {
    try {
        const response = await fetch('/api/laser/job/status');
        const data = await response.json();
        renderLaserJob(data);
    } catch (error) {
        console.error(error);
    }
}

function stopLaserPolling() {
    if (laserPollInterval) {
        clearInterval(laserPollInterval);
        laserPollInterval = null;
    }
}

function startLaserPolling() {
    stopLaserPolling();
    refreshLaserStatus();
    refreshLaserJob();
    refreshLaserConsole();
    refreshLaserQueue();
    laserPollInterval = setInterval(() => {
        refreshLaserStatus();
        refreshLaserJob();
        refreshLaserConsole();
        refreshLaserQueue();
    }, 2500);
}

function renderLaserQueue(queue) {
    const container = document.getElementById('laser-queue-list');
    if (!container) return;
    if (!queue || !queue.length) {
        container.innerHTML = `<div class="empty-state-small">${t('laserQueueEmpty')}</div>`;
        return;
    }
    container.innerHTML = queue.map(item => `
        <div class="laser-queue-item" data-id="${item.id}" data-path="${escapeHtml(item.path)}">
            <span class="laser-queue-item-name">${escapeHtml(item.filename)}</span>
            <div class="laser-queue-item-actions">
                <button type="button" class="theme-option-icon-btn" data-action="play" title="${t('laserQueuePlay')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger" data-action="remove" title="${t('laserQueueRemove')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.laser-queue-item').forEach(row => {
        const id = parseInt(row.dataset.id, 10);
        const itemPath = row.dataset.path;
        row.querySelectorAll('button[data-action]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.dataset.action === 'play') {
                    let gcodeText = '';
                    try {
                        const fileUrl = `/uploads/gcode/${itemPath.split('/').map(encodeURIComponent).join('/')}`;
                        const fileResponse = await fetch(fileUrl);
                        if (fileResponse.ok) gcodeText = await fileResponse.text();
                    } catch (error) {
                        console.error(error);
                    }
                    const { confirmed } = await confirmLaserJobStart(gcodeText);
                    if (!confirmed) return;
                    try {
                        const formData = new FormData();
                        formData.append('id', id);
                        const response = await fetch('/api/laser/queue/start', { method: 'POST', body: formData });
                        if (!response.ok) {
                            const data = await response.json().catch(() => ({}));
                            throw new Error(data.detail || 'No se pudo iniciar el trabajo.');
                        }
                        refreshLaserJob();
                        refreshLaserQueue();
                    } catch (error) {
                        console.error(error);
                        appAlert(error.message || 'No se pudo iniciar el trabajo.', '', 'danger');
                    }
                } else if (btn.dataset.action === 'remove') {
                    try {
                        const formData = new FormData();
                        formData.append('id', id);
                        await fetch('/api/laser/queue/remove', { method: 'POST', body: formData });
                        refreshLaserQueue();
                    } catch (error) {
                        console.error(error);
                    }
                }
            });
        });
    });
}

async function refreshLaserQueue() {
    try {
        const response = await fetch('/api/laser/queue');
        const data = await response.json();
        renderLaserQueue(data.queue || []);
    } catch (error) {
        console.error(error);
    }
}

function renderLaserBoardInfo(info) {
    const container = document.getElementById('laser-info-grid');
    if (!container) return;
    const entries = Object.entries(info || {});
    if (!entries.length) {
        container.innerHTML = `<div class="empty-state-small">${t('laserOffline')}</div>`;
        return;
    }
    container.innerHTML = entries.map(([key, value]) => `
        <div class="laser-info-compact-row">
            <span>${escapeHtml(key)}</span>
            <strong>${escapeHtml(String(value))}</strong>
        </div>
    `).join('');
}

async function loadLaserBoardInfo() {
    try {
        const response = await fetch('/api/laser/info');
        if (!response.ok) throw new Error('No se pudo cargar la información de la placa');
        const info = await response.json();
        renderLaserBoardInfo(info);
    } catch (error) {
        console.error(error);
        renderLaserBoardInfo(null);
    }
}

let laserHostOptions = [];

function laserConnectionModeLabel(host) {
    if (!host) return '';
    if (host.startsWith('usb:')) return t('laserConnectionModeUsb');
    return `${t('laserConnectionModeNetwork')} · ${host}`;
}

function renderLaserHostOptions(activeHost) {
    const selectEl = document.getElementById('laser-host-select');
    if (!selectEl) return;
    if (!laserHostOptions.some(device => device.host === activeHost)) {
        laserHostOptions = [{ host: activeHost, hostname: '' }, ...laserHostOptions];
    }
    selectEl.innerHTML = laserHostOptions.map(device => {
        const label = device.hostname ? `${device.hostname} (${device.host})` : device.host;
        return `<option value="${escapeHtml(device.host)}">${escapeHtml(label)}</option>`;
    }).join('');
    selectEl.value = activeHost;
    const modeEl = document.getElementById('laser-connection-mode');
    if (modeEl) modeEl.textContent = laserConnectionModeLabel(activeHost);
}

async function loadLaserHostSelector() {
    try {
        const [hostResponse, registryResponse] = await Promise.all([
            fetch('/api/laser/host'),
            fetch('/api/laser/registry'),
        ]);
        const hostData = await hostResponse.json();
        const registryData = await registryResponse.json();

        (registryData.lasers || []).forEach(entry => {
            if (!laserHostOptions.some(device => device.host === entry.host)) {
                laserHostOptions.push({ host: entry.host, hostname: entry.name });
            }
        });

        renderLaserHostOptions(hostData.host);
    } catch (error) {
        console.error(error);
    }
}

async function scanLaserNetwork() {
    const scanBtn = document.getElementById('laser-scan-btn');
    if (scanBtn) scanBtn.disabled = true;
    try {
        const response = await fetch('/api/laser/scan');
        const data = await response.json();
        laserHostOptions = data.devices || [];
        const hostResponse = await fetch('/api/laser/host');
        const hostData = await hostResponse.json();
        renderLaserHostOptions(hostData.host);
    } catch (error) {
        console.error(error);
    } finally {
        if (scanBtn) scanBtn.disabled = false;
    }
}

const laserHostSelect = document.getElementById('laser-host-select');
if (laserHostSelect) {
    laserHostSelect.addEventListener('change', async () => {
        try {
            const formData = new FormData();
            formData.append('host', laserHostSelect.value);
            await fetch('/api/laser/host', { method: 'POST', body: formData });
            const modeEl = document.getElementById('laser-connection-mode');
            if (modeEl) modeEl.textContent = laserConnectionModeLabel(laserHostSelect.value);
            loadLaserBoardInfo();
            refreshLaserStatus();
            refreshLaserQueue();
            checkSdAvailability();
        } catch (error) {
            console.error(error);
        }
    });
}

const laserScanBtn = document.getElementById('laser-scan-btn');
if (laserScanBtn) {
    laserScanBtn.addEventListener('click', scanLaserNetwork);
}

function renderLaserConsoleLog(messages) {
    const logEl = document.getElementById('laser-console-log');
    if (!logEl) return;
    if (!messages || !messages.length) {
        logEl.innerHTML = '';
        return;
    }
    const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
    logEl.innerHTML = messages.map(msg => {
        const time = msg.time ? new Date(msg.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        return `<div class="console-line"><span class="console-line-time">${time}</span><span class="console-line-message">${escapeHtml(msg.message || '')}</span></div>`;
    }).join('');
    if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function refreshLaserConsole() {
    try {
        const response = await fetch('/api/laser/console?count=150');
        const data = await response.json();
        renderLaserConsoleLog(data.messages || []);
    } catch (error) {
        console.error(error);
    }
}

const laserConsoleForm = document.getElementById('laser-console-form');
if (laserConsoleForm) {
    laserConsoleForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('laser-console-input');
        const command = input?.value.trim();
        if (!command) return;
        input.value = '';
        await sendLaserRawCommand(command);
        refreshLaserConsole();
    });
}

const GRBL_SETTING_DESCRIPTIONS = {
    '$0': 'Duración del pulso de paso (microsegundos).',
    '$1': 'Retardo de reposo de los motores tras detenerse (ms).',
    '$2': 'Máscara de inversión del pulso de paso por eje.',
    '$3': 'Máscara de inversión de dirección por eje.',
    '$4': 'Invierte la señal de habilitación de motores.',
    '$5': 'Invierte los pines de los interruptores límite.',
    '$6': 'Invierte el pin de la sonda (probe).',
    '$10': 'Qué datos incluye el reporte de estado (?).',
    '$11': 'Desviación de unión entre movimientos, mm (junction deviation).',
    '$12': 'Tolerancia de arcos, mm.',
    '$13': 'Reporta posiciones en pulgadas en vez de mm.',
    '$20': 'Activa límites por software.',
    '$21': 'Activa límites por hardware (interruptores físicos).',
    '$22': 'Activa el ciclo de home ($H).',
    '$23': 'Máscara de dirección invertida al hacer home.',
    '$24': 'Velocidad de acercamiento final al hacer home, mm/min.',
    '$25': 'Velocidad de búsqueda al hacer home, mm/min.',
    '$26': 'Retardo anti-rebote de los interruptores de home, ms.',
    '$27': 'Distancia de separación tras tocar el interruptor de home, mm.',
    '$30': 'Velocidad máxima del spindle/láser (RPM o intensidad).',
    '$31': 'Velocidad mínima del spindle/láser.',
    '$32': 'Activa el modo láser (velocidad continua en curvas).',
    '$100': 'Pasos por milímetro, eje X.',
    '$101': 'Pasos por milímetro, eje Y.',
    '$102': 'Pasos por milímetro, eje Z.',
    '$110': 'Velocidad máxima, eje X (mm/min).',
    '$111': 'Velocidad máxima, eje Y (mm/min).',
    '$112': 'Velocidad máxima, eje Z (mm/min).',
    '$120': 'Aceleración, eje X (mm/s²).',
    '$121': 'Aceleración, eje Y (mm/s²).',
    '$122': 'Aceleración, eje Z (mm/s²).',
    '$130': 'Recorrido máximo, eje X (mm).',
    '$131': 'Recorrido máximo, eje Y (mm).',
    '$132': 'Recorrido máximo, eje Z (mm).',
};

function grblSettingDescription(key) {
    return GRBL_SETTING_DESCRIPTIONS[key] || t('laserSettingsUnknownParam');
}

function renderLaserSettings(settings) {
    const container = document.getElementById('laser-settings-grid');
    if (!container) return;
    if (!settings || !settings.length) {
        container.innerHTML = `<div class="empty-state-small">${t('laserOffline')}</div>`;
        return;
    }
    container.innerHTML = settings.map(setting => `
        <div class="laser-settings-item" data-key="${setting.key}">
            <div class="laser-settings-item-row">
                <span class="laser-settings-item-label">${setting.key}</span>
                <input type="text" value="${escapeHtml(setting.value)}" data-key="${setting.key}">
            </div>
            <p class="laser-settings-item-hint">${escapeHtml(grblSettingDescription(setting.key))}</p>
        </div>
    `).join('');

    container.querySelectorAll('.laser-settings-item input').forEach(input => {
        input.addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            input.blur();
            const key = input.dataset.key;
            const value = input.value.trim();
            const item = input.closest('.laser-settings-item');
            try {
                const formData = new FormData();
                formData.append('key', key);
                formData.append('value', value);
                const response = await fetch('/api/laser/settings', { method: 'POST', body: formData });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.detail || 'No se pudo guardar el parámetro.');
                }
                if (item) {
                    item.classList.add('saved');
                    setTimeout(() => item.classList.remove('saved'), 1500);
                }
            } catch (error) {
                console.error(error);
                appAlert(error.message || 'No se pudo guardar el parámetro.', '', 'danger');
            }
        });
    });
}

async function loadLaserSettings() {
    try {
        const response = await fetch('/api/laser/settings');
        if (!response.ok) throw new Error('No se pudo cargar la configuración');
        const data = await response.json();
        renderLaserSettings(data.settings || []);
    } catch (error) {
        console.error(error);
        renderLaserSettings([]);
    }
}

const laserSettingsReloadBtn = document.getElementById('laser-settings-reload-btn');
if (laserSettingsReloadBtn) laserSettingsReloadBtn.addEventListener('click', loadLaserSettings);

async function loadLaserNameField() {
    const input = document.getElementById('laser-name-input');
    if (!input) return;
    try {
        const [hostResponse, registryResponse] = await Promise.all([
            fetch('/api/laser/host'),
            fetch('/api/laser/registry'),
        ]);
        const hostData = await hostResponse.json();
        const registryData = await registryResponse.json();
        const entry = (registryData.lasers || []).find(item => item.host === hostData.host);
        input.value = entry ? entry.name : '';
    } catch (error) {
        console.error(error);
    }
}

const laserNameSaveBtn = document.getElementById('laser-name-save-btn');
if (laserNameSaveBtn) {
    laserNameSaveBtn.addEventListener('click', async () => {
        const input = document.getElementById('laser-name-input');
        const name = input?.value.trim();
        if (!name) return;
        try {
            const hostResponse = await fetch('/api/laser/host');
            const hostData = await hostResponse.json();
            const formData = new FormData();
            formData.append('host', hostData.host);
            formData.append('name', name);
            formData.append('transport', hostData.host.startsWith('usb:') ? 'usb' : 'network');
            await fetch('/api/laser/registry', { method: 'POST', body: formData });
            showToast(t('laserNameSaved'));
            loadLaserHostSelector();
        } catch (error) {
            console.error(error);
        }
    });
}

function openLaserSettingsModal() {
    const modal = document.getElementById('laser-settings-modal');
    if (!modal) return;
    modal.classList.add('active');
    loadLaserNameField();
    loadLaserSettings();
}

function closeLaserSettingsModal() {
    const modal = document.getElementById('laser-settings-modal');
    if (modal) modal.classList.remove('active');
}

const laserIllustrationWrap = document.getElementById('laser-illustration-wrap');
if (laserIllustrationWrap) {
    laserIllustrationWrap.addEventListener('click', openLaserSettingsModal);
}

const laserSettingsModalClose = document.getElementById('laser-settings-modal-close');
if (laserSettingsModalClose) laserSettingsModalClose.addEventListener('click', closeLaserSettingsModal);

const laserSettingsModalBackdrop = document.getElementById('laser-settings-modal-backdrop');
if (laserSettingsModalBackdrop) laserSettingsModalBackdrop.addEventListener('click', closeLaserSettingsModal);

// ── Tarjeta SD (placas de red / ESP3D) ──
let sdCurrentPath = '/';
let sdCurrentEntries = { files: [] };

function sdPathSegments(path) {
    return path.split('/').filter(Boolean);
}

function renderSdBreadcrumb(path) {
    const el = document.getElementById('laser-sd-breadcrumb');
    if (!el) return;
    const segments = sdPathSegments(path);
    let acc = '';
    const crumbs = [`<button type="button" class="breadcrumb-segment" data-path="/">${t('root')}</button>`];
    segments.forEach(segment => {
        acc += `${segment}/`;
        crumbs.push(`<span class="breadcrumb-sep">/</span><button type="button" class="breadcrumb-segment" data-path="${escapeHtml(acc)}">${escapeHtml(segment)}</button>`);
    });
    el.innerHTML = crumbs.join('');
    el.querySelectorAll('.breadcrumb-segment').forEach(btn => {
        btn.addEventListener('click', () => loadSdFolder(btn.dataset.path));
    });
}

function sdFolderIcon() {
    return '<svg class="laser-sd-row-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
}

function sdFileIcon() {
    return '<svg class="laser-sd-row-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

function sdMoreIcon() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
}

function closeAllSdRowMenus() {
    document.querySelectorAll('.laser-sd-row-menu').forEach(menu => { menu.hidden = true; });
}

document.addEventListener('click', closeAllSdRowMenus);

function renderSdList(data) {
    const listEl = document.getElementById('laser-sd-list');
    const spaceEl = document.getElementById('laser-sd-space');
    if (!listEl) return;

    if (spaceEl) {
        spaceEl.textContent = data.total ? `${data.used || '—'} / ${data.total}` : '';
    }

    const entries = data.files || [];
    if (!entries.length) {
        listEl.innerHTML = `<div class="empty-state-small">${t('laserSdEmpty')}</div>`;
        return;
    }

    listEl.innerHTML = entries.map(entry => {
        const isDir = entry.size === '-1' || entry.size === -1;
        const deleteBtnHtml = `
            <button type="button" class="laser-sd-row-menu-item laser-sd-row-menu-item-danger laser-sd-delete-btn">${escapeHtml(t('delete'))}</button>
        `;
        return `
            <div class="laser-sd-row" data-name="${escapeHtml(entry.name)}" data-dir="${isDir ? '1' : '0'}">
                ${isDir ? sdFolderIcon() : sdFileIcon()}
                <span class="laser-sd-row-name">${escapeHtml(entry.name)}</span>
                ${!isDir ? `<span class="laser-sd-row-size">${escapeHtml(entry.size)}</span>` : ''}
                ${isDir ? `
                    <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger laser-sd-delete-btn" title="${escapeHtml(t('delete'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                ` : `
                    <div class="laser-sd-row-menu-wrap">
                        <button type="button" class="theme-option-icon-btn laser-sd-more-btn" title="${escapeHtml(t('laserSdMenuMore'))}">
                            ${sdMoreIcon()}
                        </button>
                        <div class="laser-sd-row-menu" hidden>
                            <button type="button" class="laser-sd-row-menu-item laser-sd-print-btn">${escapeHtml(t('laserSdPrint'))}</button>
                            ${deleteBtnHtml}
                        </div>
                    </div>
                `}
            </div>
        `;
    }).join('');

    listEl.querySelectorAll('.laser-sd-row').forEach(row => {
        const isDir = row.dataset.dir === '1';
        const name = row.dataset.name;
        if (isDir) {
            row.querySelector('.laser-sd-row-name').addEventListener('click', () => {
                loadSdFolder(`${sdCurrentPath}${name}/`);
            });
        } else {
            const moreBtn = row.querySelector('.laser-sd-more-btn');
            const menu = row.querySelector('.laser-sd-row-menu');
            if (moreBtn && menu) {
                moreBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const wasHidden = menu.hidden;
                    closeAllSdRowMenus();
                    menu.hidden = !wasHidden;
                });
            }
            const printBtn = row.querySelector('.laser-sd-print-btn');
            if (printBtn) {
                printBtn.addEventListener('click', () => {
                    if (menu) menu.hidden = true;
                    startSdFilePrint(name);
                });
            }
        }
        row.querySelector('.laser-sd-delete-btn').addEventListener('click', async (event) => {
            event.stopPropagation();
            closeAllSdRowMenus();
            if (!(await appConfirm(t('laserSdDeleteConfirm'), t('delete')))) return;
            try {
                const formData = new FormData();
                formData.append('path', sdCurrentPath);
                formData.append('name', name);
                formData.append('is_dir', isDir ? 'true' : 'false');
                const response = await fetch('/api/laser/sd/delete', { method: 'POST', body: formData });
                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.detail || t('laserSdError'));
                }
                loadSdFolder(sdCurrentPath);
            } catch (error) {
                console.error(error);
                appAlert(error.message || t('laserSdError'), '', 'danger');
            }
        });
    });
}

async function waitForLaserJobCompletion(host) {
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
            const response = await fetch(`/api/laser/job/status?host=${encodeURIComponent(host)}`);
            const data = await response.json();
            if (['completed', 'error', 'cancelled', 'idle'].includes(data.state)) return data.state;
        } catch (error) {
            console.error(error);
            return 'error';
        }
    }
}

async function startSdFilePrint(name) {
    let gcodeText = '';
    try {
        const modelsResponse = await fetch('/api/models');
        const models = await modelsResponse.json();
        const match = models.find(m => m.id.startsWith('gcode/') && m.id.split('/').pop() === name);
        if (match) {
            const relPath = stripSectionPrefix(match.id, 'gcode');
            const fileUrl = `/uploads/gcode/${relPath.split('/').map(encodeURIComponent).join('/')}`;
            const fileResponse = await fetch(fileUrl);
            if (fileResponse.ok) gcodeText = await fileResponse.text();
        }
    } catch (error) {
        console.error(error);
    }

    const { confirmed, copies } = await confirmLaserJobStart(gcodeText, {
        allowFrame: !!gcodeText,
        message: gcodeText ? undefined : `${t('laserStartConfirm')} ${t('laserSdFrameUnavailable')}`,
    });
    if (!confirmed) return;

    try {
        const hostResponse = await fetch('/api/laser/host');
        const hostData = await hostResponse.json();
        const activeHost = hostData.host;

        for (let i = 0; i < copies; i++) {
            const formData = new FormData();
            formData.append('path', sdCurrentPath);
            formData.append('name', name);
            const response = await fetch('/api/laser/sd/run', { method: 'POST', body: formData });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || t('laserSdError'));
            }
            refreshLaserJob();
            if (i < copies - 1) {
                const finalState = await waitForLaserJobCompletion(activeHost);
                if (finalState !== 'completed') break;
            }
        }
    } catch (error) {
        console.error(error);
        appAlert(error.message || t('laserSdError'), '', 'danger');
    }
}

async function loadSdFolder(path) {
    sdCurrentPath = path;
    renderSdBreadcrumb(path);
    const listEl = document.getElementById('laser-sd-list');
    if (listEl) listEl.innerHTML = `<div class="empty-state-small">${t('laserSdLoading')}</div>`;
    try {
        const response = await fetch(`/api/laser/sd/files?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        if (data.status && data.status !== 'Ok') {
            listEl.innerHTML = `<div class="empty-state-small">${escapeHtml(data.message || t('laserSdError'))}</div>`;
            return;
        }
        sdCurrentEntries = data;
        renderSdList(data);
    } catch (error) {
        console.error(error);
        if (listEl) listEl.innerHTML = `<div class="empty-state-small">${t('laserSdError')}</div>`;
    }
}

async function loadSdLibraryOptions() {
    const selectEl = document.getElementById('laser-sd-library-select');
    if (!selectEl) return;
    try {
        const response = await fetch('/api/models');
        const models = await response.json();
        const gcodeFiles = models.filter(m => m.id.startsWith('gcode/'));
        if (!gcodeFiles.length) {
            selectEl.innerHTML = `<option value="">${t('noFilesFound')}</option>`;
            return;
        }
        selectEl.innerHTML = `<option value="">${t('laserSdSelectFile')}</option>` + gcodeFiles.map(file => {
            const relPath = stripSectionPrefix(file.id, 'gcode');
            return `<option value="${escapeHtml(relPath)}">${escapeHtml(file.name)}</option>`;
        }).join('');
    } catch (error) {
        console.error(error);
    }
}

async function checkSdAvailability() {
    const queueCard = document.getElementById('laser-queue-card');
    const sdCard = document.getElementById('laser-sd-card');
    if (!queueCard || !sdCard) return;
    try {
        const response = await fetch('/api/laser/sd/available');
        const data = await response.json();
        if (data.available) {
            queueCard.hidden = true;
            sdCard.hidden = false;
            loadSdLibraryOptions();
            loadSdFolder('/');
        } else {
            queueCard.hidden = false;
            sdCard.hidden = true;
        }
    } catch (error) {
        console.error(error);
        queueCard.hidden = false;
        sdCard.hidden = true;
    }
}

const laserSdReloadBtn = document.getElementById('laser-sd-reload-btn');
if (laserSdReloadBtn) laserSdReloadBtn.addEventListener('click', () => loadSdFolder(sdCurrentPath));

const laserSdNewFolderBtn = document.getElementById('laser-sd-newfolder-btn');
if (laserSdNewFolderBtn) {
    laserSdNewFolderBtn.addEventListener('click', async () => {
        const name = prompt(t('laserSdNewFolderPrompt'));
        if (!name || !name.trim()) return;
        try {
            const formData = new FormData();
            formData.append('path', sdCurrentPath);
            formData.append('name', name.trim());
            const response = await fetch('/api/laser/sd/folder', { method: 'POST', body: formData });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || t('laserSdError'));
            }
            loadSdFolder(sdCurrentPath);
        } catch (error) {
            console.error(error);
            appAlert(error.message || t('laserSdError'), '', 'danger');
        }
    });
}

const laserSdUploadInput = document.getElementById('laser-sd-upload-input');
if (laserSdUploadInput) {
    laserSdUploadInput.addEventListener('change', async () => {
        const file = laserSdUploadInput.files?.[0];
        laserSdUploadInput.value = '';
        if (!file) return;
        try {
            const formData = new FormData();
            formData.append('path', sdCurrentPath);
            formData.append('file', file);
            const response = await fetch('/api/laser/sd/upload', { method: 'POST', body: formData });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || t('laserSdError'));
            }
            showToast(t('laserSdUploadSuccess'));
            loadSdFolder(sdCurrentPath);
        } catch (error) {
            console.error(error);
            appAlert(error.message || t('laserSdError'), '', 'danger');
        }
    });
}

const laserSdSendLibraryBtn = document.getElementById('laser-sd-send-library-btn');
if (laserSdSendLibraryBtn) {
    laserSdSendLibraryBtn.addEventListener('click', async () => {
        const selectEl = document.getElementById('laser-sd-library-select');
        const gcodePath = selectEl?.value;
        if (!gcodePath) return;
        try {
            const formData = new FormData();
            formData.append('gcode_path', gcodePath);
            formData.append('sd_path', sdCurrentPath);
            const response = await fetch('/api/laser/sd/upload-from-library', { method: 'POST', body: formData });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || t('laserSdError'));
            }
            showToast(t('laserSdSendSuccess'));
            loadSdFolder(sdCurrentPath);
        } catch (error) {
            console.error(error);
            appAlert(error.message || t('laserSdError'), '', 'danger');
        }
    });
}

function loadLaserSection() {
    loadLaserHostSelector();
    loadLaserBoardInfo();
    startLaserPolling();
    checkSdAvailability();
}

const laserPauseBtn = document.getElementById('laser-pause-btn');
if (laserPauseBtn) {
    laserPauseBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/laser/job/pause', { method: 'POST' });
            refreshLaserJob();
        } catch (error) {
            console.error(error);
        }
    });
}

const laserResumeBtn = document.getElementById('laser-resume-btn');
if (laserResumeBtn) {
    laserResumeBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/laser/job/resume', { method: 'POST' });
            refreshLaserJob();
        } catch (error) {
            console.error(error);
        }
    });
}

const laserCancelBtn = document.getElementById('laser-cancel-btn');
if (laserCancelBtn) {
    laserCancelBtn.addEventListener('click', async () => {
        if (!(await appConfirm(t('laserCancelConfirm'), t('laserCancel')))) return;
        try {
            await fetch('/api/laser/job/cancel', { method: 'POST' });
            refreshLaserJob();
        } catch (error) {
            console.error(error);
        }
    });
}

async function sendLaserRawCommand(command) {
    try {
        const formData = new FormData();
        formData.append('command', command);
        const response = await fetch('/api/laser/command', { method: 'POST', body: formData });
        if (!response.ok) throw new Error('No se pudo enviar el comando');
        return true;
    } catch (error) {
        console.error(error);
        return false;
    }
}

function parseGcodeBoundingBox(text) {
    const lines = text.split(/\r?\n/);
    let x = 0, y = 0;
    let absolute = true;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const parseValue = token => parseFloat(token.slice(1));

    for (const raw of lines) {
        const line = raw.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        const code = parts[0].toUpperCase();

        if (code === 'G90') { absolute = true; continue; }
        if (code === 'G91') { absolute = false; continue; }
        if (code === 'G92') {
            for (let i = 1; i < parts.length; i++) {
                const token = parts[i].toUpperCase();
                if (token.startsWith('X')) x = parseValue(token);
                if (token.startsWith('Y')) y = parseValue(token);
            }
            continue;
        }
        if (!['G0', 'G1', 'G00', 'G01'].includes(code)) continue;

        let nx = x, ny = y;
        for (let i = 1; i < parts.length; i++) {
            const token = parts[i].toUpperCase();
            if (token.length < 2) continue;
            const letter = token[0];
            const value = parseValue(token);
            if (Number.isNaN(value)) continue;
            if (letter === 'X') nx = absolute ? value : x + value;
            if (letter === 'Y') ny = absolute ? value : y + value;
        }
        x = nx; y = ny;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }

    if (!isFinite(minX)) return null;
    return { minX, maxX, minY, maxY };
}

async function frameLaserJob(gcodeText) {
    const bbox = parseGcodeBoundingBox(gcodeText || '');
    if (!bbox) {
        appAlert(t('laserFrameError'), '', 'danger');
        return;
    }
    const feed = 3000;
    const corners = [
        [bbox.minX, bbox.minY],
        [bbox.maxX, bbox.minY],
        [bbox.maxX, bbox.maxY],
        [bbox.minX, bbox.maxY],
        [bbox.minX, bbox.minY],
    ];
    await sendLaserRawCommand('G90 G21');
    for (const [cx, cy] of corners) {
        await sendLaserRawCommand(`G0 X${cx.toFixed(3)} Y${cy.toFixed(3)} F${feed}`);
        await new Promise(resolve => setTimeout(resolve, 350));
    }
}

function confirmLaserJobStart(gcodeText, options = {}) {
    const allowFrame = options.allowFrame !== false && !!gcodeText;
    return new Promise(resolve => {
        const modal = document.getElementById('laser-start-confirm-modal');
        const messageEl = document.getElementById('laser-start-confirm-message');
        const cancelBtn = document.getElementById('laser-start-confirm-cancel-btn');
        const frameBtn = document.getElementById('laser-start-confirm-frame-btn');
        const startBtn = document.getElementById('laser-start-confirm-start-btn');
        const copiesInput = document.getElementById('laser-start-confirm-copies-input');

        if (!modal || !cancelBtn || !frameBtn || !startBtn) {
            resolve({ confirmed: window.confirm(t('laserStartConfirm')), copies: 1 });
            return;
        }

        if (messageEl) messageEl.textContent = options.message || t('laserStartConfirm');
        frameBtn.hidden = !allowFrame;
        if (copiesInput) copiesInput.value = '1';
        modal.classList.add('active');

        const cleanup = (result) => {
            modal.classList.remove('active');
            cancelBtn.removeEventListener('click', onCancel);
            startBtn.removeEventListener('click', onStart);
            frameBtn.removeEventListener('click', onFrame);
            const copies = Math.max(1, parseInt(copiesInput?.value, 10) || 1);
            resolve({ confirmed: result, copies });
        };
        const onCancel = () => cleanup(false);
        const onStart = () => cleanup(true);
        const onFrame = async () => {
            const label = frameBtn.querySelector('span');
            const originalLabel = label ? label.textContent : '';
            frameBtn.disabled = true;
            if (label) label.textContent = t('laserFramingBusy');
            try {
                await frameLaserJob(gcodeText);
            } catch (error) {
                console.error(error);
            } finally {
                frameBtn.disabled = false;
                if (label) label.textContent = originalLabel;
            }
        };

        cancelBtn.addEventListener('click', onCancel);
        startBtn.addEventListener('click', onStart);
        frameBtn.addEventListener('click', onFrame);
    });
}

let laserJogStep = 10;
const LASER_JOG_FEED = 1500;

document.querySelectorAll('.laser-jog-btn[data-axis]').forEach(btn => {
    btn.addEventListener('click', async () => {
        const axis = btn.dataset.axis;
        const dir = parseInt(btn.dataset.dir, 10);
        const distance = (laserJogStep * dir).toFixed(3);
        await sendLaserRawCommand(`$J=G91 G21 ${axis}${distance} F${LASER_JOG_FEED}`);
        refreshLaserStatus();
    });
});

document.querySelectorAll('.laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        laserJogStep = parseFloat(btn.dataset.step);
        document.querySelectorAll('.laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

function isLaserHomeConfirmEnabled() {
    return localStorage.getItem('laserHomeConfirmEnabled') !== 'false';
}

const laserHomeBtn = document.getElementById('laser-home-btn');
if (laserHomeBtn) {
    laserHomeBtn.addEventListener('click', async () => {
        if (isLaserHomeConfirmEnabled()) {
            if (!(await appConfirm(t('laserHomeConfirm'), t('laserHome'), 'warning'))) return;
        }
        await sendLaserRawCommand('$H');
        refreshLaserStatus();
    });
}

const laserUnlockBtn = document.getElementById('laser-unlock-btn');
if (laserUnlockBtn) {
    laserUnlockBtn.addEventListener('click', async () => {
        await sendLaserRawCommand('$X');
        refreshLaserStatus();
    });
}

const laserGotoBtn = document.getElementById('laser-goto-btn');
if (laserGotoBtn) {
    laserGotoBtn.addEventListener('click', async () => {
        const xInput = document.getElementById('laser-goto-x');
        const yInput = document.getElementById('laser-goto-y');
        const x = parseFloat(xInput?.value);
        const y = parseFloat(yInput?.value);
        if (Number.isNaN(x) && Number.isNaN(y)) return;

        const parts = ['G90', 'G21', 'G0'];
        if (!Number.isNaN(x)) parts.push(`X${x}`);
        if (!Number.isNaN(y)) parts.push(`Y${y}`);
        parts.push(`F${LASER_JOG_FEED}`);
        await sendLaserRawCommand(parts.join(' '));
        refreshLaserStatus();
    });
}

let laserFireActive = false;
let laserFireLastOffAt = 0;

const laserFireBtn = document.getElementById('laser-fire-btn');
if (laserFireBtn) {
    laserFireBtn.addEventListener('click', async () => {
        if (!laserFireActive) return;
        const label = document.getElementById('laser-fire-label');
        await sendLaserRawCommand('M5');
        laserFireActive = false;
        laserFireLastOffAt = Date.now();
        laserFireBtn.classList.remove('active');
        if (label) label.textContent = t('laserFireOn');
    });

    laserFireBtn.addEventListener('dblclick', async () => {
        if (laserFireActive) return;
        if (Date.now() - laserFireLastOffAt < 600) return;
        const label = document.getElementById('laser-fire-label');
        const powerInput = document.getElementById('laser-fire-power-input');
        const power = Math.max(0, Math.min(1000, parseInt(powerInput?.value, 10) || 1));
        await sendLaserRawCommand(`M3 S${power}`);
        laserFireActive = true;
        laserFireBtn.classList.add('active');
        if (label) label.textContent = t('laserFireOff');
    });
}

let laserAirActive = false;

const laserAirBtn = document.getElementById('laser-air-btn');
if (laserAirBtn) {
    laserAirBtn.addEventListener('click', async () => {
        const label = document.getElementById('laser-air-label');
        if (!laserAirActive) {
            await sendLaserRawCommand('M8');
            laserAirActive = true;
        } else {
            await sendLaserRawCommand('M9');
            laserAirActive = false;
        }
        laserAirBtn.classList.toggle('active', laserAirActive);
        if (label) label.textContent = laserAirActive ? t('laserAirAssistOff') : t('laserAirAssistOn');
    });
}

// ── Contraer/expandir genérico de fichas (.card-header-std + .card-collapse-toggle) ──
document.addEventListener('click', (event) => {
    const toggle = event.target.closest('.card-collapse-toggle');
    if (!toggle) return;
    const card = toggle.closest('.card-collapsible');
    if (!card) return;
    card.classList.toggle('collapsed');
    toggle.classList.toggle('collapsed', card.classList.contains('collapsed'));
});

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
        loadModelsFolder(currentModelsPath);
    }
    if (sectionName === 'gcode') {
        loadGcodeFolder(currentGcodePath);
    }
    if (sectionName === 'console') {
        loadConsoleSection();
    } else {
        stopConsolePolling();
    }
    if (sectionName === 'macros') {
        loadMacrosSection();
    }
    if (sectionName === 'laser') {
        loadLaserSection();
    } else {
        stopLaserPolling();
    }
    if (sectionName === 'settings') {
        loadUpdatesStatus();
        refreshUsbPorts();
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

let currentModelsPath = '';
let currentModelsData = { folders: [], files: [] };

async function loadModelsFolder(path = currentModelsPath) {
    currentModelsPath = path;
    try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}&type=model`);
        if (!response.ok) throw new Error('No se pudo cargar la carpeta');
        currentModelsData = await response.json();
    } catch (error) {
        console.error(error);
        currentModelsData = { folders: [], files: [] };
    }
    updateBreadcrumb('models', currentModelsPath);
    renderModelsFullPage();
}

function renderModelsFullPage(filterQuery = '') {
    const modelsFullGrid = document.getElementById('models-full');
    if (!modelsFullGrid) return;

    const query = filterQuery.toLowerCase();
    const folders = currentModelsData.folders.filter(f => !query || f.name.toLowerCase().includes(query));
    const files = currentModelsData.files.filter(f => !query || f.name.toLowerCase().includes(query));

    if (folders.length === 0 && files.length === 0) {
        modelsFullGrid.innerHTML = `<div class="empty-state">${t('noFilesFound')}</div>`;
        return;
    }

    const sortedFiles = [...files].sort((a, b) => (b.modified || 0) - (a.modified || 0));
    const selected = sortedFiles.find(item => item.id === selectedModelId) || sortedFiles[0];
    selectedModelId = selected?.id || null;

    const folderRows = folders.map(folder => folderRowHtml(folder, 4)).join('');

    const fileRows = sortedFiles.map(model => {
        const isSelected = model.id === selectedModelId;
        const extensionLabel = model.extension ? model.extension.replace('.', '').toUpperCase() : '—';

        return `
            <tr class="${isSelected ? 'selected' : ''}" data-model-id="${model.id}">
                <td class="model-name">
                    <svg class="green-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h3l2-2h4l2 2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M8 11h8"/><path d="M8 15h8"/></svg>
                    <strong>${model.name}</strong>
                </td>
                <td>${t('model3D')}</td>
                <td><span class="tag-pill">${extensionLabel}</span></td>
                <td>${formatSize(model.size)}</td>
                <td>${formatDate(model.modified)}</td>
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
            <tbody>${folderRows}${fileRows}</tbody>
        </table>
    `;

    wireFolderRows(modelsFullGrid, 'model', loadModelsFolder);

    modelsFullGrid.querySelectorAll('tbody tr[data-model-id]').forEach(row => {
        row.addEventListener('click', () => {
            const model = currentModelsData.files.find(entry => entry.id === row.dataset.modelId);
            if (model) selectPreviewModel(model);
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
    const previewImage = document.getElementById('preview-image');

    if (previewTitle) previewTitle.textContent = model.name;
    if (previewType) previewType.textContent = `Tipo: ${model.extension?.replace('.', '').toUpperCase() || '—'}`;
    if (previewSize) previewSize.textContent = `Tamaño: ${formatSize(model.size)}`;
    if (previewDate) previewDate.textContent = `Modificado: ${formatDate(model.modified)}`;
    if (previewImage) {
        previewImage.innerHTML = '';
        previewImage.style.backgroundImage = 'linear-gradient(180deg, rgba(15,23,42,1) 0%, rgba(31,41,55,1) 100%)';
    }

    renderSelectedPreview(model);

    if (rerender) {
        renderModelsFullPage();
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
const settingsPreviewQuality = document.getElementById('settings-preview-quality');
const settingsAutoRefresh = document.getElementById('settings-autorefresh');
const settingsShowOfflineMachines = document.getElementById('settings-show-offline-machines');
const settingsLaserHomeConfirm = document.getElementById('settings-laser-home-confirm');
const settingsSaveBtn = document.getElementById('settings-save-btn');

function createOptionSwitch(containerId, onSelect) {
    const container = document.getElementById(containerId);
    const buttons = container ? Array.from(container.querySelectorAll('.option-switch-btn')) : [];
    let value = null;
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            value = btn.dataset.value;
            buttons.forEach(b => b.classList.toggle('active', b === btn));
            if (onSelect) onSelect(value);
        });
    });
    return {
        setValue(v) {
            value = v;
            buttons.forEach(b => b.classList.toggle('active', b.dataset.value === v));
        },
        getValue() {
            return value;
        },
    };
}

const settingsLanguageSwitch = createOptionSwitch('settings-language-switch', () => saveSettings());
const settingsUiScaleSwitch = createOptionSwitch('settings-ui-scale-switch', () => saveSettings());

function applyUiScale(scale) {
    document.documentElement.style.fontSize = `${scale}%`;
}
applyUiScale(localStorage.getItem('uiScale') || '100');
const settingsStatus = document.getElementById('settings-status');

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
        surface: '#334155',
        bg: '#0f172a',
        sidebar: '#0f172a',
        text: '#f1f5f9',
        muted: '#94a3b8',
    },
};

function loadSettingsPanel() {
    const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const savedLanguage = localStorage.getItem('language') || 'es';
    const savedQuality = localStorage.getItem('previewQuality') || 'standard';
    const savedAutoRefresh = localStorage.getItem('autoRefreshPrinters');
    const savedUiScale = localStorage.getItem('uiScale') || '100';

    updateCustomThemeCardUI();
    if (settingsTheme) settingsTheme.value = savedTheme;
    settingsLanguageSwitch.setValue(savedLanguage);
    if (settingsPreviewQuality) settingsPreviewQuality.checked = savedQuality === 'performance';
    if (settingsAutoRefresh) settingsAutoRefresh.checked = savedAutoRefresh !== 'false';
    if (settingsShowOfflineMachines) settingsShowOfflineMachines.checked = isShowOfflineMachinesEnabled();
    if (settingsLaserHomeConfirm) settingsLaserHomeConfirm.checked = isLaserHomeConfirmEnabled();
    settingsUiScaleSwitch.setValue(savedUiScale);

    setActiveThemeCard(savedTheme);
}

async function loadUpdatesStatus() {
    const versionEl = document.getElementById('updates-version');
    const pillEl = document.getElementById('updates-status-pill');
    const metaEl = document.getElementById('updates-meta');
    const applyBtn = document.getElementById('updates-apply-btn');
    if (!versionEl || !pillEl) return;

    pillEl.textContent = t('updatesChecking');
    pillEl.className = 'updates-status-pill checking';
    if (applyBtn) applyBtn.hidden = true;

    try {
        const response = await fetch('/api/system/version');
        if (!response.ok) throw new Error('No se pudo verificar la versión');
        const data = await response.json();

        versionEl.textContent = data.app_version ? `v${data.app_version}` : '—';

        if (data.status === 'update_available') {
            pillEl.textContent = t('updatesAvailable');
            pillEl.className = 'updates-status-pill available';
            if (applyBtn) applyBtn.hidden = false;
        } else if (data.status === 'up_to_date') {
            pillEl.textContent = t('updatesUpToDate');
            pillEl.className = 'updates-status-pill current';
        } else {
            pillEl.textContent = t('updatesUnknown');
            pillEl.className = 'updates-status-pill unknown';
        }

        if (metaEl) {
            const parts = [];
            if (data.branch) parts.push(data.branch);
            if (data.commit) parts.push(data.commit);
            if (data.date) parts.push(new Date(data.date).toLocaleString());
            if (data.status === 'update_available' && data.behind) parts.push(`${data.behind} commit(s) atrás`);
            metaEl.textContent = parts.join(' · ');
        }

        const tooltipEl = document.getElementById('updates-pill-tooltip');
        if (tooltipEl) {
            if (data.status === 'update_available' && data.pending_commits && data.pending_commits.length) {
                tooltipEl.innerHTML = `
                    <div class="updates-pill-tooltip-title">${escapeHtml(t('updatesPendingTitle'))}</div>
                    <ul>${data.pending_commits.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
                `;
            } else {
                tooltipEl.innerHTML = '';
            }
        }
    } catch (error) {
        console.error(error);
        pillEl.textContent = t('updatesUnknown');
        pillEl.className = 'updates-status-pill unknown';
    }
}

const updatesPillWrap = document.querySelector('.updates-status-pill-wrap');
if (updatesPillWrap) {
    updatesPillWrap.addEventListener('mouseenter', () => {
        const pillEl = document.getElementById('updates-status-pill');
        const tooltipEl = document.getElementById('updates-pill-tooltip');
        if (pillEl?.classList.contains('available') && tooltipEl?.innerHTML.trim()) {
            updatesPillWrap.classList.add('show-tooltip');
        }
    });
    updatesPillWrap.addEventListener('mouseleave', () => {
        updatesPillWrap.classList.remove('show-tooltip');
    });
}

const updatesApplyBtn = document.getElementById('updates-apply-btn');
if (updatesApplyBtn) {
    updatesApplyBtn.addEventListener('click', async () => {
        const changelogEl = document.getElementById('updates-changelog');
        const label = updatesApplyBtn.querySelector('span');
        const originalLabel = label ? label.textContent : '';

        if (!(await appConfirm(t('updatesApply') + '?', t('updatesApply'), 'warning'))) return;

        updatesApplyBtn.disabled = true;
        if (label) label.textContent = t('updatesApplying');

        try {
            const response = await fetch('/api/system/update', { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || t('updatesApplyError'));

            if (changelogEl) {
                changelogEl.hidden = false;
                if (data.updated && data.commits && data.commits.length) {
                    changelogEl.innerHTML = `
                        <div class="updates-changelog-title">${escapeHtml(t('updatesAppliedTitle'))}</div>
                        <ul>${data.commits.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
                        <div class="updates-changelog-title" style="margin-top:8px;">${escapeHtml(t('updatesReloadHint'))}</div>
                    `;
                } else {
                    changelogEl.innerHTML = `<div class="updates-changelog-title">${escapeHtml(t('updatesAlreadyCurrent'))}</div>`;
                }
            }

            loadUpdatesStatus();
        } catch (error) {
            console.error(error);
            appAlert(error.message || t('updatesApplyError'), '', 'danger');
        } finally {
            updatesApplyBtn.disabled = false;
            if (label) label.textContent = originalLabel;
        }
    });
}

const updatesCheckBtn = document.getElementById('updates-check-btn');
if (updatesCheckBtn) {
    updatesCheckBtn.addEventListener('click', loadUpdatesStatus);
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
    const languageValue = settingsLanguageSwitch.getValue();
    if (languageValue) {
        setLanguage(languageValue);
        updateLangSwitchUI();
    }
    if (settingsPreviewQuality) {
        localStorage.setItem('previewQuality', settingsPreviewQuality.checked ? 'performance' : 'standard');
    }
    if (settingsAutoRefresh) {
        localStorage.setItem('autoRefreshPrinters', settingsAutoRefresh.checked ? 'true' : 'false');
    }
    if (settingsShowOfflineMachines) {
        localStorage.setItem('showOfflineMachines', settingsShowOfflineMachines.checked ? 'true' : 'false');
        updateToggleOfflineMachinesBtn();
        renderPrinters(allPrinters);
    }
    if (settingsLaserHomeConfirm) {
        localStorage.setItem('laserHomeConfirmEnabled', settingsLaserHomeConfirm.checked ? 'true' : 'false');
    }
    const uiScaleValue = settingsUiScaleSwitch.getValue();
    if (uiScaleValue) {
        localStorage.setItem('uiScale', uiScaleValue);
        applyUiScale(uiScaleValue);
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
const langSwitchBtns = document.querySelectorAll('.lang-switch-btn');
function updateLangSwitchUI() {
    langSwitchBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === currentLanguage);
    });
}
langSwitchBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        setLanguage(btn.dataset.lang);
        updateLangSwitchUI();
    });
});
updateLangSwitchUI();

if (settingsTheme) {
    settingsTheme.addEventListener('change', () => {
        const selectedTheme = settingsTheme.value;
        setActiveThemeCard(selectedTheme);
        saveSettings();
    });
}
if (settingsPreviewQuality) {
    settingsPreviewQuality.addEventListener('change', saveSettings);
}
if (settingsAutoRefresh) {
    settingsAutoRefresh.addEventListener('change', saveSettings);
}
if (settingsShowOfflineMachines) {
    settingsShowOfflineMachines.addEventListener('change', saveSettings);
}
if (settingsLaserHomeConfirm) {
    settingsLaserHomeConfirm.addEventListener('change', saveSettings);
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
        if (card.id === 'custom-theme-card') return;
        card.addEventListener('click', () => {
            const selectedTheme = card.dataset.theme;
            if (settingsTheme) settingsTheme.value = selectedTheme;
            setActiveThemeCard(selectedTheme);
            saveSettings();
        });
    });
}

function getThemeCycleOrder() {
    const order = ['light', 'dark', 'green'];
    if (getCustomTheme()) order.push('custom');
    return order;
}

if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const cycleOrder = getThemeCycleOrder();
        const currentTheme = settingsTheme ? settingsTheme.value : document.body.getAttribute('data-theme');
        const currentIndex = cycleOrder.indexOf(currentTheme);
        const nextTheme = cycleOrder[(currentIndex + 1) % cycleOrder.length];
        localStorage.setItem('theme', nextTheme);
        if (settingsTheme) {
            settingsTheme.value = nextTheme;
        }
        setActiveThemeCard(nextTheme);
        applyTheme(nextTheme);
    });
}

// ── Custom theme (4th slot) ──
const customThemeCard = document.getElementById('custom-theme-card');
const customThemeAddBtn = document.getElementById('custom-theme-add-btn');
const customThemeBody = document.getElementById('custom-theme-body');
const customThemeSelectBtn = document.getElementById('custom-theme-select-btn');
const customThemeSwatches = document.getElementById('custom-theme-swatches');
const customThemeEditBtn = document.getElementById('custom-theme-edit-btn');
const customThemeDeleteBtn = document.getElementById('custom-theme-delete-btn');
const settingsThemeCustomOption = document.getElementById('settings-theme-custom-option');

const customThemeModal = document.getElementById('custom-theme-modal');
const customThemeModalBackdrop = document.getElementById('custom-theme-modal-backdrop');
const customThemeModalClose = document.getElementById('custom-theme-modal-close');
const customThemeAccentInput = document.getElementById('custom-theme-accent');
const customThemeSurfaceInput = document.getElementById('custom-theme-surface');
const customThemeTextInput = document.getElementById('custom-theme-text');
const customThemeMutedInput = document.getElementById('custom-theme-muted');
const customThemeSaveBtn = document.getElementById('custom-theme-save-btn');
const customThemeBgInput = document.getElementById('custom-theme-bg-input');
const customThemeBgClearBtn = document.getElementById('custom-theme-bg-clear-btn');

const CUSTOM_THEME_BG_KEY = 'customThemeBackground';
const CUSTOM_THEME_BG_MAX_BYTES = 2 * 1024 * 1024;

function getCustomThemeBackground() {
    return localStorage.getItem(CUSTOM_THEME_BG_KEY) || null;
}

function setCustomThemeBackground(dataUrl) {
    if (dataUrl) localStorage.setItem(CUSTOM_THEME_BG_KEY, dataUrl);
    else localStorage.removeItem(CUSTOM_THEME_BG_KEY);
}

function applyCustomThemeBackground() {
    const bg = document.body.classList.contains('custom') ? getCustomThemeBackground() : null;
    if (bg) {
        document.body.style.backgroundImage = `url(${bg})`;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundAttachment = 'fixed';
        document.body.style.backgroundRepeat = 'no-repeat';
    } else {
        document.body.style.backgroundImage = '';
        document.body.style.backgroundSize = '';
        document.body.style.backgroundPosition = '';
        document.body.style.backgroundAttachment = '';
        document.body.style.backgroundRepeat = '';
    }
}

if (customThemeBgInput) {
    customThemeBgInput.addEventListener('change', () => {
        const file = customThemeBgInput.files?.[0];
        customThemeBgInput.value = '';
        if (!file) return;
        if (file.size > CUSTOM_THEME_BG_MAX_BYTES) {
            appAlert(t('customThemeBgTooLarge'), '', 'warning');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            setCustomThemeBackground(reader.result);
            if (customThemeBgClearBtn) customThemeBgClearBtn.hidden = false;
            if (document.body.classList.contains('custom')) applyCustomThemeBackground();
        };
        reader.readAsDataURL(file);
    });
}

if (customThemeBgClearBtn) {
    customThemeBgClearBtn.addEventListener('click', () => {
        setCustomThemeBackground(null);
        customThemeBgClearBtn.hidden = true;
        if (document.body.classList.contains('custom')) applyCustomThemeBackground();
    });
}

function updateCustomThemeCardUI() {
    const custom = getCustomTheme();
    if (settingsThemeCustomOption) settingsThemeCustomOption.hidden = !custom;
    if (customThemeAddBtn) customThemeAddBtn.hidden = !!custom;
    if (customThemeBody) customThemeBody.hidden = !custom;
    if (custom && customThemeSwatches) {
        customThemeSwatches.innerHTML = [custom.surface, custom.accent, custom.muted, custom.text]
            .map(color => `<span class="theme-option-swatch" style="background:${color}"></span>`)
            .join('');
    }
}

function openCustomThemeModal() {
    const custom = getCustomTheme();
    if (customThemeAccentInput) customThemeAccentInput.value = custom?.accent || '#8b5cf6';
    if (customThemeSurfaceInput) customThemeSurfaceInput.value = custom?.surface || '#1f2937';
    if (customThemeTextInput) customThemeTextInput.value = custom?.text || '#f8fafc';
    if (customThemeMutedInput) customThemeMutedInput.value = custom?.muted || '#94a3b8';
    if (customThemeBgClearBtn) customThemeBgClearBtn.hidden = !getCustomThemeBackground();
    if (customThemeModal) customThemeModal.classList.add('active');
}

function closeCustomThemeModal() {
    if (customThemeModal) customThemeModal.classList.remove('active');
}

if (customThemeAddBtn) customThemeAddBtn.addEventListener('click', openCustomThemeModal);
if (customThemeEditBtn) customThemeEditBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openCustomThemeModal();
});
if (customThemeDeleteBtn) customThemeDeleteBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!(await appConfirm(t('deleteCustomThemeConfirm'), t('deleteCustomTheme')))) return;
    deleteCustomTheme();
    updateCustomThemeCardUI();
    const fallbackTheme = document.body.getAttribute('data-theme') === 'custom' ? 'light' : (settingsTheme ? settingsTheme.value : 'light');
    localStorage.setItem('theme', fallbackTheme);
    if (settingsTheme) settingsTheme.value = fallbackTheme;
    setActiveThemeCard(fallbackTheme);
    applyTheme(fallbackTheme);
});
if (customThemeSelectBtn) customThemeSelectBtn.addEventListener('click', () => {
    if (!getCustomTheme()) return;
    if (settingsTheme) settingsTheme.value = 'custom';
    setActiveThemeCard('custom');
    saveSettings();
});
if (customThemeModalBackdrop) customThemeModalBackdrop.addEventListener('click', closeCustomThemeModal);
if (customThemeModalClose) customThemeModalClose.addEventListener('click', closeCustomThemeModal);
if (customThemeSaveBtn) {
    customThemeSaveBtn.addEventListener('click', () => {
        const colors = {
            accent: customThemeAccentInput?.value || '#8b5cf6',
            surface: customThemeSurfaceInput?.value || '#1f2937',
            text: customThemeTextInput?.value || '#f8fafc',
            muted: customThemeMutedInput?.value || '#94a3b8',
        };
        saveCustomTheme(colors);
        updateCustomThemeCardUI();
        closeCustomThemeModal();
        if (settingsTheme) settingsTheme.value = 'custom';
        setActiveThemeCard('custom');
        saveSettings();
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

const viewGridPrintersBtn = document.getElementById('view-grid-printers');
const viewListPrintersBtn = document.getElementById('view-list-printers');

if (viewGridPrintersBtn) {
    viewGridPrintersBtn.addEventListener('click', () => updatePrintersViewMode('grid'));
}
if (viewListPrintersBtn) {
    viewListPrintersBtn.addEventListener('click', () => updatePrintersViewMode('list'));
}
if (printersViewMode === 'list') {
    updatePrintersViewMode('list');
}

const toggleOfflineMachinesBtn = document.getElementById('toggle-offline-machines-btn');
function updateToggleOfflineMachinesBtn() {
    if (toggleOfflineMachinesBtn) {
        toggleOfflineMachinesBtn.classList.toggle('btn-view-toggle-active', isShowOfflineMachinesEnabled());
    }
}
if (toggleOfflineMachinesBtn) {
    toggleOfflineMachinesBtn.addEventListener('click', () => {
        const nextValue = !isShowOfflineMachinesEnabled();
        localStorage.setItem('showOfflineMachines', nextValue ? 'true' : 'false');
        if (settingsShowOfflineMachines) settingsShowOfflineMachines.checked = nextValue;
        updateToggleOfflineMachinesBtn();
        renderPrinters(allPrinters);
    });
}
updateToggleOfflineMachinesBtn();

// Update language display on load
updateLangSwitchUI();
updatePageLanguage();

renderPrintQueue();
loadModels();
loadPrinters();
loadRecentPrinterFiles();
loadTopbarServerStats();
refreshDashboardLaserCard();
refreshUsbPorts();

// Refresh printers every 5 seconds
setInterval(loadPrinters, 5000);
setInterval(loadTopbarServerStats, 10000);
setInterval(refreshDashboardLaserCard, 4000);
setInterval(refreshUsbPorts, 8000);
