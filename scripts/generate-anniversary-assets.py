"""Genera los assets de la encuesta de aniversario a partir del logo BM.

Uso (Python 3 con Pillow y numpy; en Windows usa las fuentes del sistema):

    python scripts/generate-anniversary-assets.py [logo-completo.png] [logo-icono.png]

Por defecto toma brand/bm-logo-completo.png (bolsas + "BASE MAYORISTA") y
brand/bm-logo-icono.png (solo bolsas con "BM"), ambos sobre fondo blanco.
Escribe en public/aniversario/:
  - bm-logo.webp / bm-logo.png     logo completo, fondo transparente (bienvenida y confirmación)
  - bm-icono.webp / bm-icono.png   ícono, fondo transparente (encabezado y arranque)
  - icon-32.png / icon-180.png     favicon e ícono de inicio de iOS de la página
  - og-aniversario.jpg             vista previa de WhatsApp (1200 x 630)

Para sustituir el logo basta con reemplazar los PNG de brand/ (fondo blanco,
idealmente 1024 px o más) y volver a ejecutar el script.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FULL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "brand", "bm-logo-completo.png")
ICON = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "brand", "bm-logo-icono.png")
OUT = os.path.join(ROOT, "public", "aniversario")
FONTS = os.environ.get("FONT_DIR", "C:/Windows/Fonts")

INK = (29, 29, 31)
MUTED = (85, 85, 92)
AMBER = (255, 177, 29)
ORANGE = (255, 134, 21)
ORANGE_DEEP = (235, 80, 11)
MAGENTA = (226, 19, 99)
MAGENTA_DEEP = (213, 14, 95)
SURFACE = (255, 250, 245)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def crop_to_content(image, pad=0.03):
    rgb = image.convert("RGB")
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, (255, 255, 255))).convert("L")
    box = diff.point(lambda v: 255 if v > 12 else 0).getbbox()
    margin = int(max(box[2] - box[0], box[3] - box[1]) * pad)
    return image.crop((max(0, box[0] - margin), max(0, box[1] - margin), min(image.width, box[2] + margin), min(image.height, box[3] + margin)))


def white_to_alpha(image):
    """'Color a alfa' sobre blanco: conserva bordes suaves sin halo."""
    rgb = np.asarray(image.convert("RGB")).astype(np.float32) / 255.0
    alpha = np.max(1.0 - rgb, axis=2)
    safe = np.where(alpha > 0, alpha, 1.0)[..., None]
    color = (rgb - (1.0 - alpha[..., None])) / safe
    out = np.dstack([np.clip(color, 0, 1), alpha]) * 255.0
    return Image.fromarray(out.round().astype(np.uint8), "RGBA")


def save_pair(image, name, width=None, height=None):
    if width:
        image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
    elif height:
        image = image.resize((round(image.width * height / image.height), height), Image.LANCZOS)
    image.save(os.path.join(OUT, f"{name}.png"), optimize=True)
    image.save(os.path.join(OUT, f"{name}.webp"), quality=86, method=6)
    return image


def square_icon(icon, size):
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    inner = int(size * 0.84)
    fitted = icon.copy()
    fitted.thumbnail((inner, inner), Image.LANCZOS)
    canvas.paste(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2), fitted)
    return canvas


def horizontal_gradient(size, stops):
    width, height = size
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for x in range(width):
        t = x / max(1, width - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                k = (t - p0) / max(1e-6, p1 - p0)
                color = tuple(round(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                break
        draw.line([(x, 0), (x, height)], fill=color)
    return image


def glow(canvas, center, radius, color, alpha):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(
        [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius], fill=color + (alpha,)
    )
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius * 0.5)))


def gift_icon(draw, x, y, size, color, width):
    s = size / 24
    p = lambda px, py: (x + px * s, y + py * s)
    draw.rounded_rectangle([p(4, 11.5), p(20, 21)], radius=1 * s, outline=color, width=width)
    draw.rectangle([p(3, 7.5), p(21, 11.5)], outline=color, width=width)
    draw.line([p(12, 7.5), p(12, 21)], fill=color, width=width)
    draw.arc([p(6.4, 4.2), p(12.4, 9.0)], 160, 360, fill=color, width=width)
    draw.arc([p(11.6, 4.2), p(17.6, 9.0)], 180, 20, fill=color, width=width)


def build_og(full_logo):
    width, height = 1200, 630
    canvas = Image.new("RGBA", (width, height), SURFACE + (255,))
    glow(canvas, (1150, 40), 300, AMBER, 70)
    glow(canvas, (1000, 640), 280, MAGENTA, 45)
    glow(canvas, (60, 620), 220, ORANGE, 40)

    logo = full_logo.copy()
    logo.thumbnail((380, 380), Image.LANCZOS)
    canvas.alpha_composite(logo, (64, (height - logo.height) // 2))

    draw = ImageDraw.Draw(canvas)
    x = 500
    eyebrow = font("seguibl.ttf", 26)
    draw.text((x, 112), "PRIMER ANIVERSARIO", font=eyebrow, fill=MAGENTA_DEEP)
    bar = horizontal_gradient((90, 5), [(0, AMBER), (0.5, ORANGE_DEEP), (1, MAGENTA)])
    canvas.paste(bar, (x + int(draw.textlength("PRIMER ANIVERSARIO", font=eyebrow)) + 18, 130))

    title_font = font("seguibl.ttf", 60)
    y = 162
    for line in ["¡Cumplimos un año y", "el regalo es para ti!"]:
        draw.text((x, y), line, font=title_font, fill=INK)
        y += 74

    draw.text((x, y + 16), "Encuesta de aniversario · 6 preguntas · 2 min", font=font("segoeui.ttf", 30), fill=MUTED)

    pill_y = y + 84
    pill_font = font("segoeuib.ttf", 30)
    pill_text = "Responde y registra tu regalo"
    pill_w = int(draw.textlength(pill_text, font=pill_font) + 120)
    pill = horizontal_gradient((pill_w, 70), [(0, ORANGE_DEEP), (1, MAGENTA_DEEP)]).convert("RGBA")
    mask = Image.new("L", pill.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, pill_w - 1, 69], radius=35, fill=255)
    canvas.paste(pill, (x, pill_y), mask)
    draw = ImageDraw.Draw(canvas)
    gift_icon(draw, x + 26, pill_y + 17, 36, (255, 255, 255), 3)
    draw.text((x + 78, pill_y + 13), pill_text, font=pill_font, fill=(255, 255, 255))

    canvas.convert("RGB").save(os.path.join(OUT, "og-aniversario.jpg"), quality=86, optimize=True, progressive=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    full = white_to_alpha(crop_to_content(Image.open(FULL)))
    icon = white_to_alpha(crop_to_content(Image.open(ICON)))
    save_pair(full, "bm-logo", width=360)
    save_pair(icon, "bm-icono", height=120)
    square_icon(icon, 32).save(os.path.join(OUT, "icon-32.png"), optimize=True)
    square_icon(icon, 180).save(os.path.join(OUT, "icon-180.png"), optimize=True)
    build_og(full)
    for name in sorted(os.listdir(OUT)):
        print(f"{name}: {os.path.getsize(os.path.join(OUT, name))} bytes")


if __name__ == "__main__":
    main()
