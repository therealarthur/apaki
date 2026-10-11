"""
make-assets.py: the Apaki app's icons and launch screens (apaki/mobile, 2026-10-10).

From apaki/icons/source (the Myrlin M, Apaki edition): apaki-icon.svg for the
mark's paths and colours, apaki-icon-1024.png for the rendered master tile.

  iOS      AppIcon (1024 px, full bleed, no alpha: iOS rounds the corners itself)
           Splash (2732 px, light and dark): the tile in the middle of Apaki's ground
  Android  legacy and round launcher icons, adaptive foreground (the M alone,
           inside the safe zone) over a gradient background drawable, splash images

The M is drawn from the SVG's own paths (cubic curves flattened, 4x
supersampled), so it is crisp at every size; the script checks its drawing
against the 1024 master before writing anything. Needs Pillow.

  python apaki/mobile/scripts/make-assets.py
"""

import os
import re
import sys

from PIL import Image, ImageChops, ImageDraw, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE = os.path.dirname(HERE)
APAKI = os.path.dirname(MOBILE)
SOURCE = os.path.join(APAKI, "icons", "source")
IOS_ASSETS = os.path.join(MOBILE, "ios", "App", "App", "Assets.xcassets")
ANDROID_RES = os.path.join(MOBILE, "android", "app", "src", "main", "res")

TILE_TOP = (0x26, 0x22, 0x3F)
TILE_BOTTOM = (0x14, 0x12, 0x1F)
GROUND_LIGHT = (0xFD, 0xFD, 0xFF)
GROUND_DARK = (0x12, 0x11, 0x20)
SS = 4  # supersampling


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def read_mark():
    """The M's paths from apaki-icon.svg: [(points per subpath, fill)], plus the group transform."""
    svg = open(os.path.join(SOURCE, "apaki-icon.svg"), encoding="utf-8").read()
    m = re.search(r'<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)">(.*?)</g>', svg, re.S)
    tx, ty, sc, body = float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)
    flare = re.search(r'<linearGradient id="flare".*?<stop offset="0" stop-color="(#\w+)"/><stop offset="1" stop-color="(#\w+)"/>', svg, re.S)
    paths = []
    for d, fill in re.findall(r'<path d="([^"]+)" fill="([^"]+)"/>', body):
        paths.append((flatten(d), fill))
    return (tx, ty, sc), paths, (hex_rgb(flare.group(1)), hex_rgb(flare.group(2)))


