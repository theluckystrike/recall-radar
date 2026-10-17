"""Render the title, problem, architecture and end cards (1920x1080 PNG).

Drawn at 2x and downsampled for clean edges. Palette and font from the brief.
"""
import math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "work", "cards")
os.makedirs(OUT, exist_ok=True)
FONT = "/System/Library/Fonts/HelveticaNeue.ttc"
FACE = {"regular": 0, "bold": 1, "ultralight": 5, "light": 7, "medium": 10, "thin": 12}

BG = (11, 16, 32)
INK = (232, 237, 247)
MUTED = (138, 150, 176)
ACCENT = (79, 179, 255)
S = 2  # supersample
W, H = 1920 * S, 1080 * S


def font(face, px):
    return ImageFont.truetype(FONT, int(px * S), index=FACE[face])


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def base(glow=(0.5, 0.42), glow_strength=0.10, rings=None):
    """Background with a soft accent glow and optional faint radar rings."""
    img = Image.new("RGB", (W, H), BG)
    g = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(g)
    cx, cy = int(W * glow[0]), int(H * glow[1])
    r = int(H * 0.55)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    g = g.filter(ImageFilter.GaussianBlur(r * 0.45))
    tint = Image.new("RGB", (W, H), mix(BG, ACCENT, glow_strength))
    img = Image.composite(tint, img, g)
    if rings:
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        rx, ry, radii, alpha = rings
        for i, rr in enumerate(radii):
            a = int(alpha * (1 - i / (len(radii) + 1)))
            od.ellipse([rx - rr * S, ry - rr * S, rx + rr * S, ry + rr * S], outline=ACCENT + (a,), width=2 * S)
        img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    return img


def text_w(d, s, f, spacing=0):
    if spacing:
        return sum(d.textlength(ch, font=f) for ch in s) + spacing * S * (len(s) - 1)
    return d.textlength(s, font=f)


def draw_text(d, xy, s, f, fill, anchor="la", spacing=0):
    if not spacing:
        d.text(xy, s, font=f, fill=fill, anchor=anchor)
        return
    total = text_w(d, s, f, spacing)
    x, y = xy
    if anchor[0] == "m":
        x -= total / 2
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill, anchor="l" + anchor[1])
        x += d.textlength(ch, font=f) + spacing * S


def wrap(d, s, f, maxw):
    words, lines, cur = s.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw * S:
            cur = t
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def radar_mark(d, cx, cy, scale=1.0):
    """Small radar glyph: two rings, a sweep wedge, a sweep line and a blip."""
    R = 54 * scale * S
    d.pieslice([cx - R, cy - R, cx + R, cy + R], start=-90, end=-30, fill=ACCENT + (60,))
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=ACCENT + (255,), width=int(3.5 * scale * S))
    r2 = R * 0.55
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=ACCENT + (150,), width=int(2.5 * scale * S))
    ang = math.radians(-30)
    d.line([cx, cy, cx + R * math.cos(ang), cy + R * math.sin(ang)], fill=ACCENT + (255,), width=int(3.5 * scale * S))
    rr = 5 * scale * S
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=ACCENT + (255,))
    bx, by = cx + R * 0.62 * math.cos(math.radians(-62)), cy + R * 0.62 * math.sin(math.radians(-62))
    rb = 6.5 * scale * S
    d.ellipse([bx - rb, by - rb, bx + rb, by + rb], fill=INK + (255,))


def save(img, name):
    img = img.resize((1920, 1080), Image.LANCZOS)
    p = os.path.join(OUT, name)
    img.save(p)
    print(p)


