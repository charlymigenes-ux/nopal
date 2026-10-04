# NOPAL Intelligence

Capa de IA **opcional y desacoplada** del core de NOPAL.

> La identidad visual del "MODO IA ACTIVADO" — paleta, fondo, logotipo y el
> bloque de tarjetas de resumen — se planea aparte en
> [MODO_IA_PLAN.md](MODO_IA_PLAN.md). Este documento cubre la capa que ya
> existe y funciona.

NOPAL no depende de ningún modelo ni proveedor. Habla contra cualquier servidor que
exponga la API estilo OpenAI (`/v1/chat/completions`): llama.cpp, vLLM, LM Studio,
Ollama (por su capa `/v1`) o, si el usuario lo habilita explícitamente, un proveedor
de nube. **No requiere ninguna suscripción para funcionar.**

Con la IA desactivada — el valor por omisión — NOPAL se comporta exactamente igual
que antes de que esta capa existiera.

## No es un chatbot pegado

El modelo no recibe la pregunta a secas. Recibe un catálogo de herramientas de solo
lectura de NOPAL, decide cuáles necesita, NOPAL las ejecuta contra sus servicios
reales, y recién con esos datos redacta.

```
pregunta -> modelo -> tool_calls -> NOPAL ejecuta -> datos reales
         -> modelo -> respuesta en lenguaje natural
```

Cada respuesta viaja con la traza de qué herramientas se consultaron, para que el
dato sea verificable.

## Arquitectura

| Archivo | Rol |
|---|---|
| `backend/services/ai_config_service.py` | Configuración (archivo JSON + variables de entorno), validación |
| `backend/services/ai_provider.py` | `AIProvider` (interfaz) + `OpenAICompatibleProvider` |
| `backend/services/ai_tools.py` | Catálogo de herramientas de **solo lectura** |
| `backend/services/ai_agent.py` | Ciclo pregunta → herramientas → respuesta |
| `backend/api/ai.py` | Router `/api/ai/*` |

Sigue el patrón `api/` + `services/` del resto de NOPAL. No introduce base de datos,
build step, framework de frontend ni dependencias nuevas más allá de `httpx` (que se
importa de forma perezosa: si falta, NOPAL arranca igual y solo la capa de IA avisa).

### Por qué un solo proveedor y no tres clases

El diseño conceptual distinguía proveedor local / LAN / nube. Los tres hablan el mismo
protocolo por el mismo cable: lo único que cambia es la `base_url` y si hace falta una
API key. Tres subclases idénticas serían tres lugares donde arreglar el mismo bug, así
que la distinción vive en la configuración. La clase base abstracta se mantiene para
que un protocolo genuinamente distinto pueda agregarse sin tocar el resto de NOPAL.

## Configuración

Archivo `ai_config.json` en la raíz del repo (gitignored, es estado por instalación,
igual que `spoolman_config.json`). Las variables de entorno lo pisan:

| Variable | Clave | Por omisión |
|---|---|---|
| `NOPAL_AI_ENABLED` | `enabled` | `false` |
| `NOPAL_AI_BASE_URL` | `base_url` | `""` |
| `NOPAL_AI_MODEL` | `model` | `""` |
| `NOPAL_AI_API_KEY` | `api_key` | `""` |
| `NOPAL_AI_TIMEOUT` | `timeout_s` | `60` |
| `NOPAL_AI_TOOL_MODE` | `tool_mode` | `auto` |
| `NOPAL_AI_ALLOW_PUBLIC_ENDPOINT` | `allow_public_endpoint` | `false` |

La API key nunca se manda al navegador; el frontend usa el centinela `__unchanged__`
para guardar el resto del formulario sin tocarla.

### Modos de herramientas

- `native` — function calling de la API estilo OpenAI. Es el camino bueno.
- `context` — NOPAL precarga el estado del taller y lo inyecta. Funciona con cualquier
  modelo, incluso uno de 1B que no sabe hacer tool calling. Los datos siguen siendo reales.
- `auto` (por omisión) — intenta `native`, cae a `context` si el servidor lo rechaza.

## Local o en la nube: lo decide el usuario

