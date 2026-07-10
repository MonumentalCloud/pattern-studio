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
  let doc = newDoc();
  let uidCounter = 1;

  function uid() { return 'p' + (uidCounter++) + '_' + Math.random().toString(36).slice(2, 7); }
  function newDoc() {
    return { version: 1, name: 'Untitled pattern', pieces: [] };
  }
  function newPiece(nodes, closed) {
    return {
      id: uid(),
      name: 'Piece ' + (doc.pieces.length + 1),
      visible: true,
      seamAllowance: 1.0,
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

  function beginChange() { pendingSnapshot = JSON.stringify(doc); }
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
    else sel.kind = null;
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
  const sel = { pieceId: null, kind: null, idx: -1 };
  function clearSel() { sel.pieceId = null; sel.kind = null; sel.idx = -1; }
  function selectPiece(id) { sel.pieceId = id; sel.kind = null; sel.idx = -1; }
  const selPiece = () => (sel.pieceId ? pieceById(sel.pieceId) : null);

  // ---------- snapping ----------
  function snapStep() { return parseFloat($('sel-grid').value) || 0.5; }
  function snapOn() { return $('chk-snap').checked; }
  function snap(p, skipPieceId, skipNodeIdx) {
    // point snap to existing nodes first, then grid
    const tol = px(9);
    let best = null, bd = tol;
    for (const piece of doc.pieces) {
      if (piece.visible === false) continue;
      piece.path.nodes.forEach((n, i) => {
        if (piece.id === skipPieceId && i === skipNodeIdx) return;
        const d = Geo.dist(n, p);
        if (d < bd) { bd = d; best = { x: n.x, y: n.y }; }
      });
    }
    if (best) return best;
    if (!snapOn()) return { x: p.x, y: p.y };
    const s = snapStep();
    return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
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
      const g = el('g', { class: 'piece' + (piece.id === sel.pieceId ? ' selected' : ''), 'data-id': piece.id }, gPieces);
      // guide pieces (inset stitch lines): dashed marking + slits, nothing else
      if (piece.guide) {
        const gn = piece.path.nodes;
        if (gn.length < 2) continue;
        el('path', { class: 'piece-guide', d: pathD(gn, piece.path.closed) }, g);
        const gS = piece.path.closed ? Geo.outwardSign(Geo.pathPolyline(gn, true, 0.1)) : 1;
        for (const sl of piece.stitchSlits || []) {
          if (sl.seg >= gn.length) continue;
          const ln = Geo.slitLine(gn[sl.seg], gn[(sl.seg + 1) % gn.length], sl, gS);
          el('line', { class: 'piece-slit', x1: ln.a.x, y1: ln.a.y, x2: ln.b.x, y2: ln.b.y }, g);
        }
        continue;
      }
      // rp = full geometry (folded pieces resolve to their unfolded outline)
      const rp = effPiece(piece);
      const folded = rp !== piece;
      const nodes = rp.path.nodes;
      const closed = rp.path.closed;
      if (nodes.length < 2) continue;

      // cutting line (seam allowance)
      const sa = closed ? (piece.seamAllowance || 0) : 0;
      let seamPts = null;
      if (closed) seamPts = Geo.dedupe(Geo.pathPolyline(nodes, closed, 0.05));
      if (sa > 0 && seamPts && seamPts.length > 2) {
        el('path', { class: 'piece-cut', d: polyD(Geo.offsetClosed(seamPts, sa), true) }, g);
      }

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

      // notches
      if (closed && seamPts && (rp.notches || []).length) {
        const s = Geo.outwardSign(seamPts);
        const nl = piece.notchLength || 0.4;
        for (const nt of rp.notches) {
          if (nt.seg >= nodes.length) continue;
          const a = nodes[nt.seg], b = nodes[(nt.seg + 1) % nodes.length];
          const p = Geo.segPoint(a, b, nt.t);
          const tan = Geo.segTangent(a, b, nt.t);
          const nrm = { x: s * tan.y, y: -s * tan.x };
          const p1 = Geo.add(p, Geo.scale(nrm, sa));
          const p2 = Geo.add(p, Geo.scale(nrm, sa - nl));
          el('line', { class: 'piece-notch', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, g);
        }
      }

      // stitching slits
      if ((rp.stitchSlits || []).length) {
        const outS = closed && seamPts && seamPts.length > 2 ? Geo.outwardSign(seamPts) : 1;
        for (const sl of rp.stitchSlits) {
          if (sl.seg >= nodes.length) continue;
          const ln = Geo.slitLine(nodes[sl.seg], nodes[(sl.seg + 1) % nodes.length], sl, outS);
          el('line', { class: 'piece-slit', x1: ln.a.x, y1: ln.a.y, x2: ln.b.x, y2: ln.b.y }, g);
        }
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
        const c = Geo.centroid(seamPts);
        el('text', {
          class: 'piece-label', x: c.x, y: c.y,
          'font-size': px(13), 'text-anchor': 'middle',
        }, g).textContent = piece.name;
      }
    }
  }

  function renderOverlay() {
    clear(gOverlay);
    // first edge picked with the weld / stitch tool
    const firstPick = (tool === 'weld' && weldFirst) || (tool === 'stitch' && stitchFirst);
    if (firstPick) {
      const wp = pieceById(firstPick.pieceId);
      if (wp && firstPick.seg < wp.path.nodes.length) {
        const wn = wp.path.nodes;
        el('path', {
          class: 'seg-highlight weld',
          // a guide gets stitched along its whole length — highlight all of it
          d: wp.guide ? pathD(wn, wp.path.closed) : segD(wn[firstPick.seg], wn[(firstPick.seg + 1) % wn.length]),
        }, gOverlay);
      }
    }
    const piece = selPiece();
    if (!piece || tool === 'pen') return;
    const nodes = piece.path.nodes;
    const n = nodes.length;
    const r = px(4);

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
      const node = nodes[sel.idx];
      const hs = [];
      if (node.hin) hs.push({ node, h: node.hin, key: 'hin', idx: sel.idx });
      if (node.hout) hs.push({ node, h: node.hout, key: 'hout', idx: sel.idx });
      for (const item of hs) {
        const hx = item.node.x + item.h.x, hy = item.node.y + item.h.y;
        el('line', { class: 'handle-line', x1: item.node.x, y1: item.node.y, x2: hx, y2: hy }, gOverlay);
        el('circle', {
          class: 'handle-dot', cx: hx, cy: hy, r: px(4.5),
          'data-role': 'handle', 'data-idx': item.idx, 'data-key': item.key,
        }, gOverlay);
      }
    }

    // nodes
    nodes.forEach((nd, i) => {
      el('rect', {
        class: 'node' + (sel.kind === 'node' && sel.idx === i ? ' selected' : ''),
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
      if (piece.id === sel.pieceId) li.classList.add('selected');
      const eye = document.createElement('span');
      eye.className = 'eye' + (piece.visible === false ? ' off' : '');
      eye.textContent = '👁';
      eye.title = 'Show / hide';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        beginChange();
        piece.visible = piece.visible === false;
        endChange();
        renderAll();
      });
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = piece.name;
      const ln = document.createElement('span');
      ln.className = 'len';
      const ep = effPiece(piece);
      ln.textContent = fmt(Geo.pathLength(ep.path.nodes, ep.path.closed)) + ' cm';
      li.append(eye, nm, ln);
      li.addEventListener('click', () => { selectPiece(piece.id); renderAll(); });
      list.appendChild(li);
    }

    // piece props
    const piece = selPiece();
    $('piece-props').hidden = !piece;
    if (piece) {
      $('pp-name').value = piece.name;
      $('pp-sa').value = piece.seamAllowance;
      $('pp-notch').value = piece.notchLength || 0.4;
      const ep = effPiece(piece);
      $('pp-perim').textContent = fmt(Geo.pathLength(ep.path.nodes, ep.path.closed)) + ' cm' +
        (isFolded(piece) ? ' (unfolded)' : '');
      $('pp-bake').hidden = !isFolded(piece);
    }

    // selection props
    const showNode = piece && sel.kind === 'node' && piece.path.nodes[sel.idx];
    const showSeg = piece && sel.kind === 'seg';
    $('sel-props').hidden = !(showNode || showSeg);
    $('sel-node-row').hidden = !showNode;
    $('sel-handle-row').hidden = true;
    $('sel-seg-row').hidden = !showSeg;
    $('sel-seg-anchor-row').hidden = !showSeg;
    $('sel-fold-row').hidden = !showSeg;
    $('sel-clear-slits-row').hidden = true;
    if (showNode) {
      const nd = piece.path.nodes[sel.idx];
      $('sp-x').value = fmt(nd.x);
      $('sp-y').value = fmt(nd.y);
      $('sel-handle-row').hidden = !(nd.hin || nd.hout);
      $('sp-del-hin').disabled = !nd.hin;
      $('sp-del-hout').disabled = !nd.hout;
      $('sel-hint').textContent = (nd.hin || nd.hout)
        ? 'Drag a handle onto its point (or double-click it) to delete just that handle.'
        : 'Double-click the point to toggle corner / smooth.';
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
        : (piece.stitchSlits || []).filter((sl) => sl.seg === sel.idx).length;
      $('sel-clear-slits-row').hidden = !slitCount;
      if (slitCount) $('sp-clear-slits').textContent = `Remove ${slitCount} stitch hole${slitCount > 1 ? 's' : ''}`;
      $('sel-hint').textContent = piece.foldSeg === sel.idx
        ? 'This edge is the fold — the piece unfolds across it on export.'
        : 'Type a length to resize the edge — ● marks its start. Double-click inserts a point · right-click divides by measurement.';
    }
  }

  // ---------- tools ----------
  let tool = 'select';
  let weldFirst = null; // weld tool: { pieceId, seg } of the first picked edge
  let stitchFirst = null; // stitch tool: same, for the first edge of a matched pair
  const HINTS = {
    select: 'Click a piece or point to select · drag to move · Del deletes',
    pen: 'Click = corner, drag = curve · right-click = type exact length/angle · click the first point to close · Esc finishes open',
    notch: 'Click near an edge to add a notch',
    hole: 'Click inside a piece to add a drill hole',
    grain: 'Drag inside a piece to set the grainline · click (no drag) removes it',
    weld: 'Click an edge, then the matching edge on another piece — the second piece moves; both seam edges disappear',
    inset: 'Click edges to select them for a guide line (any order, click again to remove) · click inside a piece for a full-outline ring',
    knife: 'Click two points to cut a piece in two (they snap to existing points) · or click an open path to cut along it · Esc cancels',
    bool: 'Click the base piece (A), then the other (B) — combined with the op from the panel · outlines must cross exactly twice',
    stitch: 'Click an edge or guide line, then its match — both get the same number of stitching slits · same target twice = single run',
    measure: 'Drag to measure a distance',
  };
  function setTool(t) {
    tool = t;
    if (t !== 'pen') finishDraft(false);
    if (t !== 'weld') weldFirst = null;
    if (t !== 'stitch') stitchFirst = null;
    if (t !== 'inset') insetChain = null;
    if (t !== 'knife') knifeFirst = null;
    if (t !== 'bool') boolFirst = null;
    $('stitch-props').hidden = t !== 'stitch';
    $('inset-props').hidden = t !== 'inset';
    $('bool-props').hidden = t !== 'bool';
    document.querySelectorAll('#toolbar .tool').forEach((b) =>
      b.classList.toggle('active', b.dataset.tool === t));
    svg.setAttribute('class', 'tool-' + t);
    $('status-hint').textContent = HINTS[t] || '';
    renderAll(true);
  }

  // ---------- pen tool (drafting a new piece) ----------
  let draft = null; // { nodes: [], mouse: {x,y}|null }

  function renderPenPreview() {
    clear(gPreview);
    if (tool !== 'pen' || !draft || !draft.nodes.length) return;
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
    svg.focus();
    const w = screenToWorld(ev);
    const isDbl = ev.timeStamp - lastDown.t < 400 &&
      Math.hypot(ev.clientX - lastDown.x, ev.clientY - lastDown.y) < 6;
    lastDown = { t: ev.timeStamp, x: ev.clientX, y: ev.clientY };
    if (isDbl) {
      lastDown.t = -1e9; // a triple-click shouldn't count as two doubles
      drag = null;
      return handleDoubleClick(w);
    }
    svg.setPointerCapture(ev.pointerId);

    if (tool === 'pen') return penDown(w);
    if (tool === 'select') return selectDown(ev, w);
    if (tool === 'notch') return notchDown(w);
    if (tool === 'hole') return holeDown(w);
    if (tool === 'grain') return grainDown(w);
    if (tool === 'weld') return weldDown(w);
    if (tool === 'inset') return insetDown(w);
    if (tool === 'knife') return knifeDown(w);
    if (tool === 'bool') return boolDown(w);
    if (tool === 'stitch') return stitchDown(w);
    if (tool === 'measure') { drag = { type: 'measure', a: w, b: w }; return; }
  });

  svg.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch' && touchPts.has(ev.pointerId)) {
      touchPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchPts.size >= 2) { pinchUpdate(); return; }
    }
    const w = screenToWorld(ev);
    $('status-pos').textContent = `${fmt(w.x)}, ${fmt(w.y)} cm`;

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
    if (tool === 'knife' && knifeFirst && !drag) {
      const b = knifeSnap(w);
      clear(gPreview);
      el('line', { class: 'knife-line', x1: knifeFirst.x, y1: knifeFirst.y, x2: b.x, y2: b.y }, gPreview);
      for (const e2 of [knifeFirst, b]) {
        if (e2.snapped) el('circle', { class: 'snap-dot', cx: e2.x, cy: e2.y, r: px(5) }, gPreview);
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
      const piece = pieceById(drag.pieceId);
      const dx = w.x - drag.start.x, dy = w.y - drag.start.y;
      const s = snapOn() ? snapStep() : 0.0001;
      const sdx = Math.round(dx / s) * s, sdy = Math.round(dy / s) * s;
      const ddx = sdx - drag.applied.x, ddy = sdy - drag.applied.y;
      if (ddx || ddy) {
        movePiece(piece, ddx, ddy);
        drag.applied = { x: sdx, y: sdy };
        renderAll(true);
      }
      return;
    }
    if (drag.type === 'grain') {
      drag.b = snap(w);
      const piece = pieceById(drag.pieceId);
      piece.grain = { x1: drag.a.x, y1: drag.a.y, x2: drag.b.x, y2: drag.b.y };
      renderAll(true);
      return;
    }
    if (drag.type === 'measure') {
      drag.b = w;
      clear(gPreview);
      el('line', { class: 'measure-line', x1: drag.a.x, y1: drag.a.y, x2: drag.b.x, y2: drag.b.y }, gPreview);
      const mid = Geo.lerp(drag.a, drag.b, 0.5);
      el('text', {
        class: 'measure-text', x: mid.x, y: mid.y - px(8),
        'font-size': px(12), 'text-anchor': 'middle',
      }, gPreview).textContent = fmt(Geo.dist(drag.a, drag.b)) + ' cm';
      return;
    }
  });

  svg.addEventListener('pointerup', (ev) => {
    if (drag) {
      if (drag.type === 'pan') svg.classList.remove('panning');
      else if (drag.type === 'measure') clear(gPreview);
      else if (drag.type === 'grain') {
        const piece = pieceById(drag.pieceId);
        if (Geo.dist(drag.a, drag.b) < 0.5) piece.grain = drag.hadGrain ? null : piece.grain && null;
        endChange();
        renderAll();
      }
      if (['node', 'handle', 'piece'].includes(drag.type)) { endChange(); renderSidebar(); }
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
    if (sel.kind === 'node' && nodes[sel.idx]) {
      const nd = nodes[sel.idx];
      for (const key of ['hin', 'hout']) {
        if (!nd[key]) continue;
        const hp = { x: nd.x + nd[key].x, y: nd.y + nd[key].y };
        if (Geo.dist(hp, w) < px(8)) {
          beginChange();
          nd[key] = null;
          endChange();
          renderAll();
          return;
        }
      }
    }
    // double-click node: toggle corner/smooth
    const ni = hitNode(piece, w);
    if (ni >= 0) {
      beginChange();
      const nd = nodes[ni];
      if (nd.hin || nd.hout) { nd.hin = null; nd.hout = null; }
      else {
        const n = nodes.length;
        const prev = nodes[(ni - 1 + n) % n], next = nodes[(ni + 1) % n];
        const dir = Geo.norm(Geo.sub(next, prev));
        const l1 = Geo.dist(nd, prev) / 3, l2 = Geo.dist(nd, next) / 3;
        nd.hin = Geo.scale(dir, -Math.max(0.3, l1));
        nd.hout = Geo.scale(dir, Math.max(0.3, l2));
      }
      endChange();
      sel.kind = 'node'; sel.idx = ni;
      renderAll();
      return;
    }
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
  svg.addEventListener('pointercancel', (ev) => {
    if (ev.pointerType === 'touch') { touchPts.delete(ev.pointerId); if (touchPts.size < 2) pinch = null; }
  });

  // when a segment is split, notches/slits on that segment must be remapped
  function remapAfterInsert(piece, seg, t) {
    for (const arr of [piece.notches || [], piece.stitchSlits || []]) {
      for (const nt of arr) {
        if (nt.seg > seg) nt.seg += 1;
        else if (nt.seg === seg) {
          if (nt.t <= t) nt.t = t > 0 ? nt.t / t : 0;
          else { nt.seg += 1; nt.t = (nt.t - t) / (1 - t); }
        }
      }
    }
  }

  function movePiece(piece, dx, dy) {
    for (const nd of piece.path.nodes) { nd.x += dx; nd.y += dy; }
    for (const h of piece.holes || []) { h.x += dx; h.y += dy; }
    if (piece.grain) {
      piece.grain.x1 += dx; piece.grain.y1 += dy;
      piece.grain.x2 += dx; piece.grain.y2 += dy;
    }
  }

  // ---- select tool ----
  function hitNode(piece, w) {
    const tol = px(8);
    let best = -1, bd = tol;
    piece.path.nodes.forEach((nd, i) => {
      const d = Geo.dist(nd, w);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function selectDown(ev, w) {
    const piece = selPiece();
    // 1. handle of the selected node
    if (piece && sel.kind === 'node') {
      const nd = piece.path.nodes[sel.idx];
      if (nd) {
        for (const key of ['hin', 'hout']) {
          if (!nd[key]) continue;
          const hp = { x: nd.x + nd[key].x, y: nd.y + nd[key].y };
          if (Geo.dist(hp, w) < px(8)) {
            beginChange();
            drag = { type: 'handle', pieceId: piece.id, idx: sel.idx, key };
            return;
          }
        }
      }
    }
    // 2. node of the selected piece
    if (piece) {
      const ni = hitNode(piece, w);
      if (ni >= 0) {
        sel.kind = 'node'; sel.idx = ni;
        beginChange();
        drag = { type: 'node', pieceId: piece.id, idx: ni };
        renderAll(true); renderSidebar();
        return;
      }
      // 2b. notch / slit / hole of the selected piece
      const nti = hitNotch(piece, w);
      if (nti >= 0) { sel.kind = 'notch'; sel.idx = nti; renderAll(true); renderSidebar(); return; }
      const sli = hitSlit(piece, w);
      if (sli >= 0) { sel.kind = 'slit'; sel.idx = sli; renderAll(true); renderSidebar(); return; }
      const hi = (piece.holes || []).findIndex((h) => Geo.dist(h, w) < px(8));
      if (hi >= 0) { sel.kind = 'hole'; sel.idx = hi; renderAll(true); renderSidebar(); return; }
      // 3. segment of the selected piece
      const hit = Geo.nearestOnPath(piece.path.nodes, piece.path.closed, w);
      if (hit && hit.dist < px(6)) {
        sel.kind = 'seg'; sel.idx = hit.seg;
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
        selectPiece(p.id);
        beginChange();
        drag = { type: 'piece', pieceId: p.id, start: w, applied: { x: 0, y: 0 } };
        renderAll(true); renderSidebar();
        return;
      }
    }
    clearSel();
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
    const nodes = piece.path.nodes;
    const slits = piece.stitchSlits || [];
    if (!slits.length) return -1;
    const outS = piece.path.closed ? Geo.outwardSign(Geo.pathPolyline(nodes, true, 0.1)) : 1;
    let best = -1, bd = px(6);
    const centers = [];
    slits.forEach((sl, i) => {
      if (sl.seg >= nodes.length) { centers.push(null); return; }
      const ln = Geo.slitLine(nodes[sl.seg], nodes[(sl.seg + 1) % nodes.length], sl, outS);
      const p = Geo.lerp(ln.a, ln.b, 0.5);
      centers.push(p);
      const d = Geo.dist(p, w);
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
    if (gap * view.scale < 16) return -1;
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
    if (tool === 'select') {
      const w = screenToWorld(ev);
      // prefer an edge of the selected piece, else any piece's edge
      let pick = null;
      const sp = selPiece();
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
    beginChange();
    res.piece.notches = res.piece.notches || [];
    res.piece.notches.push({ seg: res.hit.seg, t: res.hit.t });
    endChange();
    selectPiece(res.piece.id);
    renderAll();
  }

  function holeDown(w) {
    const res = pickPieceAt(w, true);
    if (!res) return;
    beginChange();
    res.piece.holes = res.piece.holes || [];
    res.piece.holes.push({ x: snap(w).x, y: snap(w).y, r: 0.15 });
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
    // stitch slits ride along the same way; those on the welded seam vanish with it
    const stitchSlits = [];
    for (const sl of pA.stitchSlits || []) {
      const s = res.segMapA[sl.seg];
      if (s != null) stitchSlits.push(Object.assign({}, sl, { seg: s }));
    }
    for (const sl of pB.stitchSlits || []) {
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
    pA.path.nodes = res.nodes;
    pA.notches = notches;
    pA.holes = holes;
    pA.stitchSlits = stitchSlits;
    pA.grain = grain;
    pA.name = pA.name + '+' + pB.name;
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

  function insetDown(w) {
    const d = Math.max(0.05, parseFloat($('in-dist').value) || 0.3);
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
        newGuidePiece(Geo.simplifyPoly(pts, 0.01, true), true, p.name + ' stitch line');
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
          true, piece.name + ' stitch line');
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
      arcs.forEach((arc, i) => {
        mk(edgeGuideNodes(piece, arc, chain.d), false,
          piece.name + ' stitch line' + (arcs.length > 1 ? ' ' + (i + 1) : ''));
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

  // knife precision: endpoints snap to existing nodes only (never the grid)
  function knifeSnap(w) {
    let best = null, bd = px(9);
    for (const p of doc.pieces) {
      if (p.visible === false || p.guide) continue;
      for (const nd of p.path.nodes) {
        const d = Geo.dist(nd, w);
        if (d < bd) { bd = d; best = { x: nd.x, y: nd.y, snapped: true }; }
      }
    }
    return best || { x: w.x, y: w.y, snapped: false };
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
    const nA = [], nB = [], sA = [], sB = [];
    for (const nt of clone.notches || []) {
      const m = sideOf(nt.seg);
      (m.side === 'A' ? nA : nB).push(Object.assign({}, nt, { seg: m.seg }));
    }
    for (const sl of clone.stitchSlits || []) {
      const m = sideOf(sl.seg);
      (m.side === 'A' ? sA : sB).push(Object.assign({}, sl, { seg: m.seg }));
    }
    const polyA = Geo.pathPolyline(nodesA, true, 0.05);
    const hA = [], hB = [];
    for (const h of clone.holes || []) (Geo.pointInPolygon(polyA, h) ? hA : hB).push(h);
    let gA = null, gB = null;
    if (clone.grain) {
      const gm = { x: (clone.grain.x1 + clone.grain.x2) / 2, y: (clone.grain.y1 + clone.grain.y2) / 2 };
      if (Geo.pointInPolygon(polyA, gm)) gA = clone.grain; else gB = clone.grain;
    }

    // 5. write back: A replaces the original (same id), B is new
    const base = target.name;
    target.name = base + ' 1';
    target.path = { closed: true, nodes: nodesA };
    target.notches = nA;
    target.stitchSlits = sA;
    target.holes = hA;
    target.grain = gA;
    target.foldSeg = null;
    const pieceB = {
      id: uid(), name: base + ' 2', visible: true,
      seamAllowance: target.seamAllowance, notchLength: target.notchLength,
      path: { closed: true, nodes: nodesB },
      notches: nB, stitchSlits: sB, holes: hB, grain: gB, foldSeg: null,
    };
    doc.pieces.splice(doc.pieces.indexOf(target) + 1, 0, pieceB);
    if (sourcePiece) doc.pieces = doc.pieces.filter((p) => p.id !== sourcePiece.id);
    endChange();
    selectPiece(target.id);
    renderAll();
    $('status-hint').textContent = `Cut "${base}" into "${base} 1" and "${base} 2"` +
      (sourcePiece ? ' (cut path consumed)' : '');
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
    if (hits.length !== 2) {
      alert(hits.length === 0
        ? 'The two outlines don\'t cross — overlap the pieces first.'
        : `The outlines cross ${hits.length} times — boolean ops currently need exactly 2 crossings.`);
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
      const s = keepSeg(sl.seg);
      if (s != null) slits.push(Object.assign({}, sl, { seg: s }));
    }
    const resultPoly = Geo.pathPolyline(nodes, true, 0.05);
    const holes = (cA.holes || []).concat(cB.holes || []).filter((h) => Geo.pointInPolygon(resultPoly, h));
    let grain = null;
    if (cA.grain) {
      const gm = { x: (cA.grain.x1 + cA.grain.x2) / 2, y: (cA.grain.y1 + cA.grain.y2) / 2 };
      if (Geo.pointInPolygon(resultPoly, gm)) grain = cA.grain;
    }

    pA.path = { closed: true, nodes };
    pA.notches = notches;
    pA.stitchSlits = slits;
    pA.holes = holes;
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
  function stitchDown(w) {
    const res = nearestEdgeAt(w, true);
    if (!res) return;
    if (!stitchFirst || !pieceById(stitchFirst.pieceId)) {
      stitchFirst = { pieceId: res.piece.id, seg: res.hit.seg };
      selectPiece(res.piece.id);
      $('status-hint').textContent = 'Now click the matching edge (same edge again = single run) · Esc cancels';
      renderAll(true); renderSidebar();
      return;
    }
    const pA = pieceById(stitchFirst.pieceId);
    stitchEdges(pA, stitchFirst.seg, res.piece, res.hit.seg);
  }

  // Put the SAME number of slits on both targets, at equal arc-length
  // fractions, so hole i on side A always pairs with hole i on side B when
  // sewing. A target is one edge of a normal piece, or the WHOLE path of a
  // guide line (inset stitch lines get holes along their full length).
  function stitchTarget(piece, seg) {
    if (piece.guide) {
      return {
        whole: true,
        loop: piece.path.closed,
        len: Geo.pathLength(piece.path.nodes, piece.path.closed),
        place: (fractions) => Geo.pathArcParams(piece.path.nodes, piece.path.closed, fractions),
      };
    }
    const n = piece.path.nodes.length;
    const a = piece.path.nodes[seg], b = piece.path.nodes[(seg + 1) % n];
    return {
      whole: false,
      loop: false,
      len: Geo.segLength(a, b),
      place: (fractions) => Geo.segArcParams(a, b, fractions).map((t) => ({ seg, t })),
    };
  }

  function stitchEdges(pA, segA, pB, segB) {
    const spacing = Math.max(0.1, parseFloat($('st-spacing').value) || 0.3);
    const slitLen = Math.max(0.05, parseFloat($('st-len').value) || 0.15);
    const off = parseFloat($('st-off').value) || 0;
    const tA = stitchTarget(pA, segA);
    const same = pA.id === pB.id && (tA.whole || segA === segB);
    const tB = same ? tA : stitchTarget(pB, segB);
    const count = Math.max(2, Math.round(tA.len / spacing));
    // closed guide rings loop evenly; open runs inset half a step from the ends
    const frFor = (t) => {
      const fr = [];
      for (let i = 0; i < count; i++) fr.push(t.loop ? i / count : (i + 0.5) / count);
      return fr;
    };
    beginChange();
    const put = (piece, target) => {
      piece.stitchSlits = piece.stitchSlits || [];
      for (const pos of target.place(frFor(target))) {
        // holes sit ON a guide line; the Inset field only applies to raw edges
        piece.stitchSlits.push({ seg: pos.seg, t: pos.t, len: slitLen, ang: 45, off: target.whole ? 0 : off });
      }
    };
    put(pA, tA);
    if (!same) put(pB, tB);
    endChange();
    stitchFirst = null;
    $('status-hint').textContent = same
      ? `${count} stitching slits (${fmt(tA.len)} cm)`
      : `${count} matched slits per side (${fmt(tA.len)} vs ${fmt(tB.len)} cm)`;
    renderAll();
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
    if (ev.code === 'Space') { spaceDown = true; svg.classList.add('panning'); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.shiftKey ? redo() : undo(); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'y') { redo(); ev.preventDefault(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 's') { saveJSON(); ev.preventDefault(); return; }
    if (k === 'escape') {
      if (tool === 'pen' && draft) finishDraft(false);
      else if (tool === 'weld' && weldFirst) {
        weldFirst = null;
        $('status-hint').textContent = HINTS.weld;
        renderAll(true);
      } else if (tool === 'stitch' && stitchFirst) {
        stitchFirst = null;
        $('status-hint').textContent = HINTS.stitch;
        renderAll(true);
      } else if (tool === 'inset' && insetChain) {
        insetChain = null;
        $('status-hint').textContent = HINTS.inset;
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
    if (k === 'delete' || k === 'backspace') { deleteSelection(); ev.preventDefault(); return; }
    if (k === 'v') setTool('select');
    else if (k === 'p') setTool('pen');
    else if (k === 'n') setTool('notch');
    else if (k === 'h') setTool('hole');
    else if (k === 'g') setTool('grain');
    else if (k === 'w') setTool('weld');
    else if (k === 'i') setTool('inset');
    else if (k === 'k') setTool('knife');
    else if (k === 'b') setTool('bool');
    else if (k === 's') setTool('stitch');
    else if (k === 'm') setTool('measure');
    else if (k === '0') zoomFit();
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { spaceDown = false; svg.classList.remove('panning'); }
  });

  function deleteSelection() {
    const piece = selPiece();
    if (!piece) return;
    beginChange();
    if (sel.kind === 'node' && piece.path.nodes[sel.idx]) {
      if (piece.path.nodes.length <= (piece.path.closed ? 3 : 2)) {
        doc.pieces = doc.pieces.filter((p) => p.id !== piece.id);
        clearSel();
      } else {
        // drop notches/slits on the two segments touching this node, remap the rest
        const n = piece.path.nodes.length;
        const segA = (sel.idx - 1 + n) % n, segB = sel.idx;
        piece.notches = (piece.notches || []).filter((nt) => nt.seg !== segA && nt.seg !== segB);
        for (const nt of piece.notches) if (nt.seg > sel.idx) nt.seg -= 1;
        piece.stitchSlits = (piece.stitchSlits || []).filter((sl) => sl.seg !== segA && sl.seg !== segB);
        for (const sl of piece.stitchSlits) if (sl.seg > sel.idx) sl.seg -= 1;
        if (piece.foldSeg != null) {
          // deleting a fold-edge endpoint destroys the fold
          if (sel.idx === piece.foldSeg || sel.idx === (piece.foldSeg + 1) % n) piece.foldSeg = null;
          else if (piece.foldSeg > sel.idx) piece.foldSeg -= 1;
        }
        piece.path.nodes.splice(sel.idx, 1);
        sel.kind = null;
      }
    } else if (sel.kind === 'notch') {
      piece.notches.splice(sel.idx, 1);
      sel.kind = null;
    } else if (sel.kind === 'slit') {
      piece.stitchSlits.splice(sel.idx, 1);
      sel.kind = null;
    } else if (sel.kind === 'hole') {
      piece.holes.splice(sel.idx, 1);
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
    copy.name = piece.name + (mirror ? ' (mirror)' : ' copy');
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
        sl.seg = copy.path.closed ? (2 * n - 2 - sl.seg) % n : (n - 2 - sl.seg);
        sl.t = 1 - sl.t;
        sl.ang = -(sl.ang == null ? 45 : sl.ang); // keep the diagonal mirrored
      }
      if (copy.foldSeg != null && copy.path.closed) copy.foldSeg = (2 * n - 2 - copy.foldSeg) % n;
      for (const h of copy.holes || []) h.x = 2 * cx - h.x;
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

  function saveJSON() { download(safeName() + '.pattern.json', JSON.stringify(doc, null, 1), 'application/json'); }

  function exportDXF() {
    const ok = doc.pieces.some((p) => p.visible !== false && p.path.nodes.length >= 2);
    if (!ok) { alert('Nothing to export — draw a piece first.'); return; }
    download(safeName() + '.dxf', DXF.exportDXF(doc), 'application/dxf');
  }

  function exportSVG() {
    const ok = doc.pieces.some((p) => p.visible !== false && p.path.nodes.length >= 2);
    if (!ok) { alert('Nothing to export — draw a piece first.'); return; }
    const shapes = doc.pieces
      .filter((p) => p.visible !== false && p.path.nodes.length >= 2)
      .map((p) => ({ piece: p, s: DXF.pieceShapes(p) }));
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
    }
    const svgText =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${wMM.toFixed(2)}mm" height="${hMM.toFixed(2)}mm" ` +
      `viewBox="0 0 ${wMM.toFixed(2)} ${hMM.toFixed(2)}">\n<!-- Pattern Studio export, units: mm -->\n${body}</svg>\n`;
    download(safeName() + '.svg', svgText, 'image/svg+xml');
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
        doc = parsed;
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
      doc = parsed;
      endChange();
      clearSel();
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
    $('doc-name').value = doc.name;
    renderAll();
  });
  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) openJSON(e.target.files[0]);
    e.target.value = '';
  });
  $('btn-save').addEventListener('click', saveJSON);
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
  $('pp-sa').addEventListener('change', (e) => {
    const p = selPiece(); if (!p) return;
    beginChange(); p.seamAllowance = Math.max(0, parseFloat(e.target.value) || 0); endChange(); renderAll();
  });
  $('pp-notch').addEventListener('change', (e) => {
    const p = selPiece(); if (!p) return;
    beginChange(); p.notchLength = Math.max(0.1, parseFloat(e.target.value) || 0.4); endChange(); renderAll();
  });
  $('pp-dup').addEventListener('click', () => { const p = selPiece(); if (p) duplicatePiece(p, false); });
  $('pp-mirror').addEventListener('click', () => { const p = selPiece(); if (p) duplicatePiece(p, true); });
  $('pp-del').addEventListener('click', () => {
    const p = selPiece(); if (!p) return;
    beginChange();
    doc.pieces = doc.pieces.filter((q) => q.id !== p.id);
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
  for (const key of ['hin', 'hout']) {
    $('sp-del-' + key).addEventListener('click', () => {
      const p = selPiece();
      if (!p || sel.kind !== 'node' || !p.path.nodes[sel.idx]) return;
      beginChange();
      p.path.nodes[sel.idx][key] = null;
      endChange();
      renderAll();
    });
  }
  $('sp-clear-slits').addEventListener('click', () => {
    const p = selPiece();
    if (!p || sel.kind !== 'seg') return;
    beginChange();
    p.stitchSlits = p.guide ? [] : (p.stitchSlits || []).filter((sl) => sl.seg !== sel.idx);
    endChange();
    renderAll();
  });
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
    p.foldSeg = null;
    endChange();
    selectPiece(p.id);
    renderAll();
  });
  $('chk-snap').addEventListener('change', () => {});
  window.addEventListener('resize', applyView);

  // ---------- boot ----------
  (function boot() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.pieces)) doc = parsed;
      }
    } catch (e) { /* corrupted autosave — start fresh */ }
    $('doc-name').value = doc.name || 'Untitled pattern';
    setTool('select');
    applyView();
    if (doc.pieces.length) zoomFit();
    renderAll();
  })();
})();
