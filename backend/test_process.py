"""Tests for llama_center.process — a stand-in command (python -c) stands in
for the llama-swap binary, so no real exe is needed."""
import sys
import time

import pytest

from llama_center.process import LlamaSwapProcess, ProcessError


def _wait_until(predicate, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def test_start_stop_and_lines(tmp_path):
    cmd = [sys.executable, "-c", "import time; print('hello llama', flush=True); time.sleep(30)"]
    p = LlamaSwapProcess(cmd, tmp_path, tmp_path / "logs")
    pid = p.start()
    assert pid
    assert p.running
    assert p.pid == pid

    assert _wait_until(lambda: any("hello llama" in line for line in p.lines()))
    p.stop()
    p.flush()
    assert not p.running
    assert p.pid is None
    # the log file got the same line
    log = tmp_path / "logs" / "llama-swap.log"
    assert log.exists()
    assert "hello llama" in log.read_text(encoding="utf-8")


def test_stop_returns_exit_code(tmp_path):
    cmd = [sys.executable, "-c", "import time; time.sleep(30)"]
    p = LlamaSwapProcess(cmd, tmp_path, tmp_path / "logs")
    p.start()
    code = p.stop()
    assert code is not None  # platform-specific (SIGTERM / TerminateProcess)


def test_stop_never_started_returns_none(tmp_path):
    p = LlamaSwapProcess([sys.executable, "-c", "pass"], tmp_path, tmp_path / "logs")
    assert p.stop() is None


def test_double_start_raises(tmp_path):
    cmd = [sys.executable, "-c", "import time; time.sleep(30)"]
    p = LlamaSwapProcess(cmd, tmp_path, tmp_path / "logs")
    p.start()
    with pytest.raises(ProcessError, match="already running"):
        p.start()
    p.stop()


def test_ring_buffer_caps_lines(tmp_path):
    cmd = [sys.executable, "-c", "import sys; [print(i, flush=True) for i in range(50)]"]
    p = LlamaSwapProcess(cmd, tmp_path, tmp_path / "logs", ring_size=10)
    p.start()
    assert _wait_until(lambda: len(p.lines()) == 10 and p.lines()[-1] == "49")
    p.stop()
    p.flush()
    assert len(p.lines()) == 10
    assert p.lines()[-1] == "49"
    assert p.lines()[0] == "40"


def test_lines_returns_last_n(tmp_path):
    cmd = [sys.executable, "-c", "import sys; [print(i, flush=True) for i in range(50)]"]
    p = LlamaSwapProcess(cmd, tmp_path, tmp_path / "logs", ring_size=100)
    p.start()
    assert _wait_until(lambda: len(p.lines()) == 50)
    p.stop()
    p.flush()
    last5 = p.lines(5)
    assert len(last5) == 5
    assert last5[-1] == "49"
