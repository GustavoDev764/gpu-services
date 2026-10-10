import contextlib
import threading
from typing import Callable, Sequence, TypeVar

import torch

T = TypeVar("T")
R = TypeVar("R")

gpu_lock = threading.Lock()


def pick_device(name: str) -> torch.device:
    if name == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    device = torch.device(name)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("DEVICE=cuda, mas o torch não encontrou GPU")
    return device


def autocast(device: torch.device, fp16: bool):
    if fp16 and device.type == "cuda":
        return torch.autocast(device_type="cuda", dtype=torch.float16)
    return contextlib.nullcontext()


def is_oom(err: BaseException) -> bool:
    return isinstance(err, torch.cuda.OutOfMemoryError) or "out of memory" in str(err).lower()


def run_split(items: Sequence[T], fn: Callable[[Sequence[T]], list[R]]) -> list[R]:
    try:
        return fn(items)
    except RuntimeError as err:
        if not is_oom(err) or len(items) <= 1:
            raise
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        half = len(items) // 2
        return run_split(items[:half], fn) + run_split(items[half:], fn)


def gpu_info(device: torch.device) -> dict:
    if device.type != "cuda":
        return {"device": "cpu"}
    free, total = torch.cuda.mem_get_info(device)
    info = {
        "device": "cuda",
        "gpu": torch.cuda.get_device_name(device),
        "vramTotalMb": str(total // 2**20),
        "vramUsedMb": str((total - free) // 2**20),
    }
    with contextlib.suppress(Exception):
        info["temperatureC"] = str(torch.cuda.temperature(device))
    return info
