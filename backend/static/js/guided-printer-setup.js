// ── Asistente guiado de instalación de impresoras 3D (Bambu Lab/Elegoo/
// FlashForge) ── Wizard de 6 pasos sobre los endpoints ya existentes de cada
// marca (discover/list/register/test-connection, ver backend/api/*_printers.py
// y backend/services/*_service.py -- ninguno de esos archivos se toca acá).
// No reutiliza el patrón .cnc-wizard-* (backend/templates/index.html:4294,
// app.js:10868) porque el mockup aprobado pide un stepper más elaborado con
// 6 pasos, verificación real contra el registro atómico del backend y una
// matriz de capacidades por marca -- la mecánica de "un solo <div> visible
// por paso" es la misma idea, pero el resto del componente es propio.

const BRAND_CONFIG = {
    bambu: {
        displayName: 'Bambu Lab',
        statusBadge: 'compatible',
        descI18nKey: 'guidedSetupBrandBambuDesc',
        protocol: 'MQTT',
        connectI18nKey: 'guidedSetupCheckConnectingBambu',
        discoverEndpoint: '/api/bambu/printers/discover',
        listEndpoint: '/api/bambu/printers',
        registerEndpoint: '/api/bambu/printers',
        idField: 'serial',
        prepStepsI18nKeys: [
            'guidedSetupBambuPrep1', 'guidedSetupBambuPrep2', 'guidedSetupBambuPrep3',
            'guidedSetupBambuPrep4', 'guidedSetupBambuPrep5', 'guidedSetupBambuPrep6',
        ],
        fields: [
            { name: 'name', i18nLabel: 'guidedSetupFieldName', type: 'text', required: true },
            {
                name: 'model', i18nLabel: 'guidedSetupFieldModel', type: 'select', required: false,
                options: ['X1', 'X1 Carbon', 'X1E', 'P1P', 'P1S', 'P2S', 'A1', 'A1 Mini', 'other'],
            },
            { name: 'ip', i18nLabel: 'guidedSetupFieldIp', type: 'text', required: true },
            { name: 'serial', i18nLabel: 'guidedSetupFieldSerial', type: 'text', required: true },
            { name: 'access_code', i18nLabel: 'guidedSetupFieldAccessCode', type: 'password', required: true, secret: true },
        ],
        capabilities: {
            status: true, temperatures: true, progress: true, layers: true, pause: true, resume: true,
            cancel: true, upload: true, startPrint: true, camera: false, ams: false, filamentMapping: false,
            console: false, movement: false,
        },
    },
    elegoo: {
        displayName: 'Elegoo',
        statusBadge: 'compatible',
        descI18nKey: 'guidedSetupBrandElegooDesc',
        protocol: 'SDCP',
        connectI18nKey: 'guidedSetupCheckConnectingElegoo',
        discoverEndpoint: '/api/elegoo/printers/discover',
        listEndpoint: '/api/elegoo/printers',
        registerEndpoint: '/api/elegoo/printers',
        idField: 'mainboard_id',
        prepStepsI18nKeys: ['guidedSetupElegooPrep1', 'guidedSetupElegooPrep2', 'guidedSetupElegooPrep3', 'guidedSetupElegooPrep4'],
        fields: [
            { name: 'name', i18nLabel: 'guidedSetupFieldName', type: 'text', required: true },
            { name: 'model', i18nLabel: 'guidedSetupFieldModel', type: 'text', required: false },
            { name: 'ip', i18nLabel: 'guidedSetupFieldIp', type: 'text', required: true },
            { name: 'mainboard_id', i18nLabel: 'guidedSetupFieldMainboardId', type: 'text', required: true },
        ],
        capabilities: {
            status: true, temperatures: true, progress: true, layers: true, pause: true, resume: true,
            cancel: true, upload: true, startPrint: true, camera: false, ams: false, filamentMapping: false,
            console: false, movement: false,
        },
    },
    flashforge: {
        displayName: 'FlashForge',
        statusBadge: 'requires_lan',
        descI18nKey: 'guidedSetupBrandFlashforgeDesc',
        protocol: 'HTTP',
        connectI18nKey: 'guidedSetupCheckConnectingFlashforge',
        discoverEndpoint: '/api/flashforge/printers/discover',
        listEndpoint: '/api/flashforge/printers',
        registerEndpoint: '/api/flashforge/printers',
        idField: 'serial_number',
        prepStepsI18nKeys: ['guidedSetupFlashforgePrep1', 'guidedSetupFlashforgePrep2', 'guidedSetupFlashforgePrep3', 'guidedSetupFlashforgePrep4'],
        fields: [
            { name: 'name', i18nLabel: 'guidedSetupFieldName', type: 'text', required: true },
            { name: 'ip', i18nLabel: 'guidedSetupFieldIp', type: 'text', required: true },
            { name: 'serial_number', i18nLabel: 'guidedSetupFieldSerial', type: 'text', required: true },
            { name: 'check_code', i18nLabel: 'guidedSetupFieldCheckCode', type: 'password', required: true, secret: true },
        ],
        capabilities: {
            status: true, temperatures: true, progress: true, layers: true, pause: true, resume: true,
            cancel: true, upload: true, startPrint: true, camera: false, ams: false, filamentMapping: false,
            console: false, movement: false,
        },
    },
};

