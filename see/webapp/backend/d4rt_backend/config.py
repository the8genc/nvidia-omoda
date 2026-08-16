"""Config: typed application config loaded from a YAML file. Responsible for parsing and validating settings. NOT concerned with using them. | I/O: (config.yaml path) -> AppConfig"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8017
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")


@dataclass(frozen=True)
class EngineConfig:
    kind: str = "stub"
    repo_path: Path | None = None
    config_path: Path | None = None
    ckpt_path: Path | None = None
    device: str = "cuda"


@dataclass(frozen=True)
class LibraryConfig:
    """Where the demo's clips live. There is no upload path; this is the whole catalogue."""

    videos_dir: Path = Path("~/default-videos")
    # Where analysed scenes are kept between runs. Every clip is reconstructed
    # once at startup, which is minutes for a full playlist; keyed on the video's
    # own contents, that work only ever has to happen once per clip.
    cache_dir: Path = Path("~/.cache/d4rt-scenes")
    # Per-clip (left, top, right, bottom) fractions to cut, for the cameras that
    # burn an inset or a banner into the frame. Anything absent gets the default.
    crops: dict[str, tuple[float, float, float, float]] = field(default_factory=dict)


@dataclass(frozen=True)
class LimitsConfig:
    ffprobe_path: str = "ffprobe"
    ffprobe_timeout_seconds: float = 20.0


@dataclass(frozen=True)
class RuntimeConfig:
    nice: int = 10
    omp_num_threads: int = 4


@dataclass(frozen=True)
class AppConfig:
    server: ServerConfig = field(default_factory=ServerConfig)
    engine: EngineConfig = field(default_factory=EngineConfig)
    library: LibraryConfig = field(default_factory=LibraryConfig)
    limits: LimitsConfig = field(default_factory=LimitsConfig)
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)


ENGINE_KINDS = ("stub", "d4rt")


def _as_path(value: Any, base: Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def _optional_path(value: Any, base: Path) -> Path | None:
    return None if value is None else _as_path(value, base)


def _section(raw: dict[str, Any], name: str) -> dict[str, Any]:
    section = raw.get(name) or {}
    if not isinstance(section, dict):
        raise ValueError(f"Config section '{name}' must be a mapping, got {type(section).__name__}")
    return section


def load_config(path: Path) -> AppConfig:
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {path}")
    raw = yaml.safe_load(path.read_text()) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"Config root must be a mapping: {path}")

    base = path.parent.resolve()
    server = _section(raw, "server")
    engine = _section(raw, "engine")
    library = _section(raw, "library")
    limits = _section(raw, "limits")
    runtime = _section(raw, "runtime")

    kind = engine.get("kind", "stub")
    if kind not in ENGINE_KINDS:
        raise ValueError(f"engine.kind must be one of {ENGINE_KINDS}, got '{kind}'")

    return AppConfig(
        server=ServerConfig(
            host=server.get("host", "127.0.0.1"),
            port=int(server.get("port", 8017)),
            cors_origins=tuple(server.get("cors_origins", ServerConfig.cors_origins)),
        ),
        engine=EngineConfig(
            kind=kind,
            repo_path=_optional_path(engine.get("repo_path"), base),
            config_path=_optional_path(engine.get("config_path"), base),
            ckpt_path=_optional_path(engine.get("ckpt_path"), base),
            device=engine.get("device", "cuda"),
        ),
        library=LibraryConfig(
            videos_dir=_as_path(library.get("videos_dir", "~/default-videos"), base),
            cache_dir=_as_path(library.get("cache_dir", "~/.cache/d4rt-scenes"), base),
            crops={
                name: tuple(float(v) for v in values)
                for name, values in (library.get("crops") or {}).items()
            },
        ),
        limits=LimitsConfig(
            ffprobe_path=limits.get("ffprobe_path", "ffprobe"),
            ffprobe_timeout_seconds=float(limits.get("ffprobe_timeout_seconds", 20.0)),
        ),
        runtime=RuntimeConfig(
            nice=int(runtime.get("nice", 10)),
            omp_num_threads=int(runtime.get("omp_num_threads", 4)),
        ),
    )
