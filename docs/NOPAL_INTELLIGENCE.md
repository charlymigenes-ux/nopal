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

**Esta versión es de solo lectura.** El catálogo entero son funciones `get_*`. No hay
ninguna herramienta que inicie o cancele trabajos, mueva ejes, haga home, caliente,
active el láser o el CNC, resetee el MCU, controle relés ni ejecute shell.
`backend/tests/test_ai_tools.py` verifica ese contrato: un nombre de herramienta que
empiece con un verbo de acción hace fallar la suite.

Las futuras acciones físicas irán en un registro aparte y requerirán confirmación del
usuario. **Láser y CNC nunca deben poder arrancarse autónomamente por IA.**

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

## Herramientas disponibles

Todas devuelven JSON estructurado. Cuando un dato no se puede saber devuelven
`{"available": false, "reason": ...}` en vez de inventarlo.

`get_workshop_status` · `get_machines` · `get_machine_status` · `get_machine_temperatures`
· `get_active_jobs` · `get_job_progress` · `get_recent_errors` · `get_recent_events`
· `get_klipper_status` · `get_grbl_status` · `get_material_status`

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
