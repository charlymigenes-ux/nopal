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
  sí, `git push` no. Ahora mismo hay decenas de commits sin subir en el core
  y varios más repartidos en dos plugins (ver tabla abajo) — es deliberado,
  no un olvido.
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

Migrar una ficha rompió, uno por uno y en silencio, **cinco enganches
implícitos** que otras partes del sistema esperaban encontrar en el
marcado viejo (`.printer-card`, `.printer-card-top`, `.printer-name`,
`.printer-quick-actions`). Cada vez que uno se rompía, no había ningún
error: simplemente faltaba un botón o una función no hacía nada. La lista
de los cinco, para no repetirlos al migrar las siguientes marcas:

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

## Estado de los repos (commits locales sin publicar)

Revisa el número exacto al empezar, esta tabla envejece rápido:

```bash
cd /home/jcjc/nopal && git log --oneline @{u}..HEAD | wc -l
cd /home/jcjc/nopal/plugins/camera-viewer && git log --oneline @{u}..HEAD | wc -l
cd /home/jcjc/nopal/plugins/spoolman && git log --oneline @{u}..HEAD | wc -l
```

**No subir ninguno con `git push` sin que el usuario lo pida
explícitamente** — es una instrucción reiterada varias veces en esta
sesión, no un descuido.

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
