"""Cliente ONVIF mínimo: solo lo necesario para resolver la URL RTSP real de
una cámara/DVR a partir de host/puerto/usuario/contraseña (GetCapabilities
-> ubica el servicio de Media -> GetProfiles -> GetStreamUri). No es un
cliente ONVIF completo (sin PTZ, eventos, discovery por multicast, etc.) --
es justo lo necesario para no tener que adivinar a mano el formato de URL
RTSP de cada fabricante (Xiongmai, Hikvision, Dahua... cada uno arma esa URL
distinto, y a veces ni siquiera es la contraseña real de la cuenta sino un
token interno que el dispositivo genera solo -- ONVIF es el único punto en
común real entre todos)."""

import base64
import hashlib
import logging
import os
import socket
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

HTTP_TIMEOUT = 8

# Puertos donde distintos fabricantes suelen publicar el servicio ONVIF
# (device_service) -- no hay un estándar real, cada uno elige el suyo.
COMMON_ONVIF_PORTS = [80, 8080, 8899, 8000, 2020, 8081]


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_all(root: ET.Element, name: str) -> List[ET.Element]:
    return [el for el in root.iter() if _local_name(el.tag) == name]


def _find_one(root: ET.Element, name: str) -> Optional[ET.Element]:
    matches = _find_all(root, name)
    return matches[0] if matches else None


def _username_token(username: str, password: str) -> str:
    nonce = os.urandom(16)
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + password.encode()).digest()).decode()
    nonce_b64 = base64.b64encode(nonce).decode()
    return f"""<Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <UsernameToken>
        <Username>{username}</Username>
        <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest}</Password>
        <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce_b64}</Nonce>
        <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</Created>
      </UsernameToken>
    </Security>"""


def _soap_call(url: str, body: str, username: str, password: str, timeout: float = HTTP_TIMEOUT) -> ET.Element:
    envelope = f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Header>{_username_token(username, password)}</soap:Header>
  <soap:Body>{body}</soap:Body>
</soap:Envelope>"""
    response = requests.post(
        url,
        data=envelope.encode("utf-8"),
        headers={"Content-Type": "application/soap+xml; charset=utf-8"},
        timeout=timeout,
    )
    response.raise_for_status()
    try:
        return ET.fromstring(response.text)
    except ET.ParseError:
        raise ValueError("El dispositivo no devolvió una respuesta ONVIF válida")


def _port_open(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def resolve_rtsp_uri(host: str, port: int, username: str, password: str, timeout: float = HTTP_TIMEOUT) -> str:
    """Devuelve la URL RTSP real del primer perfil de video (el de mayor
    calidad) que reporta el dispositivo. Lanza ValueError con un mensaje
    entendible si algo falla -- host inalcanzable, credenciales rechazadas,
    o el dispositivo no habla ONVIF."""
    device_url = f"http://{host}:{port}/onvif/device_service"

    try:
        capabilities = _soap_call(
            device_url,
            '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl">'
            "<Category>Media</Category></GetCapabilities>",
            username, password, timeout,
        )
    except requests.exceptions.RequestException as e:
        raise ValueError(f"No se pudo conectar a {host}:{port} — {e}")

    if _find_one(capabilities, "Fault") is not None:
        raise ValueError("El dispositivo rechazó las credenciales ONVIF")

    media_el = _find_one(capabilities, "Media")
    xaddr_el = _find_one(media_el, "XAddr") if media_el is not None else None
    media_url = xaddr_el.text if xaddr_el is not None and xaddr_el.text else device_url

    try:
        profiles_response = _soap_call(
            media_url,
            '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>',
            username, password, timeout,
        )
    except requests.exceptions.RequestException as e:
        raise ValueError(f"No se pudo conectar al servicio de Media — {e}")

    if _find_one(profiles_response, "Fault") is not None:
        raise ValueError("El dispositivo rechazó las credenciales ONVIF")

    profile_el = _find_one(profiles_response, "Profiles")
    profile_token = profile_el.get("token") if profile_el is not None else None
    if not profile_token:
        raise ValueError("El dispositivo no reportó ningún perfil de video")

    stream_uri_body = f"""<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">
      <StreamSetup>
        <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
        <Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>
      </StreamSetup>
      <ProfileToken>{profile_token}</ProfileToken>
    </GetStreamUri>"""
    stream_response = _soap_call(media_url, stream_uri_body, username, password, timeout)
    uri_el = _find_one(stream_response, "Uri")
    if uri_el is None or not uri_el.text:
        raise ValueError("El dispositivo no devolvió una URL de stream")
    return uri_el.text


def resolve_rtsp_uri_autoscan(
    host: str, username: str, password: str, preferred_port: Optional[int] = None,
) -> Tuple[str, int]:
    """Prueba el puerto ONVIF que haya dado el usuario (si dio uno) y, si
    falla o no dio ninguno, escanea los puertos donde suelen publicarlo los
    fabricantes -- así no hace falta que el usuario sepa de antemano en qué
    puerto vive el servicio ONVIF de su cámara. Primero descarta con un
    connect() de socket los puertos cerrados (rapidísimo) antes de intentar
    el handshake ONVIF completo (mucho más lento) en cada uno."""
    candidates = []
    if preferred_port:
        candidates.append(preferred_port)
    candidates += [p for p in COMMON_ONVIF_PORTS if p not in candidates]

    open_ports = [p for p in candidates if _port_open(host, p)]
    if not open_ports:
        raise ValueError(
            f"No respondió ningún puerto ONVIF común en {host} "
            f"(probé {', '.join(str(p) for p in candidates)}). Verifica la IP."
        )

    last_error: Optional[ValueError] = None
    for port in open_ports:
        try:
            return resolve_rtsp_uri(host, port, username, password, timeout=5), port
        except ValueError as e:
            last_error = e
            continue
    raise ValueError(str(last_error) if last_error else "No se pudo resolver el stream ONVIF.")