const GPS_BRAND_ICON_SVG = {
    bambu: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    elegoo: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    flashforge: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
};

// IP/identificador/candado -- mismo lenguaje visual lineal que el resto de
// index.html (ej. el candado ya se usa en #cnc-wizard-unlock-btn).
const GPS_WIFI_ICON = '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>';
const GPS_HASH_ICON = '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>';
const GPS_LOCK_ICON = '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
const GPS_CHECK_ICON = '<polyline points="20 6 9 17 4 12"/>';
const GPS_CROSS_ICON = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
const GPS_EYE_ICON = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
const GPS_EYE_OFF_ICON = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';

// error_code -> primer paso del checklist que se marca como fallido (ver
// PRINTER_ERROR_CODES en backend/errors.py). Los pasos anteriores a ese se
// marcan ✓, los posteriores quedan en "—" (no alcanzados) -- nunca hay un
// timer fingiendo progreso, todo sale de esta única respuesta atómica.
const ERROR_CODE_FAIL_STEP = {
    IP_INVALID: 'reachIp',
    CONNECTION_FAILED: 'connecting',
    SERVICE_REFUSED: 'connecting',
    UNKNOWN: 'connecting',
    CREDENTIAL_REJECTED: 'credential',
    PROTOCOL_INVALID: 'listening',
};

const GPS_STEP_LABEL_KEYS = [
    'guidedSetupStep1Label', 'guidedSetupStep2Label', 'guidedSetupStep3Label',
    'guidedSetupStep4Label', 'guidedSetupStep5Label', 'guidedSetupStep6Label',
];

let guidedSetupState = {
    step: 1,
    brand: null,
    skipBrandStep: false,
    mode: 'discover',
    discoveredDevice: null,
    formData: {},
    verification: { state: 'idle' },
    result: null,
};

// Cache del GET {listEndpoint} de la marca activa -- se llena al entrar al
// paso 3 (junto con el /discover) y se reusa en el paso 4 para detectar
// identificadores duplicados en modo manual, sin pegarle otra vez a la red.
let guidedSetupRegistryCache = [];
let guidedSetupDiscoveryAbortController = null;
let guidedSetupElapsedInterval = null;
let guidedSetupDiscoveryElapsed = 0;

function resetGuidedSetupState() {
    cancelGpsDiscovery();
    // El campo secreto (access_code/check_code) solo vive en memoria durante
    // el asistente -- nunca en localStorage/sessionStorage. Resetear el
    // estado completo acá (siempre que se cierra el modal, sea cual sea el
    // motivo) es lo que lo saca de memoria.
    guidedSetupState = {
        step: 1,
        brand: null,
        skipBrandStep: false,
        mode: 'discover',
        discoveredDevice: null,
        formData: {},
        verification: { state: 'idle' },
        result: null,
    };
    guidedSetupRegistryCache = [];
}

function openGuidedPrinterSetup(brand) {
    // Punto de entrada admin-only: el registro real ya está protegido en el
    // backend (require_role("admin")), pero un operador no debería ni ver el
    // wizard abrirse -- mismo criterio que updateTopbarUser() en app.js.
    if (!currentAuthUser || currentAuthUser.role !== 'admin') return;
    resetGuidedSetupState();
    if (brand && BRAND_CONFIG[brand]) {
        guidedSetupState.brand = brand;
        guidedSetupState.skipBrandStep = true;
    }
    document.getElementById('guided-printer-setup-modal')?.classList.add('active');
    showGuidedSetupStep(guidedSetupState.skipBrandStep ? 2 : 1);
}

function closeGuidedPrinterSetup() {
    document.getElementById('guided-printer-setup-modal')?.classList.remove('active');
    resetGuidedSetupState();
}

document.getElementById('guided-printer-setup-close')?.addEventListener('click', closeGuidedPrinterSetup);
document.getElementById('guided-printer-setup-backdrop')?.addEventListener('click', closeGuidedPrinterSetup);

function showGuidedSetupStep(step) {
    guidedSetupState.step = step;
    renderGpsStepper();
    for (let n = 1; n <= 6; n++) {
        const el = document.getElementById(`gps-step-${n}`);
        if (el) el.hidden = n !== step;
    }
    if (step === 1) renderGpsStep1();
    if (step === 2) renderGpsStep2();
    if (step === 3) startGpsDiscovery();
    if (step === 4) renderGpsStep4();
    if (step === 5) runGpsVerification();
    if (step === 6) renderGpsStep6();
    renderGpsFooterActions();
    document.getElementById('guided-printer-setup-body')?.scrollTo({ top: 0 });
}

