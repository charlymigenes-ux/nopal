"""Encuadre: recorrer el rectángulo de un trabajo antes de cortarlo.

Es una función que MUEVE la máquina, así que lo que se protege acá no es
que el rectángulo se vea bonito, sino que el cabezal no acabe donde no debe
y que el láser no se encienda sin que alguien lo haya pedido.
"""

import pytest

from backend.services.laser_service import (
    build_frame_gcode,
    frame_area_check,
)

LIMITES = {"min_x": 10.0, "min_y": 5.0, "max_x": 60.0, "max_y": 35.0,
           "width": 50.0, "height": 30.0, "moves": 4, "truncated": False}


class TestGcodeDeEncuadre:
    def test_recorre_las_cuatro_esquinas_y_vuelve(self):
        lineas = [l for l in build_frame_gcode(LIMITES).splitlines() if l.startswith("G")]
        posiciones = [(l.split("X")[1].split()[0], l.split("Y")[1].split()[0])
                      for l in lineas if "X" in l and "Y" in l]
        assert posiciones == [("10.000", "5.000"), ("60.000", "5.000"),
                              ("60.000", "35.000"), ("10.000", "35.000"),
                              ("10.000", "5.000")]

    def test_el_laser_va_apagado_por_omision(self):
        """Ver el trazo ayuda a alinear, pero es fuego: encenderlo lo decide
        quien está frente a la máquina, no el valor por omisión."""
        gcode = build_frame_gcode(LIMITES)
        assert "M3" not in gcode
        assert gcode.count("M5") >= 2

    def test_con_potencia_explicita_si_enciende_y_siempre_apaga_al_final(self):
        gcode = build_frame_gcode(LIMITES, power=15)
        assert "M3 S15" in gcode
        assert gcode.strip().endswith("M5"), "el recorrido tiene que terminar apagado"

    def test_nunca_toca_el_eje_Z(self):
        """En una CNC, mover Z es la diferencia entre pasear la herramienta
        por encima y arrastrarla dentro del material."""
        assert "Z" not in build_frame_gcode(LIMITES)

    def test_declara_milimetros_y_absoluto(self):
        """Sin G21/G90 el recorrido depende de en qué modo quedó la máquina
        del trabajo anterior."""
        gcode = build_frame_gcode(LIMITES)
        assert "G21" in gcode and "G90" in gcode


class TestAreaDeTrabajo:
    def test_un_trabajo_mas_grande_que_la_maquina_se_bloquea(self):
        """No cabe de ninguna manera, sin importar dónde esté el origen:
        encuadrarlo la mandaría contra los finales de carrera."""
        r = frame_area_check(LIMITES, {"width": 40.0, "height": 40.0})
        assert r["blocked"] and "50" in r["blocked"] and "40" in r["blocked"]

    def test_un_trabajo_que_cabe_pasa_sin_avisos(self):
        r = frame_area_check(LIMITES, {"width": 450.0, "height": 450.0})
        assert r == {"blocked": None, "warning": None}

    def test_coordenadas_negativas_avisan_pero_no_bloquean(self):
        """Un archivo real bien puede empezar en X-0.8 por un redondeo del
        diseño. Bloquear por eso haría inútil el botón en casi toda la
        biblioteca de este taller -- comprobado contra sus archivos."""
        fuera = {**LIMITES, "min_x": -0.8}
        r = frame_area_check(fuera, {"width": 450.0, "height": 450.0})
        assert r["blocked"] is None
        assert r["warning"] and "origen" in r["warning"]

    def test_sin_area_declarada_no_se_inventa_un_limite(self):
        """Una máquina sin área conocida no da información para decidir;
        inventar un tope sería peor que no comprobar."""
        assert frame_area_check(LIMITES, None)["blocked"] is None
        assert frame_area_check(LIMITES, {})["blocked"] is None
