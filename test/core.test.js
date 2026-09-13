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

t('segMidpoint: halfway along a straight edge', () => {
  const m = Geo.segMidpoint(N(0, 0), N(10, 0));
  assert(Geo.dist(m, { x: 5, y: 0 }) < 1e-9, 'straight midpoint: ' + JSON.stringify(m));
});

t('segMidpoint: arc length, not parameter 0.5, on a lopsided curve', () => {
  // handles pushed hard toward one end: t=0.5 drifts well off the real middle
  const a = { x: 0, y: 0, hin: null, hout: { x: 7, y: 0 } };
  const b = { x: 10, y: 8, hin: { x: 0, y: -1 }, hout: null };
  // reference: walk a fine flattening to exactly half its length
  const fp = Geo.segFlatten(a, b, 0.00005);
  let total = 0;
  for (let i = 1; i < fp.length; i++) total += Geo.dist(fp[i - 1], fp[i]);
  let half = total / 2, ref = null;
  for (let i = 1; i < fp.length; i++) {
    const d = Geo.dist(fp[i - 1], fp[i]);
    if (half <= d) { ref = Geo.lerp(fp[i - 1], fp[i], half / d); break; }
    half -= d;
  }
  const mid = Geo.segMidpoint(a, b);
  assert(Geo.dist(mid, ref) < 0.01,
    `midpoint should sit at half the arc: ${JSON.stringify(mid)} vs ${JSON.stringify(ref)}`);
  assert(Geo.dist(mid, Geo.segPoint(a, b, 0.5)) > 1,
    'and on this curve that is far from the parameter-0.5 point: ' +
    Geo.dist(mid, Geo.segPoint(a, b, 0.5)).toFixed(3));
});

t('pathMidpoints: one per edge, closed vs open', () => {
  const sq = [N(0, 0), N(10, 0), N(10, 10), N(0, 10)];
  assert(Geo.pathMidpoints(sq, true).length === 4, 'closed square has 4 edge middles');
  assert(Geo.pathMidpoints(sq, false).length === 3, 'open path has one fewer');
  const m = Geo.pathMidpoints(sq, true);
  assert(Geo.dist(m[0], { x: 5, y: 0 }) < 1e-9, 'first edge middle: ' + JSON.stringify(m[0]));
  assert(Geo.dist(m[3], { x: 0, y: 5 }) < 1e-9, 'closing edge middle: ' + JSON.stringify(m[3]));
  assert(Geo.pathMidpoints([N(0, 0)], false).length === 0, 'a lone point has no edges');
});

t('stroke font: known glyphs stroke, unknown ones are reported', () => {
  const SF = require('../js/strokefont.js');
  assert(SF.supports('FRONT PANEL 2 (MIRROR)'), 'ASCII names are strokeable');
  assert(SF.supports('front panel'), 'lowercase maps onto the capitals');
  assert(!SF.supports('앞판'), 'Hangul has no glyphs');
  assert(JSON.stringify(SF.unsupportedChars('Front 앞판')) === JSON.stringify(['앞', '판']),
    'and it names which characters: ' + JSON.stringify(SF.unsupportedChars('Front 앞판')));
  const st = SF.strokes('AB', { x: 0, y: 0 }, 1);
  assert(st.length === 4, 'A (2 strokes) + B (2 strokes) = 4, got ' + st.length);
  for (const stroke of st) for (const p of stroke) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'every point is real: ' + JSON.stringify(p));
    assert(p.y <= 1e-9, 'baseline at y=0 and glyphs go up (y-down doc coords): ' + p.y);
  }
  assert(SF.width('A', 2) > SF.width('A', 1), 'width scales with height');
});

t('polyCentroid ignores how finely edges were flattened', () => {
  // same square, but one edge subdivided into many points
  const plain = [N(0, 0), N(10, 0), N(10, 10), N(0, 10)];
  const dense = [{ x: 0, y: 0 }];
  for (let i = 1; i <= 40; i++) dense.push({ x: 10 * i / 40, y: 0 });
  dense.push({ x: 10, y: 10 }, { x: 0, y: 10 });
  const c1 = Geo.polyCentroid(plain), c2 = Geo.polyCentroid(dense);
  assert(Geo.dist(c1, { x: 5, y: 5 }) < 1e-9, 'square centroid: ' + JSON.stringify(c1));
  assert(Geo.dist(c2, { x: 5, y: 5 }) < 1e-9, 'unchanged by subdivision: ' + JSON.stringify(c2));
  // the point-average version is the one that drifts
  assert(Geo.dist(Geo.centroid(dense), { x: 5, y: 5 }) > 1,
    'point-average really does drift: ' + JSON.stringify(Geo.centroid(dense)));
});

