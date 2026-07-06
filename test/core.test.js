/* Sanity tests for geometry.js and dxf.js (node test/core.test.js) */
const assert = require('assert');
const Geo = require('../js/geometry.js');
const DXF = require('../js/dxf.js');

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

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