function gpsIcon(pathMarkup, size = 14, strokeWidth = 2) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${pathMarkup}</svg>`;
}

// ── Header: stepper (círculos + conectores en desktop, texto compacto en
// viewports angostos, ver @media en guided-printer-setup.css) ──

function renderGpsStepper() {
    const stepper = document.getElementById('gps-stepper');
    const compact = document.getElementById('gps-stepper-compact');
    const current = guidedSetupState.step;
    if (stepper) {
        let html = '';
        for (let n = 1; n <= 6; n++) {
            const state = n === current ? 'active' : (n < current ? 'done' : '');
            html += `
                <div class="gps-stepper-item ${state}">
                    <div class="gps-stepper-circle">${n < current ? gpsIcon(GPS_CHECK_ICON, 14, 3) : n}</div>
                    <div class="gps-stepper-label">${escapeHtml(t(GPS_STEP_LABEL_KEYS[n - 1]))}</div>
                </div>`;
            if (n < 6) html += `<div class="gps-stepper-connector ${n < current ? 'done' : ''}"></div>`;
        }
        stepper.innerHTML = html;
    }
    if (compact) {
        compact.textContent = t('guidedSetupStepLabel')
            .replace('{step}', String(current))
            .replace('{label}', t(GPS_STEP_LABEL_KEYS[current - 1]));
    }
}

// ── Footer: navegación genérica (← Anterior / Siguiente → / Cancelar). Los
// pasos 3/5/6 tienen sus propios botones específicos dentro del cuerpo del
// paso (Cancelar búsqueda, Reintentar, Editar datos, Abrir impresora, etc.)
// -- acá solo se controla qué combinación de los 3 botones genéricos aplica. ──

function renderGpsFooterActions() {
    const el = document.getElementById('gps-footer-actions');
    if (!el) return;
    const step = guidedSetupState.step;
    const buttons = [];
    const showPrev = step >= 2 && step <= 4 && !(step === 2 && guidedSetupState.skipBrandStep);
    if (showPrev) buttons.push(`<button type="button" class="btn-file-action" id="gps-prev-btn">${escapeHtml(t('guidedSetupPrevBtn'))}</button>`);
    if (step === 2 || step === 4) buttons.push(`<button type="button" class="btn-file-action btn-file-action-accent" id="gps-next-btn">${escapeHtml(t('guidedSetupNextBtn'))}</button>`);
    if (step !== 6) buttons.push(`<button type="button" class="btn-file-action btn-file-action-danger" id="gps-cancel-btn">${escapeHtml(t('guidedSetupCancelBtn'))}</button>`);
    el.innerHTML = buttons.join('');
    el.querySelector('#gps-prev-btn')?.addEventListener('click', () => {
        cancelGpsDiscovery();
        showGuidedSetupStep(guidedSetupState.step - 1);
    });
    el.querySelector('#gps-next-btn')?.addEventListener('click', handleGpsNext);
    el.querySelector('#gps-cancel-btn')?.addEventListener('click', closeGuidedPrinterSetup);
}

function handleGpsNext() {
    if (guidedSetupState.step === 2) {
        showGuidedSetupStep(3);
    } else if (guidedSetupState.step === 4) {
        tryAdvanceFromGpsStep4();
    }
}

// ── Paso 1: selección de marca ──

function renderGpsStep1() {
    const container = document.getElementById('gps-step-1');
    if (!container) return;
    const cards = Object.keys(BRAND_CONFIG).map(brand => {
        const cfg = BRAND_CONFIG[brand];
        const badgeClass = cfg.statusBadge === 'compatible' ? 'gps-badge-compatible' : 'gps-badge-requires-lan';
        const badgeLabel = cfg.statusBadge === 'compatible' ? t('guidedSetupBadgeCompatible') : t('guidedSetupBadgeRequiresLan');
        return `
            <button type="button" class="gps-brand-card" data-brand="${brand}">
                <div class="gps-brand-card-top">
                    <span class="gps-brand-card-icon">${gpsIcon(GPS_BRAND_ICON_SVG[brand], 22)}</span>
                    <span class="gps-badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
                </div>
                <h3 class="gps-brand-card-name">${escapeHtml(cfg.displayName)}</h3>
                <p class="gps-brand-card-desc">${escapeHtml(t(cfg.descI18nKey))}</p>
            </button>`;
    }).join('');
    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep1Title'))}</h3>
        <div class="gps-brand-grid">${cards}</div>
        <div class="gps-info-banner">
            ${gpsIcon('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 18)}
            <span>${escapeHtml(t('guidedSetupNetworkBanner'))}</span>
        </div>`;
    container.querySelectorAll('.gps-brand-card').forEach(card => {
        card.addEventListener('click', () => {
            guidedSetupState.brand = card.dataset.brand;
            showGuidedSetupStep(2);
        });
    });
}

// ── Paso 2: preparar impresora (instrucciones + ilustración esquemática) ──

function gpsPrepIllustration(brand) {
    const cfg = BRAND_CONFIG[brand];
    const idField = cfg.fields.find(f => f.name === cfg.idField);
    const secretField = cfg.fields.find(f => f.secret);
    const rows = [
        { icon: GPS_WIFI_ICON, label: t('guidedSetupFieldIp') },
        { icon: GPS_HASH_ICON, label: idField ? t(idField.i18nLabel) : t('guidedSetupFieldSerial') },
    ];
    if (secretField) rows.push({ icon: GPS_LOCK_ICON, label: t(secretField.i18nLabel) });
    return `
        <div class="gps-prep-illustration-inner">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="gps-prep-illustration-device">
                <rect x="3" y="4" width="18" height="12" rx="1.5"/>
                <line x1="3" y1="8" x2="21" y2="8"/>
                <line x1="9" y1="20" x2="15" y2="20"/>
                <line x1="12" y1="16" x2="12" y2="20"/>
            </svg>
            <div class="gps-prep-illustration-rows">
                ${rows.map(r => `<div class="gps-prep-illustration-row">${gpsIcon(r.icon, 14)}<span>${escapeHtml(r.label)}</span></div>`).join('')}
            </div>
        </div>`;
}

