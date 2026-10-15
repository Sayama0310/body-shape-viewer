"""アプリアイコン（docs/icons/*.png）を作る。Pillow が必要。

    python tools/icons/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / "docs" / "icons"
S = 1024  # 下書きの解像度（縮小して滑らかにする）
BG_TOP = (64, 156, 255)
BG_BOTTOM = (10, 100, 220)
FG = (255, 255, 255)


def draw_icon(maskable=False):
    img = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(img)
    for y in range(S):  # 縦グラデーション
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))

    # maskable は中央 80% が安全領域なので小さめに描く
    k = 0.78 if maskable else 1.0
    cx = S / 2

    def box(x0, y0, x1, y1):
        return [cx + (x0 - cx) * k, S / 2 + (y0 - S / 2) * k, cx + (x1 - cx) * k, S / 2 + (y1 - S / 2) * k]

    def r(v):
        return v * k

    # 人の立ち姿（頭・胴・脚）
    d.ellipse(box(cx - 95, 150, cx + 95, 340), fill=FG)
    d.rounded_rectangle(box(cx - 170, 370, cx + 170, 640), radius=r(110), fill=FG)
    d.rounded_rectangle(box(cx - 150, 520, cx - 10, 880), radius=r(70), fill=FG)
    d.rounded_rectangle(box(cx + 10, 520, cx + 150, 880), radius=r(70), fill=FG)
    # 腕
    d.rounded_rectangle(box(cx - 250, 390, cx - 150, 700), radius=r(50), fill=FG)
    d.rounded_rectangle(box(cx + 150, 390, cx + 250, 700), radius=r(50), fill=FG)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    plain = draw_icon()
    for size, name in [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
        plain.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    draw_icon(maskable=True).resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png", optimize=True)


if __name__ == "__main__":
    main()
