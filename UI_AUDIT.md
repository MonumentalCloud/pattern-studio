# Pattern Studio: UI ownership and physical-cut audit

Audited 2026-09-12 against `main` commit `f84903b`, build 61, and the live Chrome page at https://monumentalcloud.github.io/pattern-studio/.

The repository's default branch is an older build (50). This audit uses `main`, which matches the live app. Local audit branch: `ui-audit`. No application code or pattern geometry was changed.

## Findings in brief

The main problem is inconsistent ownership: controls are organized partly by tool, partly by selected object, and partly by when a feature was added. The active tool's controls come after the piece list, export settings, and generic piece/selection controls. Creating and editing the same object often require different tools with separate selections.

There are 22 findings below: placement/discoverability problems, selection/scope ambiguities, and physical-output requirements. They are not all bugs or simple relocations.

### Confirmed requirements from Marvin

- Preserve established functionality while reorganizing the UI.
- Stitch must support editing existing runs' length, inset, and spacing as well as creating runs.
- Updated instruction: change box selection. Stitch Edit explicitly selects holes; Select has a pieces/points/edges/holes target selector.
- Hole must create a physical cutout, rather than an engraving mark.
- Stitch holes need actual width to accommodate a pricking iron without tearing the paper.
- Stitch-slot width/tooth dimensions remain unanswered. Whether editing matched spacing updates both sides is also pending.

## Placement and discoverability

| ID | Priority | Current behavior and evidence | Proposed home / remedy |
|---|---|---|---|
| 1 | High | Clicking Stitch leaves its entire settings panel below the visible sidebar at the observed 1470×718 viewport. Pieces, Export, and Piece appear first. Browser-confirmed; `index.html:116`, `index.html:123`, `index.html:136`, `index.html:273`. | Put the active tool panel first and keep the piece browser independently scrollable/collapsible. Do not make users scroll past document settings to configure a tool. |
| 2 | High | Slit angle/reference creation controls live in Stitch; editing selected holes or whole runs lives in Selection. `app.js:750`, `app.js:4633`. | A single Stitch inspector with clearly identified **New run** and **Edit existing run** contexts. Selecting a hole in Select should reveal the same editing controls. Retain shortcuts. |
| 3 | High | Remove holes on selected edges and Delete stitch line are in Selection, not Stitch. The two buttons can affect different extents. `app.js:814`, `app.js:4623`, `app.js:4683`. | Put stitch-specific delete actions alongside stitch editing. Label the actual scope: selected holes, holes on selected edges, or entire run(s), with counts. |
| 4 | High | Round has no dedicated panel. Exact radius is in the Selection panel and right-click point dialog; Round itself is drag-based. Browser confirms Round adds no panel. `index.html:98`, `index.html:190`, `app.js:2996`, `app.js:4605`. | Surface the existing numeric radius and apply action in Round as well as the selected-point inspector. Both entry points must use the same corner/geometry action. |
| 5 | High | Notch depth/style appear under generic Piece properties, including when unrelated tools are active. Notch has no panel. Settings apply to the whole piece, not only the selected notch. `app.js:730`, `app.js:4411`. | Show them in Notch and when inspecting a notch; explicitly label **All notches on this piece**. Preserve per-piece semantics. |
| 6 | Medium | Precisely locating a notch requires switching to Select, right-clicking an edge, inserting a point, then returning to Notch. Tooltip says “on an edge,” while placement snaps to nodes. `app.js:2351`, `index.html:54`, `index.html:80`. | Make the point-placement dependency visible in Notch, with a direct entry to the existing Divide edge action. Preserve node anchoring. |
| 7 | Medium | Pen's exact length/angle is only in a right-click dialog. Pen adds no sidebar panel. `index.html:105`, `app.js:2060` onward. | Expose those existing fields in the Pen panel while drafting; retain the context-menu shortcut. Do not invent unrelated Pen settings. |
| 8 | Medium | “Inset” means three different operations in three places: Offset→Guide line creates a mark, Piece→Inset copy makes another piece, Stitch→Inset positions cuts. `index.html:167`, `index.html:238`, `index.html:285`. | Keep the distinct operations, but name their result: **Offset edges**, **Create guide line**, **Inset duplicate**, **Stitch distance from edge**. Group Inset duplicate with other derived-piece operations or link it from Offset. |
| 9 | Medium | Fold creation/removal is under selected-edge controls; “Unfold now” is under Piece. Several tools reject folded pieces and refer users to the other panel. `app.js:812`, `app.js:4834`, `app.js:4848`, `app.js:3010`. | A discoverable Fold section for the selected piece, showing the fold edge and the existing create/remove/unfold actions with applicable-state guidance. |
| 10 | Medium | Export buttons are in the top bar, engraving settings in the sidebar, cloud save at its bottom, and local Save in the top bar. Browser-confirmed. `index.html:15`, `index.html:123`, `index.html:301`. | Group file operations in File/Save and put engraving options next to Export. Keep local/cloud destination explicit. |
| 11 | Medium | Grain creates/replaces by dragging, but a short click removes the existing grainline; there is no object panel or visible Remove action. `app.js:3529`, `app.js:1400`. | Show existing grainline state and a named Remove grainline action in Grain. Retain gesture behavior unless explicitly changed. |
| 12 | Medium | Weld and Knife rely on transient bottom-bar instructions for their multi-step state; Boolean and matched Stitch have panels but use that same distant status area for progress. `app.js:2394`, `app.js:2791`, `app.js:3223`. | Show current step/target and existing cancel action inside the active tool panel. Preserve immediate completion behavior; a new mandatory confirmation step is not proposed. |
| 13 | Medium | Help contradicts behavior: “Dashed line = cutting line (seam allowance)” although allowance is ignored; Stitch help describes only the older two-edge matched flow; “Inset” is not a toolbar tool. `index.html:320`, `dxf.js:213`. | Update tooltips, inline help, and keyboard guidance together with the layout. Say exactly which paths are CUT and MARK. |
| 14 | Medium | Long derived names span the canvas and obscure geometry; narrow flex rows split export help into columns and crowd compound inputs. Screenshot-confirmed. Piece-list eye/rename controls are clickable spans, and many visible labels are not associated with inputs. `app.js:653`, `style.css:163`, `style.css:194`. | Visually truncate canvas labels without renaming saved pieces; reserve full names for selection/hover. Use full-width prose and wrapping form rows, semantic buttons, and associated labels. |