function renderGpsStep2() {
    const container = document.getElementById('gps-step-2');
    if (!container || !guidedSetupState.brand) return;
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    const stepsHtml = cfg.prepStepsI18nKeys.map((key, i) => `
        <div class="gps-prep-item">
            <span class="gps-prep-item-number">${i + 1}</span>
            <span>${escapeHtml(t(key))}</span>
        </div>`).join('');
    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep2Title').replace('{brand}', cfg.displayName))}</h3>
        ${guidedSetupState.brand === 'bambu' ? `
            <div class="gps-info-banner gps-info-banner-warning">
                ${gpsIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 18)}
                <span>${escapeHtml(t('guidedSetupBambuHardwareWarning'))}</span>
            </div>` : ''}
        <div class="gps-prep-list">${stepsHtml}</div>
        <div class="gps-prep-illustration">${gpsPrepIllustration(guidedSetupState.brand)}</div>`;
}

// ── Paso 3: búsqueda en la red ──

function idFieldLabel(cfg) {
    const field = cfg.fields.find(f => f.name === cfg.idField);
    return field ? t(field.i18nLabel) : cfg.idField;
}

function cancelGpsDiscovery() {
    // El AbortController solo corta la ESPERA del lado del cliente -- el
    // backend de cada marca igual sigue escaneando y responde a los ~2-4s
    // (ver DISCOVERY_TIMEOUT en los *_service.py), esto no cancela nada del
    // lado del servidor, es puramente UX para no dejar al usuario mirando un
    // spinner si ya decidió no esperar más.
    if (guidedSetupDiscoveryAbortController) {
        guidedSetupDiscoveryAbortController.abort();
        guidedSetupDiscoveryAbortController = null;
    }
    if (guidedSetupElapsedInterval) {
        clearInterval(guidedSetupElapsedInterval);
        guidedSetupElapsedInterval = null;
    }
}

function wireGpsStep3RetryAndManual() {
    document.getElementById('gps-retry-search-btn')?.addEventListener('click', () => startGpsDiscovery());
    document.getElementById('gps-manual-add-btn')?.addEventListener('click', () => {
        cancelGpsDiscovery();
        guidedSetupState.mode = 'manual';
        guidedSetupState.discoveredDevice = null;
        guidedSetupState.formData = {};
        showGuidedSetupStep(4);
    });
}

function renderGpsStep3Scanning() {
    const container = document.getElementById('gps-step-3');
    if (!container) return;
    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep3Title'))}</h3>
        <div class="gps-discovery-status">
            <div class="gps-spinner"></div>
            <span class="gps-discovery-status-text">${escapeHtml(t('guidedSetupSearching'))}</span>
            <span class="gps-discovery-elapsed" id="gps-discovery-elapsed">${escapeHtml(t('guidedSetupElapsed').replace('{seconds}', '0'))}</span>
        </div>
        <div class="gps-inline-actions">
            <button type="button" class="btn-file-action btn-file-action-danger" id="gps-cancel-search-btn">${escapeHtml(t('guidedSetupCancelSearch'))}</button>
        </div>`;
    container.querySelector('#gps-cancel-search-btn')?.addEventListener('click', () => cancelGpsDiscovery());
}