def title_card(name="title.png"):
    img = base(glow=(0.5, 0.40), glow_strength=0.07,
               rings=(W // 2, int(H * 0.40), [260, 420, 600, 800], 26)).convert("RGBA")
    d = ImageDraw.Draw(img)
    cx = W // 2
    radar_mark(d, cx, 270 * S, 1.0)
    draw_text(d, (cx, 470 * S), "Recall Radar", font("medium", 132), INK, "ms")
    draw_text(d, (cx, 560 * S), "Ask Alexa+ if something in your home was recalled.", font("light", 50), INK, "ms")
    draw_text(d, (cx, 660 * S), "MCP SERVER  ·  NHTSA  ·  CPSC  ·  FDA", font("medium", 28), ACCENT, "ms", spacing=5)
    save(img.convert("RGB"), name)


def problem_card():
    img = base(glow=(0.18, 0.30), glow_strength=0.06)
    d = ImageDraw.Draw(img)
    x = 340 * S
    draw_text(d, (x, 340 * S), "THE PROBLEM", font("medium", 26), ACCENT, "ls", spacing=6)
    d.line([x, 370 * S, x + 64 * S, 370 * S], fill=ACCENT, width=3 * S)
    f = font("light", 64)
    lines = ["Recall notices go out by mail", "and on agency websites."]
    lines2 = ["Most people never connect them to the car", "in the driveway or the crib in the nursery."]
    y = 480 * S
    for ln in lines:
        draw_text(d, (x, y), ln, f, INK, "ls")
        y += 86 * S
    y += 40 * S
    for ln in lines2:
        draw_text(d, (x, y), ln, f, MUTED, "ls")
        y += 86 * S
    save(img, "problem.png")


def rounded_box(d, box, title, sub, title_f, sub_f, accent=False, sub2=None):
    x0, y0, x1, y1 = [v * S for v in box]
    fill = mix(BG, ACCENT, 0.10) if accent else mix(BG, INK, 0.045)
    outline = mix(BG, ACCENT, 0.85) if accent else mix(BG, INK, 0.20)
    d.rounded_rectangle([x0, y0, x1, y1], radius=22 * S, fill=fill, outline=outline, width=2 * S)
    cx = (x0 + x1) / 2
    n = 1 + (1 if sub else 0) + (1 if sub2 else 0)
    cy = (y0 + y1) / 2
    if n == 1:
        d.text((cx, cy), title, font=title_f, fill=INK, anchor="mm")
    elif n == 2:
        d.text((cx, cy - 6 * S), title, font=title_f, fill=INK, anchor="ms")
        d.text((cx, cy + 40 * S), sub, font=sub_f, fill=MUTED, anchor="ms")
    else:
        d.text((cx, cy - 18 * S), title, font=title_f, fill=INK, anchor="ms")
        d.text((cx, cy + 28 * S), sub, font=sub_f, fill=MUTED, anchor="ms")
        d.text((cx, cy + 68 * S), sub2, font=sub_f, fill=ACCENT, anchor="ms")


def arrow(d, p0, p1, color=ACCENT, width=3, head=14):
    x0, y0 = p0[0] * S, p0[1] * S
    x1, y1 = p1[0] * S, p1[1] * S
    ang = math.atan2(y1 - y0, x1 - x0)
    hx, hy = x1 - head * S * math.cos(ang), y1 - head * S * math.sin(ang)
    d.line([x0, y0, hx, hy], fill=color, width=width * S)
    left = (x1 - head * S * math.cos(ang - 0.45), y1 - head * S * math.sin(ang - 0.45))
    right = (x1 - head * S * math.cos(ang + 0.45), y1 - head * S * math.sin(ang + 0.45))
    d.polygon([(x1, y1), left, right], fill=color)


def arch_card():
    img = base(glow=(0.5, 0.45), glow_strength=0.05)
    d = ImageDraw.Draw(img)
    draw_text(d, (130 * S, 170 * S), "HOW IT WORKS", font("medium", 26), ACCENT, "ls", spacing=6)
    d.line([130 * S, 200 * S, 194 * S, 200 * S], fill=ACCENT, width=3 * S)

    tf, sf = font("medium", 40), font("regular", 27)
    # client
    rounded_box(d, (130, 400, 520, 600), "Alexa+", "or any MCP client", tf, sf)
    # server
    rounded_box(d, (760, 370, 1200, 630), "/mcp", "Cloudflare Workers", font("medium", 52), sf, accent=True,
                sub2="5 tools")
    # sources
    srcs = [("NHTSA", "vehicles"), ("CPSC", "products"), ("FDA", "food and drugs")]
    ys = [250, 430, 610]
    for (t, s), y in zip(srcs, ys):
        rounded_box(d, (1400, y, 1760, y + 140), t, s, font("medium", 36), sf)
    # arrows client -> server
    arrow(d, (535, 500), (745, 500))
    lf = font("regular", 22)
    d.text((640 * S, 474 * S), "Streamable HTTP", font=lf, fill=MUTED, anchor="ms")
    d.text((640 * S, 545 * S), "MCP 2025-11-25", font=lf, fill=MUTED, anchor="ms")
    # server -> sources
    for y in ys:
        arrow(d, (1215, 500), (1385, y + 70), color=mix(BG, ACCENT, 0.75), width=2, head=12)
    # bottom line
    draw_text(d, (960 * S, 880 * S), "5 tools, 70-word spoken answers, never says a product is safe",
              font("light", 44), INK, "ms")
    save(img, "arch.png")


def end_card():
    img = base(glow=(0.5, 0.42), glow_strength=0.065,
               rings=(W // 2, int(H * 0.42), [300, 470, 660], 22)).convert("RGBA")
    d = ImageDraw.Draw(img)
    cx = W // 2
    radar_mark(d, cx, 280 * S, 0.85)
    draw_text(d, (cx, 450 * S), "Recall Radar", font("medium", 104), INK, "ms")
    draw_text(d, (cx, 520 * S), "by Michael Lip", font("light", 44), MUTED, "ms")
    draw_text(d, (cx, 650 * S), "github.com/theluckystrike/recall-radar", font("regular", 42), ACCENT, "ms")
    draw_text(d, (cx, 715 * S), "recall-radar.lipmichal.workers.dev", font("regular", 42), ACCENT, "ms")
    draw_text(d, (cx, 900 * S), "Data from NHTSA, CPSC and FDA. Not affiliated with Amazon, NHTSA, CPSC or FDA.",
              font("regular", 24), MUTED, "ms")
    save(img.convert("RGB"), "end.png")


def caption_png(text, name):
    """Transparent 1920x1080 overlay with a dark rounded caption bar at the bottom."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = font("regular", 40)
    tw = d.textlength(text, font=f)
    padx, bar_h, bottom = 34 * S, 76 * S, 46 * S
    x0 = (W - tw) / 2 - padx
    x1 = (W + tw) / 2 + padx
    y1 = H - bottom
    y0 = y1 - bar_h
    d.rounded_rectangle([x0, y0, x1, y1], radius=20 * S, fill=(7, 10, 22, 248), outline=(138, 150, 176, 70), width=S)
    d.text((W / 2, (y0 + y1) / 2 + 1 * S), text, font=f, fill=INK + (255,), anchor="mm")
    img = img.resize((1920, 1080), Image.LANCZOS)
    p = os.path.join(ROOT, "work", "captions", name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)
    if tw / S > 1760:
        raise SystemExit(f"caption too wide: {text}")
    return p


if __name__ == "__main__":
    title_card()
    problem_card()
    arch_card()
    end_card()
