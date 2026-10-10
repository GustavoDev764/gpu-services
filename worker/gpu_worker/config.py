import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv() -> None:
    for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            os.environ.setdefault(name.strip(), value.strip().strip("\"'"))
        return


@dataclass(frozen=True)
class Config:
    redis_url: str
    key_prefix: str
    queue_prefix: str
    data_dir: Path
    job_ttl_seconds: int
    device: str
    detector_model: str
    lama_model: str
    decode_threads: int
    torch_threads: int
    drain_delay: float

    def key(self, *parts: str) -> str:
        return ":".join([self.key_prefix, *parts])

    def job_dir(self, job_id: str) -> Path:
        return self.data_dir / "jobs" / job_id


def load_config() -> Config:
    _load_dotenv()
    env = os.environ
    url = env.get("REDIS_URL", "redis://127.0.0.1:6379").rstrip("/")
    db = env.get("REDIS_DB")
    if db and url.count("/") <= 2:
        url = f"{url}/{db}"
    return Config(
        redis_url=url,
        key_prefix=env.get("KEY_PREFIX", "gpu"),
        queue_prefix=env.get("QUEUE_PREFIX", "bull"),
        data_dir=Path(env.get("DATA_DIR", "./data")).resolve(),
        job_ttl_seconds=int(env.get("JOB_TTL_SECONDS", "172800")),
        device=env.get("DEVICE", "auto"),
        detector_model=env.get("DETECTOR_MODEL", "ogkalu/comic-text-and-bubble-detector"),
        lama_model=env.get("LAMA_MODEL", ""),
        decode_threads=max(1, int(env.get("DECODE_THREADS", "2"))),
        torch_threads=int(env.get("TORCH_THREADS", "0")),
        drain_delay=max(0.1, float(env.get("QUEUE_DRAIN_DELAY", "0.5"))),
    )