t('labelBox lands on material even when the centroid does not', () => {
  // a U: its area centroid falls in the gap between the arms
  const u = [
    { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 7 }, { x: 7, y: 7 },
    { x: 7, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
  ];
  assert(!Geo.pointInPolygon(u, Geo.polyCentroid(u)), 'the U really is the awkward case');
  const box = Geo.labelBox(u);
  assert(Geo.pointInPolygon(u, { x: box.x, y: box.y }),
    'label anchor is inside the shape: ' + JSON.stringify(box));
  assert(box.w > 0, 'and reports the room available there: ' + box.w);
});

t('export labels: name engraves inside the piece on MARK', () => {
  const piece = {
    id: 'p', name: 'FRONT', visible: true, seamAllowance: 0, notchLength: 0.4,
    path: { closed: true, nodes: [N(0, 0), N(20, 0), N(20, 12), N(0, 12)] },
    notches: [], holes: [], grain: null, foldSeg: null, cutouts: [], stitchSlits: [],
  };
  const plain = DXF.pieceShapes(piece);
  const marked = DXF.pieceShapes(piece, { labels: true, labelHeight: 1 });
  const openMark = (s) => (s.polylines || []).filter((pl) => pl.layer === 'MARK' && !pl.closed);
  assert(openMark(plain).length === 0, 'off by default');
  assert(openMark(marked).length > 0, 'on when asked');
  // every stroke sits inside the outline
  const poly = Geo.pathPolyline(piece.path.nodes, true, 0.05);
  for (const pl of openMark(marked)) {
    for (const p of pl.pts) {
      assert(Geo.pointInPolygon(poly, p), 'stroke point outside the piece: ' + JSON.stringify(p));
    }
  }
  assert(!marked.texts, 'ASCII needs no TEXT fallback');
});

t('export labels: a piece too small to read is left unlabelled', () => {
  const tiny = {
    id: 'p', name: 'FRONT PANEL LEFT', visible: true, seamAllowance: 0, notchLength: 0.4,
    path: { closed: true, nodes: [N(0, 0), N(0.6, 0), N(0.6, 0.6), N(0, 0.6)] },
    notches: [], holes: [], grain: null, foldSeg: null, cutouts: [], stitchSlits: [],
  };
  const s = DXF.pieceShapes(tiny, { labels: true, labelHeight: 1 });
  const openMark = (s2) => (s2.polylines || []).filter((pl) => pl.layer === 'MARK' && !pl.closed);
  assert(openMark(s).length === 0 && !s.texts, 'nothing engraved rather than mush');
});

t('export labels: non-Latin names fall back to a DXF TEXT entity', () => {
  const piece = {
    id: 'p', name: '앞판', visible: true, seamAllowance: 0, notchLength: 0.4,
    path: { closed: true, nodes: [N(0, 0), N(20, 0), N(20, 12), N(0, 12)] },
    notches: [], holes: [], grain: null, foldSeg: null, cutouts: [], stitchSlits: [],
  };
  const s = DXF.pieceShapes(piece, { labels: true, labelHeight: 1 });
  assert(s.texts && s.texts.length === 1, 'falls back rather than dropping the name');
  assert(s.texts[0].value === '앞판' && s.texts[0].layer === 'MARK', JSON.stringify(s.texts[0]));
  const dxf = DXF.exportDXF({ version: 2, name: 't', pieces: [piece] }, { labels: true, labelHeight: 1 });
  assert(/\r\nTEXT\r\n/.test(dxf), 'and the entity reaches the file');
  assert(dxf.indexOf('앞판') > 0, 'with the name intact');
});

t('export labels: guide/stitch-line pieces are not labelled', () => {
  const guide = {
    id: 'g', name: 'Front stitch line', visible: true, guide: true,
    seamAllowance: 0, notchLength: 0.4,
    path: { closed: true, nodes: [N(0, 0), N(20, 0), N(20, 12), N(0, 12)] },
    notches: [], holes: [], grain: null, foldSeg: null, cutouts: [], stitchSlits: [],
  };
  const s = DXF.pieceShapes(guide, { labels: true, labelHeight: 1 });
  const open = (s.polylines || []).filter((pl) => pl.layer === 'MARK' && !pl.closed);
  assert(open.length === 0 && !s.texts, 'a guide line carries no engraved name');
});

t('asset cache keys match the build number', () => {
  // Every ?v= in index.html is the cache key browsers use for the JS/CSS. If
  // it lags the build, a returning browser keeps serving the old app and new
  // work simply never appears — which looks exactly like a change that was
  // never made.
  const fs = require('fs');
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const build = /id="logo" title="build (\d+)"/.exec(html);
  assert(build, 'index.html should carry a build number on #logo');
  const keys = [...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
  assert(keys.length >= 4, 'expected the css + js assets to be cache-busted, saw ' + keys.length);
  for (const k of keys) {
    assert(k === build[1],
      `asset pinned at ?v=${k} but this is build ${build[1]} — bump the cache keys`);
  }
});

t('slitLine abs: the angle is measured off the page, not the edge', () => {
  // same absolute angle on edges running four different ways => identical direction
  const dirs = [
    [N(0, 0), N(10, 0)],   // right
    [N(10, 0), N(0, 0)],   // left
    [N(0, 0), N(0, 10)],   // down
    [N(0, 10), N(0, 0)],   // up
  ].map(([a, b]) => {
    const ln = Geo.slitLine(a, b, { t: 0.5, len: 0.4, ang: 90, abs: true });
    return Geo.norm(Geo.sub(ln.b, ln.a));
  });
  for (const d of dirs) {
    assert(Math.abs(d.x) < 1e-9 && Math.abs(Math.abs(d.y) - 1) < 1e-9,
      'abs 90 is vertical whatever the edge does: ' + JSON.stringify(d));
  }
  // without abs the same angle follows the edge instead
  const rel = Geo.norm(Geo.sub(
    ...(() => { const l = Geo.slitLine(N(0, 0), N(10, 0), { t: 0.5, len: 0.4, ang: 90 }); return [l.b, l.a]; })()));
  assert(Math.abs(Math.abs(rel.y) - 1) < 1e-9, 'edge-relative 90 is square across a horizontal edge');
  const rel2 = (() => {
    const l = Geo.slitLine(N(0, 0), N(0, 10), { t: 0.5, len: 0.4, ang: 90 });
    return Geo.norm(Geo.sub(l.b, l.a));
  })();
  assert(Math.abs(Math.abs(rel2.x) - 1) < 1e-9, 'and square across a vertical edge means horizontal');
});

t('abs slits mirror about the fold axis, not by negation', () => {
  const piece = {
    id: 'p', name: 'x', visible: true, seamAllowance: 0, notchLength: 0.4,
    path: { closed: true, nodes: [N(0, 0), N(10, 0), N(10, 10), N(0, 10)] },
    notches: [], holes: [], grain: null, foldSeg: 1, cutouts: [],
    stitchSlits: [{ seg: 0, t: 0.5, len: 0.4, ang: 45, abs: true, off: 0.3 }],
  };
  const un = DXF.unfoldPiece(piece);
  const mirrored = un.stitchSlits.filter((s) => s.ang !== 45);
  assert(mirrored.length === 1, 'the mirrored half gets its own slit: ' + un.stitchSlits.length);
  // fold edge 1 runs (10,0)->(10,10): a vertical axis, so 45 mirrors to 135
  const m = ((mirrored[0].ang % 180) + 180) % 180;
  assert(Math.abs(m - 135) < 1e-6, 'abs 45 mirrors to 135 across a vertical fold: ' + mirrored[0].ang);
});

t('slitLine inset: positive moves inward, negative outward', () => {
  // top edge of a CW (y-down) square: outward normal points up (-y)
  const a = N(0, 0), b = N(10, 0);
  const inward = Geo.slitLine(a, b, { t: 0.5, len: 0.2, ang: 45, off: 0.3 }, 1);
  const mIn = Geo.lerp(inward.a, inward.b, 0.5);
  assert(Geo.dist(mIn, { x: 5, y: 0.3 }) < 1e-9, 'inward center: ' + JSON.stringify(mIn));
  const outward = Geo.slitLine(a, b, { t: 0.5, len: 0.2, ang: 45, off: -0.3 }, 1);
  const mOut = Geo.lerp(outward.a, outward.b, 0.5);
  assert(Geo.dist(mOut, { x: 5, y: -0.3 }) < 1e-9, 'outward center: ' + JSON.stringify(mOut));
  // winding flips the outward side; "inward" must follow
  const flipped = Geo.slitLine(a, b, { t: 0.5, len: 0.2, ang: 45, off: 0.3 }, -1);
  const mFl = Geo.lerp(flipped.a, flipped.b, 0.5);
  assert(Geo.dist(mFl, { x: 5, y: -0.3 }) < 1e-9, 'sign-aware: ' + JSON.stringify(mFl));
});

t('inset slits stay inside the piece through DXF export', () => {
  const piece = {
    id: 'p', name: 'x', visible: true, seamAllowance: 1, notchLength: 0.4,
    path: { closed: true, nodes: [N(0, 0), N(10, 0), N(10, 10), N(0, 10)] },
    notches: [], holes: [], grain: null, foldSeg: null,
    stitchSlits: [{ seg: 0, t: 0.5, len: 0.15, ang: 45, off: 0.4 }],
  };
  const shapes = DXF.pieceShapes(piece);
  const slit = shapes.lines.find((l) => l.layer === 'CUT');
  const mid = Geo.lerp(slit.a, slit.b, 0.5);
  // seg 0 is the top edge (y=0) of a piece extending down to y=10 — inset 0.4 puts it at y=0.4
  assert(Geo.dist(mid, { x: 5, y: 0.4 }) < 1e-9, 'slit inset into the piece: ' + JSON.stringify(mid));
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

t('pathArcParams places even holes across a whole multi-segment path', () => {
  // L-shaped open path: 10cm + 20cm = 30cm total
  const nodes = [N(0, 0), N(10, 0), N(10, 20)];
  const fr = [];
  const count = 6;
  for (let i = 0; i < count; i++) fr.push((i + 0.5) / count);
  const pos = Geo.pathArcParams(nodes, false, fr);
  const pts = pos.map((p) => Geo.segPoint(nodes[p.seg], nodes[(p.seg + 1) % 3], p.t));
  // holes every 5cm starting at 2.5: (2.5,0), (7.5,0), then down the second leg
  assert(Geo.dist(pts[0], { x: 2.5, y: 0 }) < 1e-6, JSON.stringify(pts[0]));
  assert(Geo.dist(pts[1], { x: 7.5, y: 0 }) < 1e-6, JSON.stringify(pts[1]));
  assert(Geo.dist(pts[2], { x: 10, y: 2.5 }) < 1e-6, 'crosses into seg 1: ' + JSON.stringify(pts[2]));
  assert(Geo.dist(pts[5], { x: 10, y: 17.5 }) < 1e-6, JSON.stringify(pts[5]));
});

t('simplifyPoly removes collinear points, keeps corners', () => {
  const pts = [];
  for (let x = 0; x <= 10; x++) pts.push({ x, y: 0 });
  for (let y = 1; y <= 10; y++) pts.push({ x: 10, y });
  const out = Geo.simplifyPoly(pts, 0.01, false);
  assert(out.length === 3, 'kept ' + out.length);
  assert(Geo.dist(out[1], { x: 10, y: 0 }) < 1e-9, 'corner kept');
});

t('pathIntersections: line through a square and through a curve', () => {
  const square = [N(0, 0), N(10, 0), N(10, 10), N(0, 10)];
  const knife = [N(-2, 4), N(12, 4)];
  const hits = Geo.pathIntersections(square, true, knife, false);
  assert(hits.length === 2, 'square hits: ' + hits.length);
  hits.sort((a, b) => a.point.x - b.point.x);
  assert(Geo.dist(hits[0].point, { x: 0, y: 4 }) < 0.01 && hits[0].segA === 3, JSON.stringify(hits[0]));
  assert(Geo.dist(hits[1].point, { x: 10, y: 4 }) < 0.01 && hits[1].segA === 1, JSON.stringify(hits[1]));
  assert(Math.abs(hits[1].tA - 0.4) < 0.01, 'param on right edge: ' + hits[1].tA);
  // quarter-circle arc crossed by a radial line
  const k = 5.523;
  const arc = [N(10, 0, null, { x: 0, y: k }), N(0, 10, { x: k, y: 0 }, null)];
  const hits2 = Geo.pathIntersections(arc, false, [N(0, 0), N(10, 10)], false);
  assert(hits2.length === 1, 'arc hits: ' + hits2.length);
  const d = Math.hypot(hits2[0].point.x, hits2[0].point.y);
  assert(Math.abs(d - 10) < 0.02, 'hit on the circle: r=' + d);
});

t('offsetOpen: inward offset with a mitered corner', () => {
  // right + bottom edges of a CW 10x10 square at (10,10)-(20,20)
  const pts = [{ x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
  const off = Geo.offsetOpen(pts, -0.5, 1); // inward
  assert(off.length === 3, 'miter keeps 3 points: ' + off.length);
  assert(Geo.dist(off[0], { x: 19.5, y: 10 }) < 1e-9, JSON.stringify(off[0]));
  assert(Geo.dist(off[1], { x: 19.5, y: 19.5 }) < 1e-9, 'mitered corner: ' + JSON.stringify(off[1]));
  assert(Geo.dist(off[2], { x: 10, y: 19.5 }) < 1e-9, JSON.stringify(off[2]));
});

t('guide pieces export as MARK line + CUT slits', () => {
  const guide = {
    id: 'g', name: 'stitch line', visible: true, guide: true,
    seamAllowance: 0, notchLength: 0.4,
    path: { closed: false, nodes: [N(0, 0), N(10, 0)] },
    notches: [], holes: [], grain: null, foldSeg: null,
    stitchSlits: [{ seg: 0, t: 0.5, len: 0.15, ang: 45 }],
  };
  const shapes = DXF.pieceShapes(guide);
  assert(shapes.polylines.length === 1 && shapes.polylines[0].layer === 'MARK',
    'guide line on MARK: ' + JSON.stringify(shapes.polylines.map((p) => p.layer)));
  const cut = shapes.lines.filter((l) => l.layer === 'CUT');
  assert(cut.length === 1, 'slit still cuts');
  const mid = Geo.lerp(cut[0].a, cut[0].b, 0.5);
  assert(Geo.dist(mid, { x: 5, y: 0 }) < 1e-9, 'slit on the guide line');
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
  assert(polys === seqends && polys === 1, `polylines=${polys} seqends=${seqends}`); // the outline IS the cut
  for (const layer of ['CUT', 'MARK']) assert(out.includes(layer), layer + ' layer present');
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
  // the outline IS the cut line: 20cm wide = 200mm
  assert(Math.abs(Math.max(...xs) - 200) < 0.5, 'max x ≈ 200mm, got ' + Math.max(...xs));
  // 30cm tall = 300mm
  assert(Math.abs(Math.max(...ys) - 300) < 0.5, 'max y ≈ 300mm, got ' + Math.max(...ys));
});

t('legacy seamAllowance values are ignored — the outline is always the cut', () => {
  const out = DXF.exportDXF(doc); // doc still carries seamAllowance: 1
  assert(!/(^|\r\n)8\r\nSEAM/.test(out), 'no SEAM layer entities');
});

t('notch slit cuts from the outline into the piece', () => {
  const shapes = DXF.pieceShapes(doc.pieces[0]);
  const notch = shapes.lines.find((l) => l.layer === 'CUT');
  assert(notch, 'notch line exists');
  // notch on seg 1 (x=20 edge, midpoint y=15): starts ON the edge, cuts inward
  assert(Math.abs(notch.a.x - 20) < 0.01, 'starts on the outline, x=' + notch.a.x);
  assert(Math.abs(notch.b.x - 19.6) < 0.01, 'ends inward, x=' + notch.b.x);
  assert(Math.abs(notch.a.y - 15) < 0.01 && Math.abs(notch.b.y - 15) < 0.01);
});

t('V-style notch cuts a small chip: two arms meeting at the apex', () => {
  const p2 = JSON.parse(JSON.stringify(doc.pieces[0]));
  p2.notchStyle = 'v';
  const shapes = DXF.pieceShapes(p2);
  const vls = shapes.lines.filter((l) => l.layer === 'CUT');
  assert(vls.length === 2, 'two V arms: ' + vls.length);
  for (const l of vls) assert(Math.abs(l.a.x - 20) < 0.01, 'V arm starts on the edge');
  assert(Math.abs(Math.abs(vls[0].a.y - vls[1].a.y) - 0.4) < 0.02, 'V mouth width');
  assert(Geo.dist(vls[0].b, vls[1].b) < 1e-9, 'arms share the apex');
  assert(Math.abs(vls[0].b.x - 19.6) < 0.01, 'apex 0.4cm inside');
});

t('notch ON a corner point: slit bisects the corner', () => {
  // 10x10 square (10,10)-(20,20), CW in y-down screen coords
  const N = (x, y) => ({ x, y, hin: null, hout: null });
  const nodes = [N(10, 10), N(20, 10), N(20, 20), N(10, 20)];
  const s = Geo.outwardSign(Geo.pathPolyline(nodes, true, 0.05));
  const [ln] = Geo.notchLinesPath(nodes, true, { seg: 1, t: 0 }, s, 0.4, 'slit');
  // anchored exactly on the corner (20,10), cutting inward along the bisector
  assert(Math.abs(ln.a.x - 20) < 1e-9 && Math.abs(ln.a.y - 10) < 1e-9, 'starts on the point');
  const d = 0.4 / Math.SQRT2;
  assert(Math.abs(ln.b.x - (20 - d)) < 0.01 && Math.abs(ln.b.y - (10 + d)) < 0.01,
    'apex on the 45-degree bisector: ' + JSON.stringify(ln.b));
});

t('V notch ON a corner: arms spread across BOTH adjacent edges', () => {
  const N = (x, y) => ({ x, y, hin: null, hout: null });
  const nodes = [N(10, 10), N(20, 10), N(20, 20), N(10, 20)];
  const s = Geo.outwardSign(Geo.pathPolyline(nodes, true, 0.05));
  const arms = Geo.notchLinesPath(nodes, true, { seg: 1, t: 0 }, s, 0.4, 'v');
  assert(arms.length === 2, 'two arms');
  // one mouth point 0.2 back along the top edge, the other 0.2 down the right edge
  const mouths = arms.map((l) => l.a).sort((a, b) => a.y - b.y);
  assert(Math.abs(mouths[0].x - 19.8) < 0.01 && Math.abs(mouths[0].y - 10) < 0.01,
    'arm on the top edge: ' + JSON.stringify(mouths[0]));
  assert(Math.abs(mouths[1].x - 20) < 0.01 && Math.abs(mouths[1].y - 10.2) < 0.01,
    'arm on the right edge: ' + JSON.stringify(mouths[1]));
  assert(Geo.dist(arms[0].b, arms[1].b) < 1e-9, 'arms share the apex');
});

t('notchLinesPath mid-edge matches the plain notchLines result', () => {
  const N = (x, y) => ({ x, y, hin: null, hout: null });
  const nodes = [N(10, 10), N(20, 10), N(20, 20), N(10, 20)];
  const s = Geo.outwardSign(Geo.pathPolyline(nodes, true, 0.05));
  const nt = { seg: 2, t: 0.5 };
  const a = Geo.notchLines(nodes[2], nodes[3], nt, s, 0.4, 'v');
  const b = Geo.notchLinesPath(nodes, true, nt, s, 0.4, 'v');
  for (let i = 0; i < 2; i++) {
    assert(Geo.dist(a[i].a, b[i].a) < 1e-9 && Geo.dist(a[i].b, b[i].b) < 1e-9, 'arm ' + i);
  }
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
  // 20cm unfolded piece = 200mm wide (no allowance)
  assert(Math.abs(Math.max(...xs) - 200) < 0.5, 'max x ≈ 200mm, got ' + Math.max(...xs));
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

t('import: CLO-style BLOCK/INSERT geometry is expanded', () => {
  // geometry inside BLOCKS, referenced from ENTITIES via INSERT — plus a
  // layer-7 grainline inside the piece and POINT markers, like CLO exports
  const text = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '1', '2', 'Front_M', '70', '64', '10', '0', '20', '0',
    '0', 'POLYLINE', '8', '14', '66', '1', '70', '1',
    '0', 'VERTEX', '8', '14', '10', '0', '20', '0',
    '0', 'VERTEX', '8', '14', '10', '200', '20', '0',
    '0', 'VERTEX', '8', '14', '10', '200', '20', '300',
    '0', 'VERTEX', '8', '14', '10', '0', '20', '300',
    '0', 'SEQEND',
    '0', 'LINE', '8', '7', '10', '100', '20', '50', '11', '100', '21', '250',   // grain inside
    '0', 'LINE', '8', '7', '10', '900', '20', '900', '11', '900', '21', '1100', // grain outside
    '0', 'POINT', '8', '2', '10', '0', '20', '0',
    '0', 'POINT', '8', '3', '10', '200', '20', '0',
    '0', 'TEXT', '8', '1', '10', '0', '20', '-10', '1', 'PIECE NAME: Front',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '1', '2', 'Front_M', '10', '0', '20', '0',
    '0', 'INSERT', '8', '1', '2', 'MissingBlock', '10', '0', '20', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');
  const raw = DXFImport.parse(text);
  assert(raw.blocks.Front_M, 'block captured');
  assert(DXFImport.guessUnits(raw) === 'mm', 'extent from block geometry: ' + DXFImport.rawExtent(raw));
  const res = DXFImport.build(raw, 0.1);
  assert(res.pieces.length === 1, 'pieces: ' + res.pieces.length);
  const p = res.pieces[0];
  assert(p.closed && p.name === 'Front_M', 'named from block: ' + p.name);
  const bb = Geo.bbox(Geo.pathPolyline(p.nodes, true, 0.1));
  assert(Math.abs((bb.maxX - bb.minX) - 20) < 0.01 && Math.abs((bb.maxY - bb.minY) - 30) < 0.01,
    'size 20x30cm: ' + JSON.stringify(bb));
  assert(p.grain && Math.abs(Math.hypot(p.grain.x2 - p.grain.x1, p.grain.y2 - p.grain.y1) - 20) < 0.01,
    'inside grainline attached: ' + JSON.stringify(p.grain));
  assert(res.warnings.some((w) => w.includes('grainline')), 'outside grainline dropped');
  assert(res.warnings.some((w) => w.includes('POINT')), 'points skipped');
  assert(res.warnings.some((w) => w.includes('INSERT')), 'unresolvable INSERT reported');
});

t('import: INSERT placement transform (offset, rotation, scale)', () => {
  const text = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '0', '2', 'sq', '70', '0', '10', '0', '20', '0',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '10', '10', '0', '20', '10',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'sq', '10', '100', '20', '0', '41', '2', '42', '2', '50', '90',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');
  const res = DXFImport.build(DXFImport.parse(text), 1);
  assert(res.pieces.length === 1 && res.pieces[0].closed);
  // 10-unit square scaled x2 -> 20cm sides, rotated 90° (still axis-aligned)
  assert(Math.abs(Geo.pathLength(res.pieces[0].nodes, true) - 80) < 0.01,
    'perimeter: ' + Geo.pathLength(res.pieces[0].nodes, true));
  const bb = Geo.bbox(Geo.pathPolyline(res.pieces[0].nodes, true, 0.1));
  assert(Math.abs((bb.maxX - bb.minX) - 20) < 0.01 && Math.abs((bb.maxY - bb.minY) - 20) < 0.01);
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

console.log('sew slits (weld seam cleanup)');

t('sewSlits: a welded double seam sews up, the enclosed loop becomes a cutout', () => {
  // two 10x10 halves joined at x=10 with a diamond bite across the seam; the
  // top seam segment was welded away, leaving the lower seam drawn twice
  // ((10,6)->(10,10) and back) and the diamond reachable only through the slit
  const nodes = [
    N(10, 4), N(8, 5), N(10, 6), N(10, 10), N(0, 10), N(0, 0),
    N(10, 0), N(20, 0), N(20, 10), N(10, 10), N(10, 6), N(12, 5),
  ];
  const res = Geo.sewSlits(nodes, 0.01);
  assert(res, 'coincident pair not found');
  assert(res.cutouts.length === 1, 'cutouts: ' + res.cutouts.length);
  assert(res.cutouts[0].length === 4, 'diamond nodes: ' + res.cutouts[0].length);
  const dArea = Math.abs(Geo.polyArea(Geo.pathPolyline(res.cutouts[0], true, 0.1)));
  assert(Math.abs(dArea - 4) < 0.01, 'diamond area: ' + dArea);
  assert(res.outline.length === 6, 'outline nodes: ' + res.outline.length);
  const oArea = Math.abs(Geo.polyArea(Geo.pathPolyline(res.outline, true, 0.1)));
  assert(Math.abs(oArea - 200) < 0.01, 'outline area: ' + oArea);
  // nothing of the slit remains on the outline
  assert(!res.outline.some((nd) => Math.abs(nd.x - 10) < 1e-9 && nd.y > 0.1 && nd.y < 9.9),
    'slit nodes left in outline: ' + JSON.stringify(res.outline));
  assert(res.segMap[3] && res.segMap[3].loop === -1, 'outline seg remap');
  assert(res.segMap[2] === null && res.segMap[9] === null, 'slit segs removed');
  assert(res.segMap[0] && res.segMap[0].loop === 0, 'diamond seg remap');
});

t('sewSlits: leaves ordinary outlines alone', () => {
  assert(Geo.sewSlits([N(0, 0), N(10, 0), N(10, 10), N(0, 10)], 0.01) === null, 'square must not sew');
});

t('sewSlits: curved slits (mirrored handles) sew too', () => {
  // square with a zero-width CURVED slit poking in from the top edge:
  // in at (5,0), curve to (4,3), back out along the exact same curve
  const nodes = [
    N(0, 0), N(5, 0, null, { x: 0, y: 1.5 }), N(4, 3, { x: 1, y: -1 }, { x: 1, y: -1 }),
    N(5, 0, { x: 0, y: 1.5 }, null), N(10, 0), N(10, 10), N(0, 10),
  ];
  const res = Geo.sewSlits(nodes, 0.01);
  assert(res, 'curved slit not found');
  assert(res.cutouts.length === 0, 'no loop enclosed: ' + res.cutouts.length);
  assert(res.outline.length === 5, 'outline nodes: ' + res.outline.length);
  const oArea = Math.abs(Geo.polyArea(Geo.pathPolyline(res.outline, true, 0.1)));
  assert(Math.abs(oArea - 100) < 0.05, 'outline area: ' + oArea);
});

t('pieceShapes: internal cutouts export as closed CUT polylines', () => {
  const piece = {
    id: 'x', name: 'joined', visible: true, seamAllowance: 0, notchLength: 0.4,
    path: { closed: true, nodes: [N(0, 0), N(20, 0), N(20, 10), N(0, 10)] },
    notches: [], holes: [], stitchSlits: [], grain: null, foldSeg: null,
    cutouts: [{ nodes: [N(10, 4), N(8, 5), N(10, 6), N(12, 5)] }],
  };
  const s = DXF.pieceShapes(piece);
  const cut = s.polylines.filter((p) => p.layer === 'CUT');
  assert(cut.length === 2, 'outline + cutout on CUT: ' + cut.length);
  assert(cut.every((p) => p.closed), 'both closed');
  const dxf = DXF.exportDXF({ pieces: [piece] });
  assert(dxf.includes('AC1009'), 'still R12');
});

console.log('offset loop clipping (narrow spikes)');

const selfCrossings = (pts, closed) => {
  let count = 0;
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const cross = (a, b, c, d) => {
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
  };
  for (let i = 0; i < segs; i++) {
    for (let j = i + 2; j < segs; j++) {
      if (closed && i === 0 && j === n - 1) continue;
      if (cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) count++;
    }
  }
  return count;
};

t('offsetClosed: insetting past a narrow spike clips the inverted loop', () => {
  // 20x10 body with a spike (4 wide at the base, 4 tall) — inset 1 makes the
  // spike's two side-offsets cross; the loop beyond the crossing must go
  const poly = [
    { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 10, y: -4 }, { x: 12, y: 0 },
    { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 },
  ];
  const inset = Geo.offsetClosed(poly, -1);
  assert(inset.length >= 3, 'degenerate inset');
  assert(selfCrossings(inset, true) === 0, 'self-intersections left: ' + selfCrossings(inset, true));
  // every inset point stays inside the original outline
  for (const p of inset) assert(Geo.pointInPolygon(poly, p), 'outside: ' + JSON.stringify(p));
  // the plain outward direction (seam allowance) is untouched for clean shapes
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const out = Geo.offsetClosed(sq, 1);
  assert(Math.abs(Geo.polyArea(out) - 144) < 0.01, 'clean outward offset changed: ' + Geo.polyArea(out));
});

t('offsetOpen: a run over a spike clips its crossing too', () => {
  const run = [
    { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 10, y: -4 }, { x: 12, y: 0 }, { x: 20, y: 0 },
  ];
  const off = Geo.offsetOpen(run, -1, 1); // 1cm to the inside of the piece
  assert(selfCrossings(off, false) === 0, 'open offset still crosses itself');
  // the clipped line keeps the full offset distance from the original path —
  // before clipping, the inverted loop dipped back to ~0 from the spike sides
  const dSeg = (P, A, B) => {
    const vx = B.x - A.x, vy = B.y - A.y;
    const t2 = Math.max(0, Math.min(1, ((P.x - A.x) * vx + (P.y - A.y) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(P.x - (A.x + vx * t2), P.y - (A.y + vy * t2));
  };
  for (const p of off) {
    let dm = Infinity;
    for (let i = 0; i < run.length - 1; i++) dm = Math.min(dm, dSeg(p, run[i], run[i + 1]));
    assert(dm > 0.99, `point ${JSON.stringify(p)} only ${dm.toFixed(3)} from the path`);
  }
});

t('physical slot contour has exact length/width and legacy zero width stays a line', () => {
  const line = Geo.slitLine(N(0,0), N(10,0), {t:0.5,len:0.2,ang:37}, -1);
  const pts = Geo.slitContour(line, 0.05);
  assert.equal(pts.length, 4);
  assert(Math.abs(Geo.dist(pts[0],pts[1])-0.2)<1e-10);
  assert(Math.abs(Geo.dist(pts[1],pts[2])-0.05)<1e-10);
  assert.deepEqual(Geo.slitContour(line), [line.a,line.b]);
  assert.throws(()=>Geo.slitContour(line, NaN));
  assert.throws(()=>Geo.slitContour(line, -0.1));
});

t('physical slots export closed CUT contours for outline, guide and cutout anchors', () => {
  const nodes = [N(0,0),N(10,0),N(10,10),N(0,10)];
  for (const variant of ['outline','guide','cutout']) {
    const p = {path:{nodes,closed:true},holes:[],stitchSlits:[{seg:0,t:0.5,len:0.2,width:0.05,off:0.3,ang:45}]};
    if (variant === 'guide') p.guide = true;
    if (variant === 'cutout') { p.cutouts=[{nodes:[N(2,2),N(4,2),N(4,4),N(2,4)]}]; p.stitchSlits[0].cut=0; }
    const shapes=DXF.pieceShapes(p);
    assert(shapes.polylines.some(pl=>pl.layer==='CUT' && pl.closed && pl.pts.length===4 && Math.abs(Geo.dist(pl.pts[0],pl.pts[1])-0.2)<1e-8));
    assert.equal(shapes.lines.filter(l=>l.layer==='CUT').length,0);
    p.stitchSlits[0].width=0;
    assert.equal(DXF.pieceShapes(p).lines.filter(l=>l.layer==='CUT').length,1);
  }
});

t('Hole circles are physical CUT geometry, including guide pieces', () => {
  for (const guide of [false,true]) {
    const p={guide,path:{nodes:[N(0,0),N(5,0),N(5,5),N(0,5)],closed:true},holes:[{x:2,y:2,r:0.2}]};
    assert.deepEqual(DXF.pieceShapes(p).circles,[{layer:'CUT',c:{x:2,y:2},r:0.2}]);
  }
});

t('wide slots must clear the full outer boundary, internal cutouts and circular holes', () => {
  const p={path:{nodes:[N(0,0),N(10,0),N(10,10),N(0,10)],closed:true},holes:[]};
  const slit={seg:0,t:0.5,len:0.2,width:0.05,off:0.3,ang:45};
  assert(Geo.slitFitsPiece(p,slit));
  assert(!Geo.slitFitsPiece(p,{...slit,off:0}));
  p.holes=[{x:5,y:0.3,r:0.2}];
  assert(!Geo.slitFitsPiece(p,slit));
  p.holes=[]; p.cutouts=[{nodes:[N(4.5,0.1),N(5.5,0.1),N(5.5,0.6),N(4.5,0.6)]}];
  assert(!Geo.slitFitsPiece(p,slit));
  assert(Geo.slitFitsPiece(p,{...slit,cut:0,seg:2,off:0.3}));
});

t('folded physical slots preserve width and export both halves', () => {
  const p={path:{nodes:[N(0,0),N(5,0),N(5,5),N(0,5)],closed:true},foldSeg:3,
    stitchSlits:[{seg:1,t:0.5,len:0.2,width:0.05,off:0.3,ang:45}],holes:[],notches:[]};
  const u=DXF.unfoldPiece(p);
  assert.equal(u.stitchSlits.length,2);
  assert(u.stitchSlits.every(s=>s.width===0.05));
  const slots=DXF.pieceShapes(p).polylines.filter(pl=>pl.closed && pl.pts.length===4 && Math.abs(Geo.dist(pl.pts[0],pl.pts[1])-0.2)<1e-8);
  assert.equal(slots.length,2);
});

t('unfold remaps every cutout stitch and gives mirrored runs separate identities', () => {
  const square=(x,y)=>[N(x,y),N(x+1,y),N(x+1,y+1),N(x,y+1)];
  const p={path:{nodes:[N(0,0),N(10,0),N(10,20),N(0,20)],closed:true},foldSeg:3,
    cutouts:[{nodes:square(2,2)},{nodes:square(5,10)}],holes:[],notches:[],
    stitchSlits:[{cut:1,seg:0,t:0.5,len:0.2,width:0.05,off:0.3,ang:45,run:1,pair:'test'}]};
  const u=DXF.unfoldPiece(p);
  assert.equal(u.cutouts.length,4);
  assert.equal(u.stitchSlits.length,2);
  assert.equal(u.stitchSlits[0].cut,2);
  assert.equal(u.stitchSlits[1].cut,3);
  assert.equal(u.stitchSlits[0].pair,'test');
  assert.equal(u.stitchSlits[1].pair,undefined);
  assert.notEqual(u.stitchSlits[0].run,u.stitchSlits[1].run);
  for (const sl of u.stitchSlits) {
    const c=u.cutouts[sl.cut].nodes;
    const line=Geo.slitLine(c[sl.seg],c[(sl.seg+1)%c.length],sl,-Geo.outwardSign(Geo.pathPolyline(c,true,0.01)));
    assert(Math.abs(Geo.lerp(line.a,line.b,0.5).y-9.7)<0.001);
  }
});

t('plural stitch nudges move only chosen holes, including an empty selection', () => {
  const source = require('fs').readFileSync(require.resolve('../js/app.js'), 'utf8');
  const start = source.indexOf('  function applyMove(');
  const end = source.indexOf('\n  // Fillet', start);
  const piece = {path:{nodes:[N(0,0),N(10,0)]},stitchSlits:[{seg:0,t:0.2},{seg:0,t:0.5},{seg:0,t:0.8}]};
  const sel = {kind:'slits',slits:[0,2]};
  const other = {path:piece.path,stitchSlits:[{seg:0,t:0.3}]};
  const context = {Geo,sel,multiSel:[],selPiece:()=>piece,selectedStitchHoles:()=>[{piece,indices:sel.slits},{piece:other,indices:sel.slits.length?[0]:[]}],slitContext:()=>({nodes:piece.path.nodes}),movePiece:()=>assert.fail('moved whole piece')};
  require('vm').runInNewContext(source.slice(start,end)+'; applyMove(0.1,0);',context);
  assert(Math.abs(piece.stitchSlits[0].t-0.21)<1e-8);
  assert.equal(piece.stitchSlits[1].t,0.5);
  assert(Math.abs(piece.stitchSlits[2].t-0.81)<1e-8);
  assert(Math.abs(other.stitchSlits[0].t-0.31)<1e-8);
  sel.slits=[];
  require('vm').runInNewContext('applyMove(0.1,0)',context);
});

t('matched re-spacing uses original A when B comes first and is selected', () => {
  const source = require('fs').readFileSync(require.resolve('../js/app.js'), 'utf8');
  const start = source.indexOf('  function rebuildStitchRuns(');
  const end = source.indexOf('\n  function cancelStitchChange', start);
  const b = {length:10,stitchSlits:[{pair:'p',pairSide:'B'}]};
  const a = {length:20,stitchSlits:[{pair:'p',pairSide:'A'}]};
  const groups = [b,a].map(piece=>({piece,indices:[0]}));
  const fields = {'sp-run-spacing':{value:'4'},'sp-run-inset':{value:'3'},'sp-slit-inset':{},'status-hint':{},'st-spacing':{},'st-off':{}};
  const context = {Geo,$:id=>fields[id],selectedStitchRuns:()=>groups,stitchEditSettings:()=>({len:0.2}),
    stitchRunTargets:piece=>piece,stitchChains:piece=>[{piece,path:[N(0,0),N(piece.length,0)],loop:false}],
    stitchFractions:n=>Array.from({length:n},(_,i)=>i/n),
    stitchPlaceRun:(chain,fractions,len,settings)=>chain.piece.stitchSlits.push(...fractions.map(()=>({...settings}))),
    selectStitchHoles:()=>{},rememberAppliedStitchSettings:()=>{},beginChange:()=>{},endChange:()=>{},selPiece:()=>b,sel:{},renderAll:()=>{},cancelStitchChange:message=>assert.fail(message)};
  require('vm').runInNewContext(source.slice(start,end)+'; rebuildStitchRuns();',context);
  assert.equal(a.stitchSlits.length,50); assert.equal(b.stitchSlits.length,50);
  assert(a.stitchSlits.every(s=>s.pairSide==='A')); assert(b.stitchSlits.every(s=>s.pairSide==='B'));
  const noticeStart=source.indexOf('  function matchedLengthNotice('), noticeEnd=source.indexOf('  function updateStitchUi(',noticeStart);
  require('vm').runInNewContext(source.slice(noticeStart,noticeEnd),context);
  assert.equal(context.matchedLengthNotice(20,20),'');
  assert(context.matchedLengthNotice(20,10).includes('Original side A determines hole count'));
});

t('unfold retains iron handedness for edge-relative outline and cutout slots', () => {
  const piece={path:{closed:true,nodes:[N(0,0),N(10,0),N(10,10),N(0,10)]},foldSeg:1,
    cutouts:[{nodes:[N(3,3),N(5,3),N(5,5),N(3,5)]}],stitchSlits:[
      {seg:0,t:0.5,ang:-45,len:0.15,width:0.05,off:0.3},
      {cut:0,seg:0,t:0.5,ang:-45,len:0.15,width:0.05,off:0.3}]};
  const unfolded=DXF.unfoldPiece(piece);
  assert.equal(unfolded.stitchSlits.length,4);
  assert(unfolded.stitchSlits.every(s=>s.ang===-45));
});

t('stitch preferences restore validated values and propagate applied edits', () => {
  const source=require('fs').readFileSync(require.resolve('../js/app.js'),'utf8');
  const start=source.indexOf('  const STITCH_SETTINGS_KEY'),end=source.indexOf('  // plain-language label',start);
  const fields={};
  for (const id of ['st-spacing','st-len','st-width','st-off','st-ang','st-ang-ref','sp-run-spacing','sp-run-inset']) {
    let value=id==='st-ang-ref'?'edge':'0.3';
    fields[id]={get value(){return value},set value(v){value=String(v)},checkValidity(){return id==='st-ang-ref'?['edge','page'].includes(value):value!==''&&Number.isFinite(Number(value))&&Math.abs(Number(value))<=180},addEventListener(){}};
  }
  let stored=null;
  const context={$:id=>fields[id],localStorage:{setItem:(key,v)=>{stored=v},getItem:()=>stored},refreshAngEg:()=>{}};
  require('vm').runInNewContext(source.slice(start,end),context);
  fields['st-spacing'].value='0.4'; fields['st-width'].value='0.8';fields['st-ang'].value='-45';
  context.saveStitchSettings(); fields['st-width'].value='0.5';context.restoreStitchSettings();
  assert.equal(fields['st-width'].value,'0.8');assert.equal(fields['sp-run-spacing'].value,'4');
  context.rememberAppliedStitchSettings({len:0.2,width:0.06,ang:-30,abs:false});
  assert.equal(fields['st-len'].value,'0.2');assert.equal(fields['st-width'].value,'0.6');
  assert.equal(JSON.parse(stored)['st-ang'],'-30');
  stored=JSON.stringify({'st-ang':'invalid','st-ang-ref':'bogus'});context.restoreStitchSettings();
  assert.equal(fields['st-ang'].value,'-30');assert.equal(fields['st-ang-ref'].value,'edge');
});

t('Stitch Edit box targets holes under the box instead of the previously selected shape', () => {
  const source=require('fs').readFileSync(require.resolve('../js/app.js'),'utf8');
  const start=source.indexOf("        if (drag.mode === 'stitch-edit') {"),end=source.indexOf("        if (drag.mode === 'stitch-add') {",start);
  const pieces=[{id:'a',stitchSlits:[{x:1,y:1}]},{id:'b',stitchSlits:[{x:11,y:1},{x:12,y:1}]}];
  const fields={'sp-slit-inset':{},'status-hint':{}};
  const context={doc:{pieces},Geo,x0:10,x1:13,y0:0,y1:2,drag:{mode:'stitch-edit',prevPieceId:'a'},sel:{pieceId:'a'},
    pieceById:id=>pieces.find(p=>p.id===id),slitLineFor:(p,s)=>({a:s,b:s}),selectPiece:id=>{context.sel={pieceId:id}},
    $:id=>fields[id],clearSel:()=>{context.sel={}},renderAll:()=>{}};
  const helpers=source.slice(source.indexOf('  function selectedStitchHoles()'),source.indexOf('  function selectedStitchRuns('));
  require('vm').runInNewContext(helpers,context);
  require('vm').runInNewContext('(function(){'+source.slice(start,end)+'})()',context);
  assert.equal(context.sel.pieceId,'b');assert.deepEqual(Array.from(context.sel.slits),[0,1]);
  context.x0=0;context.drag={mode:'stitch-edit'};
  pieces.push({id:'hidden',visible:false,stitchSlits:[{x:2,y:1}]});
  require('vm').runInNewContext('(function(){'+source.slice(start,end)+'})()',context);
  assert.equal(context.sel.slitGroups.length,2);
  assert.equal(context.selectedStitchHoles().reduce((n,g)=>n+g.indices.length,0),3);
  context.x0=10;context.drag={mode:'stitch-edit',shift:true};
  require('vm').runInNewContext('(function(){'+source.slice(start,end)+'})()',context);
  assert.equal(context.selectedStitchHoles().reduce((n,g)=>n+g.indices.length,0),3);
  require('vm').runInNewContext(source.slice(source.indexOf('  function selectionIds()'),source.indexOf('  function copySelection()')),context);
  assert.deepEqual(Array.from(context.selectionIds()),['a','b']);
  context.x0=30;context.x1=31;context.drag={mode:'stitch-edit'};
  require('vm').runInNewContext('(function(){'+source.slice(start,end)+'})()',context);
  assert.equal(context.selectedStitchHoles().length,0);

});

t('Cut copies and removes all shapes containing selected holes in one undo change', () => {
  const source=require('fs').readFileSync(require.resolve('../js/app.js'),'utf8');
  const a={id:'a',stitchSlits:[{}]},b={id:'b',stitchSlits:[{}]},c={id:'c',stitchSlits:[]};
  let copied,changes=0;
  const context={doc:{pieces:[a,b,c]},sel:{pieceId:'a',kind:'slits',slits:[0],slitGroups:[{pieceId:'a',indices:[0]},{pieceId:'b',indices:[0]}]},multiSel:[],
    CLIP_KEY:'test',pieceById:id=>context.doc.pieces.find(p=>p.id===id),selPiece:()=>context.doc.pieces.find(p=>p.id===context.sel.pieceId),
    clearSel:()=>{context.sel={kind:null};context.multiSel=[]},localStorage:{setItem:(k,v)=>{copied=JSON.parse(v)}},$:()=>({}),
    beginChange:()=>changes++,endChange:()=>{},renderAll:()=>{},ev:{ctrlKey:true,key:'x',preventDefault(){}}};
  const vm=require('vm');
  for (const [from,to] of [['  function selectedStitchHoles()','  function selectedStitchRuns('],['  function selectionIds()','  function pasteClipboard()'],['  function deleteSelection()','  // ---------- piece operations']]) {
    vm.runInNewContext(source.slice(source.indexOf(from),source.indexOf(to)),context);
  }
  const start=source.indexOf("    if ((ev.ctrlKey || ev.metaKey) && k === 'x')"),end=source.indexOf("    if ((ev.ctrlKey || ev.metaKey) && k === 'd')",start);
  vm.runInNewContext("(function(){const k='x';"+source.slice(start,end)+'})()',context);
  assert.deepEqual(copied.pieces.map(p=>p.id),['a','b']);
  assert.deepEqual(context.doc.pieces.map(p=>p.id),['c']);assert.equal(changes,1);
});

t('exact shape popup pauses drag, preserves anchor/direction and commits once', () => {
  const source=require('fs').readFileSync(require.resolve('../js/app.js'),'utf8');
  const start=source.indexOf('  function createDraggedShape('),end=source.indexOf("  svg.addEventListener('pointerup'",start);
  const fields={},handlers={};let changes=0,released=false;
  for (const id of ['sh-kind','shape-width','shape-height','shape-size-dialog','shape-size-form','shape-size-cancel','shape-rectangle-fields','shape-triangle-fields','shape-side-a','shape-side-b','shape-side-c','shape-size-title','shape-size-help','shape-size-error','shape-polygon-fields','shape-side-count','shape-side-length']) {
    fields[id]={value:id==='sh-kind'?'rect':'',focus(){},select(){},addEventListener:(name,fn)=>{handlers[id+':'+name]=fn}};
  }
  fields['shape-size-dialog'].showModal=()=>{fields['shape-size-dialog'].open=true};
  fields['shape-size-dialog'].close=()=>{fields['shape-size-dialog'].open=false;handlers['shape-size-dialog:close']()};
  const context={Geo,$:id=>fields[id],drag:{type:'shape',a:{x:20,y:30},b:{x:15,y:26},pointerId:1},doc:{pieces:[]},
    svg:{hasPointerCapture:()=>true,releasePointerCapture:()=>{released=true},focus(){}},gPreview:{},clear(){},
    beginChange:()=>changes++,endChange(){},newPiece:nodes=>({nodes}),selectPiece(){},renderAll(){}};
  const vm=require('vm');vm.runInNewContext(source.slice(start,end),context);
  context.openShapeSize();assert.equal(context.drag,null);assert(released);assert.equal(changes,0);
  fields['shape-width'].value='12.25';fields['shape-height'].value='8.5';handlers['shape-size-form:submit']({preventDefault(){}});
  assert.equal(changes,1);const nodes=context.doc.pieces[0].nodes;
  assert.equal(Math.min(...nodes.map(n=>n.x)),7.75);assert.equal(Math.max(...nodes.map(n=>n.x)),20);
  assert.equal(Math.min(...nodes.map(n=>n.y)),21.5);assert.equal(Math.max(...nodes.map(n=>n.y)),30);
  fields['sh-kind'].value='ellipse';context.drag={type:'shape',a:{x:2,y:2},b:{x:3,y:3},pointerId:2};context.openShapeSize();
  fields['shape-width'].value='0';handlers['shape-size-form:submit']({preventDefault(){}});assert.equal(changes,1);
  fields['shape-width'].value='0.3';fields['shape-height'].value='4';handlers['shape-size-form:submit']({preventDefault(){}});
  assert.equal(changes,2);assert(context.doc.pieces[1].nodes.every(n=>n.hin&&n.hout));
  context.drag={type:'shape',a:{x:0,y:0},b:{x:1,y:1},pointerId:3};context.openShapeSize();handlers['shape-size-cancel:click']();assert.equal(changes,2);
  context.drag={type:'shape',a:{x:2,y:2},b:{x:7,y:9},pointerId:4};context.ev={preventDefault(){}};
  const keyStart=source.indexOf("    if (k === 'alt' && drag"),keyEnd=source.indexOf('\n',keyStart);
  vm.runInNewContext("(function(){const k='alt';"+source.slice(keyStart,keyEnd)+'})()',context);
  assert(fields['shape-size-dialog'].open);assert.equal(context.drag,null);assert.equal(fields['shape-width'].value,5);assert.equal(changes,2);
  handlers['shape-size-cancel:click']();fields['sh-kind'].value='triangle';
  context.drag={type:'shape',a:{x:10,y:20},b:{x:10,y:20},pointerId:5};context.openShapeSize();
  fields['shape-side-a'].value=3;fields['shape-side-b'].value=1;fields['shape-side-c'].value=1;
  handlers['shape-size-form:submit']({preventDefault(){}});assert.equal(changes,2);assert(fields['shape-size-error'].textContent);
  fields['shape-side-a'].value=5;fields['shape-side-b'].value=4;fields['shape-side-c'].value=3;
  handlers['shape-size-form:submit']({preventDefault(){}});assert.equal(changes,3);
  assert.equal(context.doc.pieces[2].nodes.length,3);assert.equal(context.doc.pieces[2].nodes[0].x,10);


});

t('three side lengths construct unique triangle dimensions and reject impossible sides', () => {
  for (const sides of [[5,4,3],[4,8,5],[7.25,6.3,5.5]]) {
    const nodes=Geo.triangleFromSides(...sides);
    for(let i=0;i<3;i++) assert(Math.abs(Geo.dist(nodes[i],nodes[(i+1)%3])-sides[i])<1e-9);
    assert(Geo.polyArea(nodes)>0);
  }
  for(const sides of [[1,2,3],[1,2,4],[0,1,1],[-1,2,2],[NaN,2,2],[Infinity,2,2]]) assert.throws(()=>Geo.triangleFromSides(...sides));
});

t('regular polygons preserve requested count and every side length', () => {
  for(const n of [3,4,6,12,100]) {
    const nodes=Geo.regularPolygon(n,2.35);assert.equal(nodes.length,n);
    for(let i=0;i<n;i++) assert(Math.abs(Geo.dist(nodes[i],nodes[(i+1)%n])-2.35)<1e-9);
  }
  for(const [n,s] of [[2,3],[101,3],[3.5,3],[6,0],[6,NaN]]) assert.throws(()=>Geo.regularPolygon(n,s));
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
