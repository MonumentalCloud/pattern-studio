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
| **Shape tool** | drag rectangles and ellipses (circle = equal drag) with live dimensions, snapped to grid and points |
| **Pen tool** | click = corner point, click-drag = curve (bezier handles), click the first point to close the piece · live length readout while drawing · **right-click to type an exact length + angle** for the next segment |
| **Edit** | drag points, handles, edges (edges move freely) and pieces · **`Shift`-click edges (or `Shift`-drag a box)** to gather several — drag one to move them together, and the same set feeds the Offset tool · **exact moves**: type X/Y coordinates for a point, or a **Move by Δx/Δy** (cm) for any selection — point, point group, edge, hole, piece, or every marquee-selected piece · **arrow keys move the selection** (Shift = 5×, Alt = 0.1cm; notches/slits slide along their edge) · **drag on empty canvas to marquee-select** pieces — or, with a piece selected, its **points** (move/nudge/delete as a group) · **`Shift`-click pieces** (guide/stitch lines included) to gather several into a group, `Shift`-marquee adds to it · **Ctrl+C/V/X/D** copy, paste (works across tabs), cut, duplicate · **right-click a point** to convert corner↔curve, round, or delete it · **round a corner**: select a point, type a radius, Round · double-click a point to toggle corner↔smooth · double-click an edge to insert a point · **right-click an edge to divide it** at a distance (cm), a percentage, or into N equal parts (arc-length accurate on curves) · Del removes · delete a single curve handle by dragging it onto its point, double-clicking it, or the ×&nbsp;in / ×&nbsp;out buttons |
| **Seam allowance** | per-piece width (cm); the dashed line is the cutting line, computed as a true outward offset — also what goes on the DXF `CUT` layer |
| **Notches** | click an edge; exported as short slits from the cutting line inward (so the laser cuts them) |
| **Offset tool** | one tool for everything that pushes edges parallel to themselves, in three modes · **Slide** — move the selected edges along their normals (out or in), mitred where two selected edges share a corner, neighbouring edges stretch · **Protrude** — extrude each selected edge into a tab (or a recess, inward): its corners stay and straight side walls form · **Guide line** — scribe a dashed guide inset from the picked edges (the stitch line; mitered runs, click inside a piece for a full ring; exports to `MARK`, never cut) · build the edge set by clicking edges (click again to remove) or **dragging a box**; then drag a selected edge for a live offset with a ± cm readout, or type a distance and Apply for exact values |
| **Stitch holes** | diagonal slits for hand sewing (leather/felt) — click two edges or guide lines and both get the **same number of holes at matching positions**; guides get holes along their whole length (including closed rings) · **bulk mode: `Shift`-click (or drag a box over) many edges/guide lines**, then Enter or "Stitch selected" runs holes along each in one step · spacing/slit length configurable, exported on `CUT` |
| **Drill holes** | marked circles on the `MARK` layer |
| **Grainline** | drag inside a piece; double-ended arrow |
| **Edge length** | select an edge and type a target length (cm); the edge rescales about a chosen anchor (both ends / start / end) and curves keep their shape — for walking seams |
| **Knife** | cut a piece in two: click two points (they **snap to existing points**, and cuts through a point reuse it exactly — no sliver edges), or click a drawn open path to cut along it (curves embed exactly); notches, stitch slits, holes and grainline land on the correct halves — the inverse of Weld |
| **Boolean** | overlap two pieces → union, subtract (A − B) or intersect; curves survive, holes keep their sides; overlapping outlines must cross exactly twice · **subtract with B fully inside A punches it through** — B becomes an internal cutout, a real hole on the `CUT` layer (contained union/intersect also do the obvious thing) |
| **Weld** | fuse two pieces into one along matching edges — the second piece is rigidly moved into place, both seam edges disappear, notches/holes/grainline carried over · **seam leftovers that coincide sew up**: weld two mirrored halves whose joining edge carries half a cut-out (e.g. a half-circle bite) and the doubled line disappears while the bite closes into an **internal cutout** — a real hole, cut intact on the `CUT` layer, that moves/mirrors/copies with the piece |
| **Fold-line pieces** | draft half a symmetric piece, mark a straight edge as the fold — the mirrored half renders live and every edit updates it; exports unfold to the full cutting outline with the fold on the `MARK` layer |
| **Mirror copy** | mirrored duplicate for left/right pieces — handles, notches and holes are remapped correctly |
| **Measure** | drag to measure any distance; edge lengths and piece perimeters shown live (for walking seams) |
| **Snap** | to grid (0.1–1 cm), to existing points, and to **any point along another outline** (projected onto the curve) — for the pen, shapes, node drags and the knife · dragging a whole piece magnets its points onto other pieces' points or edges for exact placement |
| **Undo/redo** | Ctrl+Z / Ctrl+Y, 100 steps |
| **Cloud save (GitHub)** | connect with your own fine-grained token (Contents read/write on one repo you own) — patterns save as versioned files in that repo, load from any device; the token stays in your browser |

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