function renderGpsStep3EmptyOrCancelled(messageKey) {
    const container = document.getElementById('gps-step-3');
    if (!container) return;
    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep3Title'))}</h3>
        <div class="gps-empty-discovery">
            <span>${escapeHtml(t(messageKey))}</span>
            <div class="gps-inline-actions">
                <button type="button" class="btn-file-action btn-file-action-accent" id="gps-retry-search-btn">${escapeHtml(t('guidedSetupRetrySearch'))}</button>
                <button type="button" class="btn-file-action" id="gps-manual-add-btn">${escapeHtml(t('guidedSetupAddManually'))}</button>
            </div>
        </div>`;
    wireGpsStep3RetryAndManual();
}

function renderGpsStep3Results(devices) {
    const container = document.getElementById('gps-step-3');
    if (!container || !guidedSetupState.brand) return;
    if (!devices.length) {
        renderGpsStep3EmptyOrCancelled('guidedSetupNoDevicesFound');
        return;
    }
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    const registeredIds = new Set(guidedSetupRegistryCache.map(p => p.id));
    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep3Title'))}</h3>
        <div class="gps-device-grid" id="gps-device-grid"></div>
        <div class="gps-inline-actions">
            <button type="button" class="btn-file-action" id="gps-retry-search-btn">${escapeHtml(t('guidedSetupRetrySearch'))}</button>
            <button type="button" class="btn-file-action" id="gps-manual-add-btn">${escapeHtml(t('guidedSetupAddManually'))}</button>
        </div>`;
    const grid = container.querySelector('#gps-device-grid');
    devices.forEach(device => {
        const idValue = device[cfg.idField];
        const isRegistered = registeredIds.has(idValue);
        const card = document.createElement('div');
        card.className = `gps-device-card${isRegistered ? ' gps-device-card-disabled' : ''}`;
        card.innerHTML = `
            <div class="gps-device-card-fields">
                <div class="gps-device-card-field">
                    <span class="gps-device-card-field-label">${escapeHtml(t('guidedSetupFieldName'))}</span>
                    <span class="gps-device-card-field-value">${escapeHtml(device.name || device.model || idValue || '—')}</span>
                </div>
                <div class="gps-device-card-field">
                    <span class="gps-device-card-field-label">${escapeHtml(t('guidedSetupFieldModel'))}</span>
                    <span class="gps-device-card-field-value">${escapeHtml(device.model || '—')}</span>
                </div>
                <div class="gps-device-card-field">
                    <span class="gps-device-card-field-label">${escapeHtml(t('guidedSetupFieldIp'))}</span>
                    <span class="gps-device-card-field-value">${escapeHtml(device.ip || '—')}</span>
                </div>
                <div class="gps-device-card-field">
                    <span class="gps-device-card-field-label">${escapeHtml(idFieldLabel(cfg))}</span>
                    <span class="gps-device-card-field-value">${escapeHtml(idValue || '—')}</span>
                </div>
            </div>
            <span class="gps-badge ${isRegistered ? 'gps-device-badge-registered' : 'gps-device-badge-available'}">${escapeHtml(isRegistered ? t('guidedSetupDeviceRegistered') : t('guidedSetupDeviceAvailable'))}</span>`;
        if (!isRegistered) card.addEventListener('click', () => selectGpsDiscoveredDevice(device));
        grid.appendChild(card);
    });
    wireGpsStep3RetryAndManual();
}

function selectGpsDiscoveredDevice(device) {
    cancelGpsDiscovery();
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    guidedSetupState.mode = 'discover';
    guidedSetupState.discoveredDevice = device;
    const prefill = { name: device.name || device.model || '', model: device.model || '', ip: device.ip || '' };
    prefill[cfg.idField] = device[cfg.idField] || '';
    guidedSetupState.formData = prefill;
    showGuidedSetupStep(4);
}

async function startGpsDiscovery() {
    if (!guidedSetupState.brand) return;
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    renderGpsStep3Scanning();
    guidedSetupDiscoveryElapsed = 0;
    if (guidedSetupElapsedInterval) clearInterval(guidedSetupElapsedInterval);
    guidedSetupElapsedInterval = setInterval(() => {
        guidedSetupDiscoveryElapsed += 1;
        const elapsedEl = document.getElementById('gps-discovery-elapsed');
        if (elapsedEl) elapsedEl.textContent = t('guidedSetupElapsed').replace('{seconds}', String(guidedSetupDiscoveryElapsed));
    }, 1000);
    guidedSetupDiscoveryAbortController = new AbortController();
    try {
        const [registryResponse, discoverResponse] = await Promise.all([
            fetch(cfg.listEndpoint),
            fetch(cfg.discoverEndpoint, { method: 'POST', signal: guidedSetupDiscoveryAbortController.signal }),
        ]);
        const registryData = await registryResponse.json().catch(() => ({ printers: [] }));
        guidedSetupRegistryCache = registryData.printers || [];
        const discoverData = await discoverResponse.json().catch(() => ({ devices: [] }));
        cancelGpsDiscovery();
        renderGpsStep3Results(discoverData.devices || []);
    } catch (error) {
        cancelGpsDiscovery();
        if (error.name === 'AbortError') {
            renderGpsStep3EmptyOrCancelled('guidedSetupSearchCancelled');
        } else {
            console.error(error);
            renderGpsStep3Results([]);
        }
    }
}

// ── Paso 4: credenciales ──

