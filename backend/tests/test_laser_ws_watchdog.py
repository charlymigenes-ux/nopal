"""Recuperación del WebSocket de las placas FluidNC de red.

Una placa que pierde corriente o WiFi no cierra el socket: sigue ESTAB para el
servidor y `recv()` espera para siempre, así que NOPAL nunca reconectaba. El
listener ahora le pregunta con '?' tras un silencio y, solo si varias
preguntas seguidas quedan sin respuesta, cierra y reconecta.

Todo se simula con una placa falsa (sin red ni apagar nada), con tiempos de
milisegundos en lugar de los reales.
"""

import asyncio
import logging
import time

import pytest
import pytest_asyncio
import websockets
import websockets.exceptions

import backend.services.laser_service as laser_service

STATUS_FRAME = "<Idle|MPos:0.000,0.000,0.000|FS:0,0>"
HOST_A, HOST_B = "10.9.9.1", "10.9.9.2"


class FakeBoard:
    """Una placa: HTTP (para los '?'), y los WebSockets que se le abrieron."""

    def __init__(self, loop):
        self.loop = loop
        self.http_up = True
        self.responsive = True      # contesta a '?' en sus conexiones vivas
        self.connections = []
        self.connect_count = 0
        self.commands = []
        self.frame = STATUS_FRAME           # lo que contesta a '?'
        self.ready_at_enter = []            # ready_event visto al abrir cada conexión
        self.host = None

    def power_off(self):
        # Sin FIN/RST: los sockets existentes siguen "abiertos" para NOPAL.
        self.http_up = False
        self.responsive = False

    def power_on(self):
        # La placa arranca sin recordar ninguna conexión TCP anterior.
        for conn in self.connections:
            conn.dead = True
        self.http_up = True
        self.responsive = True

    def push(self, text):
        for conn in self.connections:
            if not conn.dead and not conn.closed:
                self.loop.call_soon_threadsafe(conn.queue.put_nowait, text)

    def send(self, command):
        self.commands.append(command)
        if not self.http_up:
            return False
        if command == "?" and self.responsive:
            self.push(self.frame)
        return True

    def drop(self, conn, exc):
        """La placa cierra el socket (limpio o anormal): la próxima lectura lanza `exc`."""
        conn.fail = exc
        self.loop.call_soon_threadsafe(conn.queue.put_nowait, "")

    @property
    def open_connections(self):
        return [c for c in self.connections if not c.closed]


class FakeWS:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.dead = False      # zombi: el otro extremo ya no existe
        self.closed = False
        self.fail = None

    async def recv(self):
        item = await self.queue.get()
        if self.fail is not None:
            raise self.fail
        return item


class FakeConnect:
    def __init__(self, board):
        self.board = board
        self.ws = None

    async def __aenter__(self):
        event = laser_service._listener_ready_events.get(self.board.host)
        self.board.ready_at_enter.append(bool(event and event.is_set()))
        if not self.board.http_up:
            raise OSError("sin ruta a la placa")
        self.ws = FakeWS()
        self.board.connections.append(self.ws)
        self.board.connect_count += 1
        return self.ws

    async def __aexit__(self, exc_type, exc, tb):
        self.ws.closed = True
        return False


@pytest_asyncio.fixture
async def boards(monkeypatch):
    loop = asyncio.get_running_loop()
    registry = {HOST_A: FakeBoard(loop), HOST_B: FakeBoard(loop)}
    for host, board in registry.items():
        board.host = host
    firmware = {}

    def fake_connect(uri, **kwargs):
        host = uri.split("//")[1].split(":")[0].rstrip("/")
        return FakeConnect(registry[host])

    def fake_send(host, command, *, allow_during_job=False):
        return registry[host].send(command)

    monkeypatch.setattr(laser_service.websockets, "connect", fake_connect)
    monkeypatch.setattr(laser_service, "send_raw_command", fake_send)
    monkeypatch.setattr(laser_service, "_firmware_for_host", lambda host: firmware.get(host, "fluidnc"))
    registry["firmware"] = firmware
    monkeypatch.setattr(laser_service, "WS_IDLE_PROBE_S", 0.05)
    monkeypatch.setattr(laser_service, "WS_REPLY_WAIT_S", 0.03)
    monkeypatch.setattr(laser_service, "WS_MAX_MISSES", 2)
    monkeypatch.setattr(laser_service, "WS_MAX_MISSES_DURING_JOB", 4)
    monkeypatch.setattr(laser_service, "WS_RECONNECT_DELAY_S", 0.02)
    yield registry
    for host in (HOST_A, HOST_B):
        task = laser_service._listener_tasks.pop(host, None)
        if task is not None:
            task.cancel()
        laser_service._jobs.pop(host, None)
        for store in (laser_service._subscribers, laser_service._listener_ready_events,
                      laser_service._ws_was_connected, laser_service._ws_verified, laser_service._sd_upload_activity,
                      laser_service._console_buffers):
            store.pop(host, None)


