/* Sanity tests for geometry.js and dxf.js (node test/core.test.js) */
const assert = require('assert');
const Geo = require('../js/geometry.js');
const DXF = require('../js/dxf.js');
const DXFImport = require('../js/dxfimport.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { console.error('  FAIL', name, '\n   ', e.message); process.exitCode = 1; }
}

const N = (x, y, hin, hout) => ({ x, y, hin: hin || null, hout: hout || null });

console.log('geometry');

t('line segment length', () => {
  assert(Math.abs(Geo.segLength(N(0, 0), N(3, 4)) - 5) < 1e-6);
});

t('cubic flattening approximates arc length', () => {
  // quarter circle radius 10 approximated by cubic (kappa = 0.5523)
  const k = 5.523;
  const a = N(10, 0, null, { x: 0, y: k });
  const b = N(0, 10, { x: k, y: 0 }, null);
  const len = Geo.segLength(a, b, 0.005);
  const expected = Math.PI * 10 / 2; // 15.708
  assert(Math.abs(len - expected) < 0.05, `len=${len} expected≈${expected}`);
});

t('pathLength closed square', () => {
  const nodes = [N(0, 0), N(10, 0), N(10, 10), N(0, 10)];
  assert(Math.abs(Geo.pathLength(nodes, true) - 40) < 1e-6);
});

t('offsetClosed grows a square outward by d (both windings)', () => {
  for (const pts of [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }],
  ]) {
    const off = Geo.offsetClosed(pts, 1);
    const bb = Geo.bbox(off);
    assert(Math.abs(bb.minX - -1) < 1e-6 && Math.abs(bb.maxX - 11) < 1e-6,
      `bbox ${JSON.stringify(bb)}`);
    assert(Math.abs(Math.abs(Geo.polyArea(off)) - 144) < 1.0, // 12x12 (miter corners)
      `area ${Geo.polyArea(off)}`);
  }
});

t('offsetClosed negative d shrinks', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const off = Geo.offsetClosed(pts, -2);
  const bb = Geo.bbox(off);
  assert(Math.abs(bb.minX - 2) < 1e-6 && Math.abs(bb.maxX - 8) < 1e-6, JSON.stringify(bb));
});

t('outward normal points away from a square', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const s = Geo.outwardSign(pts);
  // bottom edge (y=0 side is top in y-down, but take edge from (0,0)->(10,0)): tangent (1,0)
  const nrm = { x: s * 0, y: -s * 1 }; // s*(ty, -tx)
  // midpoint of that edge displaced by nrm must be OUTSIDE
  const p = { x: 5, y: 0 + nrm.y * 0.5 };
  assert(!Geo.pointInPolygon(pts, p), `normal ${JSON.stringify(nrm)} landed inside`);
});

t('pointInPolygon', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert(Geo.pointInPolygon(pts, { x: 5, y: 5 }));
  assert(!Geo.pointInPolygon(pts, { x: 15, y: 5 }));
});