function renderGpsStep4() {
    const container = document.getElementById('gps-step-4');
    if (!container || !guidedSetupState.brand) return;
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    const prefill = guidedSetupState.formData || {};
    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep4Title'))}</h3>
        <p class="gps-step-hint">${escapeHtml(t('guidedSetupStep4Hint'))}</p>
        <div class="gps-form-fields" id="gps-form-fields"></div>`;
    const fieldsWrap = container.querySelector('#gps-form-fields');
    cfg.fields.forEach(field => {
        const value = prefill[field.name] != null ? prefill[field.name] : '';
        const wrap = document.createElement('div');
        wrap.className = 'usb-classify-name-field';
        const label = document.createElement('label');
        label.setAttribute('for', `gps-field-${field.name}`);
        label.textContent = t(field.i18nLabel);
        wrap.appendChild(label);

        if (field.type === 'select') {
            const select = document.createElement('select');
            select.id = `gps-field-${field.name}`;
            (field.options || []).forEach(opt => {
                const optionEl = document.createElement('option');
                optionEl.value = opt;
                optionEl.textContent = `${opt} (${t('guidedSetupPendingValidation')})`;
                if (opt === value) optionEl.selected = true;
                select.appendChild(optionEl);
            });
            wrap.appendChild(select);
            const hint = document.createElement('p');
            hint.className = 'gps-select-hint';
            hint.textContent = t('guidedSetupPendingValidation');
            wrap.appendChild(hint);
        } else if (field.secret) {
            const secretWrap = document.createElement('div');
            secretWrap.className = 'gps-secret-field-wrap';
            const input = document.createElement('input');
            input.type = 'password';
            input.id = `gps-field-${field.name}`;
            input.autocomplete = 'off';
            // Nunca se precarga -- ni siquiera si venimos de "Editar datos"
            // tras un intento fallido, el usuario tiene que volver a
            // tipearlo (ver restricción de seguridad del asistente).
            input.value = '';
            secretWrap.appendChild(input);
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'gps-secret-toggle-btn';
            toggleBtn.title = t('guidedSetupShowSecret');
            toggleBtn.innerHTML = gpsIcon(GPS_EYE_ICON, 16);
            toggleBtn.addEventListener('click', () => {
                const showing = input.type === 'text';
                input.type = showing ? 'password' : 'text';
                toggleBtn.title = showing ? t('guidedSetupShowSecret') : t('guidedSetupHideSecret');
                toggleBtn.innerHTML = gpsIcon(showing ? GPS_EYE_ICON : GPS_EYE_OFF_ICON, 16);
            });
            secretWrap.appendChild(toggleBtn);
            wrap.appendChild(secretWrap);
        } else {
            const input = document.createElement('input');
            input.type = 'text';
            input.id = `gps-field-${field.name}`;
            input.autocomplete = 'off';
            input.value = value;
            wrap.appendChild(input);
        }
        fieldsWrap.appendChild(wrap);
    });
}

async function tryAdvanceFromGpsStep4() {
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    const values = {};
    for (const field of cfg.fields) {
        const el = document.getElementById(`gps-field-${field.name}`);
        const value = el ? String(el.value || '').trim() : '';
        if (field.required && !value) {
            showToast(t('guidedSetupFieldRequired'), 'error');
            return;
        }
        values[field.name] = value;
    }
    guidedSetupState.formData = values;
    const idValue = values[cfg.idField];
    const duplicate = guidedSetupRegistryCache.find(p => p.id === idValue);
    if (duplicate) {
        const confirmed = await appConfirm(t('guidedSetupUpdateExistingConfirm'), t('guidedSetupStep4Title'), 'warning');
        if (!confirmed) return;
    }
    showGuidedSetupStep(5);
}

// ── Paso 5: verificación real contra el backend (POST {registerEndpoint},
// sin eventos de progreso: es una única llamada atómica -- ver spec del
// asistente. El checklist deriva su estado del error_code real devuelto,
// nunca de un timer simulando avance). ──

function getGpsChecklistSteps(brand) {
    const cfg = BRAND_CONFIG[brand];
    const steps = [
        { key: 'reachIp', label: t('guidedSetupCheckReachIp') },
        { key: 'connecting', label: t(cfg.connectI18nKey) },
        { key: 'validatingId', label: t('guidedSetupCheckValidatingId') },
    ];
    if (cfg.fields.some(f => f.secret)) steps.push({ key: 'credential', label: t('guidedSetupCheckValidatingCredential') });
    steps.push({ key: 'listening', label: t('guidedSetupCheckListening') });
    steps.push({ key: 'received', label: t('guidedSetupCheckReceived') });
    return steps;
}

function applyGpsChecklistFailure(steps, failKey) {
    const canonicalOrder = ['reachIp', 'connecting', 'validatingId', 'credential', 'listening', 'received'];
    let targetKey = failKey;
    if (!steps.some(s => s.key === targetKey)) {
        const idx = canonicalOrder.indexOf(targetKey);
        targetKey = canonicalOrder.slice(idx + 1).find(k => steps.some(s => s.key === k)) || steps[steps.length - 1].key;
    }
    const targetIndex = steps.findIndex(s => s.key === targetKey);
    return steps.map((s, i) => ({
        ...s,
        state: i < targetIndex ? 'ok' : (i === targetIndex ? 'fail' : 'unreached'),
    }));
}

function gpsChecklistIcon(state) {
    if (state === 'ok') return gpsIcon(GPS_CHECK_ICON, 12, 3);
    if (state === 'fail') return gpsIcon(GPS_CROSS_ICON, 12, 3);
    if (state === 'unreached') return '—';
    return '';
}

function renderGpsStep5() {
    const container = document.getElementById('gps-step-5');
    if (!container || !guidedSetupState.brand) return;
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    const verification = guidedSetupState.verification;
    const baseSteps = getGpsChecklistSteps(guidedSetupState.brand);

    let stateSteps;
    if (verification.state === 'ok') {
        stateSteps = baseSteps.map(s => ({ ...s, state: 'ok' }));
    } else if (verification.state === 'failed') {
        stateSteps = applyGpsChecklistFailure(baseSteps, ERROR_CODE_FAIL_STEP[verification.errorCode] || 'connecting');
    } else {
        stateSteps = baseSteps.map(s => ({ ...s, state: 'pending' }));
    }

    const checklistHtml = stateSteps.map(s => `
        <div class="gps-checklist-item ${s.state}">
            <span class="gps-checklist-icon">${gpsChecklistIcon(s.state)}</span>
            <span>${escapeHtml(s.label)}</span>
        </div>`).join('');

    let errorPanelHtml = '';
    if (verification.state === 'failed') {
        errorPanelHtml = `
            <div class="gps-verify-error-panel">
                <span>${escapeHtml(verification.detail || t('guidedSetupErrorGeneric'))}</span>
            </div>
            <div class="gps-inline-actions">
                <button type="button" class="btn-file-action btn-file-action-accent" id="gps-verify-retry-btn">${escapeHtml(t('guidedSetupRetry'))}</button>
                <button type="button" class="btn-file-action" id="gps-verify-edit-btn">${escapeHtml(t('guidedSetupEditData'))}</button>
                <button type="button" class="btn-file-action" id="gps-verify-back-btn">${escapeHtml(t('guidedSetupBackToInstructions'))}</button>
            </div>
            <details class="gps-tech-details">
                <summary>${escapeHtml(t('guidedSetupTechDetails'))}</summary>
                <dl class="gps-tech-details-grid">
                    <dt>${escapeHtml(t('guidedSetupTechBrand'))}</dt><dd>${escapeHtml(cfg.displayName)}</dd>
                    <dt>${escapeHtml(t('guidedSetupTechIp'))}</dt><dd>${escapeHtml(guidedSetupState.formData.ip || '—')}</dd>
                    <dt>${escapeHtml(t('guidedSetupTechProtocol'))}</dt><dd>${escapeHtml(cfg.protocol)}</dd>
                    <dt>${escapeHtml(t('guidedSetupTechErrorCode'))}</dt><dd>${escapeHtml(verification.errorCode || '—')}</dd>
                    <dt>${escapeHtml(t('guidedSetupTechRawMessage'))}</dt><dd>${escapeHtml(verification.detail || '—')}</dd>
                </dl>
            </details>`;
    }

    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep5Title'))}</h3>
        <div class="gps-info-banner gps-info-banner-warning">
            ${gpsIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 18)}
            <span>${escapeHtml(t('guidedSetupDoNotClose'))}</span>
        </div>
        ${verification.state === 'checking' ? `<div class="gps-verify-status"><div class="gps-spinner"></div></div>` : ''}
        <div class="gps-checklist">${checklistHtml}</div>
        ${errorPanelHtml}`;

    if (verification.state === 'failed') {
        container.querySelector('#gps-verify-retry-btn')?.addEventListener('click', () => runGpsVerification());
        container.querySelector('#gps-verify-edit-btn')?.addEventListener('click', () => showGuidedSetupStep(4));
        container.querySelector('#gps-verify-back-btn')?.addEventListener('click', () => showGuidedSetupStep(2));
    }
    renderGpsFooterActions();
}

