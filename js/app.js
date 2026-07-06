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
      grain: null,
    };
  }
  function pieceById(id) { return doc.pieces.find((p) => p.id === id) || null; }

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
      pts.push(...Geo.pathPolyline(p.path.nodes, p.path.closed, 0.1));
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

  function renderPieces() {
    clear(gPieces);
    for (const piece of doc.pieces) {
      if (piece.visible === false) continue;
      const g = el('g', { class: 'piece' + (piece.id === sel.pieceId ? ' selected' : ''), 'data-id': piece.id }, gPieces);
      const nodes = piece.path.nodes;
      const closed = piece.path.closed;
      if (nodes.length < 2) continue;

      // cutting line (seam allowance)
      const sa = closed ? (piece.seamAllowance || 0) : 0;
      let seamPts = null;
      if (closed) seamPts = Geo.dedupe(Geo.pathPolyline(nodes, closed, 0.05));
      if (sa > 0 && seamPts && seamPts.length > 2) {
        el('path', { class: 'piece-cut', d: polyD(Geo.offsetClosed(seamPts, sa), true) }, g);
      }

      // main outline
      el('path', { class: 'piece-fill' + (closed ? '' : ' open'), d: pathD(nodes, closed) }, g);

      // notches
      if (closed && seamPts && (piece.notches || []).length) {
        const s = Geo.outwardSign(seamPts);
        const nl = piece.notchLength || 0.4;
        for (const nt of piece.notches) {
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

      // holes
      for (const h of piece.holes || []) {
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
    const piece = selPiece();
    if (!piece || tool === 'pen') return;
    const nodes = piece.path.nodes;
    const n = nodes.length;
    const r = px(4);

    // selected segment highlight + length
    if (sel.kind === 'seg' && sel.idx < (piece.path.closed ? n : n - 1)) {
      const a = nodes[sel.idx], b = nodes[(sel.idx + 1) % n];
      let d;
      if (Geo.segIsLine(a, b)) d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
      else {
        const c = Geo.segCtrl(a, b);
        d = `M ${a.x} ${a.y} C ${c.c1.x} ${c.c1.y} ${c.c2.x} ${c.c2.y} ${b.x} ${b.y}`;
      }
      el('path', { class: 'seg-highlight', d }, gOverlay);
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
      ln.textContent = fmt(Geo.pathLength(piece.path.nodes, piece.path.closed)) + ' cm';
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
      $('pp-perim').textContent = fmt(Geo.pathLength(piece.path.nodes, piece.path.closed)) + ' cm';
    }

    // selection props
    const showNode = piece && sel.kind === 'node' && piece.path.nodes[sel.idx];
    const showSeg = piece && sel.kind === 'seg';
    $('sel-props').hidden = !(showNode || showSeg);
    $('sel-node-row').hidden = !showNode;
    $('sel-seg-row').hidden = !showSeg;
    $('sel-seg-anchor-row').hidden = !showSeg;
    if (showNode) {
      const nd = piece.path.nodes[sel.idx];
      $('sp-x').value = fmt(nd.x);
      $('sp-y').value = fmt(nd.y);
      $('sel-hint').textContent = 'Double-click the point to toggle corner / smooth.';
    } else if (showSeg) {
      const n = piece.path.nodes.length;
      const a = piece.path.nodes[sel.idx], b = piece.path.nodes[(sel.idx + 1) % n];
      if (document.activeElement !== $('sp-seglen')) {
        $('sp-seglen').value = fmt(Geo.segLength(a, b));
      }
      $('sel-hint').textContent = 'Type a length to resize the edge — ● marks its start. Double-click the edge to insert a point.';
    }
  }

  // ---------- tools ----------
  let tool = 'select';
  const HINTS = {
    select: 'Click a piece or point to select · drag to move · Del deletes',
    pen: 'Click = corner, drag = curve · click the first point to close · Esc finishes open',
    notch: 'Click near an edge to add a notch',
    hole: 'Click inside a piece to add a drill hole',
    grain: 'Drag inside a piece to set the grainline · click (no drag) removes it',
    measure: 'Drag to measure a distance',
  };
  function setTool(t) {
    tool = t;
    if (t !== 'pen') finishDraft(false);
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

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button === 1 || spaceDown) { // pan
      drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture(ev.pointerId);
      svg.classList.add('panning');
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    svg.focus();
    const w = screenToWorld(ev);
    svg.setPointerCapture(ev.pointerId);

    if (tool === 'pen') return penDown(w);
    if (tool === 'select') return selectDown(ev, w);
    if (tool === 'notch') return notchDown(w);
    if (tool === 'hole') return holeDown(w);
    if (tool === 'grain') return grainDown(w);
    if (tool === 'measure') { drag = { type: 'measure', a: w, b: w }; return; }
  });

  svg.addEventListener('pointermove', (ev) => {
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
      nd[drag.key] = v;
      const other = drag.key === 'hout' ? 'hin' : 'hout';
      if (!ev.altKey && nd[other]) nd[other] = { x: -v.x, y: -v.y };
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

  svg.addEventListener('dblclick', (ev) => {
    const w = screenToWorld(ev);
    if (tool === 'pen') { finishDraft(false); return; }
    if (tool !== 'select') return;
    const piece = selPiece();
    if (!piece) return;
    const nodes = piece.path.nodes;
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
      beginChange();
      const n = nodes.length;
      const a = nodes[hit.seg], b = nodes[(hit.seg + 1) % n];
      const { a2, mid, b2 } = Geo.splitSeg(a, b, hit.t);
      nodes[hit.seg] = a2;
      nodes[(hit.seg + 1) % n] = b2;
      nodes.splice(hit.seg + 1, 0, mid);
      remapAfterInsert(piece, hit.seg, hit.t);
      endChange();
      sel.kind = 'node'; sel.idx = hit.seg + 1;
      renderAll();
    }
  });

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const w = screenToWorld(ev);
    zoomAt(ev.deltaY < 0 ? 1.18 : 1 / 1.18, w.x, w.y);
  }, { passive: false });

  // when a segment is split, notches on that segment must be remapped
  function remapAfterInsert(piece, seg, t) {
    for (const nt of piece.notches || []) {
      if (nt.seg > seg) nt.seg += 1;
      else if (nt.seg === seg) {
        if (nt.t <= t) nt.t = t > 0 ? nt.t / t : 0;
        else { nt.seg += 1; nt.t = (nt.t - t) / (1 - t); }
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
      // 2b. notch / hole of the selected piece
      const nti = hitNotch(piece, w);
      if (nti >= 0) { sel.kind = 'notch'; sel.idx = nti; renderAll(true); renderSidebar(); return; }
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
      const poly = Geo.pathPolyline(p.path.nodes, p.path.closed, 0.1);
      const onEdge = Geo.nearestOnPath(p.path.nodes, p.path.closed, w);
      const inside = p.path.closed && Geo.pointInPolygon(poly, w);
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
      else { clearSel(); renderAll(); }
      return;
    }
    if (k === 'enter' && tool === 'pen' && draft) { finishDraft(false); return; }
    if (k === 'delete' || k === 'backspace') { deleteSelection(); ev.preventDefault(); return; }
    if (k === 'v') setTool('select');
    else if (k === 'p') setTool('pen');
    else if (k === 'n') setTool('notch');
    else if (k === 'h') setTool('hole');
    else if (k === 'g') setTool('grain');
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
        // drop notches on the two segments touching this node, remap the rest
        const n = piece.path.nodes.length;
        const segA = (sel.idx - 1 + n) % n, segB = sel.idx;
        piece.notches = (piece.notches || []).filter((nt) => nt.seg !== segA && nt.seg !== segB);
        for (const nt of piece.notches) if (nt.seg > sel.idx) nt.seg -= 1;
        piece.path.nodes.splice(sel.idx, 1);
        sel.kind = null;
      }
    } else if (sel.kind === 'notch') {
      piece.notches.splice(sel.idx, 1);
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

  function openJSON(file) {
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
