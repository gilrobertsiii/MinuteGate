#!/usr/bin/env python3
"""Generate og.png, favicon-32.png, and apple-touch-icon.png for the static site."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

INK = (30, 26, 36)
PAPER = (250, 247, 242)
CORAL = (208, 75, 10)

SITE = Path(__file__).resolve().parent.parent / "site"


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_og() -> None:
    w, h = 1200, 630
    img = Image.new("RGB", (w, h), INK)
    draw = ImageDraw.Draw(img)
    title_font = load_font(96, bold=True)
    sub_font = load_font(36, bold=False)
    accent_font = load_font(28, bold=False)
    draw.text((72, 220), "MinuteGate", fill=PAPER, font=title_font)
    paper_soft = (int(PAPER[0] * 0.85 + INK[0] * 0.15), int(PAPER[1] * 0.85 + INK[1] * 0.15), int(PAPER[2] * 0.85 + INK[2] * 0.15))
    draw.text((72, 340), "Open-source protocol for per-minute, gated access.", fill=paper_soft, font=sub_font)
    draw.text((72, 410), "Sandbox only; no real money moves.", fill=CORAL, font=accent_font)
    img.save(SITE / "og.png", "PNG", optimize=True)


def draw_apple_touch() -> None:
    size = 180
    img = Image.new("RGB", (size, size), PAPER)
    draw = ImageDraw.Draw(img)
    font = load_font(22, bold=True)
    text = "MinuteGate"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(((size - tw) / 2, (size - th) / 2 - 4), text, fill=CORAL, font=font)
    img.save(SITE / "apple-touch-icon.png", "PNG", optimize=True)


def draw_favicon_32() -> None:
    size = 32
    img = Image.new("RGB", (size, size), PAPER)
    draw = ImageDraw.Draw(img)
    font = load_font(18, bold=True)
    text = "M"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(((size - tw) / 2, (size - th) / 2 - 2), text, fill=CORAL, font=font)
    img.save(SITE / "favicon-32.png", "PNG", optimize=True)
  # also write as favicon.ico single size
    img.save(SITE / "favicon.ico", format="ICO", sizes=[(32, 32)])


def main() -> None:
    draw_og()
    draw_apple_touch()
    draw_favicon_32()
    print("wrote", SITE / "og.png", SITE / "apple-touch-icon.png", SITE / "favicon-32.png")


if __name__ == "__main__":
    main()