# ✂ Pattern Studio

A free, browser-based **2D pattern drafting tool** — think CLO3D's 2D pattern window
without the 3D simulation. Draft pattern pieces, add notches, stitch holes, drill
holes and grainlines, then **export DXF straight to your laser cutter**. What you
draw is what gets cut — the outline IS the cutting line, no hidden allowances.

No install, no server, no subscription. Open `index.html` in a browser and draft.

## Run it

```
git clone <this repo>
open pattern-studio/index.html    # or just double-click it
```

Everything runs client-side. Your work autosaves to the browser (localStorage) and
can be saved/opened as `.pattern.json` files. In Chrome/Edge, **Save writes straight
to a file on your computer** (it asks where once, then `Ctrl+S` saves in place;
`Shift`-click Save = Save As); other browsers fall back to a download.

## Tool inspectors (build 66)

The active tool's controls stay above the Pieces list. File contains local/cloud
save and open; Export contains DXF/SVG and engraving options. Round, Notch, Hole,
Pen and Grain expose their own editing controls. Select offers an explicit box
selection target; Stitch Edit boxes select stitch holes across every visible shape, regardless of
the previous selection. Shift adds; editing, deletion and nudging apply to all
selected holes. Copy/Cut/Duplicate act on all containing shapes.

New stitching defaults to **Follow stitch line**, at **−45°** (／ on a horizontal
line). Mirroring and unfolding preserve the edge-relative iron slant. Width,
spacing, length, inset, angle and reference are remembered in this browser;
applied edits also become the defaults for new runs. Slots start at **0.5 mm width**, adjustable down to zero
for line cuts. Existing line slits keep zero width until edited. Both the canvas
and exports use the actual slot contour. Test a small paper sample to calibrate
width for your iron. Slots crossing an outline or cutout are rejected on creation
and dimension editing.

New matched seams save their pairing, so whole-run dimension edits and re-spacing
update both sides. Original side A determines the hole count, regardless of which
side is selected. An amber notice flags unequal seam lengths before matching and
when editing a linked pair; side B adjusts its spacing to retain equal counts.
**Re-space whole run** regenerates holes, including manually
removed ones. Deleting selected holes or a whole run leaves the partner intact.
Legacy seams have no pairing information; recreate them to link their sides.
Copied pieces detach from the original pair.

## Measured shapes

Choose **Shape → Triangle — three sides** or **Regular polygon**, then click the
starting corner on the canvas. Enter lengths in cm. Triangle A is its horizontal
base; B and C meet at the third corner. Impossible side combinations show an
error without creating a piece. Regular polygons use 3–100 equal sides and a side
length. Both become ordinary editable pattern pieces, with the usual undo,
rotation, mirroring and exports. General irregular polygons also need angles or
diagonals to determine a unique shape.

## Features

