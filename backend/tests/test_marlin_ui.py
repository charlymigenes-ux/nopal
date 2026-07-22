from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_marlin_registration_ui_exposes_usb_and_mks_wifi_fields():
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    required_ids = (
        "marlin-mks-wifi-discover-list",
        "marlin-mks-wifi-manual-btn",
        "marlin-printer-register-transport",
        "marlin-printer-register-host",
        "marlin-printer-register-port",
        "marlin-printer-register-profile",
        "marlin-printer-register-board",
        "marlin-printer-register-extruders",
    )
    for element_id in required_ids:
        assert f'id="{element_id}"' in html


def test_marlin_ui_calls_wifi_discovery_test_and_transport_registration():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    assert "fetch('/api/marlin-printers/mks-wifi/discover')" in javascript
    assert "testUrl = '/api/marlin-printers/mks-wifi/test'" in javascript
    assert "formData.append('transport', transport)" in javascript
    assert "formData.append('profile_id', profileId)" in javascript
    assert "renderMarlinMksWifiDiscoverList" in javascript


def test_marlin_ui_translation_keys_exist_in_every_catalog():
    translation_files = (
        "translations.js",
        "translations-de.js",
        "translations-fr.js",
        "translations-pt-BR.js",
    )
    keys = (
        "marlinTransportMksWifi",
        "marlinMksWifiManualAdd",
        "marlinMksWifiHostRequired",
        "marlinProfileLabel",
        "marlinBoardVariantUnknown",
        "marlinExtruderCountLabel",
    )
    for filename in translation_files:
        content = (ROOT / "backend/static/js" / filename).read_text(encoding="utf-8")
        for key in keys:
            assert key in content, f"{key} falta en {filename}"


def test_marlin_ui_assets_have_updated_cachebusters():
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    assert '/static/css/style.css?v=268' in html
    assert '/static/js/app.js?v=210' in html
    assert '/static/js/translations.js?v=24' in html
    for language in ("de", "fr", "pt-BR"):
        assert f'/static/js/translations-{language}.js?v=4' in html
    assert '/static/js/guided-printer-setup.js?v=2' in html


def test_guided_setup_exposes_hellbot_marlin_flow():
    javascript = (ROOT / "backend/static/js/guided-printer-setup.js").read_text(encoding="utf-8")
    assert "hellbot:" in javascript
    assert "displayName: 'Hellbot / Marlin'" in javascript
    assert "openMarlinRegisterModal('', 'Hellbot / Marlin', 'mks_wifi')" in javascript
    assert "guidedSetupBrandHellbotDesc" in javascript

    translation_files = (
        "translations.js",
        "translations-de.js",
        "translations-fr.js",
        "translations-pt-BR.js",
    )
    for filename in translation_files:
        content = (ROOT / "backend/static/js" / filename).read_text(encoding="utf-8")
        assert "guidedSetupBrandHellbotDesc" in content, f"falta traducción Hellbot en {filename}"


def test_marlin_registration_uses_m115_machine_type_as_automatic_name():
    javascript = (ROOT / "backend/static/js/app.js").read_text(encoding="utf-8")
    assert "function marlinMachineName(testData)" in javascript
    assert "testData?.firmware_info?.MACHINE_TYPE" in javascript
    assert "nameInput.dataset.autoName = 'true'" in javascript
    assert "nameInput.value = detectedMachineName" in javascript
