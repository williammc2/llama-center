"""Tests for llama_center.config — mirrors src/lib/config.test.ts rules.

Design note: config.json ALWAYS lives at the default per-user root
(chicken-and-egg — a custom install_dir is stored inside the file). Tests
redirect the root by monkeypatching LOCALAPPDATA / XDG_DATA_HOME.
"""
import json

import pytest

from llama_center import config as C
from llama_center.config import (
    AppConfig,
    ConfigError,
    default_install_dir,
    load_config,
    parse_config,
    save_config,
    serialize_config,
)

VALID = {
    "version": 1,
    "first_run_done": True,
    "install_dir": "C:\\AppData\\Local\\llama-center",
    "backend": "cuda",
    "cuda_major": 13,
    "cuda_family": "cudart",
    "llama_cpp_pin": None,
    "llama_swap_port": 8085,
    "lang": "pt-BR",
    "start_with_system": False,
    "auto_start_llama_swap": True,
    "close_to_tray": True,
    "check_updates_on_start": True,
}


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Point the per-user root at a temp dir so tests never touch the real one."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    return tmp_path


class TestParseConfig:
    def test_valid_full_config(self):
        cfg = parse_config(VALID)
        assert cfg.backend == "cuda"
        assert cfg.cuda_major == 13
        assert cfg.lang == "pt-BR"
        assert cfg.auto_start_llama_swap is True

    def test_missing_version_raises(self):
        # A file without a version is not a valid config (matches TS: o.version !== 1).
        with pytest.raises(ConfigError, match="version"):
            parse_config({"backend": "cpu"})

    def test_fills_missing_keys_with_defaults(self):
        cfg = parse_config({"version": 1, "install_dir": "/x"})
        assert cfg.llama_swap_port == 8085
        assert cfg.first_run_done is False
        assert cfg.backend == "cpu"
        assert cfg.lang == "en"
        assert cfg.close_to_tray is True

    def test_unknown_keys_dropped(self):
        cfg = parse_config({"version": 1, "bogus": 42, "backend": "vulkan"})
        assert cfg.backend == "vulkan"
        assert not hasattr(cfg, "bogus")

    def test_unknown_backend_raises(self):
        with pytest.raises(ConfigError, match="backend"):
            parse_config({"version": 1, "backend": "metal"})

    def test_bad_version_raises(self):
        with pytest.raises(ConfigError, match="version"):
            parse_config({"version": 2})

    def test_not_an_object_raises(self):
        with pytest.raises(ConfigError, match="not an object"):
            parse_config([1, 2, 3])

    def test_bad_port_raises(self):
        with pytest.raises(ConfigError, match="llama_swap_port"):
            parse_config({"version": 1, "llama_swap_port": 0})

    def test_port_float_raises(self):
        with pytest.raises(ConfigError, match="llama_swap_port"):
            parse_config({"version": 1, "llama_swap_port": 80.5})

    def test_port_bool_rejected(self):
        # bool is a subclass of int in Python — must not slip through as 1
        with pytest.raises(ConfigError, match="llama_swap_port"):
            parse_config({"version": 1, "llama_swap_port": True})

    def test_cuda_major_invalid_becomes_none(self):
        cfg = parse_config({"version": 1, "backend": "cuda", "cuda_major": 11})
        assert cfg.cuda_major is None

    def test_unknown_lang_raises(self):
        with pytest.raises(ConfigError, match="lang"):
            parse_config({"version": 1, "lang": "fr"})

    def test_cuda_family_defaults_to_cudart(self):
        cfg = parse_config({"version": 1, "backend": "cuda"})
        assert cfg.cuda_family == "cudart"
        cfg2 = parse_config({"version": 1, "backend": "cuda", "cuda_family": "plain"})
        assert cfg2.cuda_family == "plain"


class TestRoundTrip:
    def test_serialize_parse_roundtrip(self):
        cfg = parse_config(VALID)
        again = parse_config(json.loads(serialize_config(cfg)))
        assert again == cfg

    def test_save_load_roundtrip(self, home):
        cfg = AppConfig(
            install_dir=str(home / "custom-root"),  # custom dir ≠ config location
            backend="cuda",
            cuda_major=13,
            llama_swap_port=9999,
        )
        path = save_config(cfg)
        assert path.endswith("config.json")
        # Config lives at the DEFAULT root, not inside the custom install dir.
        assert path == str(C.config_path())
        assert not path.startswith(str(home / "custom-root"))
        loaded = load_config()
        assert loaded == cfg
        assert loaded.llama_swap_port == 9999

    def test_load_missing_returns_defaults(self, home):
        cfg = load_config()
        assert cfg.first_run_done is False
        assert cfg.install_dir == ""

    def test_load_corrupt_raises(self, home):
        C.config_path().parent.mkdir(parents=True, exist_ok=True)
        C.config_path().write_text("{ not json", encoding="utf-8")
        with pytest.raises(ConfigError, match="invalid JSON"):
            load_config()

    def test_default_install_dir_nonempty(self):
        assert default_install_dir().endswith("llama-center")
