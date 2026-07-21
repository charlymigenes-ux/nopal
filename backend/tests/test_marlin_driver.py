import asyncio

from backend.services import marlin_driver


class FakeTransport:
    """MarlinTransport de prueba: no abre ningún puerto real -- las líneas
    de respuesta se cargan a mano en la cola antes de llamar a la función
    bajo prueba, simulando lo que un Marlin real habría mandado."""

    def __init__(self, response_lines):
        self.response_lines = response_lines
        self.sent = []

    def send(self, command: str) -> bool:
        self.sent.append(command)
        return True

    async def ensure_ready(self) -> None:
        return None

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        for line in self.response_lines:
            queue.put_nowait(line)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        return None

    def as_marlin_transport(self) -> marlin_driver.MarlinTransport:
        return marlin_driver.MarlinTransport(
            send=self.send, ensure_ready=self.ensure_ready,
            subscribe=self.subscribe, unsubscribe=self.unsubscribe,
        )


class FakeJobTransport:
    """Transport de prueba para run_job() -- a diferencia de FakeTransport,
    la respuesta a cada línea la decide `respond_fn(command)` en el momento
    (no una cola fija cargada de antemano), para poder simular escenarios
    con estado -- ej. "la línea 2 pide Resend la primera vez, después ok"."""

    def __init__(self, respond_fn):
        self.respond_fn = respond_fn
        self.sent = []
        self._queue = None

    def send(self, command: str) -> bool:
        self.sent.append(command)
        for line in self.respond_fn(command):
            self._queue.put_nowait(line)
        return True

    async def ensure_ready(self) -> None:
        return None

    def subscribe(self) -> asyncio.Queue:
        self._queue = asyncio.Queue()
        return self._queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        return None

    def as_marlin_transport(self) -> marlin_driver.MarlinTransport:
        return marlin_driver.MarlinTransport(
            send=self.send, ensure_ready=self.ensure_ready,
            subscribe=self.subscribe, unsubscribe=self.unsubscribe,
        )


class FakeJob:
    """Duck-type mínimo de PrintJob/LaserJob -- ver el docstring de
    run_job() sobre qué atributos necesita."""

    def __init__(self, lines):
        self.lines = lines
        self.current = 0
        self.total = 0
        self.state = "running"
        self.error_message = None
        self.cancel_requested = False
        self.pause_requested = False


class TestGetFirmwareInfo:
    async def test_parses_real_m115_response(self):
        transport = FakeTransport([
            "FIRMWARE_NAME:Marlin 2.1.2 (Github) SOURCE_CODE_URL:https://github.com/MarlinFirmware/Marlin "
            "PROTOCOL_VERSION:1.0 MACHINE_TYPE:Hellbot Magna2 EXTRUDER_COUNT:1 UUID:cede2a2f-41a2-4748-9b12",
            "ok",
        ]).as_marlin_transport()
        info = await marlin_driver.get_firmware_info(transport)
        assert info["FIRMWARE_NAME"] == "Marlin 2.1.2 (Github)"
        assert info["SOURCE_CODE_URL"] == "https://github.com/MarlinFirmware/Marlin"
        assert info["PROTOCOL_VERSION"] == "1.0"
        assert info["MACHINE_TYPE"] == "Hellbot Magna2"
        assert info["EXTRUDER_COUNT"] == "1"

    async def test_sends_m115(self):
        fake = FakeTransport(["FIRMWARE_NAME:Marlin", "ok"])
        await marlin_driver.get_firmware_info(fake.as_marlin_transport())
        assert fake.sent == ["M115"]

    async def test_no_colon_lines_ignored(self):
        transport = FakeTransport(["echo:busy: processing", "ok"]).as_marlin_transport()
        info = await marlin_driver.get_firmware_info(transport)
        assert info is None

    async def test_capability_lines_not_parsed(self):
        """Las líneas 'Cap:ALGO:0' de M115 son un formato distinto (3
        partes) -- no deben aparecer en el resultado, a propósito no se
        intenta interpretarlas."""
        transport = FakeTransport([
            "FIRMWARE_NAME:Marlin 2.1.2",
            "Cap:SERIAL_XON_XOFF:0",
            "Cap:BINARY_FILE_TRANSFER:0",
            "ok",
        ]).as_marlin_transport()
        info = await marlin_driver.get_firmware_info(transport)
        assert info == {"FIRMWARE_NAME": "Marlin 2.1.2"}

    async def test_timeout_with_no_response(self):
        transport = FakeTransport([]).as_marlin_transport()
        info = await marlin_driver.get_firmware_info(transport, timeout=0.2)
        assert info is None


class TestGetTemperaturesSingleExtruder:
    async def test_single_extruder_key_unchanged(self):
        """Caso de toda la vida (T sin número) -- no debe cambiar de clave
        con el fix de doble extrusor."""
        transport = FakeTransport(["T:200.5 /205.0 B:59.8 /60.0", "ok"]).as_marlin_transport()
        temps = await marlin_driver.get_temperatures(transport)
        assert temps == {
            "extruder": {"current": 200.5, "target": 205.0},
            "heater_bed": {"current": 59.8, "target": 60.0},
        }