Ambas cosas son el mismo proveedor con distinta `base_url`. `GET /api/ai/presets`
devuelve un catálogo (OpenAI, Anthropic, Groq, OpenRouter, DeepSeek, servidor local u
"otro") para poblar el selector de la interfaz; un preset solo rellena la dirección, no
cambia nada del código.

Se pueden combinar en el tiempo: usar un proveedor de nube hoy y cambiar a un servidor
local cuando haya hardware, sin migrar nada — se edita la configuración y ya.

**NOPAL nunca elige la nube por su cuenta.** Un endpoint público exige activar a mano
`allow_public_endpoint`; si no, la validación lo rechaza. Al hacerlo, estos datos salen de
la red local hacia un tercero:

- Nombres y modelos de las máquinas registradas
- Estado de conexión, trabajo actual y avance
- Temperaturas, si la pregunta las involucra
- Mensajes de error de Klipper, Moonraker y GRBL
- Líneas del log de NOPAL, si la pregunta lo amerita

Esa lista viaja junto al catálogo en `/api/ai/presets` (campo `data_sent`) para que la
interfaz la muestre **antes** de que el usuario acepte, no después.

Lo local sigue siendo el camino por omisión y no requiere suscripción de ningún tipo.

## Qué hardware hace falta para el servidor de IA

NOPAL no ejecuta el modelo: habla con un servidor que lo ejecuta. Ese servidor puede estar
en la misma máquina o en cualquier otra de la LAN. Estas cifras son del servidor de IA, no
del equipo donde corre NOPAL.

El cuello de botella real es la **fase de prefill** (leer el prompt), no la generación. Es
cómputo matricial, y ahí una GPU rinde entre 100× y 1000× más que un CPU.

| Nivel | Hardware | Respuesta típica |
|---|---|---|
| Inservible | CPU sin GPU, 4 núcleos, modelo 7B | 3-6 min |
| Mínimo usable | ≥ 8 GB VRAM, o Apple Silicon ≥ 16 GB unificados | 5-10 s |
| Cómodo | 12-16 GB VRAM (ej. RTX 3060 12 GB) | 2-4 s |
| Modelos de 30B | 24 GB VRAM (ej. RTX 3090) | 3-6 s |

Referencia verificable, independiente de marca: **prefill ≥ 200 tok/s y generación ≥ 15
tok/s**. Por debajo de eso las respuestas tardan minutos y nadie usa la función.

Medición real en una instalación de referencia (Intel i7-6700T, 4 núcleos, 16 GB DDR4-2400
en canal doble, AVX2, sin GPU, Qwen2.5-7B Q4_K_M): **3.3 tok/s de prefill y 2.0 tok/s de
generación**, es decir ~6 minutos por respuesta. Un CPU de escritorio sin GPU no alcanza
para esta función, aunque cumpla de sobra para correr NOPAL.

Cuando el hardware no da, `tool_profile: "compact"` y `tool_mode: "context"` recortan el
prompt a la mitad. Ayudan, pero no convierten un CPU en algo interactivo.

## Seguridad

**Las herramientas de consulta son de solo lectura.** El catálogo de `ai_tools` son
funciones `get_*`; `backend/tests/test_ai_tools.py` verifica ese contrato: un nombre de
herramienta que empiece con un verbo de acción hace fallar la suite.

**Las acciones operativas viven en un registro aparte** (`backend/services/ai_actions.py`):
encender/apagar accesorios, activar escenas, crear o editar escenas, anuncios y reglas
de la Matriz LED, alertas por máquina, encolar archivos, precalentar, pausar/reanudar/
cancelar y asignar la bobina activa. Cada una pasa por tres controles, en este orden:

1. **Authorization Policy** (ADR-006, `docs/SDD.md` §18.8): la acción declara su
   acción canónica de la política y la política decide con el usuario autenticado real
   y el recurso real (la máquina o el plugin). La IA no tiene una tabla de permisos
   propia: lo que un operador no puede hacer en el panel, tampoco lo logra pidiéndoselo
   a la IA.
2. **Interruptor `actions_enabled`**, apagado por omisión: con él apagado la IA solo
   consulta, y se revalida en el punto de ejecución (un modelo puede inventarse el
   nombre de una acción).
