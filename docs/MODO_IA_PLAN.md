# Modo IA — plan de identidad visual

Plan para el "MODO IA ACTIVADO": cuando NOPAL Intelligence está encendido, el
panel cambia de ambiente completo — paleta, fondo, logotipo y un bloque de
tarjetas de resumen — sin dejar de ser el mismo NOPAL por debajo.

Este documento es **plan, no estado**. Lo que ya existe y funciona está en
[NOPAL_INTELLIGENCE.md](NOPAL_INTELLIGENCE.md).

---

## 0. Dos interruptores independientes

Esto es la regla que gobierna todo lo demás, y es fácil de equivocar:

| Interruptor | Qué controla | De qué depende |
|---|---|---|
| **IA activada** | Qué elementos **existen** en la pantalla | `enabled` en la configuración de IA |
| **Tema** | De qué **color** se pintan | La elección del usuario en Ajustes |

Son ortogonales. Con la IA encendida y el tema oscuro, los elementos exclusivos
de IA siguen ahí — pintados en oscuro. Al apagar la IA desaparecen, sin importar
el tema.

Por eso los elementos exclusivos **no se cuelgan de la clase del tema** sino de
un atributo propio, `data-ai-active`, en `<body>`.

### Elementos exclusivos del modo IA

Aparecen solo con la IA encendida, en cualquier tema:

1. **Logotipo NOPAL Intelligence** en la barra lateral (sustituye al logo normal)
2. **Píldora "MODO IA ACTIVADO"** en la barra superior
3. **Tarjeta "Estado del sistema"** con el orbe IA
4. **Ítem "IA activada"** en el menú lateral
5. **Franja de capacidades**: automatización activa · asistencia predictiva ·
   optimización en tiempo real · diagnóstico inteligente
6. **Panel del asistente** con la mascota

### Lo que NO cambia con el modo IA

Las **fichas de dispositivo** son la vista oficial de NOPAL: mismo diseño y
estilo en cualquier tema y con la IA encendida o apagada. Solo cambian de color
según el tema, como todo lo demás.

> **Anotado para después:** rediseñar las fichas de dispositivo para que
> coincidan con el modelo de muestra (render por tipo de máquina, anillo de
> progreso, fila de métricas al pie). Es trabajo aparte del tema y no bloquea
> nada de lo que sigue.

---

## 1. Cómo encaja en la arquitectura actual

NOPAL ya tiene las tres piezas que el modo IA necesita. No hay que inventar un
sistema nuevo:

| Pieza | Dónde vive hoy | Qué falta |
|---|---|---|
| Cambio de tema | `applyTheme()` en `app.js` — quita una clase de `<body>` de una lista fija y pone otra, más `data-theme` | Agregar `ai` a la lista |
| Fondo por tema | `THEME_WALLPAPER_CONFIG` en `app.js` — ya da fondo propio a `green`, `light` y `red` vía una variable CSS | Agregar la entrada `ai` |
| Paleta por tema | `body.ai { ... }` en `style.css`, redefiniendo las mismas variables que los demás temas | Escribir el bloque |

**El modo IA es un tema más**, no una segunda aplicación. Eso importa: hereda
el personalizador de módulos, la galería de plugins, el sistema de idiomas y
todo lo demás sin duplicar nada.

### Variables que el bloque `body.ai` debe redefinir

Son las mismas que ya usan `dark`, `green`, `red` y `custom`. Ninguna tarjeta
nueva debe hardcodear un color:

```
--surface-base   --surface-raised   --surface-sunken   --surface-nav
--text-strong    --text-soft        --text-faint
--border-subtle  --border-control
--accent-fill    --accent-fill-hover --accent-fill-active
--accent-ink     --accent-on        --accent-fill-rgb
--status-ok      --status-warn      --status-danger    --status-info
```

### Activación

El tema se enciende solo cuando `enabled` está en `true` en la configuración de
IA (`GET /api/ai/status`), y el usuario puede volver a su tema anterior desde
Ajustes. Apagar la IA devuelve el panel a su tema normal — misma regla que
todo lo demás: `AI_ENABLED=false` deja NOPAL idéntico.

---

## 2. Identidad visual

Tomada del logotipo NOPAL Intelligence: nopal sobre hexágono de circuito, con
degradado **verde → cian**.

| Rol | Valor | Uso |
|---|---|---|
| Acento primario | verde nopal brillante | Botones, anillos de progreso, estados en línea |
| Acento secundario | cian | Segundo tono del degradado, gráficas, detalles de dato |
| Superficie | blanco sobre fondo fotográfico de taller | Tarjetas |
| Tinta | gris azulado muy oscuro | Texto principal |
| Semánticos | rojo / ámbar / azul | Crítico / advertencia / informativo — **separados del acento** |

Dos reglas que el mockup ya respeta y conviene mantener explícitas:

- **El degradado verde→cian es del acento, no del estado.** Una máquina en
  problema se pinta con `--status-danger`, nunca con el acento de marca.
- **El fondo fotográfico va detrás de tarjetas opacas**, no debajo de texto.
  Es ambiente, no soporte de lectura.

### Assets

Van en `backend/static/img/` (misma carpeta que `Logo_O2.png`):

