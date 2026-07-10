/* Pattern Studio — DXF importer.
 * Pure functions, no DOM. Works in browser (window.DXFImport) and Node.
 *
 * Reads the entity types pattern/laser DXFs actually use:
 *   LINE, LWPOLYLINE (incl. bulge arcs), POLYLINE/VERTEX/SEQEND (incl. bulge),
 *   ARC, CIRCLE. SPLINE/TEXT/INSERT etc. are counted and skipped.
 * Bulges and ARCs become real bezier curves (arcs split into ≤90° spans),
 * loose segments are chained into outlines by endpoint proximity, closed
 * loops become pieces, small circles become drill holes, and straight runs
 * are Douglas-Peucker simplified so flattened exports don't arrive with
 * hundreds of nodes.
 *
 * DXF is y-up; the document model is cm, y-down — build() flips and scales.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./geometry.js'));
  } else {
    root.DXFImport = factory(root.Geo);
  }
})(typeof self !== 'undefined' ? self : this, function (Geo) {
  'use strict';

  const JOIN_TOL = 0.05;      // cm — endpoints closer than this are the same point
  const SIMPLIFY_TOL = 0.05;  // cm — max deviation when removing collinear points
  const MIN_OPEN_LEN = 1.0;   // cm — shorter open chains are notch/stitch slit debris
  const HOLE_MAX_R = 0.5;     // cm — circles up to this radius become drill holes

  // ---- group-code pair reader ----
  function pairs(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const out = [];
    let i = 0;
    while (i < lines.length - 1) {
      const codeStr = lines[i].trim();
      if (codeStr === '') { i++; continue; }
      const code = parseInt(codeStr, 10);
      if (Number.isNaN(code)) { i++; continue; }
      out.push([code, lines[i + 1].trim()]);
      i += 2;
    }
    return out;
  }

  // ---- parse: raw entities, no geometry interpretation yet ----
  function parse(text) {
    const ps = pairs(text);
    let section = null;
    let insunits = null;
    const flat = [];
    let i = 0;
    while (i < ps.length) {
      const [c, v] = ps[i];
      if (c === 0 && v === 'SECTION') {
        section = ps[i + 1] && ps[i + 1][0] === 2 ? ps[i + 1][1] : null;
        i += 2;
        continue;
      }
      if (c === 0 && (v === 'ENDSEC' || v === 'EOF')) { section = null; i++; continue; }
      if (section === 'HEADER' && c === 9 && v === '$INSUNITS') {
        if (ps[i + 1] && ps[i + 1][0] === 70) insunits = parseInt(ps[i + 1][1], 10);
        i += 2;
        continue;
      }
      if (section === 'ENTITIES' && c === 0) {
        const e = { type: v, data: [] };
        i++;
        while (i < ps.length && ps[i][0] !== 0) { e.data.push(ps[i]); i++; }
        flat.push(e);
        continue;
      }
      i++;
    }

    // group POLYLINE ... VERTEX* ... SEQEND
    const entities = [];
    for (let k = 0; k < flat.length; k++) {
      const e = flat[k];
      if (e.type === 'POLYLINE') {
        const verts = [];
        let kk = k + 1;
        while (kk < flat.length && flat[kk].type === 'VERTEX') { verts.push(flat[kk]); kk++; }
        if (kk < flat.length && flat[kk].type === 'SEQEND') kk++;
        entities.push({ type: 'POLYLINE', data: e.data, verts });
        k = kk - 1;
      } else if (e.type !== 'VERTEX' && e.type !== 'SEQEND') {
        entities.push(e);
      }
    }
    return { insunits, entities };
  }

  const num = (e, code, dflt) => {
    for (const [c, v] of e.data) if (c === code) return parseFloat(v);
    return dflt;
  };
  const str = (e, code, dflt) => {
    for (const [c, v] of e.data) if (c === code) return v;
    return dflt;
  };

  // cm per drawing unit for a DXF $INSUNITS value; null = unknown/unitless
  function unitScale(insunits) {
    return { 1: 2.54, 2: 30.48, 4: 0.1, 5: 1, 6: 100 }[insunits] || null;
  }

  // crude raw-coordinate extent, for unit guessing before build()
  function rawExtent(raw) {
    let min = Infinity, max = -Infinity;
    const see = (v) => { if (v < min) min = v; if (v > max) max = v; };
    for (const e of raw.entities) {
      for (const [c, v] of e.data) if (c === 10 || c === 20 || c === 11 || c === 21) see(parseFloat(v));
      for (const vt of e.verts || []) for (const [c, v] of vt.data) if (c === 10 || c === 20) see(parseFloat(v));
    }
    return max > min ? max - min : 0;
  }
  // patterns are 10–150cm; raw extents ≥250 read as mm
  function guessUnits(raw) { return rawExtent(raw) >= 250 ? 'mm' : 'cm'; }

  // ---- arcs ----
  // Nodes for an arc in doc coords: center c, radius r, from angle a0 with a
  // signed sweep, split into ≤90° spans so the cubic approximation stays exact
  // to well under 0.1mm.
  function arcNodes(c, r, a0, sweep) {
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2 + 1e-9)));
    const d = sweep / steps;
    const k = (4 / 3) * Math.tan(Math.abs(d) / 4) * r;
    const nodes = [];
    for (let s = 0; s <= steps; s++) {
      const a = a0 + d * s;
      const t = { x: -Math.sin(a) * Math.sign(d), y: Math.cos(a) * Math.sign(d) };
      nodes.push({
        x: c.x + r * Math.cos(a),
        y: c.y + r * Math.sin(a),
        hin: s > 0 ? { x: -t.x * k, y: -t.y * k } : null,
        hout: s < steps ? { x: t.x * k, y: t.y * k } : null,
      });
    }
    return nodes;
  }

  // Arc between two known points with a DXF bulge (already in doc coords,
  // bulge sign already flipped for y-down). Returns arc params or null.
  function bulgeArc(p0, p1, b) {
    if (!b || Math.abs(b) < 1e-9) return null;
    const theta = 4 * Math.atan(b);
    const d = Geo.dist(p0, p1);
    if (d < 1e-9) return null;
    const r = d / (2 * Math.sin(Math.abs(theta) / 2));
    const mid = Geo.lerp(p0, p1, 0.5);
    const u = Geo.norm(Geo.sub(p1, p0));
    const n = { x: -u.y, y: u.x };
    const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
    for (const sgn of [1, -1]) {
      const c = Geo.add(mid, Geo.scale(n, h * sgn));
      const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
      const pe = { x: c.x + r * Math.cos(a0 + theta), y: c.y + r * Math.sin(a0 + theta) };
      if (Geo.dist(pe, p1) < 1e-6 * Math.max(1, r)) return { c, r, a0, sweep: theta };
    }
    return null;
  }

  // Chain segment between consecutive polyline vertices: straight, or the
  // bulge arc expanded to curve nodes.
  function appendVertex(chain, p0, p1, bulge) {
    const arc = bulgeArc(p0, p1, bulge);
    if (!arc) {
      chain.push({ x: p1.x, y: p1.y, hin: null, hout: null });
      return;
    }
    const an = arcNodes(arc.c, arc.r, arc.a0, arc.sweep);
    // an[0] coincides with the chain's current last node — merge handles
    chain[chain.length - 1].hout = an[0].hout;
    for (let i = 1; i < an.length; i++) chain.push(an[i]);
  }

  // ---- chain joining ----
  function reverseChain(nodes) { return Geo.reverseNodes(nodes); }

  function joinChains(chains, tol) {
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < chains.length && !merged; i++) {
        for (let j = i + 1; j < chains.length && !merged; j++) {
          let A = chains[i], B = chains[j];
          const aS = A[0], aE = A[A.length - 1];
          const bS = B[0], bE = B[B.length - 1];
          if (Geo.dist(aE, bS) < tol) { /* A + B */ }
          else if (Geo.dist(aE, bE) < tol) B = reverseChain(B);
          else if (Geo.dist(aS, bE) < tol) { const T = A; A = B; B = T; }
          else if (Geo.dist(aS, bS) < tol) { A = reverseChain(A); }
          else continue;
          // junction: keep A's end position, adopt B's outgoing handle
          const joined = A.slice();
          joined[joined.length - 1] = Object.assign({}, joined[joined.length - 1], {
            hout: B[0].hout ? { x: B[0].hout.x, y: B[0].hout.y } : null,
          });
          for (let q = 1; q < B.length; q++) joined.push(B[q]);
          chains.splice(j, 1);
          chains.splice(i, 1);
          chains.push(joined);
          merged = true;
        }
      }
    }
    return chains;
  }

  // ---- simplification (straight runs only — curve nodes are untouched) ----
  function perpDist(p, a, b) {
    const ab = Geo.sub(b, a);
    const l2 = ab.x * ab.x + ab.y * ab.y;
    if (l2 < 1e-18) return Geo.dist(p, a);
    let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
    t = Math.max(0, Math.min(1, t));
    return Geo.dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
  }

  function dpKeep(pts, tol) {
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const seg = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = seg[0] + 1; i < seg[1]; i++) {
        const d = perpDist(pts[i], pts[seg[0]], pts[seg[1]]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { keep[idx] = true; stack.push([seg[0], idx], [idx, seg[1]]); }
    }
    return keep;
  }

  function simplifyChain(nodes, closed, tol) {
    const n = nodes.length;
    if (n < 3) return nodes;
    // a node is a "corner anchor" if it (or its neighbours facing it) carries handles
    const anchored = nodes.map((nd, i) => {
      if (nd.hin || nd.hout) return true;
      const prev = nodes[(i - 1 + n) % n], next = nodes[(i + 1) % n];
      if (!closed && (i === 0 || i === n - 1)) return true;
      return !!(prev.hout || next.hin);
    });
    // for closed pure polygons, anchor an arbitrary vertex to cut the loop
    if (closed && !anchored.some(Boolean)) anchored[0] = true;
    const order = [];
    const first = anchored.findIndex(Boolean);
    if (first === -1) return nodes; // open with no anchors can't happen (ends anchored)
    for (let i = 0; i < n; i++) order.push((first + i) % n);
    if (closed) order.push(first); // wrap to close the last run

    const out = [];
    let run = [order[0]];
    const flushRun = () => {
      if (run.length > 2) {
        const pts = run.map((idx) => nodes[idx]);
        const keep = dpKeep(pts, tol);
        for (let q = 1; q < run.length - 1; q++) if (keep[q]) out.push(nodes[run[q]]);
      } else {
        for (let q = 1; q < run.length - 1; q++) out.push(nodes[run[q]]);
      }
    };
    out.push(nodes[order[0]]);
    for (let q = 1; q < order.length; q++) {
      const idx = order[q];
      run.push(idx);
      if (anchored[idx] || q === order.length - 1) {
        flushRun();
        if (!(closed && q === order.length - 1)) out.push(nodes[idx]);
        run = [idx];
      }
    }
    return out;
  }

  // ---- build: raw entities -> pieces/holes in cm, y-down ----
  function build(raw, scale) {
    const warnings = [];
    const skipped = {};
    const chains = [];   // open chains to join
    const pieces = [];   // already-closed outlines
    const circles = [];
    const tx = (x, y) => ({ x: x * scale, y: -y * scale });

    for (const e of raw.entities) {
      if (e.type === 'LINE') {
        const a = tx(num(e, 10, 0), num(e, 20, 0));
        const b = tx(num(e, 11, 0), num(e, 21, 0));
        chains.push([
          { x: a.x, y: a.y, hin: null, hout: null },
          { x: b.x, y: b.y, hin: null, hout: null },
        ]);
      } else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
        const verts = [];
        if (e.type === 'LWPOLYLINE') {
          let cur = null;
          for (const [c, v] of e.data) {
            if (c === 10) { cur = { x: parseFloat(v), y: 0, bulge: 0 }; verts.push(cur); }
            else if (c === 20 && cur) cur.y = parseFloat(v);
            else if (c === 42 && cur) cur.bulge = parseFloat(v);
          }
        } else {
          for (const vt of e.verts || []) {
            verts.push({ x: num(vt, 10, 0), y: num(vt, 20, 0), bulge: num(vt, 42, 0) });
          }
        }
        if (verts.length < 2) continue;
        const closed = (num(e, 70, 0) & 1) === 1;
        const pts = verts.map((v) => Object.assign(tx(v.x, v.y), { bulge: -(v.bulge || 0) })); // y-flip flips arc side
        const chain = [{ x: pts[0].x, y: pts[0].y, hin: null, hout: null }];
        for (let i = 1; i < pts.length; i++) appendVertex(chain, pts[i - 1], pts[i], pts[i - 1].bulge);
        if (closed) {
          appendVertex(chain, pts[pts.length - 1], pts[0], pts[pts.length - 1].bulge);
          // last node coincides with the first — merge and drop it
          const last = chain.pop();
          chain[0].hin = last.hin ? { x: last.hin.x, y: last.hin.y } : null;
          pieces.push({ closed: true, nodes: chain });
        } else {
          chains.push(chain);
        }
      } else if (e.type === 'ARC') {
        const c = tx(num(e, 10, 0), num(e, 20, 0));
        const r = num(e, 40, 0) * scale;
        // DXF arcs run CCW (y-up) from 50° to 51°; after the y-flip that is a
        // negative sweep from -a0
        let a0 = -(num(e, 50, 0) * Math.PI / 180);
        let a1 = -(num(e, 51, 0) * Math.PI / 180);
        while (a1 >= a0) a1 -= 2 * Math.PI;
        if (r > 1e-9) chains.push(arcNodes(c, r, a0, a1 - a0));
      } else if (e.type === 'CIRCLE') {
        const c = tx(num(e, 10, 0), num(e, 20, 0));
        circles.push({ x: c.x, y: c.y, r: num(e, 40, 0) * scale });
      } else {
        skipped[e.type] = (skipped[e.type] || 0) + 1;
      }
    }

    joinChains(chains, JOIN_TOL);

    let debris = 0;
    for (const chain of chains) {
      const closed = chain.length > 3 && Geo.dist(chain[0], chain[chain.length - 1]) < JOIN_TOL;
      if (closed) {
        const last = chain.pop();
        chain[0].hin = last.hin ? { x: last.hin.x, y: last.hin.y } : null;
        pieces.push({ closed: true, nodes: chain });
      } else {
        if (Geo.pathLength(chain, false) < MIN_OPEN_LEN) { debris++; continue; }
        pieces.push({ closed: false, nodes: chain });
      }
    }

    for (const p of pieces) p.nodes = simplifyChain(p.nodes, p.closed, SIMPLIFY_TOL);

    // circles: small -> drill holes (assigned to the enclosing piece), else round pieces
    const holes = [];
    for (const c of circles) {
      if (c.r <= HOLE_MAX_R) holes.push(c);
      else {
        const an = arcNodes({ x: c.x, y: c.y }, c.r, 0, 2 * Math.PI);
        const last = an.pop(); // coincides with the first node — merge its handle
        an[0].hin = last.hin;
        pieces.push({ closed: true, nodes: an });
      }
    }
    for (const p of pieces) p.holes = [];
    let orphanHoles = 0;
    for (const h of holes) {
      const host = pieces.find((p) => p.closed &&
        Geo.pointInPolygon(Geo.pathPolyline(p.nodes, true, 0.1), h));
      if (host) host.holes.push({ x: h.x, y: h.y, r: h.r });
      else orphanHoles++;
    }

    // shift everything into a friendly spot near the origin
    const every = [];
    for (const p of pieces) every.push(...Geo.pathPolyline(p.nodes, p.closed, 0.5));
    if (every.length) {
      const bb = Geo.bbox(every);
      const dx = 2 - bb.minX, dy = 2 - bb.minY;
      for (const p of pieces) {
        for (const nd of p.nodes) { nd.x += dx; nd.y += dy; }
        for (const h of p.holes) { h.x += dx; h.y += dy; }
      }
    }

    if (debris) warnings.push(`${debris} tiny line(s) skipped (notch/stitch slit debris)`);
    if (orphanHoles) warnings.push(`${orphanHoles} small circle(s) outside any piece skipped`);
    for (const t in skipped) warnings.push(`${skipped[t]} ${t} entit${skipped[t] > 1 ? 'ies' : 'y'} skipped`);
    return { pieces, warnings };
  }

  return { parse, build, unitScale, guessUnits, rawExtent };
});
