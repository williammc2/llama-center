"""Tests for the llama-swap config abstraction (models -> cmd -> yaml)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from llama_center import swapconfig as swc  # noqa: E402

SERVER = r"C:\lc\llama-cpp\llama-server.exe"

# The user's real config (D:\llama-swap\config.yaml) — the reference fixture.
USER_CONFIG = """\
healthCheckTimeout: 120

models:

  qwen3.8-27b-uncensored:
    aliases:
      - qwen3.8-27b-uncensored

    cmd: >
      D:\\llama-cpp-cuda-13\\llama-server.exe
      --host 127.0.0.1
      --port ${PORT}
      --model "D:\\models\\qwe3.8-27b\\uncensored\\Qwen3.8-27B-Uncensored-IQ4_XS.gguf"
      --mmproj "D:\\models\\qwe3.8-27b\\uncensored\\mmproj-Qwen3.8-27B-Uncensored-f16.gguf"
      --ctx-size 262144
      --parallel 1
      --gpu-layers 999
      --threads 12
      --image-min-tokens 1024
      --threads-batch 16
      --flash-attn on
      --cache-type-k q4_0
      --cache-type-v q4_0
      --reasoning-preserve
      --jinja
      --spec-type draft-mtp
      --reasoning_effort medium
      --spec-draft-n-max 4
      --spec-draft-type-k q8_0
      --spec-draft-type-v q8_0
      --temp 0.7
      --top_p 0.95
      --top_k 20
      --min_p 0.0
      --presence_penalty 0.0
      --repeat-penalty 1.0
      --metrics
"""


def full_model() -> swc.SwapModel:
    return swc.SwapModel(
        name="qwen3.8-27b",
        model="D:\\models\\Qwen3.8-27B.gguf",
        mmproj="D:\\models\\mmproj.gguf",
        draft="D:\\models\\draft.gguf",
        ctx_size=262144,
        gpu_layers=999,
        threads=12,
        extra_flags="--flash-attn on --spec-type draft-mtp",
    )


class TestBuildCmd:
    def test_full_model(self):
        cmd = swc.build_cmd(full_model(), SERVER)
        assert cmd == (
            f'{SERVER} --host 127.0.0.1 --port ${{PORT}} '
            f'--model "D:\\models\\Qwen3.8-27B.gguf" '
            f'--mmproj "D:\\models\\mmproj.gguf" '
            f'--model-draft "D:\\models\\draft.gguf" '
            f'--ctx-size 262144 --gpu-layers 999 --threads 12 '
            f'--flash-attn on --spec-type draft-mtp'
        )

    def test_minimal_model_no_optionals(self):
        m = swc.SwapModel(name="m", model="D:\\m.gguf")
        cmd = swc.build_cmd(m, SERVER)
        assert cmd == (
            f'{SERVER} --host 127.0.0.1 --port ${{PORT}} --model "D:\\m.gguf" '
            f'--ctx-size {swc.DEFAULT_CTX} --gpu-layers {swc.DEFAULT_GPU_LAYERS}'
        )
        assert "--mmproj" not in cmd
        assert "--threads" not in cmd

    def test_path_with_space_is_quoted(self):
        m = swc.SwapModel(name="m", model="D:\\my models\\a b.gguf")
        cmd = swc.build_cmd(m, SERVER)
        assert '--model "D:\\my models\\a b.gguf"' in cmd

    def test_extra_flags_stripped(self):
        m = swc.SwapModel(name="m", model="D:\\m.gguf", extra_flags="  --jinja  ")
        assert swc.build_cmd(m, SERVER).endswith("--jinja")

    def test_extra_flags_newlines_collapsed(self):
        """Newlines (e.g. pasted from a multi-line textarea) become single spaces."""
        m = swc.SwapModel(
            name="m",
            model="D:\\m.gguf",
            extra_flags="--flash-attn on\n--spec-type draft-mtp\n  --temp 0.7",
        )
        cmd = swc.build_cmd(m, SERVER)
        assert "\n" not in cmd
        assert cmd.endswith("--flash-attn on --spec-type draft-mtp --temp 0.7")


class TestRenderParse:
    def test_roundtrip(self):
        models = [full_model(), swc.SwapModel(name="small", model="D:\\s.gguf")]
        text = swc.render_yaml(models, SERVER)
        back = swc.parse_models(text)
        assert len(back) == 2
        first = back[0]
        assert first.name == "qwen3.8-27b"
        assert first.model == "D:\\models\\Qwen3.8-27B.gguf"
        assert first.mmproj == "D:\\models\\mmproj.gguf"
        assert first.draft == "D:\\models\\draft.gguf"
        assert first.ctx_size == 262144
        assert first.gpu_layers == 999
        assert first.threads == 12
        assert "--spec-type draft-mtp" in first.extra_flags
        assert back[1].name == "small"
        assert back[1].ctx_size == swc.DEFAULT_CTX

    def test_render_is_valid_yaml_with_aliases(self):
        import yaml

        doc = yaml.safe_load(swc.render_yaml([full_model()], SERVER))
        assert doc["healthCheckTimeout"] == 120
        assert doc["models"]["qwen3.8-27b"]["aliases"] == ["qwen3.8-27b"]
        assert SERVER in doc["models"]["qwen3.8-27b"]["cmd"]

    def test_parse_user_config(self):
        """The user's existing config.yaml parses into fields + preserved extras."""
        models = swc.parse_models(USER_CONFIG)
        assert len(models) == 1
        m = models[0]
        assert m.name == "qwen3.8-27b-uncensored"
        assert m.model == "D:\\models\\qwe3.8-27b\\uncensored\\Qwen3.8-27B-Uncensored-IQ4_XS.gguf"
        assert m.mmproj == "D:\\models\\qwe3.8-27b\\uncensored\\mmproj-Qwen3.8-27B-Uncensored-f16.gguf"
        assert m.draft is None
        assert m.ctx_size == 262144
        assert m.gpu_layers == 999
        assert m.threads == 12
        # everything not exposed as a field survives in extra_flags
        for flag in (
            "--parallel 1",
            "--flash-attn on",
            "--cache-type-k q4_0",
            "--spec-type draft-mtp",
            "--reasoning_effort medium",
            "--temp 0.7",
            "--metrics",
        ):
            assert flag in m.extra_flags, f"lost: {flag}"
        # and the exe path is NOT in the extras (it's abstracted)
        assert "llama-server" not in m.extra_flags

    def test_parse_empty_doc(self):
        assert swc.parse_models("healthCheckTimeout: 120\n") == []
        assert swc.parse_models("") == []


class TestValidate:
    def test_duplicate_name(self):
        with pytest.raises(swc.SwapConfigError, match="duplicate"):
            swc.validate_models(
                [
                    swc.SwapModel(name="a", model="D:\\a.gguf"),
                    swc.SwapModel(name="a", model="D:\\b.gguf"),
                ]
            )

    def test_empty_model_path(self):
        with pytest.raises(swc.SwapConfigError):
            swc.validate_models([swc.SwapModel(name="a", model="  ")])

    def test_bad_ctx(self):
        with pytest.raises(swc.SwapConfigError):
            swc.validate_models([swc.SwapModel(name="a", model="D:\\a.gguf", ctx_size=0)])

    def test_bad_name_chars(self):
        with pytest.raises(swc.SwapConfigError):
            swc.validate_models([swc.SwapModel(name="has spaces", model="D:\\a.gguf")])

    def test_ok(self):
        swc.validate_models([full_model()])
