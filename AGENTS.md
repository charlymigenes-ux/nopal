# AGENTS.md — guía de traspaso para el siguiente agente

Este archivo es para el próximo agente (o humano) que retome el trabajo en
este repo sin haber estado presente en las conversaciones anteriores. No
repite lo que ya está en `CLAUDE.md` (arquitectura, convenciones, comandos);
esto es específicamente **qué se hizo, por qué, y qué falta**, para no volver
a derivar el mismo contexto desde cero.

Si algo de lo escrito acá deja de ser cierto (una migración que se completó,
un pendiente que se resolvió), **actualiza este archivo en el mismo commit**
que lo cambie. Un AGENTS.md desactualizado es peor que no tenerlo.

## Cómo trabaja el usuario (léelo antes de tocar nada)

- Habla en español mexicano, directo, a veces con erratas de tecleo rápido
  ("son andie" = "sin nadie", etc.) — no le pidas que aclare, interpreta por
  contexto y confirma con lo que construiste.
- Manda **capturas de pantalla anotadas** (flechas, círculos, colores) como
  especificación. Míralas con cuidado línea por línea: el detalle que
  importa suele estar en una esquina de la imagen, no en el texto que la
  acompaña.
- Cuando dice "continua" o "ok", es luz verde para seguir con el plan que ya
  se explicó — no vuelvas a preguntar.
