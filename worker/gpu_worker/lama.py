import os
from dataclasses import dataclass
from typing import Sequence

import cv2
import numpy as np
import torch

from .gpu import autocast, gpu_lock, is_oom, run_split

MODEL_URL = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt"

Window = tuple[int, int, int, int]


def model_path(configured: str) -> str:
    if configured:
        if not os.path.exists(configured):
            raise FileNotFoundError(f"modelo do LaMa não encontrado: {configured}")
        return configured
    folder = os.path.join(torch.hub.get_dir(), "checkpoints")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, os.path.basename(MODEL_URL))
    if not os.path.exists(path):
        torch.hub.download_url_to_file(MODEL_URL, path, progress=False)
    return path


def _overlaps(a: Window, b: Window) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def mask_windows(mask: np.ndarray, context: int) -> list[Window]:
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    h, w = mask.shape
    windows: list[Window] = []
    for label in range(1, count):
        x, y, bw, bh = (int(v) for v in stats[label][:4])
        windows.append((max(0, x - context), max(0, y - context), min(w, x + bw + context), min(h, y + bh + context)))
    merged = True
    while merged:
        merged = False
        for i in range(len(windows)):
            for j in range(i + 1, len(windows)):
                if _overlaps(windows[i], windows[j]):
                    a, b = windows[i], windows[j]
                    windows[i] = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                    del windows[j]
                    merged = True
                    break
            if merged:
                break
    return windows


@dataclass
class Patch:
    image: int
    window: Window
    rgb: np.ndarray
    mask: np.ndarray

    @property
    def size(self) -> tuple[int, int]:
        return self.rgb.shape[0], self.rgb.shape[1]


def _round8(v: int) -> int:
    return v + (-v) % 8


def group_patches(patches: list[Patch], max_count: int, max_pixels: int) -> list[list[Patch]]:
    ordered = sorted(patches, key=lambda p: (_round8(p.size[0]), _round8(p.size[1])))
    groups: list[list[Patch]] = []
    current: list[Patch] = []
    for patch in ordered:
        candidate = current + [patch]
        h = max(_round8(p.size[0]) for p in candidate)
        w = max(_round8(p.size[1]) for p in candidate)
        waste = h * w * len(candidate) > 1.35 * sum(_round8(p.size[0]) * _round8(p.size[1]) for p in candidate)
        if current and (len(candidate) > max_count or h * w * len(candidate) > max_pixels or waste):
            groups.append(current)
            current = [patch]
        else:
            current = candidate
    if current:
        groups.append(current)
    return groups


def _pad(array: np.ndarray, h: int, w: int) -> np.ndarray:
    pad = ((0, h - array.shape[0]), (0, w - array.shape[1])) + (((0, 0),) if array.ndim == 3 else ())
    return np.pad(array, pad, mode="symmetric")


class Lama:
    def __init__(self, configured_path: str, device: torch.device) -> None:
        self.path = model_path(configured_path)
        self.device = device
        self.model = torch.jit.load(self.path, map_location=device).eval()
        self.fp16_broken = False

    def _forward(self, patches: Sequence[Patch], fp16: bool) -> list[np.ndarray]:
        h = max(_round8(p.size[0]) for p in patches)
        w = max(_round8(p.size[1]) for p in patches)
        rgb = np.stack([_pad(p.rgb, h, w) for p in patches]).transpose(0, 3, 1, 2)
        mask = np.stack([_pad(p.mask, h, w) for p in patches])[:, None]
        image_t = torch.from_numpy(rgb).to(self.device, non_blocking=True).float().div_(255)
        mask_t = (torch.from_numpy(mask).to(self.device, non_blocking=True) > 0).float()
        with gpu_lock, torch.inference_mode():
            try:
                with autocast(self.device, fp16 and not self.fp16_broken):
                    out = self.model(image_t, mask_t)
            except RuntimeError as err:
                if not fp16 or self.fp16_broken or is_oom(err):
                    raise
                self.fp16_broken = True
                out = self.model(image_t, mask_t)
            out = out.float().clamp_(0, 1).mul_(255).round_().to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
        return [out[i, : p.size[0], : p.size[1]] for i, p in enumerate(patches)]

    def inpaint(
        self,
        images: Sequence[np.ndarray],
        masks: Sequence[np.ndarray],
        context: int,
        max_count: int,
        max_pixels: int,
        fp16: bool,
    ) -> list[tuple[np.ndarray, int]]:
        patches: list[Patch] = []
        counts = [0] * len(images)
        for index, (rgb, mask) in enumerate(zip(images, masks)):
            for x1, y1, x2, y2 in mask_windows(mask, context):
                patches.append(Patch(index, (x1, y1, x2, y2), rgb[y1:y2, x1:x2], mask[y1:y2, x1:x2]))
                counts[index] += 1
        results = [rgb.copy() for rgb in images]
        for group in group_patches(patches, max_count, max_pixels):
            filled = run_split(group, lambda part: self._forward(part, fp16))
            for patch, out in zip(group, filled):
                x1, y1, x2, y2 = patch.window
                region = results[patch.image][y1:y2, x1:x2]
                region[patch.mask > 0] = out[patch.mask > 0]
        return [(results[i], counts[i]) for i in range(len(images))]