class TestGetTemperaturesDualExtruder:
    async def test_t0_and_t1_kept_separate(self):
        """Bug real: antes T1 pisaba a T0 porque las dos entradas caían en
        la misma clave "extruder". Con temperaturas distintas en cada uno,
        confirma que ninguna se pierde."""
        transport = FakeTransport([
            "T:210.0 /215.0 T0:210.0 /215.0 T1:190.0 /195.0 B:60.0 /60.0",
            "ok",
        ]).as_marlin_transport()
        temps = await marlin_driver.get_temperatures(transport)
        assert temps["extruder0"] == {"current": 210.0, "target": 215.0}
        assert temps["extruder1"] == {"current": 190.0, "target": 195.0}
        assert temps["heater_bed"] == {"current": 60.0, "target": 60.0}

    async def test_only_t0_t1_no_plain_t(self):
        """Algunos firmwares de doble extrusor no mandan el "T:" genérico,
        solo T0/T1 -- confirma que igual se separan bien."""
        transport = FakeTransport(["T0:180.0 /185.0 T1:180.0 /185.0 B:0.0 /0.0", "ok"]).as_marlin_transport()
        temps = await marlin_driver.get_temperatures(transport)
        assert set(temps.keys()) == {"extruder0", "extruder1", "heater_bed"}
        assert temps["extruder0"]["current"] == 180.0
        assert temps["extruder1"]["current"] == 180.0


class TestRunJobNumbering:
    async def test_sends_m110_before_first_line(self):
        def respond(command):
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert transport.sent[0] == "M110 N0"

    async def test_lines_are_numbered_and_checksummed(self):
        def respond(command):
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)

        assert transport.sent[1].startswith("N1 G28*")
        assert transport.sent[2].startswith("N2 G1 X10*")
        # El checksum en sí es verificable de forma independiente.
        numbered, checksum = transport.sent[1].rsplit("*", 1)
        assert int(checksum) == marlin_driver._line_checksum(numbered)

    async def test_comment_only_lines_are_not_numbered(self):
        def respond(command):
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["; comment", "G28", "(also a comment)", "G1 X10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.total == 2
        assert transport.sent[1].startswith("N1 G28*")
        assert transport.sent[2].startswith("N2 G1 X10*")

    async def test_successful_job_completes(self):
        def respond(command):
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10", "G1 Y10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.state == "completed"
        assert job.current == 3
        assert job.error_message is None

    async def test_m110_failure_aborts_before_sending_gcode(self):
        def respond(command):
            return ["Error: bad numbering"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.state == "error"
        assert transport.sent == ["M110 N0"]  # nunca llegó a mandar G-code real


class TestRunJobResend:
    async def test_resend_retries_the_same_line_instead_of_aborting(self):
        """Bug real corregido: antes CUALQUIER 'Resend:' abortaba todo el
        trabajo. Acá la placa simulada pide reenviar la línea 2 una vez, y
        la segunda vez que la recibe, la acepta -- el trabajo debe
        completar, no abortar."""
        seen_line_2 = 0

        def respond(command):
            nonlocal seen_line_2
            if command.startswith("N2 "):
                seen_line_2 += 1
                if seen_line_2 == 1:
                    return ["Resend: N2"]
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10", "G1 Y10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)

        assert job.state == "completed"
        assert seen_line_2 == 2  # la pidieron reenviar una vez, después ok
        # La línea reenviada mantiene el mismo número (N2), no un N3 nuevo.
        line2_sends = [c for c in transport.sent if c.startswith("N2 ")]
        assert len(line2_sends) == 2
        assert line2_sends[0] == line2_sends[1]

    async def test_resend_out_of_range_aborts(self):
        def respond(command):
            if command.startswith("N1 "):
                return ["Resend: N99"]
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.state == "error"
        assert "rango" in job.error_message

    async def test_too_many_consecutive_resends_aborts(self):
        def respond(command):
            if command.startswith("N1 "):
                return ["Resend: N1"]
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.state == "error"
        assert "reenv" in job.error_message.lower()

    async def test_real_error_still_aborts_without_retry(self):
        """Un error real (no un Resend) debe seguir abortando el trabajo,
        como toda la vida -- no confundir con el caso de reenvío."""
        def respond(command):
            if command.startswith("N2 "):
                return ["Error:Thermal Runaway, system stopped"]
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10", "G1 Y10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.state == "error"
        assert "Thermal Runaway" in job.error_message
        # No se reenvía nada -- el trabajo se corta ahí mismo.
        assert job.current == 1


class TestRunJobBusyKeepalive:
    async def test_busy_messages_do_not_abort_a_slow_line(self):
        def respond(command):
            if command.startswith("N1 "):
                return ["echo:busy: processing", "echo:busy: processing", "ok"]
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job, line_timeout=0.5)
        assert job.state == "completed"


class TestRunJobCancelPause:
    async def test_cancel_stops_without_sending_remaining_lines(self):
        def respond(command):
            if command.startswith("N1 "):
                job.cancel_requested = True
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10", "G1 Y10"])
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.state == "cancelled"
        assert not any(c.startswith("N2 ") for c in transport.sent)

    async def test_pause_blocks_until_resumed(self):
        async def unpause_soon():
            await asyncio.sleep(0.1)
            job.pause_requested = False

        def respond(command):
            return ["ok"]

        transport = FakeJobTransport(respond)
        job = FakeJob(["G28", "G1 X10"])
        job.pause_requested = True
        asyncio.get_event_loop().create_task(unpause_soon())
        await marlin_driver.run_job(transport.as_marlin_transport(), job)
        assert job.state == "completed"
