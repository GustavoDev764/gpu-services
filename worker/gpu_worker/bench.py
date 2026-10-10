import argparse
import random
import time
from pathlib import Path

import numpy as np
import torch

from .config import load_config
from .detector import Detector
from .gpu import pick_device
from .images import load_image
from .lama import Lama, Patch, group_patches


def sync(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize(device)


def peak_mb(device: torch.device) -> str:
    if device.type != "cuda":
        return "-"
    value = torch.cuda.max_memory_allocated(device) // 2**20
    torch.cuda.reset_peak_memory_stats(device)
    return f"{value} MB"


def make_windows(pages: list[np.ndarray], count: int, seed: int = 7) -> list[tuple[np.ndarray, np.ndarray]]:
    rng = random.Random(seed)
    out = []
    while len(out) < count:
        page = pages[rng.randrange(len(pages))]
        h, w = page.shape[:2]
        wh = rng.randint(min(300, h), min(720, h))
        ww = rng.randint(min(300, w), min(720, w))
        y = rng.randint(0, h - wh)
        x = rng.randint(0, w - ww)
        rgb = np.ascontiguousarray(page[y : y + wh, x : x + ww])
        mask = np.zeros((wh, ww), np.uint8)
        mh, mw = wh // 3, ww // 2
        my, mx = (wh - mh) // 2, (ww - mw) // 2
        mask[my : my + mh, mx : mx + mw] = 255
        out.append((rgb, mask))
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pages", type=Path)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--windows", type=int, default=96)
    parser.add_argument("--detect-batches", default="1,4,8,16,32")
    parser.add_argument("--lama-batches", default="1,4,8,16,32")
    args = parser.parse_args()
    cfg = load_config()
    device = pick_device(cfg.device)
    if cfg.torch_threads > 0:
        torch.set_num_threads(cfg.torch_threads)
    files = sorted(p for p in args.pages.iterdir() if p.suffix.lower() in (".webp", ".png", ".jpg", ".jpeg"))[: args.limit]
    print(f"device {device} {torch.cuda.get_device_name(device) if device.type == 'cuda' else ''} · torch {torch.__version__} · {len(files)} páginas")

    started = time.perf_counter()
    images = [load_image(f) for f in files]
    decode_s = time.perf_counter() - started
    print(f"decodificar: {decode_s / len(files) * 1000:.0f} ms/página na CPU ({len(files) / decode_s:.1f} páginas/s por núcleo)")

    detector = Detector(cfg.detector_model, device)
    fp16_modes = [False, True] if device.type == "cuda" else [False]
    detector.detect(images[:2], 0.4, True, 1.6, 0.25, 2, False)
    reference = None
    print("\nDETECTOR (com blocos)")
    print(f"{'lote':>5} {'fp16':>5} {'páginas/s':>10} {'blocos/s':>9} {'pico VRAM':>10} {'caixas':>7}")
    for fp16 in fp16_modes:
        for batch in [int(b) for b in args.detect_batches.split(",")]:
            sync(device)
            peak_mb(device)
            started = time.perf_counter()
            found = detector.detect(images, 0.4, True, 1.6, 0.25, batch, fp16)
            sync(device)
            elapsed = time.perf_counter() - started
            tiles = sum(t for _, t in found)
            boxes = sum(len(d) for d, _ in found)
            if reference is None:
                reference = boxes
            print(f"{batch:>5} {str(fp16):>5} {len(images) / elapsed:>10.2f} {tiles / elapsed:>9.2f} {peak_mb(device):>10} {boxes:>7}")

    lama = Lama(cfg.lama_model, device)
    windows = make_windows([np.asarray(i) for i in images], args.windows)
    lama.inpaint([windows[0][0]], [windows[0][1]], 0, 1, 10**9, False)
    print(f"\nLAMA ({len(windows)} janelas de 300 a 720 px)")
    print(f"{'lote':>5} {'fp16':>5} {'janelas/s':>10} {'pico VRAM':>10} {'dif. média':>10}")
    base = None
    for fp16 in fp16_modes:
        for batch in [int(b) for b in args.lama_batches.split(",")]:
            patches = [Patch(i, (0, 0, w[0].shape[1], w[0].shape[0]), w[0], w[1]) for i, w in enumerate(windows)]
            groups = group_patches(patches, batch, 400_000_000)
            sync(device)
            peak_mb(device)
            started = time.perf_counter()
            outputs: dict[int, np.ndarray] = {}
            try:
                for group in groups:
                    for patch, out in zip(group, lama._forward(group, fp16)):
                        outputs[patch.image] = out
            except Exception as err:
                print(f"{batch:>5} {str(fp16):>5} {'falhou':>10} {'':>10} {str(err)[:60]}")
                continue
            sync(device)
            elapsed = time.perf_counter() - started
            stack = np.concatenate([outputs[i].reshape(-1) for i in range(len(windows))]).astype(np.int16)
            if base is None:
                base = stack
            diff = float(np.abs(stack - base).mean())
            print(f"{batch:>5} {str(fp16):>5} {len(windows) / elapsed:>10.2f} {peak_mb(device):>10} {diff:>10.2f}")


if __name__ == "__main__":
    main()