3. **Riesgo**: las de riesgo `confirm` (precalentar, pausar/reanudar/cancelar, crear o
   editar escenas) no se ejecutan; quedan pendientes hasta que la misma persona las
   confirma, y al confirmar se vuelve a autorizar.

Las herramientas que declaran los plugins (`AI_TOOLS`) siguen su propio contrato, ver
"Contrato de `AI_TOOLS`".

No hay herramientas para mover ejes, hacer home, mandar G-code o consola, resetear el
MCU ni ejecutar shell. **Láser y CNC nunca deben poder arrancarse autónomamente por IA**:
no existe la herramienta, y un test de `test_ai_actions.py` falla si alguien la agrega.

Por omisión solo se permiten endpoints en localhost o la LAN. Apuntar a internet exige
activar `allow_public_endpoint` a mano: mandar telemetría del taller afuera tiene que
ser una decisión explícita, no el resultado de escribir mal una IP.

## Endpoints

| Método | Ruta | Permiso |
|---|---|---|
| `GET` | `/api/ai/status` | autenticado |
| `GET`/`PUT` | `/api/ai/config` | **admin** |
| `POST` | `/api/ai/test` | **admin** |
| `GET` | `/api/ai/tools` | autenticado |
| `POST` | `/api/ai/tools/{nombre}` | autenticado |
| `POST` | `/api/ai/ask` | autenticado |

`POST /api/ai/tools/{nombre}` ejecuta una herramienta sin pasar por el modelo. Sirve
para verificar los datos que vería la IA sin depender de que haya un servidor conectado.
Las herramientas de plugins pasan aquí por la misma autorización que desde el agente
(ver "Contrato de `AI_TOOLS`"): sin permiso o con las acciones apagadas responde 403.

## Herramientas disponibles

Todas devuelven JSON estructurado. Cuando un dato no se puede saber devuelven
`{"available": false, "reason": ...}` en vez de inventarlo.

`get_workshop_status` · `get_machines` · `get_machine_status` · `get_machine_temperatures`
· `get_active_jobs` · `get_job_progress` · `get_recent_errors` · `get_recent_events`
· `get_klipper_status` · `get_grbl_status` · `get_material_status`
· `get_plugins` · `get_accessories` · `get_cameras`

### Integración con plugins

El core **no debe tener que conocer cada plugin**. Hay dos caminos, y el
segundo es el que escala:

1. **Herramientas del core que leen plugins opcionalmente** —
   `get_accessories`, `get_cameras` y `get_material_status` usan
   `get_loaded_plugin_module`, el mismo patrón best-effort que ya usaban
   `dashboard_service` y `notification_service`. Si el plugin no está
   instalado devuelven `{"available": false}` en vez de romper.

2. **Herramientas que el plugin declara por su cuenta** — si un módulo de
   un plugin define `AI_TOOLS` (una lista de `ai_tools.Tool`),
   `plugin_loader_service.get_plugin_ai_tools()` las recoge y, si cumplen el
   contrato de abajo, se suman al catálogo. Un plugin nuevo puede exponerse a
   la IA **sin tocar el core**, igual que ya declara su `router`.

#### Contrato de `AI_TOOLS`

Cada herramienta de plugin se autoriza con la Authorization Policy de NOPAL
(ADR-006, ver `docs/SDD.md` §18.8) antes de ejecutarse.

```python
from backend.services.ai_tools import Tool
from backend.services.authorization_policy import Action

AI_TOOLS = [
    Tool("get_estado_de_mi_plugin", "Lee el estado del plugin.", leer_estado,
         policy_action=Action.USE_PLUGIN),
    Tool("disparar_mi_plugin", "Hace algo con el plugin.", disparar,
         policy_action=Action.USE_PLUGIN, read_only=False),
    Tool("configurar_mi_plugin", "Cambia la configuración del plugin.", configurar,
         policy_action=Action.CONFIGURE_PLUGIN),
]
```

- **`policy_action` es obligatorio** y tiene que ser uno de los dos Enums
  canónicos de `authorization_policy.Action`: `Action.USE_PLUGIN` o
  `Action.CONFIGURE_PLUGIN`. Su texto (`"use_plugin"`) no cuenta.
