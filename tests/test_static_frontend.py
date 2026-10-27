from pathlib import Path

from jarvis_agent.app import default_static_dir


def test_default_static_dir_points_to_web_ui_build():
    expected = Path(__file__).resolve().parent.parent / "web-ui" / "dist"

    assert default_static_dir() == str(expected)
