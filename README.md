# ✂ Pattern Studio

A free, browser-based **2D pattern drafting tool** — think CLO3D's 2D pattern window
without the 3D simulation. Draft pattern pieces, add seam allowance, notches, drill
holes and grainlines, then **export DXF straight to your laser cutter**.

No install, no server, no subscription. Open `index.html` in a browser and draft.

## Run it

```
git clone <this repo>
open pattern-studio/index.html    # or just double-click it
```

Everything runs client-side. Your work autosaves to the browser (localStorage) and
can be saved/opened as `.pattern.json` files.

## Features

| | |
|---|---|
| **Pen tool** | click = corner point, click-drag = curve (bezier handles), click the first point to close the piece |
| **Edit** | drag points and handles · double-click a point to toggle corner↔smooth · double-click an edge to insert a point · Del removes |
| **Seam allowance** | per-piece width (cm); the dashed line is the cutting line, computed as a true outward offset — also what goes on the DXF `CUT` layer |
| **Notches** | click an edge; exported as short slits from the cutting line inward (so the laser cuts them) |
| **Drill holes** | marked circles on the `MARK` layer |
| **Grainline** | drag inside a piece; double-ended arrow |
| **Edge length** | select an edge and type a target length (cm); the edge rescales about a chosen anchor (both ends / start / end) and curves keep their shape — for walking seams |
| **Weld** | fuse two pieces into one along matching edges — the second piece is rigidly moved into place, both seam edges disappear, notches/holes/grainline carried over |
| **Mirror copy** | mirrored duplicate for left/right pieces — handles, notches and holes are remapped correctly |
| **Measure** | drag to measure any distance; edge lengths and piece perimeters shown live (for walking seams) |
| **Snap** | to grid (0.1–1 cm) and to existing points |
| **Undo/redo** | Ctrl+Z / Ctrl+Y, 100 steps |

## DXF export (laser cutting)

- **Format**: DXF R12 (AC1009) ASCII — the dialect read most reliably by LightBurn,
  RDWorks, Ruida controllers, Inkscape, AutoCAD, and nesting software.
- **Units**: millimetres, y-up, translated into the positive quadrant.
- **Curves** are flattened to polylines at 0.1 mm tolerance (laser software prefers
  polylines over SPLINE entities — no interpolation surprises).
- **Layers**:
  - `CUT` (red) — the cutting line (= seam line + allowance, or the outline if allowance is 0) **plus notch slits**
  - `SEAM` (green) — the stitch line, when allowance > 0 (set this layer to "no output" in your laser software, or engrave it)
  - `MARK` (blue) — grainlines and drill-hole circles (engrave or ignore)

SVG export (true-size, mm) is also available for printing or Inkscape.

## Keyboard

`V` select · `P` pen · `N` notch · `H` hole · `G` grain · `W` weld · `M` measure ·
`Space`+drag pan · wheel zoom · `0` fit · `Del` delete · `Ctrl+Z/Y` undo/redo ·
`Ctrl+S` save project · `Esc`/`Enter` finish pen path

## Tests

```
node test/core.test.js
```

Covers bezier flattening/lengths, seam-allowance offsetting (both windings),
outward-normal orientation, curve splitting, and DXF structure/scale/notch geometry.

## Roadmap

- [x] Edge-length editing (type a number, the curve adjusts) for walking seams
- [x] Weld/join two pieces along matching edges
- [ ] Grading (multi-size nests)
- [ ] Basic block generators from body measurements (bodice / sleeve / skirt)
- [ ] Tiled A4/Letter PDF export for home printers
- [ ] Internal style lines / darts as first-class objects
- [ ] Fold-line pieces (half-drafted, auto-mirrored on export)
