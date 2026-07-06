/* Pattern Studio — DXF R12 (AC1009) exporter.
 * Pure functions, no DOM. Works in browser (window.DXF) and Node.
 *
 * Output conventions (chosen for laser-cutter software compatibility —
 * LightBurn, RDWorks, Inkscape, AutoCAD all read this dialect):
 *   - Units: millimetres. Document coords are cm/y-down; export converts
 *     to mm and flips y so the pattern reads upright in CAD (y-up).
 *   - Everything is translated so the drawing sits in the +x/+y quadrant.
 *   - Curves are flattened to POLYLINE entities at 0.1 mm tolerance
 *     (laser software prefers polylines over SPLINE entities).
 *   - Layers:
 *       CUT   (color 1, red)    — cutting line (seam allowance if > 0,
 *                                 otherwise the pattern outline) + notch slits
 *       SEAM  (color 3, green)  — stitch line, only when allowance > 0
 *       MARK  (color 5, blue)   — grainlines, drill-hole circles
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./geometry.js'));
  } else {
    root.DXF = factory(root.Geo);
  }
})(typeof self !== 'undefined' ? self : this, function (Geo) {
  'use strict';

  const FLATTEN_TOL_CM = 0.01; // 0.1 mm
  const NUM = (v) => {
    // DXF numbers: plain decimal, avoid exponent notation
    const s = v.toFixed(4);
    return s === '-0.0000' ? '0.0000' : s;
  };

  function Writer() {
    const chunks = [];
    return {
      pair(code, value) { chunks.push(String(code), String(value)); },
      toString() { return chunks.join('\r\n') + '\r\n'; },
    };
  }

  const LAYERS = [
    { name: 'CUT', color: 1 },
    { name: 'SEAM', color: 3 },
    { name: 'MARK', color: 5 },
  ];

  function writeHeader(w, ext) {
    w.pair(0, 'SECTION'); w.pair(2, 'HEADER');
    w.pair(9, '$ACADVER'); w.pair(1, 'AC1009');
    w.pair(9, '$INSUNITS'); w.pair(70, 4); // mm (ignored by R12 readers, helps modern ones)
    w.pair(9, '$EXTMIN'); w.pair(10, NUM(ext.minX)); w.pair(20, NUM(ext.minY)); w.pair(30, '0.0');
    w.pair(9, '$EXTMAX'); w.pair(10, NUM(ext.maxX)); w.pair(20, NUM(ext.maxY)); w.pair(30, '0.0');
    w.pair(0, 'ENDSEC');
  }

  function writeTables(w) {
    w.pair(0, 'SECTION'); w.pair(2, 'TABLES');
    // linetype table — CONTINUOUS is required by picky readers
    w.pair(0, 'TABLE'); w.pair(2, 'LTYPE'); w.pair(70, 1);
    w.pair(0, 'LTYPE'); w.pair(2, 'CONTINUOUS'); w.pair(70, 0);
    w.pair(3, 'Solid line'); w.pair(72, 65); w.pair(73, 0); w.pair(40, '0.0');
    w.pair(0, 'ENDTAB');
    // layer table
    w.pair(0, 'TABLE'); w.pair(2, 'LAYER'); w.pair(70, LAYERS.length);
    for (const l of LAYERS) {
      w.pair(0, 'LAYER'); w.pair(2, l.name); w.pair(70, 0);
      w.pair(62, l.color); w.pair(6, 'CONTINUOUS');
    }
    w.pair(0, 'ENDTAB');
    w.pair(0, 'ENDSEC');
  }

  function polyline(w, layer, pts, closed) {
    if (pts.length < 2) return;
    w.pair(0, 'POLYLINE'); w.pair(8, layer); w.pair(66, 1); w.pair(70, closed ? 1 : 0);
    for (const p of pts) {
      w.pair(0, 'VERTEX'); w.pair(8, layer);
      w.pair(10, NUM(p.x)); w.pair(20, NUM(p.y)); w.pair(30, '0.0');
    }
    w.pair(0, 'SEQEND');
  }

  function line(w, layer, a, b) {
    w.pair(0, 'LINE'); w.pair(8, layer);
    w.pair(10, NUM(a.x)); w.pair(20, NUM(a.y)); w.pair(30, '0.0');
    w.pair(11, NUM(b.x)); w.pair(21, NUM(b.y)); w.pair(31, '0.0');
  }

  function circle(w, layer, c, r) {
    w.pair(0, 'CIRCLE'); w.pair(8, layer);
    w.pair(10, NUM(c.x)); w.pair(20, NUM(c.y)); w.pair(30, '0.0');
    w.pair(40, NUM(r));
  }

  // Collect exportable shapes for one piece, in document coords (cm, y-down).
  // Returns { polylines: [{layer, pts, closed}], lines: [{layer,a,b}], circles: [{layer,c,r}] }
  function pieceShapes(piece) {
    const out = { polylines: [], lines: [], circles: [] };
    const nodes = piece.path.nodes;
    const closed = piece.path.closed;
    if (nodes.length < 2) return out;

    const seamPts = Geo.dedupe(Geo.pathPolyline(nodes, closed, FLATTEN_TOL_CM));
    const sa = closed ? (piece.seamAllowance || 0) : 0;

    if (sa > 0) {
      const cutPts = Geo.offsetClosed(seamPts, sa);
      out.polylines.push({ layer: 'CUT', pts: cutPts, closed: true });
      out.polylines.push({ layer: 'SEAM', pts: seamPts, closed: true });
    } else {
      out.polylines.push({ layer: 'CUT', pts: seamPts, closed });
    }

    // notches: slit from the cutting line inward, perpendicular to the edge
    const notchLen = piece.notchLength || 0.4; // cm
    if (closed && (piece.notches || []).length) {
      const s = Geo.outwardSign(seamPts);
      for (const nt of piece.notches) {
        const a = nodes[nt.seg % nodes.length];
        const b = nodes[(nt.seg + 1) % nodes.length];
        const p = Geo.segPoint(a, b, nt.t);
        const tan = Geo.segTangent(a, b, nt.t);
        const nrm = { x: s * tan.y, y: -s * tan.x }; // outward
        const start = Geo.add(p, Geo.scale(nrm, sa));          // on cutting line
        const end = Geo.add(p, Geo.scale(nrm, sa - notchLen)); // inward
        out.lines.push({ layer: 'CUT', a: start, b: end });
      }
    }

    for (const h of piece.holes || []) {
      out.circles.push({ layer: 'MARK', c: { x: h.x, y: h.y }, r: h.r || 0.15 });
    }

    if (piece.grain) {
      const g = piece.grain;
      const a = { x: g.x1, y: g.y1 }, b = { x: g.x2, y: g.y2 };
      out.lines.push({ layer: 'MARK', a, b });
      // arrowheads on both ends
      const d = Geo.norm(Geo.sub(b, a));
      if (d.x || d.y) {
        const wing = (p, dir) => {
          const back = Geo.scale(dir, -0.8);
          const side = { x: -dir.y, y: dir.x };
          out.lines.push({ layer: 'MARK', a: p, b: Geo.add(p, Geo.add(back, Geo.scale(side, 0.35))) });
          out.lines.push({ layer: 'MARK', a: p, b: Geo.add(p, Geo.add(back, Geo.scale(side, -0.35))) });
        };
        wing(b, d);
        wing(a, Geo.scale(d, -1));
      }
    }
    return out;
  }

  // doc: { pieces: [...] } in cm/y-down. Returns DXF file string (mm, y-up).
  function exportDXF(doc) {
    // gather everything in cm first to compute the bbox
    const all = [];
    for (const piece of doc.pieces) {
      if (piece.visible === false) continue;
      all.push(pieceShapes(piece));
    }
    const every = [];
    for (const s of all) {
      for (const pl of s.polylines) every.push(...pl.pts);
      for (const l of s.lines) every.push(l.a, l.b);
      for (const c of s.circles) {
        every.push({ x: c.c.x - c.r, y: c.c.y - c.r }, { x: c.c.x + c.r, y: c.c.y + c.r });
      }
    }
    const bb = Geo.bbox(every);
    const MARGIN = 0; // cm
    // cm y-down -> mm y-up, translated into +x/+y quadrant
    const tx = (p) => ({
      x: (p.x - bb.minX + MARGIN) * 10,
      y: (bb.maxY - p.y + MARGIN) * 10,
    });

    const w = Writer();
    const extW = (bb.maxX - bb.minX + 2 * MARGIN) * 10;
    const extH = (bb.maxY - bb.minY + 2 * MARGIN) * 10;
    writeHeader(w, { minX: 0, minY: 0, maxX: extW, maxY: extH });
    writeTables(w);

    w.pair(0, 'SECTION'); w.pair(2, 'ENTITIES');
    for (const s of all) {
      for (const pl of s.polylines) polyline(w, pl.layer, pl.pts.map(tx), pl.closed);
      for (const l of s.lines) line(w, l.layer, tx(l.a), tx(l.b));
      for (const c of s.circles) circle(w, c.layer, tx(c.c), c.r * 10);
    }
    w.pair(0, 'ENDSEC');
    w.pair(0, 'EOF');
    return w.toString();
  }

  return { exportDXF, pieceShapes };
});
