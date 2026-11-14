#!/usr/bin/env python3
"""Capture 390px and 1280px screenshots of new site pages."""
from pathlib import Path

from playwright.sync_api import sync_playwright

ARTIFACTS = Path("/opt/cursor/artifacts")
SITE = Path(__file__).resolve().parent.parent / "site"

PAGES = [
    ("docs", "docs/index.html"),
    ("protocol", "protocol/index.html"),
    ("about", "about/index.html"),
    ("apps", "apps/index.html"),
]

WIDTHS = [390, 1280]


def main() -> None:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        base = "http://127.0.0.1:8765"
        for name, rel in PAGES:
            folder = rel.split("/")[0]
            url = f"{base}/{folder}/"
            for w in WIDTHS:
                page = browser.new_page(viewport={"width": w, "height": 900})
                page.goto(url, wait_until="networkidle")
                overflow = page.evaluate(
                    "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
                )
                if overflow:
                    raise SystemExit(f"horizontal overflow on {name} at {w}px")
                out = ARTIFACTS / f"site-{name}-{w}.png"
                page.screenshot(path=str(out), full_page=True)
                page.close()
                print("wrote", out)
        browser.close()


if __name__ == "__main__":
    main()