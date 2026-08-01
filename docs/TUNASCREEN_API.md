# Contrato TUNA-Screen ↔ NOPAL

TUNA-Screen es un cliente de NOPAL. No se conecta directamente a Klipper,
Marlin, GRBL, Bambu, Elegoo ni FlashForge. El contrato actual es la versión
`1` y vive bajo `/api/tunascreen/*` y `/ws/tunascreen`.

## Descubrimiento y emparejamiento

- `GET /api/tunascreen/info`: identificación pública del servidor, versión
  de NOPAL, versión del contrato y ruta del WebSocket.
- `POST /api/tunascreen/pair/start`: genera un código temporal; requiere una
  sesión web con rol `admin`.
- `POST /api/tunascreen/pair/confirm`: canjea el código por un token
  permanente de dispositivo.
- `GET/DELETE /api/tunascreen/devices`: administración de dispositivos
  pareados; requiere rol `admin`.

El token se envía como `Authorization: Bearer <token>`. No debe ir en query
params ni registrarse en logs.

## Estado de máquinas

- `GET /api/tunascreen/machines`: snapshot normalizado.
- `GET /api/tunascreen/machine/{id}`: detalle de una máquina.
- `GET /api/tunascreen/config`: bootstrap autocontenido para clientes nuevos.
- `WS /ws/tunascreen`: snapshots en vivo con el envelope:

```json
{
  "type": "machines",
  "api_version": 1,
  "machines": []
}
```

Cada máquina contiene:

- `id`: identificador opaco con prefijo de driver.
- `name`: nombre visible.
- `type`: `printer`, `laser` o `cnc`.
- `driver`: integración de NOPAL que la controla.
- `online`: conectividad actual.
- `capabilities`: datos/funciones que la UI puede representar.
- `actions`: órdenes que ese driver realmente puede ejecutar.
- `status`: telemetría normalizada.

`capabilities` y `actions` no son lo mismo. Por ejemplo, una Bambu puede
reportar `temperature`, pero si su integración no permite cambiar el
objetivo no anuncia `set_temperature`.

### Cámara vinculada

Si el plugin `camera-viewer` está instalado y esta máquina puntual tiene una
cámara vinculada (propósito "timelapse" + dispositivo asociado, configurado
desde el panel de NOPAL), la máquina anuncia la capability `camera` y
`status.camera` viene con:

```json
{
  "stream_url": "http://192.168.1.50:8080/stream",
  "name": "Cámara del taller"
}
```

`stream_url` puede ser relativa (cámaras USB servidas por el propio NOPAL,
ej. `/api/cameras/usb/{id}/stream`) o absoluta (URL directa/ONVIF/RTSP
puenteada) -- si es relativa, resolverla contra el mismo host base que ya se
usa para `/api/tunascreen/*`. Sin la capability `camera`, `status.camera` es
`null` -- no hay cámara vinculada a esa máquina (o el plugin no está
instalado).

## Acciones

`POST /api/tunascreen/action`

```json
{
  "machine_id": "klipper:7125",
  "action": "move",
  "params": {"axis": "X", "distance": 5, "feed": 1200}
}
```

La app sólo debe habilitar una acción si:

1. `online` es `true`;
2. el nombre aparece en `machine.actions`;
3. el estado actual permite la operación (por ejemplo, pausar exige un
   trabajo activo).

Acciones versión 1:

- Comunes: `pause`, `resume`, `cancel`.
- Movimiento: `home`, `move`.
- Impresora: `extrude`, `set_temperature`, `set_fan`,
  `set_speed_factor`, `set_flow_factor`.
- Klipper: `set_z_offset`, `run_macro`, `send_console_command`.
- Marlin: `send_console_command` (sin macros ni offset Z normalizado).
- Láser: `set_laser_power`, `set_air_assist`.
- CNC: `set_work_zero`, `set_spindle`, `set_coolant`.

Todas las entradas se validan en NOPAL. Una acción desconocida, un eje
inválido, un valor fuera de rango o una máquina fuera de línea devuelve
HTTP 400 y nunca se envía al hardware.

Los macros y el historial de consola de Klipper se consultan con:

- `GET /api/tunascreen/machine/{id}/macros`
- `GET /api/tunascreen/machine/{id}/console?count=50`

## Responsabilidad de la interfaz

La resolución física decide la densidad visual, no cambia el contrato:

- 3.5"/4.3": modo máquina esencial.
- 5": modo máquina avanzado.
- 7": máquina o multimáquina.
- 10": taller.
- PC: dashboard completo.

Impresora 3D, láser y CNC comparten el sistema visual, pero cada una muestra
únicamente su telemetría, capacidades y acciones correspondientes.
