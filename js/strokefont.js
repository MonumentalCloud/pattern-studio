/* Pattern Studio — single-stroke (engraving) font.
 * Pure functions, no DOM. Works in browser (window.StrokeFont) and Node.
 *
 * Why a stroke font and not DXF TEXT: laser software renders TEXT with
 * whatever font it happens to have — or ignores the entity entirely — so the
 * engraving is not the thing you designed. These glyphs are plain polylines,
 * the same primitive the outlines already export as, and a single-stroke
 * letter engraves in one pass instead of outlining every character twice.
 *
 * Glyph space: x right, y UP, baseline y = 0, cap height y = 1. Each glyph is
 * a list of strokes; each stroke is "x,y x,y ..." parsed once at load. Layout
 * converts to document coords (cm, y-down).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StrokeFont = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ADVANCE = 0.62;  // pen travel per character, in cap heights
  const SPACE = 0.45;    // width of a blank

  const RAW = {
    A: ['0,0 0.25,1 0.5,0', '0.1,0.4 0.4,0.4'],
    B: ['0,0 0,1 0.33,1 0.46,0.86 0.46,0.66 0.33,0.53 0,0.53', '0.33,0.53 0.48,0.38 0.48,0.15 0.33,0 0,0'],
    C: ['0.5,0.78 0.34,1 0.15,1 0,0.8 0,0.2 0.15,0 0.34,0 0.5,0.22'],
    D: ['0,0 0,1 0.3,1 0.5,0.76 0.5,0.24 0.3,0 0,0'],
    E: ['0.48,1 0,1 0,0 0.48,0', '0,0.5 0.38,0.5'],
    F: ['0.48,1 0,1 0,0', '0,0.5 0.38,0.5'],
    G: ['0.5,0.78 0.34,1 0.15,1 0,0.8 0,0.2 0.15,0 0.34,0 0.5,0.2 0.5,0.45 0.3,0.45'],
    H: ['0,0 0,1', '0.5,0 0.5,1', '0,0.5 0.5,0.5'],
    I: ['0.25,0 0.25,1', '0.08,1 0.42,1', '0.08,0 0.42,0'],
    J: ['0.44,1 0.44,0.22 0.3,0 0.13,0 0,0.2'],
    K: ['0,0 0,1', '0.5,1 0,0.45', '0.16,0.6 0.5,0'],
    L: ['0,1 0,0 0.45,0'],
    M: ['0,0 0,1 0.25,0.52 0.5,1 0.5,0'],
    N: ['0,0 0,1 0.5,0 0.5,1'],
    O: ['0.15,1 0.35,1 0.5,0.8 0.5,0.2 0.35,0 0.15,0 0,0.2 0,0.8 0.15,1'],
    P: ['0,0 0,1 0.34,1 0.5,0.85 0.5,0.68 0.34,0.53 0,0.53'],
    Q: ['0.15,1 0.35,1 0.5,0.8 0.5,0.2 0.35,0 0.15,0 0,0.2 0,0.8 0.15,1', '0.3,0.26 0.54,-0.04'],
    R: ['0,0 0,1 0.34,1 0.5,0.85 0.5,0.68 0.34,0.53 0,0.53', '0.26,0.53 0.5,0'],
    S: ['0.5,0.84 0.35,1 0.15,1 0,0.84 0,0.66 0.15,0.52 0.35,0.5 0.5,0.36 0.5,0.16 0.35,0 0.15,0 0,0.16'],
    T: ['0,1 0.5,1', '0.25,1 0.25,0'],
    U: ['0,1 0,0.2 0.15,0 0.35,0 0.5,0.2 0.5,1'],
    V: ['0,1 0.25,0 0.5,1'],
    W: ['0,1 0.13,0 0.25,0.6 0.37,0 0.5,1'],
    X: ['0,0 0.5,1', '0,1 0.5,0'],
    Y: ['0,1 0.25,0.5 0.5,1', '0.25,0.5 0.25,0'],
    Z: ['0,1 0.5,1 0,0 0.5,0'],
    0: ['0.15,1 0.35,1 0.5,0.8 0.5,0.2 0.35,0 0.15,0 0,0.2 0,0.8 0.15,1', '0.44,0.84 0.06,0.16'],
    1: ['0.08,0.8 0.25,1 0.25,0', '0.06,0 0.44,0'],
    2: ['0,0.8 0.15,1 0.35,1 0.5,0.8 0.5,0.64 0,0 0.5,0'],
    3: ['0,1 0.5,1 0.22,0.56 0.36,0.56 0.5,0.4 0.5,0.16 0.35,0 0.15,0 0,0.16'],
    4: ['0.37,0 0.37,1 0,0.3 0.5,0.3'],
    5: ['0.48,1 0.02,1 0,0.56 0.3,0.62 0.46,0.46 0.46,0.18 0.3,0 0.12,0 0,0.12'],
    6: ['0.46,0.88 0.3,1 0.14,1 0,0.8 0,0.2 0.15,0 0.35,0 0.5,0.18 0.5,0.36 0.35,0.53 0.15,0.53 0,0.36'],
    7: ['0,1 0.5,1 0.18,0'],
    8: ['0.15,0.54 0,0.68 0,0.86 0.15,1 0.35,1 0.5,0.86 0.5,0.68 0.35,0.54 0.15,0.54 0,0.4 0,0.14 0.15,0 0.35,0 0.5,0.14 0.5,0.4 0.35,0.54'],
    9: ['0.04,0.12 0.2,0 0.36,0 0.5,0.2 0.5,0.8 0.35,1 0.15,1 0,0.82 0,0.64 0.15,0.47 0.35,0.47 0.5,0.64'],
    '-': ['0.08,0.45 0.42,0.45'],
    '_': ['0,-0.12 0.5,-0.12'],
    '.': ['0.2,0 0.3,0 0.3,0.1 0.2,0.1 0.2,0'],
    ',': ['0.3,0.1 0.3,0 0.2,0 0.2,0.1 0.3,0.1', '0.28,0 0.18,-0.18'],
    ':': ['0.2,0.6 0.3,0.6 0.3,0.7 0.2,0.7 0.2,0.6', '0.2,0 0.3,0 0.3,0.1 0.2,0.1 0.2,0'],
    ';': ['0.2,0.6 0.3,0.6 0.3,0.7 0.2,0.7 0.2,0.6', '0.3,0.1 0.3,0 0.2,0 0.2,0.1 0.3,0.1', '0.28,0 0.18,-0.18'],
    "'": ['0.25,1 0.25,0.76'],
    '"': ['0.15,1 0.15,0.76', '0.35,1 0.35,0.76'],
    '(': ['0.36,1 0.16,0.74 0.16,0.26 0.36,0'],
    ')': ['0.14,1 0.34,0.74 0.34,0.26 0.14,0'],
    '[': ['0.36,1 0.16,1 0.16,0 0.36,0'],
    ']': ['0.14,1 0.34,1 0.34,0 0.14,0'],
    '/': ['0,0 0.5,1'],
    '\\': ['0,1 0.5,0'],
    '+': ['0.06,0.5 0.44,0.5', '0.25,0.31 0.25,0.69'],
    '=': ['0.06,0.62 0.44,0.62', '0.06,0.38 0.44,0.38'],
    '#': ['0.14,0 0.2,1', '0.32,0 0.38,1', '0.04,0.32 0.48,0.32', '0.04,0.68 0.48,0.68'],
    '!': ['0.25,1 0.25,0.28', '0.2,0 0.3,0 0.3,0.1 0.2,0.1 0.2,0'],
    '?': ['0,0.8 0.15,1 0.35,1 0.5,0.8 0.5,0.64 0.25,0.44 0.25,0.28', '0.2,0 0.3,0 0.3,0.1 0.2,0.1 0.2,0'],
    '*': ['0.25,0.35 0.25,0.85', '0.05,0.45 0.45,0.75', '0.45,0.45 0.05,0.75'],
    '&': ['0.5,0 0.12,0.62 0.12,0.82 0.26,1 0.4,0.86 0.4,0.7 0,0.28 0,0.14 0.14,0 0.3,0 0.5,0.24'],
    '%': ['0.02,0 0.48,1', '0.06,0.78 0.16,0.78 0.16,0.98 0.06,0.98 0.06,0.78', '0.34,0.02 0.44,0.02 0.44,0.22 0.34,0.22 0.34,0.02'],
    '@': ['0.38,0.34 0.28,0.28 0.18,0.34 0.16,0.5 0.24,0.6 0.34,0.58 0.38,0.46 0.38,0.28 0.46,0.24 0.5,0.4 0.46,0.8 0.28,1 0.1,0.94 0,0.72 0.02,0.32 0.16,0.06 0.36,0.02 0.5,0.1'],
  };

  // parse once: "x,y x,y" -> [{x,y}, ...]
  const GLYPHS = {};
  for (const ch in RAW) {
    GLYPHS[ch] = RAW[ch].map((s) => s.split(' ').map((pair) => {
      const [x, y] = pair.split(',');
      return { x: parseFloat(x), y: parseFloat(y) };
    }));
  }

  // Lowercase engraves as capitals — no lowercase glyphs, and substituting is
  // far better than dropping the letter.
  function glyphFor(ch) {
    if (GLYPHS[ch]) return GLYPHS[ch];
    const up = ch.toUpperCase();
    return GLYPHS[up] || null;
  }

  // Can every character be drawn? Anything outside the table (Hangul, CJK,
  // accents, emoji) cannot — the caller decides what to do about it.
  function supports(str) {
    for (const ch of String(str)) {
      if (ch === ' ' || ch === '\t') continue;
      if (!glyphFor(ch)) return false;
    }
    return true;
  }
  function unsupportedChars(str) {
    const bad = [];
    for (const ch of String(str)) {
      if (ch === ' ' || ch === '\t') continue;
      if (!glyphFor(ch) && bad.indexOf(ch) < 0) bad.push(ch);
    }
    return bad;
  }

  function width(str, height) {
    const h = height || 1;
    let w = 0;
    for (const ch of String(str)) w += (ch === ' ' || ch === '\t' ? SPACE : ADVANCE) * h;
    return w > 0 ? w - (ADVANCE - 0.5) * h : 0; // trim the trailing side bearing
  }

  // Strokes for a string as document polylines (cm, y-DOWN).
  // origin = { x, y } is the baseline start; align 'center' centres on x.
  // Unknown characters are skipped — check supports() first if that matters.
  function strokes(str, origin, height, align) {
    const h = height || 1;
    const o = origin || { x: 0, y: 0 };
    let x = o.x;
    if (align === 'center') x -= width(str, h) / 2;
    const out = [];
    for (const ch of String(str)) {
      if (ch === ' ' || ch === '\t') { x += SPACE * h; continue; }
      const g = glyphFor(ch);
      if (!g) continue;
      for (const stroke of g) {
        out.push(stroke.map((p) => ({ x: x + p.x * h, y: o.y - p.y * h })));
      }
      x += ADVANCE * h;
    }
    return out;
  }

  return { strokes, width, supports, unsupportedChars, ADVANCE, SPACE };
});
