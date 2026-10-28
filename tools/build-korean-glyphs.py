"""Generate Korean engraving outlines from Noto Sans KR (SIL OFL-1.1).
Usage: python3 tools/build-korean-glyphs.py NotoSansKR.ttf
Source: https://github.com/google/fonts/tree/main/ofl/notosanskr
Requires fontTools; font file SHA256 recorded in the generated asset. No font parser ships to the browser.
"""
import hashlib
import json
from pathlib import Path
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

source = Path(sys.argv[1])
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
font = TTFont(source)
assert font["head"].unitsPerEm == 1000, "Expected Noto Sans KR font units"
glyph_set = font.getGlyphSet(location={"wght": 400})

class OutlinePen(BasePen):
    def __init__(self):
        super().__init__(glyph_set)
        self.commands = []

    def command(self, code, *points):
        self.commands.append(code + " ".join(str(round(v)) for p in points for v in p))

    def _moveTo(self, p): self.command("M", p)
    def _lineTo(self, p): self.command("L", p)
    def _curveToOne(self, a, b, p): raise ValueError("Expected TrueType quadratic outlines")
    def _qCurveToOne(self, a, p): self.command("Q", a, p)
    def _closePath(self): self.command("Z")
    def _endPath(self): raise ValueError("Expected closed font contours")

outlines = {}
for code, name in font.getBestCmap().items():
    if (0xAC00 <= code <= 0xD7A3 or 0x1100 <= code <= 0x11FF or
        0x3130 <= code <= 0x318F or 0xA960 <= code <= 0xA97F or
        0xD7B0 <= code <= 0xD7FF):
        pen = OutlinePen()
        glyph_set[name].draw(pen)
        if pen.commands:
            outlines[chr(code)] = "".join(pen.commands)

assert all(chr(code) in outlines for code in range(0xAC00, 0xD7A4))
header = ("/* Generated Korean outline data, Noto Sans KR Regular (weight400), units1000.\n"
          " * Copyright2014-2021 Adobe; SIL OFL-1.1. See fonts/KOREAN-OUTLINES-OFL.txt.\n"
          f" * Source font SHA256: {source_hash}\n"
          " * Regenerate with tools/build-korean-glyphs.py. */\n")
entries = ",\n".join(json.dumps(k, ensure_ascii=False) + ":" + json.dumps(v)
                     for k, v in outlines.items())
output = (header + "(function(root){const glyphs={\n" + entries +
          "\n};if(typeof module!=='undefined'&&module.exports)module.exports=glyphs;"
          "else root.KoreanGlyphs=glyphs;})(typeof self!=='undefined'?self:this);\n")
Path(__file__).resolve().parents[1].joinpath("js/korean-glyphs.js").write_text(output)
print(f"Wrote {len(outlines)} Korean glyphs; source SHA256 {source_hash}")
