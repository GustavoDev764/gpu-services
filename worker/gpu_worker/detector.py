from dataclasses import dataclass
from typing import Sequence

import torch
from PIL import Image

from .gpu import autocast, gpu_lock, run_split

EDGE_PX = 4
NMS_IOU = 0.5
COVERED_RATIO = 0.6


@dataclass
class Box:
    label: str
    score: float
    x1: float
    y1: float
    x2: float
    y2: float
    cut: bool = False

    @property
    def area(self) -> float:
        return max(0.0, self.x2 - self.x1) * max(0.0, self.y2 - self.y1)

    def intersection(self, other: "Box") -> float:
        w = min(self.x2, other.x2) - max(self.x1, other.x1)
        h = min(self.y2, other.y2) - max(self.y1, other.y1)
        return max(0.0, w) * max(0.0, h)

    def iou(self, other: "Box") -> float:
        inter = self.intersection(other)
        union = self.area + other.area - inter
        return inter / union if union > 0 else 0.0

    def as_dict(self, width: int, height: int) -> dict:
        return {
            "label": self.label,
            "score": round(self.score, 3),
            "box": [
                int(max(0, round(self.x1))),
                int(max(0, round(self.y1))),
                int(min(width, round(self.x2))),
                int(min(height, round(self.y2))),
            ],
        }


def tile_ranges(height: int, width: int, aspect: float, overlap: float) -> list[tuple[int, int]]:
    tile_h = max(1, round(width * aspect))
    if height <= tile_h * 1.15:
        return [(0, height)]
    step = max(1, round(tile_h * (1 - overlap)))
    starts = list(range(0, height - tile_h, step))
    starts.append(height - tile_h)
    return [(y0, y0 + tile_h) for y0 in sorted(set(starts))]


def _nms(boxes: list[Box]) -> list[Box]:
    kept: list[Box] = []
    for box in sorted(boxes, key=lambda b: b.score, reverse=True):
        if all(box.label != k.label or box.iou(k) < NMS_IOU for k in kept):
            kept.append(box)
    return kept


def _join_pieces(pieces: list[Box]) -> list[Box]:
    merged = list(pieces)
    changed = True
    while changed:
        changed = False
        for i in range(len(merged)):
            for j in range(i + 1, len(merged)):
                a, b = merged[i], merged[j]
                if a.label != b.label or a.intersection(b) <= 0:
                    continue
                merged[i] = Box(a.label, max(a.score, b.score), min(a.x1, b.x1), min(a.y1, b.y1), max(a.x2, b.x2), max(a.y2, b.y2))
                del merged[j]
                changed = True
                break
            if changed:
                break
    return merged


def merge_tiles(boxes: list[Box]) -> list[Box]:
    whole = _nms([b for b in boxes if not b.cut])
    leftovers = [
        b
        for b in boxes
        if b.cut and not any(w.label == b.label and w.intersection(b) >= COVERED_RATIO * b.area for w in whole)
    ]
    return whole + _join_pieces(leftovers)


@dataclass
class Tile:
    page: int
    y0: int
    y1: int
    image: Image.Image


class Detector:
    def __init__(self, model_id: str, device: torch.device) -> None:
        from transformers import AutoImageProcessor, AutoModelForObjectDetection

        self.model_id = model_id
        self.device = device
        self.processor = AutoImageProcessor.from_pretrained(model_id)
        self.model = AutoModelForObjectDetection.from_pretrained(model_id).to(device).eval()
        self.labels: dict[int, str] = dict(self.model.config.id2label)

    def _forward(self, tiles: Sequence[Tile], threshold: float, fp16: bool) -> list[list[Box]]:
        images = [t.image for t in tiles]
        inputs = self.processor(images=images, return_tensors="pt").to(self.device)
        with gpu_lock, torch.inference_mode(), autocast(self.device, fp16):
            outputs = self.model(**inputs)
        results = self.processor.post_process_object_detection(
            outputs, threshold=threshold, target_sizes=[img.size[::-1] for img in images]
        )
        return [
            [
                Box(self.labels[int(label)], float(score), *(float(v) for v in box.float().tolist()))
                for score, label, box in zip(r["scores"], r["labels"], r["boxes"])
            ]
            for r in results
        ]

    def detect(
        self,
        pages: Sequence[Image.Image],
        threshold: float,
        tiles: bool,
        tile_aspect: float,
        tile_overlap: float,
        batch: int,
        fp16: bool,
    ) -> list[tuple[list[dict], int]]:
        work: list[Tile] = []
        counts: list[int] = []
        for index, image in enumerate(pages):
            width, height = image.size
            ranges = tile_ranges(height, width, tile_aspect, tile_overlap) if tiles else [(0, height)]
            counts.append(len(ranges))
            for y0, y1 in ranges:
                crop = image if len(ranges) == 1 else image.crop((0, y0, width, y1))
                work.append(Tile(index, y0, y1, crop))
        found: list[list[Box]] = []
        for start in range(0, len(work), batch):
            chunk = work[start : start + batch]
            found.extend(run_split(chunk, lambda part: self._forward(part, threshold, fp16)))
        per_page: list[list[Box]] = [[] for _ in pages]
        for tile, boxes in zip(work, found):
            height = pages[tile.page].size[1]
            for box in boxes:
                box.y1 += tile.y0
                box.y2 += tile.y0
                box.cut = (tile.y0 > 0 and box.y1 <= tile.y0 + EDGE_PX) or (tile.y1 < height and box.y2 >= tile.y1 - EDGE_PX)
                per_page[tile.page].append(box)
        out: list[tuple[list[dict], int]] = []
        for index, image in enumerate(pages):
            width, height = image.size
            merged = merge_tiles(per_page[index]) if counts[index] > 1 else per_page[index]
            merged.sort(key=lambda b: (round(b.y1), round(b.x1)))
            out.append(([b.as_dict(width, height) for b in merged], counts[index]))
        return out
