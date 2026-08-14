"""Límites que recorre un G-code, para el encuadre del láser y la CNC.

Si este cálculo se equivoca, el cabezal se va a mover por un rectángulo que
no es el del trabajo -- y el encuadre existe justamente para confiar en ese
rectángulo antes de cortar.
"""

from backend.services.gcode_bounds import compute_bounds


def test_rectangulo_simple():
    b = compute_bounds("G21 G90\nG0 X10 Y5\nG1 X60 Y5\nG1 X60 Y35\nG1 X10 Y35\n")
    assert (b["min_x"], b["min_y"], b["max_x"], b["max_y"]) == (10, 5, 60, 35)
    assert (b["width"], b["height"]) == (50, 30)


def test_coordenadas_relativas():
    """G91 cambia el significado de cada número: sumas, no posiciones."""
    b = compute_bounds("G21 G91\nG1 X10\nG1 Y20\nG1 X-5\n")
    assert (b["min_x"], b["max_x"]) == (0, 10)
    assert (b["min_y"], b["max_y"]) == (0, 20)


def test_pulgadas_se_convierten():
    """G20 son pulgadas. Sin convertir, un trabajo de 2\" se encuadraría
    como 2 mm y el cabezal apenas se movería."""
    b = compute_bounds("G20 G90\nG1 X0 Y0\nG1 X2 Y1\n")
    assert b["width"] == 50.8 and b["height"] == 25.4


def test_movimiento_modal():
    """En G-code una línea con solo coordenadas repite el comando anterior.
    Ignorarlo dejaba fuera casi todas las líneas de un archivo real."""
    b = compute_bounds("G21 G90\nG1 X0 Y0\nX40 Y20\nX5 Y30\n")
    assert (b["max_x"], b["max_y"]) == (40, 30)


def test_los_comentarios_no_mueven_nada():
    b = compute_bounds("G21 G90\nG1 X10 Y10\n; G1 X999 Y999\nG1 (X888) X20 Y20\n")
    assert b["max_x"] == 20 and b["max_y"] == 20


def test_g28_no_arrastra_el_rectangulo():
    """Un home no es un movimiento del trabajo y además corta la modalidad:
    si contara, el rectángulo se estiraría hasta el origen de la máquina."""
    b = compute_bounds("G21 G90\nG1 X50 Y50\nG28\nX60 Y60\n")
    assert b["min_x"] == 50 and b["min_y"] == 50


def test_archivo_sin_movimientos():
    """Sin nada que encuadrar se dice que no hay, en vez de devolver un
    rectángulo de área cero que se leería como un origen válido."""
    assert compute_bounds("; solo comentarios\nM5\nS0\n") is None
    assert compute_bounds("") is None


def test_arco_toma_el_punto_final():
    """De un G2/G3 se toma el destino. El arco puede sobresalir un poco, así
    que el rectángulo se queda corto antes que largo: de los dos errores,
    quedarse corto no rompe el material."""
    b = compute_bounds("G21 G90\nG1 X0 Y0\nG2 X20 Y0 I10 J0\n")
    assert b["max_x"] == 20


def test_archivo_gigante_se_corta_y_lo_avisa(monkeypatch):
    import backend.services.gcode_bounds as gb
    monkeypatch.setattr(gb, "MAX_LINES", 10)
    b = gb.compute_bounds("G21 G90\n" + "".join(f"G1 X{i} Y{i}\n" for i in range(100)))
    assert b["truncated"] is True
    assert b["max_x"] < 99


def test_los_traslados_en_vacio_no_estiran_el_rectangulo():
    """Un G0 mueve el cabezal sin marcar. Si contara, un archivo que se va
    al origen entre pasadas daría un encuadre mucho más grande que la pieza
    y el usuario reservaría material de más."""
    b = compute_bounds("G21 G90\nG0 X0 Y0\nG1 X50 Y50\nG1 X60 Y60\nG0 X200 Y200\n")
    assert b["max_x"] == 60 and b["max_y"] == 60


def test_cuenta_el_inicio_del_corte_no_solo_el_destino():
    """La línea que va de (10,5) a (60,5) empieza a marcar en (10,5)."""
    b = compute_bounds("G21 G90\nG0 X10 Y5\nG1 X60 Y5\n")
    assert b["min_x"] == 10 and b["min_y"] == 5


class TestCache:
    """Medir un grabado grande cuesta segundos; hacerlo en cada clic del
    botón de encuadrar sería inaceptable. Los límites de un archivo no
    cambian, así que se pagan una vez."""

    def _archivo(self, tmp_path, texto="G21 G90\nG1 X0 Y0\nG1 X30 Y20\n"):
        f = tmp_path / "pieza.gcode"
        f.write_text(texto, encoding="utf-8")
        return str(f)

    def test_la_segunda_vez_no_vuelve_a_medir(self, tmp_path, monkeypatch):
        from backend.services import gcode_bounds as gb
        ruta = self._archivo(tmp_path)
        assert gb.bounds_for_file(ruta)["width"] == 30

        medidas = {"veces": 0}
        original = gb.compute_bounds

        def contando(texto):
            medidas["veces"] += 1
            return original(texto)

        monkeypatch.setattr(gb, "compute_bounds", contando)
        assert gb.bounds_for_file(ruta)["width"] == 30
        assert medidas["veces"] == 0, "volvió a medir un archivo ya medido"

    def test_si_el_archivo_cambia_se_vuelve_a_medir(self, tmp_path):
        """Reemplazar el archivo con el mismo nombre tiene que invalidar la
        entrada: devolver los límites del anterior movería el cabezal por
        un rectángulo que ya no corresponde."""
        import os
        from backend.services import gcode_bounds as gb
        ruta = self._archivo(tmp_path)
        assert gb.bounds_for_file(ruta)["width"] == 30

        with open(ruta, "w", encoding="utf-8") as handle:
            handle.write("G21 G90\nG1 X0 Y0\nG1 X100 Y80\n")
        os.utime(ruta, (0, 0))   # fecha distinta, como un archivo nuevo
        assert gb.bounds_for_file(ruta)["width"] == 100

    def test_un_archivo_que_no_existe_no_revienta(self, tmp_path):
        from backend.services import gcode_bounds as gb
        assert gb.bounds_for_file(str(tmp_path / "no-existe.gcode")) is None
