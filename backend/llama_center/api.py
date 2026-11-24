"""The pywebview API surface, split into focused mixins.

main.py composes them into a single ``Api`` class — pywebview exposes one
object as ``window.pywebview.api``, so the UI sees the same flat surface
as before; the split only organizes the Python side by responsibility:

  ConfigApi      config read/write + detection (the camelCase boundary)
  ComponentApi   component install/update: download, stage, swap, rollback
  ProcessApi     the managed llama-swap: start, stop, status, logs
  SwapConfigApi  the llama-swap models config: save, read, import
  AppUpdateApi   the app's own installer download/launch

Shared state and helpers live in ``_ApiBase`` so every mixin reads in
isolation: ``_managed`` (the one-and-only managed process), ``_force_close``
(the self-update close hook, set by the composed Api), and the config/
progress helpers the mixins share.
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import threading
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path

import requests
import webview

from llama_center import autostart, launch, updater
from llama_center import process as proc
from llama_center import swapconfig as swc
from llama_center.config import (
    AppConfig,
    ConfigError,
    load_config,
    parse_config,
    save_config,
)
from llama_center.detect import detect


class _ApiBase:
    """Shared state + helpers for the API mixins.

    The composed ``Api`` (main.py) inherits it along with the five mixins;
    tests construct ``Api()`` and set ``_force_close`` there.
    """

    _managed: proc.LlamaSwapProcess | None = None
    _force_close: Callable[[], None] | None = None

    # --- shared helpers ---------------------------------------------------

    def _dirs(self, component: str = "llama-swap") -> updater.ComponentDirs:
        """Managed paths for the configured install dir. Raises ConfigError."""
        cfg = load_config()
        if not cfg.install_dir:
            raise ConfigError("install_dir not set — run the wizard first")
        return updater.component_dirs(cfg.install_dir, component)

    def _installed_label(self, component: str) -> str | None:
        """What is currently installed, for the backup dir name."""
        cfg = load_config()
        if component == "llama-swap" and cfg.llama_swap_installed:
            return f"v{cfg.llama_swap_installed}"
        if component == "llama-cpp" and cfg.llama_cpp_installed:
            return cfg.llama_cpp_installed
        return None

    def _push_progress(self, payload: dict) -> None:
        """Push a download-progress event to the UI (cosmetic — never raises)."""
        try:
            if webview.windows:
                webview.windows[0].evaluate_js(
                    f"window.__lcProgress && window.__lcProgress({json.dumps(payload)})"
                )
        except Exception:
            pass

    @staticmethod
    def _clean_downloads(downloads: Path) -> None:
        """Remove archives and staging dirs after a successful swap."""
        if not downloads.is_dir():
            return
        for entry in downloads.iterdir():
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)


class ConfigApi(_ApiBase):
    """Config read/write + detection — the camelCase boundary (P0)."""

    def get_detection(self) -> dict:
        d = detect()
        return {
            "os": d.os,
            "arch": d.arch,
            "suggestCuda": d.suggest_cuda,
            "backends": list(d.backends),
        }

    def get_config(self):
        """Current config as a dict (camelCase, matching the TS shape) or None."""
        try:
            cfg = load_config()
        except ConfigError:
            return {"error": "corrupt"}
        return self._to_camel(cfg)

    def save_config(self, raw: dict) -> dict:
        """Validate + persist. Returns {path} or {error}.

        Also applies the autostart entry so the toggle takes effect at once.
        """
        try:
            cfg = parse_config(self._from_camel(raw))
            path = save_config(cfg)
        except ConfigError as e:
            return {"error": str(e)}
        # autostart is best-effort; the config save is what matters
        with contextlib.suppress(Exception):
            autostart.apply(cfg.start_with_system)
        return {"path": path}

    # --- shape conversion -------------------------------------------------
    # UI speaks camelCase (TS), Python speaks snake_case (PEP8). One place
    # owns the mapping.
    _KEY_MAP = {
        "firstRunDone": "first_run_done",
        "installDir": "install_dir",
        "cudaMajor": "cuda_major",
        "cudaFamily": "cuda_family",
        "llamaCppInstalled": "llama_cpp_installed",
        "llamaSwapPort": "llama_swap_port",
        "llamaSwapInstalled": "llama_swap_installed",
        "startWithSystem": "start_with_system",
        "autoStartLlamaSwap": "auto_start_llama_swap",
        "serverBackend": "server_backend",
        "basaltExe": "basalt_exe",
        "basaltArgs": "basalt_args",
        "basaltPort": "basalt_port",
        "basaltInstalled": "basalt_installed",
        "closeToTray": "close_to_tray",
        "checkUpdatesOnStart": "check_updates_on_start",
        "hfToken": "hf_token",
        "modelDirs": "model_dirs",
    }

    def _from_camel(self, raw: dict) -> dict:
        out = {}
        for k, v in raw.items():
            out[self._KEY_MAP.get(k, k)] = v
        return out

    def _to_camel(self, cfg: AppConfig) -> dict:
        d = cfg.to_dict()
        rev = {v: k for k, v in self._KEY_MAP.items()}
        return {rev.get(k, k): v for k, v in d.items()}


class ComponentApi(_ApiBase):
    """Component install/update: download, stage, swap, rollback (P1)."""

    def download_and_stage(
        self, component: str, url: str, sha256: str | None = None, into: str | None = None
    ) -> dict:
        """Download a release asset, verify SHA-256, extract to staging.

        With `into` set, the archive is merged INTO that directory (no wipe) —
        used for a second asset (e.g. the Windows CUDA DLLs zip). Returns
        {staging: <content dir>} or {error}.
        """
        try:
            d = self._dirs(component)
            name = url.rsplit("/", 1)[-1].split("?")[0] or component
            archive = d.downloads / name

            def _on_progress(received: int, total: int | None) -> None:
                self._push_progress(
                    {"component": component, "file": name, "received": received, "total": total}
                )

            updater.download(url, archive, sha256, progress=_on_progress)
            if into:
                content = updater.extract(archive, Path(into), merge=True)
            else:
                content = updater.extract(archive, d.staging)
            return {"staging": str(content)}
        except (ConfigError, updater.UpdateError, OSError) as e:
            return {"error": str(e)}

    def swap_component(self, component: str) -> dict:
        """Swap staging into the live dir; previous install → backups.

        Cleans up downloads/ (archives + staging) on success.
        Returns {backup: <name> | null} or {error}.
        """
        try:
            d = self._dirs(component)
            backup = updater.atomic_swap(
                d, d.staging, label=self._installed_label(component)
            )
            self._clean_downloads(d.downloads)
            return {"backup": backup}
        except (ConfigError, updater.UpdateError, OSError) as e:
            return {"error": str(e)}

    def rollback_component(self, component: str) -> dict:
        """Restore the newest backup. Returns {rolledBack: bool} or {error}."""
        try:
            d = self._dirs(component)
            return {"rolledBack": updater.rollback(d)}
        except (ConfigError, updater.UpdateError, OSError) as e:
            return {"error": str(e)}

    def list_component_backups(self, component: str) -> list:
        """Backup dir names, newest first. [] when none (or no config)."""
        try:
            return updater.list_backups(self._dirs(component).backups)
        except ConfigError:
            return []


class ProcessApi(_ApiBase):
    """The managed llama-swap process: start, stop, status, logs (P3).

    Holds the one-and-only managed process as instance state (``self._managed``)
    — initialized by the composed Api, not by this mixin.
    """

    def _exe(self, d: updater.ComponentDirs) -> Path | None:
        name = "llama-swap.exe" if os.name == "nt" else "llama-swap"
        p = d.live / name
        return p if p.exists() else None

    def _server_target(self, cfg) -> dict:
        """Resolve (exe, cmd, workdir, logs, port, name) for the configured
        backend, or {"error": ...}. Backend dispatch lives here — the start/
        stop/status/logs methods below stay backend-agnostic."""
        if cfg.server_backend == "basalt":
            exe = Path(cfg.basalt_exe) if cfg.basalt_exe else None
            if exe is None or not exe.exists():
                return {"error": "basalt-not-found"}
            args = cfg.basalt_args.split()
            cmd = [str(exe)] + args
            # basalt resolves a relative --config against its CWD — default
            # workdir is the exe's own folder; pass an absolute --config to
            # decouple (shortcut: relative config paths won't resolve).
            workdir = exe.parent
            logs = exe.parent / "logs"
            return {
                "cmd": cmd,
                "workdir": workdir,
                "logs": logs,
                "port": cfg.basalt_port,
                "name": "basalt",
            }
        d = self._dirs("llama-swap")
        exe = self._exe(d)
        if exe is None:
            return {"error": "not-installed"}
        config_file = next(
            (d.live / n for n in ("llama-swap.json", swc.CONFIG_NAME) if (d.live / n).exists()),
            None,
        )
        if config_file is None:
            return {
                "error": "no-config",
                "port": cfg.llama_swap_port,
                "cmd": [], "workdir": d.live, "logs": d.logs, "name": "llama-swap",
            }
        cmd = [str(exe), "--listen", f"localhost:{cfg.llama_swap_port}",
               "--config", str(config_file)]
        return {
            "cmd": cmd,
            "workdir": d.live,
            "logs": d.logs,
            "port": cfg.llama_swap_port,
            "name": "llama-swap",
        }

    def start_llama_swap(self) -> dict:
        """Spawn the configured server (llama-swap or basalt). {pid} | {error}.

        `error` is "port-in-use" (UI shows the conflict dialog),
        "not-installed" / "basalt-not-found", or a spawn failure message.
        """
        try:
            cfg = load_config()
        except ConfigError as e:
            return {"error": str(e)}
        target = self._server_target(cfg)
        if "error" in target and target["error"] != "no-config":
            return {"error": target["error"]}
        if self._managed is not None and self._managed.running:
            return {"error": "already-running"}
        if updater.probe_port(target["port"]):
            return {"error": "port-in-use", "port": target["port"]}
        if "error" in target:
            return {"error": target["error"]}
        try:
            managed = proc.LlamaSwapProcess(target["cmd"], target["workdir"], target["logs"])
            pid = managed.start()
            self._managed = managed
            return {"pid": pid}
        except proc.ProcessError as e:
            return {"error": str(e)}

    def stop_llama_swap(self) -> dict:
        """Stop the managed server (llama-swap or basalt). The managed one is
        stopped first; for llama-swap an adopted (external) process is
        also stopped by image name — basalt gets no kill-by-name fallback.
        {stopped: bool, exitCode: int|null}."""
        if self._managed is not None and self._managed.running:
            code = self._managed.stop()
            self._managed.flush()
            return {"stopped": True, "exitCode": code}
        try:
            cfg = load_config()
        except ConfigError:
            return {"stopped": False, "exitCode": None}
        if cfg.server_backend == "basalt":
            return {"stopped": False, "exitCode": None}
        return {"stopped": updater.stop_llama_swap(), "exitCode": None}

    def restart_llama_swap(self) -> dict:
        """Stop + start the managed llama-swap (one action, no race).

        Only the managed process is restarted — an adopted (external) one is
        left alone. {pid} | {error: "not-running" | start_llama_swap's errors}.
        """
        if self._managed is None or not self._managed.running:
            return {"error": "not-running"}
        self._managed.stop()
        self._managed.flush()
        return self.start_llama_swap()

    def llama_swap_status(self) -> dict:
        """Structured status for the UI (polled ~2s): managed state, port,
        /health, and the /running model list.

        /health is probed FIRST: a 200 implies the port is busy, so the
        common states (running+healthy, nothing there) cost one round trip
        each instead of probe + health.
        """
        try:
            cfg = load_config()
        except ConfigError:
            cfg = None
        port = (
            (cfg.basalt_port if cfg.server_backend == "basalt" else cfg.llama_swap_port)
            if cfg else 8085
        )
        managed = self._managed is not None and self._managed.running
        pid = self._managed.pid if (self._managed is not None and managed) else None
        healthy = updater.health_ok(port)
        port_busy = healthy or updater.probe_port(port)
        models: list[dict] = []
        if healthy:
            try:
                r = requests.get(f"http://127.0.0.1:{port}/running", timeout=2)
                data = r.json()
                for m in data.get("running", []) if isinstance(data, dict) else []:
                    if isinstance(m, dict) and isinstance(m.get("model"), str):
                        models.append({"model": m["model"], "state": m.get("state", "")})
            except Exception:
                pass
        return {
            "managed": managed,
            "pid": pid,
            "portBusy": port_busy,
            "healthy": healthy,
            "models": models,
        }

    def llama_swap_logs(self, n: int = 200) -> list:
        """Last `n` lines of the managed process (newest last). [] when none."""
        if self._managed is not None:
            return self._managed.lines(n)
        return []


class SwapConfigApi(_ApiBase):
    """The llama-swap models config: save, read, import (P4)."""

    def _llama_server_path(self, install_dir: str) -> Path:
        return updater.component_dirs(install_dir, "llama-cpp").live / (
            "llama-server.exe" if os.name == "nt" else "llama-server"
        )

    @staticmethod
    def _models_from_camel(raw: list) -> list:
        out = []
        for r in raw or []:
            if not isinstance(r, dict):
                continue
            out.append(
                swc.SwapModel(
                    name=str(r.get("name", "")),
                    model=str(r.get("model", "")),
                    mmproj=r.get("mmproj") or None,
                    draft=r.get("draft") or None,
                    ctx_size=int(r.get("ctxSize") or swc.DEFAULT_CTX),
                    gpu_layers=int(r.get("gpuLayers") or swc.DEFAULT_GPU_LAYERS),
                    threads=(int(r["threads"]) if r.get("threads") else None),
                    extra_flags=str(r.get("extraFlags", "")),
                )
            )
        return out

    @staticmethod
    def _models_to_camel(models: list) -> list:
        out = []
        for m in models:
            d = asdict(m)
            out.append(
                {
                    "name": d["name"],
                    "model": d["model"],
                    "mmproj": d["mmproj"],
                    "draft": d["draft"],
                    "ctxSize": d["ctx_size"],
                    "gpuLayers": d["gpu_layers"],
                    "threads": d["threads"],
                    "extraFlags": d["extra_flags"],
                }
            )
        return out

    def save_llama_swap_config(self, models: list) -> dict:
        """Render model defs to `llama-swap.yaml` in the llama-swap dir.
        {path} | {error}."""
        try:
            d = self._dirs("llama-swap")
            cfg = load_config()
        except ConfigError as e:
            return {"error": str(e)}
        server = self._llama_server_path(cfg.install_dir)
        if not server.exists():
            return {"error": "llama-cpp-not-installed"}
        try:
            text = swc.render_yaml(self._models_from_camel(models), str(server))
        except swc.SwapConfigError as e:
            return {"error": str(e)}
        p = d.live / swc.CONFIG_NAME
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return {"path": str(p)}

    def get_llama_swap_config(self) -> dict:
        """Read the managed config back into model defs (UI prefill)."""
        try:
            d = self._dirs("llama-swap")
        except ConfigError:
            return {"models": [], "path": None}
        p = d.live / swc.CONFIG_NAME
        if not p.exists():
            return {"models": [], "path": None}
        try:
            models = swc.parse_models(p.read_text(encoding="utf-8"))
        except Exception:
            return {"models": [], "path": str(p)}
        return {"models": self._models_to_camel(models), "path": str(p)}

    def import_llama_swap_config(self, path: str) -> dict:
        """Parse an existing llama-swap config file (e.g. an old config.yaml)
        into model defs. {models} | {error}."""
        p = Path(str(path))
        if not p.is_file():
            return {"error": f"file not found: {path}"}
        try:
            models = swc.parse_models(p.read_text(encoding="utf-8"))
        except Exception as e:
            return {"error": f"could not parse: {e}"}
        if not models:
            return {"error": "no models found in that file"}
        return {"models": self._models_to_camel(models)}

    def open_url(self, url: str) -> dict:
        """Open a URL in the default browser (the server dashboard link)."""
        return launch.open_target(url)

    def open_path(self, path: str) -> dict:
        """Open a folder in the OS file explorer."""
        return launch.open_target(path)


class ModelApi(_ApiBase):
    """Model file downloads from HuggingFace (discovery + bytes).

    The HF API is two flat GETs — no SDK needed:
      list:  https://huggingface.co/api/models/{repo_id}/tree/main
      bytes: https://huggingface.co/{repo_id}/resolve/main/{filename}
    An optional Bearer token (config `hf_token`) unlocks gated repos and a
    higher rate limit; public files work anonymously.
    """

    HF = "https://huggingface.co"

    @staticmethod
    def _model_roots() -> list[Path]:
        """Where model files live: <install_dir>/models + the extra roots
        from Settings (model_dirs). Duplicates collapsed, missing dirs kept
        (a root may be created by the next download)."""
        roots: list[Path] = []
        try:
            cfg = load_config()
        except ConfigError:
            return roots
        if cfg.install_dir:
            roots.append(Path(cfg.install_dir) / "models")
        for d in cfg.model_dirs:
            p = Path(d)
            if p not in roots:
                roots.append(p)
        return roots

    @staticmethod
    def _hf_headers() -> dict[str, str]:
        try:
            token = load_config().hf_token
        except ConfigError:
            token = ""
        return {"Authorization": f"Bearer {token}"} if token else {}

    def list_hf_files(self, repo_id: str) -> dict:
        """List .gguf files in a HF repo (main branch).

        Returns {files: [{name, size, downloaded?, localPath?}]} or {error}.
        `downloaded` marks files already present in the local models dir
        (the UI offers "select" instead of re-downloading).
        """
        repo_id = repo_id.strip().strip("/")
        if not repo_id:
            return {"error": "enter a repo id, e.g. org/model"}
        try:
            r = requests.get(
                f"{self.HF}/api/models/{repo_id}/tree/main",
                headers=self._hf_headers(),
                timeout=15,
            )
        except requests.RequestException as e:
            return {"error": f"HF unreachable: {e}"}
        if r.status_code == 401:
            return {"error": "gated repo — set your HF token in Settings"}
        if r.status_code == 404:
            return {"error": f"repo not found: {repo_id}"}
        if r.status_code != 200:
            return {"error": f"HF returned HTTP {r.status_code}"}
        try:
            entries = r.json()
        except ValueError:
            return {"error": "HF returned non-JSON"}
        # Where downloads for THIS repo land (default root) — also the first
        # place to look for existing copies (extra roots are checked too).
        dest_dir: Path | None = None
        roots: list[Path] = []
        try:
            cfg = load_config()
            if cfg.install_dir:
                dest_dir = Path(cfg.install_dir) / "models" / repo_id
                # default root first, then any extra roots from Settings
                roots = [dest_dir] + [Path(d) / repo_id for d in cfg.model_dirs]
        except ConfigError:
            pass
        files = []
        for item in entries:
            if not (
                isinstance(item, dict)
                and item.get("type") == "file"
                and item.get("path", "").lower().endswith(".gguf")
            ):
                continue
            name = item["path"]
            entry = {"name": name, "size": int(item.get("size") or 0)}
            flat = name.rsplit("/", 1)[-1]
            for root_dir in roots:
                p = root_dir / flat
                if p.exists():
                    entry["downloaded"] = True
                    entry["localPath"] = str(p)
                    break
            files.append(entry)
        files.sort(key=lambda f: f["name"])
        return {"files": files}

    def download_hf_file(self, repo_id: str, filename: str) -> dict:
        """Download one file from a HF repo into <install_dir>/models/.

        Returns {path} (the local file) or {error}. Progress is pushed to
        the UI under component "model" (the shared progress channel).
        """
        repo_id = repo_id.strip().strip("/")
        if not repo_id or not filename:
            return {"error": "missing repo or filename"}
        try:
            cfg = load_config()
            if not cfg.install_dir:
                raise ConfigError("install_dir not set — run the wizard first")
        except ConfigError as e:
            return {"error": str(e)}
        dest_dir = Path(cfg.install_dir) / "models" / repo_id
        dest = dest_dir / filename.rsplit("/", 1)[-1]
        url = f"{self.HF}/{repo_id}/resolve/main/{filename}"

        def _on_progress(received: int, total: int | None) -> None:
            self._push_progress(
                {"component": "model", "file": dest.name, "received": received, "total": total}
            )

        try:
            updater.download(url, dest, None, timeout=600.0, progress=_on_progress)
            return {"path": str(dest)}
        except (updater.UpdateError, OSError) as e:
            return {"error": str(e)}

    def list_model_files(self) -> dict:
        """Every model file on disk: the default models root + any extra roots
        from Settings (model_dirs). {files: [{name, path, size, repo}], roots}.

        `repo` is the folder path relative to the root ("" for loose files) —
        the UI groups by it and offers file- and repo-level delete.
        """
        roots = self._model_roots()
        files = []
        for root in roots:
            if not root.is_dir():
                continue
            for p in sorted(root.rglob("*.gguf")):
                if p.is_file():
                    rel = p.relative_to(root)
                    files.append(
                        {
                            "name": p.name,
                            "path": str(p),
                            "size": p.stat().st_size,
                            # repo-like id (not a filesystem path) — always /
                            "repo": "/".join(rel.parts[:-1]),
                        }
                    )
        return {"files": files, "roots": [str(r) for r in roots]}

    def delete_model_file(self, path: str, whole_repo: bool = False) -> dict:
        """Delete one model file — or its whole repo folder when `whole_repo`.

        {deleted: n} (files removed) | {error}. The path comes from
        list_model_files (or the user's own disk), so no extra trust check.
        """
        p = Path(path)
        try:
            if whole_repo:
                repo = p if p.is_dir() else p.parent
                if not repo.is_dir():
                    return {"error": f"folder not found: {repo}"}
                # A loose file at the root of a model root has no repo folder to
                # wipe — rmtree there would delete the root itself (other repos
                # live there too).
                if repo in self._model_roots():
                    return {"error": f"cannot remove the model root {repo}"}
                n = sum(1 for f in repo.rglob("*.gguf") if f.is_file())
                shutil.rmtree(repo)
            else:
                if not p.is_file():
                    return {"error": f"file not found: {p}"}
                p.unlink()
                n = 1
            return {"deleted": n}
        except OSError as e:
            return {"error": str(e)}

    def export_llama_swap_config(self, path: str | None = None) -> dict:
        """Write the current llama-swap config to a user-chosen path.

        No `path` → a native save dialog (returns {cancelled}). {path} |
        {error}.
        """
        if not path:
            w = webview.windows[0] if webview.windows else None
            if w is None:
                return {"error": "no window for the save dialog"}
            res = w.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename="llama-swap-export.yaml",
                file_types=("YAML files (*.yaml)",),
            )
            if not res:
                return {"cancelled": True}
            path = res[0]
        try:
            d = self._dirs("llama-swap")
        except ConfigError as e:
            return {"error": str(e)}
        p = d.live / swc.CONFIG_NAME
        if not p.exists():
            return {"error": "no config saved yet"}
        dest = Path(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
        return {"path": str(dest)}


class AppUpdateApi(_ApiBase):
    """The app's own installer: download + launch (P5 self-update).

    ``self._force_close`` is injected by the composed Api (main.py owns the
    window-destroy logic; this mixin only schedules it).
    """

    def download_and_launch_installer(self, url: str) -> dict:
        """Download the app installer, launch it with a delay, and close the app.

        The download/launch mechanics live in updater.launch_installer
        (the managed llama-swap is stopped via the `stop_managed` hook so
        this process exits fast). In both OS flavors the app force-quits
        after ~1s so files are freed. Returns {launched: True, closing: True}
        or {error}.
        """

        def _on_progress(received: int, total: int | None) -> None:
            self._push_progress(
                {
                    "component": "app",
                    "file": url.rsplit("/", 1)[-1],
                    "received": received,
                    "total": total,
                }
            )

        def _stop_managed() -> None:
            # Stop the managed llama-swap NOW (not at atexit) so this process
            # exits fast. The installer launches the new instance ~2s after
            # this returns; we must be gone by then (lock + WebView2 folder +
            # files released) or the fresh instance can boot half-dead.
            if self._managed is not None and self._managed.running:
                self._managed.stop(timeout=5)
                self._managed.flush()

        try:
            updater.launch_installer(url, stop_managed=_stop_managed, progress=_on_progress)
            # Force-quit the app after 1s (lets the installer/script start first)
            if self._force_close is not None:
                threading.Timer(1.0, self._force_close).start()
            return {"launched": True, "closing": True}
        except (updater.UpdateError, OSError) as e:
            return {"error": str(e)}