async def wait_until(condition, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return True
        await asyncio.sleep(0.005)
    return False


def ready(host):
    event = laser_service._listener_ready_events.get(host)
    return bool(event and event.is_set())


async def start(host):
    laser_service.ensure_listener(host)
    assert await wait_until(lambda: ready(host))


async def test_zombie_socket_is_detected_closed_and_replaced(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    first = board.connections[0]

    board.power_off()
    # El socket sigue "abierto" pero sin respuestas: se debe detectar y limpiar.
    assert await wait_until(lambda: first.closed)
    assert not ready(HOST_A)

    board.power_on()
    assert await wait_until(lambda: ready(HOST_A) and board.connect_count == 2)
    assert first.closed and len(board.open_connections) == 1


async def test_ready_event_is_not_set_until_new_connection_exists(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    board.power_off()
    assert await wait_until(lambda: not ready(HOST_A))
    # Mientras la placa siga caída el reintento falla y ready no vuelve.
    await asyncio.sleep(0.2)
    assert not ready(HOST_A)
    assert len(board.open_connections) == 0


async def test_silent_but_healthy_board_is_not_closed(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    # Varios ciclos de silencio: la placa contesta a cada '?', no se toca el socket.
    await asyncio.sleep(0.5)
    assert board.connect_count == 1 and ready(HOST_A)
    assert board.commands.count("?") >= 3


async def test_no_probe_while_frames_keep_arriving(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    # Lo único que se manda es la verificación del socket recién abierto.
    for _ in range(10):
        board.push("ok")
        await asyncio.sleep(0.02)
    assert board.commands == ["?"]


async def test_repeated_recovery_five_times(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    for cycle in range(1, 6):
        board.power_off()
        assert await wait_until(lambda: not ready(HOST_A)), f"ciclo {cycle}: no detectó la caída"
        board.power_on()
        assert await wait_until(lambda: ready(HOST_A) and len(board.open_connections) == 1), f"ciclo {cycle}"
    assert board.connect_count == 6
    assert len(board.open_connections) == 1


async def test_reconnection_is_logged_and_not_collapsed_by_repeat_filter(boards, caplog):
    """Un "WS conectado" idéntico al de minutos antes lo agrupaba el filtro de
    repetidos del log: la reconexión real no se veía. Cada reconexión lleva
    ahora la duración de la caída y es un mensaje distinto."""
    from backend.services.logging_config_service import RepeatFilter

    board = boards[HOST_A]
    with caplog.at_level(logging.INFO, logger=laser_service.logger.name):
        await start(HOST_A)
        for _ in range(2):
            board.power_off()
            assert await wait_until(lambda: not ready(HOST_A))
            await asyncio.sleep(0.05)       # que la duración difiera entre ciclos
            board.power_on()
            assert await wait_until(lambda: ready(HOST_A))

    messages = [r.getMessage() for r in caplog.records if "WS " in r.getMessage()]
    reconnects = [m for m in messages if "WS reconectado" in m]
    assert len(reconnects) == 2 and all("sin conexión" in m for m in reconnects)
    assert sum("WS conectado" in m for m in messages) == 1     # solo el primero

    repeat_filter = RepeatFilter(window_s=3600)
    shown = [r for r in caplog.records if r.name == laser_service.logger.name and repeat_filter.filter(r)]
    assert sum("WS reconectado" in r.getMessage() for r in shown) == 2


async def test_single_listener_task_and_no_duplicate_subscribers(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    task = laser_service._listener_tasks[HOST_A]
    for _ in range(5):
        laser_service.ensure_listener(HOST_A)
    assert laser_service._listener_tasks[HOST_A] is task

    queue = laser_service._subscribe(HOST_A)
    board.power_off()
    assert await wait_until(lambda: not ready(HOST_A))
    board.power_on()
    assert await wait_until(lambda: ready(HOST_A))
    laser_service.ensure_listener(HOST_A)

    # La misma tarea sobrevivió a la caída y el suscriptor no se duplicó.
    assert laser_service._listener_tasks[HOST_A] is task and not task.done()
    assert laser_service._subscribers[HOST_A] == [queue]

    while not queue.empty():
        queue.get_nowait()
    board.push("hola")
    assert await asyncio.wait_for(queue.get(), 1) == "hola"
    await asyncio.sleep(0.02)
    assert queue.empty()      # entregado una sola vez
    laser_service._unsubscribe(HOST_A, queue)


async def test_status_works_again_after_recovery(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    assert (await laser_service.get_status(HOST_A, timeout=1))["state"] == "Idle"

    board.power_off()
    # Con el zombi y la placa caída no hay estado.
    assert await laser_service.get_status(HOST_A, timeout=0.2) is None

    board.power_on()
    # La placa vuelve a responder por HTTP pero el WS viejo ya no sirve: hasta
    # que se reconecta no hay estado; después sí, sin reiniciar nada.
    async def status_ok():
        status = await laser_service.get_status(HOST_A, timeout=0.3)
        return bool(status and status["state"] == "Idle")

    end = time.monotonic() + 3
    recovered = False
    while time.monotonic() < end and not recovered:
        recovered = await status_ok()
    assert recovered


async def test_pending_responses_are_not_replayed_after_a_drop(boards):
    board = boards[HOST_A]
    await start(HOST_A)
    queue = laser_service._subscribe(HOST_A)
    board.power_off()
    assert await wait_until(lambda: not ready(HOST_A))
    board.power_on()
    assert await wait_until(lambda: ready(HOST_A))
    # Nada del socket anterior se reinyecta ni se reenvía solo ningún comando
    # que no sea el '?' de lectura.
    assert queue.empty() or queue.get_nowait() == STATUS_FRAME
    assert set(board.commands) <= {"?"}
    laser_service._unsubscribe(HOST_A, queue)


async def test_comm_lost_is_a_latch_that_reopening_the_socket_does_not_clear(boards):
    board = boards[HOST_A]
    job = laser_service.LaserJob(HOST_A, ["G1 X1"], "t.gc", source="sd")
    laser_service._jobs[HOST_A] = job
    await start(HOST_A)

    board.power_off()
    assert await wait_until(lambda: job.comm_lost)
    assert job.state == "running"          # este objeto no corre _run_sd_job; solo se prueba el pestillo
    assert job.to_dict()["comm_lost"] is True

    # La placa vuelve: socket nuevo, y hasta con frames válidos, el pestillo sigue.
    board.power_on()
    assert await wait_until(lambda: ready(HOST_A) and laser_service._ws_connected(HOST_A))
    assert job.comm_lost is True
    await asyncio.sleep(0.15)
    assert job.comm_lost is True


async def test_active_job_waits_longer_before_closing(boards):
    board = boards[HOST_A]
    laser_service._jobs[HOST_A] = laser_service.LaserJob(HOST_A, ["G1 X1"], "t.gc", source="sd")
    await start(HOST_A)
    first = board.connections[0]
    board.power_off()
    # Sin trabajo basta con 2 preguntas (~0.11 s); con trabajo hacen falta 4.
    await asyncio.sleep(0.14)
    assert not first.closed
    assert await wait_until(lambda: first.closed)


async def test_other_boards_are_unaffected_by_one_drop(boards):
    a, b = boards[HOST_A], boards[HOST_B]
    await start(HOST_A)
    await start(HOST_B)
    b_conn = b.connections[0]
    a.power_off()
    assert await wait_until(lambda: not ready(HOST_A))
    await asyncio.sleep(0.2)
    assert ready(HOST_B) and not b_conn.closed and b.connect_count == 1
    a.power_on()
    assert await wait_until(lambda: ready(HOST_A))
    assert b.connect_count == 1


async def test_two_boards_drop_and_recover_together(boards):
    a, b = boards[HOST_A], boards[HOST_B]
    await start(HOST_A)
    await start(HOST_B)
    for _ in range(3):
        a.power_off(); b.power_off()
        assert await wait_until(lambda: not ready(HOST_A) and not ready(HOST_B))
        a.power_on(); b.power_on()
        assert await wait_until(lambda: ready(HOST_A) and ready(HOST_B))
    assert len(a.open_connections) == 1 and len(b.open_connections) == 1


async def test_clean_close_by_the_board_reconnects(boards, monkeypatch):
    board = boards[HOST_A]
    await start(HOST_A)

    original = FakeWS.recv
    state = {"closed_once": False}

    async def recv(self):
        if not state["closed_once"]:
            state["closed_once"] = True
            raise websockets.exceptions.ConnectionClosedOK(None, None)
        return await original(self)

    monkeypatch.setattr(FakeWS, "recv", recv)
    board.push("x")        # desbloquea el recv() en curso para que tome el parche
    assert await wait_until(lambda: board.connect_count >= 2 and ready(HOST_A))


def test_ws_connected_is_none_for_usb_and_unknown_hosts():
    assert laser_service._ws_connected("usb:/dev/ttyUSB9") is None
    assert laser_service._ws_connected("10.9.9.77") is None


def test_ws_connected_never_persisted_in_registry():
    assert "ws_connected" in laser_service._TRANSIENT_FIELDS


def test_usb_hosts_still_use_the_serial_listener(monkeypatch):
    calls = []
    monkeypatch.setattr(laser_service, "_ensure_serial_listener", lambda host: calls.append(("serial", host)))
    monkeypatch.setattr(laser_service, "_ensure_ws_listener", lambda host: calls.append(("ws", host)))
    laser_service.ensure_listener("usb:/dev/ttyUSB9")
    assert calls == [("serial", "usb:/dev/ttyUSB9")]


# ── F4: ready_event ante cierres normales y excepcionales ──

@pytest.mark.parametrize("exc", [
    websockets.exceptions.ConnectionClosedError(None, None),
    websockets.exceptions.ConnectionClosedOK(None, None),
], ids=["cierre_anormal", "cierre_voluntario"])
async def test_ready_event_is_cleared_before_any_new_candidate_is_tried(boards, exc):
    board = boards[HOST_A]
    await start(HOST_A)
    assert board.ready_at_enter == [False]        # el primer intento arranca sin ready

    board.drop(board.connections[0], exc)
    assert await wait_until(lambda: board.connect_count >= 2 and ready(HOST_A))
    # Al abrir el siguiente candidato (o reintentar) ya no se daba por listo el socket perdido.
    assert board.ready_at_enter[1] is False


async def test_abnormal_close_flags_the_active_job_and_a_clean_close_too(boards):
    board = boards[HOST_A]
    job = laser_service.LaserJob(HOST_A, [], "t.gc", source="sd")
    laser_service._jobs[HOST_A] = job
    await start(HOST_A)
    board.drop(board.connections[0], websockets.exceptions.ConnectionClosedOK(None, None))
    assert await wait_until(lambda: job.comm_lost)


async def test_ws_connected_needs_a_real_frame_not_just_the_handshake(boards):
    board = boards[HOST_A]
    board.responsive = False                       # contesta el handshake pero no los '?'
    laser_service.ensure_listener(HOST_A)
    assert await wait_until(lambda: ready(HOST_A))
    await asyncio.sleep(0.02)
    assert laser_service._ws_connected(HOST_A) is False
    board.push("<Idle|MPos:0.000,0.000,0.000|FS:0,0>")
    assert await wait_until(lambda: laser_service._ws_connected(HOST_A) is True)


async def test_loss_while_a_file_is_still_uploading_is_not_an_interruption(boards):
    board = boards[HOST_A]
    job = laser_service.LaserJob(HOST_A, [], "t.gc", source="sd")
    job.phase = "uploading"
    laser_service._jobs[HOST_A] = job
    await start(HOST_A)
    board.power_off()
    assert await wait_until(lambda: not ready(HOST_A))
    assert job.comm_lost is False                  # todavía no corría nada en la placa


# ── R2: el sondeo solo existe para FluidNC ──

async def test_marlin_over_network_never_receives_the_probe(boards):
    board = boards[HOST_B]
    boards["firmware"][HOST_B] = "marlin"
    await start(HOST_B)
    board.power_off()                              # silencio total
    await asyncio.sleep(0.5)                       # varios ciclos del watchdog
    assert board.commands == []                    # ni un '?' como G-code
    assert board.connect_count == 1 and not board.connections[0].closed


async def test_fluidnc_neighbour_is_still_watched_next_to_a_marlin_host(boards):
    boards["firmware"][HOST_B] = "marlin"
    a = boards[HOST_A]
    await start(HOST_A)
    await start(HOST_B)
    a.power_off()
    assert await wait_until(lambda: not ready(HOST_A))
    assert boards[HOST_B].commands == [] and ready(HOST_B)


# ── R1: subida prolongada a la SD ──

def _slow_upload_post(chunk_delay, chunks=None):
    """requests.post falso: lee el cuerpo despacio, como una subida lenta por WiFi."""
    def fake_post(url, data=None, headers=None, timeout=None, **kwargs):
        read = 0
        while True:
            chunk = data.read(1024)
            if not chunk:
                break
            time.sleep(chunk_delay)
            read += 1
            if chunks is not None and read >= chunks:
                time.sleep(chunk_delay * 40)       # se atora: deja de avanzar
                break
        return type("R", (), {"ok": True, "status_code": 200})()
    return fake_post


async def test_long_sd_upload_does_not_make_the_watchdog_close_a_live_board(boards, monkeypatch):
    board = boards[HOST_A]
    board.responsive = False                       # ocupada escribiendo en la SD: no contesta '?'
    await start(HOST_A)
    first = board.connections[0]
    commands_before = list(board.commands)
    monkeypatch.setattr(laser_service.requests, "post", _slow_upload_post(0.02))

    loop = asyncio.get_running_loop()
    upload = loop.run_in_executor(None, laser_service.sd_upload_file_tracked,
                                  HOST_A, "/", "a.gc", b"x" * 40_000, "up-1")   # ~0.8 s, ~16x el umbral del watchdog
    await asyncio.sleep(0.5)
    assert not first.closed and ready(HOST_A)      # mucho más que el umbral de cierre sin grace
    assert board.commands == commands_before       # y sin sondear mientras avanza
    await upload
    assert laser_service.get_sd_upload_progress("up-1")["status"] == "done"
    assert HOST_A not in laser_service._sd_upload_activity

    # Terminada la subida, la placa sigue muda: el watchdog vuelve a actuar.
    assert await wait_until(lambda: first.closed)


async def test_stalled_sd_upload_does_not_protect_a_dead_board(boards, monkeypatch):
    board = boards[HOST_A]
    board.responsive = False
    await start(HOST_A)
    first = board.connections[0]
    monkeypatch.setattr(laser_service, "WS_UPLOAD_PROGRESS_GRACE_S", 0.1)
    monkeypatch.setattr(laser_service.requests, "post", _slow_upload_post(0.02, chunks=3))

    loop = asyncio.get_running_loop()
    upload = loop.run_in_executor(None, laser_service.sd_upload_file_tracked,
                                  HOST_A, "/", "a.gc", b"x" * 40_000, "up-2")
    assert await wait_until(lambda: first.closed, timeout=2)   # sin avance > grace: cuenta como muda
    await upload


# ── USB / otros drivers ──

def test_usb_hosts_have_no_ws_state_and_no_watchdog_effects():
    assert laser_service._ws_connected("usb:/dev/ttyUSB0") is None
    laser_service._mark_job_comm_lost("usb:/dev/ttyUSB0")      # sin trabajo: no pasa nada


# ── F1/F2: integridad de trabajos SD ──

IDLE = "<Idle|MPos:0.000,0.000,0.000|FS:0,0>"
RUN40 = "<Run|MPos:1.000,2.000,0.000|FS:1200,800|SD:40.00,/sd/x.gc>"
RUN_NO_SD = "<Run|MPos:1.000,2.000,0.000|FS:1200,800>"


@pytest.fixture
def sd_env(monkeypatch, tmp_path):
    monkeypatch.setattr(laser_service, "HISTORY_PATH", str(tmp_path / "history.json"))
    monkeypatch.setattr(laser_service, "REGISTRY_PATH", str(tmp_path / "registry.json"))
    real_sleep = asyncio.sleep

    async def quick_sleep(delay, *args, **kwargs):
        # Las pausas de _run_sd_job (2 s, 0.5 s) a milisegundos; las cortas, tal cual.
        await real_sleep(0.003 if delay >= 0.3 else delay, *args, **kwargs)

    monkeypatch.setattr(laser_service.asyncio, "sleep", quick_sleep)
    return real_sleep


def history_state(job):
    return next(e for e in laser_service._load_history() if e["id"] == job.job_id)


def _status(frame):
    return laser_service._parse_grbl_status_line(frame)


class Scripted:
    """get_status guionado: cada paso es un estado y, opcionalmente, algo que
    ocurre justo antes de devolverlo (p. ej. caerse la conexión)."""

    def __init__(self, job, steps):
        self.job, self.steps, self.calls = job, list(steps), 0

    async def __call__(self, host, timeout=3.0):
        self.calls += 1
        frame, action = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        if action:
            action(self.job)
        return _status(frame)


def lose_comm(job):
    job.comm_lost = True


async def run_scripted(monkeypatch, steps, job=None):
    job = job or laser_service.LaserJob(HOST_A, [], "x.gc", source="sd")
    laser_service._jobs[HOST_A] = job
    laser_service.begin_laser_job_history(job)
    monkeypatch.setattr(laser_service, "send_raw_command", lambda *a, **k: True)
    scripted = Scripted(job, steps)
    monkeypatch.setattr(laser_service, "get_status", scripted)
    await asyncio.wait_for(laser_service._run_sd_job(job), 5)
    return job, scripted


async def test_sd_job_that_finishes_normally_still_completes(sd_env, monkeypatch):
    job, _ = await run_scripted(monkeypatch, [(RUN40, None), (IDLE, None)])
    assert job.state == "completed" and job.current == job.total == 100
    assert job.comm_lost is False
    assert history_state(job)["state"] == "completed"


async def test_sd_job_that_loses_comm_during_run_is_unknown_not_completed(sd_env, monkeypatch):
    job, _ = await run_scripted(monkeypatch, [(RUN40, None), (RUN40, lose_comm), (IDLE, None)])
    assert job.state == "incomplete"
    assert job.state != "completed"
    assert job.current == 40 and job.total == 100           # no se fuerza current = total
    assert job.error_message == laser_service.COMM_LOST_RESULT_UNKNOWN
    assert job.comm_lost is True


async def test_board_reboot_idle_after_comm_loss_never_completes(sd_env, monkeypatch):
    # La placa reinicia (arranca en Idle) y el WS se reabre: muchos Idle seguidos no cierran el trabajo.
    job, scripted = await run_scripted(monkeypatch, [(RUN40, None), (IDLE, lose_comm)] + [(IDLE, None)] * 10)
    assert job.state == "incomplete" and job.current == 40
    assert scripted.calls == 2                               # dejó de preguntar apenas supo que no podía confirmar


async def test_loss_in_the_same_read_that_would_complete_wins(sd_env, monkeypatch):
    # Dos Idle confirmados y la conexión se cae justo al devolver el tercero.
    job, _ = await run_scripted(monkeypatch, [(RUN40, None), (IDLE, None), (IDLE, None), (IDLE, lose_comm)])
    assert job.state == "incomplete" and job.current == 40


async def test_paused_sd_job_with_comm_loss_is_not_left_hanging(sd_env, monkeypatch):
    job = laser_service.LaserJob(HOST_A, [], "x.gc", source="sd")
    job.pause_requested = True
    job.state = "paused"
    steps = [(RUN40, None)]
    real_sleep = sd_env

    async def flip_later():
        await real_sleep(0.05)
        job.comm_lost = True

    flipper = asyncio.create_task(flip_later())
    job, _ = await run_scripted(monkeypatch, steps, job=job)
    await flipper
    assert job.state == "incomplete" and job.state != "running"


async def test_history_records_unknown_result_with_the_loss_evidence(sd_env, monkeypatch):
    job, _ = await run_scripted(monkeypatch, [(RUN40, None), (RUN40, lose_comm)])
    entry = history_state(job)
    assert entry["state"] == "incomplete"
    assert entry["comm_lost"] is True
    assert entry["error"] == laser_service.COMM_LOST_RESULT_UNKNOWN
    assert entry["current"] == 40 and entry["completed_at"] is not None
    # Una sola entrada: se cerró la que se abrió al iniciar, no se duplicó.
    assert [e["id"] for e in laser_service._load_history()].count(job.job_id) == 1


async def test_cancel_still_wins_over_everything(sd_env, monkeypatch):
    job = laser_service.LaserJob(HOST_A, [], "x.gc", source="sd")
    job.cancel_requested = True
    job.comm_lost = True
    job, _ = await run_scripted(monkeypatch, [(RUN40, None)], job=job)
    assert job.state == "cancelled"


# ── Con el listener real: placa que se apaga / reinicia a media ejecución ──

async def start_real_sd_job(boards, board):
    board.frame = RUN40
    job = laser_service.LaserJob(HOST_A, [], "x.gc", source="sd")
    laser_service._jobs[HOST_A] = job
    laser_service.begin_laser_job_history(job)
    task = asyncio.create_task(laser_service._run_sd_job(job))
    assert await wait_until(lambda: job.current == 40, timeout=3)
    return job, task


async def test_power_loss_during_run_ends_unknown_and_recovery_does_not_complete_it(boards, sd_env):
    board = boards[HOST_A]
    job, task = await start_real_sd_job(boards, board)

    board.power_off()
    await asyncio.wait_for(task, 5)
    assert job.state == "incomplete" and job.current == 40
    assert job.comm_lost is True

    board.frame = IDLE                              # reinicia y vuelve en Idle
    board.power_on()
    assert await wait_until(lambda: ready(HOST_A) and laser_service._ws_connected(HOST_A))
    for _ in range(10):                             # y varios estados Idle después
        assert (await laser_service.get_status(HOST_A, timeout=0.5)) is not None
    assert job.state == "incomplete" and job.state != "completed"
    assert job.current == 40
    assert history_state(job)["state"] == "incomplete"


async def test_abrupt_socket_close_then_idle_reboot_never_completes(boards, sd_env):
    board = boards[HOST_A]
    job, task = await start_real_sd_job(boards, board)

    board.frame = IDLE                              # la placa reinicia rápido, sin esperar al watchdog
    board.drop(board.connections[0], websockets.exceptions.ConnectionClosedError(None, None))
    await asyncio.wait_for(task, 5)
    assert job.state == "incomplete" and job.current == 40
    assert await wait_until(lambda: board.connect_count >= 2 and ready(HOST_A))   # el listener sí se recuperó
    await asyncio.sleep(0.1)
    assert job.state == "incomplete"


async def test_repeated_interruptions_each_end_unknown(boards, sd_env):
    board = boards[HOST_A]
    for cycle in range(3):
        board.frame = RUN40
        job, task = await start_real_sd_job(boards, board)
        board.power_off()
        await asyncio.wait_for(task, 5)
        assert job.state == "incomplete", f"ciclo {cycle}"
        board.power_on()
        assert await wait_until(lambda: laser_service._ws_connected(HOST_A))
