#!/usr/bin/env python3
"""
Regenerate macOS app icon with circular mask + safe-area inset (smaller, rounder look per HIG).
Requires: Pillow (pip install Pillow). Run from repo root or icons/.
"""
from pathlib import Path
import subprocess

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Need Pillow: pip install Pillow")
    raise SystemExit(1)

ICONS_DIR = Path(__file__).resolve().parent
SRC = ICONS_DIR / "icon.png"
# Safe area: content at 90% scale, centered (macOS HIG style)
SCALE = 0.90


def main():
    # Try to load original icon from git (in case icon.png was already processed)
    result = subprocess.run(
        ['git', 'show', 'HEAD:novaic-app/src-tauri/icons/icon.png'],
        capture_output=True, cwd=ICONS_DIR.parent.parent.parent
    )
    if result.returncode == 0 and len(result.stdout) > 1000:
        from io import BytesIO
        img = Image.open(BytesIO(result.stdout)).convert("RGBA")
        print("Loaded original icon from git")
    elif SRC.exists():
        img = Image.open(SRC).convert("RGBA")
        print("Using current icon.png")
    else:
        print(f"Source icon not found: {SRC}")
        raise SystemExit(1)

    w, h = img.size
    if w != 1024 or h != 1024:
        print(f"Resizing source {w}x{h} to 1024x1024 first")
        img = img.resize((1024, 1024), Image.Resampling.LANCZOS)

    # Content at 90% centered
    size_safe = int(1024 * SCALE)  # 921
    pad = (1024 - size_safe) // 2
    small = img.resize((size_safe, size_safe), Image.Resampling.LANCZOS)

    # Apply squircle (rounded rectangle) mask - macOS standard ~22.4% corner radius
    corner_radius = int(size_safe * 0.2237)
    mask = Image.new("L", (size_safe, size_safe), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size_safe - 1, size_safe - 1], radius=corner_radius, fill=255)
    small.putalpha(mask)

    out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    out.paste(small, (pad, pad), small)
    safe_1024 = out

    iconset = ICONS_DIR / "NovAIC.iconset"
    iconset.mkdir(exist_ok=True)
    # (filename, size_px)
    sizes = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    for name, size in sizes:
        resized = safe_1024.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(iconset / name, "PNG")

    # Generate .icns (macOS only)
    import sys
    if sys.platform == "darwin":
        icns_out = ICONS_DIR / "icon.icns"
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns_out)], check=True)
        print(f"Written {icns_out}")
    else:
        print("Skip icon.icns (not macOS); iconset written for manual iconutil -c icns NovAIC.iconset")

    # Update PNGs used by Tauri bundle
    (iconset / "icon_32x32.png").replace(ICONS_DIR / "32x32.png")
    (iconset / "icon_128x128.png").replace(ICONS_DIR / "128x128.png")
    (iconset / "icon_128x128@2x.png").replace(ICONS_DIR / "128x128@2x.png")
    safe_1024.save(ICONS_DIR / "icon.png", "PNG")
    print("Updated 32x32.png, 128x128.png, 128x128@2x.png, icon.png")

    # Remove iconset (optional, keep for debug: comment next block)
    for f in iconset.iterdir():
        f.unlink()
    iconset.rmdir()
    print("Done. Rebuild app (tauri build) to see new Dock/Launchpad icon.")


if __name__ == "__main__":
    main()
