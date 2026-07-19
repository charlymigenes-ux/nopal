import asyncio
import glob
import struct

import pytest

import backend.services.usb_camera_service as usb_camera_service
from backend.services.usb_camera_service import (
    V4L2_CAP_DEVICE_CAPS,
    V4L2_CAP_VIDEO_CAPTURE,
    _is_capture_device,
    _V4L2_CAP_STRUCT_FMT,
    ensure_stream,
    list_usb_video_devices,
    stop_stream,
    subscribe,
    unsubscribe,
)

HAS_REAL_V4L2_DEVICE = bool(glob.glob("/dev/video*"))


def _fake_querycap_bytes(driver="uvcvideo", card="Fake Cam", capabilities=0, device_caps=0):
    return struct.pack(
        _V4L2_CAP_STRUCT_FMT,
        driver.encode()[:16], card.encode()[:32], b"usb-fake",
        5, capabilities, device_caps, b"\x00" * 12,
    )


class TestIsCaptureDevice:
    def test_capture_bit_set_via_device_caps(self):
        caps = {"capabilities": V4L2_CAP_DEVICE_CAPS | V4L2_CAP_VIDEO_CAPTURE, "device_caps": V4L2_CAP_VIDEO_CAPTURE}
        assert _is_capture_device(caps) is True

    def test_metadata_only_node_is_excluded(self):
        # Mismo caso real que /dev/video1 de una GENERAL WEBCAM: capabilities
        # agregado incluye video capture, pero ESTE nodo puntual no.
        caps = {"capabilities": V4L2_CAP_DEVICE_CAPS | V4L2_CAP_VIDEO_CAPTURE, "device_caps": 0x04a00000}
        assert _is_capture_device(caps) is False

    def test_falls_back_to_capabilities_without_device_caps_flag(self):
        caps = {"capabilities": V4L2_CAP_VIDEO_CAPTURE, "device_caps": 0}
        assert _is_capture_device(caps) is True


class TestListUsbVideoDevices:
    def test_filters_out_non_capture_and_unreadable_nodes(self, monkeypatch):
        monkeypatch.setattr(usb_camera_service.glob, "glob", lambda pattern: ["/dev/video0", "/dev/video1", "/dev/video2"])

        def fake_query(path):
            if path == "/dev/video0":
                return {"driver": "uvcvideo", "card": "GENERAL WEBCAM", "capabilities": V4L2_CAP_DEVICE_CAPS | V4L2_CAP_VIDEO_CAPTURE, "device_caps": V4L2_CAP_VIDEO_CAPTURE}
            if path == "/dev/video1":
                return {"driver": "uvcvideo", "card": "GENERAL WEBCAM", "capabilities": V4L2_CAP_DEVICE_CAPS | V4L2_CAP_VIDEO_CAPTURE, "device_caps": 0x04a00000}
            return None  # /dev/video2: no se pudo abrir/consultar

        monkeypatch.setattr(usb_camera_service, "_query_v4l2_capability", fake_query)
        monkeypatch.setattr(usb_camera_service, "_resolve_usb_identity", lambda path: {"usb_location": "1-2", "vendor_id": "1b3f", "product_id": "2247", "product_name": "GENERAL WEBCAM"})

        devices = list_usb_video_devices()
        assert [d["device_path"] for d in devices] == ["/dev/video0"]
        assert devices[0]["name"] == "GENERAL WEBCAM"
        assert devices[0]["usb_location"] == "1-2"

    def test_empty_when_nothing_connected(self, monkeypatch):
        monkeypatch.setattr(usb_camera_service.glob, "glob", lambda pattern: [])
        assert list_usb_video_devices() == []

    @pytest.mark.skipif(not HAS_REAL_V4L2_DEVICE, reason="No hay /dev/video* en este entorno")
    def test_against_real_hardware_if_present(self):
        # Corre de verdad contra el hardware si lo hay (no mockeado) -- si
        # nada responde a VIDIOC_QUERYCAP como dispositivo de captura, la
        # lista puede quedar vacía sin que eso sea un fallo del test.
        devices = list_usb_video_devices()
        for device in devices:
            assert device["device_path"].startswith("/dev/video")
            assert device["name"]


