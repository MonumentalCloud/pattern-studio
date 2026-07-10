/* Pattern Studio — geometry core.
 * Pure functions, no DOM. Works in browser (window.Geo) and Node (module.exports).
 * Units: centimetres, y-down (SVG convention). DXF export flips y.
 *
 * Path model:
 *   node = { x, y, hin: {x,y}|null, hout: {x,y}|null }   // handles relative to node
 *   segment i connects nodes[i] -> nodes[i+1] (wraps when closed)
 *   cubic control points: c1 = a + a.hout (a if null), c2 = b + b.hin (b if null)
 *   both handles null => straight line
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;

  // ---- vector helpers ----
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function scale(a, s) { return { x: a.x * s, y: a.y * s }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function len(a) { return Math.hypot(a.x, a.y); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function norm(a) { const l = len(a); return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }; }
  function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  // ---- segment control points ----
  function segCtrl(a, b) {
    const c1 = a.hout ? { x: a.x + a.hout.x, y: a.y + a.hout.y } : { x: a.x, y: a.y };
    const c2 = b.hin ? { x: b.x + b.hin.x, y: b.y + b.hin.y } : { x: b.x, y: b.y };
    return { c1, c2 };
  }
  function segIsLine(a, b) { return !a.hout && !b.hin; }

  // ---- cubic bezier evaluation ----
  function cubicPoint(a, c1, c2, b, t) {
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return {
      x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
      y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
    };
  }
  function cubicTangent(a, c1, c2, b, t) {
    const u = 1 - t;
    let d = {
      x: 3 * u * u * (c1.x - a.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (b.x - c2.x),
      y: 3 * u * u * (c1.y - a.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (b.y - c2.y),
    };
    if (len(d) < EPS) d = sub(b, a); // degenerate handles
    return norm(d);
  }

  function segPoint(a, b, t) {
    if (segIsLine(a, b)) return lerp(a, b, t);
    const { c1, c2 } = segCtrl(a, b);
    return cubicPoint(a, c1, c2, b, t);
  }
  function segTangent(a, b, t) {
    if (segIsLine(a, b)) return norm(sub(b, a));
    const { c1, c2 } = segCtrl(a, b);
    return cubicTangent(a, c1, c2, b, t);
  }

  // ---- adaptive flattening ----
  // Returns points from t=0 to t=1 inclusive of both ends.
  function flattenCubic(a, c1, c2, b, tol) {
    tol = tol || 0.02;
    const out = [{ x: a.x, y: a.y }];
    (function rec(p0, p1, p2, p3, depth) {
      // flatness: control points' distance to chord
      const dx = p3.x - p0.x, dy = p3.y - p0.y;
      const d1 = Math.abs((p1.x - p0.x) * dy - (p1.y - p0.y) * dx);
      const d2 = Math.abs((p2.x - p0.x) * dy - (p2.y - p0.y) * dx);
      const chord2 = dx * dx + dy * dy;
      if (depth >= 18 || (d1 + d2) * (d1 + d2) <= 16 * tol * tol * Math.max(chord2, EPS)) {
        out.push({ x: p3.x, y: p3.y });
        return;
      }
      // de Casteljau split at 0.5
      const p01 = lerp(p0, p1, 0.5), p12 = lerp(p1, p2, 0.5), p23 = lerp(p2, p3, 0.5);
      const p012 = lerp(p01, p12, 0.5), p123 = lerp(p12, p23, 0.5);
      const m = lerp(p012, p123, 0.5);
      rec(p0, p01, p012, m, depth + 1);
      rec(m, p123, p23, p3, depth + 1);
    })(a, c1, c2, b, 0);
    return out;
  }

  // Flatten one segment; includes both endpoints.
  function segFlatten(a, b, tol) {
    if (segIsLine(a, b)) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    const { c1, c2 } = segCtrl(a, b);
    return flattenCubic(a, c1, c2, b, tol);
  }

  // Full path polyline. Closed paths do NOT repeat the first point.
  function pathPolyline(nodes, closed, tol) {
    const n = nodes.length;
    if (n === 0) return [];
    if (n === 1) return [{ x: nodes[0].x, y: nodes[0].y }];
    const pts = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const fp = segFlatten(nodes[i], nodes[(i + 1) % n], tol);
      for (let j = 0; j < fp.length - 1; j++) pts.push(fp[j]);
      if (!closed && i === segs - 1) pts.push(fp[fp.length - 1]);
    }
    return pts;
  }

  function segLength(a, b, tol) {
    const fp = segFlatten(a, b, tol || 0.01);
    let l = 0;
    for (let i = 1; i < fp.length; i++) l += dist(fp[i - 1], fp[i]);
    return l;
  }

  function pathLength(nodes, closed, tol) {
    const n = nodes.length;
    if (n < 2) return 0;
    let l = 0;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) l += segLength(nodes[i], nodes[(i + 1) % n], tol);
    return l;
  }

  // signed area of polygon (shoelace); y-down => visually-clockwise gives positive
  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function bbox(pts) {
    if (!pts.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function centroid(pts) {
    if (!pts.length) return { x: 0, y: 0 };
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  }

  // Remove consecutive duplicate points (within tolerance).
  function dedupe(pts, tol) {
    tol = tol || 1e-6;
    const out = [];
    for (const p of pts) {
      if (!out.length || dist(out[out.length - 1], p) > tol) out.push(p);
    }
    if (out.length > 1 && dist(out[0], out[out.length - 1]) <= tol) out.pop();
    return out;
  }

  // Which side of the flattened path is "outward"?
  // Returns +1 or -1 s.t. outward normal at a point with tangent T is
  // sign * (T.y, -T.x).
  function outwardSign(pts) {
    // y-down coords: positive shoelace area = clockwise on screen, and the
    // normal (ty,-tx) then points away from the interior.
    return polyArea(pts) > 0 ? 1 : -1;
  }

  // Offset a closed polygon outward by d (cm). d > 0 grows the shape.
  // Input should be deduped. Uses miter joins with bevel fallback.
  function offsetClosed(ptsIn, d) {
    const pts = dedupe(ptsIn);
    const n = pts.length;
    if (n < 3 || Math.abs(d) < EPS) return pts.slice();
    const s = outwardSign(pts);
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      const u = norm(sub(p1, p0)), v = norm(sub(p2, p1));
      const nu = { x: s * u.y, y: -s * u.x }; // outward normal of incoming edge
      const nv = { x: s * v.y, y: -s * v.x };
      const denom = 1 + dot(nu, nv);
      if (denom < 1e-4) { // ~180° spike: bevel
        out.push(add(p1, scale(nu, d)), add(p1, scale(nv, d)));
        continue;
      }
      const mlen = d * Math.sqrt(2 / denom);
      if (Math.abs(mlen) > 4 * Math.abs(d)) { // miter limit: bevel
        out.push(add(p1, scale(nu, d)), add(p1, scale(nv, d)));
      } else {
        out.push(add(p1, scale(norm(add(nu, nv)), mlen)));
      }
    }
    return dedupe(out);
  }

  // ---- hit testing ----
  // Nearest point on path to p. Returns { seg, t, dist, point } or null.
  function nearestOnPath(nodes, closed, p) {
    const n = nodes.length;
    if (n < 2) return null;
    const segs = closed ? n : n - 1;
    let best = null;
    for (let i = 0; i < segs; i++) {
      const a = nodes[i], b = nodes[(i + 1) % n];
      const SAMPLES = 32;
      let bt = 0, bd = Infinity;
      for (let k = 0; k <= SAMPLES; k++) {
        const t = k / SAMPLES;
        const q = segPoint(a, b, t);
        const dd = dist(q, p);
        if (dd < bd) { bd = dd; bt = t; }
      }
      // local refinement
      let lo = Math.max(0, bt - 1 / SAMPLES), hi = Math.min(1, bt + 1 / SAMPLES);
      for (let iter = 0; iter < 20; iter++) {
        const t1 = lo + (hi - lo) / 3, t2 = hi - (hi - lo) / 3;
        if (dist(segPoint(a, b, t1), p) < dist(segPoint(a, b, t2), p)) hi = t2; else lo = t1;
      }
      const t = (lo + hi) / 2;
      const q = segPoint(a, b, t);
      const dd = dist(q, p);
      if (!best || dd < best.dist) best = { seg: i, t, dist: dd, point: q };
    }
    return best;
  }

  function pointInPolygon(pts, p) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Split segment (a -> b) at t. Returns { a2, mid, b2 } — replacement nodes
  // (a2/b2 are copies of a/b with adjusted handles, mid is the new node).
  function splitSeg(a, b, t) {
    const a2 = { x: a.x, y: a.y, hin: a.hin ? { ...a.hin } : null, hout: a.hout ? { ...a.hout } : null };
    const b2 = { x: b.x, y: b.y, hin: b.hin ? { ...b.hin } : null, hout: b.hout ? { ...b.hout } : null };
    if (segIsLine(a, b)) {
      const m = lerp(a, b, t);
      return { a2, mid: { x: m.x, y: m.y, hin: null, hout: null }, b2 };
    }
    const { c1, c2 } = segCtrl(a, b);
    const p01 = lerp(a, c1, t), p12 = lerp(c1, c2, t), p23 = lerp(c2, b, t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
    const m = lerp(p012, p123, t);
    a2.hout = { x: p01.x - a.x, y: p01.y - a.y };
    b2.hin = { x: p23.x - b.x, y: p23.y - b.y };
    const mid = {
      x: m.x, y: m.y,
      hin: { x: p012.x - m.x, y: p012.y - m.y },
      hout: { x: p123.x - m.x, y: p123.y - m.y },
    };
    return { a2, mid, b2 };
  }

  // Rescale segment (a -> b) so its arc length becomes `target` (cm).
  // mode: which endpoint moves — 'start', 'end', or 'both' (split evenly).
  // Uniform scaling about the fixed point, so the curve keeps its shape and
  // arc length scales exactly linearly. Only the segment's own handles
  // (a.hout, b.hin) are touched; a.hin / b.hout belong to adjacent segments.
  // Returns { a, b } as new node objects, or null if the segment is degenerate.
  function setSegLength(a, b, target, mode) {
    const current = segLength(a, b, 0.002);
    if (!(target > 0) || current < 1e-6) return null;
    const k = target / current;
    const F = mode === 'start' ? { x: b.x, y: b.y }
      : mode === 'end' ? { x: a.x, y: a.y }
      : lerp(a, b, 0.5);
    const mv = (p) => ({ x: F.x + k * (p.x - F.x), y: F.y + k * (p.y - F.y) });
    const pa = mode === 'end' ? { x: a.x, y: a.y } : mv(a);
    const pb = mode === 'start' ? { x: b.x, y: b.y } : mv(b);
    return {
      a: { x: pa.x, y: pa.y, hin: a.hin ? { ...a.hin } : null, hout: a.hout ? scale(a.hout, k) : null },
      b: { x: pb.x, y: pb.y, hin: b.hin ? scale(b.hin, k) : null, hout: b.hout ? { ...b.hout } : null },
    };
  }

  // t parameters of the points at given arc-length fractions (0..1) along a
  // segment — so equally spaced fractions give equally spaced points even on
  // curves, where t itself is not proportional to distance.
  function segArcParams(a, b, fractions) {
    const K = 256;
    const cum = [0];
    let prev = segPoint(a, b, 0), acc = 0;
    for (let k = 1; k <= K; k++) {
      const q = segPoint(a, b, k / K);
      acc += dist(prev, q);
      cum.push(acc);
      prev = q;
    }
    const total = acc > EPS ? acc : EPS;
    return fractions.map((f) => {
      const target = Math.min(Math.max(f, 0), 1) * total;
      let lo = 0, hi = K;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
      const i = Math.max(1, lo);
      const r = (target - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-12);
      return (i - 1 + r) / K;
    });
  }

  // Endpoints of a stitching slit: a short line at parameter sl.t, rotated
  // sl.ang degrees (default 45) from the local tangent. sl.off (cm) shifts the
  // slit off the path along the normal — positive = inward, negative = outward;
  // outSign is the piece's outwardSign (+1 assumed when unknown/open).
  function slitLine(a, b, sl, outSign) {
    let p = segPoint(a, b, sl.t);
    const tan = segTangent(a, b, sl.t);
    if (sl.off) {
      const os = outSign == null ? 1 : outSign;
      const n = { x: os * tan.y, y: -os * tan.x }; // outward normal
      p = { x: p.x - n.x * sl.off, y: p.y - n.y * sl.off };
    }
    const ang = (sl.ang == null ? 45 : sl.ang) * Math.PI / 180;
    const c = Math.cos(ang), s = Math.sin(ang);
    const d = { x: c * tan.x - s * tan.y, y: s * tan.x + c * tan.y };
    const h = (sl.len || 0.15) / 2;
    return {
      a: { x: p.x - d.x * h, y: p.y - d.y * h },
      b: { x: p.x + d.x * h, y: p.y + d.y * h },
    };
  }

  // Reflect point p across the line through a and b.
  function reflectPoint(p, a, b) {
    const d = norm(sub(b, a));
    if (!d.x && !d.y) return { x: p.x, y: p.y };
    const v = sub(p, a);
    const proj = add(a, scale(d, dot(v, d)));
    return { x: 2 * proj.x - p.x, y: 2 * proj.y - p.y };
  }

  // Reflect a node list (positions and handles) across the line through a-b.
  // Node order is kept, so the winding flips — weldClosedPaths reconciles that.
  function reflectNodes(nodes, a, b) {
    const d = norm(sub(b, a));
    const rv = (v) => {
      if (!v) return null;
      const t = dot(v, d);
      return { x: 2 * t * d.x - v.x, y: 2 * t * d.y - v.y };
    };
    return nodes.map((nd) => {
      const p = reflectPoint(nd, a, b);
      return { x: p.x, y: p.y, hin: rv(nd.hin), hout: rv(nd.hout) };
    });
  }

  // Reverse a path's direction: node order flipped, hin/hout swapped.
  function reverseNodes(nodes) {
    return nodes.slice().reverse().map((nd) => ({
      x: nd.x, y: nd.y,
      hin: nd.hout ? { ...nd.hout } : null,
      hout: nd.hin ? { ...nd.hin } : null,
    }));
  }

  // Weld two closed paths into one along an edge of each. Both seam edges are
  // removed and B is rigidly moved (rotate + translate, never scaled) so the
  // edge endpoints mate; A stays put. Windings are reconciled automatically.
  // tol: max allowed difference between the two edges' endpoint spans (cm) —
  // beyond that the outline can't close cleanly.
  // Returns { nodes, segMapA, segMapB, flipT, xform } or { error, dA, dB }.
  //   segMapX[oldSeg] -> new seg index (null for the removed seam edge)
  //   flipT           -> B notch t values must become 1 - t
  //   xform(p)        -> maps original-B coordinates into the merged piece
  function weldClosedPaths(nodesA, segA, nodesB, segB, tol) {
    tol = tol == null ? 0.3 : tol;
    const nA = nodesA.length, nB = nodesB.length;
    if (nA < 3 || nB < 3 || segA >= nA || segB >= nB) return { error: 'degenerate' };
    // same winding => after mating the reversed edge, B's interior lands on
    // the opposite side of the seam from A's
    const areaA = polyArea(pathPolyline(nodesA, true, 0.05));
    const areaB = polyArea(pathPolyline(nodesB, true, 0.05));
    let B = nodesB, j = segB;
    const flipT = (areaA > 0) !== (areaB > 0);
    if (flipT) {
      B = reverseNodes(nodesB);
      j = ((nB - 2 - segB) % nB + nB) % nB;
    }
    const i = segA;
    const q0 = nodesA[(i + 1) % nA], q1 = nodesA[i]; // B[j] -> q0, B[j+1] -> q1
    const p0 = B[j], p1 = B[(j + 1) % nB];
    const dA = dist(q0, q1), dB = dist(p0, p1);
    if (dA < EPS || dB < EPS) return { error: 'degenerate' };
    if (Math.abs(dA - dB) > tol) return { error: 'length-mismatch', dA, dB };
    const va = sub(q1, q0), vb = sub(p1, p0);
    const ang = Math.atan2(va.y, va.x) - Math.atan2(vb.y, vb.x);
    const c = Math.cos(ang), s = Math.sin(ang);
    const rot = (v) => ({ x: c * v.x - s * v.y, y: s * v.x + c * v.y });
    const xform = (p) => add(q0, rot(sub(p, p0)));
    const th = (h) => (h ? rot(h) : null);

    // A's chain A[i+1] .. A[i] keeps its geometry; junction nodes then adopt
    // B's seam-side handles so B's first/last surviving edges connect
    const nodes = [];
    for (let k = 0; k < nA; k++) {
      const nd = nodesA[(i + 1 + k) % nA];
      nodes.push({ x: nd.x, y: nd.y, hin: nd.hin ? { ...nd.hin } : null, hout: nd.hout ? { ...nd.hout } : null });
    }
    nodes[0].hin = th(B[j].hin);                    // A[i+1] <- edge from B[j-1]
    nodes[nA - 1].hout = th(B[(j + 1) % nB].hout);  // A[i]   -> edge to B[j+2]
    // B's chain interior B[j+2] .. B[j-1], rigidly transformed
    for (let k = 0; k < nB - 2; k++) {
      const nd = B[(j + 2 + k) % nB];
      const p = xform(nd);
      nodes.push({ x: p.x, y: p.y, hin: th(nd.hin), hout: th(nd.hout) });
    }

    const segMapA = new Array(nA).fill(null);
    for (let s2 = 0; s2 < nA; s2++) {
      if (s2 !== i) segMapA[s2] = ((s2 - (i + 1)) % nA + nA) % nA;
    }
    const segMapB = new Array(nB).fill(null);
    for (let s2 = 0; s2 < nB; s2++) {
      const rec = flipT ? ((nB - 2 - s2) % nB + nB) % nB : s2; // index in reconciled B
      if (rec !== j) segMapB[s2] = nA - 1 + (((rec - (j + 1)) % nB + nB) % nB);
    }
    return { nodes, segMapA, segMapB, flipT, xform };
  }

  return {
    sub, add, scale, dot, len, dist, norm, lerp,
    segCtrl, segIsLine, segPoint, segTangent, segFlatten, segLength,
    cubicPoint, cubicTangent, flattenCubic,
    pathPolyline, pathLength, polyArea, bbox, centroid, dedupe,
    outwardSign, offsetClosed, nearestOnPath, pointInPolygon, splitSeg, setSegLength,
    reverseNodes, weldClosedPaths, reflectPoint, reflectNodes, segArcParams, slitLine,
  };
});
