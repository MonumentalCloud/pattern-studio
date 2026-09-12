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
 *       MARK  (color 5, blue)   — grainlines and guide lines; hole circles are CUT
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./geometry.js'), require('./strokefont.js'));
  } else {
    root.DXF = factory(root.Geo, root.StrokeFont);
  }
})(typeof self !== 'undefined' ? self : this, function (Geo, StrokeFont) {
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

  // Only used for names the stroke font has no glyphs for (Hangul, CJK...).
  // The reader supplies the font, so this is a fallback, not the normal path.
  function text(w, layer, p, height, value) {
    w.pair(0, 'TEXT'); w.pair(8, layer);
    w.pair(10, NUM(p.x)); w.pair(20, NUM(p.y)); w.pair(30, '0.0');
    w.pair(40, NUM(height));
    w.pair(1, String(value).replace(/[\r\n]+/g, ' '));
    w.pair(72, 1); // horizontally centred
    w.pair(11, NUM(p.x)); w.pair(21, NUM(p.y)); w.pair(31, '0.0');
  }

  // Resolve a fold-line piece into its full (unfolded) outline: the half is
  // mirrored across the fold edge and welded to itself along it, so the fold
  // edge disappears inside the outline. Notches and holes are mirrored too
  // (holes sitting on the axis are not duplicated). Returns a new piece-like
  // object, or the piece unchanged if it has no valid fold.
  // mirrorStart: index in the result where the mirrored half's nodes begin.
  function unfoldPiece(piece) {
    const nodes = piece.path.nodes;
    const n = nodes.length;
    const f = piece.foldSeg;
    if (f == null || !piece.path.closed || f >= n || n < 3) return piece;
    const a = nodes[f], b = nodes[(f + 1) % n];
    const res = Geo.weldClosedPaths(nodes, f, Geo.reflectNodes(nodes, a, b), f, 0.01);
    if (res.error) return piece;
    const notches = [];
    for (const nt of piece.notches || []) {
      const s1 = res.segMapA[nt.seg];
      if (s1 != null) notches.push({ seg: s1, t: nt.t });
      const s2 = res.segMapB[nt.seg];
      if (s2 != null) notches.push({ seg: s2, t: res.flipT ? 1 - nt.t : nt.t });
    }
    const holes = [];
    for (const h of piece.holes || []) {
      holes.push({ x: h.x, y: h.y, r: h.r });
      const m = res.xform(Geo.reflectPoint(h, a, b));
      if (Geo.dist(h, m) > 0.05) holes.push({ x: m.x, y: m.y, r: h.r });
    }
    // reflecting the half mirrors each slit's diagonal. An edge-referenced
    // angle just negates (the reflection reverses handedness against the
    // tangent); a page-referenced one has to mirror about the fold axis itself.
    const axisDeg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    const mirrorAng = (sl) => {
      const v = sl.ang == null ? 45 : sl.ang;
      return sl.abs ? 2 * axisDeg - v : -v;
    };
    const cutouts = [], cutMap = [];
    for (const c of piece.cutouts || []) {
      const mapping = {original:cutouts.length, mirror:null};
      cutouts.push(c);
      const refl = Geo.reflectNodes(c.nodes, a, b);
      const cen = Geo.centroid(Geo.pathPolyline(c.nodes, true, 0.1));
      const mcen = Geo.centroid(Geo.pathPolyline(refl, true, 0.1));
      if (Geo.dist(cen, mcen) > 0.05) { mapping.mirror=cutouts.length; cutouts.push({nodes:refl}); }
      cutMap.push(mapping);
    }
    const stitchSlits = [], mirroredRuns = new Map();
    let nextRun = (piece.stitchSlits || []).reduce((m,s)=>Math.max(m,s.run || 0),0) + 1;
    function mirrorSlit(sl, changes) {
      const mirrored = Object.assign({}, sl, {ang:mirrorAng(sl)}, changes);
      // Once baked, the reflected half is independently editable. It must
      // neither merge into the original run nor inherit its external pair.
      delete mirrored.pair;
      delete mirrored.pairSide;
      delete mirrored.sourceSegments;
      if (sl.run != null) {
        const key = `${sl.pair || ''}:${sl.run}`;
        if (!mirroredRuns.has(key)) mirroredRuns.set(key,nextRun++);
        mirrored.run = mirroredRuns.get(key);
      }
      return mirrored;
    }
    for (const sl of piece.stitchSlits || []) {
      if (sl.cut != null) {
        const mapping = cutMap[sl.cut];
        if (!mapping) continue;
        stitchSlits.push(Object.assign({},sl,{cut:mapping.original}));
        if (mapping.mirror != null) stitchSlits.push(mirrorSlit(sl,{cut:mapping.mirror}));
        continue;
      }
      const s1 = res.segMapA[sl.seg];
      if (s1 != null) {
        const original = Object.assign({},sl,{seg:s1});
        if (sl.sourceSegments) original.sourceSegments=sl.sourceSegments.map(i=>res.segMapA[i]).filter(i=>i!=null);
        stitchSlits.push(original);
      }
      const s2 = res.segMapB[sl.seg];
      if (s2 != null) stitchSlits.push(mirrorSlit(sl,{
        seg:s2, t:res.flipT ? 1-sl.t : sl.t,
        toff:sl.toff ? -sl.toff : undefined,
      }));
    }
    const out = Object.assign({}, piece, {
      path: { closed: true, nodes: res.nodes },
      notches, holes, stitchSlits, cutouts, foldSeg: null, mirrorStart: n - 1,
    });
    return out;
  }

  // Collect exportable shapes for one piece, in document coords (cm, y-down).
  // Returns { polylines: [{layer, pts, closed}], lines: [{layer,a,b}], circles: [{layer,c,r}] }
  // opts.labels engraves the piece name; opts.labelHeight is its cap height (cm).
  function pieceShapes(piece, opts) {
    let foldLine = null;
    if (piece.foldSeg != null) {
      const fn = piece.path.nodes, f = piece.foldSeg;
      const unfolded = unfoldPiece(piece);
      if (unfolded !== piece) {
        foldLine = { a: { x: fn[f].x, y: fn[f].y }, b: { x: fn[(f + 1) % fn.length].x, y: fn[(f + 1) % fn.length].y } };
      }
      piece = unfolded;
    }
    const out = { polylines: [], lines: [], circles: [] };
    if (foldLine) out.lines.push({ layer: 'MARK', a: foldLine.a, b: foldLine.b });
    const nodes = piece.path.nodes;
    const closed = piece.path.closed;
    if (nodes.length < 2) return out;

    const seamPts = Geo.dedupe(Geo.pathPolyline(nodes, closed, FLATTEN_TOL_CM));

    // guide pieces (inset stitch lines): the line itself is a marking, never a
    // cut — but its stitching slits are real cuts
    if (piece.guide) {
      out.polylines.push({ layer: 'MARK', pts: seamPts, closed });
      const gS = closed ? Geo.outwardSign(seamPts) : 1;
      for (const sl of piece.stitchSlits || []) {
        if (sl.seg >= nodes.length) continue;
        const line = Geo.slitLine(nodes[sl.seg], nodes[(sl.seg + 1) % nodes.length], sl, gS);
        const pts = Geo.slitContour(line, sl.width);
        if (pts.length > 2) out.polylines.push({ layer: 'CUT', pts, closed: true });
        else out.lines.push({ layer: 'CUT', a: line.a, b: line.b });
      }
      for (const h of piece.holes || []) {
        out.circles.push({ layer: 'CUT', c: { x: h.x, y: h.y }, r: h.r || 0.15 });
      }
      return out;
    }

    // the drawn outline IS the cutting line — no seam allowance
    out.polylines.push({ layer: 'CUT', pts: seamPts, closed });

    // notches: real cuts from the outline into the piece (slit or V chip)
    const notchLen = piece.notchLength || 0.4; // cm
    if (closed && (piece.notches || []).length) {
      const s = Geo.outwardSign(seamPts);
      for (const nt of piece.notches) {
        if (nt.seg >= nodes.length) continue;
        for (const ln of Geo.notchLinesPath(nodes, closed, nt, s, notchLen, piece.notchStyle)) {
          out.lines.push({ layer: 'CUT', a: ln.a, b: ln.b });
        }
      }
    }

    // internal cutouts: real cut loops inside the outline (e.g. a hole formed
    // by welding two mirrored halves)
    for (const c of piece.cutouts || []) {
      if (!c.nodes || c.nodes.length < 3) continue;
      out.polylines.push({ layer: 'CUT', pts: Geo.dedupe(Geo.pathPolyline(c.nodes, true, FLATTEN_TOL_CM)), closed: true });
    }

    // stitching slits: diagonal cuts on (or inset from) the stitch line —
    // outline-anchored, or around an internal cutout (sign flips so a
    // positive inset lands in the material, away from the hole)
    const outS = closed ? Geo.outwardSign(seamPts) : 1;
    const cutSign = {};
    for (const sl of piece.stitchSlits || []) {
      let nds = nodes, oS = outS;
      if (sl.cut != null) {
        const c = (piece.cutouts || [])[sl.cut];
        if (!c || sl.seg >= c.nodes.length) continue;
        nds = c.nodes;
        if (cutSign[sl.cut] === undefined) {
          cutSign[sl.cut] = -Geo.outwardSign(Geo.pathPolyline(c.nodes, true, 0.1));
        }
        oS = cutSign[sl.cut];
      } else if (sl.seg >= nodes.length) continue;
      const line = Geo.slitLine(nds[sl.seg], nds[(sl.seg + 1) % nds.length], sl, oS);
      const pts = Geo.slitContour(line, sl.width);
        if (pts.length > 2) out.polylines.push({ layer: 'CUT', pts, closed: true });
        else out.lines.push({ layer: 'CUT', a: line.a, b: line.b });
    }

    for (const h of piece.holes || []) {
      out.circles.push({ layer: 'CUT', c: { x: h.x, y: h.y }, r: h.r || 0.15 });
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

    // engraved piece name, on MARK so it burns rather than cuts
    if (opts && opts.labels && piece.name && !piece.guide) {
      const label = labelShapes(piece, seamPts, closed, opts);
      if (label) {
        if (label.strokes) for (const s of label.strokes) out.polylines.push({ layer: 'MARK', pts: s, closed: false });
        if (label.text) (out.texts = out.texts || []).push(label.text);
      }
    }
    return out;
  }

  // Where and how big the name goes: centred on the piece, shrunk to fit
  // inside it, and never below a size that would engrave as mush.
  const LABEL_MIN_H = 0.25; // cm
  function labelShapes(piece, seamPts, closed, opts) {
    if (!closed || !seamPts || seamPts.length < 3) return null;
    const name = String(piece.name);
    const bb = Geo.bbox(seamPts);
    const c = Geo.labelBox(seamPts); // lands on material even on a concave piece
    let h = opts.labelHeight > 0 ? opts.labelHeight : 0.8;
    // fit inside the material actually available across the label line, not
    // the bounding box — a crescent's bbox is mostly air
    const boxW = (c.w > 0 ? c.w : bb.maxX - bb.minX) * 0.85, boxH = (bb.maxY - bb.minY) / 3;
    const w1 = StrokeFont.width(name, h);
    if (w1 > boxW && w1 > 0) h *= boxW / w1;
    if (h > boxH) h = boxH;
    if (h < LABEL_MIN_H) return null; // too small to read — better none than mush
    const origin = { x: c.x, y: c.y + h / 2 }; // baseline, so the text centres on c
    if (!StrokeFont.supports(name)) {
      // Hangul, CJK, accents: no glyphs to stroke. Fall back to a TEXT entity
      // so the name still reaches the file with the reader's own font, rather
      // than dropping characters and engraving a lie.
      return { text: { layer: 'MARK', value: name, height: h, x: origin.x, y: origin.y, align: 'center' } };
    }
    return { strokes: StrokeFont.strokes(name, origin, h, 'center') };
  }

  // doc: { pieces: [...] } in cm/y-down. Returns DXF file string (mm, y-up).
  function exportDXF(doc, opts) {
    // gather everything in cm first to compute the bbox
    const all = [];
    for (const piece of doc.pieces) {
      if (piece.visible === false) continue;
      all.push(pieceShapes(piece, opts));
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
      for (const t of s.texts || []) text(w, t.layer, tx({ x: t.x, y: t.y }), t.height * 10, t.value);
    }
    w.pair(0, 'ENDSEC');
    w.pair(0, 'EOF');
    return w.toString();
  }

  return { exportDXF, pieceShapes, unfoldPiece };
});