class TestQueryV4l2Capability:
    def test_parses_real_ioctl_response_shape(self, monkeypatch, tmp_path):
        # Simula lo que fcntl.ioctl escribiría en el buffer, sin abrir un
        # dispositivo real -- valida el parseo de struct, no el syscall.
        fake_path = tmp_path / "fake-video-device"
        fake_path.write_bytes(b"")
        response = _fake_querycap_bytes(capabilities=V4L2_CAP_DEVICE_CAPS | V4L2_CAP_VIDEO_CAPTURE, device_caps=V4L2_CAP_VIDEO_CAPTURE)

        def fake_ioctl(fd, request, buf):
            buf[:] = response
            return 0

        monkeypatch.setattr(usb_camera_service.fcntl, "ioctl", fake_ioctl)
        result = usb_camera_service._query_v4l2_capability(str(fake_path))
        assert result["driver"] == "uvcvideo"
        assert result["card"] == "Fake Cam"
        assert result["device_caps"] & V4L2_CAP_VIDEO_CAPTURE

    def test_unreadable_device_returns_none(self):
        assert usb_camera_service._query_v4l2_capability("/dev/does-not-exist-nopal-test") is None


class _FakeProcess:
    def __init__(self, frames):
        self._frames = list(frames)
        self.stdout = self
        self.returncode = None
        self.killed = False
        self.pid = 12345

    async def read(self, n):
        if self._frames:
            return self._frames.pop(0)
        # Simula "sin más datos por ahora" sin cerrar el pipe -- el test
        # cancela el reader_task explícitamente en vez de esperar EOF.
        await asyncio.sleep(3600)
        return b""

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        return self.returncode


class TestSharedStream:
    async def test_single_ffmpeg_process_shared_by_two_subscribers(self, monkeypatch):
        frame = b"\xff\xd8" + b"x" * 20 + b"\xff\xd9"
        create_calls = []

        async def fake_create_subprocess_exec(*args, **kwargs):
            create_calls.append(args)
            return _FakeProcess([frame, frame])

        monkeypatch.setattr(usb_camera_service.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        monkeypatch.setattr(usb_camera_service.shutil, "which", lambda name: "/usr/bin/ffmpeg")

        try:
            queue_a = await subscribe("cam-shared", "/dev/video0")
            queue_b = await subscribe("cam-shared", "/dev/video0")

            frame_a = await asyncio.wait_for(queue_a.get(), timeout=2)
            frame_b = await asyncio.wait_for(queue_b.get(), timeout=2)
            assert frame_a == frame
            assert frame_b == frame
            # Un solo proceso lanzado para 2 suscriptores -- ese es el punto
            # central del diseño (V4L2 no admite 2 lectores simultáneos).
            assert len(create_calls) == 1
        finally:
            await unsubscribe("cam-shared", queue_a)
            await unsubscribe("cam-shared", queue_b)
            await stop_stream("cam-shared")

    async def test_ffmpeg_not_installed_raises_actionable_error(self, monkeypatch):
        monkeypatch.setattr(usb_camera_service.shutil, "which", lambda name: None)
        with pytest.raises(RuntimeError, match="ffmpeg"):
            await ensure_stream("cam-no-ffmpeg", "/dev/video0")

    async def test_stop_stream_kills_process_and_clears_state(self, monkeypatch):
        async def fake_create_subprocess_exec(*args, **kwargs):
            return _FakeProcess([])

        monkeypatch.setattr(usb_camera_service.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        monkeypatch.setattr(usb_camera_service.shutil, "which", lambda name: "/usr/bin/ffmpeg")

        stream = await ensure_stream("cam-stop", "/dev/video0")
        assert "cam-stop" in usb_camera_service._streams
        await stop_stream("cam-stop")
        assert "cam-stop" not in usb_camera_service._streams
        assert stream.process.killed is True

    async def test_idle_stop_after_last_subscriber_leaves(self, monkeypatch):
        async def fake_create_subprocess_exec(*args, **kwargs):
            return _FakeProcess([])

        monkeypatch.setattr(usb_camera_service.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        monkeypatch.setattr(usb_camera_service.shutil, "which", lambda name: "/usr/bin/ffmpeg")
        monkeypatch.setattr(usb_camera_service, "IDLE_STOP_DELAY", 0.05)

        queue = await subscribe("cam-idle", "/dev/video0")
        await unsubscribe("cam-idle", queue)
        assert "cam-idle" in usb_camera_service._streams  # todavía no, hay margen
        await asyncio.sleep(0.15)
        assert "cam-idle" not in usb_camera_service._streams


def test_is_device_present_reflects_real_filesystem(tmp_path):
    missing = tmp_path / "video99"
    assert usb_camera_service.is_device_present(str(missing)) is False
    assert usb_camera_service.is_device_present(None) is False
    present = tmp_path / "video0"
    present.write_bytes(b"")
    assert usb_camera_service.is_device_present(str(present)) is True