async function finalizeGuidedSetupSuccess() {
    const brand = guidedSetupState.brand;
    if (brand === 'bambu') { refreshBambuPrintersGrid(); loadBambuRegistryList(); }
    if (brand === 'elegoo') { refreshElegooPrintersGrid(); loadElegooRegistryList(); }
    if (brand === 'flashforge') { refreshFlashforgePrintersGrid(); loadFlashforgeRegistryList(); }
    if (typeof loadDashboardPanel === 'function') loadDashboardPanel();
}

async function runGpsVerification() {
    if (!guidedSetupState.brand) return;
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    guidedSetupState.verification = { state: 'checking' };
    renderGpsStep5();

    const formData = new FormData();
    Object.entries(guidedSetupState.formData).forEach(([key, value]) => {
        if (value != null) formData.append(key, value);
    });

    try {
        const response = await fetch(cfg.registerEndpoint, { method: 'POST', body: formData });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
            guidedSetupState.verification = { state: 'ok' };
            guidedSetupState.result = data;
            renderGpsStep5();
            await finalizeGuidedSetupSuccess();
            showGuidedSetupStep(6);
        } else {
            // Si el 400 no trae error_code (ej. validate_printer_ip() tira un
            // HTTPException plano antes de llegar a PrinterRegistrationError,
            // ver backend/utils.py) se trata como UNKNOWN -- honesto con lo
            // que realmente contestó el backend, no se inventa el motivo.
            guidedSetupState.verification = {
                state: 'failed',
                errorCode: data.error_code || 'UNKNOWN',
                detail: data.detail || t('guidedSetupErrorGeneric'),
            };
            renderGpsStep5();
        }
    } catch (error) {
        console.error(error);
        guidedSetupState.verification = { state: 'failed', errorCode: 'UNKNOWN', detail: error.message || t('guidedSetupErrorGeneric') };
        renderGpsStep5();
    }
}

// ── Paso 6: resumen final + matriz de capacidades (siempre derivada de
// BRAND_CONFIG[brand].capabilities, nunca texto libre inventado) ──