- Es exigente con el acabado visual ("estamos en 2026, no eso básico de los
  90") y con que las cosas funcionen de verdad, no que aparenten funcionar.
  Prueba cada cambio de UI describiendo lo que hiciste con evidencia (HTML
  renderizado, simulación en Node, captura), nunca solo "ya debería
  funcionar".
- **No subas nada a GitHub sin que lo pida explícitamente.** Commits locales
  sí, `git push` no, salvo que el usuario lo pida con esas palabras ("sube",
  "guarda y sube") — en esta sesión pasó exactamente una vez, después de
  varias tandas de commits locales, y ahí sí se subió core + el plugin de
  Spoolman. Que ya se haya subido una vez no es autorización permanente:
  vuelve a preguntar (o a esperar la palabra) la próxima vez.
- El servidor de producción real corre en `/home/jcjc/nopal` (fuera de
  cualquier worktree). Reiniciarlo es `sudo systemctl restart nopal.service`
  — el agente no tiene sudo interactivo, así que **quien lee esto tiene que
  pedirle al usuario que lo corra**, no intentarlo con `Bash`.

## Flujo de trabajo establecido en esta sesión

1. Se trabaja en un worktree (`.claude/worktrees/nopal-intelligence-layer-*`
   o el que corresponda), nunca directo en `/home/jcjc/nopal`.
2. Cada cambio se prueba (pytest para Python; para JS/CSS, `node --check`
   más una simulación real del render en Node cuando el cambio es de UI —
   ver ejemplos de esta técnica en el historial de commits, es el patrón
   `require('.../app.js')` con un DOM de mentira armado a mano).
3. Se sube el cachebuster `?v=N` de **cada** archivo estático que cambió
   (`app.js`, `style.css`, `translations.js`) en `backend/templates/index.html`
   — si no, el navegador sirve la copia cacheada y el usuario ve "no cambió
   nada" aunque el código sí cambió.
4. Commit en el worktree con mensaje largo explicando el *porqué*, no el
   *qué* (el diff ya dice el qué).
5. `git -C /home/jcjc/nopal merge --no-ff <rama-del-worktree>` para llevarlo
   a producción. En algún punto de esta sesión hacía falta un `git stash`
   porque el usuario tenía cambios sin commitear en `style.css`/
   `index.html` (el reordenamiento de la barra SD del láser) — **eso ya se
   resolvió y está commiteado**, así que los merges recientes son avance
   directo sin stash. Si vuelve a aparecer un working tree sucio en
   `/home/jcjc/nopal`, revisa primero de qué se trata antes de tocarlo
   (puede ser trabajo nuevo del usuario, no el mismo caso de antes).
6. Verificar el merge con `pytest` corrido *dentro de* `/home/jcjc/nopal`
   (no solo en el worktree) y confirmando que `index.html` en producción
   trae los `?v=` nuevos.
7. Nunca se le pide al usuario reiniciar sin haber verificado 1-6 primero.

**Nota de entorno**: no des por sentado que `node`/`pytest` están en el
`PATH` del worktree — en algún entorno de ejecución de esta sesión no lo
estaban. `pytest` vive en `/home/jcjc/nopal/.venv/bin/pytest` (el venv de
producción; el worktree no tiene uno propio, se puede correr contra ese
mismo sin problema ya que solo lee el repo). Un `node` suelto apareció en
`~/.local/nodejs/bin/node` — sirve para `node --check` y las simulaciones
de render. Si ninguno de los dos aparece, dilo explícitamente en vez de
saltarte la verificación en silencio.

## Qué es NOPAL Intelligence (la capa de IA)

Todo lo construido en esta sesión gira alrededor de esto. Resumen rápido:

- Capa de IA **opcional y apagada por omisión**. `backend/services/ai_*.py`
  (config, provider, tools de solo lectura, actions con confirmación,
  router multi-modelo, conversaciones).
- **Regla de oro que no se negocia**: láser y CNC nunca arrancan por esta
  vía. Hay un test que falla si alguien agrega esa herramienta.
- Cada herramienta que la IA puede llamar (`get_workshop_status`,
  `get_library`, `get_led_matrix`, etc.) tiene que corresponder a un dato
  real medido — nunca se le da a la IA algo que no pueda contestar de
  verdad. Esto es relevante para el trabajo más reciente (la cortinilla de
  comandos, ver abajo): cada chip sugerido se apoya en una tool o action que
  existe, verificado contra `ai_tools.py`/`ai_actions.py` antes de escribir
  el texto del chip.
- El **modo IA** es un tema visual (`body.ai`) + un atributo
  (`data-ai-active="true"` en `<body>`) que son **dos interruptores
  independientes**: uno decide colores, el otro decide qué elementos
  existen (`[data-ai-only]`). No los confundas ni los fusiones.

## El trabajo más grande y aún en curso: unificar las fichas de dispositivo

### Qué es

Las tarjetas de máquina del panel (`Dispositivos` en el dashboard) tenían
**seis marcados HTML distintos**, uno por marca (Klipper, Marlin, Elegoo,
FlashForge, Bambu, láser/CNC), todos generados por funciones separadas en
`backend/static/js/app.js` y compartiendo ~99 reglas CSS. Eso hacía que un
arreglo en una marca no se propagara a las otras, y con el tiempo se
separaron visualmente.

El usuario pidió reproducir **exactamente** una referencia visual que
mandó (fichas color crema, con imagen de la máquina protagonista en reposo
y como icono en la esquina al trabajar, panel de datos con divisores,
badges, botones dependientes del estado). Se construyó un **constructor
único** (`deviceCardHtml()` en `app.js`, con su CSS `.dev-card` /
`.dev-*`) y cada marca alimenta ese constructor con un modelo de datos
normalizado en vez de generar su propio HTML.

### Estado real de la migración

**Klipper y láser/CNC están migradas.** `klipperDeviceModel()` y
`laserDeviceModel()` → `deviceCardHtml()`. Las otras tres siguen con su
marcado viejo (verifica con
`grep -n 'printer-card\[data-marlin-device\]\|elegoo-id\|flashforge-id\|bambu-id' app.js`
por si esto ya avanzó desde que se escribió este archivo):

```
Marlin
Elegoo
FlashForge
Bambu
```

El usuario ya vio y aprobó la ficha de Klipper en su forma final (fichas
color crema, imagen grande/miniatura según estado, panel de temperaturas
con iconos grandes, visor de cámara como interruptor con palomita, olas
térmicas). El siguiente paso natural es repetir el mismo patrón para
Marlin, Elegoo, FlashForge y Bambu.

**Láser/CNC** (`laserDeviceModel()`, junto a `klipperDeviceModel()` en
`app.js`) comparte el mismo estado GRBL — `getLaserVisualState()` — para
láser de grabado y CNC (se distinguen por `kind: 'laser'|'cnc'`, con
métrica de Potencia vs. RPM según cuál sea). Datos reales, nada inventado:

- El progreso de trabajo viene de `/api/laser/jobs/active` (**una sola
  llamada por refresco para TODOS los láser/CNC registrados**, no una por
  host — lee el diccionario `_jobs` en memoria del backend, sin ida y
  vuelta a cada máquina). El archivo/progreso pueden venir vacíos si el
  trabajo se inició por fuera de NOPAL (GRBL no expone esos metadatos) —
  no se rellenan con un valor inventado.
- GRBL no da tiempo restante ni siempre da total de líneas: si no hay
  `total`, no hay barra de progreso (mostrar 0% habría sido mentir).
- **"Encuadrar" e "Iniciar"** abren un modal nuevo (`dev-laser-file-modal`)
  que por fin conecta `/api/laser/job/frame` — el endpoint que ya existía
  desde un turno anterior (`gcode_bounds.py` + `build_frame_gcode()`) pero
  no tenía ni un botón. **Ojo**: esto es un flujo *distinto* del que ya
  existía en la sección Láser/CNC completa (`confirmLaserJobStart` /
  `frameLaserJob`, que encuadra jogueando en vivo sobre el láser "activo"
  global vía `/api/laser/command`). El del dashboard apunta siempre al
  `host` de la ficha que lo abrió, a propósito: el dashboard puede mostrar
  varios láser/CNC a la vez, y encuadrar sobre el "activo" equivocado
  mueve el cabezal de una máquina real que no es la que el usuario miró.
  Si en algún momento se quiere unificar ambos flujos, hazlo con cuidado
  de no perder ese aislamiento por host.
- Se borró `laserDashboardCardHtml()` (el generador de markup viejo) y
  `laserIllustrationImg()` (solo la usaba esa función). El binding de
  clic viejo, atado a `.printer-card[data-laser-host]`, se reescribió
  para `.dev-card[data-laser-host]` reutilizando el mismo `WeakSet`
  (`boundLaserCards`) — antes el clic entero solo navegaba a la sección
  completa; ahora la ficha también resuelve pausar/reanudar/cancelar/home
  sin salir del dashboard, igual que Klipper.

### Lecciones ya aprendidas (no las repitas)

Migrar una ficha rompió, uno por uno y en silencio, **seis enganches
implícitos** que otras partes del sistema esperaban encontrar en el
marcado viejo (`.printer-card`, `.printer-card-top`, `.printer-name`,
`.printer-quick-actions`). Cada vez que uno se rompía, no había ningún
error: simplemente faltaba un botón o una función no hacía nada. La lista
de los seis, para no repetirlos al migrar las siguientes marcas:

1. **Botón de escenas LED** (`decorateMachineCardsWithLedSettings`) — lo
   inyecta el plugin de accesorios buscando esas clases. Ya se enseñó a
   reconocer `.dev-card`/`.dev-card-head` también.
2. **Botón de mostrar/ocultar cámara** (`ensureCameraToggleButton`,
   `mountCameraCardsIn`) — mismo problema, mismo arreglo aplicado.
3. **Abrir el panel completo de la impresora** (`openPrinterModal`) —
   además de la clase, el manejador viejo le pasaba el **objeto** de la
   impresora y el nuevo le pasaba el **puerto** (un número): el panel
   abría vacío sin ningún error. Arreglado con una función intermedia
   `abrirPanelDeImpresora(puerto)` que resuelve el objeto antes de llamar.
4. **Olas térmicas** (`printerThermalWaves`) — se perdieron por completo al
   migrar (nadie las volvió a pintar). Hubo que alimentarlas con las
   temperaturas y objetivos reales y agregarlas de vuelta al HTML de la
   ficha nueva.
5. **`<header>` real** — la cabecera de la ficha nueva usaba la etiqueta
   `<header>`, y NOPAL tiene una regla CSS **global** para ese elemento (la
   barra superior de la app) que se colaba encima (línea + relleno
   grandes). Cambiado a `<div>`.
6. **Clics de la cámara montada se colaban a la ficha entera** — esta no
   es un enganche `.printer-card` vs `.dev-card`, es un bug de
   *propagación de eventos* que solo se hizo visible al migrar láser.
   `camera-card.js` (plugin `camera-viewer`, componente compartido por
   TODAS las marcas) monta sus controles (ampliar/capturar/grabar/
   configurar) con un único listener delegado en el contenedor de la
   cámara, y ese listener nunca llamaba `event.stopPropagation()`. Como
   la cámara vive dentro de la ficha, y la ficha tiene su propio clic en
   toda la tarjeta (abrir panel / navegar a la sección), cualquier botón
   de la cámara hacía lo suyo **y además** disparaba esa navegación por
   encima. Para Klipper pasaba desapercibido (abrir el panel de la
   impresora "encima" no se sentía tan mal); con láser, navegar fuera del
   dashboard al tocar "ampliar visor" sí se notó. Arreglado en
   `plugins/camera-viewer/frontend/camera-card.js` (repo aparte, propio,
   no en núcleo — ver más abajo). **Si agregas un botón/control nuevo
   dentro de una ficha** (sea en `app.js` o en un plugin), o si un plugin
   nuevo empieza a inyectar controles en las fichas, revisa que su
   listener de clic llame `stopPropagation()` — si no, se hereda este
   mismo bug en silencio.

**Antes de migrar cada marca nueva**, busca en `app.js` todo lo que haga
`querySelector` sobre clases de la ficha vieja (`.printer-card`,
`.printer-card-top`, `.printer-name`, `.printer-quick-actions`,
`.printer-illustration`, `.printer-temps`) y decide si también necesita
reconocer `.dev-card`/`.dev-*` — no esperes a que el usuario lo note en una
captura.

### Otras piezas del sistema de fichas que hay que replicar por marca

- **Modo lista** (`.printers-grid.list-view .dev-card`): ya implementado
  para Klipper (fila compacta, imagen a 40px, sin cajas anidadas, botones
  solo con icono). Verificar que aplique igual al resto.
- **Personalizador de orden de secciones** (`getDeviceCardLayout`,
  `DEVICE_CARD_SECTIONS_DEFAULT_ORDER`, `DEVICE_CARD_LAYOUT_KEY`): reducido
  a 3 secciones reordenables (imagen, trabajo, datos) en vez de las 4
  viejas. Es agnóstico a la marca, no debería necesitar cambios al migrar
  las demás.
- **Material cargado** (Spoolman): solo aplica a Klipper por ahora — el
  plugin de Spoolman (`plugins/spoolman`) vincula carretes por **puerto**
  de Moonraker, no tiene vínculo para láser/CNC/Marlin/Elegoo/FlashForge/
  Bambu. Si al migrar otra marca el usuario pide ver material ahí, hay que
  extender `spool_link_service.py` primero (está documentado en su propio
  docstring que es una limitación conocida, "por ahora").

## Material / Spoolman: la ficha, Moonraker y la IA

Cadena de trabajo larga, con varias vueltas de ida y vuelta con el usuario
(capturas anotadas de la ficha Y de Mainsail/moonraker.conf). Toca tres
repos a la vez: núcleo (`app.js`, `klipper_service.py`, `ai_*.py`), el
plugin `plugins/spoolman/`, y de lectura el propio Moonraker instalado en
esta máquina (`/home/jcjc/moonraker/`, código fuente real, no solo docs).

### La fila de Material en la ficha (`deviceMaterialCampo`, `app.js`)

Pasó por tres formas antes de quedar bien, cada una corregida con una
captura del usuario:
1. Un `deviceCampo()` genérico de una sola línea de texto — sin ícono, sin
   color real.
2. Un ícono de dos círculos concéntricos (`DEVICE_ICONS.spool`, todavía
   vive ahí pero **ya no se usa** para esto) — el usuario lo vio y dijo que
   se leía como "disco de almacenamiento", no como carrete.
3. La forma actual: `deviceMaterialSpoolIcon(colores)`, un carrete de
   **perfil, de costado** (eje horizontal: pestañas izquierda/derecha,
   nunca arriba/abajo — eso es lo que se leía como ícono de base de datos),
   con las tres capas enrolladas coloreadas del color real del filamento.

**Multicolor real, no inventado**: un filamento coextruido/longitudinal en
Spoolman no tiene `color_hex` (queda `None`) — el color vive en
`multi_color_hexes` ("hex1,hex2", separado por comas) +
`multi_color_direction`. Confirmado contra la API real de Spoolman (no
contra su documentación) con un filamento del usuario de verdad (VER/AMA,
id 9). `plugins/spoolman/backend/router.py` resuelve ambos campos; el
ícono alterna colores entre las tres capas si hay más de uno.

Diámetro y peso restante van con el mismo patrón que Boquilla/Cama
(`deviceMetrica`): número grande + unidad chica, no texto corrido.

### Dos bugs reales que no eran de Spoolman

1. **`applyMaterialPreheat`/`temp-cool-btn` nunca refrescaban la ficha del
   dashboard** — mandaban el target de temperatura de verdad (confirmado
   en los logs del servicio) pero solo refrescaban el panel de la
   impresora abierto, nunca `loadPrinters()`. "Mandé a calentar y la ficha
   no cambia" era este bug, no percepción del usuario.
2. **El bug de fondo, más grave**: cuatro funciones que alimentan las
   fichas del dashboard (`loadPrinters`, `loadDashboardStandalonePrinters`,
   `refreshDashboardLaserCard`, `loadDashboardPanel`) tenían
   `if (... || document.hidden) return;`. El usuario usa NOPAL por RDP (ver
   `nopal-lan-topology` en la memoria del usuario) y la Page Visibility API
   del navegador no es confiable ahí — confirmado con un hueco de **20
   minutos** sin una sola llamada a `/api/printers/status` en los logs del
   servicio, justo después de un comando. Se quitó el chequeo de las
   cuatro; el único `document.hidden` que queda es el de notificaciones de
   escritorio (ese sí depende genuinamente del foco de la pestaña). Si en
   algún momento se agrega OTRO polling nuevo al dashboard, no le pongas
   `document.hidden` sin pensarlo dos veces.

### Sincronización con Moonraker (el hallazgo más grande de esta tanda)

El usuario mostró una captura de **Mainsail** (no NOPAL) con su propio
selector "Cambiar carrete" — bien poblado, con datos reales de Spoolman —
diciendo "seguimiento inactivo". La confusión ("¿por qué NOPAL no hace
esto si Mainsail sí?") tenía una causa real:

- Vincular un carrete en NOPAL (`spool_link_service.set_link`) **nunca
  hizo nada más que guardar una etiqueta** para la ficha. No resta gramos
  de Spoolman.
- Quien de verdad descuenta gramos reales mientras imprime es el propio
  **componente `[spoolman]` de Moonraker** (`moonraker.conf`, fuera de
  NOPAL por completo) — el mismo selector que usa Mainsail.
- Confirmado leyendo el código fuente real de Moonraker instalado en esta
  máquina (`/home/jcjc/moonraker/moonraker/components/spoolman.py`): el
  endpoint es `POST /server/spoolman/spool_id` con `{"spool_id": int}` —
  **y mandar `{"spool_id": null}` para limpiarlo tira un 400** (Moonraker
  intenta convertir el valor igual aunque sea `null`; hay que mandar el
  body vacío `{}` para que caiga en su propio default). Esto se descubrió
  a mano, probando contra el Moonraker real de esta máquina.
- Se agregó `MoonrakerClient.set_spoolman_active_spool(spool_id)` en
  `backend/services/klipper_service.py` (núcleo), y se llama desde las TRES
  formas de asignar un carrete: `set_active_spool_endpoint`/
  `clear_active_spool_endpoint` del plugin, y la acción de IA
  `assign_spool`. Es best-effort: si Moonraker no tiene `[spoolman]`
  configurado, el vínculo de NOPAL se guarda igual
  (`moonraker_synced: false` en la respuesta).
- Nuevo endpoint `GET /api/spoolman/moonraker-check`: por cada impresora
  con un carrete vinculado, revisa si `"spoolman"` aparece en
  `/server/info` de su Moonraker. Si no, el plugin (pestañas Resumen y
  Consumo) muestra un aviso con el nombre real de la impresora — en los 5
  idiomas que este plugin mantiene a mano en `spoolman.js` (es/en/de/fr/
  pt-BR, sin script de generación como el núcleo).

**Incidente real durante esta tanda, para que no se repita**: probando el
endpoint de sincronización, un test de `plugins/spoolman/tests/
test_active_spool.py` (puerto 7125, que en esta máquina de desarrollo
resulta ser un Moonraker **real**) cambió el spool activo de la impresora
de verdad como efecto secundario de correr `pytest`. Se detectó
(`curl localhost:7125/server/spoolman/status` antes/después de la
sospecha), se restauró el estado a mano, y se agregó un fixture
`autouse=True` en `plugins/spoolman/tests/conftest.py`
(`no_real_moonraker_calls`) que monkeypatchea
`MoonrakerClient.set_spoolman_active_spool` a un no-op por default en TODA
la suite. **Cualquier test nuevo que ejercite código con un `port` que
podría coincidir con un puerto real de esta máquina (7125 es Moonraker de
verdad) necesita este tipo de aislamiento** — no asumas que un "puerto de
prueba" es inofensivo solo porque es un número inventado.

### La acción de IA `assign_spool` y el bug de enrutamiento

Se agregó `assign_spool(machine_id, spool_id)` en `ai_actions.py`
(`risk="low"` porque no manda G-code ni mueve nada físico, `role="admin"`
copiado del endpoint del panel). El usuario probó "cambia el carrete de
nopal-i3 a verde" y la IA respondió que no tenía acceso — **sin siquiera
intentar la herramienta**. Diagnosticado probando en vivo contra la API
real de Groq (no adivinando):

1. `ai_router.classify()` mandó la pregunta al nivel `fast`
   (`llama-3.1-8b-instant`) con el catálogo compacto — `NON_CORE_HINTS`
   tenía "spool"/"material" pero no **"carrete"**, la palabra que la gente
   (y toda la interfaz de NOPAL) usa de verdad.
2. Sin catálogo completo, `get_material_status` no estaba disponible: el
   modelo no podía buscar el id real del carrete.
3. Groq (`llama-3.1-8b-instant`), probado en vivo con el catálogo
   **completo**, igual llamó a `assign_spool` **adivinando**
   `spool_id: "green"` (string) en vez de un id real — Groq rechazó la
   llamada con 400 (`tool_use_failed`, tipo inválido).
4. Ese 400, con `tools` presente en el pedido, hace que
   `ai_provider.py` asuma `ToolsUnsupportedError` y caiga a **modo
   "context"** — que apaga TODAS las herramientas y acciones para el
   resto de esa respuesta, no solo la llamada que falló. De ahí la traza
   observada (`get_workshop_status, get_machines, get_recent_errors`, que
   son literalmente `CONTEXT_MODE_TOOLS` en `ai_agent.py`).

Arreglado en dos pasos, ambos verificados en vivo contra Groq antes de dar
por bueno el arreglo (no solo con un test):
- Se agregó "carrete"/"carretes"/"bobina"/"bobinas" a `NON_CORE_HINTS`.
- **Eso no bastaba**: probado con el catálogo completo, `llama-3.1-8b-instant`
  a veces sigue sin consultar `get_material_status` primero. Se agregó
  `MATERIAL_HINTS` con su propia regla en `classify()` que manda estas
  preguntas directo al nivel `medium` (`gpt-oss-20b`), igual que ya pasa
  con diagnósticos (`reasoning`) y comparaciones (`medium`) — probado en
  vivo que `gpt-oss-20b` sí consulta primero de forma consistente.

**Metodología a copiar para el próximo "la IA no hace X"**: no confíes en
la traza que muestra la UI ni en la config de `ai_config.json` sola. Arma
un script chico (`ai_tools.get_tools_schema(perfil) + ai_actions.
get_actions_schema(rol)`, un `requests.post` directo al `base_url` +
`api_key` reales del proveedor configurado) y prueba la pregunta real
contra el modelo real que de verdad se usaría (`ai_router.classify()` te
dice cuál). Adivinar la causa desde el código sin probar contra el
proveedor real llevó a una hipótesis equivocada más de una vez en esta
sesión antes de encontrar la real.

**Cuidado al mostrar `ai_config.json`**: trae la API key en texto plano
(`api_key` dentro de cada entrada de `providers`). Si necesitas leerlo
para depurar, evita volcarlo completo a una respuesta visible para el
usuario — ya pasó una vez en esta sesión y quedó expuesta en el historial
de la conversación. Si vuelve a pasar, avísale al usuario que considere
rotar la key.

## Otros arreglos de UI sobre la ficha (esta continuación)

- **Botón de "más opciones" (los tres puntos verticales) quitado** de la
  cabecera de la ficha — no hacía nada que "cámara sin asignar" no
  hiciera ya. Ojo: esto es *distinto* del ícono ☰ real del topbar
  (`#mobile-nav-toggle-btn`, "Menú" móvil) que el usuario señaló por
  separado — ver el bug de CSS abajo.
- **Bug real de cascada CSS**: `.topbar-icon-btn` (sin especial, una sola
  clase) fijaba `display:inline-flex` más abajo en `style.css` que el
  `display:none` de `.mobile-nav-toggle-btn` (misma especificidad, gana el
  que aparece después) — el botón de menú móvil quedaba visible en
  escritorio siempre. Arreglado con un selector compuesto
  (`.topbar-icon-btn.mobile-nav-toggle-btn`, mayor especificidad) en las
  dos reglas (la de ocultar y la del `@media` que lo muestra en mobile).
  Si algo más en `.topbar-icon-btn` empieza a comportarse raro en
  desktop/mobile, sospecha de este mismo patrón de cascada.
- **Las olas térmicas se salían de la ficha**: `.dev-card` nunca heredó el
  `overflow: hidden` que sí tenía `.printer-card` (el sistema viejo). Las
  ondas se dibujan a propósito un 8% más anchas que la ficha
  (`renderThermalLayer`) confiando en que el contenedor las recorte contra
  las esquinas redondeadas. Arreglado agregando `overflow: hidden;
  isolation: isolate;` a `.dev-card`.
- **Bisel animado por categoría**: cada columna del dashboard
  (`#printers-grid`/`#lasers-grid`/`#cnc-grid`) fija `--dev-category` con
  el mismo color que su encabezado (verde/morado/naranja), y el borde de
  `.dev-card` pulsa entre una versión tenue y una viva de ese color
  (`@keyframes devCardCategoryPulse`). Se apaga en fichas offline y
  respeta `prefers-reduced-motion`. No aplica en modo mixto (una sola
  grilla para todo tipo de máquina): no hay un atributo de "tipo" uniforme
  en la ficha para colorear ahí sin una columna que lo indique.
- **CNC ya no comparte imagen con láser**: existían `cncready2.png`/
  `cncoff.png` sin usar en `static/img/` desde hacía tiempo — se agregó
  `CNC_STATE_IMAGES` y `laserDeviceModel` elige el mapa según `kind`. CNC
  no tiene variantes por estado (solo encendida/apagada); no se inventó
  arte que no existe.
- **El color de categoría (`--dev-category`) ya no es solo el bisel**: ahora
  también tiñe `.dev-card-name` (nombre de la máquina) y el resplandor de
  `:hover` de los botones de la ficha (`.dev-action`, `.dev-action-primary`,
  el botón de escenas LED, el interruptor de cámara y el nuevo botón "abrir
  panel"), todos con `var(--dev-category, <color de siempre>)` — el mismo
  patrón del bisel, así que en modo mixto o en marcas sin migrar cae solo al
  color neutro de siempre sin ningún `if` extra. Se agregó un botón nuevo,
  `.dev-hero-open-btn` (esquina superior derecha de `.dev-hero`, icono
  `expand` en `DEVICE_ICONS`), que hace explícito el gesto de "la ficha
  entera abre el panel" — visible solo en vista de imagen/cuadrícula
  (oculto en `.list-view`, sin espacio a 40px y la fila ya es igual de
  clicable). Usa `data-dev-action="open-panel"`, un valor sin `case` propio
  en el binding de clic de Klipper/láser-CNC — cae al mismo fallback que ya
  usaba "Detalles" (`abrirPanelDeImpresora`/`irASeccionDeLaser`), sin
  cablear nada nuevo en JS.

## Trabajo reciente en el plugin de cámaras (`plugins/camera-viewer`)

Repo aparte, se clona en `plugins/camera-viewer/` (gitignored en el core).

- Una cámara puede ahora venir de una **URL** además de un `/dev/videoN`
  (sirve para retransmitir un stream de crowsnest cuando el dispositivo
  físico ya está tomado por otro proceso).
- Si `ffmpeg` no logra arrancar, el error ahora **dice por qué** en la
  tarjeta (antes quedaba en un recuadro negro sin explicación). Los
  mensajes crípticos de ffmpeg se traducen — ojo con el caso real
  documentado en el código: `"No space left on device"` en V4L2 **no es
  el disco**, es ancho de banda USB, y el mensaje lo aclara.
- El **visor ampliado** (botón de pantalla completa) ya no llama al
  fullscreen nativo del navegador sobre la imagen sola: abre un visor
  propio con controles debajo del video y una tira de material (capturas +
  timelapses + grabaciones) con borrado **en el sitio** (la confirmación
  aparece sobre la propia miniatura, nunca en una ventana aparte — pedido
  explícito del usuario, no lo cambies a un modal).
- Las **grabaciones** existían en disco desde siempre pero no había forma
  de listarlas, verlas ni borrarlas — se agregaron los cuatro endpoints
  que faltaban (`GET/DELETE .../recordings`, `DELETE .../captures/...`),
  todos con protección contra rutas maliciosas (`../../algo`), probada con
  un test que intenta cinco variantes.
- Los controles de cámara compacta (los que van dentro de cada ficha de
  máquina) viven **encima del video**, en una barra con degradado — no
  debajo en una barra aparte, eso se corrigió explícitamente porque le
  robaba altura a la imagen.

Ver tabla de estado abajo para el número exacto de commits sin subir.

## Cortinilla de IA (lo último de esta sesión)

`.ai-capability-strip` (ahora `.ai-capability-dock` como envoltorio +
`.ai-capability-strip` como píldora + `.ai-capability-track` como cinta) —
antes era una franja estática de 4 frases genéricas, mal ubicada (aparecía
encimada con cualquier sección según cuál estuviera activa). Se rehizo
como:

- **`position: fixed`** al fondo del viewport, con el mismo patrón
  `left: 240px` / `.sidebar-collapsed { left: 76px }` que ya usa
  `.dashboard-fixed-stack` (el dock de Accesorios/Matriz LED) — confirmado
  con un parser HTML real que el elemento es **hermano** de cada
  `<section>` de página, nunca su descendiente, así que `position:fixed`
  lo saca del flujo sin ningún problema de ancestro oculto.
- **Contenido por sección**: `AI_SECTION_COMMANDS` en `app.js` mapea cada
  sección a 1-4 comandos, cada uno respaldado por una tool/action real
  (ver más arriba). Las secciones sin lista propia caen en
  `AI_DEFAULT_COMMANDS`.
- **Cinta que se desliza sola** (`@keyframes aiCapabilityScroll`,
  contenido duplicado para el loop sin costura), se pausa al pasar el
  mouse o enfocar con teclado, respeta `prefers-reduced-motion`.
- Click en un chip → `switchSection('ai')` + llena `#ai-question` + llama
  `askAi()`.
- El dock de Accesorios/Matriz LED se corre 78px hacia arriba
  (`body[data-ai-active="true"] .dashboard-fixed-stack { bottom: 78px; }`)
  para que nunca se encimen entre sí — ambos viven pegados al fondo, en la
  misma franja horizontal, solo cuando la IA está encendida.

Esto ya está commiteado y mergeado a producción, con `pytest` en verde y
verificación de balance de HTML/sintaxis JS. No debería necesitar más
trabajo salvo que el usuario pida ajustar la lista de comandos por sección
o encuentre un problema visual nuevo.

## Versionado y diagnóstico ("Acerca de NOPAL")

Pedido explícito del usuario, con instrucción de investigar antes de
escribir código — y valió la pena: casi toda la base ya existía.

- **Versión global**: ya existía. Archivo `VERSION` en la raíz (semver
  real, ej. `1.2.0-alpha.1`, no un placeholder) + `get_app_version()` en
  `backend/utils.py`. No se creó nada nuevo acá, solo se expuso.
- **Commit/rama de git**: ya existía en `GET /api/system/version`
  (`backend/api/status.py`, con `_run_git()` que ya maneja limpio la
  ausencia de git devolviendo `None`). Se agregó `GET /api/system/diagnostics`
  aparte (mismo archivo) en vez de inflar ese endpoint — junta lo mismo
  más sistema operativo (`platform.freedesktop_os_release()`, con
  fallback a `system()+release()`), arquitectura y versión de Python. El
  idioma activo NO viaja en la respuesta del servidor: es 100% un dato
  del navegador (`currentLanguage`).
- **Versión de plugins**: los manifiestos (`plugins/*/nopal-plugin.json`)
  YA declaran `"version"` — no hizo falta agregar ese campo. Se reusa
  `GET /api/plugins` (ya existente, `_serialize_catalog()` en
  `backend/api/plugins.py` ya resuelve la versión real desde el manifest
  del plugin instalado) filtrando `installed === true`, en vez de
  duplicar esa lectura en un endpoint nuevo.
- **UI**: tarjeta "Acerca de NOPAL" en Configuración
  (`data-settings-module="about"`), mismo patrón exacto que la tarjeta
  "Actualizaciones" de al lado (`.settings-card.card-collapsible`,
  `card-header-std`, etc.) — cárgala con `loadAboutInfo()` en `app.js`,
  llamada desde `switchSection('settings')` junto a `loadUpdatesStatus()`.
  El botón "Copiar información de diagnóstico" arma el texto con
  `buildDiagnosticsText()` y usa `navigator.clipboard.writeText()`.

## Issue #50: plugins que no heredan el cambio de idioma

`setLanguage()` (`translations.js`) ya disparaba
`window.dispatchEvent(new CustomEvent('nopal:language-changed'))` — un
mecanismo genérico construido a propósito para que cada plugin decida si
le importa (el comentario en el propio código lo dice: viene de cuando
Cotizador se sacó del core). El problema real: **casi nadie lo escuchaba**.

- `cotizador.js`: sí lo escuchaba (el original, la referencia del patrón).
- `font-library.js`: resuelve lo mismo por otra vía — un
  `MutationObserver` sobre `document.documentElement.lang` que llama
  `applyLanguage()`. Funciona igual de bien, no se tocó.
- **Arreglados esta sesión** (agregado el listener, llamando a la función
  de re-render que cada uno ya tenía): `arduino-accessories.js`,
  `spoolman.js`, `camera-viewer.js` (los tres tienen `render()`/
  `renderGrid()` con guard de `root`), y `camera-card.js` (caso especial:
  se monta varias veces a la vez, una por cada ficha con cámara vinculada
  — se le agregó un `Set` de instancias activas porque el `WeakMap` que
  ya tenía no se puede recorrer, y se expuso `render()` en el objeto que
  devuelve cada instancia).
- **Deliberadamente sin arreglar**: `matriz-led.js`, `shape-creator.js`,
  `svg-toolkit.js`. Ninguno tiene una función de repintado que no sea
  remontar por completo (`unmount()` + `mount()`), y para shape-creator/
  svg-toolkit remontar **borra trabajo en curso** (formas dibujadas en el
  canvas, archivo SVG cargado — ninguno de los dos persiste su estado en
  `localStorage`, confirmado antes de descartar la idea). Un remontaje
  ciego ahí sería peor que el bug original. Si se quiere cerrar esto de
  verdad, la vía correcta es enseñarles un `render()`/`applyLanguage()`
  propio como el de font-library, no forzar un remount — mismo criterio
  que "no rompas la arquitectura existente".

## Deuda de traducción encontrada (no es de esta sesión, quedó anotada)

Auditando esto se encontró que `translations-fr.js` y
`translations-pt-BR.js` tienen un backlog real de **~180 claves
faltantes** contra `es`/`en` (verificar con el checker de abajo, el
número baja con el tiempo si alguien corre el generador). Es anterior a
esta sesión, sin relación con el issue #50, y no se intentó cerrar acá
— hubiera sido scope creep sobre un pedido que no era ese.

`scripts/generate_i18n.py` (llama a un endpoint de traducción automática)
**tardó más de 60s y se cortó a la mitad** al intentarlo para solo ~15
claves nuevas — y lo poco que alcanzó a traducir tenía errores reales
("Commit" tradujo como el VERBO "comprometerse"/"Begehen"/"S'engager" en
vez de dejarlo como término técnico). Las claves nuevas de esta sesión
(`about*`) se tradujeron a mano en de/fr/pt-BR en vez de confiar en esa
salida — y se descartó el `.i18n-cache-{de,fr}.json` parcial que el
intento cortado había alcanzado a escribir, para que un futuro run del
script no reuse esa traducción mala.

Forma confiable de auditar sincronización real entre idiomas (no usar
regex simple — falla con claves que comparten línea o valores que
contienen `:` — ver más abajo por qué): evaluar el objeto JS de verdad.

```js
// extractObjectLiteral(text, startIdx): recorta con conteo de llaves
// respetando strings (ver el propio código de este archivo si hace
// falta reconstruirlo) -- luego eval('(' + literal + ')') y comparar
// Object.keys(obj.es) contra Object.keys(obj[otroIdioma]).
```

**Lección de esta sesión, para no repetirla**: un primer intento de esta
misma auditoría (sobre los plugins, turno anterior) usó expresiones
regulares (`/^\s*(\w+):\s*['"]/`) y dio resultados **falsos** — no
manejaba varias claves por línea, y confundía palabras dentro de un
valor (ej. `portLabel: 'Puerto:'`) con claves reales. Reportó huecos que
no existían. Si necesitas auditar traducciones, evalúa el objeto de
verdad en Node, no adivines con regex.

## Recordatorio de flujo (se repitió el error esta sesión)

**Dos veces en esta sesión** se editó código directo en
`/home/jcjc/nopal` en vez del worktree, a pesar de que este mismo
archivo ya lo advertía. La segunda vez (trabajo de versionado/
diagnóstico) terminó en un merge con conflictos reales en los tres
`translations-{de,fr,pt-BR}.js` porque producción ya tenía una versión
más completa que la copia del worktree (production había subido de
~1050 a ~1320 claves por otra vía, y el worktree nunca se sincronizó).
Se resolvió tomando la versión de producción como base
(`git checkout --ours`) y reaplicando encima solo las claves nuevas —
pero **el chequeo correcto es más barato que el arreglo**: antes de
escribir con una ruta absoluta, correr `pwd` y confirmar que sea el
worktree, no producción. Si en algún punto un archivo compartido entre
ambos (como `AGENTS.md` o `translations-*.js`) se ve sospechosamente
distinto entre worktree y producción, es señal de que ya pasó esto: hay
que sincronizar ANTES de seguir editando, no después.

## Estado de los repos (commits locales sin publicar)

Revisa el número exacto al empezar, esta tabla envejece rápido:

```bash
cd /home/jcjc/nopal && git log --oneline @{u}..HEAD | wc -l
cd /home/jcjc/nopal/plugins/camera-viewer && git log --oneline @{u}..HEAD | wc -l
cd /home/jcjc/nopal/plugins/spoolman && git log --oneline @{u}..HEAD | wc -l
```

Al cierre de esta continuación (2026-08-13), el usuario pidió explícitamente
subir: se hizo `git push` de core (`dev-main` → `origin/desarrollador`) y del
plugin de Spoolman (`master` → `origin/master`). `camera-viewer` **no** se
tocó esta vez — sigue con lo que ya tuviera pendiente de antes, revisa el
comando de arriba antes de asumir que está al día.

**No subir ninguno con `git push` sin que el usuario lo pida
explícitamente cada vez** — que se haya subido una vez no es luz verde
permanente para las siguientes tandas de commits.

## Cosas que NO hay que reinventar

- **No hay componente de framework**: todo es JS vanilla + HTML servido
  por Jinja2 + un solo `style.css` de ~17,000 líneas. No introduzcas React,
  Vue, un bundler, ni CSS-in-JS.
- **No hay build step.** Si algo no se ve reflejado, el problema casi
  siempre es el cachebuster `?v=` sin subir, no un paso de compilación
  faltante.
- **`backend/app.py`, `backend/routes.py`, `backend/database.py` están
  vacíos a propósito.** No busques código ahí ni les agregues nada.
- Antes de asumir que un test "raro" está mal, revisa si es el propio test
  el que modela mal la realidad (pasó varias veces en esta sesión: un doble
  de `sudo` que ejecutaba de verdad, un `_FakeProcess` que compartía stdout
  y stderr, un `wait()` que devolvía antes de tiempo). Verificar el doble
  de prueba con una mutación (romper el código a propósito y confirmar que
  el test lo atrapa) salvó de varios falsos positivos en esta sesión.