def flatten(d, steps=28):
    """M, L, C and Z (absolute) into polygons."""
    toks = re.findall(r"[MLCZ]|-?\d*\.?\d+", d)
    polys, cur, i, cmd, pos = [], [], 0, None, (0.0, 0.0)
    while i < len(toks):
        t = toks[i]
        if t in "MLCZ":
            cmd = t
            i += 1
            if cmd == "Z":
                if cur:
                    polys.append(cur)
                cur = []
            continue
        if cmd == "M":
            pos = (float(toks[i]), float(toks[i + 1]))
            cur = [pos]
            i += 2
            cmd = "L"
        elif cmd == "L":
            pos = (float(toks[i]), float(toks[i + 1]))
            cur.append(pos)
            i += 2
        elif cmd == "C":
            x1, y1, x2, y2, x, y = (float(v) for v in toks[i:i + 6])
            x0, y0 = pos
            for k in range(1, steps + 1):
                u = k / steps
                a, b, c, e = (1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3
                cur.append((a * x0 + b * x1 + c * x2 + e * x, a * y0 + b * y1 + c * y2 + e * y))
            pos = (x, y)
            i += 6
    if cur:
        polys.append(cur)
    return polys


def draw_mark(size, unit, origin, mark):
    """The M on transparent: `unit` px per SVG unit, the SVG's (0, 0) at `origin`."""
    (tx, ty, sc), paths, (f0, f1) = mark
    big = size * SS
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    to_px = lambda p: ((origin[0] + (tx + p[0] * sc) * unit) * SS, (origin[1] + (ty + p[1] * sc) * unit) * SS)
    for polys, fill in paths:
        mask = Image.new("L", (big, big), 0)
        md = ImageDraw.Draw(mask)
        pts_all = []
        for poly in polys:
            pts = [to_px(p) for p in poly]
            pts_all += pts
            md.polygon(pts, fill=255)
        if fill.startswith("url("):
            xs, ys = [p[0] for p in pts_all], [p[1] for p in pts_all]
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            grad = Image.new("RGBA", (big, big))
            gp = grad.load()
            for y in range(int(y0), min(big, int(y1) + 2)):
                for x in range(int(x0), min(big, int(x1) + 2)):
                    # objectBoundingBox gradient from (0, 1) to (1, 0)
                    u = (x - x0) / max(1, x1 - x0)
                    v = (y - y0) / max(1, y1 - y0)
                    t = max(0.0, min(1.0, (u + 1 - v) / 2))
                    gp[x, y] = tuple(round(f0[k] + (f1[k] - f0[k]) * t) for k in range(3)) + (255,)
            out.paste(grad, (0, 0), mask)
        else:
            out.paste(Image.new("RGBA", (big, big), hex_rgb(fill) + (255,)), (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def vertical(size, top, bottom):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(top[k] + (bottom[k] - top[k]) * t) for k in range(3)))
    return img


def full_bleed_icon(size, mark):
    """The tile's gradient to the edges and the M where the master has it (no border, no alpha)."""
    img = vertical(size, TILE_TOP, TILE_BOTTOM).convert("RGBA")
    img.alpha_composite(draw_mark(size, size / 32, (0, 0), mark))
    return img.convert("RGB")


def check_against_master(mark):
    """The drawn M over the tile must match the 1024 master inside the tile (mean difference per channel)."""
    master = Image.open(os.path.join(SOURCE, "apaki-icon-1024.png")).convert("RGBA")
    mine = full_bleed_icon(1024, mark).convert("RGBA")
    box = (64, 64, 960, 960)
    diff = ImageChops.difference(master.crop(box).convert("RGB"), mine.crop(box).convert("RGB"))
    mean = sum(ImageStat.Stat(diff).mean) / 3
    print(f"drawn M vs master: mean difference {mean:.2f} / 255")
    if mean > 3.0:
        sys.exit("make-assets: the drawn M does not match apaki-icon-1024.png; not writing anything")


def tile_on(size, ground, tile_px):
    """The master tile (rounded, with its own edge) in the middle of a ground."""
    master = Image.open(os.path.join(SOURCE, "apaki-icon-1024.png")).convert("RGBA").resize((tile_px, tile_px), Image.LANCZOS)
    img = Image.new("RGBA", (size[0], size[1]), ground + (255,))
    img.alpha_composite(master, ((size[0] - tile_px) // 2, (size[1] - tile_px) // 2))
    return img.convert("RGB")


def save(img, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    print("wrote", os.path.relpath(path, MOBILE), img.size)


def main():
    mark = read_mark()
    check_against_master(mark)

    # iOS: one 1024 icon (Xcode makes the rest), the splash in light and dark.
    save(full_bleed_icon(1024, mark), IOS_ASSETS, "AppIcon.appiconset", "AppIcon-512@2x.png")
    splash = os.path.join(IOS_ASSETS, "Splash.imageset")
    for f in os.listdir(splash):
        if f.endswith(".png"):
            os.remove(os.path.join(splash, f))
    save(tile_on((2732, 2732), GROUND_LIGHT, 400), splash, "splash-2732x2732.png")
    save(tile_on((2732, 2732), GROUND_DARK, 400), splash, "splash-2732x2732-dark.png")
    with open(os.path.join(splash, "Contents.json"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("""{
  "images" : [
    {
      "filename" : "splash-2732x2732.png",
      "idiom" : "universal"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "splash-2732x2732-dark.png",
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
""")

    # Android: launcher icons per density, the adaptive foreground (M only, in the 66 of 108 dp safe zone), splash.
    for name, px in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        icon = full_bleed_icon(px * 4, mark).resize((px, px), Image.LANCZOS)
        rounded = Image.new("L", (px * 4, px * 4), 0)
        ImageDraw.Draw(rounded).rounded_rectangle([0, 0, px * 4 - 1, px * 4 - 1], radius=px * 4 * 7 // 32, fill=255)
        legacy = icon.convert("RGBA")
        legacy.putalpha(rounded.resize((px, px), Image.LANCZOS))
        save(legacy, ANDROID_RES, f"mipmap-{name}", "ic_launcher.png")
        circle = Image.new("L", (px * 4, px * 4), 0)
        ImageDraw.Draw(circle).ellipse([0, 0, px * 4 - 1, px * 4 - 1], fill=255)
        round_icon = icon.convert("RGBA")
        round_icon.putalpha(circle.resize((px, px), Image.LANCZOS))
        save(round_icon, ANDROID_RES, f"mipmap-{name}", "ic_launcher_round.png")
        fg = px * 108 // 48
        # The M spans about 26.6 of the tile's 32 units and is centred in it; drawing the tile at 68 of the
        # layer's 108 dp keeps the M's corners inside the 66 dp safe circle (about 31 dp from the centre).
        unit = fg * (68 / 108) / 32
        save(draw_mark(fg, unit, ((fg - 32 * unit) / 2, (fg - 32 * unit) / 2), mark), ANDROID_RES, f"mipmap-{name}", "ic_launcher_foreground.png")
    for folder in os.listdir(ANDROID_RES):
        path = os.path.join(ANDROID_RES, folder, "splash.png")
        if folder.startswith("drawable") and os.path.exists(path):
            w, h = Image.open(path).size
            save(tile_on((w, h), GROUND_LIGHT, max(96, min(w, h) // 4)), path)


if __name__ == "__main__":
    main()
