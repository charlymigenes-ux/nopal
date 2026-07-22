import json

import backend.api.status as status_api


def test_temperature_presets_have_material_defaults(client, as_admin, tmp_path, monkeypatch):
    monkeypatch.setattr(status_api, "TEMP_PRESETS_PATH", str(tmp_path / "missing.json"))
    response = client.get("/api/system/temperature-presets")
    assert response.status_code == 200
    data = response.json()
    assert data["active"] == "pla"
    assert {item["name"] for item in data["materials"]} >= {"PLA", "PETG", "ABS", "TPU"}


def test_legacy_temperature_pair_is_exposed_as_custom_material(client, as_admin, tmp_path, monkeypatch):
    path = tmp_path / "presets.json"
    path.write_text(json.dumps({"heater_bed": 70, "extruder": 210}), encoding="utf-8")
    monkeypatch.setattr(status_api, "TEMP_PRESETS_PATH", str(path))
    data = client.get("/api/system/temperature-presets").json()
    assert data["active"] == "personalizado"
    assert data["materials"][0]["extruder"] == 210
    assert {item["name"] for item in data["materials"]} >= {"Personalizado", "PLA", "PETG"}


def test_material_presets_are_validated_and_saved(client, as_admin, tmp_path, monkeypatch):
    path = tmp_path / "presets.json"
    monkeypatch.setattr(status_api, "TEMP_PRESETS_PATH", str(path))
    payload = {"active": "petg", "materials": [
        {"id": "pla", "name": "PLA", "heater_bed": 60, "extruder": 205},
        {"id": "petg", "name": "PETG rápido", "heater_bed": 80, "extruder": 240},
    ]}
    response = client.post("/api/system/temperature-presets", data={"presets": json.dumps(payload)})
    assert response.status_code == 200
    assert json.loads(path.read_text(encoding="utf-8"))["active"] == "petg"


def test_material_temperature_out_of_range_is_rejected(client, as_admin):
    payload = {"materials": [{"id": "bad", "name": "Bad", "heater_bed": 500, "extruder": 200}]}
    response = client.post("/api/system/temperature-presets", data={"presets": json.dumps(payload)})
    assert response.status_code == 400