t('splitSeg keeps the curve shape', () => {
  const a = N(0, 0, null, { x: 3, y: 0 });
  const b = N(10, 10, { x: 0, y: -3 }, null);
  const before = Geo.segPoint(a, b, 0.75);
  const { a2, mid, b2 } = Geo.splitSeg(a, b, 0.5);
  // t=0.75 of original = t=0.5 of second half
  const after = Geo.segPoint(mid, b2, 0.5);
  assert(Geo.dist(before, after) < 1e-9, `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  const lenBefore = Geo.segLength(a, b, 0.002);
  const lenAfter = Geo.segLength(a2, mid, 0.002) + Geo.segLength(mid, b2, 0.002);
  assert(Math.abs(lenBefore - lenAfter) < 0.01);
});

t('nearestOnPath finds the closest edge', () => {
  const nodes = [N(0, 0), N(10, 0), N(10, 10), N(0, 10)];
  const hit = Geo.nearestOnPath(nodes, true, { x: 5, y: -1 });
  assert(hit.seg === 0, `seg=${hit.seg}`);
  assert(Math.abs(hit.point.x - 5) < 0.05 && Math.abs(hit.point.y) < 1e-6, JSON.stringify(hit.point));
  assert(Math.abs(hit.dist - 1) < 0.01);
});

t('setSegLength straight edge, move end', () => {
  const res = Geo.setSegLength(N(0, 0), N(3, 4), 10, 'end');
  assert(res.a.x === 0 && res.a.y === 0, 'start stays anchored');
  assert(Math.abs(res.b.x - 6) < 1e-9 && Math.abs(res.b.y - 8) < 1e-9, `b=${JSON.stringify(res.b)}`);
  assert(Math.abs(Geo.segLength(res.a, res.b) - 10) < 1e-6);
});

t('setSegLength move start keeps end fixed', () => {
  const res = Geo.setSegLength(N(0, 0), N(3, 4), 10, 'start');
  assert(res.b.x === 3 && res.b.y === 4, 'end stays anchored');
  assert(Math.abs(Geo.segLength(res.a, res.b) - 10) < 1e-6);
});

t('setSegLength both splits the change evenly', () => {
  const res = Geo.setSegLength(N(0, 0), N(10, 0), 20, 'both');
  assert(Math.abs(res.a.x - -5) < 1e-9 && Math.abs(res.b.x - 15) < 1e-9,
    `a=${res.a.x} b=${res.b.x}`);
  assert(Math.abs(Geo.segLength(res.a, res.b) - 20) < 1e-6);
});

t('setSegLength curve hits target and keeps shape', () => {
  // quarter circle radius 10 (arc ≈ 15.708)
  const k = 5.523;
  const a = N(10, 0, { x: -2, y: -1 }, { x: 0, y: k });
  const b = N(0, 10, { x: k, y: 0 }, { x: 1, y: 2 });
  const res = Geo.setSegLength(a, b, 20, 'both');
  assert(Math.abs(Geo.segLength(res.a, res.b, 0.002) - 20) < 0.02,
    'len=' + Geo.segLength(res.a, res.b, 0.002));
  // shape preserved: tangent direction at both ends unchanged
  const t0 = Geo.segTangent(a, b, 0), t0b = Geo.segTangent(res.a, res.b, 0);
  const t1 = Geo.segTangent(a, b, 1), t1b = Geo.segTangent(res.a, res.b, 1);
  assert(Geo.dist(t0, t0b) < 1e-9 && Geo.dist(t1, t1b) < 1e-9, 'tangents preserved');
  // adjacent segments' handles are untouched
  assert(res.a.hin.x === -2 && res.a.hin.y === -1, 'a.hin untouched');
  assert(res.b.hout.x === 1 && res.b.hout.y === 2, 'b.hout untouched');
});

t('setSegLength rejects degenerate input', () => {
  assert(Geo.setSegLength(N(0, 0), N(0, 0), 10, 'both') === null, 'zero-length segment');
  assert(Geo.setSegLength(N(0, 0), N(3, 4), 0, 'both') === null, 'zero target');
  assert(Geo.setSegLength(N(0, 0), N(3, 4), NaN, 'both') === null, 'NaN target');
});

// weld fixtures: A = 10x10 square at origin (CW in y-down), B = 10x10 square
// far away; welding A's right edge (seg 1) to B's left edge (seg 3) should
// produce a 20x10 rectangle with B moved next to A.
const weldA = () => [N(0, 0), N(10, 0), N(10, 10), N(0, 10)];
const weldB = () => [N(30, 40), N(40, 40), N(40, 50), N(30, 50)];

t('weldClosedPaths joins two squares into a rectangle', () => {
  const res = Geo.weldClosedPaths(weldA(), 1, weldB(), 3, 0.3);
  assert(!res.error, res.error);
  assert(res.nodes.length === 6, 'nodes=' + res.nodes.length);
  const poly = Geo.pathPolyline(res.nodes, true, 0.01);
  assert(Math.abs(Math.abs(Geo.polyArea(poly)) - 200) < 0.01, 'area=' + Geo.polyArea(poly));
  assert(Math.abs(Geo.pathLength(res.nodes, true) - 60) < 0.01, 'perim=' + Geo.pathLength(res.nodes, true));
  const bb = Geo.bbox(poly);
  assert(bb.minX === 0 && Math.abs(bb.maxX - 20) < 1e-9 && bb.minY === 0 && Math.abs(bb.maxY - 10) < 1e-9,
    'A stayed put, B moved beside it: ' + JSON.stringify(bb));
  assert(!res.flipT);
});

t('weldClosedPaths reconciles opposite windings', () => {
  const res = Geo.weldClosedPaths(weldA(), 1, Geo.reverseNodes(weldB()), 3, 0.3);
  assert(!res.error, res.error);
  assert(res.flipT, 'flipT set');
  const poly = Geo.pathPolyline(res.nodes, true, 0.01);
  assert(Math.abs(Math.abs(Geo.polyArea(poly)) - 200) < 0.01, 'area=' + Geo.polyArea(poly));
});

t('weldClosedPaths handles a rotated B', () => {
  const ang = 0.6, c = { x: 35, y: 45 };
  const rot = (p) => ({
    x: c.x + Math.cos(ang) * (p.x - c.x) - Math.sin(ang) * (p.y - c.y),
    y: c.y + Math.sin(ang) * (p.x - c.x) + Math.cos(ang) * (p.y - c.y),
    hin: null, hout: null,
  });
  const res = Geo.weldClosedPaths(weldA(), 1, weldB().map(rot), 3, 0.3);
  assert(!res.error, res.error);
  const poly = Geo.pathPolyline(res.nodes, true, 0.01);
  assert(Math.abs(Math.abs(Geo.polyArea(poly)) - 200) < 0.01, 'area=' + Geo.polyArea(poly));
  assert(Math.abs(Geo.pathLength(res.nodes, true) - 60) < 0.01);
});

t('weldClosedPaths seg maps relocate notches correctly', () => {
  const res = Geo.weldClosedPaths(weldA(), 1, weldB(), 3, 0.3);
  assert(res.segMapA[1] === null && res.segMapB[3] === null, 'seam edges dropped');
  // A seg 0 = bottom edge (0,0)->(10,0); its midpoint must be preserved
  const sA = res.segMapA[0];
  const pA = Geo.segPoint(res.nodes[sA], res.nodes[(sA + 1) % 6], 0.5);
  assert(Geo.dist(pA, { x: 5, y: 0 }) < 1e-9, JSON.stringify(pA));
  // B seg 1 = right edge x=40, midpoint (40,45) -> must land at xform of it
  const sB = res.segMapB[1];
  const pB = Geo.segPoint(res.nodes[sB], res.nodes[(sB + 1) % 6], 0.5);
  const expected = res.xform({ x: 40, y: 45 });
  assert(Geo.dist(pB, expected) < 1e-9, JSON.stringify([pB, expected]));
  assert(Geo.dist(expected, { x: 20, y: 5 }) < 1e-9, 'B moved rigidly: ' + JSON.stringify(expected));
});

t('weldClosedPaths preserves curved edges rigidly', () => {
  const B = weldB();
  B[1].hout = { x: 3, y: 1 };  // curve B's right edge (seg 1)
  B[2].hin = { x: 2, y: -2 };
  const before = Geo.segLength(B[1], B[2], 0.002);
  const res = Geo.weldClosedPaths(weldA(), 1, B, 3, 0.3);
  assert(!res.error, res.error);
  const sB = res.segMapB[1];
  const after = Geo.segLength(res.nodes[sB], res.nodes[(sB + 1) % 6], 0.002);
  assert(Math.abs(before - after) < 1e-6, `len ${before} -> ${after}`);
});

t('weldClosedPaths rejects mismatched edge lengths', () => {
  const shortB = [N(30, 40), N(40, 40), N(40, 45), N(30, 45)]; // 5cm left edge
  const res = Geo.weldClosedPaths(weldA(), 1, shortB, 3, 0.3);
  assert(res.error === 'length-mismatch', res.error);
  assert(Math.abs(res.dA - 10) < 1e-9 && Math.abs(res.dB - 5) < 1e-9);
});

t('segArcParams: fractions equal t on a straight edge', () => {
  const ts = Geo.segArcParams(N(0, 0), N(10, 0), [0.1, 0.5, 0.9]);
  assert(Math.abs(ts[0] - 0.1) < 1e-3 && Math.abs(ts[1] - 0.5) < 1e-3 && Math.abs(ts[2] - 0.9) < 1e-3,
    JSON.stringify(ts));
});

t('segArcParams: even arc spacing on a curve', () => {
  // quarter circle radius 10 — points at even fractions must be evenly spaced along the arc
  const k = 5.523;
  const a = N(10, 0, null, { x: 0, y: k });
  const b = N(0, 10, { x: k, y: 0 }, null);
  const fr = [0.125, 0.375, 0.625, 0.875];
  const ts = Geo.segArcParams(a, b, fr);
  const pts = ts.map((t) => Geo.segPoint(a, b, t));
  const gaps = [];
  for (let i = 1; i < pts.length; i++) gaps.push(Geo.dist(pts[i - 1], pts[i]));
  const avg = gaps.reduce((x, y) => x + y) / gaps.length;
  for (const g of gaps) assert(Math.abs(g - avg) < 0.05, 'uneven arc gaps: ' + JSON.stringify(gaps));
});

t('slitLine: diagonal slit centered on the path', () => {
  const a = N(0, 0), b = N(10, 0);
  const ln = Geo.slitLine(a, b, { seg: 0, t: 0.5, len: 0.2, ang: 45 });
  const mid = Geo.lerp(ln.a, ln.b, 0.5);
  assert(Geo.dist(mid, { x: 5, y: 0 }) < 1e-9, 'centered: ' + JSON.stringify(mid));
  assert(Math.abs(Geo.dist(ln.a, ln.b) - 0.2) < 1e-9, 'length');
  const d = Geo.norm(Geo.sub(ln.b, ln.a));
  assert(Math.abs(Math.abs(d.x) - Math.SQRT1_2) < 1e-9 && Math.abs(Math.abs(d.y) - Math.SQRT1_2) < 1e-9,
    '45 degrees: ' + JSON.stringify(d));
});

t('matched stitch runs: same count, same arc fractions on unequal edges', () => {
  const count = 7;
  const fr = [];
  for (let i = 0; i < count; i++) fr.push((i + 0.5) / count);
  const A = [N(0, 0), N(21, 0)];                                   // 21cm straight
  const k = 5.523;
  const B = [N(10, 0, null, { x: 0, y: k }), N(0, 10, { x: k, y: 0 })]; // ~15.7cm arc
  const tsA = Geo.segArcParams(A[0], A[1], fr);
  const tsB = Geo.segArcParams(B[0], B[1], fr);
  assert(tsA.length === count && tsB.length === count);
  // hole i sits at the same arc fraction on both edges: exact check on the
  // straight edge; on the curve, verify fractions via cumulative gap sums
  for (let i = 0; i < count; i++) {
    const pA = Geo.segPoint(A[0], A[1], tsA[i]);
    assert(Math.abs(pA.x / 21 - fr[i]) < 1e-3, `A hole ${i} at ${pA.x}`);
  }
  const ptsB = tsB.map((t) => Geo.segPoint(B[0], B[1], t));
  const lenB = Geo.segLength(B[0], B[1], 0.002);
  let acc = 0;
  for (let i = 1; i < count; i++) {
    acc += Geo.dist(ptsB[i - 1], ptsB[i]); // chord ≈ arc at this density
    const fracGap = acc / lenB;
    const expected = fr[i] - fr[0];
    assert(Math.abs(fracGap - expected) < 0.02, `B cumulative fraction ${i}: ${fracGap} vs ${expected}`);
  }
});

t('reflectPoint / reflectNodes mirror across a line', () => {
  const a = { x: 10, y: 0 }, b = { x: 10, y: 10 }; // vertical x=10
  const r = Geo.reflectPoint({ x: 3, y: 4 }, a, b);
  assert(Math.abs(r.x - 17) < 1e-9 && Math.abs(r.y - 4) < 1e-9, JSON.stringify(r));
  const m = Geo.reflectNodes([N(2, 2, { x: 1, y: 3 }, null)], a, b)[0];
  assert(Math.abs(m.x - 18) < 1e-9 && Math.abs(m.y - 2) < 1e-9);
  assert(Math.abs(m.hin.x - -1) < 1e-9 && Math.abs(m.hin.y - 3) < 1e-9, 'handle mirrored: ' + JSON.stringify(m.hin));
  assert(m.hout === null);
});

console.log('dxf');

const doc = {
  name: 'test',
  pieces: [{
    id: 'p1', name: 'Front', visible: true,
    seamAllowance: 1, notchLength: 0.4,
    path: {
      closed: true,
      nodes: [N(0, 0), N(20, 0), N(20, 30), N(0, 30)],
    },
    notches: [{ seg: 1, t: 0.5 }],
    holes: [{ x: 10, y: 15, r: 0.15 }],
    grain: { x1: 10, y1: 5, x2: 10, y2: 25 },
  }],
};

t('exportDXF produces a structurally valid R12 file', () => {
  const out = DXF.exportDXF(doc);
  assert(out.startsWith('0\r\nSECTION'), 'starts with SECTION');
  assert(out.includes('AC1009'), 'R12 version tag');
  assert(out.trimEnd().endsWith('EOF'), 'ends with EOF');
  // balanced sections
  const sections = (out.match(/(^|\r\n)SECTION(\r\n|$)/g) || []).length;
  const endsecs = (out.match(/(^|\r\n)ENDSEC(\r\n|$)/g) || []).length;
  assert(sections === endsecs && sections === 3, `sections=${sections} endsecs=${endsecs}`);
  // polylines terminated
  const polys = (out.match(/(^|\r\n)POLYLINE(\r\n|$)/g) || []).length;
  const seqends = (out.match(/(^|\r\n)SEQEND(\r\n|$)/g) || []).length;
  assert(polys === seqends && polys === 2, `polylines=${polys} seqends=${seqends}`); // CUT + SEAM
  for (const layer of ['CUT', 'SEAM', 'MARK']) assert(out.includes(layer), layer + ' layer present');
  assert(out.includes('CIRCLE'), 'drill hole circle');
  assert(!/e[+-]\d/i.test(out.replace(/SEQEND|ENDSEC|VERTEX|SECTION|ENTITIES|TABLES|HEADER|LAYER|LTYPE|ENDTAB|TABLE|CONTINUOUS|Solid line|EOF|POLYLINE|CIRCLE|LINE|CUT|SEAM|MARK|AC1009|\$\w+/g, '')), 'no exponent-notation numbers');
});

t('exportDXF geometry lands in +x/+y quadrant, mm scale', () => {
  const out = DXF.exportDXF(doc);
  const lines = out.split('\r\n');
  const xs = [], ys = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === '10' && lines[i - 1] !== '$EXTMIN' && lines[i - 1] !== '$EXTMAX') xs.push(parseFloat(lines[i + 1]));
    if (lines[i] === '20' && lines[i - 1] !== '$EXTMIN' && lines[i - 1] !== '$EXTMAX') ys.push(parseFloat(lines[i + 1]));
  }
  assert(Math.min(...xs) >= -0.001, 'min x >= 0, got ' + Math.min(...xs));
  assert(Math.min(...ys) >= -0.001, 'min y >= 0, got ' + Math.min(...ys));
  // piece is 20cm wide + 2x1cm allowance = 220mm
  assert(Math.abs(Math.max(...xs) - 220) < 0.5, 'max x ≈ 220mm, got ' + Math.max(...xs));
  // piece is 30cm tall + 2x1cm allowance = 320mm
  assert(Math.abs(Math.max(...ys) - 320) < 0.5, 'max y ≈ 320mm, got ' + Math.max(...ys));
});

t('seam allowance of 0 exports single CUT outline', () => {
  const d2 = JSON.parse(JSON.stringify(doc));
  d2.pieces[0].seamAllowance = 0;
  const out = DXF.exportDXF(d2);
  const polys = (out.match(/(^|\r\n)POLYLINE(\r\n|$)/g) || []).length;
  assert(polys === 1, 'one polyline, got ' + polys);
  assert(!/(^|\r\n)8\r\nSEAM/.test(out), 'no SEAM layer entities');
});

t('notch slit sits on the cutting line and points inward', () => {
  const shapes = DXF.pieceShapes(doc.pieces[0]);
  const notch = shapes.lines.find((l) => l.layer === 'CUT');
  assert(notch, 'notch line exists');
  // notch on seg 1 (x=20 edge, midpoint y=15): cut line at x=21, slit to x=20.6
  assert(Math.abs(notch.a.x - 21) < 0.01, 'starts at cut line, x=' + notch.a.x);
  assert(Math.abs(notch.b.x - 20.6) < 0.01, 'ends inward, x=' + notch.b.x);
  assert(Math.abs(notch.a.y - 15) < 0.01 && Math.abs(notch.b.y - 15) < 0.01);
});

// folded piece: right half of a 20x10 rect, fold on the x=10 edge (seg 1... no,
// half is 10x10 with fold on its right edge) — unfolds to the full 20x10
const foldedPiece = () => ({
  id: 'pf', name: 'Half', visible: true, seamAllowance: 1, notchLength: 0.4,
  path: { closed: true, nodes: [N(0, 0), N(10, 0), N(10, 10), N(0, 10)] },
  notches: [{ seg: 0, t: 0.3 }],
  holes: [{ x: 5, y: 5, r: 0.15 }, { x: 10, y: 8, r: 0.15 }],
  grain: null, foldSeg: 1,
});

t('unfoldPiece mirrors the half into the full outline', () => {
  const u = DXF.unfoldPiece(foldedPiece());
  assert(u.path.nodes.length === 6, 'nodes=' + u.path.nodes.length);
  const poly = Geo.pathPolyline(u.path.nodes, true, 0.01);
  assert(Math.abs(Math.abs(Geo.polyArea(poly)) - 200) < 0.01, 'area=' + Geo.polyArea(poly));
  assert(Math.abs(Geo.pathLength(u.path.nodes, true) - 60) < 0.01);
  const bb = Geo.bbox(poly);
  assert(bb.minX === 0 && Math.abs(bb.maxX - 20) < 1e-9, JSON.stringify(bb));
});

t('unfoldPiece mirrors notches and holes, keeps axis holes single', () => {
  const u = DXF.unfoldPiece(foldedPiece());
  assert(u.notches.length === 2, 'notches=' + u.notches.length);
  const pts = u.notches.map((nt) =>
    Geo.segPoint(u.path.nodes[nt.seg], u.path.nodes[(nt.seg + 1) % 6], nt.t));
  pts.sort((p, q) => p.x - q.x);
  assert(Geo.dist(pts[0], { x: 3, y: 0 }) < 1e-9, JSON.stringify(pts[0]));
  assert(Geo.dist(pts[1], { x: 17, y: 0 }) < 1e-9, 'mirrored notch: ' + JSON.stringify(pts[1]));
  // hole at (5,5) doubles to (15,5); hole on the axis (10,8) stays single
  assert(u.holes.length === 3, 'holes=' + JSON.stringify(u.holes));
  assert(u.holes.some((h) => Geo.dist(h, { x: 15, y: 5 }) < 1e-9), 'mirrored hole');
});

t('folded piece exports at full size with fold on MARK layer', () => {
  const out = DXF.exportDXF({ pieces: [foldedPiece()] });
  const lines = out.split('\r\n');
  const xs = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === '10' && lines[i - 1] !== '$EXTMIN' && lines[i - 1] !== '$EXTMAX') xs.push(parseFloat(lines[i + 1]));
  }
  // 20cm piece + 2x1cm allowance = 220mm wide
  assert(Math.abs(Math.max(...xs) - 220) < 0.5, 'max x ≈ 220mm, got ' + Math.max(...xs));
  const shapes = DXF.pieceShapes(foldedPiece());
  const fold = shapes.lines.find((l) => l.layer === 'MARK');
  assert(fold && Math.abs(fold.a.x - 10) < 1e-9 && Math.abs(fold.b.x - 10) < 1e-9, 'fold marked at x=10');
});

t('stitch slits export as CUT lines and mirror across folds', () => {
  const piece = foldedPiece();
  piece.notches = [];
  piece.stitchSlits = [
    { seg: 0, t: 0.25, len: 0.15, ang: 45 },
    { seg: 0, t: 0.75, len: 0.15, ang: 45 },
  ];
  // direct export of the folded piece: slits double up via the mirror
  const shapes = DXF.pieceShapes(piece);
  const cutLines = shapes.lines.filter((l) => l.layer === 'CUT');
  assert(cutLines.length === 4, 'expected 4 slit lines, got ' + cutLines.length);
  const mids = cutLines.map((l) => Geo.lerp(l.a, l.b, 0.5)).sort((p, q) => p.x - q.x);
  // seg 0 runs (0,0)->(10,0); mirror across x=10 puts twins at 20-x
  const xs = mids.map((m) => Math.round(m.x * 100) / 100);
  assert(JSON.stringify(xs) === JSON.stringify([2.5, 7.5, 12.5, 17.5]), 'slit midpoints: ' + JSON.stringify(xs));
  for (const m of mids) assert(Math.abs(m.y) < 1e-9, 'slit centered on stitch line');
  // every slit really is diagonal (45°)
  for (const l of cutLines) {
    const d = Geo.norm(Geo.sub(l.b, l.a));
    assert(Math.abs(Math.abs(d.x) - Math.SQRT1_2) < 1e-6, 'diagonal: ' + JSON.stringify(d));
  }
});

t('open path exports without allowance', () => {
  const d3 = {
    pieces: [{
      id: 'p', name: 'style line', visible: true, seamAllowance: 1,
      path: { closed: false, nodes: [N(0, 0), N(5, 5)] },
      notches: [], holes: [], grain: null,
    }],
  };
  const out = DXF.exportDXF(d3);
  assert((out.match(/(^|\r\n)POLYLINE(\r\n|$)/g) || []).length === 1);
  assert(!/(^|\r\n)8\r\nSEAM/.test(out));
});

console.log('dxf import');

const mkDXF = (...vals) =>
  ['0', 'SECTION', '2', 'ENTITIES', ...vals.map(String), '0', 'ENDSEC', '0', 'EOF'].join('\r\n');

t('import: our own export round-trips (shape, hole, slit debris filtered)', () => {
  const d = {
    pieces: [{
      id: 'p1', name: 'Tri', visible: true, seamAllowance: 0, notchLength: 0.4,
      path: { closed: true, nodes: [N(0, 0), N(20, 0), N(0, 30)] },
      notches: [{ seg: 0, t: 0.5 }],
      holes: [{ x: 5, y: 10, r: 0.15 }],
      grain: null,
    }],
  };
  const raw = DXFImport.parse(DXF.exportDXF(d));
  assert(DXFImport.unitScale(raw.insunits) === 0.1, 'mm declared in header');
  const res = DXFImport.build(raw, 0.1);
  assert(res.pieces.length === 1, 'pieces: ' + res.pieces.length);
  const p = res.pieces[0];
  assert(p.closed && p.nodes.length === 3, `nodes=${p.nodes.length}`);
  // triangle orientation survives the y-flips: right angle at top-left in y-down
  const pts = p.nodes.map((n) => [Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100]);
  const has = (x, y) => pts.some(([px2, py]) => Math.abs(px2 - x) < 0.01 && Math.abs(py - y) < 0.01);
  assert(has(2, 2) && has(22, 2) && has(2, 32), 'triangle points: ' + JSON.stringify(pts));
  assert(p.holes.length === 1 && Math.abs(p.holes[0].x - 7) < 0.01 && Math.abs(p.holes[0].y - 12) < 0.01,
    'hole carried over: ' + JSON.stringify(p.holes));
  assert(res.warnings.some((w) => w.includes('tiny line')), 'notch slit filtered: ' + JSON.stringify(res.warnings));
});

t('import: four LINE entities join into one closed piece', () => {
  const raw = DXFImport.parse(mkDXF(
    0, 'LINE', 8, 0, 10, 0, 20, 0, 11, 10, 21, 0,
    0, 'LINE', 8, 0, 10, 10, 20, 0, 11, 10, 21, 10,
    0, 'LINE', 8, 0, 10, 10, 20, 10, 11, 0, 21, 10,
    0, 'LINE', 8, 0, 10, 0, 20, 10, 11, 0, 21, 0,
  ));
  const res = DXFImport.build(raw, 1);
  assert(res.pieces.length === 1 && res.pieces[0].closed, JSON.stringify(res.pieces.map((p) => p.closed)));
  assert(res.pieces[0].nodes.length === 4, 'nodes=' + res.pieces[0].nodes.length);
  assert(Math.abs(Geo.pathLength(res.pieces[0].nodes, true) - 40) < 0.01);
});

t('import: LWPOLYLINE bulge becomes a real curve, bulging outward', () => {
  // 10x10 square (CCW in y-up) whose right side is a semicircle bulging out
  const raw = DXFImport.parse(mkDXF(
    0, 'LWPOLYLINE', 8, 0, 90, 4, 70, 1,
    10, 0, 20, 0,
    10, 10, 20, 0, 42, 1,
    10, 10, 20, 10,
    10, 0, 20, 10,
  ));
  const res = DXFImport.build(raw, 1);
  assert(res.pieces.length === 1 && res.pieces[0].closed);
  const nodes = res.pieces[0].nodes;
  const len = Geo.pathLength(nodes, true);
  assert(Math.abs(len - (30 + Math.PI * 5)) < 0.05, 'perimeter=' + len); // 3 sides + semicircle
  const bb = Geo.bbox(Geo.pathPolyline(nodes, true, 0.01));
  assert(Math.abs((bb.maxX - bb.minX) - 15) < 0.02, 'bulges outward: width=' + (bb.maxX - bb.minX));
});

t('import: ARC entity closes with lines into a quarter pie', () => {
  const raw = DXFImport.parse(mkDXF(
    0, 'LINE', 8, 0, 10, 0, 20, 0, 11, 10, 21, 0,
    0, 'ARC', 8, 0, 10, 0, 20, 0, 40, 10, 50, 0, 51, 90,
    0, 'LINE', 8, 0, 10, 0, 20, 10, 11, 0, 21, 0,
  ));
  const res = DXFImport.build(raw, 1);
  assert(res.pieces.length === 1 && res.pieces[0].closed, 'joined+closed');
  const len = Geo.pathLength(res.pieces[0].nodes, true);
  assert(Math.abs(len - (20 + Math.PI * 5)) < 0.05, 'perimeter=' + len);
});

t('import: dense flattened polylines get simplified', () => {
  // square drawn with collinear midpoints -> back to 4 corners
  const vals = [0, 'LWPOLYLINE', 8, 0, 90, 8, 70, 1];
  const sq = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]];
  for (const [x, y] of sq) vals.push(10, x, 20, y);
  const res1 = DXFImport.build(DXFImport.parse(mkDXF(...vals)), 1);
  assert(res1.pieces[0].nodes.length === 4, 'collinear removed: ' + res1.pieces[0].nodes.length);
  // 72-gon "circle": node count drops, perimeter preserved
  const vals2 = [0, 'LWPOLYLINE', 8, 0, 90, 72, 70, 1];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * 2 * Math.PI;
    vals2.push(10, (10 * Math.cos(a)).toFixed(6), 20, (10 * Math.sin(a)).toFixed(6));
  }
  const res2 = DXFImport.build(DXFImport.parse(mkDXF(...vals2)), 1);
  const n = res2.pieces[0].nodes.length;
  const len = Geo.pathLength(res2.pieces[0].nodes, true);
  assert(n <= 45, '72 -> ' + n + ' nodes'); // ~40 is the honest count for 0.5mm fidelity at r=10
  assert(Math.abs(len - 62.5) < 0.5, 'perimeter kept: ' + len);
});

t('import: unit guessing (mm for big raw extents, cm otherwise)', () => {
  const big = DXFImport.parse(mkDXF(0, 'LINE', 8, 0, 10, 0, 20, 0, 11, 800, 21, 0));
  assert(DXFImport.guessUnits(big) === 'mm');
  const small = DXFImport.parse(mkDXF(0, 'LINE', 8, 0, 10, 0, 20, 0, 11, 60, 21, 0));
  assert(DXFImport.guessUnits(small) === 'cm');
  assert(DXFImport.unitScale(4) === 0.1 && DXFImport.unitScale(5) === 1 &&
    Math.abs(DXFImport.unitScale(1) - 2.54) < 1e-9 && DXFImport.unitScale(0) === null);
});

t('import: SPLINE and TEXT are skipped with a warning, circles become pieces/holes', () => {
  const raw = DXFImport.parse(mkDXF(
    0, 'LWPOLYLINE', 8, 0, 90, 4, 70, 1, 10, 0, 20, 0, 10, 20, 20, 0, 10, 20, 20, 20, 10, 0, 20, 20,
    0, 'CIRCLE', 8, 0, 10, 10, 20, 10, 40, 0.2,   // small -> hole in the square
    0, 'CIRCLE', 8, 0, 10, 60, 20, 60, 40, 5,     // big -> its own round piece
    0, 'SPLINE', 8, 0, 10, 1, 20, 1,
    0, 'TEXT', 8, 0, 10, 1, 20, 1, 1, 'label',
  ));
  const res = DXFImport.build(raw, 1);
  assert(res.pieces.length === 2, 'square + circle piece: ' + res.pieces.length);
  const sq = res.pieces.find((p) => p.nodes.length === 4);
  assert(sq && sq.holes.length === 1, 'small circle became a hole');
  const round = res.pieces.find((p) => p !== sq);
  assert(Math.abs(Geo.pathLength(round.nodes, true) - Math.PI * 10) < 0.05, 'round piece perimeter');
  assert(res.warnings.some((w) => w.includes('SPLINE')) && res.warnings.some((w) => w.includes('TEXT')),
    JSON.stringify(res.warnings));
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
