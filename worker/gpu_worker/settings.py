DEFAULTS: dict[str, float | int | bool] = {
    "detect_batch": 8,
    "detect_concurrency": 2,
    "detect_threshold": 0.4,
    "tile_aspect": 1.6,
    "tile_overlap": 0.25,
    "fp16_detect": True,
    "inpaint_batch": 16,
    "inpaint_batch_pixels": 16_000_000,
    "inpaint_concurrency": 2,
    "lama_context": 200,
    "fp16_lama": False,
}


def parse_settings(row: dict[str, str]) -> dict[str, float | int | bool]:
    out: dict[str, float | int | bool] = {}
    for name, default in DEFAULTS.items():
        raw = row.get(name)
        if raw is None:
            out[name] = default
        elif isinstance(default, bool):
            out[name] = raw in ("true", "1")
        elif isinstance(default, int):
            try:
                out[name] = int(float(raw))
            except ValueError:
                out[name] = default
        else:
            try:
                out[name] = float(raw)
            except ValueError:
                out[name] = default
    return out
