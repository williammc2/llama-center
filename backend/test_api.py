"""Tests for the pywebview Api surface (main.py) — the camelCase boundary."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from main import Api  # noqa: E402


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Redirect the config root so tests never touch the real user profile."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    return tmp_path


class TestApi:
    def test_save_get_config_roundtrip(self, home):
        api = Api()
        payload = {
            "version": 1,
            "firstRunDone": True,
            "installDir": str(home / "custom-root"),
            "backend": "cuda",
            "cudaMajor": 13,
            "cudaFamily": "cudart",
            "llamaCppPin": None,
            "llamaSwapPort": 9090,
            "lang": "pt-BR",
            "startWithSystem": False,
            "autoStartLlamaSwap": False,
            "closeToTray": True,
            "checkUpdatesOnStart": True,
        }
        res = api.save_config(payload)
        assert "path" in res, res
        assert res["path"].endswith("config.json")

        got = api.get_config()
        assert got["backend"] == "cuda"
        assert got["cudaMajor"] == 13
        assert got["llamaSwapPort"] == 9090
        assert got["lang"] == "pt-BR"
        assert got["firstRunDone"] is True
        assert got["installDir"] == str(home / "custom-root")

    def test_save_config_corrupt_returns_error(self, home):
        api = Api()
        res = api.save_config({"version": 1, "backend": "metal"})
        assert "error" in res
        assert "backend" in res["error"]

    def test_get_config_missing_returns_defaults(self, home):
        api = Api()
        cfg = api.get_config()
        # No config file → defaults (first run), not null.
        assert cfg["firstRunDone"] is False
        assert cfg["backend"] == "cpu"

    def test_get_detection_shape(self):
        api = Api()
        d = api.get_detection()
        assert set(d) == {"os", "arch", "suggestCuda", "cudaMajorHint", "gpuName", "backends"}
        assert isinstance(d["backends"], list)

    def test_key_mapping_is_bidirectional(self):
        api = Api()
        camel = {
            "version": 1,
            "firstRunDone": True,
            "installDir": "/tmp/x",
            "backend": "cpu",
            "cudaMajor": 12,
            "cudaFamily": "plain",
            "llamaCppPin": "b10814",
            "llamaSwapPort": 8085,
            "lang": "en",
            "startWithSystem": True,
            "autoStartLlamaSwap": True,
            "closeToTray": False,
            "checkUpdatesOnStart": False,
        }
        snake = api._from_camel(camel)
        assert snake["first_run_done"] is True
        assert snake["install_dir"] == "/tmp/x"
        assert snake["cuda_major"] == 12
        assert snake["llama_cpp_pin"] == "b10814"
        # and back
        from llama_center.config import parse_config

        cfg = parse_config(snake)
        out = api._to_camel(cfg)
        assert out["cudaMajor"] == 12
        assert out["autoStartLlamaSwap"] is True
        assert out["closeToTray"] is False