## Selection and action scope

| ID | Priority | Current behavior and evidence | Design consequence |
|---|---|---|---|
| 15 | High | `sel`/`multiSel` drive generic editing, while `stitchMulti`/`stitchSideA` drive Stitch. Selecting an edge in Select does not populate Stitch targets. Stitch clicks do not update the generic selection, so generic properties can describe an older piece. `app.js:881`, `app.js:3246`, `app.js:4802`. | Explicitly distinguish the selected object from the current operation targets. Hide or clearly scope irrelevant generic actions. Selection transfer into Stitch must be deliberate and verified; simply moving HTML cannot fix this. |
| 16 | High | Two “Move by” rows can coexist: Piece moves the whole piece/group; Selection moves the point/edge/hole/cutout. Generic Piece→Delete removes the whole piece even when a child is selected. `app.js:744`, `app.js:4571`, `app.js:4802`. | Label object and scope directly: **Move selected edge** versus **Move whole piece**, **Delete piece** versus **Delete selected hole**. Prefer one prominent applicable action. |
| 17 | High | Group Move/Scale/Rotate act on all selected pieces, but sidebar Duplicate/Delete operate on only `selPiece()`. Keyboard duplicate/delete can act on the group. Copy/Cut also operate on containing pieces, even when a child is selected. `app.js:3773`, `app.js:3807`, `app.js:4419`, `app.js:4571`. | Show scope/count on every group action. Keep current semantics during pure relocation; normalizing button/shortcut behavior is a separate decision, not assumed. |
| 18 | Medium | Select marquee chooses holes only when it catches more holes than outline points; ties favor points. Stitch marquee gathers edges/guides/cutouts. `app.js:1470`, `app.js:3268`. | Superseded by Marvin’s correction: explicit hole boxes in Stitch Edit and an explicit target filter in Select. |
| 19 | High | Existing run editing is incomplete: angle is editable, but length/spacing/inset are creation inputs. Apply generates another run rather than editing one. Runs store per-hole geometry and a per-piece run number, with no persistent matched-side link. Guide targets ignore the general inset input. `app.js:3297`, `app.js:3393`, `app.js:3448`, `app.js:3473`. | Marvin approved existing-run editing. Distinguish create/update explicitly. Spacing changes require regeneration, not merely rearranging controls. Decide matched-side update scope before changing storage. Show guide-relative inset behavior rather than silently treating it as outline inset. |