## DXF import

The **Open** button also accepts `.dxf` — patterns from Seamly2D/Valentina, CLO3D
(File → Export → DXF), Inkscape, or any CAD tool:

- Reads `LINE`, `LWPOLYLINE`/`POLYLINE` (including **bulge arcs** — curves come in as
  real beziers, not facets), `ARC` and `CIRCLE`; `SPLINE`/`TEXT`/etc. are skipped with
  a note. Loose lines/arcs are chained into outlines; closed loops become pieces,
  small circles become drill holes.
- **`BLOCK`/`INSERT` structure is expanded** — garment CAD exports (CLO, AAMA/ASTM)
  put each piece in a block and only reference it from the entities section. Pieces
  are named from their blocks, and AAMA layer-7 lines import as grainlines.
- Units come from the file header when declared; otherwise you get one prompt with a
  size-based guess (mm/cm/in).
- Straight runs are simplified (0.5 mm tolerance), so densely flattened exports don't
  arrive with hundreds of points; sub-centimetre debris (notch/stitch slits) is filtered.
- Imported pieces default to seam allowance 0, since an exported outline is usually
  already the cutting line.

## Keyboard

`V` select · `P` pen · `R` shape · `N` notch · `H` hole · `G` grain · `W` weld · `O` offset (`I` works too) · `S` stitch · `K` knife · `F` round · `B` boolean · `M` measure ·
`Space`+drag or two-finger scroll pan · pinch/`Ctrl`+scroll zoom · `0` fit · `Del` delete · `Ctrl+Z/Y` undo/redo ·
`Ctrl+C/V/X` copy/paste/cut · `Ctrl+D` duplicate · `Ctrl+S` save project · `Esc`/`Enter` finish pen path · arrows nudge selection (`Shift` ×5, `Alt` fine)

## Tests

```
node test/core.test.js
```

Covers bezier flattening/lengths, seam-allowance offsetting (both windings),
outward-normal orientation, curve splitting, and DXF structure/scale/notch geometry.

## Roadmap

- [x] Edge-length editing (type a number, the curve adjusts) for walking seams
- [x] Weld/join two pieces along matching edges
- [x] DXF import (LINE/POLYLINE/ARC/CIRCLE → pieces; CLO3D's DXF export imports too —
      `.zprj` itself is proprietary, export DXF from CLO instead)
- [ ] GarmentCode importer — open [GarmentCode](https://github.com/maria-korosteleva/GarmentCode) /
      Design2GarmentCode specification JSONs as editable pieces (verified compatible:
      cm units, panels map to pieces, quadratic/cubic curves map to handles exactly)
- [ ] Grading (multi-size nests)
- [ ] Basic block generators from body measurements (bodice / sleeve / skirt)
- [ ] Tiled A4/Letter PDF export for home printers
- [ ] Internal style lines / darts as first-class objects
- [x] Fold-line pieces (half-drafted, auto-mirrored on export)