function gpsCapabilityLabelKey(key) {
    return `guidedSetupCap${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function renderGpsStep6() {
    const container = document.getElementById('gps-step-6');
    if (!container || !guidedSetupState.brand) return;
    const cfg = BRAND_CONFIG[guidedSetupState.brand];
    const printer = guidedSetupState.result || {};
    const capsAvailable = Object.entries(cfg.capabilities).filter(([, v]) => v);
    const capsUnavailable = Object.entries(cfg.capabilities).filter(([, v]) => !v);

    const capItem = (key, available) => `
        <div class="gps-capability-item ${available ? 'available' : 'unavailable'}">
            ${gpsIcon(available ? GPS_CHECK_ICON : GPS_CROSS_ICON, 15, available ? 3 : 2)}
            <span>${escapeHtml(t(gpsCapabilityLabelKey(key)))}</span>
        </div>`;

    container.innerHTML = `
        <h3 class="gps-step-title">${escapeHtml(t('guidedSetupStep6Title'))}</h3>
        <div class="gps-summary-card">
            <div class="gps-summary-row"><span class="gps-summary-row-label">${escapeHtml(t('guidedSetupSummaryName'))}</span><span class="gps-summary-row-value">${escapeHtml(printer.name || '—')}</span></div>
            <div class="gps-summary-row"><span class="gps-summary-row-label">${escapeHtml(t('guidedSetupSummaryBrand'))}</span><span class="gps-summary-row-value">${escapeHtml(cfg.displayName)}</span></div>
            <div class="gps-summary-row"><span class="gps-summary-row-label">${escapeHtml(t('guidedSetupSummaryModel'))}</span><span class="gps-summary-row-value">${escapeHtml(printer.model || '—')}</span></div>
            <div class="gps-summary-row"><span class="gps-summary-row-label">${escapeHtml(t('guidedSetupSummaryStatus'))}</span><span class="gps-summary-row-value">${escapeHtml(printer.online ? t('online') : t('offline'))}</span></div>
            <div class="gps-summary-row"><span class="gps-summary-row-label">${escapeHtml(t('guidedSetupSummaryIp'))}</span><span class="gps-summary-row-value">${escapeHtml(printer.ip || '—')}</span></div>
            <div class="gps-summary-row"><span class="gps-summary-row-label">${escapeHtml(idFieldLabel(cfg))}</span><span class="gps-summary-row-value">${escapeHtml(printer.id || '—')}</span></div>
        </div>
        <div class="gps-capabilities-grid">
            <div>
                <p class="gps-capabilities-col-title">${escapeHtml(t('guidedSetupCapabilitiesAvailable'))}</p>
                ${capsAvailable.map(([key]) => capItem(key, true)).join('')}
            </div>
            <div>
                <p class="gps-capabilities-col-title">${escapeHtml(t('guidedSetupCapabilitiesUnavailable'))}</p>
                ${capsUnavailable.map(([key]) => capItem(key, false)).join('')}
            </div>
        </div>
        <div class="gps-step6-actions">
            <button type="button" class="btn-file-action btn-file-action-accent" id="gps-open-printer-btn">${escapeHtml(t('guidedSetupOpenPrinter'))}</button>
            <button type="button" class="btn-file-action" id="gps-add-another-btn">${escapeHtml(t('guidedSetupAddAnother'))}</button>
            <button type="button" class="btn-file-action" id="gps-goto-dashboard-btn">${escapeHtml(t('guidedSetupGoDashboard'))}</button>
            <button type="button" class="btn-file-action" id="gps-finish-btn">${escapeHtml(t('guidedSetupFinish'))}</button>
        </div>`;

    container.querySelector('#gps-open-printer-btn')?.addEventListener('click', () => {
        const brand = guidedSetupState.brand;
        closeGuidedPrinterSetup();
        switchSection(brand);
    });
    container.querySelector('#gps-add-another-btn')?.addEventListener('click', () => {
        const skipBrandStep = guidedSetupState.skipBrandStep;
        const brand = guidedSetupState.brand;
        resetGuidedSetupState();
        if (skipBrandStep) {
            guidedSetupState.brand = brand;
            guidedSetupState.skipBrandStep = true;
            showGuidedSetupStep(2);
        } else {
            showGuidedSetupStep(1);
        }
    });
    container.querySelector('#gps-goto-dashboard-btn')?.addEventListener('click', () => {
        closeGuidedPrinterSetup();
        switchSection('dashboard');
    });
    container.querySelector('#gps-finish-btn')?.addEventListener('click', () => closeGuidedPrinterSetup());
}

// ── Auto-apertura en primer inicio: dashboard sin ninguna impresora
// registrada, admin logueado, todavía no se mostró en esta pestaña. Llamado
// desde loadDashboardPanel() en app.js (ver renderDashboardPanel). ──

function maybeAutoOpenGuidedSetup(data) {
    if (!currentAuthUser || currentAuthUser.role !== 'admin') return;
    if (typeof setupRequired !== 'undefined' && setupRequired) return;
    if (!data || !data.devices || !data.devices.printer || data.devices.printer.total !== 0) return;
    if (sessionStorage.getItem('guidedSetupAutoShown') === '1') return;
    sessionStorage.setItem('guidedSetupAutoShown', '1');
    openGuidedPrinterSetup();
}

// Botón dedicado en Configuración → Dispositivos (sin marca preseleccionada,
// arranca en el paso 1). Visibilidad admin-only controlada en
// updateTopbarUser() de app.js (mismo patrón que el resto de botones
// admin-only, ver app.js:63/68).
document.getElementById('guided-printer-setup-open-btn')?.addEventListener('click', () => openGuidedPrinterSetup());
