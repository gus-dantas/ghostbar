"""The GhostAvo mark: one tile, a quarter of a cut avocado whose stone is also an eye.

Draws every version as SVG, on a 100-unit grid:
  - the quarter disc, radius 100, centred on the bottom right corner;
  - colour version: a 9-unit rind band in the skin colour, the flesh inside it;
  - the stone-eye: an egg 24 x 30, narrow at the top, centred at (64, 58), tilted 14 degrees
    toward the avocado's centre; a pupil of radius 5.4 low in the egg, a glint of radius 1.6;
  - small version (16 and 32 px): no rind, the egg 1.45 times larger, no glint.
One colour is the primary mark: the egg is cut out of the quarter, the pupil stays.
The official ground is paper (#F2F5F4); the deep teal ground is an alternative, not the standard.

  python3 make_mark.py   (writes the SVGs next to this file)
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TEAL, SKIN, ORANGE, DEEP, PAPER, INK = "#50C1B1", "#2A8A7C", "#EE8A50", "#123F3A", "#F2F5F4", "#10201F"
QUARTER = "M100 100V0A100 100 0 0 0 0 100Z"
FLESH = "M100 100V9A91 91 0 0 0 9 100Z"
EGG = "M0 -15C8 -15 12 -4.5 12 3C12 10.5 6.8 15 0 15C-6.8 15 -12 10.5 -12 3C-12 -4.5 -8 -15 0 -15Z"
EYE = "translate(64 58) rotate(-14)"
EYE_SMALL = "translate(62 58) rotate(-14) scale(1.45)"


def svg(body, view="0 0 100 100", size=None):
    dims = f' width="{size}" height="{size}"' if size else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}"{dims}>\n{body}\n</svg>\n'


def colour(small=False):
    if small:
        return (f'  <path d="{QUARTER}" fill="{TEAL}"/>\n'
                f'  <g transform="{EYE_SMALL}"><path d="{EGG}" fill="{ORANGE}"/><circle cy="4" r="5.6" fill="{DEEP}"/></g>')
    return (f'  <path d="{QUARTER}" fill="{SKIN}"/>\n  <path d="{FLESH}" fill="{TEAL}"/>\n'
            f'  <g transform="{EYE}"><path d="{EGG}" fill="{ORANGE}"/><circle cy="4" r="5.4" fill="{DEEP}"/>'
            f'<circle cx="-1.7" cy="2.2" r="1.6" fill="{PAPER}"/></g>')


def mono(fill, uid, small=False):
    eye = EYE_SMALL if small else EYE
    glint = "" if small else '<circle cx="-1.7" cy="2.2" r="1.6" fill="#000"/>'
    return (f'  <defs>\n'
            f'    <mask id="cut-{uid}"><rect width="100" height="100" fill="#fff"/><g transform="{eye}"><path d="{EGG}" fill="#000"/></g></mask>\n'
            f'    <mask id="glint-{uid}"><rect width="100" height="100" fill="#fff"/><g transform="{eye}">{glint}</g></mask>\n'
            f'  </defs>\n'
            f'  <path d="{QUARTER}" fill="{fill}" mask="url(#cut-{uid})"/>\n'
            # the mask goes on an untransformed group, so its rectangle covers the whole tile
            f'  <g mask="url(#glint-{uid})"><g transform="{eye}"><circle cy="4" r="{5.6 if small else 5.4}" fill="{fill}"/></g></g>')


def write(name, text):
    with open(os.path.join(HERE, name), "w") as f:
        f.write(text)


# the mark
write("ghostavo-mark.svg", svg(mono("currentColor", "cc")))                 # one colour, takes the text colour
write("ghostavo-mark-teal.svg", svg(mono(TEAL, "t")))
write("ghostavo-mark-ink.svg", svg(mono(INK, "i")))
write("ghostavo-mark-paper.svg", svg(mono(PAPER, "p")))                       # for dark grounds
write("ghostavo-mark-colour.svg", svg(colour()))
write("ghostavo-mark-small.svg", svg(colour(small=True)))                     # 16 and 32 px
write("ghostavo-mark-small-mono.svg", svg(mono("currentColor", "s", small=True)))

# the tile: the mark on its official paper ground, for favicons and extension icons
PAPER_SQ = f'  <rect width="100" height="100" fill="{PAPER}"/>\n'
write("ghostavo-tile.svg", svg(PAPER_SQ + colour()))
write("ghostavo-tile-small.svg", svg(PAPER_SQ + colour(small=True)))
write("ghostavo-tile-mono.svg", svg(PAPER_SQ + mono(TEAL, "tm")))

# app icon, 1024: the paper tile on Apple's grid (paper is the official ground), the quarter anchored to its bottom right corner
R, C = 690, 924                    # quarter radius, the corner it grows from
k = R / 100                        # tile units to pixels
ex, ey = C - 36 * k, C - 42 * k    # the eye, (64, 58) in tile units
app = f'''  <defs><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="{PAPER}"/>
  <g clip-path="url(#tile)">
    <path d="M{C} {C}V{C - R}A{R} {R} 0 0 0 {C - R} {C}Z" fill="{SKIN}"/>
    <path d="M{C} {C}V{C - R + 9 * k}A{R - 9 * k} {R - 9 * k} 0 0 0 {C - R + 9 * k} {C}Z" fill="{TEAL}"/>
    <g transform="translate({ex} {ey}) rotate(-14) scale({k})"><path d="{EGG}" fill="{ORANGE}"/><circle cy="4" r="5.4" fill="{DEEP}"/><circle cx="-1.7" cy="2.2" r="1.6" fill="{PAPER}"/></g>
  </g>'''
write("app-icon.svg", svg(app, "0 0 1024 1024"))

# menu bar glyphs (template images: black on clear), 64 px; badges sit in the empty top left
G = 0.82                            # the quarter fills 82 % of the glyph
def glyph(extra="", pupil=True):
    t = f"translate(11 11) scale({G * 0.64})"
    pup = f'<g transform="{EYE_SMALL}"><circle cy="4" r="5.6" fill="#000"/></g>' if pupil else ""
    return svg(f'''  <defs><mask id="cut"><rect width="100" height="100" fill="#fff"/><g transform="{EYE_SMALL}"><path d="{EGG}" fill="#000"/></g></mask></defs>
  <g transform="{t}"><path d="{QUARTER}" fill="#000" mask="url(#cut)"/>{pup}</g>
  {extra}''', "0 0 64 64")
write("tray-idle.svg", glyph())
write("tray-recording.svg", glyph('<circle cx="15" cy="15" r="9" fill="#000"/>'))
write("tray-transcribing.svg", glyph('<circle cx="9" cy="15" r="3.6" fill="#000"/><circle cx="20" cy="15" r="3.6" fill="#000"/><circle cx="31" cy="15" r="3.6" fill="#000"/>'))
write("tray-warning.svg", glyph('<circle cx="15" cy="15" r="11" fill="#000"/><rect x="13.4" y="7" width="3.2" height="10" rx="1.6" fill="#fff"/><circle cx="15" cy="21.6" r="1.9" fill="#fff"/>'))
print("wrote", len([f for f in os.listdir(HERE) if f.endswith(".svg")]), "SVGs")
