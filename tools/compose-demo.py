#!/usr/bin/env python3
"""compose-demo.py — turn the paired window screenshots from tools/record-demo.mjs into the looping
README hero GIF.

Each frame is a composite: a caption band, then the two windows side by side, each under its own
label. The captions are drawn HERE, on the composite, so the product's own pixels are never edited —
what you see inside each pane is exactly what the browser rendered. The window that Playwright put
offline gets an amber rule and an OFFLINE label, because a dropped network is otherwise invisible.

Frames are quantised against one shared palette so the GIF encoder can store only what changed
between frames, identical consecutive frames are collapsed into a single longer frame, and the
result is downscaled to ~1000px — the width GitHub renders a README image at.

Usage: python tools/compose-demo.py <manifest.json>
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Layout, in capture pixels (the screenshots are 2x device pixels).
PAD, GAP = 28, 30
BAND, LABEL = 150, 52
OUT_WIDTH = 1000
FPS_MS = 125  # one "hold" unit of playback time

BG = (6, 9, 11)
FG = (232, 236, 239)
DIM = (140, 158, 166)
CYAN = (56, 195, 214)
AMBER = (216, 190, 126)
EDGE = (30, 42, 48)

FONTS = Path("C:/Windows/Fonts")


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for candidate in (FONTS / name, Path("/usr/share/fonts/truetype/dejavu") / name):
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size)


F_TITLE = font("seguisb.ttf", 46)
F_SUB = font("segoeui.ttf", 29)
F_LABEL = font("seguisb.ttf", 26)


def compose(spec: dict, pane_w: int, pane_h: int) -> Image.Image:
    width = PAD * 2 + pane_w * 2 + GAP
    height = BAND + LABEL + pane_h + PAD
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)

    draw.text((PAD + 2, 34), spec["caption"], font=F_TITLE, fill=FG)
    if spec["sub"]:
        draw.text((PAD + 2, 96), spec["sub"], font=F_SUB, fill=DIM)

    for side, index in (("a", 0), ("b", 1)):
        x = PAD + index * (pane_w + GAP)
        off = spec.get("offline") == side
        name = "Ana · window 1" if side == "a" else "Ben · window 2"
        draw.text((x + 4, BAND + 8), name, font=F_LABEL, fill=AMBER if off else DIM)
        if off:
            tag = "OFFLINE — no network"
            draw.text((x + pane_w - draw.textlength(tag, font=F_LABEL) - 4, BAND + 8), tag, font=F_LABEL, fill=AMBER)
        y = BAND + LABEL
        canvas.paste(Image.open(spec[side]).convert("RGB"), (x, y))
        draw.rectangle([x - 1, y - 1, x + pane_w, y + pane_h], outline=AMBER if off else EDGE, width=3)

    return canvas


def main() -> None:
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    specs = manifest["frames"]
    out = Path(manifest["out"])

    probe = Image.open(specs[0]["a"])
    pane_w, pane_h = probe.size
    scale = OUT_WIDTH / (PAD * 2 + pane_w * 2 + GAP)

    frames: list[Image.Image] = []
    durations: list[int] = []
    previous: bytes | None = None
    for spec in specs:
        image = compose(spec, pane_w, pane_h)
        image = image.resize((OUT_WIDTH, round(image.height * scale)), Image.LANCZOS)
        ms = FPS_MS * int(spec.get("hold", 1))
        digest = image.tobytes()
        if digest == previous:
            durations[-1] += ms  # identical to the last frame — hold it rather than store it twice
            continue
        previous = digest
        frames.append(image)
        durations.append(ms)

    # One shared palette across the whole reel: the encoder can then store inter-frame deltas.
    sample = frames[:: max(1, len(frames) // 24)]
    strip = Image.new("RGB", (frames[0].width, frames[0].height * len(sample)))
    for i, f in enumerate(sample):
        strip.paste(f, (0, i * frames[0].height))
    palette = strip.quantize(colors=128, method=Image.MEDIANCUT)

    quantised = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]

    out.parent.mkdir(parents=True, exist_ok=True)
    quantised[0].save(
        out,
        save_all=True,
        append_images=quantised[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )
    total = sum(durations) / 1000
    print(f"  {len(quantised)} frames · {frames[0].width}x{frames[0].height} · {total:.1f}s · {out.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