| Asset | Uso | Estado |
|---|---|---|
| Logotipo NOPAL Intelligence (marca + texto) | Barra lateral en modo IA | Recibido |
| Isotipo (solo hexágono) | Favicon, barra colapsada | Recibido |
| Fondo de taller | Wallpaper del tema `ai` | Recibido |
| Render de impresora 3D | Tarjeta de dispositivo tipo impresora | Recibido |
| Render de CNC | Tarjeta de dispositivo tipo CNC | Recibido |
| Render de láser | Tarjeta de dispositivo tipo láser | Recibido |
| Mascota | Esquina del asistente | Recibido |

Los renders se aplican **por tipo de máquina**, no por máquina concreta: hay
tres tipos (impresora, CNC, láser) y cualquier equipo nuevo que se registre cae
en uno de ellos sin necesitar arte propio.

---

## 3. Inventario de tarjetas

Contrastado contra lo que `dashboard_service.get_dashboard_summary()` devuelve
hoy. **La regla es la misma que rige a la capa de IA: ningún número que NOPAL
no pueda medir.**

### Reales — se pueden construir ya

| Tarjeta | Origen |
|---|---|
| Estado del sistema | `system.health`, `services_online/total`, `uptime_seconds`, `update_status` |
| Rendimiento del host | `host.cpu_percent`, `mem_percent`, `disk_percent`, `load_average`, `cpu_history` |
| Red y conectividad | `host.ip`, `bandwidth_kbps`, `rx_gb`, `tx_gb` |
| Alertas y notificaciones | `alerts.error/warning/info` |
| Dispositivos | Las 5 marcas de impresora + láser/CNC, con estado, avance y temperaturas |
| Accesorios | Plugin `arduino-accessories` |
| Matriz LED | Plugin `matriz-led` |
| Asistente IA | `POST /api/ai/ask` — ya implementado |

### Estimadas — hay que etiquetarlas como tales

| Tarjeta | Realidad |
|---|---|
| Consumo actual | `power.active_watts` es la **suma de vatios nominales** configurados en Cotizador para las máquinas que trabajan ahora. El backend lo marca `"estimated": true`. No hay medidor de energía. |
| Eficiencia | No existe ningún cálculo así en NOPAL. |

La tarjeta debe decir "estimado" en la propia interfaz. Presentar una suma de
placas nominales como si fuera una medición es exactamente el tipo de dato
inventado que el resto del proyecto evita.

### Sin datos — decisión pendiente

| Tarjeta | Realidad | Camino para volverla real |
|---|---|---|
| Ambiente del taller | `dashboard_service` devuelve `"ambient": None`, con un comentario que dice que se deja nulo *"para que el frontend muestre un estado de sin datos en vez de un número inventado"* | Sensor **AHT20 o DHT22** (~$3 USD) en uno de los ESP8266 ya presentes en la LAN, expuesto por el plugin de accesorios Arduino |
| Próximo mantenimiento | `"maintenance": None` — no hay tracking de horas ni de intervalos | Acumular horas por máquina desde el historial de trabajos (`laser_history.json` como punto de partida) y compararlas contra intervalos configurables |

Ambas son features legítimas y alcanzables. La primera es una compra de tres
dólares sobre una arquitectura que ya existe; la segunda es desarrollo.

---

## 4. Fases

**Fase 1 — el ambiente.** Tema `ai`: paleta, fondo, logotipo, píldora "MODO IA
ACTIVADO" en la barra superior y en el menú. Sin tarjetas nuevas. Es el cambio
visible más grande y no depende de ningún dato nuevo.

**Fase 2 — las tarjetas. HECHA, y era mucho más chica de lo planeado.**

Al ir a construirlas resultó que **las siete ya existían** en el panel:
`panel-card-pos-estado`, `-host`, `-red`, `panel-card-alerts` y las tres
mini-tarjetas (`panel-ambient-value`, `panel-power-value`,
`panel-maintenance-value`). Y `renderPanelMiniCards()` ya resolvía bien la
falta de datos: muestra `panelNoSensor`, `panelEstimated` y `panelNoData` en
vez de inventar números.

Como todas se pintan con las variables del tema, **adoptan la paleta del modo
IA solas**. Lo único que hubo que agregar fue el logotipo y un par de ajustes
de superficie.

Esto también resuelve lo que el plan llamaba fase 3: el consumo ya se
etiqueta como estimado.

**Fase 3 — rediseño de las fichas de dispositivo.** Vista oficial de NOPAL:
render por tipo de máquina (`3D_IA.png`, `CNC_IA.png`, `LASER_IA.png`), anillo
de progreso y fila de métricas al pie. Igual en cualquier tema y con IA o sin
ella. **Pendiente.**

**Fase 4 — cerrar los huecos de datos.** Sensor ambiental y/o tracking de
mantenimiento, según se decida. Cada uno convierte una tarjeta que hoy dice
"sin datos" en una tarjeta con medición real.

---

## 5. Decisiones abiertas

1. **Ambiente del taller**: ¿se compra el sensor, o la tarjeta se muestra en
   estado "sin datos" hasta que exista?
2. **Próximo mantenimiento**: ¿se construye el tracking, o la tarjeta se omite
   en la primera versión?
3. **Consumo actual**: ¿se etiqueta como estimado, o se mide de verdad con un
   PZEM-004T en un ESP?

Ninguna bloquea la fase 1.
