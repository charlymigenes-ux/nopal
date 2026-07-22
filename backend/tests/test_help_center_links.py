from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_help_community_link_opens_official_nopal_mexico_youtube_channel():
    html = (ROOT / "backend/templates/index.html").read_text(encoding="utf-8")
    assert 'href="https://www.youtube.com/@NOPALM%C3%A9xico"' in html
    assert 'target="_blank" rel="noopener" class="help-community-link"' in html