| | |
|---|---|
| **Shape tool** | drag rectangles and ellipses (circle = equal drag) with live dimensions, snapped to grid and points · press **Option / Alt during the drag** (or hold it when starting) to enter exact width and height in cm; Enter creates, Escape cancels. The starting corner and drag direction stay fixed. |
| **Pen tool** | click = corner point, click-drag = curve (bezier handles), click the first point to close the piece · live length readout while drawing · **right-click to type an exact length + angle** for the next segment |
| **Edit** | **select first, then drag**: a click that changes the selection only selects — press the point/edge/cutout/piece again to move it, and a move needs a few pixels of travel before it starts, so a click never nudges geometry · drag points, handles, edges (edges move freely) and pieces · **`Shift`-click edges (or `Shift`-drag a box)** to gather several — drag one to move them together, and the same set feeds the Offset tool · **exact moves**: type X/Y coordinates for a point, or a **Move by Δx/Δy** (cm) for any selection — point, point group, edge, hole, piece, or every marquee-selected piece · **arrow keys move the selection** (Shift = 5×, Alt = 0.1cm; notches/slits slide along their edge) · **choose the Select box target explicitly**: pieces, or points/edges/stitch holes on the selected piece · **`Shift`-click pieces** (guide/stitch lines included) to gather several into a group, `Shift`-marquee adds to it · **Ctrl+C/V/X/D** copy, paste (works across tabs), cut, duplicate · **right-click a point** to convert corner↔curve, round, or delete it · **round a corner**: use Round, click a point, type a radius and apply · double-click a point to toggle corner↔smooth · double-click an edge to insert a point · **right-click an edge to divide it** at a distance (cm), a percentage, or into N equal parts (arc-length accurate on curves) · Del removes · **curve handles are deleted one at a time**: click a handle (it rings — **Del** then takes that handle, never the point under it), double-click it, drag it onto its point, or use the ×&nbsp;in / ×&nbsp;out buttons — a selected point shows its own two handles *and* the facing (hollow) handle of each neighbour, since an edge is bent from both ends and the far one used to be unreachable · **internal cutouts are objects too**: with the piece selected, click a cutout's ring to select it — drag / arrows / Move by reposition it, Del removes it (any stitch run riding on it goes too) |
| **Notches** | **snap to points only**: click near an outline and the notch lands exactly on the nearest point (divide an edge — right-click it — to put a point at an exact distance first) · a **real cut into the piece** from the outline inward, in two per-piece styles — **Slit** (one straight cut) or **V cut** (two arms meeting at an apex, so the laser drops the chip out; at a corner the cut bisects it and the V spreads across both edges) — depth per piece (cm), drawn live and exported on `CUT` |
| **Offset tool** | one tool for everything that pushes edges parallel to themselves, in three modes · **Slide** — move the selected edges along their normals (out or in), mitred where two selected edges share a corner, neighbouring edges stretch · **Protrude** — extrude each selected edge into a tab (or a recess, inward): its corners stay and straight side walls form · **Guide line** — scribe a dashed guide inset from the picked edges (the stitch line; mitered runs, click inside a piece for a full ring; exports to `MARK`, never cut) · build the edge set by clicking edges (click again to remove) or **dragging a box**; then drag a selected edge for a live offset with a ± cm readout, or type a distance and Apply for exact values |
| **Stitch holes** | diagonal slits for hand sewing (leather/felt), **slant is yours to set**, against either reference · ***Slant from: Follow stitch line*** (default, −45°) measures the angle off the edge each hole sits on — the traditional saddle-stitch convention, so slits follow the outline round a curve; ±45 are the two diagonals, 90 is square across the seam, and the on-screen direction turns with the outline (45° reads `\` on a horizontal edge but `/` on a vertical one) · ***Slant from: Page*** measures off the page instead, so **every hole stays parallel** however the outline turns — `0` = horizontal, `90` = vertical, `45` = `\`, `-45` = `/`, with the panel naming the result as you type · edit holes already placed under **Stitch → Edit holes / runs**: select holes, set length/width/slant/inset change, then **Apply to selected holes** or **Apply to run / matched pair** · in two modes · **Single** (default): click, `Shift`-click or **drag a box** over any mix of edges, guide lines and internal cutouts, then Enter or "Stitch selected" — each continuous run gets holes spaced along its own length; contiguous edges of a piece stitch as **one run along the mitred inset line** (Inset honoured around corners, the full outline becomes a single loop, a cutout gets a ring of holes inset *into* the material) · **Matched**: gather side A the same way (several connected edges chain into one seam), confirm with **"Set side A ▸"**, gather side B, then "Stitch matched" — both sides get the **same number of holes at matching positions** for pairing seams, hole count taken from side A's length · every run is **one object**: click a stitched edge (or any single hole) and "Delete stitch line" removes the whole run · **delete a section**: drag a box over some holes (or `Shift`-click them) and Del removes just those — holes stay separate marks until export, where they become cut slits · spacing/slit length configurable, exported on `CUT` |
| **Hole tool** | Physical circular cutouts on `CUT`, with editable diameter in millimetres (3 mm default), including circles in existing saved patterns. |
| **Grainline** | drag inside a piece; double-ended arrow |
| **Edge length** | select an edge and type a target length (cm); the edge rescales about a chosen anchor (both ends / start / end) and curves keep their shape — for walking seams |
| **Knife** | cut a piece in two: click two points (they **snap to existing points**, and cuts through a point reuse it exactly — no sliver edges), or click a drawn open path to cut along it (curves embed exactly); notches, stitch slits, holes and grainline land on the correct halves — the inverse of Weld |
| **Boolean** | overlap two pieces → union, subtract (A − B) or intersect; curves survive, holes keep their sides; overlapping outlines must cross exactly twice · **subtract with B fully inside A punches it through** — B becomes an internal cutout, a real hole on the `CUT` layer (contained union/intersect also do the obvious thing) |
| **Weld** | fuse two pieces into one along matching edges — the second piece is rigidly moved into place, both seam edges disappear, notches/holes/grainline carried over · **seam leftovers that coincide sew up**: weld two mirrored halves whose joining edge carries half a cut-out (e.g. a half-circle bite) and the doubled line disappears while the bite closes into an **internal cutout** — a real hole, cut intact on the `CUT` layer, that moves/mirrors/copies with the piece |
| **Fold-line pieces** | draft half a symmetric piece, mark a straight edge as the fold — the mirrored half renders live and every edit updates it; exports unfold to the full cutting outline with the fold on the `MARK` layer |
| **Mirror copy** | mirrored duplicate for left/right pieces — handles, notches and holes are remapped correctly |
| **Inset copy** | duplicate a piece with its outline offset **inward** by a set distance (lining / padding layers) — lands concentric on the original; negative distance grows it outward; holes and cutouts ride along |
| **Scale** | resize a piece — or every marquee-selected piece about their **shared centre** — by a percentage, or **drag the corner handles** around the selection (uniform, anchored at the opposite corner, live % readout); curves, holes and cutouts scale along, stitch slit sizes stay as configured |
| **Rotate** | type exact degrees (positive = counter-clockwise, like pen angles) or **drag the round handle** above the selection — 1° steps, `Shift` = 15°; works on marquee groups about their shared centre; all marks ride along |
| **Measure** | drag to measure any distance; edge lengths and piece perimeters shown live (for walking seams) |
| **Snap** | **every positional tool snaps** — pen, shapes, node drags, knife, drill holes, grainline, measure · to grid (0.1–1 cm), to existing points (**cutout corners included**), to the **middle of every edge** — outlines, cutout rings and the pen's own draft, marked with a diamond as you catch it, and measured by **arc length** so the middle of a curve is where it looks, not where the handles put parameter 0.5 · corners always win over a middle, and a middle over an arbitrary point on the curve · and to **any point along another outline or cutout ring** (projected onto the curve) · **orthogonal alignment**: a point that lines up horizontally/vertically with any other point snaps level with it, with a dashed guide to the reference — the pen aligns with **its own draft points** too, so paths close square · dragging a whole piece magnets its points onto other pieces' points or edges for exact placement |
| **Pieces panel** | the layer list — click to select, the eye hides/shows, **double-click a name to rename it in place** (Enter saves, Esc cancels; you get exactly the name you type) · **derived names don't pile up**: duplicating, mirroring, insetting or stitch-lining an already-derived piece folds the repeat into a counter — `Front copy`, `Front copy 2`, `Front copy 3`, never `Front copy copy copy` — and generated names are kept distinct from each other |
| **Engraved piece names** | tick **Engrave piece names** in the Export panel and each piece's name is written inside its own outline on the `MARK` layer, in **single-stroke lines** — one laser pass per letter, no font to install, no reader-dependent rendering · text height is yours to set (cm) and shrinks automatically to fit the material actually available across the piece, not its bounding box; below 2.5 mm the label is skipped rather than engraved as mush · the name sits on the area centroid, or on the widest interior run when that centroid falls outside the shape (a U or a crescent) · applies to **both DXF and SVG**; guide/stitch lines stay unlabelled · names the stroke font has no glyphs for (Hangul, CJK, accents) fall back to a DXF `TEXT` entity so nothing is silently dropped, and the export says which pieces did that |
| **Undo/redo** | Ctrl+Z / Ctrl+Y, 100 steps |
| **Cloud save (GitHub)** | connect with your own fine-grained token (Contents read/write on one repo you own) — patterns save as versioned files in that repo, load from any device; the token stays in your browser |

## DXF export (laser cutting)

- **Format**: DXF R12 (AC1009) ASCII — the dialect read most reliably by LightBurn,
  RDWorks, Ruida controllers, Inkscape, AutoCAD, and nesting software.
- **Units**: millimetres, y-up, translated into the positive quadrant.
- **Curves** are flattened to polylines at 0.1 mm tolerance (laser software prefers
  polylines over SPLINE entities — no interpolation surprises).
- **Layers**:
  - `CUT` (red) — the piece outline (exactly as drawn) and internal cutouts, **plus notch cuts, circular holes and stitch slots**
  - `MARK` (blue) — grainlines, guide lines and fold lines (engrave or ignore)

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
- The imported outline is used as-is — it becomes the cutting line, same as
  pieces drafted here.

## Keyboard

`V` select · `P` pen · `R` shape · `N` notch · `H` hole · `G` grain · `W` weld · `O` offset (`I` works too) · `S` stitch · `K` knife · `F` round · `B` boolean · `M` measure ·
`Space`+drag or two-finger scroll pan · pinch/`Ctrl`+scroll zoom · `0` fit · `Del` delete · `Ctrl+Z/Y` undo/redo ·
`Ctrl+C/V/X` copy/paste/cut · `Ctrl+D` duplicate · `Ctrl+S` save project · `Esc`/`Enter` finish pen path · arrows nudge selection (`Shift` ×5, `Alt` fine)

## Tests

```
node test/core.test.js
```

Covers bezier flattening/lengths, outline offsetting (both windings),
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