- **`USE_PLUGIN`**: usar el plugin; la política lo permite a operador y admin.
- **`CONFIGURE_PLUGIN`**: cambiar configuración o comportamiento persistente
  del plugin; la política exige **admin**.
- **`read_only`** (por omisión `True`): una herramienta que cambia estado debe
  declarar `read_only=False`. Las que cambian estado, y siempre las de
  `CONFIGURE_PLUGIN`, requieren además que `actions_enabled` esté encendido.
  Orden: primero la política (¿puede?), después el interruptor.
- **El `plugin_id` lo determina el core**, a partir del paquete donde se cargó
  el módulo (`nopal_plugins.<id>`), comparado con los plugins instalados. El
  recurso que ve la política es `plugin:<id>`; el plugin no lo elige.
- **La identidad sale del usuario autenticado** que inició la operación (en
  `/api/ai/ask` o en `POST /api/ai/tools/{nombre}`): `user_id` y rol de la
  sesión, con los que el core arma el principal. Ni el plugin ni el modelo
  pueden proporcionar identidad: los argumentos se filtran por el esquema, los
  atributos que el plugin agregue a su `Tool` se ignoran, y una herramienta
  que declare parámetros `role`, `user_id`, `user`, `username`, `principal` o
  `scope` no se acepta. El handler no recibe la identidad del usuario.
- **Lo que no cumple el contrato queda fuera del registro y no se expone**:
  sin `policy_action`, con cualquier otra acción (temperatura, movimiento,
  consola, potencia, archivos, sistema…), con parámetros de identidad, o con
  el nombre de una herramienta del core o de una acción de `ai_actions`. Se
  salta con una advertencia en el log; un plugin roto nunca tumba la capa de
  IA. Si una herramienta necesita otra acción, hay que definirla antes de
  forma explícita.
- El catálogo que ve el modelo (y `GET /api/ai/tools`) solo incluye las
  herramientas que ese usuario podría ejecutar.
- **No hay confirmación automática.** Las herramientas de plugin no tienen el
  flujo `risk="confirm"` de `ai_actions` (acción pendiente que la persona
  confirma): se ejecutan en cuanto la política y el interruptor lo permiten.
- **Límite del modelo de confianza.** El código de un plugin corre dentro del
  proceso de NOPAL (trusted, in-process). Este contrato controla lo que se
  ejecuta *como herramienta de IA*; no impide que el código del plugin, fuera
  de él, llame directamente a otros servicios. Eso queda fuera de alcance.

Otras reglas del punto de extensión:

- Las del core ganan ante un choque de nombres: un plugin no puede sustituir
  una herramienta central por una suya.
- El perfil `compact` deja fuera las de plugins: son justo las que sobran
  cuando el servidor de IA es lento.

`get_plugins` es la herramienta que cierra el círculo — sin ella el modelo no
sabe siquiera que NOPAL es extensible y niega capacidades que un plugin
instalado ya resuelve. Por eso pertenece al núcleo pese al costo en tokens.

`get_camera_snapshot` está registrada pero **no se le ofrece al modelo** (`exposed=False`):
la arquitectura queda lista para un modelo multimodal futuro, pero no hay implementación
todavía. Una IA de visión nunca debe ser el único mecanismo de detección de incendio,
humo, choque, runaway térmico o presencia humana.

### Identidad de máquina

NOPAL no tiene un id único global: cada marca identifica lo suyo a su manera. Se
construye un id compuesto `<tipo>:<id-nativo>` (`klipper:7125`, `laser:192.168.0.61`) y
además se acepta el nombre visible, porque es lo que el usuario escribe en su pregunta.

## Reutilización

`get_workshop_status()` no agrega tracking nuevo: envuelve
`dashboard_service.get_dashboard_summary()`, el mismo agregado que ya alimenta al panel
de control. `get_recent_errors()` reusa `notification_service.get_notifications()`.
`get_material_status()` usa el plugin de Materiales vía `get_loaded_plugin_module`, con
el mismo patrón best-effort que ya usa el core para cámaras y Cotizador.