## Physical output

| ID | Priority | Current behavior and evidence | Required change |
|---|---|---|---|
| 20 | High | Stitch holes have length/angle/offset but no width. `Geo.slitLine` returns two endpoints; both guide and outline/cutout export paths emit CUT lines. SVG uses the same shapes. `geometry.js:661`, `dxf.js:195`, `dxf.js:246`, `app.js:4071`. | Add physical slot width and export a closed cutting contour when width > 0. A thicker CSS/SVG display stroke alone does not change the DXF cutting path. Slot shape and width must match the iron; width is pending. |
| 21 | High | New Stitch defaults to inset 0, so a slit is centered on the outline. The UI advises approximately 0.3 cm but does not enforce a clearance. Placement checks the center, not the complete cut footprint. `index.html:286`, `app.js:3418`. | For paper templates, validate/show the whole slot against the outer boundary and internal cutouts. A wider slot needs sufficient material around it. The current input is a creation default, not evidence of the inset of Marvin's existing holes. Do not attribute the reported tearing to inset without measuring the actual pattern. |
| 22 | High | Hole creates a circle of radius 0.15 cm and exports it on MARK; its diameter is fixed at 3 mm and it has no settings panel. A cutout created through Boolean is instead on CUT. `app.js:2372`, `dxf.js:205`, `dxf.js:267`. | Marvin confirmed Hole must be a physical cutout. Put output purpose and diameter in Hole. Choose explicit compatibility behavior for existing MARK holes before changing their output; do not silently convert every old document. This is a functionality/output change, not a placement-only change. |

## Complete tool ownership map

| Tool | Existing controls / interactions | Proposed presentation |
|---|---|---|
| Select | Piece, point, handle, edge, cutout, notch, slit selection; transforms; shortcuts | Object inspector with an explicit type and scope. Tool-specific controls remain reachable here through the same inspector used by their tool. |
| Measure | Drag and read distance | Short tool instructions and measurement result; no invented settings. |
| Pen | Click/drag construction; right-click exact segment | New-segment length/angle and finish/close guidance. |
| Shape | Rectangle/ellipse dropdown; drag creation | Keep its existing settings at the top of the inspector. Exact width/height fields would be an additional feature, not a relocation. |
| Offset | Slide, protrude, guide; distance and apply | Existing modes with clear result names, scope, and guide-state explanation. |
| Round | Drag radius; numeric radius elsewhere | Shared corner/radius inspector. |
| Knife | Two points or open cut path | Current step and cancel; surface existing folded-piece restrictions. |
| Boolean | Operation dropdown; A/B picks | Operation plus explicit A/B state; keep existing geometry limitations. |
| Weld | Two matching edges | Selected first edge and next-step guidance; preserve geometry semantics. |
| Stitch | Creation settings and A/B state; editing/deletion elsewhere | New-run and existing-run contexts, same editing controls from Select. Preserve box behavior. Add actual slot width once specified. |
| Notch | Click node; per-piece depth/style elsewhere | Per-piece notch settings and access to precise point placement. |
| Hole | Click adds fixed-size MARK circle | Physical cutout controls per Marvin's requirement; existing-document compatibility must be explicit. |
| Grain | Drag create/replace, click remove | Existing grain state and visible named removal action. |

## Minimal implementation design

**Layout:** Keep the canvas, toolbar, and existing vanilla JavaScript. Reorder the sidebar so the active tool/object inspector is first. Make Pieces a bounded section rather than an unbounded preamble. Move Export options alongside Export and Cloud into the file controls. Use existing sections and handlers; no framework or generic inspector framework is needed.

