"""Qué puertos sondea NOPAL buscando Moonraker.

Una instancia no tiene por qué estar en el rango de siempre: una granja
virtual en Docker publica cada contenedor donde le toque (7211, 7212...) y
esos nunca se descubrían solos.
"""

import pytest

from backend.services import klipper_service as ks


@pytest.fixture(autouse=True)
def sin_puertos_extra(monkeypatch):
    monkeypatch.delenv("NOPAL_KLIPPER_PORTS", raising=False)


def test_por_omision_solo_los_puertos_de_siempre():
    """Una instalación que no declara nada se comporta exactamente igual
    que antes: tres peticiones cada ciclo de descubrimiento, no más."""
    assert ks.get_moonraker_discovery_ports() == [7125, 7126, 7127]


def test_los_puertos_declarados_se_agregan(monkeypatch):
    monkeypatch.setenv("NOPAL_KLIPPER_PORTS", "7211,7212")
    assert ks.get_moonraker_discovery_ports() == [7125, 7126, 7127, 7211, 7212]


def test_se_toleran_espacios_y_punto_y_coma(monkeypatch):
    monkeypatch.setenv("NOPAL_KLIPPER_PORTS", " 7211 ; 7212 ")
    assert ks.get_moonraker_discovery_ports()[-2:] == [7211, 7212]


def test_no_se_sondea_dos_veces_el_mismo_puerto(monkeypatch):
    """Cada puerto es una petición HTTP cada 5 segundos: repetirlo es
    gastar el doble por nada."""
    monkeypatch.setenv("NOPAL_KLIPPER_PORTS", "7125,7211,7211")
    assert ks.get_moonraker_discovery_ports() == [7125, 7126, 7127, 7211]


@pytest.mark.parametrize("valor", ["abc", "7211,basura", "99999", "-1", "7211,,"])
def test_un_valor_invalido_no_tumba_el_descubrimiento(monkeypatch, valor):
    """Quedarse sin ver NINGUNA impresora por una coma de más sería peor
    que ignorar la entrada mala."""
    monkeypatch.setenv("NOPAL_KLIPPER_PORTS", valor)
    puertos = ks.get_moonraker_discovery_ports()
    assert puertos[:3] == [7125, 7126, 7127]
    assert all(1 <= p <= 65535 for p in puertos)
