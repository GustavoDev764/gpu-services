from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError

MAX_PIXELS = 200_000_000


class ImageError(ValueError):
    pass


def load_image(path: Path) -> Image.Image:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(path) as image:
            image.load()
            return image.convert("RGB")
    except Image.DecompressionBombError as err:
        raise ImageError(f"imagem grande demais (limite de {MAX_PIXELS:,} pixels)") from err
    except (UnidentifiedImageError, OSError) as err:
        raise ImageError("arquivo não é uma imagem válida") from err


def load_mask(path: Path, size: tuple[int, int]) -> np.ndarray:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(path) as image:
            image.load()
            if image.size != size:
                raise ImageError(f"a máscara tem {image.size[0]}x{image.size[1]}, mas a imagem tem {size[0]}x{size[1]}")
            if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
                alpha = np.asarray(image.convert("RGBA"))[:, :, 3]
                return np.where(alpha > 0, 255, 0).astype(np.uint8)
            gray = np.asarray(image.convert("L"))
            return np.where(gray > 127, 255, 0).astype(np.uint8)
    except (UnidentifiedImageError, OSError) as err:
        raise ImageError("máscara não é uma imagem válida") from err


def save_png(rgb: np.ndarray, path: Path) -> None:
    Image.fromarray(rgb).save(path, "PNG", compress_level=1)
