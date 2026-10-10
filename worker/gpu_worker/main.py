import asyncio
import contextlib
import json
import logging
import shutil
import signal
import sys
import time

import numpy as np
import redis.asyncio as aioredis
import torch
from bullmq import Queue, UnrecoverableError, Worker
from PIL import Image

from .config import Config, load_config
from .detector import Detector
from .gpu import gpu_info, pick_device
from .jobs import Canceled, JobRunner
from .lama import Lama
from .settings import parse_settings

QUEUES = {"detect": "gpu-detect", "inpaint": "gpu-inpaint", "webhook": "gpu-webhook"}
HEARTBEAT_S = 5

log = logging.getLogger("gpu-worker")


class Service:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.redis = aioredis.from_url(cfg.redis_url, decode_responses=True)
        self.device = pick_device(cfg.device)
        self.state: dict[str, str] = {"ready": "0", "startedAt": str(int(time.time() * 1000))}
        self.models: dict[str, str] = {}
        self.runner: JobRunner | None = None
        self.workers: dict[str, Worker] = {}
        self.webhook: Queue | None = None
        self.stop = asyncio.Event()

    async def heartbeat(self) -> None:
        while not self.stop.is_set():
            info = {**self.state, **gpu_info(self.device), "models": json.dumps(self.models), "at": str(int(time.time() * 1000))}
            with contextlib.suppress(Exception):
                await self.redis.hset(self.cfg.key("worker"), mapping=info)
                await self.redis.expire(self.cfg.key("worker"), HEARTBEAT_S * 6)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.stop.wait(), HEARTBEAT_S)

    def load_models(self) -> JobRunner:
        started = time.perf_counter()
        detector = Detector(self.cfg.detector_model, self.device)
        lama = Lama(self.cfg.lama_model, self.device)
        detector.detect([Image.new("RGB", (640, 900), "white")], 0.4, True, 1.6, 0.25, 1, self.device.type == "cuda")
        blank = np.full((64, 64, 3), 255, np.uint8)
        hole = np.zeros((64, 64), np.uint8)
        hole[24:40, 24:40] = 255
        lama.inpaint([blank], [hole], 8, 1, 1_000_000, False)
        self.models = {"detector": self.cfg.detector_model, "lama": lama.path}
        log.info("modelos carregados em %.1fs no %s", time.perf_counter() - started, self.device)
        return JobRunner(self.cfg, detector, lama)

    async def settings(self) -> dict:
        return parse_settings(await self.redis.hgetall(self.cfg.key("settings")))

    async def finish(self, job_id: str, status: str, error: str | None, busy_ms: int | None) -> None:
        key = self.cfg.key("job", job_id)
        current = await self.redis.hget(key, "status")
        if current == "canceled":
            return
        mapping = {"status": status, "finishedAt": str(int(time.time() * 1000))}
        if error:
            mapping["error"] = error[:2000]
        if busy_ms is not None:
            mapping["gpuMs"] = str(busy_ms)
        shutil.rmtree(self.cfg.job_dir(job_id) / "in", ignore_errors=True)
        pipe = self.redis.pipeline()
        pipe.hset(key, mapping=mapping)
        pipe.expire(key, self.cfg.job_ttl_seconds)
        pipe.expire(self.cfg.key("job", job_id, "result"), self.cfg.job_ttl_seconds)
        job_type = await self.redis.hget(key, "type")
        if job_type:
            pipe.hincrby(self.cfg.key("stats"), f"{job_type}:{status}", 1)
        await pipe.execute()
        if await self.redis.hget(key, "callbackUrl"):
            await self.webhook.add("deliver", {"jobId": job_id, "attempt": 1}, {"removeOnComplete": True, "removeOnFail": True})

    def processor(self, kind: str):
        async def process(job, token):
            job_id = job.data["jobId"]
            key = self.cfg.key("job", job_id)
            row = await self.redis.hgetall(key)
            if not row or row.get("status") in ("canceled", "succeeded", "failed"):
                return None
            mapping = {"status": "running", "attempts": str(job.attemptsMade + 1)}
            if not row.get("startedAt"):
                mapping["startedAt"] = str(int(time.time() * 1000))
            await self.redis.hset(key, mapping=mapping)
            settings = await self.settings()
            run = self.runner.detect if kind == "detect" else self.runner.inpaint
            started = time.perf_counter()
            try:
                busy_ms, failed = await asyncio.to_thread(run, job_id, row, settings)
            except Canceled:
                log.info("%s: cancelado", job_id)
                return None
            except Exception as err:
                final = isinstance(err, UnrecoverableError) or job.attemptsMade + 1 >= int(job.opts.get("attempts") or 1)
                log.exception("%s: falhou (tentativa %d)", job_id, job.attemptsMade + 1)
                if final:
                    await self.finish(job_id, "failed", str(err), None)
                else:
                    await self.redis.hset(key, "error", f"tentativa {job.attemptsMade + 1}: {err}"[:2000])
                raise
            total = int(row.get("total") or 0)
            status = "failed" if total and failed >= total else "succeeded"
            error = f"{failed} de {total} arquivos com erro" if failed else None
            await self.finish(job_id, status, error, busy_ms)
            log.info("%s: %s %d arquivos em %.1fs (modelo %.1fs)%s", job_id, kind, total, time.perf_counter() - started, busy_ms / 1000, f", {failed} com erro" if failed else "")
            return {"failed": failed}

        return process

    async def watch_settings(self) -> None:
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(self.cfg.key("settings", "changed"))
        try:
            while not self.stop.is_set():
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=2.0)
                if message:
                    await self.apply_concurrency()
        finally:
            await pubsub.unsubscribe()
            await pubsub.aclose()

    async def apply_concurrency(self) -> None:
        s = await self.settings()
        for kind, worker in self.workers.items():
            n = int(s[f"{kind}_concurrency"])
            if worker.opts.get("concurrency") != n:
                worker.opts["concurrency"] = n
                log.info("fila %s: %d jobs simultâneos", QUEUES[kind], n)

    async def run(self) -> int:
        heartbeat = asyncio.create_task(self.heartbeat())
        try:
            self.runner = await asyncio.to_thread(self.load_models)
        except Exception as err:
            log.exception("não foi possível carregar os modelos")
            self.state["error"] = str(err)[:500]
            await asyncio.sleep(HEARTBEAT_S + 1)
            self.stop.set()
            await heartbeat
            return 1
        opts = {"connection": self.cfg.redis_url, "prefix": self.cfg.queue_prefix}
        self.webhook = Queue(QUEUES["webhook"], opts)
        s = await self.settings()
        for kind in ("detect", "inpaint"):
            self.workers[kind] = Worker(QUEUES[kind], self.processor(kind), {**opts, "concurrency": int(s[f"{kind}_concurrency"]), "lockDuration": 120000, "drainDelay": self.cfg.drain_delay})
            log.info("fila %s ativa: %d jobs simultâneos", QUEUES[kind], int(s[f"{kind}_concurrency"]))
        self.state["ready"] = "1"
        watcher = asyncio.create_task(self.watch_settings())
        await self.stop.wait()
        for worker in self.workers.values():
            await worker.close()
        await self.webhook.close()
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await watcher
        await heartbeat
        with contextlib.suppress(Exception):
            await self.redis.delete(self.cfg.key("worker"))
        await self.redis.aclose()
        return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    logging.getLogger("bullmq").setLevel(logging.WARNING)
    cfg = load_config()
    if cfg.torch_threads > 0:
        torch.set_num_threads(cfg.torch_threads)
    service = Service(cfg)
    log.info("worker iniciando: device %s, redis %s, dados %s", service.device, cfg.redis_url.rsplit("@", 1)[-1], cfg.data_dir)

    async def runner() -> int:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, service.stop.set)
        return await service.run()

    try:
        return asyncio.run(runner())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
