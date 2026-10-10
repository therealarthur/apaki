# Apaki icon sources

The Myrlin M from Myrlin Jobs (live mark at https://jobs.myrlin.io/icon.svg), Apaki edition, 2026-10-09.
Jobs has an orange flare on the last foot; Apaki's flare runs teal to blue, the cyan
(hsl 189 94% 43%, #07B6D5) and blue (hsl 217 91% 60%, #3C83F6) stops of the Fly x Myrlin
pearl that Apaki's ground uses. Strokes are ink, folds periwinkle.

- `apaki-icon.svg`: the app icon, a Glass-family dark tile with the M at 0.86 scale (32 px grid).
- `apaki-icon-small.svg`: the same at 0.96 scale for the 16 to 24 px icon frames.
- `apaki-icon-1024.png`: the rendered master.
- `apaki-mark-inline.svg`: the bare M for inline use (ui/mark.js); CSS colours it per theme.

Rebuild `../icon.ico` (16 to 256 px) and `../icon.png` (512 px): render the SVGs at 1024 px with
headless Edge (`msedge --headless=new --default-background-color=00000000 --window-size=1024,1024
--screenshot=out.png file:///.../apaki-icon.svg`), then downscale with Pillow (small variant for
16, 20 and 24 px). After changing icon.ico, touch apaki/build.rs, or the exe keeps the old icon.