**Shared ownership:** Stitch and selected-slit inspection should show one set of controls, with an explicit create/edit mode and scope. Apply the same principle to Round and Notch. Preserve Select as a way to discover/edit any object; do not require users to memorize a tool switch just to inspect a selected object.

**Code scope:** `index.html` owns panel structure/labels; `style.css` owns layout and responsive/readable rows; `js/app.js` owns visibility, tool transitions, selections, run editing, persistence and SVG rendering. Physical slot geometry belongs beside `slitLine` in `js/geometry.js`; `js/dxf.js` should use the shared contour for both guide and regular/cutout slit exports. SVG already consumes `DXF.pieceShapes`, so reuse that export route. Extend `test/core.test.js` with geometry/output behavior checks only when implementation starts.

**Slot geometry:** Preserve the current slit center, length, angle, normal/tangential offsets, and outline/cutout anchor. Add width in document units with a millimetre UI. Width 0 retains the existing single-line cut. Positive width produces a closed contour oriented along the existing slit. Do not silently widen legacy patterns. Canvas, selection indication, hit testing, bounds, DXF, and SVG must agree. Test copy, mirror, fold, weld, knife, rotate, and scale so width follows the intended physical sizing rule (current slit length stays fixed when scaling pieces).

**Run editing:** Updating length/angle/width can preserve individual hole locations; changing spacing requires recovering/storing a run definition and regenerating holes. Existing per-hole offsets include miter corrections and are not equivalent to one original inset setting. Preserve manually removed holes unless a regeneration action explicitly says it restores them. Matched runs currently have no persisted cross-piece pairing; ask how paired edits should work before designing that association. Do not infer a pair by matching local run numbers.

**Compatibility:** Hole-to-CUT changes and slot width must have explicit old-document behavior. Preserve imported mark circles where intended. A UI-only change must not change export geometry, selection scope, saved names, or legacy migration results.

## Verification and limits

Completed:

- Inspected source for all 13 tools, sidebar visibility, selection handlers, keyboard actions, stitch creation/edit/delete paths, shared geometry, and both exports.
- Switched through all 13 tools on the live build using tool buttons/shortcuts, checked panel headings/state, and restored Select. Did not draw, delete, save, export, or modify the user's pattern geometry.
- Visually confirmed that Stitch controls are below the viewport, the competing global panels, text wrapping, and canvas label clutter.
- Ran the existing baseline: `node test/core.test.js`, 73 passed. These establish a baseline only; they do not validate the proposed redesign or manufacturing fit.

Before claiming the overhaul complete:

- Browser checks with no selection, each selected object type, and multi-selection; active controls visible without scrolling; no stale target edits.
- Create and edit stitches on straight/curved outlines, guides, cutouts, and matched sides; compare counts/locations; deletion scopes; cancel/retry, undo/redo, save/reload.
- Verify legacy documents, fixed physical slit sizes under transforms, and independently inspect exported closed slot contours and Hole CUT layers in DXF and SVG.
- Check compact desktop layout, keyboard focus/labels, context-menu alternatives, and every existing tool shortcut.
- Verify build/cache identifiers and the deployed build. This static app has no production bundler to run, but deployment/cache checks are still outstanding.
- Cut a small calibration sample in the actual paper with the actual iron. No browser or geometry test establishes a tear-free physical fit.

No redesign implementation, modified-build browser E2E, deployment validation, or physical cutting test has been completed.

## Implementation outcome (build 62)

Tool-first inspectors, visible Pen/Round/Notch/Hole/Grain actions, File/Export menus, explicit box selection, linked new matched runs, adjustable physical stitch slots, and CUT circles implemented. Existing unlinked seams are not guessed. Whole-run regeneration explicitly restores gaps; deletion remains scoped to the selection/run.

Matched re-spacing uses original side A regardless of selected side. An amber notice reports unequal seam lengths before matching and while editing saved pairs. Browser verification: 200/100 mm pair reloaded and re-spaced from B at 4 mm produces 50/50 holes.
