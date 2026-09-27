"""
Regenerate the PWA icons in assets/icons.

    python tools/generate-icons.py

Writes PNGs with nothing but the standard library (zlib + struct), so there
is no imaging dependency to install. Run it whenever the theme colours
change; the palette below is the single source of truth.

The design matches the app's own brand mark: a rounded square carrying the
accent-to-secondary gradient, with the map pin punched out in the same
near-black used for text on yellow.
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "icons"

# Straight from css/main.css
BG_TOP = (242, 183, 5)     # --accent            #f2b705
BG_BOTTOM = (21, 127, 74)  # --secondary         #157f4a
GLYPH = (26, 20, 7)        # --accent-contrast   #1a1407


def blend(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_alpha(x, y, size, radius):
    """Anti-aliased coverage of a rounded square."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    d = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, radius - d + 0.5))


def pin_alpha(x, y, size, scale=1.0, pad_y=0.0):
    """A map pin: a disc sitting on a tapering point."""
    u = (x - size / 2) / (size * scale)
    v = (y - size / 2) / (size * scale) - pad_y

    head_r, head_cy = 0.20, -0.10
    a_head = max(0.0, min(1.0, (head_r - math.hypot(u, v - head_cy)) * size * scale + 0.5))

    tip_y = 0.34
    a_tail = 0.0
    if head_cy <= v <= tip_y:
        t = (v - head_cy) / (tip_y - head_cy)
        half = head_r * (1 - t) * 0.98
        a_tail = max(0.0, min(1.0, (half - abs(u)) * size * scale + 0.5))

    return max(a_head, a_tail)


def hole_alpha(x, y, size, scale=1.0, pad_y=0.0):
    u = (x - size / 2) / (size * scale)
    v = (y - size / 2) / (size * scale) - pad_y
    d = math.hypot(u, v - (-0.10))
    return max(0.0, min(1.0, (0.083 - d) * size * scale + 0.5))


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag, data):
        body = struct.pack(">I", len(data)) + tag + data
        return body + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def make_icon(size, maskable=False):
    """Maskable icons need the glyph inside the safe zone and a full bleed."""
    corner = size * 0.5 if maskable else size * 0.22
    scale = 0.78 if maskable else 1.0
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Eased so yellow holds most of the square and the green
            # arrives late; a straight 50/50 ramp muddies through olive.
            t = ((x + y) / (2 * size)) ** 1.9
            bg = blend(BG_TOP, BG_BOTTOM, t)
            a_bg = rounded_alpha(x + 0.5, y + 0.5, size, corner)

            a_pin = pin_alpha(x + 0.5, y + 0.5, size, scale, -0.02)
            a_pin = max(0.0, a_pin - hole_alpha(x + 0.5, y + 0.5, size, scale, -0.02))

            r, g, b = blend(bg, GLYPH, a_pin)
            row += bytes((r, g, b, round(a_bg * 255)))
        rows.append(row)
    return rows


def make_badge(size):
    """Android tints the status-bar badge, so it must be white on transparency."""
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            a = pin_alpha(x + 0.5, y + 0.5, size, 0.92, -0.02)
            a = max(0.0, a - hole_alpha(x + 0.5, y + 0.5, size, 0.92, -0.02))
            row += bytes((255, 255, 255, round(a * 255)))
        rows.append(row)
    return rows


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name, maskable in [
        (192, "icon-192.png", False),
        (512, "icon-512.png", False),
        (512, "icon-maskable-512.png", True),
        (180, "apple-touch-icon.png", False),
    ]:
        write_png(OUT / name, size, make_icon(size, maskable))
        print("wrote", name)

    write_png(OUT / "badge.png", 96, make_badge(96))
    print("wrote badge.png")
    print("\nicon.svg is maintained by hand - keep its colours in step.")


if __name__ == "__main__":
    main()
