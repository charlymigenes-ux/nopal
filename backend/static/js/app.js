// ── Autenticación + barra superior global ──
// Va primero en el archivo a propósito: envuelve window.fetch ANTES de que
// corran las llamadas de init de más abajo (loadModels(), loadPrinters(),
// etc.) — si esto estuviera al final del archivo, esas llamadas iniciales
// ya se habrían disparado con el fetch original y un 401 en la primera
// carga pasaría desapercibido (dashboard visible, resto roto en silencio).

let currentAuthUser = null;

const ORIGINAL_FETCH = window.fetch.bind(window);
window.fetch = async function authAwareFetch(input, init) {
    const response = await ORIGINAL_FETCH(input, init);
    if (response.status === 401) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
            showLoginOverlay();
        }
    }
    return response;
};

function showLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.hidden = false;
    document.getElementById('login-mode-setup')?.setAttribute('hidden', '');
    document.getElementById('login-mode-login')?.removeAttribute('hidden');
}

function showSetupOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.hidden = false;
    document.getElementById('login-mode-login')?.setAttribute('hidden', '');
    document.getElementById('login-mode-setup')?.removeAttribute('hidden');
}

function hideLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.hidden = true;
}

function updateTopbarUser(user) {
    const nameEl = document.getElementById('topbar-user-name');
    const avatarEl = document.getElementById('topbar-user-avatar');
    const roleEl = document.getElementById('topbar-user-role');
    if (nameEl) nameEl.textContent = user.username;
    if (avatarEl) avatarEl.textContent = (user.username || '?').slice(0, 1);
    if (roleEl) roleEl.textContent = user.role === 'admin' ? t('roleAdmin') : t('roleOperator');
}

async function checkAuth() {
    try {
        const setupResponse = await ORIGINAL_FETCH('/api/auth/setup-required');
        if (setupResponse.ok) {
            const setupData = await setupResponse.json();
            if (setupData.required) {
                showSetupOverlay();
                return null;
            }
        }
    } catch (error) {
        console.error(error);
    }

    try {
        const response = await ORIGINAL_FETCH('/api/auth/me');
        if (!response.ok) {
            showLoginOverlay();
            return null;
        }
        const user = await response.json();
        currentAuthUser = user;
        hideLoginOverlay();
        updateTopbarUser(user);
        return user;
    } catch (error) {
        console.error(error);
        return null;
    }
}

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username-input')?.value.trim() || '';
    const password = document.getElementById('login-password-input')?.value || '';
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit-btn');
    if (errorEl) errorEl.hidden = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
        const formData = new FormData();
        formData.append('username', username);
        formData.append('password', password);
        const response = await ORIGINAL_FETCH('/api/auth/login', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('loginError'));
        }
        window.location.reload();
    } catch (error) {
        if (errorEl) {
            errorEl.textContent = error.message || t('loginError');
            errorEl.hidden = false;
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
});

document.getElementById('setup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('setup-username-input')?.value.trim() || '';
    const password = document.getElementById('setup-password-input')?.value || '';
    const confirmPassword = document.getElementById('setup-password-confirm-input')?.value || '';
    const errorEl = document.getElementById('setup-error');
    const submitBtn = document.getElementById('setup-submit-btn');
    if (errorEl) errorEl.hidden = true;

    if (password !== confirmPassword) {
        if (errorEl) {
            errorEl.textContent = t('setupPasswordMismatch');
            errorEl.hidden = false;
        }
        return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
        const formData = new FormData();
        formData.append('username', username);
        formData.append('password', password);
        const response = await ORIGINAL_FETCH('/api/auth/setup', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('setupError'));
        }
        window.location.reload();
    } catch (error) {
        if (errorEl) {
            errorEl.textContent = error.message || t('setupError');
            errorEl.hidden = false;
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
});

document.getElementById('topbar-logout-btn')?.addEventListener('click', async () => {
    try {
        await ORIGINAL_FETCH('/api/auth/logout', { method: 'POST' });
    } catch (error) {
        console.error(error);
    }
    window.location.reload();
});

function closeAllTopbarDropdowns() {
    document.querySelectorAll('.topbar-menu-panel').forEach(panel => { panel.hidden = true; });
}

document.addEventListener('click', closeAllTopbarDropdowns);

function wireTopbarDropdown(btnId, panelId) {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = !panel.hidden;
        closeAllTopbarDropdowns();
        panel.hidden = wasOpen;
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
}

wireTopbarDropdown('topbar-notif-btn', 'topbar-notif-panel');
wireTopbarDropdown('topbar-lang-btn', 'topbar-lang-panel');
wireTopbarDropdown('topbar-user-btn', 'topbar-user-panel');

function updateTopbarLangLabel() {
    const el = document.getElementById('topbar-lang-current');
    if (el) el.textContent = (typeof currentLanguage !== 'undefined' ? currentLanguage : 'es').toUpperCase();
}

document.querySelectorAll('#topbar-lang-panel .lang-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        updateTopbarLangLabel();
        closeAllTopbarDropdowns();
    });
});

function renderTopbarNotifications(data) {
    const badge = document.getElementById('topbar-notif-badge');
    const list = document.getElementById('topbar-notif-list');
    if (!badge || !list) return;
    const count = data.count || 0;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
    const items = data.items || [];
    if (!items.length) {
        list.innerHTML = `<div class="topbar-notif-empty">${escapeHtml(t('notificationsEmpty'))}</div>`;
        return;
    }
    list.innerHTML = items.map(item => `
        <div class="topbar-notif-item severity-${escapeHtml(item.severity || 'info')}">
            <span class="topbar-notif-item-dot"></span>
            <span>${escapeHtml(item.message)}</span>
        </div>
    `).join('');
}

async function loadTopbarNotifications() {
    if (!currentAuthUser) return;
    try {
        const response = await fetch('/api/notifications');
        if (!response.ok) return;
        renderTopbarNotifications(await response.json());
    } catch (error) {
        console.error(error);
    }
}

checkAuth().then(user => {
    updateTopbarLangLabel();
    if (user) loadTopbarNotifications();
});
setInterval(() => { if (currentAuthUser) loadTopbarNotifications(); }, 10000);

const modelsGrid = document.getElementById('models');
const printersGrid = document.getElementById('printers-grid');
const lasersGrid = document.getElementById('lasers-grid');
const cncGrid = document.getElementById('cnc-grid');
const machinesColumns = document.getElementById('machines-columns');
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
let printersViewMode = localStorage.getItem('printersViewMode') || 'list';
const gcodePreviewCache = new Map();

function isSidebarCollapsed() {
    return localStorage.getItem('sidebarCollapsed') === 'true';
}

function applySidebarCollapsed(collapsed) {
    const shell = document.querySelector('.app-shell');
    if (shell) shell.classList.toggle('sidebar-collapsed', collapsed);
}

applySidebarCollapsed(isSidebarCollapsed());

const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => {
        const collapsed = !isSidebarCollapsed();
        localStorage.setItem('sidebarCollapsed', collapsed ? 'true' : 'false');
        applySidebarCollapsed(collapsed);
    });
}

// ── Orden personalizable de los accesos del sidebar ──
const SIDEBAR_ORDER_KEY = 'sidebarOrder';
const SIDEBAR_CATEGORY_STATE_KEY = 'sidebarCategoryState';
const FIXED_SIDEBAR_SECTIONS = ['dashboard', 'help'];

function getSidebarSections() {
    return Array.from(document.querySelectorAll('.nav-list .nav-item'))
        .map(btn => btn.dataset.section)
        .filter(id => id && !FIXED_SIDEBAR_SECTIONS.includes(id));
}

function getSidebarOrder() {
    const allSections = getSidebarSections();
    let saved = [];
    try {
        saved = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY) || '[]');
    } catch (error) {
        saved = [];
    }
    const valid = saved.filter(id => allSections.includes(id));
    const missing = allSections.filter(id => !valid.includes(id));
    return [...valid, ...missing];
}

function saveSidebarOrder(order) {
    localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(order));
}

function applySidebarOrder() {
    const navList = document.querySelector('.nav-list');
    if (!navList) return;
    const order = getSidebarOrder();
    const orderIndex = new Map(order.map((sectionId, index) => [sectionId, index]));

    // Cada acceso se reordena únicamente dentro de su categoría. La versión
    // anterior anexaba todos los botones directamente a navList, destruyendo
    // los grupos definidos en el HTML y dejando los encabezados separados.
    navList.querySelectorAll('.nav-category-items').forEach(container => {
        const buttons = Array.from(container.querySelectorAll(':scope > .nav-item'));
        buttons
            .sort((a, b) => (orderIndex.get(a.dataset.section) ?? Number.MAX_SAFE_INTEGER)
                - (orderIndex.get(b.dataset.section) ?? Number.MAX_SAFE_INTEGER))
            .forEach(button => container.appendChild(button));
    });
}

applySidebarOrder();

function getSidebarCategoryState() {
    try {
        return JSON.parse(localStorage.getItem(SIDEBAR_CATEGORY_STATE_KEY) || '{}');
    } catch (error) {
        return {};
    }
}

function setCategoryCollapsed(category, collapsed) {
    category.classList.toggle('collapsed', collapsed);
    const header = category.querySelector('[data-category-toggle]');
    if (header) header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

const sidebarCategoryState = getSidebarCategoryState();
document.querySelectorAll('.nav-category').forEach(category => {
    const group = category.dataset.group;
    const header = category.querySelector('[data-category-toggle]');
    setCategoryCollapsed(category, sidebarCategoryState[group] === true);
    if (!header) return;
    header.addEventListener('click', () => {
        const collapsed = !category.classList.contains('collapsed');
        setCategoryCollapsed(category, collapsed);
        const state = getSidebarCategoryState();
        state[group] = collapsed;
        localStorage.setItem(SIDEBAR_CATEGORY_STATE_KEY, JSON.stringify(state));
    });
});

function renderSidebarOrderList() {
    const container = document.getElementById('sidebar-order-list');
    const navList = document.querySelector('.nav-list');
    if (!container || !navList) return;

    const order = getSidebarOrder();
    container.innerHTML = order.map(sectionId => {
        const btn = navList.querySelector(`.nav-item[data-section="${sectionId}"]`);
        if (!btn) return '';
        const groupContainer = btn.closest('.nav-category-items');
        const groupSections = groupContainer
            ? Array.from(groupContainer.querySelectorAll(':scope > .nav-item[data-section]')).map(item => item.dataset.section)
            : [sectionId];
        const index = groupSections.indexOf(sectionId);
        const iconEl = btn.querySelector('svg');
        const icon = iconEl ? iconEl.outerHTML : '';
        const labelEl = btn.querySelector('span[data-i18n]');
        const label = labelEl ? labelEl.textContent : sectionId;
        const options = groupSections.map((_, i) => `<option value="${i + 1}" ${i === index ? 'selected' : ''}>${i + 1}</option>`).join('');
        return `
            <div class="sidebar-order-row">
                <span class="sidebar-order-row-label">${icon}<span>${escapeHtml(label)}</span></span>
                <select class="sidebar-order-select" data-section="${sectionId}">${options}</select>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.sidebar-order-select').forEach(select => {
        select.addEventListener('change', () => {
            const sectionId = select.dataset.section;
            const newPos = parseInt(select.value, 10) - 1;
            const button = navList.querySelector(`.nav-item[data-section="${sectionId}"]`);
            const groupContainer = button?.closest('.nav-category-items');
            if (!button || !groupContainer) return;
            const groupButtons = Array.from(groupContainer.querySelectorAll(':scope > .nav-item[data-section]'));
            const oldPos = groupButtons.indexOf(button);
            if (oldPos === -1 || newPos === oldPos) return;
            groupButtons.splice(oldPos, 1);
            groupButtons.splice(newPos, 0, button);
            groupButtons.forEach(item => groupContainer.appendChild(item));
            saveSidebarOrder(getSidebarSections());
            renderSidebarOrderList();
        });
    });
}

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

// Extrae todas las "palabras" (letra + número) de una línea de G-code.
// Muchos post-procesadores (p.ej. LightBurn) empacan varias palabras sin
// espacios entre ellas, p.ej. "G1 X35.8Y0.2F10000" son en realidad tres
// palabras (X35.8, Y0.2, F10000): partir solo por espacios pierde Y y F.
const GCODE_WORD_PATTERN = /([A-Za-z])(-?\d*\.?\d+)/g;

function tokenizeGcodeLine(line) {
    const words = [];
    GCODE_WORD_PATTERN.lastIndex = 0;
    let match;
    while ((match = GCODE_WORD_PATTERN.exec(line)) !== null) {
        words.push({ letter: match[1].toUpperCase(), value: parseFloat(match[2]) });
    }
    return words;
}

// Los archivos láser tipo raster (LightBurn, etc.) recorren todo el área con
// G0/G1 y modulan la potencia con S: S0 es una pasada "apagada" (solo
// posicionamiento) y S>0 es donde realmente graba. Si se dibujan todos los
// movimientos por igual, el preview se ve como un montón de líneas rectas de
// lado a lado (efecto "código de barras") en vez de la imagen grabada. Por
// eso, cuando el archivo usa S en absoluto, solo se dibujan los tramos donde
// la potencia es mayor a 0; si nunca aparece S (G-code de impresora FDM, por
// ejemplo), se conserva el comportamiento anterior y se dibuja todo el
// recorrido.
function gcodeUsesLaserPower(content) {
    return /(?:^|\s)S-?\d/.test(content);
}

function parseGcodePath(content, maxSegments = 2500) {
    const filterByPower = gcodeUsesLaserPower(content);
    const lines = content.split(/\r?\n/);
    let x = 0, y = 0, z = 0, e = 0;
    let absolute = true;
    let power = 0;
    let lastPoint = new THREE.Vector3(0, 0, 0);
    let hasLastPoint = false;
    const segments = [];

    for (const raw of lines) {
        const line = raw.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim();
        if (!line) continue;

        const words = tokenizeGcodeLine(line);
        if (words.length === 0) continue;
        const command = words[0];

        for (let i = 1; i < words.length; i++) {
            if (words[i].letter === 'S') power = words[i].value;
        }

        if (command.letter === 'M' && command.value === 5) {
            power = 0;
            continue;
        }
        if (command.letter === 'G' && command.value === 90) {
            absolute = true;
            continue;
        }
        if (command.letter === 'G' && command.value === 91) {
            absolute = false;
            continue;
        }
        if (command.letter === 'G' && command.value === 92) {
            for (let i = 1; i < words.length; i++) {
                const word = words[i];
                if (word.letter === 'X') x = word.value;
                if (word.letter === 'Y') y = word.value;
                if (word.letter === 'Z') z = word.value;
                if (word.letter === 'E') e = word.value;
            }
            continue;
        }
        if (!(command.letter === 'G' && (command.value === 0 || command.value === 1))) continue;

        let nx = x;
        let ny = y;
        let nz = z;
        let ne = e;

        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            if (word.letter === 'X') nx = absolute ? word.value : x + word.value;
            if (word.letter === 'Y') ny = absolute ? word.value : y + word.value;
            if (word.letter === 'Z') nz = absolute ? word.value : z + word.value;
            if (word.letter === 'E') ne = absolute ? word.value : e + word.value;
        }

        const moved = nx !== x || ny !== y || nz !== z;
        if (moved) {
            const currentPoint = new THREE.Vector3(nx, ny, nz);
            const isBurning = filterByPower ? (command.value === 1 && power > 0) : true;
            if (!hasLastPoint) {
                lastPoint = currentPoint.clone();
                hasLastPoint = true;
            } else if (isBurning) {
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

// ── Parser de trayectoria para el visor CNC ──
// Independiente de parseGcodePath: ese filtra segmentos por potencia de
// láser (S como on/off), lo cual rompería la lectura de G-code de CNC (ahí
// S es RPM de husillo, no potencia). Reusa solo el tokenizador de bajo nivel.

// Interpola un arco G2 (horario) / G3 (antihorario) a una lista de puntos
// intermedios, soportando tanto la forma I/J (centro relativo) como R
// (radio) — ambas comunes en archivos CNC reales.
function linearizeArc(x, y, z, nx, ny, nz, i, j, r, clockwise) {
    let cx, cy;
    if (r !== null && r !== undefined) {
        const dx = nx - x, dy = ny - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) return [{ x: nx, y: ny, z: nz }];
        const h = Math.sqrt(Math.max(0, r * r - (dist / 2) * (dist / 2)));
        const midX = (x + nx) / 2, midY = (y + ny) / 2;
        const perpX = -dy / dist, perpY = dx / dist;
        const sign = (clockwise ? -1 : 1) * (r >= 0 ? 1 : -1);
        cx = midX + sign * h * perpX;
        cy = midY + sign * h * perpY;
    } else {
        cx = x + (i || 0);
        cy = y + (j || 0);
    }
    const radius = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    const startAngle = Math.atan2(y - cy, x - cx);
    let endAngle = Math.atan2(ny - cy, nx - cx);
    let sweep = endAngle - startAngle;
    if (clockwise) {
        if (sweep >= 0) sweep -= 2 * Math.PI;
    } else {
        if (sweep <= 0) sweep += 2 * Math.PI;
    }
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (3 * Math.PI / 180)));
    const points = [];
    for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const angle = startAngle + sweep * t;
        points.push({
            x: cx + radius * Math.cos(angle),
            y: cy + radius * Math.sin(angle),
            z: z + (nz - z) * t,
        });
    }
    return points;
}

// Parsea un archivo CNC completo: soporta G0/G1/G2/G3, G90/G91, G20/G21.
// Agrupa los movimientos de corte en sub-trayectorias separadas cada vez que
// aparece un G0 (así se pueden etiquetar con su propio rango de Z, como en
// la referencia visual "path N · Z a → b"), y devuelve los rápidos aparte
// para dibujarlos distinto (línea tenue) de los cortes (ámbar).
function parseCncToolpath(content) {
    const lines = content.split(/\r?\n/);
    let x = 0, y = 0, z = 0;
    let absolute = true;
    let unitsScale = 1;
    const cutPaths = [];
    const rapidSegments = [];
    let currentCut = null;
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };

    function updateBounds(px, py, pz) {
        if (px < bounds.minX) bounds.minX = px;
        if (px > bounds.maxX) bounds.maxX = px;
        if (py < bounds.minY) bounds.minY = py;
        if (py > bounds.maxY) bounds.maxY = py;
        if (pz < bounds.minZ) bounds.minZ = pz;
        if (pz > bounds.maxZ) bounds.maxZ = pz;
    }

    function closeCurrentCut() {
        if (currentCut && currentCut.points.length >= 2) {
            cutPaths.push(currentCut);
        }
        currentCut = null;
    }

    for (const raw of lines) {
        const line = raw.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim();
        if (!line) continue;
        const words = tokenizeGcodeLine(line);
        if (words.length === 0) continue;

        let motionMode = null;
        let ix = null, iy = null, iz = null, ii = null, jj = null, rr = null;

        for (const word of words) {
            if (word.letter === 'G') {
                if (word.value === 90) absolute = true;
                else if (word.value === 91) absolute = false;
                else if (word.value === 20) unitsScale = 25.4;
                else if (word.value === 21) unitsScale = 1;
                else if (word.value === 0 || word.value === 1 || word.value === 2 || word.value === 3) motionMode = word.value;
            } else if (word.letter === 'X') ix = word.value * unitsScale;
            else if (word.letter === 'Y') iy = word.value * unitsScale;
            else if (word.letter === 'Z') iz = word.value * unitsScale;
            else if (word.letter === 'I') ii = word.value * unitsScale;
            else if (word.letter === 'J') jj = word.value * unitsScale;
            else if (word.letter === 'R') rr = word.value * unitsScale;
        }

        if (motionMode === null) continue;

        const nx = ix !== null ? (absolute ? ix : x + ix) : x;
        const ny = iy !== null ? (absolute ? iy : y + iy) : y;
        const nz = iz !== null ? (absolute ? iz : z + iz) : z;

        if (motionMode === 0) {
            closeCurrentCut();
            if (nx !== x || ny !== y || nz !== z) {
                rapidSegments.push(new THREE.Vector3(x, y, z), new THREE.Vector3(nx, ny, nz));
                updateBounds(x, y, z);
                updateBounds(nx, ny, nz);
            }
        } else if (motionMode === 1) {
            if (!currentCut) currentCut = { id: cutPaths.length, points: [new THREE.Vector3(x, y, z)], zStart: z, zEnd: z };
            currentCut.points.push(new THREE.Vector3(nx, ny, nz));
            currentCut.zEnd = nz;
            updateBounds(x, y, z);
            updateBounds(nx, ny, nz);
        } else if (motionMode === 2 || motionMode === 3) {
            if (!currentCut) currentCut = { id: cutPaths.length, points: [new THREE.Vector3(x, y, z)], zStart: z, zEnd: z };
            const arcPoints = linearizeArc(x, y, z, nx, ny, nz, ii, jj, rr, motionMode === 2);
            for (const p of arcPoints) {
                currentCut.points.push(new THREE.Vector3(p.x, p.y, p.z));
                updateBounds(p.x, p.y, p.z);
            }
            currentCut.zEnd = nz;
        }

        x = nx;
        y = ny;
        z = nz;
    }
    closeCurrentCut();

    if (!Number.isFinite(bounds.minX)) {
        bounds.minX = bounds.maxX = bounds.minY = bounds.maxY = bounds.minZ = bounds.maxZ = 0;
    }

    return { cutPaths, rapidSegments, bounds };
}

const gcodeDimensionsCache = new Map();

// LightBurn (y otros post-procesadores) escriben el bounding box real ya
// calculado en el encabezado, p.ej. "; Bounds: X13.97 Y4.7 to X155.63
// Y245.8" — leerlo es exacto e inmediato, así que se prueba primero antes de
// recalcularlo a mano recorriendo todo el archivo.
function parseGcodeBoundsComment(header) {
    const match = header.match(/;\s*Bounds:\s*X(-?[\d.]+)\s*Y(-?[\d.]+)\s*to\s*X(-?[\d.]+)\s*Y(-?[\d.]+)/i);
    if (!match) return null;
    const minX = parseFloat(match[1]);
    const minY = parseFloat(match[2]);
    const maxX = parseFloat(match[3]);
    const maxY = parseFloat(match[4]);
    if ([minX, minY, maxX, maxY].some(Number.isNaN)) return null;
    return { width: maxX - minX, height: maxY - minY };
}

async function getGcodeDimensions(fileUrl) {
    if (gcodeDimensionsCache.has(fileUrl)) {
        return gcodeDimensionsCache.get(fileUrl);
    }
    let dimensions = null;
    try {
        const response = await fetch(fileUrl);
        const text = await response.text();
        dimensions = parseGcodeBoundsComment(text.slice(0, 1000));
        if (!dimensions) {
            const points = parseGcodePath(text, Number.MAX_SAFE_INTEGER);
            if (points.length > 0) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const point of points) {
                    if (point.x < minX) minX = point.x;
                    if (point.x > maxX) maxX = point.x;
                    if (point.y < minY) minY = point.y;
                    if (point.y > maxY) maxY = point.y;
                }
                dimensions = { width: maxX - minX, height: maxY - minY };
            }
        }
    } catch (error) {
        console.error('G-code dimensions error:', error);
    }
    gcodeDimensionsCache.set(fileUrl, dimensions);
    return dimensions;
}

function formatGcodeDimensions(dimensions) {
    if (!dimensions) return '—';
    return `${dimensions.width.toFixed(0)} × ${dimensions.height.toFixed(0)} mm`;
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
    const material = new THREE.LineBasicMaterial({ color: 0x39e87a, linewidth: 2 });
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

// Miniatura de CNC en el Cotizador: NO reusa renderGcodeThumbnail/
// parseGcodePath — ese parser filtra segmentos por "potencia de láser" (S
// como on/off), y en G-code de CNC el S es RPM de husillo, siempre positivo
// y case casi nunca en cero, así que casi todo el corte real se descartaba
// (quedaba un trazo minúsculo, la mayoría del archivo en blanco). Reusa
// parseCncToolpath, el mismo parser ya usado en el visor CNC de verdad, que
// entiende G0/G1/G2/G3 sin ese supuesto.
async function renderCncGcodeThumbnail(thumb, fileUrl) {
    if (!thumb || !window.THREE || typeof window.THREE.Scene !== 'function') return;
    thumb.innerHTML = '';

    let text;
    try {
        const response = await fetch(fileUrl);
        text = await response.text();
    } catch (error) {
        console.error(error);
        thumb.innerHTML = `<div class="thumb-placeholder">G-code</div>`;
        return;
    }

    const toolpath = parseCncToolpath(text);
    if (!toolpath.cutPaths.length && !toolpath.rapidSegments.length) {
        thumb.innerHTML = `<div class="thumb-placeholder">G-code</div>`;
        return;
    }

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    thumb.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x888888, 1));

    const group = new THREE.Group();
    scene.add(group);

    if (toolpath.rapidSegments.length) {
        const geometry = new THREE.BufferGeometry().setFromPoints(toolpath.rapidSegments);
        const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });
        group.add(new THREE.LineSegments(geometry, material));
    }
    toolpath.cutPaths.forEach(path => {
        const geometry = new THREE.BufferGeometry().setFromPoints(path.points);
        const material = new THREE.LineBasicMaterial({ color: 0xf59e0b });
        group.add(new THREE.Line(geometry, material));
    });

    const box = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3();
    box.getCenter(center);
    group.position.sub(center);

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

// Miniatura real incrustada por el slicer (igual que Mainsail/Fluidd) en vez
// de re-renderizar la trayectoria — más fiel y mucho más barata de generar.
// Si el archivo no trae miniatura incrustada, cae de vuelta al render 3D.
function loadRealGcodeThumbnail(container, relPath, section, fallbackFileUrl) {
    container.innerHTML = '';
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => {
        if (fallbackFileUrl) renderGcodeThumbnail(container, fallbackFileUrl);
    };
    img.src = `/api/models/thumbnail?path=${encodeURIComponent(relPath)}&section=${encodeURIComponent(section)}`;
    container.appendChild(img);
}

async function renderGcodePreview(container, fileUrl) {
    if (!container || !window.THREE || typeof window.THREE.Scene !== 'function') return;
    container.innerHTML = '';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x081410);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x081410, 1);
    container.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x999999, 1.2));

    const line = await getGcodePreviewScene(fileUrl, 200000);
    if (!line) {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280;padding:1rem;text-align:center;">No se pudo generar la vista previa.</div>';
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

    const fileUrl = model.file_url;
    const extension = (fileUrl || '').toLowerCase();
    if (isGcodeFile(model) || GCODE_FILE_EXTENSIONS.some(ext => extension.endsWith(ext))) {
        // El visor de G-code dibuja sobre fondo blanco (como en la página de
        // G-code); el degradado oscuro es solo para el visor de modelos STL/3MF.
        previewImage.style.backgroundImage = 'none';
        previewImage.classList.add('gcode-mode');
        renderGcodePreview(previewImage, fileUrl);
        return;
    }

    previewImage.classList.remove('gcode-mode');
    previewImage.style.backgroundImage = 'linear-gradient(180deg, rgba(15,23,42,1) 0%, rgba(31,41,55,1) 100%)';

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

function hexToRgbTriplet(hex) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!match) return '34, 197, 94';
    const [, r, g, b] = match;
    return `${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}`;
}

function applyTheme(theme) {
    let resolvedTheme = theme === 'custom' && getCustomTheme() ? 'custom' : theme;
    if (!['dark', 'green', 'red', 'custom'].includes(resolvedTheme)) resolvedTheme = 'light';
    document.body.classList.remove('dark', 'green', 'red', 'custom', 'light');
    document.body.classList.add(resolvedTheme);
    document.body.setAttribute('data-theme', resolvedTheme);
    applyCustomThemeBackground();

    const colors = getThemeColors(resolvedTheme);
    document.documentElement.style.setProperty('--accent', colors.accent);
    document.documentElement.style.setProperty('--accent-rgb', hexToRgbTriplet(colors.accent));
    document.documentElement.style.setProperty('--surface', colors.surface);
    document.documentElement.style.setProperty('--text', colors.text);
    document.documentElement.style.setProperty('--text-muted', colors.muted);
    document.documentElement.style.setProperty('--text-secondary', colors.muted);
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
                red: '🔴',
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
    const fileCount = folder.file_count || 0;
    return `
        <tr class="folder-row" data-folder-path="${folder.path}">
            <td class="model-name" colspan="${colspan}">
                <svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <strong>${folder.name}</strong>
                <span class="folder-file-count">${fileCount}</span>
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

// ── Selección múltiple de archivos (gcode / model) para mover o eliminar en lote ──
const bulkSelectionState = { gcode: new Set(), model: new Set() };

function getBulkSelection(section) {
    return bulkSelectionState[section];
}

function sectionBulkPrefix(section) {
    return section === 'gcode' ? 'gcode' : 'models';
}

function renderBulkBar(section) {
    const prefix = sectionBulkPrefix(section);
    const selection = getBulkSelection(section);
    const bar = document.getElementById(`${prefix}-bulk-bar`);
    const countEl = document.getElementById(`${prefix}-bulk-count`);
    if (bar) bar.hidden = selection.size === 0;
    if (countEl) countEl.textContent = `${selection.size} ${t('filesSelected')}`;
}

function wireBulkSelection(section, container, files) {
    const prefix = sectionBulkPrefix(section);
    const selection = getBulkSelection(section);
    // Descarta ids de archivos que ya no están en la carpeta actual (se movieron/eliminaron/cambiaste de carpeta).
    const validIds = new Set(files.map(f => f.id));
    Array.from(selection).forEach(id => { if (!validIds.has(id)) selection.delete(id); });

    const selectAllCheckbox = document.getElementById(`${prefix}-select-all`);
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = files.length > 0 && files.every(f => selection.has(f.id));
        selectAllCheckbox.addEventListener('change', () => {
            if (selectAllCheckbox.checked) {
                files.forEach(f => selection.add(f.id));
            } else {
                files.forEach(f => selection.delete(f.id));
            }
            container.querySelectorAll('.row-select-checkbox').forEach(cb => { cb.checked = selectAllCheckbox.checked; });
            renderBulkBar(section);
        });
    }

    container.querySelectorAll('.row-select-checkbox').forEach(checkbox => {
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => {
            const id = checkbox.dataset.modelId;
            if (checkbox.checked) selection.add(id); else selection.delete(id);
            renderBulkBar(section);
        });
    });

    renderBulkBar(section);
}

function clearBulkSelection(section, reloadFn) {
    getBulkSelection(section).clear();
    renderBulkBar(section);
    if (reloadFn) reloadFn();
}

async function bulkDeleteSelected(section, allFiles, reloadFn) {
    const selection = getBulkSelection(section);
    if (!selection.size) return;
    if (!(await appConfirm(t('bulkDeleteConfirm'), t('delete'), 'danger'))) return;

    const targets = allFiles.filter(f => selection.has(f.id));
    for (const model of targets) {
        const relPath = stripSectionPrefix(model.id, section);
        try {
            await fetch(`/api/files?path=${encodeURIComponent(relPath)}&type=${section}`, { method: 'DELETE' });
        } catch (error) {
            console.error(error);
        }
    }
    selection.clear();
    renderBulkBar(section);
    reloadFn();
}

function bulkMoveSelected(section, allFiles, reloadFn) {
    const selection = getBulkSelection(section);
    if (!selection.size) return;
    const targets = allFiles.filter(f => selection.has(f.id));
    openMoveFileModal(section, targets, reloadFn, () => clearBulkSelection(section));
}

document.getElementById('gcode-bulk-move-btn')?.addEventListener('click', () => bulkMoveSelected('gcode', currentGcodeData.files, () => loadGcodeFolder(currentGcodePath)));
document.getElementById('gcode-bulk-delete-btn')?.addEventListener('click', () => bulkDeleteSelected('gcode', currentGcodeData.files, () => loadGcodeFolder(currentGcodePath)));
document.getElementById('gcode-bulk-clear-btn')?.addEventListener('click', () => clearBulkSelection('gcode', () => renderGcodeTable()));

document.getElementById('models-bulk-move-btn')?.addEventListener('click', () => bulkMoveSelected('model', currentModelsData.files, () => loadModelsFolder(currentModelsPath)));
document.getElementById('models-bulk-delete-btn')?.addEventListener('click', () => bulkDeleteSelected('model', currentModelsData.files, () => loadModelsFolder(currentModelsPath)));
document.getElementById('models-bulk-clear-btn')?.addEventListener('click', () => clearBulkSelection('model', () => renderModelsFullPage()));

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

function laserHistoryStateLabel(state) {
    if (state === 'completed') return t('completed');
    if (state === 'cancelled') return t('cancelled');
    return t('laserHistoryStateError');
}

function renderLaserHistory(jobs) {
    const container = document.getElementById('laser-history-list');
    if (!container) return;
    if (!jobs || !jobs.length) {
        container.innerHTML = `<div class="empty-state">${t('laserHistoryEmpty')}</div>`;
        return;
    }
    container.innerHTML = jobs.map(job => {
        const visualState = getJobVisualState(job.state);
        const hostLabel = laserHostLabel(job.host) || job.host;
        return `
            <div class="recent-job-card laser-history-card">
                <div class="recent-job-thumb">
                    ${job.snapshot
                        ? `<img src="${job.snapshot}" alt="" loading="lazy">`
                        : '<svg class="recent-job-thumb-fallback" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v6"/><path d="M5 22h14l-1.5-9h-11z"/><path d="M9 13v3"/><path d="M15 13v3"/></svg>'}
                </div>
                <div class="recent-job-info">
                    <div class="printer-status-line ${visualState}">
                        <span class="printer-status-dot ${visualState}"></span>${laserHistoryStateLabel(job.state)}
                    </div>
                    <h4 class="recent-job-name" title="${escapeHtml(job.filename || '')}">${escapeHtml(job.filename || '—')}</h4>
                    <div class="recent-job-meta">
                        <span>${escapeHtml(hostLabel)}</span>
                        <span>${formatDate(job.completed_at)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function loadLaserHistory() {
    const container = document.getElementById('laser-history-list');
    try {
        const response = await fetch('/api/laser/history?limit=50');
        if (!response.ok) throw new Error('No se pudo cargar el historial del láser');
        const data = await response.json();
        renderLaserHistory(data.jobs || []);
    } catch (error) {
        console.error(error);
        if (container) container.innerHTML = `<div class="empty-state">${t('errorLoadingModels')}</div>`;
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

    const folderRows = folders.map(folder => folderRowHtml(folder, 5)).join('');

    const fileRows = sortedFiles.map(model => {
        const isSelected = model.id === selectedGcodeId;
        const cachedDimensions = gcodeDimensionsCache.get(model.file_url);
        const checked = getBulkSelection('gcode').has(model.id) ? 'checked' : '';
        return `
            <tr class="${isSelected ? 'selected' : ''}" data-model-id="${model.id}">
                <td class="select-col"><input type="checkbox" class="row-select-checkbox" data-model-id="${model.id}" ${checked}></td>
                <td class="model-name">
                    <img class="cnc-files-thumb" loading="lazy" alt="" src="/api/gcode/thumbnail?path=${encodeURIComponent(stripSectionPrefix(model.id, 'gcode'))}&kind=printer">
                    <strong>${model.name}</strong>
                </td>
                <td><span class="tag-pill">MDF</span></td>
                <td>${formatSize(model.size)}</td>
                <td>${formatDate(model.modified)}</td>
                <td class="gcode-dimensions">${cachedDimensions !== undefined ? formatGcodeDimensions(cachedDimensions) : '…'}</td>
            </tr>
        `;
    }).join('');

    gcodeTable.innerHTML = `
        <table class="models-table">
            <thead>
                <tr>
                    <th class="select-col"><input type="checkbox" class="select-all-checkbox" id="gcode-select-all"></th>
                    <th>${t('columnName')}</th>
                    <th>${t('material')}</th>
                    <th>${t('columnSize')}</th>
                    <th>${t('columnDate')}</th>
                    <th>${t('columnDimensions')}</th>
                </tr>
            </thead>
            <tbody>${folderRows}${fileRows}</tbody>
        </table>
    `;

    wireFolderRows(gcodeTable, 'gcode', loadGcodeFolder);
    wireBulkSelection('gcode', gcodeTable, sortedFiles);

    gcodeTable.querySelectorAll('tbody tr[data-model-id]').forEach(row => {
        row.addEventListener('click', (event) => {
            if (event.target.closest('.row-select-checkbox')) return;
            const model = currentGcodeData.files.find(entry => entry.id === row.dataset.modelId);
            if (model) selectGcodePreview(model);
        });
    });

    sortedFiles.forEach(model => {
        if (gcodeDimensionsCache.has(model.file_url)) return;
        getGcodeDimensions(model.file_url).then(dimensions => {
            const row = gcodeTable.querySelector(`tbody tr[data-model-id="${model.id}"] .gcode-dimensions`);
            if (row) row.textContent = formatGcodeDimensions(dimensions);
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
        gcodePreviewScene.innerHTML = '';
        const relPath = stripSectionPrefix(model.id, 'gcode');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        // Miniatura PNG pre-generada (y cacheada en disco) del trazo 2D del
        // G-code — antes esto caía directo al render 3D en vivo (lento,
        // recalculaba la trayectoria completa cada vez que se seleccionaba
        // un archivo). El endpoint genera la PNG una sola vez y la reusa
        // mientras el archivo fuente no cambie (ver get_or_create_gcode_thumbnail).
        img.onerror = () => renderGcodePreview(gcodePreviewScene, fileUrl);
        img.src = `/api/gcode/thumbnail?path=${encodeURIComponent(relPath)}&kind=printer`;
        gcodePreviewScene.appendChild(img);
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

    const isGcode = isGcodeFile(model);

    modelModal.classList.add('active');
    document.getElementById('modal-filename').textContent = filename;

    const infoGroups = document.getElementById('modal-info-groups');
    if (infoGroups) infoGroups.hidden = isGcode;
    if (!isGcode) {
        document.getElementById('modal-tags').textContent = (model.tags || ['#modelo3D', '#impresion3D']).join(' ');
        document.getElementById('modal-material').textContent = model.material || 'PLA';
        document.getElementById('modal-time').textContent = model.estimated_time || formatEstimatedTime(model.estimated_time_minutes);
    }

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
        sendBtn.hidden = !isGcode;
        sendBtn.onclick = isGcode ? () => {
            closeModelModal();
            const relPath = stripSectionPrefix(model.id, 'model');
            openPrinterSendModal(relPath, model.name, 'model', model);
        } : null;
    }

    // Wait for the modal to render before initializing Three.js
    setTimeout(() => {
        initializeThreeViewer(modalViewer, fileUrl);
    }, 100);
}

function initializeThreeViewer(modalViewer, fileUrl) {
    const extension = (fileUrl || '').toLowerCase();
    const isGcode = GCODE_FILE_EXTENSIONS.some(ext => extension.endsWith(ext));
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

const mutedActivePrintPorts = new Set();
const ACTIVE_PRINT_RING_RADIUS = 38;
const ACTIVE_PRINT_RING_CIRCUMFERENCE = 2 * Math.PI * ACTIVE_PRINT_RING_RADIUS;

function formatSecondsShort(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '—';
    return formatEstimatedTime(Math.round(seconds / 60));
}

function activePrintCardHtml(printer) {
    const job = printer.job || {};
    const progress = job.progress || 0;
    const isPaused = job.state === 'paused';
    const port = printer.port;
    const muted = mutedActivePrintPorts.has(port);
    const dashOffset = ACTIVE_PRINT_RING_CIRCUMFERENCE * (1 - Math.min(100, progress) / 100);
    const layersLabel = (job.current_layer != null && job.total_layer != null)
        ? `${job.current_layer} / ${job.total_layer}`
        : '—';
    const estimatedTotal = job.estimated_time != null
        ? formatSecondsShort(job.estimated_time)
        : (job.print_duration != null && job.estimated_remaining != null
            ? formatSecondsShort(job.print_duration + job.estimated_remaining)
            : '—');

    return `
        <div class="active-print-card ${isPaused ? 'paused' : 'printing'}" data-port="${port}">
            <div class="active-print-body">
                <div class="active-print-col active-print-col-info">
                    <div class="active-print-card-title">${escapeHtml(printer.name || `Printer ${port}`)} — ${t('activePrintQueue')}</div>
                    <div class="active-print-thumb">
                        ${NOPAL_LOGO_SVG}
                        ${job.thumbnail_url ? `<img src="${job.thumbnail_url}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
                    </div>
                    <div class="active-print-info">
                        <h3 class="active-print-filename" title="${escapeHtml(job.filename || '')}">${escapeHtml(job.filename || '—')}</h3>
                        <div class="active-print-meta-row"><span>${t('activePrintLayerHeight')}</span><strong>${job.layer_height != null ? `${job.layer_height} mm` : '—'}</strong></div>
                        <div class="active-print-meta-row"><span>${t('activePrintFilament')}</span><strong>${job.filament_type ? escapeHtml(job.filament_type) : '—'}</strong></div>
                        <div class="active-print-meta-row"><span>${t('activePrintEstimatedTime')}</span><strong>${estimatedTotal}</strong></div>
                    </div>
                </div>
                <div class="active-print-col active-print-col-ring">
                    <div class="active-print-col-header">${t('activePrintProgressHeader')}</div>
                    <div class="active-print-ring-body">
                        <div class="active-print-ring">
                            <svg width="94" height="94" viewBox="0 0 94 94">
                                <circle class="active-print-ring-track" cx="47" cy="47" r="${ACTIVE_PRINT_RING_RADIUS}" fill="none" stroke-width="9"/>
                                <circle class="active-print-ring-fill" cx="47" cy="47" r="${ACTIVE_PRINT_RING_RADIUS}" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${ACTIVE_PRINT_RING_CIRCUMFERENCE}" stroke-dashoffset="${dashOffset}"/>
                            </svg>
                            <span class="active-print-ring-pct">${progress}%</span>
                        </div>
                        <div class="active-print-ring-stats">
                            <div class="active-print-stat-row"><span>${t('activePrintElapsed')}</span><strong>${formatSecondsShort(job.print_duration)}</strong></div>
                            <div class="active-print-stat-row"><span>${t('activePrintRemaining')}</span><strong>${formatSecondsShort(job.estimated_remaining)}</strong></div>
                            <div class="active-print-stat-row"><span>${t('activePrintSpeed')}</span><strong>${job.speed != null ? `${Math.round(job.speed)} mm/s` : '—'}</strong></div>
                            <div class="active-print-stat-row"><span>${t('activePrintLayers')}</span><strong>${layersLabel}</strong></div>
                        </div>
                    </div>
                </div>
                <div class="active-print-col active-print-col-actions">
                    <div class="active-print-col-header">${t('activePrintQuickControls')}</div>
                    <div class="active-print-actions-grid">
                        <button type="button" class="active-print-action-btn active-print-action-pause" data-action="${isPaused ? 'resume' : 'pause'}" data-port="${port}">
                            ${isPaused
                                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
                                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
                            <span>${isPaused ? t('activePrintResume') : t('activePrintPause')}</span>
                        </button>
                        <button type="button" class="active-print-action-btn active-print-action-stop" data-action="cancel" data-port="${port}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>
                            <span>${t('activePrintStop')}</span>
                        </button>
                        <button type="button" class="active-print-action-btn" data-action="cancel" data-port="${port}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            <span>${t('activePrintCancel')}</span>
                        </button>
                        <button type="button" class="active-print-action-btn" data-action="mute" data-port="${port}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${muted
                                ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
                                : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>'}</svg>
                            <span>${muted ? t('activePrintUnmute') : t('activePrintMute')}</span>
                        </button>
                    </div>
                    <button type="button" class="active-print-fullscreen-btn" data-action="fullscreen" data-port="${port}">
                        <span>${t('activePrintFullscreen')}</span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </button>
                </div>
            </div>
        </div>
    `;
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

    printQueue.innerHTML = activeJobs.map(activePrintCardHtml).join('');

    printQueue.querySelectorAll('.active-print-action-btn').forEach(btn => {
        btn.addEventListener('click', () => handleActivePrintAction(btn.dataset.action, Number(btn.dataset.port)));
    });
    printQueue.querySelectorAll('.active-print-fullscreen-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const printer = allPrinters.find(p => p.port === Number(btn.dataset.port));
            if (printer) openPrinterModal(printer);
        });
    });
}

async function handleActivePrintAction(action, port) {
    if (action === 'mute') {
        if (mutedActivePrintPorts.has(port)) {
            mutedActivePrintPorts.delete(port);
        } else {
            mutedActivePrintPorts.add(port);
        }
        renderPrintQueue();
        return;
    }
    if (action === 'pause') {
        await fetch(`/api/printers/${port}/pause`, { method: 'POST' });
        loadPrinters();
        return;
    }
    if (action === 'resume') {
        await fetch(`/api/printers/${port}/resume`, { method: 'POST' });
        loadPrinters();
        return;
    }
    if (action === 'cancel') {
        const confirmed = await appConfirm(t('activePrintCancelConfirm'), t('activePrintStop'), 'danger');
        if (!confirmed) return;
        await fetch(`/api/printers/${port}/cancel`, { method: 'POST' });
        loadPrinters();
    }
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
        // Encendido (target>0) = subiendo hacia el objetivo; apagado = bajando
        // por calor residual. Es el estado real del calentador, no el del
        // trabajo de impresión — antes decía "Inactivo" aunque estuviera
        // calentando de verdad.
        const stateLabel = sensor.kind === 'heater'
            ? (sensor.target > 0
                ? '<span class="temp-state-arrow temp-state-arrow-up">▲</span>'
                : '<span class="temp-state-arrow temp-state-arrow-down">▼</span>')
            : '';
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
                </div>
            </div>
            <div class="temp-card-body" id="temp-card-body">
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
    if (canvas) {
        requestAnimationFrame(() => drawTemperatureChart(canvas, seriesData, sensors));
    }

    container.querySelectorAll('.temp-target-input').forEach(input => {
        input.addEventListener('change', () => {
            const target = parseFloat(input.value) || 0;
            setTemperatureTarget(port, input.dataset.heater, target);
        });
    });

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

document.getElementById('temp-presets-modal-close')?.addEventListener('click', closeTempPresetsModal);

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
            </div>
            <div class="temp-card-body" id="toolhead-card-body">
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
                <div class="toolhead-speed-ticks">
                    <span>25%</span><span>50%</span><span>75%</span><span>100%</span><span>150%</span><span>200%</span>
                </div>
            </div>
        </div>
    `;

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
let printerModalQueueInterval = null;

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
    if (printerModalQueueInterval) {
        clearInterval(printerModalQueueInterval);
        printerModalQueueInterval = null;
    }
    const banner = document.getElementById('printer-modal-error-banner');
    if (banner) banner.hidden = true;
}

function renderPrinterErrorBanner(printer, stateValue) {
    const banner = document.getElementById('printer-modal-error-banner');
    if (!banner) return;

    const errorStates = ['error', 'shutdown', 'disconnected'];
    if (!errorStates.includes(stateValue) || !printer.port) {
        banner.hidden = true;
        return;
    }

    const port = printer.port;
    const message = printer.printer_info?.state_message || '';
    const titleEl = document.getElementById('printer-error-banner-title');
    const messageEl = document.getElementById('printer-error-banner-message');
    const klippyLogBtn = document.getElementById('printer-error-klippy-log-btn');
    const moonrakerLogBtn = document.getElementById('printer-error-moonraker-log-btn');
    const restartBtn = document.getElementById('printer-error-restart-btn');
    const firmwareRestartBtn = document.getElementById('printer-error-firmware-restart-btn');

    if (titleEl) titleEl.textContent = `${t('printerReportsKlipper')}: ${stateValue.toUpperCase()}`;
    if (messageEl) messageEl.textContent = message;

    const logHost = window.location.hostname;
    if (klippyLogBtn) klippyLogBtn.href = `http://${logHost}:${port}/server/files/logs/klippy.log`;
    if (moonrakerLogBtn) moonrakerLogBtn.href = `http://${logHost}:${port}/server/files/logs/moonraker.log`;

    if (restartBtn) {
        restartBtn.onclick = async () => {
            if (!(await appConfirm(t('printerRestartConfirm'), t('printerRestart'), 'warning'))) return;
            try {
                await fetch(`/api/printers/${port}/restart`, { method: 'POST' });
                showToast(t('printerRestart'));
                setTimeout(() => openPrinterModal(printer), 2000);
            } catch (error) {
                console.error(error);
            }
        };
    }
    if (firmwareRestartBtn) {
        firmwareRestartBtn.onclick = async () => {
            if (!(await appConfirm(t('printerFirmwareRestartConfirm'), t('printerFirmwareRestart'), 'warning'))) return;
            try {
                await fetch(`/api/printers/${port}/firmware-restart`, { method: 'POST' });
                showToast(t('printerFirmwareRestart'));
                setTimeout(() => openPrinterModal(printer), 3000);
            } catch (error) {
                console.error(error);
            }
        };
    }

    banner.hidden = false;
}

function printerQueueJobLabel(job) {
    return job.filename || job.job_id || '—';
}

async function loadPrinterQueue(port) {
    const container = document.getElementById('printer-modal-queue');
    if (!container) return;
    try {
        const response = await fetch(`/api/printers/${port}/queue`);
        if (!response.ok) throw new Error('No se pudo cargar la cola de impresión');
        const data = await response.json();
        renderPrinterQueueCard(port, data);
    } catch (error) {
        console.error(error);
    }
}

function renderPrinterQueueCard(port, data) {
    const container = document.getElementById('printer-modal-queue');
    if (!container) return;
    const jobs = data?.queued_jobs || [];
    const printer = (allPrinters || []).find(p => p.port === port);
    const job = printer?.job;
    const hasActiveJob = job && (job.state === 'printing' || job.state === 'paused');
    const isEmpty = !hasActiveJob && !jobs.length;

    const activeJobHtml = hasActiveJob ? `
        <div class="printer-send-file-card printer-queue-active-card">
            <div class="printer-send-file-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span data-i18n="fileTypeGcode">GCODE</span>
            </div>
            <div class="printer-send-file-meta">
                <div class="printer-send-file-name" title="${escapeHtml(job.filename || '')}">${escapeHtml(job.filename || '—')}</div>
                <div class="printer-send-file-details">${[
                    job.file_size_mb != null ? `${job.file_size_mb} MB` : null,
                    job.current_layer != null && job.total_layer != null ? `${t('activePrintLayers')} ${job.current_layer}/${job.total_layer}` : null,
                    job.modified_at ? formatDate(job.modified_at) : null,
                ].filter(Boolean).join(' · ')}</div>
            </div>
            <div class="printer-send-file-thumb">${job.thumbnail_url ? `<img src="${job.thumbnail_url}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}</div>
        </div>
        <div class="printer-queue-active-progress">
            <div class="printer-queue-active-progress-bar">
                <div class="printer-queue-active-progress-fill" style="width:${job.progress || 0}%"></div>
            </div>
            <span class="printer-queue-active-progress-pct">${job.progress || 0}%</span>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger" id="printer-queue-cancel-active-btn" title="${t('activePrintCancel')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    ` : '';

    const totalFiles = (hasActiveJob ? 1 : 0) + jobs.length;
    const totalTime = hasActiveJob && job.estimated_remaining != null ? formatSecondsShort(job.estimated_remaining) : '—';

    container.innerHTML = `
        <div class="temp-card printer-queue-card">
            <div class="temp-card-header">
                <div class="temp-card-header-left">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                    <span>${t('printerQueueTitle')}</span>
                </div>
                ${data.queue_state !== 'ready' ? `
                    <button type="button" class="temp-preset-pill" id="printer-queue-start-btn">${t('printerQueueStart')}</button>
                ` : ''}
            </div>
            <div class="temp-card-body">
                ${isEmpty ? `<div class="empty-state-small">${t('noActivePrints')}</div>` : `
                ${activeJobHtml}
                <div class="printer-queue-list">
                    ${jobs.map(job => `
                        <div class="printer-queue-item">
                            <span class="printer-queue-item-drag">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
                            </span>
                            <div class="printer-queue-item-info">
                                <span class="printer-queue-item-name">${escapeHtml(printerQueueJobLabel(job))}</span>
                                <span class="printer-queue-item-state">${t('printerQueueWaiting')}</span>
                            </div>
                            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger" data-job-id="${escapeHtml(job.job_id || '')}" title="${t('laserQueueRemove')}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        </div>
                    `).join('')}
                </div>
                <div class="printer-queue-summary">
                    <div><span>${t('printerQueueTotalFiles')}</span><strong>${t('printerQueueFilesCount').replace('{count}', totalFiles)}</strong></div>
                    <div><span>${t('printerQueueTotalTime')}</span><strong>${totalTime}</strong></div>
                    <div><span>${t('printerQueueTotalFilament')}</span><strong>—</strong></div>
                </div>
                `}
            </div>
        </div>
    `;

    container.querySelectorAll('.printer-queue-item button[data-job-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await fetch(`/api/printers/${port}/queue/${encodeURIComponent(btn.dataset.jobId)}`, { method: 'DELETE' });
                loadPrinterQueue(port);
            } catch (error) {
                console.error(error);
            }
        });
    });

    document.getElementById('printer-queue-start-btn')?.addEventListener('click', async () => {
        try {
            await fetch(`/api/printers/${port}/queue/start`, { method: 'POST' });
            loadPrinterQueue(port);
        } catch (error) {
            console.error(error);
        }
    });

    document.getElementById('printer-queue-cancel-active-btn')?.addEventListener('click', async () => {
        const confirmed = await appConfirm(t('activePrintCancelConfirm'), t('activePrintStop'), 'danger');
        if (!confirmed) return;
        await fetch(`/api/printers/${port}/cancel`, { method: 'POST' });
        loadPrinterQueue(port);
    });
}

// Actualiza el encabezado del modal (nombre, punto/estado, imagen, banner de
// error) a partir del último objeto printer conocido. Se llama al abrir el
// modal Y en cada poll de temperaturas mientras sigue abierto — antes solo se
// llamaba una vez al abrir, así que si la impresora pasaba de inactiva a
// imprimiendo con el modal ya abierto, el encabezado se quedaba "Inactivo"
// aunque las tarjetas de temperatura ya mostraran "Imprimiendo".
function refreshPrinterModalHeader(printer) {
    const stateValue = getPrinterEffectiveStateValue(printer);
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
    const queueContainer = document.getElementById('printer-modal-queue');

    if (modalContent) modalContent.className = `modal-content printer-modal-content ${visualState}`;
    if (modalImage) modalImage.src = PRINTER_STATE_IMAGES[visualState];
    if (modalName) modalName.textContent = printerName;
    if (modalStatusLine) modalStatusLine.className = `printer-status-line ${visualState}`;
    if (modalStatusDot) modalStatusDot.className = `printer-status-dot ${visualState}`;
    if (modalStatusText) modalStatusText.textContent = stateDisplay;

    renderPrinterErrorBanner(printer, stateValue);
    // Con Klipper en error/shutdown, Toolhead/Temperaturas/Cola no tienen
    // datos reales que mostrar (el firmware no está corriendo) — se ocultan
    // y solo queda visible el banner de error con sus acciones.
    const printerErrorStates = ['error', 'shutdown', 'disconnected'];
    const isPrinterInError = printerErrorStates.includes(stateValue);
    const modalBody = document.querySelector('.printer-modal-body');
    if (modalBody) modalBody.hidden = isPrinterInError;
    if (queueContainer) queueContainer.hidden = isPrinterInError;

    return { stateValue, isPrinterInError };
}

async function openPrinterModal(printer) {
    if (!printerModal) return;

    const statsContainer = document.getElementById('printer-modal-stats');
    const temperaturesContainer = document.getElementById('printer-modal-temperatures');
    const toolheadContainer = document.getElementById('printer-modal-toolhead');
    const queueContainer = document.getElementById('printer-modal-queue');

    if (statsContainer) statsContainer.innerHTML = `<div class="empty-state-small">${t('noSystemStats')}</div>`;
    if (temperaturesContainer) temperaturesContainer.innerHTML = '';
    if (toolheadContainer) toolheadContainer.innerHTML = '';
    if (queueContainer) queueContainer.innerHTML = '';

    const { isPrinterInError } = refreshPrinterModalHeader(printer);

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

    if (printer.port && !isPrinterInError) {
        const port = printer.port;
        loadPrinterTemperatures(port);
        printerModalTemperatureInterval = setInterval(() => {
            const latest = allPrinters.find(p => p.port === port);
            if (latest) refreshPrinterModalHeader(latest);
            loadPrinterTemperatures(port);
        }, 4000);
        loadPrinterToolhead(port);
        printerModalToolheadInterval = setInterval(() => loadPrinterToolhead(port), 3000);
        loadPrinterQueue(port);
        printerModalQueueInterval = setInterval(() => loadPrinterQueue(port), 5000);
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
        [printersGrid, lasersGrid, cncGrid].forEach(grid => {
            if (grid) grid.innerHTML = `<div class="empty-state">${t('errorLoadingModels')}</div>`;
        });
    }
}

const PRINTER_STATE_IMAGES = {
    printing: '/static/img/printer_ready.png',
    paused: '/static/img/printer_atencion.png',
    error: '/static/img/printer_Alert.png',
    idle: '/static/img/printer_ready.png',
    heating: '/static/img/printer_atencion.png',
};

function getPrinterVisualState(stateValue, isOnline) {
    if (stateValue === 'printing') return 'printing';
    if (stateValue === 'paused') return 'paused';
    if (!isOnline || ['error', 'shutdown', 'disconnected'].includes(stateValue)) return 'error';
    return 'idle';
}

// `printer.state`/`printer.printer_info.state` es el estado de Klipper como
// software (ready/error/shutdown) — sigue siendo "ready" mientras imprime,
// eso NO cambia con el trabajo. El estado real del trabajo vive aparte en
// `printer.job.state` (printing/paused/complete/standby). Antes toda la app
// leía solo el primero, así que todo se veía "Inactivo" mientras imprimía.
function getPrinterEffectiveStateValue(printer) {
    const jobState = (printer.job?.state || '').toString().toLowerCase();
    if (jobState === 'printing' || jobState === 'paused') return jobState;
    return (printer.state || printer.printer_info?.state || '').toString().toLowerCase();
}

function printerIllustrationImg(visualState) {
    return `<img src="${PRINTER_STATE_IMAGES[visualState]}" alt="" loading="lazy">`;
}

const PRINTER_STATUS_SORT_ORDER = { printing: 0, paused: 1, error: 2, idle: 3 };

function getPrinterSortPriority(printer) {
    const stateValue = getPrinterEffectiveStateValue(printer);
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

// Mismo código de colores que las tarjetas del dashboard: verde=impresora,
// morado=láser, ámbar=CNC.
function getDeviceKindColor(kind) {
    if (kind === 'cnc') return 'var(--orange)';
    if (kind === '3d' || kind === 'printer') return '#22c55e';
    return '#8b5cf6';
}

function laserDashboardSortPriority(status) {
    const visualState = getLaserVisualState(status);
    if (visualState === 'offline') return 4;
    return PRINTER_STATUS_SORT_ORDER[visualState] ?? 3;
}

function laserDashboardCardHtml(entry) {
    const { host, status, kind } = entry;
    const visualState = getLaserVisualState(status);
    const isOnline = visualState !== 'offline';
    const statusText = isOnline ? t('online') : t('offline');
    const stateLabel = isOnline ? (status.state || t('idle')) : t('laserOffline');
    const position = isOnline ? `X${status.x.toFixed(1)} Y${status.y.toFixed(1)} Z${status.z.toFixed(1)}` : '—';
    // Marlin no reporta feed/velocidad realtime (feed/speed llegan null).
    const feedSpeed = isOnline && status.feed != null && status.speed != null ? `${status.feed} / ${status.speed}` : '—';
    const hostLabel = laserHostLabel(host);
    const typeLabel = kind === 'cnc' ? t('cnc') : t('laser');
    const typeClass = kind === 'cnc' ? 'printer-card-type-cnc' : 'printer-card-type-laser';

    return `
        <div class="printer-card ${typeClass} laser-dashboard-card ${isOnline ? 'online' : 'offline'} ${visualState}" data-laser-host="${escapeHtml(host)}">
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${hostLabel ? escapeHtml(hostLabel) : typeLabel}</h3>
                    ${hostLabel ? `<p class="printer-name-sub">${typeLabel}</p>` : ''}
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
                return { host: laser.host, status, kind: laser.kind || 'laser' };
            } catch (error) {
                return { host: laser.host, status: { connected: false }, kind: laser.kind || 'laser' };
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

// ── Alertas sonoras y notificaciones nativas (trabajos de impresión/láser) ──
const ALERT_SOUNDS = {
    success: '/static/audio/success.mp3',
    error: '/static/audio/error.mp3',
    warning: '/static/audio/warning.mp3',
};

function isSoundAlertsEnabled() {
    return localStorage.getItem('soundAlertsEnabled') === 'true';
}

function playAlertSound(tone) {
    if (!isSoundAlertsEnabled()) return;
    const src = ALERT_SOUNDS[tone] || ALERT_SOUNDS.warning;
    try {
        const audio = new Audio(src);
        audio.play().catch(() => {});
    } catch (error) {
        console.error(error);
    }
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// La notificación nativa del navegador solo se dispara si la pestaña no está
// enfocada (si el usuario ya está mirando la app sería redundante), pero el
// globo en pantalla y el flash del título de la pestaña se muestran siempre
// que suena una alerta — así queda claro por qué sonó, esté o no enfocada.
const ORIGINAL_TAB_TITLE = document.title;
let tabTitleFlashTimeout = null;

function flashBrowserTabTitle(text) {
    if (tabTitleFlashTimeout) clearTimeout(tabTitleFlashTimeout);
    document.title = `🔔 ${text}`;
    tabTitleFlashTimeout = setTimeout(() => {
        document.title = ORIGINAL_TAB_TITLE;
        tabTitleFlashTimeout = null;
    }, 5000);
}

function notifyUser(title, body, tone = 'warning') {
    playAlertSound(tone);
    if (!isSoundAlertsEnabled()) return;
    const toastTone = tone === 'error' ? 'error' : tone === 'success' ? 'success' : 'warning';
    showToast(body ? `${title}: ${body}` : title, toastTone);
    flashBrowserTabTitle(title);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try {
            new Notification(title, { body, icon: '/static/img/favicon.ico' });
        } catch (error) {
            console.error(error);
        }
    }
}

function updatePrintersViewMode(mode) {
    printersViewMode = mode;
    localStorage.setItem('printersViewMode', mode);
    [printersGrid, lasersGrid, cncGrid].forEach(grid => {
        if (grid) grid.classList.toggle('list-view', mode === 'list');
    });
    const gridBtn = document.getElementById('view-grid-printers');
    const listBtn = document.getElementById('view-list-printers');
    if (gridBtn) gridBtn.classList.toggle('btn-view-toggle-active', mode === 'grid');
    if (listBtn) listBtn.classList.toggle('btn-view-toggle-active', mode === 'list');
}

const printerJobLastState = new Map(); // port -> último job.state visto, para detectar transiciones

function checkPrinterJobTransitions(printers) {
    (printers || []).forEach(printer => {
        const port = printer.port;
        const jobState = printer.job?.state || '';
        if (!jobState || port == null) return;
        const previous = printerJobLastState.get(port);
        if (jobState !== previous) {
            // No avisar en el primer poll tras cargar la página — solo en
            // transiciones que ocurren mientras la app ya está abierta.
            if (previous != null) {
                const printerName = printer.name || `Printer ${port}`;
                if (jobState === 'complete') {
                    notifyUser(t('printerJobCompleteTitle'), printerName, 'success');
                } else if (jobState === 'error') {
                    notifyUser(t('printerJobErrorTitle'), printerName, 'error');
                }
            }
            printerJobLastState.set(port, jobState);
        }
    });
}

const printerConnLastState = new Map(); // port -> último online/offline visto, para avisar conexión/desconexión
const laserConnLastState = new Map(); // host -> último online/offline visto

function checkPrinterConnectionTransitions(printers) {
    (printers || []).forEach(printer => {
        const port = printer.port;
        if (port == null) return;
        const stateValue = getPrinterEffectiveStateValue(printer);
        const isOnline = printer.status === 'online' || ['ready', 'printing', 'paused', 'busy', 'standby'].includes(stateValue);
        const previous = printerConnLastState.get(port);
        if (isOnline !== previous) {
            if (previous != null) {
                const printerName = printer.name || `Printer ${port}`;
                if (isOnline) {
                    notifyUser(t('deviceConnectedTitle'), printerName, 'success');
                } else {
                    notifyUser(t('deviceDisconnectedTitle'), printerName, 'warning');
                }
            }
            printerConnLastState.set(port, isOnline);
        }
    });
}

function checkLaserConnectionTransitions(laserEntries) {
    (laserEntries || []).forEach(entry => {
        const host = entry.host;
        if (!host) return;
        const isOnline = getLaserVisualState(entry.status) !== 'offline';
        const previous = laserConnLastState.get(host);
        if (isOnline !== previous) {
            if (previous != null) {
                const laserName = laserHostLabel(host);
                if (isOnline) {
                    notifyUser(t('deviceConnectedTitle'), laserName, 'success');
                } else {
                    notifyUser(t('deviceDisconnectedTitle'), laserName, 'warning');
                }
            }
            laserConnLastState.set(host, isOnline);
        }
    });
}

function renderPrinters(printersInput) {
    if (!printersGrid) return;

    [printersGrid, lasersGrid, cncGrid].forEach(grid => {
        if (grid) grid.classList.toggle('list-view', printersViewMode === 'list');
    });
    const showOffline = isShowOfflineMachinesEnabled();
    const printers = printersInput || [];
    checkPrinterJobTransitions(printers);
    checkPrinterConnectionTransitions(printers);
    checkLaserConnectionTransitions(dashboardLaserEntries);

    const printerEntries = printers.map(printer => {
        const stateValue = getPrinterEffectiveStateValue(printer);
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

        // Un calentador con target>0 sigue "trabajando" aunque Klipper diga
        // idle (no hay trabajo activo) — antes la ficha decía "Inactivo" con
        // fondo neutro mientras precalentaba de verdad.
        const bedTarget = data.heater_bed && typeof data.heater_bed.target === 'number' ? data.heater_bed.target : 0;
        const extruderTarget = data.extruder && typeof data.extruder.target === 'number' ? data.extruder.target : 0;
        const isHeating = visualState === 'idle' && (bedTarget > 0 || extruderTarget > 0);
        const displayState = isHeating ? 'heating' : visualState;
        const displayStateText = isHeating ? t('heating') : stateDisplay;

        const BED_MAX_TEMP = 110;
        const EXTRUDER_MAX_TEMP = 260;
        const bedPercent = typeof bedTemp === 'number' ? Math.min(100, Math.round((bedTemp / BED_MAX_TEMP) * 100)) : 0;
        const extruderPercent = typeof extruderTemp === 'number' ? Math.min(100, Math.round((extruderTemp / EXTRUDER_MAX_TEMP) * 100)) : 0;

        const printerName = printer.name || printer.printer_info?.name || printer.printer_info?.hostname || `Printer ${printer.port || ''}`;
        const jobProgress = printer.job && typeof printer.job.progress === 'number' ? printer.job.progress : 0;
        const jobRemainingMinutes = printer.job && printer.job.estimated_remaining != null ? Math.round(printer.job.estimated_remaining / 60) : null;
        const portKey = String(printer.port);
        if (dashboardPrinterThemeMode.get(portKey) === 'cool') {
            const stillCooling = (typeof bedTemp === 'number' && bedTemp > 40) || (typeof extruderTemp === 'number' && extruderTemp > 40);
            if (!stillCooling) dashboardPrinterThemeMode.delete(portKey);
        }
        const themeMode = visualState === 'idle' ? dashboardPrinterThemeMode.get(portKey) : null;
        const themeModeClass = themeMode ? ` printer-card-${themeMode}` : '';

        const html = `
            <div class="printer-card printer-card-type-3d ${normalizedStatus} ${displayState}${themeModeClass}" data-port="${printer.port}">
                <div class="printer-card-top">
                    <div>
                        <h3 class="printer-name">${escapeHtml(printerName)}</h3>
                        <p class="printer-name-sub">${t('printerType3D')}</p>
                    </div>
                    <div class="printer-quick-actions">
                        ${visualState === 'idle' ? `
                            <button type="button" class="printer-quick-action-btn" data-quick-action="cool" data-port="${printer.port}" title="${t('tempCool')}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
                            </button>
                            <button type="button" class="printer-quick-action-btn printer-quick-action-btn-accent" data-quick-action="preheat" data-port="${printer.port}" title="${t('tempPreset')}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z"/><path d="M12 18a3.75 3.75 0 0 0 .495-7.468 5.99 5.99 0 0 0-1.925 3.547 5.975 5.975 0 0 1-2.133-1.001A3.75 3.75 0 0 0 12 18Z"/></svg>
                            </button>
                        ` : ''}
                        <div class="printer-status-icon ${normalizedStatus}" title="${statusText}">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
                            </svg>
                        </div>
                    </div>
                </div>

                <div class="printer-status-line ${displayState}">
                    <span class="printer-status-dot ${displayState}"></span>${displayStateText}
                </div>

                <div class="printer-illustration printer-illustration-${displayState}">
                    ${printerIllustrationImg(displayState)}
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
                            <span>${jobProgress}% ${t('printed')}</span>
                            <span>${jobRemainingMinutes != null ? formatEstimatedTime(jobRemainingMinutes) : '—'}</span>
                        </div>
                        <div class="temp-progress"><div class="temp-progress-fill" style="width: ${jobProgress}%"></div></div>
                    </div>
                ` : ''}
            </div>
        `;

        return { isOnline, sortPriority: getPrinterSortPriority(printer), html };
    });

    const laserOnlyEntries = dashboardLaserEntries.filter(entry => (entry.kind || 'laser') !== 'cnc').map(entry => {
        const isOnline = getLaserVisualState(entry.status) !== 'offline';
        return {
            isOnline,
            sortPriority: laserDashboardSortPriority(entry.status),
            html: laserDashboardCardHtml(entry),
        };
    });

    const cncEntries = dashboardLaserEntries.filter(entry => entry.kind === 'cnc').map(entry => {
        const isOnline = getLaserVisualState(entry.status) !== 'offline';
        return {
            isOnline,
            sortPriority: laserDashboardSortPriority(entry.status),
            html: laserDashboardCardHtml(entry),
        };
    });

    const renderColumn = (grid, entries, emptyKey) => {
        if (!grid) return;
        let filtered = showOffline ? entries : entries.filter(entry => entry.isOnline);
        filtered = [...filtered].sort((a, b) => a.sortPriority - b.sortPriority);
        grid.innerHTML = filtered.length
            ? filtered.map(entry => entry.html).join('')
            : `<div class="empty-state">${t(emptyKey)}</div>`;
    };

    renderColumn(printersGrid, printerEntries, 'noPrintersFound');
    renderColumn(lasersGrid, laserOnlyEntries, 'noLasersFound');
    renderColumn(cncGrid, cncEntries, 'noCncFound');

    const columnsRoot = machinesColumns || printersGrid;

    columnsRoot.querySelectorAll('.printer-card[data-port]').forEach(card => {
        card.addEventListener('click', () => {
            const port = Number(card.dataset.port);
            const printer = allPrinters.find(p => p.port === port);
            if (printer) openPrinterModal(printer);
        });
    });

    columnsRoot.querySelectorAll('.printer-card[data-laser-host]').forEach(card => {
        card.addEventListener('click', async () => {
            const host = card.dataset.laserHost;
            try {
                const formData = new FormData();
                formData.append('host', host);
                await fetch('/api/laser/host', { method: 'POST', body: formData });
            } catch (error) {
                console.error(error);
            }
            switchSection(card.classList.contains('printer-card-type-cnc') ? 'cnc' : 'laser');
        });
    });

    columnsRoot.querySelectorAll('.printer-quick-action-btn').forEach(btn => {
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
            const stateValue = getPrinterEffectiveStateValue(printer);
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
        <td class="select-col"></td>
        <td class="model-name" colspan="9">
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

    function uploadOneFile(file) {
        return new Promise(resolve => {
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
                if (!(xhr.status >= 200 && xhr.status < 300)) {
                    if (row) row.remove();
                    appAlert(`No se pudo subir "${file.name}".`, '', 'danger');
                }
                resolve();
            });

            xhr.addEventListener('error', () => {
                if (row) row.remove();
                appAlert(`No se pudo subir "${file.name}".`, '', 'danger');
                resolve();
            });

            xhr.send(formData);
        });
    }

    input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;

        // Uno por vez (no en paralelo) para que la barra de progreso de cada
        // fila tenga sentido y no se sature el endpoint con varias subidas
        // grandes a la vez.
        for (const file of files) {
            await uploadOneFile(file);
        }
        input.value = '';
        loadModels();
        onDone();
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

function openMoveFileModal(section, modelOrModels, reloadFn, clearSelection) {
    if (!modelOrModels) return;
    const models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
    if (!models.length) return;
    moveFileSection = section;
    moveFileTargetModel = models;
    moveFileReloadFn = reloadFn;
    moveFileClearSelection = clearSelection;

    const nameEl = document.getElementById('move-file-current-name');
    if (nameEl) nameEl.textContent = models.length === 1 ? models[0].name : `${models.length} ${t('filesSelected')}`;

    const startPath = stripSectionPrefix(models[0].id, section).split('/').slice(0, -1).join('/');
    loadMoveFileFolder(startPath);

    const modal = document.getElementById('move-file-modal');
    if (modal) modal.classList.add('active');
}

async function confirmMoveFile() {
    const targets = moveFileTargetModel;
    if (!targets || !targets.length) return;

    let failed = 0;
    for (const model of targets) {
        const relPath = stripSectionPrefix(model.id, moveFileSection);
        const formData = new FormData();
        formData.append('path', relPath);
        formData.append('destination', moveFileBrowsePath);
        formData.append('type', moveFileSection);
        try {
            const response = await fetch('/api/files/move', { method: 'POST', body: formData });
            if (!response.ok) failed++;
        } catch (error) {
            console.error(error);
            failed++;
        }
    }

    closeMoveFileModal();
    if (moveFileClearSelection) moveFileClearSelection();
    if (moveFileReloadFn) moveFileReloadFn();
    if (failed) appAlert(t('bulkMovePartialError').replace('{n}', failed), '', 'danger');
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

// ── Enviar G-code a impresora 3D (imprimir ahora, cola nativa de Moonraker o programada) ──
let printerSendTarget = null;
let printerSendSelectedPort = null;
let printerSendMode = 'now';

function renderPrinterSendPicker(selectedPort) {
    const container = document.getElementById('printer-send-picker');
    if (!container) return;
    if (!allPrinters.length) {
        container.innerHTML = `<div class="empty-state-small">${t('noPrintersFound')}</div>`;
        return;
    }
    const validPorts = allPrinters.map(p => p.port);
    const onlinePorts = allPrinters.filter(p => p.status === 'online').map(p => p.port);
    // Preferir el puerto ya elegido, si sigue siendo válido; si no, la primera
    // impresora en línea (evita mandar por defecto a una apagada/offline).
    const nextPort = (selectedPort && validPorts.includes(selectedPort))
        ? selectedPort
        : (onlinePorts[0] ?? validPorts[0]);
    printerSendSelectedPort = nextPort;

    container.innerHTML = allPrinters.map(printer => {
        const name = getPrinterDisplayName(printer);
        const isOnline = printer.status === 'online';
        const active = printer.port === nextPort ? ' active' : '';
        const offlineClass = isOnline ? '' : ' offline';
        const stateValue = getPrinterEffectiveStateValue(printer);
        const isBusy = isOnline && (stateValue === 'printing' || stateValue === 'paused');
        const busyClass = isBusy ? ' busy' : '';
        const stateKey = stateValue === 'ready' ? 'idle' : stateValue;
        const stateDisplay = t(stateKey) !== stateKey ? t(stateKey) : (stateValue || t('idle'));
        const statusLine = isOnline ? `${t('online')} · ${stateDisplay}` : t('offline');
        return `
            <button type="button" class="printer-send-row${active}${offlineClass}${busyClass}" data-port="${printer.port}" data-busy="${isBusy ? '1' : '0'}">
                <span class="printer-send-row-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                </span>
                <span class="printer-send-row-info">
                    <span class="printer-send-row-name">${escapeHtml(name)}</span>
                    <span class="printer-send-row-status"><span class="printer-send-row-status-dot"></span>${escapeHtml(statusLine)}</span>
                </span>
                <span class="printer-send-row-pill">${isOnline ? t('online') : t('offline')}</span>
                <span class="printer-send-row-radio"><span class="printer-send-row-radio-dot"></span></span>
            </button>
        `;
    }).join('');

    container.querySelectorAll('.printer-send-row').forEach(btn => {
        btn.addEventListener('click', () => {
            printerSendSelectedPort = parseInt(btn.dataset.port, 10);
            container.querySelectorAll('.printer-send-row').forEach(el => {
                el.classList.toggle('active', parseInt(el.dataset.port, 10) === printerSendSelectedPort);
            });
            updatePrinterSendBusyWarning();
        });
    });

    updatePrinterSendBusyWarning();
}

function updatePrinterSendBusyWarning() {
    const warningEl = document.getElementById('printer-send-busy-warning');
    const warningTextEl = document.getElementById('printer-send-busy-warning-text');
    const primaryBtn = document.getElementById('printer-send-primary-btn');
    if (!warningEl) return;

    const selectedPrinter = allPrinters.find(p => p.port === printerSendSelectedPort);
    const stateValue = selectedPrinter ? getPrinterEffectiveStateValue(selectedPrinter) : '';
    const isBusy = selectedPrinter?.status === 'online' && (stateValue === 'printing' || stateValue === 'paused');

    warningEl.hidden = !isBusy;
    if (isBusy && warningTextEl) {
        warningTextEl.textContent = stateValue === 'paused' ? t('printerSendBusyPausedWarning') : t('printerSendBusyWarning');
    }
    if (primaryBtn) primaryBtn.disabled = isBusy && printerSendMode === 'now';
}

function setPrinterSendMode(mode) {
    printerSendMode = mode;
    document.querySelectorAll('.printer-send-mode-card').forEach(card => {
        card.classList.toggle('active', card.dataset.mode === mode);
    });
    const scheduleField = document.getElementById('printer-send-schedule-field');
    if (scheduleField) scheduleField.hidden = mode !== 'schedule';
    const primaryIcon = document.getElementById('printer-send-primary-icon');
    const primaryLabel = document.getElementById('printer-send-primary-label');
    if (mode === 'schedule') {
        if (primaryIcon) primaryIcon.innerHTML = '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>';
        if (primaryLabel) primaryLabel.textContent = t('printerSendModeScheduleTitle');
    } else {
        if (primaryIcon) primaryIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
        if (primaryLabel) primaryLabel.textContent = t('printNow');
    }
    updatePrinterSendBusyWarning();
}

document.querySelectorAll('.printer-send-mode-card').forEach(card => {
    card.addEventListener('click', () => setPrinterSendMode(card.dataset.mode));
});

function openPrinterSendModal(relPath, filename, section = 'model', model = null) {
    printerSendTarget = { path: relPath, filename, section };
    document.getElementById('printer-send-modal')?.classList.add('active');
    const filenameEl = document.getElementById('printer-send-filename');
    if (filenameEl) filenameEl.textContent = filename;

    const detailsEl = document.getElementById('printer-send-filedetails');
    const thumbEl = document.getElementById('printer-send-thumb');
    if (thumbEl) thumbEl.innerHTML = '';
    if (model) {
        if (detailsEl) detailsEl.textContent = `${formatSize(model.size)} · ${formatDate(model.modified)}`;
        if (model.file_url) {
            getGcodeLineCount(model.file_url).then(count => {
                if (detailsEl && count != null) {
                    detailsEl.textContent = t('printerSendFileMeta')
                        .replace('{size}', formatSize(model.size))
                        .replace('{lines}', count.toLocaleString())
                        .replace('{date}', formatDate(model.modified));
                }
            });
            if (thumbEl) loadRealGcodeThumbnail(thumbEl, relPath, section, model.file_url);
        }
    } else if (detailsEl) {
        detailsEl.textContent = '';
    }

    setPrinterSendMode('now');
    const scheduleInput = document.getElementById('printer-send-schedule-input');
    if (scheduleInput) scheduleInput.value = '';

    renderPrinterSendPicker(printerSendSelectedPort);
}

function closePrinterSendModal() {
    document.getElementById('printer-send-modal')?.classList.remove('active');
}

async function submitPrinterSend(mode) {
    if (!printerSendTarget || !printerSendSelectedPort) return;
    const selectedPrinter = allPrinters.find(p => p.port === printerSendSelectedPort);
    if (selectedPrinter && selectedPrinter.status !== 'online') {
        appAlert(t('printerSendOfflineError'), '', 'warning');
        return;
    }
    if (mode === 'print' && selectedPrinter) {
        const stateValue = getPrinterEffectiveStateValue(selectedPrinter);
        if (stateValue === 'printing' || stateValue === 'paused') {
            appAlert(stateValue === 'paused' ? t('printerSendBusyPausedWarning') : t('printerSendBusyWarning'), '', 'warning');
            return;
        }
    }
    try {
        const formData = new FormData();
        formData.append('path', printerSendTarget.path);
        formData.append('mode', mode);
        formData.append('section', printerSendTarget.section || 'model');
        const response = await fetch(`/api/printers/${printerSendSelectedPort}/send`, { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo enviar el archivo.');
        }
        closePrinterSendModal();
        showToast(mode === 'queue' ? t('printerSendQueued') : t('printerSendStarted'));
        loadPrinters();
    } catch (error) {
        console.error(error);
        appAlert(error.message || 'No se pudo enviar el archivo.', '', 'danger');
    }
}

async function submitPrinterSendSchedule() {
    if (!printerSendTarget || !printerSendSelectedPort) return;
    const scheduleInput = document.getElementById('printer-send-schedule-input');
    const value = scheduleInput?.value;
    if (!value) {
        appAlert(t('printerSendScheduleMissing'), '', 'warning');
        return;
    }
    if (new Date(value).getTime() <= Date.now()) {
        appAlert(t('printerSendScheduleInPast'), '', 'warning');
        return;
    }
    try {
        const formData = new FormData();
        formData.append('port', printerSendSelectedPort);
        formData.append('path', printerSendTarget.path);
        formData.append('filename', printerSendTarget.filename);
        formData.append('scheduled_at', value);
        formData.append('section', printerSendTarget.section || 'model');
        const response = await fetch('/api/printers/schedule', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo programar la impresión.');
        }
        closePrinterSendModal();
        showToast(t('printerSendScheduled'));
    } catch (error) {
        console.error(error);
        appAlert(error.message || 'No se pudo programar la impresión.', '', 'danger');
    }
}

document.getElementById('printer-send-backdrop')?.addEventListener('click', closePrinterSendModal);
document.getElementById('printer-send-close-btn')?.addEventListener('click', closePrinterSendModal);
document.getElementById('printer-send-cancel-btn')?.addEventListener('click', closePrinterSendModal);
document.getElementById('printer-send-queue-btn')?.addEventListener('click', () => submitPrinterSend('queue'));
document.getElementById('printer-send-primary-btn')?.addEventListener('click', () => {
    if (printerSendMode === 'schedule') {
        submitPrinterSendSchedule();
    } else {
        submitPrinterSend('print');
    }
});

// ── Console & Macros ──
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderConsolePrinterPicker(preferredPort) {
    const container = document.getElementById('console-printer-picker');
    if (!container) return preferredPort;

    if (!allPrinters.length) {
        container.innerHTML = `<div class="empty-state-small">${t('noPrintersFound')}</div>`;
        return null;
    }

    const validPorts = allPrinters.map(p => p.port);
    const nextPort = (preferredPort && validPorts.includes(preferredPort)) ? preferredPort : validPorts[0];

    container.innerHTML = allPrinters.map(printer => {
        const name = getPrinterDisplayName(printer);
        const active = printer.port === nextPort ? ' active' : '';
        return `
            <button type="button" class="printer-picker-card${active}" data-port="${printer.port}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                <span>${escapeHtml(name)}</span>
            </button>
        `;
    }).join('');

    container.querySelectorAll('.printer-picker-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const port = parseInt(btn.dataset.port, 10);
            if (port === consoleSelectedPort) return;
            consoleSelectedPort = port;
            container.querySelectorAll('.printer-picker-card').forEach(el => {
                el.classList.toggle('active', parseInt(el.dataset.port, 10) === port);
            });
            startConsolePolling();
            loadMacrosForSelectedPrinter();
        });
    });

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
    consoleSelectedPort = renderConsolePrinterPicker(consoleSelectedPort);
    startConsolePolling();
    loadMacrosForSelectedPrinter();
}

const consoleClearBtn = document.getElementById('console-clear-btn');
if (consoleClearBtn) {
    consoleClearBtn.addEventListener('click', () => {
        const logEl = document.getElementById('console-log');
        if (logEl) logEl.innerHTML = '';
    });
}

// ── Selector de tamaño de texto para las consolas (solo afecta el log) ──
function applyConsoleFontSize(targetId, size) {
    const logEl = document.getElementById(targetId);
    if (logEl) {
        logEl.classList.remove('font-sm', 'font-lg');
        if (size === 'sm') logEl.classList.add('font-sm');
        if (size === 'lg') logEl.classList.add('font-lg');
    }
    localStorage.setItem(`consoleFontSize-${targetId}`, size);
}

document.querySelectorAll('.console-font-size-toggle').forEach(toggle => {
    const targetId = toggle.dataset.target;
    const savedSize = localStorage.getItem(`consoleFontSize-${targetId}`) || 'md';
    applyConsoleFontSize(targetId, savedSize);
    toggle.querySelectorAll('.console-font-size-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.size === savedSize);
        btn.addEventListener('click', () => {
            toggle.querySelectorAll('.console-font-size-btn').forEach(b => b.classList.toggle('active', b === btn));
            applyConsoleFontSize(targetId, btn.dataset.size);
        });
    });
});

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

function macroLabel(name) {
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const MACRO_DESCRIPTION_PATTERNS = [
    { test: /^PAUSE$/, es: 'Pausa la impresión actual.', en: 'Pauses the current print.' },
    { test: /^RESUME$/, es: 'Reanuda la impresión pausada.', en: 'Resumes the paused print.' },
    { test: /CANCEL_PRINT/, es: 'Cancela la impresión en curso.', en: 'Cancels the current print.' },
    { test: /LOAD_FILAMENT/, es: 'Carga el filamento en el extrusor.', en: 'Loads filament into the extruder.' },
    { test: /UNLOAD_FILAMENT/, es: 'Retira el filamento del extrusor.', en: 'Unloads filament from the extruder.' },
    { test: /FILAMENT_CHANGE|^M600$/, es: 'Pausa la impresión para cambiar el filamento.', en: 'Pauses the print to change filament.' },
    { test: /PID_(TUNE|CALIBRATE)/, es: 'Calibra el PID de temperatura.', en: 'Calibrates temperature PID.' },
    { test: /BED_MESH/, es: 'Calibra la malla de la cama.', en: 'Calibrates the bed mesh.' },
    { test: /Z_TILT/, es: 'Ajusta la inclinación del eje Z.', en: 'Adjusts Z-axis tilt.' },
    { test: /QUAD_GANTRY_LEVEL|^G32$/, es: 'Nivela el pórtico (gantry).', en: 'Levels the gantry.' },
    { test: /^(HOME_ALL|G28)$/, es: 'Lleva todos los ejes a su posición de home.', en: 'Homes all axes.' },
    { test: /PARK/, es: 'Estaciona el cabezal en una posición segura.', en: 'Parks the toolhead in a safe position.' },
    { test: /PREHEAT/, es: 'Precalienta la impresora.', en: 'Preheats the printer.' },
    { test: /COOL_?DOWN/, es: 'Enfría la cama y el extrusor.', en: 'Cools down the bed and extruder.' },
    { test: /CLEAN_NOZZLE|NOZZLE_CLEAN/, es: 'Limpia la boquilla.', en: 'Cleans the nozzle.' },
    { test: /START_PRINT/, es: 'Rutina de inicio de impresión.', en: 'Print start routine.' },
    { test: /END_PRINT/, es: 'Rutina de fin de impresión.', en: 'Print end routine.' },
    { test: /^BEEP$/, es: 'Emite un sonido con el zumbador.', en: 'Beeps the buzzer.' },
    { test: /LIGHT/, es: 'Enciende o apaga la iluminación.', en: 'Toggles the lighting.' },
    { test: /SAVE_CONFIG/, es: 'Guarda la configuración actual en printer.cfg.', en: 'Saves the current config to printer.cfg.' },
    { test: /TEST_SPEED/, es: 'Corre una prueba de velocidad de movimiento.', en: 'Runs a motion speed test.' },
    { test: /CALIBRATE/, es: 'Corre una rutina de calibración.', en: 'Runs a calibration routine.' },
];

function macroAutoDescription(name) {
    const upper = (name || '').toUpperCase();
    const match = MACRO_DESCRIPTION_PATTERNS.find(rule => rule.test.test(upper));
    if (match) return currentLanguage === 'en' ? match.en : match.es;
    return t('macroNoDescription');
}

function renderMacrosGrid(macros) {
    const gridEl = document.getElementById('macros-grid');
    if (!gridEl) return;
    if (!macros || !macros.length) {
        gridEl.innerHTML = `<div class="empty-state">${t('noMacros')}</div>`;
        return;
    }
    gridEl.innerHTML = macros.map(macro => `
        <button type="button" class="macro-btn" data-macro="${escapeHtml(macro.name)}">
            <span class="macro-btn-face">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                <span>${macroLabel(macro.name)}</span>
            </span>
            <span class="macro-btn-description">${escapeHtml(macro.description || macroAutoDescription(macro.name))}</span>
        </button>
    `).join('');

    gridEl.querySelectorAll('.macro-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!consoleSelectedPort) return;
            btn.disabled = true;
            btn.classList.add('running');
            try {
                const formData = new FormData();
                formData.append('port', consoleSelectedPort);
                formData.append('macro', btn.dataset.macro);
                const response = await fetch('/api/macros/run', { method: 'POST', body: formData });
                if (!response.ok) throw new Error('No se pudo ejecutar el macro');
            } catch (error) {
                console.error(error);
                appAlert(error.message || 'No se pudo ejecutar el macro.', '', 'danger');
            } finally {
                btn.disabled = false;
                btn.classList.remove('running');
            }
        });
    });
}

async function loadMacrosForSelectedPrinter() {
    const gridEl = document.getElementById('macros-grid');
    if (!consoleSelectedPort) {
        if (gridEl) gridEl.innerHTML = `<div class="empty-state">${t('noPrintersFound')}</div>`;
        return;
    }
    try {
        const response = await fetch(`/api/macros?port=${consoleSelectedPort}`);
        if (!response.ok) throw new Error('No se pudo cargar los macros');
        const data = await response.json();
        renderMacrosGrid(data.macros || []);
    } catch (error) {
        console.error(error);
        if (gridEl) gridEl.innerHTML = `<div class="empty-state">${t('noMacros')}</div>`;
    }
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
// Firmware por host ('fluidnc'/'marlin') — aparte de registeredLaserMap
// (host -> nombre) para no romper los muchos lugares que ya esperan un
// string ahí; solo se usa para pintar el badge de firmware en las listas.
let registeredLaserFirmwareMap = new Map();

async function refreshRegisteredLasers() {
    try {
        const response = await fetch('/api/laser/registry');
        const data = await response.json();
        const lasers = data.lasers || [];
        registeredLaserMap = new Map(lasers.map(entry => [entry.host, entry.name]));
        registeredLaserFirmwareMap = new Map(lasers.map(entry => [entry.host, entry.firmware || 'fluidnc']));
    } catch (error) {
        console.error(error);
    }
}

function deviceFirmwareBadgeLabel(firmware) {
    return firmware === 'marlin' ? t('usbClassifyFirmwareMarlin') : t('usbClassifyFirmwareFluidnc');
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
        const firmwareBadge = registeredName
            ? `<span class="usb-port-firmware-badge">${escapeHtml(deviceFirmwareBadgeLabel(registeredLaserFirmwareMap.get(host)))}</span>`
            : '';
        const actionHtml = registeredName
            ? `<div class="usb-port-registered">
                    <span class="usb-port-registered-badge">${escapeHtml(registeredName)}</span>
                    ${firmwareBadge}
                    <button type="button" class="theme-option-icon-btn usb-port-rename-btn" data-host="${escapeHtml(host)}" data-name="${escapeHtml(registeredName)}" title="${escapeHtml(t('usbPortRename'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </button>
                    <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger usb-port-unlink-btn" data-host="${escapeHtml(host)}" data-name="${escapeHtml(registeredName)}" data-chip="${escapeHtml(port.chip)}" data-transport="usb" title="${escapeHtml(t('usbPortUnlink'))}">
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

    wireRegisteredDeviceActions(container);
}

function wireRegisteredDeviceActions(container) {
    container.querySelectorAll('.usb-port-rename-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openDeviceRenameModal(btn.dataset.host, btn.dataset.name);
        });
    });

    container.querySelectorAll('.usb-port-unlink-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openDeviceUnlinkModal(btn.dataset.host, btn.dataset.name, btn.dataset.chip, btn.dataset.transport);
        });
    });
}

let deviceUnlinkTarget = null;

async function openDeviceUnlinkModal(host, name, chip, transport) {
    deviceUnlinkTarget = host;
    const modal = document.getElementById('device-unlink-modal');
    const nameEl = document.getElementById('device-unlink-name');
    const pillEl = document.getElementById('device-unlink-status-pill');
    const chipEl = document.getElementById('device-unlink-chip');
    const connEl = document.getElementById('device-unlink-connection');
    const addedEl = document.getElementById('device-unlink-added');
    const lastSeenEl = document.getElementById('device-unlink-lastseen');

    if (nameEl) nameEl.textContent = name || host;
    if (chipEl) chipEl.textContent = chip || '—';
    if (connEl) connEl.textContent = transport === 'usb' ? `USB (${host.replace(/^usb:/, '')})` : `WiFi (${host})`;
    if (pillEl) { pillEl.textContent = '…'; pillEl.className = 'device-unlink-status-pill offline'; }
    if (addedEl) addedEl.textContent = '—';
    if (lastSeenEl) lastSeenEl.textContent = '—';

    modal?.classList.add('active');

    try {
        const regResponse = await fetch('/api/laser/registry');
        const regData = await regResponse.json();
        const entry = (regData.lasers || []).find(l => l.host === host);
        if (addedEl) addedEl.textContent = entry?.registered_at ? formatDate(entry.registered_at) : '—';
    } catch (error) {
        console.error(error);
    }

    try {
        const statusResponse = await fetch(`/api/laser/status?host=${encodeURIComponent(host)}`);
        const status = await statusResponse.json();
        const isOnline = !!status?.connected;
        if (pillEl) {
            pillEl.textContent = isOnline ? t('online') : t('offline');
            pillEl.className = `device-unlink-status-pill${isOnline ? '' : ' offline'}`;
        }
        if (lastSeenEl) lastSeenEl.textContent = isOnline ? t('deviceUnlinkNow') : '—';
    } catch (error) {
        if (pillEl) { pillEl.textContent = t('offline'); pillEl.className = 'device-unlink-status-pill offline'; }
    }
}

function closeDeviceUnlinkModal() {
    document.getElementById('device-unlink-modal')?.classList.remove('active');
    deviceUnlinkTarget = null;
}

async function handleDeviceUnlinkConfirm() {
    if (!deviceUnlinkTarget) return;
    try {
        const formData = new FormData();
        formData.append('host', deviceUnlinkTarget);
        await fetch('/api/laser/registry/remove', { method: 'POST', body: formData });
        closeDeviceUnlinkModal();
        refreshUsbPorts();
        loadWifiDevices();
        if (document.getElementById('laser-host-select')) loadLaserHostSelector();
    } catch (error) {
        console.error(error);
    }
}

document.getElementById('device-unlink-backdrop')?.addEventListener('click', closeDeviceUnlinkModal);
document.getElementById('device-unlink-close-btn')?.addEventListener('click', closeDeviceUnlinkModal);
document.getElementById('device-unlink-cancel-btn')?.addEventListener('click', closeDeviceUnlinkModal);
document.getElementById('device-unlink-confirm-btn')?.addEventListener('click', handleDeviceUnlinkConfirm);

async function loadWifiDevices() {
    const container = document.getElementById('wifi-devices-list');
    if (!container) return;
    container.innerHTML = `<div class="empty-state-small">${t('laserWifiScanning')}</div>`;
    try {
        await refreshRegisteredLasers();
        const response = await fetch('/api/laser/scan');
        const data = await response.json();
        const scanned = data.devices || [];
        // Las placas encontradas a mano por IP (fuera de la subred que barre
        // el escaneo automático) se conservan aunque se vuelva a escanear.
        const merged = [...manualWifiDevices.filter(d => !scanned.some(s => s.host === d.host)), ...scanned];
        renderWifiDevices(merged);
    } catch (error) {
        console.error(error);
        renderWifiDevices([...manualWifiDevices]);
    }
}

function renderWifiDevices(devices) {
    const container = document.getElementById('wifi-devices-list');
    if (!container) return;
    if (!devices.length) {
        container.innerHTML = `<div class="empty-state-small">${t('laserWifiDevicesEmpty')}</div>`;
        return;
    }
    container.innerHTML = devices.map(device => {
        const registeredName = registeredLaserMap.get(device.host);
        const firmwareBadge = registeredName
            ? `<span class="usb-port-firmware-badge">${escapeHtml(deviceFirmwareBadgeLabel(registeredLaserFirmwareMap.get(device.host)))}</span>`
            : '';
        const actionHtml = registeredName
            ? `<div class="usb-port-registered">
                    <span class="usb-port-registered-badge">${escapeHtml(registeredName)}</span>
                    ${firmwareBadge}
                    <button type="button" class="theme-option-icon-btn usb-port-rename-btn" data-host="${escapeHtml(device.host)}" data-name="${escapeHtml(registeredName)}" title="${escapeHtml(t('usbPortRename'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </button>
                    <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger usb-port-unlink-btn" data-host="${escapeHtml(device.host)}" data-name="${escapeHtml(registeredName)}" data-chip="${escapeHtml(device.hostname || device.firmware || '')}" data-transport="network" title="${escapeHtml(t('usbPortUnlink'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
               </div>`
            : `<button type="button" class="btn-file-action wifi-device-add-btn" data-host="${escapeHtml(device.host)}" data-hostname="${escapeHtml(device.hostname || '')}" data-firmware="${escapeHtml(device.firmware || '')}">${escapeHtml(t('usbPortAdd'))}</button>`;
        return `
            <div class="usb-port-item">
                <div class="usb-port-item-info">
                    <strong>${escapeHtml(device.hostname || device.host)}</strong>
                    <span>${escapeHtml(device.firmware || '')}</span>
                </div>
                <span class="usb-port-vidpid">${escapeHtml(device.host)}</span>
                ${actionHtml}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.wifi-device-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openWifiClassifyModal(btn.dataset.host, btn.dataset.hostname, btn.dataset.firmware);
        });
    });

    wireRegisteredDeviceActions(container);
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

async function loadRegistryDevices() {
    const container = document.getElementById('registry-devices-list');
    if (!container) return;
    try {
        const response = await fetch('/api/laser/registry/status');
        const data = await response.json();
        renderRegistryDevices(data.lasers || []);
    } catch (error) {
        console.error(error);
    }
}

function renderRegistryDevices(devices) {
    const container = document.getElementById('registry-devices-list');
    if (!container) return;
    if (!devices.length) {
        container.innerHTML = `<div class="empty-state-small">${t('registryDevicesEmpty')}</div>`;
        return;
    }
    container.innerHTML = devices.map(device => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(device.name || device.host)}</strong>
                <span>${escapeHtml(device.host)}</span>
            </div>
            <span class="usb-port-firmware-badge">${escapeHtml(deviceFirmwareBadgeLabel(device.firmware))}</span>
            <span class="device-status-pill ${device.online ? 'online' : 'offline'}">${device.online ? t('online') : t('offline')}</span>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger registry-device-remove-btn" data-host="${escapeHtml(device.host)}" title="${escapeHtml(t('usbPortUnlink'))}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.registry-device-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const host = btn.dataset.host;
            if (!(await appConfirm(t('usbUnlinkConfirm'), t('usbPortUnlink')))) return;
            try {
                const body = new URLSearchParams();
                body.set('host', host);
                await fetch('/api/laser/registry/remove', { method: 'POST', body });
                loadRegistryDevices();
                refreshUsbPorts();
            } catch (error) {
                console.error(error);
            }
        });
    });
}

document.getElementById('registry-devices-refresh-btn')?.addEventListener('click', loadRegistryDevices);
document.getElementById('usb-ports-refresh-btn')?.addEventListener('click', refreshUsbPorts);

// ── Accesorios IoT (extractor/ventilador/bomba/compresor) ──

const ACCESSORY_KIND_ICONS = {
    extractor: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.59 4.59A2 2 0 1 1 11 8H2"/><path d="M12.59 19.41A2 2 0 1 0 14 16H2"/><path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2"/></svg>',
    fan: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 12a3 3 0 1 0 0-6c0 2 1 4 3 6z"/><path d="M12 12a3 3 0 1 0 0 6c0-2-1-4-3-6z"/><path d="M12 12a3 3 0 1 0 6 0c-2 0-4 1-6 3z"/><path d="M12 12a3 3 0 1 0-6 0c2 0 4-1 6-3z"/></svg>',
    pump: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    compressor: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="9" width="14" height="10" rx="1"/><path d="M17 12h4"/><path d="M17 16h4"/><circle cx="8" cy="14" r="2"/></svg>',
    other: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
};

const accessoryDriverSwitch = createOptionSwitch('accessory-driver-switch', value => {
    document.getElementById('accessory-config-relay').hidden = value !== 'http_relay';
    document.getElementById('accessory-config-ha').hidden = value !== 'home_assistant';
});

async function loadAccessories() {
    const container = document.getElementById('accessories-list');
    if (!container) return;
    try {
        const response = await fetch('/api/accessories/status');
        const data = await response.json();
        renderAccessories(data.accessories || []);
    } catch (error) {
        console.error(error);
    }
}

function renderAccessories(accessories) {
    const container = document.getElementById('accessories-list');
    if (!container) return;
    if (!accessories.length) {
        container.innerHTML = `<div class="empty-state-small">${t('accessoriesEmpty')}</div>`;
        return;
    }
    container.innerHTML = accessories.map(acc => {
        const statusClass = acc.on === true ? 'on' : acc.on === false ? 'off' : 'unknown';
        const statusLabel = acc.on === true ? t('accessoryOn') : acc.on === false ? t('accessoryOff') : t('accessoryUnknown');
        const driverLabel = acc.driver === 'home_assistant' ? t('accessoryDriverHa') : t('accessoryDriverRelay');
        return `
        <div class="accessory-item">
            <span class="accessory-item-icon">${ACCESSORY_KIND_ICONS[acc.kind] || ACCESSORY_KIND_ICONS.other}</span>
            <div class="accessory-item-info">
                <span class="accessory-item-name">${escapeHtml(acc.name)}</span>
                <span class="accessory-item-meta">${escapeHtml(driverLabel)}</span>
            </div>
            <div class="accessory-item-actions">
                <span class="device-status-pill ${statusClass}">${statusLabel}</span>
                <button type="button" class="accessory-power-btn ${acc.on ? 'is-on' : ''}" data-id="${escapeHtml(acc.id)}" data-on="${acc.on ? 'true' : 'false'}" title="${acc.on ? t('accessoryTurnOff') : t('accessoryTurnOn')}">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                </button>
                <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger accessory-remove-btn" data-id="${escapeHtml(acc.id)}" title="${t('accessoryRemove')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        `;
    }).join('');

    container.querySelectorAll('.accessory-power-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const nextOn = btn.dataset.on !== 'true';
            btn.disabled = true;
            try {
                const body = new URLSearchParams();
                body.set('id', id);
                body.set('on', nextOn ? 'true' : 'false');
                const response = await fetch('/api/accessories/power', { method: 'POST', body });
                if (!response.ok) throw new Error('power toggle failed');
            } catch (error) {
                console.error(error);
            } finally {
                loadAccessories();
            }
        });
    });

    container.querySelectorAll('.accessory-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!(await appConfirm(t('accessoryRemoveConfirm'), t('accessoryRemove'), 'danger'))) return;
            try {
                const body = new URLSearchParams();
                body.set('id', id);
                await fetch('/api/accessories/remove', { method: 'POST', body });
            } catch (error) {
                console.error(error);
            } finally {
                loadAccessories();
            }
        });
    });
}

function openAccessoryModal() {
    document.getElementById('accessory-name-input').value = '';
    document.getElementById('accessory-kind-select').value = 'extractor';
    document.getElementById('accessory-relay-on-url').value = '';
    document.getElementById('accessory-relay-off-url').value = '';
    document.getElementById('accessory-relay-status-url').value = '';
    document.getElementById('accessory-relay-status-text').value = '';
    document.getElementById('accessory-ha-base-url').value = '';
    document.getElementById('accessory-ha-token').value = '';
    document.getElementById('accessory-ha-entity-id').value = '';
    accessoryDriverSwitch.setValue('http_relay');
    document.getElementById('accessory-config-relay').hidden = false;
    document.getElementById('accessory-config-ha').hidden = true;
    document.getElementById('accessory-modal')?.classList.add('active');
}

function closeAccessoryModal() {
    document.getElementById('accessory-modal')?.classList.remove('active');
}

document.getElementById('accessory-add-btn')?.addEventListener('click', openAccessoryModal);
document.getElementById('accessory-modal-close')?.addEventListener('click', closeAccessoryModal);
document.getElementById('accessory-modal-backdrop')?.addEventListener('click', closeAccessoryModal);
document.getElementById('accessory-cancel-btn')?.addEventListener('click', closeAccessoryModal);

document.getElementById('accessory-save-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('accessory-name-input').value.trim();
    if (!name) return;
    const kind = document.getElementById('accessory-kind-select').value;
    const driver = accessoryDriverSwitch.getValue() || 'http_relay';

    let config = {};
    if (driver === 'home_assistant') {
        config = {
            base_url: document.getElementById('accessory-ha-base-url').value.trim(),
            token: document.getElementById('accessory-ha-token').value.trim(),
            entity_id: document.getElementById('accessory-ha-entity-id').value.trim(),
        };
    } else {
        config = {
            on_url: document.getElementById('accessory-relay-on-url').value.trim(),
            off_url: document.getElementById('accessory-relay-off-url').value.trim(),
        };
        const statusUrl = document.getElementById('accessory-relay-status-url').value.trim();
        const statusText = document.getElementById('accessory-relay-status-text').value.trim();
        if (statusUrl) config.status_url = statusUrl;
        if (statusText) config.status_on_text = statusText;
    }

    try {
        const body = new URLSearchParams();
        body.set('name', name);
        body.set('kind', kind);
        body.set('driver', driver);
        body.set('config', JSON.stringify(config));
        const response = await fetch('/api/accessories', { method: 'POST', body });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showToast(err.detail || t('accessorySaveError'));
            return;
        }
        closeAccessoryModal();
        loadAccessories();
    } catch (error) {
        console.error(error);
        showToast(t('accessorySaveError'));
    }
});

let usbClassifyTarget = null;

function showUsbClassifyStep(step) {
    const typeStep = document.getElementById('usb-classify-step-type');
    const nameStep = document.getElementById('usb-classify-step-name');
    if (typeStep) typeStep.hidden = step !== 'type';
    if (nameStep) nameStep.hidden = step !== 'name';
}

function openUsbClassifyModal(device, chip) {
    usbClassifyTarget = { transport: 'usb', device, host: `usb:${device}`, chip };
    const label = document.getElementById('usb-classify-device-label');
    if (label) label.textContent = `${chip} · ${device}`;
    showUsbClassifyStep('type');
    const modal = document.getElementById('usb-classify-modal');
    if (modal) modal.classList.add('active');
}

function openWifiClassifyModal(host, hostname, firmware) {
    // ESP3D siempre trae hostname; FluidNC no lo expone por HTTP — en ese
    // caso se usa el firmware detectado, y si tampoco hay, un genérico.
    const displayName = hostname || firmware || t('laserGenericNetworkDevice');
    usbClassifyTarget = { transport: 'network', host, chip: displayName };
    const label = document.getElementById('usb-classify-device-label');
    if (label) label.textContent = `${displayName} · ${host}`;
    showUsbClassifyStep('type');
    const modal = document.getElementById('usb-classify-modal');
    if (modal) modal.classList.add('active');
}

function closeUsbClassifyModal() {
    const modal = document.getElementById('usb-classify-modal');
    if (modal) modal.classList.remove('active');
    showUsbClassifyStep('type');
}

function grblHomeCornerLabel(mask) {
    const m = parseInt(mask, 10);
    if (Number.isNaN(m)) return null;
    const xRight = !!(m & 1);
    const yTop = !!(m & 2);
    const xLabel = xRight ? t('usbScanCornerRight') : t('usbScanCornerLeft');
    const yLabel = yTop ? t('usbScanCornerTop') : t('usbScanCornerBottom');
    return `${yLabel} ${xLabel}`;
}

async function runUsbClassifyScan() {
    const target = usbClassifyTarget;
    if (!target) return;

    const defaultName = target.transport === 'usb'
        ? (target.chip === 'CH340' || target.chip === 'CH340K' ? 'Sculpfun' : target.chip)
        : target.chip;
    const label = document.getElementById('usb-classify-device-label-name');
    if (label) label.textContent = `${target.chip} · ${target.transport === 'usb' ? target.device : target.host}`;
    const titleKind = document.getElementById('usb-classify-name-title-kind');
    if (titleKind) titleKind.textContent = target.kind === 'cnc' ? t('usbKindCnc') : t('usbKindLaser');
    const nameStepEl = document.getElementById('usb-classify-step-name');
    if (nameStepEl) nameStepEl.classList.toggle('theme-cnc', target.kind === 'cnc');
    const input = document.getElementById('usb-classify-name-input');
    const confirmBtn = document.getElementById('usb-classify-name-confirm-btn');
    const scanStatus = document.getElementById('usb-classify-scan-status');
    const scanGrid = document.getElementById('usb-classify-scan-grid');
    const widthInput = document.getElementById('usb-classify-scan-width');
    const heightInput = document.getElementById('usb-classify-scan-height');
    const homeValue = document.getElementById('usb-classify-scan-home-value');
    const profileRow = document.getElementById('usb-classify-profile-row');

    if (input) input.value = defaultName;
    if (widthInput) widthInput.value = '';
    if (heightInput) heightInput.value = '';
    if (homeValue) homeValue.textContent = '—';
    if (scanGrid) scanGrid.hidden = true;
    if (profileRow) profileRow.hidden = target.kind !== 'cnc';
    if (usbClassifyProfileSwitch) usbClassifyProfileSwitch.setValue('router');
    if (usbClassifyFirmwareSwitch) usbClassifyFirmwareSwitch.setValue('fluidnc');
    if (scanStatus) scanStatus.hidden = false;
    if (confirmBtn) confirmBtn.disabled = true;
    showUsbClassifyStep('name');
    if (input) {
        input.focus();
        input.select();
    }

    try {
        if (target.transport === 'usb') {
            const formData = new FormData();
            formData.append('device', target.device);
            const testResponse = await fetch('/api/laser/usb-ports/test', { method: 'POST', body: formData });
            if (!testResponse.ok) {
                const data = await testResponse.json().catch(() => ({}));
                throw new Error(data.detail || t('usbTestFailed'));
            }
        }

        const settingsResponse = await fetch(`/api/laser/settings?host=${encodeURIComponent(target.host)}`);
        if (settingsResponse.ok) {
            const settingsData = await settingsResponse.json();
            const settings = {};
            (settingsData.settings || []).forEach(entry => { settings[entry.key] = entry.value; });
            if (widthInput && settings['$130']) widthInput.value = settings['$130'];
            if (heightInput && settings['$131']) heightInput.value = settings['$131'];
            if (homeValue) homeValue.textContent = grblHomeCornerLabel(settings['$23']) || '—';
        }
    } catch (error) {
        console.error(error);
        showToast(error.message || t('usbScanFailed'), 'error');
    } finally {
        if (scanStatus) scanStatus.hidden = true;
        if (scanGrid) scanGrid.hidden = false;
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

function handleUsbClassifyLaser() {
    if (usbClassifyTarget) usbClassifyTarget.kind = 'laser';
    runUsbClassifyScan();
}

function handleUsbClassifyCnc() {
    if (usbClassifyTarget) usbClassifyTarget.kind = 'cnc';
    runUsbClassifyScan();
}

async function handleUsbClassifyNameConfirm() {
    const target = usbClassifyTarget;
    const input = document.getElementById('usb-classify-name-input');
    const name = input ? input.value.trim() : '';
    if (!target || !name) return;

    const widthInput = document.getElementById('usb-classify-scan-width');
    const heightInput = document.getElementById('usb-classify-scan-height');
    const homeValue = document.getElementById('usb-classify-scan-home-value');
    const width = widthInput && widthInput.value ? parseFloat(widthInput.value) : null;
    const height = heightInput && heightInput.value ? parseFloat(heightInput.value) : null;
    const homeCorner = homeValue && homeValue.textContent !== '—' ? homeValue.textContent : null;

    const confirmBtn = document.getElementById('usb-classify-name-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;
    closeUsbClassifyModal();

    try {
        const registerData = new FormData();
        registerData.append('host', target.host);
        registerData.append('name', name);
        registerData.append('transport', target.transport);
        registerData.append('kind', target.kind || 'laser');
        if (width) registerData.append('work_area_width', width);
        if (height) registerData.append('work_area_height', height);
        if (homeCorner) registerData.append('home_corner', homeCorner);
        if (target.kind === 'cnc' && usbClassifyProfileSwitch) {
            registerData.append('machine_profile', usbClassifyProfileSwitch.getValue() || 'router');
        }
        if (usbClassifyFirmwareSwitch) {
            registerData.append('firmware', usbClassifyFirmwareSwitch.getValue() || 'fluidnc');
        }
        await fetch('/api/laser/registry', { method: 'POST', body: registerData });

        const kindLabel = target.kind === 'cnc' ? t('usbKindCnc') : t('usbKindLaser');
        showToast(`${name}: ${t('usbRegisterSuccess').replace('{kind}', kindLabel)}`);
        refreshUsbPorts();
        loadWifiDevices();
        if (document.getElementById('laser-host-select')) loadLaserHostSelector();
    } catch (error) {
        console.error(error);
        showToast(error.message || t('usbTestFailed'), 'error');
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

function handleUsbClassifyPrinter() {
    closeUsbClassifyModal();
    showToast(t('usbPrinterNotSupported'), 'error');
}

const usbClassifyLaserBtn = document.getElementById('usb-classify-laser-btn');
if (usbClassifyLaserBtn) usbClassifyLaserBtn.addEventListener('click', handleUsbClassifyLaser);

const usbClassifyCncBtn = document.getElementById('usb-classify-cnc-btn');
if (usbClassifyCncBtn) usbClassifyCncBtn.addEventListener('click', handleUsbClassifyCnc);

const usbClassifyPrinterBtn = document.getElementById('usb-classify-printer-btn');
if (usbClassifyPrinterBtn) usbClassifyPrinterBtn.addEventListener('click', handleUsbClassifyPrinter);

const usbClassifyCancelBtn = document.getElementById('usb-classify-cancel-btn');
if (usbClassifyCancelBtn) usbClassifyCancelBtn.addEventListener('click', closeUsbClassifyModal);

const usbClassifyCloseBtn = document.getElementById('usb-classify-close-btn');
if (usbClassifyCloseBtn) usbClassifyCloseBtn.addEventListener('click', closeUsbClassifyModal);

const usbClassifyNameConfirmBtn = document.getElementById('usb-classify-name-confirm-btn');
if (usbClassifyNameConfirmBtn) usbClassifyNameConfirmBtn.addEventListener('click', handleUsbClassifyNameConfirm);

const usbClassifyNameCancelBtn = document.getElementById('usb-classify-name-cancel-btn');
if (usbClassifyNameCancelBtn) usbClassifyNameCancelBtn.addEventListener('click', closeUsbClassifyModal);

const usbClassifyNameInput = document.getElementById('usb-classify-name-input');
if (usbClassifyNameInput) {
    usbClassifyNameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleUsbClassifyNameConfirm();
        }
    });
}

const usbClassifyBackdrop = document.getElementById('usb-classify-backdrop');
if (usbClassifyBackdrop) usbClassifyBackdrop.addEventListener('click', closeUsbClassifyModal);

const wifiDevicesScanBtn = document.getElementById('wifi-devices-scan-btn');
if (wifiDevicesScanBtn) {
    wifiDevicesScanBtn.addEventListener('click', async () => {
        wifiDevicesScanBtn.disabled = true;
        await loadWifiDevices();
        wifiDevicesScanBtn.disabled = false;
    });
}

// ── Búsqueda manual por IP (placas fuera del rango del escaneo automático,
// otra subred, o en modo Punto de Acceso propio como FluidNC recién flasheado) ──
let manualWifiDevices = [];

const wifiScanIpToggleBtn = document.getElementById('wifi-devices-scan-ip-toggle-btn');
const wifiScanIpRow = document.getElementById('wifi-scan-ip-row');
const wifiScanIpInput = document.getElementById('wifi-scan-ip-input');
const wifiScanIpBtn = document.getElementById('wifi-scan-ip-btn');

if (wifiScanIpToggleBtn && wifiScanIpRow) {
    wifiScanIpToggleBtn.addEventListener('click', () => {
        wifiScanIpRow.hidden = !wifiScanIpRow.hidden;
        if (!wifiScanIpRow.hidden && wifiScanIpInput) wifiScanIpInput.focus();
    });
}

async function searchWifiDeviceByIp() {
    const ip = wifiScanIpInput?.value.trim();
    if (!ip) {
        showToast(t('laserScanIpInvalid'), 'warning');
        return;
    }
    wifiScanIpBtn.disabled = true;
    const originalLabel = wifiScanIpBtn.querySelector('span')?.textContent;
    const labelEl = wifiScanIpBtn.querySelector('span');
    if (labelEl) labelEl.textContent = t('laserScanIpSearching');
    try {
        const response = await fetch(`/api/laser/scan-ip?ip=${encodeURIComponent(ip)}`);
        if (!response.ok) {
            showToast(t('laserScanIpNotFound'), 'warning');
            return;
        }
        const device = await response.json();
        if (!manualWifiDevices.some(d => d.host === device.host)) {
            manualWifiDevices.push(device);
        }
        showToast(t('laserScanIpFound'));
        if (wifiScanIpInput) wifiScanIpInput.value = '';
        await refreshRegisteredLasers();
        renderWifiDevices([...manualWifiDevices]);
    } catch (error) {
        console.error(error);
        showToast(t('laserScanIpNotFound'), 'warning');
    } finally {
        wifiScanIpBtn.disabled = false;
        if (labelEl) labelEl.textContent = originalLabel;
    }
}

if (wifiScanIpBtn) wifiScanIpBtn.addEventListener('click', searchWifiDeviceByIp);
if (wifiScanIpInput) {
    wifiScanIpInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            searchWifiDeviceByIp();
        }
    });
}

// ── Renombrar dispositivo registrado (modal propio, sin prompt() nativo) ──
let deviceRenameTarget = null;

async function openDeviceRenameModal(host, currentName) {
    deviceRenameTarget = host;
    const input = document.getElementById('device-rename-input');
    const widthInput = document.getElementById('device-rename-width');
    const heightInput = document.getElementById('device-rename-height');
    if (input) input.value = currentName || '';
    if (widthInput) widthInput.value = '';
    if (heightInput) heightInput.value = '';

    const modal = document.getElementById('device-rename-modal');
    if (modal) modal.classList.add('active');
    if (input) {
        input.focus();
        input.select();
    }

    const profileRow = document.getElementById('device-rename-profile-row');
    if (profileRow) profileRow.hidden = true;

    try {
        const response = await fetch('/api/laser/registry');
        const data = await response.json();
        const entry = (data.lasers || []).find(item => item.host === host);
        if (entry && entry.work_area) {
            if (widthInput) widthInput.value = entry.work_area.width || '';
            if (heightInput) heightInput.value = entry.work_area.height || '';
        }
        if (profileRow) profileRow.hidden = !(entry && entry.kind === 'cnc');
        deviceRenameProfileSwitch.setValue((entry && entry.machine_profile) || 'router');
        deviceRenameFirmwareSwitch.setValue((entry && entry.firmware) || 'fluidnc');
    } catch (error) {
        console.error(error);
    }
}

function closeDeviceRenameModal() {
    const modal = document.getElementById('device-rename-modal');
    if (modal) modal.classList.remove('active');
    deviceRenameTarget = null;
}

async function handleDeviceRenameConfirm() {
    const host = deviceRenameTarget;
    const input = document.getElementById('device-rename-input');
    const widthInput = document.getElementById('device-rename-width');
    const heightInput = document.getElementById('device-rename-height');
    const name = input ? input.value.trim() : '';
    if (!host || !name) return;
    closeDeviceRenameModal();
    try {
        const registryResponse = await fetch('/api/laser/registry');
        const registryData = await registryResponse.json();
        const existing = (registryData.lasers || []).find(item => item.host === host);

        const formData = new FormData();
        formData.append('host', host);
        formData.append('name', name);
        formData.append('transport', host.startsWith('usb:') ? 'usb' : 'network');
        formData.append('kind', (existing && existing.kind) || 'laser');
        const width = widthInput && widthInput.value ? parseFloat(widthInput.value) : null;
        const height = heightInput && heightInput.value ? parseFloat(heightInput.value) : null;
        if (width) formData.append('work_area_width', width);
        if (height) formData.append('work_area_height', height);
        if (existing && existing.home_corner) formData.append('home_corner', existing.home_corner);
        if (existing && existing.kind === 'cnc') {
            formData.append('machine_profile', deviceRenameProfileSwitch.getValue() || 'router');
        }
        formData.append('firmware', deviceRenameFirmwareSwitch.getValue() || 'fluidnc');

        await fetch('/api/laser/registry', { method: 'POST', body: formData });
        refreshUsbPorts();
        loadWifiDevices();
        if (document.getElementById('laser-host-select')) loadLaserHostSelector();

        const changes = [];
        const previousName = existing ? existing.name : null;
        const previousWidth = existing && existing.work_area ? existing.work_area.width : null;
        const previousHeight = existing && existing.work_area ? existing.work_area.height : null;
        if (previousName !== name) changes.push(`${t('usbRegisterNameLabel')}: ${name}`);
        if (width && width !== previousWidth) changes.push(`${t('usbScanWidthLabel')}: ${width}`);
        if (height && height !== previousHeight) changes.push(`${t('usbScanHeightLabel')}: ${height}`);
        showToast(changes.length ? `${t('deviceEditSaved')} — ${changes.join(' · ')}` : t('deviceEditSaved'));
    } catch (error) {
        console.error(error);
    }
}

const deviceRenameConfirmBtn = document.getElementById('device-rename-confirm-btn');
if (deviceRenameConfirmBtn) deviceRenameConfirmBtn.addEventListener('click', handleDeviceRenameConfirm);

const deviceRenameCancelBtn = document.getElementById('device-rename-cancel-btn');
if (deviceRenameCancelBtn) deviceRenameCancelBtn.addEventListener('click', closeDeviceRenameModal);

const deviceRenameBackdrop = document.getElementById('device-rename-backdrop');
if (deviceRenameBackdrop) deviceRenameBackdrop.addEventListener('click', closeDeviceRenameModal);

document.getElementById('device-rename-modal-close')?.addEventListener('click', closeDeviceRenameModal);

const deviceRenameInput = document.getElementById('device-rename-input');
if (deviceRenameInput) {
    deviceRenameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleDeviceRenameConfirm();
        }
    });
}

// ── Laser (GRBL) ──
let laserPollInterval = null;

function renderLaserStatus(data) {
    const dot = document.getElementById('laser-status-dot');
    const text = document.getElementById('laser-status-text');
    const pill = document.getElementById('laser-state-pill');
    const position = document.getElementById('laser-position');
    const feedSpeed = document.getElementById('laser-feed-speed');
    const overrides = document.getElementById('laser-overrides');
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
        if (overrides) overrides.textContent = '— / — / —';
        return;
    }

    dot.classList.add('online');
    text.textContent = t('laserOnline');
    document.body.setAttribute('data-machine-firmware', data.firmware || 'fluidnc');
    if (pill) {
        pill.textContent = data.state || '';
        pill.className = `laser-state-pill state-${(data.state || '').toLowerCase()}`;
    }
    if (position) position.textContent = `X${data.x.toFixed(2)} Y${data.y.toFixed(2)} Z${data.z.toFixed(2)}`;
    // Marlin no reporta feed/velocidad realtime (feed/speed llegan null) —
    // se muestra "—" en vez de "null" mientras no haya nada que mostrar.
    const hasFeedSpeed = data.feed != null && data.speed != null;
    const powerPercent = hasFeedSpeed ? Math.round((data.speed / LASER_POWER_S_MAX) * 100) : null;
    if (feedSpeed) feedSpeed.textContent = hasFeedSpeed ? `${data.feed} / ${powerPercent}%` : '—';
    if (overrides) {
        // GRBL no manda "Ov" en cada reporte de status (solo cada ~10
        // reportes) — si todavía no llegó ninguno esta sesión, mostrar "—"
        // en vez de 0%, que se leería como "override puesto a cero".
        overrides.textContent = data.overrides
            ? `${data.overrides.feed}% / ${data.overrides.rapid}% / ${data.overrides.spindle}%`
            : '— / — / —';
    }
    const jobSpeedEl = document.getElementById('laser-job-speed');
    if (jobSpeedEl) jobSpeedEl.textContent = hasFeedSpeed ? `${data.feed} mm/min` : '—';
    const jobPowerEl = document.getElementById('laser-job-power');
    if (jobPowerEl) jobPowerEl.textContent = hasFeedSpeed ? `${powerPercent}%` : '—';
    updateLaserBedMapPosition(data.x, data.y, (data.state || '').toLowerCase() === 'run');
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

const laserJobHostLastState = new Map();
const laserJobHostTerminalKey = new Map();
const laserJobHostTerminalSince = new Map();
const laserJobHostStartTime = new Map();
const LASER_JOB_TERMINAL_DISMISS_MS = 8000;
let laserJobIsActive = false;
let laserJobThumbFilename = null;

// Igual que "Vista previa del modelo" en Gestión de Archivos: intenta la
// miniatura real incrustada por el slicer, y si el archivo no la trae, cae
// al render 3D de la trayectoria — en vez de una foto en vivo del trazo
// todavía a medio dibujar en el grill (que se ve como una mancha vacía al
// arrancar el trabajo).
async function loadLaserJobFileThumb(container, filename) {
    try {
        const response = await fetch('/api/models');
        const models = await response.json();
        const match = models.find(m => m.id.startsWith('gcode/') && m.id.split('/').pop() === filename);
        if (!match) {
            container.innerHTML = '';
            return;
        }
        const relPath = stripSectionPrefix(match.id, 'gcode');
        const fileUrl = `/uploads/gcode/${relPath.split('/').map(encodeURIComponent).join('/')}`;
        loadRealGcodeThumbnail(container, relPath, 'gcode', fileUrl);
    } catch (error) {
        console.error(error);
    }
}

function formatLaserJobDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = n => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function renderLaserJob(job, jobHost) {
    const pauseBtns = [document.getElementById('laser-pause-btn'), document.getElementById('laser-pause-btn-panel')];
    const resumeBtns = [document.getElementById('laser-resume-btn'), document.getElementById('laser-resume-btn-panel')];
    const cancelBtns = [document.getElementById('laser-cancel-btn'), document.getElementById('laser-cancel-btn-panel')];
    const progressWraps = [document.getElementById('laser-job-progress'), document.getElementById('laser-job-progress-panel')];
    const progressFills = [document.getElementById('laser-job-progress-fill'), document.getElementById('laser-job-progress-fill-panel')];
    const progressTexts = [document.getElementById('laser-job-progress-text'), document.getElementById('laser-job-progress-text-panel')];
    const errorEl = document.getElementById('laser-job-error');
    if (!pauseBtns[0]) return;

    const state = job?.state || 'idle';
    const isActive = state === 'running' || state === 'paused';
    const isTerminal = state === 'completed' || state === 'error' || state === 'cancelled';
    laserJobIsActive = isActive;

    // El estado del trabajo es por láser (host), pero el backend nunca
    // limpia el último job terminado — así que al simplemente seleccionar
    // un láser que ya tenía un error viejo no debe reaparecer la alerta;
    // solo se avisa si la transición a error ocurrió mientras ya se estaba
    // viendo ese mismo láser en esta sesión.
    const host = jobHost || document.getElementById('laser-host-select')?.value || '';
    const previousStateForHost = laserJobHostLastState.get(host);
    if (state === 'error' && previousStateForHost && previousStateForHost !== 'error') {
        appAlert(job?.error || t('laserJobErrorGeneric'), t('laserJobErrorTitle'), 'danger');
        notifyUser(t('laserJobErrorTitle'), job?.error || t('laserJobErrorGeneric'), 'error');
    }
    if (state === 'completed' && previousStateForHost && previousStateForHost !== 'completed') {
        sendLaserBedMapSnapshotToHistory(host);
        notifyUser(t('laserJobCompleteTitle'), job?.filename || '', 'success');
    }
    // Un trabajo nuevo (no una reanudación tras pausa) empieza con el grill limpio,
    // así la figura que se va formando corresponde solo al corte en curso.
    if (state === 'running' && previousStateForHost !== 'running' && previousStateForHost !== 'paused') {
        clearLaserBedMapTrace();
    }
    if (state === 'running' && !laserJobHostStartTime.has(host)) {
        laserJobHostStartTime.set(host, Date.now());
    }
    if (isTerminal || state === 'idle') {
        laserJobHostStartTime.delete(host);
    }
    laserJobHostLastState.set(host, state);

    pauseBtns.forEach(btn => { if (btn) btn.hidden = state !== 'running'; });
    resumeBtns.forEach(btn => { if (btn) btn.hidden = state !== 'paused'; });
    cancelBtns.forEach(btn => { if (btn) btn.hidden = !isActive; });

    // El backend mantiene el último job terminado indefinidamente en el
    // polling, así que aquí se controla cuánto tiempo sigue visible la
    // barra de progreso/error tras terminar, para que no quede "pegada".
    let dismissed = false;
    if (isTerminal) {
        const key = `${state}|${job?.filename || ''}|${job?.current || 0}|${job?.total || 0}|${job?.error || ''}`;
        if (key !== laserJobHostTerminalKey.get(host)) {
            laserJobHostTerminalKey.set(host, key);
            laserJobHostTerminalSince.set(host, Date.now());
        }
        dismissed = Date.now() - laserJobHostTerminalSince.get(host) > LASER_JOB_TERMINAL_DISMISS_MS;
    } else {
        laserJobHostTerminalKey.delete(host);
    }

    const showProgress = (isActive || isTerminal) && !dismissed;
    const percent = job?.total ? Math.round((job.current / job.total) * 100) : 0;
    progressWraps.forEach(el => { if (el) el.hidden = !showProgress; });
    progressFills.forEach(el => { if (el) el.style.width = `${percent}%`; });
    const progressTextLegacy = document.getElementById('laser-job-progress-text');
    if (progressTextLegacy) progressTextLegacy.textContent = `${job?.current || 0} / ${job?.total || 0}`;
    const progressTextPanel = document.getElementById('laser-job-progress-text-panel');
    if (progressTextPanel) progressTextPanel.textContent = `${percent}%`;
    if (errorEl) errorEl.textContent = dismissed ? '' : (job?.error || '');

    const infoRow = document.getElementById('laser-job-info-row');
    const statsRow = document.getElementById('laser-job-stats-row');
    if (infoRow) infoRow.hidden = !showProgress;
    if (statsRow) statsRow.hidden = !showProgress;
    if (showProgress) {
        const filenameEl = document.getElementById('laser-job-info-filename');
        if (filenameEl) filenameEl.textContent = job?.filename || '—';
        const linesEl = document.getElementById('laser-job-lines');
        if (linesEl) linesEl.textContent = `${(job?.current || 0).toLocaleString()} / ${(job?.total || 0).toLocaleString()}`;

        const startTime = laserJobHostStartTime.get(host);
        const elapsedMs = startTime ? Date.now() - startTime : null;
        const elapsedEl = document.getElementById('laser-job-elapsed');
        if (elapsedEl) elapsedEl.textContent = elapsedMs != null ? formatLaserJobDuration(elapsedMs) : '—';
        const remainingEl = document.getElementById('laser-job-remaining');
        if (remainingEl) {
            const remainingMs = (elapsedMs != null && job?.current > 0 && job?.total > job.current)
                ? (elapsedMs / job.current) * (job.total - job.current)
                : null;
            remainingEl.textContent = remainingMs != null ? formatLaserJobDuration(remainingMs) : '—';
        }

        const thumbEl = document.getElementById('laser-job-thumb');
        if (thumbEl && job?.filename && job.filename !== laserJobThumbFilename) {
            laserJobThumbFilename = job.filename;
            loadLaserJobFileThumb(thumbEl, job.filename);
        }
    } else {
        laserJobThumbFilename = null;
    }

    document.querySelectorAll('.laser-jog-btn, .laser-step-btn, #laser-unlock-btn, #laser-fire-btn, #laser-fire-power-input, #laser-air-btn').forEach(el => {
        el.disabled = isActive;
    });
}

async function refreshLaserJob() {
    try {
        // Antes esto solo consultaba el host seleccionado en pantalla, así
        // que un corte en curso "desaparecía" de la ficha en cuanto el
        // usuario miraba otro láser/CNC en la interfaz. Ahora se pregunta
        // primero si CUALQUIER host registrado tiene un trabajo propio
        // activo (running/paused) y, si lo hay, se muestra ese — sin
        // importar cuál esté seleccionado — para no perderlo de vista al
        // navegar. Si no hay ninguno activo, se sigue mostrando el estado
        // (idle/terminado) del host seleccionado, como antes.
        const activeResponse = await fetch('/api/laser/jobs/active');
        const activeData = await activeResponse.json();
        const activeJob = (activeData.jobs || [])[0];
        if (activeJob) {
            renderLaserJob(activeJob, activeJob.host);
            return;
        }

        const response = await fetch('/api/laser/job/status');
        const data = await response.json();
        renderLaserJob(data);
    } catch (error) {
        console.error(error);
    }
}

let laserStatusPollInterval = null;

function stopLaserPolling() {
    if (laserPollInterval) {
        clearInterval(laserPollInterval);
        laserPollInterval = null;
    }
    if (laserStatusPollInterval) {
        clearInterval(laserStatusPollInterval);
        laserStatusPollInterval = null;
    }
    setLaserBedMapFollowMode(false);
}

function startLaserPolling() {
    stopLaserPolling();
    refreshLaserStatus();
    refreshLaserJob();
    refreshLaserConsole();
    refreshLaserQueue();
    // La posición/trazo se consulta mucho más seguido que el resto (cola,
    // consola, job) para que el trazo del corte en el grill se vea fluido
    // en vez de ir a saltos — antes todo compartía el mismo intervalo de 2.5s.
    laserStatusPollInterval = setInterval(refreshLaserStatus, 600);
    laserPollInterval = setInterval(() => {
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
            <div class="laser-queue-item-thumb" id="laser-queue-thumb-${item.id}"></div>
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
        const thumbEl = document.getElementById(`laser-queue-thumb-${id}`);
        if (thumbEl && itemPath) {
            const fileUrl = `/uploads/gcode/${itemPath.split('/').map(encodeURIComponent).join('/')}`;
            loadRealGcodeThumbnail(thumbEl, itemPath, 'gcode', fileUrl);
        }
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

// #laser-section ahora es exclusivamente de dispositivos láser (la sección
// CNC tiene su propia ficha y su propio selector — ver switchSection()), así
// que esta función ya no decide qué sección mostrar, solo pinta el nombre y
// el acento de color del dispositivo activo dentro de la ficha de conexión.
function applyLaserMachineKindUI(host) {
    const device = laserHostOptions.find(item => item.host === host);
    const kind = device && device.kind ? device.kind : 'laser';

    const hostSelect = document.getElementById('laser-host-select');
    if (hostSelect) {
        hostSelect.style.color = getDeviceKindColor(kind);
    }

    const machineTitleEl = document.getElementById('laser-connection-machine-title');
    if (machineTitleEl) {
        const name = (device && device.hostname) || laserHostLabel(host);
        machineTitleEl.textContent = name || '';
        machineTitleEl.style.color = getDeviceKindColor(kind);
    }
}

function renderLaserHostOptions(activeHost) {
    const selectEl = document.getElementById('laser-host-select');
    if (!selectEl) return;
    let laserDevices = laserHostOptions.filter(device => (device.kind || 'laser') !== 'cnc');
    if (!laserDevices.some(device => device.host === activeHost)) {
        laserDevices = [{ host: activeHost, hostname: '' }, ...laserDevices];
    }
    selectEl.innerHTML = laserDevices.map(device => {
        const label = device.hostname ? `${device.hostname} (${device.host})` : device.host;
        const color = getDeviceKindColor(device.kind || 'laser');
        return `<option value="${escapeHtml(device.host)}" style="color:${color}">${escapeHtml(label)}</option>`;
    }).join('');
    selectEl.value = activeHost;
    const modeEl = document.getElementById('laser-connection-mode');
    if (modeEl) modeEl.textContent = laserConnectionModeLabel(activeHost);
    applyLaserMachineKindUI(activeHost);
    const consoleNameEl = document.getElementById('laser-console-active-name');
    if (consoleNameEl) {
        const device = laserDevices.find(item => item.host === activeHost);
        consoleNameEl.textContent = (device && device.hostname) || laserHostLabel(activeHost) || '—';
    }
    renderLaserBedMap(activeHost);
}

let laserBedMapWorkArea = null;

// ── Preferencias del marcador de posición del láser (forma/color) ──
const LASER_MARKER_SHAPE_KEY = 'laserMarkerShape';
const LASER_MARKER_COLOR_KEY = 'laserMarkerColor';
const LASER_MARKER_COLORS = ['#22c55e', '#f59e0b', '#3b82f6', '#ef4444', '#a855f7'];

function getLaserMarkerShape() {
    return localStorage.getItem(LASER_MARKER_SHAPE_KEY) || 'dot';
}

function getLaserMarkerColor() {
    const saved = localStorage.getItem(LASER_MARKER_COLOR_KEY);
    return LASER_MARKER_COLORS.includes(saved) ? saved : LASER_MARKER_COLORS[0];
}

function applyLaserMarkerToDot() {
    const shape = getLaserMarkerShape();
    const color = getLaserMarkerColor();
    [document.getElementById('laser-bed-map-dot'), document.getElementById('laser-marker-preview-dot')].forEach(el => {
        if (!el) return;
        el.classList.toggle('shape-cross', shape === 'cross');
        el.style.setProperty('--laser-marker-color', color);
    });
}

function renderLaserMarkerSettings() {
    const shapeContainer = document.getElementById('laser-marker-shape-options');
    const colorContainer = document.getElementById('laser-marker-color-options');
    if (shapeContainer) {
        const shape = getLaserMarkerShape();
        shapeContainer.querySelectorAll('.laser-marker-shape-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.shape === shape);
        });
    }
    if (colorContainer) {
        const color = getLaserMarkerColor();
        colorContainer.querySelectorAll('.laser-marker-color-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.color === color);
        });
    }
    applyLaserMarkerToDot();
}

document.getElementById('laser-marker-shape-options')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.laser-marker-shape-btn');
    if (!btn) return;
    localStorage.setItem(LASER_MARKER_SHAPE_KEY, btn.dataset.shape);
    renderLaserMarkerSettings();
    applyLaserMarkerToDot();
});

document.getElementById('laser-marker-color-options')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.laser-marker-color-btn');
    if (!btn) return;
    localStorage.setItem(LASER_MARKER_COLOR_KEY, btn.dataset.color);
    renderLaserMarkerSettings();
    applyLaserMarkerToDot();
});

function renderLaserBedMapAxisTicks() {
    const axisX = document.getElementById('laser-bed-map-axis-x');
    const axisY = document.getElementById('laser-bed-map-axis-y');
    if (!axisX || !axisY) return;
    if (!laserBedMapWorkArea) {
        axisX.innerHTML = '';
        axisY.innerHTML = '';
        return;
    }
    const steps = 4;
    const xTicks = [];
    const yTicks = [];
    for (let i = 0; i <= steps; i++) {
        xTicks.push(Math.round((laserBedMapWorkArea.width / steps) * i));
        yTicks.push(Math.round((laserBedMapWorkArea.height / steps) * i));
    }
    axisX.innerHTML = xTicks.map(v => `<span>${v}</span>`).join('');
    axisY.innerHTML = yTicks.map(v => `<span>${v}</span>`).join('');
}

function renderLaserBedMap(host) {
    const mapEl = document.getElementById('laser-bed-map');
    const emptyEl = document.getElementById('laser-bed-map-empty');
    const dimsEl = document.getElementById('laser-bed-map-dims');
    const dotEl = document.getElementById('laser-bed-map-dot');
    if (!mapEl) return;

    const device = laserHostOptions.find(item => item.host === host);
    const workArea = device && device.workArea;
    laserBedMapWorkArea = (workArea && workArea.width && workArea.height) ? workArea : null;
    clearLaserBedMapTrace();
    setLaserBedMapFollowMode(false);

    if (!laserBedMapWorkArea) {
        if (emptyEl) emptyEl.hidden = false;
        if (dotEl) dotEl.hidden = true;
        if (dimsEl) dimsEl.textContent = '';
        mapEl.style.aspectRatio = '1 / 1';
        renderLaserBedMapAxisTicks();
        return;
    }

    if (emptyEl) emptyEl.hidden = true;
    if (dotEl) dotEl.hidden = false;
    applyLaserMarkerToDot();
    if (dimsEl) dimsEl.textContent = `${laserBedMapWorkArea.width} × ${laserBedMapWorkArea.height} mm`;
    mapEl.style.aspectRatio = `${laserBedMapWorkArea.width} / ${laserBedMapWorkArea.height}`;
    renderLaserBedMapAxisTicks();
}

let laserBedMapTracePoints = [];

function clearLaserBedMapTrace() {
    laserBedMapTracePoints = [];
    const line = document.getElementById('laser-bed-map-trace-line');
    if (line) line.setAttribute('points', '');
}

function addLaserBedMapTracePoint(percentX, percentY) {
    laserBedMapTracePoints.push(`${percentX.toFixed(2)},${(100 - percentY).toFixed(2)}`);
    if (laserBedMapTracePoints.length > 8000) laserBedMapTracePoints.shift();
    const line = document.getElementById('laser-bed-map-trace-line');
    if (line) line.setAttribute('points', laserBedMapTracePoints.join(' '));
}

// Captura la figura trazada en el grill (no el grid ni el fondo, solo el
// trazo real del corte) como un SVG compacto, para guardarla como miniatura
// del trabajo en el historial de impresión del láser.
function captureLaserBedMapSnapshot() {
    if (!laserBedMapTracePoints.length) return null;
    const points = laserBedMapTracePoints.join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="220" height="220">`
        + `<rect width="100" height="100" fill="#07130d"/>`
        + `<polyline points="${points}" fill="none" stroke="#22c55e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
        + `</svg>`;
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

async function sendLaserBedMapSnapshotToHistory(host) {
    const snapshot = captureLaserBedMapSnapshot();
    if (!snapshot || !host) return;
    try {
        const formData = new FormData();
        formData.append('host', host);
        formData.append('snapshot', snapshot);
        await fetch('/api/laser/history/snapshot', { method: 'POST', body: formData });
    } catch (error) {
        console.error(error);
    }
}

function updateLaserBedMapPosition(x, y, tracing) {
    const dotEl = document.getElementById('laser-bed-map-dot');
    if (!dotEl || !laserBedMapWorkArea || dotEl.hidden) return;
    const percentX = Math.min(100, Math.max(0, (x / laserBedMapWorkArea.width) * 100));
    const percentY = Math.min(100, Math.max(0, (y / laserBedMapWorkArea.height) * 100));
    dotEl.style.left = `${percentX}%`;
    dotEl.style.bottom = `${percentY}%`;
    if (tracing) addLaserBedMapTracePoint(percentX, percentY);
}

// ── Mover el láser haciendo click sobre el mapa de cama ──
function laserBedMapCoordsFromEvent(event) {
    if (!laserBedMapWorkArea) return null;
    const mapEl = document.getElementById('laser-bed-map');
    if (!mapEl) return null;
    const rect = mapEl.getBoundingClientRect();
    const fracX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const fracY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    return {
        x: fracX * laserBedMapWorkArea.width,
        y: (1 - fracY) * laserBedMapWorkArea.height,
    };
}

const laserBedMapEl = document.getElementById('laser-bed-map');
if (laserBedMapEl) {
    const hoverCoordsEl = document.getElementById('laser-bed-map-hover-coords');

    laserBedMapEl.addEventListener('mousemove', (event) => {
        const coords = laserBedMapCoordsFromEvent(event);
        if (!coords || !hoverCoordsEl) return;
        hoverCoordsEl.textContent = `X: ${coords.x.toFixed(1)}  Y: ${coords.y.toFixed(1)}`;
        hoverCoordsEl.hidden = false;
    });

    laserBedMapEl.addEventListener('mouseleave', () => {
        if (hoverCoordsEl) hoverCoordsEl.hidden = true;
    });

    laserBedMapEl.addEventListener('click', async (event) => {
        if (laserJobIsActive) return;
        const coords = laserBedMapCoordsFromEvent(event);
        if (!coords) return;
        await sendLaserRawCommand(`G90 G21 G0 X${coords.x.toFixed(2)} Y${coords.y.toFixed(2)} F${LASER_JOG_FEED}`);
        refreshLaserStatus();
    });
}

// ── Zoom del mapa de cama, para ver mejor la figura mientras se corta ──
let laserBedMapZoom = 1;
const LASER_BED_MAP_ZOOM_MIN = 1;
const LASER_BED_MAP_ZOOM_MAX = 25;
const LASER_BED_MAP_ZOOM_STEP = 0.5;

function applyLaserBedMapZoom() {
    if (laserBedMapEl) laserBedMapEl.style.setProperty('--bed-zoom', laserBedMapZoom);
    const label = document.getElementById('laser-bed-map-zoom-label');
    if (label) label.textContent = `${Math.round(laserBedMapZoom * 100)}%`;
}

document.getElementById('laser-bed-map-zoom-in')?.addEventListener('click', () => {
    setLaserBedMapFollowMode(false);
    laserBedMapZoom = Math.min(LASER_BED_MAP_ZOOM_MAX, laserBedMapZoom + LASER_BED_MAP_ZOOM_STEP);
    applyLaserBedMapZoom();
});

document.getElementById('laser-bed-map-zoom-out')?.addEventListener('click', () => {
    setLaserBedMapFollowMode(false);
    laserBedMapZoom = Math.max(LASER_BED_MAP_ZOOM_MIN, laserBedMapZoom - LASER_BED_MAP_ZOOM_STEP);
    applyLaserBedMapZoom();
});

document.getElementById('laser-bed-map-zoom-reset')?.addEventListener('click', () => {
    setLaserBedMapFollowMode(false);
    laserBedMapZoom = 1;
    applyLaserBedMapZoom();
    const viewport = document.getElementById('laser-bed-map-viewport');
    if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
});

// Ajusta zoom + scroll al recuadro de lo que ya se trazó en el grill (no al
// tamaño teórico del archivo completo) — así con una figura chica en una
// cama grande se ve el detalle real del avance, sin agrandar el punto ni el
// grosor del trazo (solo se acerca la "cámara", zoom uniforme de todo el mapa).
function fitLaserBedMapToTrace() {
    if (!laserBedMapTracePoints.length || !laserBedMapWorkArea) {
        showToast(t('laserFitNoJob'), 'warning');
        setLaserBedMapFollowMode(false);
        return;
    }
    let minPX = Infinity, maxPX = -Infinity, minPY = Infinity, maxPY = -Infinity;
    laserBedMapTracePoints.forEach(point => {
        const [xStr, svgYStr] = point.split(',');
        const px = parseFloat(xStr);
        const py = 100 - parseFloat(svgYStr); // de vuelta a % en espacio de la cama (origen abajo-izquierda)
        if (Number.isNaN(px) || Number.isNaN(py)) return;
        minPX = Math.min(minPX, px);
        maxPX = Math.max(maxPX, px);
        minPY = Math.min(minPY, py);
        maxPY = Math.max(maxPY, py);
    });
    if (!isFinite(minPX)) return;

    // Mínimo 4% de span para que un trazo muy chico (o un solo punto) no pida zoom infinito.
    const spanXPercent = Math.max(4, maxPX - minPX);
    const spanYPercent = Math.max(4, maxPY - minPY);
    const zoomX = 100 / spanXPercent;
    const zoomY = 100 / spanYPercent;
    // 0.75 deja margen alrededor de la figura en vez de pegarla a los bordes del visor.
    laserBedMapZoom = Math.min(LASER_BED_MAP_ZOOM_MAX, Math.max(LASER_BED_MAP_ZOOM_MIN, Math.min(zoomX, zoomY) * 0.75));
    applyLaserBedMapZoom();

    const viewport = document.getElementById('laser-bed-map-viewport');
    const mapEl = document.getElementById('laser-bed-map');
    if (!viewport || !mapEl) return;
    requestAnimationFrame(() => {
        const centerPX = (minPX + maxPX) / 2;
        const centerPY = (minPY + maxPY) / 2;
        viewport.scrollLeft = (centerPX / 100) * mapEl.offsetWidth - viewport.clientWidth / 2;
        viewport.scrollTop = (1 - centerPY / 100) * mapEl.offsetHeight - viewport.clientHeight / 2;
    });
}

// Zoom fijo (no follow) al tamaño real del archivo apenas arranca el
// trabajo, usando el bounding box en mm calculado por parseGcodeBoundingBox
// (no el trazo ya recorrido, que recién arrancando está vacío).
function zoomLaserBedMapToBounds(bbox) {
    if (!bbox || !laserBedMapWorkArea) return;
    const minPX = Math.min(100, Math.max(0, (bbox.minX / laserBedMapWorkArea.width) * 100));
    const maxPX = Math.min(100, Math.max(0, (bbox.maxX / laserBedMapWorkArea.width) * 100));
    const minPY = Math.min(100, Math.max(0, (bbox.minY / laserBedMapWorkArea.height) * 100));
    const maxPY = Math.min(100, Math.max(0, (bbox.maxY / laserBedMapWorkArea.height) * 100));

    const spanXPercent = Math.max(4, maxPX - minPX);
    const spanYPercent = Math.max(4, maxPY - minPY);
    const zoomX = 100 / spanXPercent;
    const zoomY = 100 / spanYPercent;
    laserBedMapZoom = Math.min(LASER_BED_MAP_ZOOM_MAX, Math.max(LASER_BED_MAP_ZOOM_MIN, Math.min(zoomX, zoomY) * 0.75));
    applyLaserBedMapZoom();

    const viewport = document.getElementById('laser-bed-map-viewport');
    const mapEl = document.getElementById('laser-bed-map');
    if (!viewport || !mapEl) return;
    requestAnimationFrame(() => {
        const centerPX = (minPX + maxPX) / 2;
        // Mismo origen abajo-izquierda que fitLaserBedMapToTrace — el SVG/scroll
        // usan Y invertido (arriba = 0), por eso 1 - centerPY/100.
        const centerPY = (minPY + maxPY) / 2;
        viewport.scrollLeft = (centerPX / 100) * mapEl.offsetWidth - viewport.clientWidth / 2;
        viewport.scrollTop = (1 - centerPY / 100) * mapEl.offsetHeight - viewport.clientHeight / 2;
    });
}

let laserBedMapFollowInterval = null;

// Al activarse, cada 10s vuelve a llamar fitLaserBedMapToTrace() para seguir
// el avance del trazo — corre en su propio timer, separado del sondeo de
// posición/trabajo, para no interferir con la barra de progreso.
function setLaserBedMapFollowMode(enabled) {
    if (laserBedMapFollowInterval) {
        clearInterval(laserBedMapFollowInterval);
        laserBedMapFollowInterval = null;
    }
    if (enabled) {
        laserBedMapFollowInterval = setInterval(fitLaserBedMapToTrace, 10000);
    }
    document.getElementById('laser-bed-map-zoom-fit')?.classList.toggle('active', enabled);
}

document.getElementById('laser-bed-map-zoom-fit')?.addEventListener('click', () => {
    if (laserBedMapFollowInterval) {
        setLaserBedMapFollowMode(false);
        return;
    }
    fitLaserBedMapToTrace();
    setLaserBedMapFollowMode(true);
});

document.getElementById('laser-bed-map-viewport')?.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    laserBedMapZoom = Math.min(LASER_BED_MAP_ZOOM_MAX, Math.max(LASER_BED_MAP_ZOOM_MIN, laserBedMapZoom + (event.deltaY < 0 ? LASER_BED_MAP_ZOOM_STEP : -LASER_BED_MAP_ZOOM_STEP)));
    applyLaserBedMapZoom();
}, { passive: false });

// ── Detección de control/joystick (Gamepad API) — por ahora solo se muestra
// como conectado; el mapeo a movimiento del cabezal queda para más adelante.
function renderGamepadBadge() {
    const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    const active = Array.from(pads).find(pad => pad);
    const shortName = active ? active.id.replace(/\s*\(.*?\)\s*$/, '') : t('laserGamepadNone');

    document.querySelectorAll('.laser-gamepad-badge').forEach(badge => {
        badge.classList.toggle('connected', !!active);
        badge.title = active ? active.id : '';
        const label = badge.querySelector('.laser-gamepad-badge-label');
        if (label) label.textContent = shortName;
    });

    const selectLabel = document.getElementById('laser-gamepad-select-label');
    if (selectLabel) selectLabel.textContent = shortName;
}

if ('getGamepads' in navigator) {
    // El evento gamepadconnected no es confiable en todos los navegadores
    // (Chrome/Edge suelen requerir que se presione un botón del control antes
    // de dispararlo), así que además se hace sondeo periódico como respaldo.
    window.addEventListener('gamepadconnected', renderGamepadBadge);
    window.addEventListener('gamepaddisconnected', renderGamepadBadge);
    renderGamepadBadge();
    setInterval(renderGamepadBadge, 1000);
}

// ── Mapeo de botones del control/pendant a acciones del láser ──
// Pensado para pendants tipo Sculpfun (Pausa/Parar/Iniciar/Origen/Regresar a 0/
// Láser + cruceta de movimiento), que se enumeran como gamepad genérico con
// botones fijos — no hay forma de conocer de antemano qué índice de botón
// corresponde a cada etiqueta física, así que el usuario los asigna a mano.
// kind: 'both' = tiene sentido en las dos máquinas (con la función real
// resuelta según cuál esté activa), 'laser'/'cnc' = solo aplica a esa
// máquina. La lista siempre muestra TODAS las acciones — asignar un botón es
// una tarea de una sola vez, no depende de qué máquina esté activa ahora
// mismo; lo que cambia según la máquina es qué pasa al apretarlo (ver
// runGamepadAction).
const LASER_GAMEPAD_ACTIONS = [
    { id: 'jogUp', kind: 'both', label: t('laserGamepadJogUp'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>' },
    { id: 'jogDown', kind: 'both', label: t('laserGamepadJogDown'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>' },
    { id: 'jogLeft', kind: 'both', label: t('laserGamepadJogLeft'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>' },
    { id: 'jogRight', kind: 'both', label: t('laserGamepadJogRight'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' },
    { id: 'jogZUp', kind: 'cnc', label: t('gamepadJogZUp'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>' },
    { id: 'jogZDown', kind: 'cnc', label: t('gamepadJogZDown'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>' },
    { id: 'pause', kind: 'both', label: t('laserPause'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' },
    { id: 'resume', kind: 'both', label: t('laserGamepadResume'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>' },
    { id: 'cancel', kind: 'both', label: t('laserGamepadStop'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>' },
    { id: 'toggleTool', kind: 'both', label: t('gamepadToggleTool'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg>' },
    { id: 'goToOrigin', kind: 'both', label: t('laserGamepadGoToOrigin'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>' },
    { id: 'setOrigin', kind: 'both', label: t('laserGamepadSetOrigin'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>' },
    { id: 'frame', kind: 'laser', label: t('laserGamepadFrame'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>' },
];
const LASER_GAMEPAD_MAP_KEY = 'laserGamepadMap';

function getLaserGamepadMap() {
    let map;
    try {
        map = JSON.parse(localStorage.getItem(LASER_GAMEPAD_MAP_KEY) || '{}');
    } catch (error) {
        map = {};
    }
    // Migración de la acción renombrada laserToggle -> toggleTool (ahora
    // representa dos comportamientos reales según la máquina, no solo
    // láser) — se corre en cada lectura, así nadie pierde su botón ya
    // asignado por el renombre; es idempotente (no vuelve a correr una vez
    // migrado, porque laserToggle ya no existe en el mapa guardado).
    if (map.laserToggle !== undefined && map.toggleTool === undefined) {
        map.toggleTool = map.laserToggle;
        delete map.laserToggle;
        saveLaserGamepadMap(map);
    }
    return map;
}

function saveLaserGamepadMap(map) {
    localStorage.setItem(LASER_GAMEPAD_MAP_KEY, JSON.stringify(map));
}

// El paso/feed de jog reusa EXACTAMENTE la misma resolución que ya usan los
// botones en pantalla (app.js, handler de '.laser-jog-btn[data-axis]') —
// así el gamepad nunca mueve a una distancia distinta de lo que la pantalla
// muestra como paso activo. Los botones de jog en pantalla del CNC no
// tienen ningún guard de "trabajo activo" (a diferencia del láser, que sí
// lo tenía acá) — se mantiene ese guard solo para láser, sin inventar uno
// nuevo para CNC que no existe en ningún otro control de CNC.
async function gamepadJog(axis, dir, activeKind) {
    const inCnc = activeKind === 'cnc';
    if (!inCnc && laserJobIsActive) return;
    const step = inCnc ? (axis === 'Z' ? cncJogStepZ : cncJogStep) : laserJogStep;
    const feed = inCnc ? (CNC_JOG_FEED_BY_MODE[cncJogFeedMode] || CNC_JOG_FEED_BY_MODE.normal) : LASER_JOG_FEED;
    await sendLaserJog(axis, step * dir, feed);
    if (inCnc) refreshCncStatus(); else refreshLaserStatus();
}

async function gamepadGoToOrigin(activeKind) {
    const inCnc = activeKind === 'cnc';
    if (!inCnc && laserJobIsActive) return;
    const feed = inCnc ? (CNC_JOG_FEED_BY_MODE[cncJogFeedMode] || CNC_JOG_FEED_BY_MODE.normal) : LASER_JOG_FEED;
    await sendLaserRawCommand(`G90 G21 G0 X0 Y0 F${feed}`);
    if (inCnc) refreshCncStatus(); else refreshLaserStatus();
}

async function gamepadSetOrigin(activeKind) {
    const inCnc = activeKind === 'cnc';
    if (!inCnc && laserJobIsActive) return;
    await sendLaserRawCommand('G92 X0 Y0');
    if (inCnc) refreshCncStatus(); else refreshLaserStatus();
}

async function gamepadToggleTool(activeKind) {
    if (activeKind === 'cnc') {
        // Sin husillo en modo plotter — no hay nada que alternar.
        if (document.body.getAttribute('data-cnc-profile') === 'plotter') return;
        await setCncSpindleMode(cncSpindleMode === 'off' ? 'cw' : 'off');
    } else {
        toggleLaserFire();
    }
}

async function frameQueuedLaserJob() {
    if (laserJobIsActive) return;
    try {
        const response = await fetch('/api/laser/queue');
        const data = await response.json();
        const first = (data.queue || [])[0];
        if (!first) {
            appAlert(t('laserQueueEmpty'), '', 'warning');
            return;
        }
        const fileUrl = `/uploads/gcode/${first.path.split('/').map(encodeURIComponent).join('/')}`;
        const fileResponse = await fetch(fileUrl);
        const gcodeText = fileResponse.ok ? await fileResponse.text() : '';
        await frameLaserJob(gcodeText);
    } catch (error) {
        console.error(error);
    }
}

// activeKind: 'laser' | 'cnc' — resuelto por pollLaserGamepad() según qué
// sección esté activa. Las acciones kind:'laser' (frame) no hacen nada en
// CNC (no tienen equivalente real); no hay acciones kind:'cnc' además de
// jogZUp/jogZDown que necesiten no-opear en láser porque un láser no tiene Z.
function runLaserGamepadAction(actionId, activeKind) {
    const inCnc = activeKind === 'cnc';
    switch (actionId) {
        case 'jogUp': gamepadJog('Y', 1, activeKind); break;
        case 'jogDown': gamepadJog('Y', -1, activeKind); break;
        case 'jogLeft': gamepadJog('X', -1, activeKind); break;
        case 'jogRight': gamepadJog('X', 1, activeKind); break;
        case 'jogZUp': if (inCnc) gamepadJog('Z', 1, activeKind); break;
        case 'jogZDown': if (inCnc) gamepadJog('Z', -1, activeKind); break;
        case 'pause': handleLaserPause(); break;
        case 'resume': handleLaserResume(); break;
        case 'cancel': handleLaserCancel(); break;
        case 'toggleTool': gamepadToggleTool(activeKind); break;
        case 'goToOrigin': gamepadGoToOrigin(activeKind); break;
        case 'setOrigin': gamepadSetOrigin(activeKind); break;
        case 'frame': if (!inCnc) frameQueuedLaserJob(); break;
    }
}

let laserGamepadLearnTarget = null;
let laserGamepadPrevPressed = [];
let laserGamepadLastJogAt = 0;

function pollLaserGamepad() {
    // activeKind resuelve cuál de las dos secciones está activa (o ninguna,
    // 'null', si el usuario está en Dashboard/Configuración/etc — ahí el
    // gamepad no dispara nada, igual que antes cuando solo existía láser).
    const laserSection = document.getElementById('laser-section');
    const cncSection = document.getElementById('cnc-section');
    const onLaserSection = laserSection && laserSection.classList.contains('active');
    const onCncSection = cncSection && cncSection.classList.contains('active');
    const activeKind = onCncSection ? 'cnc' : (onLaserSection ? 'laser' : null);
    const gamepadModalOpen = document.getElementById('laser-gamepad-modal')?.classList.contains('active');
    const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    const pad = Array.from(pads).find(p => p);

    if (pad && (activeKind || laserGamepadLearnTarget || gamepadModalOpen)) {
        const map = getLaserGamepadMap();
        const now = Date.now();
        const pressedNow = pad.buttons.map(btn => btn.pressed || btn.value > 0.5);

        pressedNow.forEach((isPressed, index) => {
            const wasPressed = !!laserGamepadPrevPressed[index];

            if (isPressed && !wasPressed && laserGamepadLearnTarget) {
                const newMap = getLaserGamepadMap();
                newMap[laserGamepadLearnTarget] = index;
                saveLaserGamepadMap(newMap);
                laserGamepadLearnTarget = null;
                renderLaserGamepadMapList();
                return;
            }

            const actionId = Object.keys(map).find(key => map[key] === index);

            // Con el modal de mapeo abierto, reflejar en la consola qué botón
            // se está presionando ahora mismo — independiente de si además
            // dispara la acción real (eso depende de qué sección esté activa).
            if (gamepadModalOpen && actionId && isPressed !== wasPressed) {
                document.querySelectorAll(`#laser-gamepad-console [data-console-action="${actionId}"]`).forEach(el => {
                    el.classList.toggle('pressed', isPressed);
                });
            }

            if (laserGamepadLearnTarget || !activeKind || !actionId) return;

            // Con la ficha de confirmación previa a imprimir abierta ("Enmarcar /
            // Iniciar / Cancelar"), el control debe operar ESA ficha en vez de
            // disparar las acciones normales del panel láser (que todavía
            // corren por detrás mientras el modal espera respuesta).
            const startConfirmModal = document.getElementById('laser-start-confirm-modal');
            if (startConfirmModal?.classList.contains('active')) {
                if (isPressed && !wasPressed) {
                    const btnId = actionId === 'frame' ? 'laser-start-confirm-frame-btn'
                        : actionId === 'resume' ? 'laser-start-confirm-start-btn'
                        : actionId === 'cancel' ? 'laser-start-confirm-cancel-btn'
                        : null;
                    if (btnId) document.getElementById(btnId)?.click();
                }
                return;
            }

            if (actionId.startsWith('jog')) {
                if (isPressed && now - laserGamepadLastJogAt > 160) {
                    runLaserGamepadAction(actionId, activeKind);
                    laserGamepadLastJogAt = now;
                }
            } else if (isPressed && !wasPressed) {
                runLaserGamepadAction(actionId, activeKind);
            }
        });

        laserGamepadPrevPressed = pressedNow;
    } else {
        laserGamepadPrevPressed = [];
    }

    requestAnimationFrame(pollLaserGamepad);
}

if ('getGamepads' in navigator) {
    requestAnimationFrame(pollLaserGamepad);
}

function renderLaserGamepadMapList() {
    const lists = document.querySelectorAll('.laser-gamepad-map-list');
    const map = getLaserGamepadMap();

    if (lists.length) {
        const html = LASER_GAMEPAD_ACTIONS.map(action => {
            const assigned = map[action.id];
            const listening = laserGamepadLearnTarget === action.id;
            const kindBadge = action.kind !== 'both'
                ? `<span class="laser-gamepad-map-row-badge" style="color:${getDeviceKindColor(action.kind)};border-color:${getDeviceKindColor(action.kind)}">${action.kind.toUpperCase()}</span>`
                : '';
            return `
                <div class="laser-gamepad-map-row">
                    <span class="laser-gamepad-map-row-label"><span class="laser-gamepad-map-row-icon">${action.icon || ''}</span>${escapeHtml(action.label)}${kindBadge}</span>
                    <span class="laser-gamepad-map-state">
                        <span class="laser-gamepad-map-state-dot${assigned != null ? ' assigned' : ''}"></span>
                        ${assigned != null ? t('laserGamepadStateAssigned') : t('laserGamepadStateUnassigned')}
                    </span>
                    <button type="button" class="laser-gamepad-assign-btn${listening ? ' listening' : ''}" data-action="${action.id}">
                        ${listening ? t('laserGamepadListening') : t('laserGamepadAssign')}
                    </button>
                </div>
            `;
        }).join('');

        lists.forEach(list => {
            list.innerHTML = html;
            list.querySelectorAll('.laser-gamepad-assign-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    laserGamepadLearnTarget = laserGamepadLearnTarget === btn.dataset.action ? null : btn.dataset.action;
                    renderLaserGamepadMapList();
                });
            });
        });
    }

    document.querySelectorAll('#laser-gamepad-console [data-console-action]').forEach(el => {
        el.classList.toggle('assigned', map[el.dataset.consoleAction] != null);
    });
}

// Actualiza la consola decorativa del modal para reflejar qué sección está
// activa ahora mismo: el slot "LASER" cambia a "HUSILLO" (ícono + etiqueta)
// en CNC, los slots Z+/Z- se atenúan fuera de CNC, y ENMARCAR (solo láser)
// se atenúa en CNC. Se llama al abrir el modal y al cambiar de sección — no
// hace falta correrlo en cada frame, la sección activa no cambia tan seguido.
const GAMEPAD_TOOL_ICON_LASER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/></svg>';
const GAMEPAD_TOOL_ICON_SPINDLE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6"/><path d="M12 6c0-2-2-3-2-3M12 8c0-2 2-3 2-3"/><path d="M8 12h8l-2 10h-4z"/></svg>';

function updateGamepadConsoleForSection() {
    const cncSection = document.getElementById('cnc-section');
    const onCnc = cncSection && cncSection.classList.contains('active');

    const toggleBtn = document.querySelector('#laser-gamepad-console [data-console-action="toggleTool"]');
    if (toggleBtn) {
        const labelEl = toggleBtn.querySelector('.lgc-btn-label');
        const iconEl = toggleBtn.querySelector('.lgc-btn-icon');
        if (labelEl) labelEl.textContent = t(onCnc ? 'laserGamepadConsoleSpindle' : 'laserGamepadConsoleLaser');
        if (iconEl) iconEl.innerHTML = onCnc ? GAMEPAD_TOOL_ICON_SPINDLE : GAMEPAD_TOOL_ICON_LASER;
    }
    document.querySelectorAll('#laser-gamepad-console [data-console-action="frame"]').forEach(el => {
        el.classList.toggle('lgc-btn-unassignable', onCnc);
    });
    document.querySelectorAll('#laser-gamepad-console [data-console-action="jogZUp"], #laser-gamepad-console [data-console-action="jogZDown"]').forEach(el => {
        el.classList.toggle('lgc-btn-unassignable', !onCnc);
    });
}

function openLaserGamepadModal() {
    laserGamepadLearnTarget = null;
    renderLaserGamepadMapList();
    updateGamepadConsoleForSection();
    document.getElementById('laser-gamepad-modal')?.classList.add('active');
}

function closeLaserGamepadModal() {
    laserGamepadLearnTarget = null;
    document.getElementById('laser-gamepad-modal')?.classList.remove('active');
}

document.querySelectorAll('.laser-gamepad-badge').forEach(badge => {
    badge.addEventListener('click', openLaserGamepadModal);
});
document.getElementById('laser-gamepad-modal-backdrop')?.addEventListener('click', closeLaserGamepadModal);
document.getElementById('laser-gamepad-modal-close')?.addEventListener('click', closeLaserGamepadModal);
document.getElementById('laser-gamepad-save-btn')?.addEventListener('click', closeLaserGamepadModal);
document.getElementById('laser-gamepad-reset-btn')?.addEventListener('click', async () => {
    if (!(await appConfirm(t('laserGamepadResetConfirm'), t('customThemeReset'), 'danger'))) return;
    saveLaserGamepadMap({});
    laserGamepadLearnTarget = null;
    renderLaserGamepadMapList();
});

async function loadLaserHostSelector() {
    try {
        const [hostResponse, registryResponse] = await Promise.all([
            fetch('/api/laser/host'),
            fetch('/api/laser/registry/status'),
        ]);
        const hostData = await hostResponse.json();
        const registryData = await registryResponse.json();
        const registryEntries = registryData.lasers || [];
        const registryHosts = new Set(registryEntries.map(entry => entry.host));

        // Descarta restos de escaneos anteriores que ya no están registrados,
        // para que el selector no acumule dispositivos fantasma indefinidamente.
        laserHostOptions = laserHostOptions.filter(device => registryHosts.has(device.host) || device.host === hostData.host);

        registryEntries.forEach(entry => {
            const existing = laserHostOptions.find(device => device.host === entry.host);
            if (existing) {
                existing.hostname = entry.name;
                existing.kind = entry.kind || 'laser';
                existing.workArea = entry.work_area || null;
                existing.homeCorner = entry.home_corner || null;
                existing.machineProfile = entry.machine_profile || 'router';
                existing.online = entry.online;
            } else {
                laserHostOptions.push({
                    host: entry.host,
                    hostname: entry.name,
                    kind: entry.kind || 'laser',
                    workArea: entry.work_area || null,
                    homeCorner: entry.home_corner || null,
                    machineProfile: entry.machine_profile || 'router',
                    online: entry.online,
                });
            }
        });

        // El selector de conexión solo debe ofrecer placas realmente
        // conectadas ahora mismo — "Todos los dispositivos" en Configuración
        // ya cubre ver/quitar las que están sin conexión.
        laserHostOptions = laserHostOptions.filter(device => device.online !== false);

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
            localStorage.setItem('lastLaserHost', laserHostSelect.value);
            const modeEl = document.getElementById('laser-connection-mode');
            if (modeEl) modeEl.textContent = laserConnectionModeLabel(laserHostSelect.value);
            applyLaserMachineKindUI(laserHostSelect.value);
            loadLaserBoardInfo();
            refreshLaserStatus();
            refreshLaserJob();
            refreshLaserConsole();
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
        const host = document.getElementById('laser-host-select')?.value;
        const url = `/api/laser/console?count=150${host ? `&host=${encodeURIComponent(host)}` : ''}`;
        const response = await fetch(url);
        const data = await response.json();
        renderLaserConsoleLog(data.messages || []);
    } catch (error) {
        console.error(error);
    }
}

const laserConsoleForm = document.getElementById('laser-console-form');
const laserConsoleHistory = [];
let laserConsoleHistoryIndex = -1;
let laserConsoleHistoryDraft = '';

if (laserConsoleForm) {
    laserConsoleForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('laser-console-input');
        const command = input?.value.trim();
        if (!command) return;
        input.value = '';
        if (laserConsoleHistory[laserConsoleHistory.length - 1] !== command) {
            laserConsoleHistory.push(command);
        }
        laserConsoleHistoryIndex = -1;
        laserConsoleHistoryDraft = '';
        const host = document.getElementById('laser-host-select')?.value;
        await sendLaserRawCommand(command, host);
        // Ráfaga de refrescos cortos en vez de esperar el poll de 2.5s — cubre
        // tanto respuestas rápidas como el resto de una respuesta larga tipo
        // $$ que la placa tarda unos cientos de ms en terminar de transmitir.
        [150, 400, 900, 1800].forEach(delay => setTimeout(refreshLaserConsole, delay));
    });

    const laserConsoleInputEl = document.getElementById('laser-console-input');
    laserConsoleInputEl?.addEventListener('keydown', (event) => {
        if (!laserConsoleHistory.length) return;
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (laserConsoleHistoryIndex === -1) laserConsoleHistoryDraft = laserConsoleInputEl.value;
            laserConsoleHistoryIndex = Math.min(laserConsoleHistoryIndex + 1, laserConsoleHistory.length - 1);
            laserConsoleInputEl.value = laserConsoleHistory[laserConsoleHistory.length - 1 - laserConsoleHistoryIndex];
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (laserConsoleHistoryIndex <= 0) {
                laserConsoleHistoryIndex = -1;
                laserConsoleInputEl.value = laserConsoleHistoryDraft;
            } else {
                laserConsoleHistoryIndex -= 1;
                laserConsoleInputEl.value = laserConsoleHistory[laserConsoleHistory.length - 1 - laserConsoleHistoryIndex];
            }
        }
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

function renderLaserSettings(settings, firmware) {
    const container = document.getElementById('laser-settings-grid');
    if (!container) return;
    if (!settings || !settings.length) {
        // Marlin no tiene parámetros $$ (GET /api/laser/settings devuelve
        // settings:[] a propósito para esos hosts) — mensaje distinto del de
        // "sin conexión" para no confundir a alguien con una placa Marlin
        // conectada y online que simplemente no tiene nada que listar acá.
        const message = firmware === 'marlin' ? t('cncSettingsNotAvailableMarlin') : t('laserOffline');
        container.innerHTML = `<div class="empty-state-small">${message}</div>`;
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
        const [settingsResponse, statusResponse] = await Promise.all([
            fetch('/api/laser/settings'),
            fetch('/api/laser/status'),
        ]);
        if (!settingsResponse.ok) throw new Error('No se pudo cargar la configuración');
        const data = await settingsResponse.json();
        const statusData = statusResponse.ok ? await statusResponse.json() : {};
        renderLaserSettings(data.settings || [], statusData.firmware);
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
    laserSdUploadInput.addEventListener('change', () => {
        const file = laserSdUploadInput.files?.[0];
        laserSdUploadInput.value = '';
        if (!file) return;

        const progressWrap = document.getElementById('laser-sd-upload-progress');
        const progressFill = document.getElementById('laser-sd-upload-progress-fill');
        const progressLabel = document.getElementById('laser-sd-upload-progress-label');
        if (progressWrap) progressWrap.hidden = false;
        if (progressFill) progressFill.style.width = '0%';
        if (progressLabel) progressLabel.textContent = '0%';

        const formData = new FormData();
        formData.append('path', sdCurrentPath);
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/laser/sd/upload');

        xhr.upload.addEventListener('progress', event => {
            if (!event.lengthComputable) return;
            const percent = Math.round((event.loaded / event.total) * 100);
            if (progressFill) progressFill.style.width = `${percent}%`;
            if (progressLabel) progressLabel.textContent = `${percent}%`;
        });

        xhr.addEventListener('load', () => {
            if (progressWrap) progressWrap.hidden = true;
            if (xhr.status >= 200 && xhr.status < 300) {
                showToast(t('laserSdUploadSuccess'));
                loadSdFolder(sdCurrentPath);
            } else {
                let message = t('laserSdError');
                try {
                    message = JSON.parse(xhr.responseText).detail || message;
                } catch (error) {
                    // respuesta no era JSON, se usa el mensaje genérico
                }
                appAlert(message, '', 'danger');
            }
        });

        xhr.addEventListener('error', () => {
            if (progressWrap) progressWrap.hidden = true;
            appAlert(t('laserSdError'), '', 'danger');
        });

        xhr.send(formData);
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

async function loadLaserSection() {
    await loadLaserHostSelector();
    const resolvedHost = await ensureSectionHost(kind => kind !== 'cnc', 'lastLaserHost');
    if (resolvedHost) renderLaserHostOptions(resolvedHost);
    loadLaserBoardInfo();
    startLaserPolling();
    checkSdAvailability();
}

async function handleLaserPause() {
    try {
        await fetch('/api/laser/job/pause', { method: 'POST' });
        refreshLaserJob();
    } catch (error) {
        console.error(error);
    }
}

async function handleLaserResume() {
    try {
        await fetch('/api/laser/job/resume', { method: 'POST' });
        refreshLaserJob();
    } catch (error) {
        console.error(error);
    }
}

async function handleLaserCancel() {
    if (!(await appConfirm(t('laserCancelConfirm'), t('laserCancel')))) return;
    try {
        await fetch('/api/laser/job/cancel', { method: 'POST' });
        refreshLaserJob();
    } catch (error) {
        console.error(error);
    }
}

['laser-pause-btn', 'laser-pause-btn-panel'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', handleLaserPause);
});

['laser-resume-btn', 'laser-resume-btn-panel'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', handleLaserResume);
});

['laser-cancel-btn', 'laser-cancel-btn-panel'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', handleLaserCancel);
});

async function sendLaserRawCommand(command, host) {
    try {
        const formData = new FormData();
        formData.append('command', command);
        if (host) formData.append('host', host);
        const response = await fetch('/api/laser/command', { method: 'POST', body: formData });
        if (!response.ok) throw new Error('No se pudo enviar el comando');
        return true;
    } catch (error) {
        console.error(error);
        return false;
    }
}

// Mueve UN eje en relativo — el backend arma la secuencia real ($J=... GRBL
// o G91/G1/G90 Marlin) según el firmware registrado para `host`, así el
// frontend deja de construir G-code de jog a mano (ver services/laser_service.py::jog).
async function sendLaserJog(axis, distance, feed, host) {
    try {
        const formData = new FormData();
        formData.append('axis', axis);
        formData.append('distance', distance);
        formData.append('feed', feed);
        if (host) formData.append('host', host);
        const response = await fetch('/api/laser/jog', { method: 'POST', body: formData });
        return response.ok;
    } catch (error) {
        console.error(error);
        return false;
    }
}

// El D-pad tiene botones diagonales que antes movían dos ejes en un solo
// comando $J combinado — /api/laser/jog solo acepta un eje + una distancia
// por pedido, así que un jog diagonal es dos llamadas en paralelo (una por
// eje) en vez de una sola.
async function sendLaserJogMoves(moves, feed, host) {
    await Promise.all(moves.map(({ axis, distance }) => sendLaserJog(axis, distance, feed, host)));
}

async function sendLaserHome(host, axes) {
    try {
        const formData = new FormData();
        if (host) formData.append('host', host);
        if (axes) formData.append('axes', axes);
        const response = await fetch('/api/laser/home', { method: 'POST', body: formData });
        return response.ok;
    } catch (error) {
        console.error(error);
        return false;
    }
}

function parseGcodeBoundingBox(text) {
    const lines = text.split(/\r?\n/);
    let x = 0, y = 0;
    let absolute = true;
    let motionCode = null; // último G0/G1 visto — modal, sigue vigente en líneas que no lo repiten
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (const raw of lines) {
        const line = raw.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim();
        if (!line) continue;
        // Software real (ej. LightBurn) no siempre separa cada parámetro con
        // espacio — una línea típica es "G1 X0.442Y0.442F1500S0" sin espacios
        // entre X/Y/F/S. Tokenizar por límite de letra (no por espacio en
        // blanco) es la única forma de no perder los parámetros pegados.
        const tokens = line.toUpperCase().match(/[A-Z][+-]?[0-9]*\.?[0-9]+/g);
        if (!tokens) continue;

        let hasX = false, hasY = false, nx = x, ny = y;
        for (const token of tokens) {
            const letter = token[0];
            const value = parseFloat(token.slice(1));
            if (Number.isNaN(value)) continue;
            if (letter === 'G') {
                if (value === 90) absolute = true;
                else if (value === 91) absolute = false;
                else if (value === 92) motionCode = 'G92';
                else if (value === 0 || value === 1) motionCode = `G${value}`;
            } else if (letter === 'X') {
                nx = absolute ? value : x + value;
                hasX = true;
            } else if (letter === 'Y') {
                ny = absolute ? value : y + value;
                hasY = true;
            }
        }

        if (motionCode === 'G92') {
            if (hasX) x = nx;
            if (hasY) y = ny;
            continue;
        }
        if (motionCode !== 'G0' && motionCode !== 'G1') continue;
        if (!hasX && !hasY) continue;

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
            const confirmed = window.confirm(t('laserStartConfirm'));
            if (confirmed && gcodeText) zoomLaserBedMapToBounds(parseGcodeBoundingBox(gcodeText));
            resolve({ confirmed, copies: 1 });
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
        const onStart = () => {
            if (gcodeText) zoomLaserBedMapToBounds(parseGcodeBoundingBox(gcodeText));
            cleanup(true);
        };
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
// GRBL reporta y acepta la potencia del spindle/láser en su escala nativa S0-S1000
// ($30), pero en la UI se maneja siempre como porcentaje 0-100 para que sea consistente
// con el resto de controles (pasos, avance, etc.).
const LASER_POWER_S_MAX = 1000;

// La ficha CNC tiene su propio selector "Modo Feed" (Lento/Normal/Rápido)
// que la sección láser no tiene — el D-pad es el mismo elemento/clase
// compartido entre ambas fichas (mismo <button class="laser-jog-btn">), así
// que el feed a usar se decide según en qué sección está el botón al hacer clic.
const CNC_JOG_FEED_BY_MODE = { slow: 300, normal: 1500, fast: 4000 };
let cncJogFeedMode = 'normal';

document.querySelectorAll('.laser-jog-btn[data-axis]').forEach(btn => {
    btn.addEventListener('click', async () => {
        const axis = btn.dataset.axis;
        const dir = parseInt(btn.dataset.dir, 10);
        // El modal del asistente guiado vive fuera de #cnc-section (los
        // modales son overlays a nivel de <body>) pero su D-pad debe usar
        // los mismos parámetros de CNC, no los de láser.
        const inCnc = !!btn.closest('#cnc-section') || !!btn.closest('#cnc-wizard-modal');
        // El paso de Z en CNC es propio y más chico que el de XY — jogear Z a
        // 10-100mm (los pasos de XY) es fácil de usar mal y estrellar la fresa.
        const step = inCnc ? (axis === 'Z' ? cncJogStepZ : cncJogStep) : laserJogStep;
        const feed = inCnc ? (CNC_JOG_FEED_BY_MODE[cncJogFeedMode] || CNC_JOG_FEED_BY_MODE.normal) : LASER_JOG_FEED;
        const moves = [{ axis, distance: step * dir }];
        if (btn.dataset.axis2 && btn.dataset.dir2) {
            const dir2 = parseInt(btn.dataset.dir2, 10);
            moves.push({ axis: btn.dataset.axis2, distance: step * dir2 });
        }
        await sendLaserJogMoves(moves, feed);
        if (inCnc) { refreshCncStatus(); } else { refreshLaserStatus(); }
    });
});

document.querySelectorAll('#laser-jog-steps .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        laserJogStep = parseFloat(btn.dataset.step);
        document.querySelectorAll('#laser-jog-steps .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

let cncJogStep = 10;

document.querySelectorAll('#cnc-jog-steps .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        cncJogStep = parseFloat(btn.dataset.step);
        document.querySelectorAll('#cnc-jog-steps .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

let cncJogStepZ = 1;

document.querySelectorAll('#cnc-jog-steps-z .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        cncJogStepZ = parseFloat(btn.dataset.stepZ);
        document.querySelectorAll('#cnc-jog-steps-z .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

document.querySelectorAll('#cnc-feed-mode-group .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        cncJogFeedMode = btn.dataset.feedMode;
        document.querySelectorAll('#cnc-feed-mode-group .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

// ── Ficha CNC dedicada ──

let cncStatusPollInterval = null;
let cncSlowPollInterval = null;
let cncRapidPercent = 100;

// Cada sección (Láser/CNC) recuerda su propio último dispositivo activo,
// aunque el backend solo mantenga UNA conexión real a la vez (el ESP32 solo
// acepta un cliente WebSocket) — al entrar a una sección, la reconectamos al
// dispositivo de su propio tipo, sin tocar nada si ya está en el correcto.
async function ensureSectionHost(kindPredicate, lastHostKey) {
    const devices = laserHostOptions.filter(device => kindPredicate(device.kind || 'laser'));
    if (!devices.length) return null;
    const remembered = localStorage.getItem(lastHostKey);
    const target = devices.find(device => device.host === remembered) || devices[0];
    try {
        const currentResponse = await fetch('/api/laser/host');
        const current = await currentResponse.json();
        if (current.host !== target.host) {
            const formData = new FormData();
            formData.append('host', target.host);
            await fetch('/api/laser/host', { method: 'POST', body: formData });
        }
    } catch (error) {
        console.error(error);
    }
    localStorage.setItem(lastHostKey, target.host);
    return target.host;
}

function renderCncHostOptions(activeHost) {
    const selectEl = document.getElementById('cnc-host-select');
    if (!selectEl) return;
    const cncDevices = laserHostOptions.filter(device => device.kind === 'cnc');
    const resolvedHost = activeHost
        || document.getElementById('cnc-host-select')?.value
        || cncDevices[0]?.host;
    selectEl.innerHTML = cncDevices.map(device => {
        const label = device.hostname ? `${device.hostname} (${device.host})` : device.host;
        return `<option value="${escapeHtml(device.host)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (resolvedHost) selectEl.value = resolvedHost;
    const activeDevice = cncDevices.find(device => device.host === resolvedHost);
    applyCncMachineProfile(activeDevice?.machineProfile);
}

// La cola de trabajos es compartida entre láser y CNC a nivel de backend (un
// solo archivo se manda al host que esté activo al arrancar) — no hay forma
// de "separar" qué ítem es de cuál máquina. Esta lista muestra la misma cola
// que el láser, pero visible sin salir de la sección CNC, para no tener que
// ir a Láser a ver o correr algo que agregaste desde acá.
function renderCncQueue(queue) {
    const container = document.getElementById('cnc-queue-list');
    if (!container) return;
    if (!queue || !queue.length) {
        container.innerHTML = `<div class="empty-state-small">${t('laserQueueEmpty')}</div>`;
        return;
    }
    container.innerHTML = queue.map(item => `
        <div class="laser-queue-item" data-id="${item.id}" data-path="${escapeHtml(item.path || '')}">
            <div class="laser-queue-item-thumb" id="cnc-queue-thumb-${item.id}"></div>
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
        const thumbEl = document.getElementById(`cnc-queue-thumb-${id}`);
        if (thumbEl && itemPath) {
            const fileUrl = `/uploads/gcode/${itemPath.split('/').map(encodeURIComponent).join('/')}`;
            loadRealGcodeThumbnail(thumbEl, itemPath, 'gcode', fileUrl);
        }
        row.querySelectorAll('button[data-action]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.dataset.action === 'play') {
                    try {
                        const formData = new FormData();
                        formData.append('id', id);
                        formData.append('host', document.getElementById('cnc-host-select')?.value || '');
                        const response = await fetch('/api/laser/queue/start', { method: 'POST', body: formData });
                        if (!response.ok) {
                            const data = await response.json().catch(() => ({}));
                            throw new Error(data.detail || 'No se pudo iniciar el trabajo.');
                        }
                        refreshCncJobFooter();
                        refreshCncQueue();
                    } catch (error) {
                        console.error(error);
                        appAlert(error.message || 'No se pudo iniciar el trabajo.', '', 'danger');
                    }
                } else if (btn.dataset.action === 'remove') {
                    try {
                        const formData = new FormData();
                        formData.append('id', id);
                        await fetch('/api/laser/queue/remove', { method: 'POST', body: formData });
                        refreshCncQueue();
                    } catch (error) {
                        console.error(error);
                    }
                }
            });
        });
    });
}

async function refreshCncQueue() {
    try {
        const response = await fetch('/api/laser/queue');
        const data = await response.json();
        renderCncQueue(data.queue || []);
    } catch (error) {
        console.error(error);
    }
}

// ── Visor CNC: pestaña VISOR (2D/2.5D, ámbar sobre grilla oscura) ──

const cncViewerState = { currentFileUrl: null, currentFilename: null, visorHandle: null };

// Escena Three.js independiente de la del preview de la biblioteca de
// modelos (renderGcodePreview) — no comparte instancia ni DOM, cada una vive
// en su propio contenedor. Devuelve un handle para que los botones de
// navegación y el cambio de pestaña puedan controlarla sin recrearla.
// home_corner se guarda como texto ya traducido (es/en), no como el bitmask
// crudo de GRBL — frágil para usarlo en lógica y no solo para mostrarlo,
// pero es lo que hay disponible hoy. Documentado como deuda técnica.
function parseHomeCorner(homeCorner) {
    const s = (homeCorner || '').toLowerCase();
    return {
        right: s.includes('derecha') || s.includes('right'),
        top: s.includes('arriba') || s.includes('top'),
    };
}

// Única fuente de verdad de "¿el diseño entra en el área de trabajo?" —
// reusada tanto por el rectángulo de referencia del VISOR como por el paso 3
// del asistente guiado, para no tener el chequeo duplicado en dos lugares.
function computeWorkAreaFit(bounds, workArea) {
    if (!workArea || !workArea.width || !workArea.height) return null;
    const designWidth = bounds.maxX - bounds.minX;
    const designHeight = bounds.maxY - bounds.minY;
    const overflowX = Math.max(0, designWidth - workArea.width);
    const overflowY = Math.max(0, designHeight - workArea.height);
    return { fits: overflowX === 0 && overflowY === 0, designWidth, designHeight, overflowX, overflowY };
}

// Dibuja el rectángulo del área de trabajo registrada como referencia,
// como hijo de `group` con coordenadas crudas de G-code — al ser hijo,
// hereda la traslación del padre automáticamente, sin compensar nada a mano.
function drawWorkAreaBounds(group, workArea, homeCorner, fits) {
    if (!workArea || !workArea.width || !workArea.height) return null;
    const { right, top } = parseHomeCorner(homeCorner);
    const x0 = right ? -workArea.width : 0;
    const y0 = top ? -workArea.height : 0;
    const points = [
        new THREE.Vector3(x0, y0, 0),
        new THREE.Vector3(x0 + workArea.width, y0, 0),
        new THREE.Vector3(x0 + workArea.width, y0 + workArea.height, 0),
        new THREE.Vector3(x0, y0 + workArea.height, 0),
        new THREE.Vector3(x0, y0, 0),
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
        color: fits === false ? 0xef4444 : 0x22c55e,
        dashSize: workArea.width * 0.01,
        gapSize: workArea.width * 0.006,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    group.add(line);
    return line;
}

async function renderCncVisor(container, fileUrl, deviceInfo) {
    if (!container || !window.THREE || typeof window.THREE.Scene !== 'function') return null;
    container.innerHTML = '';

    let response, text;
    try {
        response = await fetch(fileUrl);
        text = await response.text();
    } catch (error) {
        console.error(error);
        return null;
    }

    const toolpath = parseCncToolpath(text);
    if (!toolpath.cutPaths.length && !toolpath.rapidSegments.length) {
        return { empty: true };
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x081410);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x081410, 1);
    container.appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x999999, 1.2));

    const group = new THREE.Group();
    scene.add(group);

    if (toolpath.rapidSegments.length) {
        const geometry = new THREE.BufferGeometry().setFromPoints(toolpath.rapidSegments);
        const material = new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, dashSize: 2, gapSize: 1.5 });
        const rapidLine = new THREE.LineSegments(geometry, material);
        rapidLine.computeLineDistances();
        group.add(rapidLine);
    }

    const CUT_COLOR = 0xf59e0b;
    const SELECTED_COLOR = 0xfbbf24;
    const cutLines = toolpath.cutPaths.map(path => {
        const geometry = new THREE.BufferGeometry().setFromPoints(path.points);
        const material = new THREE.LineBasicMaterial({ color: CUT_COLOR });
        const line = new THREE.Line(geometry, material);
        line.userData.cncPath = path;
        group.add(line);
        return line;
    });

    // El box/center/maxDim de encuadre se calculan SOLO con el trazado real
    // (antes de agregar el rectángulo del área de trabajo) — si el área de
    // trabajo es mucho más grande que el diseño (caso típico), incluirla acá
    // haría que "ajustar al área" aleje tanto la vista que el diseño quede
    // minúsculo. El rectángulo queda como referencia visual, no afecta el zoom.
    const box = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const fit = computeWorkAreaFit(toolpath.bounds, deviceInfo && deviceInfo.workArea);
    const workAreaLine = drawWorkAreaBounds(group, deviceInfo && deviceInfo.workArea, deviceInfo && deviceInfo.homeCorner, fit ? fit.fits : null);

    group.position.sub(center);

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
        if (!width || !height) return;
        renderer.setSize(width, height);
        applyFrustum(width, height);
    };

    const fitToView = () => {
        view.size = maxDim * 1.15;
        view.offsetX = 0;
        view.offsetY = 0;
        resize();
    };

    const zoomBy = factor => {
        view.size = Math.max(maxDim * 0.08, Math.min(maxDim * 8, view.size * factor));
        applyFrustum(container.clientWidth || 320, container.clientHeight || 320);
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
    const onPointerUp = event => {
        isDragging = false;
        try { renderer.domElement.releasePointerCapture(event.pointerId); } catch (error) { /* noop */ }
    };
    const onWheel = event => {
        event.preventDefault();
        zoomBy(event.deltaY > 0 ? 1.1 : 0.9);
    };

    // Raycasting: resalta la sub-trayectoria bajo el cursor y muestra su
    // rango de Z; al mover sin arrastrar, la lectura de coordenadas sigue el
    // punto del trazado más cercano al cursor (no la posición real de la
    // máquina — acá se está previsualizando un archivo, no necesariamente el
    // trabajo que tiene cargado el controlador).
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: maxDim * 0.01 };
    const pointerNdc = new THREE.Vector2();
    let selectedLine = null;
    const coordX = document.getElementById('cnc-visor-coord-x');
    const coordY = document.getElementById('cnc-visor-coord-y');
    const coordZ = document.getElementById('cnc-visor-coord-z');

    const onPointerMove = event => {
        if (isDragging) {
            const height = container.clientHeight || 320;
            const scale = view.size / height;
            view.offsetX -= (event.clientX - lastX) * scale;
            view.offsetY += (event.clientY - lastY) * scale;
            lastX = event.clientX;
            lastY = event.clientY;
            applyFrustum(container.clientWidth || 320, container.clientHeight || 320);
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        const hits = raycaster.intersectObjects(cutLines, false);
        if (hits.length) {
            const point = hits[0].point.clone().add(center);
            if (coordX) coordX.textContent = point.x.toFixed(3);
            if (coordY) coordY.textContent = point.y.toFixed(3);
            if (coordZ) coordZ.textContent = point.z.toFixed(3);
        }
    };

    const onClick = event => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        const hits = raycaster.intersectObjects(cutLines, false);
        if (selectedLine) selectedLine.material.color.setHex(CUT_COLOR);
        if (hits.length) {
            selectedLine = hits[0].object;
            selectedLine.material.color.setHex(SELECTED_COLOR);
        } else {
            selectedLine = null;
        }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('click', onClick);

    // El marcador de origen antes vivía fijo en CSS (arriba-izquierda,
    // decorativo) sin importar dónde estuviera realmente X0/Y0 del G-code —
    // acá se calcula su posición real en pantalla cada frame, proyectando el
    // origen mundial (0,0,0 de `group`, que ya arrastra el -center aplicado
    // arriba vía localToWorld) a través de la cámara actual. Así sigue
    // correcto durante pan/zoom sin wiring aparte.
    const originMarkerEl = document.getElementById('cnc-visor-origin-marker');
    const MARKER_HOTSPOT = { x: 9, y: 25 };
    const updateOriginMarker = () => {
        if (!originMarkerEl) return;
        const worldOrigin = group.localToWorld(new THREE.Vector3(0, 0, 0));
        const ndc = worldOrigin.project(camera);
        const width = container.clientWidth || 320;
        const height = container.clientHeight || 320;
        const px = (ndc.x * 0.5 + 0.5) * width;
        const py = (1 - (ndc.y * 0.5 + 0.5)) * height;
        const visible = ndc.z < 1 && px >= -40 && px <= width + 40 && py >= -40 && py <= height + 40;
        originMarkerEl.style.display = visible ? '' : 'none';
        if (visible) {
            originMarkerEl.style.transform = `translate(${(px - MARKER_HOTSPOT.x).toFixed(1)}px, ${(py - MARKER_HOTSPOT.y).toFixed(1)}px)`;
        }
    };

    let animId = null;
    const animate = () => {
        animId = requestAnimationFrame(animate);
        renderer.render(scene, camera);
        updateOriginMarker();
    };
    resize();
    animate();

    return {
        empty: false,
        resize,
        fitToView,
        zoomIn: () => zoomBy(0.9),
        zoomOut: () => zoomBy(1.1),
        getBounds: () => toolpath.bounds,
        getWorkAreaLine: () => workAreaLine,
        getFit: () => fit,
        dispose: () => {
            if (animId) cancelAnimationFrame(animId);
            renderer.dispose();
        },
    };
}

async function loadCncViewerFile(fileUrl, filename) {
    const canvasContainer = document.getElementById('cnc-visor-canvas');
    const emptyState = document.getElementById('cnc-visor-empty-state');
    const overlays = ['cnc-visor-origin-marker', 'cnc-visor-coords', 'cnc-visor-nav-col', 'cnc-visor-legend'];
    if (!canvasContainer) return;

    if (cncViewerState.visorHandle && typeof cncViewerState.visorHandle.dispose === 'function') {
        cncViewerState.visorHandle.dispose();
    }
    cncViewerState.currentFileUrl = fileUrl;
    cncViewerState.currentFilename = filename;
    cncViewerState.visorHandle = null;

    const activeHost = document.getElementById('cnc-host-select')?.value;
    const device = laserHostOptions.find(item => item.host === activeHost);
    const deviceInfo = { workArea: device?.workArea || null, homeCorner: device?.homeCorner || null };

    const handle = await renderCncVisor(canvasContainer, fileUrl, deviceInfo);
    if (!handle || handle.empty) {
        overlays.forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
        if (emptyState) emptyState.style.display = 'flex';
        return;
    }
    cncViewerState.visorHandle = handle;
    overlays.forEach(id => { const el = document.getElementById(id); if (el) el.hidden = false; });
    if (emptyState) emptyState.style.display = 'none';
}

function initCncViewerTabs() {
    const tabsWrap = document.getElementById('cnc-viewer-tabs');
    if (!tabsWrap || tabsWrap.dataset.wired) return;
    tabsWrap.dataset.wired = 'true';

    tabsWrap.querySelectorAll('.cnc-viewer-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.viewerTab;
            tabsWrap.querySelectorAll('.cnc-viewer-tab').forEach(t => {
                t.classList.toggle('active', t === tab);
                t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
            });
            document.querySelectorAll('.cnc-viewer-panel').forEach(panel => {
                panel.classList.toggle('active', panel.dataset.viewerPanel === target);
            });
            // El canvas WebGL queda en tamaño 0 mientras su panel está en
            // display:none — hay que avisarle que vuelva a medir al mostrarse.
            if (target === 'visor' && cncViewerState.visorHandle) {
                cncViewerState.visorHandle.resize();
            }
        });
    });

    document.querySelectorAll('#cnc-visor-nav-col [data-visor-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const handle = cncViewerState.visorHandle;
            if (!handle) return;
            const action = btn.dataset.visorAction;
            if (action === 'fit') handle.fitToView();
            else if (action === 'zoom-in') handle.zoomIn();
            else if (action === 'zoom-out') handle.zoomOut();
            else if (action === 'fullscreen') {
                const wrap = document.getElementById('cnc-visor-canvas-wrap');
                if (wrap && wrap.requestFullscreen) wrap.requestFullscreen();
            }
        });
    });
}

async function loadCncSection() {
    initCncViewerTabs();
    await loadLaserHostSelector();
    const resolvedHost = await ensureSectionHost(kind => kind === 'cnc', 'lastCncHost');
    renderCncHostOptions(resolvedHost);
    refreshCncStatus();
    refreshCncParserState();
    renderCncFilesTable();
    refreshCncQueue();
    stopCncPolling();
    cncStatusPollInterval = setInterval(refreshCncStatus, 600);
    cncSlowPollInterval = setInterval(() => {
        refreshCncParserState();
        refreshCncJobFooter();
        refreshCncQueue();
    }, 4000);
}

function stopCncPolling() {
    if (cncStatusPollInterval) { clearInterval(cncStatusPollInterval); cncStatusPollInterval = null; }
    if (cncSlowPollInterval) { clearInterval(cncSlowPollInterval); cncSlowPollInterval = null; }
}

const cncHostSelect = document.getElementById('cnc-host-select');
if (cncHostSelect) {
    cncHostSelect.addEventListener('change', async () => {
        try {
            const formData = new FormData();
            formData.append('host', cncHostSelect.value);
            await fetch('/api/laser/host', { method: 'POST', body: formData });
            localStorage.setItem('lastCncHost', cncHostSelect.value);
            const activeDevice = laserHostOptions.find(device => device.host === cncHostSelect.value);
            applyCncMachineProfile(activeDevice?.machineProfile);
            refreshCncStatus();
            refreshCncParserState();
            renderCncFilesTable();
        } catch (error) {
            console.error(error);
        }
    });
}

function setCncPinActive(pinKey, active) {
    const pill = document.querySelector(`.cnc-pin-pill[data-pin="${pinKey}"]`);
    if (pill) pill.classList.toggle('active', active);
}

async function refreshCncStatus() {
    const host = document.getElementById('cnc-host-select')?.value;
    try {
        const response = await fetch(`/api/laser/status${host ? `?host=${encodeURIComponent(host)}` : ''}`);
        const data = await response.json();

        const statePills = [document.getElementById('cnc-state-pill'), document.getElementById('cnc-wizard-state-pill')].filter(Boolean);
        const dot = document.getElementById('cnc-footer-dot');
        const connectedText = document.getElementById('cnc-footer-connected');
        if (!data.connected) {
            statePills.forEach(el => { el.textContent = t('laserOffline').toUpperCase(); el.className = 'cnc-state-pill state-alarm'; });
            if (dot) dot.classList.remove('online');
            if (connectedText) connectedText.textContent = t('offline');
            return;
        }

        if (dot) dot.classList.add('online');
        if (connectedText) connectedText.textContent = t('online');

        // Firmware de la placa activa — controla qué tan "GRBL" se ve el panel
        // (ver regla body[data-machine-firmware="marlin"] .grbl-only en style.css).
        document.body.setAttribute('data-machine-firmware', data.firmware || 'fluidnc');
        const firmwareFooterEl = document.getElementById('cnc-footer-firmware');
        if (firmwareFooterEl) firmwareFooterEl.textContent = deviceFirmwareBadgeLabel(data.firmware);
        const portFooterEl = document.getElementById('cnc-footer-port');
        if (portFooterEl) portFooterEl.textContent = laserHostLabel(data.host || host || '') || '—';

        const state = (data.state || 'Idle');
        statePills.forEach(el => {
            el.textContent = state.toUpperCase();
            el.className = 'cnc-state-pill' + (state.toLowerCase() === 'alarm' ? ' state-alarm' : state.toLowerCase() === 'run' ? ' state-run' : '');
        });

        const wco = data.wco || { x: 0, y: 0, z: 0 };
        const setPos = (axis, machineVal) => {
            const workEl = document.getElementById(`cnc-pos-work-${axis}`);
            const machineEl = document.getElementById(`cnc-pos-machine-${axis}`);
            if (machineEl) machineEl.textContent = machineVal.toFixed(3);
            if (workEl) workEl.textContent = (machineVal - (wco[axis] || 0)).toFixed(3);
        };
        setPos('x', data.x || 0);
        setPos('y', data.y || 0);
        setPos('z', data.z || 0);

        const feedEl = document.getElementById('cnc-feed-value');
        if (feedEl) feedEl.textContent = data.feed != null ? Math.round(data.feed) : '—';
        const rpmEl = document.getElementById('cnc-rpm-value');
        if (rpmEl) rpmEl.textContent = data.speed != null ? Math.round(data.speed) : '—';

        // Caso híbrido: placa Marlin con hotend/cama propios (ej. un router
        // con calefactor auxiliar) — el status trae extruder/heater_bed
        // aparte, solo cuando aplica (ver /api/laser/status en el backend).
        const marlinTempsRow = document.getElementById('cnc-marlin-temps-row');
        if (marlinTempsRow) {
            const hasExtruder = !!data.extruder;
            const hasBed = !!data.heater_bed;
            marlinTempsRow.hidden = !(hasExtruder || hasBed);
            const extruderEl = document.getElementById('cnc-extruder-temp');
            if (extruderEl) {
                extruderEl.textContent = hasExtruder
                    ? `${data.extruder.current.toFixed(1)}° / ${data.extruder.target.toFixed(1)}°`
                    : '—';
            }
            const bedEl = document.getElementById('cnc-bed-temp');
            if (bedEl) {
                bedEl.textContent = hasBed
                    ? `${data.heater_bed.current.toFixed(1)}° / ${data.heater_bed.target.toFixed(1)}°`
                    : '—';
            }
        }

        const pins = data.pins || '';
        ['X', 'Y', 'Z', 'P', 'D', 'A'].forEach(key => setCncPinActive(key, pins.includes(key)));

        if (data.buffer) {
            const bufEl = document.getElementById('cnc-footer-buffer');
            if (bufEl) bufEl.textContent = `${data.buffer.planner} / ${data.buffer.rx}`;
        }

        if (data.overrides) {
            const feedOvEl = document.getElementById('cnc-feed-override-value');
            if (feedOvEl) feedOvEl.textContent = `${data.overrides.feed}%`;
            const spindleOvEl = document.getElementById('cnc-spindle-override-value');
            if (spindleOvEl) spindleOvEl.textContent = `${data.overrides.spindle}%`;
        }
    } catch (error) {
        console.error(error);
    }
}

async function refreshCncParserState() {
    const host = document.getElementById('cnc-host-select')?.value;
    try {
        const response = await fetch(`/api/laser/parser-state${host ? `?host=${encodeURIComponent(host)}` : ''}`);
        if (!response.ok) return;
        const data = await response.json();
        const wcsSelect = document.getElementById('cnc-wcs-select');
        if (wcsSelect && data.wcs) wcsSelect.value = data.wcs;
        // Marlin no tiene sistemas de coordenadas G54-G59 — parser-state
        // devuelve supported:false en vez de tirar error para esos hosts.
        // Se oculta el selector directo acá además de por CSS (.grbl-only),
        // por si el firmware del host todavía no llegó por refreshCncStatus.
        const wcsField = wcsSelect?.closest('.cnc-topbar-field');
        if (wcsField) wcsField.hidden = data.supported === false;
    } catch (error) {
        console.error(error);
    }
}

async function refreshCncJobFooter() {
    try {
        const response = await fetch('/api/laser/job/status');
        const job = await response.json();
        const filenameEl = document.getElementById('cnc-job-filename');
        if (filenameEl) filenameEl.textContent = job?.filename || '—';
        const percent = job?.total ? Math.round((job.current / job.total) * 100) : 0;
        const fillEl = document.getElementById('cnc-job-progress-fill');
        if (fillEl) fillEl.style.width = `${percent}%`;
        const percentEl = document.getElementById('cnc-job-percent');
        if (percentEl) percentEl.textContent = `${percent}%`;
    } catch (error) {
        console.error(error);
    }
}

const cncWcsSelect = document.getElementById('cnc-wcs-select');
if (cncWcsSelect) {
    cncWcsSelect.addEventListener('change', async () => {
        await sendLaserRawCommand(cncWcsSelect.value);
        refreshCncParserState();
    });
}

document.getElementById('cnc-unlock-btn')?.addEventListener('click', async () => {
    await sendLaserRawCommand('$X');
    refreshCncStatus();
});

document.getElementById('cnc-reset-btn')?.addEventListener('click', async () => {
    await sendLaserRawCommand('\x18');
    refreshCncStatus();
});

document.getElementById('cnc-stop-btn')?.addEventListener('click', async () => {
    await sendLaserRawCommand('\x18');
    refreshCncStatus();
});

document.getElementById('cnc-footer-stop-btn')?.addEventListener('click', async () => {
    await sendLaserRawCommand('\x18');
    refreshCncStatus();
    refreshCncJobFooter();
});

document.getElementById('cnc-run-btn')?.addEventListener('click', async () => {
    const formData = new FormData();
    formData.append('host', document.getElementById('cnc-host-select')?.value || '');
    try {
        await fetch('/api/laser/job/resume', { method: 'POST', body: formData });
    } catch (error) {
        console.error(error);
    }
    refreshCncJobFooter();
});

document.getElementById('cnc-pause-btn')?.addEventListener('click', async () => {
    const formData = new FormData();
    formData.append('host', document.getElementById('cnc-host-select')?.value || '');
    try {
        await fetch('/api/laser/job/pause', { method: 'POST', body: formData });
    } catch (error) {
        console.error(error);
    }
    refreshCncJobFooter();
});

document.getElementById('cnc-park-btn')?.addEventListener('click', async () => {
    const formData = new FormData();
    formData.append('host', document.getElementById('cnc-host-select')?.value || '');
    try {
        await fetch('/api/laser/job/pause', { method: 'POST', body: formData });
    } catch (error) {
        console.error(error);
    }
    // Se aleja un poco de la pieza en Z al estacionar, además de pausar.
    await sendLaserJog('Z', 10, 500);
    refreshCncStatus();
    refreshCncJobFooter();
});

document.getElementById('cnc-probe-btn')?.addEventListener('click', async () => {
    await sendLaserRawCommand('G38.2 Z-10 F100');
    refreshCncStatus();
});

document.querySelectorAll('[data-z-nudge]').forEach(btn => {
    btn.addEventListener('click', async () => {
        const amount = parseFloat(btn.dataset.zNudge);
        await sendLaserJog('Z', amount, 500);
        refreshCncStatus();
    });
});

async function applyCncManualShift() {
    const x = parseFloat(document.getElementById('cnc-shift-x')?.value || '0');
    const y = parseFloat(document.getElementById('cnc-shift-y')?.value || '0');
    await sendLaserRawCommand(`G10 L20 P0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
    refreshCncStatus();
}

document.getElementById('cnc-shift-apply-btn')?.addEventListener('click', applyCncManualShift);

// El checkbox "Auto" salta el botón Aplicar: si está marcado, cada cambio en
// los campos X/Y dispara el shift de inmediato.
['cnc-shift-x', 'cnc-shift-y'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
        if (document.getElementById('cnc-shift-auto')?.checked) applyCncManualShift();
    });
});

// ── Cero rápido: pone en cero X/Y en la posición actual (seguro en
// cualquier altura). Z queda aparte y con confirmación porque solo debe
// hacerse con la fresa realmente tocando el material — si no, arruina la
// profundidad de corte de todo el trabajo. ──
async function zeroCncXY() {
    await sendLaserRawCommand('G10 L20 P0 X0.000 Y0.000');
    refreshCncStatus();
}

document.getElementById('cnc-zero-xy-btn')?.addEventListener('click', zeroCncXY);

document.getElementById('cnc-zero-z-btn')?.addEventListener('click', async () => {
    if (!(await appConfirm(t('cncZeroZConfirm'), t('cncZeroZ'), 'danger'))) return;
    await sendLaserRawCommand('G10 L20 P0 Z0.000');
    refreshCncStatus();
});

// Compartido entre el botón "Correr" de la tabla ARCHIVOS y el paso final
// del asistente guiado, para no duplicar la lógica de arrancar un trabajo.
async function startCncJob(path, host) {
    const formData = new FormData();
    formData.append('path', path);
    formData.append('host', host || document.getElementById('cnc-host-select')?.value || '');
    try {
        await fetch('/api/laser/job/start', { method: 'POST', body: formData });
        showToast(t('cncJobStarted'));
    } catch (error) {
        console.error(error);
    }
    refreshCncJobFooter();
}

// ── Asistente guiado CNC ("Guía para dibujar") — modal con 4 pasos,
// mismo mecanismo de pasos-dentro-de-un-modal que #usb-classify-modal. ──

let cncWizardStep = 1;
let cncWizardState = { selectedFile: null, originConfirmed: false, fitOk: null, bounds: null };

function updateCncWizardNextEnabled() {
    const nextBtn = document.getElementById('cnc-wizard-next-btn');
    if (!nextBtn) return;
    if (cncWizardStep === 1) {
        nextBtn.disabled = !cncWizardState.selectedFile;
    } else if (cncWizardStep === 2) {
        nextBtn.disabled = !cncWizardState.originConfirmed;
    } else if (cncWizardStep === 3) {
        const ackChecked = document.getElementById('cnc-wizard-fit-ack')?.checked;
        nextBtn.disabled = cncWizardState.fitOk === false && !ackChecked;
    } else {
        nextBtn.disabled = false;
    }
}

function showCncWizardStep(step) {
    cncWizardStep = step;
    [1, 2, 3, 4].forEach(n => {
        const el = document.getElementById(`cnc-wizard-step-${n}`);
        if (el) el.hidden = n !== step;
        const dot = document.querySelector(`.cnc-wizard-step-dot[data-step-dot="${n}"]`);
        if (dot) {
            dot.classList.toggle('active', n === step);
            dot.classList.toggle('done', n < step);
        }
    });
    const backBtn = document.getElementById('cnc-wizard-back-btn');
    const nextBtn = document.getElementById('cnc-wizard-next-btn');
    const runBtn = document.getElementById('cnc-wizard-run-btn');
    if (backBtn) backBtn.hidden = step === 1;
    if (nextBtn) nextBtn.hidden = step === 4;
    if (runBtn) runBtn.hidden = step !== 4;
    updateCncWizardNextEnabled();
    if (step === 3) renderCncWizardFitCheck();
    if (step === 4) renderCncWizardSummary();
}

async function renderCncWizardFileList() {
    const container = document.getElementById('cnc-wizard-file-list');
    if (!container) return;
    try {
        const response = await fetch('/api/browse?path=&type=gcode');
        const data = await response.json();
        const files = data.files || [];
        const query = (document.getElementById('cnc-wizard-file-search')?.value || '').toLowerCase();
        const filtered = files.filter(f => !query || f.name.toLowerCase().includes(query));
        if (!filtered.length) {
            container.innerHTML = `<div class="empty-state-small">${t('noFilesFound')}</div>`;
            return;
        }
        container.innerHTML = filtered.map(file => `
            <div class="cnc-wizard-file-row" data-file-id="${escapeHtml(file.id)}" data-file-url="${escapeHtml(file.file_url)}" data-file-name="${escapeHtml(file.name)}">
                <span>${escapeHtml(file.name)}</span>
                <span>${formatSize(file.size)}</span>
            </div>
        `).join('');
        container.querySelectorAll('.cnc-wizard-file-row').forEach(row => {
            row.addEventListener('click', () => {
                container.querySelectorAll('.cnc-wizard-file-row').forEach(r => r.classList.toggle('selected', r === row));
                cncWizardState.selectedFile = {
                    id: row.dataset.fileId,
                    url: row.dataset.fileUrl,
                    name: row.dataset.fileName,
                    path: stripSectionPrefix(row.dataset.fileId, 'gcode'),
                };
                cncWizardState.bounds = null;
                updateCncWizardNextEnabled();
            });
        });
    } catch (error) {
        console.error(error);
        container.innerHTML = `<div class="empty-state-small">${t('noFilesFound')}</div>`;
    }
}

document.getElementById('cnc-wizard-file-search')?.addEventListener('input', () => renderCncWizardFileList());

document.getElementById('cnc-wizard-home-btn')?.addEventListener('click', async () => {
    if (isLaserHomeConfirmEnabled()) {
        if (!(await appConfirm(t('laserHomeConfirm'), t('laserHome'), 'warning'))) return;
    }
    await sendLaserRawCommand('$H');
    refreshCncStatus();
});

// El jog no funciona en estado Alarm (GRBL lo rechaza con "error:8, requires
// idle state") — sin este botón, el único comando permitido en Alarm sería
// Home, dejando sin salida a quien esté alarmado por otro motivo (ej. ya
// homeado, solo necesita desbloquear).
document.getElementById('cnc-wizard-unlock-btn')?.addEventListener('click', async () => {
    await sendLaserRawCommand('$X');
    refreshCncStatus();
});

document.getElementById('cnc-wizard-zero-xy-btn')?.addEventListener('click', async () => {
    await zeroCncXY();
    cncWizardState.originConfirmed = true;
    showCncWizardStep(3);
});

// Pasos de jog propios del asistente — no comparten wiring con
// #cnc-jog-steps/#cnc-jog-steps-z del panel principal, aunque sí la misma
// variable de estado (cncJogStep/cncJogStepZ): es el mismo valor físico,
// solo dos controles distintos para fijarlo.
document.querySelectorAll('#cnc-wizard-jog-steps .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        cncJogStep = parseFloat(btn.dataset.step);
        document.querySelectorAll('#cnc-wizard-jog-steps .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});
document.querySelectorAll('#cnc-wizard-jog-steps-z .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        cncJogStepZ = parseFloat(btn.dataset.stepZ);
        document.querySelectorAll('#cnc-wizard-jog-steps-z .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

async function renderCncWizardFitCheck() {
    const outer = document.getElementById('cnc-wizard-fit-outer');
    const inner = document.getElementById('cnc-wizard-fit-inner');
    const text = document.getElementById('cnc-wizard-fit-text');
    const ackRow = document.getElementById('cnc-wizard-fit-ack-row');
    const ackInput = document.getElementById('cnc-wizard-fit-ack');
    if (!cncWizardState.selectedFile || !outer || !inner || !text) return;

    const activeHost = document.getElementById('cnc-host-select')?.value;
    const device = laserHostOptions.find(item => item.host === activeHost);
    const workArea = device?.workArea;

    let bounds = cncWizardState.bounds;
    if (!bounds) {
        try {
            const response = await fetch(cncWizardState.selectedFile.url);
            const gcodeText = await response.text();
            bounds = parseCncToolpath(gcodeText).bounds;
            cncWizardState.bounds = bounds;
        } catch (error) {
            console.error(error);
        }
    }

    if (!bounds || !workArea) {
        text.textContent = t('cncWizardFitUnknown');
        cncWizardState.fitOk = null;
        if (ackRow) ackRow.hidden = true;
        updateCncWizardNextEnabled();
        return;
    }

    const fit = computeWorkAreaFit(bounds, workArea);
    cncWizardState.fitOk = fit.fits;

    // Diagrama esquemático, no a escala real: el contenedor es siempre
    // cuadrado (aspect-ratio:1 en CSS) — cada eje se expresa como % de SU
    // PROPIA dimensión del área de trabajo, no una escala mm→px compartida.
    const { right, top } = parseHomeCorner(device?.homeCorner);
    const designWPercent = ((bounds.maxX - bounds.minX) / workArea.width) * 100;
    const designHPercent = ((bounds.maxY - bounds.minY) / workArea.height) * 100;
    const leftPct = right ? Math.max(0, 100 - designWPercent) : 0;
    const topPct = top ? 0 : Math.max(0, 100 - designHPercent);
    inner.style.left = `${leftPct}%`;
    inner.style.top = `${topPct}%`;
    inner.style.width = `${Math.min(100, designWPercent)}%`;
    inner.style.height = `${Math.min(100, designHPercent)}%`;
    inner.classList.toggle('overflow', !fit.fits);

    text.textContent = fit.fits
        ? `${t('cncWizardFitOk')}: ${fit.designWidth.toFixed(0)} × ${fit.designHeight.toFixed(0)} mm / ${workArea.width} × ${workArea.height} mm`
        : `${t('cncWizardFitExceeds')}: +${fit.overflowX.toFixed(0)}mm X, +${fit.overflowY.toFixed(0)}mm Y`;

    if (ackRow) ackRow.hidden = fit.fits;
    if (ackInput) ackInput.checked = false;
    updateCncWizardNextEnabled();
}

document.getElementById('cnc-wizard-fit-ack')?.addEventListener('change', updateCncWizardNextEnabled);

function renderCncWizardSummary() {
    const el = document.getElementById('cnc-wizard-summary');
    if (el && cncWizardState.selectedFile) {
        el.textContent = cncWizardState.selectedFile.name;
    }
}

function openCncWizardModal() {
    cncWizardState = { selectedFile: null, originConfirmed: false, fitOk: null, bounds: null };
    const searchInput = document.getElementById('cnc-wizard-file-search');
    if (searchInput) searchInput.value = '';
    showCncWizardStep(1);
    renderCncWizardFileList();
    document.getElementById('cnc-wizard-modal')?.classList.add('active');
}

function closeCncWizardModal() {
    document.getElementById('cnc-wizard-modal')?.classList.remove('active');
}

document.getElementById('cnc-wizard-open-btn')?.addEventListener('click', openCncWizardModal);
document.getElementById('cnc-wizard-cancel-btn')?.addEventListener('click', closeCncWizardModal);
document.getElementById('cnc-wizard-backdrop')?.addEventListener('click', closeCncWizardModal);

document.getElementById('cnc-wizard-back-btn')?.addEventListener('click', () => {
    if (cncWizardStep > 1) showCncWizardStep(cncWizardStep - 1);
});

document.getElementById('cnc-wizard-next-btn')?.addEventListener('click', () => {
    if (cncWizardStep < 4) showCncWizardStep(cncWizardStep + 1);
});

document.getElementById('cnc-wizard-run-btn')?.addEventListener('click', async () => {
    if (!cncWizardState.selectedFile) return;
    await startCncJob(cncWizardState.selectedFile.path);
    closeCncWizardModal();
});

// ── Overrides de feed/husillo: bytes de tiempo real de GRBL (0x90-0x9E).
// El campo "Ov:" del status solo aparece en algunos reportes (no todos), por
// eso el valor mostrado se actualiza en cuanto refreshCncStatus lo capture,
// no inmediatamente al apretar el botón.
const CNC_OVERRIDE_BYTES = {
    feed: { '-10': 0x92, '-1': 0x94, '1': 0x93, '10': 0x91 },
    spindle: { '-10': 0x9B, '-1': 0x9D, '1': 0x9C, '10': 0x9A },
};

document.querySelectorAll('.cnc-override-row[data-override] [data-ov]').forEach(btn => {
    btn.addEventListener('click', async () => {
        const kind = btn.closest('[data-override]')?.dataset.override;
        const byte = CNC_OVERRIDE_BYTES[kind]?.[btn.dataset.ov];
        if (byte === undefined) return;
        await sendLaserRawCommand(String.fromCharCode(byte));
        setTimeout(refreshCncStatus, 250);
    });
});

// ── Husillo: CW/Off/CCW + RPM ──

let cncSpindleMode = 'off';

async function setCncSpindleMode(mode) {
    cncSpindleMode = mode;
    document.querySelectorAll('.cnc-spindle-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.spindleMode === mode);
    });
    const rpm = document.getElementById('cnc-rpm-input')?.value || '0';
    if (mode === 'cw') await sendLaserRawCommand(`M3 S${rpm}`);
    else if (mode === 'ccw') await sendLaserRawCommand(`M4 S${rpm}`);
    else await sendLaserRawCommand('M5');
    refreshCncStatus();
}

document.querySelectorAll('.cnc-spindle-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setCncSpindleMode(btn.dataset.spindleMode));
});

document.querySelectorAll('#cnc-spindle-card .laser-step-btn[data-rpm]').forEach(btn => {
    btn.addEventListener('click', async () => {
        const rpmInput = document.getElementById('cnc-rpm-input');
        if (rpmInput) rpmInput.value = btn.dataset.rpm;
        document.querySelectorAll('#cnc-spindle-card .laser-step-btn[data-rpm]').forEach(b => b.classList.toggle('active', b === btn));
        if (cncSpindleMode !== 'off') await setCncSpindleMode(cncSpindleMode);
    });
});

// ── Rápido %: multiplicador del feed de jog en modo "Rápido" ──

document.querySelectorAll('#cnc-rapid-group .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        cncRapidPercent = parseFloat(btn.dataset.rapid);
        CNC_JOG_FEED_BY_MODE.fast = Math.round(4000 * (cncRapidPercent / 100));
        document.querySelectorAll('#cnc-rapid-group .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

// ── PERFIL ACTIVO: presets guardados en localStorage (feed/RPM/paso) ──

const CNC_PROFILES_KEY = 'cncProfiles';

function getCncProfiles() {
    try {
        return JSON.parse(localStorage.getItem(CNC_PROFILES_KEY) || '[]');
    } catch (error) {
        return [];
    }
}

function renderCncProfileOptions() {
    const selectEl = document.getElementById('cnc-profile-select');
    if (!selectEl) return;
    const profiles = getCncProfiles();
    const manualLabel = t('cncProfileManual');
    selectEl.innerHTML = [`<option value="">${escapeHtml(manualLabel)}</option>`]
        .concat(profiles.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`))
        .join('');
}

document.getElementById('cnc-profile-select')?.addEventListener('change', (event) => {
    const profiles = getCncProfiles();
    const profile = profiles[parseInt(event.target.value, 10)];
    if (!profile) return;
    const rpmInput = document.getElementById('cnc-rpm-input');
    if (rpmInput && profile.rpm) rpmInput.value = profile.rpm;
    cncJogStep = profile.step || cncJogStep;
    document.querySelectorAll('#cnc-jog-steps .laser-step-btn').forEach(b => {
        b.classList.toggle('active', parseFloat(b.dataset.step) === cncJogStep);
    });
});

// ── ARCHIVOS: tabla de gcode/CNC (biblioteca compartida, sección "gcode") ──

async function renderCncFilesTable() {
    const tbody = document.getElementById('cnc-files-tbody');
    if (!tbody) return;
    const query = (document.getElementById('cnc-files-search')?.value || '').toLowerCase();
    try {
        const response = await fetch('/api/browse?path=&type=gcode');
        const data = await response.json();
        const files = data.files || [];
        const filtered = files.filter(f => !query || f.name.toLowerCase().includes(query));
        if (!filtered.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="empty-state-small">${t('noFilesFound')}</td></tr>`;
            return;
        }
        tbody.innerHTML = filtered.map(file => `
            <tr class="cnc-files-row" data-file-url="${escapeHtml(file.file_url)}" data-file-name="${escapeHtml(file.name)}">
                <td class="model-name">
                    <img class="cnc-files-thumb" loading="lazy" alt="" src="/api/gcode/thumbnail?path=${encodeURIComponent(stripSectionPrefix(file.id, 'gcode'))}&kind=cnc">
                    ${escapeHtml(file.name)}
                </td>
                <td>${formatSize(file.size)}</td>
                <td>${formatDate(file.modified)}</td>
                <td>
                    <div class="cnc-files-row-actions">
                        <button type="button" class="theme-option-icon-btn" data-run-file="${escapeHtml(file.id)}" title="${escapeHtml(t('cncRun'))}">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </button>
                        <button type="button" class="theme-option-icon-btn" data-queue-file="${escapeHtml(file.id)}" title="${escapeHtml(t('addToQueue'))}">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg>
                        </button>
                        <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger" data-delete-file="${escapeHtml(file.id)}" title="${escapeHtml(t('delete'))}">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.cnc-files-row').forEach(row => {
            row.addEventListener('click', () => {
                loadCncViewerFile(row.dataset.fileUrl, row.dataset.fileName);
                tbody.querySelectorAll('.cnc-files-row').forEach(r => r.classList.toggle('selected', r === row));
            });
        });

        tbody.querySelectorAll('[data-run-file]').forEach(btn => {
            btn.addEventListener('click', async event => {
                event.stopPropagation();
                await startCncJob(stripSectionPrefix(btn.dataset.runFile, 'gcode'));
            });
        });

        tbody.querySelectorAll('[data-queue-file]').forEach(btn => {
            btn.addEventListener('click', async event => {
                event.stopPropagation();
                const formData = new FormData();
                const relPath = stripSectionPrefix(btn.dataset.queueFile, 'gcode');
                formData.append('path', relPath);
                formData.append('filename', relPath.split('/').pop());
                try {
                    await fetch('/api/laser/queue/add', { method: 'POST', body: formData });
                    showToast(t('printerSendQueued'));
                    refreshCncQueue();
                } catch (error) {
                    console.error(error);
                }
            });
        });

        tbody.querySelectorAll('[data-delete-file]').forEach(btn => {
            btn.addEventListener('click', async event => {
                event.stopPropagation();
                if (!(await appConfirm(t('cncDeleteFileConfirm'), t('delete'), 'danger'))) return;
                try {
                    await fetch(`/api/files?path=${encodeURIComponent(stripSectionPrefix(btn.dataset.deleteFile, 'gcode'))}&type=gcode`, { method: 'DELETE' });
                    renderCncFilesTable();
                } catch (error) {
                    console.error(error);
                }
            });
        });
    } catch (error) {
        console.error(error);
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state-small">${t('errorLoadingModels')}</td></tr>`;
    }
}

document.getElementById('cnc-files-search')?.addEventListener('input', () => renderCncFilesTable());
document.getElementById('cnc-files-refresh-btn')?.addEventListener('click', () => renderCncFilesTable());

wireUploadButton('cnc-files-upload-btn', 'cnc-files-upload-input', 'gcode', () => '', 'cnc-files-table-wrap', () => renderCncFilesTable());
document.getElementById('cnc-files-add-btn')?.addEventListener('click', () => {
    document.getElementById('cnc-files-upload-input')?.click();
});

document.getElementById('cnc-settings-btn')?.addEventListener('click', () => switchSection('settings'));

document.querySelectorAll('#laser-power-presets .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const powerInput = document.getElementById('laser-fire-power-input');
        if (powerInput) powerInput.value = btn.dataset.power;
        document.querySelectorAll('#laser-power-presets .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
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
        await sendLaserHome();
        clearLaserBedMapTrace();
        refreshLaserStatus();
    });
}

const cncHomeBtn = document.getElementById('cnc-home-btn');
if (cncHomeBtn) {
    cncHomeBtn.addEventListener('click', async () => {
        if (isLaserHomeConfirmEnabled()) {
            if (!(await appConfirm(t('laserHomeConfirm'), t('laserHome'), 'warning'))) return;
        }
        await sendLaserHome();
        refreshCncStatus();
    });
}

const laserUnlockBtn = document.getElementById('laser-unlock-btn');
if (laserUnlockBtn) {
    laserUnlockBtn.addEventListener('click', async () => {
        await sendLaserRawCommand('$X');
        refreshLaserStatus();
    });
}

let laserFireActive = false;
let laserFireLastOffAt = 0;

async function laserFireOff() {
    const label = document.getElementById('laser-fire-label');
    await sendLaserRawCommand('M5');
    laserFireActive = false;
    laserFireLastOffAt = Date.now();
    document.getElementById('laser-fire-btn')?.classList.remove('active');
    if (label) label.textContent = t('laserFireOn');
}

async function laserFireOn() {
    if (Date.now() - laserFireLastOffAt < 600) return;
    const label = document.getElementById('laser-fire-label');
    const powerInput = document.getElementById('laser-fire-power-input');
    const powerPercent = Math.max(0, Math.min(100, parseInt(powerInput?.value, 10) || 0));
    const powerS = Math.round((powerPercent / 100) * LASER_POWER_S_MAX);
    await sendLaserRawCommand(`M3 S${powerS}`);
    laserFireActive = true;
    document.getElementById('laser-fire-btn')?.classList.add('active');
    if (label) label.textContent = t('laserFireOff');
}

function toggleLaserFire() {
    if (laserFireActive) laserFireOff();
    else laserFireOn();
}

const laserFireBtn = document.getElementById('laser-fire-btn');
if (laserFireBtn) {
    laserFireBtn.addEventListener('click', () => {
        if (laserFireActive) laserFireOff();
    });

    laserFireBtn.addEventListener('dblclick', () => {
        if (!laserFireActive) laserFireOn();
    });
}

let cncSpindleActive = false;
let cncSpindleLastOffAt = 0;

async function cncSpindleOff() {
    const label = document.getElementById('laser-spindle-label');
    await sendLaserRawCommand('M5');
    cncSpindleActive = false;
    cncSpindleLastOffAt = Date.now();
    document.getElementById('laser-spindle-btn')?.classList.remove('active');
    if (label) label.textContent = t('cncSpindleOn');
}

async function cncSpindleOn() {
    if (Date.now() - cncSpindleLastOffAt < 600) return;
    const label = document.getElementById('laser-spindle-label');
    const rpmInput = document.getElementById('laser-spindle-rpm-input');
    const rpm = Math.max(0, parseInt(rpmInput?.value, 10) || 0);
    await sendLaserRawCommand(`M3 S${rpm}`);
    cncSpindleActive = true;
    document.getElementById('laser-spindle-btn')?.classList.add('active');
    if (label) label.textContent = t('cncSpindleOff');
}

function toggleCncSpindle() {
    if (cncSpindleActive) cncSpindleOff();
    else cncSpindleOn();
}

const laserSpindleBtn = document.getElementById('laser-spindle-btn');
if (laserSpindleBtn) {
    laserSpindleBtn.addEventListener('click', () => {
        if (cncSpindleActive) cncSpindleOff();
    });

    laserSpindleBtn.addEventListener('dblclick', () => {
        if (!cncSpindleActive) cncSpindleOn();
    });
}

document.querySelectorAll('#laser-spindle-presets .laser-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const rpmInput = document.getElementById('laser-spindle-rpm-input');
        if (rpmInput) rpmInput.value = btn.dataset.rpm;
        document.querySelectorAll('#laser-spindle-presets .laser-step-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});

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

// ── Impresoras Marlin standalone (USB directo, sin Klipper/Moonraker) ──
// Path paralelo al de impresoras Klipper y al de CNC/láser: acá no hay
// Moonraker ni GRBL, solo un puerto serie hablando G-code Marlin puro (ver
// backend/services/marlin_printer_service.py). El alta (descubrir puerto +
// nombre/baudrate) vive en Configuración junto al resto de dispositivos; la
// ficha operativa (jog/temperaturas/consola/impresión) es esta sección
// dedicada ("Impresoras Marlin" en el menú) + un modal de detalle por
// impresora, mismo patrón tarjeta->modal que usa Impresora 3D (Klipper).

let marlinPrintersRegistryCache = [];

async function loadMarlinPrintersSettingsCard() {
    const discoverContainer = document.getElementById('marlin-discover-list');
    const registryContainer = document.getElementById('marlin-printers-registry-list');
    if (!discoverContainer && !registryContainer) return;
    try {
        const [portsResponse, registryResponse] = await Promise.all([
            fetch('/api/marlin-printers/discover'),
            fetch('/api/marlin-printers/registry/status'),
        ]);
        const portsData = await portsResponse.json();
        const registryData = await registryResponse.json();
        marlinPrintersRegistryCache = registryData.printers || [];
        renderMarlinDiscoverList(portsData.ports || []);
        renderMarlinRegistryList(marlinPrintersRegistryCache);
    } catch (error) {
        console.error(error);
    }
}

function renderMarlinDiscoverList(ports) {
    const container = document.getElementById('marlin-discover-list');
    if (!container) return;
    if (!ports.length) {
        container.innerHTML = `<div class="empty-state-small">${t('marlinPrinterNoPorts')}</div>`;
        return;
    }
    container.innerHTML = ports.map(port => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(port.device)}</strong>
                <span>${escapeHtml(port.chip || '')}${port.description ? ' · ' + escapeHtml(port.description) : ''}</span>
            </div>
            <span class="usb-port-vidpid">${escapeHtml(port.vid_pid || '')}</span>
            <button type="button" class="btn-file-action marlin-printer-discover-add-btn" data-device="${escapeHtml(port.device)}" data-chip="${escapeHtml(port.chip || '')}">${escapeHtml(t('usbPortAdd'))}</button>
        </div>
    `).join('');

    container.querySelectorAll('.marlin-printer-discover-add-btn').forEach(btn => {
        btn.addEventListener('click', () => openMarlinRegisterModal(btn.dataset.device, btn.dataset.chip));
    });
}

function renderMarlinRegistryList(printers) {
    const container = document.getElementById('marlin-printers-registry-list');
    if (!container) return;
    if (!printers.length) {
        container.innerHTML = `<div class="empty-state-small">${t('marlinPrinterNoPrinters')}</div>`;
        return;
    }
    container.innerHTML = printers.map(printer => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(printer.name || printer.device)}</strong>
                <span>${escapeHtml(printer.device)} · ${printer.baud || 115200} bps</span>
            </div>
            <span class="device-status-pill ${printer.online ? 'online' : 'offline'}">${printer.online ? t('online') : t('offline')}</span>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger marlin-printer-remove-btn" data-device="${escapeHtml(printer.device)}" title="${escapeHtml(t('usbPortUnlink'))}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.marlin-printer-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const device = btn.dataset.device;
            if (!(await appConfirm(t('marlinPrinterRemoveConfirm'), t('usbPortUnlink'), 'danger'))) return;
            try {
                const formData = new FormData();
                formData.append('device', device);
                await fetch('/api/marlin-printers/registry/remove', { method: 'POST', body: formData });
            } catch (error) {
                console.error(error);
            } finally {
                loadMarlinPrintersSettingsCard();
                refreshMarlinPrintersGrid();
            }
        });
    });
}

document.getElementById('marlin-printers-discover-btn')?.addEventListener('click', loadMarlinPrintersSettingsCard);

let marlinRegisterTarget = null;

function openMarlinRegisterModal(device, chip) {
    marlinRegisterTarget = device;
    const label = document.getElementById('marlin-printer-register-device-label');
    if (label) label.textContent = chip ? `${chip} · ${device}` : device;
    const nameInput = document.getElementById('marlin-printer-register-name');
    if (nameInput) nameInput.value = chip && chip !== 'CH340' && chip !== 'CH340K' ? chip : 'Impresora Marlin';
    const baudSelect = document.getElementById('marlin-printer-register-baud');
    if (baudSelect) baudSelect.value = '115200';
    document.getElementById('marlin-printer-register-modal')?.classList.add('active');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
}

function closeMarlinRegisterModal() {
    document.getElementById('marlin-printer-register-modal')?.classList.remove('active');
    marlinRegisterTarget = null;
}

document.getElementById('marlin-printer-register-close')?.addEventListener('click', closeMarlinRegisterModal);
document.getElementById('marlin-printer-register-backdrop')?.addEventListener('click', closeMarlinRegisterModal);
document.getElementById('marlin-printer-register-cancel-btn')?.addEventListener('click', closeMarlinRegisterModal);

document.getElementById('marlin-printer-register-confirm-btn')?.addEventListener('click', async () => {
    const device = marlinRegisterTarget;
    const nameInput = document.getElementById('marlin-printer-register-name');
    const baudSelect = document.getElementById('marlin-printer-register-baud');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!device || !name) return;
    closeMarlinRegisterModal();
    try {
        const formData = new FormData();
        formData.append('device', device);
        formData.append('name', name);
        formData.append('baud', baudSelect ? baudSelect.value : '115200');
        await fetch('/api/marlin-printers/registry', { method: 'POST', body: formData });
        showToast(`${name}: ${t('marlinPrinterRegisterSuccess')}`);
    } catch (error) {
        console.error(error);
    } finally {
        loadMarlinPrintersSettingsCard();
        refreshMarlinPrintersGrid();
    }
});

// ── Ficha operativa: grid de tarjetas + modal de detalle por impresora ──

let marlinGridPollInterval = null;

function getMarlinPrinterVisualState(status) {
    if (!status || !status.connected) return 'offline';
    const state = (status.state || 'idle').toLowerCase();
    if (state === 'printing') return 'printing';
    if (state === 'paused') return 'paused';
    return 'idle';
}

function marlinPrinterCardHtml(printer, status) {
    const visualState = getMarlinPrinterVisualState(status);
    const isOnline = visualState !== 'offline';
    const statusText = isOnline ? t('online') : t('offline');
    const stateLabel = isOnline ? t(visualState) : t('offline');
    const name = printer.name || printer.device;

    let extruderTemp = '--';
    let bedTemp = '--';
    if (status?.extruder && typeof status.extruder.current === 'number') extruderTemp = Math.round(status.extruder.current * 10) / 10;
    if (status?.heater_bed && typeof status.heater_bed.current === 'number') bedTemp = Math.round(status.heater_bed.current * 10) / 10;

    return `
        <div class="printer-card printer-card-type-3d ${isOnline ? 'online' : 'offline'} ${visualState}" data-marlin-device="${escapeHtml(printer.device)}">
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${escapeHtml(name)}</h3>
                    <p class="printer-name-sub">Marlin</p>
                </div>
                <div class="printer-status-icon ${isOnline ? 'online' : 'offline'}" title="${statusText}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                </div>
            </div>

            <div class="printer-status-line ${visualState}">
                <span class="printer-status-dot ${visualState}"></span>${stateLabel}
            </div>

            <div class="printer-illustration printer-illustration-${visualState}">
                ${printerIllustrationImg(visualState)}
            </div>

            ${isOnline ? `
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
            ` : ''}
        </div>
    `;
}

async function refreshMarlinPrintersGrid() {
    const grid = document.getElementById('marlin-printers-grid');
    if (!grid) return;
    try {
        const response = await fetch('/api/marlin-printers/registry/status');
        const data = await response.json();
        const printers = data.printers || [];
        marlinPrintersRegistryCache = printers;
        if (!printers.length) {
            grid.innerHTML = `<div class="empty-state">${t('marlinPrinterNoPrinters')}</div>`;
            return;
        }
        const entries = await Promise.all(printers.map(async printer => {
            try {
                const statusResponse = await fetch(`/api/marlin-printers/status?device=${encodeURIComponent(printer.device)}`);
                const status = await statusResponse.json();
                return { printer, status };
            } catch (error) {
                return { printer, status: { connected: false } };
            }
        }));
        grid.innerHTML = entries.map(({ printer, status }) => marlinPrinterCardHtml(printer, status)).join('');
        grid.querySelectorAll('.printer-card[data-marlin-device]').forEach(card => {
            card.addEventListener('click', () => openMarlinPrinterModal(card.dataset.marlinDevice));
        });
    } catch (error) {
        console.error(error);
    }
}

async function loadMarlinSection() {
    await loadMarlinPrintersSettingsCard();
    refreshMarlinPrintersGrid();
    stopMarlinPrintersPolling();
    marlinGridPollInterval = setInterval(refreshMarlinPrintersGrid, 3000);
}

function stopMarlinPrintersPolling() {
    if (marlinGridPollInterval) { clearInterval(marlinGridPollInterval); marlinGridPollInterval = null; }
}

document.getElementById('marlin-printers-refresh-btn')?.addEventListener('click', refreshMarlinPrintersGrid);

// El alta (descubrir puerto + nombre/baudrate) vive en Configuración, junto
// al resto de dispositivos (misma lógica que "Todos los dispositivos" para
// láser/CNC) — este botón lleva ahí en vez de duplicar el flujo de alta acá.
document.getElementById('marlin-printers-add-btn')?.addEventListener('click', () => {
    switchSection('settings');
    showToast(t('marlinPrinterAddGoSettingsHint'));
    setTimeout(() => {
        document.getElementById('marlin-discover-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
});

async function sendMarlinPrinterJog(device, axis, distance, feed) {
    try {
        const formData = new FormData();
        formData.append('device', device);
        formData.append('axis', axis);
        formData.append('distance', distance);
        formData.append('feed', feed);
        const response = await fetch('/api/marlin-printers/jog', { method: 'POST', body: formData });
        return response.ok;
    } catch (error) {
        console.error(error);
        return false;
    }
}

async function sendMarlinPrinterHome(device, axes) {
    try {
        const formData = new FormData();
        formData.append('device', device);
        if (axes) formData.append('axes', axes);
        const response = await fetch('/api/marlin-printers/home', { method: 'POST', body: formData });
        return response.ok;
    } catch (error) {
        console.error(error);
        return false;
    }
}

let marlinModalDevice = null;
let marlinModalFastInterval = null;
let marlinModalSlowInterval = null;
let marlinToolheadJogStep = 10;

function closeMarlinPrinterModal() {
    document.getElementById('marlin-printer-modal')?.classList.remove('active');
    if (marlinModalFastInterval) { clearInterval(marlinModalFastInterval); marlinModalFastInterval = null; }
    if (marlinModalSlowInterval) { clearInterval(marlinModalSlowInterval); marlinModalSlowInterval = null; }
    marlinModalDevice = null;
}

document.getElementById('marlin-printer-modal-close')?.addEventListener('click', closeMarlinPrinterModal);
document.getElementById('marlin-printer-modal-backdrop')?.addEventListener('click', closeMarlinPrinterModal);

async function openMarlinPrinterModal(device) {
    marlinModalDevice = device;
    const entry = marlinPrintersRegistryCache.find(p => p.device === device);
    const nameEl = document.getElementById('marlin-printer-modal-name');
    if (nameEl) nameEl.textContent = (entry && entry.name) || device;
    document.getElementById('marlin-printer-modal')?.classList.add('active');

    await renderMarlinPrintCardShell(device);

    const consoleContainer = document.getElementById('marlin-printer-modal-console');
    if (consoleContainer) {
        consoleContainer.innerHTML = `
            <div class="temp-card">
                <div class="temp-card-header">
                    <div class="temp-card-header-left">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="3"/><line x1="6" y1="16" x2="6" y2="16.01"/></svg>
                        <span>${t('console')}</span>
                    </div>
                </div>
                <div class="temp-card-body">
                    <div class="console-log" id="marlin-printer-console-log"></div>
                    <form class="console-input-row" id="marlin-printer-console-form">
                        <input type="text" id="marlin-printer-console-input" autocomplete="off" placeholder="${escapeHtml(t('consoleInputPlaceholder'))}">
                        <button type="submit" class="btn-icon-dark" title="${escapeHtml(t('consoleInputPlaceholder'))}">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                        </button>
                    </form>
                </div>
            </div>
        `;
        wireMarlinConsoleForm(device);
    }

    refreshMarlinModalStatus();
    refreshMarlinModalTemperatures();
    refreshMarlinConsole();
    refreshMarlinPrintStatus();

    if (marlinModalFastInterval) clearInterval(marlinModalFastInterval);
    if (marlinModalSlowInterval) clearInterval(marlinModalSlowInterval);
    marlinModalFastInterval = setInterval(refreshMarlinModalStatus, 1200);
    marlinModalSlowInterval = setInterval(() => {
        refreshMarlinModalTemperatures();
        refreshMarlinConsole();
        refreshMarlinPrintStatus();
    }, 2500);
}

function renderMarlinToolheadCard(data, device) {
    const container = document.getElementById('marlin-printer-modal-toolhead');
    if (!container) return;
    if (!data || !data.connected) {
        container.innerHTML = `<div class="empty-state-small">${t('offline')}</div>`;
        return;
    }
    const position = { x: data.x || 0, y: data.y || 0, z: data.z || 0 };

    container.innerHTML = `
        <div class="temp-card toolhead-card">
            <div class="temp-card-header">
                <div class="temp-card-header-left">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                    <span>${t('toolhead')}</span>
                </div>
            </div>
            <div class="temp-card-body">
                <div class="toolhead-position-row">
                    <div class="toolhead-position-field">
                        <div class="toolhead-position-field-top"><span class="toolhead-position-letter">X</span></div>
                        <div class="toolhead-position-box"><span class="toolhead-position-value">${position.x.toFixed(2)}</span></div>
                    </div>
                    <div class="toolhead-position-field">
                        <div class="toolhead-position-field-top"><span class="toolhead-position-letter">Y</span></div>
                        <div class="toolhead-position-box"><span class="toolhead-position-value">${position.y.toFixed(2)}</span></div>
                    </div>
                    <div class="toolhead-position-field">
                        <div class="toolhead-position-field-top"><span class="toolhead-position-letter">Z</span></div>
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
                        <button type="button" class="toolhead-home-all-btn" id="marlin-toolhead-home-all-btn" title="G28">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                            <span>${t('homeAll')}</span>
                        </button>
                    </div>
                </div>

                <div class="toolhead-axis-home-row">
                    <button type="button" id="marlin-toolhead-home-x-btn">X</button>
                    <button type="button" id="marlin-toolhead-home-y-btn">Y</button>
                    <button type="button" id="marlin-toolhead-home-z-btn">Z</button>
                </div>

                <div class="toolhead-steps-row" id="marlin-toolhead-jog-steps">
                    <button type="button" class="toolhead-step-btn" data-step="1">1</button>
                    <button type="button" class="toolhead-step-btn" data-step="10">10</button>
                    <button type="button" class="toolhead-step-btn" data-step="25">25</button>
                    <button type="button" class="toolhead-step-btn active" data-step="50">50</button>
                    <button type="button" class="toolhead-step-btn" data-step="100">100</button>
                </div>
            </div>
        </div>
    `;

    container.querySelectorAll('#marlin-toolhead-jog-steps .toolhead-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            marlinToolheadJogStep = parseFloat(btn.dataset.step);
            container.querySelectorAll('#marlin-toolhead-jog-steps .toolhead-step-btn').forEach(b => b.classList.toggle('active', b === btn));
        });
        if (btn.classList.contains('active')) marlinToolheadJogStep = parseFloat(btn.dataset.step);
    });

    container.querySelectorAll('.toolhead-jog-btn[data-axis]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const axis = btn.dataset.axis;
            const dir = parseInt(btn.dataset.dir, 10);
            const distance = marlinToolheadJogStep * dir;
            const feed = axis === 'Z' ? 600 : 3000;
            await sendMarlinPrinterJog(device, axis, distance, feed);
            refreshMarlinModalStatus();
        });
    });

    const homeAllBtn = document.getElementById('marlin-toolhead-home-all-btn');
    if (homeAllBtn) homeAllBtn.addEventListener('click', async () => {
        await sendMarlinPrinterHome(device);
        refreshMarlinModalStatus();
    });

    ['x', 'y', 'z'].forEach(axis => {
        const btn = document.getElementById(`marlin-toolhead-home-${axis}-btn`);
        if (btn) btn.addEventListener('click', async () => {
            await sendMarlinPrinterHome(device, axis.toUpperCase());
            refreshMarlinModalStatus();
        });
    });
}

async function refreshMarlinModalStatus() {
    const device = marlinModalDevice;
    if (!device) return;
    try {
        const response = await fetch(`/api/marlin-printers/status?device=${encodeURIComponent(device)}`);
        const data = await response.json();
        renderMarlinToolheadCard(data, device);
        const statusDot = document.getElementById('marlin-printer-modal-status-dot');
        const statusText = document.getElementById('marlin-printer-modal-status-text');
        const visualState = getMarlinPrinterVisualState(data);
        const isOnline = visualState !== 'offline';
        if (statusDot) statusDot.className = `printer-status-dot ${visualState}`;
        if (statusText) statusText.textContent = isOnline ? t(visualState) : t('offline');
    } catch (error) {
        console.error(error);
    }
}

async function refreshMarlinModalTemperatures() {
    const device = marlinModalDevice;
    if (!device) return;
    const container = document.getElementById('marlin-printer-modal-temperatures');
    if (container && container.contains(document.activeElement) && document.activeElement.classList.contains('temp-target-input')) {
        return; // no pisar el valor mientras el usuario está escribiendo un target
    }
    try {
        const response = await fetch(`/api/marlin-printers/temperatures?device=${encodeURIComponent(device)}`);
        if (!response.ok) throw new Error('No se pudo cargar la temperatura');
        const data = await response.json();
        renderMarlinTemperaturesCard(data, device);
    } catch (error) {
        console.error(error);
        if (container) container.innerHTML = '';
    }
}

function renderMarlinTemperaturesCard(data, device) {
    const container = document.getElementById('marlin-printer-modal-temperatures');
    if (!container) return;
    const sensors = data?.sensors || [];
    if (!sensors.length) {
        container.innerHTML = '';
        return;
    }

    const rows = sensors.map((sensor, index) => {
        const color = TEMP_SERIES_COLORS[index % TEMP_SERIES_COLORS.length];
        const stateLabel = (sensor.target || 0) > 0
            ? '<span class="temp-state-arrow temp-state-arrow-up">▲</span>'
            : '<span class="temp-state-arrow temp-state-arrow-down">▼</span>';
        return `
            <div class="temp-table-row">
                <div class="temp-row-name">
                    <span class="temp-row-icon" style="color:${color}">${temperatureRowIcon('heater')}</span>
                    <span>${escapeHtml(sensor.label)}</span>
                </div>
                <div class="temp-row-state">${stateLabel}</div>
                <div class="temp-row-current" style="${sensor.current != null ? `color:${heatColorForSensor(sensor.current, sensor.key)}` : ''}">${sensor.current != null ? sensor.current.toFixed(1) + '°C' : '—'}</div>
                <div class="temp-row-target">
                    <div class="temp-target-input-wrap">
                        <input type="number" class="temp-target-input" data-heater="${escapeHtml(sensor.key)}" value="${sensor.target ?? 0}" step="1" min="0">
                        <span class="temp-target-unit">°C</span>
                    </div>
                    <button type="button" class="theme-option-icon-btn marlin-temp-apply-btn" data-heater="${escapeHtml(sensor.key)}" title="${escapeHtml(t('cncApply'))}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="temp-card">
            <div class="temp-card-header">
                <div class="temp-card-header-left">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4v10.5a4 4 0 1 0 4 0V4a2 2 0 0 0-4 0Z"/></svg>
                    <span>${t('temperatures')}</span>
                </div>
            </div>
            <div class="temp-card-body">
                <div class="temp-table">
                    <div class="temp-table-head">
                        <div>${t('columnName')}</div>
                        <div>${t('status')}</div>
                        <div>${t('tempActual')}</div>
                        <div>${t('tempTarget')}</div>
                    </div>
                    ${rows}
                </div>
            </div>
        </div>
    `;

    container.querySelectorAll('.marlin-temp-apply-btn').forEach(btn => {
        btn.addEventListener('click', () => applyMarlinTempTarget(device, btn.dataset.heater, container));
    });
    container.querySelectorAll('.temp-target-input').forEach(input => {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyMarlinTempTarget(device, input.dataset.heater, container);
            }
        });
    });
}

async function applyMarlinTempTarget(device, heater, container) {
    const input = container.querySelector(`.temp-target-input[data-heater="${heater}"]`);
    const target = parseFloat(input?.value) || 0;
    try {
        const formData = new FormData();
        formData.append('device', device);
        formData.append('heater', heater);
        formData.append('target', target);
        await fetch('/api/marlin-printers/temperature-target', { method: 'POST', body: formData });
    } catch (error) {
        console.error(error);
    }
}

function renderMarlinConsoleLog(messages) {
    const logEl = document.getElementById('marlin-printer-console-log');
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

async function refreshMarlinConsole() {
    const device = marlinModalDevice;
    if (!device) return;
    try {
        const response = await fetch(`/api/marlin-printers/console?device=${encodeURIComponent(device)}&count=150`);
        const data = await response.json();
        renderMarlinConsoleLog(data.messages || []);
    } catch (error) {
        console.error(error);
    }
}

function wireMarlinConsoleForm(device) {
    const form = document.getElementById('marlin-printer-console-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = document.getElementById('marlin-printer-console-input');
        const command = input?.value.trim();
        if (!command) return;
        input.value = '';
        try {
            const formData = new FormData();
            formData.append('device', device);
            formData.append('command', command);
            await fetch('/api/marlin-printers/console', { method: 'POST', body: formData });
        } catch (error) {
            console.error(error);
        }
        [150, 400, 900, 1800].forEach(delay => setTimeout(refreshMarlinConsole, delay));
    });
}

async function renderMarlinPrintCardShell(device) {
    const container = document.getElementById('marlin-printer-modal-print');
    if (!container) return;
    let files = [];
    try {
        const response = await fetch('/api/browse?path=&type=gcode');
        const data = await response.json();
        files = data.files || [];
    } catch (error) {
        console.error(error);
    }

    const options = files.length
        ? files.map(file => `<option value="${escapeHtml(stripSectionPrefix(file.id, 'gcode'))}">${escapeHtml(file.name)}</option>`).join('')
        : `<option value="">${escapeHtml(t('noFilesFound'))}</option>`;

    container.innerHTML = `
        <div class="temp-card">
            <div class="temp-card-header">
                <div class="temp-card-header-left">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <span>${t('marlinPrinterPrintTitle')}</span>
                </div>
            </div>
            <div class="temp-card-body">
                <div class="cnc-job-file-row">
                    <select id="marlin-print-file-select" class="settings-select">${options}</select>
                </div>
                <div class="cnc-job-progress-row">
                    <span id="marlin-print-state-text">${escapeHtml(t('marlinPrinterNoActiveJob'))}</span>
                    <div class="laser-job-progress-bar"><div class="laser-job-progress-fill" id="marlin-print-progress-fill"></div></div>
                    <span id="marlin-print-percent">0%</span>
                </div>
                <div class="cnc-job-buttons-row">
                    <button type="button" class="btn-file-action btn-file-action-accent" id="marlin-print-start-btn">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        <span>${escapeHtml(t('laserStart'))}</span>
                    </button>
                    <button type="button" class="btn-file-action" id="marlin-print-pause-btn" hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                        <span>${escapeHtml(t('laserPause'))}</span>
                    </button>
                    <button type="button" class="btn-file-action" id="marlin-print-resume-btn" hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        <span>${escapeHtml(t('laserResume'))}</span>
                    </button>
                    <button type="button" class="btn-file-action btn-file-action-danger" id="marlin-print-cancel-btn" hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        <span>${escapeHtml(t('laserCancel'))}</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    document.getElementById('marlin-print-start-btn')?.addEventListener('click', async () => {
        const select = document.getElementById('marlin-print-file-select');
        const path = select?.value;
        if (!path) return;
        try {
            const formData = new FormData();
            formData.append('device', device);
            formData.append('path', path);
            const response = await fetch('/api/marlin-printers/print/start', { method: 'POST', body: formData });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'No se pudo iniciar la impresión.');
            }
            showToast(t('cncJobStarted'));
        } catch (error) {
            console.error(error);
            appAlert(error.message || 'No se pudo iniciar la impresión.', '', 'danger');
        }
        refreshMarlinPrintStatus();
    });

    document.getElementById('marlin-print-pause-btn')?.addEventListener('click', async () => {
        const formData = new FormData();
        formData.append('device', device);
        await fetch('/api/marlin-printers/print/pause', { method: 'POST', body: formData });
        refreshMarlinPrintStatus();
    });
    document.getElementById('marlin-print-resume-btn')?.addEventListener('click', async () => {
        const formData = new FormData();
        formData.append('device', device);
        await fetch('/api/marlin-printers/print/resume', { method: 'POST', body: formData });
        refreshMarlinPrintStatus();
    });
    document.getElementById('marlin-print-cancel-btn')?.addEventListener('click', async () => {
        if (!(await appConfirm(t('laserCancel'), t('laserCancel'), 'danger'))) return;
        const formData = new FormData();
        formData.append('device', device);
        await fetch('/api/marlin-printers/print/cancel', { method: 'POST', body: formData });
        refreshMarlinPrintStatus();
    });
}

async function refreshMarlinPrintStatus() {
    const device = marlinModalDevice;
    if (!device) return;
    try {
        const response = await fetch(`/api/marlin-printers/print/status?device=${encodeURIComponent(device)}`);
        const job = await response.json();
        const state = job?.state || 'idle';
        const isActive = state === 'running' || state === 'paused';
        const stateTextEl = document.getElementById('marlin-print-state-text');
        if (stateTextEl) {
            stateTextEl.textContent = isActive ? (job.filename || t('marlinPrinterNoActiveJob')) : t('marlinPrinterNoActiveJob');
        }
        const percent = job?.total ? Math.round((job.current / job.total) * 100) : 0;
        const fillEl = document.getElementById('marlin-print-progress-fill');
        if (fillEl) fillEl.style.width = `${percent}%`;
        const percentEl = document.getElementById('marlin-print-percent');
        if (percentEl) percentEl.textContent = `${percent}%`;

        const startBtn = document.getElementById('marlin-print-start-btn');
        const pauseBtn = document.getElementById('marlin-print-pause-btn');
        const resumeBtn = document.getElementById('marlin-print-resume-btn');
        const cancelBtn = document.getElementById('marlin-print-cancel-btn');
        if (startBtn) startBtn.hidden = isActive;
        if (pauseBtn) pauseBtn.hidden = state !== 'running';
        if (resumeBtn) resumeBtn.hidden = state !== 'paused';
        if (cancelBtn) cancelBtn.hidden = !isActive;

        const select = document.getElementById('marlin-print-file-select');
        if (select) select.disabled = isActive;
    } catch (error) {
        console.error(error);
    }
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
            const category = item.closest('.nav-category');
            if (category?.classList.contains('collapsed')) {
                setCategoryCollapsed(category, false);
            }
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
    if (sectionName === 'laser') {
        stopCncPolling();
        loadLaserSection();
    } else if (sectionName === 'cnc') {
        stopLaserPolling();
        loadCncSection();
    } else {
        stopLaserPolling();
        stopCncPolling();
    }
    if (document.getElementById('laser-gamepad-modal')?.classList.contains('active')) {
        updateGamepadConsoleForSection();
    }
    if (sectionName === 'settings') {
        loadUpdatesStatus();
        refreshUsbPorts();
        loadRegistryDevices();
        renderSidebarOrderList();
        renderLaserMarkerSettings();
        renderGamepadBadge();
        loadUsersSettings();
    } else {
        stopSystemLogPolling();
    }
    if (sectionName === 'help') {
        loadHelpVersion();
    }
    if (sectionName === 'pricing') {
        loadPricingSection();
    }
}

async function loadHelpVersion() {
    const badge = document.getElementById('help-version-badge');
    if (!badge) return;
    try {
        const response = await fetch('/api/system/version');
        if (!response.ok) throw new Error('No se pudo cargar la versión');
        const data = await response.json();
        badge.textContent = data.app_version ? `v${data.app_version}` : '—';
    } catch (error) {
        console.error(error);
        badge.textContent = '—';
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

const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn');
if (sidebarSettingsBtn) {
    sidebarSettingsBtn.addEventListener('click', () => switchSection('settings'));
}

const sidebarHelpBtn = document.getElementById('sidebar-help-btn');
if (sidebarHelpBtn) {
    sidebarHelpBtn.addEventListener('click', () => switchSection('help'));
}

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

    const folderRows = folders.map(folder => folderRowHtml(folder, 5)).join('');

    const fileRows = sortedFiles.map(model => {
        const isSelected = model.id === selectedModelId;
        const extensionLabel = model.extension ? model.extension.replace('.', '').toUpperCase() : '—';
        const checked = getBulkSelection('model').has(model.id) ? 'checked' : '';
        const isGcode = isGcodeFile(model);
        const icon = isGcode
            ? '<svg class="orange-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
            : '<svg class="green-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h3l2-2h4l2 2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M8 11h8"/><path d="M8 15h8"/></svg>';

        return `
            <tr class="${isSelected ? 'selected' : ''}" data-model-id="${model.id}">
                <td class="select-col"><input type="checkbox" class="row-select-checkbox" data-model-id="${model.id}" ${checked}></td>
                <td class="model-name">
                    ${icon}
                    <strong>${model.name}</strong>
                </td>
                <td>${isGcode ? t('gcode') : t('model3D')}</td>
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
                    <th class="select-col"><input type="checkbox" class="select-all-checkbox" id="models-select-all"></th>
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
    wireBulkSelection('model', modelsFullGrid, sortedFiles);

    modelsFullGrid.querySelectorAll('tbody tr[data-model-id]').forEach(row => {
        row.addEventListener('click', (event) => {
            if (event.target.closest('.row-select-checkbox')) return;
            const model = currentModelsData.files.find(entry => entry.id === row.dataset.modelId);
            if (model) selectPreviewModel(model);
        });
    });

    if (selected) {
        selectPreviewModel(selected, false);
    }
}

const GCODE_FILE_EXTENSIONS = ['.gcode', '.gc', '.gco', '.nc', '.tap', '.cnc'];

function isGcodeFile(model) {
    return GCODE_FILE_EXTENSIONS.includes((model?.extension || '').toLowerCase());
}

function getFavoriteModelIds() {
    try {
        return new Set(JSON.parse(localStorage.getItem('favoriteModelIds') || '[]'));
    } catch (error) {
        return new Set();
    }
}

function toggleFavoriteModel(id) {
    const favorites = getFavoriteModelIds();
    if (favorites.has(id)) {
        favorites.delete(id);
    } else {
        favorites.add(id);
    }
    localStorage.setItem('favoriteModelIds', JSON.stringify([...favorites]));
    return favorites.has(id);
}

function goToOnlinePrinter() {
    if (!allPrinters.length) {
        appAlert(t('noPrintersFound'), '', 'warning');
        return;
    }
    const printer = allPrinters.find(p => p.status === 'online') || allPrinters[0];
    openPrinterModal(printer);
}

function selectPreviewModel(model, rerender = true) {
    if (!model) return;
    selectedModelId = model.id;
    const previewTitle = document.getElementById('preview-filename');
    const previewTypePill = document.getElementById('preview-type-pill');
    const previewType = document.getElementById('preview-type');
    const previewSize = document.getElementById('preview-size');
    const previewDate = document.getElementById('preview-date');
    const previewImage = document.getElementById('preview-image');
    const sendPrinterBtn = document.getElementById('preview-send-printer-btn');
    const favoriteBtn = document.getElementById('preview-favorite-btn');
    const gotoPrinterBtn = document.getElementById('preview-goto-printer-btn');

    const extensionLabel = model.extension ? model.extension.replace('.', '').toUpperCase() : '—';

    if (previewTitle) previewTitle.textContent = model.name;
    if (previewTypePill) {
        previewTypePill.textContent = extensionLabel;
        previewTypePill.hidden = false;
    }
    if (previewType) previewType.textContent = extensionLabel;
    if (previewSize) previewSize.textContent = formatSize(model.size);
    if (previewDate) previewDate.textContent = formatDate(model.modified);
    if (previewImage) {
        previewImage.innerHTML = '';
        previewImage.style.backgroundImage = 'linear-gradient(180deg, rgba(15,23,42,1) 0%, rgba(31,41,55,1) 100%)';
    }
    if (sendPrinterBtn) sendPrinterBtn.hidden = !isGcodeFile(model);
    if (favoriteBtn) favoriteBtn.classList.toggle('active', getFavoriteModelIds().has(model.id));
    if (gotoPrinterBtn) gotoPrinterBtn.hidden = false;

    renderSelectedPreview(model);

    if (rerender) {
        renderModelsFullPage();
    }
}

const previewSendPrinterBtn = document.getElementById('preview-send-printer-btn');
if (previewSendPrinterBtn) {
    previewSendPrinterBtn.addEventListener('click', () => {
        const model = currentModelsData.files.find(entry => entry.id === selectedModelId);
        if (!model || !isGcodeFile(model)) return;
        const relPath = stripSectionPrefix(model.id, 'model');
        openPrinterSendModal(relPath, model.name, 'model', model);
    });
}

const previewFavoriteBtn = document.getElementById('preview-favorite-btn');
if (previewFavoriteBtn) {
    previewFavoriteBtn.addEventListener('click', () => {
        if (!selectedModelId) return;
        const isFavorite = toggleFavoriteModel(selectedModelId);
        previewFavoriteBtn.classList.toggle('active', isFavorite);
    });
}

const previewGotoPrinterBtn = document.getElementById('preview-goto-printer-btn');
if (previewGotoPrinterBtn) {
    previewGotoPrinterBtn.addEventListener('click', goToOnlinePrinter);
}

const previewExpandBtn = document.getElementById('preview-expand-btn');
if (previewExpandBtn) {
    previewExpandBtn.addEventListener('click', () => {
        const model = currentModelsData.files.find(entry => entry.id === selectedModelId);
        if (!model) return;
        openModelModal(model.file_url, model.name, model);
    });
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
const settingsSoundAlerts = document.getElementById('settings-sound-alerts');
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
const settingsCncModeSwitch = createOptionSwitch('settings-cnc-mode-switch', () => saveSettings());
const usbClassifyProfileSwitch = createOptionSwitch('usb-classify-profile-switch', null);
const deviceRenameProfileSwitch = createOptionSwitch('device-rename-profile-switch', null);
const usbClassifyFirmwareSwitch = createOptionSwitch('usb-classify-firmware-switch', null);
const deviceRenameFirmwareSwitch = createOptionSwitch('device-rename-firmware-switch', null);
const systemLogLevelSwitch = createOptionSwitch('system-log-level-switch', () => renderSystemLogs());

// ── Visor de logs del sistema (Configuración) ──
let systemLogPollInterval = null;

async function renderSystemLogs() {
    const viewer = document.getElementById('system-log-viewer');
    if (!viewer) return;
    const level = systemLogLevelSwitch.getValue();
    const query = level && level !== 'all' ? `&level=${encodeURIComponent(level)}` : '';
    try {
        const response = await fetch(`/api/logs?lines=500${query}`);
        const data = await response.json();
        viewer.innerHTML = (data.lines || []).map(line => {
            let levelClass = '';
            if (/\bERROR\b/.test(line)) levelClass = 'console-line-level-error';
            else if (/\bWARNING\b/.test(line)) levelClass = 'console-line-level-warning';
            return `<div class="console-line ${levelClass}"><span class="console-line-message">${escapeHtml(line)}</span></div>`;
        }).join('');
        viewer.scrollTop = viewer.scrollHeight;
    } catch (error) {
        console.error(error);
    }
}

document.getElementById('system-log-refresh-btn')?.addEventListener('click', renderSystemLogs);

function startSystemLogPolling() {
    renderSystemLogs();
    stopSystemLogPolling();
    // Un log no necesita el ritmo de 600ms/4s usado en otros lados — 15s
    // alcanza de sobra para un panel de diagnóstico que se refresca a pedido.
    systemLogPollInterval = setInterval(renderSystemLogs, 15000);
}

function stopSystemLogPolling() {
    if (systemLogPollInterval) { clearInterval(systemLogPollInterval); systemLogPollInterval = null; }
}

const systemLogsModal = document.getElementById('system-logs-modal');
const systemLogsModalBackdrop = document.getElementById('system-logs-modal-backdrop');
const systemLogsModalClose = document.getElementById('system-logs-modal-close');
const systemLogOpenBtn = document.getElementById('system-log-open-btn');

function openSystemLogsModal() {
    if (systemLogsModal) systemLogsModal.classList.add('active');
    startSystemLogPolling();
}

function closeSystemLogsModal() {
    if (systemLogsModal) systemLogsModal.classList.remove('active');
    stopSystemLogPolling();
}

if (systemLogOpenBtn) systemLogOpenBtn.addEventListener('click', openSystemLogsModal);
if (systemLogsModalBackdrop) systemLogsModalBackdrop.addEventListener('click', closeSystemLogsModal);
if (systemLogsModalClose) systemLogsModalClose.addEventListener('click', closeSystemLogsModal);

function applyUiScale(scale) {
    document.documentElement.style.fontSize = `${scale}%`;
}
applyUiScale(localStorage.getItem('uiScale') || '100');

// Modo Simple/Avanzado del panel CNC — controla qué tan visibles están los
// controles semi-pro (overrides, WCS, pines, perfiles) vía CSS
// (body[data-cnc-mode] .cnc-advanced-only). Se aplica ya al cargar la página,
// no solo al entrar a Configuración, para que el filtro esté activo desde el
// primer render de la ficha CNC.
function applyCncDashboardMode(mode) {
    document.body.setAttribute('data-cnc-mode', mode);
}
applyCncDashboardMode(localStorage.getItem('cncDashboardMode') || 'simple');

// Perfil de la máquina CNC activa (router con husillo vs. plotter de
// lápiz/marcador) — mismo mecanismo que applyCncDashboardMode() (atributo en
// <body>, filtrado por CSS vía .cnc-router-only), llamado cada vez que se
// resuelve/cambia el host CNC activo. El texto del botón "Z=0 aquí" también
// cambia acá porque en modo plotter no tiene sentido hablar de "profundidad".
function applyCncMachineProfile(profile) {
    const resolved = profile === 'plotter' ? 'plotter' : 'router';
    document.body.setAttribute('data-cnc-profile', resolved);
    const zeroZBtn = document.getElementById('cnc-zero-z-btn');
    if (zeroZBtn) {
        const span = zeroZBtn.querySelector('span');
        if (span) span.textContent = t(resolved === 'plotter' ? 'cncZeroZPlotter' : 'cncZeroZ');
    }
}
const settingsStatus = document.getElementById('settings-status');

const THEME_PALETTES = {
    light: {
        accent: '#22c55e',
        surface: '#FFFFFF',
        bg: '#F7F8FA',
        sidebar: '#FFFFFF',
        text: '#1E293B',
        muted: '#64748B',
    },
    dark: {
        accent: '#22c55e',
        surface: '#181818',
        bg: '#050505',
        sidebar: '#0C0C0C',
        text: '#FFFFFF',
        muted: '#B8B8B8',
    },
    green: {
        accent: '#22c55e',
        surface: '#171D23',
        bg: '#0f172a',
        sidebar: '#0A0D10',
        text: '#F5F7FA',
        muted: '#B7C1CC',
    },
    red: {
        accent: '#E5484D',
        surface: '#2E171A',
        bg: '#120809',
        sidebar: '#1A0C0D',
        text: '#FFFFFF',
        muted: '#D2B8BA',
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
    if (settingsSoundAlerts) settingsSoundAlerts.checked = isSoundAlertsEnabled();
    if (settingsLaserHomeConfirm) settingsLaserHomeConfirm.checked = isLaserHomeConfirmEnabled();
    settingsUiScaleSwitch.setValue(savedUiScale);
    settingsCncModeSwitch.setValue(localStorage.getItem('cncDashboardMode') || 'simple');

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
    if (settingsSoundAlerts) {
        localStorage.setItem('soundAlertsEnabled', settingsSoundAlerts.checked ? 'true' : 'false');
        if (settingsSoundAlerts.checked) requestNotificationPermission();
    }
    if (settingsLaserHomeConfirm) {
        localStorage.setItem('laserHomeConfirmEnabled', settingsLaserHomeConfirm.checked ? 'true' : 'false');
    }
    const uiScaleValue = settingsUiScaleSwitch.getValue();
    if (uiScaleValue) {
        localStorage.setItem('uiScale', uiScaleValue);
        applyUiScale(uiScaleValue);
    }
    const cncModeValue = settingsCncModeSwitch.getValue();
    if (cncModeValue) {
        localStorage.setItem('cncDashboardMode', cncModeValue);
        applyCncDashboardMode(cncModeValue);
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
    const order = ['light', 'dark', 'green', 'red'];
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
const customThemeCancelBtn = document.getElementById('custom-theme-cancel-btn');
const customThemeResetBtn = document.getElementById('custom-theme-reset-btn');
const customThemeAccentInput = document.getElementById('custom-theme-accent');
const customThemeSurfaceInput = document.getElementById('custom-theme-surface');
const customThemeTextInput = document.getElementById('custom-theme-text');
const customThemeMutedInput = document.getElementById('custom-theme-muted');
const customThemeSaveBtn = document.getElementById('custom-theme-save-btn');
const customThemeBgInput = document.getElementById('custom-theme-bg-input');
const customThemeBgClearBtn = document.getElementById('custom-theme-bg-clear-btn');
const customThemeBgChangeBtn = document.getElementById('custom-theme-bg-change-btn');
const customThemeBgDropzone = document.getElementById('custom-theme-bg-dropzone');
const customThemeBgPreviewImg = document.getElementById('custom-theme-bg-preview-img');
const customThemeBgPreviewPlaceholder = document.getElementById('custom-theme-bg-preview-placeholder');
const customThemePreview = document.getElementById('custom-theme-preview');

const CUSTOM_THEME_DEFAULTS = { accent: '#8b5cf6', surface: '#1f2937', text: '#f8fafc', muted: '#94a3b8' };
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

function renderCustomThemeBgPreview() {
    const bg = getCustomThemeBackground();
    if (customThemeBgPreviewImg) {
        customThemeBgPreviewImg.src = bg || '';
        customThemeBgPreviewImg.hidden = !bg;
    }
    if (customThemeBgPreviewPlaceholder) customThemeBgPreviewPlaceholder.hidden = !!bg;
    if (customThemeBgClearBtn) customThemeBgClearBtn.hidden = !bg;
}

function applyCustomThemeBackgroundFile(file) {
    if (!file) return;
    if (file.size > CUSTOM_THEME_BG_MAX_BYTES) {
        appAlert(t('customThemeBgTooLarge'), '', 'warning');
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        setCustomThemeBackground(reader.result);
        renderCustomThemeBgPreview();
        if (document.body.classList.contains('custom')) applyCustomThemeBackground();
    };
    reader.readAsDataURL(file);
}

if (customThemeBgInput) {
    customThemeBgInput.addEventListener('change', () => {
        const file = customThemeBgInput.files?.[0];
        customThemeBgInput.value = '';
        applyCustomThemeBackgroundFile(file);
    });
}

if (customThemeBgChangeBtn) {
    customThemeBgChangeBtn.addEventListener('click', () => customThemeBgInput?.click());
}

if (customThemeBgDropzone) {
    ['dragenter', 'dragover'].forEach(evt => {
        customThemeBgDropzone.addEventListener(evt, (event) => {
            event.preventDefault();
            customThemeBgDropzone.classList.add('dragover');
        });
    });
    ['dragleave', 'dragend'].forEach(evt => {
        customThemeBgDropzone.addEventListener(evt, () => {
            customThemeBgDropzone.classList.remove('dragover');
        });
    });
    customThemeBgDropzone.addEventListener('drop', (event) => {
        event.preventDefault();
        customThemeBgDropzone.classList.remove('dragover');
        const file = event.dataTransfer?.files?.[0];
        applyCustomThemeBackgroundFile(file);
    });
}

if (customThemeBgClearBtn) {
    customThemeBgClearBtn.addEventListener('click', () => {
        setCustomThemeBackground(null);
        renderCustomThemeBgPreview();
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

function updateCustomThemePreview() {
    if (!customThemePreview) return;
    customThemePreview.style.setProperty('--ctp-accent', customThemeAccentInput?.value || CUSTOM_THEME_DEFAULTS.accent);
    customThemePreview.style.setProperty('--ctp-surface', customThemeSurfaceInput?.value || CUSTOM_THEME_DEFAULTS.surface);
    customThemePreview.style.setProperty('--ctp-text', customThemeTextInput?.value || CUSTOM_THEME_DEFAULTS.text);
    customThemePreview.style.setProperty('--ctp-muted', customThemeMutedInput?.value || CUSTOM_THEME_DEFAULTS.muted);
}

[customThemeAccentInput, customThemeSurfaceInput, customThemeTextInput, customThemeMutedInput].forEach(input => {
    if (input) input.addEventListener('input', updateCustomThemePreview);
});

document.querySelectorAll('.custom-theme-color-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.target);
        target?.click();
    });
});

if (customThemeResetBtn) {
    customThemeResetBtn.addEventListener('click', () => {
        if (customThemeAccentInput) customThemeAccentInput.value = CUSTOM_THEME_DEFAULTS.accent;
        if (customThemeSurfaceInput) customThemeSurfaceInput.value = CUSTOM_THEME_DEFAULTS.surface;
        if (customThemeTextInput) customThemeTextInput.value = CUSTOM_THEME_DEFAULTS.text;
        if (customThemeMutedInput) customThemeMutedInput.value = CUSTOM_THEME_DEFAULTS.muted;
        updateCustomThemePreview();
    });
}

function openCustomThemeModal() {
    const custom = getCustomTheme();
    if (customThemeAccentInput) customThemeAccentInput.value = custom?.accent || CUSTOM_THEME_DEFAULTS.accent;
    if (customThemeSurfaceInput) customThemeSurfaceInput.value = custom?.surface || CUSTOM_THEME_DEFAULTS.surface;
    if (customThemeTextInput) customThemeTextInput.value = custom?.text || CUSTOM_THEME_DEFAULTS.text;
    if (customThemeMutedInput) customThemeMutedInput.value = custom?.muted || CUSTOM_THEME_DEFAULTS.muted;
    updateCustomThemePreview();
    renderCustomThemeBgPreview();
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
if (customThemeCancelBtn) customThemeCancelBtn.addEventListener('click', closeCustomThemeModal);
if (customThemeSaveBtn) {
    customThemeSaveBtn.addEventListener('click', () => {
        const colors = {
            accent: customThemeAccentInput?.value || CUSTOM_THEME_DEFAULTS.accent,
            surface: customThemeSurfaceInput?.value || CUSTOM_THEME_DEFAULTS.surface,
            text: customThemeTextInput?.value || CUSTOM_THEME_DEFAULTS.text,
            muted: customThemeMutedInput?.value || CUSTOM_THEME_DEFAULTS.muted,
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
loadLaserHistory();
loadTopbarServerStats();
refreshDashboardLaserCard();
refreshUsbPorts();
loadAccessories();

// Refresh printers every 5 seconds
setInterval(loadPrinters, 5000);
setInterval(loadTopbarServerStats, 10000);
setInterval(loadAccessories, 10000);
// Antes cada 4s — con 6 dispositivos registrados en paralelo, cada uno
// pudiendo tardar hasta ~8s en darse por vencido si está apagado/desconectado
// (5s de ensure_listener_ready + 3s de espera de respuesta en get_status),
// los ciclos se apilaban entre sí y competían por la única conexión que cada
// placa GRBL soporta — eso era la causa real de "se desconecta seguido y la
// página queda lenta". 20s conserva el aviso de conexión/desconexión
// (checkLaserConnectionTransitions) sin la contención constante.
setInterval(refreshDashboardLaserCard, 20000);
setInterval(refreshUsbPorts, 8000);

// ── Cotizador ──

const PRICING_JOB_TYPE_MAP = {
    printer: { section: 'model', machineKind: 'printer', materialKind: 'filament' },
    laser_cut: { section: 'gcode', machineKind: 'laser', materialKind: null },
    laser_engrave: { section: 'gcode', machineKind: 'laser', materialKind: null },
    cnc: { section: 'gcode', machineKind: 'cnc', materialKind: null },
};

const PRICING_JOB_TYPE_LABEL_KEYS = {
    printer: 'pricingJobTypePrinter',
    laser_cut: 'pricingJobTypeLaserCut',
    laser_engrave: 'pricingJobTypeLaserEngrave',
    cnc: 'pricingJobTypeCnc',
};

let pricingJobType = 'printer';
let pricingBrowsePath = '';
let pricingBrowseData = { folders: [], files: [] };
let pricingSelectedFile = null;
let pricingMachines = [];
let pricingMaterials = [];
let pricingExtraCosts = [];
let pricingLastQuoteResult = null;
let pricingLastSavedQuoteId = null;
let pricingQuoteRequestTimer = null;
let pricingQuoteDate = null;
let pricingWired = false;
let pricingWhatsappQuoteId = null;

function pricingSection() {
    return PRICING_JOB_TYPE_MAP[pricingJobType].section;
}

function pricingJobTypeLabel(type) {
    const key = PRICING_JOB_TYPE_LABEL_KEYS[type];
    return key ? t(key) : '—';
}

function _formatMinutes(totalMinutes) {
    const m = Math.round(totalMinutes);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h ? `${h}h ${mm}m` : `${mm}m`;
}

function ensurePricingValidUntilDefault() {
    const input = document.getElementById('pricing-valid-until-input');
    if (input && !input.value) {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        input.value = d.toISOString().slice(0, 10);
    }
}

async function loadPricingSection() {
    wirePricingSection();
    updatePricingJobTypeTheme();
    await loadPricingCatalogs();
    await loadPricingFileBrowser(pricingBrowsePath);
    renderPricingExtraCosts();
    loadPricingQuotesHistory();
    ensurePricingValidUntilDefault();
    updatePricingBreadcrumbState();
    schedulePricingQuoteRefresh();
}

function wirePricingSection() {
    if (pricingWired) return;
    pricingWired = true;

    document.querySelectorAll('#pricing-job-type-switch .option-switch-btn').forEach(btn => {
        btn.addEventListener('click', () => setPricingJobType(btn.dataset.value));
    });
    document.querySelectorAll('#pricing-detail-level-switch .option-switch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#pricing-detail-level-switch .option-switch-btn').forEach(b => b.classList.toggle('active', b === btn));
            pricingLastSavedQuoteId = null;
            schedulePricingQuoteRefresh();
        });
    });

    document.getElementById('pricing-machine-select')?.addEventListener('change', () => {
        pricingLastSavedQuoteId = null;
        schedulePricingQuoteRefresh();
    });
    document.getElementById('pricing-material-select')?.addEventListener('change', () => {
        pricingLastSavedQuoteId = null;
        schedulePricingQuoteRefresh();
    });
    document.getElementById('pricing-color-select')?.addEventListener('change', () => { pricingLastSavedQuoteId = null; });

    const qtyInput = document.getElementById('pricing-quantity-input');
    qtyInput?.addEventListener('input', () => {
        pricingLastSavedQuoteId = null;
        schedulePricingQuoteRefresh();
    });
    document.getElementById('pricing-qty-minus')?.addEventListener('click', () => {
        if (!qtyInput) return;
        qtyInput.value = Math.max(1, (parseInt(qtyInput.value, 10) || 1) - 1);
        qtyInput.dispatchEvent(new Event('input'));
    });
    document.getElementById('pricing-qty-plus')?.addEventListener('click', () => {
        if (!qtyInput) return;
        qtyInput.value = (parseInt(qtyInput.value, 10) || 1) + 1;
        qtyInput.dispatchEvent(new Event('input'));
    });

    document.getElementById('pricing-currency-select')?.addEventListener('change', () => renderPricingCostSummary(pricingLastQuoteResult));
    document.getElementById('pricing-exchange-rate-input')?.addEventListener('input', () => renderPricingCostSummary(pricingLastQuoteResult));

    document.getElementById('pricing-add-extra-cost-btn')?.addEventListener('click', addPricingExtraCostRow);
    document.getElementById('pricing-replace-file-btn')?.addEventListener('click', showPricingFileBrowserAgain);
    document.getElementById('pricing-new-quote-btn')?.addEventListener('click', resetPricingWizard);
    document.getElementById('pricing-discard-btn')?.addEventListener('click', resetPricingWizard);
    document.getElementById('pricing-copy-id-btn')?.addEventListener('click', copyPricingQuoteId);

    document.getElementById('pricing-save-btn')?.addEventListener('click', savePricingQuote);
    document.getElementById('pricing-print-btn')?.addEventListener('click', () => openPricingPrintPreview());
    document.getElementById('pricing-send-btn')?.addEventListener('click', () => sendPricingQuoteAction());
    document.getElementById('pricing-whatsapp-btn')?.addEventListener('click', () => openPricingWhatsappModal());

    document.getElementById('pricing-whatsapp-confirm-btn')?.addEventListener('click', confirmPricingWhatsappSend);
    document.getElementById('pricing-whatsapp-cancel-btn')?.addEventListener('click', closePricingWhatsappModal);
    document.getElementById('pricing-whatsapp-modal-close')?.addEventListener('click', closePricingWhatsappModal);
    document.getElementById('pricing-whatsapp-modal-backdrop')?.addEventListener('click', closePricingWhatsappModal);

    wireTopbarDropdown('pricing-header-menu-btn', 'pricing-header-menu-panel');
}

function updatePricingBreadcrumbState() {
    const step1 = document.getElementById('pricing-breadcrumb-step-1');
    const step2 = document.getElementById('pricing-breadcrumb-step-2');
    const step3 = document.getElementById('pricing-breadcrumb-step-3');
    const sub1 = document.getElementById('pricing-breadcrumb-sub-1');
    if (!step1 || !step2 || !step3) return;

    const hasFile = !!pricingSelectedFile;
    const hasQuote = !!pricingLastQuoteResult;

    if (sub1) sub1.textContent = hasFile ? t('pricingStep1SubDone') : t('pricingStep1SubEmpty');
    step1.classList.toggle('done', hasFile);
    step1.classList.toggle('active', !hasFile);
    step2.classList.toggle('done', hasQuote);
    step2.classList.toggle('active', hasFile && !hasQuote);
    step3.classList.toggle('active', hasQuote);
}

function updatePricingJobTypeTheme() {
    const section = document.getElementById('pricing-section');
    if (!section) return;
    section.classList.remove('job-type-laser', 'job-type-cnc');
    if (pricingJobType === 'laser_cut' || pricingJobType === 'laser_engrave') {
        section.classList.add('job-type-laser');
    } else if (pricingJobType === 'cnc') {
        section.classList.add('job-type-cnc');
    }
}

function setPricingJobType(type) {
    if (!PRICING_JOB_TYPE_MAP[type] || pricingJobType === type) return;
    pricingJobType = type;
    pricingBrowsePath = '';
    pricingSelectedFile = null;
    pricingLastQuoteResult = null;
    pricingLastSavedQuoteId = null;
    document.getElementById('pricing-selected-file-block').hidden = true;
    document.getElementById('pricing-file-empty').hidden = false;
    document.getElementById('pricing-file-info-card').hidden = true;
    document.querySelectorAll('#pricing-job-type-switch .option-switch-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === type);
    });
    updatePricingJobTypeTheme();
    renderPricingMaterialSelect();
    renderPricingMachineSelect();
    loadPricingFileBrowser('');
    renderPricingCostSummary(null);
    renderPricingFileInfo(null);
    updatePricingBreadcrumbState();
}

function showPricingFileBrowserAgain() {
    pricingSelectedFile = null;
    document.getElementById('pricing-selected-file-block').hidden = true;
    document.getElementById('pricing-file-empty').hidden = false;
    renderPricingFileBrowser();
    updatePricingBreadcrumbState();
}

function resetPricingWizard() {
    pricingSelectedFile = null;
    pricingLastQuoteResult = null;
    pricingLastSavedQuoteId = null;
    pricingExtraCosts = [];
    pricingQuoteDate = null;
    document.getElementById('pricing-file-empty').hidden = false;
    document.getElementById('pricing-selected-file-block').hidden = true;
    document.getElementById('pricing-file-info-card').hidden = true;
    const qtyInput = document.getElementById('pricing-quantity-input');
    if (qtyInput) qtyInput.value = 1;
    const notesInput = document.getElementById('pricing-notes-input');
    if (notesInput) notesInput.value = '';
    const validUntilInput = document.getElementById('pricing-valid-until-input');
    if (validUntilInput) validUntilInput.value = '';
    const clientNameInput = document.getElementById('pricing-client-name-input');
    if (clientNameInput) clientNameInput.value = '';
    const clientPhoneInput = document.getElementById('pricing-client-phone-input');
    if (clientPhoneInput) clientPhoneInput.value = '';
    ensurePricingValidUntilDefault();
    document.querySelectorAll('#pricing-detail-level-switch .option-switch-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === 'standard');
    });
    renderPricingFileBrowser();
    renderPricingExtraCosts();
    renderPricingCostSummary(null);
    renderPricingFileInfo(null);
    renderPricingAdditionalInfo(null);
    updatePricingBreadcrumbState();
    closeAllTopbarDropdowns();
}

function copyPricingQuoteId() {
    if (!pricingLastSavedQuoteId) return;
    navigator.clipboard?.writeText(pricingLastSavedQuoteId)
        .then(() => showToast(t('pricingIdCopied')))
        .catch(() => {});
}

async function loadPricingCatalogs() {
    try {
        const [materialsRes, machinesRes] = await Promise.all([
            fetch('/api/pricing/materials'),
            fetch('/api/pricing/machines'),
        ]);
        pricingMaterials = materialsRes.ok ? (await materialsRes.json()).materials : [];
        pricingMachines = machinesRes.ok ? (await machinesRes.json()).machines : [];
    } catch (error) {
        console.error(error);
        pricingMaterials = [];
        pricingMachines = [];
    }
    renderPricingMaterialSelect();
    renderPricingMachineSelect();
}

function renderPricingMaterialSelect() {
    const select = document.getElementById('pricing-material-select');
    if (!select) return;
    const wantKind = PRICING_JOB_TYPE_MAP[pricingJobType].materialKind;
    const relevant = pricingMaterials.filter(m => wantKind ? m.kind === wantKind : m.kind !== 'filament');
    const prevValue = select.value;
    select.innerHTML = relevant.length
        ? relevant.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('')
        : `<option value="">${escapeHtml(t('pricingNoMaterials'))}</option>`;
    if (relevant.some(m => m.id === prevValue)) select.value = prevValue;
}

function renderPricingMachineSelect() {
    const select = document.getElementById('pricing-machine-select');
    if (!select) return;
    const wantKind = PRICING_JOB_TYPE_MAP[pricingJobType].machineKind;
    const relevant = pricingMachines.filter(m => m.kind === wantKind);
    const prevValue = select.value;
    select.innerHTML = `<option value="">${escapeHtml(t('pricingNoMachine'))}</option>` +
        relevant.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    if (relevant.some(m => m.id === prevValue)) select.value = prevValue;
}

async function loadPricingFileBrowser(path) {
    pricingBrowsePath = path;
    const container = document.getElementById('pricing-file-browser');
    if (container) container.innerHTML = `<div class="empty-state-small">${escapeHtml(t('pricingLoading'))}</div>`;
    try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}&type=${encodeURIComponent(pricingSection())}`);
        if (!response.ok) throw new Error('No se pudo cargar la carpeta');
        pricingBrowseData = await response.json();
    } catch (error) {
        console.error(error);
        pricingBrowseData = { folders: [], files: [] };
    }
    renderPricingBreadcrumb();
    renderPricingFileBrowser();
}

function renderPricingBreadcrumb() {
    const container = document.getElementById('pricing-file-breadcrumb');
    if (!container) return;
    const rootLabel = pricingSection() === 'model' ? t('navPrinting3d') : t('pricingLaserCnc');
    const parts = pricingBrowsePath ? pricingBrowsePath.split('/') : [];
    let accPath = '';
    const crumbs = [`<button type="button" data-path="">${escapeHtml(rootLabel)}</button>`];
    parts.forEach(part => {
        accPath = accPath ? `${accPath}/${part}` : part;
        crumbs.push('<span>/</span>');
        crumbs.push(`<button type="button" data-path="${escapeHtml(accPath)}">${escapeHtml(part)}</button>`);
    });
    container.innerHTML = crumbs.join(' ');
    container.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => loadPricingFileBrowser(btn.dataset.path));
    });
}

function renderPricingFileBrowser() {
    const container = document.getElementById('pricing-file-browser');
    if (!container) return;
    const folders = pricingBrowseData.folders || [];
    const files = pricingBrowseData.files || [];
    if (!folders.length && !files.length) {
        container.innerHTML = `<div class="empty-state-small">${escapeHtml(t('noFilesFound'))}</div>`;
        return;
    }

    const folderRows = folders.map(folder => `
        <button type="button" class="pricing-file-row folder" data-path="${escapeHtml(folder.path)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>${escapeHtml(folder.name)}</span>
            <span class="pricing-file-row-meta">${folder.file_count}</span>
        </button>
    `);
    const fileRows = files.map(file => `
        <button type="button" class="pricing-file-row${pricingSelectedFile && pricingSelectedFile.id === file.id ? ' selected' : ''}" data-id="${escapeHtml(file.id)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span>${escapeHtml(file.name)}</span>
            <span class="pricing-file-row-meta">${escapeHtml(formatSize(file.size))}</span>
        </button>
    `);

    container.innerHTML = folderRows.join('') + fileRows.join('');
    container.querySelectorAll('.pricing-file-row.folder').forEach(btn => {
        btn.addEventListener('click', () => loadPricingFileBrowser(btn.dataset.path));
    });
    container.querySelectorAll('.pricing-file-row:not(.folder)').forEach(btn => {
        btn.addEventListener('click', () => {
            const file = files.find(f => f.id === btn.dataset.id);
            if (file) selectPricingFile(file);
        });
    });
}

function selectPricingFile(file) {
    pricingSelectedFile = file;
    pricingLastQuoteResult = null;
    pricingLastSavedQuoteId = null;

    const emptyBox = document.getElementById('pricing-file-empty');
    if (emptyBox) emptyBox.hidden = true;
    const block = document.getElementById('pricing-selected-file-block');
    if (block) block.hidden = false;
    const nameEl = document.getElementById('pricing-selected-file-name');
    if (nameEl) nameEl.textContent = file.name;
    const subEl = document.getElementById('pricing-selected-file-sub');
    if (subEl) subEl.textContent = `${(file.extension || '').replace('.', '').toUpperCase()} · ${formatSize(file.size)}`;

    const thumb = document.getElementById('pricing-selected-file-thumb');
    if (thumb) {
        if (isGcodeFile(file) && pricingJobType === 'cnc') {
            // CNC usa su propio parser (ver comentario en
            // renderCncGcodeThumbnail) — el genérico de abajo interpreta mal
            // el S de RPM de husillo como si fuera potencia de láser.
            renderCncGcodeThumbnail(thumb, file.file_url);
        } else if (isGcodeFile(file)) {
            const relPath = stripSectionPrefix(file.id, pricingSection());
            loadRealGcodeThumbnail(thumb, relPath, pricingSection(), file.file_url);
        } else {
            // STL/3MF/OBJ sin laminar — el visor de trayectoria de G-code no
            // sabe leer esto (antes lo intentaba igual y mostraba el texto
            // de relleno "G-code" en un cuadro vacío). Mismo renderer 3D que
            // ya usa la galería de Modelos para esta misma familia de
            // archivos.
            thumb.innerHTML = '';
            renderStandardModelPreview(thumb, file.file_url);
        }
    }

    updatePricingBreadcrumbState();
    schedulePricingQuoteRefresh();
}

function addPricingExtraCostRow() {
    pricingExtraCosts.push({ label: '', amount: 0, category: 'consumable' });
    renderPricingExtraCosts();
    schedulePricingQuoteRefresh();
}

function removePricingExtraCostRow(index) {
    pricingExtraCosts.splice(index, 1);
    renderPricingExtraCosts();
    schedulePricingQuoteRefresh();
}

function renderPricingExtraCosts() {
    const container = document.getElementById('pricing-extra-costs-list');
    if (!container) return;
    if (!pricingExtraCosts.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = pricingExtraCosts.map((cost, index) => `
        <div class="pricing-extra-cost-row" data-index="${index}">
            <input type="text" class="pricing-extra-cost-label" placeholder="${escapeHtml(t('pricingCostLabelPlaceholder'))}" value="${escapeHtml(cost.label)}">
            <input type="number" class="pricing-extra-cost-amount" min="0" step="0.01" value="${cost.amount}">
            <select class="pricing-extra-cost-category">
                <option value="consumable"${cost.category === 'consumable' ? ' selected' : ''}>${escapeHtml(t('pricingCategoryConsumable'))}</option>
                <option value="additional"${cost.category === 'additional' ? ' selected' : ''}>${escapeHtml(t('pricingCategoryAdditional'))}</option>
            </select>
            <button type="button" class="pricing-extra-cost-remove-btn" title="${escapeHtml(t('pricingRemoveCost'))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.pricing-extra-cost-row').forEach(row => {
        const index = parseInt(row.dataset.index, 10);
        row.querySelector('.pricing-extra-cost-label').addEventListener('input', (e) => {
            pricingExtraCosts[index].label = e.target.value;
            pricingLastSavedQuoteId = null;
            schedulePricingQuoteRefresh();
        });
        row.querySelector('.pricing-extra-cost-amount').addEventListener('input', (e) => {
            pricingExtraCosts[index].amount = parseFloat(e.target.value) || 0;
            pricingLastSavedQuoteId = null;
            schedulePricingQuoteRefresh();
        });
        row.querySelector('.pricing-extra-cost-category').addEventListener('change', (e) => {
            pricingExtraCosts[index].category = e.target.value;
            pricingLastSavedQuoteId = null;
            schedulePricingQuoteRefresh();
        });
        row.querySelector('.pricing-extra-cost-remove-btn').addEventListener('click', () => removePricingExtraCostRow(index));
    });
}

function schedulePricingQuoteRefresh() {
    clearTimeout(pricingQuoteRequestTimer);
    pricingQuoteRequestTimer = setTimeout(refreshPricingQuote, 400);
}

async function refreshPricingQuote() {
    if (!pricingSelectedFile) {
        renderPricingCostSummary(null);
        renderPricingFileInfo(null);
        renderPricingAdditionalInfo(null);
        return;
    }
    const materialSelect = document.getElementById('pricing-material-select');
    const materialId = materialSelect ? materialSelect.value : '';
    if (!materialId) {
        renderPricingCostSummary(null);
        return;
    }
    const machineId = document.getElementById('pricing-machine-select')?.value || '';
    const quantity = parseFloat(document.getElementById('pricing-quantity-input')?.value) || 1;
    const relPath = stripSectionPrefix(pricingSelectedFile.id, pricingSection());
    const validExtraCosts = pricingExtraCosts.filter(c => c.label && c.amount);
    const detailLevel = document.querySelector('#pricing-detail-level-switch .option-switch-btn.active')?.dataset.value || 'standard';

    const formData = new FormData();
    formData.append('path', relPath);
    formData.append('section', pricingSection());
    formData.append('material_id', materialId);
    formData.append('quantity', quantity);
    if (machineId) formData.append('machine_id', machineId);
    formData.append('extra_costs', JSON.stringify(validExtraCosts));
    formData.append('overrides', JSON.stringify({ detail_level: detailLevel }));

    try {
        const response = await fetch('/api/pricing/quote', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo calcular la cotización.');
        }
        const result = await response.json();
        pricingLastQuoteResult = result;
        pricingLastSavedQuoteId = null;
        pricingQuoteDate = new Date();
        renderPricingCostSummary(result);
        renderPricingFileInfo(result);
        renderPricingAdditionalInfo(result);
        updatePricingBreadcrumbState();
    } catch (error) {
        console.error(error);
        pricingLastQuoteResult = null;
        renderPricingCostSummary(null, error.message);
        updatePricingBreadcrumbState();
    }
}

function renderPricingCostSummary(result, errorMessage) {
    const linesContainer = document.getElementById('pricing-cost-lines');
    const subtotalRow = document.getElementById('pricing-cost-subtotal-row');
    const marginRow = document.getElementById('pricing-cost-margin-row');
    const totalRow = document.getElementById('pricing-cost-total-row');
    const saveBtn = document.getElementById('pricing-save-btn');
    if (!linesContainer) return;

    if (!result) {
        linesContainer.innerHTML = `<div class="empty-state-small">${errorMessage ? escapeHtml(errorMessage) : escapeHtml(t('pricingSummaryEmpty'))}</div>`;
        if (subtotalRow) subtotalRow.hidden = true;
        if (marginRow) marginRow.hidden = true;
        if (totalRow) totalRow.hidden = true;
        if (saveBtn) saveBtn.disabled = true;
        updatePricingSaveGatedButtons();
        return;
    }

    // El selector de moneda/tipo de cambio es solo de presentación: multiplica
    // lo que ya calculó el backend para mostrarlo en otra moneda, pero NUNCA
    // se manda al guardar — la cotización persistida siempre queda en la
    // moneda base (result.costs.currency), para no inventar una tasa de
    // conversión que nadie confirmó.
    const baseCurrency = result.costs.currency;
    const displayCurrency = document.getElementById('pricing-currency-select')?.value || baseCurrency;
    const rate = parseFloat(document.getElementById('pricing-exchange-rate-input')?.value) || 1;
    const fmt = (amount) => `${displayCurrency} ${(amount * rate).toFixed(2)}`;

    linesContainer.innerHTML = result.cost_lines.map((line, index) => `
        <div class="pricing-cost-line">
            <span class="pricing-cost-line-icon icon-${line.key}">${index + 1}</span>
            <span class="pricing-cost-line-body">
                <span>
                    <span class="pricing-cost-line-label">${escapeHtml(line.label)}</span>
                    ${line.detail ? `<span class="pricing-cost-line-detail">${escapeHtml(line.detail)}</span>` : ''}
                </span>
                <span class="pricing-cost-line-amount${line.missing ? ' missing' : ''}">${line.missing ? '—' : fmt(line.amount)}</span>
            </span>
        </div>
    `).join('');

    const subtotalAmountEl = document.getElementById('pricing-cost-subtotal-amount');
    if (subtotalAmountEl) subtotalAmountEl.textContent = fmt(result.costs.subtotal);
    const marginPillEl = document.getElementById('pricing-margin-pill');
    if (marginPillEl) marginPillEl.textContent = result.costs.margin_percentage != null ? `${result.costs.margin_percentage}%` : '';
    const marginAmountEl = document.getElementById('pricing-cost-margin-amount');
    if (marginAmountEl) marginAmountEl.textContent = fmt(result.costs.margin_cost);
    const totalAmountEl = document.getElementById('pricing-cost-total-amount');
    if (totalAmountEl) totalAmountEl.textContent = `${fmt(result.costs.total)}${result.costs.total_is_partial ? ' *' : ''}`;

    if (subtotalRow) subtotalRow.hidden = false;
    if (marginRow) marginRow.hidden = false;
    if (totalRow) totalRow.hidden = false;
    if (saveBtn) saveBtn.disabled = false;
    updatePricingSaveGatedButtons();
}

// Vista previa PDF / Enviar cotización solo tienen sentido sobre una
// cotización YA GUARDADA (necesitan un id real para /cotizador/print/{id}
// y /api/pricing/quotes/{id}/status) — se habilitan recién después de
// "Guardar cotización", con un tooltip explicando por qué mientras tanto.
function updatePricingSaveGatedButtons() {
    const printBtn = document.getElementById('pricing-print-btn');
    const sendBtn = document.getElementById('pricing-send-btn');
    const whatsappBtn = document.getElementById('pricing-whatsapp-btn');
    const enabled = !!pricingLastSavedQuoteId;
    [printBtn, sendBtn, whatsappBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = !enabled;
        btn.title = enabled ? '' : t('pricingSaveFirstHint');
    });
}

function renderPricingFileInfo(result) {
    const card = document.getElementById('pricing-file-info-card');
    const list = document.getElementById('pricing-file-info-list');
    const dimsEl = document.getElementById('pricing-selected-file-dims');
    if (!card || !list) return;
    if (!result) {
        card.hidden = true;
        if (dimsEl) dimsEl.hidden = true;
        return;
    }
    const e = result.extracted;
    const rows = [[t('pricingInfoJobType'), pricingJobTypeLabel(pricingJobType), 'pill']];
    if (e.estimated_time_minutes != null) rows.push([t('pricingInfoTime'), _formatMinutes(e.estimated_time_minutes)]);
    if (e.filament_g != null) rows.push([t('pricingInfoWeight'), `${e.filament_g.toFixed(2)} g`]);
    if (e.cut_length_mm != null) rows.push([t('pricingInfoCutLength'), `${(e.cut_length_mm / 1000).toFixed(2)} m`]);
    if (e.bounding_box_area_m2 != null) rows.push([t('pricingInfoArea'), `${e.bounding_box_area_m2.toFixed(3)} m²`]);

    list.innerHTML = rows.map(([label, value, kind]) => `
        <div class="pricing-info-row">
            <span>${escapeHtml(label)}</span>
            ${kind === 'pill' ? `<span class="device-status-pill on">${escapeHtml(value)}</span>` : `<strong>${escapeHtml(value)}</strong>`}
        </div>
    `).join('');
    card.hidden = false;

    // Ancho/Alto: solo si el bounding box real vino de G-code parseado (no
    // hay forma honesta de saberlo para un STL/3MF sin laminar todavía).
    if (dimsEl) {
        if (e.width_mm != null && e.height_mm != null) {
            dimsEl.innerHTML = `
                <span>${escapeHtml(t('pricingDimsWidth'))} <strong>${e.width_mm.toFixed(1)} mm</strong></span>
                <span>${escapeHtml(t('pricingDimsHeight'))} <strong>${e.height_mm.toFixed(1)} mm</strong></span>
            `;
            dimsEl.hidden = false;
        } else {
            dimsEl.hidden = true;
        }
    }
}

function renderPricingAdditionalInfo(result) {
    const totalTimeEl = document.getElementById('pricing-info-total-time');
    const dateEl = document.getElementById('pricing-info-quote-date');
    const idEl = document.getElementById('pricing-info-quote-id');
    const copyBtn = document.getElementById('pricing-copy-id-btn');

    if (totalTimeEl) totalTimeEl.textContent = result && result.total_time_minutes != null ? _formatMinutes(result.total_time_minutes) : '—';
    if (dateEl) dateEl.textContent = pricingQuoteDate ? pricingQuoteDate.toLocaleString() : '—';
    if (idEl) idEl.textContent = pricingLastSavedQuoteId || '—';
    if (copyBtn) copyBtn.hidden = !pricingLastSavedQuoteId;
}

async function savePricingQuote() {
    if (!pricingLastQuoteResult) return;
    const saveBtn = document.getElementById('pricing-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
        const detailLevel = document.querySelector('#pricing-detail-level-switch .option-switch-btn.active')?.dataset.value || 'standard';
        const quotePayload = {
            ...pricingLastQuoteResult,
            job_type: pricingJobType,
            color: document.getElementById('pricing-color-select')?.value || null,
            detail_level: detailLevel,
            valid_until: document.getElementById('pricing-valid-until-input')?.value || null,
            notes: document.getElementById('pricing-notes-input')?.value.trim() || null,
            client_name: document.getElementById('pricing-client-name-input')?.value.trim() || null,
            client_phone: document.getElementById('pricing-client-phone-input')?.value.trim() || null,
        };
        const formData = new FormData();
        formData.append('quote', JSON.stringify(quotePayload));
        const response = await fetch('/api/pricing/quotes', { method: 'POST', body: formData });
        if (!response.ok) throw new Error(t('pricingSaveError'));
        const saved = await response.json();
        pricingLastSavedQuoteId = saved.id;
        showToast(`${t('pricingQuoteSaved')}: ${saved.id}`);
        updatePricingSaveGatedButtons();
        renderPricingAdditionalInfo(pricingLastQuoteResult);
        loadPricingQuotesHistory();
    } catch (error) {
        console.error(error);
        appAlert(error.message || t('pricingSaveError'), '', 'danger');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

function openPricingPrintPreview(quoteId) {
    const id = quoteId || pricingLastSavedQuoteId;
    if (!id) return;
    window.open(`/cotizador/print/${encodeURIComponent(id)}`, '_blank');
}

async function sendPricingQuoteAction(quoteId) {
    const id = quoteId || pricingLastSavedQuoteId;
    if (!id) return;
    try {
        const formData = new FormData();
        formData.append('status', 'sent');
        const response = await fetch(`/api/pricing/quotes/${encodeURIComponent(id)}/status`, { method: 'POST', body: formData });
        if (!response.ok) throw new Error(t('pricingSendError'));
        showToast(t('pricingQuoteSent'));
        loadPricingQuotesHistory();
    } catch (error) {
        console.error(error);
        appAlert(error.message || t('pricingSendError'), '', 'danger');
    }
}

async function openPricingWhatsappModal(quoteId) {
    const id = quoteId || pricingLastSavedQuoteId;
    if (!id) return;
    try {
        const response = await fetch(`/api/pricing/quotes/${encodeURIComponent(id)}/whatsapp-link`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('pricingWhatsappError'));
        }
        const data = await response.json();
        pricingWhatsappQuoteId = id;
        const textarea = document.getElementById('pricing-whatsapp-message-input');
        if (textarea) textarea.value = data.message || '';
        const modal = document.getElementById('pricing-whatsapp-modal');
        if (modal) modal.classList.add('active');
        if (textarea) textarea.focus();
    } catch (error) {
        console.error(error);
        appAlert(error.message || t('pricingWhatsappError'), '', 'danger');
    }
}

function closePricingWhatsappModal() {
    const modal = document.getElementById('pricing-whatsapp-modal');
    if (modal) modal.classList.remove('active');
    pricingWhatsappQuoteId = null;
}

async function confirmPricingWhatsappSend() {
    const id = pricingWhatsappQuoteId;
    if (!id) return;
    const textarea = document.getElementById('pricing-whatsapp-message-input');
    const message = textarea ? textarea.value : '';
    try {
        const response = await fetch(`/api/pricing/quotes/${encodeURIComponent(id)}/whatsapp-link?message=${encodeURIComponent(message)}`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('pricingWhatsappError'));
        }
        const data = await response.json();
        closePricingWhatsappModal();
        window.open(data.url, '_blank');
    } catch (error) {
        console.error(error);
        appAlert(error.message || t('pricingWhatsappError'), '', 'danger');
    }
}

async function loadPricingQuotesHistory() {
    try {
        const response = await fetch('/api/pricing/quotes');
        if (!response.ok) throw new Error('No se pudo cargar el historial');
        const data = await response.json();
        renderPricingQuotesTable(data.quotes || []);
    } catch (error) {
        console.error(error);
        renderPricingQuotesTable([]);
    }
}

function renderPricingQuotesTable(quotes) {
    const tbody = document.getElementById('pricing-quotes-tbody');
    if (!tbody) return;
    if (!quotes.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(t('pricingNoQuotes'))}</td></tr>`;
        return;
    }

    tbody.innerHTML = quotes.map(quote => {
        const date = quote.created_at ? new Date(quote.created_at * 1000).toLocaleString() : '—';
        const total = quote.costs ? `${quote.costs.currency} ${quote.costs.total.toFixed(2)}` : '—';
        const status = quote.status || 'draft';
        const statusKey = `pricingStatus_${status}`;
        const statusLabel = t(statusKey) !== statusKey ? t(statusKey) : status;
        const jobTypeLabel = quote.job_type ? pricingJobTypeLabel(quote.job_type) : '—';
        return `
            <tr>
                <td>${escapeHtml(quote.id)}</td>
                <td class="pricing-quote-file-cell">
                    <span class="pricing-quote-file-name">${escapeHtml(quote.file?.name || '—')}</span>
                    <span class="pricing-quote-material-name">${escapeHtml(quote.material?.name || '')}</span>
                </td>
                <td>${escapeHtml(jobTypeLabel)}</td>
                <td>${escapeHtml(total)}</td>
                <td>${escapeHtml(date)}</td>
                <td><span class="device-status-pill ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span></td>
                <td class="pricing-quote-row-actions">
                    <button type="button" class="pricing-quote-print-btn" data-id="${escapeHtml(quote.id)}" title="${escapeHtml(t('pricingPrintPreview'))}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('.pricing-quote-print-btn').forEach(btn => {
        btn.addEventListener('click', () => openPricingPrintPreview(btn.dataset.id));
    });
}

// ── Cotizador > Catálogos (materiales/máquinas/ajustes) ──

let pricingMaterialEditingId = null;
let pricingMachineEditingId = null;

function openPricingCatalogsModal() {
    switchPricingCatalogsTab('materials');
    resetPricingMaterialForm();
    resetPricingMachineForm();
    loadPricingMaterialsCatalog();
    loadPricingMachinesCatalog();
    loadPricingMachineImportOptions();
    loadPricingCatalogsSettingsForm();
    document.getElementById('pricing-catalogs-modal')?.classList.add('active');
}

function closePricingCatalogsModal() {
    document.getElementById('pricing-catalogs-modal')?.classList.remove('active');
}

function switchPricingCatalogsTab(tab) {
    document.querySelectorAll('#pricing-catalogs-tab-switch .option-switch-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === tab);
    });
    document.querySelectorAll('.pricing-catalogs-tab').forEach(panel => {
        panel.hidden = panel.id !== `pricing-catalogs-tab-${tab}`;
    });
}

document.getElementById('pricing-manage-catalogs-btn')?.addEventListener('click', () => {
    closeAllTopbarDropdowns();
    openPricingCatalogsModal();
});
document.getElementById('pricing-catalogs-modal-close')?.addEventListener('click', closePricingCatalogsModal);
document.getElementById('pricing-catalogs-modal-backdrop')?.addEventListener('click', closePricingCatalogsModal);
document.querySelectorAll('#pricing-catalogs-tab-switch .option-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPricingCatalogsTab(btn.dataset.value));
});

// ── Materiales ──

function pricingMaterialKindLabel(kind) {
    if (kind === 'filament') return t('pricingMaterialKindFilament');
    if (kind === 'sheet') return t('pricingMaterialKindSheet');
    return t('pricingMaterialKindConsumable');
}

function updatePricingMaterialUnitOptions(kind) {
    const select = document.getElementById('material-add-unit-select');
    if (!select) return;
    const prevValue = select.value;
    if (kind === 'filament') {
        select.innerHTML = '<option value="kg">kg</option><option value="g">g</option>';
        select.disabled = false;
    } else if (kind === 'sheet') {
        select.innerHTML = '<option value="m2">m2</option>';
        select.disabled = true;
    } else {
        select.innerHTML = '<option value="pieza">pieza</option><option value="servicio">servicio</option><option value="unidad">unidad</option>';
        select.disabled = false;
    }
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;
}

const materialAddKindSwitch = createOptionSwitch('material-add-kind-switch', (kind) => {
    updatePricingMaterialUnitOptions(kind);
    const filamentExtra = document.getElementById('material-add-extra-filament');
    const sheetExtra = document.getElementById('material-add-extra-sheet');
    if (filamentExtra) filamentExtra.hidden = kind !== 'filament';
    if (sheetExtra) sheetExtra.hidden = kind !== 'sheet';
});
materialAddKindSwitch.setValue('filament');
updatePricingMaterialUnitOptions('filament');

function resetPricingMaterialForm() {
    pricingMaterialEditingId = null;
    const nameInput = document.getElementById('material-add-name-input');
    if (nameInput) nameInput.value = '';
    const unitCostInput = document.getElementById('material-add-unit-cost-input');
    if (unitCostInput) unitCostInput.value = '';
    const densityInput = document.getElementById('material-add-density-input');
    if (densityInput) densityInput.value = '1.24';
    const diameterInput = document.getElementById('material-add-diameter-input');
    if (diameterInput) diameterInput.value = '1.75';
    const thicknessInput = document.getElementById('material-add-thickness-input');
    if (thicknessInput) thicknessInput.value = '';
    materialAddKindSwitch.setValue('filament');
    updatePricingMaterialUnitOptions('filament');
    const filamentExtra = document.getElementById('material-add-extra-filament');
    if (filamentExtra) filamentExtra.hidden = false;
    const sheetExtra = document.getElementById('material-add-extra-sheet');
    if (sheetExtra) sheetExtra.hidden = true;
    const errorEl = document.getElementById('material-add-error');
    if (errorEl) errorEl.hidden = true;
    const addBtn = document.getElementById('material-add-btn');
    if (addBtn) addBtn.querySelector('span').textContent = t('pricingMaterialAddAction');
    const cancelBtn = document.getElementById('material-add-cancel-edit-btn');
    if (cancelBtn) cancelBtn.hidden = true;
}

function fillPricingMaterialForm(material) {
    pricingMaterialEditingId = material.id;
    document.getElementById('material-add-name-input').value = material.name;
    materialAddKindSwitch.setValue(material.kind);
    updatePricingMaterialUnitOptions(material.kind);
    document.getElementById('material-add-extra-filament').hidden = material.kind !== 'filament';
    document.getElementById('material-add-extra-sheet').hidden = material.kind !== 'sheet';
    document.getElementById('material-add-unit-cost-input').value = material.unit_cost;
    const unitSelect = document.getElementById('material-add-unit-select');
    if (unitSelect && material.unit && Array.from(unitSelect.options).some(o => o.value === material.unit)) {
        unitSelect.value = material.unit;
    }
    if (material.kind === 'filament') {
        document.getElementById('material-add-density-input').value = material.density_g_cm3 ?? 1.24;
        document.getElementById('material-add-diameter-input').value = material.diameter_mm ?? 1.75;
    } else if (material.kind === 'sheet') {
        document.getElementById('material-add-thickness-input').value = material.thickness_mm ?? '';
    }
    const addBtn = document.getElementById('material-add-btn');
    if (addBtn) addBtn.querySelector('span').textContent = t('pricingMaterialSaveChangesAction');
    const cancelBtn = document.getElementById('material-add-cancel-edit-btn');
    if (cancelBtn) cancelBtn.hidden = false;
}

async function loadPricingMaterialsCatalog() {
    try {
        const response = await fetch('/api/pricing/materials');
        if (!response.ok) throw new Error();
        const data = await response.json();
        renderPricingMaterialsCatalogList(data.materials || []);
    } catch (error) {
        console.error(error);
        renderPricingMaterialsCatalogList([]);
    }
}

function renderPricingMaterialsCatalogList(materials) {
    const container = document.getElementById('pricing-materials-catalog-list');
    if (!container) return;
    if (!materials.length) {
        container.innerHTML = `<div class="empty-state-small">${escapeHtml(t('pricingMaterialCatalogEmpty'))}</div>`;
        return;
    }
    container.innerHTML = materials.map(material => `
        <div class="usb-port-item" data-id="${escapeHtml(material.id)}">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(material.name)}</strong>
                <span>${escapeHtml(pricingMaterialKindLabel(material.kind))} · ${material.unit_cost}/${escapeHtml(material.unit || '')}</span>
            </div>
            <div class="pricing-catalog-item-actions">
                <button type="button" class="theme-option-icon-btn material-edit-btn" data-id="${escapeHtml(material.id)}" title="${escapeHtml(t('pricingMaterialEditTitle'))}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger material-remove-btn" data-id="${escapeHtml(material.id)}" title="${escapeHtml(t('pricingMaterialRemove'))}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.material-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const material = materials.find(m => m.id === btn.dataset.id);
            if (material) fillPricingMaterialForm(material);
        });
    });
    container.querySelectorAll('.material-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removePricingMaterialCatalogEntry(btn.dataset.id));
    });
}

async function submitPricingMaterialForm() {
    const name = document.getElementById('material-add-name-input')?.value.trim() || '';
    const kind = materialAddKindSwitch.getValue() || 'filament';
    const unitCost = parseFloat(document.getElementById('material-add-unit-cost-input')?.value);
    const unit = document.getElementById('material-add-unit-select')?.value || '';
    const errorEl = document.getElementById('material-add-error');
    if (errorEl) errorEl.hidden = true;

    if (!name || isNaN(unitCost)) {
        if (errorEl) {
            errorEl.textContent = t('pricingMaterialNameRequired');
            errorEl.hidden = false;
        }
        return;
    }

    let config = {};
    if (kind === 'filament') {
        config = {
            density_g_cm3: parseFloat(document.getElementById('material-add-density-input')?.value) || 1.24,
            diameter_mm: parseFloat(document.getElementById('material-add-diameter-input')?.value) || 1.75,
        };
    } else if (kind === 'sheet') {
        const thickness = parseFloat(document.getElementById('material-add-thickness-input')?.value);
        if (!isNaN(thickness)) config = { thickness_mm: thickness };
    }

    try {
        const formData = new FormData();
        formData.append('name', name);
        formData.append('kind', kind);
        formData.append('unit_cost', unitCost);
        formData.append('unit', unit);
        formData.append('config', JSON.stringify(config));
        if (pricingMaterialEditingId) formData.append('id', pricingMaterialEditingId);

        const response = await fetch('/api/pricing/materials', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('pricingMaterialSaveError'));
        }
        showToast(t(pricingMaterialEditingId ? 'pricingMaterialUpdatedToast' : 'pricingMaterialAddedToast'));
        resetPricingMaterialForm();
        loadPricingMaterialsCatalog();
        loadPricingCatalogs();
    } catch (error) {
        console.error(error);
        if (errorEl) {
            errorEl.textContent = error.message || t('pricingMaterialSaveError');
            errorEl.hidden = false;
        }
    }
}

async function removePricingMaterialCatalogEntry(id) {
    if (!(await appConfirm(t('pricingMaterialRemoveConfirm'), t('pricingMaterialRemove')))) return;
    try {
        const formData = new FormData();
        formData.append('id', id);
        const response = await fetch('/api/pricing/materials/remove', { method: 'POST', body: formData });
        if (!response.ok) throw new Error();
        if (pricingMaterialEditingId === id) resetPricingMaterialForm();
        loadPricingMaterialsCatalog();
        loadPricingCatalogs();
    } catch (error) {
        console.error(error);
        appAlert(t('pricingMaterialSaveError'), '', 'danger');
    }
}

document.getElementById('material-add-btn')?.addEventListener('click', submitPricingMaterialForm);
document.getElementById('material-add-cancel-edit-btn')?.addEventListener('click', resetPricingMaterialForm);

// ── Máquinas ──

const machineAddKindSwitch = createOptionSwitch('machine-add-kind-switch', () => {});
machineAddKindSwitch.setValue('printer');

function pricingMachineKindLabel(kind) {
    if (kind === 'printer') return t('pricingMachineKindPrinter');
    if (kind === 'laser') return t('pricingMachineKindLaser');
    return t('pricingMachineKindCnc');
}

function resetPricingMachineForm() {
    pricingMachineEditingId = null;
    const nameInput = document.getElementById('machine-add-name-input');
    if (nameInput) nameInput.value = '';
    const wattsInput = document.getElementById('machine-add-watts-input');
    if (wattsInput) wattsInput.value = '';
    const rateInput = document.getElementById('machine-add-rate-input');
    if (rateInput) rateInput.value = '';
    machineAddKindSwitch.setValue('printer');
    const errorEl = document.getElementById('machine-add-error');
    if (errorEl) errorEl.hidden = true;
    const addBtn = document.getElementById('machine-add-btn');
    if (addBtn) addBtn.querySelector('span').textContent = t('pricingMachineAddAction');
    const cancelBtn = document.getElementById('machine-add-cancel-edit-btn');
    if (cancelBtn) cancelBtn.hidden = true;
    const importSelect = document.getElementById('machine-import-device-select');
    if (importSelect) importSelect.selectedIndex = 0;
}

function fillPricingMachineForm(machine) {
    pricingMachineEditingId = machine.id;
    document.getElementById('machine-add-name-input').value = machine.name;
    machineAddKindSwitch.setValue(machine.kind);
    document.getElementById('machine-add-watts-input').value = machine.watts;
    document.getElementById('machine-add-rate-input').value = machine.rate_per_hour;
    const addBtn = document.getElementById('machine-add-btn');
    if (addBtn) addBtn.querySelector('span').textContent = t('pricingMachineSaveChangesAction');
    const cancelBtn = document.getElementById('machine-add-cancel-edit-btn');
    if (cancelBtn) cancelBtn.hidden = false;
}

async function loadPricingMachinesCatalog() {
    try {
        const response = await fetch('/api/pricing/machines');
        if (!response.ok) throw new Error();
        const data = await response.json();
        renderPricingMachinesCatalogList(data.machines || []);
    } catch (error) {
        console.error(error);
        renderPricingMachinesCatalogList([]);
    }
}

function renderPricingMachinesCatalogList(machines) {
    const container = document.getElementById('pricing-machines-catalog-list');
    if (!container) return;
    if (!machines.length) {
        container.innerHTML = `<div class="empty-state-small">${escapeHtml(t('pricingMachineCatalogEmpty'))}</div>`;
        return;
    }
    container.innerHTML = machines.map(machine => `
        <div class="usb-port-item" data-id="${escapeHtml(machine.id)}">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(machine.name)}</strong>
                <span>${escapeHtml(pricingMachineKindLabel(machine.kind))} · ${machine.watts}W · $${machine.rate_per_hour}/h</span>
            </div>
            <div class="pricing-catalog-item-actions">
                <button type="button" class="theme-option-icon-btn machine-edit-btn" data-id="${escapeHtml(machine.id)}" title="${escapeHtml(t('pricingMachineEditTitle'))}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger machine-remove-btn" data-id="${escapeHtml(machine.id)}" title="${escapeHtml(t('pricingMachineRemove'))}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.machine-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const machine = machines.find(m => m.id === btn.dataset.id);
            if (machine) fillPricingMachineForm(machine);
        });
    });
    container.querySelectorAll('.machine-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removePricingMachineCatalogEntry(btn.dataset.id));
    });
}

async function submitPricingMachineForm() {
    const name = document.getElementById('machine-add-name-input')?.value.trim() || '';
    const kind = machineAddKindSwitch.getValue() || 'printer';
    const watts = parseFloat(document.getElementById('machine-add-watts-input')?.value);
    const ratePerHour = parseFloat(document.getElementById('machine-add-rate-input')?.value);
    const errorEl = document.getElementById('machine-add-error');
    if (errorEl) errorEl.hidden = true;

    if (!name || isNaN(watts) || isNaN(ratePerHour)) {
        if (errorEl) {
            errorEl.textContent = t('pricingMachineNameRequired');
            errorEl.hidden = false;
        }
        return;
    }

    try {
        const formData = new FormData();
        formData.append('name', name);
        formData.append('kind', kind);
        formData.append('watts', watts);
        formData.append('rate_per_hour', ratePerHour);
        if (pricingMachineEditingId) formData.append('id', pricingMachineEditingId);

        const response = await fetch('/api/pricing/machines', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('pricingMachineSaveError'));
        }
        showToast(t(pricingMachineEditingId ? 'pricingMachineUpdatedToast' : 'pricingMachineAddedToast'));
        resetPricingMachineForm();
        loadPricingMachinesCatalog();
        loadPricingCatalogs();
    } catch (error) {
        console.error(error);
        if (errorEl) {
            errorEl.textContent = error.message || t('pricingMachineSaveError');
            errorEl.hidden = false;
        }
    }
}

async function removePricingMachineCatalogEntry(id) {
    if (!(await appConfirm(t('pricingMachineRemoveConfirm'), t('pricingMachineRemove')))) return;
    try {
        const formData = new FormData();
        formData.append('id', id);
        const response = await fetch('/api/pricing/machines/remove', { method: 'POST', body: formData });
        if (!response.ok) throw new Error();
        if (pricingMachineEditingId === id) resetPricingMachineForm();
        loadPricingMachinesCatalog();
        loadPricingCatalogs();
    } catch (error) {
        console.error(error);
        appAlert(t('pricingMachineSaveError'), '', 'danger');
    }
}

document.getElementById('machine-add-btn')?.addEventListener('click', submitPricingMachineForm);
document.getElementById('machine-add-cancel-edit-btn')?.addEventListener('click', resetPricingMachineForm);

async function loadPricingMachineImportOptions() {
    const select = document.getElementById('machine-import-device-select');
    if (!select) return;
    let devices = [];
    try {
        const [printersRes, lasersRes] = await Promise.all([
            fetch('/api/printers'),
            fetch('/api/laser/registry'),
        ]);
        const printers = printersRes.ok ? (await printersRes.json()).printers || [] : [];
        const registryDevices = lasersRes.ok ? (await lasersRes.json()).lasers || [] : [];
        devices = [
            ...printers.map(p => ({ name: p.name, kind: 'printer' })),
            ...registryDevices.map(d => ({ name: d.name, kind: d.kind === 'cnc' ? 'cnc' : 'laser' })),
        ];
    } catch (error) {
        console.error(error);
    }

    if (!devices.length) {
        select.innerHTML = `<option value="" disabled selected>${escapeHtml(t('pricingMachineImportNoneFound'))}</option>`;
        return;
    }

    select.innerHTML = `<option value="" disabled selected>${escapeHtml(t('pricingMachineImportPlaceholder'))}</option>` +
        devices.map((device, index) => `<option value="${index}" data-name="${escapeHtml(device.name)}" data-kind="${escapeHtml(device.kind)}">${escapeHtml(device.name)} (${escapeHtml(pricingMachineKindLabel(device.kind))})</option>`).join('');
}

document.getElementById('machine-import-device-select')?.addEventListener('change', (e) => {
    const option = e.target.selectedOptions[0];
    if (!option || !option.dataset.name) return;
    document.getElementById('machine-add-name-input').value = option.dataset.name;
    machineAddKindSwitch.setValue(option.dataset.kind);
});

// ── Ajustes globales ──

const settingsMarginModeSwitch = createOptionSwitch('settings-margin-mode-switch', (mode) => {
    document.getElementById('settings-margin-percentage-field').hidden = mode !== 'percentage';
    document.getElementById('settings-margin-flat-field').hidden = mode !== 'flat_amount';
});
settingsMarginModeSwitch.setValue('percentage');

async function loadPricingCatalogsSettingsForm() {
    try {
        const response = await fetch('/api/pricing/settings');
        if (!response.ok) throw new Error();
        const settings = await response.json();
        document.getElementById('settings-currency-select').value = settings.currency || 'MXN';
        document.getElementById('settings-price-kwh-input').value = settings.price_per_kwh ?? '';
        document.getElementById('settings-labor-rate-input').value = settings.labor_rate_per_hour ?? '';
        document.getElementById('settings-prep-minutes-input').value = settings.default_prep_minutes ?? '';
        const mode = settings.margin?.mode || 'percentage';
        settingsMarginModeSwitch.setValue(mode);
        document.getElementById('settings-margin-percentage-field').hidden = mode !== 'percentage';
        document.getElementById('settings-margin-flat-field').hidden = mode !== 'flat_amount';
        document.getElementById('settings-margin-percentage-input').value = settings.margin?.percentage ?? '';
        document.getElementById('settings-margin-flat-input').value = settings.margin?.flat_amount ?? '';
    } catch (error) {
        console.error(error);
    }
}

async function submitPricingCatalogsSettingsForm() {
    const errorEl = document.getElementById('settings-save-error');
    if (errorEl) errorEl.hidden = true;
    try {
        const mode = settingsMarginModeSwitch.getValue() || 'percentage';
        const margin = {
            mode,
            percentage: parseFloat(document.getElementById('settings-margin-percentage-input')?.value) || 0,
            flat_amount: parseFloat(document.getElementById('settings-margin-flat-input')?.value) || 0,
        };
        const formData = new FormData();
        formData.append('currency', document.getElementById('settings-currency-select')?.value || 'MXN');
        formData.append('price_per_kwh', document.getElementById('settings-price-kwh-input')?.value || '0');
        formData.append('labor_rate_per_hour', document.getElementById('settings-labor-rate-input')?.value || '0');
        formData.append('default_prep_minutes', document.getElementById('settings-prep-minutes-input')?.value || '0');
        formData.append('margin', JSON.stringify(margin));

        const response = await fetch('/api/pricing/settings', { method: 'POST', body: formData });
        if (!response.ok) throw new Error();
        showToast(t('pricingSettingsSavedToast'));
        schedulePricingQuoteRefresh();
    } catch (error) {
        console.error(error);
        if (errorEl) {
            errorEl.textContent = t('pricingSettingsSaveError');
            errorEl.hidden = false;
        }
    }
}

document.getElementById('settings-save-btn-catalogs')?.addEventListener('click', submitPricingCatalogsSettingsForm);

// ── Configuración > Usuarios ──

async function loadUsersSettings() {
    const card = document.getElementById('users-settings-card');
    if (!card) return;
    if (!currentAuthUser || currentAuthUser.role !== 'admin') {
        card.hidden = true;
        return;
    }
    card.hidden = false;
    try {
        const response = await fetch('/api/auth/users');
        if (!response.ok) throw new Error('No se pudo cargar la lista de usuarios');
        const data = await response.json();
        renderUsersList(data.users || []);
    } catch (error) {
        console.error(error);
        renderUsersList([]);
    }
}

function renderUsersList(users) {
    const container = document.getElementById('users-list');
    if (!container) return;
    if (!users.length) {
        container.innerHTML = `<div class="empty-state-small">${escapeHtml(t('usersEmpty'))}</div>`;
        return;
    }

    container.innerHTML = users.map(user => `
        <div class="usb-port-item" data-id="${escapeHtml(user.id)}">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(user.username)}</strong>
                <span>${user.created_at ? new Date(user.created_at * 1000).toLocaleDateString() : ''}</span>
            </div>
            <select class="user-item-role-select" data-id="${escapeHtml(user.id)}">
                <option value="operador"${user.role === 'operador' ? ' selected' : ''}>${escapeHtml(t('usersRoleOperator'))}</option>
                <option value="admin"${user.role === 'admin' ? ' selected' : ''}>${escapeHtml(t('usersRoleAdmin'))}</option>
            </select>
            <button type="button" class="theme-option-icon-btn user-reset-password-btn" data-id="${escapeHtml(user.id)}" title="${escapeHtml(t('usersResetPassword'))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger user-remove-btn" data-id="${escapeHtml(user.id)}" title="${escapeHtml(t('usersRemove'))}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.user-item-role-select').forEach(select => {
        select.addEventListener('change', async () => {
            try {
                const formData = new FormData();
                formData.append('user_id', select.dataset.id);
                formData.append('role', select.value);
                const response = await fetch('/api/auth/users/update', { method: 'POST', body: formData });
                if (!response.ok) throw new Error();
                showToast(t('usersUpdated'));
            } catch (error) {
                console.error(error);
                appAlert(t('usersUpdateError'), '', 'danger');
                loadUsersSettings();
            }
        });
    });

    container.querySelectorAll('.user-reset-password-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const newPassword = prompt(t('usersResetPasswordPrompt'));
            if (!newPassword) return;
            try {
                const formData = new FormData();
                formData.append('user_id', btn.dataset.id);
                formData.append('new_password', newPassword);
                const response = await fetch('/api/auth/users/update', { method: 'POST', body: formData });
                if (!response.ok) throw new Error();
                showToast(t('usersPasswordReset'));
            } catch (error) {
                console.error(error);
                appAlert(t('usersUpdateError'), '', 'danger');
            }
        });
    });

    container.querySelectorAll('.user-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!(await appConfirm(t('usersRemoveConfirm'), t('usersRemove')))) return;
            try {
                const formData = new FormData();
                formData.append('user_id', btn.dataset.id);
                const response = await fetch('/api/auth/users/remove', { method: 'POST', body: formData });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.detail || t('usersUpdateError'));
                }
                loadUsersSettings();
            } catch (error) {
                console.error(error);
                appAlert(error.message || t('usersUpdateError'), '', 'danger');
            }
        });
    });
}

document.getElementById('user-add-btn')?.addEventListener('click', async () => {
    const usernameInput = document.getElementById('user-add-username-input');
    const passwordInput = document.getElementById('user-add-password-input');
    const username = usernameInput?.value.trim() || '';
    const password = passwordInput?.value || '';
    const role = document.querySelector('#user-add-role-switch .option-switch-btn.active')?.dataset.value || 'operador';
    const errorEl = document.getElementById('user-add-error');
    if (errorEl) errorEl.hidden = true;
    if (!username || !password) {
        if (errorEl) {
            errorEl.textContent = t('usersAddMissingFields');
            errorEl.hidden = false;
        }
        return;
    }
    try {
        const formData = new FormData();
        formData.append('username', username);
        formData.append('password', password);
        formData.append('role', role);
        const response = await fetch('/api/auth/users', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('usersAddError'));
        }
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
        showToast(t('usersAdded'));
        loadUsersSettings();
    } catch (error) {
        console.error(error);
        if (errorEl) {
            errorEl.textContent = error.message || t('usersAddError');
            errorEl.hidden = false;
        }
    }
});

document.querySelectorAll('#user-add-role-switch .option-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#user-add-role-switch .option-switch-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
});
