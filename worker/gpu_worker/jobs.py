import json
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Callable, Iterator, Sequence, TypeVar

import numpy as np
import redis

from .config import Config
from .detector import Detector
from .images import ImageError, load_image, load_mask, save_png
from .lama import Lama

T = TypeVar("T")
L = TypeVar("L")


class Canceled(Exception):
    pass


def prefetched(groups: Sequence[T], load: Callable[[T], L], pool: ThreadPoolExecutor) -> Iterator[tuple[T, L]]:
    future: Future | None = pool.submit(load, groups[0]) if groups else None
    for index, group in enumerate(groups):
        current = future.result()
        future = pool.submit(load, groups[index + 1]) if index + 1 < len(groups) else None
        yield group, current


def chunks(items: list[T], size: int) -> list[list[T]]:
    return [items[i : i + size] for i in range(0, len(items), max(1, size))]


class JobRunner:
    def __init__(self, cfg: Config, detector: Detector, lama: Lama) -> None:
        self.cfg = cfg
        self.detector = detector
        self.lama = lama
        self.redis = redis.Redis.from_url(cfg.redis_url, decode_responses=True)
        self.decode_pool = ThreadPoolExecutor(max_workers=cfg.decode_threads, thread_name_prefix="decode")
        self.save_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="save")

    def _check(self, job_id: str) -> None:
        if self.redis.hget(self.cfg.key("job", job_id), "status") == "canceled":
            raise Canceled()

    def _store(self, job_id: str, results: list[dict]) -> None:
        if not results:
            return
        pipe = self.redis.pipeline()
        pipe.hset(self.cfg.key("job", job_id, "result"), mapping={r["name"]: json.dumps(r) for r in results})
        pipe.hincrby(self.cfg.key("job", job_id), "done", len(results))
        failed = sum(1 for r in results if r["status"] == "failed")
        if failed:
            pipe.hincrby(self.cfg.key("job", job_id), "failed", failed)
        pipe.execute()

    def detect(self, job_id: str, row: dict, settings: dict) -> tuple[int, int]:
        inputs = json.loads(row["inputs"])
        params = json.loads(row.get("params") or "{}")
        done = set(self.redis.hkeys(self.cfg.key("job", job_id, "result")))
        todo = [i for i in inputs if i["name"] not in done]
        folder = self.cfg.job_dir(job_id) / "in"
        batch = int(settings["detect_batch"])

        def load(group: list[dict]):
            out = []
            for item in group:
                try:
                    out.append(load_image(folder / item["file"]))
                except ImageError as err:
                    out.append(err)
            return out

        busy_ms = 0
        failed = 0
        for group, decoded in prefetched(chunks(todo, max(batch, 4)), load, self.decode_pool):
            self._check(job_id)
            ok = [(item, img) for item, img in zip(group, decoded) if not isinstance(img, Exception)]
            results = [
                {"name": item["name"], "status": "failed", "error": str(img)}
                for item, img in zip(group, decoded)
                if isinstance(img, Exception)
            ]
            started = time.perf_counter()
            found = self.detector.detect(
                [img for _, img in ok],
                threshold=float(params.get("threshold", settings["detect_threshold"])),
                tiles=bool(params.get("tiles", True)),
                tile_aspect=float(settings["tile_aspect"]),
                tile_overlap=float(settings["tile_overlap"]),
                batch=batch,
                fp16=bool(settings["fp16_detect"]),
            )
            busy_ms += round((time.perf_counter() - started) * 1000)
            for (item, img), (detections, tiles) in zip(ok, found):
                results.append({"name": item["name"], "status": "done", "width": img.size[0], "height": img.size[1], "tiles": tiles, "detections": detections})
            failed += sum(1 for r in results if r["status"] == "failed")
            self._store(job_id, results)
        return busy_ms, failed

    def inpaint(self, job_id: str, row: dict, settings: dict) -> tuple[int, int]:
        inputs = json.loads(row["inputs"])
        params = json.loads(row.get("params") or "{}")
        done = set(self.redis.hkeys(self.cfg.key("job", job_id, "result")))
        todo = [i for i in inputs if i["name"] not in done]
        folder = self.cfg.job_dir(job_id) / "in"
        out_dir = self.cfg.job_dir(job_id) / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        group_size = max(4, int(settings["inpaint_batch"]))

        def load(group: list[dict]):
            out = []
            for item in group:
                try:
                    image = load_image(folder / item["file"])
                    mask = load_mask(folder / item["mask"], image.size)
                    out.append((np.asarray(image), mask))
                except ImageError as err:
                    out.append(err)
            return out

        busy_ms = 0
        failed = 0
        pending: list[Future] = []
        used: set[str] = set()
        for group, decoded in prefetched(chunks(todo, group_size), load, self.decode_pool):
            self._check(job_id)
            ok = [(item, pair) for item, pair in zip(group, decoded) if not isinstance(pair, Exception)]
            results = [
                {"name": item["name"], "status": "failed", "error": str(pair)}
                for item, pair in zip(group, decoded)
                if isinstance(pair, Exception)
            ]
            started = time.perf_counter()
            filled = self.lama.inpaint(
                [pair[0] for _, pair in ok],
                [pair[1] for _, pair in ok],
                context=int(params.get("context", settings["lama_context"])),
                max_count=int(settings["inpaint_batch"]),
                max_pixels=int(settings["inpaint_batch_pixels"]),
                fp16=bool(settings["fp16_lama"]),
            )
            busy_ms += round((time.perf_counter() - started) * 1000)
            for (item, pair), (rgb, windows) in zip(ok, filled):
                stem = item["name"].rsplit(".", 1)[0]
                file = f"{stem}.png"
                n = 2
                while file.lower() in used:
                    file = f"{stem}-{n}.png"
                    n += 1
                used.add(file.lower())
                pending.append(self.save_pool.submit(save_png, rgb, out_dir / file))
                results.append({"name": item["name"], "status": "done", "file": file, "width": int(rgb.shape[1]), "height": int(rgb.shape[0]), "windows": windows})
            for f in pending:
                f.result()
            pending.clear()
            failed += sum(1 for r in results if r["status"] == "failed")
            self._store(job_id, results)
        return busy_ms, failed
