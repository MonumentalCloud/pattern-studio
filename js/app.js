/* Pattern Studio — application (DOM, tools, rendering, persistence, export). */
/* global Geo, DXF */
(function () {
  'use strict';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const svg = $('canvas');
  const gPieces = $('layer-pieces');
  const gPreview = $('layer-preview');
  const gOverlay = $('layer-overlay');
  const gridMinor = $('grid-rect-minor');
  const gridMajor = $('grid-rect-major');
  const SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  const fmt = (v) => (Math.round(v * 100) / 100).toFixed(1);

  // ---------- document state ----------
  const STORAGE_KEY = 'patternStudioDoc.v1';
  const DOC_VERSION = 2; // 2: stitch slant is user-set (see migrateDoc)
  let doc = newDoc();
  let uidCounter = 1;

  function uid() { return 'p' + (uidCounter++) + '_' + Math.random().toString(36).slice(2, 7); }
  function newDoc() {
    return { version: DOC_VERSION, name: 'Untitled pattern', pieces: [] };
  }
  // ---------- piece names ----------
  // Derived names used to glue another word onto whatever was already there,
  // so a few operations left you with "Piece 1 copy copy (mirror) stitch line".
  // decorate() strips a repeat of the same suffix first and lets uniqueName
  // number it instead: copy, copy 2, copy 3.
  function uniqueName(want, skipId) {
    const taken = new Set(doc.pieces.filter((p) => p.id !== skipId).map((p) => p.name));
    if (!taken.has(want)) return want;
    for (let i = 2; i < 500; i++) if (!taken.has(want + ' ' + i)) return want + ' ' + i;
    return want;
  }
  function decorate(base, suffix, skipId) {
    const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const root = String(base || 'Piece')
      .replace(new RegExp('(?:\\s*' + esc + '(?:\\s+\\d+)?)+\\s*$', 'i'), '')
      .trim() || 'Piece';
    return uniqueName(root + ' ' + suffix, skipId);
  }

  // Builds 51-55 cut stitch holes at 135° instead of 45°, and the slant is
  // stored per hole, so patterns touched in that window kept the wrong one.
  // Fold it back ONCE, stamped by document version: the slant is user-set now,
  // so a deliberate 135 has to survive a reload.
  function migrateDoc(d) {
    if (!d) return d;
    if ((d.version || 1) < 2) {
      for (const p of d.pieces || []) {
        for (const sl of p.stitchSlits || []) {
          if (sl.ang === 135) sl.ang = 45;
          else if (sl.ang === -135) sl.ang = -45;
        }
      }
    }
    d.version = DOC_VERSION;
    return d;
  }

  function newPiece(nodes, closed) {
    return {
      id: uid(),
      name: uniqueName('Piece ' + (doc.pieces.length + 1)),
      visible: true,
      seamAllowance: 0, // the drawn outline IS the cutting line
      notchLength: 0.4,
      path: { closed: !!closed, nodes },
      notches: [],
      holes: [],
      stitchSlits: [],
      grain: null,
      foldSeg: null,
    };
  }
  function pieceById(id) { return doc.pieces.find((p) => p.id === id) || null; }
  // folded pieces store only one half — this resolves the full outline
  function isFolded(p) { return p.foldSeg != null && p.path.closed && p.foldSeg < p.path.nodes.length; }
  function effPiece(p) { return isFolded(p) ? DXF.unfoldPiece(p) : p; }

  // ---------- undo / redo ----------
  const undoStack = [];
  const redoStack = [];
  let pendingSnapshot = null;
  let nudgeTimer = null; // coalesces bursts of arrow-key moves into one undo step

  function beginChange() {
    if (nudgeTimer) { // a nudge burst is open — close it before the new change
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
      endChange();
    }
    pendingSnapshot = JSON.stringify(doc);
  }
  function endChange() {
    if (pendingSnapshot === null) return;
    const now = JSON.stringify(doc);
    if (now !== pendingSnapshot) {
      undoStack.push(pendingSnapshot);
      if (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
      autosave();
    }
    pendingSnapshot = null;
    updateUndoButtons();
  }
  function applySnapshot(json) {
    doc = JSON.parse(json);
    // selection may point at removed things
    if (sel.pieceId && !pieceById(sel.pieceId)) clearSel();
    else { sel.kind = null; sel.handle = null; }
    autosave();
    renderAll();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(doc));
    applySnapshot(undoStack.pop());
    updateUndoButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(doc));
    applySnapshot(redoStack.pop());
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('btn-undo').disabled = !undoStack.length;
    $('btn-redo').disabled = !redoStack.length;
  }
  function autosave() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch (e) { /* quota */ }
  }

  // ---------- view (pan / zoom) ----------
  const view = { x: -5, y: -5, scale: 12 }; // world top-left (cm), px per cm

  function viewBox() {
    const r = svg.getBoundingClientRect();
    return { x: view.x, y: view.y, w: r.width / view.scale, h: r.height / view.scale };
  }
  function applyView() {
    const vb = viewBox();
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    for (const rect of [gridMinor, gridMajor]) {
      // align rect to grid so pattern tiles stay put
      const gx = Math.floor(vb.x / 5) * 5, gy = Math.floor(vb.y / 5) * 5;
      rect.setAttribute('x', gx); rect.setAttribute('y', gy);
      rect.setAttribute('width', vb.w + 10); rect.setAttribute('height', vb.h + 10);
    }
    $('status-zoom').textContent = Math.round(view.scale / 12 * 100) + '%';
    renderAll(true); // sizes of nodes/labels depend on scale
  }
  function screenToWorld(ev) {
    const r = svg.getBoundingClientRect();
    return { x: view.x + (ev.clientX - r.left) / view.scale, y: view.y + (ev.clientY - r.top) / view.scale };
  }
  const px = (v) => v / view.scale; // screen px -> world cm at current zoom

  function zoomAt(factor, cx, cy) {
    const ns = Math.min(400, Math.max(1.5, view.scale * factor));
    const f = view.scale / ns;
    view.x = cx - (cx - view.x) * f;
    view.y = cy - (cy - view.y) * f;
    view.scale = ns;
    applyView();
  }
  function zoomFit() {
    const pts = [];
    for (const p of doc.pieces) {
      if (p.visible === false) continue;
      const ep = effPiece(p);
      pts.push(...Geo.pathPolyline(ep.path.nodes, ep.path.closed, 0.1));
    }
    const r = svg.getBoundingClientRect();
    if (!pts.length) { view.x = -5; view.y = -5; view.scale = 12; applyView(); return; }
    const bb = Geo.bbox(pts);
    const m = 4; // cm margin
    const w = bb.maxX - bb.minX + 2 * m, h = bb.maxY - bb.minY + 2 * m;
    view.scale = Math.min(400, Math.max(1.5, Math.min(r.width / w, r.height / h)));
    view.x = bb.minX - m - (r.width / view.scale - w) / 2;
    view.y = bb.minY - m - (r.height / view.scale - h) / 2;
    applyView();
  }

  // ---------- selection ----------
  // sel.handle: the curve handle last picked up, as { idx, key }. A handle is
  // not a selection of its own — sel.kind stays 'node' — so without this Del
  // would fall through to the point and delete the whole thing.
  const sel = { pieceId: null, kind: null, idx: -1, nodes: [], handle: null };
  let multiSel = []; // piece ids from a marquee selection (moves/deletes as a group)
  function clearSel() { delete sel.slitGroups; sel.pieceId = null; sel.kind = null; sel.idx = -1; sel.nodes = []; sel.handle = null; multiSel = []; }
  function selectPiece(id) { delete sel.slitGroups; sel.pieceId = id; sel.kind = null; sel.idx = -1; sel.nodes = []; sel.handle = null; multiSel = []; }
  const selPiece = () => (sel.pieceId ? pieceById(sel.pieceId) : null);

  // ---------- snapping ----------
  function snapStep() { return parseFloat($('sel-grid').value) || 0.5; }
  function snapOn() { return $('chk-snap').checked; }
  let alignGuides = []; // transient dashed lines while a snap lines up with far points
  let snapMarks = []; // transient markers for a snap that isn't on a drawn point

  function snap(p, skipPieceId, skipNodeIdx) {
    alignGuides = [];
    snapMarks = [];
    // priority: existing points, then edge middles, then points anywhere along
    // other outlines, then orthogonal alignment with other points, then grid.
    // candidate points: outline nodes, cutout corners and — while the pen is
    // drafting — the draft's own placed points (so a path can close square)
    const pts = [];
    const mids = [];
    // an edge touching the point being dragged has no fixed middle — it moves
    // with the drag, so it would chase the cursor instead of anchoring it
    const midsOf = (nodes, closed, skipIdx) => {
      const n = nodes.length;
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        if (skipIdx != null && (i === skipIdx || (i + 1) % n === skipIdx)) continue;
        mids.push(Geo.segMidpoint(nodes[i], nodes[(i + 1) % n]));
      }
    };
    for (const piece of doc.pieces) {
      if (piece.visible === false) continue;
      const own = piece.id === skipPieceId;
      piece.path.nodes.forEach((n, i) => {
        if (own && i === skipNodeIdx) return;
        pts.push(n);
      });
      midsOf(piece.path.nodes, piece.path.closed, own ? skipNodeIdx : null);
      for (const c of piece.cutouts || []) {
        for (const n of c.nodes) pts.push(n);
        if (c.nodes && c.nodes.length > 1) midsOf(c.nodes, true, null);
      }
    }
    const draftPts = draft && draft.nodes ? draft.nodes : [];
    // the draft's own edges get middles too, but not the rubber-band segment
    if (draftPts.length > 2) midsOf(draftPts.slice(0, -1), false, null);
    const tol = px(9);
    let best = null, bd = tol;
    for (const n of pts) {
      const d = Geo.dist(n, p);
      if (d < bd) { bd = d; best = { x: n.x, y: n.y }; }
    }
    // the draft's last point is the rubber-band anchor — snapping ONTO it
    // would pin the preview, but aligning with it (below) is the useful part
    for (const n of draftPts.slice(0, -1)) {
      const d = Geo.dist(n, p);
      if (d < bd) { bd = d; best = { x: n.x, y: n.y }; }
    }
    if (best) return best;
    // edge middles: a tier below real points, so a corner always wins over the
    // middle of the edge leading to it
    let bestM = null, bm = px(8);
    for (const n of mids) {
      const d = Geo.dist(n, p);
      if (d < bm) { bm = d; bestM = n; }
    }
    if (bestM) {
      snapMarks.push({ x: bestM.x, y: bestM.y });
      return { x: bestM.x, y: bestM.y };
    }
    // on-curve snap: project onto the nearest outline (never the edited piece's own)
    let bestE = null, be = px(7);
    for (const piece of doc.pieces) {
      if (piece.visible === false || piece.id === skipPieceId || piece.path.nodes.length < 2) continue;
      const hit = Geo.nearestOnPath(piece.path.nodes, piece.path.closed, p);
      if (hit && hit.dist < be) { be = hit.dist; bestE = hit.point; }
      for (const c of piece.cutouts || []) {
        if (!c.nodes || c.nodes.length < 3) continue;
        const h2 = Geo.nearestOnPath(c.nodes, true, p);
        if (h2 && h2.dist < be) { be = h2.dist; bestE = h2.point; }
      }
    }
    if (bestE) return { x: bestE.x, y: bestE.y };
    // orthogonal alignment: same x / same y as any point on the canvas,
    // each axis independently (a dashed guide shows the reference point)
    const at = px(6);
    let ax = null, adx = at, ay = null, ady = at;
    for (const n of pts.concat(draftPts, mids)) {
      const dx = Math.abs(n.x - p.x), dy = Math.abs(n.y - p.y);
      if (dx < adx) { adx = dx; ax = n; }
      if (dy < ady) { ady = dy; ay = n; }
    }
    const out = { x: ax ? ax.x : p.x, y: ay ? ay.y : p.y };
    if ((!ax || !ay) && snapOn()) {
      const s = snapStep();
      if (!ax) out.x = Math.round(out.x / s) * s;
      if (!ay) out.y = Math.round(out.y / s) * s;
    }
    if (ax) alignGuides.push({ x1: ax.x, y1: ax.y, x2: out.x, y2: out.y });
    if (ay && ay !== ax) alignGuides.push({ x1: ay.x, y1: ay.y, x2: out.x, y2: out.y });
    return out;
  }

  // where a slit lives: the piece outline, or one of its internal cutouts
  // (sl.cut). For cutouts the outward sign flips, so a positive Inset pushes
  // the hole INTO the material — away from the hole's edge.
  function slitContext(piece, sl) {
    if (sl.cut != null) {
      const c = (piece.cutouts || [])[sl.cut];
      if (!c || !c.nodes || sl.seg >= c.nodes.length) return null;
      return { nodes: c.nodes, outS: -Geo.outwardSign(Geo.pathPolyline(c.nodes, true, 0.1)) };
    }
    if (sl.seg >= piece.path.nodes.length) return null;
    return {
      nodes: piece.path.nodes,
      outS: piece.path.closed ? Geo.outwardSign(Geo.pathPolyline(piece.path.nodes, true, 0.1)) : 1,
    };
  }
  function slitLineFor(piece, sl) {
    const ctx = slitContext(piece, sl);
    if (!ctx) return null;
    return Geo.slitLine(ctx.nodes[sl.seg], ctx.nodes[(sl.seg + 1) % ctx.nodes.length], sl, ctx.outS);
  }

  function drawAlignGuides(group) {
    for (const g2 of alignGuides) {
      el('line', { class: 'align-guide', x1: g2.x1, y1: g2.y1, x2: g2.x2, y2: g2.y2 }, group);
      el('circle', { class: 'snap-dot', cx: g2.x1, cy: g2.y1, r: px(4) }, group);
    }
    // caught the middle of an edge — a diamond, so it reads differently from
    // landing at some arbitrary point along the curve
    for (const m of snapMarks) {
      const r = px(5);
      el('polygon', {
        class: 'snap-mid',
        points: `${m.x},${m.y - r} ${m.x + r},${m.y} ${m.x},${m.y + r} ${m.x - r},${m.y}`,
      }, group);
    }
  }

  // ---------- rendering ----------
  function pathD(nodes, closed) {
    const n = nodes.length;
    if (!n) return '';
    let d = `M ${nodes[0].x} ${nodes[0].y}`;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = nodes[i], b = nodes[(i + 1) % n];
      if (Geo.segIsLine(a, b)) d += ` L ${b.x} ${b.y}`;
      else {
        const { c1, c2 } = Geo.segCtrl(a, b);
        d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
      }
    }
    if (closed) d += ' Z';
    return d;
  }
  function polyD(pts, closed) {
    if (!pts.length) return '';
    return 'M ' + pts.map((p) => `${p.x} ${p.y}`).join(' L ') + (closed ? ' Z' : '');
  }
  function segD(a, b) {
    if (Geo.segIsLine(a, b)) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    const { c1, c2 } = Geo.segCtrl(a, b);
    return `M ${a.x} ${a.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
  }

  function renderPieces() {
    clear(gPieces);
    for (const piece of doc.pieces) {
      if (piece.visible === false) continue;
      const g = el('g', {
        class: 'piece' + (piece.id === sel.pieceId || multiSel.includes(piece.id) ? ' selected' : ''),
        'data-id': piece.id,
      }, gPieces);
      // guide pieces (inset stitch lines): dashed marking + slits, nothing else
      if (piece.guide) {
        const gn = piece.path.nodes;
        if (gn.length < 2) continue;
        el('path', { class: 'piece-guide', d: pathD(gn, piece.path.closed) }, g);
        const gS = piece.path.closed ? Geo.outwardSign(Geo.pathPolyline(gn, true, 0.1)) : 1;
        for (const sl of piece.stitchSlits || []) {
          if (sl.seg >= gn.length) continue;
          const ln = Geo.slitLine(gn[sl.seg], gn[(sl.seg + 1) % gn.length], sl, gS);
          const pts = Geo.slitContour(ln, sl.width);
          el('path', { class: 'piece-slit', d: polyD(pts, pts.length > 2) }, g);
        }
        continue;
      }
      // rp = full geometry (folded pieces resolve to their unfolded outline)
      const rp = effPiece(piece);
      const folded = rp !== piece;
      const nodes = rp.path.nodes;
      const closed = rp.path.closed;
      if (nodes.length < 2) continue;

      let seamPts = null;
      if (closed) seamPts = Geo.dedupe(Geo.pathPolyline(nodes, closed, 0.05));

      // main outline
      if (folded) {
        // fill the whole unfolded shape; solid stroke on the drafted half,
        // dimmed stroke on the mirrored half, dash-dot on the fold itself
        el('path', { class: 'piece-fill nostroke', d: pathD(nodes, true) }, g);
        const rn = piece.path.nodes, n0 = rn.length, f = piece.foldSeg;
        const half = [];
        for (let k = 0; k < n0; k++) half.push(rn[(f + 1 + k) % n0]);
        el('path', { class: 'piece-fill open', d: pathD(half, false) }, g);
        const msub = nodes.slice(n0 - 1).concat([nodes[0]]);
        el('path', { class: 'piece-mirror', d: pathD(msub, false) }, g);
        el('line', {
          class: 'piece-fold',
          x1: rn[f].x, y1: rn[f].y, x2: rn[(f + 1) % n0].x, y2: rn[(f + 1) % n0].y,
        }, g);
      } else {
        el('path', { class: 'piece-fill' + (closed ? '' : ' open'), d: pathD(nodes, closed) }, g);
      }

      // notches: real cuts from the outline into the piece (slit or V)
      if (closed && seamPts && (rp.notches || []).length) {
        const s = Geo.outwardSign(seamPts);
        const nl = piece.notchLength || 0.4;
        for (const nt of rp.notches) {
          if (nt.seg >= nodes.length) continue;
          for (const ln of Geo.notchLinesPath(nodes, closed, nt, s, nl, piece.notchStyle)) {
            el('line', { class: 'piece-notch', x1: ln.a.x, y1: ln.a.y, x2: ln.b.x, y2: ln.b.y }, g);
          }
        }
      }

      // stitching slits (outline runs and internal-cutout runs)
      if ((rp.stitchSlits || []).length) {
        const outS = closed && seamPts && seamPts.length > 2 ? Geo.outwardSign(seamPts) : 1;
        const cutS = {}; // outward sign per cutout, cached
        for (const sl of rp.stitchSlits) {
          let ln;
          if (sl.cut != null) {
            const c = (rp.cutouts || [])[sl.cut];
            if (!c || sl.seg >= c.nodes.length) continue;
            if (cutS[sl.cut] === undefined) {
              cutS[sl.cut] = -Geo.outwardSign(Geo.pathPolyline(c.nodes, true, 0.1));
            }
            ln = Geo.slitLine(c.nodes[sl.seg], c.nodes[(sl.seg + 1) % c.nodes.length], sl, cutS[sl.cut]);
          } else {
            if (sl.seg >= nodes.length) continue;
            ln = Geo.slitLine(nodes[sl.seg], nodes[(sl.seg + 1) % nodes.length], sl, outS);
          }
          const pts = Geo.slitContour(ln, sl.width);
          el('path', { class: 'piece-slit', d: polyD(pts, pts.length > 2) }, g);
        }
      }

      // internal cutouts — real cut lines, drawn like the outline
      for (const c of rp.cutouts || []) {
        if (c.nodes && c.nodes.length > 2) el('path', { class: 'piece-cutout', d: pathD(c.nodes, true) }, g);
      }

      // holes
      for (const h of rp.holes || []) {
        el('circle', { class: 'piece-hole', cx: h.x, cy: h.y, r: h.r || 0.15 }, g);
        el('line', { class: 'piece-hole', x1: h.x - 0.25, y1: h.y, x2: h.x + 0.25, y2: h.y }, g);
        el('line', { class: 'piece-hole', x1: h.x, y1: h.y - 0.25, x2: h.x, y2: h.y + 0.25 }, g);
      }

      // grainline
      if (piece.grain) {
        const gn = piece.grain;
        const a = { x: gn.x1, y: gn.y1 }, b = { x: gn.x2, y: gn.y2 };
        const d = Geo.norm(Geo.sub(b, a));
        let arrows = '';
        if (d.x || d.y) {
          const side = { x: -d.y, y: d.x };
          const wing = (p, dir) => {
            const q1 = Geo.add(p, Geo.add(Geo.scale(dir, -0.8), Geo.scale(side, 0.35)));
            const q2 = Geo.add(p, Geo.add(Geo.scale(dir, -0.8), Geo.scale(side, -0.35)));
            return ` M ${q1.x} ${q1.y} L ${p.x} ${p.y} L ${q2.x} ${q2.y}`;
          };
          arrows = wing(b, d) + wing(a, Geo.scale(d, -1));
        }
        el('path', { class: 'piece-grain', d: `M ${a.x} ${a.y} L ${b.x} ${b.y}` + arrows }, g);
      }

      // label
      if (closed && seamPts && seamPts.length > 2) {
        const c = Geo.labelBox(seamPts); // same anchor the engraved name uses
        el('text', {
          class: 'piece-label', x: c.x, y: c.y,
          'font-size': px(13), 'text-anchor': 'middle',
        }, g).textContent = piece.name.length > 30 ? piece.name.slice(0, 27) + '…' : piece.name;
      }
    }
  }

  function renderOverlay() {
    clear(gOverlay);
    drawAlignGuides(gOverlay);
    // first edge picked with the weld / stitch tool
    const stitchTargetD = (tp, tg) => {
      if (tg.cut != null) {
        const c = (tp.cutouts || [])[tg.cut];
        return c && c.nodes.length > 2 ? pathD(c.nodes, true) : null;
      }
      if (tp.guide) return pathD(tp.path.nodes, tp.path.closed);
      if (tg.seg >= tp.path.nodes.length) return null;
      const tn = tp.path.nodes;
      return segD(tn[tg.seg], tn[(tg.seg + 1) % tn.length]);
    };
    if (tool === 'weld' && weldFirst) {
      const wp = pieceById(weldFirst.pieceId);
      const d = wp && stitchTargetD(wp, weldFirst);
      if (d) el('path', { class: 'seg-highlight weld', d }, gOverlay);
    }
    if (tool === 'stitch') {
      // confirmed side A in dashed orange, the in-progress selection solid
      for (const tg of stitchSideA || []) {
        const tp = pieceById(tg.pieceId);
        const d = tp && stitchTargetD(tp, tg);
        if (d) el('path', { class: 'seg-highlight weld', d }, gOverlay);
      }
      for (const tg of stitchMulti) {
        const tp = pieceById(tg.pieceId);
        const d = tp && stitchTargetD(tp, tg);
        if (d) el('path', { class: 'seg-highlight', d }, gOverlay);
      }
    }
    // scale handles around the selected piece / marquee group
    if (tool === 'select') {
      const scIds = scaleTargets();
      if (scIds.length) {
        const sh = scaleHandles(scIds);
        if (sh) {
          el('rect', {
            class: 'scale-box',
            x: sh.bb.minX, y: sh.bb.minY,
            width: sh.bb.maxX - sh.bb.minX, height: sh.bb.maxY - sh.bb.minY,
          }, gOverlay);
          const r2 = px(4.5);
          for (const c of sh.corners) {
            el('rect', {
              class: 'scale-handle',
              x: c.x - r2, y: c.y - r2, width: 2 * r2, height: 2 * r2,
            }, gOverlay);
          }
          el('line', {
            class: 'scale-box',
            x1: sh.rot.x, y1: sh.bb.minY, x2: sh.rot.x, y2: sh.rot.y,
          }, gOverlay);
          el('circle', { class: 'rotate-handle', cx: sh.rot.x, cy: sh.rot.y, r: px(5) }, gOverlay);
        }
      }
    }
    if (multiSel.length > 1) return; // group selection: no per-node overlay
    const piece = selPiece();
    if (!piece || tool === 'pen') return;
    const nodes = piece.path.nodes;
    const n = nodes.length;
    const r = px(4);

    // multi-edge selection highlight
    if (sel.kind === 'segs') {
      for (const i of sel.segs) {
        if (i >= (piece.path.closed ? n : n - 1)) continue;
        el('path', { class: 'seg-highlight', d: segD(nodes[i], nodes[(i + 1) % n]) }, gOverlay);
      }
    }

    // selected segment highlight + length
    if (sel.kind === 'seg' && sel.idx < (piece.path.closed ? n : n - 1)) {
      const a = nodes[sel.idx], b = nodes[(sel.idx + 1) % n];
      el('path', { class: 'seg-highlight', d: segD(a, b) }, gOverlay);
      el('circle', { class: 'seg-start-dot', cx: a.x, cy: a.y, r: px(3) }, gOverlay);
      const mid = Geo.segPoint(a, b, 0.5);
      el('text', {
        class: 'seg-len-text', x: mid.x, y: mid.y - px(8),
        'font-size': px(12), 'text-anchor': 'middle',
      }, gOverlay).textContent = fmt(Geo.segLength(a, b)) + ' cm';
    }

    // handles for the selected node (and its neighbours' facing handles)
    if (sel.kind === 'node' && sel.idx < n) {
      for (const item of handleTargets(piece)) {
        const far = item.own ? '' : ' far';
        const held = sel.handle && sel.handle.idx === item.idx && sel.handle.key === item.key;
        el('line', {
          class: 'handle-line' + far,
          x1: item.node.x, y1: item.node.y, x2: item.p.x, y2: item.p.y,
        }, gOverlay);
        // the handle in hand is ringed: it is what Del removes
        if (held) el('circle', { class: 'handle-held', cx: item.p.x, cy: item.p.y, r: px(7.5) }, gOverlay);
        el('circle', {
          class: 'handle-dot' + far, cx: item.p.x, cy: item.p.y, r: px(4.5),
          'data-role': 'handle', 'data-idx': item.idx, 'data-key': item.key,
        }, gOverlay);
      }
    }

    // selected internal cutout
    if (sel.kind === 'cut') {
      const c = (piece.cutouts || [])[sel.idx];
      if (c && c.nodes.length > 2) el('path', { class: 'seg-highlight', d: pathD(c.nodes, true) }, gOverlay);
    }

    // selected stitch holes (single or set)
    if (sel.kind === 'slit' || (sel.kind === 'slits' && sel.slits)) {
      for (const group of selectedStitchHoles()) for (const i of group.indices) {
        const sl2 = (group.piece.stitchSlits || [])[i];
        const ln = sl2 && slitLineFor(group.piece, sl2);
        if (!ln) continue;
        const c = Geo.lerp(ln.a, ln.b, 0.5);
        el('circle', { class: 'snap-dot', cx: c.x, cy: c.y, r: px(5) }, gOverlay);
      }
    }

    // nodes
    nodes.forEach((nd, i) => {
      const isSel = (sel.kind === 'node' && sel.idx === i) ||
        (sel.kind === 'nodes' && sel.nodes.includes(i));
      el('rect', {
        class: 'node' + (isSel ? ' selected' : ''),
        x: nd.x - r, y: nd.y - r, width: 2 * r, height: 2 * r,
        'data-role': 'node', 'data-idx': i,
      }, gOverlay);
    });
  }

  function renderAll(keepList) {
    renderPieces();
    renderOverlay();
    renderPenPreview();
    if (!keepList) renderSidebar();
  }

  // ---------- sidebar ----------
  let renamingId = null; // piece whose name is being edited inline in the list
  // Selecting a piece rebuilds the whole list, so the second click of a
  // double-click lands on a freshly created node and the browser never fires
  // dblclick. Pair the clicks ourselves instead — this survives the rebuild.
  let lastRowClick = { id: null, t: 0 };

  // a typed name is taken as typed — uniqueName only tidies generated ones
  function commitRename(piece, raw) {
    if (renamingId !== piece.id) return;
    renamingId = null;
    const name = String(raw || '').trim();
    if (name && name !== piece.name) {
      beginChange();
      piece.name = name;
      endChange();
    }
    renderAll();
  }

  function renderSidebar() {
    const list = $('piece-list');
    clear(list);
    if (!doc.pieces.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No pieces yet — use the Pen tool';
      list.appendChild(li);
    }
    for (const piece of doc.pieces) {
      const li = document.createElement('li');
      if (piece.id === sel.pieceId || multiSel.includes(piece.id)) li.classList.add('selected');
      const eye = document.createElement('button');
      eye.className = 'eye' + (piece.visible === false ? ' off' : '');
      eye.textContent = '👁';
      eye.title = 'Show / hide ' + piece.name;
      eye.setAttribute('aria-label', eye.title);
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        beginChange();
        piece.visible = piece.visible === false;
        endChange();
        renderAll();
      });
      const ln = document.createElement('span');
      ln.className = 'len';
      const ep = effPiece(piece);
      ln.textContent = fmt(Geo.pathLength(ep.path.nodes, ep.path.closed)) + ' cm';
      if (renamingId === piece.id) {
        // rename in place — the list survives re-renders because renamingId,
        // not the DOM, is what remembers the edit is open
        const inp = document.createElement('input');
        inp.className = 'nm-edit';
        inp.type = 'text';
        inp.value = piece.name;
        const stop = (e) => e.stopPropagation();
        inp.addEventListener('click', stop);
        inp.addEventListener('dblclick', stop);
        inp.addEventListener('pointerdown', stop);
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { inp.blur(); }
          else if (e.key === 'Escape') { renamingId = null; renderSidebar(); }
        });
        inp.addEventListener('blur', () => commitRename(piece, inp.value));
        li.append(eye, inp, ln);
        list.appendChild(li);
        // focus once it is actually in the document
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        continue;
      }
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = piece.name;
      nm.title = piece.name + ' — double-click (or the ✎) to rename';
      const ren = document.createElement('button');
      ren.className = 'ren';
      ren.textContent = '✎';
      ren.title = 'Rename ' + piece.name;
      ren.setAttribute('aria-label', ren.title);
      ren.addEventListener('click', (e) => {
        e.stopPropagation();
        renamingId = piece.id;
        renderSidebar();
      });
      li.append(eye, nm, ren, ln);
      li.addEventListener('click', () => {
        const now = Date.now();
        const again = lastRowClick.id === piece.id && now - lastRowClick.t < 500;
        lastRowClick = again ? { id: null, t: 0 } : { id: piece.id, t: now };
        if (again) renamingId = piece.id;
        selectPiece(piece.id);
        renderAll();
      });
      list.appendChild(li);
    }

    // piece props
    const piece = selPiece();
    $('piece-props').hidden = !piece;
    if (piece) {
      $('pp-name').value = piece.name;
      $('pp-notch').value = piece.notchLength || 0.4;
      $('pp-notch-style').value = piece.notchStyle || 'slit';
      const ep = effPiece(piece);
      $('pp-perim').textContent = fmt(Geo.pathLength(ep.path.nodes, ep.path.closed)) + ' cm' +
        (isFolded(piece) ? ' (unfolded)' : '');
      $('pp-bake').hidden = !isFolded(piece);
    }

    // selection props
    const showNode = piece && sel.kind === 'node' && piece.path.nodes[sel.idx];
    const showSeg = piece && sel.kind === 'seg';
    const showSegs = piece && sel.kind === 'segs' && sel.segs && sel.segs.length > 0;
    const cutSel = piece && sel.kind === 'cut' && (piece.cutouts || [])[sel.idx];
    const showMove = piece && (showNode || showSeg || showSegs || sel.kind === 'hole' || cutSel ||
      (sel.kind === 'nodes' && sel.nodes.length > 0));
    const slitSel = piece && sel.kind === 'slit' && (piece.stitchSlits || [])[sel.idx];
    const slitsSel = piece && sel.kind === 'slits' && sel.slits && sel.slits.length > 0;
    $('sel-props').hidden = !(showNode || showSeg || showSegs || showMove || slitSel || slitsSel);
    $('sel-del-run-row').hidden = !(slitSel || slitsSel);
    $('sel-slit-ang-row').hidden = !(slitSel || slitsSel);
    $('sel-slit-ang-ref-row').hidden = !(slitSel || slitsSel);
    $('sel-slit-ang-btns').hidden = !(slitSel || slitsSel);
    {
      const shown = slitSel || (slitsSel ? piece.stitchSlits[sel.slits[0]] : null);
      if (shown) {
        if (document.activeElement !== $('sp-slit-ang-ref')) {
          $('sp-slit-ang-ref').value = shown.abs ? 'page' : 'edge';
        }
        $('sp-slit-ang-eg').textContent =
          angLabel(shown.ang == null ? 45 : shown.ang, !!shown.abs);
      }
    }
    if (slitSel) {
      const runOf = (sl) => (slitSel.run != null ? sl.run === slitSel.run : (sl.seg === slitSel.seg && sl.cut === slitSel.cut));
      const count = piece.stitchSlits.filter(runOf).length;
      $('sp-del-run').textContent = 'Delete selected hole';
      if (document.activeElement !== $('sp-slit-ang')) {
        $('sp-slit-ang').value = slitSel.ang == null ? 45 : slitSel.ang;
      }
      $('sel-hint').textContent = 'One hole of a stitch line — ' + (slitSel.abs
        ? 'its slant is measured from the page, so every hole set this way stays parallel (0 = horizontal, 90 = vertical)'
        : 'its slant is measured from the edge it sits on, so ±45 are the two diagonals and the direction turns with the outline')
        + ' · Del removes just this hole; the button removes the whole line. Shift-click or drag a box to gather several holes.';
    } else if (slitsSel) {
      $('sp-del-run').textContent = `Delete ${sel.slits.length} stitch holes`;
      if (document.activeElement !== $('sp-slit-ang')) {
        const first = piece.stitchSlits[sel.slits[0]];
        $('sp-slit-ang').value = first ? (first.ang == null ? 45 : first.ang) : 45;
      }
      $('sel-hint').textContent =
        `${sel.slits.length} stitch holes selected — set their slant above, or Del (or the button) removes them · Shift-click holes to add/remove · drag a box over more.`;
    }
    $('sel-node-row').hidden = !showNode;
    $('sel-round-row').hidden = !showNode;
    $('sel-handle-row').hidden = true;
    $('sel-seg-row').hidden = !showSeg;
    $('sel-seg-anchor-row').hidden = !showSeg;
    $('sel-move-row').hidden = !showMove;
    $('sel-fold-row').hidden = !showSeg;
    $('sel-clear-slits-row').hidden = true;
    if (showNode) {
      const nd = piece.path.nodes[sel.idx];
      if (document.activeElement !== $('sp-x')) $('sp-x').value = fmt(nd.x);
      if (document.activeElement !== $('sp-y')) $('sp-y').value = fmt(nd.y);
      $('sel-handle-row').hidden = !(nd.hin || nd.hout);
      $('sp-del-hin').disabled = !nd.hin;
      $('sp-del-hout').disabled = !nd.hout;
      const near = handleTargets(piece);
      $('sel-hint').textContent = sel.handle
        ? 'Handle in hand (ringed) — Del removes just this handle, not the point · drag it to reshape the curve, or drop it on its point to delete it.'
        : (near.length
          ? 'Drag the point again to move it · click a handle then Del, or double-click it, to delete just that handle — hollow handles belong to the next point along and bend the same edge.'
          : 'Drag the point again to move it · double-click it to toggle corner / smooth · Del removes the point.');
    } else if (showSeg) {
      const n = piece.path.nodes.length;
      const a = piece.path.nodes[sel.idx], b = piece.path.nodes[(sel.idx + 1) % n];
      if (document.activeElement !== $('sp-seglen')) {
        $('sp-seglen').value = fmt(Geo.segLength(a, b));
      }
      $('sel-fold-row').hidden = !piece.path.closed || !!piece.guide;
      $('sp-fold').textContent = piece.foldSeg === sel.idx ? 'Remove fold line' : 'Make fold line';
      // guides carry one run over the whole path — the button clears all of it
      const slitCount = piece.guide
        ? (piece.stitchSlits || []).length
        : (piece.stitchSlits || []).filter((sl) => sl.cut == null && sl.seg === sel.idx).length;
      $('sel-clear-slits-row').hidden = !slitCount;
      if (slitCount) $('sp-clear-slits').textContent = `Remove ${slitCount} stitch hole${slitCount > 1 ? 's' : ''}`;
      // ...and the whole stitch line(s) touching this edge, corners included
      if (slitCount) {
        const onEdge = (s2) => piece.guide || (s2.cut == null && s2.seg === sel.idx);
        const runsHere = new Set((piece.stitchSlits || []).filter(onEdge).map((s2) => s2.run).filter((r) => r != null));
        const runTotal = (piece.stitchSlits || []).filter((s2) =>
          (s2.run != null ? runsHere.has(s2.run) : onEdge(s2))).length;
        $('sel-del-run-row').hidden = false;
        $('sp-del-run').textContent = `Delete stitch line (${runTotal} hole${runTotal > 1 ? 's' : ''})`;
      }
      $('sel-hint').textContent = piece.foldSeg === sel.idx
        ? 'This edge is the fold — the piece unfolds across it on export.'
        : 'Drag the edge again to move it · type a length to resize (● = start) · double-click inserts a point · right-click divides · the Offset tool (O) slides/protrudes it along its normal.';
    } else if (showSegs) {
      $('sel-hint').textContent = tool === 'offset'
        ? `${sel.segs.length} edges selected — drag one to apply the mode live, or type a distance and Apply.`
        : `${sel.segs.length} edges selected — drag one (or arrows / Move by) to move them together · Shift-click adds/removes · the Offset tool (O) slides/protrudes the set.`;
      // stitch holes across ALL selected edges delete together
      const inSel = (s2) => piece.guide || (s2.cut == null && sel.segs.includes(s2.seg));
      const slitCount = (piece.stitchSlits || []).filter(inSel).length;
      $('sel-clear-slits-row').hidden = !slitCount;
      if (slitCount) {
        $('sp-clear-slits').textContent = `Remove ${slitCount} stitch hole${slitCount > 1 ? 's' : ''}`;
        const runsHere = new Set((piece.stitchSlits || []).filter(inSel).map((s2) => s2.run).filter((r) => r != null));
        const runTotal = (piece.stitchSlits || []).filter((s2) =>
          (s2.run != null ? runsHere.has(s2.run) : inSel(s2))).length;
        $('sel-del-run-row').hidden = false;
        $('sp-del-run').textContent =
          `Delete stitch line${runsHere.size > 1 ? 's' : ''} (${runTotal} hole${runTotal > 1 ? 's' : ''})`;
      }
    } else if (sel.kind === 'nodes') {
      $('sel-hint').textContent =
        `${sel.nodes.length} points selected — drag or arrows move them · type Δx/Δy for an exact move.`;
    } else if (sel.kind === 'hole') {
      $('sel-hint').textContent = 'Circular cutout — drag or arrows move it · type Δx/Δy for an exact move.';
    } else if (cutSel) {
      const cSlits = (piece.stitchSlits || []).filter((sl) => sl.cut === sel.idx).length;
      $('sel-hint').textContent = 'Internal cutout — drag / arrows / Move by reposition it · Del removes it' +
        (cSlits ? ` (and its ${cSlits} stitch holes)` : '') + '.';
    }
    renderInspector(piece);
  }

  // One inspector owns a tool's controls, including when Select finds its objects.
  function renderInspector(piece) {
    const editingSlits = piece && (sel.kind === 'slit' || sel.kind === 'slits');
    const stitchVisible = tool === 'stitch' || (tool === 'select' && editingSlits);
    $('stitch-props').hidden = !stitchVisible;
    const edit = tool !== 'stitch' || $('st-workflow').value === 'edit';
    if (tool === 'select' && editingSlits) $('st-workflow').value = 'edit';
    $('st-create').hidden = edit;
    $('st-edit').hidden = !edit;
    $('st-edit-fields').hidden = !editingSlits;
    $('st-edit-notice').hidden = true;
    if (editingSlits) {
      const indices = sel.kind === 'slit' ? [sel.idx] : sel.slits;
      const sl = piece.stitchSlits[indices[0]];
      if (sl) {
        for (const [id, value] of [['sp-slit-len', sl.len * 10 || 1.5], ['sp-slit-width', (sl.width || 0) * 10]]) {
          if (document.activeElement !== $(id)) $(id).value = Math.round(value * 1000) / 1000;
        }
        const groups = selectedStitchRuns(true);
        if (sl.pair) {
          const pair = groups.filter(g => g.piece.stitchSlits[g.indices[0]].pair === sl.pair);
          try {
            const lengths = {};
            for (const g of pair) {
              const holes = g.indices.map(i => g.piece.stitchSlits[i]);
              const chains = stitchChains(stitchRunTargets(g.piece, holes), 0);
              if (chains.length === 1) lengths[holes[0].pairSide] = Geo.pathLength(chains[0].path, chains[0].loop);
            }
            $('st-edit-notice').textContent = lengths.A == null || lengths.B == null
              ? 'Matched side missing or unavailable. Recreate the pair to restore its original side A reference.'
              : matchedLengthNotice(lengths.A, lengths.B);
          } catch (_) {
            $('st-edit-notice').textContent = 'The matched seam path has changed and cannot be checked. Recreate the pair before re-spacing.';
          }
          $('st-edit-notice').hidden = !$('st-edit-notice').textContent;
        }
        const selected = selectedStitchHoles();
        $('sp-del-run').textContent = `Delete ${selected.reduce((n,g)=>n+g.indices.length,0)} stitch holes`;
        $('st-edit-summary').textContent = `${selected.reduce((n,g)=>n+g.indices.length,0)} hole(s) across ${selected.length} shape(s). Whole-run action affects ${groups.length} run(s), including linked partners.`;
      }
    } else $('st-edit-summary').textContent = 'Click a hole or stitched edge, or drag a box to select holes across shapes.';
    $('piece-props').hidden = !piece || tool !== 'select' || !!editingSlits;
    $('sel-props').hidden = tool !== 'select' || $('sel-props').hidden || !!editingSlits;
    $('notch-props').hidden = !(tool === 'notch' || (tool === 'select' && piece && sel.kind === 'notch'));
    $('pp-notch').disabled = $('pp-notch-style').disabled = !piece;
    $('round-props').hidden = !(tool === 'round' || (tool === 'select' && piece && sel.kind === 'node'));
    $('sel-round-row').hidden = false;
    $('sp-round-btn').disabled = !piece || sel.kind !== 'node';
    $('hole-props').hidden = !(tool === 'hole' || (tool === 'select' && piece && sel.kind === 'hole'));
    $('hole-update').hidden = !piece || sel.kind !== 'hole';
    if (piece && sel.kind === 'hole' && document.activeElement !== $('hole-diameter')) {
      $('hole-diameter').value = (piece.holes[sel.idx].r || 0.15) * 20;
    }
    $('select-props').hidden = tool !== 'select';
    $('pen-props').hidden = tool !== 'pen';
    $('grain-props').hidden = tool !== 'grain';
    $('grain-remove').disabled = !piece || !piece.grain;
    $('piece-title').textContent = multiSel.length > 1 ? `${multiSel.length} pieces selected` : 'Whole piece';
    $('selection-title').textContent = 'Selected ' + ({seg:'edge',segs:'edges',node:'point',nodes:'points',hole:'hole',cut:'cutout'}[sel.kind] || 'object');
    $('pp-dup').textContent = 'Duplicate ' + (multiSel.length > 1 ? `${multiSel.length} pieces` : 'piece');
    $('pp-del').textContent = 'Delete ' + (multiSel.length > 1 ? `${multiSel.length} pieces` : 'whole piece');
    $('pp-mirror').textContent = multiSel.length > 1 ? 'Mirror first piece' : 'Mirror copy';
    $('tool-title').textContent = tool === 'bool' ? 'Boolean' : tool.charAt(0).toUpperCase() + tool.slice(1);
  }

  function selectedStitchHoles() {
    if (!['slit', 'slits'].includes(sel.kind)) return [];
    const groups = sel.slitGroups || [{pieceId:sel.pieceId, indices:sel.kind === 'slit' ? [sel.idx] : sel.slits || []}];
    return groups.map(g => ({piece:pieceById(g.pieceId), indices:g.indices})).filter(g => g.piece && g.indices.length);
  }
  function selectStitchHoles(groups) {
    groups = groups.filter(g => g.indices.length);
    clearSel();
    if (!groups.length) return;
    sel.pieceId = groups[0].piece.id;
    sel.kind = 'slits'; sel.slits = groups[0].indices;
    sel.slitGroups = groups.map(g => ({pieceId:g.piece.id, indices:g.indices}));
    $('sp-slit-inset').value = 0;
  }

  function selectedStitchRuns(linked) {
    const p = selPiece();
    if (!p) return [];
    const selected = selectedStitchHoles();
    const chosen = selected.flatMap(g => g.indices.map(i => g.piece.stitchSlits[i])).filter(Boolean);
    const pairs = new Set(linked ? chosen.map(s => s.pair).filter(Boolean) : []);
    const groups = [];
    for (const piece of doc.pieces) {
      const localChosen = selected.filter(g => g.piece === piece).flatMap(g => g.indices.map(i => piece.stitchSlits[i])).filter(Boolean);
      const byRun = new Map();
      (piece.stitchSlits || []).forEach((s, i) => {
        const local = localChosen.some(c => c.run != null ? c.run === s.run && c.pair === s.pair : s.run == null && c.seg === s.seg && c.cut === s.cut);
        if (!local && !pairs.has(s.pair)) return;
        const key = s.run == null ? `legacy:${s.cut == null ? 'outline' : s.cut}:${s.seg}` : `${s.pair || ''}:${s.run}`;
        if (!byRun.has(key)) byRun.set(key, []);
        byRun.get(key).push(i);
      });
      for (const indices of byRun.values()) groups.push({piece, indices});
    }
    return groups;
  }

  function stitchEditDown(ev, w) {
    for (const p of doc.pieces.slice().reverse()) {
      if (p.visible === false) continue;
      const i = hitSlit(p, w);
      if (i < 0) continue;
      const groups = ev.shiftKey ? selectedStitchHoles() : [];
      let group = groups.find(g => g.piece === p);
      if (!group) { group = {piece:p, indices:[]}; groups.push(group); }
      const indices = new Set(group.indices);
      if (indices.has(i)) indices.delete(i); else indices.add(i);
      group.indices = [...indices];
      selectStitchHoles(groups);
      renderAll();
      return;
    }
    const res = nearestEdgeAt(w, true), co = cutoutAt(w);
    const p = co && (!res || co.dist < res.hit.dist) ? co.piece : res && res.piece;
    if (p) {
      const cut = co && co.piece === p && (!res || co.dist < res.hit.dist) ? co.cut : null;
      const i = (p.stitchSlits || []).findIndex(s => cut != null ? s.cut === cut : s.cut == null && (p.guide || s.seg === res.hit.seg));
      if (i >= 0) {
        selectPiece(p.id); sel.kind = 'slit'; sel.idx = i;
        sel.slits = selectedStitchRuns(false).flatMap(g => g.indices);
        sel.kind = 'slits'; sel.idx = -1;
        $('sp-slit-inset').value = 0;
        renderAll(); return;
      }
    }
    drag = {type:'marquee', mode:'stitch-edit', a:w, b:w, shift:ev.shiftKey};
  }

  // ---------- tools ----------
  let tool = 'select';
  let weldFirst = null; // weld tool: { pieceId, seg } of the first picked edge
  let stitchMulti = []; // stitch tool: [{pieceId, seg|cut}] targets being gathered
  let stitchSideA = null; // matched mode: the confirmed side-A target set
  const HINTS = {
    select: 'Click to select, then drag to move · Box selection chooses pieces, points, edges or stitch holes explicitly · Shift adds · Del deletes the selected objects',
    pen: 'Click = corner, drag = curve · right-click = type exact length/angle · click the first point to close · Esc finishes open',
    shape: 'Rectangle / ellipse: drag, Option / Alt for exact size · Triangle / polygon: click the starting corner to enter measurements',
    notch: 'Click near a point on an outline — the notch snaps to it · right-click an edge to divide it where you need a point',
    hole: 'Click inside a piece to add a circular cutout',
    grain: 'Drag inside a piece to set the grainline · click (no drag) removes it',
    weld: 'Click an edge, then the matching edge on another piece — the second piece moves; both seam edges disappear',
    offset: 'Click edges to select them (click again to deselect, drag a box for several) · drag a selected edge to apply the mode live · Apply uses the exact distance · in Guide mode click inside a piece for a full ring · Esc clears',
    knife: 'Click two points to cut a piece in two (they snap to existing points) · or click an open path to cut along it · Esc cancels',
    round: 'Drag outward from a corner point — the drag distance sets the fillet radius, live preview shows the arc',
    bool: 'Click the base piece (A), then the other (B) — combined with the op from the panel · overlapping outlines must cross exactly twice · Subtract with B fully inside A punches it through as a hole',
    stitch: 'Select edges, guide lines or cutouts (click / Shift-click / drag a box) · Single mode: Enter runs holes along each · Matched mode: pick side A, Enter, pick side B, Enter — both sides get the same holes · Esc cancels',
    measure: 'Drag to measure a distance',
  };
  function setTool(t) {
    const prev = tool;
    tool = t;
    if (t === 'stitch' && prev !== 'stitch') {
      const p = selPiece();
      if (p && (sel.kind === 'slit' || sel.kind === 'slits')) $('st-workflow').value = 'edit';
      else if (p && (sel.kind === 'seg' || sel.kind === 'segs')) {
        $('st-workflow').value = 'create';
        stitchMulti = selectedSegsOf(p).map(seg => ({pieceId:p.id, seg}));
      }
    }
    if (t !== 'pen') finishDraft(false);
    if (t !== 'weld') weldFirst = null;
    if (t !== 'stitch') { stitchMulti = []; stitchSideA = null; }
    if (t !== 'offset') insetChain = null;
    if (t !== 'knife') knifeFirst = null;
    if (t !== 'bool') boolFirst = null;
    $('stitch-props').hidden = t !== 'stitch';
    $('offset-props').hidden = t !== 'offset';
    $('bool-props').hidden = t !== 'bool';
    $('shape-props').hidden = t !== 'shape';
    document.querySelectorAll('#toolbar .tool').forEach((b) =>
      b.classList.toggle('active', b.dataset.tool === t));
    svg.setAttribute('class', 'tool-' + t);
    $('status-hint').textContent = HINTS[t] || '';
    if (t === 'stitch') updateStitchUi();
    renderAll();
    $('sidebar').scrollTop = 0;
  }

  // ---------- pen tool (drafting a new piece) ----------
  let draft = null; // { nodes: [], mouse: {x,y}|null }

  function renderPenPreview() {
    clear(gPreview);
    if (tool !== 'pen' || !draft || !draft.nodes.length) return;
    drawAlignGuides(gPreview);
    el('path', { class: 'preview-path', d: pathD(draft.nodes, false) }, gPreview);
    if (draft.mouse) {
      const last = draft.nodes[draft.nodes.length - 1];
      el('line', {
        class: 'preview-rubber',
        x1: last.x, y1: last.y, x2: draft.mouse.x, y2: draft.mouse.y,
      }, gPreview);
      // live length of the segment being drawn (right-click to type it)
      const len = Geo.dist(last, draft.mouse);
      if (len > 0.05) {
        const mid = Geo.lerp(last, draft.mouse, 0.5);
        el('text', {
          class: 'measure-text', x: mid.x, y: mid.y - px(8),
          'font-size': px(12), 'text-anchor': 'middle',
        }, gPreview).textContent = fmt(len) + ' cm';
      }
    }
    const r = px(4);
    draft.nodes.forEach((nd, i) => {
      const closable = i === 0 && draft.nodes.length > 2 && draft.mouse &&
        Geo.dist(draft.mouse, draft.nodes[0]) < px(10);
      el('rect', {
        class: 'node' + (closable ? ' first-hint' : ''),
        x: nd.x - r, y: nd.y - r, width: 2 * r, height: 2 * r,
      }, gPreview);
    });
  }

  function finishDraft(closed) {
    if (!draft) return;
    closePenDialog();
    if (draft.nodes.length >= 2) {
      beginChange();
      const piece = newPiece(draft.nodes, closed);
      doc.pieces.push(piece);
      endChange();
      selectPiece(piece.id);
    }
    draft = null;
    clear(gPreview);
    renderAll();
  }

  // ---------- pointer interaction ----------
  let drag = null; // active drag descriptor
  let spaceDown = false;
  // Double-clicks are detected manually from pointerdown timing: the native
  // dblclick event is unreliable once setPointerCapture is involved, and
  // doesn't exist at all for some touch/pen input.
  let lastDown = { t: -1e9, x: 0, y: 0 };
  let dblPending = null; // double-click held over until pointerup (select tool)

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch') {
      touchPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchPts.size >= 2) {
        // second finger: abort any single-finger tool drag, start the gesture
        if (drag) { endChange(); drag = null; }
        pinch = null;
        pinchUpdate(); // set the reference from the touchdown positions
        ev.preventDefault();
        return;
      }
    }
    if (ev.button === 1 || spaceDown) { // pan
      drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture(ev.pointerId);
      svg.classList.add('panning');
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    if (!$('pen-dialog').hidden) closePenDialog();
    if (!$('divide-dialog').hidden) closeDivideDialog();
    if (!$('node-dialog').hidden) closeNodeDialog();
    svg.focus();
    const w = screenToWorld(ev);
    const isDbl = ev.timeStamp - lastDown.t < 400 &&
      Math.hypot(ev.clientX - lastDown.x, ev.clientY - lastDown.y) < 6;
    lastDown = { t: ev.timeStamp, x: ev.clientX, y: ev.clientY };
    dblPending = null;
    if (isDbl) {
      lastDown.t = -1e9; // a triple-click shouldn't count as two doubles
      if (tool !== 'select') { drag = null; return handleDoubleClick(w); }
      // select tool: hold the double-click until pointerup. Selecting now takes
      // two presses, so the second press must still be able to start a move —
      // it only counts as a double-click if the pointer stayed put.
      dblPending = { w };
    }
    svg.setPointerCapture(ev.pointerId);

    if (tool === 'pen') return penDown(w);
    if (tool === 'shape') { drag = { type: 'shape', a: snap(w), b: snap(w), pointerId:ev.pointerId }; if (ev.altKey || ['triangle','polygon'].includes($('sh-kind').value)) { ev.preventDefault(); openShapeSize(); } return; }
    if (tool === 'select') return selectDown(ev, w);
    if (tool === 'notch') return notchDown(w);
    if (tool === 'hole') return holeDown(w);
    if (tool === 'grain') return grainDown(w);
    if (tool === 'weld') return weldDown(w);
    if (tool === 'offset') return offsetDown(w);
    if (tool === 'knife') return knifeDown(w);
    if (tool === 'round') return roundDown(w);
    if (tool === 'bool') return boolDown(w);
    if (tool === 'stitch') return stitchDown(ev, w);
    if (tool === 'measure') { const a = snap(w); drag = { type: 'measure', a, b: a }; return; }
  });

  svg.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch' && touchPts.has(ev.pointerId)) {
      touchPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchPts.size >= 2) { pinchUpdate(); return; }
    }
    const w = screenToWorld(ev);
    $('status-pos').textContent = `${fmt(w.x)}, ${fmt(w.y)} cm`;

    // past the slop the press is a real move, and no longer a double-click
    if (drag && drag.dead) {
      if (Math.hypot(ev.clientX - drag.dead.x, ev.clientY - drag.dead.y) < DRAG_SLOP) return;
      drag.dead = null;
      dblPending = null;
    }

    if (tool === 'pen' && draft) {
      draft.mouse = snap(w);
      if (drag && drag.type === 'pen-handle') {
        const nd = draft.nodes[draft.nodes.length - 1];
        const dx = w.x - nd.x, dy = w.y - nd.y;
        if (Math.hypot(dx, dy) > px(4)) {
          nd.hout = { x: dx, y: dy };
          nd.hin = { x: -dx, y: -dy };
        } else { nd.hout = null; nd.hin = null; }
      }
      renderPenPreview();
      return;
    }
    if (tool === 'knife' && !drag) {
      const b = knifeSnap(w);
      clear(gPreview);
      if (knifeFirst) {
        el('line', { class: 'knife-line', x1: knifeFirst.x, y1: knifeFirst.y, x2: b.x, y2: b.y }, gPreview);
      }
      // ghost the point the click would land on, before any click happens
      for (const e2 of knifeFirst ? [knifeFirst, b] : [b]) {
        if (e2.snapped) {
          el('circle', { class: 'snap-dot', cx: e2.x, cy: e2.y, r: px(5) }, gPreview);
          el('circle', { class: 'ghost-dot', cx: e2.x, cy: e2.y, r: px(2.5) }, gPreview);
        }
      }
      return;
    }
    if (!drag) return;

    if (drag.type === 'pan') {
      view.x = drag.vx - (ev.clientX - drag.sx) / view.scale;
      view.y = drag.vy - (ev.clientY - drag.sy) / view.scale;
      applyView();
      return;
    }
    if (drag.type === 'node') {
      const p = snap(w, drag.pieceId, drag.idx);
      const nd = pieceById(drag.pieceId).path.nodes[drag.idx];
      nd.x = p.x; nd.y = p.y;
      renderAll(true); renderSidebar();
      return;
    }
    if (drag.type === 'segs') {
      const piece = pieceById(drag.pieceId);
      const raw = Geo.dot(Geo.sub(w, drag.start), drag.n);
      const s = snapOn() ? snapStep() : 0.0001;
      const off = Math.round(raw / s) * s;
      if (off !== drag.applied) {
        for (const [k, v] of drag.vecs) {
          const nd = piece.path.nodes[k];
          nd.x = drag.orig[k].x + v.x * off;
          nd.y = drag.orig[k].y + v.y * off;
        }
        drag.applied = off;
        renderAll(true);
      }
      clear(gPreview);
      if (Math.abs(off) > 1e-9) {
        const n = piece.path.nodes.length;
        const a = piece.path.nodes[drag.idx], b = piece.path.nodes[(drag.idx + 1) % n];
        const mid = Geo.segPoint(a, b, 0.5);
        el('text', {
          class: 'measure-text', x: mid.x, y: mid.y - px(12),
          'font-size': px(12), 'text-anchor': 'middle',
        }, gPreview).textContent = (off > 0 ? '+' : '') + fmt(off) + ' cm';
      }
      return;
    }
    if (drag.type === 'rotate') { // ring handle: rotate about the selection centre
      const raw = Math.atan2(w.y - drag.c.y, w.x - drag.c.x) - drag.a0;
      const stepDeg = ev.shiftKey ? 15 : 1;
      const step = stepDeg * Math.PI / 180;
      const ang = Math.round(raw / step) * step;
      if (Math.abs(ang - drag.applied) > 1e-12) {
        rotatePieces(drag.ids, drag.c.x, drag.c.y, ang - drag.applied);
        drag.applied = ang;
        renderAll(true);
      }
      clear(gPreview);
      let deg = Math.round(-drag.applied * 180 / Math.PI); // show CCW-positive
      if (deg > 180) deg -= 360;
      if (deg < -180) deg += 360;
      el('text', {
        class: 'measure-text', x: w.x, y: w.y - px(16),
        'font-size': px(12), 'text-anchor': 'middle',
      }, gPreview).textContent = deg + '\u00b0';
      return;
    }
    if (drag.type === 'scale') { // corner handle: uniform scale about the opposite corner
      const d0 = Geo.dist(drag.start, drag.anchor);
      let f = d0 > 1e-6 ? Geo.dist(w, drag.anchor) / d0 : 1;
      f = Math.max(0.05, Math.round(f * 100) / 100); // whole-percent steps
      if (Math.abs(f / drag.applied - 1) > 1e-9) {
        scalePieces(drag.ids, drag.anchor.x, drag.anchor.y, f / drag.applied);
        drag.applied = f;
        renderAll(true);
      }
      clear(gPreview);
      el('text', {
        class: 'measure-text', x: w.x, y: w.y - px(16),
        'font-size': px(12), 'text-anchor': 'middle',
      }, gPreview).textContent = Math.round(drag.applied * 100) + '%';
      return;
    }
    if (drag.type === 'seg') { // select tool: move the edge freely
      const piece = pieceById(drag.pieceId);
      const n = piece.path.nodes.length;
      const a = piece.path.nodes[drag.idx], b = piece.path.nodes[(drag.idx + 1) % n];
      const dx = w.x - drag.start.x, dy = w.y - drag.start.y;
      const s = snapOn() ? snapStep() : 0.0001;
      const sdx = Math.round(dx / s) * s, sdy = Math.round(dy / s) * s;
      const ddx = sdx - drag.applied.x, ddy = sdy - drag.applied.y;
      if (ddx || ddy) {
        a.x += ddx; a.y += ddy;
        if (b !== a) { b.x += ddx; b.y += ddy; }
        drag.applied = { x: sdx, y: sdy };
        renderAll(true);
      }
      return;
    }
    if (drag.type === 'seg-extrude') { // offset tool: protrude the selected edges
      const piece = pieceById(drag.pieceId);
      const raw = Geo.dot(Geo.sub(w, drag.start), drag.n);
      const s = snapOn() ? snapStep() : 0.0001;
      const off = Math.round(raw / s) * s;
      if (off && !drag.inserted) {
        // extrude every selected edge, highest index first so lower stay valid
        const order = drag.segs.slice().sort((x, y) => y - x);
        const entries = [];
        for (const i of order) {
          const nrm = segOffsetNormal(piece, i);
          entries.push({ orig: i, mid: extrudeSeg(piece, i), nrm });
        }
        entries.forEach((e, j) => { e.mid += 2 * (order.length - 1 - j); });
        for (const e of entries) {
          e.ax = piece.path.nodes[e.mid].x; e.ay = piece.path.nodes[e.mid].y;
          e.bx = piece.path.nodes[e.mid + 1].x; e.by = piece.path.nodes[e.mid + 1].y;
        }
        drag.entries = entries;
        drag.inserted = true;
        setSegSelection(piece, entries.map((e) => e.mid).sort((x, y) => x - y));
      }
      if (drag.inserted && off !== drag.applied) {
        for (const e of drag.entries) {
          piece.path.nodes[e.mid].x = e.ax + e.nrm.x * off;
          piece.path.nodes[e.mid].y = e.ay + e.nrm.y * off;
          piece.path.nodes[e.mid + 1].x = e.bx + e.nrm.x * off;
          piece.path.nodes[e.mid + 1].y = e.by + e.nrm.y * off;
        }
        drag.applied = off;
        renderAll(true);
      }
      clear(gPreview);
      if (drag.inserted && Math.abs(off) > 1e-9) {
        const e = drag.entries.find((en) => en.orig === drag.clickSeg) || drag.entries[0];
        const mid = Geo.segPoint(piece.path.nodes[e.mid], piece.path.nodes[e.mid + 1], 0.5);
        el('text', {
          class: 'measure-text', x: mid.x, y: mid.y - px(12),
          'font-size': px(12), 'text-anchor': 'middle',
        }, gPreview).textContent = (off > 0 ? '+' : '') + fmt(off) + ' cm';
      }
      return;
    }
    if (drag.type === 'nodes') {
      const piece = pieceById(drag.pieceId);
      const dx = w.x - drag.start.x, dy = w.y - drag.start.y;
      const s = snapOn() ? snapStep() : 0.0001;
      const sdx = Math.round(dx / s) * s, sdy = Math.round(dy / s) * s;
      const ddx = sdx - drag.applied.x, ddy = sdy - drag.applied.y;
      if (ddx || ddy) {
        for (const i of drag.idxs) {
          const nd = piece.path.nodes[i];
          if (nd) { nd.x += ddx; nd.y += ddy; }
        }
        drag.applied = { x: sdx, y: sdy };
        renderAll(true);
      }
      return;
    }
    if (drag.type === 'cutout') {
      const piece = pieceById(drag.pieceId);
      const c = piece && (piece.cutouts || [])[drag.idx];
      if (c) {
        const dx = w.x - drag.start.x, dy = w.y - drag.start.y;
        const s = snapOn() ? snapStep() : 0.0001;
        const sdx = Math.round(dx / s) * s, sdy = Math.round(dy / s) * s;
        const ddx = sdx - drag.applied.x, ddy = sdy - drag.applied.y;
        if (ddx || ddy) {
          for (const nd of c.nodes) { nd.x += ddx; nd.y += ddy; }
          drag.applied = { x: sdx, y: sdy };
          renderAll(true);
        }
      }
      return;
    }
    if (drag.type === 'round') {
      const piece = pieceById(drag.pieceId);
      const corner = piece.path.nodes[drag.idx];
      clear(gPreview);
      let R = Math.round(Geo.dist(w, corner) / 0.05) * 0.05;
      R = Math.min(R, drag.maxR);
      drag.R = R >= 0.05 ? R : 0;
      if (drag.R) {
        const fp = filletParams(piece, drag.idx, drag.R);
        if (!fp.error) {
          const c1 = { x: fp.A.x + fp.ta.x * fp.k, y: fp.A.y + fp.ta.y * fp.k };
          const c2 = { x: fp.B.x - fp.tb.x * fp.k, y: fp.B.y - fp.tb.y * fp.k };
          el('path', {
            class: 'preview-path',
            d: `M ${fp.A.x} ${fp.A.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${fp.B.x} ${fp.B.y}`,
          }, gPreview);
          el('circle', { class: 'ghost-dot', cx: fp.A.x, cy: fp.A.y, r: px(3.5) }, gPreview);
          el('circle', { class: 'ghost-dot', cx: fp.B.x, cy: fp.B.y, r: px(3.5) }, gPreview);
          el('text', {
            class: 'measure-text', x: w.x, y: w.y - px(10),
            'font-size': px(12), 'text-anchor': 'middle',
          }, gPreview).textContent = 'R ' + fmt(drag.R) + ' cm';
        }
      }
      return;
    }
    if (drag.type === 'handle') {
      const nd = pieceById(drag.pieceId).path.nodes[drag.idx];
      const v = { x: w.x - nd.x, y: w.y - nd.y };
      // dropping a handle onto its own point deletes it
      const kill = Geo.len(v) < px(5);
      nd[drag.key] = kill ? null : v;
      const other = drag.key === 'hout' ? 'hin' : 'hout';
      if (!kill && !ev.altKey && nd[other]) nd[other] = { x: -v.x, y: -v.y };
      renderAll(true);
      return;
    }
    if (drag.type === 'piece') {
      const group = drag.ids.map(pieceById).filter(Boolean);
      const dx = w.x - drag.start.x, dy = w.y - drag.start.y;
      const s = snapOn() ? snapStep() : 0.0001;
      let sdx = Math.round(dx / s) * s, sdy = Math.round(dy / s) * s;
      // placement magnet: pull the nearest node of the dragged group exactly
      // onto a nearby node — or any point on the outline — of an unmoved piece
      let magnet = null;
      {
        let best = px(9);
        for (const gp of group) {
          for (const nd of gp.path.nodes) {
            const tx2 = nd.x - drag.applied.x + sdx, ty2 = nd.y - drag.applied.y + sdy;
            for (const q of doc.pieces) {
              if (drag.ids.includes(q.id) || q.visible === false) continue;
              for (const qn of q.path.nodes) {
                const d = Math.hypot(qn.x - tx2, qn.y - ty2);
                if (d < best) { best = d; magnet = { dx: qn.x - tx2, dy: qn.y - ty2, x: qn.x, y: qn.y }; }
              }
            }
          }
        }
        if (!magnet) { // no vertex pair in range: try landing on an edge
          let bestE = px(7);
          for (const gp of group) {
            for (const nd of gp.path.nodes) {
              const tp = { x: nd.x - drag.applied.x + sdx, y: nd.y - drag.applied.y + sdy };
              for (const q of doc.pieces) {
                if (drag.ids.includes(q.id) || q.visible === false || q.path.nodes.length < 2) continue;
                const hit = Geo.nearestOnPath(q.path.nodes, q.path.closed, tp);
                if (hit && hit.dist < bestE) {
                  bestE = hit.dist;
                  magnet = { dx: hit.point.x - tp.x, dy: hit.point.y - tp.y, x: hit.point.x, y: hit.point.y };
                }
              }
            }
          }
        }
        if (magnet) { sdx += magnet.dx; sdy += magnet.dy; }
      }
      const ddx = sdx - drag.applied.x, ddy = sdy - drag.applied.y;
      if (ddx || ddy) {
        for (const gp of group) movePiece(gp, ddx, ddy);
        drag.applied = { x: sdx, y: sdy };
        renderAll(true);
      }
      clear(gPreview);
      if (magnet) {
        el('circle', { class: 'snap-dot', cx: magnet.x, cy: magnet.y, r: px(6) }, gPreview);
      }
      return;
    }
    if (drag.type === 'marquee') {
      drag.b = w;
      clear(gPreview);
      el('rect', {
        class: 'marquee',
        x: Math.min(drag.a.x, drag.b.x), y: Math.min(drag.a.y, drag.b.y),
        width: Math.abs(drag.b.x - drag.a.x), height: Math.abs(drag.b.y - drag.a.y),
      }, gPreview);
      return;
    }
    if (drag.type === 'grain') {
      drag.b = snap(w);
      const piece = pieceById(drag.pieceId);
      piece.grain = { x1: drag.a.x, y1: drag.a.y, x2: drag.b.x, y2: drag.b.y };
      renderAll(true);
      return;
    }
    if (drag.type === 'shape') {
      drag.b = snap(w);
      if (ev.altKey) { openShapeSize(); return; }
      clear(gPreview);
      drawAlignGuides(gPreview);
      const x0 = Math.min(drag.a.x, drag.b.x), x1 = Math.max(drag.a.x, drag.b.x);
      const y0 = Math.min(drag.a.y, drag.b.y), y1 = Math.max(drag.a.y, drag.b.y);
      if ($('sh-kind').value === 'ellipse') {
        el('ellipse', {
          class: 'preview-path',
          cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2,
        }, gPreview);
      } else {
        el('rect', { class: 'preview-path', x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, gPreview);
      }
      el('text', {
        class: 'measure-text', x: (x0 + x1) / 2, y: y0 - px(8),
        'font-size': px(12), 'text-anchor': 'middle',
      }, gPreview).textContent = `${fmt(x1 - x0)} × ${fmt(y1 - y0)} cm`;
      return;
    }
    if (drag.type === 'measure') {
      drag.b = snap(w);
      clear(gPreview);
      drawAlignGuides(gPreview);
      el('line', { class: 'measure-line', x1: drag.a.x, y1: drag.a.y, x2: drag.b.x, y2: drag.b.y }, gPreview);
      const mid = Geo.lerp(drag.a, drag.b, 0.5);
      el('text', {
        class: 'measure-text', x: mid.x, y: mid.y - px(8),
        'font-size': px(12), 'text-anchor': 'middle',
      }, gPreview).textContent = fmt(Geo.dist(drag.a, drag.b)) + ' cm';
      return;
    }
  });

  // Both free dragging and exact dimensions commit through the same geometry path.
  function createDraggedShape(shape) {
    let nodes = shape.nodes;
    if (!nodes) {
      const x0 = Math.min(shape.a.x, shape.b.x), x1 = Math.max(shape.a.x, shape.b.x);
      const y0 = Math.min(shape.a.y, shape.b.y), y1 = Math.max(shape.a.y, shape.b.y);
      if (x1 - x0 < 0.3 - 1e-9 || y1 - y0 < 0.3 - 1e-9) return;
      if (shape.kind === 'ellipse') {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
        const k = 0.5522847498;
        nodes = [
          { x: cx + rx, y: cy, hin: { x: 0, y: -k * ry }, hout: { x: 0, y: k * ry } },
          { x: cx, y: cy + ry, hin: { x: k * rx, y: 0 }, hout: { x: -k * rx, y: 0 } },
          { x: cx - rx, y: cy, hin: { x: 0, y: k * ry }, hout: { x: 0, y: -k * ry } },
          { x: cx, y: cy - ry, hin: { x: -k * rx, y: 0 }, hout: { x: k * rx, y: 0 } },
        ];
      } else {
        nodes = [
          { x: x0, y: y0, hin: null, hout: null },
          { x: x1, y: y0, hin: null, hout: null },
          { x: x1, y: y1, hin: null, hout: null },
          { x: x0, y: y1, hin: null, hout: null },
        ];
      }
    }
    beginChange();
    const piece = newPiece(nodes, true);
    doc.pieces.push(piece);
    endChange();
    selectPiece(piece.id);
    renderAll();
  }
  let exactShape = null;
  function openShapeSize() {
    if (!drag || drag.type !== 'shape') return;
    exactShape = {...drag, kind:$('sh-kind').value};
    drag = null;
    if (svg.hasPointerCapture(exactShape.pointerId)) svg.releasePointerCapture(exactShape.pointerId);
    $('shape-width').value = Number(Math.max(0.3, Math.abs(exactShape.b.x-exactShape.a.x)).toFixed(4));
    $('shape-height').value = Number(Math.max(0.3, Math.abs(exactShape.b.y-exactShape.a.y)).toFixed(4));
    const triangle=exactShape.kind==='triangle', polygon=exactShape.kind==='polygon';
    $('shape-rectangle-fields').hidden=triangle||polygon;
    $('shape-triangle-fields').hidden=!triangle;
    for (const id of ['shape-width','shape-height']) $(id).disabled=triangle||polygon;
    for (const id of ['shape-side-a','shape-side-b','shape-side-c']) $(id).disabled=!triangle;
    $('shape-polygon-fields').hidden=!polygon;
    for (const id of ['shape-side-count','shape-side-length']) $(id).disabled=!polygon;
    $('shape-size-title').textContent=polygon?'Regular polygon':triangle?'Triangle from three sides':'Exact shape size';
    $('shape-size-help').textContent=polygon?'All sides and angles are equal. The first side starts here and runs horizontally to the right.':triangle?'Side A is the horizontal base. Side B joins its far end to the third corner; side C returns to the start.':'Keeps your starting corner and drag direction. Ellipse values are its full width and height.';
    $('shape-size-error').textContent='';
    $('shape-size-dialog').showModal();
    const focus=$(polygon?'shape-side-count':triangle?'shape-side-a':'shape-width'); focus.focus(); focus.select();
  }
  $('shape-size-form').addEventListener('submit', ev => {
    ev.preventDefault();
    if (!exactShape) return;
    const {a,b,kind}=exactShape;
    try {
      if (kind==='triangle' || kind==='polygon') {
        const nodes=kind==='triangle'
          ? Geo.triangleFromSides(...['shape-side-a','shape-side-b','shape-side-c'].map(id=>Number($(id).value)))
          : Geo.regularPolygon(Number($('shape-side-count').value),Number($('shape-side-length').value));
        createDraggedShape({nodes:nodes.map(n=>({...n,x:a.x+n.x,y:a.y+n.y}))});
      } else {
        const width=Number($('shape-width').value), height=Number($('shape-height').value);
        if (![width,height].every(v=>Number.isFinite(v)&&v>=0.3)) return;
        createDraggedShape({a, b:{x:a.x+(b.x<a.x?-width:width), y:a.y+(b.y<a.y?-height:height)}, kind});
      }
    } catch (error) { $('shape-size-error').textContent=error.message; return; }
    $('shape-size-dialog').close();
  });
  $('shape-size-cancel').addEventListener('click', () => $('shape-size-dialog').close());
  $('shape-size-dialog').addEventListener('close', () => {
    exactShape=null; clear(gPreview); svg.focus();
  });

  svg.addEventListener('pointerup', (ev) => {
    if (drag) {
      if (alignGuides.length || snapMarks.length) { alignGuides = []; snapMarks = []; renderAll(true); }
      if (drag.type === 'pan') svg.classList.remove('panning');
      else if (drag.type === 'measure') clear(gPreview);
      else if (drag.type === 'shape') {
        clear(gPreview);
        createDraggedShape({...drag, kind:$('sh-kind').value});
      }
      else if (drag.type === 'grain') {
        const piece = pieceById(drag.pieceId);
        if (Geo.dist(drag.a, drag.b) < 0.5) piece.grain = drag.hadGrain ? null : piece.grain && null;
        endChange();
        renderAll();
      }
      if (drag.type === 'piece') clear(gPreview);
      if (drag.type === 'round') {
        clear(gPreview);
        if (drag.R >= 0.05) {
          const piece = pieceById(drag.pieceId);
          if (piece) {
            selectPiece(piece.id);
            roundCorner(piece, drag.idx, drag.R);
          }
        }
        drag = null;
        return;
      }
      if (drag.type === 'marquee') {
        clear(gPreview);
        const x0 = Math.min(drag.a.x, drag.b.x), x1 = Math.max(drag.a.x, drag.b.x);
        const y0 = Math.min(drag.a.y, drag.b.y), y1 = Math.max(drag.a.y, drag.b.y);
        if (drag.mode === 'inset') {
          // offset tool, guide mode: a drag adds every caught edge to the
          // guide run, a plain click keeps the toggle behaviour
          if (x1 - x0 > 0.2 || y1 - y0 > 0.2) insetMarquee(x0, y0, x1, y1);
          else insetClick(drag.a);
          drag = null;
          return;
        }
        if (drag.mode === 'offset-add') {
          // offset tool, slide/protrude: box-select edges into the set
          if (x1 - x0 > 0.2 || y1 - y0 > 0.2) offsetBoxAdd(x0, y0, x1, y1);
          else { clearSel(); } // click on empty space clears the edge set
          renderAll(true); renderSidebar();
          drag = null;
          return;
        }
        if (drag.mode === 'stitch-edit') {
          const groups = drag.shift ? selectedStitchHoles() : [];
          for (const p of doc.pieces) {
            if (p.visible === false) continue;
            const previous = groups.find(g => g.piece === p);
            const indices = new Set(previous ? previous.indices : []);
            (p.stitchSlits || []).forEach((sl, i) => {
              const ln = slitLineFor(p, sl);
              if (!ln) return;
              const c = Geo.lerp(ln.a, ln.b, 0.5);
              if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) indices.add(i);
            });
            if (previous) previous.indices = [...indices];
            else if (indices.size) groups.push({piece:p, indices:[...indices]});
          }
          selectStitchHoles(groups);
          drag = null; renderAll();
          $('status-hint').textContent = `${groups.reduce((n,g)=>n+g.indices.length,0)} stitch holes selected across ${groups.length} shape(s)`;
          return;
        }
        if (drag.mode === 'stitch-add') {
          // stitch tool: box-select targets; a plain empty click clears them
          if (x1 - x0 > 0.2 || y1 - y0 > 0.2) stitchBoxAdd(x0, y0, x1, y1);
          else { stitchMulti = []; updateStitchUi(); }
          renderAll(true);
          drag = null;
          return;
        }
        if (x1 - x0 > 0.2 || y1 - y0 > 0.2) {
          // with a piece selected, the marquee grabs its POINTS first
          const prevPiece = drag.prevPieceId ? pieceById(drag.prevPieceId) : null;
          let done = false;
          const target = $('select-box').value;
          if (target !== 'pieces') {
            done = true;
            if (!prevPiece) {
              $('status-hint').textContent = 'Select a piece first, then box-select its ' + target + '.';
            } else {
              const inside = p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
              const kind = target === 'points' ? 'nodes' : target === 'edges' ? 'segs' : 'slits';
              const set = new Set(drag.shift && sel.kind === kind ? sel[kind] : []);
              if (target === 'points') prevPiece.path.nodes.forEach((nd, i) => { if (inside(nd)) set.add(i); });
              else if (target === 'edges') {
                const nodes = prevPiece.path.nodes;
                for (let i = 0; i < nodes.length - (prevPiece.path.closed ? 0 : 1); i++) if (inside(nodes[i]) && inside(nodes[(i + 1) % nodes.length])) set.add(i);
              } else (prevPiece.stitchSlits || []).forEach((sl, i) => {
                const ln = slitLineFor(prevPiece, sl);
                if (ln && inside(Geo.lerp(ln.a, ln.b, 0.5))) set.add(i);
              });
              selectPiece(prevPiece.id);
              sel.kind = set.size ? kind : null; sel[kind] = [...set]; sel.idx = -1;
              $('status-hint').textContent = `${set.size} ${target} selected`;
            }
          }
          if (!done) {
            const ids = [];
            for (const p of doc.pieces) {
              if (p.visible === false || p.path.nodes.length < 2) continue;
              const bb = Geo.bbox(Geo.pathPolyline(p.path.nodes, p.path.closed, 0.2));
              if (bb.minX <= x1 && bb.maxX >= x0 && bb.minY <= y1 && bb.maxY >= y0) ids.push(p.id);
            }
            // Shift adds to the existing group instead of replacing it
            const base = drag.shift ? (multiSel.length ? multiSel : (sel.pieceId ? [sel.pieceId] : [])) : [];
            const merged = [...new Set([...base, ...ids])];
            clearSel();
            if (merged.length) {
              sel.pieceId = merged[0];
              multiSel = merged;
              $('status-hint').textContent =
                `${merged.length} piece${merged.length > 1 ? 's' : ''} selected — drag or arrow keys move them together · Del deletes`;
            }
          }
        } else {
          clearSel(); // plain click on empty space
        }
        renderAll(true); renderSidebar();
      }
      if (drag.type === 'segs' || drag.type === 'seg-extrude') {
        // offset tool release: a zero-distance release is a click — deselect
        // the clicked edge; an extrude released flat removes its extra corners
        clear(gPreview);
        const piece = pieceById(drag.pieceId);
        if (piece && drag.type === 'seg-extrude' && drag.inserted && drag.applied === 0) {
          for (const e of drag.entries.slice().sort((p, q) => q.mid - p.mid)) {
            collapseExtrude(piece, e.mid);
          }
          setSegSelection(piece, drag.segs.slice().sort((x, y) => x - y));
        }
        const releasedFlat = drag.type === 'seg-extrude'
          ? (!drag.inserted || drag.applied === 0)
          : drag.applied === 0;
        if (piece && releasedFlat && drag.clickSeg != null) {
          const cur = new Set(sel.pieceId === piece.id
            ? (sel.kind === 'segs' ? sel.segs : (sel.kind === 'seg' ? [sel.idx] : [])) : []);
          cur.delete(drag.clickSeg);
          setSegSelection(piece, [...cur].sort((x, y) => x - y));
        }
        endChange();
        renderAll(true); renderSidebar();
        drag = null;
        return;
      }
      if (drag.type === 'scale' || drag.type === 'rotate') clear(gPreview);
      if (['node', 'nodes', 'handle', 'piece', 'seg', 'scale', 'rotate', 'cutout'].includes(drag.type)) { endChange(); renderSidebar(); }
      if (drag.type === 'pen-handle') renderPenPreview();
      drag = null;
      return;
    }
  });

  function handleDoubleClick(w) {
    if (tool === 'pen') { finishDraft(false); return; }
    if (tool !== 'select') return;
    const piece = selPiece();
    if (!piece) return;
    const nodes = piece.path.nodes;
    // double-click a handle dot: delete that handle
    const killHandle = (t) => {
      beginChange();
      nodes[t.idx][t.key] = null;
      sel.handle = null;
      endChange();
      renderAll(); renderSidebar();
    };
    const own = hitHandle(piece, w, true);
    if (own) { killHandle(own); return; }
    // double-click node: toggle corner/smooth
    const ni = hitNode(piece, w);
    if (ni >= 0) {
      toggleNodeSmooth(piece, ni);
      sel.kind = 'node'; sel.idx = ni;
      renderAll();
      return;
    }
    // a neighbour's facing handle — same deal, checked after the points so it
    // can't shadow one
    const far = hitHandle(piece, w, false);
    if (far) { killHandle(far); return; }
    // double-click edge: insert node
    const hit = Geo.nearestOnPath(nodes, piece.path.closed, w);
    if (hit && hit.dist < px(8)) {
      if (piece.foldSeg === hit.seg) {
        $('status-hint').textContent = 'The fold line must stay a single straight edge — remove the fold first.';
        return;
      }
      beginChange();
      const n = nodes.length;
      const a = nodes[hit.seg], b = nodes[(hit.seg + 1) % n];
      const { a2, mid, b2 } = Geo.splitSeg(a, b, hit.t);
      nodes[hit.seg] = a2;
      nodes[(hit.seg + 1) % n] = b2;
      nodes.splice(hit.seg + 1, 0, mid);
      remapAfterInsert(piece, hit.seg, hit.t);
      if (piece.foldSeg != null && piece.foldSeg > hit.seg) piece.foldSeg += 1;
      endChange();
      sel.kind = 'node'; sel.idx = hit.seg + 1;
      renderAll();
    }
  }

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      // trackpad pinch arrives as ctrl+wheel; also plain Ctrl/Cmd+scroll
      const w = screenToWorld(ev);
      const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-dy * 0.01)));
      zoomAt(factor, w.x, w.y);
    } else {
      // two-finger scroll (or mouse wheel) pans
      const dm = ev.deltaMode === 1 ? 16 : 1;
      view.x += (ev.deltaX * dm) / view.scale;
      view.y += (ev.deltaY * dm) / view.scale;
      applyView();
    }
  }, { passive: false });

  // ---- touch: one finger = tools, two fingers = pan/pinch-zoom ----
  const touchPts = new Map(); // pointerId -> {x, y}
  let pinch = null; // { wx, wy, d0, s0 } gesture reference

  function pinchUpdate() {
    const pts = [...touchPts.values()];
    if (pts.length < 2) return;
    const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const r = svg.getBoundingClientRect();
    if (!pinch) {
      pinch = {
        wx: view.x + (cx - r.left) / view.scale,
        wy: view.y + (cy - r.top) / view.scale,
        d0: Math.max(d, 1),
        s0: view.scale,
      };
      return;
    }
    const ns = Math.min(400, Math.max(1.5, pinch.s0 * d / pinch.d0));
    view.scale = ns;
    view.x = pinch.wx - (cx - r.left) / ns;
    view.y = pinch.wy - (cy - r.top) / ns;
    applyView();
  }

  svg.addEventListener('pointerup', (ev) => {
    if (ev.pointerType === 'touch') { touchPts.delete(ev.pointerId); if (touchPts.size < 2) pinch = null; }
  });
  // runs after the handler above has closed out the drag: a press that never
  // travelled was a double-click after all, so act on it now
  svg.addEventListener('pointerup', () => {
    const d = dblPending;
    dblPending = null;
    if (d) handleDoubleClick(d.w);
  });
  svg.addEventListener('pointercancel', (ev) => {
    dblPending = null;
    if (ev.pointerType === 'touch') { touchPts.delete(ev.pointerId); if (touchPts.size < 2) pinch = null; }
  });

  // when a segment is split, notches/slits on that segment must be remapped
  function remapAfterInsert(piece, seg, t) {
    for (const arr of [piece.notches || [], piece.stitchSlits || []]) {
      for (const nt of arr) {
        if (nt.cut != null) continue; // cutout-anchored: outline splits don't touch it
        if (nt.seg > seg) nt.seg += 1;
        else if (nt.seg === seg) {
          if (nt.t <= t) nt.t = t > 0 ? nt.t / t : 0;
          else { nt.seg += 1; nt.t = (nt.t - t) / (1 - t); }
        }
      }
    }
  }

  // extrude an edge: its endpoints stay as corners, a duplicated pair carries
  // the edge (curve included) outward — straight side walls form a tab/recess
  function extrudeSeg(piece, i) {
    const nodes = piece.path.nodes;
    const a = nodes[i], b = nodes[(i + 1) % nodes.length];
    const a2 = { x: a.x, y: a.y, hin: null, hout: a.hout ? { ...a.hout } : null };
    const b2 = { x: b.x, y: b.y, hin: b.hin ? { ...b.hin } : null, hout: null };
    a.hout = null; b.hin = null;
    nodes.splice(i + 1, 0, a2, b2);
    const remap = (m) => { if (m.seg === i) m.seg = i + 1; else if (m.seg > i) m.seg += 2; };
    for (const nt of piece.notches || []) remap(nt);
    for (const sl of piece.stitchSlits || []) { if (sl.cut == null) remap(sl); }
    if (piece.foldSeg != null) { const m = { seg: piece.foldSeg }; remap(m); piece.foldSeg = m.seg; }
    return i + 1; // index of the protruding edge
  }
  function collapseExtrude(piece, mid) { // inverse, only while the offset is back at 0
    const nodes = piece.path.nodes;
    const a2 = nodes[mid], b2 = nodes[mid + 1];
    const a = nodes[mid - 1], b = nodes[(mid + 2) % nodes.length];
    a.hout = a2.hout; b.hin = b2.hin;
    nodes.splice(mid, 2);
    const i = mid - 1;
    const remap = (m) => { if (m.seg === mid) m.seg = i; else if (m.seg > mid) m.seg -= 2; };
    for (const nt of piece.notches || []) remap(nt);
    for (const sl of piece.stitchSlits || []) { if (sl.cut == null) remap(sl); }
    if (piece.foldSeg != null) { const m = { seg: piece.foldSeg }; remap(m); piece.foldSeg = m.seg; }
    return i;
  }

  // per-node displacement (per unit of outward offset) for sliding a set of
  // edges together — mitred where two selected edges share a corner, so a
  // contiguous run outsets like a true offset instead of tearing apart
  function segsOffsetVectors(piece, segs) {
    const nodes = piece.path.nodes;
    const n = nodes.length;
    const closed = piece.path.closed;
    const os = closed ? Geo.outwardSign(Geo.pathPolyline(nodes, closed, 0.1)) : 1;
    const segNormal = (i) => {
      const t = Geo.segTangent(nodes[i], nodes[(i + 1) % n], 0.5);
      return { x: os * t.y, y: -os * t.x };
    };
    const set = new Set(segs);
    const vecs = new Map(); // node index -> unit-offset displacement
    for (const i of set) {
      for (const k of [i, (i + 1) % n]) {
        if (vecs.has(k)) continue;
        const inS = k > 0 ? k - 1 : (closed ? n - 1 : -1);
        const outS = (closed || k < n - 1) ? k : -1;
        const hasIn = inS >= 0 && set.has(inS);
        const hasOut = outS >= 0 && set.has(outS);
        let v;
        if (hasIn && hasOut) {
          const a = segNormal(inS), b = segNormal(outS);
          const dot = Math.max(-0.99, a.x * b.x + a.y * b.y); // clamp hairpin corners
          v = { x: (a.x + b.x) / (1 + dot), y: (a.y + b.y) / (1 + dot) };
        } else {
          v = segNormal(hasIn ? inS : outS);
        }
        vecs.set(k, v);
      }
    }
    return vecs;
  }

  function movePiece(piece, dx, dy) {
    for (const nd of piece.path.nodes) { nd.x += dx; nd.y += dy; }
    for (const h of piece.holes || []) { h.x += dx; h.y += dy; }
    for (const c of piece.cutouts || []) {
      for (const nd of c.nodes) { nd.x += dx; nd.y += dy; }
    }
    if (piece.grain) {
      piece.grain.x1 += dx; piece.grain.y1 += dy;
      piece.grain.x2 += dx; piece.grain.y2 += dy;
    }
  }

  // ---- select tool ----
  // Every handle that bends an edge meeting the selected point: its own two,
  // plus the facing handle of each neighbour. A curve is shaped from both ends,
  // so the far handle has to be grabbable (and deletable) here — otherwise an
  // edge stays curved with nothing on screen to grab.
  function handleTargets(piece) {
    if (!piece || sel.kind !== 'node') return [];
    const nodes = piece.path.nodes, n = nodes.length;
    if (!nodes[sel.idx]) return [];
    const out = [];
    const add = (idx, key, own) => {
      const node = nodes[idx];
      if (!node || !node[key]) return;
      out.push({ idx, key, own, node, p: { x: node.x + node[key].x, y: node.y + node[key].y } });
    };
    add(sel.idx, 'hin', true);
    add(sel.idx, 'hout', true);
    const closed = piece.path.closed;
    const prev = sel.idx > 0 ? sel.idx - 1 : (closed ? n - 1 : -1);
    const next = sel.idx < n - 1 ? sel.idx + 1 : (closed ? 0 : -1);
    if (prev >= 0 && prev !== sel.idx) add(prev, 'hout', false);
    if (next >= 0 && next !== sel.idx) add(next, 'hin', false);
    return out;
  }
  // pick a handle under the cursor — own handles win over a neighbour's, so a
  // far handle sitting near its own point never steals that point's click
  function hitHandle(piece, w, own) {
    for (const t of handleTargets(piece)) {
      if (t.own === own && Geo.dist(t.p, w) < px(8)) return t;
    }
    return null;
  }

  function hitNode(piece, w) {
    const tol = px(8);
    let best = -1, bd = tol;
    piece.path.nodes.forEach((nd, i) => {
      const d = Geo.dist(nd, w);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  // corner scale handles for the selected piece / group: they sit a little
  // outside the bounding box so they never fight with the outline's own nodes
  function scaleHandles(ids) {
    const pts = [];
    for (const id of ids) {
      const p = pieceById(id);
      if (!p || p.path.nodes.length < 2) continue;
      const ep = effPiece(p);
      pts.push(...Geo.pathPolyline(ep.path.nodes, ep.path.closed, 0.2));
    }
    if (!pts.length) return null;
    const bb = Geo.bbox(pts);
    const off = px(14) / Math.SQRT2;
    return {
      bb,
      rot: { x: (bb.minX + bb.maxX) / 2, y: bb.minY - px(24) },
      corners: [
        { x: bb.minX - off, y: bb.minY - off, ax: bb.maxX, ay: bb.maxY },
        { x: bb.maxX + off, y: bb.minY - off, ax: bb.minX, ay: bb.maxY },
        { x: bb.maxX + off, y: bb.maxY + off, ax: bb.minX, ay: bb.minY },
        { x: bb.minX - off, y: bb.maxY + off, ax: bb.maxX, ay: bb.minY },
      ],
    };
  }
  function scaleTargets() {
    if (multiSel.length > 1) return multiSel.slice();
    return selPiece() && sel.kind === null ? [sel.pieceId] : [];
  }

  // Moving is a second gesture: a press that changes the selection only
  // selects, and an armed move waits for DRAG_SLOP pixels of travel before it
  // touches the geometry — so a click that wobbles doesn't nudge anything.
  const DRAG_SLOP = 4;
  const downPt = (ev) => ({ x: ev.clientX, y: ev.clientY });

  function selectDown(ev, w) {
    const piece = selPiece();
    sel.handle = null; // any fresh press drops the handle focus; handle hits re-arm it
    // 0. corner scale handle of the selected piece / group (Shift is a
    // gathering gesture — it never grabs the handles)
    const scIds = ev.shiftKey ? [] : scaleTargets();
    if (scIds.length) {
      const sh = scaleHandles(scIds);
      if (sh) {
        if (Geo.dist(sh.rot, w) < px(9)) {
          const c = { x: (sh.bb.minX + sh.bb.maxX) / 2, y: (sh.bb.minY + sh.bb.maxY) / 2 };
          beginChange();
          drag = {
            type: 'rotate', ids: scIds, c,
            a0: Math.atan2(w.y - c.y, w.x - c.x), applied: 0,
          };
          return;
        }
        for (const c of sh.corners) {
          if (Geo.dist(c, w) < px(9)) {
            beginChange();
            drag = {
              type: 'scale', ids: scIds,
              anchor: { x: c.ax, y: c.ay }, start: { x: c.x, y: c.y }, applied: 1,
            };
            return;
          }
        }
      }
    }
    // 1. handle of the selected node (its own; a neighbour's comes after the
    // points, so a far handle near its owner can't swallow that point's click)
    if (piece && sel.kind === 'node') {
      const own = hitHandle(piece, w, true);
      if (own) {
        sel.handle = { idx: own.idx, key: own.key };
        beginChange();
        drag = { type: 'handle', pieceId: piece.id, idx: own.idx, key: own.key, dead: downPt(ev) };
        renderAll(true); renderSidebar();
        return;
      }
    }
    // 2. node of the selected piece
    if (piece) {
      const ni = hitNode(piece, w);
      if (ni >= 0) {
        if (sel.kind === 'nodes' && sel.nodes.includes(ni)) {
          // drag the whole point selection together
          beginChange();
          drag = { type: 'nodes', pieceId: piece.id, idxs: sel.nodes.slice(), start: w, applied: { x: 0, y: 0 }, dead: downPt(ev) };
          return;
        }
        if (sel.kind === 'node' && sel.idx === ni) { // already the selection: now it moves
          beginChange();
          drag = { type: 'node', pieceId: piece.id, idx: ni, dead: downPt(ev) };
          renderAll(true); renderSidebar(); // the press just dropped any handle focus
          return;
        }
        sel.kind = 'node'; sel.idx = ni; sel.nodes = [];
        renderAll(true); renderSidebar();
        return;
      }
      // 2a. facing handle of a neighbouring point — it bends an edge of the
      // selected point, so it is grabbable without selecting the other end
      const far = hitHandle(piece, w, false);
      if (far) {
        sel.handle = { idx: far.idx, key: far.key };
        beginChange();
        drag = { type: 'handle', pieceId: piece.id, idx: far.idx, key: far.key, dead: downPt(ev) };
        renderAll(true); renderSidebar();
        return;
      }
      // 2b. notch / slit / hole of the selected piece
      const nti = hitNotch(piece, w);
      if (nti >= 0) { sel.kind = 'notch'; sel.idx = nti; renderAll(true); renderSidebar(); return; }
      const sli = hitSlit(piece, w);
      if (sli >= 0) {
        delete sel.slitGroups;
        if (ev.shiftKey || sel.kind === 'slits') {
          // gather several stitch holes; click toggles once a set exists
          const set = new Set(sel.kind === 'slits' ? sel.slits
            : (sel.kind === 'slit' ? [sel.idx] : []));
          if (set.has(sli)) set.delete(sli); else set.add(sli);
          const arr = [...set].sort((a2, b2) => a2 - b2);
          sel.nodes = [];
          if (!arr.length) { sel.kind = null; sel.idx = -1; }
          else if (arr.length === 1) { sel.kind = 'slit'; sel.idx = arr[0]; }
          else { sel.kind = 'slits'; sel.slits = arr; sel.idx = -1; }
          renderAll(true); renderSidebar();
          return;
        }
        sel.kind = 'slit'; sel.idx = sli; renderAll(true); renderSidebar(); return;
      }
      const hi = (piece.holes || []).findIndex((h) => Geo.dist(h, w) < px(8));
      if (hi >= 0) { sel.kind = 'hole'; sel.idx = hi; renderAll(true); renderSidebar(); return; }
      // 2c. internal cutout ring of the selected piece
      const ci = (piece.cutouts || []).findIndex((c) => {
        if (!c.nodes || c.nodes.length < 3) return false;
        const h2 = Geo.nearestOnPath(c.nodes, true, w);
        return h2 && h2.dist < px(6);
      });
      if (ci >= 0) {
        if (sel.kind === 'cut' && sel.idx === ci) { // already the selection: now it moves
          beginChange();
          drag = { type: 'cutout', pieceId: piece.id, idx: ci, start: w, applied: { x: 0, y: 0 }, dead: downPt(ev) };
          return;
        }
        sel.kind = 'cut'; sel.idx = ci; sel.nodes = [];
        renderAll(true); renderSidebar();
        return;
      }
      // 3. segment of the selected piece — dragging moves the edge freely;
      // Shift-click gathers several edges into a set (the Offset tool then
      // slides/protrudes the same set along its normals)
      const hit = Geo.nearestOnPath(piece.path.nodes, piece.path.closed, w);
      if (hit && hit.dist < px(6) && multiSel.length <= 1) {
        if (ev.shiftKey) {
          const cur = new Set(selectedSegsOf(piece));
          if (cur.has(hit.seg)) cur.delete(hit.seg); else cur.add(hit.seg);
          setSegSelection(piece, [...cur].sort((x, y) => x - y));
          renderAll(true); renderSidebar();
          return;
        }
        if (sel.kind === 'segs' && sel.segs.includes(hit.seg)) {
          // drag any edge of the set: the whole set moves freely together
          const nn = piece.path.nodes.length;
          const ks = new Set();
          for (const i of sel.segs) { ks.add(i); ks.add((i + 1) % nn); }
          beginChange();
          drag = { type: 'nodes', pieceId: piece.id, idxs: [...ks], start: w, applied: { x: 0, y: 0 }, dead: downPt(ev) };
          return;
        }
        if (sel.kind === 'seg' && sel.idx === hit.seg) { // already the selection: now it moves
          beginChange();
          drag = { type: 'seg', pieceId: piece.id, idx: hit.seg, start: w, applied: { x: 0, y: 0 }, dead: downPt(ev) };
          return;
        }
        sel.kind = 'seg'; sel.idx = hit.seg; sel.nodes = [];
        renderAll(true); renderSidebar();
        return;
      }
    }
    // 4. any piece body / outline (topmost = last drawn)
    for (let i = doc.pieces.length - 1; i >= 0; i--) {
      const p = doc.pieces[i];
      if (p.visible === false || p.path.nodes.length < 2) continue;
      const ep = effPiece(p); // clicking the mirrored half of a folded piece counts too
      const poly = Geo.pathPolyline(ep.path.nodes, ep.path.closed, 0.1);
      const onEdge = Geo.nearestOnPath(ep.path.nodes, ep.path.closed, w);
      const inside = ep.path.closed && Geo.pointInPolygon(poly, w);
      if (inside || (onEdge && onEdge.dist < px(6))) {
        if (ev.shiftKey) {
          // Shift-click: toggle the piece (guide lines included) in a group
          const set = new Set(multiSel.length ? multiSel : (sel.pieceId ? [sel.pieceId] : []));
          if (set.has(p.id)) set.delete(p.id); else set.add(p.id);
          const ids = [...set];
          clearSel();
          if (ids.length) {
            sel.pieceId = ids[0];
            multiSel = ids;
            $('status-hint').textContent =
              `${ids.length} piece${ids.length > 1 ? 's' : ''} selected — drag or arrow keys move them together · Shift-click adds/removes · Del deletes`;
          }
          renderAll(true); renderSidebar();
          return;
        }
        if (multiSel.length > 1 && multiSel.includes(p.id)) {
          // drag the whole marquee group together
          beginChange();
          drag = { type: 'piece', ids: multiSel.slice(), start: w, applied: { x: 0, y: 0 }, dead: downPt(ev) };
          return;
        }
        if (sel.pieceId === p.id && sel.kind === null) { // already the selection: now it moves
          beginChange();
          drag = { type: 'piece', ids: [p.id], start: w, applied: { x: 0, y: 0 }, dead: downPt(ev) };
          return;
        }
        selectPiece(p.id);
        renderAll(true); renderSidebar();
        return;
      }
    }
    // 5. empty space: marquee — points of the already-selected piece (Shift:
    // its edges), else pieces
    drag = { type: 'marquee', a: w, b: w, prevPieceId: sel.pieceId, shift: ev.shiftKey };
    renderAll(true); renderSidebar();
  }

  function hitNotch(piece, w) {
    if (!piece.path.closed) return -1;
    const nodes = piece.path.nodes;
    let best = -1, bd = px(8);
    (piece.notches || []).forEach((nt, i) => {
      if (nt.seg >= nodes.length) return;
      const p = Geo.segPoint(nodes[nt.seg], nodes[(nt.seg + 1) % nodes.length], nt.t);
      const d = Geo.dist(p, w);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function hitSlit(piece, w) {
    const slits = piece.stitchSlits || [];
    if (!slits.length) return -1;
    let best = -1, bd = px(6);
    const centers = [];
    slits.forEach((sl, i) => {
      const ln = slitLineFor(piece, sl);
      if (!ln) { centers.push(null); return; }
      const p = Geo.lerp(ln.a, ln.b, 0.5);
      centers.push(p);
      const d = Geo.nearestOnPath([{...ln.a}, {...ln.b}], false, w).dist - (sl.width || 0) / 2;
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return -1;
    // slits sit ON the edge, so an edge with a stitch run would soak up every
    // click — individual slits are only pickable once zoomed in far enough to
    // tell them apart; otherwise the click belongs to the edge
    let gap = Infinity;
    centers.forEach((c, i) => {
      if (i === best || !c) return;
      const d = Geo.dist(c, centers[best]);
      if (d < gap) gap = d;
    });
    if (tool !== 'stitch' && gap * view.scale < 16) return -1;
    return best;
  }

  // ---- pen tool: typed segment length (right-click while drafting) ----
  // Angle convention shown to the user: 0° = right, 90° = up, counter-clockwise
  // (document space is y-down, so dy = -sin).
  function openPenDialog(ev) {
    const last = draft.nodes[draft.nodes.length - 1];
    const ref = draft.mouse || screenToWorld(ev);
    const dx = ref.x - last.x, dy = ref.y - last.y;
    const len = Math.hypot(dx, dy);
    $('pd-len').value = len > 0.05 ? fmt(len) : '';
    $('pd-ang').value = len > 0.05 ? Math.round(Math.atan2(-dy, dx) * 180 / Math.PI) : 0;
    const dlg = $('pen-dialog');
    const wrap = $('canvas-wrap').getBoundingClientRect();
    dlg.hidden = false;
    dlg.style.left = Math.min(ev.clientX - wrap.left + 12, wrap.width - 190) + 'px';
    dlg.style.top = Math.min(ev.clientY - wrap.top + 12, wrap.height - 110) + 'px';
    $('pd-len').focus();
    $('pd-len').select();
  }
  function closePenDialog() { $('pen-dialog').hidden = true; svg.focus(); }
  function commitPenDialog() {
    if (!draft || !draft.nodes.length) { closePenDialog(); return; }
    const len = parseFloat($('pd-len').value);
    const ang = (parseFloat($('pd-ang').value) || 0) * Math.PI / 180;
    if (!(len > 0)) { closePenDialog(); return; }
    const last = draft.nodes[draft.nodes.length - 1];
    const p = { x: last.x + len * Math.cos(ang), y: last.y - len * Math.sin(ang) };
    draft.nodes.push({ x: p.x, y: p.y, hin: null, hout: null });
    draft.mouse = { x: p.x, y: p.y };
    closePenDialog();
    renderPenPreview();
  }
  svg.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (tool === 'pen' && draft && draft.nodes.length) { openPenDialog(ev); return; }
    if (tool === 'select' || tool === 'notch') {
      const w = screenToWorld(ev);
      const sp = selPiece();
      // a point first: right-click opens the node menu
      let np = null;
      if (sp) {
        const ni = hitNode(sp, w);
        if (ni >= 0) np = { piece: sp, idx: ni };
      }
      if (!np) {
        for (const p of doc.pieces) {
          if (p.visible === false || p.guide) continue;
          const ni = hitNode(p, w);
          if (ni >= 0) { np = { piece: p, idx: ni }; break; }
        }
      }
      if (np) {
        selectPiece(np.piece.id);
        sel.kind = 'node';
        sel.idx = np.idx;
        renderAll(true);
        renderSidebar();
        openNodeDialog(ev, np.piece, np.idx);
        return;
      }
      // otherwise an edge: divide dialog
      let pick = null;
      if (sp && sp.path.nodes.length >= 2) {
        const hit = Geo.nearestOnPath(sp.path.nodes, sp.path.closed, w);
        if (hit && hit.dist < px(8)) pick = { piece: sp, hit };
      }
      if (!pick) pick = nearestEdgeAt(w, true);
      if (pick) {
        selectPiece(pick.piece.id);
        sel.kind = 'seg';
        sel.idx = pick.hit.seg;
        renderAll(true);
        renderSidebar();
        openDivideDialog(ev, pick.piece, pick.hit.seg);
      }
    }
  });

  // ---- node dialog (right-click a point) ----
  function openNodeDialog(ev, piece, idx) {
    const nd = piece.path.nodes[idx];
    $('nd-smooth').textContent = nd.hin || nd.hout
      ? 'Convert to corner (remove handles)'
      : 'Convert to curve point (add handles)';
    const dlg = $('node-dialog');
    const wrap = $('canvas-wrap').getBoundingClientRect();
    dlg.hidden = false;
    dlg.style.left = Math.min(ev.clientX - wrap.left + 12, wrap.width - 240) + 'px';
    dlg.style.top = Math.min(ev.clientY - wrap.top + 12, wrap.height - 130) + 'px';
  }
  function closeNodeDialog() { $('node-dialog').hidden = true; svg.focus(); }

  function toggleNodeSmooth(piece, ni) {
    beginChange();
    const nodes = piece.path.nodes;
    const nd = nodes[ni];
    if (nd.hin || nd.hout) {
      nd.hin = null;
      nd.hout = null;
    } else {
      const n = nodes.length;
      const prev = nodes[(ni - 1 + n) % n], next = nodes[(ni + 1) % n];
      const dir = Geo.norm(Geo.sub(next, prev));
      const l1 = Geo.dist(nd, prev) / 3, l2 = Geo.dist(nd, next) / 3;
      nd.hin = Geo.scale(dir, -Math.max(0.3, l1));
      nd.hout = Geo.scale(dir, Math.max(0.3, l2));
    }
    endChange();
  }

  $('nd-smooth').addEventListener('click', () => {
    const p = selPiece();
    if (!p || sel.kind !== 'node' || !p.path.nodes[sel.idx]) { closeNodeDialog(); return; }
    toggleNodeSmooth(p, sel.idx);
    closeNodeDialog();
    renderAll();
  });
  $('nd-round-btn').addEventListener('click', () => {
    const p = selPiece();
    if (!p || sel.kind !== 'node' || !p.path.nodes[sel.idx]) { closeNodeDialog(); return; }
    const R = parseFloat($('nd-round-r').value);
    if (!(R > 0)) { alert('Radius must be positive.'); return; }
    closeNodeDialog();
    roundCorner(p, sel.idx, R);
  });
  $('nd-del').addEventListener('click', () => {
    closeNodeDialog();
    deleteSelection();
  });
  $('nd-round-r').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { $('nd-round-btn').click(); ev.preventDefault(); }
    else if (ev.key === 'Escape') { closeNodeDialog(); ev.preventDefault(); }
    ev.stopPropagation();
  });

  // ---- divide-edge dialog (right-click an edge with the Select tool) ----
  function openDivideDialog(ev, piece, seg) {
    const n = piece.path.nodes.length;
    const len = Geo.segLength(piece.path.nodes[seg], piece.path.nodes[(seg + 1) % n]);
    $('dv-dist').value = fmt(len / 2);
    $('dv-pct').value = 50;
    $('dv-hint').textContent = `Edge is ${fmt(len)} cm · measured from its start (●) · Esc closes`;
    const dlg = $('divide-dialog');
    const wrap = $('canvas-wrap').getBoundingClientRect();
    dlg.hidden = false;
    dlg.style.left = Math.min(ev.clientX - wrap.left + 12, wrap.width - 250) + 'px';
    dlg.style.top = Math.min(ev.clientY - wrap.top + 12, wrap.height - 140) + 'px';
    $('dv-dist').focus();
    $('dv-dist').select();
    renderDivideGhosts('dist');
  }
  function closeDivideDialog() {
    $('divide-dialog').hidden = true;
    clear(gPreview);
    svg.focus();
  }

  // ghost preview of the would-be point(s) for the given mode, live as you type
  let dvLastMode = 'dist';
  function renderDivideGhosts(mode) {
    dvLastMode = mode;
    clear(gPreview);
    const p = selPiece();
    if (!p || sel.kind !== 'seg' || $('divide-dialog').hidden) return;
    const n = p.path.nodes.length;
    const a = p.path.nodes[sel.idx], b = p.path.nodes[(sel.idx + 1) % n];
    const len = Geo.segLength(a, b);
    const fromEnd = $('dv-from').value === 'end';
    let fr = [];
    if (mode === 'dist') {
      const d = parseFloat($('dv-dist').value);
      if (d > 0 && d < len) fr = [fromEnd ? 1 - d / len : d / len];
    } else if (mode === 'pct') {
      const q = parseFloat($('dv-pct').value);
      if (q > 0 && q < 100) fr = [fromEnd ? 1 - q / 100 : q / 100];
    } else {
      const k = Math.round(parseFloat($('dv-n').value));
      if (k >= 2 && k <= 50) for (let i = 1; i < k; i++) fr.push(i / k);
    }
    for (const t of Geo.segArcParams(a, b, fr)) {
      const q = Geo.segPoint(a, b, t);
      el('circle', { class: 'ghost-dot', cx: q.x, cy: q.y, r: px(4.5) }, gPreview);
    }
  }

  // insert points at the given arc-length fractions (ascending, exclusive 0/1)
  function divideSelectedEdge(fractions) {
    const p = selPiece();
    if (!p || sel.kind !== 'seg') { closeDivideDialog(); return; }
    if (p.foldSeg === sel.idx) {
      alert('The fold line must stay a single straight edge — remove the fold first.');
      return;
    }
    const n = p.path.nodes.length;
    const a = p.path.nodes[sel.idx], b = p.path.nodes[(sel.idx + 1) % n];
    const ts = Geo.segArcParams(a, b, fractions);
    beginChange();
    // insert from the far end inward: each split keeps the lower part as
    // sel.idx, and bezier parameters rescale linearly
    let prev = 1;
    for (let i = ts.length - 1; i >= 0; i--) {
      insertNodeAt(p, sel.idx, Math.min(0.999, Math.max(0.001, ts[i] / prev)));
      prev = ts[i];
    }
    endChange();
    closeDivideDialog();
    renderAll();
    $('status-hint').textContent = `Added ${ts.length} point${ts.length > 1 ? 's' : ''} on the edge`;
  }

  $('dv-dist-btn').addEventListener('click', () => {
    const p = selPiece();
    if (!p || sel.kind !== 'seg') return;
    const n = p.path.nodes.length;
    const len = Geo.segLength(p.path.nodes[sel.idx], p.path.nodes[(sel.idx + 1) % n]);
    const d = parseFloat($('dv-dist').value);
    if (!(d > 0) || d >= len) { alert(`Distance must be between 0 and ${fmt(len)} cm.`); return; }
    const f = d / len;
    divideSelectedEdge([$('dv-from').value === 'end' ? 1 - f : f]);
  });
  $('dv-pct-btn').addEventListener('click', () => {
    const pct = parseFloat($('dv-pct').value);
    if (!(pct > 0) || pct >= 100) { alert('Percentage must be between 0 and 100.'); return; }
    const f = pct / 100;
    divideSelectedEdge([$('dv-from').value === 'end' ? 1 - f : f]);
  });
  $('dv-n-btn').addEventListener('click', () => {
    const k = Math.round(parseFloat($('dv-n').value));
    if (!(k >= 2) || k > 50) { alert('Parts must be between 2 and 50.'); return; }
    const fr = [];
    for (let i = 1; i < k; i++) fr.push(i / k);
    divideSelectedEdge(fr);
  });
  {
    const dvModes = { 'dv-dist': 'dist', 'dv-pct': 'pct', 'dv-n': 'n' };
    for (const id of ['dv-dist', 'dv-pct', 'dv-n']) {
      $(id).addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { $(id + '-btn').click(); ev.preventDefault(); }
        else if (ev.key === 'Escape') { closeDivideDialog(); ev.preventDefault(); }
        ev.stopPropagation();
      });
      $(id).addEventListener('input', () => renderDivideGhosts(dvModes[id]));
      $(id).addEventListener('focus', () => renderDivideGhosts(dvModes[id]));
    }
    $('dv-from').addEventListener('change', () => renderDivideGhosts(dvLastMode));
  }
  for (const id of ['pd-len', 'pd-ang']) {
    $(id).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { commitPenDialog(); ev.preventDefault(); }
      else if (ev.key === 'Escape') { closePenDialog(); ev.preventDefault(); }
      ev.stopPropagation();
    });
  }

  // ---- pen tool ----
  function penDown(w) {
    const p = snap(w);
    if (!draft) draft = { nodes: [], mouse: p };
    if (draft.nodes.length > 2 && Geo.dist(p, draft.nodes[0]) < px(10)) {
      finishDraft(true);
      return;
    }
    draft.nodes.push({ x: p.x, y: p.y, hin: null, hout: null });
    drag = { type: 'pen-handle' };
    renderPenPreview();
  }

  // ---- notch / hole / grain ----
  function pickPieceAt(w, needInside) {
    const cand = [];
    if (selPiece()) cand.push(selPiece());
    for (const p of doc.pieces) if (!cand.includes(p)) cand.push(p);
    for (const p of cand) {
      if (!p || p.visible === false || p.path.nodes.length < 2) continue;
      if (needInside) {
        if (!p.path.closed) continue;
        const poly = Geo.pathPolyline(p.path.nodes, p.path.closed, 0.1);
        if (Geo.pointInPolygon(poly, w)) return { piece: p };
      } else {
        const hit = Geo.nearestOnPath(p.path.nodes, p.path.closed, w);
        if (hit && hit.dist < px(10)) return { piece: p, hit };
      }
    }
    return null;
  }

  function notchDown(w) {
    const res = pickPieceAt(w, false);
    if (!res || !res.piece.path.closed) return;
    // notches anchor to POINTS only: snap to the outline node nearest the
    // click — divide an edge first to put a point exactly where you need it
    const nodes = res.piece.path.nodes;
    let bi = 0, bd = Infinity;
    nodes.forEach((nd, i) => {
      const d = Math.hypot(nd.x - w.x, nd.y - w.y);
      if (d < bd) { bd = d; bi = i; }
    });
    beginChange();
    res.piece.notches = res.piece.notches || [];
    res.piece.notches.push({ seg: bi, t: 0 });
    endChange();
    selectPiece(res.piece.id);
    $('status-hint').textContent =
      `Notch snapped to the point at ${fmt(nodes[bi].x)}, ${fmt(nodes[bi].y)} — divide an edge (right-click it) to add points`;
    renderAll();
  }

  function holeDown(w) {
    const diameter = Number($('hole-diameter').value);
    if (!Number.isFinite(diameter) || diameter < 0.5 || diameter > 100) { $('status-hint').textContent = 'Hole diameter must be 0.5–100 mm.'; return; }
    const res = pickPieceAt(w, true);
    if (!res) return;
    beginChange();
    res.piece.holes = res.piece.holes || [];
    res.piece.holes.push({ x: snap(w).x, y: snap(w).y, r: diameter / 20 });
    endChange();
    selectPiece(res.piece.id);
    renderAll();
  }

  // ---- weld / stitch edge picking ----
  function nearestEdgeAt(w, allowOpen) {
    let best = null;
    for (const p of doc.pieces) {
      if (p.visible === false || p.path.nodes.length < 2) continue;
      if (!allowOpen && (!p.path.closed || p.path.nodes.length < 3)) continue;
      const hit = Geo.nearestOnPath(p.path.nodes, p.path.closed, w);
      if (hit && hit.dist < px(10) && (!best || hit.dist < best.hit.dist)) best = { piece: p, hit };
    }
    return best;
  }

  function weldDown(w) {
    const res = nearestEdgeAt(w);
    if (!res || res.piece.guide) return; // guides are markings, not weldable geometry
    if (!weldFirst || weldFirst.pieceId === res.piece.id || !pieceById(weldFirst.pieceId)) {
      weldFirst = { pieceId: res.piece.id, seg: res.hit.seg };
      selectPiece(res.piece.id);
      $('status-hint').textContent = 'Now click the matching edge on the other piece · Esc cancels';
      renderAll(true); renderSidebar();
      return;
    }
    weldPieces(pieceById(weldFirst.pieceId), weldFirst.seg, res.piece, res.hit.seg);
  }

  function weldPieces(pA, segA, pB, segB) {
    if (isFolded(pA) || isFolded(pB)) {
      alert('One of these pieces has a fold line. Unfold it first (select the piece and press "Unfold now"), then weld.');
      return;
    }
    const res = Geo.weldClosedPaths(pA.path.nodes, segA, pB.path.nodes, segB, 0.3);
    if (res.error) {
      if (res.error === 'length-mismatch') {
        alert(`These edges don't match: ${fmt(res.dA)} cm vs ${fmt(res.dB)} cm between their end points.\n` +
          'Make them equal first (select an edge and type into the Length field), then weld again.');
      }
      return;
    }
    beginChange();
    const notches = [];
    for (const nt of pA.notches || []) {
      const s = res.segMapA[nt.seg];
      if (s != null) notches.push({ seg: s, t: nt.t });
    }
    for (const nt of pB.notches || []) {
      const s = res.segMapB[nt.seg];
      if (s != null) notches.push({ seg: s, t: res.flipT ? 1 - nt.t : nt.t });
    }
    // stitch slits ride along the same way; those on the welded seam vanish
    // with it. Cutout-anchored slits follow their cutout (B's indices shift
    // past A's cutout list).
    const cutBase = (pA.cutouts || []).length;
    const stitchSlits = [];
    for (const sl of pA.stitchSlits || []) {
      if (sl.cut != null) { stitchSlits.push(Object.assign({}, sl)); continue; }
      const s = res.segMapA[sl.seg];
      if (s != null) stitchSlits.push(Object.assign({}, sl, { seg: s }));
    }
    for (const sl of pB.stitchSlits || []) {
      if (sl.cut != null) { stitchSlits.push(Object.assign({}, sl, { cut: sl.cut + cutBase })); continue; }
      const s = res.segMapB[sl.seg];
      if (s != null) stitchSlits.push(Object.assign({}, sl, { seg: s, t: res.flipT ? 1 - sl.t : sl.t }));
    }
    const holes = (pA.holes || []).concat((pB.holes || []).map((h) => {
      const p = res.xform(h);
      return { x: p.x, y: p.y, r: h.r };
    }));
    let grain = pA.grain;
    if (!grain && pB.grain) {
      const a = res.xform({ x: pB.grain.x1, y: pB.grain.y1 });
      const b = res.xform({ x: pB.grain.x2, y: pB.grain.y2 });
      grain = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    // existing internal cutouts ride along (B's rigidly transformed with it)
    const xformNode = (nd) => {
      const p = res.xform(nd);
      const h = (hh) => {
        if (!hh) return null;
        const q = res.xform({ x: nd.x + hh.x, y: nd.y + hh.y });
        return { x: q.x - p.x, y: q.y - p.y };
      };
      return { x: p.x, y: p.y, hin: h(nd.hin), hout: h(nd.hout) };
    };
    const cutouts = (pA.cutouts || []).map((c) => ({ nodes: c.nodes.map((nd) => ({ ...nd })) }))
      .concat((pB.cutouts || []).map((c) => ({ nodes: c.nodes.map(xformNode) })));
    // seam leftovers lying exactly on top of each other (two mirrored halves
    // of a hole meeting along the join) sew up: the doubled line disappears
    // and the enclosed loop becomes an internal cutout, cut but intact
    let outline = res.nodes;
    const sew = Geo.sewSlits(res.nodes, 0.02);
    if (sew) {
      outline = sew.outline;
      for (const c of sew.cutouts) cutouts.push({ nodes: c });
      const remap = (arr) => arr.filter((m) => {
        if (m.cut != null) return true; // cutout-anchored: outline sewing is irrelevant
        const to = sew.segMap[m.seg];
        if (!to || to.loop !== -1) return false; // died with the slit / on a cutout
        m.seg = to.seg;
        return true;
      });
      remap(notches);
      remap(stitchSlits);
    }
    pA.path.nodes = outline;
    pA.notches = notches;
    pA.holes = holes;
    pA.stitchSlits = stitchSlits;
    pA.grain = grain;
    pA.cutouts = cutouts;
    // keep both names while that stays readable, else fall back to a suffix
    const merged = pA.name + '+' + pB.name;
    pA.name = merged.length <= 40 ? uniqueName(merged, pA.id) : decorate(pA.name, 'welded', pA.id);
    doc.pieces = doc.pieces.filter((p) => p.id !== pB.id);
    endChange();
    weldFirst = null;
    selectPiece(pA.id);
    setTool('select');
    renderAll();
  }

  // ---- inset tool: guide lines for stitching ----
  // Each click on an edge TOGGLES it in the current selection (any order);
  // guides regenerate from the contiguous runs, mitered around corners.
  let insetChain = null; // { pieceId, d, segs: Set, guideIds: [] }

  // ---- offset tool: slide / protrude / guide, over a set of selected edges ----
  function setSegSelection(piece, segs) {
    sel.pieceId = piece.id;
    sel.nodes = [];
    multiSel = [];
    if (!segs.length) { sel.kind = null; sel.idx = -1; }
    else if (segs.length === 1) { sel.kind = 'seg'; sel.idx = segs[0]; }
    else { sel.kind = 'segs'; sel.segs = segs; sel.idx = -1; }
  }
  function selectedSegsOf(piece) {
    if (sel.pieceId !== piece.id) return [];
    if (sel.kind === 'segs') return sel.segs.slice();
    if (sel.kind === 'seg') return [sel.idx];
    return [];
  }

  function offsetDown(w) {
    if ($('of-mode').value === 'guide') {
      // guide mode: click toggles an edge in the run / inside = full ring;
      // drag box-adds — resolved on pointerup
      drag = { type: 'marquee', mode: 'inset', a: w, b: w };
      return;
    }
    // slide / protrude: build an edge selection, drag a selected edge to apply
    let best = null;
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide || p.path.nodes.length < 2) continue;
      const hit = Geo.nearestOnPath(p.path.nodes, p.path.closed, w);
      if (hit && hit.dist < px(8) && (!best || hit.dist < best.hit.dist)) best = { piece: p, hit };
    }
    if (!best) {
      drag = { type: 'marquee', mode: 'offset-add', a: w, b: w };
      return;
    }
    const piece = best.piece, seg = best.hit.seg;
    const cur = selectedSegsOf(piece);
    if (cur.includes(seg)) {
      // drag applies the mode to the whole set; a plain click deselects (on up)
      startOffsetDrag(piece, seg, w, cur);
      return;
    }
    cur.push(seg);
    setSegSelection(piece, cur.sort((x, y) => x - y));
    renderAll(true); renderSidebar();
  }

  function startOffsetDrag(piece, seg, w, segs) {
    const nn = piece.path.nodes.length;
    const tan = Geo.segTangent(piece.path.nodes[seg], piece.path.nodes[(seg + 1) % nn], 0.5);
    const os = piece.path.closed ? Geo.outwardSign(Geo.pathPolyline(piece.path.nodes, true, 0.1)) : 1;
    const n = { x: os * tan.y, y: -os * tan.x };
    beginChange();
    if ($('of-mode').value === 'extrude') {
      drag = {
        type: 'seg-extrude', pieceId: piece.id, segs, clickSeg: seg,
        start: w, applied: 0, n, inserted: false, entries: null,
      };
    } else {
      const vecs = segsOffsetVectors(piece, segs);
      const orig = {};
      for (const k of vecs.keys()) orig[k] = { x: piece.path.nodes[k].x, y: piece.path.nodes[k].y };
      drag = {
        type: 'segs', pieceId: piece.id, idx: seg, clickSeg: seg,
        start: w, applied: 0, n, vecs, orig,
      };
    }
  }

  function offsetBoxAdd(x0, y0, x1, y1) {
    const inside = (nd) => nd.x >= x0 && nd.x <= x1 && nd.y >= y0 && nd.y <= y1;
    let best = null; // the already-selected piece wins, then most edges caught
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide || p.path.nodes.length < 2) continue;
      const nodes = p.path.nodes;
      const n = nodes.length;
      const segCount = p.path.closed ? n : n - 1;
      const segs = [];
      for (let i = 0; i < segCount; i++) {
        if (inside(nodes[i]) && inside(nodes[(i + 1) % n])) segs.push(i);
      }
      if (!segs.length) continue;
      const score = segs.length + (sel.pieceId === p.id ? 1000 : 0);
      if (!best || score > best.score) best = { piece: p, segs, score };
    }
    if (!best) return;
    const cur = new Set(selectedSegsOf(best.piece));
    for (const s of best.segs) cur.add(s);
    setSegSelection(best.piece, [...cur].sort((x, y) => x - y));
  }

  // marquee for the inset tool: add every edge fully inside the box to the run
  function insetMarquee(x0, y0, x1, y1) {
    const d = Math.max(0.05, Math.abs(parseFloat($('of-dist').value)) || 0.3);
    const inside = (nd) => nd.x >= x0 && nd.x <= x1 && nd.y >= y0 && nd.y <= y1;
    let best = null; // the current chain's piece wins, then most edges caught
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide || !p.path.closed || p.path.nodes.length < 3) continue;
      const nodes = p.path.nodes;
      const n = nodes.length;
      const segs = [];
      for (let i = 0; i < n; i++) {
        if (inside(nodes[i]) && inside(nodes[(i + 1) % n])) segs.push(i);
      }
      if (!segs.length) continue;
      const score = segs.length + (insetChain && insetChain.pieceId === p.id ? 1000 : 0);
      if (!best || score > best.score) best = { piece: p, segs, score };
    }
    if (!best) return;
    const piece = best.piece;
    if (!insetChain || insetChain.pieceId !== piece.id || insetChain.d !== d) {
      insetChain = { pieceId: piece.id, d, segs: new Set(), guideIds: [] };
    }
    for (const s of best.segs) insetChain.segs.add(s);
    regenChainGuides(piece);
  }

  function insetClick(w) {
    const d = Math.max(0.05, Math.abs(parseFloat($('of-dist').value)) || 0.3);
    // an edge of a real (non-guide) closed piece → toggle it in the selection
    let bestEdge = null;
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide || !p.path.closed || p.path.nodes.length < 3) continue;
      const hit = Geo.nearestOnPath(p.path.nodes, p.path.closed, w);
      if (hit && hit.dist < px(10) && (!bestEdge || hit.dist < bestEdge.hit.dist)) bestEdge = { piece: p, hit };
    }
    if (bestEdge) {
      const piece = bestEdge.piece, seg = bestEdge.hit.seg;
      if (!insetChain || insetChain.pieceId !== piece.id || insetChain.d !== d) {
        insetChain = { pieceId: piece.id, d, segs: new Set(), guideIds: [] };
      }
      if (insetChain.segs.has(seg)) insetChain.segs.delete(seg);
      else insetChain.segs.add(seg);
      regenChainGuides(piece);
      return;
    }
    // otherwise: inside a piece → full-outline ring
    for (let i = doc.pieces.length - 1; i >= 0; i--) {
      const p = doc.pieces[i];
      if (p.visible === false || p.guide || !p.path.closed || p.path.nodes.length < 3) continue;
      const poly = Geo.pathPolyline(p.path.nodes, true, 0.1);
      if (Geo.pointInPolygon(poly, w)) {
        insetChain = null;
        const pts = Geo.offsetClosed(Geo.dedupe(Geo.pathPolyline(p.path.nodes, true, 0.02)), -d);
        if (pts.length < 3) return;
        newGuidePiece(Geo.simplifyPoly(pts, 0.01, true), true, decorate(p.name, 'stitch line'));
        return;
      }
    }
  }

  // rebuild the chain's guide pieces from its selected edges
  function regenChainGuides(piece) {
    const chain = insetChain;
    const n = piece.path.nodes.length;
    beginChange();
    doc.pieces = doc.pieces.filter((p) => !chain.guideIds.includes(p.id));
    chain.guideIds = [];
    if (!chain.segs.size) {
      endChange();
      insetChain = null;
      clearSel();
      renderAll();
      $('status-hint').textContent = HINTS.inset;
      return;
    }
    const mk = (nodes, closed, name) => {
      const gp = {
        id: uid(), name, visible: true, guide: true,
        seamAllowance: 0, notchLength: 0.4,
        path: { closed, nodes },
        notches: [], holes: [], stitchSlits: [], grain: null, foldSeg: null,
      };
      doc.pieces.push(gp);
      chain.guideIds.push(gp.id);
    };
    let runCount;
    if (chain.segs.size === n) {
      // every edge selected → full-outline ring
      const pts = Geo.offsetClosed(Geo.dedupe(Geo.pathPolyline(piece.path.nodes, true, 0.02)), -chain.d);
      if (pts.length >= 3) {
        mk(Geo.simplifyPoly(pts, 0.01, true).map((p) => ({ x: p.x, y: p.y, hin: null, hout: null })),
          true, decorate(piece.name, 'stitch line'));
      }
      runCount = 1;
    } else {
      // contiguous runs (any click order, wrap-aware)
      const arcs = [];
      for (let s0 = 0; s0 < n; s0++) {
        if (!chain.segs.has(s0) || chain.segs.has((s0 - 1 + n) % n)) continue;
        const arc = [s0];
        let nx = (s0 + 1) % n;
        while (chain.segs.has(nx)) { arc.push(nx); nx = (nx + 1) % n; }
        arcs.push(arc);
      }
      arcs.forEach((arc) => {
        mk(edgeGuideNodes(piece, arc, chain.d), false, decorate(piece.name, 'stitch line'));
      });
      runCount = arcs.length;
    }
    endChange();
    if (chain.guideIds.length) selectPiece(chain.guideIds[0]);
    renderAll();
    const e = chain.segs.size;
    $('status-hint').textContent =
      `${e} edge${e > 1 ? 's' : ''} → ${runCount} guide run${runCount > 1 ? 's' : ''} · click edges to add/remove · Esc finishes`;
  }

  // guide node list for a contiguous run of edges, offset inward with miters
  function edgeGuideNodes(piece, segs, d) {
    const nodes = piece.path.nodes, n = nodes.length;
    const s = Geo.outwardSign(Geo.pathPolyline(nodes, true, 0.05));
    let pts = [];
    segs.forEach((si, k) => {
      const fp = Geo.segFlatten(nodes[si], nodes[(si + 1) % n], 0.01);
      if (k) fp.shift(); // shared corner point
      pts = pts.concat(fp);
    });
    const off = Geo.offsetOpen(Geo.dedupe(pts), -d, s);
    return Geo.simplifyPoly(off, 0.01, false).map((p) => ({ x: p.x, y: p.y, hin: null, hout: null }));
  }

  function newGuidePiece(ptsOrNodes, closed, name) {
    const piece = {
      id: uid(), name, visible: true, guide: true,
      seamAllowance: 0, notchLength: 0.4,
      path: {
        closed,
        nodes: ptsOrNodes.map((p) => ({ x: p.x, y: p.y, hin: p.hin || null, hout: p.hout || null })),
      },
      notches: [], holes: [], stitchSlits: [], grain: null, foldSeg: null,
    };
    beginChange();
    doc.pieces.push(piece);
    endChange();
    selectPiece(piece.id);
    renderAll();
    $('status-hint').textContent = closed
      ? 'Guide ring created — use the Stitch tool to convert it to holes'
      : 'Guide line created — click an adjacent edge to extend it, or use the Stitch tool';
    return piece.id;
  }

  // ---- knife tool: cut a piece in two along a line or open path ----
  function insertNodeAt(piece, seg, t) {
    const nodes = piece.path.nodes;
    const n = nodes.length;
    const a = nodes[seg], b = nodes[(seg + 1) % n];
    const { a2, mid, b2 } = Geo.splitSeg(a, b, t);
    nodes[seg] = a2;
    nodes[(seg + 1) % n] = b2;
    nodes.splice(seg + 1, 0, mid);
    remapAfterInsert(piece, seg, t);
    if (piece.foldSeg != null && piece.foldSeg > seg) piece.foldSeg += 1;
    return seg + 1;
  }

  // knife precision: endpoints snap to existing nodes, then to points anywhere
  // along an outline (never the grid)
  function knifeSnap(w) {
    let best = null, bd = px(9);
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide) continue;
      for (const nd of p.path.nodes) {
        const d = Geo.dist(nd, w);
        if (d < bd) { bd = d; best = { x: nd.x, y: nd.y, snapped: true }; }
      }
    }
    if (best) return best;
    let be = px(7);
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide || p.path.nodes.length < 2) continue;
      const hit = Geo.nearestOnPath(p.path.nodes, p.path.closed, w);
      if (hit && hit.dist < be) { be = hit.dist; best = { x: hit.point.x, y: hit.point.y, snapped: true }; }
    }
    if (best) return best;
    // away from geometry: still respect alignment + grid (no ghost dot)
    const s = snap(w);
    return { x: s.x, y: s.y, snapped: false };
  }

  let knifeFirst = null; // first of the two cut points

  function knifeDown(w) {
    // clicking an open (non-guide) path uses it as the cut path
    if (!knifeFirst) {
      let bestPath = null;
      for (const p of doc.pieces) {
        if (p.visible === false || p.guide || p.path.closed || p.path.nodes.length < 2) continue;
        const hit = Geo.nearestOnPath(p.path.nodes, false, w);
        if (hit && hit.dist < px(8) && (!bestPath || hit.dist < bestPath.hit.dist)) bestPath = { piece: p, hit };
      }
      if (bestPath) {
        cutWithNodes(JSON.parse(JSON.stringify(bestPath.piece.path.nodes)), bestPath.piece);
        return;
      }
      knifeFirst = knifeSnap(w);
      clear(gPreview);
      if (knifeFirst.snapped) el('circle', { class: 'snap-dot', cx: knifeFirst.x, cy: knifeFirst.y, r: px(5) }, gPreview);
      $('status-hint').textContent = 'Now click the second cut point · Esc cancels';
      return;
    }
    // second point: perform the cut
    const b = knifeSnap(w);
    const a = knifeFirst;
    knifeFirst = null;
    clear(gPreview);
    if (Geo.dist(a, b) < 0.3) { $('status-hint').textContent = HINTS.knife; return; }
    // extend slightly past the points so a cut ending exactly on a node still
    // crosses the outline transversally
    const dir = Geo.norm(Geo.sub(b, a));
    const ea = Geo.add(a, Geo.scale(dir, -0.2));
    const eb = Geo.add(b, Geo.scale(dir, 0.2));
    cutWithNodes([
      { x: ea.x, y: ea.y, hin: null, hout: null },
      { x: eb.x, y: eb.y, hin: null, hout: null },
    ], null);
  }

  function cutWithNodes(cutNodes, sourcePiece) {
    for (let i = doc.pieces.length - 1; i >= 0; i--) {
      const p = doc.pieces[i];
      if (p.visible === false || p.guide || !p.path.closed || p.path.nodes.length < 3) continue;
      if (sourcePiece && p.id === sourcePiece.id) continue;
      const hits = Geo.pathIntersections(p.path.nodes, true, cutNodes, false);
      if (hits.length === 2) {
        if (isFolded(p)) { alert('Unfold this piece ("Unfold now") before cutting it.'); return; }
        performCut(p, cutNodes, hits, sourcePiece);
        return;
      }
      if (hits.length > 2) {
        alert(`The cut crosses "${p.name}" ${hits.length} times — cut in steps, two crossings at a time.`);
        return;
      }
    }
    alert('The cut must cross a piece exactly twice (enter and exit).');
  }

  // Resolve two intersection hits on a path to node indices: hits landing on
  // an existing node (within 0.05cm) REUSE that node — no sliver segments —
  // otherwise a node is inserted at the hit. Returns [idx0, idx1] matching the
  // order of `hits`, or null if both land on the same node.
  function resolveCutNodes(piece, hits, segKey, tKey) {
    const clampT = (t) => Math.min(0.995, Math.max(0.005, t));
    const nodes = piece.path.nodes;
    const n = nodes.length;
    const cls = hits.map((h) => {
      const seg = h[segKey], t = h[tKey];
      const a = nodes[seg], b = nodes[(seg + 1) % n];
      if (Geo.dist(h.point, a) < 0.05) return { node: seg };
      if (Geo.dist(h.point, b) < 0.05) return { node: (seg + 1) % n };
      return { seg, t };
    });
    const out = [null, null];
    const mids = [0, 1].filter((i) => cls[i].node === undefined);
    if (mids.length === 2) {
      // insert the higher position first so the second insertion stays valid
      const order = (cls[0].seg !== cls[1].seg ? cls[0].seg > cls[1].seg : cls[0].t > cls[1].t) ? [0, 1] : [1, 0];
      const hiIdx = insertNodeAt(piece, cls[order[0]].seg, clampT(cls[order[0]].t));
      const tLow = cls[order[1]].seg === cls[order[0]].seg ? cls[order[1]].t / cls[order[0]].t : cls[order[1]].t;
      out[order[1]] = insertNodeAt(piece, cls[order[1]].seg, clampT(tLow));
      out[order[0]] = hiIdx + 1; // shifted by the second (earlier) insertion
    } else if (mids.length === 1) {
      const mi = mids[0], ni = 1 - mi;
      const idx = insertNodeAt(piece, cls[mi].seg, clampT(cls[mi].t));
      out[mi] = idx;
      out[ni] = cls[ni].node >= idx ? cls[ni].node + 1 : cls[ni].node;
    } else {
      out[0] = cls[0].node;
      out[1] = cls[1].node;
    }
    return out[0] === out[1] ? null : out;
  }

  function performCut(target, cutNodesIn, hits, sourcePiece) {
    beginChange();
    // 1. resolve the two crossings on the outline (reusing nodes when hit)
    const clone = JSON.parse(JSON.stringify(target));
    const rA = resolveCutNodes(clone, hits, 'segA', 'tA');
    if (!rA) {
      endChange();
      alert('The cut enters and exits at the same point — nothing to split.');
      return;
    }
    const ia = rA[0], ib = rA[1];
    const n2 = clone.path.nodes.length;

    // 2. extract the cut path's middle chain between the intersections,
    //    keeping its curve handles
    const cutP = {
      path: { closed: false, nodes: JSON.parse(JSON.stringify(cutNodesIn)) },
      notches: [], stitchSlits: [], foldSeg: null,
    };
    const rB = resolveCutNodes(cutP, hits, 'segB', 'tB');
    if (!rB) {
      endChange();
      alert('The cut enters and exits at the same point — nothing to split.');
      return;
    }
    const M = cutP.path.nodes.slice(Math.min(rB[0], rB[1]), Math.max(rB[0], rB[1]) + 1);

    // 3. assemble the two halves: outline chain + cut chain (junction nodes
    //    merge, adopting the cut side's handles)
    const N = clone.path.nodes;
    const walk = (from, to) => {
      const arr = [];
      for (let k = from; ; k = (k + 1) % n2) {
        arr.push(JSON.parse(JSON.stringify(N[k])));
        if (k === to) break;
      }
      return arr;
    };
    const mStartsAtIa = Geo.dist(M[0], N[ia]) < Geo.dist(M[0], N[ib]);
    const build = (from, to, mChain) => {
      const nodes = walk(from, to);
      const last = nodes[nodes.length - 1];
      last.hout = mChain[0].hout ? { x: mChain[0].hout.x, y: mChain[0].hout.y } : null;
      for (let q = 1; q < mChain.length - 1; q++) nodes.push(JSON.parse(JSON.stringify(mChain[q])));
      nodes[0].hin = mChain[mChain.length - 1].hin
        ? { x: mChain[mChain.length - 1].hin.x, y: mChain[mChain.length - 1].hin.y } : null;
      return nodes;
    };
    const Mrev = Geo.reverseNodes(M);
    const nodesA = build(ia, ib, mStartsAtIa ? Mrev : M);  // A closes ib -> ia along the cut
    const nodesB = build(ib, ia, mStartsAtIa ? M : Mrev);  // B closes ia -> ib along the cut

    // 4. redistribute notches/slits by outline segment, holes/grain by side
    const lenA = (ib - ia + n2) % n2; // outline edge count in A
    const sideOf = (seg) => {
      const rel = (seg - ia + n2) % n2;
      return rel < lenA ? { side: 'A', seg: rel } : { side: 'B', seg: (seg - ib + n2) % n2 };
    };
    const nA = [], nB = [];
    for (const nt of clone.notches || []) {
      const m = sideOf(nt.seg);
      (m.side === 'A' ? nA : nB).push(Object.assign({}, nt, { seg: m.seg }));
    }
    const polyA = Geo.pathPolyline(nodesA, true, 0.05);
    const hA = [], hB = [];
    for (const h of clone.holes || []) (Geo.pointInPolygon(polyA, h) ? hA : hB).push(h);
    const cA = [], cB = [], cutMap = [];
    for (const c of clone.cutouts || []) {
      const cen = Geo.centroid(Geo.pathPolyline(c.nodes, true, 0.1));
      if (Geo.pointInPolygon(polyA, cen)) { cutMap.push({ side: 'A', idx: cA.length }); cA.push(c); }
      else { cutMap.push({ side: 'B', idx: cB.length }); cB.push(c); }
    }
    const sA = [], sB = [];
    for (const sl of clone.stitchSlits || []) {
      if (sl.cut != null) { // cutout slits follow their cutout to its half
        const m = cutMap[sl.cut];
        if (m) (m.side === 'A' ? sA : sB).push(Object.assign({}, sl, { cut: m.idx }));
        continue;
      }
      const m = sideOf(sl.seg);
      (m.side === 'A' ? sA : sB).push(Object.assign({}, sl, { seg: m.seg }));
    }
    let gA = null, gB = null;
    if (clone.grain) {
      const gm = { x: (clone.grain.x1 + clone.grain.x2) / 2, y: (clone.grain.y1 + clone.grain.y2) / 2 };
      if (Geo.pointInPolygon(polyA, gm)) gA = clone.grain; else gB = clone.grain;
    }

    // 5. write back: A replaces the original (same id), B is new
    // cutting a cut piece shouldn't stack counters ("Front 1 1 1")
    const base = target.name.replace(/\s+\d+$/, '').trim() || target.name;
    target.name = uniqueName(base + ' 1', target.id);
    target.path = { closed: true, nodes: nodesA };
    target.notches = nA;
    target.stitchSlits = sA;
    target.holes = hA;
    target.cutouts = cA;
    target.grain = gA;
    target.foldSeg = null;
    const pieceB = {
      id: uid(), name: uniqueName(base + ' 2'), visible: true,
      seamAllowance: target.seamAllowance, notchLength: target.notchLength,
      path: { closed: true, nodes: nodesB },
      notches: nB, stitchSlits: sB, holes: hB, cutouts: cB, grain: gB, foldSeg: null,
    };
    doc.pieces.splice(doc.pieces.indexOf(target) + 1, 0, pieceB);
    if (sourcePiece) doc.pieces = doc.pieces.filter((p) => p.id !== sourcePiece.id);
    endChange();
    selectPiece(target.id);
    renderAll();
    $('status-hint').textContent = `Cut "${base}" into "${target.name}" and "${pieceB.name}"` +
      (sourcePiece ? ' (cut path consumed)' : '');
  }

  // ---- round tool: drag outward from a corner, distance = radius ----
  function roundDown(w) {
    let best = null, bd = px(9);
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide) continue;
      p.path.nodes.forEach((nd, i) => {
        const d = Geo.dist(nd, w);
        if (d < bd) { bd = d; best = { piece: p, idx: i }; }
      });
    }
    if (!best) return;
    if (isFolded(best.piece)) { alert('Unfold this piece ("Unfold now") before rounding its corners.'); return; }
    const probe = filletParams(best.piece, best.idx, 0.01);
    if (probe.error) { $('status-hint').textContent = probe.error; return; }
    selectPiece(best.piece.id); sel.kind = 'node'; sel.idx = best.idx; renderSidebar();
    drag = { type: 'round', pieceId: best.piece.id, idx: best.idx, R: 0, maxR: probe.maxR };
    $('status-hint').textContent = 'Drag outward — the distance sets the radius · release to apply';
  }

  // ---- boolean tool: union / subtract / intersect two closed pieces ----
  let boolFirst = null; // piece id of the base (A)

  function boolPieceAt(w) {
    for (let i = doc.pieces.length - 1; i >= 0; i--) {
      const p = doc.pieces[i];
      if (p.visible === false || p.guide || !p.path.closed || p.path.nodes.length < 3) continue;
      const poly = Geo.pathPolyline(p.path.nodes, true, 0.1);
      const hit = Geo.nearestOnPath(p.path.nodes, true, w);
      if (Geo.pointInPolygon(poly, w) || (hit && hit.dist < px(6))) return p;
    }
    return null;
  }

  function boolDown(w) {
    const p = boolPieceAt(w);
    if (!p) return;
    if (isFolded(p)) { alert('Unfold this piece ("Unfold now") before boolean operations.'); return; }
    if (!boolFirst || !pieceById(boolFirst)) {
      boolFirst = p.id;
      selectPiece(p.id);
      renderAll(true); renderSidebar();
      $('status-hint').textContent = 'Now click the second piece (B) · Esc cancels';
      return;
    }
    if (p.id === boolFirst) {
      $('status-hint').textContent = 'Click a DIFFERENT piece — the base (A) is already picked.';
      return;
    }
    booleanPieces(pieceById(boolFirst), p, $('bl-op').value);
    boolFirst = null;
  }

  function booleanPieces(pA, pB, op) {
    const hits = Geo.pathIntersections(pA.path.nodes, true, pB.path.nodes, true);
    if (hits.length === 0) {
      // no crossings: one piece may sit entirely inside the other
      const polyA0 = Geo.pathPolyline(pA.path.nodes, true, 0.05);
      const polyB0 = Geo.pathPolyline(pB.path.nodes, true, 0.05);
      const bInA = pB.path.nodes.every((nd) => Geo.pointInPolygon(polyA0, nd));
      const aInB = pA.path.nodes.every((nd) => Geo.pointInPolygon(polyB0, nd));
      if (op === 'subtract' && bInA) {
        // punch B through A: it becomes an internal cutout (a real hole on CUT)
        beginChange();
        pA.cutouts = (pA.cutouts || []).concat(
          [{ nodes: pB.path.nodes.map((nd) => JSON.parse(JSON.stringify(nd))) }],
          (pB.cutouts || []).map((c) => ({ nodes: JSON.parse(JSON.stringify(c.nodes)) })));
        doc.pieces = doc.pieces.filter((q) => q.id !== pB.id);
        endChange();
        boolFirst = null;
        selectPiece(pA.id);
        setTool('select');
        renderAll();
        $('status-hint').textContent = `Subtract: "${pB.name}" punched through "${pA.name}" as an internal cutout`;
        return;
      }
      if (op === 'intersect' && (bInA || aInB)) {
        // the contained piece IS the intersection
        beginChange();
        doc.pieces = doc.pieces.filter((q) => q.id !== (bInA ? pA.id : pB.id));
        endChange();
        boolFirst = null;
        selectPiece(bInA ? pB.id : pA.id);
        setTool('select');
        renderAll();
        $('status-hint').textContent = 'Intersect: kept the contained piece';
        return;
      }
      if (op === 'union' && (bInA || aInB)) {
        // the containing piece IS the union
        beginChange();
        doc.pieces = doc.pieces.filter((q) => q.id !== (bInA ? pB.id : pA.id));
        endChange();
        boolFirst = null;
        selectPiece(bInA ? pA.id : pB.id);
        setTool('select');
        renderAll();
        $('status-hint').textContent = 'Union: kept the containing piece';
        return;
      }
      alert(op === 'subtract'
        ? 'The outlines don\'t touch. To punch a hole, place the piece to subtract fully inside the other; to trim, overlap the outlines.'
        : 'The two outlines don\'t cross — overlap the pieces first.');
      return;
    }
    if (hits.length !== 2) {
      alert(`The outlines cross ${hits.length} times — boolean ops currently need exactly 2 crossings.`);
      return;
    }
    beginChange();
    const cA = JSON.parse(JSON.stringify(pA));
    const cB = JSON.parse(JSON.stringify(pB));
    const rA = resolveCutNodes(cA, hits, 'segA', 'tA');
    const rB = resolveCutNodes(cB, hits, 'segB', 'tB');
    if (!rA || !rB) { endChange(); alert('Degenerate crossing — nothing to combine.'); return; }

    // both outlines split into two arcs at the shared crossing points;
    // classify each arc by whether its midpoint is inside the other piece
    const mkArc = (piece, from, to) => {
      const N = piece.path.nodes, n2 = N.length;
      const nodes = [];
      for (let k = from; ; k = (k + 1) % n2) {
        nodes.push(JSON.parse(JSON.stringify(N[k])));
        if (k === to) break;
      }
      return { nodes, from, edges: nodes.length - 1, total: n2 };
    };
    const arcsA = [mkArc(cA, rA[0], rA[1]), mkArc(cA, rA[1], rA[0])];
    const arcsB = [mkArc(cB, rB[0], rB[1]), mkArc(cB, rB[1], rB[0])];
    const polyA = Geo.pathPolyline(pA.path.nodes, true, 0.05);
    const polyB = Geo.pathPolyline(pB.path.nodes, true, 0.05);
    const arcInside = (arc, poly) => {
      const pos = Geo.pathArcParams(arc.nodes, false, [0.5])[0];
      return Geo.pointInPolygon(poly, Geo.segPoint(arc.nodes[pos.seg], arc.nodes[pos.seg + 1], pos.t));
    };
    const aOut = arcsA.find((a) => !arcInside(a, polyB)), aIn = arcsA.find((a) => arcInside(a, polyB));
    const bOut = arcsB.find((a) => !arcInside(a, polyA)), bIn = arcsB.find((a) => arcInside(a, polyA));
    const parts = op === 'union' ? [aOut, bOut] : op === 'intersect' ? [aIn, bIn] : [aOut, bIn];
    if (!parts[0] || !parts[1]) {
      endChange();
      alert('Could not classify the overlap — adjust the pieces and try again.');
      return;
    }

    // compose: A's arc, then B's arc oriented to close the loop (junction
    // nodes merge, adopting B's handles at the joins)
    const arcA = parts[0], arcB = parts[1];
    let bNodes = arcB.nodes;
    const aEnd = arcA.nodes[arcA.nodes.length - 1];
    if (Geo.dist(bNodes[0], aEnd) > Geo.dist(bNodes[bNodes.length - 1], aEnd)) {
      bNodes = Geo.reverseNodes(bNodes);
    }
    const nodes = arcA.nodes.map((nd) => JSON.parse(JSON.stringify(nd)));
    nodes[nodes.length - 1].hout = bNodes[0].hout ? { x: bNodes[0].hout.x, y: bNodes[0].hout.y } : null;
    for (let q = 1; q < bNodes.length - 1; q++) nodes.push(JSON.parse(JSON.stringify(bNodes[q])));
    nodes[0].hin = bNodes[bNodes.length - 1].hin
      ? { x: bNodes[bNodes.length - 1].hin.x, y: bNodes[bNodes.length - 1].hin.y } : null;

    // A's notches/slits survive on its kept arc; B's boundary marks are
    // dropped; holes from both stay if inside the result; A's grain if inside
    const keepSeg = (seg) => {
      const rel = (seg - arcA.from + arcA.total) % arcA.total;
      return rel < arcA.edges ? rel : null;
    };
    const notches = [], slits = [];
    for (const nt of cA.notches || []) {
      const s = keepSeg(nt.seg);
      if (s != null) notches.push(Object.assign({}, nt, { seg: s }));
    }
    for (const sl of cA.stitchSlits || []) {
      if (sl.cut != null) continue; // cutout indices reshuffle — re-stitch after
      const s = keepSeg(sl.seg);
      if (s != null) slits.push(Object.assign({}, sl, { seg: s }));
    }
    const resultPoly = Geo.pathPolyline(nodes, true, 0.05);
    const holes = (cA.holes || []).concat(cB.holes || []).filter((h) => Geo.pointInPolygon(resultPoly, h));
    const cutouts = (cA.cutouts || []).concat(cB.cutouts || []).filter((c) =>
      Geo.pointInPolygon(resultPoly, Geo.centroid(Geo.pathPolyline(c.nodes, true, 0.1))));
    let grain = null;
    if (cA.grain) {
      const gm = { x: (cA.grain.x1 + cA.grain.x2) / 2, y: (cA.grain.y1 + cA.grain.y2) / 2 };
      if (Geo.pointInPolygon(resultPoly, gm)) grain = cA.grain;
    }

    pA.path = { closed: true, nodes };
    pA.notches = notches;
    pA.stitchSlits = slits;
    pA.holes = holes;
    pA.cutouts = cutouts;
    pA.grain = grain;
    pA.foldSeg = null;
    doc.pieces = doc.pieces.filter((q) => q.id !== pB.id);
    endChange();
    selectPiece(pA.id);
    renderAll();
    const opName = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect' }[op];
    $('status-hint').textContent = `${opName}: "${pA.name}" ${op === 'subtract' ? '−' : op === 'union' ? '+' : '∩'} "${pB.name}"`;
  }

  // ---- stitch tool ----
  // each generated run gets an id so a whole stitch line can be picked and
  // deleted as one object (slits stay separate marks until DXF export)
  function nextStitchRun(piece) {
    return (piece.stitchSlits || []).reduce((m, s) => Math.max(m, s.run || 0), 0) + 1;
  }

  function stitchTargetKey(tg) {
    const p = pieceById(tg.pieceId);
    return tg.pieceId + '/' + (p && p.guide ? 'guide' : (tg.cut != null ? 'cut' + tg.cut : tg.seg));
  }

  // nearest internal cutout edge under the cursor, across all pieces
  function cutoutAt(w) {
    let best = null;
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide) continue;
      (p.cutouts || []).forEach((c, k) => {
        if (!c.nodes || c.nodes.length < 3) return;
        const hit = Geo.nearestOnPath(c.nodes, true, w);
        if (hit && hit.dist < px(10) && (!best || hit.dist < best.dist)) {
          best = { piece: p, cut: k, dist: hit.dist };
        }
      });
    }
    return best;
  }
  // ---- stitch tool state machine ----
  // Two explicit modes (st-mode): "single" runs holes along every selected
  // target independently; "matched" gathers side A, confirms, gathers side B,
  // then gives BOTH sides the same number of holes at matching fractions.
  function matchedLengthNotice(a, b) {
    if (Math.abs(a - b) < 0.01) return '';
    return `Unequal seam lengths: side A ${(a * 10).toFixed(1)} mm, side B ${(b * 10).toFixed(1)} mm. Original side A determines hole count; side B’s spacing adjusts to match. Check that this difference is intentional.`;
  }
  function updateStitchUi() {
    $('st-match-notice').hidden = true;
    if ($('st-workflow').value === 'edit') {
      $('status-hint').textContent = 'Edit stitches: click a hole or stitched edge, box-select holes across shapes · Shift adds/removes · Del removes selected holes';
      return;
    }
    const matched = $('st-mode').value === 'matched';
    if (matched && stitchSideA && stitchMulti.length) {
      const a = stitchChains(stitchSideA, 0), b = stitchChains(stitchMulti, 0);
      if (a.length === 1 && b.length === 1) {
        $('st-match-notice').textContent = matchedLengthNotice(Geo.pathLength(a[0].path, a[0].loop), Geo.pathLength(b[0].path, b[0].loop));
        $('st-match-notice').hidden = !$('st-match-notice').textContent;
      }
    }
    const btn = $('st-apply');
    const nSel = stitchMulti.length;
    const s2 = nSel > 1 ? 's' : '';
    if (!matched) {
      btn.textContent = 'Stitch selected';
      $('status-hint').textContent = nSel
        ? `${nSel} stitch target${s2} selected — Enter (or "Stitch selected") runs holes along each · click toggles · drag a box adds more · Esc cancels`
        : HINTS.stitch;
    } else if (!stitchSideA) {
      btn.textContent = 'Set side A \u25b8';
      $('status-hint').textContent = nSel
        ? `Side A: ${nSel} target${s2} — Enter (or "Set side A") confirms it, then pick side B`
        : 'Matched mode: select side A (click, Shift-click or drag a box), then Enter to confirm';
    } else {
      btn.textContent = 'Stitch matched';
      $('status-hint').textContent = nSel
        ? `Side B: ${nSel} target${s2} — Enter (or "Stitch matched") gives both sides the same holes`
        : `Side A set (${stitchSideA.length} target${stitchSideA.length > 1 ? 's' : ''}) — now select side B · Esc restarts`;
    }
  }

  function stitchDown(ev, w) {
    if ($('st-workflow').value === 'edit') return stitchEditDown(ev, w);
    const res = nearestEdgeAt(w, true);
    const co = cutoutAt(w);
    if (!res && !co) {
      // empty space: drag a box to gather many targets; a plain click clears
      drag = { type: 'marquee', mode: 'stitch-add', a: w, b: w };
      return;
    }
    // an internal cutout counts as a target too — whoever is closer wins
    const useCut = co && (!res || co.dist < res.hit.dist);
    const tg = useCut
      ? { pieceId: co.piece.id, cut: co.cut, seg: 0 }
      : { pieceId: res.piece.id, seg: res.hit.seg };
    const k = stitchTargetKey(tg);
    const idx = stitchMulti.findIndex((t) => stitchTargetKey(t) === k);
    if (idx >= 0) stitchMulti.splice(idx, 1); else stitchMulti.push(tg);
    updateStitchUi();
    renderAll(true);
  }

  // box-select stitch targets: edges with both endpoints inside; guide lines
  // and cutouts that fit entirely inside come in as whole-path targets
  function stitchBoxAdd(x0, y0, x1, y1) {
    const inside = (nd) => nd.x >= x0 && nd.x <= x1 && nd.y >= y0 && nd.y <= y1;
    const have = new Set(stitchMulti.map(stitchTargetKey));
    const add = (tg) => {
      const k = stitchTargetKey(tg);
      if (!have.has(k)) { have.add(k); stitchMulti.push(tg); }
    };
    for (const p of doc.pieces) {
      if (p.visible === false || p.path.nodes.length < 2) continue;
      if (p.guide) {
        if (p.path.nodes.every(inside)) add({ pieceId: p.id, seg: 0 });
        continue;
      }
      const n = p.path.nodes.length;
      const segCount = p.path.closed ? n : n - 1;
      for (let i = 0; i < segCount; i++) {
        if (inside(p.path.nodes[i]) && inside(p.path.nodes[(i + 1) % n])) add({ pieceId: p.id, seg: i });
      }
      (p.cutouts || []).forEach((c, k) => {
        if (c.nodes && c.nodes.length > 2 && c.nodes.every(inside)) add({ pieceId: p.id, cut: k, seg: 0 });
      });
    }
    updateStitchUi();
  }

  // Turn a target set into continuous CHAINS, each with the actual path the
  // holes run along (mitred inset for outline edges, offset ring for a full
  // outline or a cutout, the line itself for a guide) plus how to anchor the
  // holes back into the document.
  function stitchChains(targets, off) {
    const chains = [];
    const guideSeen = new Set();
    const segsByPiece = new Map();
    const mkNodes = (pts) => pts.map((q) => ({ x: q.x, y: q.y, hin: null, hout: null }));
    for (const tg of targets) {
      const p = pieceById(tg.pieceId);
      if (!p) continue;
      if (p.guide) {
        if (!guideSeen.has(p.id)) {
          guideSeen.add(p.id);
          chains.push({ piece: p, path: p.path.nodes, loop: p.path.closed, anchor: { kind: 'guide' }, inset:off });
        }
        continue;
      }
      if (tg.cut != null) {
        const c = (p.cutouts || [])[tg.cut];
        if (!c || c.nodes.length < 3) continue;
        const base = Geo.dedupe(Geo.pathPolyline(c.nodes, true, 0.02));
        const pts = off ? Geo.offsetClosed(base, off) : base; // outward = into material
        if (pts.length < 3) continue;
        chains.push({
          piece: p, loop: true, anchor: { kind: 'cut', cut: tg.cut },
          path: mkNodes(Geo.simplifyPoly(pts, 0.005, true)),
        });
        continue;
      }
      if (tg.seg >= p.path.nodes.length) continue;
      if (!segsByPiece.has(p.id)) segsByPiece.set(p.id, new Set());
      segsByPiece.get(p.id).add(tg.seg);
    }
    for (const [pid, set] of segsByPiece) {
      const p = pieceById(pid);
      const n = p.path.nodes.length;
      const closed = p.path.closed;
      const segCount = closed ? n : n - 1;
      if (closed && set.size === segCount) {
        // full outline: one closed loop, inset (or on the line when off = 0)
        const base = Geo.dedupe(Geo.pathPolyline(p.path.nodes, true, 0.02));
        const pts = off ? Geo.offsetClosed(base, -off) : base;
        if (pts.length >= 3) {
          chains.push({
            piece: p, loop: true, anchor: { kind: 'outline', segs:[...set] },
            path: mkNodes(Geo.simplifyPoly(pts, 0.005, true)),
          });
        }
        continue;
      }
      for (let s0 = 0; s0 < segCount; s0++) {
        if (!set.has(s0)) continue;
        const prev = closed ? (s0 - 1 + n) % n : s0 - 1;
        if (prev >= 0 && set.has(prev)) continue; // not the start of its arc
        const arc = [s0];
        let cur = s0;
        for (;;) {
          const nxt = closed ? (cur + 1) % n : cur + 1;
          if ((!closed && nxt >= segCount) || !set.has(nxt) || arc.length >= set.size) break;
          arc.push(nxt);
          cur = nxt;
        }
        chains.push({ piece: p, loop: false, anchor: { kind: 'outline', segs:arc.slice() }, path: edgeGuideNodes(p, arc, off) });
      }
    }
    return chains;
  }

  // Slant for holes about to be placed. Kept per hole so a run can be
  // re-angled later without touching the rest. abs = measured off the page
  // (all holes parallel) instead of off the edge (follows the outline).
  const clampAng = (v, dflt) => (Number.isFinite(v) ? Math.max(-180, Math.min(180, v)) : dflt);
  function stitchAngle() {
    return clampAng(parseFloat($('st-ang').value), -45);
  }
  function stitchAngleAbs() { return $('st-ang-ref').value === 'page'; }

  const STITCH_SETTINGS_KEY = 'patternStudioStitchSettings.v1';
  const stitchSettingIds = ['st-spacing', 'st-len', 'st-width', 'st-off', 'st-ang', 'st-ang-ref'];
  function saveStitchSettings() {
    const values = Object.fromEntries(stitchSettingIds.map(id => [id, $(id).value]));
    try { localStorage.setItem(STITCH_SETTINGS_KEY, JSON.stringify(values)); } catch (_) { /* storage unavailable */ }
    $('sp-run-spacing').value = Number($('st-spacing').value) * 10;
    $('sp-run-inset').value = Number($('st-off').value) * 10;
  }
  function restoreStitchSettings() {
    try {
      const values = JSON.parse(localStorage.getItem(STITCH_SETTINGS_KEY));
      for (const id of stitchSettingIds) {
        if (!values || typeof values[id] !== 'string') continue;
        const input = $(id), previous = input.value;
        input.value = values[id];
        if (!input.value || !input.checkValidity()) input.value = previous;
      }
    } catch (_) { /* missing/corrupt preferences: use defaults */ }
    $('sp-run-spacing').value = Number($('st-spacing').value) * 10;
    $('sp-run-inset').value = Number($('st-off').value) * 10;
    refreshAngEg();
  }
  for (const id of stitchSettingIds) $(id).addEventListener('input', () => {
    if (stitchSettingIds.every(key => $(key).value && $(key).checkValidity())) saveStitchSettings();
  });
  function rememberAppliedStitchSettings(values) {
    $('st-len').value = Number(values.len.toFixed(6));
    $('st-width').value = Number((values.width * 10).toFixed(6));
    $('st-ang').value = values.ang;
    $('st-ang-ref').value = values.abs ? 'page' : 'edge';
    saveStitchSettings();
    refreshAngEg();
  }

  // plain-language label for an angle, so the number isn't the only clue
  function angLabel(ang, abs) {
    if (!abs) {
      const a = ((ang % 180) + 180) % 180;
      if (a < 1 || a > 179) return '(along the edge)';
      if (Math.abs(a - 90) < 1) return '(square across the edge)';
      return '';
    }
    const a = ((ang % 180) + 180) % 180;
    if (a < 1 || a > 179) return '(horizontal ―)';
    if (Math.abs(a - 90) < 1) return '(vertical |)';
    if (Math.abs(a - 45) < 1) return '(diagonal ＼)';
    if (Math.abs(a - 135) < 1) return '(diagonal ／)';
    return '';
  }
  function refreshAngEg() {
    $('st-ang-eg').textContent = angLabel(stitchAngle(), stitchAngleAbs());
  }

  // place holes at the given arc-length fractions of a chain's path, anchoring
  // each back into the document (per-hole off/toff keep corner miters exact)
  function stitchPlaceRun(chain, fractions, slitLen, settings) {
    settings = settings || {width:Number($('st-width').value) / 10, ang:stitchAngle(), abs:stitchAngleAbs()};
    if (!Number.isFinite(settings.width) || settings.width < 0 || settings.width > slitLen) throw new Error('Slot width must be between 0 and slit length.');
    const piece = chain.piece;
    piece.stitchSlits = piece.stitchSlits || [];
    const run = nextStitchRun(piece);
    let placed = 0;
    if (chain.anchor.kind === 'guide') {
      for (const pos of Geo.pathArcParams(chain.path, chain.loop, fractions)) {
        const gs = { seg: pos.seg, t: pos.t, len: slitLen, width:settings.width, ang:settings.ang, off:chain.inset || 0, run };
        if (settings.abs) gs.abs = true;
        if (settings.pair) { gs.pair = settings.pair; gs.pairSide = settings.pairSide; }
        piece.stitchSlits.push(gs);
        placed++;
      }
      return placed;
    }
    const isCut = chain.anchor.kind === 'cut';
    const anchorNodes = isCut ? piece.cutouts[chain.anchor.cut].nodes : piece.path.nodes;
    const anchorClosed = isCut ? true : piece.path.closed;
    const nA = anchorNodes.length;
    const os = isCut
      ? -Geo.outwardSign(Geo.pathPolyline(anchorNodes, true, 0.05))
      : (piece.path.closed ? Geo.outwardSign(Geo.pathPolyline(anchorNodes, true, 0.05)) : 1);
    const piecePoly = !isCut && piece.path.closed ? Geo.pathPolyline(piece.path.nodes, true, 0.05) : null;
    for (const pos of Geo.pathArcParams(chain.path, chain.loop, fractions)) {
      const P = Geo.segPoint(chain.path[pos.seg], chain.path[(pos.seg + 1) % chain.path.length], pos.t);
      if (piecePoly && !Geo.pointInPolygon(piecePoly, P)) {
        // holes on the outline itself sit exactly on the boundary — only
        // reject when a real inset would land outside
        const bhit = Geo.nearestOnPath(piece.path.nodes, piece.path.closed, P);
        if (!bhit || bhit.dist > 0.05) throw new Error('The stitch run falls outside the piece. Reduce the inset.');
      }
      const hit = Geo.nearestOnPath(anchorNodes, anchorClosed, P);
      if (!hit) continue;
      const a = anchorNodes[hit.seg], b = anchorNodes[(hit.seg + 1) % nA];
      const q = Geo.segPoint(a, b, hit.t);
      const tan = Geo.segTangent(a, b, hit.t);
      const nrm = { x: os * tan.y, y: -os * tan.x };
      const offI = (q.x - P.x) * nrm.x + (q.y - P.y) * nrm.y;
      const tofI = (P.x - q.x) * tan.x + (P.y - q.y) * tan.y;
      const slit = { seg: hit.seg, t: hit.t, len: slitLen, width:settings.width, ang:settings.ang, off: offI, run };
      if (settings.abs) slit.abs = true;
      if (settings.pair) { slit.pair = settings.pair; slit.pairSide = settings.pairSide; }
      if (chain.anchor.segs) slit.sourceSegments = chain.anchor.segs.slice();
      if (isCut) slit.cut = chain.anchor.cut;
      if (Math.abs(tofI) > 1e-6) slit.toff = tofI;
      if (!Geo.slitFitsPiece(piece, slit)) throw new Error('A slot crosses the outline or a cutout. Increase inset or reduce slit length/width.');
      piece.stitchSlits.push(slit);
      placed++;
    }
    return placed;
  }

  function stitchFractions(count, loop) {
    const fr = [];
    for (let i = 0; i < count; i++) fr.push(loop ? i / count : (i + 0.5) / count);
    return fr;
  }

  // single mode: every chain gets its own run, spaced from its own length
  function stitchApplySingle() {
    if (!stitchMulti.length) return;
    const spacing = Math.max(0.1, parseFloat($('st-spacing').value) || 0.3);
    const slitLen = Math.max(0.05, parseFloat($('st-len').value) || 0.15);
    const off = parseFloat($('st-off').value) || 0;
    const chains = stitchChains(stitchMulti, off);
    if (!chains.length) return;
    beginChange();
    let total = 0, runs = 0;
    for (const ch of chains) {
      const L = Geo.pathLength(ch.path, ch.loop);
      if (L < 1e-6) continue;
      const count = Math.max(2, Math.round(L / spacing));
      total += stitchPlaceRun(ch, stitchFractions(count, ch.loop), slitLen);
      runs++;
    }
    endChange();
    stitchMulti = [];
    updateStitchUi();
    $('status-hint').textContent = `${total} stitching slits over ${runs} run${runs > 1 ? 's' : ''}`;
    renderAll();
  }

  // matched mode: side A and side B each collapse to ONE chain; both get the
  // same count so hole i on A pairs with hole i on B when sewing
  function stitchMatched(aTargets, bTargets) {
    const spacing = Math.max(0.1, parseFloat($('st-spacing').value) || 0.3);
    const slitLen = Math.max(0.05, parseFloat($('st-len').value) || 0.15);
    const off = parseFloat($('st-off').value) || 0;
    const chainsA = stitchChains(aTargets, off);
    const chainsB = stitchChains(bTargets, off);
    if (chainsA.length !== 1 || chainsB.length !== 1) {
      $('status-hint').textContent =
        'Each side must be ONE continuous run — pick connected edges (or a single guide / cutout) per side.';
      return;
    }
    const A = chainsA[0], B = chainsB[0];
    const lenA = Geo.pathLength(A.path, A.loop);
    const lenB = Geo.pathLength(B.path, B.loop);
    if (lenA < 1e-6 || lenB < 1e-6) return;
    const count = Math.max(2, Math.round(lenA / spacing));
    beginChange();
    const settings = {width:Number($('st-width').value) / 10, ang:stitchAngle(), abs:stitchAngleAbs(), pair:uid()};
    stitchPlaceRun(A, stitchFractions(count, A.loop), slitLen, {...settings, pairSide:"A"});
    stitchPlaceRun(B, stitchFractions(count, B.loop), slitLen, {...settings, pairSide:"B"});
    endChange();
    stitchSideA = null;
    stitchMulti = [];
    updateStitchUi();
    $('status-hint').textContent =
      `${count} matched slits per side (${fmt(lenA)} vs ${fmt(lenB)} cm)`;
    renderAll();
  }

  // the panel button / Enter: advance the current mode's flow
  function stitchApply() {
    try {
      if (!$('st-spacing').checkValidity() || !$('st-len').checkValidity() || !$('st-off').checkValidity() || !$('st-width').checkValidity()) throw new Error('Check the stitch dimensions before applying.');
      stitchApplyUnsafe();
    } catch (e) { cancelStitchChange(e.message); }
  }
  function stitchApplyUnsafe() {
    if ($('st-mode').value === 'matched') {
      if (!stitchSideA) {
        if (!stitchMulti.length) {
          $('status-hint').textContent = 'Select side A first — click, Shift-click or drag a box over edges/guides/cutouts.';
          return;
        }
        stitchSideA = stitchMulti;
        stitchMulti = [];
        updateStitchUi();
        renderAll(true);
        return;
      }
      if (!stitchMulti.length) {
        $('status-hint').textContent = 'Now select side B, then Enter (or "Stitch matched").';
        return;
      }
      stitchMatched(stitchSideA, stitchMulti);
      return;
    }
    if (!stitchMulti.length) {
      $('status-hint').textContent = 'Nothing selected — click edges/guide lines/cutouts (or drag a box over them) first.';
      return;
    }
    stitchApplySingle();
  }

  function grainDown(w) {
    const res = pickPieceAt(w, true);
    if (!res) return;
    selectPiece(res.piece.id);
    beginChange();
    const hadGrain = !!res.piece.grain;
    const a = snap(w);
    drag = { type: 'grain', pieceId: res.piece.id, a, b: a, hadGrain };
  }

  // ---------- keyboard ----------
  window.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const k = ev.key.toLowerCase();
    if ($('shape-size-dialog').open) return;
    if (k === 'alt' && drag && drag.type === 'shape') { ev.preventDefault(); openShapeSize(); return; }
    if (ev.code === 'Space') { spaceDown = true; svg.classList.add('panning'); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.shiftKey ? redo() : undo(); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'y') { redo(); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 's') { saveJSON(); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'c') { if (copySelection()) ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'v') { pasteClipboard(); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'x') {
      if (copySelection()) {
        const ids = selectionIds();
        clearSel(); sel.pieceId = ids[0];
        if (ids.length > 1) multiSel = ids;
        deleteSelection();
      }
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && k === 'd') { duplicateSelection(); ev.preventDefault(); return; }
    if (k === 'enter' && tool === 'stitch' && $('st-workflow').value === 'create' && (stitchMulti.length || stitchSideA)) {
      stitchApply();
      ev.preventDefault();
      return;
    }
    if (k === 'escape') {
      if (tool === 'pen' && draft) finishDraft(false);
      else if (tool === 'weld' && weldFirst) {
        weldFirst = null;
        $('status-hint').textContent = HINTS.weld;
        renderAll(true);
      } else if (tool === 'stitch' && (stitchSideA || stitchMulti.length)) {
        stitchMulti = [];
        stitchSideA = null;
        updateStitchUi();
        renderAll(true);
      } else if (tool === 'offset' && (insetChain || sel.kind === 'seg' || sel.kind === 'segs')) {
        insetChain = null;
        sel.kind = null; sel.idx = -1;
        $('status-hint').textContent = HINTS.offset;
        renderAll(true); renderSidebar();
      } else if (tool === 'knife' && knifeFirst) {
        knifeFirst = null;
        clear(gPreview);
        $('status-hint').textContent = HINTS.knife;
      } else if (tool === 'bool' && boolFirst) {
        boolFirst = null;
        $('status-hint').textContent = HINTS.bool;
      } else { clearSel(); renderAll(); }
      return;
    }
    if (k === 'enter' && tool === 'pen' && draft) { finishDraft(false); return; }
    if (k === 'delete' || k === 'backspace') { if (tool === 'stitch' && $('st-workflow').value === 'edit' && !['slit','slits'].includes(sel.kind)) { $('status-hint').textContent = 'No stitch holes selected.'; ev.preventDefault(); return; } if (tool === 'stitch' && $('st-workflow').value === 'create') { stitchMulti = []; stitchSideA = null; updateStitchUi(); renderAll(); ev.preventDefault(); return; } deleteSelection(); ev.preventDefault(); return; }
    if (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown') {
      if (tool === 'stitch' && ($('st-workflow').value !== 'edit' || !['slit','slits'].includes(sel.kind))) { ev.preventDefault(); return; }
      if (!selPiece() && !multiSel.length) return;
      ev.preventDefault();
      const step = ev.altKey ? 0.1 : ev.shiftKey ? snapStep() * 5 : snapStep();
      nudgeSelection(
        k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0,
        k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0,
      );
      return;
    }
    if (k === 'v') setTool('select');
    else if (k === 'p') setTool('pen');
    else if (k === 'r') setTool('shape');
    else if (k === 'n') setTool('notch');
    else if (k === 'h') setTool('hole');
    else if (k === 'g') setTool('grain');
    else if (k === 'w') setTool('weld');
    else if (k === 'i' || k === 'o') setTool('offset');
    else if (k === 'k') setTool('knife');
    else if (k === 'b') setTool('bool');
    else if (k === 'f') setTool('round');
    else if (k === 's') setTool('stitch');
    else if (k === 'm') setTool('measure');
    else if (k === '0') zoomFit();
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { spaceDown = false; svg.classList.remove('panning'); }
  });

  // Arrow-key movement. Whatever is selected moves: node, edge (both ends),
  // hole, whole piece(s); notches/slits slide along their edge. Rapid presses
  // coalesce into one undo step.
  function nudgeSelection(dx, dy) {
    const piece = selPiece();
    if (!piece && !multiSel.length) return;
    if (pendingSnapshot === null) pendingSnapshot = JSON.stringify(doc);
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { nudgeTimer = null; endChange(); renderSidebar(); }, 600);
    applyMove(dx, dy);
    renderAll(true);
  }

  // move whatever is selected by (dx, dy) — shared by the arrow keys and the
  // exact Δx/Δy inputs; the caller owns the undo step
  function applyMove(dx, dy) {
    const piece = selPiece();
    if (multiSel.length > 1) {
      for (const id of multiSel) { const p = pieceById(id); if (p) movePiece(p, dx, dy); }
    } else if (sel.kind === 'nodes' && sel.nodes.length) {
      for (const i of sel.nodes) {
        const nd = piece.path.nodes[i];
        if (nd) { nd.x += dx; nd.y += dy; }
      }
    } else if (sel.kind === 'node' && piece.path.nodes[sel.idx]) {
      const nd = piece.path.nodes[sel.idx];
      nd.x += dx; nd.y += dy;
    } else if (sel.kind === 'seg' && sel.idx < piece.path.nodes.length) {
      const n = piece.path.nodes.length;
      const a = piece.path.nodes[sel.idx], b = piece.path.nodes[(sel.idx + 1) % n];
      a.x += dx; a.y += dy;
      if (b !== a) { b.x += dx; b.y += dy; }
    } else if (sel.kind === 'segs' && sel.segs && sel.segs.length) {
      const n = piece.path.nodes.length;
      const ks = new Set();
      for (const i of sel.segs) { ks.add(i); ks.add((i + 1) % n); }
      for (const k of ks) {
        const nd = piece.path.nodes[k];
        if (nd) { nd.x += dx; nd.y += dy; }
      }
    } else if (sel.kind === 'hole' && piece.holes && piece.holes[sel.idx]) {
      piece.holes[sel.idx].x += dx;
      piece.holes[sel.idx].y += dy;
    } else if (sel.kind === 'cut' && piece.cutouts && piece.cutouts[sel.idx]) {
      for (const nd of piece.cutouts[sel.idx].nodes) { nd.x += dx; nd.y += dy; }
    } else if (sel.kind === 'notch' || sel.kind === 'slit' || sel.kind === 'slits') {
      const groups = sel.kind === 'notch' ? [{piece, indices:[sel.idx]}] : selectedStitchHoles();
      for (const group of groups) for (const index of group.indices) {
        const piece = group.piece;
        const arr = sel.kind === 'notch' ? piece.notches : piece.stitchSlits;
        const it = arr && arr[index];
        const ctx = it && (sel.kind !== 'notch'
          ? slitContext(piece, it)
          : (it.seg < piece.path.nodes.length ? { nodes: piece.path.nodes } : null));
        if (ctx) {
          const n = ctx.nodes.length;
          const len = Geo.segLength(ctx.nodes[it.seg], ctx.nodes[(it.seg + 1) % n]);
          const dir = dx !== 0 ? Math.sign(dx) : -Math.sign(dy);
          if (len > 1e-6) it.t = Math.min(0.99, Math.max(0.01, it.t + dir * Math.hypot(dx, dy) / len));
        }
      }
    } else {
      movePiece(piece, dx, dy);
    }
  }

  // Fillet geometry for rounding a corner with radius R. Pure computation —
  // used for the live preview and for the actual edit. Returns { error, maxR }
  // when the corner can't take R.
  function filletParams(piece, idx, R) {
    const nodes = piece.path.nodes;
    const n = nodes.length;
    if (!piece.path.closed && (idx === 0 || idx === n - 1)) {
      return { error: 'End points of an open path have no corner to round.' };
    }
    const inSeg = (idx - 1 + n) % n, outSeg = idx;
    if (piece.foldSeg === inSeg || piece.foldSeg === outSeg) {
      return { error: 'This corner touches the fold line — remove the fold first.' };
    }
    const corner = nodes[idx], prev = nodes[inSeg], next = nodes[(idx + 1) % n];
    const L1 = Geo.segLength(prev, corner), L2 = Geo.segLength(corner, next);
    const tin = Geo.segTangent(prev, corner, 1), tout = Geo.segTangent(corner, next, 0);
    const phi = Math.acos(Math.min(1, Math.max(-1, Geo.dot(tin, tout))));
    if (phi < 0.05) return { error: 'This corner is already (nearly) straight.' };
    const maxR = Math.min(L1, L2) * 0.9 / Math.tan(phi / 2);
    const setback = R * Math.tan(phi / 2);
    if (setback > L1 * 0.9 || setback > L2 * 0.9) {
      return { error: `Radius too large for these edges — max here is about ${fmt(maxR)} cm.`, maxR };
    }
    const tA = Geo.segArcParams(prev, corner, [(L1 - setback) / L1])[0];
    const tB = Geo.segArcParams(corner, next, [setback / L2])[0];
    return {
      inSeg,
      tA, tB,
      ta: Geo.segTangent(prev, corner, tA),  // arc entry direction
      tb: Geo.segTangent(corner, next, tB),  // arc exit direction
      k: (4 / 3) * Math.tan(phi / 4) * R,
      A: Geo.segPoint(prev, corner, tA),
      B: Geo.segPoint(corner, next, tB),
      maxR,
    };
  }

  // Round the selected corner with a circular fillet of radius R.
  function roundCorner(piece, idx, R) {
    const fp = filletParams(piece, idx, R);
    if (fp.error) { alert(fp.error); return; }
    const inSeg = fp.inSeg;
    const tA = fp.tA, tB = fp.tB, ta = fp.ta, tb = fp.tb, k = fp.k;
    beginChange();
    // NOTE: insertNodeAt replaces the segment's endpoints with copies, so the
    // corner's index must be tracked arithmetically, not by reference
    insertNodeAt(piece, inSeg, tA);
    const ci = idx + (inSeg < idx ? 1 : 0);
    insertNodeAt(piece, ci, tB); // the corner's outgoing edge is now seg ci
    const n2 = piece.path.nodes.length;
    const A = piece.path.nodes[(ci - 1 + n2) % n2];
    const B = piece.path.nodes[(ci + 1) % n2];
    // drop the corner node; its two stub edges become the arc
    const segA2 = (ci - 1 + n2) % n2, segB2 = ci;
    piece.notches = (piece.notches || []).filter((nt) => nt.seg !== segA2 && nt.seg !== segB2);
    for (const nt of piece.notches) if (nt.seg > ci) nt.seg -= 1;
    piece.stitchSlits = (piece.stitchSlits || []).filter((sl) => sl.cut != null || (sl.seg !== segA2 && sl.seg !== segB2));
    for (const sl of piece.stitchSlits) if (sl.cut == null && sl.seg > ci) sl.seg -= 1;
    if (piece.foldSeg != null && piece.foldSeg > ci) piece.foldSeg -= 1;
    piece.path.nodes.splice(ci, 1);
    A.hout = { x: ta.x * k, y: ta.y * k };
    B.hin = { x: -tb.x * k, y: -tb.y * k };
    endChange();
    sel.kind = 'node';
    sel.idx = piece.path.nodes.indexOf(A);
    renderAll();
    $('status-hint').textContent = `Corner rounded with a ${fmt(R)} cm radius`;
  }

  // remove one node, dropping marks on its two edges and remapping the rest
  function deleteNodeAt(piece, idx) {
    const n = piece.path.nodes.length;
    const segA = (idx - 1 + n) % n, segB = idx;
    piece.notches = (piece.notches || []).filter((nt) => nt.seg !== segA && nt.seg !== segB);
    for (const nt of piece.notches) if (nt.seg > idx) nt.seg -= 1;
    piece.stitchSlits = (piece.stitchSlits || []).filter((sl) => sl.cut != null || (sl.seg !== segA && sl.seg !== segB));
    for (const sl of piece.stitchSlits) if (sl.cut == null && sl.seg > idx) sl.seg -= 1;
    if (piece.foldSeg != null) {
      // deleting a fold-edge endpoint destroys the fold
      if (idx === piece.foldSeg || idx === (piece.foldSeg + 1) % n) piece.foldSeg = null;
      else if (piece.foldSeg > idx) piece.foldSeg -= 1;
    }
    piece.path.nodes.splice(idx, 1);
  }

  // ---------- clipboard (Ctrl+C/V/X/D) ----------
  // Stored in localStorage, so paste works across tabs of the app too.
  const CLIP_KEY = 'patternStudioClipboard.v1';

  function selectionIds() {
    const holes = selectedStitchHoles();
    if (holes.length) return holes.map(g => g.piece.id);
    return multiSel.length ? multiSel.slice() : sel.pieceId ? [sel.pieceId] : [];
  }

  function copySelection() {
    const items = selectionIds().map(pieceById).filter(Boolean)
      .map((p) => JSON.parse(JSON.stringify(p)));
    if (!items.length) return false;
    try { localStorage.setItem(CLIP_KEY, JSON.stringify({ pieces: items, n: 0 })); } catch (e) { /* quota */ }
    $('status-hint').textContent = `Copied ${items.length} piece${items.length > 1 ? 's' : ''} — Ctrl+V pastes`;
    return true;
  }

  function pasteClipboard() {
    let clip = null;
    try { clip = JSON.parse(localStorage.getItem(CLIP_KEY)); } catch (e) { /* ignore */ }
    if (!clip || !Array.isArray(clip.pieces) || !clip.pieces.length) return;
    migrateDoc(clip); // the clipboard may come from a tab on an older build
    clip.n = (clip.n || 0) + 1; // each paste lands a bit further
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (e) { /* quota */ }
    const off = 2 * clip.n;
    beginChange();
    const newIds = [];
    for (const src of clip.pieces) {
      const p = JSON.parse(JSON.stringify(src));
      p.id = uid();
      for (const sl of p.stitchSlits || []) { delete sl.pair; delete sl.pairSide; }
      movePiece(p, off, off);
      doc.pieces.push(p);
      newIds.push(p.id);
    }
    endChange();
    clearSel();
    sel.pieceId = newIds[0];
    if (newIds.length > 1) multiSel = newIds;
    renderAll();
    $('status-hint').textContent = `Pasted ${newIds.length} piece${newIds.length > 1 ? 's' : ''}`;
  }

  function duplicateSelection() {
    const ids = selectionIds();
    if (!ids.length) return;
    beginChange();
    const newIds = [];
    for (const id of ids) {
      const src = pieceById(id);
      if (!src) continue;
      const p = JSON.parse(JSON.stringify(src));
      p.id = uid();
      for (const sl of p.stitchSlits || []) { delete sl.pair; delete sl.pairSide; }
      p.name = decorate(src.name, 'copy');
      movePiece(p, 3, 3);
      doc.pieces.push(p);
      newIds.push(p.id);
    }
    endChange();
    clearSel();
    sel.pieceId = newIds[0] || null;
    if (newIds.length > 1) multiSel = newIds;
    renderAll();
  }

  function deleteSelection() {
    const piece = selPiece();
    if (!piece) return;
    if (multiSel.length > 1 && sel.kind === null) {
      beginChange();
      doc.pieces = doc.pieces.filter((p) => !multiSel.includes(p.id));
      clearSel();
      endChange();
      renderAll();
      return;
    }
    // a handle is picked up: Del takes that handle, not the point under it
    if (sel.handle) {
      const hn = piece.path.nodes[sel.handle.idx];
      const key = sel.handle.key;
      sel.handle = null;
      if (hn && hn[key]) {
        beginChange();
        hn[key] = null;
        endChange();
        renderAll(); renderSidebar();
        return;
      }
    }
    beginChange();
    if (['slit','slits'].includes(sel.kind)) {
      const groups = selectedStitchHoles();
      for (const group of groups) {
        const drop = new Set(group.indices);
        group.piece.stitchSlits = group.piece.stitchSlits.filter((s,i)=>!drop.has(i));
      }
      clearSel(); endChange(); renderAll();
      $('status-hint').textContent = `Deleted ${groups.reduce((n,g)=>n+g.indices.length,0)} stitch holes`;
      return;
    }
    if (sel.kind === 'node' && piece.path.nodes[sel.idx]) {
      if (piece.path.nodes.length <= (piece.path.closed ? 3 : 2)) {
        doc.pieces = doc.pieces.filter((p) => p.id !== piece.id);
        clearSel();
      } else {
        deleteNodeAt(piece, sel.idx);
        sel.kind = null;
      }
    } else if (sel.kind === 'nodes' && sel.nodes.length) {
      const min = piece.path.closed ? 3 : 2;
      if (piece.path.nodes.length - sel.nodes.length < min) {
        doc.pieces = doc.pieces.filter((p) => p.id !== piece.id);
        clearSel();
      } else {
        for (const i of sel.nodes.slice().sort((a, b) => b - a)) deleteNodeAt(piece, i);
        sel.kind = null;
        sel.nodes = [];
      }
    } else if (sel.kind === 'notch') {
      piece.notches.splice(sel.idx, 1);
      sel.kind = null;
    } else if (sel.kind === 'hole') {
      piece.holes.splice(sel.idx, 1);
      sel.kind = null;
    } else if (sel.kind === 'cut' && piece.cutouts && piece.cutouts[sel.idx]) {
      // internal cutout: remove it and any stitch run that rode on it
      piece.cutouts.splice(sel.idx, 1);
      piece.stitchSlits = (piece.stitchSlits || []).filter((sl) => sl.cut !== sel.idx);
      for (const sl of piece.stitchSlits) if (sl.cut != null && sl.cut > sel.idx) sl.cut--;
      sel.kind = null;
    } else {
      doc.pieces = doc.pieces.filter((p) => p.id !== piece.id);
      clearSel();
    }
    endChange();
    renderAll();
  }

  // ---------- piece operations ----------
  function duplicatePiece(piece, mirror) {
    const copy = JSON.parse(JSON.stringify(piece));
    copy.id = uid();
    for (const sl of copy.stitchSlits || []) { delete sl.pair; delete sl.pairSide; }
    copy.name = decorate(piece.name, mirror ? '(mirror)' : 'copy');
    if (mirror) {
      const poly = Geo.pathPolyline(copy.path.nodes, copy.path.closed, 0.1);
      const bb = Geo.bbox(poly);
      const cx = (bb.minX + bb.maxX) / 2;
      const refl = (h) => (h ? { x: -h.x, y: h.y } : null);
      const n = copy.path.nodes.length;
      copy.path.nodes = copy.path.nodes
        .map((nd) => ({ x: 2 * cx - nd.x, y: nd.y, hin: refl(nd.hout), hout: refl(nd.hin) }))
        .reverse();
      // remap notches: orig seg i -> new seg (2n-2-i) mod n (closed) / n-2-i (open)
      for (const nt of copy.notches || []) {
        nt.seg = copy.path.closed ? (2 * n - 2 - nt.seg) % n : (n - 2 - nt.seg);
        nt.t = 1 - nt.t;
      }
      for (const sl of copy.stitchSlits || []) {
        if (sl.cut != null) {
          const cn = ((copy.cutouts || [])[sl.cut] || { nodes: [] }).nodes.length;
          if (cn) sl.seg = (2 * cn - 2 - sl.seg) % cn; // cutouts reverse too
        } else {
          sl.seg = copy.path.closed ? (2 * n - 2 - sl.seg) % n : (n - 2 - sl.seg);
        }
        sl.t = 1 - sl.t;
        if (sl.abs) sl.ang = -(sl.ang == null ? 45 : sl.ang); // edge-relative iron slant keeps its handedness
        if (sl.toff) sl.toff = -sl.toff; // tangent reverses with the path
      }
      if (copy.foldSeg != null && copy.path.closed) copy.foldSeg = (2 * n - 2 - copy.foldSeg) % n;
      for (const h of copy.holes || []) h.x = 2 * cx - h.x;
      for (const c of copy.cutouts || []) {
        c.nodes = c.nodes
          .map((nd) => ({ x: 2 * cx - nd.x, y: nd.y, hin: refl(nd.hout), hout: refl(nd.hin) }))
          .reverse();
      }
      if (copy.grain) {
        copy.grain.x1 = 2 * cx - copy.grain.x1;
        copy.grain.x2 = 2 * cx - copy.grain.x2;
      }
      movePiece(copy, bb.maxX - bb.minX + 3, 0);
    } else {
      movePiece(copy, 3, 3);
    }
    beginChange();
    doc.pieces.push(copy);
    endChange();
    selectPiece(copy.id);
    renderAll();
  }

  // ---------- file ops ----------
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const safeName = () => (doc.name || 'pattern').replace(/[^\w\-가-힣 ]+/g, '').trim() || 'pattern';

  // ---------- local file save (File System Access API, Chrome/Edge) ----------
  // First save asks where; after that, Save writes straight to that file on
  // disk — no downloads, no cloud. Falls back to a download elsewhere.
  const FS_OK = typeof window.showSaveFilePicker === 'function';
  let fileHandle = null;

  function fsStore(mode, fn) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('patternStudioFiles', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction('handles', mode);
          const r = fn(tx.objectStore('handles'));
          tx.oncomplete = () => { req.result.close(); resolve(r && r.result); };
          tx.onerror = () => { req.result.close(); reject(tx.error); };
        } catch (e) { // e.g. a handle that can't be structured-cloned
          req.result.close();
          reject(e);
        }
      };
    });
  }
  function rememberHandle(h) {
    fileHandle = h;
    fsStore('readwrite', (st) => (h ? st.put(h, 'project') : st.delete('project'))).catch(() => {});
    $('btn-save').title = h
      ? `Save to ${h.name} (Ctrl+S) · Shift-click to Save As`
      : 'Save the project to a file on your computer (Ctrl+S)';
  }
  if (FS_OK) {
    $('btn-save').title = 'Save the project to a file on your computer (Ctrl+S)';
    fsStore('readonly', (st) => st.get('project'))
      .then((h) => { if (h && !fileHandle) rememberHandle(h); })
      .catch(() => {});
  }

  async function saveJSON(saveAs) {
    const data = JSON.stringify(doc, null, 1);
    if (FS_OK) {
      try {
        if (!fileHandle || saveAs) {
          rememberHandle(await window.showSaveFilePicker({
            suggestedName: safeName() + '.pattern.json',
            types: [{ description: 'Pattern Studio project', accept: { 'application/json': ['.json'] } }],
          }));
        } else if (fileHandle.queryPermission &&
            (await fileHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          if ((await fileHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
            throw new Error('permission denied');
          }
        }
        const w = await fileHandle.createWritable();
        await w.write(data);
        await w.close();
        $('status-hint').textContent = `Saved to ${fileHandle.name} ✓`;
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // picker cancelled — not an error
        // fall back to a download so the work is never lost
      }
    }
    download(safeName() + '.pattern.json', data, 'application/json');
  }

  const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Export settings shared by DXF and SVG.
  function exportOpts() {
    return {
      labels: $('ex-labels').checked,
      labelHeight: Math.max(0.2, parseFloat($('ex-label-h').value) || 0.8),
    };
  }

  // Names the stroke font can't draw fall back to a TEXT entity, whose look
  // depends on the reader's font — say so rather than let it surprise them at
  // the laser. Pieces too small to hold legible text are dropped entirely.
  function reportLabelIssues(opts) {
    if (!opts.labels) return;
    const fellBack = [], tooSmall = [];
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide || !p.name || !p.path.closed) continue;
      const s = DXF.pieceShapes(p, opts);
      if (s.texts && s.texts.length) fellBack.push(p.name);
      else if (!(s.polylines || []).some((pl) => pl.layer === 'MARK' && !pl.closed)) tooSmall.push(p.name);
    }
    const bits = [];
    if (fellBack.length) {
      bits.push(`${fellBack.length} name${fellBack.length > 1 ? 's' : ''} exported as DXF text ` +
        `(no engraving strokes for those characters): ${fellBack.slice(0, 3).join(', ')}`);
    }
    if (tooSmall.length) {
      bits.push(`${tooSmall.length} piece${tooSmall.length > 1 ? 's' : ''} too small to label: ` +
        tooSmall.slice(0, 3).join(', '));
    }
    if (bits.length) $('status-hint').textContent = bits.join(' · ');
  }

  function exportDXF() {
    const ok = doc.pieces.some((p) => p.visible !== false && p.path.nodes.length >= 2);
    if (!ok) { alert('Nothing to export — draw a piece first.'); return; }
    const opts = exportOpts();
    download(safeName() + '.dxf', DXF.exportDXF(doc, opts), 'application/dxf');
    reportLabelIssues(opts);
  }

  function exportSVG() {
    const ok = doc.pieces.some((p) => p.visible !== false && p.path.nodes.length >= 2);
    if (!ok) { alert('Nothing to export — draw a piece first.'); return; }
    const svgOpts = exportOpts();
    const shapes = doc.pieces
      .filter((p) => p.visible !== false && p.path.nodes.length >= 2)
      .map((p) => ({ piece: p, s: DXF.pieceShapes(p, svgOpts) }));
    const every = [];
    for (const { s } of shapes) {
      for (const pl of s.polylines) every.push(...pl.pts);
      for (const l of s.lines) every.push(l.a, l.b);
      for (const c of s.circles) every.push({ x: c.c.x - c.r, y: c.c.y - c.r }, { x: c.c.x + c.r, y: c.c.y + c.r });
    }
    const bb = Geo.bbox(every);
    const M = 1; // cm margin
    const wMM = (bb.maxX - bb.minX + 2 * M) * 10, hMM = (bb.maxY - bb.minY + 2 * M) * 10;
    const tx = (p) => `${((p.x - bb.minX + M) * 10).toFixed(2)},${((p.y - bb.minY + M) * 10).toFixed(2)}`;
    const COLORS = { CUT: '#d00000', SEAM: '#008000', MARK: '#0044cc' };
    let body = '';
    for (const { s } of shapes) {
      for (const pl of s.polylines) {
        body += `<polyline points="${pl.pts.map(tx).join(' ')}${pl.closed ? ' ' + tx(pl.pts[0]) : ''}" ` +
          `fill="none" stroke="${COLORS[pl.layer]}" stroke-width="0.3"/>\n`;
      }
      for (const l of s.lines) {
        body += `<line x1="${tx(l.a).split(',')[0]}" y1="${tx(l.a).split(',')[1]}" ` +
          `x2="${tx(l.b).split(',')[0]}" y2="${tx(l.b).split(',')[1]}" ` +
          `stroke="${COLORS[l.layer]}" stroke-width="0.3"/>\n`;
      }
      for (const c of s.circles) {
        body += `<circle cx="${tx(c.c).split(',')[0]}" cy="${tx(c.c).split(',')[1]}" r="${(c.r * 10).toFixed(2)}" ` +
          `fill="none" stroke="${COLORS[c.layer]}" stroke-width="0.3"/>\n`;
      }
      // names with no stroke glyphs: real <text>, rendered by the viewer's font
      for (const t of s.texts || []) {
        const [x, y] = tx({ x: t.x, y: t.y }).split(',');
        body += `<text x="${x}" y="${y}" font-size="${(t.height * 10).toFixed(2)}" ` +
          `text-anchor="middle" fill="${COLORS[t.layer]}">${esc(t.value)}</text>\n`;
      }
    }
    const svgText =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${wMM.toFixed(2)}mm" height="${hMM.toFixed(2)}mm" ` +
      `viewBox="0 0 ${wMM.toFixed(2)} ${hMM.toFixed(2)}">\n<!-- Pattern Studio export, units: mm -->\n${body}</svg>\n`;
    download(safeName() + '.svg', svgText, 'image/svg+xml');
    reportLabelIssues(svgOpts);
  }

  /* global DXFImport */
  function importDXFText(text, filename) {
    let raw;
    try { raw = DXFImport.parse(text); } catch (e) {
      alert('Could not read that DXF: ' + e.message);
      return;
    }
    let scale = DXFImport.unitScale(raw.insunits);
    if (scale == null) {
      const guess = DXFImport.guessUnits(raw);
      const ans = prompt(`"${filename}" doesn't declare its units.\nWhat are they? (mm / cm / in)`, guess);
      if (ans == null) return;
      scale = { mm: 0.1, cm: 1, in: 2.54, inch: 2.54, inches: 2.54 }[ans.trim().toLowerCase()];
      if (!scale) { alert('Unknown unit "' + ans + '" — try mm, cm or in.'); return; }
    }
    const res = DXFImport.build(raw, scale);
    if (!res.pieces.length) {
      alert('No usable outlines found in that DXF.' +
        (res.warnings.length ? '\n' + res.warnings.join('\n') : ''));
      return;
    }
    beginChange();
    const base = doc.pieces.length;
    res.pieces.forEach((p, i) => {
      doc.pieces.push({
        id: uid(),
        name: p.name || filename.replace(/\.dxf$/i, '') + (res.pieces.length > 1 ? ' ' + (i + 1) : ''),
        visible: true,
        seamAllowance: 0, // an imported outline IS the cutting line
        notchLength: 0.4,
        path: { closed: p.closed, nodes: p.nodes },
        notches: [], holes: p.holes || [], stitchSlits: [], grain: p.grain || null, foldSeg: null,
      });
    });
    endChange();
    selectPiece(doc.pieces[base].id);
    renderAll();
    zoomFit();
    $('status-hint').textContent = `Imported ${res.pieces.length} piece(s)` +
      (res.warnings.length ? ' · ' + res.warnings.join(' · ') : '');
  }

  function openJSON(file) {
    if (/\.dxf$/i.test(file.name)) {
      const rd = new FileReader();
      rd.onload = () => importDXFText(String(rd.result), file.name);
      rd.readAsText(file);
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const parsed = JSON.parse(rd.result);
        if (!parsed || !Array.isArray(parsed.pieces)) throw new Error('bad file');
        beginChange();
        doc = migrateDoc(parsed);
        endChange();
        clearSel();
        $('doc-name').value = doc.name || 'Untitled pattern';
        renderAll();
        zoomFit();
      } catch (e) {
        alert('Could not open that file — is it a Pattern Studio .json project?');
      }
    };
    rd.readAsText(file);
  }

  // ---------- cloud save (GitHub) ----------
  // Each user connects with their own fine-grained PAT scoped to one repo;
  // patterns live in that repo under patterns/ — every save is a commit.
  const GH_KEY = 'patternStudioGH.v1';
  let gh = null; // { token, repo, login }

  const b64encode = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  const b64decode = (s) => {
    const bin = atob(s.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  };

  async function ghApi(path, opts) {
    const res = await fetch('https://api.github.com' + path, Object.assign({}, opts, {
      headers: Object.assign({
        Authorization: 'Bearer ' + gh.token,
        Accept: 'application/vnd.github+json',
      }, (opts && opts.headers) || {}),
    }));
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '');
      if (res.status === 403 && body.includes('Resource not accessible')) {
        throw new Error('the token cannot write to ' + ((gh && gh.repo) || 'the repo') + '.\n\n' +
          'Fix it on github.com → Settings → Developer settings → Fine-grained tokens → your token:\n' +
          '1. Repository access: "Only select repositories" — make sure ' + ((gh && gh.repo) || 'your repo') + ' is in the list\n' +
          '2. Permissions → Repository permissions → Contents: "Read and write"\n\n' +
          'Then paste the token here again (Disconnect → Connect).');
      }
      throw new Error('GitHub said ' + res.status + (res.status === 401 ? ' — token rejected' : '') +
        (body ? ': ' + body.slice(0, 140) : ''));
    }
    return res;
  }

  function ghRender() {
    $('gh-disconnected').hidden = !!gh;
    $('gh-connected').hidden = !gh;
    if (gh) $('gh-status').textContent = `Connected as ${gh.login} · ${gh.repo}`;
  }

  async function ghConnect() {
    const token = $('gh-token').value.trim();
    if (!token) { alert('Paste a GitHub token first.'); return; }
    gh = { token, repo: '', login: '' };
    try {
      const user = await (await ghApi('/user')).json();
      if (!user.login) throw new Error('token rejected');
      gh.login = user.login;
      let repo = $('gh-repo').value.trim() || 'my-patterns';
      if (!repo.includes('/')) repo = user.login + '/' + repo;
      gh.repo = repo;
      const check = await ghApi('/repos/' + repo);
      if (check.status === 404) {
        throw new Error(`repo "${repo}" not found (or the token can't see it). ` +
          'Create it on github.com/new, and give the token Contents read & write on it.');
      }
      const info = await check.json().catch(() => ({}));
      if (info.permissions && !info.permissions.push) {
        throw new Error(`the token can only READ "${repo}" — saving needs write.\n\n` +
          'Edit the token on github.com → Settings → Developer settings → Fine-grained tokens:\n' +
          'Permissions → Repository permissions → Contents: "Read and write", then reconnect.');
      }
      localStorage.setItem(GH_KEY, JSON.stringify(gh));
      $('gh-token').value = '';
      ghRender();
      ghList();
    } catch (e) {
      gh = null;
      ghRender();
      alert('Could not connect: ' + e.message);
    }
  }

  async function ghSave() {
    if (!gh) return;
    const path = 'patterns/' + safeName() + '.pattern.json';
    const btn = $('gh-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const existing = await ghApi('/repos/' + gh.repo + '/contents/' + encodeURI(path));
      const sha = existing.status === 200 ? (await existing.json()).sha : undefined;
      const body = {
        message: (sha ? 'Update ' : 'Add ') + safeName(),
        content: b64encode(JSON.stringify(doc, null, 1)),
      };
      if (sha) body.sha = sha;
      await ghApi('/repos/' + gh.repo + '/contents/' + encodeURI(path), {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      $('gh-status').textContent = `Saved "${safeName()}" ✓ · ${gh.repo}`;
      ghList();
    } catch (e) {
      alert('Cloud save failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Save to cloud';
    }
  }

  async function ghList() {
    if (!gh) return;
    const ul = $('gh-files');
    clear(ul);
    try {
      const res = await ghApi('/repos/' + gh.repo + '/contents/patterns');
      const items = res.status === 200 ? await res.json() : [];
      const files = (Array.isArray(items) ? items : []).filter((f) => f.name.endsWith('.json'));
      if (!files.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No saved patterns yet';
        ul.appendChild(li);
      }
      for (const f of files) {
        const li = document.createElement('li');
        li.textContent = f.name.replace(/\.pattern\.json$|\.json$/, '');
        li.title = 'Load ' + f.path;
        li.addEventListener('click', () => ghLoad(f.path));
        ul.appendChild(li);
      }
    } catch (e) {
      $('gh-status').textContent = 'Could not list patterns: ' + e.message;
    }
  }

  async function ghLoad(path) {
    if (!gh) return;
    try {
      const res = await ghApi('/repos/' + gh.repo + '/contents/' + encodeURI(path));
      if (res.status === 404) throw new Error('file disappeared');
      const file = await res.json();
      const parsed = JSON.parse(b64decode(file.content));
      if (!parsed || !Array.isArray(parsed.pieces)) throw new Error('not a Pattern Studio project');
      beginChange();
      doc = migrateDoc(parsed);
      endChange();
      clearSel();
      if (FS_OK) rememberHandle(null); // cloud project ≠ the last local file
      $('doc-name').value = doc.name || 'Untitled pattern';
      renderAll();
      zoomFit();
      $('gh-status').textContent = `Loaded "${doc.name}" · ${gh.repo}`;
    } catch (e) {
      alert('Cloud load failed: ' + e.message);
    }
  }

  $('gh-connect').addEventListener('click', ghConnect);
  $('gh-save').addEventListener('click', ghSave);
  $('gh-logout').addEventListener('click', () => {
    localStorage.removeItem(GH_KEY);
    gh = null;
    ghRender();
  });
  (function ghBoot() {
    try {
      const saved = JSON.parse(localStorage.getItem(GH_KEY));
      if (saved && saved.token && saved.repo) { gh = saved; ghList(); }
    } catch (e) { /* ignore */ }
    ghRender();
  })();

  // ---------- wire up UI ----------
  document.querySelectorAll('#toolbar .tool').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('btn-add-piece').addEventListener('click', () => setTool('pen'));

  $('btn-new').addEventListener('click', () => {
    if (doc.pieces.length && !confirm('Start a new pattern? Unsaved work is kept in Undo.')) return;
    beginChange();
    doc = newDoc();
    endChange();
    clearSel();
    if (FS_OK) rememberHandle(null); // a new pattern must not overwrite the old file
    $('doc-name').value = doc.name;
    renderAll();
  });
  $('btn-open').addEventListener('click', async () => {
    if (FS_OK && typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker({
          types: [{
            description: 'Pattern project or DXF',
            accept: { 'application/json': ['.json'], 'application/dxf': ['.dxf'] },
          }],
        });
        const file = await h.getFile();
        openJSON(file);
        // opening a project remembers its file, so Save writes back to it
        if (/\.json$/i.test(file.name)) rememberHandle(h);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        // fall through to the classic input on anything unexpected
      }
    }
    $('file-input').click();
  });
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) openJSON(e.target.files[0]);
    e.target.value = '';
  });
  $('btn-save').addEventListener('click', (ev) => saveJSON(ev.shiftKey));
  $('ex-labels').addEventListener('change', () => {
    $('ex-label-h-row').hidden = !$('ex-labels').checked;
  });
  $('btn-export-dxf').addEventListener('click', exportDXF);
  $('btn-export-svg').addEventListener('click', exportSVG);
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-fit').addEventListener('click', zoomFit);
  $('doc-name').addEventListener('change', (e) => {
    beginChange(); doc.name = e.target.value; endChange();
  });

  $('pp-name').addEventListener('change', (e) => {
    const p = selPiece(); if (!p) return;
    beginChange(); p.name = e.target.value; endChange(); renderAll();
  });
  $('pp-notch-style').addEventListener('change', (e) => {
    const p = selPiece(); if (!p) return;
    beginChange(); p.notchStyle = e.target.value === 'v' ? 'v' : 'slit'; endChange(); renderAll();
  });
  $('pp-notch').addEventListener('change', (e) => {
    const p = selPiece(); if (!p) return;
    beginChange(); p.notchLength = Math.max(0.1, parseFloat(e.target.value) || 0.4); endChange(); renderAll();
  });
  $('pp-dup').addEventListener('click', duplicateSelection);
  $('pp-mirror').addEventListener('click', () => { const p = selPiece(); if (p) duplicatePiece(p, true); });
  $('pp-inset-btn').addEventListener('click', () => {
    const p = selPiece();
    if (!p) return;
    if (!p.path.closed) { $('status-hint').textContent = 'Inset copies need a closed outline.'; return; }
    const d = parseFloat($('pp-inset-d').value) || 0;
    if (!d) return;
    const src = effPiece(p); // folded pieces inset their full unfolded shape
    const pts = Geo.offsetClosed(Geo.dedupe(Geo.pathPolyline(src.path.nodes, true, 0.02)), -d);
    if (pts.length < 3) { $('status-hint').textContent = 'That distance swallows the whole piece.'; return; }
    const copy = {
      id: uid(),
      name: decorate(p.name, d > 0 ? 'inset' : 'outset'),
      visible: true,
      seamAllowance: p.seamAllowance,
      notchLength: p.notchLength,
      path: {
        closed: true,
        nodes: Geo.simplifyPoly(pts, 0.01, true).map((q) => ({ x: q.x, y: q.y, hin: null, hout: null })),
      },
      notches: [], stitchSlits: [],
      holes: JSON.parse(JSON.stringify(p.holes || [])),
      cutouts: JSON.parse(JSON.stringify(p.cutouts || [])),
      grain: p.grain ? { ...p.grain } : null,
      foldSeg: null,
    };
    if (p.guide) copy.guide = true;
    beginChange();
    doc.pieces.push(copy);
    endChange();
    selectPiece(copy.id);
    renderAll();
    $('status-hint').textContent =
      `"${copy.name}" created ${fmt(Math.abs(d))} cm ${d > 0 ? 'inside' : 'outside'} the original — it sits on top; drag or Move it away`;
  });
  $('pp-inset-d').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { $('pp-inset-btn').click(); ev.preventDefault(); }
    ev.stopPropagation();
  });
  // scale pieces about (cx, cy) by factor f — shared by the Scale field and
  // the drag handles. The caller owns the undo step.
  function scalePieces(ids, cx, cy, f) {
    const sp = (pt) => { pt.x = cx + (pt.x - cx) * f; pt.y = cy + (pt.y - cy) * f; };
    const sh = (h) => { if (h) { h.x *= f; h.y *= f; } };
    for (const id of ids) {
      const p = pieceById(id);
      if (!p) continue;
      for (const nd of p.path.nodes) { sp(nd); sh(nd.hin); sh(nd.hout); }
      for (const h of p.holes || []) { sp(h); h.r = (h.r || 0.15) * f; }
      for (const c of p.cutouts || []) {
        for (const nd of c.nodes) { sp(nd); sh(nd.hin); sh(nd.hout); }
      }
      for (const sl of p.stitchSlits || []) {
        // positions scale with the piece; the slit length is a tooling choice
        if (sl.off) sl.off *= f;
        if (sl.toff) sl.toff *= f;
      }
      if (p.grain) {
        const a = { x: p.grain.x1, y: p.grain.y1 }, b = { x: p.grain.x2, y: p.grain.y2 };
        sp(a); sp(b);
        p.grain = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      }
    }
  }

  // rotate pieces about (cx, cy) by rad (screen coords, y-down) — slits,
  // notches and their offsets are all tangent-relative, so they just follow
  function rotatePieces(ids, cx, cy, rad) {
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const rp = (pt) => {
      const x = pt.x - cx, y = pt.y - cy;
      pt.x = cx + x * cos - y * sin;
      pt.y = cy + x * sin + y * cos;
    };
    const rh = (h) => {
      if (!h) return;
      const x = h.x, y = h.y;
      h.x = x * cos - y * sin;
      h.y = x * sin + y * cos;
    };
    for (const id of ids) {
      const p = pieceById(id);
      if (!p) continue;
      for (const nd of p.path.nodes) { rp(nd); rh(nd.hin); rh(nd.hout); }
      for (const h of p.holes || []) rp(h);
      for (const c of p.cutouts || []) {
        for (const nd of c.nodes) { rp(nd); rh(nd.hin); rh(nd.hout); }
      }
      if (p.grain) {
        const a = { x: p.grain.x1, y: p.grain.y1 }, b = { x: p.grain.x2, y: p.grain.y2 };
        rp(a); rp(b);
        p.grain = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      }
    }
  }

  function selectionCentre(ids) {
    const pts = [];
    for (const id of ids) {
      const p = pieceById(id);
      if (p) pts.push(...Geo.pathPolyline(p.path.nodes, p.path.closed, 0.2));
    }
    if (!pts.length) return null;
    const bb = Geo.bbox(pts);
    return { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  }

  $('pp-rot-btn').addEventListener('click', () => {
    const deg = parseFloat($('pp-rot').value) || 0;
    if (!deg) return;
    const ids = multiSel.length > 1 ? multiSel : (selPiece() ? [selPiece().id] : []);
    const c = ids.length && selectionCentre(ids);
    if (!c) return;
    beginChange();
    rotatePieces(ids, c.x, c.y, -deg * Math.PI / 180); // + = counter-clockwise, like pen angles
    endChange();
    renderAll(); renderSidebar();
    $('pp-rot').value = 0;
    $('status-hint').textContent =
      `Rotated ${ids.length > 1 ? ids.length + ' pieces' : 'piece'} by ${deg}°`;
  });
  $('pp-rot').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { $('pp-rot-btn').click(); ev.preventDefault(); }
    ev.stopPropagation();
  });

  $('pp-scale-btn').addEventListener('click', () => {
    const f = (parseFloat($('pp-scale').value) || 0) / 100;
    if (!(f > 0) || Math.abs(f - 1) < 1e-9) return;
    const ids = multiSel.length > 1 ? multiSel : (selPiece() ? [selPiece().id] : []);
    if (!ids.length) return;
    // one shared centre, so a scaled group keeps its relative placement
    const pts = [];
    for (const id of ids) {
      const p = pieceById(id);
      if (p) pts.push(...Geo.pathPolyline(p.path.nodes, p.path.closed, 0.2));
    }
    if (!pts.length) return;
    const bb = Geo.bbox(pts);
    beginChange();
    scalePieces(ids, (bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, f);
    endChange();
    renderAll(); renderSidebar();
    $('pp-scale').value = 100;
    $('status-hint').textContent =
      `Scaled ${ids.length > 1 ? ids.length + ' pieces' : 'piece'} to ${Math.round(f * 1000) / 10}%`;
  });
  $('pp-scale').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { $('pp-scale-btn').click(); ev.preventDefault(); }
    ev.stopPropagation();
  });
  $('pp-del').addEventListener('click', () => {
    const ids = selectionIds(); if (!ids.length) return;
    beginChange();
    doc.pieces = doc.pieces.filter(q => !ids.includes(q.id));
    endChange();
    clearSel();
    renderAll();
  });
  for (const axis of ['x', 'y']) {
    $('sp-' + axis).addEventListener('change', (e) => {
      const p = selPiece();
      if (!p || sel.kind !== 'node' || !p.path.nodes[sel.idx]) return;
      beginChange();
      p.path.nodes[sel.idx][axis] = parseFloat(e.target.value) || 0;
      endChange();
      renderAll();
    });
  }
  $('sp-seglen').addEventListener('change', (e) => {
    const p = selPiece();
    if (!p || sel.kind !== 'seg') return;
    const nodes = p.path.nodes;
    const n = nodes.length;
    if (sel.idx >= (p.path.closed ? n : n - 1)) return;
    const ai = sel.idx, bi = (sel.idx + 1) % n;
    const target = parseFloat(e.target.value);
    const res = Geo.setSegLength(nodes[ai], nodes[bi], target, $('sp-seg-anchor').value);
    if (!res) { renderSidebar(); return; }
    beginChange();
    nodes[ai] = res.a;
    nodes[bi] = res.b;
    endChange();
    renderAll();
  });
  $('sp-round-btn').addEventListener('click', () => {
    const p = selPiece();
    if (!p || sel.kind !== 'node' || !p.path.nodes[sel.idx]) return;
    const R = parseFloat($('sp-round-r').value);
    if (!(R > 0)) { alert('Radius must be positive.'); return; }
    roundCorner(p, sel.idx, R);
  });
  for (const key of ['hin', 'hout']) {
    $('sp-del-' + key).addEventListener('click', () => {
      const p = selPiece();
      if (!p || sel.kind !== 'node' || !p.path.nodes[sel.idx]) return;
      beginChange();
      p.path.nodes[sel.idx][key] = null;
      sel.handle = null;
      endChange();
      renderAll(); renderSidebar();
    });
  }
  $('sp-clear-slits').addEventListener('click', () => {
    const p = selPiece();
    if (!p || (sel.kind !== 'seg' && sel.kind !== 'segs')) return;
    const segsSel = new Set(sel.kind === 'segs' ? sel.segs : [sel.idx]);
    beginChange();
    p.stitchSlits = p.guide ? [] : (p.stitchSlits || []).filter((sl) => sl.cut != null || !segsSel.has(sl.seg));
    endChange();
    renderAll(); renderSidebar();
  });
  // re-angle existing holes: the selected ones, or every hole of their run(s)
  function stitchEditSettings() {
    const len = Number($('sp-slit-len').value) / 10;
    const width = Number($('sp-slit-width').value) / 10;
    const inset = Number($('sp-slit-inset').value) / 10;
    const ang = Number($('sp-slit-ang').value);
    if (![len, width, inset, ang].every(Number.isFinite) || len < 0.05 || len > 1 || width < 0 || width > len || Math.abs(inset) > 2 || Math.abs(ang) > 180) {
      throw new Error('Use length 0.5–10 mm, width 0–length, inset change ±20 mm, and slant ±180°.');
    }
    return {len, width, inset, ang, abs:$('sp-slit-ang-ref').value === 'page'};
  }

  function applySlitAngle(wholeRun) {
    const p = selPiece();
    if (!p) return;
    try {
      const values = stitchEditSettings();
      const groups = wholeRun ? selectedStitchRuns(true) : selectedStitchHoles();
      const changes = [];
      for (const group of groups) for (const i of group.indices) {
        const s = group.piece.stitchSlits[i];
        const next = {...s, len:values.len, width:values.width, ang:values.ang, abs:values.abs, off:(s.off || 0) + values.inset};
        if (!Geo.slitFitsPiece(group.piece, next)) throw new Error('A slot crosses the cutting outline or a cutout. Increase inset or reduce length/width.');
        changes.push({piece:group.piece, i, next});
      }
      if (!changes.length) return;
      beginChange();
      for (const c of changes) c.piece.stitchSlits[c.i] = c.next;
      endChange();
      $('sp-slit-inset').value = 0;
      rememberAppliedStitchSettings(values);
      renderAll();
      $('status-hint').textContent = `Updated ${changes.length} holes${wholeRun && groups.length > 1 ? ' across linked runs' : ''}`;
    } catch (e) { $('status-hint').textContent = e.message; }
  }

  function stitchRunTargets(piece, holes) {
    if (piece.guide) return [{pieceId:piece.id, seg:0}];
    const cuts = new Set(holes.map(s => s.cut));
    if (cuts.size !== 1) throw new Error('This run spans multiple boundaries. Recreate it from its source edges.');
    if (holes[0].cut != null) return [{pieceId:piece.id, cut:holes[0].cut, seg:0}];
    const pts = holes.map(s => slitLineFor(piece, s)).filter(Boolean).map(l => Geo.lerp(l.a,l.b,0.5));
    const candidates = [];
    if (holes[0].sourceSegments) candidates.push(holes[0].sourceSegments);
    const occupied = [...new Set(holes.map(s=>s.seg))];
    const n = piece.path.nodes.length, closed = piece.path.closed;
    // Legacy runs have only projected anchors. Recover a source only when its
    // inset path actually contains every surviving hole, including corner holes.
    // ponytail: bounded legacy recovery; recreate a run if over 64 edges are ambiguous.
    if (occupied.length <= 64) {
      const have = new Set(occupied);
      for (const start of occupied) {
        const arc = [];
        for (let i=start; have.has(i) && arc.length<occupied.length; i=closed?(i+1)%n:i+1) {
          arc.push(i); candidates.push(arc.slice());
        }
      }
    }
    const offsets = [...new Set(holes.map(s=>Math.round((s.off || 0)*100000)/100000))];
    for (const segs of candidates) {
      const targets = segs.map(seg=>({pieceId:piece.id,seg}));
      for (const off of offsets) {
        const chains = stitchChains(targets,off);
        if (chains.length === 1 && pts.every(p=>Geo.nearestOnPath(chains[0].path,chains[0].loop,p).dist < 0.02)) return targets;
      }
    }
    throw new Error('The original stitch path cannot be recovered reliably after these edits. Recreate the run from its source edges.');
  }

  function rebuildStitchRuns() {
    const groups = selectedStitchRuns(true);
    if (!groups.length) return;
    try {
      const settings = stitchEditSettings();
      const spacing = Number($('sp-run-spacing').value) / 10;
      const inset = Number($('sp-run-inset').value) / 10;
      if (!Number.isFinite(spacing) || spacing < 0.1 || spacing > 2 || !Number.isFinite(inset) || Math.abs(inset) > 2) throw new Error('Use spacing 1–20 mm and inset ±20 mm.');
      const plans = groups.map(g => {
        const old = g.indices.map(i => g.piece.stitchSlits[i]);
        const targets = stitchRunTargets(g.piece, old);
        const chains = stitchChains(targets, inset);
        if (chains.length !== 1) throw new Error('This run now spans disconnected edges. Select and recreate its connected edges in Create runs.');
        return {...g, chain:chains[0], pair:old[0].pair, pairSide:old[0].pairSide};
      });
      for (const plan of plans) {
        const reference = plan.pair ? plans.find(p => p.pair === plan.pair && p.pairSide === 'A') : plan;
        if (!reference) throw new Error('Original side A is unavailable. Recreate the matched pair before re-spacing.');
        plan.count = Math.max(2, Math.round(Geo.pathLength(reference.chain.path, reference.chain.loop) / spacing));
      }
      beginChange();
      // Remove by object identity: multiple paired runs may share one piece.
      const drop = new Set(groups.flatMap(g => g.indices.map(i => g.piece.stitchSlits[i])));
      for (const piece of new Set(groups.map(g => g.piece))) piece.stitchSlits = piece.stitchSlits.filter(s => !drop.has(s));
      const newSelection = [];
      for (const plan of plans) {
        const from = plan.piece.stitchSlits.length;
        stitchPlaceRun(plan.chain, stitchFractions(plan.count, plan.chain.loop), settings.len, {...settings, pair:plan.pair, pairSide:plan.pairSide});
        let group = newSelection.find(g=>g.piece===plan.piece);
        if (!group) { group={piece:plan.piece,indices:[]}; newSelection.push(group); }
        for (let i = from; i < plan.piece.stitchSlits.length; i++) group.indices.push(i);
      }
      endChange();
      selectStitchHoles(newSelection);
      $('sp-slit-inset').value = 0;
      $('st-spacing').value = spacing;
      $('st-off').value = inset;
      rememberAppliedStitchSettings(settings);
      renderAll();
      $('status-hint').textContent = `Re-spaced ${plans.length} run(s); matched sides retain equal counts`;
    } catch (e) { cancelStitchChange(e.message); }
  }

  function cancelStitchChange(message) {
    if (pendingSnapshot != null) { doc = JSON.parse(pendingSnapshot); pendingSnapshot = null; }
    renderAll();
    $('status-hint').textContent = message;
  }

  $('sp-slit-ang-sel').addEventListener('click', () => applySlitAngle(false));
  $('sp-slit-ang-run').addEventListener('click', () => applySlitAngle(true));
  for (const id of ['st-ang', 'st-ang-ref']) $(id).addEventListener('input', refreshAngEg);
  $('sp-slit-ang-ref').addEventListener('change', () => {
    const v = parseFloat($('sp-slit-ang').value);
    $('sp-slit-ang-eg').textContent =
      angLabel(clampAng(v, 45), $('sp-slit-ang-ref').value === 'page');
  });
  $('sp-slit-ang').addEventListener('input', () => {
    const v = parseFloat($('sp-slit-ang').value);
    $('sp-slit-ang-eg').textContent =
      angLabel(clampAng(v, 45), $('sp-slit-ang-ref').value === 'page');
  });
  refreshAngEg();
  $('sp-slit-ang').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); applySlitAngle(false); }
  });

  $('sp-del-run').addEventListener('click', () => {
    if (['slit','slits'].includes(sel.kind)) { deleteSelection(); return; }
    const p = selPiece();
    if (!p) return;
    let keep = null;
    if (sel.kind === 'slits' && sel.slits && sel.slits.length) {
      const drop = new Set(sel.slits);
      keep = (s, i) => !drop.has(i);
    } else if (sel.kind === 'slit' && (p.stitchSlits || [])[sel.idx]) {
      const sl = p.stitchSlits[sel.idx];
      keep = (s, i) => i !== sel.idx;
    } else if (sel.kind === 'seg' || sel.kind === 'segs') {
      const segsSel = new Set(sel.kind === 'segs' ? sel.segs : [sel.idx]);
      const onEdge = (s2) => p.guide || (s2.cut == null && segsSel.has(s2.seg));
      const runsHere = new Set((p.stitchSlits || []).filter(onEdge).map((s2) => s2.run).filter((r) => r != null));
      keep = (s) => !(s.run != null ? runsHere.has(s.run) : onEdge(s));
    }
    if (!keep) return;
    beginChange();
    p.stitchSlits = (p.stitchSlits || []).filter(keep);
    endChange();
    if (sel.kind === 'slit' || sel.kind === 'slits') { sel.kind = null; sel.idx = -1; sel.slits = []; }
    renderAll(); renderSidebar();
    $('status-hint').textContent = 'Selected stitch holes deleted';
  });
  function segOffsetNormal(p, i) {
    const n = p.path.nodes.length;
    const a = p.path.nodes[i], b = p.path.nodes[(i + 1) % n];
    const tan = Geo.segTangent(a, b, 0.5);
    const os = p.path.closed ? Geo.outwardSign(Geo.pathPolyline(p.path.nodes, true, 0.1)) : 1;
    return { x: os * tan.y, y: -os * tan.x };
  }
  // offset tool: apply the exact distance to the selected edges by mode
  $('of-apply').addEventListener('click', () => {
    const mode = $('of-mode').value;
    const val = parseFloat($('of-dist').value) || 0;
    if (!val) return;
    if (mode === 'guide') {
      // guide scribing applies live; Apply re-scribes the run at the new distance
      if (insetChain) {
        const piece = pieceById(insetChain.pieceId);
        if (piece) {
          insetChain.d = Math.max(0.05, Math.abs(val));
          regenChainGuides(piece);
          $('status-hint').textContent = `Guide re-scribed at ${fmt(Math.abs(val))} cm`;
        }
      }
      return;
    }
    const p = selPiece();
    if (!p) return;
    const segs = selectedSegsOf(p);
    if (!segs.length) return;
    if (mode === 'extrude') {
      // extrude each selected edge; descending order keeps lower indices valid
      beginChange();
      const order = segs.slice().sort((x, y) => y - x);
      const mids = [];
      for (const i of order) {
        const nrm = segOffsetNormal(p, i);
        const mid = extrudeSeg(p, i);
        const a = p.path.nodes[mid], b = p.path.nodes[mid + 1];
        a.x += nrm.x * val; a.y += nrm.y * val;
        b.x += nrm.x * val; b.y += nrm.y * val;
        mids.push(mid);
      }
      endChange();
      // every later (lower-index) extrusion shifted the earlier mids by +2
      setSegSelection(p, mids.map((m, j) => m + 2 * (order.length - 1 - j)).sort((x, y) => x - y));
      $('status-hint').textContent =
        `${order.length} edge${order.length > 1 ? 's' : ''} protruded ${val > 0 ? 'outward' : 'inward'} by ${fmt(Math.abs(val))} cm`;
    } else {
      const vecs = segsOffsetVectors(p, segs);
      beginChange();
      for (const [k, v] of vecs) {
        const nd = p.path.nodes[k];
        nd.x += v.x * val; nd.y += v.y * val;
      }
      endChange();
      $('status-hint').textContent =
        `${segs.length} edge${segs.length > 1 ? 's' : ''} slid ${val > 0 ? 'outward' : 'inward'} by ${fmt(Math.abs(val))} cm`;
    }
    renderAll(); renderSidebar();
  });
  $('of-mode').addEventListener('change', () => {
    const m = $('of-mode').value;
    if (m !== 'guide') insetChain = null;
    if (m === 'guide') { sel.kind = null; sel.idx = -1; }
    $('of-hint').textContent = m === 'slide'
      ? 'Moves the selected edges along their normals (+ out, − in), mitred where two share a corner; neighbouring edges stretch to follow.'
      : m === 'extrude'
        ? 'Extrudes each selected edge into a tab (+ out) or recess (− in) — its corners stay put and straight side walls form.'
        : 'Scribes a dashed guide line inset from the picked edges (mitred runs; click inside a piece for a full ring). Exports to MARK — use the Stitch tool on it for holes.';
    renderAll(true);
    $('status-hint').textContent = HINTS.offset;
  });
  $('of-dist').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { $('of-apply').click(); ev.preventDefault(); }
    ev.stopPropagation();
  });
  $('st-apply').addEventListener('click', stitchApply);
  $('st-mode').addEventListener('change', () => {
    stitchMulti = [];
    stitchSideA = null;
    updateStitchUi();
    renderAll(true);
  });
  // typing exact coordinates for the selected point
  for (const key of ['x', 'y']) {
    $('sp-' + key).addEventListener('change', () => {
      const p = selPiece();
      if (!p || sel.kind !== 'node' || !p.path.nodes[sel.idx]) return;
      const v = parseFloat($('sp-' + key).value);
      if (!isFinite(v)) return;
      beginChange();
      p.path.nodes[sel.idx][key] = v;
      endChange();
      renderAll(true);
    });
  }
  // exact Δx/Δy move for the current selection / the whole piece
  $('sp-move-btn').addEventListener('click', () => {
    if (!selPiece()) return;
    const dx = parseFloat($('sp-dx').value) || 0;
    const dy = parseFloat($('sp-dy').value) || 0;
    if (!dx && !dy) return;
    beginChange();
    applyMove(dx, dy);
    endChange();
    renderAll(); renderSidebar();
    $('status-hint').textContent = `Moved by (${fmt(dx)}, ${fmt(dy)}) cm`;
  });
  $('pp-move-btn').addEventListener('click', () => {
    const dx = parseFloat($('pp-dx').value) || 0;
    const dy = parseFloat($('pp-dy').value) || 0;
    if (!dx && !dy) return;
    const ids = multiSel.length > 1 ? multiSel : (selPiece() ? [selPiece().id] : []);
    if (!ids.length) return;
    beginChange();
    for (const id of ids) { const p = pieceById(id); if (p) movePiece(p, dx, dy); }
    endChange();
    renderAll(); renderSidebar();
    $('status-hint').textContent =
      `${ids.length > 1 ? ids.length + ' pieces' : 'Piece'} moved by (${fmt(dx)}, ${fmt(dy)}) cm`;
  });
  for (const [inp, btn] of [['sp-dx', 'sp-move-btn'], ['sp-dy', 'sp-move-btn'],
    ['pp-dx', 'pp-move-btn'], ['pp-dy', 'pp-move-btn']]) {
    $(inp).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { $(btn).click(); ev.preventDefault(); }
      ev.stopPropagation();
    });
  }
  $('sp-fold').addEventListener('click', () => {
    const p = selPiece();
    if (!p || sel.kind !== 'seg' || !p.path.closed) return;
    if (p.foldSeg === sel.idx) {
      beginChange(); p.foldSeg = null; endChange(); renderAll();
      return;
    }
    const n = p.path.nodes.length;
    if (!Geo.segIsLine(p.path.nodes[sel.idx], p.path.nodes[(sel.idx + 1) % n])) {
      alert('A fold line must be a straight edge (no curve handles).');
      return;
    }
    beginChange(); p.foldSeg = sel.idx; endChange(); renderAll();
  });
  $('pp-bake').addEventListener('click', () => {
    const p = selPiece();
    if (!p || !isFolded(p)) return;
    const u = DXF.unfoldPiece(p);
    if (u === p) return;
    beginChange();
    p.path.nodes = u.path.nodes;
    p.notches = u.notches;
    p.holes = u.holes;
    p.stitchSlits = u.stitchSlits;
    p.cutouts = u.cutouts;
    p.foldSeg = null;
    endChange();
    selectPiece(p.id);
    renderAll();
  });
  $('chk-snap').addEventListener('change', () => {});
  window.addEventListener('resize', applyView);

  $('st-workflow').addEventListener('change', () => {
    stitchMulti = []; stitchSideA = null;
    const action = $('st-workflow').value;
    if (tool !== 'stitch') setTool('stitch');
    $('st-workflow').value = action;
    updateStitchUi(); renderAll();
  });
  $('sp-run-rebuild').addEventListener('click', rebuildStitchRuns);
  $('sp-delete-whole').addEventListener('click', () => {
    const groups = selectedStitchRuns(false);
    if (!groups.length) return;
    const drop = new Set(groups.flatMap(g=>g.indices.map(i=>g.piece.stitchSlits[i])));
    beginChange();
    for (const p of new Set(groups.map(g=>g.piece))) p.stitchSlits = p.stitchSlits.filter(s=>!drop.has(s));
    endChange(); sel.kind=null; sel.idx=-1; sel.slits=[]; renderAll();
    $('status-hint').textContent = `Deleted ${groups.length} run(s); matched partners were kept`;
  });
  $('hole-update').addEventListener('click', () => {
    const p = selPiece(), value = Number($('hole-diameter').value);
    if (!p || sel.kind !== 'hole') return;
    if (!Number.isFinite(value) || value < 0.5 || value > 100) { $('status-hint').textContent = 'Hole diameter must be 0.5–100 mm.'; return; }
    beginChange(); p.holes[sel.idx].r = value / 20; endChange(); renderAll();
  });
  $('grain-remove').addEventListener('click', () => {
    const p = selPiece(); if (!p || !p.grain) return;
    beginChange(); p.grain = null; endChange(); renderAll();
  });
  $('pen-add').addEventListener('click', () => {
    if (!draft || !draft.nodes.length) { $('status-hint').textContent = 'Place the first point on the canvas.'; return; }
    if (!$('pen-length').checkValidity() || !$('pen-angle').checkValidity()) return;
    $('pd-len').value = $('pen-length').value; $('pd-ang').value = $('pen-angle').value;
    commitPenDialog();
  });
  $('pen-finish').addEventListener('click', () => finishDraft(false));
  $('tool-cancel').addEventListener('click', () => {
    stitchMulti = []; stitchSideA = null; weldFirst = null; knifeFirst = null; boolFirst = null; insetChain = null;
    if (tool === 'pen') finishDraft(false);
    clearSel(); renderAll(); $('status-hint').textContent = HINTS[tool];
  });
  new MutationObserver(() => { $('tool-instructions').textContent = $('status-hint').textContent; })
    .observe($('status-hint'), {childList:true, characterData:true, subtree:true});
  document.addEventListener('click', ev => {
    for (const menu of document.querySelectorAll('.top-menu[open]')) if (!menu.contains(ev.target)) menu.open = false;
  });

  // ---------- boot ----------
  (function boot() {
    restoreStitchSettings();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.pieces)) doc = migrateDoc(parsed);
      }
    } catch (e) { /* corrupted autosave — start fresh */ }
    // surface the build the browser actually loaded: a stale cached copy is
    // otherwise indistinguishable from a change that never shipped
    $('status-build').textContent = $('logo').title || '';
    $('doc-name').value = doc.name || 'Untitled pattern';
    setTool('select');
    applyView();
    if (doc.pieces.length) zoomFit();
    renderAll();
  })();
})();
