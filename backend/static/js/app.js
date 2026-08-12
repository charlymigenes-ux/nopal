// ── Autenticación + barra superior global ──
// Va primero en el archivo a propósito: envuelve window.fetch ANTES de que
// corran las llamadas de init de más abajo (loadModels(), loadPrinters(),
// etc.) — si esto estuviera al final del archivo, esas llamadas iniciales
// ya se habrían disparado con el fetch original y un 401 en la primera
// carga pasaría desapercibido (dashboard visible, resto roto en silencio).

let currentAuthUser = null;
// Reflejado por checkAuth() vía /api/auth/setup-required. Sin esto, los
// setInterval de polling (loadPrinters, loadDashboardPanel, etc.) pegan
// a endpoints protegidos, reciben 401 y el interceptor de abajo tapa la
// pantalla de configuración inicial con el login en loop, cada pocos
// segundos — aunque el backend ya haya decidido correctamente que
// corresponde mostrar el setup.
let setupRequired = false;

const ORIGINAL_FETCH = window.fetch.bind(window);
window.fetch = async function authAwareFetch(input, init) {
    const response = await ORIGINAL_FETCH(input, init);
    if (response.status === 401) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
            if (setupRequired) {
                showSetupOverlay();
            } else {
                showLoginOverlay();
            }
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

    // La galería de plugins es una acción administrativa (instalar/desinstalar
    // afecta a todo el equipo) — un operador no debe ni verla ni poder entrar.
    const pluginsBtn = document.getElementById('nav-plugins-gallery-btn');
    if (pluginsBtn) pluginsBtn.hidden = user.role !== 'admin';

    // El Control del sistema (servicios systemd + reiniciar/apagar el host)
    // es igual de sensible — solo admin lo debe ver u operar.
    const systemBtn = document.getElementById('topbar-system-btn');
    if (systemBtn) systemBtn.hidden = user.role !== 'admin';

    // El asistente guiado de instalación de impresoras termina en un POST
    // admin-only (require_role("admin") en cada *_printers.py) -- un
    // operador no debería ni ver el punto de entrada (ver
    // guided-printer-setup.js:openGuidedPrinterSetup, que además revalida
    // el rol por las dudas si igual se llegara a invocar).
    const guidedSetupBtn = document.getElementById('guided-printer-setup-open-btn');
    if (guidedSetupBtn) guidedSetupBtn.hidden = user.role !== 'admin';

    // La configuración de IA decide a qué servidor externo se le manda
    // telemetría del taller: mismo criterio que la galería de plugins, es
    // admin-only en el backend (require_role("admin") en backend/api/ai.py)
    // y un operador no debe ni verla. Preguntarle a la IA sí es para
    // cualquiera, así que la sección del asistente no se toca acá.
    const aiCard = document.querySelector('[data-settings-module="ai"]');
    if (aiCard) aiCard.hidden = user.role !== 'admin';
}

function showFullscreenRecommendation() {
    if (!document.fullscreenEnabled || document.fullscreenElement || sessionStorage.getItem('fullscreenRecommendationDismissed') === 'true' || document.getElementById('fullscreen-recommendation')) return;
    const banner = document.createElement('div');
    banner.id = 'fullscreen-recommendation';
    banner.className = 'fullscreen-recommendation';
    banner.innerHTML = `
        <span class="fullscreen-recommendation-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg></span>
        <span><strong>NOPAL funciona mejor en pantalla completa</strong><small>Obtén más espacio para el área de trabajo y los controles.</small></span>
        <button type="button" class="fullscreen-recommendation-action">Activar pantalla completa</button>
        <button type="button" class="fullscreen-recommendation-close" aria-label="Cerrar">×</button>`;
    document.body.appendChild(banner);
    banner.querySelector('.fullscreen-recommendation-action').addEventListener('click', async () => {
        try {
            await document.documentElement.requestFullscreen();
            banner.remove();
        } catch (error) {
            console.error(error);
            showToast('El navegador no permitió activar la pantalla completa.', 'warning');
        }
    });
    banner.querySelector('.fullscreen-recommendation-close').addEventListener('click', () => {
        sessionStorage.setItem('fullscreenRecommendationDismissed', 'true');
        banner.remove();
    });
}

async function checkAuth() {
    try {
        const setupResponse = await ORIGINAL_FETCH('/api/auth/setup-required');
        if (setupResponse.ok) {
            const setupData = await setupResponse.json();
            setupRequired = !!setupData.required;
            if (setupRequired) {
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
        showFullscreenRecommendation();
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
    const labels = { es: 'ES', en: 'EN', 'pt-BR': 'PT', fr: 'FR', de: 'DE' };
    if (el) el.textContent = labels[typeof currentLanguage !== 'undefined' ? currentLanguage : 'es'] || 'ES';
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
    list.innerHTML = items.map((item, index) => `
        <button type="button" class="topbar-notif-item severity-${escapeHtml(item.severity || 'info')}" data-notif-index="${index}">
            <span class="topbar-notif-item-dot"></span>
            <span>${escapeHtml(item.message)}</span>
        </button>
    `).join('');
    list.querySelectorAll('.topbar-notif-item').forEach(btn => {
        btn.addEventListener('click', () => {
            closeAllTopbarDropdowns();
            goToNotificationTarget(items[Number(btn.dataset.notifIndex)]);
        });
    });
}

// Ruta de cada alerta a su destino concreto -- antes toda alerta de
// impresora mandaba a la sección "dashboard" en general (que ES la grilla
// de impresoras, pero sin foco en ninguna en particular) dejando al
// usuario a buscar manualmente cuál de varias impresoras era la que
// fallaba. Con "port" (ver notification_service.py) se abre directo el
// modal de esa impresora puntual, igual que si el usuario clickeara su
// tarjeta.
function goToNotificationTarget(item) {
    if (!item) return;
    if (item.source === 'printer' && item.port != null) {
        switchSection('dashboard');
        const printer = allPrinters.find(p => p.port === item.port);
        if (printer) openPrinterModal(printer);
        return;
    }
    switchSection(item.section || 'dashboard');
}

let lastNotificationsData = { count: 0, items: [] };

// ── Alertas descartadas ("no molestar de nuevo" para una máquina que se
// sabe apagada a propósito, etc.) — se guardan por "id" estable (ver
// notification_service.py) en localStorage, no en el servidor: no hay
// concepto de usuario/sesión en ese registro y el descarte es una
// preferencia puramente local del navegador. Se podan solas cuando la
// condición que las generó desaparece (ver pruneDismissedAlertIds), así que
// si la misma máquina vuelve a fallar más tarde la alerta reaparece.
const DISMISSED_ALERTS_KEY = 'dismissedAlertIds';

function getDismissedAlertIds() {
    try {
        return new Set(JSON.parse(localStorage.getItem(DISMISSED_ALERTS_KEY) || '[]'));
    } catch (error) {
        return new Set();
    }
}

function saveDismissedAlertIds(idSet) {
    localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify([...idSet]));
}

function dismissAlert(id) {
    if (!id) return;
    const dismissed = getDismissedAlertIds();
    dismissed.add(id);
    saveDismissedAlertIds(dismissed);
}

function pruneDismissedAlertIds(activeItems) {
    const activeIds = new Set((activeItems || []).map(item => item.id).filter(Boolean));
    const dismissed = getDismissedAlertIds();
    let changed = false;
    dismissed.forEach(id => {
        if (!activeIds.has(id)) {
            dismissed.delete(id);
            changed = true;
        }
    });
    if (changed) saveDismissedAlertIds(dismissed);
}

// Salud "efectiva" del sistema tal como la ve el usuario: igual al cálculo
// del backend (dashboard_service.get_dashboard_summary) pero descontando
// las alertas que el usuario ya descartó -- si la única alerta de error era
// una impresora apagada a propósito y la descarta, el pill/título de la
// pestaña deben dejar de mostrar "error" sin esperar al próximo poll del
// panel completo.
function computeEffectiveHealth() {
    const dismissed = getDismissedAlertIds();
    const active = (lastNotificationsData.items || []).filter(item => !(item.id && dismissed.has(item.id)));
    if (active.some(item => item.severity === 'error')) return 'error';
    if (active.some(item => item.severity === 'warning')) return 'warning';
    return 'ok';
}

async function loadTopbarNotifications() {
    if (!currentAuthUser) return;
    try {
        const response = await fetch('/api/notifications');
        if (!response.ok) return;
        const data = await response.json();
        lastNotificationsData = data;
        pruneDismissedAlertIds(data.items || []);
        renderTopbarNotifications(data);
        updateStatusPill();
        updateStatusTabTitle();
    } catch (error) {
        console.error(error);
    }
}

checkAuth().then(user => {
    updateTopbarLangLabel();
    if (user) {
        loadTopbarNotifications();
        loadInstalledPluginModules();
    }
});
setInterval(() => { if (currentAuthUser) loadTopbarNotifications(); }, 10000);

function installModernModelsLibraryMarkup() {
    const section = document.getElementById('models-section');
    if (!section) return;
    section.innerHTML = `
        <main class="main-content gcode-library-main models-modern-main">
            <div class="gcode-library-shell models-library-shell">
                <section class="gcode-library-card models-library-card">
                    <header class="gcode-library-header">
                        <div><span class="library-page-eyebrow" data-i18n="libraryEyebrow">BIBLIOTECA NOPAL</span><h1 data-i18n="navPrinting3d">Impresión 3D</h1><p data-i18n="libraryModelsDescription">Explora, organiza y gestiona tus modelos y archivos listos para imprimir.</p></div>
                        <div class="gcode-library-actions">
                            <div class="upload-wrapper"><button id="upload-btn-models" class="gcode-primary-action" type="button"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span data-i18n="libraryUploadFile">Subir archivo</span></button><input id="upload-input-models" type="file" accept=".stl,.3mf,.obj,.gcode,.gc,.gco" multiple hidden></div>
                            <button id="create-folder-btn-models" class="gcode-toolbar-action" type="button"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg><span data-i18n="libraryNewFolder">Nueva carpeta</span></button>
                            <button id="reload-btn-models" class="gcode-toolbar-action" type="button"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg><span data-i18n="libraryRefresh">Actualizar</span></button>
                            <button id="settings-btn-models" class="gcode-icon-action" type="button" title="Más opciones"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button>
                        </div>
                    </header>
                    <div class="gcode-navigation-row">
                        <div class="gcode-navigation-buttons"><button id="models-nav-back" type="button" title="Atrás"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg></button><button id="models-nav-forward" type="button" title="Adelante"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></button><button id="models-nav-up" type="button" title="Subir nivel"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg></button><button id="models-nav-home" type="button" title="Inicio"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/></svg></button></div>
                        <nav class="gcode-breadcrumbs" id="models-breadcrumb" aria-label="Ruta actual"></nav><span id="models-disk-free" class="gcode-disk-free">—</span>
                    </div>
                    <div class="gcode-library-toolbar">
                        <label class="gcode-library-search"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.7" y2="16.7"/></svg><input id="search-models" type="search" placeholder="Buscar modelos..."><kbd>Ctrl K</kbd></label>
                        <div class="gcode-toolbar-spacer"></div>
                        <label class="gcode-select-control"><span data-i18n="librarySortBy">Ordenar por:</span><select id="models-sort-select"><option value="name-asc" data-i18n="librarySortNameAsc">Nombre (A-Z)</option><option value="name-desc" data-i18n="librarySortNameDesc">Nombre (Z-A)</option><option value="date-desc" data-i18n="librarySortNewest">Más recientes</option><option value="date-asc" data-i18n="librarySortOldest">Más antiguos</option><option value="size-desc" data-i18n="librarySortLargest">Mayor tamaño</option></select></label>
                        <label class="gcode-select-control gcode-filter-control"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16M7 12h10m-7 7h4"/></svg><select id="models-filter-select"><option value="all" data-i18n="libraryFilters">Filtros</option><option value="favorites" data-i18n="libraryFavorites">Favoritos</option><option value="recent" data-i18n="libraryRecent">Recientes</option><option value="models" data-i18n="libraryModelsOnly">Modelos 3D</option><option value="gcode">G-code</option></select></label>
                        <div class="gcode-view-switch"><button id="view-grid-full" type="button" data-view="grid" title="Vista de cuadrícula"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button><button id="view-list-full" class="active" type="button" data-view="list" title="Vista de lista"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg></button></div>
                    </div>
                    <div class="gcode-browser-layout">
                        <aside class="gcode-inner-sidebar"><section><div class="gcode-sidebar-heading"><strong>★ <span data-i18n="libraryFavorites">Favoritos</span></strong><button id="models-favorites-all" type="button" data-i18n="libraryViewAll">Ver todos</button></div><div id="models-favorites-list" class="gcode-sidebar-list"></div></section><section><div class="gcode-sidebar-heading"><strong>◷ <span data-i18n="libraryRecent">Recientes</span></strong><button id="models-recents-all" type="button" data-i18n="libraryViewAll">Ver todos</button></div><div id="models-recents-list" class="gcode-sidebar-list"></div></section><section><div class="gcode-sidebar-heading"><strong>◇ <span data-i18n="libraryFormats">Formatos</span></strong></div><div id="models-tags-list" class="gcode-sidebar-list"></div></section></aside>
                        <div class="gcode-browser-content" data-bg-label="IMPRESIÓN 3D"><div id="models-folder-strip" class="gcode-folder-strip"></div><div class="bulk-actions-bar" id="models-bulk-bar" hidden><span id="models-bulk-count">0</span><button type="button" class="btn-file-action" id="models-bulk-move-btn">Mover</button><button type="button" class="btn-file-action btn-file-action-danger" id="models-bulk-delete-btn">Eliminar</button><button type="button" class="bulk-actions-clear-btn" id="models-bulk-clear-btn">Cancelar selección</button></div><div id="models-full" class="models-table-wrapper gcode-modern-table models-modern-table"></div><footer class="gcode-pagination" id="models-pagination"></footer></div>
                    </div>
                </section>
                <aside class="models-preview-card gcode-modern-preview models-modern-preview"><div class="preview-card-inner">
                    <div class="preview-card-header"><div><span class="preview-label" data-i18n="libraryModelPreview">VISTA PREVIA DEL MODELO</span></div><button type="button" class="preview-expand-btn" id="preview-expand-btn" title="Ampliar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button></div>
                    <div class="gcode-preview-name-row"><h2 id="preview-filename" data-i18n="librarySelectModel">Selecciona un modelo</h2><button type="button" class="preview-favorite-btn" id="preview-favorite-btn" title="Favorito">☆</button></div><p class="models-preview-description" data-i18n="libraryModelPreviewHelp">Vista interactiva para modelos 3D y trayectorias G-code.</p>
                    <div class="preview-meta-grid"><div><span>Tipo</span><strong id="preview-type">—</strong><span id="preview-type-pill" hidden></span></div><div><span>Tamaño</span><strong id="preview-size">—</strong></div><div><span>Modificado</span><strong id="preview-date">—</strong></div></div>
                    <div class="preview-file-actions"><button type="button" class="btn-file-action btn-file-action-accent" id="preview-send-printer-btn" hidden>Enviar a impresora</button><button type="button" class="btn-file-action" id="preview-download-btn">Descargar</button><button type="button" class="btn-file-action" id="preview-rename-btn">Renombrar</button><button type="button" class="btn-file-action" id="preview-move-btn">Mover</button><button type="button" class="btn-file-action btn-file-action-danger" id="preview-delete-btn">Eliminar</button></div>
                    <div class="models-preview-stage" id="model-preview-box"><div class="preview-image" id="preview-image"><div class="preview-image-placeholder">3D</div></div></div>
                    <div class="gcode-preview-insights"><div><span>Formato</span><strong id="models-preview-format">—</strong></div><div><span>Estado</span><strong id="models-preview-status">Listo</strong></div></div>
                    <button type="button" class="btn-file-action preview-goto-printer-btn models-goto-printer" id="preview-goto-printer-btn" hidden>Ir a la impresora</button>
                </div></aside>
            </div>
        </main>`;
}

installModernModelsLibraryMarkup();

const modelsGrid = document.getElementById('models');
const printersGrid = document.getElementById('printers-grid');
const lasersGrid = document.getElementById('lasers-grid');
const cncGrid = document.getElementById('cnc-grid');
const machinesColumns = document.getElementById('machines-columns');
const machinesMixedGrid = document.getElementById('machines-mixed-grid');
const devicesGroupModeBtn = document.getElementById('devices-group-mode-btn');
const deviceColumnsCustomizerBtn = document.getElementById('device-columns-customizer-btn');
const printerCardCustomizerBtn = document.getElementById('printer-card-customizer-btn');
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
let printersLoading = false;
const boundPrinterCards = new WeakSet();
const boundMarlinCards = new WeakSet();
const boundStandaloneCards = new WeakSet();
const boundStandaloneActionButtons = new WeakSet();
const boundLaserCards = new WeakSet();
const boundQuickActionButtons = new WeakSet();
const boundMarlinTemperatureButtons = new WeakSet();
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

// ── Cajón de navegación en mobile ──
// El sidebar se convierte en un cajón deslizable por debajo de 768px (ver
// CSS). Este botón/backdrop solo existen visualmente en ese breakpoint,
// pero los listeners se registran siempre (no estorban en escritorio).
const mobileNavToggleBtn = document.getElementById('mobile-nav-toggle-btn');
const mobileNavBackdrop = document.getElementById('mobile-nav-backdrop');

function setMobileNavOpen(open) {
    const shell = document.querySelector('.app-shell');
    if (shell) shell.classList.toggle('mobile-nav-open', open);
    if (mobileNavToggleBtn) mobileNavToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

if (mobileNavToggleBtn) {
    mobileNavToggleBtn.addEventListener('click', () => {
        const shell = document.querySelector('.app-shell');
        setMobileNavOpen(!shell?.classList.contains('mobile-nav-open'));
    });
}

if (mobileNavBackdrop) {
    mobileNavBackdrop.addEventListener('click', () => setMobileNavOpen(false));
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMobileNavOpen(false);
});

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
    const locale = { es: 'es-MX', en: 'en-US', 'pt-BR': 'pt-BR', fr: 'fr-FR', de: 'de-DE' }[currentLanguage] || 'es-MX';
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
    // Distancia relativa a donde el caller ya dejó la cámara (proporcional al
    // tamaño real de la pieza, mm o cm según el caso) en vez de límites
    // absolutos fijos -- esos rompían el zoom en piezas grandes (G-code de
    // impresora, decenas/cientos de mm: la primera rueda de mouse hacía un
    // salto brusco al tope). Además escala los 3 ejes de la posición, no solo
    // Z, para no desviar el ángulo de vista al hacer zoom.
    const baseDistance = camera.position.length() || 1;
    const minDistance = baseDistance * 0.2;
    const maxDistance = baseDistance * 5;
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
        const factor = event.deltaY > 0 ? 1.1 : 0.9;
        const newDistance = Math.max(minDistance, Math.min(maxDistance, camera.position.length() * factor));
        camera.position.setLength(newDistance);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
}

// Vista previa de G-code de IMPRESORA 3D (a diferencia de renderGcodePreview,
// pensada para láser/CNC en el plano XY con cámara ortográfica fija desde
// arriba): acá la pieza tiene volumen real en Z, así que hace falta cámara en
// perspectiva y poder rotarla — mismo criterio que ya usa setupPreviewControls
// para STL/3MF. Centrar la trayectoria en su propio bounding box (no en el
// origen de la cama) es lo que permite verla desde cualquier ángulo sin que
// se salga del cuadro.
async function renderPrinterGcodePreview(container, fileUrl) {
    if (!container || !window.THREE || typeof window.THREE.Scene !== 'function') return;
    container.innerHTML = '';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x081410);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
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

    const box = new THREE.Box3().setFromObject(line);
    const center = new THREE.Vector3();
    box.getCenter(center);
    line.position.sub(center);
    scene.add(line);

    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    camera.position.set(maxDim * 1.1, maxDim * 0.9, maxDim * 1.3);
    camera.lookAt(0, 0, 0);

    const resize = () => {
        const width = container.clientWidth || 320;
        const height = container.clientHeight || 320;
        renderer.setSize(width, height);
        camera.aspect = width / height || 1;
        camera.updateProjectionMatrix();
    };

    setupPreviewControls(renderer, camera, scene, line);

    const animate = () => {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    };
    resize();
    animate();
    window.addEventListener('resize', resize);
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
        previewImage.style.backgroundImage = 'none';
        previewImage.classList.add('gcode-mode');
        // A diferencia del visor de G-code de la biblioteca de Archivos
        // (láser/CNC, plano en XY con cámara ortográfica fija), acá el
        // G-code es de una impresora 3D real: la pieza tiene volumen en Z,
        // así que necesita perspectiva y poder rotarla desde cualquier
        // ángulo -- ver renderPrinterGcodePreview.
        renderPrinterGcodePreview(previewImage, fileUrl);
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

function hexToRgbTriplet(hex) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!match) return '34, 197, 94';
    const [, r, g, b] = match;
    return `${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}`;
}

/* ---------------------------------------------------------------
   Utilidades de color para el tema custom.

   Los cuatro temas base (claro, dark, green, red) viven completos en la
   capa de tokens de style.css y no necesitan nada de JS. El tema custom es
   el único que se arma en runtime, porque el usuario solo elige cuatro
   colores (accent, superficie, texto, texto tenue) y de ahí hay que derivar
   el resto de los tokens semánticos: elevación, bordes y una versión del
   accent que sea legible como texto sobre su propia superficie.
   --------------------------------------------------------------- */

function parseHex(hex) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!match) return null;
    return [1, 2, 3].map((i) => parseInt(match[i], 16));
}

function toHex(rgb) {
    return '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}

// Luminancia relativa segun WCAG 2.1.
function relativeLuminance(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return 0;
    const [r, g, b] = rgb.map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Mezcla lineal entre dos colores. ratio 0 = a, 1 = b.
function mixColors(a, b, ratio) {
    const ca = parseHex(a);
    const cb = parseHex(b);
    if (!ca || !cb) return a;
    return toHex(ca.map((v, i) => v + (cb[i] - v) * ratio));
}

// Acerca un color a blanco o negro hasta que alcance el contraste pedido
// contra la superficie. Sirve para que el accent elegido por el usuario siga
// siendo legible como texto aunque haya escogido, por ejemplo, un amarillo
// claro sobre una superficie clara.
function ensureContrast(color, against, target) {
    const towards = relativeLuminance(against) > 0.5 ? '#000000' : '#ffffff';
    let result = color;
    for (let step = 0; step <= 20; step++) {
        if (contrastRatio(result, against) >= target) return result;
        result = mixColors(color, towards, step / 20);
    }
    return result;
}

// Traduce los cuatro colores del tema custom al juego completo de tokens
// semanticos. Se escriben sobre <body> (no sobre <html>) porque la regla
// body.custom de style.css tambien vive ahi: el estilo inline le gana a la
// clase en el mismo elemento, que es justo lo que queremos.
function applyCustomThemeTokens(custom) {
    if (!custom) return;
    const surface = custom.surface || CUSTOM_THEME_DEFAULTS.surface;
    const text = custom.text || CUSTOM_THEME_DEFAULTS.text;
    const muted = custom.muted || CUSTOM_THEME_DEFAULTS.muted;
    const accent = custom.accent || CUSTOM_THEME_DEFAULTS.accent;
    const isDark = relativeLuminance(surface) < 0.5;
    // La superficie que eligio el usuario es la de las tarjetas; el lienzo de
    // la pagina se separa de ella para que las tarjetas se lean como tarjetas.
    const canvas = mixColors(surface, isDark ? '#000000' : '#0F172A', isDark ? 0.45 : 0.09);

    const tokens = {
        '--surface-raised': surface,
        '--surface-base': canvas,
        '--surface-sunken': mixColors(surface, canvas, 0.55),
        '--surface-nav': mixColors(surface, canvas, 0.3),
        '--text-strong': text,
        '--text-soft': muted,
        '--text-faint': muted,
        '--border-subtle': mixColors(surface, text, 0.14),
        '--border-control': ensureContrast(mixColors(surface, text, 0.4), surface, 3),
        '--accent-fill': accent,
        '--accent-fill-hover': mixColors(accent, isDark ? '#ffffff' : '#000000', 0.15),
        '--accent-fill-active': mixColors(accent, '#000000', 0.18),
        '--accent-ink': ensureContrast(accent, surface, 3),
        '--accent-on': contrastRatio(accent, '#0B0B0C') >= contrastRatio(accent, '#FFFFFF') ? '#0B0B0C' : '#FFFFFF',
        '--accent-fill-rgb': hexToRgbTriplet(accent),
        // Los estados no son configurables: rojo sigue significando error sin
        // importar que tema arme el usuario.
        '--status-ok': isDark ? '#4ADE80' : '#15803D',
        '--status-warn': isDark ? '#FBBF24' : '#B45309',
        '--status-danger': isDark ? '#F87171' : '#DC2626',
        '--status-info': isDark ? '#60A5FA' : '#1D4ED8',
    };
    Object.entries(tokens).forEach(([name, value]) => {
        document.body.style.setProperty(name, value);
    });
}

function clearCustomThemeTokens() {
    const names = [
        '--surface-raised', '--surface-base', '--surface-sunken', '--surface-nav',
        '--text-strong', '--text-soft', '--text-faint',
        '--border-subtle', '--border-control',
        '--accent-fill', '--accent-fill-hover', '--accent-fill-active',
        '--accent-ink', '--accent-on', '--accent-fill-rgb',
        '--status-ok', '--status-warn', '--status-danger', '--status-info',
    ];
    names.forEach((name) => document.body.style.removeProperty(name));
}

function applyTheme(theme) {
    let resolvedTheme = theme === 'custom' && getCustomTheme() ? 'custom' : theme;
    if (!['dark', 'green', 'red', 'custom', 'ai'].includes(resolvedTheme)) resolvedTheme = 'light';
    document.body.classList.remove('dark', 'green', 'red', 'custom', 'light', 'ai');
    document.body.classList.add(resolvedTheme);
    document.body.setAttribute('data-theme', resolvedTheme);
    applyCustomThemeBackground();

    // Los colores NO se escriben desde aqui. Los cuatro temas base viven
    // completos en la capa de tokens de style.css y se resuelven solos con la
    // clase que acabamos de poner en <body>. Antes esta funcion escribia
    // --bg/--card-bg/--text/--accent... inline sobre <html>, duplicando los
    // valores del CSS: en el tema claro el inline le ganaba a la regla :root,
    // asi que el stylesheet quedaba muerto, y --text-secondary terminaba
    // valiendo lo mismo que --text-muted en los cuatro temas.
    clearCustomThemeTokens();
    if (resolvedTheme === 'custom') applyCustomThemeTokens(getCustomTheme());

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
    // Hoisted -- definida más abajo junto al resto de la lógica de fondos
    // por tema, pero un cambio de tema (dropdown, ciclo, tarjeta) siempre
    // debe refrescar qué miniatura de fondo se ve "activa".
    if (typeof refreshWallpaperThumbActiveStates === 'function') refreshWallpaperThumbActiveStates();
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

    // Con selección múltiple activa, los botones de un solo archivo del
    // panel de vista previa (Renombrar/Mover/Eliminar) actúan sobre el
    // archivo previsualizado, no sobre los marcados -- ambiguo y confuso
    // (bug real: "Eliminar" del panel borraba solo uno en vez de los varios
    // marcados). Se deshabilitan mientras haya selección múltiple para
    // forzar el uso de Mover/Eliminar de esta barra, que sí opera sobre
    // todos los marcados.
    const singleFileBtnIds = section === 'gcode'
        ? ['gcode-rename-btn', 'gcode-move-btn', 'gcode-delete-btn']
        : ['preview-rename-btn', 'preview-move-btn', 'preview-delete-btn'];
    singleFileBtnIds.forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = selection.size > 0;
        btn.title = selection.size > 0 ? t('bulkActionsDisabledHint') : '';
    });
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
    if (!(await appConfirm(t('deleteFolderConfirm'), t('delete'), 'danger'))) return;

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
let gcodeSearchQuery = '';
let gcodeSortMode = localStorage.getItem('nopalGcodeSort') || 'name-asc';
let gcodeFilterMode = 'all';
let gcodeTagFilter = '';
let gcodeViewMode = localStorage.getItem('nopalGcodeView') || 'list';
let gcodePage = 1;
let gcodePathHistory = [''];
let gcodePathHistoryIndex = 0;
const GCODE_PAGE_SIZE = 8;
const GCODE_FAVORITES_KEY = 'nopalGcodeFavorites';
const GCODE_RECENTS_KEY = 'nopalGcodeRecents';

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

// Modern G-code library. It deliberately builds on the existing browse and
// file-action endpoints so this UI remains a presentation-only refactor.
function readGcodeLibraryItems(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(value) ? value : [];
    } catch (_) {
        return [];
    }
}

function writeGcodeLibraryItems(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function gcodeSnapshot(model) {
    return {
        id: model.id,
        name: model.name,
        path: stripSectionPrefix(model.id, 'gcode'),
        material: model.material || 'MDF',
        modified: model.modified || 0,
    };
}

function getGcodeFavorites() {
    return readGcodeLibraryItems(GCODE_FAVORITES_KEY);
}

function isGcodeFavorite(id) {
    return getGcodeFavorites().some(item => item.id === id);
}

function toggleGcodeFavorite(model) {
    if (!model) return;
    const favorites = getGcodeFavorites();
    const index = favorites.findIndex(item => item.id === model.id);
    if (index >= 0) favorites.splice(index, 1);
    else favorites.unshift(gcodeSnapshot(model));
    writeGcodeLibraryItems(GCODE_FAVORITES_KEY, favorites.slice(0, 50));
    renderGcodeTable();
}

function rememberRecentGcode(model) {
    const recent = readGcodeLibraryItems(GCODE_RECENTS_KEY).filter(item => item.id !== model.id);
    recent.unshift(gcodeSnapshot(model));
    writeGcodeLibraryItems(GCODE_RECENTS_KEY, recent.slice(0, 12));
}

function getGcodePathParent(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function recordGcodePath(path) {
    if (gcodePathHistory[gcodePathHistoryIndex] === path) return;
    gcodePathHistory = gcodePathHistory.slice(0, gcodePathHistoryIndex + 1);
    gcodePathHistory.push(path);
    gcodePathHistoryIndex = gcodePathHistory.length - 1;
}

async function loadGcodeFolder(path = currentGcodePath, options = {}) {
    const normalizedPath = String(path || '').replace(/^\/+|\/+$/g, '');
    if (options.recordHistory !== false) recordGcodePath(normalizedPath);
    currentGcodePath = normalizedPath;
    gcodePage = 1;
    try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(normalizedPath)}&type=gcode`);
        if (!response.ok) throw new Error('No se pudo cargar la carpeta');
        currentGcodeData = await response.json();
    } catch (error) {
        console.error(error);
        currentGcodeData = { folders: [], files: [] };
    }
    renderGcodeBreadcrumb();
    renderGcodeTable();
}

function renderGcodeBreadcrumb() {
    const breadcrumb = document.getElementById('gcode-breadcrumb');
    if (!breadcrumb) return;
    const parts = currentGcodePath.split('/').filter(Boolean);
    const segments = [
        { label: t('libraryRoot'), path: '' },
        { label: t('librarySection'), path: '' },
        { label: 'G-code', path: '' },
    ];
    parts.forEach((part, index) => segments.push({ label: part, path: parts.slice(0, index + 1).join('/') }));
    breadcrumb.innerHTML = segments.map(segment => `
        <button type="button" class="breadcrumb-segment" data-gcode-path="${escapeHtml(segment.path)}">${escapeHtml(segment.label)}</button>
    `).join('');
    breadcrumb.querySelectorAll('[data-gcode-path]').forEach(button => {
        button.addEventListener('click', () => loadGcodeFolder(button.dataset.gcodePath));
    });
    document.getElementById('gcode-nav-back')?.toggleAttribute('disabled', gcodePathHistoryIndex <= 0);
    document.getElementById('gcode-nav-forward')?.toggleAttribute('disabled', gcodePathHistoryIndex >= gcodePathHistory.length - 1);
    document.getElementById('gcode-nav-up')?.toggleAttribute('disabled', !currentGcodePath);
    const disk = document.getElementById('gcode-disk-free');
    if (disk) disk.textContent = t('libraryCounts').replace('{folders}', currentGcodeData.folders.length).replace('{files}', currentGcodeData.files.length);
}

function renderGcodeFolderStrip(folders) {
    const strip = document.getElementById('gcode-folder-strip');
    if (!strip) return;
    strip.hidden = folders.length === 0;
    strip.innerHTML = folders.map(folder => `
        <button type="button" class="gcode-folder-card" data-folder-path="${escapeHtml(folder.path)}">
            <svg width="29" height="29" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-9l-2-2Z"/></svg>
            <span><strong>${escapeHtml(folder.name)}</strong><small>${t('libraryItems').replace('{count}', Number(folder.file_count || 0).toLocaleString())}</small></span>
            <span class="gcode-folder-menu" aria-hidden="true">›</span>
        </button>
    `).join('');
    strip.querySelectorAll('[data-folder-path]').forEach(button => {
        button.addEventListener('click', () => loadGcodeFolder(button.dataset.folderPath));
    });
}

function getFilteredGcodeFiles() {
    const query = gcodeSearchQuery.trim().toLowerCase();
    const favoriteIds = new Set(getGcodeFavorites().map(item => item.id));
    const recentIds = new Set(readGcodeLibraryItems(GCODE_RECENTS_KEY).map(item => item.id));
    const files = currentGcodeData.files.filter(model => {
        if (query && !String(model.name || '').toLowerCase().includes(query)) return false;
        if (gcodeTagFilter && String(model.material || 'G-code').toLowerCase() !== gcodeTagFilter) return false;
        if (gcodeFilterMode === 'favorites' && !favoriteIds.has(model.id)) return false;
        if (gcodeFilterMode === 'recent' && !recentIds.has(model.id)) return false;
        return true;
    });
    return files.sort((a, b) => {
        if (gcodeSortMode === 'name-desc') return String(b.name).localeCompare(String(a.name), undefined, { sensitivity: 'base' });
        if (gcodeSortMode === 'date-desc') return Number(b.modified || 0) - Number(a.modified || 0);
        if (gcodeSortMode === 'date-asc') return Number(a.modified || 0) - Number(b.modified || 0);
        if (gcodeSortMode === 'size-desc') return Number(b.size || 0) - Number(a.size || 0);
        return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
    });
}

function renderGcodeSidebar() {
    const favorites = getGcodeFavorites();
    const recents = readGcodeLibraryItems(GCODE_RECENTS_KEY);
    const itemHtml = item => `
        <button type="button" class="gcode-sidebar-item" data-gcode-item="${escapeHtml(item.id)}">
            <span class="gcode-sidebar-icon">◇</span><span>${escapeHtml(item.name)}</span><b>GC</b>
        </button>`;
    const favoriteList = document.getElementById('gcode-favorites-list');
    const recentList = document.getElementById('gcode-recents-list');
    if (favoriteList) favoriteList.innerHTML = favorites.slice(0, 4).map(itemHtml).join('') || `<span class="gcode-sidebar-empty">${t('libraryNoFavorites')}</span>`;
    if (recentList) recentList.innerHTML = recents.slice(0, 5).map(itemHtml).join('') || `<span class="gcode-sidebar-empty">${t('libraryNoRecent')}</span>`;
    const tagCounts = new Map();
    currentGcodeData.files.forEach(model => {
        const tag = model.material || 'G-code';
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    });
    const tags = document.getElementById('gcode-tags-list');
    if (tags) tags.innerHTML = Array.from(tagCounts.entries()).map(([tag, count]) => `
        <button type="button" class="gcode-sidebar-item" data-gcode-tag="${escapeHtml(tag)}">
            <span class="gcode-sidebar-icon">◆</span><span>${escapeHtml(tag)}</span><b>${count}</b>
        </button>`).join('') || `<span class="gcode-sidebar-empty">${t('libraryNoTags')}</span>`;
    document.querySelectorAll('[data-gcode-item]').forEach(button => {
        button.addEventListener('click', async () => {
            const snapshot = [...favorites, ...recents].find(item => item.id === button.dataset.gcodeItem);
            if (!snapshot) return;
            const parent = getGcodePathParent(snapshot.path);
            if (parent !== currentGcodePath) await loadGcodeFolder(parent);
            const model = currentGcodeData.files.find(item => item.id === snapshot.id);
            if (model) selectGcodePreview(model);
        });
    });
    tags?.querySelectorAll('[data-gcode-tag]').forEach(button => {
        button.addEventListener('click', () => {
            gcodeTagFilter = button.dataset.gcodeTag.toLowerCase();
            gcodeSearchQuery = '';
            if (searchGcodeInput) searchGcodeInput.value = '';
            gcodePage = 1;
            renderGcodeTable();
        });
    });
}

function renderGcodePagination(totalItems, totalPages) {
    const pagination = document.getElementById('gcode-pagination');
    if (!pagination) return;
    if (!totalItems) {
        pagination.innerHTML = `<span>${t('libraryZeroResults')}</span>`;
        return;
    }
    const start = (gcodePage - 1) * GCODE_PAGE_SIZE + 1;
    const end = Math.min(gcodePage * GCODE_PAGE_SIZE, totalItems);
    const pages = Array.from({ length: totalPages }, (_, index) => index + 1)
        .filter(page => page === 1 || page === totalPages || Math.abs(page - gcodePage) <= 1);
    let previousPage = 0;
    const pageButtons = pages.map(page => {
        const gap = previousPage && page - previousPage > 1 ? '<span>…</span>' : '';
        previousPage = page;
        return `${gap}<button type="button" class="${page === gcodePage ? 'active' : ''}" data-gcode-page="${page}">${page}</button>`;
    }).join('');
    pagination.innerHTML = `
        <span>${t('libraryResults').replace('{start}', start).replace('{end}', end).replace('{total}', totalItems)}</span>
        <div class="gcode-pagination-pages"><button type="button" data-gcode-page="${gcodePage - 1}" ${gcodePage === 1 ? 'disabled' : ''}>‹</button>${pageButtons}<button type="button" data-gcode-page="${gcodePage + 1}" ${gcodePage === totalPages ? 'disabled' : ''}>›</button></div>
        <span>${t('libraryPerPage').replace('{count}', GCODE_PAGE_SIZE)}</span>`;
    pagination.querySelectorAll('[data-gcode-page]').forEach(button => {
        button.addEventListener('click', () => {
            const page = Number(button.dataset.gcodePage);
            if (page < 1 || page > totalPages || page === gcodePage) return;
            gcodePage = page;
            renderGcodeTable();
        });
    });
}

function renderGcodeTable(filterQuery = gcodeSearchQuery) {
    const gcodeTable = document.getElementById('gcode-table');
    if (!gcodeTable) return;
    gcodeSearchQuery = filterQuery || '';
    const folderQuery = gcodeSearchQuery.toLowerCase();
    renderGcodeFolderStrip(currentGcodeData.folders.filter(folder => !folderQuery || folder.name.toLowerCase().includes(folderQuery)));
    renderGcodeSidebar();
    renderGcodeBreadcrumb();
    const files = getFilteredGcodeFiles();
    const totalPages = Math.max(1, Math.ceil(files.length / GCODE_PAGE_SIZE));
    gcodePage = Math.min(gcodePage, totalPages);
    const pageFiles = files.slice((gcodePage - 1) * GCODE_PAGE_SIZE, gcodePage * GCODE_PAGE_SIZE);
    gcodeTable.classList.toggle('is-grid', gcodeViewMode === 'grid');
    document.getElementById('gcode-view-list')?.classList.toggle('active', gcodeViewMode === 'list');
    document.getElementById('gcode-view-grid')?.classList.toggle('active', gcodeViewMode === 'grid');
    renderGcodePagination(files.length, totalPages);
    if (!files.length) {
        gcodeTable.innerHTML = `<div class="empty-state">${t('noFilesFound')}</div>`;
        return;
    }
    if (!selectedGcodeId || !files.some(entry => entry.id === selectedGcodeId)) selectedGcodeId = pageFiles[0]?.id || null;
    const fileRows = pageFiles.map(model => {
        const cachedDimensions = gcodeDimensionsCache.get(model.file_url);
        const checked = getBulkSelection('gcode').has(model.id) ? 'checked' : '';
        return `
            <tr class="${model.id === selectedGcodeId ? 'selected' : ''}" data-model-id="${escapeHtml(model.id)}">
                <td class="select-col"><input type="checkbox" class="row-select-checkbox" data-model-id="${escapeHtml(model.id)}" ${checked}></td>
                <td class="model-name"><img class="cnc-files-thumb" loading="lazy" alt="" src="/api/gcode/thumbnail?path=${encodeURIComponent(stripSectionPrefix(model.id, 'gcode'))}&kind=printer"><strong>${escapeHtml(model.name)}</strong>${isGcodeFavorite(model.id) ? '<span class="gcode-file-favorite">★</span>' : ''}</td>
                <td><span class="tag-pill">${escapeHtml(model.material || 'MDF')}</span></td>
                <td>${formatSize(model.size)}</td><td>${formatDate(model.modified)}</td>
                <td class="gcode-dimensions">${cachedDimensions !== undefined ? formatGcodeDimensions(cachedDimensions) : '…'}</td>
                <td><span class="gcode-status-ok" title="${t('libraryAvailable')}">✓</span></td>
                <td><button type="button" class="gcode-row-menu" data-row-menu title="${t('libraryActions')}">•••</button></td>
            </tr>`;
    }).join('');
    gcodeTable.innerHTML = `<table class="models-table"><thead><tr>
        <th class="select-col"><input type="checkbox" class="select-all-checkbox" id="gcode-select-all"></th>
        <th>${t('columnName')}</th><th>${t('material')}</th><th>${t('columnSize')}</th><th>${t('columnDate')}</th><th>${t('columnDimensions')}</th><th>${t('libraryStatus')}</th><th aria-label="${t('libraryActions')}">•••</th>
        </tr></thead><tbody>${fileRows}</tbody></table>`;
    wireBulkSelection('gcode', gcodeTable, pageFiles);
    gcodeTable.querySelectorAll('tbody tr[data-model-id]').forEach(row => {
        row.addEventListener('click', event => {
            if (event.target.closest('.row-select-checkbox')) return;
            const model = currentGcodeData.files.find(entry => entry.id === row.dataset.modelId);
            if (model) selectGcodePreview(model);
        });
        row.querySelector('[data-row-menu]')?.addEventListener('click', event => {
            event.stopPropagation();
            const model = currentGcodeData.files.find(entry => entry.id === row.dataset.modelId);
            if (model) selectGcodePreview(model);
        });
        // Un raster de imagen grande puede tardar varios segundos en
        // generarse la primera vez (ver thumbnail_service) -- si esa
        // solicitud se cae o se cancela (p.ej. el usuario cambió de vista
        // antes de que terminara), el <img> se queda en blanco para
        // siempre sin este fallback, porque no hay reintento automático.
        const thumbImg = row.querySelector('.cnc-files-thumb');
        const rowModel = currentGcodeData.files.find(entry => entry.id === row.dataset.modelId);
        if (thumbImg && rowModel) {
            thumbImg.addEventListener('error', () => {
                const replacement = document.createElement('div');
                replacement.className = 'cnc-files-thumb';
                thumbImg.replaceWith(replacement);
                renderGcodeThumbnail(replacement, rowModel.file_url);
            }, { once: true });
        }
    });
    pageFiles.forEach(model => {
        if (gcodeDimensionsCache.has(model.file_url)) return;
        getGcodeDimensions(model.file_url).then(dimensions => {
            const row = Array.from(gcodeTable.querySelectorAll('tbody tr[data-model-id]')).find(item => item.dataset.modelId === model.id);
            const cell = row?.querySelector('.gcode-dimensions');
            if (cell) cell.textContent = formatGcodeDimensions(dimensions);
        });
    });
    const selectedModel = files.find(entry => entry.id === selectedGcodeId);
    if (selectedModel) selectGcodePreview(selectedModel, false);
}

async function selectGcodePreview(model, rerender = true) {
    if (!model) return;
    selectedGcodeId = model.id;
    rememberRecentGcode(model);
    const fileUrl = model.file_url;
    if (gcodePreviewTitle) gcodePreviewTitle.textContent = model.name;
    if (gcodePreviewDescription) gcodePreviewDescription.textContent = model.description || t('libraryGcodePreviewHelp');
    if (gcodePreviewSize) gcodePreviewSize.textContent = formatSize(model.size);
    if (gcodePreviewDate) gcodePreviewDate.textContent = formatDate(model.modified);
    const material = document.getElementById('gcode-preview-material');
    const estimatedTime = document.getElementById('gcode-preview-time');
    const favoriteButton = document.getElementById('gcode-preview-favorite');
    if (material) material.textContent = model.material || 'MDF';
    if (estimatedTime) estimatedTime.textContent = model.estimated_time || formatEstimatedTime(model.estimated_time_minutes);
    if (favoriteButton) {
        const favorite = isGcodeFavorite(model.id);
        favoriteButton.textContent = favorite ? '★' : '☆';
        favoriteButton.classList.toggle('active', favorite);
    }
    if (gcodePreviewLines) {
        const requestedId = model.id;
        getGcodeLineCount(fileUrl).then(lineCount => {
            if (selectedGcodeId === requestedId) gcodePreviewLines.textContent = lineCount.toLocaleString();
        });
    }
    getGcodeDimensions(fileUrl).then(dimensions => {
        if (!dimensions || selectedGcodeId !== model.id) return;
        const xValues = [0, dimensions.width / 2, dimensions.width];
        const yValues = [dimensions.height, dimensions.height / 2, 0];
        document.querySelectorAll('.gcode-preview-ruler-x i').forEach((label, index) => { label.textContent = Math.round(xValues[index] || 0); });
        document.querySelectorAll('.gcode-preview-ruler-y i').forEach((label, index) => { label.textContent = Math.round(yValues[index] || 0); });
    });
    if (gcodePreviewScene) {
        gcodePreviewScene.innerHTML = '';
        const img = document.createElement('img');
        img.alt = model.name;
        img.loading = 'lazy';
        img.onerror = () => renderGcodePreview(gcodePreviewScene, fileUrl);
        img.src = `/api/gcode/thumbnail?path=${encodeURIComponent(stripSectionPrefix(model.id, 'gcode'))}&kind=printer`;
        gcodePreviewScene.appendChild(img);
    }
    if (rerender) renderGcodeTable();
}

function updateGcodeSearch(query) {
    gcodeSearchQuery = query || '';
    gcodeTagFilter = '';
    gcodePage = 1;
    renderGcodeTable();
}

document.getElementById('gcode-nav-back')?.addEventListener('click', () => {
    if (gcodePathHistoryIndex <= 0) return;
    gcodePathHistoryIndex -= 1;
    loadGcodeFolder(gcodePathHistory[gcodePathHistoryIndex], { recordHistory: false });
});
document.getElementById('gcode-nav-forward')?.addEventListener('click', () => {
    if (gcodePathHistoryIndex >= gcodePathHistory.length - 1) return;
    gcodePathHistoryIndex += 1;
    loadGcodeFolder(gcodePathHistory[gcodePathHistoryIndex], { recordHistory: false });
});
document.getElementById('gcode-nav-up')?.addEventListener('click', () => loadGcodeFolder(getGcodePathParent(currentGcodePath)));
document.getElementById('gcode-nav-home')?.addEventListener('click', () => loadGcodeFolder(''));
document.getElementById('gcode-sort-select')?.addEventListener('change', event => {
    gcodeSortMode = event.target.value;
    localStorage.setItem('nopalGcodeSort', gcodeSortMode);
    gcodePage = 1;
    renderGcodeTable();
});
document.getElementById('gcode-filter-select')?.addEventListener('change', event => {
    gcodeFilterMode = event.target.value;
    gcodeTagFilter = '';
    gcodePage = 1;
    renderGcodeTable();
});
document.querySelectorAll('[data-view]').forEach(button => {
    if (!button.id.startsWith('gcode-view-')) return;
    button.addEventListener('click', () => {
        gcodeViewMode = button.dataset.view;
        localStorage.setItem('nopalGcodeView', gcodeViewMode);
        renderGcodeTable();
    });
});
document.getElementById('gcode-favorites-all')?.addEventListener('click', () => {
    gcodeFilterMode = 'favorites';
    const select = document.getElementById('gcode-filter-select');
    if (select) select.value = 'favorites';
    gcodePage = 1;
    renderGcodeTable();
});
document.getElementById('gcode-recents-all')?.addEventListener('click', () => {
    gcodeFilterMode = 'recent';
    const select = document.getElementById('gcode-filter-select');
    if (select) select.value = 'recent';
    gcodePage = 1;
    renderGcodeTable();
});
document.getElementById('gcode-preview-favorite')?.addEventListener('click', () => {
    toggleGcodeFavorite(currentGcodeData.files.find(entry => entry.id === selectedGcodeId));
});
const gcodeSortSelect = document.getElementById('gcode-sort-select');
if (gcodeSortSelect) gcodeSortSelect.value = gcodeSortMode;
document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const section = document.getElementById('gcode-section');
        if (section?.classList.contains('active') || section?.style.display !== 'none') {
            event.preventDefault();
            searchGcodeInput?.focus();
        }
    }
});

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

/* Estado térmico decorativo de las fichas de impresora. Se deriva siempre de
   las temperaturas y objetivos que ya entrega cada controlador; no mantiene
   un estado paralelo ni crea temporizadores por impresora. */

const PRINTER_THERMAL_IDLE_COLOR = 'rgb(34, 197, 94)';
const PRINTER_THERMAL_ERROR_COLOR = 'rgb(239, 68, 68)';
const PRINTER_THERMAL_OFFLINE_COLOR = 'rgb(148, 163, 184)';

// Blanco→rojo en 10 escalones (no interpolación continua) — "cambia de tono
// cada 10% de temperatura" en vez de un degradado liso.
function interpolateHeatingWhiteToRed(percent) {
    const stepped = Math.floor(Math.max(0, Math.min(100, percent)) / 10) * 10;
    const ratio = stepped / 100;
    const from = [255, 255, 255];
    const to = [239, 68, 68];
    const color = from.map((channel, index) => Math.round(channel + (to[index] - channel) * ratio));
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

// Semilla estable (puerto/host) para el retraso negativo de la animación —
// sin esto, como renderPrinters() reconstruye toda la grilla en cada sondeo
// (cada 5s) y las olas duran 9-15s, la animación nunca llega a completar un
// ciclo: siempre vuelve al fotograma 0 y se ve como un "salto" repetido en
// vez de un movimiento continuo. Con un delay negativo fijo por tarjeta, el
// nuevo elemento nace ya "a mitad de camino" en el mismo punto de siempre,
// que se percibe fluido aunque el nodo se haya recreado.
function thermalDelaySeed(seed) {
    if (seed == null) return 0;
    const text = String(seed);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    return -(Math.abs(hash) % 15);
}

function renderThermalLayer(modifierClasses, thermalColor, strength, seed) {
    const delay = thermalDelaySeed(seed);
    return `
        <div class="printer-thermal-layer ${modifierClasses}" aria-hidden="true"
             style="--thermal-color:${thermalColor};--thermal-strength:${strength.toFixed(3)};--thermal-delay:${delay}s">
            <svg class="printer-thermal-waves" viewBox="0 0 800 150" preserveAspectRatio="none" focusable="false">
                <path class="printer-thermal-wave printer-thermal-wave-a" d="M-160 78 C-60 18 40 138 140 78 S340 18 440 78 S640 138 740 78 S940 18 1040 78"/>
                <path class="printer-thermal-wave printer-thermal-wave-b" d="M-180 96 C-70 48 20 142 130 92 S330 42 430 94 S630 146 730 90 S930 42 1040 94"/>
                <path class="printer-thermal-wave printer-thermal-wave-c" d="M-140 58 C-45 108 55 16 155 62 S355 112 455 58 S655 12 755 64 S955 110 1050 58"/>
            </svg>
        </div>
    `;
}

function printerThermalWaves(bedActual, extruderActual, bedTarget, extruderTarget, printState, isOffline = false, seed = null) {
    const actualValues = [bedActual, extruderActual].filter(Number.isFinite);
    if (!actualValues.length && !isOffline) return '';

    if (isOffline) {
        return renderThermalLayer('thermal-offline is-thermal-offline', PRINTER_THERMAL_OFFLINE_COLOR, 0.32, seed);
    }

    const thermalValue = Math.max(...actualValues);
    const activeHeaters = [
        { actual: bedActual, target: bedTarget },
        { actual: extruderActual, target: extruderTarget },
    ].filter(heater => Number.isFinite(heater.actual) && Number.isFinite(heater.target) && heater.target > 0);
    const isActivelyHeating = activeHeaters.some(heater => heater.actual < heater.target - 3);
    const isStable = activeHeaters.length > 0 && activeHeaters.every(heater => Math.abs(heater.actual - heater.target) <= 3);
    const isError = printState === 'error';
    const thermalPhase = thermalValue < 40 ? 'cold' : thermalValue < 80 ? 'warm' : thermalValue < 215 ? 'heating' : 'hot';

    // Idle (sin target activo) = verde. Con un target activo (calentando o
    // sosteniendo) = blanco→rojo según qué tan alta es la temperatura real.
    let thermalColor;
    if (isError) {
        thermalColor = PRINTER_THERMAL_ERROR_COLOR;
    } else if (activeHeaters.length > 0) {
        thermalColor = interpolateHeatingWhiteToRed((thermalValue / 260) * 100);
    } else {
        thermalColor = PRINTER_THERMAL_IDLE_COLOR;
    }
    const strength = Math.min(0.5, 0.24 + (thermalValue / 260) * 0.22);
    const modifierClasses = [
        `thermal-${thermalPhase}`,
        isActivelyHeating ? 'is-actively-heating' : '',
        isStable ? 'is-thermal-stable' : '',
        isError ? 'is-thermal-error' : '',
    ].filter(Boolean).join(' ');

    return renderThermalLayer(modifierClasses, thermalColor, strength, seed);
}

// Versión simple (sin temperatura) para láser/CNC: verde en reposo, rojo si
// hay error, gris si está offline — mismo lenguaje visual que las impresoras.
function deviceStateThermalWave(visualState, seed = null) {
    if (visualState === 'offline') {
        return renderThermalLayer('thermal-offline is-thermal-offline', PRINTER_THERMAL_OFFLINE_COLOR, 0.32, seed);
    }
    const isError = visualState === 'error';
    const modifierClasses = isError ? 'thermal-hot is-thermal-error' : 'thermal-cold is-thermal-stable';
    const color = isError ? PRINTER_THERMAL_ERROR_COLOR : PRINTER_THERMAL_IDLE_COLOR;
    return renderThermalLayer(modifierClasses, color, 0.3, seed);
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
let temperatureMaterialPresets = null;
let temperaturePresetEditorData = null;
let materialPreheatTarget = null;

function normalizeTemperatureMaterialPresets(data) {
    if (Array.isArray(data?.materials)) return data;
    return { active: 'personalizado', materials: [{ id: 'personalizado', name: 'Personalizado', heater_bed: data?.heater_bed ?? 60, extruder: data?.extruder ?? 200 }] };
}

async function loadTemperatureMaterialPresets(force = false) {
    if (temperatureMaterialPresets && !force) return temperatureMaterialPresets;
    const response = await fetch('/api/system/temperature-presets');
    if (!response.ok) throw new Error('No se pudieron cargar los materiales');
    temperatureMaterialPresets = normalizeTemperatureMaterialPresets(await response.json());
    return temperatureMaterialPresets;
}

async function setMarlinHeaterTarget(device, heater, target) {
    const formData = new FormData();
    formData.append('device', device);
    formData.append('heater', heater);
    formData.append('target', target);
    const response = await fetch('/api/marlin-printers/temperature-target', { method: 'POST', body: formData });
    if (!response.ok) throw new Error('No se pudo actualizar la temperatura Marlin');
}

async function applyMaterialPreheat(material) {
    if (!materialPreheatTarget) return;
    const target = materialPreheatTarget;
    const heaters = target.heaters || ['heater_bed', 'extruder'];
    await Promise.all(heaters.map(heater => {
        const value = material[heater === 'heater_bed' ? 'heater_bed' : 'extruder'];
        return target.type === 'marlin' ? setMarlinHeaterTarget(target.id, heater, value) : setTemperatureTarget(target.id, heater, value);
    }));
    document.getElementById('material-preheat-modal')?.classList.remove('active');
    showToast(`${material.name}: cama ${material.heater_bed}°C · boquilla ${material.extruder}°C`);
}

async function openMaterialPreheatModal(target) {
    materialPreheatTarget = target;
    const modal = document.getElementById('material-preheat-modal');
    const list = document.getElementById('material-preheat-list');
    document.getElementById('material-preheat-machine').textContent = `${target.name || 'Impresora'} · selecciona el material cargado`;
    list.innerHTML = '<div class="machine-led-loading">Cargando materiales…</div>';
    modal.classList.add('active');
    try {
        const presets = await loadTemperatureMaterialPresets();
        list.innerHTML = presets.materials.map(material => `<button type="button" class="material-preheat-option" data-material-id="${escapeHtml(material.id)}"><strong>${escapeHtml(material.name)}</strong><span><b>${material.extruder}°</b> boquilla</span><span><b>${material.heater_bed}°</b> cama</span></button>`).join('');
        list.querySelectorAll('[data-material-id]').forEach(button => button.addEventListener('click', async () => {
            const material = presets.materials.find(item => item.id === button.dataset.materialId);
            button.disabled = true;
            try { await applyMaterialPreheat(material); } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
        }));
    } catch (error) {
        list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
}

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
        presetBtn.addEventListener('click', () => {
            temperatureCardThemeMode = 'warm';
            openMaterialPreheatModal({ type: 'klipper', id: port, name: 'Impresora Klipper', heaters: heaterSensors.map(sensor => sensor.key) });
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

    let presets = modal.classList.contains('active') ? temperaturePresetEditorData : null;
    if (!presets) {
        try {
            presets = await loadTemperatureMaterialPresets(true);
        } catch (error) {
            console.error(error);
        }
    }

    temperaturePresetEditorData = presets || { active: 'pla', materials: [] };
    fieldsEl.innerHTML = `<div class="material-preset-editor-list">${temperaturePresetEditorData.materials.map((material, index) => `
        <div class="material-preset-editor-row" data-material-row="${index}">
            <input type="text" data-material-field="name" value="${escapeHtml(material.name)}" aria-label="Nombre del material">
            <label><span>Boquilla</span><input type="number" data-material-field="extruder" value="${material.extruder}" min="0" max="400"><small>°C</small></label>
            <label><span>Cama</span><input type="number" data-material-field="heater_bed" value="${material.heater_bed}" min="0" max="200"><small>°C</small></label>
            <button type="button" class="material-preset-remove" data-material-remove="${index}" aria-label="Eliminar material">×</button>
        </div>`).join('')}</div><button type="button" class="btn-file-action material-preset-add" id="material-preset-add">+ Agregar material</button>`;
    fieldsEl.querySelectorAll('[data-material-remove]').forEach(button => button.addEventListener('click', () => {
        temperaturePresetEditorData.materials.splice(Number(button.dataset.materialRemove), 1);
        temperatureMaterialPresets = temperaturePresetEditorData;
        openTempPresetsModal(heaterSensors);
    }));
    document.getElementById('material-preset-add')?.addEventListener('click', () => {
        temperaturePresetEditorData.materials.push({ id: `material-${Date.now()}`, name: 'Nuevo material', heater_bed: 60, extruder: 200 });
        temperatureMaterialPresets = temperaturePresetEditorData;
        openTempPresetsModal(heaterSensors);
    });

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
        const materials = [];
        fieldsEl.querySelectorAll('[data-material-row]').forEach((row, index) => {
            const previous = temperaturePresetEditorData.materials[index] || {};
            materials.push({
                id: previous.id || `material-${index + 1}`,
                name: row.querySelector('[data-material-field="name"]').value.trim(),
                extruder: Number(row.querySelector('[data-material-field="extruder"]').value),
                heater_bed: Number(row.querySelector('[data-material-field="heater_bed"]').value),
            });
        });
        const presets = { active: temperaturePresetEditorData.active || materials[0]?.id, materials };
        try {
            const formData = new FormData();
            formData.append('presets', JSON.stringify(presets));
            const response = await fetch('/api/system/temperature-presets', { method: 'POST', body: formData });
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'No se pudieron guardar los materiales');
            temperatureMaterialPresets = presets;
            closeTempPresetsModal();
        } catch (error) {
            showToast(error.message, 'error');
        }
    });
}

['material-preheat-modal-close', 'material-preheat-modal-backdrop'].forEach(id => document.getElementById(id)?.addEventListener('click', () => document.getElementById('material-preheat-modal')?.classList.remove('active')));
document.getElementById('material-preheat-configure')?.addEventListener('click', () => {
    document.getElementById('material-preheat-modal')?.classList.remove('active');
    openTempPresetsModal([]);
});

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

const PANEL_GAUGE_RADIUS = 40;
const PANEL_GAUGE_CIRCUMFERENCE = 2 * Math.PI * PANEL_GAUGE_RADIUS;

// Íconos de línea (16px, stroke=currentColor) para las celdas del panel de
// control. Genéricos a propósito (nada de logos de marca, ej. Debian).
const TOPBAR_ICON_ACTIVITY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
const TOPBAR_ICON_CHIP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>';
const PANEL_ICON_SHIELD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const PANEL_ICON_SERVER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="7" rx="1"/><rect x="2" y="14" width="20" height="7" rx="1"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/></svg>';
const PANEL_ICON_CLOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const PANEL_ICON_REFRESH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const PANEL_ICON_DISK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="11" cy="5" rx="8" ry="3"/><path d="M3 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M3 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>';
const PANEL_ICON_PRINTER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
const PANEL_ICON_LASER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6"/><path d="M5 22h14l-1.5-9h-11z"/><path d="M9 13v3"/><path d="M15 13v3"/></svg>';
const PANEL_ICON_CNC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M12 6c0-2-2-3-2-3M12 8c0-2 2-3 2-3"/><path d="M8 12h8l-2 10h-4z"/></svg>';
const PANEL_ICON_CAMERA = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

// Íconos ilustrados (PNG subidos por el usuario) para las tarjetas de
// dispositivos conectados y de alertas — reemplazan los SVG de línea solo
// en esos dos lugares; los SVG de arriba se conservan para los íconos
// chicos de "Trabajos en curso", que no se tocaron.
const PANEL_DEVICE_ICON_PRINTER = '<img src="/static/img/panel-icon-printer.png" alt="" class="panel-device-icon-img">';
const PANEL_DEVICE_ICON_LASER = '<img src="/static/img/panel-icon-laser.png" alt="" class="panel-device-icon-img">';
const PANEL_DEVICE_ICON_CNC = '<img src="/static/img/panel-icon-cnc.png" alt="" class="panel-device-icon-img">';
const PANEL_DEVICE_ICON_CAMERA = '<img src="/static/img/panel-icon-camera.png" alt="" class="panel-device-icon-img">';
const PANEL_ALERT_ICON_ERROR = '<img src="/static/img/panel-icon-alert-critical.png" alt="" class="panel-alert-icon-img">';
const PANEL_ALERT_ICON_WARNING = '<img src="/static/img/panel-icon-alert-warning.png" alt="" class="panel-alert-icon-img">';
const PANEL_ALERT_ICON_INFO = '<img src="/static/img/panel-icon-alert-info.png" alt="" class="panel-alert-icon-img">';

const PANEL_DEVICE_TYPES = [
    { key: 'printer', icon: PANEL_DEVICE_ICON_PRINTER, labelKey: 'printerType3D' },
    { key: 'laser', icon: PANEL_DEVICE_ICON_LASER, labelKey: 'laser' },
    { key: 'cnc', icon: PANEL_DEVICE_ICON_CNC, labelKey: 'cnc' },
    { key: 'camera', icon: PANEL_DEVICE_ICON_CAMERA, labelKey: 'navCameras' },
];

function panelInfoRow(icon, label, value, valueClass) {
    return `
        <div class="panel-info-row">
            ${icon}
            <div class="panel-info-row-text">
                <span class="panel-info-row-label">${label}</span>
                <span class="panel-info-row-value${valueClass ? ` ${valueClass}` : ''}">${value}</span>
            </div>
        </div>`;
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function panelHealthLabel(health) {
    if (health === 'error') return t('panelHealthBad');
    if (health === 'warning') return t('panelHealthWarning');
    return t('panelHealthGood');
}

function renderPanelHealth(data) {
    const system = data.system || {};
    const grid = document.getElementById('panel-health-grid');
    if (grid) {
        const uptimeText = system.uptime_seconds != null ? formatUptime(system.uptime_seconds) : '—';
        const updateText = system.update_status === 'update_available' ? t('panelUpdateAvailable') : t('panelUpdateUpToDate');
        const health = computeEffectiveHealth();
        const healthValueClass = health === 'error' ? 'panel-info-row-value-error'
            : health === 'warning' ? 'panel-info-row-value-warning'
            : '';
        grid.innerHTML = [
            panelInfoRow(PANEL_ICON_SHIELD, t('panelHealthLabel'), panelHealthLabel(health), healthValueClass),
            panelInfoRow(PANEL_ICON_SERVER, t('panelServicesLabel'), `${system.services_online ?? 0} / ${system.services_total ?? 0}`),
            panelInfoRow(PANEL_ICON_CLOCK, t('panelUptimeLabel'), uptimeText),
            panelInfoRow(PANEL_ICON_REFRESH, t('panelUpdatesLabel'), updateText),
        ].join('');
    }

    updateStatusPill();
}

// Aplica el estado (color/texto/parpadeo/indicador de actualización) al pill
// del panel superior. Separado de renderPanelHealth para poder refrescarlo
// al instante al descartar una alerta, sin esperar al próximo poll de
// /api/system (loadDashboardPanel) que es el que trae `data.system`.
function updateStatusPill() {
    const pill = document.getElementById('panel-status-pill');
    const pillText = document.getElementById('panel-status-text');
    if (!pill || !pillText) return;
    const health = computeEffectiveHealth();
    pill.classList.remove('panel-status-ok', 'panel-status-warning', 'panel-status-error');
    pill.classList.add(`panel-status-${health}`);
    pillText.textContent = health === 'error' ? t('panelSystemError')
        : health === 'warning' ? t('panelSystemWarning')
        : t('panelSystemActive');
    // Parpadea solo cuando hay algo crítico en impresoras/láser/CNC sin
    // descartar -- "error" es la única severidad que esas fuentes usan hoy
    // (ver notification_service.py), así que health==='error' ya implica eso.
    pill.classList.toggle('panel-status-blink', health === 'error');
    pill.classList.toggle('panel-status-has-update', !!getUpdateNotification());
}

function getCriticalDeviceAlerts() {
    const dismissed = getDismissedAlertIds();
    return (lastNotificationsData.items || []).filter(item =>
        item.severity === 'error' && (item.source === 'printer' || item.source === 'laser')
        && !(item.id && dismissed.has(item.id)));
}

function getUpdateNotification() {
    return (lastNotificationsData.items || []).find(item => item.source === 'update');
}

function closePanelStatusPopup() {
    document.getElementById('panel-status-popup')?.remove();
}

function openPanelStatusPopup(alerts, updateItem) {
    closePanelStatusPopup();
    const pill = document.getElementById('panel-status-pill');
    if (!pill) return;
    const popup = document.createElement('div');
    popup.id = 'panel-status-popup';
    popup.className = 'panel-status-popup';
    popup.innerHTML = `
        <div class="panel-status-popup-header">${escapeHtml(t('panelCriticalPopupTitle'))}</div>
        ${alerts.map((alert, index) => `
            <div class="panel-status-popup-item">
                <button type="button" class="panel-status-popup-item-main" data-alert-index="${index}">
                    ${PANEL_ALERT_ICON_ERROR}
                    <span>${escapeHtml(alert.message)}</span>
                </button>
                ${alert.id ? `<button type="button" class="panel-status-popup-dismiss" data-dismiss-id="${escapeHtml(alert.id)}" title="${escapeHtml(t('panelAlertDismiss'))}" aria-label="${escapeHtml(t('panelAlertDismiss'))}">&times;</button>` : ''}
            </div>
        `).join('')}
        ${updateItem ? `
            <button type="button" class="panel-status-popup-update">
                ${PANEL_ALERT_ICON_INFO}
                <span>${escapeHtml(updateItem.message)}</span>
                <span class="panel-status-popup-update-badge">${escapeHtml(t('panelUpdateAvailable'))}</span>
            </button>
        ` : ''}`;
    pill.appendChild(popup);
    popup.querySelectorAll('.panel-status-popup-item-main').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            goToNotificationTarget(alerts[Number(btn.dataset.alertIndex)]);
            closePanelStatusPopup();
        });
    });
    popup.querySelectorAll('.panel-status-popup-dismiss').forEach(btn => {
        btn.addEventListener('click', event => {
            event.stopPropagation();
            dismissAlert(btn.dataset.dismissId);
            updateStatusPill();
            updateStatusTabTitle();
            const remaining = getCriticalDeviceAlerts();
            const update = getUpdateNotification();
            if (remaining.length || update) {
                openPanelStatusPopup(remaining, update);
            } else {
                closePanelStatusPopup();
            }
        });
    });
    const updateBtn = popup.querySelector('.panel-status-popup-update');
    if (updateBtn) {
        updateBtn.addEventListener('click', event => {
            event.stopPropagation();
            goToNotificationTarget(updateItem);
            closePanelStatusPopup();
        });
    }
}

document.getElementById('panel-status-pill')?.addEventListener('click', event => {
    event.stopPropagation();
    const alerts = getCriticalDeviceAlerts();
    const updateItem = getUpdateNotification();
    if (!alerts.length && !updateItem) return;
    if (document.getElementById('panel-status-popup')) {
        closePanelStatusPopup();
    } else {
        openPanelStatusPopup(alerts, updateItem);
    }
});
document.addEventListener('click', closePanelStatusPopup);

function panelGaugeHtml(valuePercent, colorClass, icon, label, displayValue, subtext) {
    const percent = Math.max(0, Math.min(100, valuePercent || 0));
    // Con valores reales pero minúsculos (ej. 0.03% de disco usado en uploads/
    // sobre un disco de 400+ GB) el anillo redondeaba a 0 y se veía igual que
    // "sin configurar" — un piso visual mínimo deja claro que sí hay dato.
    const visualPercent = percent > 0 && percent < 3 ? 3 : percent;
    const offset = PANEL_GAUGE_CIRCUMFERENCE - (visualPercent / 100) * PANEL_GAUGE_CIRCUMFERENCE;
    return `
        <div class="panel-gauge">
            <div class="panel-gauge-ring">
                <svg viewBox="0 0 96 96">
                    <circle class="gauge-track" cx="48" cy="48" r="${PANEL_GAUGE_RADIUS}"/>
                    <circle class="gauge-fill ${colorClass}" cx="48" cy="48" r="${PANEL_GAUGE_RADIUS}" stroke-dasharray="${PANEL_GAUGE_CIRCUMFERENCE}" stroke-dashoffset="${offset}"/>
                </svg>
                <span class="gauge-value">${displayValue}</span>
            </div>
            <div class="panel-gauge-label">${icon}<span>${label}</span></div>
            ${subtext ? `<span class="panel-gauge-sub">${subtext}</span>` : ''}
        </div>`;
}

function panelLoadChartHtml(history, loadAverage) {
    const values = Array.isArray(history) ? history : [];
    const width = 300;
    const height = 56;
    let pathSection = '';
    if (values.length >= 2) {
        const stepX = width / (values.length - 1);
        const points = values.map((value, index) => {
            const x = index * stepX;
            const y = height - (Math.max(0, Math.min(100, value)) / 100) * height;
            return [x, y];
        });
        const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
        const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
        pathSection = `
            <path class="panel-load-chart-area" d="${areaPath}"/>
            <path class="panel-load-chart-line" d="${linePath}"/>`;
    }
    return `
        <svg class="panel-load-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${pathSection}</svg>
        ${values.length < 2 ? `<span class="panel-load-chart-empty">${escapeHtml(t('panelLoadGathering'))}</span>` : ''}
        ${loadAverage != null ? `<span class="panel-load-chart-avg">${escapeHtml(t('panelLoadAverage'))}: <strong>${loadAverage.toFixed(2)}</strong></span>` : ''}
    `;
}

function renderPanelHost(data) {
    const host = data.host || {};

    const gauges = document.getElementById('panel-host-gauges');
    if (gauges) {
        if (!host.online) {
            gauges.innerHTML = `<div class="panel-empty-state">${escapeHtml(t('panelHostOffline'))}</div>`;
        } else {
            const diskSubtext = host.disk_used_bytes != null && host.disk_total_bytes != null
                ? `${formatSize(host.disk_used_bytes)} / ${formatSize(host.disk_total_bytes)}`
                : null;
            // <1% (típico: uploads/ frente a un disco de cientos de GB) se
            // muestra con 2 decimales — redondeado a entero siempre daba "0",
            // indistinguible de "sin datos".
            const diskDisplay = host.disk_percent == null ? '—'
                : host.disk_percent > 0 && host.disk_percent < 1 ? host.disk_percent.toFixed(2)
                : Math.round(host.disk_percent);
            gauges.innerHTML = [
                panelGaugeHtml(host.cpu_percent, 'gauge-fill-cpu', TOPBAR_ICON_ACTIVITY, 'CPU', host.cpu_percent != null ? host.cpu_percent : '—'),
                panelGaugeHtml(host.mem_percent, 'gauge-fill-mem', TOPBAR_ICON_CHIP, t('memory'), host.mem_percent != null ? host.mem_percent : '—'),
                panelGaugeHtml(host.disk_percent, 'gauge-fill-disk', PANEL_ICON_DISK, t('panelDiskLabel'), diskDisplay, diskSubtext),
            ].join('');
        }
    }

    const loadChart = document.getElementById('panel-load-chart');
    if (loadChart) {
        loadChart.innerHTML = host.online ? panelLoadChartHtml(host.cpu_history, host.load_average) : '';
    }

    const networkGrid = document.getElementById('panel-network-grid');
    if (networkGrid) {
        const networkCell = (label, value) => `
            <div class="panel-network-cell">
                <span class="panel-network-label">${label}</span>
                <strong class="panel-network-value">${value}</strong>
            </div>`;
        networkGrid.innerHTML = `
            <div class="panel-network-row">
                ${networkCell(t('hostIp'), host.ip || '—')}
                ${networkCell(t('hostNetworkSpeed'), host.bandwidth_kbps != null ? `${host.bandwidth_kbps} KB/s` : '—')}
            </div>
            <div class="panel-network-row">
                ${networkCell(t('hostReceived'), host.rx_gb != null ? `${host.rx_gb} GB` : '—')}
                ${networkCell(t('hostTransmitted'), host.tx_gb != null ? `${host.tx_gb} GB` : '—')}
            </div>`;
    }
}

function renderPanelDevices(data) {
    const row = document.getElementById('panel-devices-row');
    if (!row) return;
    const devices = data.devices || {};
    row.innerHTML = PANEL_DEVICE_TYPES.map(typeDef => {
        const counts = devices[typeDef.key] || { online: 0, total: 0 };
        if (typeDef.soon) {
            return `
                <div class="panel-device-tile panel-device-tile-soon">
                    <span class="panel-device-icon">${typeDef.icon}</span>
                    <strong>—</strong>
                    <span>${escapeHtml(t(typeDef.labelKey))}</span>
                </div>`;
        }
        return `
            <div class="panel-device-tile">
                <span class="panel-device-icon">${typeDef.icon}</span>
                <strong>${counts.total}</strong>
                <span>${escapeHtml(t(typeDef.labelKey))}</span>
            </div>`;
    }).join('');
}

function panelJobMachineIcon(machineType) {
    if (machineType === 'laser') return PANEL_ICON_LASER;
    if (machineType === 'cnc') return PANEL_ICON_CNC;
    return PANEL_ICON_PRINTER;
}

function formatTimeRemaining(seconds) {
    if (seconds == null || seconds < 0) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function renderPanelJobs(data) {
    const list = document.getElementById('panel-jobs-list');
    if (!list) return;
    const jobs = (data.jobs && data.jobs.active) || [];
    if (!jobs.length) {
        list.innerHTML = `<div class="panel-empty-state">${escapeHtml(t('panelNoActiveJobs'))}</div>`;
        return;
    }
    list.innerHTML = jobs.map(job => {
        const progress = Math.max(0, Math.min(100, job.progress || 0));
        const remaining = formatTimeRemaining(job.time_remaining_s);
        const layerText = job.current_layer != null && job.total_layer ? `${job.current_layer}/${job.total_layer}` : null;
        return `
            <div class="panel-job-row">
                <span class="panel-job-icon panel-job-icon-${escapeHtml(job.machine_type || 'printer')}">${panelJobMachineIcon(job.machine_type)}</span>
                <div class="panel-job-info">
                    <strong>${escapeHtml(job.name || '—')}</strong>
                    <span>${escapeHtml(job.filename || '—')}</span>
                </div>
                <div class="panel-job-progress-ring" style="--panel-job-progress:${progress}">
                    <span>${progress}%</span>
                </div>
                <div class="panel-job-meta">
                    ${remaining ? `<span>${escapeHtml(t('panelTimeRemaining'))}<strong>${remaining}</strong></span>` : ''}
                    ${layerText ? `<span>${escapeHtml(t('panelLayer'))}<strong>${escapeHtml(layerText)}</strong></span>` : ''}
                    <span class="panel-job-state">${escapeHtml(job.state || '—')}</span>
                </div>
                ${job.device_type && job.device_id ? `<div class="panel-job-camera" data-cam-container="${escapeHtml(job.device_type)}:${escapeHtml(job.device_id)}"></div>` : ''}
            </div>`;
    }).join('');
    mountCameraCardsIn(list);
}

function renderPanelAlerts(data) {
    const row = document.getElementById('panel-alerts-row');
    if (!row) return;
    const alerts = data.alerts || { error: 0, warning: 0, info: 0 };
    row.innerHTML = `
        <div class="panel-alert-tile panel-alert-tile-error">
            ${PANEL_ALERT_ICON_ERROR}
            <div class="panel-alert-tile-text">
                <strong>${alerts.error || 0}</strong>
                <span>${escapeHtml(t('panelAlertsCritical'))}</span>
            </div>
        </div>
        <div class="panel-alert-tile panel-alert-tile-warning">
            ${PANEL_ALERT_ICON_WARNING}
            <div class="panel-alert-tile-text">
                <strong>${alerts.warning || 0}</strong>
                <span>${escapeHtml(t('panelAlertsWarning'))}</span>
            </div>
        </div>
        <div class="panel-alert-tile panel-alert-tile-info">
            ${PANEL_ALERT_ICON_INFO}
            <div class="panel-alert-tile-text">
                <strong>${alerts.info || 0}</strong>
                <span>${escapeHtml(t('panelAlertsInfo'))}</span>
            </div>
        </div>`;
}

function renderPanelMiniCards(data) {
    const ambientValue = document.getElementById('panel-ambient-value');
    if (ambientValue) ambientValue.textContent = data.ambient != null ? `${data.ambient}°C` : t('panelNoSensor');

    const powerValue = document.getElementById('panel-power-value');
    if (powerValue) {
        const power = data.power || {};
        powerValue.textContent = power.active_watts != null ? `~${power.active_watts} W (${t('panelEstimated')})` : '—';
    }

    const maintenanceValue = document.getElementById('panel-maintenance-value');
    if (maintenanceValue) maintenanceValue.textContent = data.maintenance != null ? data.maintenance : t('panelNoData');
}

function renderDashboardPanel(data) {
    renderPanelHealth(data);
    renderPanelHost(data);
    renderPanelDevices(data);
    renderPanelJobs(data);
    renderPanelAlerts(data);
    renderPanelMiniCards(data);
}

let dashboardPanelLoading = false;

async function loadDashboardPanel() {
    if (dashboardPanelLoading || document.hidden) return;
    dashboardPanelLoading = true;
    try {
        const response = await fetch('/api/dashboard/summary');
        if (!response.ok) throw new Error('No se pudo cargar el resumen del panel');
        const data = await response.json();
        renderDashboardPanel(data);
        // Definida en guided-printer-setup.js (carga después de app.js) --
        // el guard typeof es defensivo nomás: para cuando este await se
        // resuelve, esa etiqueta <script> ya terminó de parsearse siempre.
        if (typeof maybeAutoOpenGuidedSetup === 'function') maybeAutoOpenGuidedSetup(data);
    } catch (error) {
        console.error(error);
    } finally {
        dashboardPanelLoading = false;
    }
}

function updatePanelClock() {
    const timeEl = document.getElementById('panel-clock-time');
    const dateEl = document.getElementById('panel-clock-date');
    if (!timeEl && !dateEl) return;
    const now = new Date();
    const locale = (typeof currentLanguage !== 'undefined' ? currentLanguage : 'es') === 'es' ? 'es-MX' : currentLanguage;
    if (timeEl) timeEl.textContent = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (dateEl) dateEl.textContent = now.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}

document.getElementById('panel-devices-see-all')?.addEventListener('click', () => {
    document.getElementById('machines-columns')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('panel-jobs-see-all')?.addEventListener('click', () => switchSection('queue'));
document.getElementById('panel-alerts-see-all')?.addEventListener('click', () => {
    document.getElementById('topbar-notif-btn')?.click();
});

// Ocultar-al-pasar-el-mouse del panel superior (opcional, ver Configuración
// > Apariencia y UI/UX > "Panel superior del Inicio"). Por defecto queda
// siempre visible (comportamiento previo) — el modo "hover" es opt-in.
const PANEL_AUTOHIDE_KEY = 'panelHeroAutoHideMode';
let panelHeroCollapseTimer = null;
let panelHeroPinned = false;

function getPanelAutoHideMode() {
    return localStorage.getItem(PANEL_AUTOHIDE_KEY) === 'hover' ? 'hover' : 'always';
}

function setPanelHeroCollapsed(collapsed) {
    document.getElementById('panel-hero-collapsible')?.classList.toggle('collapsed', collapsed);
}

function schedulePanelHeroCollapse() {
    if (panelHeroPinned || getPanelAutoHideMode() !== 'hover') return;
    clearTimeout(panelHeroCollapseTimer);
    panelHeroCollapseTimer = setTimeout(() => setPanelHeroCollapsed(true), 220);
}

function cancelPanelHeroCollapse() {
    clearTimeout(panelHeroCollapseTimer);
    if (getPanelAutoHideMode() === 'hover') setPanelHeroCollapsed(false);
}

function applyPanelAutoHideMode() {
    const mode = getPanelAutoHideMode();
    const select = document.getElementById('settings-panel-autohide');
    if (select) select.value = mode;
    panelHeroPinned = false;
    clearTimeout(panelHeroCollapseTimer);
    setPanelHeroCollapsed(mode === 'hover');
}

[document.querySelector('.global-topbar'), document.getElementById('panel-hero-collapsible')].forEach(zone => {
    zone?.addEventListener('mouseenter', cancelPanelHeroCollapse);
    zone?.addEventListener('mouseleave', schedulePanelHeroCollapse);
});

document.getElementById('global-topbar-panel-title')?.addEventListener('click', () => {
    if (getPanelAutoHideMode() !== 'hover') return;
    panelHeroPinned = !panelHeroPinned;
    if (panelHeroPinned) {
        cancelPanelHeroCollapse();
    } else {
        schedulePanelHeroCollapse();
    }
});

document.getElementById('settings-panel-autohide')?.addEventListener('change', event => {
    localStorage.setItem(PANEL_AUTOHIDE_KEY, event.target.value === 'hover' ? 'hover' : 'always');
    applyPanelAutoHideMode();
});

// Botón manual, siempre visible en el borde inferior del panel -- a
// diferencia del modo "hover" (opt-in, escondido en Configuración), este
// funciona sin depender de ningún ajuste. Al usarlo se fija panelHeroPinned
// para que, en modo "hover", el auto-colapso al sacar el mouse no le gane
// la partida al click explícito del usuario.
document.getElementById('panel-hero-toggle-btn')?.addEventListener('click', () => {
    const collapsed = !document.getElementById('panel-hero-collapsible')?.classList.contains('collapsed');
    panelHeroPinned = true;
    clearTimeout(panelHeroCollapseTimer);
    setPanelHeroCollapsed(collapsed);
});

applyPanelAutoHideMode();

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
    closeConfigFileEditor();
    const cameraContainer = document.getElementById('printer-modal-camera');
    if (cameraContainer) window.NopalCameraCard?.unmount(cameraContainer);
}

// Compartido entre el banner de error (solo visible si Klipper está en un
// estado de error) y el módulo persistente "Archivos de config" (siempre
// visible) -- misma acción de reiniciar/ver logs, dos lugares distintos
// desde donde se puede disparar. Recibe los elementos ya resueltos por el
// llamador en vez de buscarlos por id acá adentro, porque el módulo nuevo
// genera su propio markup dinámico (sin ids fijos, para poder recrearlo
// cada vez que se abre el modal sin colisionar con el banner).
function wirePrinterRestartActions({ restartBtn, firmwareRestartBtn, klippyLogBtn, moonrakerLogBtn }, printer) {
    const port = printer.port;
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
}

function renderPrinterErrorBanner(printer, stateValue) {
    const banner = document.getElementById('printer-modal-error-banner');
    if (!banner) return;

    const errorStates = ['error', 'shutdown', 'disconnected'];
    if (!errorStates.includes(stateValue) || !printer.port) {
        banner.hidden = true;
        return;
    }

    const message = printer.printer_info?.state_message || '';
    const titleEl = document.getElementById('printer-error-banner-title');
    const messageEl = document.getElementById('printer-error-banner-message');

    if (titleEl) titleEl.textContent = `${t('printerReportsKlipper')}: ${stateValue.toUpperCase()}`;
    if (messageEl) messageEl.textContent = message;

    wirePrinterRestartActions({
        restartBtn: document.getElementById('printer-error-restart-btn'),
        firmwareRestartBtn: document.getElementById('printer-error-firmware-restart-btn'),
        klippyLogBtn: document.getElementById('printer-error-klippy-log-btn'),
        moonrakerLogBtn: document.getElementById('printer-error-moonraker-log-btn'),
    }, printer);

    banner.hidden = false;
}

async function loadPrinterConfigFiles(port, printer) {
    const container = document.getElementById('printer-modal-configfiles');
    if (!container) return;
    try {
        const response = await fetch(`/api/printers/${port}/config-files`);
        if (!response.ok) throw new Error('No se pudo cargar los archivos de config');
        const data = await response.json();
        renderPrinterConfigFiles(container, port, printer, data.files || []);
    } catch (error) {
        console.error(error);
        container.innerHTML = `
            <div class="temp-card">
                <div class="temp-card-header">
                    <div class="temp-card-header-left">${PRINTER_MODULE_ICON_CONFIGFILES}<span>${t('printerModuleConfigFiles')}</span></div>
                </div>
                <div class="temp-card-body"><div class="empty-state-small">${t('printerConfigFilesEmpty')}</div></div>
            </div>`;
    }
}

function renderPrinterConfigFiles(container, port, printer, files) {
    const sorted = [...files].sort((a, b) => (a.path || '').localeCompare(b.path || ''));
    container.innerHTML = `
        <div class="temp-card">
            <div class="temp-card-header">
                <div class="temp-card-header-left">${PRINTER_MODULE_ICON_CONFIGFILES}<span>${t('printerModuleConfigFiles')}</span></div>
            </div>
            <div class="temp-card-body">
                <div class="config-actions-row">
                    <button type="button" class="btn-file-action btn-file-action-danger" data-restart-action="restart">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                        <span>${t('printerRestart')}</span>
                    </button>
                    <button type="button" class="btn-file-action btn-file-action-danger" data-restart-action="firmware-restart">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                        <span>${t('printerFirmwareRestart')}</span>
                    </button>
                    <a class="btn-file-action" data-restart-action="klippy-log" href="#" target="_blank" rel="noopener noreferrer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        <span>${t('printerKlipperLog')}</span>
                    </a>
                    <a class="btn-file-action" data-restart-action="moonraker-log" href="#" target="_blank" rel="noopener noreferrer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        <span>${t('printerMoonrakerLog')}</span>
                    </a>
                </div>
                ${sorted.length ? `
                <div class="config-file-list">
                    ${sorted.map(file => `
                        <button type="button" class="config-file-row" data-path="${escapeHtml(file.path || '')}">
                            <span class="config-file-row-name">${escapeHtml(file.path || '')}</span>
                            <span class="config-file-row-size">${formatSize(file.size || 0)}</span>
                        </button>
                    `).join('')}
                </div>
                ` : `<div class="empty-state-small">${t('printerConfigFilesEmpty')}</div>`}
            </div>
        </div>
    `;

    wirePrinterRestartActions({
        restartBtn: container.querySelector('[data-restart-action="restart"]'),
        firmwareRestartBtn: container.querySelector('[data-restart-action="firmware-restart"]'),
        klippyLogBtn: container.querySelector('[data-restart-action="klippy-log"]'),
        moonrakerLogBtn: container.querySelector('[data-restart-action="moonraker-log"]'),
    }, printer);

    container.querySelectorAll('.config-file-row').forEach(row => {
        row.addEventListener('click', () => openConfigFileEditor(port, row.dataset.path, printer));
    });
}

const printerConfigEditorModal = document.getElementById('printer-config-editor-modal');
let printerConfigEditorContext = null;

async function openConfigFileEditor(port, path, printer) {
    if (!printerConfigEditorModal) return;
    printerConfigEditorContext = { port, path, printer };
    const titleEl = document.getElementById('printer-config-editor-title');
    const textarea = document.getElementById('printer-config-editor-textarea');
    if (titleEl) titleEl.textContent = path;
    if (textarea) {
        textarea.value = '';
        textarea.disabled = true;
    }
    printerConfigEditorModal.classList.add('active');
    try {
        const response = await fetch(`/api/printers/${port}/config-files/content?path=${encodeURIComponent(path)}`);
        if (!response.ok) throw new Error('No se pudo leer el archivo');
        const data = await response.json();
        if (textarea) {
            textarea.value = data.content || '';
            textarea.disabled = false;
        }
    } catch (error) {
        console.error(error);
        appAlert(t('printerConfigFileLoadError'), '', 'danger');
        closeConfigFileEditor();
    }
}

function closeConfigFileEditor() {
    if (!printerConfigEditorModal) return;
    printerConfigEditorModal.classList.remove('active');
    printerConfigEditorContext = null;
}

document.getElementById('printer-config-editor-close')?.addEventListener('click', closeConfigFileEditor);
document.querySelector('#printer-config-editor-modal .modal-backdrop')?.addEventListener('click', closeConfigFileEditor);
document.getElementById('printer-config-editor-cancel-btn')?.addEventListener('click', closeConfigFileEditor);

document.getElementById('printer-config-editor-save-btn')?.addEventListener('click', async () => {
    if (!printerConfigEditorContext) return;
    const { port, path, printer } = printerConfigEditorContext;
    const confirmed = await appConfirm(
        t('printerConfigFileSaveConfirm').replace('{path}', path),
        t('printerModuleConfigFiles'),
        'warning',
    );
    if (!confirmed) return;
    const textarea = document.getElementById('printer-config-editor-textarea');
    const formData = new FormData();
    formData.append('path', path);
    formData.append('content', textarea ? textarea.value : '');
    try {
        const response = await fetch(`/api/printers/${port}/config-files/content`, { method: 'POST', body: formData });
        if (!response.ok) throw new Error('No se pudo guardar el archivo');
        showToast(t('printerConfigFileSaved'));
        closeConfigFileEditor();
        loadPrinterConfigFiles(port, printer);
    } catch (error) {
        console.error(error);
        appAlert(t('printerConfigFileSaveError'), '', 'danger');
    }
});

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
    // y solo queda visible el banner de error con sus acciones. "Archivos de
    // config" queda afuera de este apagón a propósito: Moonraker (que sirve
    // esos archivos) sigue arriba aunque Klipper se haya caído, así que es
    // precisamente en este estado donde más sirve poder editar printer.cfg.
    const printerErrorStates = ['error', 'shutdown', 'disconnected'];
    const isPrinterInError = printerErrorStates.includes(stateValue);
    if (isPrinterInError) {
        document.querySelectorAll('.printer-modal-body > .printer-modal-column').forEach(col => {
            if (col.dataset.module !== 'configfiles') col.hidden = true;
        });
    } else {
        // Reaplica el layout guardado (orden + ocultos elegidos en el
        // customizer) en vez de simplemente poner hidden=false -- si no, al
        // salir del estado de error se le pisaría al usuario su preferencia
        // de tener, por ejemplo, Cola oculta.
        applyPrinterModulesLayout();
    }

    return { stateValue, isPrinterInError };
}

async function openPrinterModal(printer) {
    if (!printerModal) return;

    const statsContainer = document.getElementById('printer-modal-stats');
    const temperaturesContainer = document.getElementById('printer-modal-temperatures');
    const toolheadContainer = document.getElementById('printer-modal-toolhead');
    const queueContainer = document.getElementById('printer-modal-queue');
    const configFilesContainer = document.getElementById('printer-modal-configfiles');
    const cameraContainer = document.getElementById('printer-modal-camera');

    if (statsContainer) statsContainer.innerHTML = `<div class="empty-state-small">${t('noSystemStats')}</div>`;
    if (temperaturesContainer) temperaturesContainer.innerHTML = '';
    if (toolheadContainer) toolheadContainer.innerHTML = '';
    if (queueContainer) queueContainer.innerHTML = '';
    if (configFilesContainer) configFilesContainer.innerHTML = '';
    if (cameraContainer) window.NopalCameraCard?.mount(cameraContainer, { deviceType: 'klipper', deviceId: printer.name });

    printerModal.classList.add('active');
    applyPrinterModulesLayout();

    // Se llama después de applyPrinterModulesLayout() para que, si Klipper
    // está en error, el ocultamiento forzado de Toolhead/Temperaturas/Cola
    // (ver refreshPrinterModalHeader) sea la última palabra y no lo pise el
    // layout guardado del customizer.
    const { isPrinterInError } = refreshPrinterModalHeader(printer);

    if (printer.port) loadPrinterConfigFiles(printer.port, printer);

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

// ── "Personalizar Módulos" (estilo Mainsail): reordenar y mostrar/ocultar
// los módulos del modal de impresora Klipper (Toolhead/Temperaturas/Cola)
// por breakpoint de pantalla. "Estado" representa la topbar fija de arriba;
// se muestra bloqueado en la lista solo por fidelidad visual, nunca se
// reordena ni se oculta (la topbar es estructuralmente independiente de las
// 3 columnas de .printer-modal-body).
//
// Estructura pensada para poder agregar más módulos después (Extrusor,
// Macros, Consola, etc. — fase futura explícitamente fuera de alcance) sin
// reescribir nada: basta con añadir una entrada más a PRINTER_MODULE_DEFS.
const PRINTER_MODULE_ICON_STATUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
const PRINTER_MODULE_ICON_TOOLHEAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const PRINTER_MODULE_ICON_TEMPERATURES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"/></svg>';
const PRINTER_MODULE_ICON_QUEUE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
const PRINTER_MODULE_ICON_CONFIGFILES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const PRINTER_MODULE_ICON_CAMERA = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
const PRINTER_MODULE_LOCK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const PRINTER_MODULE_DRAG_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

const PRINTER_MODULE_DEFS = [
    { key: 'estado', group: 'available', labelKey: 'status', iconSvg: PRINTER_MODULE_ICON_STATUS, locked: true },
    { key: 'toolhead', group: 'available', labelKey: 'toolhead', iconSvg: PRINTER_MODULE_ICON_TOOLHEAD, locked: false },
    { key: 'temperatures', group: 'extra', labelKey: 'temperatures', iconSvg: PRINTER_MODULE_ICON_TEMPERATURES, locked: false },
    { key: 'queue', group: 'extra', labelKey: 'printerModuleQueue', iconSvg: PRINTER_MODULE_ICON_QUEUE, locked: false },
    { key: 'configfiles', group: 'extra', labelKey: 'printerModuleConfigFiles', iconSvg: PRINTER_MODULE_ICON_CONFIGFILES, locked: false },
    // Solo se completa con contenido si hay una cámara vinculada (purpose
    // "timelapse" + bound_device) a esta impresora puntual -- ver
    // window.NopalCameraCard en el plugin camera-viewer. Sin el plugin
    // instalado, o sin cámara vinculada, la columna queda vacía (nunca
    // rompe el resto del modal, mismo criterio "opcional" de siempre).
    { key: 'camera', group: 'extra', labelKey: 'printerModuleCamera', iconSvg: PRINTER_MODULE_ICON_CAMERA, locked: false },
];

const PRINTER_MODULE_NONLOCKED_KEYS = PRINTER_MODULE_DEFS.filter(mod => !mod.locked).map(mod => mod.key);

// Los 4 breakpoints se resuelven por ancho de ventana, igual que el resto
// del layout responsive de la app (no hay coincidencia exacta con ningún
// @media existente porque este es un concepto nuevo — el propio del editor).
const PRINTER_MODULE_BREAKPOINTS = [
    { id: 'mobile', maxWidth: 639 },
    { id: 'tablet', minWidth: 640, maxWidth: 1023 },
    { id: 'desktop', minWidth: 1024, maxWidth: 1439 },
    { id: 'wide', minWidth: 1440 },
];

function getPrinterModuleBreakpointId(width = window.innerWidth) {
    const match = PRINTER_MODULE_BREAKPOINTS.find(bp =>
        (bp.minWidth === undefined || width >= bp.minWidth) &&
        (bp.maxWidth === undefined || width <= bp.maxWidth));
    return match ? match.id : 'desktop';
}

function getPrinterModulesLayout(breakpointId) {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(`printerModulesLayout_${breakpointId}`) || 'null');
    } catch (error) {
        saved = null;
    }
    const savedOrder = Array.isArray(saved?.order) ? saved.order.filter(key => PRINTER_MODULE_NONLOCKED_KEYS.includes(key)) : [];
    const missing = PRINTER_MODULE_NONLOCKED_KEYS.filter(key => !savedOrder.includes(key));
    const hidden = Array.isArray(saved?.hidden) ? saved.hidden.filter(key => PRINTER_MODULE_NONLOCKED_KEYS.includes(key)) : [];
    return { order: [...savedOrder, ...missing], hidden };
}

function savePrinterModulesLayout(breakpointId, layout) {
    localStorage.setItem(`printerModulesLayout_${breakpointId}`, JSON.stringify({
        order: (layout.order || []).filter(key => PRINTER_MODULE_NONLOCKED_KEYS.includes(key)),
        hidden: (layout.hidden || []).filter(key => PRINTER_MODULE_NONLOCKED_KEYS.includes(key)),
    }));
}

function resetPrinterModulesLayout(breakpointId) {
    localStorage.removeItem(`printerModulesLayout_${breakpointId}`);
}

// Aplica el layout guardado del breakpoint actual a las 3 columnas reales
// del modal de impresora (reordenar + ocultar). Se llama al abrir el modal
// y cuando el resize cruza un límite de breakpoint mientras está abierto.
function applyPrinterModulesLayout() {
    const modalBody = document.querySelector('#printer-modal .printer-modal-body');
    if (!modalBody) return;
    const layout = getPrinterModulesLayout(getPrinterModuleBreakpointId());
    const orderIndex = new Map(layout.order.map((key, index) => [key, index]));
    const columns = Array.from(modalBody.querySelectorAll(':scope > .printer-modal-column[data-module]'));
    columns
        .slice()
        .sort((a, b) => (orderIndex.get(a.dataset.module) ?? 99) - (orderIndex.get(b.dataset.module) ?? 99))
        .forEach(col => modalBody.appendChild(col));
    columns.forEach(col => {
        col.hidden = layout.hidden.includes(col.dataset.module);
    });
}

let lastPrinterModuleBreakpointId = getPrinterModuleBreakpointId();
window.addEventListener('resize', () => {
    const current = getPrinterModuleBreakpointId();
    if (current === lastPrinterModuleBreakpointId) return;
    lastPrinterModuleBreakpointId = current;
    if (printerModal && printerModal.classList.contains('active')) {
        applyPrinterModulesLayout();
    }
});

// Pestaña de breakpoint que se está editando en el modal "Personalizar
// Módulos" — independiente del ancho real de la ventana, así se puede
// editar por ejemplo el layout de "Celular" desde un monitor de escritorio.
let moduleCustomizerActiveBreakpoint = getPrinterModuleBreakpointId();

function renderModuleCustomizerTabs() {
    document.querySelectorAll('#module-customizer-tabs .module-customizer-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.breakpoint === moduleCustomizerActiveBreakpoint);
    });
}

function renderModuleCustomizerRow(mod, layout) {
    const label = t(mod.labelKey);
    if (mod.locked) {
        return `
            <div class="module-customizer-row module-customizer-row-locked" data-module="${mod.key}">
                <span class="module-customizer-row-handle module-customizer-row-handle-disabled">${PRINTER_MODULE_DRAG_ICON}</span>
                <span class="module-customizer-row-icon">${mod.iconSvg}</span>
                <span class="module-customizer-row-label">${escapeHtml(label)}</span>
                <span class="module-customizer-row-lock" title="${escapeHtml(t('moduleCustomizerLockedHint'))}">${PRINTER_MODULE_LOCK_ICON}</span>
            </div>
        `;
    }
    const isHidden = layout.hidden.includes(mod.key);
    const checkboxClass = mod.group === 'available' ? 'module-customizer-checkbox-green' : 'module-customizer-checkbox-purple';
    return `
        <div class="module-customizer-row" data-module="${mod.key}">
            <span class="module-customizer-row-handle">${PRINTER_MODULE_DRAG_ICON}</span>
            <span class="module-customizer-row-icon">${mod.iconSvg}</span>
            <span class="module-customizer-row-label">${escapeHtml(label)}</span>
            <label class="module-customizer-row-toggle">
                <input type="checkbox" class="module-customizer-checkbox ${checkboxClass}" data-module="${mod.key}" ${isHidden ? '' : 'checked'}>
            </label>
        </div>
    `;
}

// Reordena visualmente en el DOM la fila que se está arrastrando dentro de
// su propia lista (grupo), a mano con Pointer Events — sin HTML5 drag&drop
// nativo (no funciona bien en touch) ni librerías de terceros. La fila
// arrastrada se saca del flujo (position:absolute dentro de la lista, que
// es position:relative) y sigue al cursor verticalmente mientras las demás
// se reacomodan de inmediato al cruzar su punto medio.
function getModuleCustomizerDropTarget(list, draggingRow, pointerY) {
    const rows = Array.from(list.querySelectorAll(':scope > .module-customizer-row'))
        .filter(row => row !== draggingRow && !row.classList.contains('module-customizer-row-locked'));
    return rows.reduce((closest, row) => {
        const box = row.getBoundingClientRect();
        const offset = pointerY - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset, element: row };
        }
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function persistModuleOrderFromDom() {
    const availableList = document.getElementById('module-customizer-list-available');
    const extraList = document.getElementById('module-customizer-list-extra');
    const domOrder = [
        ...Array.from(availableList ? availableList.querySelectorAll(':scope > .module-customizer-row[data-module]') : []),
        ...Array.from(extraList ? extraList.querySelectorAll(':scope > .module-customizer-row[data-module]') : []),
    ].map(row => row.dataset.module).filter(key => PRINTER_MODULE_NONLOCKED_KEYS.includes(key));
    const currentLayout = getPrinterModulesLayout(moduleCustomizerActiveBreakpoint);
    savePrinterModulesLayout(moduleCustomizerActiveBreakpoint, { order: domOrder, hidden: currentLayout.hidden });
    applyPrinterModulesLayout();
}

function initModuleCustomizerDrag(list, onReorder = persistModuleOrderFromDom) {
    let draggingRow = null;

    function onPointerMove(event) {
        if (!draggingRow) return;
        event.preventDefault();
        const dy = event.clientY - draggingRow._moduleDragStartPointerY;
        draggingRow.style.top = `${draggingRow._moduleDragStartTop + dy}px`;
        const after = getModuleCustomizerDropTarget(list, draggingRow, event.clientY);
        if (after == null) {
            list.appendChild(draggingRow);
        } else if (after !== draggingRow.nextElementSibling) {
            list.insertBefore(draggingRow, after);
        }
    }

    function endDrag() {
        if (!draggingRow) return;
        draggingRow.classList.remove('module-customizer-row-dragging');
        draggingRow.style.position = '';
        draggingRow.style.top = '';
        draggingRow.style.left = '';
        draggingRow.style.right = '';
        draggingRow.style.zIndex = '';
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', endDrag);
        document.removeEventListener('pointercancel', endDrag);
        draggingRow = null;
        onReorder();
    }

    list.querySelectorAll('.module-customizer-row-handle:not(.module-customizer-row-handle-disabled)').forEach(handle => {
        handle.addEventListener('pointerdown', (event) => {
            const row = handle.closest('.module-customizer-row');
            if (!row) return;
            event.preventDefault();
            const listRect = list.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            row._moduleDragStartPointerY = event.clientY;
            row._moduleDragStartTop = rowRect.top - listRect.top;
            draggingRow = row;
            row.classList.add('module-customizer-row-dragging');
            row.style.position = 'absolute';
            row.style.top = `${row._moduleDragStartTop}px`;
            row.style.left = '0';
            row.style.right = '0';
            row.style.zIndex = '20';
            try { handle.setPointerCapture(event.pointerId); } catch (error) { /* no-op: no crítico si el navegador no lo soporta */ }
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', endDrag);
            document.addEventListener('pointercancel', endDrag);
        });
    });
}

function renderModuleCustomizerLists() {
    const availableList = document.getElementById('module-customizer-list-available');
    const extraList = document.getElementById('module-customizer-list-extra');
    if (!availableList || !extraList) return;

    const layout = getPrinterModulesLayout(moduleCustomizerActiveBreakpoint);
    const orderIndex = new Map(layout.order.map((key, index) => [key, index]));

    const byGroup = (group) => PRINTER_MODULE_DEFS
        .filter(mod => mod.group === group)
        .sort((a, b) => {
            if (a.locked !== b.locked) return a.locked ? -1 : 1;
            return (orderIndex.get(a.key) ?? 99) - (orderIndex.get(b.key) ?? 99);
        });

    availableList.innerHTML = byGroup('available').map(mod => renderModuleCustomizerRow(mod, layout)).join('');
    extraList.innerHTML = byGroup('extra').map(mod => renderModuleCustomizerRow(mod, layout)).join('');

    [availableList, extraList].forEach(list => {
        list.querySelectorAll('input.module-customizer-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                const key = checkbox.dataset.module;
                const currentLayout = getPrinterModulesLayout(moduleCustomizerActiveBreakpoint);
                const hiddenSet = new Set(currentLayout.hidden);
                if (checkbox.checked) hiddenSet.delete(key); else hiddenSet.add(key);
                savePrinterModulesLayout(moduleCustomizerActiveBreakpoint, { order: currentLayout.order, hidden: Array.from(hiddenSet) });
                applyPrinterModulesLayout();
            });
        });
        initModuleCustomizerDrag(list);
    });
}

function openModuleCustomizerModal() {
    const modal = document.getElementById('module-customizer-modal');
    if (!modal) return;
    moduleCustomizerActiveBreakpoint = getPrinterModuleBreakpointId();
    renderModuleCustomizerTabs();
    renderModuleCustomizerLists();
    modal.classList.add('active');
}

function closeModuleCustomizerModal() {
    document.getElementById('module-customizer-modal')?.classList.remove('active');
}

document.getElementById('printer-modal-settings-btn')?.addEventListener('click', openModuleCustomizerModal);
document.getElementById('module-customizer-modal-close')?.addEventListener('click', closeModuleCustomizerModal);
document.getElementById('module-customizer-modal-backdrop')?.addEventListener('click', closeModuleCustomizerModal);

document.querySelectorAll('#module-customizer-tabs .module-customizer-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        moduleCustomizerActiveBreakpoint = tab.dataset.breakpoint;
        renderModuleCustomizerTabs();
        renderModuleCustomizerLists();
    });
});

document.getElementById('module-customizer-reset-btn')?.addEventListener('click', () => {
    resetPrinterModulesLayout(moduleCustomizerActiveBreakpoint);
    renderModuleCustomizerLists();
    applyPrinterModulesLayout();
    showToast(t('moduleCustomizerResetDone'));
});

// ── "Personalizar" para las páginas de Configuración y Ayuda ────────────
// Configuración (7 tarjetas) y Ayuda (8 tarjetas) son de nuevo dos páginas
// independientes (index.html: #settings-section / #help-section), cada una
// con su propio pool de tarjetas reales (#settings-modules-pool /
// #help-modules-pool — cada tarjeta con un atributo
// data-settings-module="<key>" que la identifica sin importar en qué grupo
// termine) y su propio editor "Personalizar" para crear/renombrar/borrar
// grupos y arrastrar tarjetas entre ellos, igual que el editor de módulos
// del modal de impresora pero con grupos definidos por el propio usuario en
// vez de 2 columnas fijas "disponibles"/"adicionales".
//
// Las dos páginas comparten exactamente la misma lógica (grupos, arrastre,
// persistencia por breakpoint), así que en vez de duplicarla existe un solo
// motor genérico — createModulePageScope(config) — parametrizado por los ids
// del DOM y el prefijo de localStorage de cada página; se instancia una vez
// por página al final de este bloque (settingsModulesPageScope /
// helpModulesPageScope). El arrastre nunca cruza entre páginas porque cada
// instancia solo consulta el DOM dentro de su propio modal
// (config.modalGroupsId): no comparten grupos, tarjetas ni localStorage.
//
// Persistencia en localStorage, una entrada por breakpoint y por página
// (mismos 4 breakpoints que el editor de impresora — se mantienen aparte a
// propósito: son features independientes, así cada una evoluciona sin
// arriesgar a las otras):
//   settingsModulesLayout_<breakpointId> = { groups: [{ id, name, modules: [key, ...] }, ...], hidden: [key, ...] }
//   helpModulesLayout_<breakpointId>     = { groups: [{ id, name, modules: [key, ...] }, ...], hidden: [key, ...] }
// Por defecto (primera vez, nada guardado) cada página arma un solo grupo con
// todas sus tarjetas en su orden original ("General" en Configuración,
// "Ayuda" en Ayuda) — así ningún usuario existente ve la página vacía.
const SETTINGS_MODULE_ICON_GENERAL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
const SETTINGS_MODULE_ICON_APPEARANCE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20 6 6 0 0 0 0-12 4 4 0 0 1 0-8z"/></svg>';
const SETTINGS_MODULE_ICON_UPDATES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
const SETTINGS_MODULE_ICON_LOGS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>';
const SETTINGS_MODULE_ICON_USERS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const SETTINGS_MODULE_ICON_TUNASCREEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
const SETTINGS_MODULE_ICON_DEVICES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';
const SETTINGS_MODULE_ICON_ACCESSORIES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>';
const SETTINGS_MODULE_ICON_ABOUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
const SETTINGS_MODULE_ICON_MODELS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
const SETTINGS_MODULE_ICON_GCODE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const SETTINGS_MODULE_ICON_DASHBOARD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const SETTINGS_MODULE_ICON_LASER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6"/><path d="M5 22h14l-1.5-9h-11z"/><path d="M9 13v3"/><path d="M15 13v3"/></svg>';
const SETTINGS_MODULE_ICON_QUEUE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
const SETTINGS_MODULE_ICON_MACROS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const SETTINGS_MODULE_ICON_SETTINGS_HELP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

const SETTINGS_MODULE_ICON_AI = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v1a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 3 3v1a3 3 0 0 0 6 0v-1a3 3 0 0 0 3-3v-1a3 3 0 0 0 0-6V9a3 3 0 0 0-3-3V5a3 3 0 0 0-3-3z"/><path d="M12 8v8"/><path d="M9 12h6"/></svg>';

// Las tarjetas reales de #settings-modules-pool.
const SETTINGS_MODULE_DEFS = [
    { key: 'general', labelKey: 'generalSettings', iconSvg: SETTINGS_MODULE_ICON_GENERAL },
    { key: 'appearance', labelKey: 'appearanceSettingsTitle', iconSvg: SETTINGS_MODULE_ICON_APPEARANCE },
    { key: 'updates', labelKey: 'updates', iconSvg: SETTINGS_MODULE_ICON_UPDATES },
    { key: 'logs', labelKey: 'systemLogs', iconSvg: SETTINGS_MODULE_ICON_LOGS },
    { key: 'users', labelKey: 'usersTitle', iconSvg: SETTINGS_MODULE_ICON_USERS },
    { key: 'devices', labelKey: 'devicesTitle', iconSvg: SETTINGS_MODULE_ICON_DEVICES },
    { key: 'accessories', labelKey: 'accessoriesSettingsTitle', iconSvg: SETTINGS_MODULE_ICON_ACCESSORIES },
    { key: 'tunascreen', labelKey: 'tunascreenTitle', iconSvg: SETTINGS_MODULE_ICON_TUNASCREEN },
    { key: 'ai', labelKey: 'aiSettingsTitle', iconSvg: SETTINGS_MODULE_ICON_AI },
    { key: 'backup', labelKey: 'backupTitle', iconSvg: SETTINGS_MODULE_ICON_UPDATES },
];
// Centro de ayuda (layout fijo, sin personalización por arrastre -- ver
// renderHelpCenter() más abajo en este archivo) reusa estos mismos íconos
// lineales ya definidos arriba para SETTINGS_MODULE_DEFS.

// Mismos 4 breakpoints que PRINTER_MODULE_BREAKPOINTS más arriba, compartidos
// por ambas páginas.
const SETTINGS_MODULE_BREAKPOINTS = [
    { id: 'mobile', maxWidth: 639 },
    { id: 'tablet', minWidth: 640, maxWidth: 1023 },
    { id: 'desktop', minWidth: 1024, maxWidth: 1439 },
    { id: 'wide', minWidth: 1440 },
];

function getSettingsModuleBreakpointId(width = window.innerWidth) {
    const match = SETTINGS_MODULE_BREAKPOINTS.find(bp =>
        (bp.minWidth === undefined || width >= bp.minWidth) &&
        (bp.maxWidth === undefined || width <= bp.maxWidth));
    return match ? match.id : 'desktop';
}

function generateSettingsModuleGroupId() {
    return `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Motor genérico: una instancia = una página con su propio pool de
// tarjetas, su propio contenedor de grupos y su propio modal "Personalizar".
// Hoy solo Configuración lo usa (Ayuda tiene su propio layout fijo, ver
// renderHelpCenter()), pero se mantiene parametrizado por si otra página
// necesita personalización por arrastre en el futuro.
// config = {
//   storagePrefix,               // 'settingsModulesLayout_'
//   moduleDefs,                  // SETTINGS_MODULE_DEFS
//   groupsElementId,             // contenedor real de la página (fuera del modal)
//   modalId, modalTabsId, modalGroupsId, modalCloseId, modalBackdropId,
//   customizeBtnId, addGroupBtnId, resetBtnId,
//   defaultGroups: [{ id, nameKey, keys }],
// }
function createModulePageScope(config) {
    const moduleKeys = config.moduleDefs.map(mod => mod.key);
    const moduleDefsByKey = new Map(config.moduleDefs.map(mod => [mod.key, mod]));
    // Pestaña de breakpoint que se está editando en el editor de esta
    // página — independiente del ancho real de la ventana (igual que
    // moduleCustomizerActiveBreakpoint del editor de impresora).
    let customizerActiveBreakpoint = getSettingsModuleBreakpointId();

    function getDefaultLayout() {
        return {
            groups: config.defaultGroups.map(g => ({ id: g.id, name: t(g.nameKey), modules: [...g.keys] })),
            hidden: [],
        };
    }

    // Reacomoda/sanea un layout leído de localStorage: descarta claves de
    // módulo repetidas o que ya no existen, y agrega a un grupo "Sin grupo"
    // (creándolo si hace falta) cualquier módulo que falte por alguna razón
    // (versión vieja del layout, corrupción manual del localStorage, etc.)
    // — así todas las tarjetas de esta página siempre quedan cubiertas y
    // nunca se "pierde" una silenciosamente.
    function sanitizeLayout(raw) {
        const groupsIn = Array.isArray(raw?.groups) ? raw.groups : [];
        const seen = new Set();
        const groups = groupsIn
            .filter(g => g && typeof g.id === 'string' && typeof g.name === 'string')
            .map(g => ({
                id: g.id,
                name: g.name,
                modules: Array.isArray(g.modules) ? g.modules.filter(key => {
                    if (!moduleKeys.includes(key) || seen.has(key)) return false;
                    seen.add(key);
                    return true;
                }) : [],
            }));
        const missing = moduleKeys.filter(key => !seen.has(key));
        if (missing.length) {
            let ungrouped = groups.find(g => g.id === 'ungrouped');
            if (!ungrouped) {
                ungrouped = { id: 'ungrouped', name: t('settingsModuleGroupUngrouped'), modules: [] };
                groups.push(ungrouped);
            }
            ungrouped.modules.push(...missing);
        }
        const hidden = Array.isArray(raw?.hidden) ? raw.hidden.filter(key => moduleKeys.includes(key)) : [];
        return { groups, hidden };
    }

    function getLayout(breakpointId) {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(`${config.storagePrefix}${breakpointId}`) || 'null');
        } catch (error) {
            saved = null;
        }
        if (!saved || !Array.isArray(saved.groups) || !saved.groups.length) {
            return getDefaultLayout();
        }
        return sanitizeLayout(saved);
    }

    function saveLayout(breakpointId, layout) {
        localStorage.setItem(`${config.storagePrefix}${breakpointId}`, JSON.stringify(sanitizeLayout(layout)));
    }

    function resetLayout(breakpointId) {
        localStorage.removeItem(`${config.storagePrefix}${breakpointId}`);
    }

    // Aplica el layout guardado del breakpoint actual a la página real: arma
    // un <section> por grupo y mueve dentro las tarjetas reales (nunca las
    // recrea — conservan todos sus listeners) tomándolas de donde estén (la
    // "alberca" inicial de esta página la primera vez, o el grupo anterior
    // en llamadas siguientes). El estado "oculto" elegido en el editor se
    // aplica con una clase (settings-module-hidden-by-user), no con el
    // atributo `hidden` nativo — ese lo sigue controlando exclusivamente
    // cada función dueña de la tarjeta (p. ej. loadUsersSettings() según el
    // rol del usuario), para que ambos mecanismos convivan sin pisarse.
    function apply() {
        const groupsContainer = document.getElementById(config.groupsElementId);
        if (!groupsContainer) return;
        const layout = getLayout(getSettingsModuleBreakpointId());
        const sections = [];

        layout.groups.forEach(group => {
            const section = document.createElement('section');
            section.className = 'settings-module-group';
            section.dataset.groupId = group.id;

            const titleRow = document.createElement('div');
            titleRow.className = 'settings-module-group-title-row';
            const title = document.createElement('h2');
            title.className = 'settings-module-group-title';
            title.textContent = group.name;
            titleRow.appendChild(title);

            const body = document.createElement('div');
            body.className = 'settings-module-group-body';

            let hasModule = false;
            let hasVisibleModule = false;
            group.modules.forEach(key => {
                const el = document.querySelector(`[data-settings-module="${key}"]`);
                if (!el) return;
                hasModule = true;
                const isHiddenByUser = layout.hidden.includes(key);
                el.classList.toggle('settings-module-hidden-by-user', isHiddenByUser);
                if (!isHiddenByUser) hasVisibleModule = true;
                body.appendChild(el);
            });

            if (!hasModule) return;
            section.appendChild(titleRow);
            section.appendChild(body);
            section.hidden = !hasVisibleModule;
            sections.push(section);
        });

        groupsContainer.innerHTML = '';
        sections.forEach(section => groupsContainer.appendChild(section));
    }

    let lastBreakpointId = getSettingsModuleBreakpointId();
    window.addEventListener('resize', () => {
        const current = getSettingsModuleBreakpointId();
        if (current === lastBreakpointId) return;
        lastBreakpointId = current;
        apply();
    });

    function renderCustomizerTabs() {
        document.querySelectorAll(`#${config.modalTabsId} .module-customizer-tab`).forEach(tab => {
            tab.classList.toggle('active', tab.dataset.breakpoint === customizerActiveBreakpoint);
        });
    }

    function renderCustomizerRow(mod, layout) {
        const label = t(mod.labelKey);
        const isHidden = layout.hidden.includes(mod.key);
        return `
            <div class="module-customizer-row settings-module-customizer-row" data-module="${mod.key}">
                <span class="module-customizer-row-handle">${PRINTER_MODULE_DRAG_ICON}</span>
                <span class="module-customizer-row-icon">${mod.iconSvg}</span>
                <span class="module-customizer-row-label">${escapeHtml(label)}</span>
                <label class="module-customizer-row-toggle">
                    <input type="checkbox" class="module-customizer-checkbox" data-module="${mod.key}" ${isHidden ? '' : 'checked'}>
                </label>
            </div>
        `;
    }

    function renderCustomizerGroupHtml(group, layout) {
        const rowsHtml = group.modules
            .map(key => moduleDefsByKey.get(key))
            .filter(Boolean)
            .map(mod => renderCustomizerRow(mod, layout))
            .join('');
        const namePlaceholder = escapeHtml(t('settingsModuleCustomizerGroupNamePlaceholder'));
        return `
            <div class="module-customizer-group settings-module-customizer-group" data-group-id="${escapeHtml(group.id)}">
                <div class="settings-module-customizer-group-header">
                    <input type="text" class="settings-module-customizer-group-name-input" data-group-id="${escapeHtml(group.id)}" value="${escapeHtml(group.name)}" aria-label="${namePlaceholder}" placeholder="${namePlaceholder}">
                    <button type="button" class="settings-module-customizer-group-delete-btn" data-group-id="${escapeHtml(group.id)}" title="${escapeHtml(t('settingsModuleCustomizerDeleteGroupBtn'))}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                    </button>
                </div>
                <div class="module-customizer-list settings-module-customizer-list" data-group-id="${escapeHtml(group.id)}">${rowsHtml}</div>
            </div>
        `;
    }

    function listRows(list) {
        return Array.from(list.children).filter(el => el.classList.contains('module-customizer-row'));
    }

    function toggleEmptyHint(list) {
        if (!list) return;
        const hint = list.querySelector(':scope > .settings-module-customizer-list-hint');
        if (listRows(list).length) {
            if (hint) hint.remove();
        } else if (!hint) {
            const newHint = document.createElement('div');
            newHint.className = 'settings-module-customizer-list-hint';
            newHint.textContent = t('settingsModuleCustomizerEmptyGroupHint');
            list.appendChild(newHint);
        }
    }

    function renderCustomizerGroups() {
        const container = document.getElementById(config.modalGroupsId);
        if (!container) return;
        const layout = getLayout(customizerActiveBreakpoint);
        container.innerHTML = layout.groups.map(group => renderCustomizerGroupHtml(group, layout)).join('');

        container.querySelectorAll('.settings-module-customizer-list').forEach(list => {
            toggleEmptyHint(list);
            list.querySelectorAll('input.module-customizer-checkbox').forEach(checkbox => {
                checkbox.addEventListener('change', () => {
                    const key = checkbox.dataset.module;
                    const currentLayout = getLayout(customizerActiveBreakpoint);
                    const hiddenSet = new Set(currentLayout.hidden);
                    if (checkbox.checked) hiddenSet.delete(key); else hiddenSet.add(key);
                    saveLayout(customizerActiveBreakpoint, { groups: currentLayout.groups, hidden: Array.from(hiddenSet) });
                    apply();
                });
            });
            initCustomizerDrag(list);
        });

        container.querySelectorAll('.settings-module-customizer-group-name-input').forEach(input => {
            input.addEventListener('change', () => {
                const currentLayout = getLayout(customizerActiveBreakpoint);
                const group = currentLayout.groups.find(g => g.id === input.dataset.groupId);
                if (!group) return;
                group.name = input.value.trim() || t('settingsModuleCustomizerNewGroupDefaultName');
                input.value = group.name;
                saveLayout(customizerActiveBreakpoint, currentLayout);
                apply();
            });
        });

        container.querySelectorAll('.settings-module-customizer-group-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteGroup(btn.dataset.groupId));
        });
    }

    // Borra un grupo. Si tenía tarjetas asignadas, nunca se pierden: se
    // mueven a un grupo "Sin grupo" (se reutiliza si ya existe uno, o se
    // crea de cero) — pide confirmación solo en ese caso, porque es la
    // única variante con un efecto visible sobre el layout del usuario.
    function deleteGroup(groupId) {
        const layout = getLayout(customizerActiveBreakpoint);
        const group = layout.groups.find(g => g.id === groupId);
        if (!group) return;

        const proceed = () => {
            const remaining = layout.groups.filter(g => g.id !== groupId);
            if (group.modules.length) {
                let ungrouped = remaining.find(g => g.id === 'ungrouped');
                if (!ungrouped) {
                    ungrouped = { id: 'ungrouped', name: t('settingsModuleGroupUngrouped'), modules: [] };
                    remaining.push(ungrouped);
                }
                ungrouped.modules.push(...group.modules);
            }
            saveLayout(customizerActiveBreakpoint, { groups: remaining, hidden: layout.hidden });
            renderCustomizerGroups();
            apply();
        };

        if (group.modules.length) {
            appConfirm(t('settingsModuleCustomizerDeleteGroupConfirm'), t('settingsModuleCustomizerDeleteGroupTitle'), 'danger')
                .then(confirmed => { if (confirmed) proceed(); });
        } else {
            proceed();
        }
    }

    function nextGroupName(existingNames) {
        const base = t('settingsModuleCustomizerNewGroupDefaultName');
        if (!existingNames.includes(base)) return base;
        let i = 2;
        while (existingNames.includes(`${base} ${i}`)) i++;
        return `${base} ${i}`;
    }

    function getDropTarget(list, draggingRow, pointerY) {
        const rows = listRows(list).filter(row => row !== draggingRow);
        return rows.reduce((closest, row) => {
            const box = row.getBoundingClientRect();
            const offset = pointerY - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset, element: row };
            }
            return closest;
        }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
    }

    // Solo mira listas dentro del modal de esta página (config.modalGroupsId)
    // — así el arrastre nunca puede soltar una tarjeta en el modal de la
    // otra página, aunque ambos compartan las mismas clases CSS.
    function getListAtPoint(x, y) {
        const lists = Array.from(document.querySelectorAll(`#${config.modalGroupsId} .settings-module-customizer-list`));
        return lists.find(list => {
            const box = list.getBoundingClientRect();
            return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
        }) || null;
    }

    // Persiste en localStorage el orden/agrupación actual leyendo
    // directamente el DOM de todas las listas del editor de esta página
    // (cada .settings-module-customizer-list vale por un grupo) — se llama
    // una sola vez al soltar el arrastre, nunca en cada pointermove (sería
    // carísimo: movería las tarjetas reales de la página en cada frame).
    function persistOrderFromDom() {
        const currentLayout = getLayout(customizerActiveBreakpoint);
        const groupsById = new Map(currentLayout.groups.map(g => [g.id, g]));
        document.querySelectorAll(`#${config.modalGroupsId} .settings-module-customizer-list`).forEach(list => {
            const group = groupsById.get(list.dataset.groupId);
            if (!group) return;
            group.modules = listRows(list)
                .map(row => row.dataset.module)
                .filter(key => moduleKeys.includes(key));
        });
        saveLayout(customizerActiveBreakpoint, { groups: Array.from(groupsById.values()), hidden: currentLayout.hidden });
        apply();
    }

    // A diferencia de initModuleCustomizerDrag (editor de impresora: una sola
    // lista fija por llamada, la fila nunca cambia de contenedor), acá el
    // mismo arrastre tiene que poder soltarse en cualquier otro grupo — pero
    // solo entre los grupos de esta misma página, nunca con los de la otra
    // (getListAtPoint() solo mira dentro de config.modalGroupsId). Por eso
    // la fila arrastrada se vuelve position:fixed (coordenadas de viewport)
    // y sigue al cursor sin importar de qué lista sea hija en cada
    // instante, mientras que por debajo se va reinsertando de verdad en el
    // DOM de la lista que esté bajo el cursor — así el layout final ya
    // queda reflejado en el propio árbol del DOM al soltar
    // (persistOrderFromDom simplemente lee ese orden, no hace falta llevar
    // un estado de arrastre aparte).
    function initCustomizerDrag(list) {
        list.querySelectorAll(':scope > .module-customizer-row > .module-customizer-row-handle').forEach(handle => {
            handle.addEventListener('pointerdown', (event) => {
                const row = handle.closest('.module-customizer-row');
                if (!row) return;
                event.preventDefault();
                const rowRect = row.getBoundingClientRect();
                const draggingRow = row;
                const dragOffsetX = event.clientX - rowRect.left;
                const dragOffsetY = event.clientY - rowRect.top;
                draggingRow.classList.add('module-customizer-row-dragging');
                draggingRow.style.position = 'fixed';
                draggingRow.style.top = `${rowRect.top}px`;
                draggingRow.style.left = `${rowRect.left}px`;
                draggingRow.style.width = `${rowRect.width}px`;
                draggingRow.style.zIndex = '2000';

                function onPointerMove(moveEvent) {
                    moveEvent.preventDefault();
                    draggingRow.style.top = `${moveEvent.clientY - dragOffsetY}px`;
                    draggingRow.style.left = `${moveEvent.clientX - dragOffsetX}px`;
                    const targetList = getListAtPoint(moveEvent.clientX, moveEvent.clientY);
                    if (!targetList) return;
                    const originList = draggingRow.parentElement;
                    const after = getDropTarget(targetList, draggingRow, moveEvent.clientY);
                    let moved = false;
                    if (after == null) {
                        if (originList !== targetList || draggingRow.nextElementSibling) {
                            targetList.appendChild(draggingRow);
                            moved = true;
                        }
                    } else if (after !== draggingRow.nextElementSibling || originList !== targetList) {
                        targetList.insertBefore(draggingRow, after);
                        moved = true;
                    }
                    if (moved) {
                        toggleEmptyHint(targetList);
                        if (originList !== targetList) toggleEmptyHint(originList);
                    }
                }

                function endDrag() {
                    draggingRow.classList.remove('module-customizer-row-dragging');
                    draggingRow.style.position = '';
                    draggingRow.style.top = '';
                    draggingRow.style.left = '';
                    draggingRow.style.width = '';
                    draggingRow.style.zIndex = '';
                    document.removeEventListener('pointermove', onPointerMove);
                    document.removeEventListener('pointerup', endDrag);
                    document.removeEventListener('pointercancel', endDrag);
                    document.querySelectorAll(`#${config.modalGroupsId} .settings-module-customizer-list`).forEach(toggleEmptyHint);
                    persistOrderFromDom();
                }

                try { handle.setPointerCapture(event.pointerId); } catch (error) { /* no-op: no crítico si el navegador no lo soporta */ }
                document.addEventListener('pointermove', onPointerMove);
                document.addEventListener('pointerup', endDrag);
                document.addEventListener('pointercancel', endDrag);
            });
        });
    }

    function openModal() {
        const modal = document.getElementById(config.modalId);
        if (!modal) return;
        customizerActiveBreakpoint = getSettingsModuleBreakpointId();
        renderCustomizerTabs();
        renderCustomizerGroups();
        modal.classList.add('active');
    }

    function closeModal() {
        document.getElementById(config.modalId)?.classList.remove('active');
    }

    document.getElementById(config.customizeBtnId)?.addEventListener('click', openModal);
    document.getElementById(config.modalCloseId)?.addEventListener('click', closeModal);
    document.getElementById(config.modalBackdropId)?.addEventListener('click', closeModal);

    document.querySelectorAll(`#${config.modalTabsId} .module-customizer-tab`).forEach(tab => {
        tab.addEventListener('click', () => {
            customizerActiveBreakpoint = tab.dataset.breakpoint;
            renderCustomizerTabs();
            renderCustomizerGroups();
        });
    });

    document.getElementById(config.addGroupBtnId)?.addEventListener('click', () => {
        const layout = getLayout(customizerActiveBreakpoint);
        const newGroup = { id: generateSettingsModuleGroupId(), name: nextGroupName(layout.groups.map(g => g.name)), modules: [] };
        layout.groups.push(newGroup);
        saveLayout(customizerActiveBreakpoint, layout);
        renderCustomizerGroups();
        apply();
        const input = document.querySelector(`.settings-module-customizer-group-name-input[data-group-id="${newGroup.id}"]`);
        if (input) { input.focus(); input.select(); }
    });

    document.getElementById(config.resetBtnId)?.addEventListener('click', () => {
        resetLayout(customizerActiveBreakpoint);
        renderCustomizerGroups();
        apply();
        showToast(t('moduleCustomizerResetDone'));
    });

    // Arma la página real ni bien carga la app — así ya se ve agrupada
    // incluso antes de que el usuario entre por primera vez a esta sección.
    apply();

    return { apply, openModal, closeModal };
}

const settingsModulesPageScope = createModulePageScope({
    storagePrefix: 'settingsModulesLayout_',
    moduleDefs: SETTINGS_MODULE_DEFS,
    groupsElementId: 'settings-modules-groups',
    modalId: 'settings-module-customizer-modal',
    modalTabsId: 'settings-module-customizer-tabs',
    modalGroupsId: 'settings-module-customizer-groups',
    customizeBtnId: 'settings-customize-btn',
    modalCloseId: 'settings-module-customizer-modal-close',
    modalBackdropId: 'settings-module-customizer-modal-backdrop',
    addGroupBtnId: 'settings-module-customizer-add-group-btn',
    resetBtnId: 'settings-module-customizer-reset-btn',
    defaultGroups: [
        { id: 'general', nameKey: 'settingsModuleGroupDefaultGeneral', keys: SETTINGS_MODULE_DEFS.map(mod => mod.key) },
    ],
});

// Wrapper con el mismo nombre que usaba la versión fusionada — switchSection()
// lo sigue llamando por nombre al entrar a Configuración.
function applySettingsModulesLayout() {
    settingsModulesPageScope.apply();
}

// ── Centro de ayuda ── Sidebar de categorías + buscador + panel de tarjetas
// grandes, layout fijo (sin drag & drop ni grupos personalizables -- eso se
// retiró a propósito, era el diseño viejo de #help-modules-pool). Solo 4
// categorías tienen contenido/destino real hoy (home/printers3d/laserCnc/
// library); el resto queda "Próximamente" de forma honesta en vez de
// simular un artículo que no existe.
const HELP_CAT_ICON_DEVICES = '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>';
const HELP_CAT_ICON_NETWORK = '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>';
const HELP_CAT_ICON_MAINTENANCE = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';
const HELP_CAT_ICON_TROUBLESHOOTING = '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
const HELP_CAT_ICON_FAQ = '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>';

const HELP_CATEGORIES = [
    { key: 'home', iconSvg: SETTINGS_MODULE_ICON_ABOUT, titleKey: 'helpCatHomeTitle', descKey: 'helpAboutDescription', tags: [], status: 'available', gotoSection: null },
    { key: 'printers3d', iconSvg: SETTINGS_MODULE_ICON_DASHBOARD, titleKey: 'helpCatPrintersTitle', descKey: 'helpCatPrintersDesc', tags: ['Klipper', 'Marlin', 'Bambu Lab', 'Elegoo', 'FlashForge'], status: 'available', gotoSection: 'dashboard' },
    { key: 'laserCnc', iconSvg: SETTINGS_MODULE_ICON_LASER, titleKey: 'helpCatLaserTitle', descKey: 'helpLaserBody', tags: ['GRBL', 'FluidNC', 'DLC32', 'GCode'], status: 'available', gotoSection: 'laser' },
    { key: 'library', iconSvg: SETTINGS_MODULE_ICON_MODELS, titleKey: 'helpCatLibraryTitle', descKey: 'helpCatLibraryDesc', tags: ['STL', '3MF', 'GCode'], status: 'available', gotoSection: 'models' },
    { key: 'devices', iconSvg: HELP_CAT_ICON_DEVICES, titleKey: 'helpCatDevicesTitle', descKey: 'helpCatComingSoonDesc', tags: [], status: 'coming_soon', gotoSection: null },
    { key: 'network', iconSvg: HELP_CAT_ICON_NETWORK, titleKey: 'helpCatNetworkTitle', descKey: 'helpCatComingSoonDesc', tags: [], status: 'coming_soon', gotoSection: null },
    { key: 'automation', iconSvg: SETTINGS_MODULE_ICON_MACROS, titleKey: 'helpCatAutomationTitle', descKey: 'helpCatComingSoonDesc', tags: [], status: 'coming_soon', gotoSection: null },
    { key: 'maintenance', iconSvg: HELP_CAT_ICON_MAINTENANCE, titleKey: 'helpCatMaintenanceTitle', descKey: 'helpCatComingSoonDesc', tags: [], status: 'coming_soon', gotoSection: null },
    { key: 'troubleshooting', iconSvg: HELP_CAT_ICON_TROUBLESHOOTING, titleKey: 'helpCatTroubleshootingTitle', descKey: 'helpCatComingSoonDesc', tags: [], status: 'coming_soon', gotoSection: null },
    { key: 'faq', iconSvg: HELP_CAT_ICON_FAQ, titleKey: 'helpCatFaqTitle', descKey: 'helpCatComingSoonDesc', tags: [], status: 'coming_soon', gotoSection: null },
];

let helpCenterActiveKey = 'home';

function helpCenterIcon(pathMarkup) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathMarkup}</svg>`;
}

function helpCenterMatchesQuery(cat, query) {
    if (!query) return true;
    const haystack = [t(cat.titleKey), t(cat.descKey), ...cat.tags].join(' ').toLowerCase();
    return haystack.includes(query);
}

function helpCenterCardActionsHtml(cat) {
    if (cat.key === 'home') {
        return `
            <div class="help-about-row">
                <span class="help-version-badge" id="help-version-badge">—</span>
                <a href="https://github.com/charlymigenes-ux/nopal" target="_blank" rel="noopener" class="btn-file-action">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.93.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.19 1.78 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.73 0c2.18-1.49 3.14-1.18 3.14-1.18.63 1.59.23 2.76.12 3.05.73.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14 0 1.54-.01 2.79-.01 3.17 0 .31.21.68.8.56A10.99 10.99 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>
                    <span data-i18n="helpGithub">Repositorio en GitHub</span>
                </a>
                <button type="button" class="btn-file-action btn-file-action-accent" id="help-replay-tour-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                    <span data-i18n="helpReplayTour">Repetir recorrido guiado</span>
                </button>
            </div>`;
    }
    if (cat.status === 'coming_soon') {
        return `<button type="button" class="btn-file-action help-feature-card-btn" disabled><span data-i18n="helpComingSoonBadge">Próximamente</span></button>`;
    }
    let extra = '';
    if (cat.key === 'printers3d' && currentAuthUser?.role === 'admin' && typeof openGuidedPrinterSetup === 'function') {
        extra = `<button type="button" class="btn-file-action btn-file-action-accent help-feature-card-guided-btn" id="help-open-guided-setup-btn"><span data-i18n="guidedSetupAddWizardBtn">Agregar impresora (asistente guiado)</span></button>`;
    }
    return `<button type="button" class="btn-file-action help-feature-card-btn" data-help-goto="${cat.gotoSection}"><span data-i18n="helpGotoSection">Ir a la sección</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>${extra}`;
}

function renderHelpCenter() {
    const listEl = document.getElementById('help-category-list');
    const panelEl = document.getElementById('help-panel');
    if (!listEl || !panelEl) return;
    const query = (document.getElementById('help-search-input')?.value || '').trim().toLowerCase();
    const visible = HELP_CATEGORIES.filter(cat => helpCenterMatchesQuery(cat, query));

    listEl.innerHTML = HELP_CATEGORIES.map(cat => `
        <button type="button" class="help-category-item ${cat.key === helpCenterActiveKey ? 'active' : ''} ${cat.status === 'coming_soon' ? 'coming-soon' : ''}" data-help-cat="${cat.key}">
            <span class="help-category-item-icon">${helpCenterIcon(cat.iconSvg)}</span>
            <span class="help-category-item-text">
                <span class="help-category-item-title">${escapeHtml(t(cat.titleKey))}</span>
                <span class="help-category-item-sub">${cat.status === 'coming_soon' ? escapeHtml(t('helpComingSoonBadge')) : escapeHtml(t(cat.descKey)).slice(0, 40)}</span>
            </span>
        </button>`).join('');

    panelEl.innerHTML = visible.length ? visible.map(cat => `
        <div class="help-feature-card ${cat.status === 'coming_soon' ? 'help-feature-card-coming-soon' : ''}" id="help-card-${cat.key}">
            <div class="help-feature-card-top">
                <span class="help-feature-card-icon">${helpCenterIcon(cat.iconSvg)}</span>
                <div class="help-feature-card-heading">
                    <h2>${escapeHtml(t(cat.titleKey))}</h2>
                    <p>${escapeHtml(t(cat.descKey))}</p>
                </div>
            </div>
            ${cat.tags.length ? `<div class="help-feature-card-tags">${cat.tags.map(tag => `<span class="badge badge-alt help-tag-pill">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            <div class="help-feature-card-actions">${helpCenterCardActionsHtml(cat)}</div>
        </div>`).join('') : `<p class="help-panel-empty">${escapeHtml(t('noFilesFound'))}</p>`;

    updatePageLanguage();
    if (typeof loadHelpVersion === 'function') loadHelpVersion();
}

document.addEventListener('click', event => {
    const catBtn = event.target.closest('.help-category-item');
    if (catBtn) {
        helpCenterActiveKey = catBtn.dataset.helpCat;
        renderHelpCenter();
        document.getElementById(`help-card-${helpCenterActiveKey}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const gotoBtn = event.target.closest('.help-feature-card-btn:not([disabled])');
    if (gotoBtn && gotoBtn.dataset.helpGoto) {
        switchSection(gotoBtn.dataset.helpGoto);
        setMobileNavOpen(false);
        return;
    }
    if (event.target.closest('#help-open-guided-setup-btn') && typeof openGuidedPrinterSetup === 'function') {
        openGuidedPrinterSetup();
    }
});

document.getElementById('help-search-input')?.addEventListener('input', () => renderHelpCenter());

let dashboardPrintersLoaded = false;
let dashboardLaserDevicesLoaded = false;
let dashboardPrintersLoadError = false;
let dashboardLaserDevicesLoadError = false;
let dashboardStandalonePrintersLoaded = false;
let dashboardStandalonePrintersLoading = false;
let dashboardStandalonePrinterEntries = [];
const marlinDashboardStatusCache = new Map();
let marlinDashboardStatusRefreshInFlight = false;

function deviceColumnLoadingMarkup(labelKey) {
    const accentClass = labelKey === 'laser' ? 'device-loading-orbit-laser'
        : labelKey === 'cnc' ? 'device-loading-orbit-cnc'
        : 'device-loading-orbit-printer';
    return `
        <div class="device-column-loading" role="status" aria-live="polite">
            <div class="device-loading-orbit ${accentClass}" aria-hidden="true">
                <span></span><span></span><i></i>
            </div>
        </div>
    `;
}

function renderInitialDeviceLoaders() {
    if (printersGrid && !dashboardPrintersLoaded) printersGrid.innerHTML = deviceColumnLoadingMarkup('printerType3D');
    if (lasersGrid && !dashboardLaserDevicesLoaded) lasersGrid.innerHTML = deviceColumnLoadingMarkup('laser');
    if (cncGrid && !dashboardLaserDevicesLoaded) cncGrid.innerHTML = deviceColumnLoadingMarkup('cnc');
}

async function loadPrinters() {
    if (printersLoading || document.hidden) return;
    printersLoading = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch('/api/printers/status', { signal: controller.signal });
        if (!response.ok) throw new Error('No se pudo cargar el estado de impresoras');
        const data = await response.json();
        allPrinters = data.printers || [];
        dashboardPrintersLoaded = true;
        dashboardPrintersLoadError = false;
        renderPrinters(allPrinters);
        updateActivePrintersCount();
        renderPrintQueue();
        refreshModelsQueueBadge();
    } catch (error) {
        console.error(error);
        dashboardPrintersLoaded = true;
        dashboardPrintersLoadError = true;
        renderPrinters(allPrinters);
    } finally {
        clearTimeout(timer);
        printersLoading = false;
    }
}

function standalonePrinterSortPriority(visualState) {
    if (visualState === 'offline') return 4;
    return PRINTER_STATUS_SORT_ORDER[visualState] ?? 3;
}

async function refreshDashboardMarlinStatuses(printers) {
    if (marlinDashboardStatusRefreshInFlight || !printers.length) return;
    marlinDashboardStatusRefreshInFlight = true;
    try {
        const results = await Promise.all(printers.map(async printer => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5500);
            try {
                const response = await fetch(`/api/marlin-printers/status?device=${encodeURIComponent(printer.device)}`, { signal: controller.signal });
                if (!response.ok) return null;
                return { device: printer.device, status: await response.json() };
            } catch {
                return null;
            } finally {
                clearTimeout(timer);
            }
        }));
        let changed = false;
        results.filter(Boolean).forEach(({ device, status }) => {
            marlinDashboardStatusCache.set(String(device), status);
            changed = true;
        });
        if (changed) setTimeout(() => loadDashboardStandalonePrinters({ skipMarlinStatusRefresh: true }), 0);
    } finally {
        marlinDashboardStatusRefreshInFlight = false;
    }
}

async function loadDashboardStandalonePrinters({ skipMarlinStatusRefresh = false } = {}) {
    if (dashboardStandalonePrintersLoading || document.hidden) return;
    dashboardStandalonePrintersLoading = true;
    try {
        const requests = [
            fetch('/api/marlin-printers/registry/status').then(res => res.ok ? res.json() : Promise.reject(new Error('Marlin'))),
            fetch('/api/marlin-printers/jobs/active').then(res => res.ok ? res.json() : Promise.reject(new Error('Marlin jobs'))),
            fetch('/api/elegoo/printers').then(res => res.ok ? res.json() : Promise.reject(new Error('Elegoo'))),
            fetch('/api/flashforge/printers').then(res => res.ok ? res.json() : Promise.reject(new Error('FlashForge'))),
            fetch('/api/bambu/printers').then(res => res.ok ? res.json() : Promise.reject(new Error('Bambu'))),
        ];
        const [marlinResult, marlinJobsResult, elegooResult, flashforgeResult, bambuResult] = await Promise.allSettled(requests);
        const entries = [];

        if (marlinResult.status === 'fulfilled') {
            const printers = marlinResult.value.printers || [];
            const jobs = marlinJobsResult.status === 'fulfilled' ? (marlinJobsResult.value.jobs || []) : [];
            const jobsByDevice = new Map(jobs.map(job => [String(job.device), job]));
            marlinPrintersRegistryCache = printers;
            printers.forEach(printer => {
                const job = jobsByDevice.get(String(printer.device));
                const state = job?.state === 'running' ? 'printing' : (job?.state || 'idle');
                const cachedStatus = marlinDashboardStatusCache.get(String(printer.device)) || {};
                const status = { ...cachedStatus, connected: Boolean(printer.online), state };
                const visualState = getMarlinPrinterVisualState(status);
                entries.push({
                    type: 'marlin', id: printer.device,
                    isOnline: Boolean(printer.online),
                    sortPriority: standalonePrinterSortPriority(visualState),
                    html: marlinPrinterCardHtml(printer, status),
                });
            });
            if (!skipMarlinStatusRefresh) void refreshDashboardMarlinStatuses(printers);
        }

        if (elegooResult.status === 'fulfilled') {
            const printers = elegooResult.value.printers || [];
            elegooPrintersRegistryCache = printers;
            printers.forEach(printer => {
                const visualState = getElegooVisualState(printer);
                entries.push({
                    type: 'elegoo', id: printer.id,
                    isOnline: visualState !== 'offline',
                    sortPriority: standalonePrinterSortPriority(visualState),
                    html: elegooPrinterCardHtml(printer),
                });
            });
        }

        if (flashforgeResult.status === 'fulfilled') {
            const printers = flashforgeResult.value.printers || [];
            flashforgePrintersRegistryCache = printers;
            printers.forEach(printer => {
                const visualState = getFlashforgeVisualState(printer);
                entries.push({
                    type: 'flashforge', id: printer.id,
                    isOnline: visualState !== 'offline',
                    sortPriority: standalonePrinterSortPriority(visualState),
                    html: flashforgePrinterCardHtml(printer),
                });
            });
        }

        if (bambuResult.status === 'fulfilled') {
            const printers = bambuResult.value.printers || [];
            bambuPrintersRegistryCache = printers;
            printers.forEach(printer => {
                const visualState = getBambuVisualState(printer);
                entries.push({
                    type: 'bambu', id: printer.id,
                    isOnline: visualState !== 'offline',
                    sortPriority: standalonePrinterSortPriority(visualState),
                    html: bambuPrinterCardHtml(printer),
                });
            });
        }

        dashboardStandalonePrinterEntries = entries;
        dashboardStandalonePrintersLoaded = true;
        renderPrinters(allPrinters);
        updateActivePrintersCount();
    } catch (error) {
        console.error(error);
    } finally {
        dashboardStandalonePrintersLoading = false;
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
            ${deviceStateThermalWave(visualState, host)}
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${hostLabel ? escapeHtml(hostLabel) : typeLabel}</h3>
                    ${hostLabel ? `<p class="printer-name-sub">${typeLabel}</p>` : ''}
                </div>
                <div class="printer-quick-actions">
                    <div class="printer-status-icon ${isOnline ? 'online' : 'offline'}" title="${statusText}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                    </div>
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
            <div class="printer-card-camera" data-cam-container="${kind === 'cnc' ? 'cnc' : 'laser'}:${escapeHtml(host)}"></div>
        </div>
    `;
}

function bindMarlinTemperatureActions(root) {
    root.querySelectorAll('.printer-card[data-marlin-device]').forEach(card => {
        card.querySelectorAll('[data-marlin-temp-action]').forEach(button => {
            if (boundMarlinTemperatureButtons.has(button)) return;
            boundMarlinTemperatureButtons.add(button);
            button.addEventListener('click', async event => {
            event.stopPropagation();
            const device = card.dataset.marlinDevice;
            const printer = marlinPrintersRegistryCache.find(item => item.device === device) || {};
            const heaters = ['heater_bed', printer.extruder_count === 2 ? 'extruder0' : 'extruder'];
            if (printer.extruder_count === 2) heaters.push('extruder1');
            if (button.dataset.marlinTempAction === 'preheat') {
                openMaterialPreheatModal({ type: 'marlin', id: device, name: printer.name || card.querySelector('.printer-name')?.textContent || 'Marlin', heaters });
            } else {
                try { await Promise.all(heaters.map(heater => setMarlinHeaterTarget(device, heater, 0))); showToast('Calentadores Marlin apagados'); }
                catch (error) { showToast(error.message, 'error'); }
            }
            });
        });
    });
}

let dashboardLaserEntries = [];

async function refreshDashboardLaserCard() {
    if (document.hidden) return;
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
        dashboardLaserDevicesLoadError = false;
    } catch (error) {
        console.error(error);
        dashboardLaserEntries = [];
        dashboardLaserDevicesLoadError = true;
    }
    dashboardLaserDevicesLoaded = true;
    renderPrinters(allPrinters);
}

function isShowOfflineMachinesEnabled() {
    return localStorage.getItem('showOfflineMachines') !== 'false';
}

function isOnboardingHintsEnabled() {
    return localStorage.getItem('onboardingHintsEnabled') !== 'false';
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
// Prefijo persistente que refleja la salud del sistema (ver
// computeEffectiveHealth) para que se pueda ver un error/advertencia con
// solo mirar la pestaña del navegador, sin tener NOPAL enfocado. El flash de
// una alerta puntual (ver notifyUser) tiene prioridad temporal sobre esto,
// pero al terminar restaura este prefijo en vez del título original a secas.
let statusTabTitlePrefix = '';

function flashBrowserTabTitle(text) {
    if (tabTitleFlashTimeout) clearTimeout(tabTitleFlashTimeout);
    document.title = `🔔 ${text}`;
    tabTitleFlashTimeout = setTimeout(() => {
        document.title = `${statusTabTitlePrefix}${ORIGINAL_TAB_TITLE}`;
        tabTitleFlashTimeout = null;
    }, 5000);
}

function updateStatusTabTitle() {
    const health = computeEffectiveHealth();
    statusTabTitlePrefix = health === 'error' ? '⛔ ' : health === 'warning' ? '⚠️ ' : '';
    if (!tabTitleFlashTimeout) {
        document.title = `${statusTabTitlePrefix}${ORIGINAL_TAB_TITLE}`;
    }
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
    [printersGrid, lasersGrid, cncGrid, document.getElementById('marlin-printers-grid')].forEach(grid => {
        if (grid) grid.classList.toggle('list-view', mode === 'list');
    });
    [['view-grid-printers', 'view-list-printers'], ['view-grid-marlin', 'view-list-marlin']].forEach(([gridId, listId]) => {
        const gridBtn = document.getElementById(gridId);
        const listBtn = document.getElementById(listId);
        if (gridBtn) gridBtn.classList.toggle('btn-view-toggle-active', mode === 'grid');
        if (listBtn) listBtn.classList.toggle('btn-view-toggle-active', mode === 'list');
    });
}

// Organizador local de las tres columnas del dashboard. No afecta otras
// páginas ni el registro real de máquinas: solo orden y visibilidad visual.
const DEVICE_COLUMNS_LAYOUT_KEY = 'dashboardDeviceColumnsLayout';
const DEVICE_COLUMNS_DEFAULT_ORDER = ['printer', 'laser', 'cnc'];
const DEVICE_COLUMN_DEFINITIONS = {
    printer: { labelKey: 'printerType3D', accentClass: 'printer' },
    laser: { labelKey: 'laser', accentClass: 'laser' },
    cnc: { labelKey: 'cnc', accentClass: 'cnc' },
};

// Modo grupo (columnas por tipo, default) vs modo mixto (todos los
// dispositivos juntos en una sola grilla, sin agrupar) — no cambia grid/list,
// solo si hay o no separación por tipo de máquina.
const DEVICES_GROUP_MODE_KEY = 'devicesGroupMode';

function getDevicesGroupMode() {
    return localStorage.getItem(DEVICES_GROUP_MODE_KEY) === 'mixed' ? 'mixed' : 'grouped';
}

function setDevicesGroupMode(mode) {
    localStorage.setItem(DEVICES_GROUP_MODE_KEY, mode === 'mixed' ? 'mixed' : 'grouped');
    devicesGroupModeBtn?.classList.toggle('btn-view-toggle-active', mode === 'mixed');
    if (machinesColumns) machinesColumns.hidden = mode === 'mixed';
    if (machinesMixedGrid) machinesMixedGrid.hidden = mode !== 'mixed';
    renderPrinters(allPrinters);
}

function getDeviceColumnsLayout() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(DEVICE_COLUMNS_LAYOUT_KEY) || 'null');
    } catch (error) {
        saved = null;
    }
    const savedOrder = Array.isArray(saved?.order) ? saved.order.filter(key => DEVICE_COLUMNS_DEFAULT_ORDER.includes(key)) : [];
    const order = [...savedOrder, ...DEVICE_COLUMNS_DEFAULT_ORDER.filter(key => !savedOrder.includes(key))];
    const hidden = Array.isArray(saved?.hidden) ? saved.hidden.filter(key => DEVICE_COLUMNS_DEFAULT_ORDER.includes(key)) : [];
    if (hidden.length >= DEVICE_COLUMNS_DEFAULT_ORDER.length) hidden.pop();
    return { order, hidden };
}

function saveDeviceColumnsLayout(layout) {
    localStorage.setItem(DEVICE_COLUMNS_LAYOUT_KEY, JSON.stringify(layout));
}

// Conteo de dispositivos visibles por categoría, actualizado en cada
// renderPrinters() — null significa "todavía no se sabe" (cargando o con
// error), y a propósito no colapsa la columna en ese caso para no achicarla
// de golpe y luego tener que volver a agrandarla cuando llegue el dato real.
let lastDeviceCategoryCounts = { printer: null, laser: null, cnc: null };

function applyDeviceColumnsLayout() {
    if (!machinesColumns) return;
    const layout = getDeviceColumnsLayout();
    const hiddenSet = new Set(layout.hidden);
    let visibleCount = 0;
    layout.order.forEach(key => {
        const column = machinesColumns.querySelector(`[data-device-column="${key}"]`);
        if (!column) return;
        const isManuallyHidden = hiddenSet.has(key);
        const isDynamicallyEmpty = lastDeviceCategoryCounts[key] === 0;
        const shouldHide = isManuallyHidden || isDynamicallyEmpty;
        column.hidden = shouldHide;
        if (!shouldHide) visibleCount++;
        machinesColumns.appendChild(column);
    });
    machinesColumns.style.setProperty('--machines-visible-columns', String(Math.max(1, visibleCount)));
    const isCustomized = hiddenSet.size > 0 || layout.order.some((key, index) => key !== DEVICE_COLUMNS_DEFAULT_ORDER[index]);
    deviceColumnsCustomizerBtn?.classList.toggle('btn-view-toggle-active', isCustomized);
}

function saveDeviceColumnsCustomizerState() {
    const list = document.getElementById('device-columns-customizer-list');
    if (!list) return;
    const rows = Array.from(list.querySelectorAll(':scope > .module-customizer-row[data-device-column]'));
    const order = rows.map(row => row.dataset.deviceColumn);
    const hidden = rows.filter(row => !row.querySelector('input')?.checked).map(row => row.dataset.deviceColumn);
    saveDeviceColumnsLayout({ order, hidden });
    applyDeviceColumnsLayout();
}

function renderDeviceColumnsCustomizer() {
    const list = document.getElementById('device-columns-customizer-list');
    if (!list) return;
    const layout = getDeviceColumnsLayout();
    const hiddenSet = new Set(layout.hidden);
    list.innerHTML = layout.order.map(key => {
        const definition = DEVICE_COLUMN_DEFINITIONS[key];
        return `
            <div class="module-customizer-row device-column-customizer-row" data-device-column="${key}">
                <span class="module-customizer-row-handle" title="${escapeHtml(t('deviceOrganizerDragHint'))}">${PRINTER_MODULE_DRAG_ICON}</span>
                <span class="device-column-customizer-accent device-column-customizer-accent-${definition.accentClass}" aria-hidden="true"></span>
                <span class="module-customizer-row-label">${escapeHtml(t(definition.labelKey))}</span>
                <label class="module-customizer-row-toggle">
                    <input type="checkbox" class="module-customizer-checkbox module-customizer-checkbox-green" data-device-column="${key}" ${hiddenSet.has(key) ? '' : 'checked'}>
                    <span></span>
                </label>
            </div>
        `;
    }).join('');

    initModuleCustomizerDrag(list, saveDeviceColumnsCustomizerState);
    list.querySelectorAll('input.module-customizer-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const checkedCount = list.querySelectorAll('input.module-customizer-checkbox:checked').length;
            if (!checkedCount) {
                checkbox.checked = true;
                showToast(t('deviceOrganizerAtLeastOne'), 'warning');
                return;
            }
            saveDeviceColumnsCustomizerState();
        });
    });
}

function openDeviceColumnsCustomizer() {
    renderDeviceColumnsCustomizer();
    document.getElementById('device-columns-customizer-modal')?.classList.add('active');
}

function closeDeviceColumnsCustomizer() {
    document.getElementById('device-columns-customizer-modal')?.classList.remove('active');
}

deviceColumnsCustomizerBtn?.addEventListener('click', openDeviceColumnsCustomizer);
document.getElementById('device-columns-customizer-modal-close')?.addEventListener('click', closeDeviceColumnsCustomizer);
document.getElementById('device-columns-customizer-modal-backdrop')?.addEventListener('click', closeDeviceColumnsCustomizer);
document.getElementById('device-columns-customizer-reset-btn')?.addEventListener('click', () => {
    localStorage.removeItem(DEVICE_COLUMNS_LAYOUT_KEY);
    applyDeviceColumnsLayout();
    renderDeviceColumnsCustomizer();
    showToast(t('moduleCustomizerResetDone'));
});

devicesGroupModeBtn?.addEventListener('click', () => {
    setDevicesGroupMode(getDevicesGroupMode() === 'mixed' ? 'grouped' : 'mixed');
});

// Organizador de las secciones internas de la tarjeta de impresora 3D
// (encabezado/estado/miniatura/temperaturas) — solo orden, sin ocultar
// secciones (a diferencia del organizador de columnas de arriba).
const PRINTER_CARD_LAYOUT_KEY = 'printerCardSectionsLayout';
const PRINTER_CARD_SECTIONS_DEFAULT_ORDER = ['header', 'badge', 'thumbnail', 'temps'];
const PRINTER_CARD_SECTION_LABEL_KEYS = {
    header: 'printerCardSectionHeader',
    badge: 'printerCardSectionBadge',
    thumbnail: 'printerCardSectionThumbnail',
    temps: 'printerCardSectionTemps',
};

function getPrinterCardLayout() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(PRINTER_CARD_LAYOUT_KEY) || 'null');
    } catch (error) {
        saved = null;
    }
    const savedOrder = Array.isArray(saved) ? saved.filter(key => PRINTER_CARD_SECTIONS_DEFAULT_ORDER.includes(key)) : [];
    return [...savedOrder, ...PRINTER_CARD_SECTIONS_DEFAULT_ORDER.filter(key => !savedOrder.includes(key))];
}

function savePrinterCardLayout(order) {
    localStorage.setItem(PRINTER_CARD_LAYOUT_KEY, JSON.stringify(order));
}

function printerCardSectionOrder(sectionKey) {
    const index = getPrinterCardLayout().indexOf(sectionKey);
    return index === -1 ? 0 : index;
}

function renderPrinterCardCustomizer() {
    const list = document.getElementById('printer-card-customizer-list');
    if (!list) return;
    const layout = getPrinterCardLayout();
    list.innerHTML = layout.map(key => `
        <div class="module-customizer-row printer-card-customizer-row" data-printer-card-section="${key}">
            <span class="module-customizer-row-handle" title="${escapeHtml(t('printerCardOrganizerDragHint'))}">${PRINTER_MODULE_DRAG_ICON}</span>
            <span class="module-customizer-row-label">${escapeHtml(t(PRINTER_CARD_SECTION_LABEL_KEYS[key]))}</span>
        </div>
    `).join('');

    initModuleCustomizerDrag(list, () => {
        const rows = Array.from(list.querySelectorAll(':scope > .printer-card-customizer-row'));
        savePrinterCardLayout(rows.map(row => row.dataset.printerCardSection));
        renderPrinters(allPrinters);
    });
}

function openPrinterCardCustomizer() {
    renderPrinterCardCustomizer();
    document.getElementById('printer-card-customizer-modal')?.classList.add('active');
}

function closePrinterCardCustomizer() {
    document.getElementById('printer-card-customizer-modal')?.classList.remove('active');
}

printerCardCustomizerBtn?.addEventListener('click', openPrinterCardCustomizer);
document.getElementById('printer-card-customizer-modal-close')?.addEventListener('click', closePrinterCardCustomizer);
document.getElementById('printer-card-customizer-modal-backdrop')?.addEventListener('click', closePrinterCardCustomizer);
document.getElementById('printer-card-customizer-reset-btn')?.addEventListener('click', () => {
    localStorage.removeItem(PRINTER_CARD_LAYOUT_KEY);
    renderPrinterCardCustomizer();
    renderPrinters(allPrinters);
    showToast(t('moduleCustomizerResetDone'));
});

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

// Alertas LED por máquina. El panel solo publica cambios de estado; toda la
// selección de hardware y ejecución vive dentro de Automatización de Taller.
const machineLedPlugin = { checked: false, installed: false, available: false };
const machineLedLastState = new Map();
const machineLedEnabledCache = new Map();
// {machine_key: runs[]} -- último "runs" (tramos start/count/color) que el
// backend confirmó como realmente pintado en la tira física para esa
// máquina, solo cuando el accesorio tiene "Mostrar en panel" activado (ver
// machine_led_automation.apply_state). Se pinta desde acá (no en cada
// respuesta) porque la tarjeta se reconstruye por innerHTML en cada ciclo
// de polling -- ver decorateMachineCardsWithLedSettings.
const machineLedRenderCache = new Map();
let machineLedCurrentMachine = null;

async function fetchMachineLedEnabledStates() {
    try {
        const response = await fetch('/api/accessories/machine-led/enabled');
        if (!response.ok) return null;
        return (await response.json()).enabled || {};
    } catch (error) {
        return null;
    }
}

function machineLedCardIdentity(card) {
    const name = card.querySelector('.printer-name')?.textContent?.trim() || 'Máquina';
    if (card.dataset.port) return { type: 'klipper', id: card.dataset.port, name };
    if (card.dataset.marlinDevice) return { type: 'marlin', id: card.dataset.marlinDevice, name };
    if (card.dataset.elegooId) return { type: 'elegoo', id: card.dataset.elegooId, name };
    if (card.dataset.flashforgeId) return { type: 'flashforge', id: card.dataset.flashforgeId, name };
    if (card.dataset.bambuId) return { type: 'bambu', id: card.dataset.bambuId, name };
    if (card.dataset.laserHost) return {
        type: card.classList.contains('printer-card-type-cnc') ? 'cnc' : 'laser',
        id: card.dataset.laserHost,
        name,
    };
    return null;
}

function machineLedCardState(card) {
    // "Enfriando" no es un estado real de la impresora (Klipper/Marlin/etc.
    // vuelven a "idle" en cuanto el target baja a 0) -- se detecta aparte
    // por la clase printer-card-cool que ya usa el tema visual de la
    // tarjeta mientras la temperatura sigue bajando.
    if (card.classList.contains('printer-card-cool')) return 'cooling';
    return ['heating', 'printing', 'paused', 'completed', 'error', 'offline', 'idle']
        .find(state => card.classList.contains(state)) || (card.classList.contains('offline') ? 'offline' : 'idle');
}

// Progreso 0-100 hacia el objetivo de temperatura, guardado por cada tarjeta
// como data-heat-progress al renderizarse (ver computeHeatProgress). Nadie
// obliga a que exista -- máquinas sin ese dato simplemente no animan el
// degradado y usan el color fijo configurado para el estado.
function machineLedCardProgress(card) {
    const raw = card.dataset.heatProgress;
    if (raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

// Progreso hacia el objetivo de temperatura = el calentador que le falta
// más (no el promedio) -- si cama y extrusor calientan a la vez, el LED no
// se ve "casi listo" hasta que los dos de verdad lo estén.
function computeHeatProgress(bedTemp, bedTarget, extruderTemp, extruderTarget) {
    const ratios = [];
    if (bedTarget > 0 && typeof bedTemp === 'number') ratios.push(Math.max(0, Math.min(1, bedTemp / bedTarget)));
    if (extruderTarget > 0 && typeof extruderTemp === 'number') ratios.push(Math.max(0, Math.min(1, extruderTemp / extruderTarget)));
    if (!ratios.length) return null;
    return Math.round(Math.min(...ratios) * 100);
}

async function ensureMachineLedPluginStatus() {
    if (machineLedPlugin.checked) return machineLedPlugin;
    machineLedPlugin.checked = true;
    try {
        const response = await fetch('/api/plugins');
        const plugins = response.ok ? ((await response.json()).plugins || []) : [];
        const plugin = plugins.find(item => item.id === 'arduino-accessories');
        machineLedPlugin.installed = Boolean(plugin?.installed && plugin?.enabled);
        machineLedPlugin.available = machineLedPlugin.installed;
    } catch (error) {
        machineLedPlugin.installed = false;
    }
    return machineLedPlugin;
}

const matrizLedPlugin = { checked: false, installed: false };

async function ensureMatrizLedPluginStatus() {
    if (matrizLedPlugin.checked) return matrizLedPlugin;
    matrizLedPlugin.checked = true;
    try {
        const response = await fetch('/api/plugins');
        const plugins = response.ok ? ((await response.json()).plugins || []) : [];
        const plugin = plugins.find(item => item.id === 'matriz-led');
        matrizLedPlugin.installed = Boolean(plugin?.installed && plugin?.enabled);
    } catch (error) {
        matrizLedPlugin.installed = false;
    }
    return matrizLedPlugin;
}

// Mismo vocabulario de estados que MACHINE_STATES/MACHINE_STATE_LABELS en
// el propio matriz-led.js (plugins/matriz-led/frontend/matriz-led.js) --
// duplicado a propósito: este archivo es el core de NOPAL y no debe
// importar código de un plugin, que puede no estar instalado.
const MACHINE_LED_MATRIX_STATES = ['idle', 'heating', 'cooling', 'printing', 'paused', 'complete', 'error', 'offline'];
const MACHINE_LED_MATRIX_STATE_LABELS = {
    idle: 'En espera', heating: 'Calentando', cooling: 'Enfriando', printing: 'Trabajando',
    paused: 'Pausada', complete: 'Finalizada', error: 'Error', offline: 'Desconectada',
};

const machineLedTabsSwitch = createOptionSwitch('machine-led-tabs', tab => {
    document.getElementById('machine-led-content').hidden = tab !== 'strip';
    document.getElementById('machine-led-matrix-content').hidden = tab !== 'matrix';
});

async function publishMachineLedState(machine, state, progress) {
    const key = `${machine.type}:${machine.id}`;
    // Con heating/cooling el estado no cambia mientras sube o baja la
    // temperatura, así que deduplicar solo por estado nunca dejaría
    // avanzar el degradado. Se redondea a saltos de 5% -- el backend hace
    // la deduplicación fina de verdad contra la cantidad de LEDs prendidos.
    const isGradientState = (state === 'heating' || state === 'cooling') && progress != null;
    const dedupValue = isGradientState ? `${state}:${Math.round(progress / 5) * 5}` : state;
    if (machineLedLastState.get(key) === dedupValue) return;
    const plugin = await ensureMachineLedPluginStatus();
    if (!plugin.installed || !plugin.available) return;
    const form = new FormData();
    form.append('machine_type', machine.type);
    form.append('machine_id', machine.id);
    form.append('state', state);
    if (isGradientState) form.append('progress', String(Math.round(progress)));
    try {
        const response = await fetch('/api/accessories/machine-led/state', { method: 'POST', body: form });
        if (response.status === 404) {
            machineLedPlugin.available = false;
            return;
        }
        if (response.ok) {
            machineLedLastState.set(key, dedupValue);
            const data = await response.json().catch(() => null);
            if (data?.show_on_panel && data.runs?.length) {
                machineLedRenderCache.set(key, data.runs);
            } else {
                machineLedRenderCache.delete(key);
            }
        }
    } catch (error) {
        console.debug('Alertas LED no disponibles:', error);
    }
}

// Réplica visual (puntos de color) de los LEDs que la automatización ya
// pintó físicamente para esta máquina -- de hasta 40 LEDs, uno por punto;
// segmentos más largos se resumen como barras proporcionales por tramo
// para no inflar el DOM con cientos de nodos.
function machineLedIndicatorHtml(runs) {
    const total = runs.reduce((sum, run) => sum + run.count, 0);
    if (total <= 0) return '';
    if (total > 40) {
        const bars = runs.map(run => {
            const color = `rgb(${run.color[0]}, ${run.color[1]}, ${run.color[2]})`;
            return `<span class="machine-led-bar" style="width:${(run.count / total) * 100}%;background:${color}"></span>`;
        }).join('');
        return `<span class="machine-led-indicator machine-led-indicator-bars" title="Reflejo de la iluminación física (${total} LEDs)">${bars}</span>`;
    }
    const dots = [];
    runs.forEach(run => {
        const color = `rgb(${run.color[0]}, ${run.color[1]}, ${run.color[2]})`;
        for (let i = 0; i < run.count; i++) dots.push(`<span class="machine-led-dot" style="background:${color}"></span>`);
    });
    return `<span class="machine-led-indicator" title="Reflejo de la iluminación física">${dots.join('')}</span>`;
}

function ensureMachineLedIndicator(card, key) {
    const header = card.querySelector('.printer-card-top');
    if (!header) return;
    const actions = header.querySelector('.printer-quick-actions') || header;
    const existing = actions.querySelector('.machine-led-indicator');
    const runs = machineLedRenderCache.get(key);
    const html = runs ? machineLedIndicatorHtml(runs) : '';
    if (!html) {
        existing?.remove();
        return;
    }
    if (existing) existing.outerHTML = html;
    else actions.insertAdjacentHTML('afterbegin', html);
}

function machineLedButtonHtml(machine) {
    return `<button type="button" class="machine-led-settings-btn" title="Alertas visuales LED" aria-label="Configurar alertas LED de ${escapeHtml(machine.name)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.37.34.7.64.96.3.25.68.4 1.08.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg></button>`;
}

// Asegura el botón de forma síncrona -- nunca detrás de un await. La causa
// del parpadeo era justo que esta función esperaba una respuesta de red
// (fetchMachineLedEnabledStates) antes de crear el botón: la tarjeta se
// reconstruye por innerHTML en cada ciclo de polling y, mientras la
// promesa seguía pendiente, quedaba sin botón unos cuantos frames.
function ensureMachineLedButton(card, machine) {
    const header = card.querySelector('.printer-card-top');
    if (!header) return null;
    let button = header.querySelector('.machine-led-settings-btn');
    if (button) return button;
    const actions = header.querySelector('.printer-quick-actions') || header;
    actions.insertAdjacentHTML('afterbegin', machineLedButtonHtml(machine));
    button = header.querySelector('.machine-led-settings-btn');
    button.addEventListener('click', event => {
        event.stopPropagation();
        openMachineLedModal(machine);
    });
    return button;
}

function decorateMachineCardsWithLedSettings(root) {
    const entries = Array.from(root.querySelectorAll('.printer-card'))
        .map(card => ({ card, machine: machineLedCardIdentity(card) }))
        .filter(entry => entry.machine);
    if (!entries.length) return;

    entries.forEach(({ card, machine }) => {
        const key = `${machine.type}:${machine.id}`;
        const button = ensureMachineLedButton(card, machine);
        if (button) button.classList.toggle('is-enabled', Boolean(machineLedEnabledCache.get(key)));
        ensureMachineLedIndicator(card, key);
        publishMachineLedState(machine, machineLedCardState(card), machineLedCardProgress(card));
    });

    // El color verde/gris (habilitado o no) sí puede llegar un ciclo tarde
    // sin que se note -- se refresca aparte, sin bloquear la creación del
    // botón ni el resto del render.
    refreshMachineLedEnabledCache(entries);
}

async function refreshMachineLedEnabledCache(entries) {
    const freshEnabled = await fetchMachineLedEnabledStates();
    if (!freshEnabled) return;
    machineLedEnabledCache.clear();
    Object.entries(freshEnabled).forEach(([key, value]) => machineLedEnabledCache.set(key, value));
    entries.forEach(({ card, machine }) => {
        const button = card.querySelector('.machine-led-settings-btn');
        if (!button) return;
        const key = `${machine.type}:${machine.id}`;
        button.classList.toggle('is-enabled', Boolean(machineLedEnabledCache.get(key)));
    });
}

function machineLedUnavailableMarkup(installed) {
    return `<div class="machine-led-empty">
        <div class="machine-led-empty-icon">${installed ? '!' : '✦'}</div>
        <h3>${installed ? 'El plugin necesita actualizarse' : 'Activa las alertas visuales'}</h3>
        <p>${installed
            ? 'Automatización de Taller está instalado, pero esta versión todavía no expone la configuración de escenas por máquina.'
            : 'Esta opción aparece al instalar el plugin Automatización de Taller. El control de tus máquinas sigue funcionando sin él.'}</p>
        <button type="button" class="machine-led-primary" data-machine-led-open-plugins>${installed ? 'Ver actualización' : 'Instalar plugin'}</button>
    </div>`;
}

function machineLedRgbToHex(rgb) {
    return `#${(rgb || [0, 0, 0]).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
}

function machineLedHexToRgb(hex) {
    return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
}

function renderMachineLedEditor(payload) {
    const content = document.getElementById('machine-led-content');
    const targets = payload.targets || [];
    if (!targets.length) {
        content.innerHTML = `<div class="machine-led-empty"><div class="machine-led-empty-icon">⌁</div>
            <h3>Falta registrar una tira LED</h3>
            <p>El plugin está instalado, pero todavía no hay una tira PWM o WS2812 registrada como accesorio. Agrégala en Automatización de Taller y vuelve aquí.</p>
            <button type="button" class="machine-led-primary" data-machine-led-open-accessories>Abrir Automatización de Taller</button></div>`;
        return;
    }
    const saved = payload.config || {};
    const selectedId = saved.accessory_id || targets[0].id;
    const selected = targets.find(item => item.id === selectedId) || targets[0];
    const colors = { ...(payload.default_colors || {}), ...(saved.colors || {}) };
    const stateLabels = { idle: 'En espera', heating: 'Calentando', cooling: 'Enfriando', printing: 'Trabajando', paused: 'Pausada', completed: 'Finalizada', error: 'Error', offline: 'Desconectada' };
    const total = selected.led_count || 1;
    const start = saved.start ?? 0;
    const count = saved.count ?? total;
    content.innerHTML = `<form id="machine-led-form">
        <label class="machine-led-enable"><span><strong>Usar alertas visuales</strong><small>Esta máquina enviará sus cambios de estado al accesorio LED.</small></span>
            <input type="checkbox" id="machine-led-enabled" ${saved.enabled ? 'checked' : ''}></label>
        <label class="machine-led-field"><span>Tira LED</span><select id="machine-led-target">${targets.map(target => `<option value="${escapeHtml(target.id)}" ${target.id === selected.id ? 'selected' : ''}>${escapeHtml(target.name)} · ${target.led_count || '?'} LEDs</option>`).join('')}</select></label>
        <div class="machine-led-segment-title"><strong>Zona asignada</strong><span id="machine-led-segment-summary">LED ${start + 1}–${start + count} de ${total}</span></div>
        <div class="machine-led-pixels" id="machine-led-pixels"></div>
        <div class="machine-led-segment-fields">
            <label class="machine-led-field"><span>Empieza en</span><input id="machine-led-start" type="number" min="1" max="${total}" value="${start + 1}"></label>
            <label class="machine-led-field"><span>Cantidad</span><input id="machine-led-count" type="number" min="1" max="${total}" value="${count}"></label>
        </div>
        <div class="machine-led-protocol-note" id="machine-led-protocol-note" ${selected.segment_capable ? 'hidden' : ''}>
            <span id="machine-led-protocol-note-text">Esta placa usa protocolo ${selected.protocol || 3}: puede usar la tira completa. Los repartos 4+4, 3+5 o similares se habilitan al actualizarla a protocolo 4.</span>
            <button type="button" class="machine-led-update-btn" id="machine-led-update-firmware-btn">Actualizar placa</button>
        </div>
        <div class="machine-led-colors"><strong>Color para cada estado</strong>${(payload.states || []).map(state => `<label><span>${stateLabels[state] || state}</span><input type="color" data-machine-led-color="${state}" value="${machineLedRgbToHex(colors[state])}"></label>`).join('')}</div>
        <div class="machine-led-actions"><button type="button" class="machine-led-secondary" data-machine-led-cancel>Cancelar</button><button type="submit" class="machine-led-primary">Guardar escena</button></div>
    </form>`;

    const targetSelect = document.getElementById('machine-led-target');
    const startInput = document.getElementById('machine-led-start');
    const countInput = document.getElementById('machine-led-count');
    const drawPixels = () => {
        const target = targets.find(item => item.id === targetSelect.value) || targets[0];
        const targetTotal = target.led_count || 1;
        if (!target.segment_capable) { startInput.value = 1; countInput.value = targetTotal; }
        startInput.disabled = !target.segment_capable;
        countInput.disabled = !target.segment_capable;
        startInput.max = targetTotal;
        countInput.max = targetTotal;
        let zoneStart = Math.max(0, Number(startInput.value) - 1);
        let zoneCount = Math.max(1, Number(countInput.value));
        if (zoneStart + zoneCount > targetTotal) zoneCount = targetTotal - zoneStart;
        document.getElementById('machine-led-pixels').innerHTML = Array.from({ length: targetTotal }, (_, index) => `<i class="${index >= zoneStart && index < zoneStart + zoneCount ? 'selected' : ''}" title="LED ${index + 1}"></i>`).join('');
        document.getElementById('machine-led-segment-summary').textContent = `LED ${zoneStart + 1}–${zoneStart + zoneCount} de ${targetTotal}`;
        const note = document.getElementById('machine-led-protocol-note');
        note.hidden = target.segment_capable;
        if (!target.segment_capable) {
            document.getElementById('machine-led-protocol-note-text').textContent =
                `Esta placa usa protocolo ${target.protocol || 3}: puede usar la tira completa. Los repartos se habilitan al actualizarla a protocolo 4.`;
        }
    };
    [targetSelect, startInput, countInput].forEach(input => input.addEventListener('input', drawPixels));
    drawPixels();
    document.getElementById('machine-led-form').addEventListener('submit', saveMachineLedConfig);
    document.getElementById('machine-led-update-firmware-btn')?.addEventListener('click', () => {
        const target = targets.find(item => item.id === targetSelect.value) || targets[0];
        openFirmwareUpdateModal(target.id, target.name);
    });
}

async function openMachineLedModal(machine) {
    machineLedCurrentMachine = machine;
    const modal = document.getElementById('machine-led-modal');
    document.getElementById('machine-led-machine-name').textContent = `${machine.name} · escena independiente`;
    const content = document.getElementById('machine-led-content');
    content.innerHTML = '<div class="machine-led-loading">Leyendo configuración…</div>';
    const tabs = document.getElementById('machine-led-tabs');
    tabs.hidden = true;
    if (machineLedTabsSwitch) machineLedTabsSwitch.setValue('strip');
    content.hidden = false;
    document.getElementById('machine-led-matrix-content').hidden = true;
    modal.hidden = false;
    setupMachineLedMatrixTab(machine);
    const plugin = await ensureMachineLedPluginStatus();
    if (!plugin.installed) {
        content.innerHTML = machineLedUnavailableMarkup(false);
        return;
    }
    try {
        const query = new URLSearchParams({ machine_type: machine.type, machine_id: machine.id });
        const response = await fetch(`/api/accessories/machine-led/config?${query}`);
        if (!response.ok) {
            machineLedPlugin.available = false;
            content.innerHTML = machineLedUnavailableMarkup(true);
            return;
        }
        machineLedPlugin.available = true;
        renderMachineLedEditor(await response.json());
    } catch (error) {
        content.innerHTML = machineLedUnavailableMarkup(true);
    }
}

// La pestaña "Matriz LED" del modal de Automatización de Taller replica el
// modal "Alertas por máquina" que ya existe dentro del propio plugin
// matriz-led (misma API /api/plugins/matriz-led/machine-alerts) -- así se
// configuran las dos automatizaciones (tira LED y Matriz LED) para la
// misma máquina sin salir de este modal. Solo aparece si el plugin
// matriz-led está instalado y habilitado.
// El plugin matriz-led identifica cada máquina con el id "con prefijo de
// marca" que arma tunascreen_service.list_machines() -- "marlin:/dev/…",
// "klipper:<port>", "bambu:<id>", etc. (ver _marlin_machine/_klipper_machine/
// _bambu_like_machine en tunascreen_service.py) -- porque screen_service.
// list_machines() de este plugin reusa exactamente esa misma función. El
// core, en cambio, arma `machine.id` a partir del dataset de la tarjeta
// (machineLedCardIdentity), sin ese prefijo. Sin este mapeo, esta pestaña
// leía y guardaba bajo una clave distinta a la que realmente consulta la
// automatización del plugin -- se veía como que "guardaba" pero nunca
// activaba nada de verdad. CNC es la única marca cuyo `machine.type` no
// coincide con el prefijo real: tunascreen arma el id de CNC igual que el
// de láser ("laser:<host>", ver _laser_machine), un mismo host GRBL sirve
// a los dos "kind".
function matrizLedMachineKey(machine) {
    const brand = machine.type === 'cnc' ? 'laser' : machine.type;
    return `${brand}:${machine.id}`;
}

async function setupMachineLedMatrixTab(machine) {
    const plugin = await ensureMatrizLedPluginStatus();
    if (!plugin.installed || machineLedCurrentMachine !== machine) return;
    document.getElementById('machine-led-tabs').hidden = false;
    renderMatrizLedMachineAlertsEditor(machine);
}

async function renderMatrizLedMachineAlertsEditor(machine) {
    const content = document.getElementById('machine-led-matrix-content');
    content.innerHTML = '<div class="machine-led-loading">Leyendo configuración…</div>';
    try {
        const [announcementsRes, configRes] = await Promise.all([
            fetch('/api/plugins/matriz-led/announcements'),
            fetch(`/api/plugins/matriz-led/machine-alerts/${encodeURIComponent(matrizLedMachineKey(machine))}`),
        ]);
        if (machineLedCurrentMachine !== machine) return;
        const announcements = announcementsRes.ok ? ((await announcementsRes.json()).announcements || []) : [];
        const config = configRes.ok ? await configRes.json() : { enabled: false, state_announcements: {} };
        const stateAnnouncements = config.state_announcements || {};
        content.innerHTML = `<form id="machine-led-matrix-form">
            <label class="machine-led-enable"><span><strong>Usar alertas visuales</strong><small>Esta máquina mandará sus cambios de estado a la Matriz LED.</small></span>
                <input type="checkbox" id="machine-led-matrix-enabled" ${config.enabled ? 'checked' : ''}></label>
            <div class="machine-led-colors">${MACHINE_LED_MATRIX_STATES.map(state => `
                <label class="machine-led-field"><span>${MACHINE_LED_MATRIX_STATE_LABELS[state]}</span>
                    <select data-machine-led-matrix-state="${state}">
                        <option value="">Sin asignar</option>
                        ${announcements.map(item => `<option value="${escapeHtml(item.id)}" ${stateAnnouncements[state] === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
                    </select>
                </label>`).join('')}
            </div>
            <div class="machine-led-actions"><button type="button" class="machine-led-secondary" data-machine-led-cancel>Cancelar</button><button type="submit" class="machine-led-primary">Guardar escena</button></div>
        </form>`;
        document.getElementById('machine-led-matrix-form').addEventListener('submit', event => saveMatrizLedMachineAlerts(event, machine));
    } catch (error) {
        console.error(error);
        content.innerHTML = machineLedUnavailableMarkup(true);
    }
}

async function saveMatrizLedMachineAlerts(event, machine) {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    const stateAnnouncements = {};
    document.querySelectorAll('[data-machine-led-matrix-state]').forEach(select => {
        stateAnnouncements[select.dataset.machineLedMatrixState] = select.value || null;
    });
    try {
        const response = await fetch(`/api/plugins/matriz-led/machine-alerts/${encodeURIComponent(matrizLedMachineKey(machine))}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: document.getElementById('machine-led-matrix-enabled').checked,
                state_announcements: stateAnnouncements,
            }),
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo guardar.');
        }
        document.getElementById('machine-led-modal').hidden = true;
    } catch (error) {
        console.error(error);
        button.disabled = false;
        appAlert(error.message || 'No se pudo guardar.', '', 'danger');
    }
}

async function saveMachineLedConfig(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const button = formElement.querySelector('[type="submit"]');
    button.disabled = true;
    const form = new FormData();
    form.append('machine_type', machineLedCurrentMachine.type);
    form.append('machine_id', machineLedCurrentMachine.id);
    form.append('machine_name', machineLedCurrentMachine.name);
    form.append('enabled', document.getElementById('machine-led-enabled').checked);
    form.append('accessory_id', document.getElementById('machine-led-target').value);
    form.append('start', Math.max(0, Number(document.getElementById('machine-led-start').value) - 1));
    form.append('count', Number(document.getElementById('machine-led-count').value));
    const colors = {};
    formElement.querySelectorAll('[data-machine-led-color]').forEach(input => { colors[input.dataset.machineLedColor] = machineLedHexToRgb(input.value); });
    form.append('colors', JSON.stringify(colors));
    try {
        const response = await fetch('/api/accessories/machine-led/config', { method: 'POST', body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || 'No se pudo guardar la escena');
        const key = `${machineLedCurrentMachine.type}:${machineLedCurrentMachine.id}`;
        machineLedLastState.delete(key);
        machineLedEnabledCache.set(key, document.getElementById('machine-led-enabled').checked);
        document.querySelectorAll('.machine-led-settings-btn').forEach(btn => {
            if (btn.getAttribute('aria-label') === `Configurar alertas LED de ${machineLedCurrentMachine.name}`) {
                btn.classList.toggle('is-enabled', machineLedEnabledCache.get(key));
            }
        });
        document.getElementById('machine-led-modal').hidden = true;
        showToast('Escena LED guardada');
    } catch (error) {
        showToast(error.message, 'error');
        button.disabled = false;
    }
}

document.getElementById('machine-led-close')?.addEventListener('click', () => { document.getElementById('machine-led-modal').hidden = true; });
document.getElementById('machine-led-modal')?.addEventListener('click', event => {
    if (event.target.id === 'machine-led-modal' || event.target.closest('[data-machine-led-cancel]')) event.currentTarget.hidden = true;
    if (event.target.closest('[data-machine-led-open-plugins]')) { event.currentTarget.hidden = true; switchSection('plugins'); }
    if (event.target.closest('[data-machine-led-open-accessories]')) {
        event.currentTarget.hidden = true;
        const nav = document.querySelector('[data-plugin-id="arduino-accessories"], [data-section="arduino-accessories"]');
        if (nav?.dataset.section) switchSection(nav.dataset.section); else switchSection('plugins');
    }
});

// ── Actualizar placa (desde el aviso de protocolo en Alertas visuales) ──
let firmwareUpdateAccessoryId = null;

function resetFirmwareUpdateModal() {
    const paths = document.getElementById('firmware-update-paths');
    const status = document.getElementById('firmware-update-status');
    const manualNext = document.getElementById('firmware-update-manual-next');
    const ring = document.getElementById('firmware-update-ring');
    const deviceInfo = document.getElementById('firmware-update-device-info');
    if (paths) paths.hidden = false;
    if (status) status.hidden = true;
    if (manualNext) manualNext.hidden = true;
    if (ring) {
        ring.className = 'firmware-update-ring stage-searching';
        const ringText = document.getElementById('firmware-update-ring-text');
        if (ringText) ringText.textContent = 'Buscando…';
    }
    if (deviceInfo) deviceInfo.innerHTML = '';
}

function openFirmwareUpdateModal(accessoryId, boardLabel) {
    firmwareUpdateAccessoryId = accessoryId;
    resetFirmwareUpdateModal();
    const subtitle = document.getElementById('firmware-update-subtitle');
    if (subtitle) subtitle.textContent = `${boardLabel} · sube el firmware más reciente por WiFi, o descárgalo para hacerlo tú mismo.`;
    document.getElementById('firmware-update-modal')?.classList.add('active');
}

function closeFirmwareUpdateModal() {
    document.getElementById('firmware-update-modal')?.classList.remove('active');
}

document.getElementById('firmware-update-close-btn')?.addEventListener('click', closeFirmwareUpdateModal);
document.getElementById('firmware-update-backdrop')?.addEventListener('click', closeFirmwareUpdateModal);

document.getElementById('firmware-download-bin-btn')?.addEventListener('click', async () => {
    try {
        const response = await fetch('/api/accessories/firmware/builds');
        const data = await response.json();
        const build = (data.builds || [])[0];
        if (!build) { showToast('No hay ningún firmware .bin subido todavía en NOPAL.', 'error'); return; }
        window.location.href = `/api/accessories/firmware/builds/${encodeURIComponent(build.filename)}/download`;
        document.getElementById('firmware-update-manual-next').hidden = false;
    } catch (error) {
        showToast('No se pudo descargar el firmware.', 'error');
    }
});

document.getElementById('firmware-download-ino-btn')?.addEventListener('click', () => {
    window.location.href = '/api/accessories/firmware/source';
    document.getElementById('firmware-update-manual-next').hidden = false;
});

document.getElementById('firmware-goto-ota-btn')?.addEventListener('click', async () => {
    if (!firmwareUpdateAccessoryId) return;
    try {
        const response = await fetch(`/api/accessories/${encodeURIComponent(firmwareUpdateAccessoryId)}/firmware-status`);
        if (!response.ok) throw new Error();
        const info = await response.json();
        if (info.ip) window.open(`http://${info.ip}/update`, '_blank');
        else showToast('No se pudo determinar la IP de la placa.', 'error');
    } catch (error) {
        showToast('No se pudo contactar la placa.', 'error');
    }
});

document.getElementById('firmware-auto-update-btn')?.addEventListener('click', async () => {
    if (!firmwareUpdateAccessoryId) return;
    const pathsEl = document.getElementById('firmware-update-paths');
    const statusEl = document.getElementById('firmware-update-status');
    const ringEl = document.getElementById('firmware-update-ring');
    const ringText = document.getElementById('firmware-update-ring-text');
    const deviceInfoEl = document.getElementById('firmware-update-device-info');

    pathsEl.hidden = true;
    statusEl.hidden = false;
    ringEl.className = 'firmware-update-ring stage-searching';
    ringText.textContent = 'Buscando…';
    deviceInfoEl.innerHTML = '';

    try {
        const statusResponse = await fetch(`/api/accessories/${encodeURIComponent(firmwareUpdateAccessoryId)}/firmware-status`);
        const statusData = await statusResponse.json().catch(() => ({}));
        if (!statusResponse.ok) throw new Error(statusData.detail || 'No se pudo contactar la placa');

        ringEl.className = 'firmware-update-ring stage-connected';
        ringText.textContent = 'Conectado';
        deviceInfoEl.innerHTML = `<strong>${escapeHtml(statusData.board || statusData.chip || 'Placa')}</strong><span>Firmware actual: v${escapeHtml(statusData.firmware || '—')}</span>`;
        await new Promise(resolve => setTimeout(resolve, 700));

        ringEl.className = 'firmware-update-ring stage-uploading';
        ringText.textContent = 'Subiendo…';

        const flashResponse = await fetch(`/api/accessories/firmware/flash-ota-for/${encodeURIComponent(firmwareUpdateAccessoryId)}`, {
            method: 'POST',
            body: new URLSearchParams(),
        });
        const flashData = await flashResponse.json().catch(() => ({}));
        if (!flashResponse.ok) throw new Error(flashData.detail || 'Fallo al actualizar la placa');

        ringEl.className = 'firmware-update-ring stage-done';
        ringText.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        deviceInfoEl.innerHTML += '<span class="firmware-update-done-label">Flasheo terminado — la placa se está reiniciando</span>';
    } catch (error) {
        ringEl.className = 'firmware-update-ring stage-error';
        ringText.textContent = '✕';
        deviceInfoEl.innerHTML = `<span class="firmware-update-error-label">${escapeHtml(error.message || 'No se pudo actualizar la placa.')}</span>`;
    }
});

function syncDashboardNode(current, incoming) {
    if (current.nodeType !== incoming.nodeType || current.nodeName !== incoming.nodeName) {
        current.replaceWith(incoming.cloneNode(true));
        return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
        if (current.nodeValue !== incoming.nodeValue) current.nodeValue = incoming.nodeValue;
        return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;

    // La tarjeta de cámara (ver camera-card.js) monta su propio subárbol
    // dentro de este contenedor de forma asincrónica, fuera de este ciclo de
    // render -- si se la dejara diffear como cualquier otro nodo, el
    // "incoming" siempre la ve vacía (el HTML del server no sabe qué cámara
    // se montó) y la poda de "sobran hijos" de más abajo la destruiría en
    // cada refresh del grid. El atributo es estable entre renders (mismo
    // deviceType:deviceId), así que no hace falta sincronizarlo tampoco.
    if (current.hasAttribute('data-cam-container')) return;

    [...current.attributes].forEach(attribute => {
        if (!incoming.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    });
    [...incoming.attributes].forEach(attribute => {
        if (current.getAttribute(attribute.name) !== attribute.value) {
            current.setAttribute(attribute.name, attribute.value);
        }
    });

    const currentChildren = [...current.childNodes];
    const incomingChildren = [...incoming.childNodes];
    const commonLength = Math.min(currentChildren.length, incomingChildren.length);
    for (let index = 0; index < commonLength; index += 1) {
        syncDashboardNode(currentChildren[index], incomingChildren[index]);
    }
    for (let index = commonLength; index < incomingChildren.length; index += 1) {
        current.appendChild(incomingChildren[index].cloneNode(true));
    }
    while (current.childNodes.length > incomingChildren.length) {
        current.removeChild(current.lastChild);
    }
}

function dashboardCardKey(element) {
    if (!(element instanceof HTMLElement)) return null;
    const key = element.dataset.port
        || element.dataset.marlinDevice
        || element.dataset.elegooId
        || element.dataset.flashforgeId
        || element.dataset.bambuId
        || element.dataset.laserHost;
    return key ? `${element.classList.contains('printer-card-type-cnc') ? 'cnc' : 'machine'}:${key}` : null;
}

function reconcileDashboardGrid(grid, nextHtml) {
    if (grid.innerHTML === nextHtml) return;
    const template = document.createElement('template');
    template.innerHTML = nextHtml;
    const incoming = [...template.content.children];
    const current = [...grid.children];
    const currentByKey = new Map(current.map(node => [dashboardCardKey(node), node]).filter(([key]) => key));

    if (!incoming.length || incoming.some(node => !dashboardCardKey(node))) {
        grid.innerHTML = nextHtml;
        return;
    }

    const fragment = document.createDocumentFragment();
    incoming.forEach(nextNode => {
        const existing = currentByKey.get(dashboardCardKey(nextNode));
        if (existing) {
            syncDashboardNode(existing, nextNode);
            fragment.appendChild(existing);
        } else {
            fragment.appendChild(nextNode);
        }
    });
    grid.replaceChildren(fragment);
}

// Preferencia por dispositivo de "¿se muestra la miniatura de cámara en su
// tarjeta?" -- separada de si HAY una cámara vinculada (eso lo resuelve
// mountCameraCardsIn contra /api/cameras): esto es solo la elección del
// usuario de tenerla visible u oculta, persistida entre sesiones. Default
// visible=true (mantiene el comportamiento previo) para quien ya la veía.
const CAMERA_CARD_VISIBILITY_KEY = 'cameraCardVisibleDevices';

function getCameraCardVisibilityMap() {
    try {
        return JSON.parse(localStorage.getItem(CAMERA_CARD_VISIBILITY_KEY) || '{}');
    } catch (error) {
        return {};
    }
}

function isCameraCardVisible(deviceKey) {
    const map = getCameraCardVisibilityMap();
    return map[deviceKey] !== false;
}

function setCameraCardVisible(deviceKey, visible) {
    const map = getCameraCardVisibilityMap();
    if (visible) delete map[deviceKey]; else map[deviceKey] = false;
    localStorage.setItem(CAMERA_CARD_VISIBILITY_KEY, JSON.stringify(map));
}

// Ícono de mostrar/ocultar cámara inyectado junto al resto de los controles
// rápidos de la tarjeta (mismo patrón que ensureMachineLedButton para el
// engranaje de escenas LED) -- solo aparece si el dispositivo tiene de
// verdad una cámara vinculada, así que se crea desde mountCameraCardsIn una
// vez que ya sabe la respuesta, nunca de entrada en el HTML estático.
function ensureCameraToggleButton(card, deviceKey) {
    const header = card.querySelector('.printer-card-top');
    if (!header) return;
    let button = header.querySelector('.printer-card-camera-toggle');
    if (!button) {
        const actions = header.querySelector('.printer-quick-actions') || header;
        actions.insertAdjacentHTML('afterbegin', `
            <button type="button" class="printer-card-camera-toggle" data-cam-toggle-key="${escapeHtml(deviceKey)}" title="${escapeHtml(t('cameraToggleTitle'))}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </button>`);
        button = header.querySelector('.printer-card-camera-toggle');
        button.addEventListener('click', event => {
            event.stopPropagation();
            const key = button.dataset.camToggleKey;
            const nextVisible = !isCameraCardVisible(key);
            setCameraCardVisible(key, nextVisible);
            button.classList.toggle('is-enabled', nextVisible);
            const container = card.querySelector('[data-cam-container]');
            if (!container) return;
            if (nextVisible) {
                const [deviceType, deviceId] = (container.dataset.camContainer || '').split(':');
                if (deviceType && deviceId) window.NopalCameraCard?.mount(container, { deviceType, deviceId, compact: true });
            } else {
                window.NopalCameraCard?.unmount(container);
                container.innerHTML = '';
            }
        });
    }
    button.classList.toggle('is-enabled', isCameraCardVisible(deviceKey));
}

// Monta la tarjeta de cámara (ver camera-card.js) en cada placeholder
// `[data-cam-container]` de un grid ya renderizado -- formato del atributo:
// "deviceType:deviceId" (ver elegooPrinterCardHtml/bambuPrinterCardHtml/
// flashforgePrinterCardHtml/laserDashboardCardHtml). Resuelve contra
// /api/cameras una sola vez por llamada (no una por tarjeta) para saber
// cuáles de estos placeholders corresponden de verdad a un dispositivo con
// cámara vinculada -- ahí, y solo ahí, aparece el ícono de mostrar/ocultar
// (ensureCameraToggleButton) y se monta la miniatura si la preferencia
// guardada la deja visible.
async function mountCameraCardsIn(root) {
    if (!root || !window.NopalCameraCard) return;
    const containers = [...root.querySelectorAll('[data-cam-container]')];
    if (!containers.length) return;
    let cameras = [];
    try {
        const response = await fetch('/api/cameras');
        if (!response.ok) return;
        cameras = (await response.json()).cameras || [];
    } catch (error) {
        return;
    }
    containers.forEach(container => {
        const [deviceType, deviceId] = (container.dataset.camContainer || '').split(':');
        if (!deviceType || !deviceId) return;
        const card = container.closest('.printer-card');
        const camera = cameras.find(c => c.purpose === 'timelapse' && c.bound_device
            && c.bound_device.type === deviceType && String(c.bound_device.id) === String(deviceId));
        if (!camera) {
            card?.querySelector('.printer-card-camera-toggle')?.remove();
            if (container.childElementCount > 0) {
                window.NopalCameraCard.unmount(container);
                container.innerHTML = '';
            }
            return;
        }
        const deviceKey = `${deviceType}:${deviceId}`;
        if (card) ensureCameraToggleButton(card, deviceKey);
        if (!isCameraCardVisible(deviceKey)) return;
        if (container.childElementCount > 0) return;
        window.NopalCameraCard.mount(container, { deviceType, deviceId, compact: true });
    });
}

function renderPrinters(printersInput) {
    if (!printersGrid) return;

    [printersGrid, lasersGrid, cncGrid, machinesMixedGrid].forEach(grid => {
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
        // Progreso para el degradado LED de calentando/enfriando -- ver
        // computeHeatProgress()/machineLedCardProgress() en la sección de
        // alertas visuales del plugin de accesorios.
        const heatProgress = displayState === 'heating'
            ? computeHeatProgress(bedTemp, bedTarget, extruderTemp, extruderTarget)
            : (themeMode === 'cool' ? Math.max(bedPercent, extruderPercent) : null);
        // En modo lista la miniatura queda anclada (position:absolute, "sangra"
        // fuera de la fila) y el order de flexbox no la mueve — es la única de
        // las 4 secciones sin una posición de flujo real. Como gesto mínimo de
        // que sí responde al orden guardado, se ancla a la derecha cuando el
        // usuario la arrastra hasta el final; si no, queda a la izquierda.
        const thumbRightClass = getPrinterCardLayout().indexOf('thumbnail') === PRINTER_CARD_SECTIONS_DEFAULT_ORDER.length - 1
            ? ' printer-card-thumb-right' : '';

        const html = `
            <div class="printer-card printer-card-type-3d ${normalizedStatus} ${displayState}${themeModeClass}${thumbRightClass}" data-port="${printer.port}" data-heat-progress="${heatProgress ?? ''}">
                ${printerThermalWaves(
                    typeof bedTemp === 'number' ? bedTemp : null,
                    typeof extruderTemp === 'number' ? extruderTemp : null,
                    bedTarget,
                    extruderTarget,
                    displayState,
                    !isOnline,
                    printer.port
                )}
                <div class="printer-card-top" data-printer-card-section="header" style="order:${printerCardSectionOrder('header')}">
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

                <div class="printer-status-line ${displayState}" data-printer-card-section="badge" style="order:${printerCardSectionOrder('badge')}">
                    <span class="printer-status-dot ${displayState}"></span>${displayStateText}
                </div>

                <div class="printer-illustration printer-illustration-${displayState}" data-printer-card-section="thumbnail" style="order:${printerCardSectionOrder('thumbnail')}">
                    ${printerIllustrationImg(displayState)}
                </div>

                ${visualState === 'printing' || visualState === 'paused' || visualState === 'idle' ? `
                    <div class="printer-temps" data-printer-card-section="temps" style="order:${printerCardSectionOrder('temps')}">
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
                    <div class="printer-progress" style="order:99">
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
    printerEntries.push(...dashboardStandalonePrinterEntries);

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

    const renderColumn = (grid, entries, emptyKey, isLoaded, hasLoadError, loadingLabelKey) => {
        if (!grid) return null;
        if (!isLoaded) {
            grid.innerHTML = deviceColumnLoadingMarkup(loadingLabelKey);
            return null;
        }
        if (hasLoadError) {
            grid.innerHTML = `<div class="empty-state">${t('errorLoadingModels')}</div>`;
            return null;
        }
        let filtered = showOffline ? entries : entries.filter(entry => entry.isOnline);
        filtered = [...filtered].sort((a, b) => a.sortPriority - b.sortPriority);
        const nextHtml = filtered.length
            ? filtered.map(entry => entry.html).join('')
            : `<div class="empty-state">${t(emptyKey)}</div>`;
        reconcileDashboardGrid(grid, nextHtml);
        return filtered.length;
    };

    const groupMode = getDevicesGroupMode();

    if (groupMode === 'mixed') {
        if (machinesMixedGrid) {
            const allEntries = [...printerEntries, ...laserOnlyEntries, ...cncEntries];
            const isLoaded = dashboardPrintersLoaded && dashboardLaserDevicesLoaded;
            const hasLoadError = dashboardPrintersLoadError || dashboardLaserDevicesLoadError;
            renderColumn(machinesMixedGrid, allEntries, 'noPrintersFound', isLoaded, hasLoadError, 'printerType3D');
        }
    } else {
        lastDeviceCategoryCounts = {
            printer: renderColumn(printersGrid, printerEntries, 'noPrintersFound', dashboardPrintersLoaded, dashboardPrintersLoadError, 'printerType3D'),
            laser: renderColumn(lasersGrid, laserOnlyEntries, 'noLasersFound', dashboardLaserDevicesLoaded, dashboardLaserDevicesLoadError, 'laser'),
            cnc: renderColumn(cncGrid, cncEntries, 'noCncFound', dashboardLaserDevicesLoaded, dashboardLaserDevicesLoadError, 'cnc'),
        };
        applyDeviceColumnsLayout();
    }

    const columnsRoot = groupMode === 'mixed' ? (machinesMixedGrid || printersGrid) : (machinesColumns || printersGrid);

    decorateMachineCardsWithLedSettings(columnsRoot);
    bindMarlinTemperatureActions(columnsRoot);
    // La vista de cámara en la tarjeta solo aplica al modo "mixto" (todos
    // los tipos en una sola grilla) -- en columnas separadas por tipo
    // (Impresoras/Láser/CNC) las tarjetas quedan más angostas y la miniatura
    // se ve desproporcionada, además de duplicar lo que ya se ve en modo
    // mixto. Pedido explícito del usuario sobre una captura de ambos modos.
    if (groupMode === 'mixed') mountCameraCardsIn(columnsRoot);

    columnsRoot.querySelectorAll('.printer-card[data-port]').forEach(card => {
        if (boundPrinterCards.has(card)) return;
        boundPrinterCards.add(card);
        card.addEventListener('click', () => {
            const port = Number(card.dataset.port);
            const printer = allPrinters.find(p => p.port === port);
            if (printer) openPrinterModal(printer);
        });
    });

    columnsRoot.querySelectorAll('.printer-card[data-marlin-device]').forEach(card => {
        if (boundMarlinCards.has(card)) return;
        boundMarlinCards.add(card);
        card.addEventListener('click', () => openMarlinPrinterModal(card.dataset.marlinDevice));
    });

    const standaloneSections = [
        ['elegoo', 'elegooId'],
        ['flashforge', 'flashforgeId'],
        ['bambu', 'bambuId'],
    ];
    standaloneSections.forEach(([section, dataKey]) => {
        columnsRoot.querySelectorAll(`.printer-card[data-${section}-id]`).forEach(card => {
            if (!boundStandaloneCards.has(card)) {
                boundStandaloneCards.add(card);
                card.addEventListener('click', () => switchSection(section));
            }
            card.querySelectorAll('.elegoo-card-action-btn').forEach(btn => {
                if (boundStandaloneActionButtons.has(btn)) return;
                boundStandaloneActionButtons.add(btn);
                btn.addEventListener('click', event => {
                    event.stopPropagation();
                    const action = btn.dataset.action;
                    const printerId = btn.dataset[dataKey];
                    if (section === 'elegoo') handleElegooPrinterAction(action, printerId);
                    if (section === 'flashforge') handleFlashforgePrinterAction(action, printerId);
                    if (section === 'bambu') handleBambuPrinterAction(action, printerId);
                });
            });
        });
    });

    columnsRoot.querySelectorAll('.printer-card[data-laser-host]').forEach(card => {
        if (boundLaserCards.has(card)) return;
        boundLaserCards.add(card);
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
        if (boundQuickActionButtons.has(btn)) return;
        boundQuickActionButtons.add(btn);
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
                    const printer = allPrinters.find(item => String(item.port) === String(port)) || {};
                    openMaterialPreheatModal({ type: 'klipper', id: port, name: printer.name || `Klipper ${port}` });
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
        const standaloneOnlineCount = dashboardStandalonePrinterEntries.filter(entry => entry.isOnline).length;
        activePrintersEl.textContent = (onlineCount + standaloneOnlineCount).toLocaleString();
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
        modelsTagFilter = '';
        modelsPage = 1;
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
    if (!btn || !input) return null;

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

    // Extraída del listener de 'change' del input para que el drag-and-drop
    // (wireLibraryDropzone) pueda subir los mismos archivos por la misma
    // vía, en vez de duplicar la lógica de subida.
    async function uploadFiles(files) {
        if (!files.length) return;
        // Uno por vez (no en paralelo) para que la barra de progreso de cada
        // fila tenga sentido y no se sature el endpoint con varias subidas
        // grandes a la vez.
        for (const file of files) {
            await uploadOneFile(file);
        }
        loadModels();
        onDone();
    }

    input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        await uploadFiles(files);
        input.value = '';
    });

    return uploadFiles;
}

// Arrastrar archivos desde el explorador del sistema y soltarlos sobre la
// tarjeta de la biblioteca los sube por la misma vía que el botón "Subir
// archivo" -- mismo criterio visual que ya usaba el dropzone del fondo de
// tema personalizado (Configuración > Apariencia).
function wireLibraryDropzone(zoneEl, uploadFiles) {
    if (!zoneEl || !uploadFiles) return;
    ['dragenter', 'dragover'].forEach(evt => {
        zoneEl.addEventListener(evt, event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            zoneEl.classList.add('library-dropzone-active');
        });
    });
    ['dragleave', 'dragend'].forEach(evt => {
        zoneEl.addEventListener(evt, () => {
            zoneEl.classList.remove('library-dropzone-active');
        });
    });
    zoneEl.addEventListener('drop', event => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        zoneEl.classList.remove('library-dropzone-active');
        uploadFiles(Array.from(event.dataTransfer.files));
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
    if (!(await appConfirm(t('deleteFileConfirm'), t('delete'), 'danger'))) return;

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

wireLibraryDropzone(
    document.querySelector('#models-section .gcode-library-card'),
    wireUploadButton('upload-btn-models', 'upload-input-models', 'model', () => currentModelsPath, 'models-full', () => loadModelsFolder(currentModelsPath))
);
wireLibraryDropzone(
    document.querySelector('#gcode-section .gcode-library-card'),
    wireUploadButton('upload-btn-gcode', 'upload-input-gcode', 'gcode', () => currentGcodePath, 'gcode-table', () => loadGcodeFolder(currentGcodePath))
);
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
            formData.append('kind', 'laser');
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
// El picker mezcla Klipper, Marlin, Elegoo, FlashForge y Bambu en una sola lista.
// Cada entrada se identifica con { type, id }: para Klipper `id` es el puerto
// (número), para Elegoo/FlashForge es el `id` del registro (mainboard_id /
// serial_number, string). Elegoo y FlashForge no tienen cola nativa ni usan
// el scheduler propio de NOPAL (que además guarda todo por `port`), así que
// para esas dos el modo queda forzado siempre a "now".
let printerSendTarget = null;
let printerSendSelected = null; // { type: 'klipper'|'marlin'|'elegoo'|'flashforge'|'bambu', id }
let printerSendMode = 'now';
let printerSendEntries = []; // lista fresca combinada, se recarga cada vez que se abre el modal

function getPrinterSendSelectedEntry() {
    if (!printerSendSelected) return null;
    return printerSendEntries.find(entry => entry.type === printerSendSelected.type && String(entry.id) === String(printerSendSelected.id)) || null;
}

// Refresca Klipper (a través de loadPrinters(), que además actualiza el
// dashboard) y hace fetch fresco de Marlin/Elegoo/FlashForge/Bambu en paralelo — a
// propósito NO se reusan elegooPrintersRegistryCache/flashforgePrintersRegistryCache/
// bambuPrintersRegistryCache, porque esos solo se llenan si el usuario ya
// visitó esas secciones antes.
async function loadPrinterSendEntries() {
    const [, marlinData, marlinJobsData, elegooData, flashforgeData, bambuData] = await Promise.all([
        loadPrinters(),
        fetch('/api/marlin-printers/registry/status').then(res => res.json()).catch(() => ({ printers: [] })),
        fetch('/api/marlin-printers/jobs/active').then(res => res.json()).catch(() => ({ jobs: [] })),
        fetch('/api/elegoo/printers').then(res => res.json()).catch(() => ({ printers: [] })),
        fetch('/api/flashforge/printers').then(res => res.json()).catch(() => ({ printers: [] })),
        fetch('/api/bambu/printers').then(res => res.json()).catch(() => ({ printers: [] })),
    ]);

    const entries = allPrinters.map(printer => ({ type: 'klipper', id: printer.port, printer }));
    const marlinJobs = new Map((marlinJobsData.jobs || []).map(job => [String(job.device), job]));
    (marlinData.printers || []).forEach(printer => {
        const activeJob = marlinJobs.get(String(printer.device));
        entries.push({
            type: 'marlin',
            id: printer.device,
            printer: {
                ...printer,
                status: printer.online ? 'online' : 'offline',
                state: activeJob?.state || 'idle',
            },
        });
    });
    (elegooData.printers || []).forEach(printer => entries.push({ type: 'elegoo', id: printer.id, printer }));
    (flashforgeData.printers || []).forEach(printer => entries.push({ type: 'flashforge', id: printer.id, printer }));
    (bambuData.printers || []).forEach(printer => entries.push({ type: 'bambu', id: printer.id, printer }));
    return entries;
}

function renderPrinterSendPicker(selected) {
    const container = document.getElementById('printer-send-picker');
    if (!container) return;
    if (!printerSendEntries.length) {
        container.innerHTML = `<div class="empty-state-small">${t('noPrintersFound')}</div>`;
        printerSendSelected = null;
        updatePrinterSendModesAvailability();
        return;
    }

    const isValidSelection = selected && printerSendEntries.some(entry => entry.type === selected.type && String(entry.id) === String(selected.id));
    // Preferir la impresora ya elegida, si sigue siendo válida; si no, la
    // primera impresora en línea (evita mandar por defecto a una apagada/offline).
    let nextSelected = isValidSelection ? selected : null;
    if (!nextSelected) {
        const onlineEntry = printerSendEntries.find(entry => entry.printer.status === 'online');
        const fallbackEntry = onlineEntry || printerSendEntries[0];
        nextSelected = { type: fallbackEntry.type, id: fallbackEntry.id };
    }
    printerSendSelected = nextSelected;

    container.innerHTML = printerSendEntries.map(entry => {
        const printer = entry.printer;
        const name = getPrinterDisplayName(printer);
        const isOnline = printer.status === 'online';
        const active = (entry.type === printerSendSelected.type && String(entry.id) === String(printerSendSelected.id)) ? ' active' : '';
        const offlineClass = isOnline ? '' : ' offline';
        const stateValue = getPrinterEffectiveStateValue(printer);
        const isBusy = isOnline && (stateValue === 'printing' || stateValue === 'paused');
        const busyClass = isBusy ? ' busy' : '';
        const stateKey = stateValue === 'ready' ? 'idle' : stateValue;
        const stateDisplay = t(stateKey) !== stateKey ? t(stateKey) : (stateValue || t('idle'));
        const statusLine = isOnline ? `${t('online')} · ${stateDisplay}` : t('offline');
        return `
            <button type="button" class="printer-send-row${active}${offlineClass}${busyClass}" data-type="${entry.type}" data-id="${escapeHtml(String(entry.id))}" data-busy="${isBusy ? '1' : '0'}">
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
            printerSendSelected = { type: btn.dataset.type, id: btn.dataset.id };
            container.querySelectorAll('.printer-send-row').forEach(el => {
                el.classList.toggle('active', el.dataset.type === printerSendSelected.type && el.dataset.id === String(printerSendSelected.id));
            });
            updatePrinterSendBusyWarning();
            updatePrinterSendModesAvailability();
        });
    });

    updatePrinterSendBusyWarning();
    updatePrinterSendModesAvailability();
}

function updatePrinterSendBusyWarning() {
    const warningEl = document.getElementById('printer-send-busy-warning');
    const warningTextEl = document.getElementById('printer-send-busy-warning-text');
    const primaryBtn = document.getElementById('printer-send-primary-btn');
    if (!warningEl) return;

    const selectedPrinter = getPrinterSendSelectedEntry()?.printer;
    const stateValue = selectedPrinter ? getPrinterEffectiveStateValue(selectedPrinter) : '';
    const isBusy = selectedPrinter?.status === 'online' && (stateValue === 'printing' || stateValue === 'paused');

    warningEl.hidden = !isBusy;
    if (isBusy && warningTextEl) {
        warningTextEl.textContent = stateValue === 'paused' ? t('printerSendBusyPausedWarning') : t('printerSendBusyWarning');
    }
    if (primaryBtn) primaryBtn.disabled = isBusy && printerSendMode === 'now';
}

// Marlin/Elegoo/FlashForge/Bambu no soportan "Agregar a la cola" ni "Programar impresión"
// (ver comentario arriba) — se deshabilitan sus tarjetas de modo y el botón
// rápido de cola del footer, y si el usuario tenía ese modo elegido se
// vuelve a "now" automáticamente al cambiar de impresora.
let printerSendSdCheckToken = 0;

function updatePrinterSendModesAvailability() {
    const selectedEntry = getPrinterSendSelectedEntry();
    const isKlipper = !selectedEntry || selectedEntry.type === 'klipper';
    const restrictedModeCards = document.querySelectorAll('.printer-send-mode-card[data-mode="queue"], .printer-send-mode-card[data-mode="schedule"]');
    const queueFooterBtn = document.getElementById('printer-send-queue-btn');

    restrictedModeCards.forEach(card => {
        card.disabled = !isKlipper;
        card.classList.toggle('disabled', !isKlipper);
        const noteEl = card.querySelector('.printer-send-mode-unavailable');
        if (noteEl) noteEl.hidden = isKlipper;
    });
    if (queueFooterBtn) queueFooterBtn.hidden = !isKlipper;

    if (!isKlipper && printerSendMode !== 'now') {
        setPrinterSendMode('now');
    }

    updatePrinterSendSdAvailability(selectedEntry);
}

// Solo Marlin puede tener tarjeta SD, y encima hay que preguntarle a la
// placa (M21) si de verdad hay una insertada -- se pide aparte del resto
// (que es todo síncrono/local) y con un token de carrera: si el usuario ya
// cambió de impresora para cuando responde, se descarta en vez de pintar
// la disponibilidad de la impresora anterior.
async function updatePrinterSendSdAvailability(selectedEntry) {
    const card = document.getElementById('printer-send-mode-sd');
    if (!card) return;
    const token = ++printerSendSdCheckToken;

    if (!selectedEntry || selectedEntry.type !== 'marlin') {
        card.hidden = true;
        card.disabled = true;
        if (printerSendMode === 'sd') setPrinterSendMode('now');
        return;
    }

    card.hidden = false;
    card.disabled = true;
    card.classList.add('disabled');
    const noteEl = card.querySelector('.printer-send-mode-unavailable');
    if (noteEl) noteEl.hidden = true;

    try {
        const response = await fetch(`/api/marlin-printers/sd/available?device=${encodeURIComponent(selectedEntry.id)}`);
        if (token !== printerSendSdCheckToken) return;
        const data = response.ok ? await response.json() : { available: false };
        card.disabled = !data.available;
        card.classList.toggle('disabled', !data.available);
        if (noteEl) noteEl.hidden = !!data.available;
        if (!data.available && printerSendMode === 'sd') setPrinterSendMode('now');
    } catch (error) {
        if (token !== printerSendSdCheckToken) return;
        card.disabled = true;
        card.classList.add('disabled');
        if (noteEl) noteEl.hidden = false;
        if (printerSendMode === 'sd') setPrinterSendMode('now');
    }
}

function setPrinterSendMode(mode) {
    const selectedEntry = getPrinterSendSelectedEntry();
    const isKlipper = !selectedEntry || selectedEntry.type === 'klipper';
    const isMarlin = selectedEntry?.type === 'marlin';
    if (mode === 'sd' && !isMarlin) mode = 'now';
    if (!isKlipper && !isMarlin && mode !== 'now') mode = 'now';
    if (!isKlipper && isMarlin && mode !== 'now' && mode !== 'sd') mode = 'now';

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
    } else if (mode === 'sd') {
        if (primaryIcon) primaryIcon.innerHTML = '<path d="M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6l-4-4z"/><path d="M13 2v4h4"/>';
        if (primaryLabel) primaryLabel.textContent = t('printerSendModeSdTitle');
    } else {
        if (primaryIcon) primaryIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
        if (primaryLabel) primaryLabel.textContent = t('printNow');
    }
    updatePrinterSendBusyWarning();
}

document.querySelectorAll('.printer-send-mode-card').forEach(card => {
    card.addEventListener('click', () => {
        if (card.disabled) return;
        setPrinterSendMode(card.dataset.mode);
    });
});

async function openPrinterSendModal(relPath, filename, section = 'model', model = null) {
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

    const pickerContainer = document.getElementById('printer-send-picker');
    if (pickerContainer) pickerContainer.innerHTML = `<div class="empty-state-small">${t('devicesLoading')}</div>`;

    printerSendEntries = await loadPrinterSendEntries();
    renderPrinterSendPicker(printerSendSelected);
}

function closePrinterSendModal() {
    document.getElementById('printer-send-modal')?.classList.remove('active');
}

async function submitPrinterSend(mode) {
    if (!printerSendTarget || !printerSendSelected) return;
    const selectedEntry = getPrinterSendSelectedEntry();
    const selectedPrinter = selectedEntry?.printer;
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
    if (!selectedEntry) return;
    // Elegoo/FlashForge no tienen cola nativa — no debería poder llegar acá
    // porque el botón/tarjeta de "queue" está deshabilitado para ellas, pero
    // por las dudas no se manda nada si igual se invoca.
    if (selectedEntry.type !== 'klipper' && mode !== 'print') return;

    try {
        const formData = new FormData();
        formData.append('path', printerSendTarget.path);
        formData.append('section', printerSendTarget.section || 'model');

        let url;
        if (selectedEntry.type === 'klipper') {
            formData.append('mode', mode);
            url = `/api/printers/${selectedEntry.id}/send`;
        } else if (selectedEntry.type === 'marlin') {
            formData.append('device', selectedEntry.id);
            url = '/api/marlin-printers/print/start';
        } else if (selectedEntry.type === 'elegoo') {
            url = `/api/elegoo/printers/${encodeURIComponent(selectedEntry.id)}/send`;
        } else if (selectedEntry.type === 'bambu') {
            url = `/api/bambu/printers/${encodeURIComponent(selectedEntry.id)}/send`;
        } else {
            url = `/api/flashforge/printers/${encodeURIComponent(selectedEntry.id)}/send`;
        }

        const response = await fetch(url, { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo enviar el archivo.');
        }
        closePrinterSendModal();
        showToast(mode === 'queue' ? t('printerSendQueued') : t('printerSendStarted'));
        loadPrinters();
        if (selectedEntry.type === 'elegoo') refreshElegooPrintersGrid();
        if (selectedEntry.type === 'flashforge') refreshFlashforgePrintersGrid();
        if (selectedEntry.type === 'bambu') refreshBambuPrintersGrid();
        if (selectedEntry.type === 'marlin') refreshMarlinPrintersGrid();
    } catch (error) {
        console.error(error);
        appAlert(error.message || 'No se pudo enviar el archivo.', '', 'danger');
    }
}

async function submitPrinterSendSchedule() {
    if (!printerSendTarget || !printerSendSelected) return;
    const selectedEntry = getPrinterSendSelectedEntry();
    // El scheduler de NOPAL guarda todo por `port` de Klipper — no aplica a
    // Elegoo/FlashForge (su tarjeta de modo ya está deshabilitada para ellas).
    if (!selectedEntry || selectedEntry.type !== 'klipper') return;
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
        formData.append('port', selectedEntry.id);
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

async function submitPrinterSendToSd() {
    if (!printerSendTarget || !printerSendSelected) return;
    const selectedEntry = getPrinterSendSelectedEntry();
    if (!selectedEntry || selectedEntry.type !== 'marlin') return;
    const selectedPrinter = selectedEntry.printer;
    if (selectedPrinter && selectedPrinter.status !== 'online') {
        appAlert(t('printerSendOfflineError'), '', 'warning');
        return;
    }
    const primaryBtn = document.getElementById('printer-send-primary-btn');
    if (primaryBtn) primaryBtn.disabled = true;
    try {
        const formData = new FormData();
        formData.append('device', selectedEntry.id);
        formData.append('path', printerSendTarget.path);
        formData.append('section', printerSendTarget.section || 'model');
        formData.append('preheat', 'true');
        const response = await fetch('/api/marlin-printers/sd/upload-and-print', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || 'No se pudo subir el archivo a la SD.');
        }
        closePrinterSendModal();
        showToast(t('printerSendStarted'));
        refreshMarlinPrintersGrid();
        loadPrinters();
    } catch (error) {
        console.error(error);
        appAlert(error.message || 'No se pudo subir el archivo a la SD.', '', 'danger');
    } finally {
        if (primaryBtn) primaryBtn.disabled = false;
    }
}

document.getElementById('printer-send-backdrop')?.addEventListener('click', closePrinterSendModal);
document.getElementById('printer-send-close-btn')?.addEventListener('click', closePrinterSendModal);
document.getElementById('printer-send-cancel-btn')?.addEventListener('click', closePrinterSendModal);
document.getElementById('printer-send-queue-btn')?.addEventListener('click', () => submitPrinterSend('queue'));
document.getElementById('printer-send-primary-btn')?.addEventListener('click', () => {
    if (printerSendMode === 'schedule') {
        submitPrinterSendSchedule();
    } else if (printerSendMode === 'sd') {
        submitPrinterSendToSd();
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
        loadRegistryDevices();
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
        // El registro de láser/CNC va en paralelo solo para conocer el chip
        // de cada placa: es lo que muestra el popup de desvincular, y sin él
        // saldría con un guion donde debería decir ESP32/CH340. Si falla, la
        // lista se pinta igual.
        const [response, laserResponse] = await Promise.all([
            fetch('/api/devices/registry'),
            fetch('/api/laser/registry').catch(() => null),
        ]);
        const data = await response.json();
        let chips = new Map();
        try {
            const laserData = laserResponse ? await laserResponse.json() : null;
            chips = new Map((laserData?.lasers || []).map(l => [l.host, l.chip || '']));
        } catch (_) { /* sin datos de chip: el popup mostrará un guion */ }
        renderRegistryDevices(data.machines || [], chips);
    } catch (error) {
        console.error(error);
    }
}

// driver de tunascreen_service.list_machines() -> etiqueta legible. Nombres
// de marca no se traducen (mismo criterio que PROTECTED_TERMS en
// scripts/generate_i18n.py); "grbl" cubre tanto láser como CNC (ver
// _laser_machine en tunascreen_service.py), esa etiqueta sí usa i18n.
function deviceDriverBadgeLabel(driver) {
    const brandLabels = {
        marlin: 'Marlin', klipper: 'Klipper', bambu: 'Bambu Lab',
        elegoo: 'Elegoo', flashforge: 'FlashForge',
    };
    if (driver === 'grbl') return `${t('usbKindLaser')} / ${t('usbKindCnc')}`;
    return brandLabels[driver] || driver;
}

function renderRegistryDevices(machines, chips = new Map()) {
    const container = document.getElementById('registry-devices-list');
    if (!container) return;
    if (!machines.length) {
        container.innerHTML = `<div class="empty-state-small">${t('registryDevicesEmpty')}</div>`;
        return;
    }
    container.innerHTML = machines.map(machine => {
        // Editar y desvincular solo para láser/CNC: son los que el registro
        // de NOPAL puede tocar (/api/laser/registry). Una impresora Klipper
        // se administra desde su propia tarjeta, y poner acá un botón que
        // pegara al endpoint equivocado sería peor que no tenerlo.
        const esGrbl = machine.driver === 'grbl';
        const host = String(machine.id || '').replace(/^laser:/, '');
        const nombre = machine.name || machine.id;
        // La píldora de estado va DENTRO del grupo de la derecha: el item es
        // flex con space-between, y dejarla suelta la empujaría al centro.
        const pildora = `<span class="device-status-pill ${machine.online ? 'online' : 'offline'}">${machine.online ? t('online') : t('offline')}</span>`;
        const acciones = esGrbl ? `
            <div class="usb-port-registered">
                ${pildora}
                <button type="button" class="theme-option-icon-btn usb-port-rename-btn" data-host="${escapeHtml(host)}" data-name="${escapeHtml(nombre)}" title="${escapeHtml(t('usbPortRename'))}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger usb-port-unlink-btn" data-host="${escapeHtml(host)}" data-name="${escapeHtml(nombre)}" data-chip="${escapeHtml(chips.get(host) || '')}" data-transport="${host.startsWith('usb:') ? 'usb' : 'wifi'}" title="${escapeHtml(t('usbPortUnlink'))}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>` : pildora;
        return `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(nombre)}</strong>
                <span>${escapeHtml(deviceDriverBadgeLabel(machine.driver))}</span>
            </div>
            ${acciones}
        </div>`;
    }).join('');

    // Mismo cableado que la lista de puertos USB: el popup de editar y el de
    // desvincular ya existían, esta lista simplemente nunca pintó los botones.
    wireRegisteredDeviceActions(container);
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

const ACCESSORY_DRIVER_LABEL_KEYS = {
    http_relay: 'accessoryDriverRelay',
    home_assistant: 'accessoryDriverHa',
    arduino: 'accessoryDriverArduino',
};

let accessoryArduinoTarget = null;

const accessoryDriverSwitch = createOptionSwitch('accessory-driver-switch', value => {
    document.getElementById('accessory-config-relay').hidden = value !== 'http_relay';
    document.getElementById('accessory-config-ha').hidden = value !== 'home_assistant';
    document.getElementById('accessory-config-arduino').hidden = value !== 'arduino';
    if (value === 'arduino') updateAccessoryArduinoConfigUI();
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

const ACCESSORY_ADD_TILE_HTML = `
    <button type="button" class="accessory-add-tile" title="Agregar accesorio">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`;

const ACCESSORY_GRID_COLUMNS = 3;
const ACCESSORY_GRID_DEFAULT_ROWS = 2;

function renderAccessories(accessories) {
    const container = document.getElementById('accessories-list');
    if (!container) return;
    // Grilla fija de 3x2 (6 fichas) -- si sobran espacios se rellenan con
    // fichas de "agregar" (todas hacen lo mismo, cualquiera abre el alta);
    // si hay más de 6 accesorios no se recorta ni se hace scroll, se
    // agregan filas y el contenedor se achica (.accessories-list-dense)
    // para que el alto total del dock no cambie.
    const defaultSlots = ACCESSORY_GRID_COLUMNS * ACCESSORY_GRID_DEFAULT_ROWS;
    const dense = accessories.length > defaultSlots;
    const rows = dense ? Math.ceil(accessories.length / ACCESSORY_GRID_COLUMNS) : ACCESSORY_GRID_DEFAULT_ROWS;
    container.classList.toggle('accessories-list-dense', dense);
    container.style.setProperty('--accessory-rows', rows);
    const emptySlots = dense ? 0 : defaultSlots - accessories.length;

    container.innerHTML = accessories.map(acc => {
        const statusClass = acc.on === true ? 'on' : acc.on === false ? 'off' : 'unknown';
        const statusLabel = acc.on === true ? t('accessoryOn') : acc.on === false ? t('accessoryOff') : t('accessoryUnknown');
        const driverLabelKey = ACCESSORY_DRIVER_LABEL_KEYS[acc.driver];
        const driverLabel = driverLabelKey ? t(driverLabelKey) : (acc.driver || t('accessoryDriverRelay'));
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
    }).join('') + ACCESSORY_ADD_TILE_HTML.repeat(emptySlots);

    container.querySelectorAll('.accessory-add-tile').forEach(btn => {
        btn.addEventListener('click', () => openAccessoryModal());
    });

    container.querySelectorAll('.accessory-power-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const nextOn = btn.dataset.on !== 'true';
            if (!nextOn) {
                const acc = accessories.find(item => item.id === id);
                const name = acc ? acc.name : '';
                if (!(await appConfirm(t('accessoryTurnOffConfirm').replace('{name}', name), t('accessoryTurnOff'), 'warning'))) return;
            }
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

// Copia en vivo (solo lectura) de la Matriz LED en el dock fijo del Panel
// de Control -- mismo dato que #mled-live-grid dentro del propio plugin
// (ver renderLiveView() en matriz-led.js), leído directo de
// /api/plugins/matriz-led/last-sent en vez de duplicar el estado del
// plugin en el core. Solo se muestra si el plugin está instalado.
// Clave del último historial ya pintado -- evita re-renderizar (y por lo
// tanto re-disparar la animación de entrada de los pills) en cada poll de
// 10s cuando nada cambió desde la última vez.
let dashboardMatrixTickerLastKey = null;

function renderDashboardMatrixTicker(ticker, history) {
    const key = history.map(entry => `${entry.source}:${entry.sent_at}`).join('|');
    if (key === dashboardMatrixTickerLastKey) return;
    dashboardMatrixTickerLastKey = key;
    // Más reciente 100% opaco, y -25% por cada uno más viejo (75/50/25%) --
    // no se pintan más de 4, ese último ya queda casi invisible.
    ticker.innerHTML = history.slice(0, 4)
        .map((entry, index) => `<span class="dashboard-dock-matrix-pill" style="opacity:${1 - index * 0.25}">${escapeHtml(entry.source || 'Manual')}</span>`)
        .join('');
}

async function loadDashboardMatrixPreview() {
    const wrap = document.getElementById('dashboard-dock-matrix');
    const grid = document.getElementById('dashboard-dock-matrix-grid');
    const ticker = document.getElementById('dashboard-dock-matrix-ticker');
    if (!wrap || !grid) return;
    const plugin = await ensureMatrizLedPluginStatus();
    if (!plugin.installed) {
        wrap.hidden = true;
        return;
    }
    try {
        const [lastSentRes, historyRes] = await Promise.all([
            fetch('/api/plugins/matriz-led/last-sent'),
            fetch('/api/plugins/matriz-led/last-sent-history'),
        ]);
        if (!lastSentRes.ok) {
            wrap.hidden = true;
            return;
        }
        const data = await lastSentRes.json();
        const matrix = data.last_sent?.matrix;
        wrap.hidden = false;
        grid.innerHTML = matrix
            ? matrix.flat().map(color => `<span style="${color ? `background:#${color}` : ''}"></span>`).join('')
            : '';
        if (ticker && historyRes.ok) {
            renderDashboardMatrixTicker(ticker, (await historyRes.json()).history || []);
        }
    } catch (error) {
        console.error(error);
        wrap.hidden = true;
    }
}

const DASHBOARD_DOCK_COLLAPSED_KEY = 'dashboardDockCollapsed';
const dashboardDock = document.getElementById('dashboard-dock');
if (dashboardDock && localStorage.getItem(DASHBOARD_DOCK_COLLAPSED_KEY) === 'true') {
    dashboardDock.classList.add('collapsed');
}
document.getElementById('dashboard-dock-toggle')?.addEventListener('click', () => {
    if (!dashboardDock) return;
    const collapsed = dashboardDock.classList.toggle('collapsed');
    localStorage.setItem(DASHBOARD_DOCK_COLLAPSED_KEY, collapsed ? 'true' : 'false');
});

async function loadAccessoryArduinoDiscoverList() {
    const container = document.getElementById('accessory-arduino-discover-list');
    if (!container) return;
    container.innerHTML = `<div class="empty-state-small">${t('accessoryArduinoDiscoverScanning')}</div>`;
    try {
        const response = await fetch('/api/accessories/arduino/discover');
        if (!response.ok) throw new Error(`discover failed: ${response.status}`);
        const data = await response.json();
        renderAccessoryArduinoDiscoverList(data.boards || []);
    } catch (error) {
        console.error(error);
        container.innerHTML = `<div class="empty-state-small">${t('accessoryArduinoDiscoverError')}</div>`;
    }
}

function renderAccessoryArduinoDiscoverList(boards) {
    const container = document.getElementById('accessory-arduino-discover-list');
    if (!container) return;
    if (!boards.length) {
        container.innerHTML = `<div class="empty-state-small">${t('accessoryArduinoDiscoverEmpty')}</div>`;
        return;
    }
    container.innerHTML = boards.map(board => {
        const relayCount = parseInt(board.relays, 10) || 0;
        const relayInfo = relayCount ? ` · ${t('accessoryArduinoDiscoverRelays').replace('{count}', relayCount)}` : '';
        return `
            <div class="usb-port-item">
                <div class="usb-port-item-info">
                    <strong>${escapeHtml(board.chip || board.device)}</strong>
                    <span>${escapeHtml(board.device)}${relayInfo}</span>
                </div>
                <span class="usb-port-vidpid">${board.latency_ms != null ? `${board.latency_ms} ms` : '—'}</span>
                <button type="button" class="btn-file-action accessory-arduino-discover-add-btn" data-device="${escapeHtml(board.device || '')}" data-location="${escapeHtml(board.location || '')}" data-chip="${escapeHtml(board.chip || '')}" data-relays="${escapeHtml(String(relayCount || 1))}">${escapeHtml(t('usbPortAdd'))}</button>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.accessory-arduino-discover-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openAccessoryModal({
                device: btn.dataset.device,
                location: btn.dataset.location,
                chip: btn.dataset.chip,
                relays: parseInt(btn.dataset.relays, 10) || 1,
                relay: 1,
            });
        });
    });
}

document.getElementById('accessory-arduino-discover-btn')?.addEventListener('click', loadAccessoryArduinoDiscoverList);

function updateAccessoryArduinoConfigUI() {
    const label = document.getElementById('accessory-arduino-device-label');
    const relaySelect = document.getElementById('accessory-arduino-relay-select');
    if (!label || !relaySelect) return;
    if (!accessoryArduinoTarget || !accessoryArduinoTarget.device) {
        label.textContent = t('accessoryArduinoNoDevice');
        relaySelect.innerHTML = '';
        relaySelect.disabled = true;
        return;
    }
    label.textContent = accessoryArduinoTarget.chip
        ? `${accessoryArduinoTarget.chip} · ${accessoryArduinoTarget.device}`
        : accessoryArduinoTarget.device;
    const relayCount = Math.max(parseInt(accessoryArduinoTarget.relays, 10) || 0, 1);
    const selected = parseInt(accessoryArduinoTarget.relay, 10) || 1;
    relaySelect.innerHTML = Array.from({ length: relayCount }, (_, i) => i + 1)
        .map(n => `<option value="${n}" ${n === selected ? 'selected' : ''}>${n}</option>`)
        .join('');
    relaySelect.disabled = false;
}

// arduinoPrefill (opcional): { device, location, chip, relays, relay } — viene de
// la lista de placas detectadas (ver renderAccessoryArduinoDiscoverList) cuando el
// alta se hace desde ahí en vez del botón genérico "Agregar accesorio".
function openAccessoryModal(arduinoPrefill) {
    document.getElementById('accessory-name-input').value = '';
    document.getElementById('accessory-kind-select').value = 'extractor';
    document.getElementById('accessory-relay-on-url').value = '';
    document.getElementById('accessory-relay-off-url').value = '';
    document.getElementById('accessory-relay-status-url').value = '';
    document.getElementById('accessory-relay-status-text').value = '';
    document.getElementById('accessory-ha-base-url').value = '';
    document.getElementById('accessory-ha-token').value = '';
    document.getElementById('accessory-ha-entity-id').value = '';
    accessoryArduinoTarget = arduinoPrefill
        ? {
            device: arduinoPrefill.device,
            location: arduinoPrefill.location || '',
            chip: arduinoPrefill.chip || '',
            relays: arduinoPrefill.relays,
            relay: arduinoPrefill.relay || 1,
        }
        : null;
    const driver = arduinoPrefill ? 'arduino' : 'http_relay';
    accessoryDriverSwitch.setValue(driver);
    document.getElementById('accessory-config-relay').hidden = driver !== 'http_relay';
    document.getElementById('accessory-config-ha').hidden = driver !== 'home_assistant';
    document.getElementById('accessory-config-arduino').hidden = driver !== 'arduino';
    updateAccessoryArduinoConfigUI();
    document.getElementById('accessory-modal')?.classList.add('active');
}

function closeAccessoryModal() {
    document.getElementById('accessory-modal')?.classList.remove('active');
}

document.getElementById('accessory-add-btn-settings')?.addEventListener('click', openAccessoryModal);
document.getElementById('accessory-modal-close')?.addEventListener('click', closeAccessoryModal);
document.getElementById('accessory-modal-backdrop')?.addEventListener('click', closeAccessoryModal);
document.getElementById('accessory-cancel-btn')?.addEventListener('click', closeAccessoryModal);

document.getElementById('accessory-save-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('accessory-name-input').value.trim();
    const kind = document.getElementById('accessory-kind-select').value;
    const driver = accessoryDriverSwitch.getValue() || 'http_relay';

    let config = {};
    if (driver === 'home_assistant') {
        config = {
            base_url: document.getElementById('accessory-ha-base-url').value.trim(),
            token: document.getElementById('accessory-ha-token').value.trim(),
            entity_id: document.getElementById('accessory-ha-entity-id').value.trim(),
        };
    } else if (driver === 'arduino') {
        const relaySelect = document.getElementById('accessory-arduino-relay-select');
        const relay = relaySelect ? parseInt(relaySelect.value, 10) : NaN;
        if (!accessoryArduinoTarget || !accessoryArduinoTarget.device || !relay) {
            showToast(t('accessoryArduinoNoDeviceError'), 'error');
            return;
        }
        config = { device: accessoryArduinoTarget.device, relay };
        if (accessoryArduinoTarget.location) config.location = accessoryArduinoTarget.location;
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

// Perfiles de láser/CNC conocidos (ver printer_profiles.py del backend) --
// mismo criterio de caché que marlinPrinterProfilesCache. { [profileId]: perfil }
let laserDeviceProfilesCache = null;

async function ensureLaserDeviceProfiles() {
    if (laserDeviceProfilesCache) return laserDeviceProfilesCache;
    try {
        const response = await fetch('/api/laser/profiles');
        const data = await response.json();
        laserDeviceProfilesCache = {};
        (data.profiles || []).forEach(profile => { laserDeviceProfilesCache[profile.id] = profile; });
    } catch (error) {
        console.error(error);
        laserDeviceProfilesCache = {};
    }
    return laserDeviceProfilesCache;
}

async function populateUsbClassifyModelSelect(kind) {
    const select = document.getElementById('usb-classify-model-select');
    if (!select) return;
    const profiles = await ensureLaserDeviceProfiles();
    const matching = Object.values(profiles).filter(profile => profile.machine_type === kind);
    select.innerHTML = `<option value="">${escapeHtml(t('usbClassifyModelGeneric'))}</option>` +
        matching.map(profile =>
            `<option value="${escapeHtml(profile.id)}">${escapeHtml(`${profile.manufacturer} ${profile.model}`)}</option>`
        ).join('');
    select.value = '';
}

// Elegir un modelo conocido rellena ancho/alto de una vez -- no reemplaza
// el escaneo real de $130/$131 (ver runUsbClassifyScan), lo complementa
// para cuando la placa no trae esos valores configurados o el usuario
// prefiere no medir a mano.
function applyUsbClassifyModelProfile(profileId) {
    const profile = laserDeviceProfilesCache?.[profileId];
    if (!profile || !profile.work_area) return;
    const widthInput = document.getElementById('usb-classify-scan-width');
    const heightInput = document.getElementById('usb-classify-scan-height');
    const scanGrid = document.getElementById('usb-classify-scan-grid');
    if (widthInput) widthInput.value = profile.work_area.x;
    if (heightInput) heightInput.value = profile.work_area.y;
    if (scanGrid) scanGrid.hidden = false;
}

document.getElementById('usb-classify-model-select')?.addEventListener('change', event => {
    applyUsbClassifyModelProfile(event.target.value);
});

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
    populateUsbClassifyModelSelect(target.kind);
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
        loadRegistryDevices();
        if (document.getElementById('laser-host-select')) loadLaserHostSelector();
    } catch (error) {
        console.error(error);
        showToast(error.message || t('usbTestFailed'), 'error');
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

function handleUsbClassifyPrinter() {
    const target = usbClassifyTarget;
    closeUsbClassifyModal();
    if (target?.transport === 'usb') {
        openMarlinRegisterModal(target.device, target.chip);
    } else {
        showToast(t('usbPrinterNotSupported'), 'error');
    }
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
        loadRegistryDevices();
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

// ── Badges numéricos de cola en el sidebar (Láser, CNC, Impresión 3D) ──
// Láser y CNC son ambas placas GRBL y comparten una única cola en el backend
// (solo puede haber un trabajo GRBL activo a la vez), así que sus dos badges
// siempre muestran el mismo número. Impresión 3D consulta un endpoint propio
// que ya excluye el trabajo que está imprimiendo activamente en cada Klipper.
function setNavItemBadge(elId, count) {
    const badge = document.getElementById(elId);
    if (!badge) return;
    badge.closest('.nav-item')?.classList.toggle('has-queue-items', count > 0);
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

// La cola es un único pool en el backend, pero cada archivo se agrega con
// un `kind` ("laser"/"cnc", ver add_to_queue) según desde qué ficha se
// mandó — así el badge de cada sección cuenta solo lo suyo, no el total
// combinado. Entradas viejas sin `kind` (servidor recién reiniciado antes
// de este cambio) se tratan como "laser" por default.
function updateLaserCncQueueBadges(queue) {
    const items = queue || [];
    const laserCount = items.filter(item => (item.kind || 'laser') !== 'cnc').length;
    const cncCount = items.filter(item => item.kind === 'cnc').length;
    setNavItemBadge('nav-badge-laser', laserCount);
    setNavItemBadge('nav-badge-cnc', cncCount);
}

// refreshLaserQueue()/refreshCncQueue() solo corren mientras se está dentro
// de esas secciones (startLaserPolling/startCncPolling se detienen al salir
// de Láser/CNC), así que además hace falta un poll propio y liviano que
// mantenga los badges del sidebar al día sin importar en qué sección esté
// el usuario.
async function refreshLaserCncQueueBadgesGlobal() {
    try {
        const response = await fetch('/api/laser/queue');
        const data = await response.json();
        updateLaserCncQueueBadges(data.queue || []);
    } catch (error) {
        console.error(error);
    }
}

async function refreshModelsQueueBadge() {
    try {
        const response = await fetch('/api/printers/queue/count');
        const data = await response.json();
        setNavItemBadge('nav-badge-models', data.count || 0);
    } catch (error) {
        console.error(error);
    }
}

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
    // El panel de trabajo activo (ficha "Movimiento del cabezal") es la
    // única fuente de controles/progreso — antes había una segunda copia
    // (pausar/cancelar + barra) suelta dentro de la ficha "Cola del láser"
    // que duplicaba exactamente esta misma info sin agregar nada.
    const pauseBtn = document.getElementById('laser-pause-btn-panel');
    const resumeBtn = document.getElementById('laser-resume-btn-panel');
    const cancelBtn = document.getElementById('laser-cancel-btn-panel');
    const progressWrap = document.getElementById('laser-job-progress-panel');
    const progressFill = document.getElementById('laser-job-progress-fill-panel');
    const progressText = document.getElementById('laser-job-progress-text-panel');
    const errorEl = document.getElementById('laser-job-error');
    if (!pauseBtn) return;

    // Un G0/G1 manual pone GRBL en estado Run durante unos instantes. El
    // backend lo reporta como `source: external`, pero no es una grabación
    // administrada por NOPAL y no debe abrir ni bloquear este panel.
    const isManagedJob = job?.source === 'stream' || job?.source === 'sd';
    const state = isManagedJob ? (job?.state || 'idle') : 'idle';
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

    if (pauseBtn) pauseBtn.hidden = state !== 'running';
    if (resumeBtn) resumeBtn.hidden = state !== 'paused';
    if (cancelBtn) cancelBtn.hidden = !isActive;

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
    if (progressWrap) progressWrap.hidden = !showProgress;
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = `${percent}%`;
    if (errorEl) errorEl.textContent = dismissed ? '' : (job?.error || '');

    // Mientras hay un trabajo para mostrar, "Controles de máquina" (encender
    // láser/aire asistido) no aporta nada — el gcode ya maneja el láser — así
    // que se oculta y el panel del trabajo ocupa todo el ancho de esa fila
    // en vez de quedar apretado a la mitad.
    const controlsQuadrant = document.querySelector('.laser-jog-quadrant-controls');
    const jobQuadrant = document.querySelector('.laser-jog-quadrant-job');
    if (controlsQuadrant) controlsQuadrant.hidden = showProgress;
    if (jobQuadrant) {
        jobQuadrant.hidden = !showProgress;
        jobQuadrant.classList.toggle('laser-jog-quadrant-job-full', showProgress);
    }

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

    // Los botones de jog/step (.laser-jog-btn/.laser-step-btn) son la MISMA
    // clase compartida entre la ficha de Láser, la de CNC y el asistente de
    // dibujo de CNC — pero acá arriba "host" puede ser el de un láser
    // trabajando mientras el usuario está mirando la sección CNC (ambas
    // pueden tener trabajos activos en simultáneo, cada una en su propia
    // placa). Deshabilitar por clase sin distinguir sección apagaba el jog
    // de CNC entero apenas cualquier láser se ponía a correr, aunque la
    // placa CNC seleccionada estuviera completamente libre. Se compara el
    // host del trabajo activo contra el host seleccionado en CADA sección
    // para decidir si a ESA sección le toca deshabilitarse.
    const laserSelectedHost = document.getElementById('laser-host-select')?.value || '';
    const cncSelectedHost = document.getElementById('cnc-host-select')?.value || '';
    const disableLaserJog = isActive && host === laserSelectedHost;
    const disableCncJog = isActive && host === cncSelectedHost;

    document.querySelectorAll('#laser-section .laser-jog-btn, #laser-section .laser-step-btn, #laser-unlock-btn, #laser-fire-btn, #laser-fire-power-input, #laser-air-btn').forEach(el => {
        el.disabled = disableLaserJog;
    });
    document.querySelectorAll('#cnc-section .laser-jog-btn, #cnc-section .laser-step-btn, #cnc-wizard-modal .laser-jog-btn, #cnc-wizard-modal .laser-step-btn').forEach(el => {
        el.disabled = disableCncJog;
    });
}

async function refreshLaserJob() {
    try {
        // Antes esto solo consultaba el host seleccionado en pantalla, así
        // que un corte en curso "desaparecía" de la ficha en cuanto el
        // usuario miraba otro láser en la interfaz. Ahora se pregunta
        // primero si CUALQUIER host registrado de tipo láser tiene un
        // trabajo propio activo (running/paused) y, si lo hay, se muestra
        // ese — sin importar cuál esté seleccionado — para no perderlo de
        // vista al navegar. Se excluyen los hosts tipo CNC a propósito: esta
        // ficha vive en la sección Láser, y `/api/laser/jobs/active` no
        // distingue kind — sin este filtro, un trabajo de CNC corriendo se
        // mostraba acá como si fuera del láser. Si no hay ninguno activo, se
        // sigue mostrando el estado (idle/terminado) del host seleccionado,
        // como antes.
        const activeResponse = await fetch('/api/laser/jobs/active');
        const activeData = await activeResponse.json();
        const activeJob = (activeData.jobs || []).find(job => {
            const device = laserHostOptions.find(item => item.host === job.host);
            return (device?.kind || 'laser') !== 'cnc';
        });
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
        const queue = data.queue || [];
        renderLaserQueue(queue.filter(item => (item.kind || 'laser') !== 'cnc'));
        updateLaserCncQueueBadges(queue);
    } catch (error) {
        console.error(error);
    }
}

// Las claves de conexión USB (get_board_info en laser_service.py) son fijas
// y las controlamos nosotros -- se pueden traducir. Las de red vienen del
// firmware (respuesta [ESP420] de ESP3D/FluidNC, "Chip ID"/"FW version"/etc.)
// y varían según la placa, así que no hay un set cerrado para mapear: esas
// se muestran tal cual, igual que el resto de NOPAL cuando un valor no
// mapeado no se adivina.
const LASER_INFO_KEY_LABELS = {
    Device: 'laserInfoDevice',
    Chip: 'laserInfoChip',
    Description: 'laserInfoDescription',
};

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
            <span>${escapeHtml(LASER_INFO_KEY_LABELS[key] ? t(LASER_INFO_KEY_LABELS[key]) : key)}</span>
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
    const cameraContainer = document.getElementById('laser-modal-camera');
    if (cameraContainer && activeHost) window.NopalCameraCard?.mount(cameraContainer, { deviceType: 'laser', deviceId: activeHost });
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
            // renderLaserHostOptions (no solo applyLaserMachineKindUI) porque
            // también actualiza el título de "Consola Láser de: X" y el mapa
            // de área de trabajo — si no, ambos quedan pegados a la máquina
            // anterior hasta que se sale y se vuelve a entrar a la sección.
            renderLaserHostOptions(laserHostSelect.value);
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
    if (listEl) listEl.innerHTML = `<div class="empty-state-small empty-state-small-loading"><span class="mini-spinner"></span>${t('laserSdLoading')}</div>`;
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

const laserHubTabs = createOptionSwitch('laser-hub-tabs', tab => {
    document.querySelectorAll('.laser-hub-panel').forEach(panel => {
        panel.hidden = panel.dataset.hubPanel !== tab;
    });
});
if (laserHubTabs) laserHubTabs.setValue('connection');

// La pestaña "Memoria (SD)" del hub solo tiene sentido si la placa
// conectada realmente reporta tener una tarjeta SD -- si no, se oculta el
// botón de la pestaña (si estaba activa, se vuelve a "Conexión").
function setLaserMemoryTabAvailable(available) {
    const memoryTab = document.querySelector('#laser-hub-tabs [data-value="memory"]');
    if (memoryTab) memoryTab.hidden = !available;
    if (!available && laserHubTabs && laserHubTabs.getValue() === 'memory') {
        laserHubTabs.setValue('connection');
        document.querySelectorAll('.laser-hub-panel').forEach(panel => {
            panel.hidden = panel.dataset.hubPanel !== 'connection';
        });
    }
}

async function checkSdAvailability() {
    const sdCard = document.getElementById('laser-sd-card');
    if (!sdCard) return;
    try {
        const response = await fetch('/api/laser/sd/available');
        const data = await response.json();
        setLaserMemoryTabAvailable(!!data.available);
        if (data.available) {
            loadSdLibraryOptions();
            loadSdFolder('/');
        }
    } catch (error) {
        console.error(error);
        setLaserMemoryTabAvailable(false);
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

document.getElementById('laser-pause-btn-panel')?.addEventListener('click', handleLaserPause);
document.getElementById('laser-resume-btn-panel')?.addEventListener('click', handleLaserResume);
document.getElementById('laser-cancel-btn-panel')?.addEventListener('click', handleLaserCancel);

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

document.getElementById('laser-move-to-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (laserJobIsActive) {
        appAlert(t('laserMoveBusy'), '', 'warning');
        return;
    }

    const parseCoordinate = (id) => Number.parseFloat(
        (document.getElementById(id)?.value || '').trim().replace(',', '.')
    );
    const x = parseCoordinate('laser-move-x-input');
    const y = parseCoordinate('laser-move-y-input');
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        appAlert(t('laserMoveInvalid'), '', 'warning');
        return;
    }
    if (laserBedMapWorkArea && (
        x < 0 || y < 0 ||
        x > laserBedMapWorkArea.width || y > laserBedMapWorkArea.height
    )) {
        appAlert(t('laserMoveOutsideWorkArea'), '', 'warning');
        return;
    }

    const moved = await sendLaserRawCommand(
        `G90 G21 G0 X${x.toFixed(2)} Y${y.toFixed(2)} F${LASER_JOG_FEED}`
    );
    if (!moved) {
        appAlert(t('laserMoveError'), '', 'danger');
        return;
    }
    refreshLaserStatus();
});

document.querySelectorAll('#laser-move-to-form input').forEach((input) => {
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        document.getElementById('laser-move-to-form')?.requestSubmit();
    });
});

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
    const cameraContainer = document.getElementById('cnc-modal-camera');
    if (cameraContainer && resolvedHost) window.NopalCameraCard?.mount(cameraContainer, { deviceType: 'cnc', deviceId: resolvedHost });
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
        const queue = data.queue || [];
        renderCncQueue(queue.filter(item => item.kind === 'cnc'));
        updateLaserCncQueueBadges(queue);
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

        // Mismo respaldo que en la biblioteca de Archivos: si la miniatura
        // generada por el servidor no carga (archivo grande aún
        // procesándose, request cancelado, etc.), no se queda en blanco para
        // siempre -- cae al render 3D del lado del cliente.
        tbody.querySelectorAll('.cnc-files-thumb').forEach(img => {
            img.addEventListener('error', () => {
                const replacement = document.createElement('div');
                replacement.className = 'cnc-files-thumb';
                img.replaceWith(replacement);
                const fileUrl = img.closest('tr')?.dataset.fileUrl;
                if (fileUrl) renderCncGcodeThumbnail(replacement, fileUrl);
            }, { once: true });
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
                formData.append('kind', 'cnc');
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

// ── Impresoras Marlin standalone (USB o MKS WiFi, sin Moonraker) ──
// Path paralelo al de impresoras Klipper y al de CNC/láser: acá no hay
// Moonraker ni GRBL, solo G-code Marlin puro sobre USB serie o TCP 8080 (ver
// backend/services/marlin_printer_service.py). El alta vive en Configuración;
// ficha operativa (jog/temperaturas/consola/impresión) es esta sección
// dedicada ("Impresoras Marlin" en el menú) + un modal de detalle por
// impresora, mismo patrón tarjeta->modal que usa Impresora 3D (Klipper).

let marlinPrintersRegistryCache = [];
// Catálogo de perfiles (ver printer_profiles.py) -- estático del lado del
// backend, se pide una sola vez y se cachea acá para no repetir el fetch
// en cada render de tarjeta. { [profileId]: perfil }
let marlinPrinterProfilesCache = null;

async function ensureMarlinPrinterProfiles() {
    if (marlinPrinterProfilesCache) return marlinPrinterProfilesCache;
    try {
        const response = await fetch('/api/marlin-printers/profiles');
        const data = await response.json();
        marlinPrinterProfilesCache = {};
        (data.profiles || []).forEach(profile => { marlinPrinterProfilesCache[profile.id] = profile; });
    } catch (error) {
        console.error(error);
        marlinPrinterProfilesCache = {};
    }
    return marlinPrinterProfilesCache;
}

// Etiqueta legible de la revisión de placa (ej. "MKS Robin Nano V3 (2023)")
// a partir de profile_id/board_variant guardados en el registro -- null si
// todavía no se cargó el catálogo o la impresora no tiene perfil (placa
// Marlin genérica, caso normal y válido).
function marlinBoardVariantLabel(profileId, boardVariant) {
    if (!profileId || !boardVariant || !marlinPrinterProfilesCache) return null;
    const profile = marlinPrinterProfilesCache[profileId];
    return profile?.board_variants?.[boardVariant]?.label || null;
}

async function loadMarlinPrintersSettingsCard() {
    const registryContainer = document.getElementById('marlin-printers-registry-list');
    if (!registryContainer) return;
    try {
        const [mksResponse, registryResponse] = await Promise.all([
            fetch('/api/marlin-printers/mks-wifi/discover'),
            fetch('/api/marlin-printers/registry/status'),
        ]);
        const mksData = await mksResponse.json();
        const registryData = await registryResponse.json();
        marlinPrintersRegistryCache = registryData.printers || [];
        renderMarlinMksWifiDiscoverList(mksData.modules || []);
        renderMarlinRegistryList(marlinPrintersRegistryCache);
    } catch (error) {
        console.error(error);
    }
}

function renderMarlinMksWifiDiscoverList(modules) {
    const container = document.getElementById('marlin-mks-wifi-discover-list');
    if (!container) return;
    if (!modules.length) {
        container.innerHTML = `<div class="empty-state-small">${escapeHtml(t('marlinMksWifiNoModules'))}</div>`;
        return;
    }
    container.innerHTML = modules.map(module => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(module.ip)}</strong>
                <span>${escapeHtml(t('marlinTransportMksWifi'))} · ${escapeHtml(module.module_id || '')}</span>
            </div>
            <span class="usb-port-vidpid">TCP ${escapeHtml(String(module.port || 8080))}</span>
            <button type="button" class="btn-file-action marlin-mks-wifi-add-btn"
                data-device="${escapeHtml(module.device || '')}" data-host="${escapeHtml(module.ip)}"
                data-module-id="${escapeHtml(module.module_id || '')}">${escapeHtml(t('usbPortAdd'))}</button>
        </div>
    `).join('');
    container.querySelectorAll('.marlin-mks-wifi-add-btn').forEach(btn => {
        btn.addEventListener('click', () => openMarlinRegisterModal(
            btn.dataset.device, btn.dataset.moduleId, 'mks_wifi', { host: btn.dataset.host }
        ));
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
                <span>${escapeHtml(printer.device)} · ${printer.transport === 'mks_wifi' ? escapeHtml(t('marlinTransportMksWifi')) : `${printer.baud || 115200} bps`}</span>
            </div>
            ${printer.conflict
                ? `<span class="device-status-pill conflict" title="${escapeHtml(printer.conflict)}">${escapeHtml(t('deviceConflict'))}</span>`
                : `<span class="device-status-pill ${printer.online ? 'online' : 'offline'}">${printer.online ? t('online') : t('offline')}</span>`
            }
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
document.getElementById('marlin-mks-wifi-manual-btn')?.addEventListener('click', () => {
    openMarlinRegisterModal('', 'MKS WiFi', 'mks_wifi');
});

let marlinRegisterTarget = null;

function updateMarlinRegisterTransportFields() {
    const transport = document.getElementById('marlin-printer-register-transport')?.value || 'usb_serial';
    const wifiFields = document.getElementById('marlin-printer-register-wifi-fields');
    const baudField = document.getElementById('marlin-printer-register-baud-field');
    if (wifiFields) wifiFields.hidden = transport !== 'mks_wifi';
    if (baudField) baudField.hidden = transport === 'mks_wifi';
}

function updateMarlinRegisterProfileFields() {
    const profileId = document.getElementById('marlin-printer-register-profile')?.value || '';
    const fields = document.getElementById('marlin-printer-register-profile-fields');
    const boardSelect = document.getElementById('marlin-printer-register-board');
    const extrudersSelect = document.getElementById('marlin-printer-register-extruders');
    const profile = marlinPrinterProfilesCache?.[profileId];
    if (fields) fields.hidden = !profile;
    if (!profile) return;

    if (boardSelect) {
        boardSelect.innerHTML = `<option value="">${escapeHtml(t('marlinBoardVariantUnknown'))}</option>` +
            Object.entries(profile.board_variants || {}).map(([id, variant]) =>
                `<option value="${escapeHtml(id)}">${escapeHtml(variant.label || id)}</option>`
            ).join('');
    }
    if (extrudersSelect) {
        const minimum = profile.extruders?.minimum || 1;
        const maximum = profile.extruders?.maximum || minimum;
        extrudersSelect.innerHTML = Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index)
            .map(count => `<option value="${count}"${count === maximum ? ' selected' : ''}>${count}</option>`).join('');
    }
}

async function populateMarlinRegisterProfiles(preferredProfile = '') {
    const profiles = await ensureMarlinPrinterProfiles();
    const select = document.getElementById('marlin-printer-register-profile');
    if (!select) return;
    select.innerHTML = `<option value="">${escapeHtml(t('marlinProfileGeneric'))}</option>` +
        Object.values(profiles).map(profile =>
            `<option value="${escapeHtml(profile.id)}">${escapeHtml(`${profile.manufacturer} ${profile.model}`)}</option>`
        ).join('');
    select.value = profiles[preferredProfile] ? preferredProfile : '';
    updateMarlinRegisterProfileFields();
}

async function probeMarlinUsbRegistration(device, baud = '') {
    const formData = new FormData();
    formData.append('device', device);
    if (baud) formData.append('baud', baud);
    const response = await fetch('/api/marlin-printers/usb-ports/test', { method: 'POST', body: formData });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || t('usbTestFailed'));
    }
    return response.json();
}

function marlinMachineName(testData) {
    return String(testData?.firmware_info?.MACHINE_TYPE || '').trim();
}

async function openMarlinRegisterModal(device, chip, transport = 'usb_serial', options = {}) {
    marlinRegisterTarget = { device: device || '', transport };
    const label = document.getElementById('marlin-printer-register-device-label');
    if (label) label.textContent = [chip, device].filter(Boolean).join(' · ') || t('marlinMksWifiManualAdd');
    const nameInput = document.getElementById('marlin-printer-register-name');
    if (nameInput) {
        nameInput.value = transport === 'mks_wifi' ? 'Hellbot Magna 2 300' :
            (chip && chip !== 'CH340' && chip !== 'CH340K' ? chip : 'Impresora Marlin');
        nameInput.dataset.autoName = 'true';
    }
    const transportSelect = document.getElementById('marlin-printer-register-transport');
    if (transportSelect) transportSelect.value = transport;
    const hostInput = document.getElementById('marlin-printer-register-host');
    if (hostInput) hostInput.value = options.host || '';
    const portInput = document.getElementById('marlin-printer-register-port');
    if (portInput) portInput.value = '8080';
    const baudSelect = document.getElementById('marlin-printer-register-baud');
    if (baudSelect) baudSelect.value = '';
    updateMarlinRegisterTransportFields();
    await populateMarlinRegisterProfiles(transport === 'mks_wifi' ? 'hellbot_magna2_300' : '');
    document.getElementById('marlin-printer-register-modal')?.classList.add('active');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
    // El puerto ya está conectado: identifícalo en segundo plano y usa el
    // MACHINE_TYPE real de M115 como nombre. Si el usuario empieza a escribir
    // un apodo mientras llega la respuesta, no se pisa su texto.
    if (transport === 'usb_serial' && device && marlinRegisterTarget) {
        const target = marlinRegisterTarget;
        target.probePromise = probeMarlinUsbRegistration(device).then(testData => {
            if (marlinRegisterTarget !== target) return testData;
            target.detected = testData;
            const machineName = marlinMachineName(testData);
            if (machineName && nameInput?.dataset.autoName === 'true') nameInput.value = machineName;
            if (baudSelect && testData.baud) baudSelect.dataset.detectedBaud = String(testData.baud);
            if (label && machineName) label.textContent = `${machineName} · ${device}`;
            return testData;
        }).catch(() => null);
    }
}

function closeMarlinRegisterModal() {
    document.getElementById('marlin-printer-register-modal')?.classList.remove('active');
    marlinRegisterTarget = null;
}

document.getElementById('marlin-printer-register-close')?.addEventListener('click', closeMarlinRegisterModal);
document.getElementById('marlin-printer-register-backdrop')?.addEventListener('click', closeMarlinRegisterModal);
document.getElementById('marlin-printer-register-cancel-btn')?.addEventListener('click', closeMarlinRegisterModal);
document.getElementById('marlin-printer-register-transport')?.addEventListener('change', updateMarlinRegisterTransportFields);
document.getElementById('marlin-printer-register-profile')?.addEventListener('change', updateMarlinRegisterProfileFields);
document.getElementById('marlin-printer-register-name')?.addEventListener('input', event => {
    event.currentTarget.dataset.autoName = 'false';
});

document.getElementById('marlin-printer-register-confirm-btn')?.addEventListener('click', async () => {
    let device = marlinRegisterTarget?.device || '';
    const transport = document.getElementById('marlin-printer-register-transport')?.value || 'usb_serial';
    const nameInput = document.getElementById('marlin-printer-register-name');
    const baudSelect = document.getElementById('marlin-printer-register-baud');
    let name = nameInput ? nameInput.value.trim() : '';
    if (!name) return;
    // Vacío ("Auto-detectar") significa "no mandar baud" -- el backend
    // prueba 115200/250000 solo (ver probe_marlin_autobaud). Si el usuario
    // eligió uno a mano, se manda ese tal cual, igual que antes.
    const selectedBaud = baudSelect ? baudSelect.value : '';
    try {
        const testFormData = new FormData();
        let testUrl = '/api/marlin-printers/usb-ports/test';
        let testData = null;
        if (transport === 'mks_wifi') {
            const host = document.getElementById('marlin-printer-register-host')?.value.trim() || '';
            const port = document.getElementById('marlin-printer-register-port')?.value || '8080';
            if (!host) throw new Error(t('marlinMksWifiHostRequired'));
            testFormData.append('host', host);
            testFormData.append('port', port);
            testUrl = '/api/marlin-printers/mks-wifi/test';
        } else {
            if (!device) return;
            testFormData.append('device', device);
            if (selectedBaud) testFormData.append('baud', selectedBaud);
            if (!selectedBaud && marlinRegisterTarget?.probePromise) {
                testData = await marlinRegisterTarget.probePromise;
            }
        }
        if (!testData) {
            const testResponse = await fetch(testUrl, { method: 'POST', body: testFormData });
            if (!testResponse.ok) {
                const data = await testResponse.json().catch(() => ({}));
                throw new Error(data.detail || t('usbTestFailed'));
            }
            testData = await testResponse.json();
        }
        if (transport === 'mks_wifi') device = testData.device;
        const detectedMachineName = marlinMachineName(testData);
        if (detectedMachineName && nameInput?.dataset.autoName === 'true') {
            name = detectedMachineName;
            nameInput.value = detectedMachineName;
        }
        if (!name) throw new Error(t('usbRegisterNameLabel'));

        const formData = new FormData();
        formData.append('device', device);
        formData.append('name', name);
        formData.append('transport', transport);
        const resolvedBaud = selectedBaud || testData.baud || '';
        if (transport === 'usb_serial' && resolvedBaud) formData.append('baud', resolvedBaud);
        const profileId = document.getElementById('marlin-printer-register-profile')?.value || '';
        if (profileId) {
            formData.append('profile_id', profileId);
            const boardVariant = document.getElementById('marlin-printer-register-board')?.value || '';
            const extruderCount = document.getElementById('marlin-printer-register-extruders')?.value || '';
            if (boardVariant) formData.append('board_variant', boardVariant);
            if (extruderCount) formData.append('extruder_count', extruderCount);
        }
        const registerResponse = await fetch('/api/marlin-printers/registry', { method: 'POST', body: formData });
        if (!registerResponse.ok) {
            const data = await registerResponse.json().catch(() => ({}));
            throw new Error(data.detail || t('usbScanFailed'));
        }
        closeMarlinRegisterModal();
        showToast(`${name}: ${t('marlinPrinterRegisterSuccess')}`);
    } catch (error) {
        console.error(error);
        showToast(error.message || t('usbScanFailed'), 'error');
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
    const boardLabel = marlinBoardVariantLabel(printer.profile_id, printer.board_variant);
    // extruder_count solo se guarda con perfil (ver printer_profiles.py) --
    // una placa Marlin genérica sin perfil sigue siendo de un solo hotend,
    // como toda la vida.
    const dualExtruder = printer.extruder_count === 2;

    const readTemp = key => status?.[key] && typeof status[key].current === 'number' ? Math.round(status[key].current * 10) / 10 : null;
    const readTarget = key => status?.[key] && typeof status[key].target === 'number' ? status[key].target : 0;
    const bedTemp = readTemp('heater_bed');
    const bedTarget = readTarget('heater_bed');
    // Para la onda térmica decorativa, con doble extrusor alcanza con T0 --
    // es un efecto visual aproximado, no una lectura exacta por extrusor.
    const primaryExtruderKey = dualExtruder ? 'extruder0' : 'extruder';
    const extruderTemp = readTemp(primaryExtruderKey);
    const extruderTarget = readTarget(primaryExtruderKey);

    const tempItemsHtml = dualExtruder
        ? `
            <div class="temp-item">
                <div class="temp-label">${t('bedTemp')}</div>
                <div class="temp-value">${bedTemp != null ? bedTemp : '--'}<span class="temp-unit">°C</span></div>
            </div>
            <div class="temp-item">
                <div class="temp-label">T0</div>
                <div class="temp-value">${readTemp('extruder0') != null ? readTemp('extruder0') : '--'}<span class="temp-unit">°C</span></div>
            </div>
            <div class="temp-item">
                <div class="temp-label">T1</div>
                <div class="temp-value">${readTemp('extruder1') != null ? readTemp('extruder1') : '--'}<span class="temp-unit">°C</span></div>
            </div>
        `
        : `
            <div class="temp-item">
                <div class="temp-label">${t('bedTemp')}</div>
                <div class="temp-value">${bedTemp != null ? bedTemp : '--'}<span class="temp-unit">°C</span></div>
            </div>
            <div class="temp-item">
                <div class="temp-label">${t('extruderTemp')}</div>
                <div class="temp-value">${extruderTemp != null ? extruderTemp : '--'}<span class="temp-unit">°C</span></div>
            </div>
        `;

    const heatProgress = visualState === 'heating' ? computeHeatProgress(bedTemp, bedTarget, extruderTemp, extruderTarget) : null;
    // PRINTER_STATE_IMAGES no tiene entrada "offline" (ver printerIllustrationImg)
    // -- se pisa por "idle" solo para elegir la imagen, el resto de la tarjeta
    // sigue mostrando el estado real sin conexión.
    const illustrationState = visualState === 'offline' ? 'idle' : visualState;
    return `
        <div class="printer-card printer-card-type-3d printer-card-connection-marlin ${isOnline ? 'online' : 'offline'} ${visualState}" data-marlin-device="${escapeHtml(printer.device)}" data-heat-progress="${heatProgress ?? ''}">
            ${printerThermalWaves(bedTemp, extruderTemp, bedTarget, extruderTarget, visualState, !isOnline)}
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${escapeHtml(name)}</h3>
                    <p class="printer-name-sub">${boardLabel ? escapeHtml(boardLabel) : 'Marlin'}</p>
                </div>
                <div class="printer-quick-actions">
                    ${isOnline ? `<button type="button" class="printer-quick-action-btn marlin-card-temp-action" data-marlin-temp-action="cool" title="${t('tempCool')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.7 17.7 8.4a8 8 0 1 1-11.4 0Z"/></svg></button>
                    <button type="button" class="printer-quick-action-btn printer-quick-action-btn-accent marlin-card-temp-action" data-marlin-temp-action="preheat" title="${t('tempPreset')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15.4 5.2A8.25 8.25 0 1 1 6 7a8.3 8.3 0 0 0 3 2.6 9 9 0 0 1 3.4-6.9 8.2 8.2 0 0 0 3 2.5Z"/></svg></button>` : ''}
                    <div class="printer-status-icon ${isOnline ? 'online' : 'offline'}" title="${statusText}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                    </div>
                </div>
            </div>

            <div class="printer-status-line ${visualState}">
                <span class="printer-status-dot ${visualState}"></span>${stateLabel}
            </div>

            <div class="printer-illustration printer-illustration-${illustrationState}">
                ${printerIllustrationImg(illustrationState)}
            </div>

            ${isOnline ? `<div class="printer-temps${dualExtruder ? ' printer-temps-triple' : ''}">${tempItemsHtml}</div>` : ''}
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
        bindMarlinTemperatureActions(grid);
        grid.querySelectorAll('.printer-card[data-marlin-device]').forEach(card => {
            card.addEventListener('click', () => openMarlinPrinterModal(card.dataset.marlinDevice));
        });
    } catch (error) {
        console.error(error);
    }
}

async function loadMarlinSection() {
    await ensureMarlinPrinterProfiles();
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
        document.getElementById('usb-ports-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
});

// ── Impresoras Elegoo standalone (SDCP por WebSocket, Centauri Carbon/Carbon
// 2, Neptune 4, OrangeStorm Giga) ── Path paralelo a Marlin: acá tampoco hay
// Moonraker, pero a diferencia de Marlin (puerto serie USB) el alta es por
// red — mismo patrón que láser/CNC (escanear -> elegir -> nombrar ->
// registrar, ver loadWifiDevices/openUsbClassifyModal), no el de puertos USB.
// La ficha operativa es esta sección dedicada ("Impresoras Elegoo" en el
// menú); a diferencia de Marlin/Klipper no hay modal de detalle porque SDCP
// no expone jog/homing manual — pausar/reanudar/cancelar alcanza directo en
// la tarjeta (ver elegooPrinterCardHtml).

let elegooPrintersRegistryCache = [];

function getElegooVisualState(printer) {
    if (!printer || !printer.online) return 'offline';
    const state = (printer.job && printer.job.state) || 'idle';
    if (state === 'printing' || state === 'preparing' || state === 'resuming') return 'printing';
    if (state === 'paused' || state === 'pausing') return 'paused';
    // "stopping" (cancelación en curso) y "unknown" caen acá: son estados de
    // transición hacia inactivo, no ameritan su propio color/animación.
    return 'idle';
}

function elegooPrinterCardHtml(printer) {
    const visualState = getElegooVisualState(printer);
    const isOnline = visualState !== 'offline';
    const statusText = isOnline ? t('online') : t('offline');
    const stateLabel = isOnline ? t(visualState) : t('offline');
    const name = printer.name || printer.model || printer.id;
    const subLabel = [printer.model, printer.ip].filter(Boolean).join(' · ');
    // PRINTER_STATE_IMAGES no tiene entrada "offline" (ver printerIllustrationImg)
    // — se pisa por "idle" solo para elegir la imagen, el resto de la tarjeta
    // sigue mostrando el estado real sin conexión.
    const illustrationState = visualState === 'offline' ? 'idle' : visualState;

    const temps = printer.temps || {};
    const extruder = temps.extruder || {};
    const bed = temps.heater_bed || {};
    const extruderTemp = typeof extruder.current === 'number' ? Math.round(extruder.current * 10) / 10 : null;
    const bedTemp = typeof bed.current === 'number' ? Math.round(bed.current * 10) / 10 : null;
    const extruderTarget = typeof extruder.target === 'number' ? extruder.target : 0;
    const bedTarget = typeof bed.target === 'number' ? bed.target : 0;

    const job = printer.job || {};
    const progress = typeof job.progress === 'number' ? job.progress : 0;
    const layersLabel = (job.current_layer != null && job.total_layer != null)
        ? `${job.current_layer} / ${job.total_layer}`
        : '—';

    const showActions = visualState === 'printing' || visualState === 'paused';
    const isPaused = visualState === 'paused';
    const heatProgress = visualState === 'heating' ? computeHeatProgress(bedTemp, bedTarget, extruderTemp, extruderTarget) : null;

    return `
        <div class="printer-card printer-card-type-3d ${isOnline ? 'online' : 'offline'} ${visualState}" data-elegoo-id="${escapeHtml(printer.id)}" data-heat-progress="${heatProgress ?? ''}">
            ${printerThermalWaves(bedTemp, extruderTemp, bedTarget, extruderTarget, visualState, !isOnline, printer.id)}
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${escapeHtml(name)}</h3>
                    <p class="printer-name-sub">${subLabel ? escapeHtml(subLabel) : 'Elegoo'}</p>
                </div>
                <div class="printer-status-icon ${isOnline ? 'online' : 'offline'}" title="${statusText}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                </div>
            </div>

            <div class="printer-status-line ${visualState}">
                <span class="printer-status-dot ${visualState}"></span>${stateLabel}
            </div>

            <div class="printer-illustration printer-illustration-${illustrationState}">
                ${printerIllustrationImg(illustrationState)}
            </div>

            ${isOnline ? `
                <div class="printer-temps">
                    <div class="temp-item">
                        <div class="temp-label">${t('bedTemp')}</div>
                        <div class="temp-value">${bedTemp != null ? bedTemp : '--'}<span class="temp-unit">°C</span></div>
                    </div>
                    <div class="temp-item">
                        <div class="temp-label">${t('extruderTemp')}</div>
                        <div class="temp-value">${extruderTemp != null ? extruderTemp : '--'}<span class="temp-unit">°C</span></div>
                    </div>
                </div>
            ` : ''}

            ${showActions ? `
                <div class="printer-progress">
                    <div class="printer-progress-labels">
                        <span>${progress}% ${t('printed')}</span>
                        <span>${t('activePrintLayers')}: ${layersLabel}</span>
                    </div>
                    <div class="temp-progress"><div class="temp-progress-fill" style="width: ${progress}%"></div></div>
                </div>
                <div class="elegoo-card-actions">
                    <button type="button" class="elegoo-card-action-btn elegoo-card-action-pause" data-action="${isPaused ? 'resume' : 'pause'}" data-elegoo-id="${escapeHtml(printer.id)}">
                        ${isPaused
                            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
                            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
                        <span>${isPaused ? t('activePrintResume') : t('activePrintPause')}</span>
                    </button>
                    <button type="button" class="elegoo-card-action-btn elegoo-card-action-cancel" data-action="cancel" data-elegoo-id="${escapeHtml(printer.id)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        <span>${t('activePrintCancel')}</span>
                    </button>
                </div>
            ` : ''}
            ${printerDiagToggleHtml('elegoo', printer.id)}
            <div class="printer-card-camera" data-cam-container="elegoo:${escapeHtml(printer.id)}"></div>
        </div>
    `;
}

async function handleElegooPrinterAction(action, printerId) {
    if (!printerId || !action) return;
    if (action === 'cancel') {
        const confirmed = await appConfirm(t('activePrintCancelConfirm'), t('activePrintStop'), 'danger');
        if (!confirmed) return;
    }
    try {
        const response = await fetch(`/api/elegoo/printers/${encodeURIComponent(printerId)}/${action}`, { method: 'POST' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('elegooActionFailed'));
        }
    } catch (error) {
        console.error(error);
        showToast(error.message || t('elegooActionFailed'), 'error');
    } finally {
        refreshElegooPrintersGrid();
    }
}

let elegooGridPollInterval = null;

async function refreshElegooPrintersGrid() {
    const grid = document.getElementById('elegoo-printers-grid');
    if (!grid) return;
    try {
        const response = await fetch('/api/elegoo/printers');
        const data = await response.json();
        const printers = data.printers || [];
        elegooPrintersRegistryCache = printers;
        if (!printers.length) {
            grid.innerHTML = `<div class="empty-state">${t('elegooPrinterNoPrinters')}</div>`;
            return;
        }
        grid.innerHTML = printers.map(elegooPrinterCardHtml).join('');
        grid.querySelectorAll('.elegoo-card-action-btn').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                handleElegooPrinterAction(btn.dataset.action, btn.dataset.elegooId);
            });
        });
        mountCameraCardsIn(grid);
    } catch (error) {
        console.error(error);
    }
}

async function loadElegooSection() {
    refreshElegooPrintersGrid();
    stopElegooPrintersPolling();
    elegooGridPollInterval = setInterval(refreshElegooPrintersGrid, 3000);
}

function stopElegooPrintersPolling() {
    if (elegooGridPollInterval) { clearInterval(elegooGridPollInterval); elegooGridPollInterval = null; }
}

document.getElementById('elegoo-printers-refresh-btn')?.addEventListener('click', refreshElegooPrintersGrid);

// Admin: abre el asistente guiado nuevo pre-seleccionando Elegoo (salta el
// paso 1). Operador: sin acceso al asistente (termina en un POST admin-only),
// se mantiene el comportamiento previo de ir a Configuración a solo mirar la
// lista de descubrimiento -- ver guided-printer-setup.js:openGuidedPrinterSetup.
document.getElementById('elegoo-printers-add-btn')?.addEventListener('click', () => {
    if (currentAuthUser?.role === 'admin' && typeof openGuidedPrinterSetup === 'function') {
        openGuidedPrinterSetup('elegoo');
        return;
    }
    switchSection('settings');
    showToast(t('elegooPrinterAddGoSettingsHint'));
    setTimeout(() => {
        document.getElementById('elegoo-discover-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
});

// ── Alta de impresoras Elegoo en Configuración (escaneo UDP + registro) ──

async function loadElegooRegistryList() {
    const container = document.getElementById('elegoo-printers-registry-list');
    if (!container) return;
    try {
        const response = await fetch('/api/elegoo/printers');
        const data = await response.json();
        elegooPrintersRegistryCache = data.printers || [];
        renderElegooRegistryList(elegooPrintersRegistryCache);
    } catch (error) {
        console.error(error);
    }
}

function renderElegooRegistryList(printers) {
    const container = document.getElementById('elegoo-printers-registry-list');
    if (!container) return;
    if (!printers.length) {
        container.innerHTML = `<div class="empty-state-small">${t('elegooPrinterNoPrinters')}</div>`;
        return;
    }
    container.innerHTML = printers.map(printer => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(printer.name || printer.model || printer.id)}</strong>
                <span>${escapeHtml(printer.ip || '')}${printer.model ? ' · ' + escapeHtml(printer.model) : ''}</span>
            </div>
            <span class="device-status-pill ${printer.online ? 'online' : 'offline'}">${printer.online ? t('online') : t('offline')}</span>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger elegoo-printer-remove-btn" data-id="${escapeHtml(printer.id)}" title="${escapeHtml(t('usbPortUnlink'))}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.elegoo-printer-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!(await appConfirm(t('elegooPrinterRemoveConfirm'), t('usbPortUnlink'), 'danger'))) return;
            try {
                const response = await fetch(`/api/elegoo/printers/${encodeURIComponent(id)}`, { method: 'DELETE' });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.detail || t('elegooActionFailed'));
                }
            } catch (error) {
                console.error(error);
                showToast(error.message || t('elegooActionFailed'), 'error');
            } finally {
                loadElegooRegistryList();
                refreshElegooPrintersGrid();
            }
        });
    });
}

// El escaneo (broadcast UDP) solo se dispara a mano — igual que
// loadWifiDevices() para láser/CNC, no tiene sentido barrer la red cada vez
// que se entra a Configuración.
async function discoverElegooPrinters() {
    const container = document.getElementById('elegoo-discover-list');
    if (!container) return;
    container.innerHTML = `<div class="empty-state-small">${t('laserWifiScanning')}</div>`;
    try {
        await loadElegooRegistryList();
        const response = await fetch('/api/elegoo/printers/discover', { method: 'POST' });
        const data = await response.json();
        renderElegooDiscoverList(data.devices || []);
    } catch (error) {
        console.error(error);
        renderElegooDiscoverList([]);
    }
}

function renderElegooDiscoverList(devices) {
    const container = document.getElementById('elegoo-discover-list');
    if (!container) return;
    const registeredIds = new Set(elegooPrintersRegistryCache.map(printer => printer.id));
    const pending = devices.filter(device => !registeredIds.has(device.mainboard_id));
    if (!pending.length) {
        container.innerHTML = `<div class="empty-state-small">${t('elegooDiscoverEmpty')}</div>`;
        return;
    }
    container.innerHTML = pending.map(device => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(device.name || device.mainboard_id)}</strong>
                <span>${escapeHtml(device.ip)}${device.model ? ' · ' + escapeHtml(device.model) : ''}</span>
            </div>
            <button type="button" class="btn-file-action elegoo-discover-add-btn"
                data-ip="${escapeHtml(device.ip)}"
                data-mainboard-id="${escapeHtml(device.mainboard_id)}"
                data-name="${escapeHtml(device.name || '')}"
                data-model="${escapeHtml(device.model || '')}">${escapeHtml(t('usbPortAdd'))}</button>
        </div>
    `).join('');

    container.querySelectorAll('.elegoo-discover-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openElegooRegisterModal({
                ip: btn.dataset.ip,
                mainboard_id: btn.dataset.mainboardId,
                name: btn.dataset.name,
                model: btn.dataset.model,
            });
        });
    });
}

document.getElementById('elegoo-printers-discover-btn')?.addEventListener('click', discoverElegooPrinters);

let elegooRegisterTarget = null;

function openElegooRegisterModal(device) {
    elegooRegisterTarget = device;
    const label = document.getElementById('elegoo-printer-register-device-label');
    if (label) label.textContent = [device.model, device.ip].filter(Boolean).join(' · ');
    const nameInput = document.getElementById('elegoo-printer-register-name');
    if (nameInput) nameInput.value = device.name || device.model || 'Elegoo';
    document.getElementById('elegoo-printer-register-modal')?.classList.add('active');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
}

function closeElegooRegisterModal() {
    document.getElementById('elegoo-printer-register-modal')?.classList.remove('active');
    elegooRegisterTarget = null;
}

document.getElementById('elegoo-printer-register-close')?.addEventListener('click', closeElegooRegisterModal);
document.getElementById('elegoo-printer-register-backdrop')?.addEventListener('click', closeElegooRegisterModal);
document.getElementById('elegoo-printer-register-cancel-btn')?.addEventListener('click', closeElegooRegisterModal);

document.getElementById('elegoo-printer-register-confirm-btn')?.addEventListener('click', async () => {
    const device = elegooRegisterTarget;
    const nameInput = document.getElementById('elegoo-printer-register-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!device || !name) return;
    closeElegooRegisterModal();
    try {
        const formData = new FormData();
        formData.append('ip', device.ip);
        formData.append('mainboard_id', device.mainboard_id);
        formData.append('name', name);
        formData.append('model', device.model || '');
        const response = await fetch('/api/elegoo/printers', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('elegooActionFailed'));
        }
        showToast(`${name}: ${t('elegooPrinterRegisterSuccess')}`);
    } catch (error) {
        console.error(error);
        showToast(error.message || t('elegooActionFailed'), 'error');
    } finally {
        loadElegooRegistryList();
        refreshElegooPrintersGrid();
    }
});

// ── Impresoras FlashForge standalone (HTTP REST puro por puerto 8898,
// Adventurer 5M/5M Pro/AD5X/Creator 5) ── Mismo patrón que Elegoo (sección
// dedicada, tarjetas propias, alta por escaneo de red en Configuración) — la
// única diferencia real es que FlashForge sí exige autenticación, así que el
// alta pide un campo más (check code) además del nombre. El resto (shape de
// datos, tarjeta, pausar/reanudar/cancelar) es idéntico, así que se reusan a
// propósito las clases CSS .elegoo-card-actions/.elegoo-card-action-btn en
// vez de duplicarlas con otro nombre.

let flashforgePrintersRegistryCache = [];

function getFlashforgeVisualState(printer) {
    if (!printer || !printer.online) return 'offline';
    // job.state documentado: idle | printing | paused | pausing | busy |
    // error | unknown. "busy" (tareas que no son imprimir, ej. nivelación/
    // calibración), "error" y "unknown" caen en "idle": son estados de
    // transición sin color/animación propia, mismo criterio que
    // getElegooVisualState con "stopping"/"unknown".
    const state = (printer.job && printer.job.state) || 'idle';
    if (state === 'printing') return 'printing';
    if (state === 'paused' || state === 'pausing') return 'paused';
    return 'idle';
}

function flashforgePrinterCardHtml(printer) {
    const visualState = getFlashforgeVisualState(printer);
    const isOnline = visualState !== 'offline';
    const statusText = isOnline ? t('online') : t('offline');
    const stateLabel = isOnline ? t(visualState) : t('offline');
    const name = printer.name || printer.model || printer.id;
    const subLabel = [printer.model, printer.ip].filter(Boolean).join(' · ');
    // PRINTER_STATE_IMAGES no tiene entrada "offline" (ver printerIllustrationImg)
    // — se pisa por "idle" solo para elegir la imagen, el resto de la tarjeta
    // sigue mostrando el estado real sin conexión.
    const illustrationState = visualState === 'offline' ? 'idle' : visualState;

    const temps = printer.temps || {};
    const extruder = temps.extruder || {};
    const bed = temps.heater_bed || {};
    const extruderTemp = typeof extruder.current === 'number' ? Math.round(extruder.current * 10) / 10 : null;
    const bedTemp = typeof bed.current === 'number' ? Math.round(bed.current * 10) / 10 : null;
    const extruderTarget = typeof extruder.target === 'number' ? extruder.target : 0;
    const bedTarget = typeof bed.target === 'number' ? bed.target : 0;

    const job = printer.job || {};
    const progress = typeof job.progress === 'number' ? job.progress : 0;
    const layersLabel = (job.current_layer != null && job.total_layer != null)
        ? `${job.current_layer} / ${job.total_layer}`
        : '—';

    const showActions = visualState === 'printing' || visualState === 'paused';
    const isPaused = visualState === 'paused';
    const heatProgress = visualState === 'heating' ? computeHeatProgress(bedTemp, bedTarget, extruderTemp, extruderTarget) : null;

    return `
        <div class="printer-card printer-card-type-3d ${isOnline ? 'online' : 'offline'} ${visualState}" data-flashforge-id="${escapeHtml(printer.id)}" data-heat-progress="${heatProgress ?? ''}">
            ${printerThermalWaves(bedTemp, extruderTemp, bedTarget, extruderTarget, visualState, !isOnline, printer.id)}
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${escapeHtml(name)}</h3>
                    <p class="printer-name-sub">${subLabel ? escapeHtml(subLabel) : 'FlashForge'}</p>
                </div>
                <div class="printer-status-icon ${isOnline ? 'online' : 'offline'}" title="${statusText}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                </div>
            </div>

            <div class="printer-status-line ${visualState}">
                <span class="printer-status-dot ${visualState}"></span>${stateLabel}
            </div>

            <div class="printer-illustration printer-illustration-${illustrationState}">
                ${printerIllustrationImg(illustrationState)}
            </div>

            ${isOnline ? `
                <div class="printer-temps">
                    <div class="temp-item">
                        <div class="temp-label">${t('bedTemp')}</div>
                        <div class="temp-value">${bedTemp != null ? bedTemp : '--'}<span class="temp-unit">°C</span></div>
                    </div>
                    <div class="temp-item">
                        <div class="temp-label">${t('extruderTemp')}</div>
                        <div class="temp-value">${extruderTemp != null ? extruderTemp : '--'}<span class="temp-unit">°C</span></div>
                    </div>
                </div>
            ` : ''}

            ${showActions ? `
                <div class="printer-progress">
                    <div class="printer-progress-labels">
                        <span>${progress}% ${t('printed')}</span>
                        <span>${t('activePrintLayers')}: ${layersLabel}</span>
                    </div>
                    <div class="temp-progress"><div class="temp-progress-fill" style="width: ${progress}%"></div></div>
                </div>
                <div class="elegoo-card-actions">
                    <button type="button" class="elegoo-card-action-btn elegoo-card-action-pause" data-action="${isPaused ? 'resume' : 'pause'}" data-flashforge-id="${escapeHtml(printer.id)}">
                        ${isPaused
                            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
                            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
                        <span>${isPaused ? t('activePrintResume') : t('activePrintPause')}</span>
                    </button>
                    <button type="button" class="elegoo-card-action-btn elegoo-card-action-cancel" data-action="cancel" data-flashforge-id="${escapeHtml(printer.id)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        <span>${t('activePrintCancel')}</span>
                    </button>
                </div>
            ` : ''}
            ${printerDiagToggleHtml('flashforge', printer.id)}
            <div class="printer-card-camera" data-cam-container="flashforge:${escapeHtml(printer.id)}"></div>
        </div>
    `;
}

async function handleFlashforgePrinterAction(action, printerId) {
    if (!printerId || !action) return;
    if (action === 'cancel') {
        const confirmed = await appConfirm(t('activePrintCancelConfirm'), t('activePrintStop'), 'danger');
        if (!confirmed) return;
    }
    try {
        const response = await fetch(`/api/flashforge/printers/${encodeURIComponent(printerId)}/${action}`, { method: 'POST' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('flashforgeActionFailed'));
        }
    } catch (error) {
        console.error(error);
        showToast(error.message || t('flashforgeActionFailed'), 'error');
    } finally {
        refreshFlashforgePrintersGrid();
    }
}

let flashforgeGridPollInterval = null;

async function refreshFlashforgePrintersGrid() {
    const grid = document.getElementById('flashforge-printers-grid');
    if (!grid) return;
    try {
        const response = await fetch('/api/flashforge/printers');
        const data = await response.json();
        const printers = data.printers || [];
        flashforgePrintersRegistryCache = printers;
        if (!printers.length) {
            grid.innerHTML = `<div class="empty-state">${t('flashforgePrinterNoPrinters')}</div>`;
            return;
        }
        grid.innerHTML = printers.map(flashforgePrinterCardHtml).join('');
        grid.querySelectorAll('.elegoo-card-action-btn').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                handleFlashforgePrinterAction(btn.dataset.action, btn.dataset.flashforgeId);
            });
        });
        mountCameraCardsIn(grid);
    } catch (error) {
        console.error(error);
    }
}

async function loadFlashforgeSection() {
    refreshFlashforgePrintersGrid();
    stopFlashforgePrintersPolling();
    flashforgeGridPollInterval = setInterval(refreshFlashforgePrintersGrid, 3000);
}

function stopFlashforgePrintersPolling() {
    if (flashforgeGridPollInterval) { clearInterval(flashforgeGridPollInterval); flashforgeGridPollInterval = null; }
}

document.getElementById('flashforge-printers-refresh-btn')?.addEventListener('click', refreshFlashforgePrintersGrid);

// Admin: abre el asistente guiado nuevo pre-seleccionando FlashForge (salta
// el paso 1). Operador: mismo fallback que el botón equivalente de Elegoo.
document.getElementById('flashforge-printers-add-btn')?.addEventListener('click', () => {
    if (currentAuthUser?.role === 'admin' && typeof openGuidedPrinterSetup === 'function') {
        openGuidedPrinterSetup('flashforge');
        return;
    }
    switchSection('settings');
    showToast(t('flashforgePrinterAddGoSettingsHint'));
    setTimeout(() => {
        document.getElementById('flashforge-discover-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
});

// ── Alta de impresoras FlashForge en Configuración (escaneo UDP + registro) ──

async function loadFlashforgeRegistryList() {
    const container = document.getElementById('flashforge-printers-registry-list');
    if (!container) return;
    try {
        const response = await fetch('/api/flashforge/printers');
        const data = await response.json();
        flashforgePrintersRegistryCache = data.printers || [];
        renderFlashforgeRegistryList(flashforgePrintersRegistryCache);
    } catch (error) {
        console.error(error);
    }
}

function renderFlashforgeRegistryList(printers) {
    const container = document.getElementById('flashforge-printers-registry-list');
    if (!container) return;
    if (!printers.length) {
        container.innerHTML = `<div class="empty-state-small">${t('flashforgePrinterNoPrinters')}</div>`;
        return;
    }
    container.innerHTML = printers.map(printer => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(printer.name || printer.model || printer.id)}</strong>
                <span>${escapeHtml(printer.ip || '')}${printer.model ? ' · ' + escapeHtml(printer.model) : ''}</span>
            </div>
            <span class="device-status-pill ${printer.online ? 'online' : 'offline'}">${printer.online ? t('online') : t('offline')}</span>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger flashforge-printer-remove-btn" data-id="${escapeHtml(printer.id)}" title="${escapeHtml(t('usbPortUnlink'))}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.flashforge-printer-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!(await appConfirm(t('flashforgePrinterRemoveConfirm'), t('usbPortUnlink'), 'danger'))) return;
            try {
                const response = await fetch(`/api/flashforge/printers/${encodeURIComponent(id)}`, { method: 'DELETE' });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.detail || t('flashforgeActionFailed'));
                }
            } catch (error) {
                console.error(error);
                showToast(error.message || t('flashforgeActionFailed'), 'error');
            } finally {
                loadFlashforgeRegistryList();
                refreshFlashforgePrintersGrid();
            }
        });
    });
}

// El escaneo (broadcast UDP) solo se dispara a mano — igual que
// discoverElegooPrinters(), no tiene sentido barrer la red cada vez que se
// entra a Configuración.
async function discoverFlashforgePrinters() {
    const container = document.getElementById('flashforge-discover-list');
    if (!container) return;
    container.innerHTML = `<div class="empty-state-small">${t('laserWifiScanning')}</div>`;
    try {
        await loadFlashforgeRegistryList();
        const response = await fetch('/api/flashforge/printers/discover', { method: 'POST' });
        const data = await response.json();
        renderFlashforgeDiscoverList(data.devices || []);
    } catch (error) {
        console.error(error);
        renderFlashforgeDiscoverList([]);
    }
}

function renderFlashforgeDiscoverList(devices) {
    const container = document.getElementById('flashforge-discover-list');
    if (!container) return;
    const registeredIds = new Set(flashforgePrintersRegistryCache.map(printer => printer.id));
    const pending = devices.filter(device => !registeredIds.has(device.serial_number));
    if (!pending.length) {
        container.innerHTML = `<div class="empty-state-small">${t('flashforgeDiscoverEmpty')}</div>`;
        return;
    }
    container.innerHTML = pending.map(device => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(device.name || device.serial_number)}</strong>
                <span>${escapeHtml(device.ip)}${device.model ? ' · ' + escapeHtml(device.model) : ''}</span>
            </div>
            <button type="button" class="btn-file-action flashforge-discover-add-btn"
                data-ip="${escapeHtml(device.ip)}"
                data-serial-number="${escapeHtml(device.serial_number)}"
                data-name="${escapeHtml(device.name || '')}"
                data-model="${escapeHtml(device.model || '')}">${escapeHtml(t('usbPortAdd'))}</button>
        </div>
    `).join('');

    container.querySelectorAll('.flashforge-discover-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openFlashforgeRegisterModal({
                ip: btn.dataset.ip,
                serial_number: btn.dataset.serialNumber,
                name: btn.dataset.name,
                model: btn.dataset.model,
            });
        });
    });
}

document.getElementById('flashforge-printers-discover-btn')?.addEventListener('click', discoverFlashforgePrinters);

let flashforgeRegisterTarget = null;

function openFlashforgeRegisterModal(device) {
    flashforgeRegisterTarget = device;
    const label = document.getElementById('flashforge-printer-register-device-label');
    if (label) label.textContent = [device.model, device.ip].filter(Boolean).join(' · ');
    const nameInput = document.getElementById('flashforge-printer-register-name');
    if (nameInput) nameInput.value = device.name || device.model || 'FlashForge';
    const checkCodeInput = document.getElementById('flashforge-printer-register-check-code');
    if (checkCodeInput) checkCodeInput.value = '';
    document.getElementById('flashforge-printer-register-modal')?.classList.add('active');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
}

function closeFlashforgeRegisterModal() {
    document.getElementById('flashforge-printer-register-modal')?.classList.remove('active');
    flashforgeRegisterTarget = null;
}

document.getElementById('flashforge-printer-register-close')?.addEventListener('click', closeFlashforgeRegisterModal);
document.getElementById('flashforge-printer-register-backdrop')?.addEventListener('click', closeFlashforgeRegisterModal);
document.getElementById('flashforge-printer-register-cancel-btn')?.addEventListener('click', closeFlashforgeRegisterModal);

document.getElementById('flashforge-printer-register-confirm-btn')?.addEventListener('click', async () => {
    const device = flashforgeRegisterTarget;
    const nameInput = document.getElementById('flashforge-printer-register-name');
    const checkCodeInput = document.getElementById('flashforge-printer-register-check-code');
    const name = nameInput ? nameInput.value.trim() : '';
    const checkCode = checkCodeInput ? checkCodeInput.value.trim() : '';
    if (!device || !name || !checkCode) return;
    closeFlashforgeRegisterModal();
    try {
        const formData = new FormData();
        formData.append('ip', device.ip);
        formData.append('serial_number', device.serial_number);
        formData.append('check_code', checkCode);
        formData.append('name', name);
        const response = await fetch('/api/flashforge/printers', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            // A diferencia de Elegoo, acá un 400 casi siempre es "check code
            // incorrecto" -- se muestra tal cual el detail del backend en
            // vez de un mensaje genérico (ver flashforge_register_endpoint).
            throw new Error(data.detail || t('flashforgeActionFailed'));
        }
        showToast(`${name}: ${t('flashforgePrinterRegisterSuccess')}`);
    } catch (error) {
        console.error(error);
        showToast(error.message || t('flashforgeActionFailed'), 'error');
    } finally {
        loadFlashforgeRegistryList();
        refreshFlashforgePrintersGrid();
    }
});

// ── Impresoras Bambu Lab standalone (X1C/X1/X1E/P1P/P1S/A1/A1 mini, modo LAN
// local vía MQTT+FTPS) ── Mismo patrón que Elegoo/FlashForge (sección
// dedicada, tarjetas propias, alta por escaneo de red en Configuración) — el
// shape de datos, la tarjeta y pausar/reanudar/cancelar son idénticos, así
// que se reusan a propósito las clases CSS .elegoo-card-actions/
// .elegoo-card-action-btn en vez de duplicarlas. Dos diferencias reales frente
// a FlashForge: 1) el modelo no se puede detectar por protocolo (el SSDP de
// Bambu casi nunca lo reporta), así que el alta pide un <select> además del
// nombre y el access code; 2) el registro hace un handshake MQTT real contra
// la impresora que puede tardar hasta 5s, así que el modal de alta se queda
// abierto con el botón de confirmar deshabilitado mientras espera, en vez de
// cerrarse optimistamente como el de FlashForge.

let bambuPrintersRegistryCache = [];

function getBambuVisualState(printer) {
    if (!printer || !printer.online) return 'offline';
    // job.state documentado: idle | printing | paused | preparing | error |
    // unknown (ver _JOB_STATE_MAP en bambu_service.py). "preparing"
    // (nivelación de cama/calibración antes de imprimir), "error" y "unknown"
    // caen en "idle": son estados de transición sin color/animación propia,
    // mismo criterio que getFlashforgeVisualState con "busy"/"error"/"unknown".
    const state = (printer.job && printer.job.state) || 'idle';
    if (state === 'printing') return 'printing';
    if (state === 'paused') return 'paused';
    return 'idle';
}

function bambuPrinterCardHtml(printer) {
    const visualState = getBambuVisualState(printer);
    const isOnline = visualState !== 'offline';
    const statusText = isOnline ? t('online') : t('offline');
    const stateLabel = isOnline ? t(visualState) : t('offline');
    const name = printer.name || printer.model || printer.id;
    const subLabel = [printer.model, printer.ip].filter(Boolean).join(' · ');
    // PRINTER_STATE_IMAGES no tiene entrada "offline" (ver printerIllustrationImg)
    // — se pisa por "idle" solo para elegir la imagen, el resto de la tarjeta
    // sigue mostrando el estado real sin conexión.
    const illustrationState = visualState === 'offline' ? 'idle' : visualState;

    const temps = printer.temps || {};
    const extruder = temps.extruder || {};
    const bed = temps.heater_bed || {};
    const extruderTemp = typeof extruder.current === 'number' ? Math.round(extruder.current * 10) / 10 : null;
    const bedTemp = typeof bed.current === 'number' ? Math.round(bed.current * 10) / 10 : null;
    const extruderTarget = typeof extruder.target === 'number' ? extruder.target : 0;
    const bedTarget = typeof bed.target === 'number' ? bed.target : 0;

    const job = printer.job || {};
    const progress = typeof job.progress === 'number' ? job.progress : 0;
    const layersLabel = (job.current_layer != null && job.total_layer != null)
        ? `${job.current_layer} / ${job.total_layer}`
        : '—';

    const showActions = visualState === 'printing' || visualState === 'paused';
    const isPaused = visualState === 'paused';
    const heatProgress = visualState === 'heating' ? computeHeatProgress(bedTemp, bedTarget, extruderTemp, extruderTarget) : null;

    return `
        <div class="printer-card printer-card-type-3d ${isOnline ? 'online' : 'offline'} ${visualState}" data-bambu-id="${escapeHtml(printer.id)}" data-heat-progress="${heatProgress ?? ''}">
            ${printerThermalWaves(bedTemp, extruderTemp, bedTarget, extruderTarget, visualState, !isOnline, printer.id)}
            <div class="printer-card-top">
                <div>
                    <h3 class="printer-name">${escapeHtml(name)}</h3>
                    <p class="printer-name-sub">${subLabel ? escapeHtml(subLabel) : 'Bambu Lab'}</p>
                </div>
                <div class="printer-status-icon ${isOnline ? 'online' : 'offline'}" title="${statusText}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                </div>
            </div>

            <div class="printer-status-line ${visualState}">
                <span class="printer-status-dot ${visualState}"></span>${stateLabel}
            </div>

            <div class="printer-illustration printer-illustration-${illustrationState}">
                ${printerIllustrationImg(illustrationState)}
            </div>

            ${isOnline ? `
                <div class="printer-temps">
                    <div class="temp-item">
                        <div class="temp-label">${t('bedTemp')}</div>
                        <div class="temp-value">${bedTemp != null ? bedTemp : '--'}<span class="temp-unit">°C</span></div>
                    </div>
                    <div class="temp-item">
                        <div class="temp-label">${t('extruderTemp')}</div>
                        <div class="temp-value">${extruderTemp != null ? extruderTemp : '--'}<span class="temp-unit">°C</span></div>
                    </div>
                </div>
            ` : ''}

            ${showActions ? `
                <div class="printer-progress">
                    <div class="printer-progress-labels">
                        <span>${progress}% ${t('printed')}</span>
                        <span>${t('activePrintLayers')}: ${layersLabel}</span>
                    </div>
                    <div class="temp-progress"><div class="temp-progress-fill" style="width: ${progress}%"></div></div>
                </div>
                <div class="elegoo-card-actions">
                    <button type="button" class="elegoo-card-action-btn elegoo-card-action-pause" data-action="${isPaused ? 'resume' : 'pause'}" data-bambu-id="${escapeHtml(printer.id)}">
                        ${isPaused
                            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
                            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
                        <span>${isPaused ? t('activePrintResume') : t('activePrintPause')}</span>
                    </button>
                    <button type="button" class="elegoo-card-action-btn elegoo-card-action-cancel" data-action="cancel" data-bambu-id="${escapeHtml(printer.id)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        <span>${t('activePrintCancel')}</span>
                    </button>
                </div>
            ` : ''}
            ${printerDiagToggleHtml('bambu', printer.id)}
            <div class="printer-card-camera" data-cam-container="bambu:${escapeHtml(printer.id)}"></div>
        </div>
    `;
}

async function handleBambuPrinterAction(action, printerId) {
    if (!printerId || !action) return;
    if (action === 'cancel') {
        const confirmed = await appConfirm(t('activePrintCancelConfirm'), t('activePrintStop'), 'danger');
        if (!confirmed) return;
    }
    try {
        const response = await fetch(`/api/bambu/printers/${encodeURIComponent(printerId)}/${action}`, { method: 'POST' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || t('bambuActionFailed'));
        }
    } catch (error) {
        console.error(error);
        showToast(error.message || t('bambuActionFailed'), 'error');
    } finally {
        refreshBambuPrintersGrid();
    }
}

let bambuGridPollInterval = null;

async function refreshBambuPrintersGrid() {
    const grid = document.getElementById('bambu-printers-grid');
    if (!grid) return;
    try {
        const response = await fetch('/api/bambu/printers');
        const data = await response.json();
        const printers = data.printers || [];
        bambuPrintersRegistryCache = printers;
        if (!printers.length) {
            grid.innerHTML = `<div class="empty-state">${t('bambuPrinterNoPrinters')}</div>`;
            return;
        }
        grid.innerHTML = printers.map(bambuPrinterCardHtml).join('');
        grid.querySelectorAll('.elegoo-card-action-btn').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                handleBambuPrinterAction(btn.dataset.action, btn.dataset.bambuId);
            });
        });
        mountCameraCardsIn(grid);
    } catch (error) {
        console.error(error);
    }
}

async function loadBambuSection() {
    refreshBambuPrintersGrid();
    stopBambuPrintersPolling();
    bambuGridPollInterval = setInterval(refreshBambuPrintersGrid, 3000);
}

function stopBambuPrintersPolling() {
    if (bambuGridPollInterval) { clearInterval(bambuGridPollInterval); bambuGridPollInterval = null; }
}

document.getElementById('bambu-printers-refresh-btn')?.addEventListener('click', refreshBambuPrintersGrid);

// Admin: abre el asistente guiado nuevo pre-seleccionando Bambu Lab (salta
// el paso 1). Operador: mismo fallback que el botón equivalente de Elegoo.
document.getElementById('bambu-printers-add-btn')?.addEventListener('click', () => {
    if (currentAuthUser?.role === 'admin' && typeof openGuidedPrinterSetup === 'function') {
        openGuidedPrinterSetup('bambu');
        return;
    }
    switchSection('settings');
    showToast(t('bambuPrinterAddGoSettingsHint'));
    setTimeout(() => {
        document.getElementById('bambu-discover-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
});

// ── Alta de impresoras Bambu Lab en Configuración (escaneo SSDP + registro) ──

async function loadBambuRegistryList() {
    const container = document.getElementById('bambu-printers-registry-list');
    if (!container) return;
    try {
        const response = await fetch('/api/bambu/printers');
        const data = await response.json();
        bambuPrintersRegistryCache = data.printers || [];
        renderBambuRegistryList(bambuPrintersRegistryCache);
    } catch (error) {
        console.error(error);
    }
}

function renderBambuRegistryList(printers) {
    const container = document.getElementById('bambu-printers-registry-list');
    if (!container) return;
    if (!printers.length) {
        container.innerHTML = `<div class="empty-state-small">${t('bambuPrinterNoPrinters')}</div>`;
        return;
    }
    container.innerHTML = printers.map(printer => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(printer.name || printer.model || printer.id)}</strong>
                <span>${escapeHtml(printer.ip || '')}${printer.model ? ' · ' + escapeHtml(printer.model) : ''}</span>
            </div>
            <span class="device-status-pill ${printer.online ? 'online' : 'offline'}">${printer.online ? t('online') : t('offline')}</span>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger bambu-printer-remove-btn" data-id="${escapeHtml(printer.id)}" title="${escapeHtml(t('usbPortUnlink'))}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.bambu-printer-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!(await appConfirm(t('bambuPrinterRemoveConfirm'), t('usbPortUnlink'), 'danger'))) return;
            try {
                const response = await fetch(`/api/bambu/printers/${encodeURIComponent(id)}`, { method: 'DELETE' });
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.detail || t('bambuActionFailed'));
                }
            } catch (error) {
                console.error(error);
                showToast(error.message || t('bambuActionFailed'), 'error');
            } finally {
                loadBambuRegistryList();
                refreshBambuPrintersGrid();
            }
        });
    });
}

// El escaneo (multicast SSDP pasivo) solo se dispara a mano — igual que
// discoverFlashforgePrinters(), no tiene sentido barrer la red cada vez que
// se entra a Configuración. A diferencia de Elegoo/FlashForge (probe activo
// con respuesta inmediata), acá solo se escucha un NOTIFY periódico que la
// impresora emite sola, así que puede no encontrar nada si el escaneo cae
// entre dos anuncios — el usuario puede reintentar apretando de nuevo.
async function discoverBambuPrinters() {
    const container = document.getElementById('bambu-discover-list');
    if (!container) return;
    container.innerHTML = `<div class="empty-state-small">${t('laserWifiScanning')}</div>`;
    try {
        await loadBambuRegistryList();
        const response = await fetch('/api/bambu/printers/discover', { method: 'POST' });
        const data = await response.json();
        renderBambuDiscoverList(data.devices || []);
    } catch (error) {
        console.error(error);
        renderBambuDiscoverList([]);
    }
}

function renderBambuDiscoverList(devices) {
    const container = document.getElementById('bambu-discover-list');
    if (!container) return;
    const registeredIds = new Set(bambuPrintersRegistryCache.map(printer => printer.id));
    const pending = devices.filter(device => !registeredIds.has(device.serial));
    if (!pending.length) {
        container.innerHTML = `<div class="empty-state-small">${t('bambuDiscoverEmpty')}</div>`;
        return;
    }
    container.innerHTML = pending.map(device => `
        <div class="usb-port-item">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(device.name || device.serial)}</strong>
                <span>${escapeHtml(device.ip)}${device.model ? ' · ' + escapeHtml(device.model) : ''}</span>
            </div>
            <button type="button" class="btn-file-action bambu-discover-add-btn"
                data-ip="${escapeHtml(device.ip)}"
                data-serial="${escapeHtml(device.serial)}"
                data-name="${escapeHtml(device.name || '')}"
                data-model="${escapeHtml(device.model || '')}">${escapeHtml(t('usbPortAdd'))}</button>
        </div>
    `).join('');

    container.querySelectorAll('.bambu-discover-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            openBambuRegisterModal({
                ip: btn.dataset.ip,
                serial: btn.dataset.serial,
                name: btn.dataset.name,
                model: btn.dataset.model,
            });
        });
    });
}

document.getElementById('bambu-printers-discover-btn')?.addEventListener('click', discoverBambuPrinters);

let bambuRegisterTarget = null;

function openBambuRegisterModal(device) {
    bambuRegisterTarget = device;
    const label = document.getElementById('bambu-printer-register-device-label');
    if (label) label.textContent = [device.model, device.ip].filter(Boolean).join(' · ');
    const nameInput = document.getElementById('bambu-printer-register-name');
    if (nameInput) nameInput.value = device.name || device.model || 'Bambu Lab';
    const accessCodeInput = document.getElementById('bambu-printer-register-access-code');
    if (accessCodeInput) accessCodeInput.value = '';
    const modelSelect = document.getElementById('bambu-printer-register-model');
    if (modelSelect) {
        // El SSDP de Bambu casi nunca reporta el modelo (ver scan_network en
        // bambu_service.py) -- si no coincide con ninguna opción del select
        // se deja la primera por defecto y el usuario lo elige a mano.
        const hasMatch = device.model && Array.from(modelSelect.options).some(opt => opt.value === device.model);
        modelSelect.value = hasMatch ? device.model : modelSelect.options[0].value;
    }
    document.getElementById('bambu-printer-register-modal')?.classList.add('active');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
}

function closeBambuRegisterModal() {
    document.getElementById('bambu-printer-register-modal')?.classList.remove('active');
    bambuRegisterTarget = null;
}

document.getElementById('bambu-printer-register-close')?.addEventListener('click', closeBambuRegisterModal);
document.getElementById('bambu-printer-register-backdrop')?.addEventListener('click', closeBambuRegisterModal);
document.getElementById('bambu-printer-register-cancel-btn')?.addEventListener('click', closeBambuRegisterModal);

document.getElementById('bambu-printer-register-confirm-btn')?.addEventListener('click', async () => {
    const device = bambuRegisterTarget;
    const nameInput = document.getElementById('bambu-printer-register-name');
    const accessCodeInput = document.getElementById('bambu-printer-register-access-code');
    const modelSelect = document.getElementById('bambu-printer-register-model');
    const name = nameInput ? nameInput.value.trim() : '';
    const accessCode = accessCodeInput ? accessCodeInput.value.trim() : '';
    const model = modelSelect ? modelSelect.value : '';
    if (!device || !name || !accessCode) return;

    const confirmBtn = document.getElementById('bambu-printer-register-confirm-btn');
    const confirmLabel = confirmBtn?.querySelector('span');
    const originalLabel = confirmLabel ? confirmLabel.textContent : '';
    // El registro hace un handshake MQTT real contra la impresora (hasta 5s,
    // ver register_printer() en bambu_service.py) -- se deshabilita el botón
    // y se muestra un estado de carga en vez de cerrar el modal
    // optimistamente, mismo criterio que addCameraOnvif() en
    // camera-viewer.js. El modal solo se cierra si el registro confirma OK,
    // así el usuario puede corregir el access code sin tener que reabrirlo.
    if (confirmBtn) confirmBtn.disabled = true;
    if (confirmLabel) confirmLabel.textContent = t('bambuPrinterConnecting');
    try {
        const formData = new FormData();
        formData.append('ip', device.ip);
        formData.append('serial', device.serial);
        formData.append('access_code', accessCode);
        formData.append('name', name);
        formData.append('model', model);
        const response = await fetch('/api/bambu/printers', { method: 'POST', body: formData });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            // Un 400 acá casi siempre es "access code incorrecto" -- se
            // muestra tal cual el detail del backend en vez de un mensaje
            // genérico (ver bambu_register_endpoint).
            throw new Error(data.detail || t('bambuActionFailed'));
        }
        closeBambuRegisterModal();
        showToast(`${name}: ${t('bambuPrinterRegisterSuccess')}`);
    } catch (error) {
        console.error(error);
        showToast(error.message || t('bambuActionFailed'), 'error');
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
        if (confirmLabel) confirmLabel.textContent = originalLabel;
        loadBambuRegistryList();
        refreshBambuPrintersGrid();
    }
});

// ── Diagnóstico de conexión (Bambu Lab/Elegoo/FlashForge) ── Botón "Probar
// conexión" + panel colapsable en cada tarjeta ya registrada, agregado junto
// con el asistente guiado (ver guided-printer-setup.js) pero compartido por
// las 3 marcas porque las 3 exponen el mismo endpoint de solo lectura
// (POST /api/{brand}/printers/{id}/test-connection, no admin). El estado de
// "abierto/cerrado" vive en un objeto module-level en vez de en el DOM
// porque refreshElegooPrintersGrid()/refreshFlashforgePrintersGrid()/
// refreshBambuPrintersGrid() reconstruyen el grid entero cada ~3s (polling)
// -- sin esto, cualquier panel abierto se cerraría solo en el próximo poll.
const printerDiagState = {};

function printerDiagKey(brand, id) {
    return `${brand}:${id}`;
}

function printerDiagPanelHtml(brand, id) {
    const state = printerDiagState[printerDiagKey(brand, id)];
    if (!state || !state.open) return '';
    if (state.status === 'checking') {
        return `<div class="printer-diag-panel"><div class="printer-diag-panel-status checking"><span class="gps-spinner"></span> ${escapeHtml(t('printerDiagTesting'))}</div></div>`;
    }
    const data = state.data || {};
    const rows = [];
    if (data.latency_ms != null) rows.push([t('printerDiagLatency'), `${data.latency_ms} ms`]);
    if (brand === 'bambu') {
        rows.push([t('printerDiagMqttListener'), data.mqtt_listener_connected ? t('printerDiagConnected') : t('printerDiagDisconnected')]);
        if (data.last_communication_at) rows.push([t('printerDiagLastComm'), String(data.last_communication_at)]);
    }
    if (brand === 'elegoo') {
        rows.push([t('printerDiagConfirmedId'), data.confirmed_id ? t('printerDiagYes') : t('printerDiagNo')]);
        rows.push([t('printerDiagListener'), data.listener_connected ? t('printerDiagConnected') : t('printerDiagDisconnected')]);
    }
    const dl = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
    return `
        <div class="printer-diag-panel">
            <div class="printer-diag-panel-status ${state.status === 'ok' ? 'ok' : 'fail'}">
                ${state.status === 'ok'
                    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> ${escapeHtml(t('printerDiagSuccess'))}`
                    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ${escapeHtml(t('printerDiagFailed'))}`}
            </div>
            ${data.error ? `<div>${escapeHtml(data.error)}</div>` : ''}
            ${rows.length ? `<dl class="printer-diag-panel-grid">${dl}</dl>` : ''}
        </div>`;
}

function printerDiagToggleHtml(brand, id) {
    return `
        <button type="button" class="printer-diag-toggle-btn" data-diag-brand="${brand}" data-diag-id="${escapeHtml(id)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span>${escapeHtml(t('printerDiagTestConnection'))}</span>
        </button>
        ${printerDiagPanelHtml(brand, id)}`;
}

function refreshPrinterGridForBrand(brand) {
    if (brand === 'elegoo') refreshElegooPrintersGrid();
    if (brand === 'flashforge') refreshFlashforgePrintersGrid();
    if (brand === 'bambu') refreshBambuPrintersGrid();
}

async function testPrinterConnection(brand, printerId) {
    const key = printerDiagKey(brand, printerId);
    printerDiagState[key] = { open: true, status: 'checking', data: null };
    refreshPrinterGridForBrand(brand);
    try {
        const response = await fetch(`/api/${brand}/printers/${encodeURIComponent(printerId)}/test-connection`, { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        printerDiagState[key] = { open: true, status: data.success ? 'ok' : 'fail', data };
    } catch (error) {
        console.error(error);
        printerDiagState[key] = { open: true, status: 'fail', data: { error: error.message || String(error) } };
    }
    refreshPrinterGridForBrand(brand);
}

document.addEventListener('click', event => {
    const btn = event.target.closest('.printer-diag-toggle-btn');
    if (!btn) return;
    event.stopPropagation();
    const brand = btn.dataset.diagBrand;
    const id = btn.dataset.diagId;
    const key = printerDiagKey(brand, id);
    if (printerDiagState[key]?.open) {
        delete printerDiagState[key];
        refreshPrinterGridForBrand(brand);
        return;
    }
    testPrinterConnection(brand, id);
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
    const cameraContainer = document.getElementById('marlin-printer-modal-camera');
    if (cameraContainer) window.NopalCameraCard?.unmount(cameraContainer);
}

document.getElementById('marlin-printer-modal-close')?.addEventListener('click', closeMarlinPrinterModal);
document.getElementById('marlin-printer-modal-backdrop')?.addEventListener('click', closeMarlinPrinterModal);

async function openMarlinPrinterModal(device) {
    marlinModalDevice = device;
    const entry = marlinPrintersRegistryCache.find(p => p.device === device);
    const nameEl = document.getElementById('marlin-printer-modal-name');
    if (nameEl) nameEl.textContent = (entry && entry.name) || device;
    document.getElementById('marlin-printer-modal')?.classList.add('active');

    const cameraContainer = document.getElementById('marlin-printer-modal-camera');
    if (cameraContainer) window.NopalCameraCard?.mount(cameraContainer, { deviceType: 'marlin', deviceId: device });

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
                <div class="temp-card-header-actions">
                    <button type="button" class="temp-cool-pill" id="marlin-temp-cool-btn">${t('tempCool')}</button>
                    <button type="button" class="temp-preset-pill" id="marlin-temp-preset-btn">${t('tempPreset')}</button>
                    <button type="button" class="temp-icon-btn" id="marlin-temp-config-btn" title="Configurar materiales">⚙</button>
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
    const heaterKeys = sensors.map(sensor => sensor.key);
    document.getElementById('marlin-temp-cool-btn')?.addEventListener('click', async () => {
        try { await Promise.all(heaterKeys.map(heater => setMarlinHeaterTarget(device, heater, 0))); refreshMarlinModalTemperatures(); }
        catch (error) { showToast(error.message, 'error'); }
    });
    document.getElementById('marlin-temp-preset-btn')?.addEventListener('click', () => {
        const printer = marlinPrintersRegistryCache.find(item => item.device === device) || {};
        openMaterialPreheatModal({ type: 'marlin', id: device, name: printer.name || 'Marlin', heaters: heaterKeys });
    });
    document.getElementById('marlin-temp-config-btn')?.addEventListener('click', () => openTempPresetsModal(sensors));
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
    let localFiles = [];
    let sdFiles = [];
    const [localResult, sdResult] = await Promise.allSettled([
        fetch('/api/browse?path=&type=gcode').then(async response => {
            if (!response.ok) throw new Error('No se pudo leer la biblioteca local.');
            return response.json();
        }),
        fetch(`/api/marlin-printers/sd/files?device=${encodeURIComponent(device)}`).then(async response => {
            if (!response.ok) throw new Error('No se pudo leer la tarjeta SD.');
            return response.json();
        }),
    ]);
    if (localResult.status === 'fulfilled') localFiles = localResult.value.files || [];
    else console.error(localResult.reason);
    if (sdResult.status === 'fulfilled') sdFiles = sdResult.value.files || [];
    else console.error(sdResult.reason);

    const localOptions = localFiles.map(file => `
        <option data-source="local" value="${escapeHtml(stripSectionPrefix(file.id, 'gcode'))}">${escapeHtml(file.name)}</option>
    `).join('');
    const sdOptions = sdFiles.map(file => `
        <option data-source="sd" value="${escapeHtml(file.name)}">${escapeHtml(file.name)} · ${escapeHtml(formatSize(file.size))}</option>
    `).join('');
    const options = localOptions || sdOptions
        ? `${localOptions ? `<optgroup label="${escapeHtml(t('helpCatLibraryTitle'))} · NOPAL">${localOptions}</optgroup>` : ''}
           ${sdOptions ? `<optgroup label="${escapeHtml(t('laserSdTitle'))} · Marlin">${sdOptions}</optgroup>` : ''}`
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
        const selectedOption = select?.selectedOptions?.[0];
        const selectedValue = selectedOption?.value;
        const source = selectedOption?.dataset.source || 'local';
        if (!selectedValue) return;
        try {
            const formData = new FormData();
            formData.append('device', device);
            let endpoint;
            if (source === 'sd') {
                formData.append('filename', selectedValue);
                endpoint = '/api/marlin-printers/sd/print/start';
            } else {
                formData.append('path', selectedValue);
                endpoint = '/api/marlin-printers/print/start';
            }
            const response = await fetch(endpoint, { method: 'POST', body: formData });
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

// ── Onboarding tour (spotlight guiado) ──
// Un paso por elemento destacado, con contador y botones Siguiente/Anterior/Omitir.
// Data-driven: una entrada por sección, cada una con un array de pasos
// { selector, titleKey, bodyKey }. Se dispara solo una vez por sección
// (localStorage `tourSeen_{section}`) y se puede desactivar globalmente
// desde Ajustes (`onboardingHintsEnabled`) o repetir desde Ayuda.
const TOUR_STEPS = {
    dashboard: [
        { selector: '.stats-grid', titleKey: 'tourDashboard1Title', bodyKey: 'tourDashboard1Body' },
        { selector: '#machines-columns', titleKey: 'tourDashboard2Title', bodyKey: 'tourDashboard2Body' },
        { selector: '.accessories-section', titleKey: 'tourDashboard3Title', bodyKey: 'tourDashboard3Body' },
        { selector: '.dashboard-bottom', titleKey: 'tourDashboard4Title', bodyKey: 'tourDashboard4Body' },
    ],
    models: [
        { selector: '#models-section .section-search', titleKey: 'tourModels1Title', bodyKey: 'tourModels1Body' },
        { selector: '#models-section .upload-wrapper', titleKey: 'tourModels2Title', bodyKey: 'tourModels2Body' },
        { selector: '#models-full', titleKey: 'tourModels3Title', bodyKey: 'tourModels3Body' },
        { selector: '.models-preview-card', titleKey: 'tourModels4Title', bodyKey: 'tourModels4Body' },
    ],
    gcode: [
        { selector: '#gcode-section .upload-wrapper', titleKey: 'tourGcode1Title', bodyKey: 'tourGcode1Body' },
        { selector: '#gcode-table', titleKey: 'tourGcode2Title', bodyKey: 'tourGcode2Body' },
        { selector: '#gcode-preview', titleKey: 'tourGcode3Title', bodyKey: 'tourGcode3Body' },
        { selector: '#gcode-send-laser-btn', titleKey: 'tourGcode4Title', bodyKey: 'tourGcode4Body' },
    ],
    console: [
        { selector: '#console-printer-picker', titleKey: 'tourConsole1Title', bodyKey: 'tourConsole1Body' },
        { selector: '#console-log', titleKey: 'tourConsole2Title', bodyKey: 'tourConsole2Body' },
        { selector: '#console-input-form', titleKey: 'tourConsole3Title', bodyKey: 'tourConsole3Body' },
        { selector: '#macros-grid', titleKey: 'tourConsole4Title', bodyKey: 'tourConsole4Body' },
    ],
    laser: [
        { selector: '#laser-connection-card', titleKey: 'tourLaser1Title', bodyKey: 'tourLaser1Body' },
        { selector: '#laser-queue-card', titleKey: 'tourLaser2Title', bodyKey: 'tourLaser2Body' },
        { selector: '.toolhead-card', titleKey: 'tourLaser3Title', bodyKey: 'tourLaser3Body' },
        { selector: '#laser-console-card', titleKey: 'tourLaser4Title', bodyKey: 'tourLaser4Body' },
    ],
    cnc: [
        { selector: '#cnc-status-card', titleKey: 'tourCnc1Title', bodyKey: 'tourCnc1Body' },
        { selector: '#cnc-job-card', titleKey: 'tourCnc2Title', bodyKey: 'tourCnc2Body' },
        { selector: '#cnc-jog-card', titleKey: 'tourCnc3Title', bodyKey: 'tourCnc3Body' },
        { selector: '#cnc-viewer-card', titleKey: 'tourCnc4Title', bodyKey: 'tourCnc4Body' },
        { selector: '#cnc-files-card', titleKey: 'tourCnc5Title', bodyKey: 'tourCnc5Body' },
    ],
    marlin: [
        { selector: '#marlin-section .page-header', titleKey: 'tourMarlin1Title', bodyKey: 'tourMarlin1Body' },
        { selector: '#marlin-printers-add-btn', titleKey: 'tourMarlin2Title', bodyKey: 'tourMarlin2Body' },
        { selector: '#marlin-printers-grid', titleKey: 'tourMarlin3Title', bodyKey: 'tourMarlin3Body' },
    ],
    queue: [
        { selector: '#search-recent', titleKey: 'tourQueue1Title', bodyKey: 'tourQueue1Body' },
        { selector: '#models', titleKey: 'tourQueue2Title', bodyKey: 'tourQueue2Body' },
        { selector: '#laser-history-list', titleKey: 'tourQueue3Title', bodyKey: 'tourQueue3Body' },
    ],
    pricing: [
        { selector: '#pricing-new-quote-btn', titleKey: 'tourPricing1Title', bodyKey: 'tourPricing1Body' },
        { selector: '#pricing-steps-breadcrumb', titleKey: 'tourPricing2Title', bodyKey: 'tourPricing2Body' },
        { selector: '.pricing-col-file', titleKey: 'tourPricing3Title', bodyKey: 'tourPricing3Body' },
        { selector: '#pricing-job-type-switch', titleKey: 'tourPricing4Title', bodyKey: 'tourPricing4Body' },
        { selector: '.pricing-col-summary', titleKey: 'tourPricing5Title', bodyKey: 'tourPricing5Body' },
    ],
    settings: [
        { selector: '.settings-general-card', titleKey: 'tourSettings1Title', bodyKey: 'tourSettings1Body' },
        { selector: '.theme-config-card', titleKey: 'tourSettings2Title', bodyKey: 'tourSettings2Body' },
        { selector: '.usb-ports-settings-card', titleKey: 'tourSettings3Title', bodyKey: 'tourSettings3Body' },
        { selector: '#settings-save-btn', titleKey: 'tourSettings4Title', bodyKey: 'tourSettings4Body' },
    ],
};

let tourState = null; // { sectionName, steps, index }
let tourResizeHandler = null;
let tourTypewriterTimer = null;

// Efecto "máquina de escribir" para la descripción de cada paso — revela
// `text` en `el` caracter por caracter en vez de de una sola vez.
function typewriteTourText(el, text, onDone, speed = 32) {
    if (tourTypewriterTimer) {
        clearInterval(tourTypewriterTimer);
        tourTypewriterTimer = null;
    }
    el.textContent = '';
    let i = 0;
    tourTypewriterTimer = setInterval(() => {
        i += 1;
        el.textContent = text.slice(0, i);
        if (i >= text.length) {
            clearInterval(tourTypewriterTimer);
            tourTypewriterTimer = null;
            if (onDone) onDone();
        }
    }, speed);
}

function removeTourOverlay() {
    document.getElementById('tour-overlay')?.remove();
    if (tourResizeHandler) {
        window.removeEventListener('resize', tourResizeHandler);
        tourResizeHandler = null;
    }
    if (tourTypewriterTimer) {
        clearInterval(tourTypewriterTimer);
        tourTypewriterTimer = null;
    }
}

function endTour() {
    if (tourState) {
        localStorage.setItem(`tourSeen_${tourState.sectionName}`, 'true');
    }
    tourState = null;
    removeTourOverlay();
}

// Un paso con selector cuyo elemento no existe, está oculto (atributo
// `hidden`/`display:none`) o no ocupa espacio en el layout (p.ej. la
// sección de accesorios cuando no hay ninguno cargado) no es un paso
// válido para el tour — hay que saltarlo en vez de dibujar un spotlight
// roto sobre un elemento invisible.
function isTourStepValid(step) {
    if (!step || !step.selector) return true;
    const el = document.querySelector(step.selector);
    return !!(el && el.offsetParent !== null);
}

// Busca, a partir de startIndex y avanzando en `direction` (1 o -1), el
// próximo índice de paso válido. Devuelve -1/steps.length si no hay ninguno.
function findValidTourIndex(steps, startIndex, direction) {
    let idx = startIndex;
    while (idx >= 0 && idx < steps.length && !isTourStepValid(steps[idx])) {
        idx += direction;
    }
    return idx;
}

function tourNext() {
    if (!tourState) return;
    const idx = findValidTourIndex(tourState.steps, tourState.index + 1, 1);
    if (idx < 0 || idx >= tourState.steps.length) {
        endTour();
        return;
    }
    tourState.index = idx;
    renderTourStep();
}

function tourPrev() {
    if (!tourState || tourState.index === 0) return;
    const idx = findValidTourIndex(tourState.steps, tourState.index - 1, -1);
    if (idx < 0) return;
    tourState.index = idx;
    renderTourStep();
}

function positionTourElements(spotlight, card, target) {
    if (!target) {
        spotlight.hidden = true;
        card.style.top = '50%';
        card.style.left = '50%';
        card.style.transform = 'translate(-50%, -50%)';
        card.style.visibility = 'visible';
        return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const pad = 8;
        spotlight.hidden = false;
        spotlight.style.top = `${Math.max(rect.top - pad, 0)}px`;
        spotlight.style.left = `${Math.max(rect.left - pad, 0)}px`;
        spotlight.style.width = `${rect.width + pad * 2}px`;
        spotlight.style.height = `${rect.height + pad * 2}px`;

        const cardWidth = card.offsetWidth || 320;
        const cardHeight = card.offsetHeight || 200;
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        let top;
        if (spaceBelow > cardHeight + 24) {
            top = rect.bottom + 16;
        } else if (spaceAbove > cardHeight + 24) {
            top = rect.top - cardHeight - 16;
        } else {
            top = Math.max(16, (window.innerHeight - cardHeight) / 2);
        }
        let left = Math.min(rect.left, window.innerWidth - cardWidth - 16);
        left = Math.max(left, 16);
        card.style.top = `${top}px`;
        card.style.left = `${left}px`;
        card.style.transform = 'none';
        card.style.visibility = 'visible';
    });
}

function renderTourStep() {
    if (!tourState) return;
    removeTourOverlay();

    const step = tourState.steps[tourState.index];
    const total = tourState.steps.length;
    const index = tourState.index;
    const target = step.selector ? document.querySelector(step.selector) : null;

    const overlay = document.createElement('div');
    overlay.id = 'tour-overlay';
    overlay.className = 'tour-overlay';

    const spotlight = document.createElement('div');
    spotlight.className = 'tour-spotlight';
    spotlight.hidden = true;
    overlay.appendChild(spotlight);

    const backdrop = document.createElement('div');
    backdrop.className = 'tour-backdrop';
    backdrop.hidden = !!target;
    overlay.appendChild(backdrop);

    const card = document.createElement('div');
    card.className = 'tour-card';
    card.style.visibility = 'hidden';
    card.innerHTML = `
        <div class="tour-card-counter">${index + 1} / ${total}</div>
        <h3 class="tour-card-title">${escapeHtml(t(step.titleKey))}</h3>
        <p class="tour-card-body" id="tour-card-body"></p>
        <div class="tour-card-actions">
            <button type="button" class="tour-btn tour-btn-skip" id="tour-skip-btn">${escapeHtml(t('tourSkip'))}</button>
            <div class="tour-card-nav">
                <button type="button" class="tour-btn tour-btn-secondary" id="tour-prev-btn"${index === 0 ? ' disabled' : ''}>${escapeHtml(t('tourPrev'))}</button>
                <button type="button" class="tour-btn tour-btn-primary" id="tour-next-btn">${escapeHtml(index === total - 1 ? t('tourFinish') : t('tourNext'))}</button>
            </div>
        </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    document.getElementById('tour-skip-btn').addEventListener('click', endTour);
    document.getElementById('tour-prev-btn').addEventListener('click', tourPrev);
    document.getElementById('tour-next-btn').addEventListener('click', tourNext);

    positionTourElements(spotlight, card, target);
    tourResizeHandler = () => positionTourElements(spotlight, card, target);
    window.addEventListener('resize', tourResizeHandler);

    // El card se posicionó recién arriba casi vacío (sin la descripción
    // todavía) — una vez que termina de escribirse, se reacomoda porque
    // puede haber crecido de alto.
    const bodyEl = document.getElementById('tour-card-body');
    typewriteTourText(bodyEl, t(step.bodyKey), () => positionTourElements(spotlight, card, target));
}

function startTour(sectionName) {
    const steps = TOUR_STEPS[sectionName];
    if (!steps || !steps.length) return;
    const startIndex = findValidTourIndex(steps, 0, 1);
    if (startIndex < 0 || startIndex >= steps.length) return;
    tourState = { sectionName, steps, index: startIndex };
    renderTourStep();
}

function maybeStartTour(sectionName) {
    if (!isOnboardingHintsEnabled()) return;
    if (!TOUR_STEPS[sectionName]) return;
    if (localStorage.getItem(`tourSeen_${sectionName}`) === 'true') return;
    // El chequeo de auth va DENTRO del timeout, no antes de programarlo:
    // checkAuth() es fire-and-forget (ver app.js:238) y todavía puede no
    // haber resuelto en el instante en que esta función corre durante la
    // carga inicial de la página — los 350ms de delay ya existentes suelen
    // alcanzar de sobra para que /api/auth/me responda.
    setTimeout(() => {
        if (!currentAuthUser || setupRequired) return;
        startTour(sectionName);
    }, 350);
}

document.addEventListener('keydown', (event) => {
    if (tourState && event.key === 'Escape') endTour();
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
            const category = item.closest('.nav-category');
            if (category?.classList.contains('collapsed')) {
                setCategoryCollapsed(category, false);
            }
        }
    });

    // El título/subtítulo y el estado/reloj del Panel de Control viven en la
    // topbar global (compartida por todas las secciones) pero solo tienen
    // sentido en el dashboard — se ocultan en el resto de las páginas.
    const isDashboard = sectionName === 'dashboard';
    const topbarTitle = document.getElementById('global-topbar-panel-title');
    const topbarMeta = document.getElementById('global-topbar-panel-meta');
    const topbarClock = document.getElementById('global-topbar-clock');
    if (topbarTitle) topbarTitle.hidden = !isDashboard;
    if (topbarMeta) topbarMeta.hidden = !isDashboard;
    if (topbarClock) topbarClock.hidden = !isDashboard;

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
    if (sectionName === 'ai') {
        loadAiSection();
    }
    if (sectionName === 'settings') {
        loadAiSettings();
        backupLoadGroups();
    }
    if (sectionName === 'laser') {
        stopCncPolling();
        window.NopalCameraCard?.unmount(document.getElementById('cnc-modal-camera'));
        loadLaserSection();
    } else if (sectionName === 'cnc') {
        stopLaserPolling();
        window.NopalCameraCard?.unmount(document.getElementById('laser-modal-camera'));
        loadCncSection();
    } else {
        stopLaserPolling();
        stopCncPolling();
        window.NopalCameraCard?.unmount(document.getElementById('laser-modal-camera'));
        window.NopalCameraCard?.unmount(document.getElementById('cnc-modal-camera'));
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
        loadTunascreenSettings();
        applySettingsModulesLayout();
        // Solo la lista de registradas (GET local, sin costo) — el escaneo
        // UDP de red queda para cuando el usuario aprieta "Actualizar", igual
        // que loadWifiDevices() para láser/CNC.
        loadElegooRegistryList();
        loadFlashforgeRegistryList();
        loadBambuRegistryList();
        loadMarlinPrintersSettingsCard();
    } else {
        stopSystemLogPolling();
    }
    if (sectionName === 'help') {
        renderHelpCenter();
    }
    if (sectionName === 'plugins') {
        loadPluginsGallery();
    }
    if (sectionName === 'marlin') {
        loadMarlinSection();
    } else {
        stopMarlinPrintersPolling();
    }
    if (sectionName === 'elegoo') {
        loadElegooSection();
    } else {
        stopElegooPrintersPolling();
    }
    if (sectionName === 'flashforge') {
        loadFlashforgeSection();
    } else {
        stopFlashforgePrintersPolling();
    }
    if (sectionName === 'bambu') {
        loadBambuSection();
    } else {
        stopBambuPrintersPolling();
    }
    maybeStartTour(sectionName);
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

// Delegado (no bind directo) -- #help-replay-tour-btn ahora lo inyecta
// renderHelpCenter() dinámicamente dentro de la tarjeta "Inicio", no existe
// en el HTML estático en el momento en que este script corre.
document.addEventListener('click', event => {
    if (!event.target.closest('#help-replay-tour-btn')) return;
    Object.keys(localStorage)
        .filter(key => key.startsWith('tourSeen_'))
        .forEach(key => localStorage.removeItem(key));
    switchSection('dashboard');
});

// Add click listeners to nav items
const navItems = document.querySelectorAll('.nav-item');
navItems.forEach(item => {
    item.addEventListener('click', () => {
        const section = item.dataset.section;
        switchSection(section);
        // En mobile, navegar a una sección cierra el cajón lateral (no-op
        // en escritorio, donde .mobile-nav-open nunca se activa).
        setMobileNavOpen(false);
    });
});

// ── Galería de plugins ──
const pluginsGrid = document.getElementById('plugins-grid');
const pluginsFeatured = document.getElementById('plugins-featured');
const pluginsEmpty = document.getElementById('plugins-empty');
const pluginsSearchInput = document.getElementById('plugins-search-input');
const pluginsCategoryFilters = document.getElementById('plugins-category-filters');
const pluginsInstalledCount = document.getElementById('plugins-installed-count');
let pluginsCatalog = [];
let pluginsCategories = [];
let pluginsActiveCategory = 'all';
let pluginsLoaded = false;
let pluginsFeaturedId = null;

window.NopalPluginRegistry = window.NopalPluginRegistry || {};

function versionedPluginAssetUrl(url, version) {
    if (!url) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}v=${encodeURIComponent(version || 'dev')}`;
}

function loadPluginAsset(plugin) {
    if (!plugin?.frontend?.script || window.NopalPluginRegistry[plugin.id]) return Promise.resolve();
    const styleId = `plugin-style-${plugin.id}`;
    if (plugin.frontend.style && !document.getElementById(styleId)) {
        const link = document.createElement('link');
        link.id = styleId;
        link.rel = 'stylesheet';
        link.href = versionedPluginAssetUrl(plugin.frontend.style, plugin.version);
        document.head.appendChild(link);
    }
    const scriptId = `plugin-script-${plugin.id}`;
    const existing = document.getElementById(scriptId);
    if (existing) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = scriptId;
        script.src = versionedPluginAssetUrl(plugin.frontend.script, plugin.version);
        script.defer = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`No se pudo cargar ${plugin.name}`));
        document.body.appendChild(script);
    });
}

async function loadInstalledPluginModules(catalog = null) {
    try {
        let list = catalog;
        if (!Array.isArray(list)) {
            const response = await fetch('/api/plugins');
            if (!response.ok) return;
            list = (await response.json()).plugins || [];
        }
        await Promise.all(list.filter(plugin => plugin.installed && plugin.enabled && plugin.frontend).map(loadPluginAsset));
    } catch (error) {
        console.error('Error al cargar plugins:', error);
    }
}

function unloadPluginModule(pluginId) {
    const module = window.NopalPluginRegistry[pluginId];
    if (module?.unmount) module.unmount();
    delete window.NopalPluginRegistry[pluginId];
    document.getElementById(`plugin-script-${pluginId}`)?.remove();
    document.getElementById(`plugin-style-${pluginId}`)?.remove();
}

function pluginIconSvg(icon, size = 24) {
    const paths = {
        shapes: '<rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17.5" cy="6.5" r="3.5"/><path d="m4 20 4-7 4 7Z"/><path d="M15 14h6v6h-6z"/>',
        route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h3a4 4 0 0 0 4-4V9a4 4 0 0 1 4-4"/>',
        vector: '<path d="m5 3 14 0 2 7-9 11-9-11Z"/><path d="M5 3l7 18L19 3M3 10h18"/>',
        type: '<path d="M4 5V3h16v2"/><path d="M9 21h6"/><path d="M12 3v18"/>',
        layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
        cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
        camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
        banknote: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
        spool: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>'
    };
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[icon] || paths.shapes}</svg>`;
}

function pluginActionLabel(plugin) {
    if (plugin.availability !== 'available') return t('pluginsComingSoon');
    return plugin.installed ? t('pluginsUninstall') : t('pluginsInstall');
}

// "Actualizar" solo tiene sentido si el catálogo ofrece una versión
// MAYOR que la instalada. Una comparación por desigualdad mostraba el botón
// incluso cuando el checkout del plugin iba por delante del catálogo.
function pluginUpdateAvailable(plugin) {
    if (!plugin.installed || !plugin.catalog_version || !plugin.version) return false;
    const catalog = String(plugin.catalog_version).split('.').map(part => Number.parseInt(part, 10) || 0);
    const installed = String(plugin.version).split('.').map(part => Number.parseInt(part, 10) || 0);
    const length = Math.max(catalog.length, installed.length);
    for (let index = 0; index < length; index += 1) {
        const catalogPart = catalog[index] || 0;
        const installedPart = installed[index] || 0;
        if (catalogPart > installedPart) return true;
        if (catalogPart < installedPart) return false;
    }
    return false;
}

function pluginCatalogText(plugin, field) {
    const safeId = String(plugin.id || '').replace(/-/g, '_');
    const key = `pluginCatalog_${safeId}_${field}`;
    const translated = t(key);
    return translated === key ? (plugin[field] || '') : translated;
}

function pluginCategoryText(category) {
    const keys = {
        'Diseño': 'pluginCategoryDesign',
        'Producción': 'pluginCategoryProduction',
        'Utilidades': 'pluginCategoryUtilities',
        'Accesorios': 'pluginCategoryHardware',
    };
    return keys[category] ? t(keys[category]) : category;
}

function pluginCompatibilityText(value) {
    const keys = {
        'Láser': 'pluginCompatibilityLaser',
        'Impresión 3D': 'pluginCompatibilityPrint3d',
        'CNC': 'pluginCompatibilityCnc',
    };
    return keys[value] ? t(keys[value]) : value;
}

function renderPluginCard(plugin) {
    const status = plugin.installed ? t('pluginsStatusInstalled') : plugin.availability === 'available' ? t('pluginsStatusAvailable') : t('pluginsComingSoon');
    const disabled = plugin.availability !== 'available';
    return `
        <article class="plugin-card" data-plugin-id="${escapeHtml(plugin.id)}" style="--plugin-accent:${escapeHtml(plugin.accent || '#a855f7')}">
            <div class="plugin-card-top">
                <div class="plugin-card-icon">${pluginIconSvg(plugin.icon)}</div>
                <span class="plugin-card-status${plugin.installed ? ' is-installed' : ''}">${escapeHtml(status)}</span>
            </div>
            <h3>${escapeHtml(pluginCatalogText(plugin, 'name'))}</h3>
            <span class="plugin-card-publisher">${escapeHtml(plugin.publisher)} · v${escapeHtml(plugin.version)}</span>
            <p class="plugin-card-description">${escapeHtml(pluginCatalogText(plugin, 'description'))}</p>
            <div class="plugin-card-tags">${plugin.compatibility.map(item => `<span class="plugin-card-tag">${escapeHtml(pluginCompatibilityText(item))}</span>`).join('')}</div>
            <div class="plugin-card-footer">
                <span class="plugin-card-meta">${escapeHtml(pluginCategoryText(plugin.category))} · ${escapeHtml(plugin.size === 'Por definir' ? t('pluginsSizeTbd') : plugin.size)}</span>
                <div class="plugin-card-actions${pluginUpdateAvailable(plugin) ? ' has-update' : ''}">
                    ${pluginUpdateAvailable(plugin) ? `<button type="button" class="plugin-update-btn" data-plugin-action="update" data-plugin-id="${escapeHtml(plugin.id)}" title="${escapeHtml(t('pluginsUpdateAvailable').replace('{version}', plugin.catalog_version))}">${escapeHtml(t('pluginsUpdate'))}</button>` : ''}
                    <button type="button" class="plugin-install-btn${plugin.installed ? ' is-installed' : ''}" data-plugin-action="${plugin.installed ? 'uninstall' : 'install'}" data-plugin-id="${escapeHtml(plugin.id)}" ${disabled ? 'disabled' : ''}>${escapeHtml(pluginActionLabel(plugin))}</button>
                </div>
            </div>
        </article>`;
}

function renderPluginsFeatured() {
    if (!pluginsFeatured) return;
    // Clic en una tarjeta selecciona ese plugin para el banner (persiste
    // aunque cambie el filtro/búsqueda); sin selección, cae al plugin
    // marcado "featured" en el catálogo, como antes.
    const selected = pluginsFeaturedId && pluginsCatalog.find(plugin => plugin.id === pluginsFeaturedId);
    const featured = selected || pluginsCatalog.find(plugin => plugin.featured);
    const show = featured && (selected || (pluginsActiveCategory === 'all' && !pluginsSearchInput?.value.trim()));
    pluginsFeatured.hidden = !show;
    if (!show) return;
    // La imagen del plugin va de fondo del contenedor completo (debajo del
    // degradado que ya trae la tarjeta), no como una miniatura aparte --
    // así el degradado sigue haciendo de transición hacia el texto.
    pluginsFeatured.classList.toggle('has-banner-image', !!featured.banner_image);
    if (featured.banner_image) {
        pluginsFeatured.style.setProperty('--plugins-featured-image', `url('${featured.banner_image.replace(/'/g, "%27")}')`);
    } else {
        pluginsFeatured.style.removeProperty('--plugins-featured-image');
    }
    const visual = featured.banner_image ? '' : `<div class="plugins-featured-icon">${pluginIconSvg(featured.icon, 58)}</div>`;
    pluginsFeatured.innerHTML = `
        <div class="plugins-featured-copy" style="--plugin-accent:${escapeHtml(featured.accent)}">
            <span class="plugins-featured-label">${escapeHtml(t('pluginsFeatured'))}</span>
            <h2>${escapeHtml(pluginCatalogText(featured, 'name'))}</h2>
            <p>${escapeHtml(pluginCatalogText(featured, 'long_description'))}</p>
            <div class="plugin-card-tags">${featured.compatibility.map(item => `<span class="plugin-card-tag">${escapeHtml(pluginCompatibilityText(item))}</span>`).join('')}</div>
        </div>
        <div class="plugins-featured-visual">${visual}</div>`;
}

function renderPluginsFilters() {
    if (!pluginsCategoryFilters) return;
    const filters = [{ id: 'all', label: t('pluginsFilterAll') }, ...pluginsCategories.map(category => ({ id: category, label: pluginCategoryText(category) }))];
    pluginsCategoryFilters.innerHTML = filters.map(filter => `
        <button type="button" class="plugins-filter-chip${pluginsActiveCategory === filter.id ? ' active' : ''}" data-plugin-category="${escapeHtml(filter.id)}">${escapeHtml(filter.label)}</button>`).join('');
}

function renderPluginsGallery() {
    if (!pluginsGrid) return;
    const query = (pluginsSearchInput?.value || '').trim().toLocaleLowerCase();
    const filtered = pluginsCatalog.filter(plugin => {
        const inCategory = pluginsActiveCategory === 'all' || plugin.category === pluginsActiveCategory;
        const haystack = `${pluginCatalogText(plugin, 'name')} ${pluginCatalogText(plugin, 'description')} ${plugin.publisher} ${pluginCategoryText(plugin.category)} ${plugin.compatibility.map(pluginCompatibilityText).join(' ')}`.toLocaleLowerCase();
        return inCategory && (!query || haystack.includes(query));
    });
    pluginsGrid.innerHTML = filtered.map(renderPluginCard).join('');
    if (pluginsEmpty) pluginsEmpty.hidden = filtered.length > 0;
    renderPluginsFilters();
    renderPluginsFeatured();
}

async function loadPluginsGallery(force = false) {
    if (!pluginsGrid || (pluginsLoaded && !force)) return;
    pluginsGrid.innerHTML = `<div class="plugins-loading">${escapeHtml(t('pluginsLoading'))}</div>`;
    try {
        const response = await fetch('/api/plugins');
        if (!response.ok) throw new Error(t('pluginsLoadError'));
        const data = await response.json();
        pluginsCatalog = Array.isArray(data.plugins) ? data.plugins : [];
        pluginsCategories = Array.isArray(data.categories) ? data.categories : [];
        pluginsLoaded = true;
        if (pluginsInstalledCount) pluginsInstalledCount.textContent = data.installed_count || 0;
        await loadInstalledPluginModules(pluginsCatalog);
        renderPluginsGallery();
    } catch (error) {
        console.error(error);
        pluginsGrid.innerHTML = `<div class="plugins-loading">${escapeHtml(t('pluginsLoadError'))}</div>`;
    }
}

async function changePluginInstallation(pluginId, action, button) {
    const plugin = pluginsCatalog.find(item => item.id === pluginId);
    if (!plugin) return;
    const localizedName = pluginCatalogText(plugin, 'name');
    if (action === 'uninstall' && !(await appConfirm(t('pluginsUninstallConfirm').replace('{name}', localizedName), t('pluginsUninstall')))) return;
    button.disabled = true;
    button.textContent = t('pluginsWorking');
    try {
        const url = action === 'install' ? `/api/plugins/${encodeURIComponent(pluginId)}/install`
            : action === 'update' ? `/api/plugins/${encodeURIComponent(pluginId)}/update`
            : `/api/plugins/${encodeURIComponent(pluginId)}`;
        const response = await fetch(url, { method: action === 'uninstall' ? 'DELETE' : 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || t('pluginsActionError'));
        if (action === 'uninstall') unloadPluginModule(pluginId);
        pluginsLoaded = false;
        await loadPluginsGallery(true);
        if (action === 'install') {
            showToast(t('pluginsInstalledSuccess').replace('{name}', localizedName));
        } else if (action === 'uninstall') {
            showToast(t('pluginsUninstalledSuccess').replace('{name}', localizedName));
        } else if (!data.updated) {
            showToast(t('pluginsUpdateNoChanges').replace('{name}', localizedName));
        } else if (data.backend_changed) {
            // Cambió backend/ del plugin -- eso solo se carga una vez, al
            // arrancar NOPAL (ver plugin_loader_service.py), así que un
            // reload de la página no alcanza acá.
            showToast(t('pluginsUpdatedBackendChanged').replace('{name}', localizedName), 'warning');
        } else {
            // Solo cambió frontend -- recargar la página trae el script
            // nuevo sin depender de invalidar caché a mano.
            showToast(t('pluginsUpdatedSuccess').replace('{name}', localizedName));
            setTimeout(() => window.location.reload(), 1200);
        }
    } catch (error) {
        showToast(error.message || t('pluginsActionError'), 'error');
        button.disabled = false;
        button.textContent = action === 'update' ? t('pluginsUpdate') : pluginActionLabel(plugin);
    }
}

pluginsCategoryFilters?.addEventListener('click', event => {
    const button = event.target.closest('[data-plugin-category]');
    if (!button) return;
    pluginsActiveCategory = button.dataset.pluginCategory;
    renderPluginsGallery();
});
pluginsSearchInput?.addEventListener('input', renderPluginsGallery);
pluginsGrid?.addEventListener('click', event => {
    const button = event.target.closest('[data-plugin-action]');
    if (button) {
        changePluginInstallation(button.dataset.pluginId, button.dataset.pluginAction, button);
        return;
    }
    const card = event.target.closest('.plugin-card');
    if (card && card.dataset.pluginId && card.dataset.pluginId !== pluginsFeaturedId) {
        pluginsFeaturedId = card.dataset.pluginId;
        renderPluginsFeatured();
        pluginsFeatured?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
});

// ── Editor G-Code local ──
const gcodeEditorTextarea = document.getElementById('gcode-editor-textarea');
const gcodeEditorFilename = document.getElementById('gcode-editor-filename');
const gcodeEditorLineCount = document.getElementById('gcode-editor-line-count');
const gcodeEditorFileInput = document.getElementById('gcode-editor-file-input');
const gcodeAnalysisType = document.getElementById('gcode-analysis-type');
const gcodeAnalysisSummary = document.getElementById('gcode-analysis-summary');
const gcodeAnalysisDetails = document.getElementById('gcode-analysis-details');
const gcodeAnalysisSignals = document.getElementById('gcode-analysis-signals');
let gcodeAnalysisTimer = null;

function analyzeGcodeContent(content) {
    const rawLines = content.split(/\r?\n/);
    const scores = { print3d: 0, laser: 0, cnc: 0 };
    const signals = { print3d: [], laser: [], cnc: [] };
    const addSignal = (type, points, label) => {
        scores[type] += points;
        if (!signals[type].includes(label)) signals[type].push(label);
    };
    const stats = { executable: 0, g0: 0, g1: 0, g2: 0, g3: 0, layers: new Set(), tools: new Set(), commands: new Set() };
    const ranges = { feed: [Infinity, -Infinity], power: [Infinity, -Infinity], nozzle: [Infinity, -Infinity], bed: [Infinity, -Infinity] };
    const bounds = { X: [Infinity, -Infinity], Y: [Infinity, -Infinity], Z: [Infinity, -Infinity] };
    const position = { X: 0, Y: 0, Z: 0 };
    let units = '';
    let absolute = true;
    let coordinateSystem = '';
    let plane = '';
    let generator = '';
    let firmware = '';
    let declaredBounds = '';
    let declaredFeed = '';
    let declaredPower = '';
    let pathDistance = 0;
    let hasExtrusion = false;

    rawLines.forEach(rawLine => {
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        const comment = ((trimmed.match(/;(.+)/) || [])[1] || '').trim();
        if (comment) {
            const generatorMatch = comment.match(/\b(LightBurn(?:\s+(?:Pro\s+)?[\d.]+)?|Ultimaker Cura[^;]*|Cura_SteamEngine[^;]*|PrusaSlicer[^;]*|SuperSlicer[^;]*|OrcaSlicer[^;]*|Bambu Studio[^;]*|Simplify3D[^;]*|ideaMaker[^;]*|Fusion 360[^;]*|FreeCAD[^;]*|VCarve[^;]*|Aspire[^;]*|Estlcam[^;]*|Carbide Create[^;]*)/i);
            if (generatorMatch && !generator) generator = generatorMatch[1].trim();
            if (/\bLightBurn\b/i.test(comment)) addSignal('laser', 8, 'LightBurn');
            if (/\b(Cura|PrusaSlicer|SuperSlicer|OrcaSlicer|Bambu Studio|Simplify3D|ideaMaker)\b/i.test(comment)) addSignal('print3d', 8, t('gcodeSignalSlicer'));
            if (/\b(Fusion 360|FreeCAD|VCarve|Aspire|Estlcam|Carbide Create|CAM)\b/i.test(comment)) addSignal('cnc', 7, t('gcodeSignalCam'));
            if (/\bGRBL\b/i.test(comment)) firmware = 'GRBL';
            if (/\bLAYER\s*[: ]\s*(-?\d+)/i.test(comment)) {
                stats.layers.add(comment.match(/\bLAYER\s*[: ]\s*(-?\d+)/i)[1]);
                addSignal('print3d', 3, t('gcodeSignalLayers'));
            }
            if (/\b(TYPE|WALL-INNER|WALL-OUTER|SKIRT|BRIM|INFILL)\b/i.test(comment)) addSignal('print3d', 2, t('gcodeSignalPrintFeatures'));
            if (/\b(LASER|ENGRAV|CUTTING)\b/i.test(comment)) addSignal('laser', 3, t('gcodeSignalLaserTerms'));
            const declared = comment.match(/Bounds:\s*X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)\s+to\s+X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)/i);
            if (declared) declaredBounds = `X ${declared[1]}–${declared[3]} · Y ${declared[2]}–${declared[4]}`;
            const processSettings = comment.match(/@\s*([\d.]+)\s*(mm\/min|in\/min).*?([\d.]+)\s*%\s*power/i);
            if (processSettings) {
                declaredFeed = `${processSettings[1]} ${processSettings[2]}`;
                declaredPower = `${processSettings[3]}%`;
            }
        }

        const code = trimmed.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim().toUpperCase();
        if (!code || code.startsWith('%')) return;
        const commands = [...code.matchAll(/(?:^|\s)([GMT])\s*(\d+(?:\.\d+)?)/g)]
            .map(match => `${match[1]}${Number(match[2])}`);
        if (!commands.length) return;
        const command = commands.find(item => ['G0', 'G1', 'G2', 'G3'].includes(item))
            || commands.find(item => item.startsWith('M'))
            || commands[0];
        stats.executable += 1;
        commands.forEach(item => stats.commands.add(item));

        const values = {};
        for (const match of code.matchAll(/([A-Z])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g)) values[match[1]] = Number(match[2]);
        if (commands.includes('G20')) units = t('gcodeUnitsInches');
        if (commands.includes('G21')) units = t('gcodeUnitsMillimeters');
        if (commands.includes('G90')) absolute = true;
        if (commands.includes('G91')) absolute = false;
        commands.filter(item => /^G5[4-9]$/.test(item)).forEach(item => { coordinateSystem = item; });
        commands.filter(item => /^G1[789]$/.test(item)).forEach(item => { plane = item; });

        if (/^T\d+$/.test(command)) stats.tools.add(command.slice(1));
        const standaloneTool = code.match(/^T\s*(\d+)/);
        if (standaloneTool) stats.tools.add(standaloneTool[1]);
        if (commands.some(item => item === 'M6' || /^G8[1-9]$/.test(item) || item === 'G43' || item === 'G49')) addSignal('cnc', 7, t('gcodeSignalCncTooling'));
        if (commands.some(item => item === 'G2' || item === 'G3')) addSignal('cnc', 1, t('gcodeSignalArcs'));
        if (commands.includes('M4')) addSignal('laser', 6, 'M4');
        if (commands.some(item => item === 'M3' || item === 'M4') && Number.isFinite(values.S)) addSignal('laser', 2, t('gcodeSignalPowerControl'));

        if (['M104', 'M109'].includes(command)) {
            const temperature = Number.isFinite(values.S) ? values.S : values.R;
            if (Number.isFinite(temperature)) { ranges.nozzle[0] = Math.min(ranges.nozzle[0], temperature); ranges.nozzle[1] = Math.max(ranges.nozzle[1], temperature); }
            addSignal('print3d', 7, t('gcodeSignalHotend'));
        }
        if (['M140', 'M190'].includes(command)) {
            const temperature = Number.isFinite(values.S) ? values.S : values.R;
            if (Number.isFinite(temperature)) { ranges.bed[0] = Math.min(ranges.bed[0], temperature); ranges.bed[1] = Math.max(ranges.bed[1], temperature); }
            addSignal('print3d', 7, t('gcodeSignalBed'));
        }
        if (['M106', 'M107'].includes(command)) addSignal('print3d', 2, t('gcodeSignalFan'));

        if (Number.isFinite(values.F)) { ranges.feed[0] = Math.min(ranges.feed[0], values.F); ranges.feed[1] = Math.max(ranges.feed[1], values.F); }
        if (Number.isFinite(values.S) && ['M3', 'M4', 'G0', 'G1'].includes(command)) {
            ranges.power[0] = Math.min(ranges.power[0], values.S);
            ranges.power[1] = Math.max(ranges.power[1], values.S);
        }
        if (Number.isFinite(values.E) && ['G0', 'G1'].includes(command)) {
            hasExtrusion = true;
            addSignal('print3d', 6, t('gcodeSignalExtrusion'));
        }

        if (['G0', 'G1', 'G2', 'G3'].includes(command)) {
            stats[command.toLowerCase()] += 1;
            const next = { ...position };
            ['X', 'Y', 'Z'].forEach(axis => {
                if (Number.isFinite(values[axis])) next[axis] = absolute ? values[axis] : position[axis] + values[axis];
            });
            if (Number.isFinite(values.X) || Number.isFinite(values.Y) || Number.isFinite(values.Z)) {
                pathDistance += Math.hypot(next.X - position.X, next.Y - position.Y, next.Z - position.Z);
                ['X', 'Y', 'Z'].forEach(axis => {
                    bounds[axis][0] = Math.min(bounds[axis][0], next[axis]);
                    bounds[axis][1] = Math.max(bounds[axis][1], next[axis]);
                    position[axis] = next[axis];
                });
            }
        }
    });

    if (firmware === 'GRBL' && ranges.power[1] > -Infinity && !hasExtrusion) addSignal('laser', 2, 'GRBL + S');
    if (bounds.Z[0] < 0 && !hasExtrusion) addSignal('cnc', 2, t('gcodeSignalNegativeZ'));
    if (stats.tools.size) addSignal('cnc', 5, t('gcodeSignalToolChanges'));

    const ranking = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [type, topScore] = ranking[0][1] > 0 ? ranking[0] : ['unknown', 0];
    const margin = topScore - (ranking[1]?.[1] || 0);
    const confidence = topScore >= 10 && margin >= 5 ? t('gcodeConfidenceHigh') : topScore >= 5 && margin >= 2 ? t('gcodeConfidenceMedium') : t('gcodeConfidenceLow');
    const rangeText = range => range[1] > -Infinity ? (range[0] === range[1] ? `${range[0]}` : `${range[0]}–${range[1]}`) : '';
    const axisBounds = ['X', 'Y', 'Z'].filter(axis => bounds[axis][1] > -Infinity).map(axis => `${axis} ${bounds[axis][0].toFixed(2)}–${bounds[axis][1].toFixed(2)}`).join(' · ');
    const motionText = ['G0', 'G1', 'G2', 'G3'].map(command => `${command}: ${stats[command.toLowerCase()].toLocaleString()}`).join(' · ');

    return {
        type, confidence, scores, signals: type === 'unknown' ? [] : signals[type],
        details: [
            [t('gcodeAnalysisGenerator'), generator || t('gcodeAnalysisNotDetected'), true],
            [t('gcodeAnalysisFirmware'), firmware || t('gcodeAnalysisNotDetected')],
            [t('gcodeAnalysisUnits'), units || t('gcodeAnalysisNotDeclared')],
            [t('gcodeAnalysisCoordinates'), `${absolute ? t('gcodeCoordinatesAbsolute') : t('gcodeCoordinatesRelative')}${coordinateSystem ? ` · ${coordinateSystem}` : ''}${plane ? ` · ${plane}` : ''}`],
            [t('gcodeAnalysisBounds'), declaredBounds || axisBounds || t('gcodeAnalysisNotDetected'), true],
            [t('gcodeAnalysisFeed'), rangeText(ranges.feed) ? `${rangeText(ranges.feed)} /min` : declaredFeed || t('gcodeAnalysisNotDetected')],
            [t('gcodeAnalysisPower'), `${rangeText(ranges.power) ? `S ${rangeText(ranges.power)}` : ''}${rangeText(ranges.power) && declaredPower ? ' · ' : ''}${declaredPower ? `${declaredPower} ${t('gcodeAnalysisDeclared')}` : ''}` || t('gcodeAnalysisNotDetected')],
            [t('gcodeAnalysisTemperatures'), `${rangeText(ranges.nozzle) ? `${t('gcodeAnalysisNozzle')} ${rangeText(ranges.nozzle)} °C` : ''}${rangeText(ranges.nozzle) && rangeText(ranges.bed) ? ' · ' : ''}${rangeText(ranges.bed) ? `${t('gcodeAnalysisBed')} ${rangeText(ranges.bed)} °C` : ''}` || t('gcodeAnalysisNotDetected'), true],
            [t('gcodeAnalysisLayersTools'), `${stats.layers.size ? `${stats.layers.size} ${t('gcodeAnalysisLayers')}` : ''}${stats.layers.size && stats.tools.size ? ' · ' : ''}${stats.tools.size ? `${t('gcodeAnalysisTools')}: ${[...stats.tools].join(', ')}` : ''}` || t('gcodeAnalysisNotDetected')],
            [t('gcodeAnalysisPath'), pathDistance ? `${pathDistance.toFixed(1)} ${units === t('gcodeUnitsInches') ? 'in' : 'mm'}` : t('gcodeAnalysisNotDetected')],
            [t('gcodeAnalysisCommands'), `${stats.executable.toLocaleString()} · ${stats.commands.size} ${t('gcodeAnalysisUnique')}`, true],
            [t('gcodeAnalysisMovements'), motionText, true]
        ]
    };
}

function renderGcodeAnalysis() {
    if (!gcodeEditorTextarea || !gcodeAnalysisType || !gcodeAnalysisSummary || !gcodeAnalysisDetails || !gcodeAnalysisSignals) return;
    const content = gcodeEditorTextarea.value;
    if (!content.trim()) {
        gcodeAnalysisType.className = 'gcode-type-badge is-unknown';
        gcodeAnalysisType.textContent = t('gcodeTypeUnknown');
        gcodeAnalysisSummary.textContent = t('gcodeAnalysisEmpty');
        gcodeAnalysisDetails.innerHTML = '';
        gcodeAnalysisSignals.innerHTML = '';
        return;
    }
    const analysis = analyzeGcodeContent(content);
    const typeLabels = { print3d: t('gcodeTypePrint3d'), laser: t('gcodeTypeLaser'), cnc: t('gcodeTypeCnc'), unknown: t('gcodeTypeUnknown') };
    gcodeAnalysisType.className = `gcode-type-badge is-${analysis.type}`;
    gcodeAnalysisType.textContent = typeLabels[analysis.type];
    gcodeAnalysisSummary.textContent = analysis.type === 'unknown'
        ? t('gcodeAnalysisUndetermined')
        : t('gcodeAnalysisClassification').replace('{type}', typeLabels[analysis.type]).replace('{confidence}', analysis.confidence);
    gcodeAnalysisDetails.innerHTML = analysis.details.map(([label, value, wide]) => `
        <div class="gcode-analysis-item${wide ? ' is-wide' : ''}">
            <span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
        </div>`).join('');
    gcodeAnalysisSignals.innerHTML = analysis.signals.map(signal => `<span class="gcode-analysis-signal">${escapeHtml(signal)}</span>`).join('');
}

function scheduleGcodeAnalysis(immediate = false) {
    clearTimeout(gcodeAnalysisTimer);
    if (immediate) renderGcodeAnalysis();
    else gcodeAnalysisTimer = setTimeout(renderGcodeAnalysis, 250);
}

function updateGcodeEditorLineCount() {
    if (!gcodeEditorTextarea || !gcodeEditorLineCount) return;
    const content = gcodeEditorTextarea.value;
    const count = content ? content.split(/\r?\n/).length : 0;
    gcodeEditorLineCount.textContent = t('gcodeEditorLines').replace('{count}', count.toLocaleString());
    scheduleGcodeAnalysis();
}

document.getElementById('gcode-editor-open-btn')?.addEventListener('click', () => {
    gcodeEditorFileInput?.click();
});

gcodeEditorFileInput?.addEventListener('change', async () => {
    const file = gcodeEditorFileInput.files?.[0];
    if (!file || !gcodeEditorTextarea) return;
    gcodeEditorTextarea.value = await file.text();
    if (gcodeEditorFilename) gcodeEditorFilename.textContent = file.name;
    updateGcodeEditorLineCount();
    gcodeEditorTextarea.focus();
    gcodeEditorFileInput.value = '';
});

document.getElementById('gcode-editor-new-btn')?.addEventListener('click', async () => {
    if (!gcodeEditorTextarea) return;
    if (gcodeEditorTextarea.value && !(await appConfirm(t('gcodeEditorNewConfirm'), t('gcodeEditorNew')))) return;
    gcodeEditorTextarea.value = '';
    if (gcodeEditorFilename) gcodeEditorFilename.textContent = t('gcodeEditorUntitled');
    updateGcodeEditorLineCount();
    gcodeEditorTextarea.focus();
});

document.getElementById('gcode-editor-download-btn')?.addEventListener('click', () => {
    if (!gcodeEditorTextarea) return;
    const filename = (gcodeEditorFilename?.textContent || t('gcodeEditorUntitled')).trim();
    const blob = new Blob([gcodeEditorTextarea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = /\.(gcode|gc|gco|nc|tap|cnc)$/i.test(filename) ? filename : `${filename}.gcode`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
});

gcodeEditorTextarea?.addEventListener('input', updateGcodeEditorLineCount);
gcodeEditorTextarea?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const start = gcodeEditorTextarea.selectionStart;
    const end = gcodeEditorTextarea.selectionEnd;
    gcodeEditorTextarea.setRangeText('    ', start, end, 'end');
    updateGcodeEditorLineCount();
});
updateGcodeEditorLineCount();
scheduleGcodeAnalysis(true);

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
let modelsSearchQuery = '';
let modelsSortMode = localStorage.getItem('nopalModelsSort') || 'name-asc';
let modelsFilterMode = 'all';
let modelsTagFilter = '';
let modelsViewMode = localStorage.getItem('nopalModelsView') || 'list';
let modelsPage = 1;
let modelsPathHistory = [''];
let modelsPathHistoryIndex = 0;
const MODELS_PAGE_SIZE = 8;
const MODELS_RECENTS_KEY = 'nopalModelsRecents';

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

function modelLibrarySnapshot(model) {
    return { id: model.id, name: model.name, path: stripSectionPrefix(model.id, 'model'), extension: model.extension || '', modified: model.modified || 0 };
}

function rememberRecentModel(model) {
    const recent = readGcodeLibraryItems(MODELS_RECENTS_KEY).filter(item => item.id !== model.id);
    recent.unshift(modelLibrarySnapshot(model));
    writeGcodeLibraryItems(MODELS_RECENTS_KEY, recent.slice(0, 12));
}

function recordModelsPath(path) {
    if (modelsPathHistory[modelsPathHistoryIndex] === path) return;
    modelsPathHistory = modelsPathHistory.slice(0, modelsPathHistoryIndex + 1);
    modelsPathHistory.push(path);
    modelsPathHistoryIndex = modelsPathHistory.length - 1;
}

async function loadModelsFolder(path = currentModelsPath, options = {}) {
    const normalizedPath = String(path || '').replace(/^\/+|\/+$/g, '');
    if (options.recordHistory !== false) recordModelsPath(normalizedPath);
    currentModelsPath = normalizedPath;
    modelsPage = 1;
    try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(normalizedPath)}&type=model`);
        if (!response.ok) throw new Error('No se pudo cargar la carpeta');
        currentModelsData = await response.json();
    } catch (error) {
        console.error(error);
        currentModelsData = { folders: [], files: [] };
    }
    renderModelsBreadcrumb();
    renderModelsFullPage();
}

function renderModelsBreadcrumb() {
    const breadcrumb = document.getElementById('models-breadcrumb');
    if (!breadcrumb) return;
    const parts = currentModelsPath.split('/').filter(Boolean);
    const segments = [{ label: t('libraryRoot'), path: '' }, { label: t('librarySection'), path: '' }, { label: t('navPrinting3d'), path: '' }];
    parts.forEach((part, index) => segments.push({ label: part, path: parts.slice(0, index + 1).join('/') }));
    breadcrumb.innerHTML = segments.map(segment => `<button type="button" class="breadcrumb-segment" data-models-path="${escapeHtml(segment.path)}">${escapeHtml(segment.label)}</button>`).join('');
    breadcrumb.querySelectorAll('[data-models-path]').forEach(button => button.addEventListener('click', () => loadModelsFolder(button.dataset.modelsPath)));
    document.getElementById('models-nav-back')?.toggleAttribute('disabled', modelsPathHistoryIndex <= 0);
    document.getElementById('models-nav-forward')?.toggleAttribute('disabled', modelsPathHistoryIndex >= modelsPathHistory.length - 1);
    document.getElementById('models-nav-up')?.toggleAttribute('disabled', !currentModelsPath);
    const disk = document.getElementById('models-disk-free');
    if (disk) disk.textContent = t('libraryCounts').replace('{folders}', currentModelsData.folders.length).replace('{files}', currentModelsData.files.length);
}

function renderModelsFolderStrip(folders) {
    const strip = document.getElementById('models-folder-strip');
    if (!strip) return;
    strip.hidden = !folders.length;
    strip.innerHTML = folders.map(folder => `<button type="button" class="gcode-folder-card" data-model-folder="${escapeHtml(folder.path)}"><svg width="29" height="29" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-9l-2-2Z"/></svg><span><strong>${escapeHtml(folder.name)}</strong><small>${t('libraryItems').replace('{count}', Number(folder.file_count || 0).toLocaleString())}</small></span><span class="gcode-folder-menu">›</span></button>`).join('');
    strip.querySelectorAll('[data-model-folder]').forEach(button => button.addEventListener('click', () => loadModelsFolder(button.dataset.modelFolder)));
}

function getFilteredModelsFiles() {
    const query = modelsSearchQuery.trim().toLowerCase();
    const favorites = getFavoriteModelIds();
    const recentIds = new Set(readGcodeLibraryItems(MODELS_RECENTS_KEY).map(item => item.id));
    return currentModelsData.files.filter(model => {
        const extension = String(model.extension || '').replace('.', '').toLowerCase();
        if (query && !String(model.name || '').toLowerCase().includes(query)) return false;
        if (modelsTagFilter && extension !== modelsTagFilter) return false;
        if (modelsFilterMode === 'favorites' && !favorites.has(model.id)) return false;
        if (modelsFilterMode === 'recent' && !recentIds.has(model.id)) return false;
        if (modelsFilterMode === 'gcode' && !isGcodeFile(model)) return false;
        if (modelsFilterMode === 'models' && isGcodeFile(model)) return false;
        return true;
    }).sort((a, b) => {
        if (modelsSortMode === 'name-desc') return String(b.name).localeCompare(String(a.name), undefined, { sensitivity: 'base' });
        if (modelsSortMode === 'date-desc') return Number(b.modified || 0) - Number(a.modified || 0);
        if (modelsSortMode === 'date-asc') return Number(a.modified || 0) - Number(b.modified || 0);
        if (modelsSortMode === 'size-desc') return Number(b.size || 0) - Number(a.size || 0);
        return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
    });
}

function renderModelsSidebar() {
    const favorites = getFavoriteModelIds();
    const recent = readGcodeLibraryItems(MODELS_RECENTS_KEY);
    const favoriteModels = currentModelsData.files.filter(model => favorites.has(model.id));
    const itemHtml = item => `<button type="button" class="gcode-sidebar-item" data-model-library-item="${escapeHtml(item.id)}"><span class="gcode-sidebar-icon">◇</span><span>${escapeHtml(item.name)}</span><b>${escapeHtml(String(item.extension || '3D').replace('.', '').toUpperCase())}</b></button>`;
    const favoriteList = document.getElementById('models-favorites-list');
    const recentList = document.getElementById('models-recents-list');
    if (favoriteList) favoriteList.innerHTML = favoriteModels.slice(0, 4).map(itemHtml).join('') || `<span class="gcode-sidebar-empty">${t('libraryNoFavorites')}</span>`;
    if (recentList) recentList.innerHTML = recent.slice(0, 5).map(itemHtml).join('') || `<span class="gcode-sidebar-empty">${t('libraryNoRecent')}</span>`;
    const formats = new Map();
    currentModelsData.files.forEach(model => {
        const extension = String(model.extension || 'archivo').replace('.', '').toUpperCase();
        formats.set(extension, (formats.get(extension) || 0) + 1);
    });
    const tags = document.getElementById('models-tags-list');
    if (tags) tags.innerHTML = Array.from(formats.entries()).map(([format, count]) => `<button type="button" class="gcode-sidebar-item" data-model-format="${escapeHtml(format.toLowerCase())}"><span class="gcode-sidebar-icon">◆</span><span>${escapeHtml(format)}</span><b>${count}</b></button>`).join('') || `<span class="gcode-sidebar-empty">${t('libraryNoFormats')}</span>`;
    document.querySelectorAll('[data-model-library-item]').forEach(button => button.addEventListener('click', async () => {
        const snapshot = [...favoriteModels.map(modelLibrarySnapshot), ...recent].find(item => item.id === button.dataset.modelLibraryItem);
        if (!snapshot) return;
        const parent = getGcodePathParent(snapshot.path);
        if (parent !== currentModelsPath) await loadModelsFolder(parent);
        const model = currentModelsData.files.find(item => item.id === snapshot.id);
        if (model) selectPreviewModel(model);
    }));
    tags?.querySelectorAll('[data-model-format]').forEach(button => button.addEventListener('click', () => {
        modelsTagFilter = button.dataset.modelFormat;
        modelsSearchQuery = '';
        if (searchModelsInput) searchModelsInput.value = '';
        modelsPage = 1;
        renderModelsFullPage();
    }));
}

function renderModelsPagination(totalItems, totalPages) {
    const pagination = document.getElementById('models-pagination');
    if (!pagination) return;
    if (!totalItems) { pagination.innerHTML = `<span>${t('libraryZeroResults')}</span>`; return; }
    const start = (modelsPage - 1) * MODELS_PAGE_SIZE + 1;
    const end = Math.min(modelsPage * MODELS_PAGE_SIZE, totalItems);
    const pages = Array.from({ length: totalPages }, (_, index) => index + 1).filter(page => page === 1 || page === totalPages || Math.abs(page - modelsPage) <= 1);
    let previous = 0;
    const controls = pages.map(page => { const gap = previous && page - previous > 1 ? '<span>…</span>' : ''; previous = page; return `${gap}<button type="button" class="${page === modelsPage ? 'active' : ''}" data-models-page="${page}">${page}</button>`; }).join('');
    pagination.innerHTML = `<span>${t('libraryResults').replace('{start}', start).replace('{end}', end).replace('{total}', totalItems)}</span><div class="gcode-pagination-pages"><button type="button" data-models-page="${modelsPage - 1}" ${modelsPage === 1 ? 'disabled' : ''}>‹</button>${controls}<button type="button" data-models-page="${modelsPage + 1}" ${modelsPage === totalPages ? 'disabled' : ''}>›</button></div><span>${t('libraryPerPage').replace('{count}', MODELS_PAGE_SIZE)}</span>`;
    pagination.querySelectorAll('[data-models-page]').forEach(button => button.addEventListener('click', () => { const page = Number(button.dataset.modelsPage); if (page < 1 || page > totalPages || page === modelsPage) return; modelsPage = page; renderModelsFullPage(); }));
}

function renderModelsFullPage(filterQuery = modelsSearchQuery) {
    const container = document.getElementById('models-full');
    if (!container) return;
    modelsSearchQuery = filterQuery || '';
    const folderQuery = modelsSearchQuery.toLowerCase();
    renderModelsFolderStrip(currentModelsData.folders.filter(folder => !folderQuery || folder.name.toLowerCase().includes(folderQuery)));
    renderModelsSidebar();
    renderModelsBreadcrumb();
    const files = getFilteredModelsFiles();
    const totalPages = Math.max(1, Math.ceil(files.length / MODELS_PAGE_SIZE));
    modelsPage = Math.min(modelsPage, totalPages);
    const pageFiles = files.slice((modelsPage - 1) * MODELS_PAGE_SIZE, modelsPage * MODELS_PAGE_SIZE);
    container.classList.toggle('is-grid', modelsViewMode === 'grid');
    document.getElementById('view-list-full')?.classList.toggle('active', modelsViewMode === 'list');
    document.getElementById('view-grid-full')?.classList.toggle('active', modelsViewMode === 'grid');
    renderModelsPagination(files.length, totalPages);
    if (!files.length) { container.innerHTML = `<div class="empty-state">${t('noFilesFound')}</div>`; return; }
    if (!selectedModelId || !files.some(model => model.id === selectedModelId)) selectedModelId = pageFiles[0]?.id || null;
    const rows = pageFiles.map(model => {
        const extension = String(model.extension || '').replace('.', '').toUpperCase() || '—';
        const checked = getBulkSelection('model').has(model.id) ? 'checked' : '';
        return `<tr class="${model.id === selectedModelId ? 'selected' : ''}" data-model-id="${escapeHtml(model.id)}"><td class="select-col"><input type="checkbox" class="row-select-checkbox" data-model-id="${escapeHtml(model.id)}" ${checked}></td><td class="model-name"><span class="model-format-icon">${escapeHtml(extension)}</span><strong>${escapeHtml(model.name)}</strong>${getFavoriteModelIds().has(model.id) ? '<span class="gcode-file-favorite">★</span>' : ''}</td><td>${isGcodeFile(model) ? 'G-code' : t('model3D')}</td><td><span class="tag-pill">${escapeHtml(extension)}</span></td><td>${formatSize(model.size)}</td><td>${formatDate(model.modified)}</td><td>${escapeHtml(model.dimensions || '—')}</td><td><span class="gcode-status-ok" title="${t('libraryAvailable')}">✓</span></td><td><button type="button" class="gcode-row-menu" data-model-row-menu title="${t('libraryActions')}">•••</button></td></tr>`;
    }).join('');
    container.innerHTML = `<table class="models-table"><thead><tr><th class="select-col"><input type="checkbox" class="select-all-checkbox" id="models-select-all"></th><th>${t('columnName')}</th><th>${t('columnType')}</th><th>${t('libraryFormat')}</th><th>${t('columnSize')}</th><th>${t('previewMetaModified')}</th><th>${t('columnDimensions')}</th><th>${t('libraryStatus')}</th><th aria-label="${t('libraryActions')}">•••</th></tr></thead><tbody>${rows}</tbody></table>`;
    wireBulkSelection('model', container, pageFiles);
    container.querySelectorAll('tbody tr[data-model-id]').forEach(row => {
        row.addEventListener('click', event => { if (event.target.closest('.row-select-checkbox')) return; const model = currentModelsData.files.find(item => item.id === row.dataset.modelId); if (model) selectPreviewModel(model); });
        row.querySelector('[data-model-row-menu]')?.addEventListener('click', event => { event.stopPropagation(); const model = currentModelsData.files.find(item => item.id === row.dataset.modelId); if (model) selectPreviewModel(model); });
    });
    const selected = files.find(model => model.id === selectedModelId);
    if (selected) selectPreviewModel(selected, false);
}

function selectPreviewModel(model, rerender = true) {
    if (!model) return;
    selectedModelId = model.id;
    rememberRecentModel(model);
    const extension = model.extension ? model.extension.replace('.', '').toUpperCase() : '—';
    const previewTitle = document.getElementById('preview-filename');
    if (previewTitle) previewTitle.textContent = model.name;
    const previewType = document.getElementById('preview-type');
    if (previewType) previewType.textContent = extension;
    const previewSize = document.getElementById('preview-size');
    if (previewSize) previewSize.textContent = formatSize(model.size);
    const previewDate = document.getElementById('preview-date');
    if (previewDate) previewDate.textContent = formatDate(model.modified);
    const previewFormat = document.getElementById('models-preview-format');
    if (previewFormat) previewFormat.textContent = extension;
    const previewStatus = document.getElementById('models-preview-status');
    if (previewStatus) previewStatus.textContent = t('libraryReady');
    const favoriteBtn = document.getElementById('preview-favorite-btn');
    if (favoriteBtn) { const favorite = getFavoriteModelIds().has(model.id); favoriteBtn.textContent = favorite ? '★' : '☆'; favoriteBtn.classList.toggle('active', favorite); }
    const sendPrinterBtn = document.getElementById('preview-send-printer-btn');
    if (sendPrinterBtn) sendPrinterBtn.hidden = !isGcodeFile(model);
    const gotoPrinterBtn = document.getElementById('preview-goto-printer-btn');
    if (gotoPrinterBtn) gotoPrinterBtn.hidden = false;
    renderSelectedPreview(model);
    if (rerender) renderModelsFullPage();
}

document.getElementById('models-nav-back')?.addEventListener('click', () => { if (modelsPathHistoryIndex <= 0) return; modelsPathHistoryIndex -= 1; loadModelsFolder(modelsPathHistory[modelsPathHistoryIndex], { recordHistory: false }); });
document.getElementById('models-nav-forward')?.addEventListener('click', () => { if (modelsPathHistoryIndex >= modelsPathHistory.length - 1) return; modelsPathHistoryIndex += 1; loadModelsFolder(modelsPathHistory[modelsPathHistoryIndex], { recordHistory: false }); });
document.getElementById('models-nav-up')?.addEventListener('click', () => loadModelsFolder(getGcodePathParent(currentModelsPath)));
document.getElementById('models-nav-home')?.addEventListener('click', () => loadModelsFolder(''));
document.getElementById('models-sort-select')?.addEventListener('change', event => { modelsSortMode = event.target.value; localStorage.setItem('nopalModelsSort', modelsSortMode); modelsPage = 1; renderModelsFullPage(); });
document.getElementById('models-filter-select')?.addEventListener('change', event => { modelsFilterMode = event.target.value; modelsTagFilter = ''; modelsPage = 1; renderModelsFullPage(); });
document.getElementById('models-favorites-all')?.addEventListener('click', () => { modelsFilterMode = 'favorites'; const select = document.getElementById('models-filter-select'); if (select) select.value = 'favorites'; modelsPage = 1; renderModelsFullPage(); });
document.getElementById('models-recents-all')?.addEventListener('click', () => { modelsFilterMode = 'recent'; const select = document.getElementById('models-filter-select'); if (select) select.value = 'recent'; modelsPage = 1; renderModelsFullPage(); });
document.getElementById('view-grid-full')?.addEventListener('click', () => { modelsViewMode = 'grid'; localStorage.setItem('nopalModelsView', modelsViewMode); renderModelsFullPage(); });
document.getElementById('view-list-full')?.addEventListener('click', () => { modelsViewMode = 'list'; localStorage.setItem('nopalModelsView', modelsViewMode); renderModelsFullPage(); });
const modelsSortSelect = document.getElementById('models-sort-select');
if (modelsSortSelect) modelsSortSelect.value = modelsSortMode;

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
        previewFavoriteBtn.textContent = isFavorite ? '★' : '☆';
        renderModelsFullPage();
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
const settingsOnboardingHints = document.getElementById('settings-onboarding-hints');
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

// ── Modal "Control del sistema": servicios systemd (Klipper/Moonraker/
// Crowsnest) + control del host (reiniciar/apagar equipo). Backend en
// backend/api/system.py, rol admin requerido — el botón que abre este
// modal (#topbar-system-btn) ya viene oculto para operadores desde
// updateTopbarUser(). Deja afuera a propósito "Control de Klipper"
// (reiniciar Klipper/firmware): eso ya vive atado a cada impresora
// registrada (ver printerRestartConfirm/printerFirmwareRestartConfirm
// más arriba), no es parte de este popup a nivel host. ──
let systemControlPollInterval = null;

function systemControlServiceLabel(unit) {
    if (!unit) return unit;
    return unit.charAt(0).toUpperCase() + unit.slice(1);
}

function renderSystemControlServices(services) {
    const container = document.getElementById('system-control-services-list');
    if (!container) return;
    if (!services.length) {
        container.innerHTML = `<p class="system-control-empty">${t('systemControlEmpty')}</p>`;
        return;
    }
    container.innerHTML = services.map(service => {
        const isActive = service.active === 'active';
        const isFailed = service.active === 'failed';
        const dotClass = isActive ? 'is-active' : (isFailed ? 'is-failed' : '');
        const unit = escapeHtml(service.unit || '');
        const statusText = [service.active, service.sub].filter(Boolean).join(' · ');
        const disabled = service.controllable === false;
        return `
            <div class="system-control-row" data-service="${unit}">
                <span class="system-control-status-dot ${dotClass}"></span>
                <div class="system-control-row-name">
                    <strong>${escapeHtml(systemControlServiceLabel(service.unit))}</strong>
                    <small>${escapeHtml(statusText)}</small>
                </div>
                <button type="button" class="system-control-icon-btn" data-sysctl-restart="${unit}" title="${escapeHtml(t('systemControlServiceRestartTitle'))}" ${disabled ? 'disabled' : ''}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
                <label class="system-control-switch">
                    <input type="checkbox" data-sysctl-toggle="${unit}" ${isActive ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                    <span></span>
                </label>
            </div>`;
    }).join('');
}

async function loadSystemControlServices() {
    const container = document.getElementById('system-control-services-list');
    try {
        const response = await fetch('/api/system/services');
        if (!response.ok) throw new Error('No se pudo cargar los servicios');
        const data = await response.json();
        renderSystemControlServices(data.services || []);
    } catch (error) {
        console.error(error);
        if (container) container.innerHTML = `<p class="system-control-empty">${t('systemControlEmpty')}</p>`;
    }
}

async function runSystemServiceAction(action, service) {
    if (!service) return;
    try {
        const response = await fetch(`/api/system/services/${action}`, {
            method: 'POST',
            body: new URLSearchParams({ service }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
            showToast(data.detail || t('systemControlActionError'), 'error');
            return;
        }
    } catch (error) {
        console.error(error);
        showToast(t('systemControlActionError'), 'error');
    } finally {
        // systemd no aplica el cambio de estado al instante — se espera un
        // poco antes de refrescar para no pintar el estado viejo encima.
        setTimeout(loadSystemControlServices, 1500);
    }
}

document.getElementById('system-control-services-list')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-sysctl-restart]');
    if (!btn || btn.disabled) return;
    runSystemServiceAction('restart', btn.dataset.sysctlRestart);
});

document.getElementById('system-control-services-list')?.addEventListener('change', (event) => {
    const input = event.target.closest('[data-sysctl-toggle]');
    if (!input) return;
    runSystemServiceAction(input.checked ? 'start' : 'stop', input.dataset.sysctlToggle);
});

const systemControlModal = document.getElementById('system-control-modal');
const systemControlModalBackdrop = document.getElementById('system-control-modal-backdrop');
const systemControlModalClose = document.getElementById('system-control-modal-close');
const systemControlOpenBtn = document.getElementById('topbar-system-btn');

function openSystemControlModal() {
    if (!systemControlModal) return;
    systemControlModal.classList.add('active');
    loadSystemControlServices();
    if (systemControlPollInterval) clearInterval(systemControlPollInterval);
    systemControlPollInterval = setInterval(loadSystemControlServices, 5000);
}

function closeSystemControlModal() {
    if (systemControlModal) systemControlModal.classList.remove('active');
    if (systemControlPollInterval) { clearInterval(systemControlPollInterval); systemControlPollInterval = null; }
}

if (systemControlOpenBtn) systemControlOpenBtn.addEventListener('click', openSystemControlModal);
if (systemControlModalBackdrop) systemControlModalBackdrop.addEventListener('click', closeSystemControlModal);
if (systemControlModalClose) systemControlModalClose.addEventListener('click', closeSystemControlModal);

document.getElementById('system-control-nopal-restart-btn')?.addEventListener('click', async () => {
    if (!(await appConfirm(t('systemControlRestartNopalConfirm'), t('systemControlRestartNopal'), 'warning'))) return;
    try {
        const response = await fetch('/api/system/nopal/restart', { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
            showToast(data.detail || t('systemControlActionError'), 'error');
            return;
        }
        showToast(t('systemControlRestartNopalToast'));
        // El proceso se reinicia solo del lado del servidor (systemd lo
        // vuelve a levantar en ~5s) -- se recarga la página sola después de
        // darle tiempo, así el usuario no tiene que refrescar a mano.
        setTimeout(() => window.location.reload(), 8000);
    } catch (error) {
        console.error(error);
        showToast(t('systemControlActionError'), 'error');
    }
});

document.getElementById('system-control-host-reboot-btn')?.addEventListener('click', async () => {
    if (!(await appConfirm(t('systemControlRestartHostConfirm'), t('systemControlRestartHost'), 'warning'))) return;
    try {
        const response = await fetch('/api/system/host/reboot', { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
            showToast(data.detail || t('systemControlActionError'), 'error');
            return;
        }
        showToast(t('systemControlRestartHost'));
    } catch (error) {
        console.error(error);
        showToast(t('systemControlActionError'), 'error');
    }
});

document.getElementById('system-control-host-shutdown-btn')?.addEventListener('click', async () => {
    // Doble confirmación a propósito: esta acción apaga físicamente el
    // equipo, no queda forma de revertirla sin acceso físico a la máquina.
    if (!(await appConfirm(t('systemControlShutdownHostConfirm1'), t('systemControlShutdownHost'), 'danger'))) return;
    if (!(await appConfirm(t('systemControlShutdownHostConfirm2'), t('systemControlShutdownHost'), 'danger'))) return;
    try {
        const response = await fetch('/api/system/host/shutdown', { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
            showToast(data.detail || t('systemControlActionError'), 'error');
            return;
        }
        showToast(t('systemControlShutdownHost'));
    } catch (error) {
        console.error(error);
        showToast(t('systemControlActionError'), 'error');
    }
});

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
    if (settingsOnboardingHints) settingsOnboardingHints.checked = isOnboardingHintsEnabled();
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
            updatesPillWrap.closest('.settings-card')?.classList.add('updates-tooltip-open');
        }
    });
    updatesPillWrap.addEventListener('mouseleave', () => {
        updatesPillWrap.classList.remove('show-tooltip');
        updatesPillWrap.closest('.settings-card')?.classList.remove('updates-tooltip-open');
    });
}

function confirmSafeSystemUpdate() {
    const modal = document.getElementById('update-safety-modal');
    const checkbox = document.getElementById('update-safety-checkbox');
    const cancelBtn = document.getElementById('update-safety-cancel');
    const proceedBtn = document.getElementById('update-safety-proceed');
    if (!modal || !checkbox || !cancelBtn || !proceedBtn) return Promise.resolve(false);

    modal.hidden = false;
    checkbox.checked = false;
    proceedBtn.disabled = true;
    document.body.classList.add('modal-open');

    return new Promise(resolve => {
        const finish = confirmed => {
            modal.hidden = true;
            document.body.classList.remove('modal-open');
            checkbox.removeEventListener('change', onCheckboxChange);
            cancelBtn.removeEventListener('click', onCancel);
            proceedBtn.removeEventListener('click', onProceed);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKeydown);
            resolve(confirmed);
        };
        const onCheckboxChange = () => { proceedBtn.disabled = !checkbox.checked; };
        const onCancel = () => finish(false);
        const onProceed = () => { if (checkbox.checked) finish(true); };
        const onBackdrop = event => { if (event.target === modal) finish(false); };
        const onKeydown = event => { if (event.key === 'Escape') finish(false); };

        checkbox.addEventListener('change', onCheckboxChange);
        cancelBtn.addEventListener('click', onCancel);
        proceedBtn.addEventListener('click', onProceed);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKeydown);
        checkbox.focus();
    });
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForNopalRestart(timeoutMs = 45000) {
    await wait(1800);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`/api/system/version?restartCheck=${Date.now()}`, {
                cache: 'no-store',
            });
            if (response.ok) return true;
        } catch (_error) {
            // El corte de conexión es esperado mientras systemd levanta NOPAL.
        }
        await wait(1000);
    }
    return false;
}

const updatesApplyBtn = document.getElementById('updates-apply-btn');
if (updatesApplyBtn) {
    updatesApplyBtn.addEventListener('click', async () => {
        const changelogEl = document.getElementById('updates-changelog');
        const label = updatesApplyBtn.querySelector('span');
        const originalLabel = label ? label.textContent : '';

        if (!(await confirmSafeSystemUpdate())) return;

        updatesApplyBtn.disabled = true;
        if (label) label.textContent = t('updatesApplying');

        try {
            const response = await fetch('/api/system/update', { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || t('updatesApplyError'));

            if (changelogEl) {
                changelogEl.hidden = false;
                if (data.updated && data.commits && data.commits.length) {
                    const statusMessage = data.dependency_install_failed
                        ? t('updatesDependencyInstallFailed')
                        : (data.restart_scheduled ? t('updatesRestarting') : t('updatesManualRestart'));
                    changelogEl.innerHTML = `
                        <div class="updates-changelog-title">${escapeHtml(t('updatesAppliedTitle'))}</div>
                        <ul>${data.commits.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
                        <div class="updates-changelog-title" style="margin-top:8px;">${escapeHtml(statusMessage)}</div>
                    `;
                } else {
                    changelogEl.innerHTML = `<div class="updates-changelog-title">${escapeHtml(t('updatesAlreadyCurrent'))}</div>`;
                }
            }

            if (data.updated && data.restart_scheduled) {
                if (label) label.textContent = t('updatesRestarting');
                const serviceReady = await waitForNopalRestart();
                if (!serviceReady) throw new Error(t('updatesRestartTimeout'));
                window.location.reload();
                return;
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
        if (pluginsLoaded) renderPluginsGallery();
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
    if (settingsOnboardingHints) {
        localStorage.setItem('onboardingHintsEnabled', settingsOnboardingHints.checked ? 'true' : 'false');
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
if (settingsOnboardingHints) {
    settingsOnboardingHints.addEventListener('change', saveSettings);
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
        if (card.id === 'custom-theme-card' || card.id === 'nopal-theme-card' || card.id === 'light-theme-card' || card.id === 'red-theme-card') return;
        card.addEventListener('click', () => {
            const selectedTheme = card.dataset.theme;
            if (settingsTheme) settingsTheme.value = selectedTheme;
            setActiveThemeCard(selectedTheme);
            saveSettings();
        });
    });
}

// ── Fondos de NOPAL Style / Desert / Red: cada tarjeta de tema muestra
// sus propias 3 miniaturas fijas (no upload libre como el tema
// personalizado), pero cualquier miniatura -- sea de la fila del tema que
// sea -- se puede aplicar a CUALQUIER tema: el clic siempre actúa sobre el
// tema actualmente seleccionado (settingsTheme.value), no sobre el dueño
// de la fila. Por eso el localStorage guarda la URL completa elegida (no
// un índice 0/1/2 dentro de las opciones fijas de ESE tema) -- necesario
// para poder guardar, por ejemplo, un fondo de Desert como fondo de Red.
const NOPAL_WALLPAPER_KEY = 'nopalThemeWallpaper';
const NOPAL_WALLPAPER_OPTIONS = [
    '/static/img/fondo_NOPAL_RED.png',
    '/static/img/fondo_NOPAL_GREEN_2.png',
    '/static/img/fondo_NOPAL_GREEN_3.png',
];
const LIGHT_WALLPAPER_KEY = 'lightThemeWallpaper';
const LIGHT_WALLPAPER_OPTIONS = [
    '/static/img/fondo_NOPAL_DESERT_1.png',
    '/static/img/fondo_NOPAL_DESERT_2.png',
    '/static/img/fondoClaro3.png',
];
const AI_WALLPAPER_KEY = 'aiThemeWallpaper';
const AI_WALLPAPER_OPTIONS = [
    '/static/img/FONDO1_IA.jpg',
    '/static/img/FONDO2_IA.jpg',
    '/static/img/FONDO3_IA.jpg',
];
const RED_WALLPAPER_KEY = 'redThemeWallpaper';
const RED_WALLPAPER_OPTIONS = [
    '/static/img/fondo_NOPAL_GRAY.png',
    '/static/img/fondo_NOPAL_ROJO_2.png',
    '/static/img/fondo_NOPAL_ROJO_3.png',
];

const THEME_WALLPAPER_CONFIG = {
    green: { storageKey: NOPAL_WALLPAPER_KEY, cssVar: '--nopal-wallpaper', options: NOPAL_WALLPAPER_OPTIONS },
    light: { storageKey: LIGHT_WALLPAPER_KEY, cssVar: '--light-wallpaper', options: LIGHT_WALLPAPER_OPTIONS },
    red: { storageKey: RED_WALLPAPER_KEY, cssVar: '--red-wallpaper', options: RED_WALLPAPER_OPTIONS },
    ai: { storageKey: AI_WALLPAPER_KEY, cssVar: '--ai-wallpaper', options: AI_WALLPAPER_OPTIONS },
};

function getThemeWallpaperUrl(theme) {
    const config = THEME_WALLPAPER_CONFIG[theme];
    if (!config) return null;
    return localStorage.getItem(config.storageKey) || config.options[0];
}

function applyThemeWallpaper(theme) {
    const config = THEME_WALLPAPER_CONFIG[theme];
    if (!config) return;
    document.documentElement.style.setProperty(config.cssVar, `url('${getThemeWallpaperUrl(theme)}')`);
}

// El anillo "activo" de cada miniatura refleja el fondo REAL del tema
// actualmente seleccionado -- por eso puede prenderse en la fila de un
// tema distinto al que tiene esa miniatura (ej. Red usando un fondo de
// Desert prende el anillo en la fila de Desert, no en la de Red).
function refreshWallpaperThumbActiveStates() {
    const activeTheme = settingsTheme?.value || localStorage.getItem('theme') || 'dark';
    const activeUrl = getThemeWallpaperUrl(activeTheme);
    document.querySelectorAll('.theme-option-wallpaper-thumb').forEach(btn => {
        const src = btn.querySelector('img')?.getAttribute('src');
        btn.classList.toggle('active', Boolean(activeUrl) && src === activeUrl);
    });
}

function setActiveThemeWallpaper(imageUrl) {
    const activeTheme = settingsTheme?.value || localStorage.getItem('theme') || 'dark';
    const config = THEME_WALLPAPER_CONFIG[activeTheme];
    if (!config) return; // Dark/Custom no tienen fondo de imagen seleccionable acá.
    localStorage.setItem(config.storageKey, imageUrl);
    applyThemeWallpaper(activeTheme);
    refreshWallpaperThumbActiveStates();
}

function applyAllThemeWallpapers() {
    Object.keys(THEME_WALLPAPER_CONFIG).forEach(applyThemeWallpaper);
    refreshWallpaperThumbActiveStates();
}

const nopalThemeSelectBtn = document.getElementById('nopal-theme-select-btn');
if (nopalThemeSelectBtn) {
    nopalThemeSelectBtn.addEventListener('click', () => {
        if (settingsTheme) settingsTheme.value = 'green';
        setActiveThemeCard('green');
        saveSettings();
        refreshWallpaperThumbActiveStates();
    });
}

const lightThemeSelectBtn = document.getElementById('light-theme-select-btn');
if (lightThemeSelectBtn) {
    lightThemeSelectBtn.addEventListener('click', () => {
        if (settingsTheme) settingsTheme.value = 'light';
        setActiveThemeCard('light');
        saveSettings();
        refreshWallpaperThumbActiveStates();
    });
}

const aiThemeSelectBtn = document.getElementById('ai-theme-select-btn');
if (aiThemeSelectBtn) {
    aiThemeSelectBtn.addEventListener('click', () => {
        if (settingsTheme) settingsTheme.value = 'ai';
        setActiveThemeCard('ai');
        saveSettings();
        refreshWallpaperThumbActiveStates();
    });
}

const redThemeSelectBtn = document.getElementById('red-theme-select-btn');
if (redThemeSelectBtn) {
    redThemeSelectBtn.addEventListener('click', () => {
        if (settingsTheme) settingsTheme.value = 'red';
        setActiveThemeCard('red');
        saveSettings();
        refreshWallpaperThumbActiveStates();
    });
}

document.querySelectorAll('.theme-option-wallpaper-thumb').forEach(btn => {
    btn.addEventListener('click', event => {
        event.stopPropagation();
        const url = btn.querySelector('img')?.getAttribute('src');
        if (url) setActiveThemeWallpaper(url);
    });
    // Miniatura sin archivo subido todavía -- se reemplaza por un
    // placeholder en vez de dejar el ícono de imagen rota del navegador.
    btn.querySelector('img')?.addEventListener('error', () => btn.classList.add('is-missing'), { once: true });
});
applyAllThemeWallpapers();

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

const viewGridMarlinBtn = document.getElementById('view-grid-marlin');
const viewListMarlinBtn = document.getElementById('view-list-marlin');

if (viewGridMarlinBtn) {
    viewGridMarlinBtn.addEventListener('click', () => updatePrintersViewMode('grid'));
}
if (viewListMarlinBtn) {
    viewListMarlinBtn.addEventListener('click', () => updatePrintersViewMode('list'));
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
applyDeviceColumnsLayout();
(() => {
    const mode = getDevicesGroupMode();
    devicesGroupModeBtn?.classList.toggle('btn-view-toggle-active', mode === 'mixed');
    if (machinesColumns) machinesColumns.hidden = mode === 'mixed';
    if (machinesMixedGrid) machinesMixedGrid.hidden = mode !== 'mixed';
})();

// Los 6 botones de dispositivo del sidebar (Láser/CNC/Marlin/Elegoo/
// FlashForge/Bambu) arrancan `hidden` en el HTML y solo se muestran cuando
// ya existe al menos un dispositivo de esa categoría -- mismo patrón que ya
// usa "Galería de plugins" (ver updateTopbarUser más arriba). El primer alta
// de cualquier categoría siempre es posible igual desde Configuración >
// Dispositivos (ese flujo no depende de estos botones -- ver
// marlin-printers-discover-btn/elegoo-printers-discover-btn/etc. en
// index.html), así que ocultarlos hasta que haya algo que gestionar no deja
// a nadie sin forma de dar de alta su primer dispositivo.
function setDeviceNavHidden(section, hidden) {
    const btn = document.querySelector(`.nav-item[data-section="${section}"]`);
    if (btn) btn.hidden = hidden;
}

async function refreshDeviceNavVisibility() {
    // Láser/CNC: reusa la lista que refreshDashboardLaserCard ya mantiene
    // fresca para el dashboard -- conteo de dispositivos registrados real,
    // no el post-filtro "mostrar offline" que usa lastDeviceCategoryCounts.
    setDeviceNavHidden('laser', !dashboardLaserEntries.some(e => (e.kind || 'laser') !== 'cnc'));
    setDeviceNavHidden('cnc', !dashboardLaserEntries.some(e => e.kind === 'cnc'));

    const checkBrand = async (section, url) => {
        try {
            const res = await fetch(url);
            if (!res.ok) return;
            const data = await res.json();
            setDeviceNavHidden(section, !(data.printers && data.printers.length > 0));
        } catch {
            // Sin red o error puntual: no tocar el estado actual del botón.
        }
    };
    await Promise.all([
        checkBrand('marlin', '/api/marlin-printers/registry'),
        checkBrand('elegoo', '/api/elegoo/printers'),
        checkBrand('bambu', '/api/bambu/printers'),
    ]);
}

// FlashForge queda fuera del refresco periódico de arriba a propósito: a
// diferencia de Marlin/Elegoo/Bambu, GET /api/flashforge/printers hace un
// /detail real por impresora registrada (ver flashforge_printers.py) --
// repetirlo de fondo cada 20s solo para decidir si el botón del sidebar se
// ve tiene un costo real si esa impresora está apagada. Se resuelve una
// sola vez al cargar la página.
async function refreshFlashforgeNavVisibility() {
    try {
        const res = await fetch('/api/flashforge/printers');
        if (!res.ok) return;
        const data = await res.json();
        setDeviceNavHidden('flashforge', !(data.printers && data.printers.length > 0));
    } catch {
        // no-op
    }
}

// Update language display on load
updateLangSwitchUI();
updatePageLanguage();

renderPrintQueue();
renderInitialDeviceLoaders();
loadModels();
loadPrinters();
loadDashboardStandalonePrinters();
loadRecentPrinterFiles();
loadLaserHistory();
loadDashboardPanel();
updatePanelClock();
refreshDashboardLaserCard();
refreshUsbPorts();
loadAccessories();
loadAccessoryArduinoDiscoverList();
loadDashboardMatrixPreview();
refreshDeviceNavVisibility();
refreshFlashforgeNavVisibility();
maybeStartTour('dashboard');

// loadPrinters ya queda programado por setupPrinterRefresh(), que además
// respeta la preferencia del usuario. No crear un segundo intervalo aquí.
setInterval(loadDashboardStandalonePrinters, 10000);
setInterval(loadDashboardPanel, 10000);
setInterval(updatePanelClock, 1000);
setInterval(loadAccessories, 10000);
setInterval(loadDashboardMatrixPreview, 10000);
// Antes cada 4s — con 6 dispositivos registrados en paralelo, cada uno
// pudiendo tardar hasta ~8s en darse por vencido si está apagado/desconectado
// (5s de ensure_listener_ready + 3s de espera de respuesta en get_status),
// los ciclos se apilaban entre sí y competían por la única conexión que cada
// placa GRBL soporta — eso era la causa real de "se desconecta seguido y la
// página queda lenta". 20s conserva el aviso de conexión/desconexión
// (checkLaserConnectionTransitions) sin la contención constante.
setInterval(refreshDashboardLaserCard, 20000);
setInterval(refreshUsbPorts, 8000);
setInterval(refreshDeviceNavVisibility, 20000);

// Badge de cola de Láser/CNC en el sidebar: independiente de si el usuario
// está dentro de esas secciones (startLaserPolling/startCncPolling se
// detienen al salir de Láser/CNC, pero el badge del sidebar debe seguir
// actualizado desde cualquier otra sección).
refreshLaserCncQueueBadgesGlobal();
setInterval(refreshLaserCncQueueBadgesGlobal, 5000);

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

// ── Configuración > TUNA-Screen ──

let tunascreenCodeCountdownTimer = null;

async function loadTunascreenSettings() {
    const card = document.getElementById('tunascreen-settings-card');
    if (!card) return;
    if (!currentAuthUser || currentAuthUser.role !== 'admin') {
        card.hidden = true;
        return;
    }
    card.hidden = false;
    // El botón "Generar código" se bindea una sola vez -- este loader se
    // vuelve a llamar cada vez que se entra a Configuración (ver
    // switchSection), y re-bindear en cada visita apilaría listeners.
    if (!card.dataset.bound) {
        card.dataset.bound = '1';
        document.getElementById('tunascreen-generate-code-btn')?.addEventListener('click', handleTunascreenGenerateCode);
    }
    loadTunascreenDevices();
}

async function loadTunascreenDevices() {
    const container = document.getElementById('tunascreen-devices-list');
    if (!container) return;
    try {
        const response = await fetch('/api/tunascreen/devices');
        if (!response.ok) throw new Error();
        const data = await response.json();
        renderTunascreenDevicesList(data.devices || []);
    } catch (error) {
        console.error(error);
        renderTunascreenDevicesList([]);
    }
}

async function handleTunascreenGenerateCode() {
    try {
        const response = await fetch('/api/tunascreen/pair/start', { method: 'POST' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        showTunascreenCode(data.code, data.expires_in);
    } catch (error) {
        console.error(error);
        appAlert(t('tunascreenGenerateError'), '', 'danger');
    }
}

// Cuenta regresiva en vivo -- el código dura 5 minutos y es de un solo uso
// (ver tunascreen_service.py), así que mostrar cuánto le queda evita que
// alguien lo tipee en la tablet después de que ya venció.
function showTunascreenCode(code, expiresInSeconds) {
    const display = document.getElementById('tunascreen-code-display');
    const valueEl = document.getElementById('tunascreen-code-value');
    const expiryEl = document.getElementById('tunascreen-code-expiry');
    if (!display || !valueEl || !expiryEl) return;

    display.hidden = false;
    valueEl.textContent = code;

    if (tunascreenCodeCountdownTimer) clearInterval(tunascreenCodeCountdownTimer);
    let remaining = expiresInSeconds;
    const renderCountdown = () => {
        if (remaining <= 0) {
            clearInterval(tunascreenCodeCountdownTimer);
            display.hidden = true;
            return;
        }
        const minutes = Math.floor(remaining / 60);
        const seconds = String(remaining % 60).padStart(2, '0');
        expiryEl.textContent = t('tunascreenCodeExpiry').replace('{time}', `${minutes}:${seconds}`);
        remaining -= 1;
    };
    renderCountdown();
    tunascreenCodeCountdownTimer = setInterval(renderCountdown, 1000);
}

function renderTunascreenDevicesList(devices) {
    const container = document.getElementById('tunascreen-devices-list');
    if (!container) return;
    if (!devices.length) {
        container.innerHTML = `<div class="empty-state-small">${escapeHtml(t('tunascreenDevicesEmpty'))}</div>`;
        return;
    }

    container.innerHTML = devices.map(device => `
        <div class="usb-port-item" data-id="${escapeHtml(device.device_id)}">
            <div class="usb-port-item-info">
                <strong>${escapeHtml(device.name)}</strong>
                <span>${device.last_seen ? escapeHtml(t('tunascreenLastSeen').replace('{date}', new Date(device.last_seen * 1000).toLocaleString())) : escapeHtml(t('tunascreenNeverConnected'))}</span>
            </div>
            <button type="button" class="theme-option-icon-btn theme-option-icon-btn-danger tunascreen-device-revoke-btn" data-id="${escapeHtml(device.device_id)}" title="${escapeHtml(t('tunascreenRevoke'))}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.tunascreen-device-revoke-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!(await appConfirm(t('tunascreenRevokeConfirm'), t('tunascreenRevoke')))) return;
            try {
                const response = await fetch(`/api/tunascreen/devices/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
                if (!response.ok) throw new Error();
                loadTunascreenDevices();
            } catch (error) {
                console.error(error);
                appAlert(t('tunascreenRevokeError'), '', 'danger');
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


// ===========================================================================
// NOPAL Intelligence
// ---------------------------------------------------------------------------
// La vista del asistente se alimenta de /api/ai/tools/* -- exactamente las
// mismas funciones de solo lectura que consulta el modelo. Así la pantalla y
// la IA nunca pueden discrepar sobre el estado del taller: si una tarjeta dice
// que el láser está desconectado, es porque la herramienta lo reportó así, no
// porque el frontend lo calcule por su cuenta.
//
// Todo el color sale de las variables CSS del tema (ver style.css), nunca
// hardcodeado -- esta sección tiene que verse bien en claro, oscuro, verde,
// rojo y personalizado igual que el resto de NOPAL.
// ===========================================================================

const AI_API_KEY_UNCHANGED = '__unchanged__';

let aiPresets = [];
let aiDataSent = [];
let aiConfigCache = null;
let aiBusy = false;
let aiConversationId = null;

// Una acción de riesgo NO se ejecutó: el backend la dejó esperando. Se pinta
// con lo que va a pasar en texto claro, porque confirmar a ciegas un
// "precalentar a 200" es justo lo que los niveles de riesgo evitan.
function aiRenderPendingAction(pendiente) {
    const thread = document.getElementById('ai-thread');
    if (!thread) return;
    const caja = document.createElement('div');
    caja.className = 'ai-pending-action';
    const args = Object.entries(pendiente.arguments || {})
        .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`).join(' · ');
    caja.innerHTML = `
        <div class="ai-pending-head">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>${escapeHtml(t('aiConfirmNeeded'))}</span>
        </div>
        <p class="ai-pending-what"><strong>${escapeHtml(pendiente.action)}</strong>${args ? ' — ' + args : ''}</p>
        <div class="ai-pending-actions">
            <button type="button" class="btn-file-action btn-file-action-accent" data-confirm>${escapeHtml(t('aiConfirmRun'))}</button>
            <button type="button" class="btn-file-action" data-cancel>${escapeHtml(t('cancelAction'))}</button>
        </div>`;
    thread.appendChild(caja);
    thread.scrollTop = thread.scrollHeight;

    const cerrar = (texto, tono) => {
        caja.innerHTML = `<div class="ai-pending-done" data-tone="${tono}">${escapeHtml(texto)}</div>`;
    };

    caja.querySelector('[data-confirm]').addEventListener('click', async () => {
        caja.querySelectorAll('button').forEach(b => (b.disabled = true));
        try {
            await aiFetchJson(`/api/ai/actions/${pendiente.id}/confirm`, { method: 'POST' });
            cerrar(t('aiActionDone'), 'ok');
        } catch (error) {
            cerrar(error.message, 'error');
        }
    });
    caja.querySelector('[data-cancel]').addEventListener('click', async () => {
        caja.querySelectorAll('button').forEach(b => (b.disabled = true));
        try { await aiFetchJson(`/api/ai/actions/${pendiente.id}/cancel`, { method: 'POST' }); } catch (_) {}
        cerrar(t('aiActionCancelled'), 'muted');
    });
}

// Guardadas por el usuario. Vacío = usar las de fábrica, que sí se traducen.
let aiStoredSuggestions = [];

function aiSuggestedQuestions() {
    if (aiStoredSuggestions.length) return aiStoredSuggestions;
    return [
        t('aiSuggestWorkshop'),
        t('aiSuggestAvailable'),
        t('aiSuggestErrors'),
    ];
}

async function aiLoadSuggestions() {
    try {
        const data = await aiFetchJson('/api/ai/suggestions');
        aiStoredSuggestions = data.suggestions || [];
    } catch (_) {
        aiStoredSuggestions = [];
    }
}

function aiRenderSuggestionEditor() {
    const rows = document.getElementById('ai-suggestions-rows');
    if (!rows) return;
    // Al editar se parte de lo que se ve hoy, sean guardadas o de fábrica:
    // así el usuario ajusta las de fábrica en vez de empezar de cero.
    const base = aiStoredSuggestions.length ? aiStoredSuggestions : aiSuggestedQuestions();
    rows.innerHTML = base.map((texto, i) => `
        <div class="ai-suggestion-row">
            <input type="text" class="ai-text-input" data-suggestion-index="${i}" value="${escapeHtml(texto)}" maxlength="120">
            <button type="button" class="btn-file-action" data-suggestion-remove="${i}" title="${escapeHtml(t('aiDelete'))}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>`).join('');

    rows.querySelectorAll('[data-suggestion-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
            const i = Number(btn.dataset.suggestionRemove);
            const actuales = aiReadSuggestionEditor();
            actuales.splice(i, 1);
            aiStoredSuggestions = actuales;
            aiRenderSuggestionEditor();
        });
    });
}

function aiReadSuggestionEditor() {
    return Array.from(document.querySelectorAll('[data-suggestion-index]'))
        .map(input => input.value.trim())
        .filter(Boolean);
}

async function aiSaveSuggestions() {
    // Una lista vacía es válida (significa "usa las de fábrica"), pero solo
    // si el usuario borró las filas a mano, no si el editor no se renderizó.
    if (!document.getElementById('ai-suggestions-rows')) return;
    try {
        const data = await aiFetchJson('/api/ai/suggestions', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suggestions: aiReadSuggestionEditor() }),
        });
        aiStoredSuggestions = data.suggestions || [];
        aiRenderSuggestionEditor();
        aiRenderSuggestions();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function aiFetchJson(url, options = {}) {
    const response = await fetch(url, options);
    let payload = null;
    try {
        payload = await response.json();
    } catch (_) {
        payload = null;
    }
    if (!response.ok) {
        const error = new Error(payload?.detail || `HTTP ${response.status}`);
        // Campo hermano de `detail` (ver backend/api/ai.py): segundos que el
        // proveedor pidió esperar. Se propaga en el Error para que quien
        // atrape sepa que esto no es una falla cualquiera, sino una espera.
        error.retryAfter = payload?.retry_after ?? null;
        throw error;
    }
    return payload;
}

// --- Enfriamiento tras un límite de cuota ----------------------------------
// Cuando el proveedor responde "límite alcanzado, reintenta en 4.5s", ese
// dato llega en retry_after y aquí se vuelve un cronómetro en cuenta
// regresiva. Sin él el usuario solo ve un error rojo, vuelve a preguntar de
// inmediato y gasta cuota justo cuando no la tiene, alargando la espera.
// El estado es uno solo para toda la app: la sección de IA y el panel de
// Inicio pegan al mismo proveedor, así que la espera de uno es la del otro.

let aiCooldownUntil = 0;
let aiCooldownTotal = 0;
let aiCooldownTimer = null;

function aiCooldownRemaining() {
    return Math.max(0, (aiCooldownUntil - Date.now()) / 1000);
}

function aiStartCooldown(segundos) {
    const espera = Number(segundos);
    if (!Number.isFinite(espera) || espera <= 0) return;
    const hasta = Date.now() + espera * 1000;
    // Si ya corría una espera más larga, se respeta: acortarla solo
    // provocaría otro rechazo del proveedor.
    if (hasta <= aiCooldownUntil) return;
    aiCooldownUntil = hasta;
    aiCooldownTotal = espera;
    if (aiCooldownTimer) clearInterval(aiCooldownTimer);
    aiCooldownTimer = setInterval(aiCooldownTick, 100);
    aiCooldownTick();
}

function aiCooldownTick() {
    const restante = aiCooldownRemaining();
    if (restante <= 0) aiEndCooldown();
    else aiRenderCooldown(restante);
}

function aiEndCooldown() {
    if (aiCooldownTimer) clearInterval(aiCooldownTimer);
    aiCooldownTimer = null;
    aiCooldownUntil = 0;
    aiCooldownTotal = 0;
    document.querySelectorAll('.ai-cooldown').forEach(nodo => { nodo.hidden = true; });
    aiSetComposersDisabled(false);
}

function aiFormatCooldown(restante) {
    // Bajo un minuto se muestran décimas: un contador de enteros en una
    // espera de 4 s parece congelado.
    if (restante < 60) return `${restante.toFixed(1)}s`;
    return `${Math.floor(restante / 60)}:${String(Math.floor(restante % 60)).padStart(2, '0')}`;
}

function aiRenderCooldown(restante) {
    // El aro tiene radio 15.9155 (circunferencia 100), así que el desfase
    // del trazo es directamente el porcentaje ya transcurrido.
    const proporcion = aiCooldownTotal > 0 ? Math.min(1, restante / aiCooldownTotal) : 0;
    document.querySelectorAll('.ai-cooldown').forEach(nodo => {
        nodo.hidden = false;
        const tiempo = nodo.querySelector('[data-cooldown-time]');
        if (tiempo) tiempo.textContent = aiFormatCooldown(restante);
        const aro = nodo.querySelector('.ai-cooldown-progress');
        if (aro) aro.style.strokeDashoffset = String(100 - proporcion * 100);
    });
    aiSetComposersDisabled(true);
}

function aiSetComposersDisabled(bloqueado) {
    document.querySelectorAll('#ai-composer, #panel-ai-composer').forEach(form => {
        form.querySelectorAll('input, button').forEach(el => { el.disabled = bloqueado; });
    });
    document.querySelectorAll('#ai-suggestions .ai-suggestion, #panel-ai-suggestions .ai-suggestion')
        .forEach(btn => { btn.disabled = bloqueado; });
}

// --- Configuración (Ajustes → Inteligencia artificial) ---------------------

function aiCurrentPreset() {
    return aiPresets.find(p => p.id === document.getElementById('ai-preset')?.value) || null;
}

function aiUpdatePresetUi() {
    const preset = aiCurrentPreset();
    const note = document.getElementById('ai-preset-note');
    const warning = document.getElementById('ai-public-warning');
    const keyField = document.getElementById('ai-api-key-field');
    if (note) note.textContent = preset?.note || '';
    // El aviso de datos aparece por lo que el usuario ESTÁ eligiendo, no por
    // lo que ya guardó: tiene que verlo antes de aceptar, no después.
    if (warning) warning.hidden = !preset?.cloud;
    if (keyField) keyField.hidden = false;
}

function aiRenderPresets() {
    const select = document.getElementById('ai-preset');
    if (!select) return;
    select.innerHTML = aiPresets
        .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
        .join('');

    const list = document.getElementById('ai-data-sent');
    if (list) {
        list.innerHTML = aiDataSent.map(item => `<li>${escapeHtml(item)}</li>`).join('');
    }
}

// Niveles del modo automático (backend/services/ai_router.py::TIERS). El
// orden es el que se pinta en el formulario.
const AI_TIERS = ['fast', 'medium', 'reasoning', 'vision', 'agent'];

function aiTierModelsFromForm() {
    const tabla = {};
    AI_TIERS.forEach(tier => {
        const valor = (document.getElementById(`ai-tier-${tier}`)?.value || '').trim();
        if (valor) tabla[tier] = valor;
    });
    return tabla;
}

function aiUpdateModelModeUi() {
    const auto = document.querySelector('input[name="ai-model-mode"]:checked')?.value === 'auto';
    const bloque = document.getElementById('ai-tier-models');
    if (bloque) {
        bloque.hidden = !auto;
        // Abierto al activarlo: si queda cerrado, el usuario prende el modo
        // automático y no ve que hay modelos que configurar.
        if (auto) bloque.open = true;
    }
}

function aiPresetIdForUrl(baseUrl) {
    if (!baseUrl) return 'local';
    const match = aiPresets.find(p => p.base_url && p.base_url === baseUrl);
    return match ? match.id : 'custom';
}

function aiFillConfigForm(config) {
    aiConfigCache = config;
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
    const check = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };

    check('ai-enabled', config.enabled);
    set('ai-name', config.name);
    set('ai-base-url', config.base_url);
    set('ai-model', config.model);
    set('ai-timeout', config.timeout_s);
    set('ai-tool-mode', config.tool_mode);
    set('ai-tool-profile', config.tool_profile);
    check('ai-allow-public', config.allow_public_endpoint);
    check('ai-actions-enabled', config.actions_enabled);

    const modo = config.model_mode === 'auto' ? 'auto' : 'fixed';
    const radio = document.querySelector(`input[name="ai-model-mode"][value="${modo}"]`);
    if (radio) radio.checked = true;
    const tabla = config.tier_models || {};
    AI_TIERS.forEach(tier => set(`ai-tier-${tier}`, tabla[tier]));
    aiUpdateModelModeUi();

    const select = document.getElementById('ai-preset');
    if (select) select.value = aiPresetIdForUrl(config.base_url);

    // La clave nunca baja al navegador. Si el servidor dice que hay una
    // guardada se muestra un relleno visual, y al guardar se manda el
    // centinela para conservarla (ver API_KEY_UNCHANGED en el backend).
    const keyInput = document.getElementById('ai-api-key');
    if (keyInput) {
        keyInput.value = config.api_key_set ? AI_API_KEY_UNCHANGED : '';
        keyInput.dataset.untouched = config.api_key_set ? 'true' : 'false';
    }

    // Campos forzados por variables de entorno: se bloquean en vez de dejar
    // que el usuario "guarde" un cambio que el entorno va a pisar igual.
    const locked = new Set(config.env_locked_fields || []);
    const lockMap = {
        enabled: 'ai-enabled', base_url: 'ai-base-url', model: 'ai-model',
        timeout_s: 'ai-timeout', tool_mode: 'ai-tool-mode',
        tool_profile: 'ai-tool-profile', allow_public_endpoint: 'ai-allow-public',
    };
    Object.entries(lockMap).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = locked.has(key);
        if (locked.has(key)) el.title = t('aiEnvLocked');
    });

    aiUpdatePresetUi();
    aiUpdateNavVisibility(config.enabled);
}

function aiReadConfigForm() {
    const val = id => document.getElementById(id)?.value ?? '';
    const checked = id => !!document.getElementById(id)?.checked;
    const keyInput = document.getElementById('ai-api-key');
    return {
        enabled: checked('ai-enabled'),
        provider: 'openai-compatible',
        base_url: val('ai-base-url').trim(),
        model: val('ai-model').trim(),
        api_key: keyInput?.dataset.untouched === 'true' ? AI_API_KEY_UNCHANGED : (keyInput?.value ?? ''),
        timeout_s: Number(val('ai-timeout')) || 60,
        tool_mode: val('ai-tool-mode') || 'auto',
        tool_profile: val('ai-tool-profile') || 'full',
        allow_public_endpoint: checked('ai-allow-public'),
        actions_enabled: checked('ai-actions-enabled'),
        model_mode: document.querySelector('input[name="ai-model-mode"]:checked')?.value || 'fixed',
        tier_models: aiTierModelsFromForm(),
    };
}

function aiShowTestResult(message, tone) {
    const el = document.getElementById('ai-test-result');
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone;
}

// null = el formulario está creando una IA nueva; un id = la está editando.
let aiEditingId = null;

function aiRenderProviders(data) {
    const list = document.getElementById('ai-providers-list');
    if (!list) return;
    const providers = data.providers || [];
    if (!providers.length) {
        list.innerHTML = `<p class="ai-empty">${escapeHtml(t('aiNoProviders'))}</p>`;
        return;
    }
    list.innerHTML = providers.map(p => `
        <div class="ai-provider-row${p.active ? ' is-active' : ''}" data-id="${escapeHtml(p.id)}">
            <div class="ai-provider-info">
                <span class="ai-provider-name">${escapeHtml(p.name || p.base_url)}${p.active ? `<span class="ai-provider-badge">${escapeHtml(t('aiActive'))}</span>` : ''}</span>
                <span class="ai-provider-meta">${escapeHtml(p.model || '—')} · ${escapeHtml(p.base_url)}</span>
            </div>
            <div class="ai-provider-actions">
                ${p.active ? '' : `<button type="button" class="btn-file-action" data-ai-act="activate">${escapeHtml(t('aiUseThis'))}</button>`}
                <button type="button" class="btn-file-action" data-ai-act="edit">${escapeHtml(t('aiEdit'))}</button>
                <button type="button" class="btn-file-action" data-ai-act="delete">${escapeHtml(t('aiDelete'))}</button>
            </div>
        </div>`).join('');

    list.querySelectorAll('[data-ai-act]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const row = btn.closest('.ai-provider-row');
            const id = row?.dataset.id;
            const accion = btn.dataset.aiAct;
            if (!id) return;
            try {
                if (accion === 'activate') {
                    await aiFetchJson(`/api/ai/providers/${id}/activate`, { method: 'POST' });
                    showToast(t('aiActivated'), 'success');
                } else if (accion === 'delete') {
                    // Borrar una IA guardada tira su dirección y su clave: se
                    // confirma, igual que cualquier borrado en NOPAL.
                    const nombre = row.querySelector('.ai-provider-name')?.textContent || '';
                    if (!confirm(`${t('aiDeleteConfirm')}\n\n${nombre}`)) return;
                    await aiFetchJson(`/api/ai/providers/${id}`, { method: 'DELETE' });
                    if (aiEditingId === id) aiResetProviderForm();
                    showToast(t('aiDeleted'), 'success');
                } else if (accion === 'edit') {
                    const actual = (aiProvidersCache.providers || []).find(x => x.id === id);
                    if (actual) aiEditProvider(actual);
                    return;
                }
                await loadAiSettings();
            } catch (error) {
                showToast(error.message, 'error');
            }
        });
    });
}

let aiProvidersCache = { providers: [] };

function aiEditProvider(provider) {
    aiEditingId = provider.id;
    aiFillConfigForm({ ...provider, enabled: aiProvidersCache.enabled });
    const title = document.getElementById('ai-form-title');
    if (title) title.textContent = `${t('aiEditing')}: ${provider.name || provider.base_url}`;
    const cancel = document.getElementById('ai-cancel-btn');
    if (cancel) cancel.hidden = false;
    document.getElementById('ai-settings-fields')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function aiResetProviderForm() {
    aiEditingId = null;
    aiFillConfigForm({ ...DEFAULT_AI_FORM, enabled: aiProvidersCache.enabled });
    const title = document.getElementById('ai-form-title');
    if (title) title.textContent = t('aiNewProvider');
    const cancel = document.getElementById('ai-cancel-btn');
    if (cancel) cancel.hidden = true;
    aiShowTestResult('', '');
}

const DEFAULT_AI_FORM = {
    name: '', base_url: '', model: '', api_key_set: false, timeout_s: 60,
    tool_mode: 'auto', tool_profile: 'full', allow_public_endpoint: false,
    env_locked_fields: [],
};

async function loadAiSettings() {
    if (currentAuthUser?.role !== 'admin') return;
    try {
        if (!aiPresets.length) {
            const data = await aiFetchJson('/api/ai/presets');
            aiPresets = data.presets || [];
            aiDataSent = data.data_sent || [];
            aiRenderPresets();
        }
        await aiLoadSuggestions();
        aiRenderSuggestionEditor();
        aiProvidersCache = await aiFetchJson('/api/ai/providers');
        aiRenderProviders(aiProvidersCache);
        const activa = (aiProvidersCache.providers || []).find(p => p.active);
        // El interruptor global refleja el estado de la capa, no el de una
        // entrada; el resto del formulario muestra la IA que se está editando.
        const check = document.getElementById('ai-enabled');
        if (check) check.checked = !!aiProvidersCache.enabled;
        aiUpdateSettingsDimming(!!aiProvidersCache.enabled);
        if (aiEditingId === null && activa) aiEditProvider(activa);
        else if (!activa) aiResetProviderForm();
    } catch (error) {
        aiShowTestResult(error.message, 'error');
    }
}

async function saveAiSettings() {
    const button = document.getElementById('ai-save-btn');
    if (button) button.disabled = true;
    try {
        const cuerpo = aiReadConfigForm();
        cuerpo.name = document.getElementById('ai-name')?.value.trim() || '';
        // Sin id se crea una IA nueva; con id se actualiza la que se edita.
        const nueva = aiEditingId === null;
        const guardada = await aiFetchJson(
            nueva ? '/api/ai/providers' : `/api/ai/providers/${aiEditingId}`,
            {
                method: nueva ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cuerpo),
            },
        );
        aiEditingId = guardada.id;
        // Las preguntas rápidas tienen su propio botón. Guardarlas aquí leía
        // el DOM aunque el editor no estuviera renderizado -- y una lectura
        // vacía BORRABA las guardadas. Solo se arrastran si el editor existe
        // y tiene filas.
        if (document.querySelectorAll('[data-suggestion-index]').length) {
            await aiSaveSuggestions();
        }
        showToast(t('aiSaved'), 'success');
        aiShowTestResult('', '');
        await loadAiSettings();
    } catch (error) {
        showToast(error.message, 'error');
        aiShowTestResult(error.message, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

// El interruptor global no pertenece a ninguna IA guardada: enciende o apaga
// la capa entera, así que va por su propio endpoint.
async function setAiEnabled(enabled) {
    try {
        aiProvidersCache = await aiFetchJson('/api/ai/enabled', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        aiUpdateNavVisibility(!!aiProvidersCache.enabled);
        showToast(enabled ? t('aiTurnedOn') : t('aiTurnedOff'), 'success');
    } catch (error) {
        showToast(error.message, 'error');
        const check = document.getElementById('ai-enabled');
        if (check) check.checked = !enabled;  // revertir el visual si el backend dijo que no
    }
}

async function testAiConnection() {
    const button = document.getElementById('ai-test-btn');
    if (button) button.disabled = true;
    aiShowTestResult(t('aiTesting'), 'pending');
    try {
        // Se manda el formulario tal como está para poder probar ANTES de
        // guardar, que es lo que uno quiere al configurar por primera vez.
        const result = await aiFetchJson('/api/ai/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(aiReadConfigForm()),
        });
        if (!result.ok) {
            aiShowTestResult(result.error || t('aiTestFailed'), 'error');
            return;
        }
        const datalist = document.getElementById('ai-model-options');
        if (datalist) {
            datalist.innerHTML = (result.models || [])
                .map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
        }
        // Solo se rellena lo que esté vacío: nunca se pisa lo que el
        // usuario eligió a mano. Las sugerencias vienen de la lista real
        // del servidor, así que valen igual para Groq que para Ollama.
        const sugeridos = result.suggested_tier_models || {};
        AI_TIERS.forEach(tier => {
            const campo = document.getElementById(`ai-tier-${tier}`);
            if (campo && !campo.value.trim() && sugeridos[tier]) campo.value = sugeridos[tier];
        });
        aiShowTestResult(result.warning || t('aiTestOk'), result.warning ? 'warn' : 'ok');
    } catch (error) {
        aiShowTestResult(error.message, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

// --- Sección del asistente -------------------------------------------------

// El modo IA tiene DOS interruptores independientes (ver docs/MODO_IA_PLAN.md):
// la clase de tema decide los COLORES, y este atributo decide qué elementos
// EXISTEN. Separarlos es lo que permite tener la IA encendida con el tema
// oscuro y seguir viendo la píldora, la marca y la franja de capacidades.
const AI_THEME_BEFORE_KEY = 'themeBeforeAi';

function aiUpdateSettingsDimming(enabled) {
    // El gris es solo señal visual: los campos siguen siendo usables porque
    // configurar la IA es paso previo a poder encenderla.
    document.getElementById('ai-settings-body')?.classList.toggle('is-off', !enabled);
}

function aiApplyModeChrome(enabled) {
    aiUpdateSettingsDimming(enabled);
    const wasActive = document.body.getAttribute('data-ai-active') === 'true';
    // La pestaña de IA desaparece al apagar la capa; si era la visible hay
    // que devolver el panel a Trabajos o quedaría en blanco.
    if (!enabled && document.querySelector('[data-panel-tab="ai"]')?.classList.contains('active')) {
        aiSwitchPanelTab('jobs');
    }
    document.body.setAttribute('data-ai-active', enabled ? 'true' : 'false');
    if (enabled === wasActive) return;  // sin transición, no se toca el tema

    // Al encender la IA el ambiente completo cambia al tema 'ai', pero se
    // recuerda el anterior para devolverlo al apagar. Si mientras tanto el
    // usuario elige otro tema a mano, se respeta: al apagar solo se restaura
    // cuando el tema vigente sigue siendo 'ai'.
    const actual = document.body.getAttribute('data-theme');
    if (enabled) {
        if (actual !== 'ai') {
            try { localStorage.setItem(AI_THEME_BEFORE_KEY, actual || 'light'); } catch (_) {}
            applyTheme('ai');
        }
    } else if (actual === 'ai') {
        let previo = 'light';
        try { previo = localStorage.getItem(AI_THEME_BEFORE_KEY) || 'light'; } catch (_) {}
        applyTheme(previo);
    }
}

// El chrome del modo IA no puede esperar a que alguien entre a la sección de
// IA: si la capa está encendida, la píldora y la marca tienen que estar desde
// que carga la página.
async function aiInitModeChrome() {
    try {
        const status = await aiFetchJson('/api/ai/status');
        aiApplyModeChrome(!!status.enabled);
        aiUpdateNavVisibility(!!status.enabled);
    } catch (_) {
        aiApplyModeChrome(false);
    }
}

function aiUpdateNavVisibility(enabled) {
    const button = document.getElementById('nav-ai-btn');
    if (button) button.hidden = !enabled;
    aiApplyModeChrome(enabled);
}

// Render por tipo de máquina. Son las mismas ilustraciones del modo IA que
// ya usan las tarjetas del panel: una ficha con la foto de la máquina se
// reconoce de un vistazo, un rectángulo con texto no.
const AI_MACHINE_ART = {
    printer: '/static/img/3D_IA.webp',
    laser: '/static/img/LASER_IA.webp',
    cnc: '/static/img/CNC_IA.webp',
};

const AI_METRIC_ICONS = {
    temp: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
    bed: '<path d="M2 17h20"/><path d="M4 17V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8"/><path d="M6 17v2"/><path d="M18 17v2"/>',
    power: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    speed: '<path d="M12 20a8 8 0 1 0-8-8"/><path d="M12 12l4-3"/>',
    progress: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

function aiMetric(icon, value) {
    // Sin dato se muestra una raya, nunca un cero: un 0 °C leído como real
    // es peor que admitir que no se sabe.
    return `<span class="ai-machine-metric">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${AI_METRIC_ICONS[icon]}</svg>
        <span>${escapeHtml(value === null || value === undefined || value === '' ? '—' : String(value))}</span>
    </span>`;
}

function aiMachineTone(machine) {
    const estado = String(machine.status?.state || '').toLowerCase();
    if (!machine.online) return 'off';
    if (['error', 'alarm', 'alarma'].includes(estado)) return 'error';
    if (estado === 'paused') return 'warn';
    if (['printing', 'running', 'busy'].includes(estado)) return 'busy';
    return 'ok';
}

function aiMachineStateLabel(machine, tone) {
    const etiquetas = { off: 'aiOffline', error: 'aiStateAlert', warn: 'aiStatePaused', busy: 'aiWorking', ok: 'aiReady' };
    return t(etiquetas[tone] || 'aiReady');
}

function aiMachineMetrics(machine) {
    const st = machine.status || {};
    const grados = v => (Number.isFinite(v) ? `${Math.round(v)}°C` : null);
    const avance = Number.isFinite(st.job?.progress) ? `${Math.round(st.job.progress)}%` : null;

    if (machine.type === 'printer') {
        return aiMetric('temp', grados(st.hotend?.current)) +
               aiMetric('bed', grados(st.bed?.current)) +
               aiMetric('progress', avance);
    }
    // Láser y CNC no tienen boquilla ni cama: lo que importa es cuánta
    // potencia/giro se está entregando y a qué velocidad se mueve.
    const potencia = machine.type === 'cnc'
        ? (Number.isFinite(st.spindle_rpm) ? `${Math.round(st.spindle_rpm)} rpm` : null)
        : (Number.isFinite(st.laser_power) ? `S${Math.round(st.laser_power)}` : null);
    const velocidad = Number.isFinite(st.feed) ? `${Math.round(st.feed)} mm/m` : null;
    return aiMetric('power', potencia) + aiMetric('speed', velocidad) + aiMetric('progress', avance);
}

function aiMachineDetail(machine, tone) {
    const st = machine.status || {};
    if (!machine.online) return t('aiNoConnection');
    const job = st.job || {};
    if (Number.isFinite(job.progress) && job.progress > 0) {
        const archivo = job.filename ? ` · ${job.filename}` : '';
        return `${Math.round(job.progress)}%${archivo}`;
    }
    return t(tone === 'error' ? 'aiNeedsAttention' : 'aiIdle');
}

function aiMachineCard(machine) {
    const tone = aiMachineTone(machine);
    const art = AI_MACHINE_ART[machine.type] || AI_MACHINE_ART.printer;
    return `
        <article class="ai-machine-card" data-tone="${tone}">
            <div class="ai-machine-top">
                <span class="ai-machine-art"><img src="${art}" alt="" loading="lazy"></span>
                <span class="ai-machine-id">
                    <span class="ai-machine-name" title="${escapeHtml(machine.name || machine.id)}">${escapeHtml(machine.name || machine.id)}</span>
                    <span class="ai-machine-pill">${escapeHtml(aiMachineStateLabel(machine, tone))}</span>
                </span>
            </div>
            <p class="ai-machine-detail">${escapeHtml(aiMachineDetail(machine, tone))}</p>
            <div class="ai-machine-metrics">${aiMachineMetrics(machine)}</div>
        </article>`;
}

async function aiLoadMachines() {
    const container = document.getElementById('ai-machines');
    if (!container) return;
    try {
        const data = await aiFetchJson('/api/devices/registry');
        const machines = data.machines || [];
        container.innerHTML = machines.length
            ? machines.map(aiMachineCard).join('')
            : `<p class="ai-empty">${escapeHtml(t('aiNoMachines'))}</p>`;
    } catch (error) {
        container.innerHTML = `<p class="ai-empty">${escapeHtml(error.message)}</p>`;
    }
}

async function aiLoadEvents() {
    const container = document.getElementById('ai-events');
    if (!container) return;
    try {
        const data = await aiFetchJson('/api/ai/tools/get_recent_events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 12 }),
        });
        const events = (data.events || []).slice().reverse();
        container.innerHTML = events.length
            ? events.map(event => `
                <div class="ai-event" data-level="${escapeHtml((event.level || '').toLowerCase())}">
                    <span class="ai-event-dot"></span>
                    <div class="ai-event-body">
                        <span class="ai-event-message">${escapeHtml(event.message || '')}</span>
                        <span class="ai-event-meta">${escapeHtml(event.timestamp || '')} · ${escapeHtml(event.source || '')}</span>
                    </div>
                </div>`).join('')
            : `<p class="ai-empty">${escapeHtml(t('aiNoEvents'))}</p>`;
    } catch (error) {
        container.innerHTML = `<p class="ai-empty">${escapeHtml(error.message)}</p>`;
    }
}

function aiAppendMessage(role, text, meta = null) {
    const thread = document.getElementById('ai-thread');
    if (!thread) return null;
    const bubble = document.createElement('div');
    bubble.className = `ai-msg ai-msg-${role}`;
    bubble.innerHTML = `<div class="ai-msg-text">${escapeHtml(text)}</div>` +
        (meta ? `<div class="ai-msg-meta">${escapeHtml(meta)}</div>` : '');
    thread.appendChild(bubble);
    thread.scrollTop = thread.scrollHeight;
    return bubble;
}

function aiRenderSuggestions() {
    const container = document.getElementById('ai-suggestions');
    if (!container) return;
    container.innerHTML = aiSuggestedQuestions()
        .map(q => `<button type="button" class="ai-suggestion">${escapeHtml(q)}</button>`).join('');
    container.querySelectorAll('.ai-suggestion').forEach(button => {
        button.addEventListener('click', () => {
            const input = document.getElementById('ai-question');
            if (input) input.value = button.textContent;
            askAi();
        });
    });
    // Los botones se acaban de recrear: si hay una espera en curso, vuelven
    // a bloquearse.
    if (aiCooldownRemaining() > 0) aiSetComposersDisabled(true);
}

function aiResetThread() {
    aiConversationId = null;
    const thread = document.getElementById('ai-thread');
    if (thread) thread.innerHTML = '';
    aiAppendMessage('assistant', t('aiGreeting'));
    aiRenderSuggestions();
}

async function askAi() {
    // El bloqueo de verdad está aquí, no en los botones deshabilitados:
    // Enter en el campo de texto también llega a este punto.
    if (aiBusy || aiCooldownRemaining() > 0) return;
    const input = document.getElementById('ai-question');
    const question = (input?.value || '').trim();
    if (!question) return;

    aiBusy = true;
    if (input) input.value = '';
    const sendBtn = document.getElementById('ai-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    aiAppendMessage('user', question);
    const pending = aiAppendMessage('assistant', t('aiThinking'));
    pending?.classList.add('ai-msg-pending');

    try {
        const result = await aiFetchJson('/api/ai/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, conversation_id: aiConversationId }),
        });
        pending?.remove();
        // La traza de herramientas se muestra siempre: es lo que permite
        // verificar de dónde salió cada dato en vez de confiar a ciegas.
        const tools = (result.tool_calls || []).map(c => c.tool).join(', ');
        const seconds = Math.round((result.elapsed_ms || 0) / 1000);
        // Con el modo automático encendido, el admin necesita poder ver POR
        // QUÉ una respuesta salió cara o pobre. Es metadata de la decisión
        // local, no razonamiento del modelo.
        const ruta = (result.route && currentAuthUser?.role === 'admin')
            ? `${result.route.tier.toUpperCase()} · ${result.route.model} · ${result.route.reason}`
            : '';
        const meta = [ruta, tools && `${t('aiToolsUsed')}: ${tools}`, seconds ? `${seconds}s` : '']
            .filter(Boolean).join(' · ');
        aiAppendMessage('assistant', result.answer || '', meta);
        aiConversationId = result.conversation_id || aiConversationId;
        if (result.pending_action) aiRenderPendingAction(result.pending_action);
        aiLoadHistory();
    } catch (error) {
        pending?.remove();
        aiAppendMessage('assistant', error.message, t('aiError'));
        aiStartCooldown(error.retryAfter);
    } finally {
        aiBusy = false;
        if (sendBtn) sendBtn.disabled = aiCooldownRemaining() > 0;
    }
}

async function aiLoadHistory() {
    const list = document.getElementById('ai-history-list');
    if (!list) return;
    let data = { conversations: [] };
    try {
        data = await aiFetchJson('/api/ai/conversations');
    } catch (_) { /* sin sesión: se deja vacío */ }

    const limpiar = document.getElementById('ai-history-clear-btn');
    if (limpiar) limpiar.hidden = currentAuthUser?.role !== 'admin' || !data.conversations.length;

    if (!data.conversations.length) {
        list.innerHTML = `<p class="ai-empty">${escapeHtml(t('aiNoHistory'))}</p>`;
        return;
    }
    list.innerHTML = data.conversations.map(c => `
        <div class="ai-history-row${c.id === aiConversationId ? ' is-active' : ''}" data-id="${escapeHtml(c.id)}">
            <button type="button" class="ai-history-open" data-open>
                <span class="ai-history-title">${escapeHtml(c.title)}</span>
                <span class="ai-history-meta">${c.message_count} · ${escapeHtml(aiFormatDate(c.updated_at))}</span>
            </button>
            <button type="button" class="ai-history-del" data-del data-i18n-title="aiDelete" title="Eliminar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>`).join('');

    list.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () =>
        aiOpenConversation(btn.closest('.ai-history-row').dataset.id)));
    list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
        const id = btn.closest('.ai-history-row').dataset.id;
        if (!confirm(t('aiDeleteConversationConfirm'))) return;
        try {
            await aiFetchJson(`/api/ai/conversations/${id}`, { method: 'DELETE' });
            if (aiConversationId === id) aiResetThread();
            await aiLoadHistory();
        } catch (error) { showToast(error.message, 'error'); }
    }));
}

function aiFormatDate(seconds) {
    if (!seconds) return '';
    try {
        return new Date(seconds * 1000).toLocaleString(undefined,
            { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
}

async function aiOpenConversation(id) {
    try {
        const c = await aiFetchJson(`/api/ai/conversations/${id}`);
        aiConversationId = c.id;
        const thread = document.getElementById('ai-thread');
        if (thread) thread.innerHTML = '';
        (c.messages || []).forEach(m => {
            const meta = m.role === 'assistant' && (m.tool_calls || []).length
                ? `${t('aiToolsUsed')}: ${(m.tool_calls || []).filter(Boolean).join(', ')}`
                : null;
            aiAppendMessage(m.role === 'user' ? 'user' : 'assistant', m.content || '', meta);
        });
        aiRenderSuggestions();
        await aiLoadHistory();
    } catch (error) { showToast(error.message, 'error'); }
}

async function loadAiSection() {
    const notice = document.getElementById('ai-disabled-notice');
    const layout = document.getElementById('ai-layout');
    const pill = document.getElementById('ai-conn-pill');

    let status = { enabled: false };
    try {
        status = await aiFetchJson('/api/ai/status');
    } catch (_) { /* sin sesión o backend viejo: se trata como apagado */ }

    aiUpdateNavVisibility(status.enabled);

    if (!status.enabled) {
        if (notice) notice.hidden = false;
        if (layout) layout.hidden = true;
        if (pill) pill.hidden = true;
        return;
    }

    if (notice) notice.hidden = true;
    if (layout) layout.hidden = false;
    if (pill) {
        pill.hidden = false;
        pill.textContent = status.model || t('aiConnected');
        pill.dataset.tone = 'ok';
    }

    await aiLoadSuggestions();
    const thread = document.getElementById('ai-thread');
    if (thread && !thread.children.length) aiResetThread();
    else aiRenderSuggestions();

    aiLoadMachines();
    aiLoadEvents();
    aiLoadHistory();
}

// --- Asistente compacto del panel de control -----------------------------
// Comparte la conversación con la sección completa (mismo aiConversationId),
// así que empezar aquí y seguir allá es un solo hilo.
function aiSwitchPanelTab(nombre) {
    document.querySelectorAll('[data-panel-tab]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.panelTab === nombre));
    document.querySelectorAll('[data-panel-pane]').forEach(pane => {
        pane.hidden = pane.dataset.panelPane !== nombre;
    });
    const verTodos = document.getElementById('panel-jobs-see-all');
    if (verTodos) verTodos.hidden = nombre !== 'jobs';
    if (nombre === 'ai') aiRenderPanelSuggestions();
}

function aiRenderPanelSuggestions() {
    const cont = document.getElementById('panel-ai-suggestions');
    if (!cont) return;
    cont.innerHTML = aiSuggestedQuestions()
        .map(q => `<button type="button" class="ai-suggestion">${escapeHtml(q)}</button>`).join('');
    cont.querySelectorAll('.ai-suggestion').forEach(btn => btn.addEventListener('click', () => {
        const input = document.getElementById('panel-ai-question');
        if (input) input.value = btn.textContent;
        askAiFromPanel();
    }));
    if (aiCooldownRemaining() > 0) aiSetComposersDisabled(true);
}

function aiAppendPanelMessage(role, text, meta) {
    const thread = document.getElementById('panel-ai-thread');
    if (!thread) return null;
    const bubble = document.createElement('div');
    bubble.className = `ai-msg ai-msg-${role}`;
    bubble.innerHTML = `<div class="ai-msg-text">${escapeHtml(text)}</div>` +
        (meta ? `<div class="ai-msg-meta">${escapeHtml(meta)}</div>` : '');
    thread.appendChild(bubble);
    thread.scrollTop = thread.scrollHeight;
    return bubble;
}

let aiPanelBusy = false;

async function askAiFromPanel() {
    if (aiPanelBusy || aiCooldownRemaining() > 0) return;
    const input = document.getElementById('panel-ai-question');
    const question = (input?.value || '').trim();
    if (!question) return;

    aiPanelBusy = true;
    if (input) input.value = '';
    aiAppendPanelMessage('user', question);
    const pendiente = aiAppendPanelMessage('assistant', t('aiThinking'));
    pendiente?.classList.add('ai-msg-pending');

    try {
        const result = await aiFetchJson('/api/ai/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, conversation_id: aiConversationId }),
        });
        pendiente?.remove();
        aiConversationId = result.conversation_id || aiConversationId;
        const tools = (result.tool_calls || []).map(c => c.tool).join(', ');
        aiAppendPanelMessage('assistant', result.answer || '', tools ? `${t('aiToolsUsed')}: ${tools}` : null);
        // Una acción de riesgo pedida desde aquí se confirma en la sección
        // completa: el panel es demasiado angosto para mostrar bien qué se
        // va a ejecutar, y confirmar a ciegas es justo lo que se evita.
        if (result.pending_action) {
            aiAppendPanelMessage('assistant', t('aiConfirmInSection'));
        }
    } catch (error) {
        pendiente?.remove();
        aiAppendPanelMessage('assistant', error.message, t('aiError'));
        aiStartCooldown(error.retryAfter);
    } finally {
        aiPanelBusy = false;
    }
}

document.querySelectorAll('[data-panel-tab]').forEach(btn =>
    btn.addEventListener('click', () => aiSwitchPanelTab(btn.dataset.panelTab)));
document.getElementById('panel-ai-composer')?.addEventListener('submit', event => {
    event.preventDefault();
    askAiFromPanel();
});

aiInitModeChrome();

document.getElementById('ai-composer')?.addEventListener('submit', event => {
    event.preventDefault();
    askAi();
});
document.getElementById('ai-clear-btn')?.addEventListener('click', () => { aiResetThread(); aiLoadHistory(); });
document.getElementById('ai-history-clear-btn')?.addEventListener('click', async () => {
    if (!confirm(t('aiClearHistoryConfirm'))) return;
    try {
        await aiFetchJson('/api/ai/conversations', { method: 'DELETE' });
        aiResetThread();
        await aiLoadHistory();
    } catch (error) { showToast(error.message, 'error'); }
});
document.getElementById('ai-refresh-btn')?.addEventListener('click', loadAiSection);
document.getElementById('ai-goto-settings-btn')?.addEventListener('click', () => switchSection('settings'));
document.getElementById('ai-save-btn')?.addEventListener('click', saveAiSettings);
document.getElementById('ai-provider-add-btn')?.addEventListener('click', aiResetProviderForm);
document.getElementById('ai-suggestions-save-btn')?.addEventListener('click', async () => {
    const aviso = document.getElementById('ai-suggestions-result');
    await aiSaveSuggestions();
    if (aviso) {
        aviso.textContent = t('aiQuestionsSaved');
        aviso.dataset.tone = 'ok';
        setTimeout(() => { aviso.textContent = ''; }, 2500);
    }
});
document.getElementById('ai-suggestion-add-btn')?.addEventListener('click', () => {
    aiStoredSuggestions = [...aiReadSuggestionEditor(), ''];
    aiRenderSuggestionEditor();
    document.querySelector('[data-suggestion-index]:last-of-type')?.focus();
});
document.getElementById('ai-cancel-btn')?.addEventListener('click', aiResetProviderForm);
document.getElementById('ai-enabled')?.addEventListener('change', event => {
    aiUpdateSettingsDimming(event.target.checked);   // respuesta inmediata al clic
    setAiEnabled(event.target.checked);
});
document.getElementById('ai-test-btn')?.addEventListener('click', testAiConnection);
document.querySelectorAll('input[name="ai-model-mode"]').forEach(radio =>
    radio.addEventListener('change', aiUpdateModelModeUi));
document.getElementById('ai-preset')?.addEventListener('change', () => {
    const preset = aiCurrentPreset();
    const urlInput = document.getElementById('ai-base-url');
    if (preset?.base_url && urlInput) urlInput.value = preset.base_url;
    aiUpdatePresetUi();
});
document.getElementById('ai-api-key')?.addEventListener('input', event => {
    event.target.dataset.untouched = 'false';
});


// ===========================================================================
// Respaldo de configuración
// ---------------------------------------------------------------------------
// Selección múltiple a propósito: respaldar todo cuando solo querías las
// impresoras es tan molesto como no tener respaldo.
// ===========================================================================

function backupShow(mensaje, tono) {
    const el = document.getElementById('backup-result');
    if (!el) return;
    el.textContent = mensaje;
    el.dataset.tone = tono || '';
}

async function backupLoadGroups() {
    const cont = document.getElementById('backup-groups');
    if (!cont || currentAuthUser?.role !== 'admin') return;
    let data = { groups: [] };
    try {
        data = await aiFetchJson('/api/config-backup/groups');
    } catch (_) { return; }

    cont.innerHTML = data.groups.map(g => `
        <label class="backup-group${g.available ? '' : ' is-empty'}">
            <input type="checkbox" value="${escapeHtml(g.id)}" ${g.available ? '' : 'disabled'}>
            <span class="backup-group-text">
                <span class="backup-group-label">${escapeHtml(g.label)}${g.sensitive ? `<span class="backup-sensitive">${escapeHtml(t('backupSensitive'))}</span>` : ''}</span>
                ${g.warning ? `<small>${escapeHtml(g.warning)}</small>` : ''}
                ${g.available ? '' : `<small>${escapeHtml(t('backupNoData'))}</small>`}
            </span>
        </label>`).join('');
}

function backupSelected() {
    return Array.from(document.querySelectorAll('#backup-groups input:checked')).map(i => i.value);
}

document.getElementById('backup-export-btn')?.addEventListener('click', async () => {
    const groups = backupSelected();
    if (!groups.length) { backupShow(t('backupPickSomething'), 'error'); return; }
    backupShow(t('backupWorking'), 'pending');
    try {
        const response = await fetch('/api/config-backup/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groups, passphrase: document.getElementById('backup-passphrase')?.value || '' }),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }
        // Descarga directa: el archivo nunca pasa por el portapapeles ni por
        // otro servicio.
        const blob = await response.blob();
        const enlace = document.createElement('a');
        enlace.href = URL.createObjectURL(blob);
        enlace.download = (response.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1]
            || 'nopal-config.nopal';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        URL.revokeObjectURL(enlace.href);
        backupShow(t('backupExported'), 'ok');
    } catch (error) {
        backupShow(error.message, 'error');
    }
});

document.getElementById('backup-import-input')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const passphrase = document.getElementById('backup-passphrase')?.value || '';
    backupShow(t('backupWorking'), 'pending');

    // Primero se inspecciona: la persona tiene derecho a ver qué va a
    // sobrescribir antes de aceptarlo.
    let info;
    try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('passphrase', passphrase);
        const r = await fetch('/api/config-backup/inspect', { method: 'POST', body: fd });
        info = await r.json();
        if (!r.ok) throw new Error(info.detail || `HTTP ${r.status}`);
    } catch (error) { backupShow(error.message, 'error'); return; }

    if (info.needs_passphrase) {
        backupShow(t('backupNeedsPassphrase'), 'error');
        return;
    }

    const seleccionados = backupSelected();
    const groups = seleccionados.length ? seleccionados : info.groups;
    if (!confirm(`${t('backupImportConfirm')}\n\n${groups.join(', ')}\n\n${info.files.length} ${t('backupFiles')}`)) {
        backupShow('', '');
        return;
    }

    try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('groups', groups.join(','));
        fd.append('passphrase', passphrase);
        const r = await fetch('/api/config-backup/import', { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
        backupShow(`${t('backupImported')} (${data.restored.length}) — ${t('backupRestartNeeded')}`, 'ok');
    } catch (error) {
        backupShow(error.message, 'error');
    }
});
