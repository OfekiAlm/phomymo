/**
 * Create with AI - validation and normalization pipeline
 *
 *   raw model text -> parse -> version/migration -> structural checks -> semantic checks
 *   -> layout checks (bounds, scannability, overflow) -> normalized document (mm units)
 *
 * Model output is treated as untrusted input: only whitelisted fields are copied into
 * freshly created objects (no spreading/merging of model objects), every number must be
 * finite, every enum is checked, and text is stripped of control characters and markup.
 */

import { validateBarcodeData, validateQRData } from '../utils/validation.js?v=101';
import { AI_FONTS, AI_ENUMS, DEFAULT_AI_FONT, LABEL_DOCUMENT_VERSION } from './schema.js?v=1';

export const PT_TO_MM = 25.4 / 72;
// Editor coordinate space: 8 px per mm (203 DPI), see canvas.js PX_PER_MM.
export const EDITOR_PX_PER_MM = 8;

export const LIMITS = {
  MAX_ELEMENTS: 150,
  MAX_TEXT_LENGTH: 2000,
  MAX_TABLE_ROWS: 40,
  MAX_TABLE_COLUMNS: 8,
  MIN_FONT_PT: 6,
  MAX_FONT_PT: 70,       // ~200 editor px (TEXT.MAX_FONT_SIZE)
  MIN_BARCODE_TEXT_PT: 5,
  MAX_BARCODE_TEXT_PT: 20,
  MIN_STROKE_MM: 0.125,  // 1 printer dot
  MAX_STROKE_MM: 2.5,    // SHAPE.MAX_STROKE_WIDTH (20 px)
  MAX_CORNER_RADIUS_MM: 6.25, // SHAPE.MAX_CORNER_RADIUS (50 px)
  MIN_ELEMENT_MM: 1.25,  // ELEMENT.MIN_WIDTH / MIN_HEIGHT (10 px)
  MIN_QR_MM: 8,
  MIN_BARCODE_HEIGHT_MM: 5,
  QR_DOTS_PER_MODULE: 2,
  MAX_ID_LENGTH: 40,
};

// QR byte-mode capacity per version at error correction level M (qrcode library default).
const QR_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
  711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331];

const DANGEROUS_SCHEMES = /^\s*(javascript|vbscript|data|file|blob):/i;
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
const LTR_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
const STRONG_CHAR = new RegExp(`${RTL_CHAR.source}|${LTR_CHAR.source}`);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const has = (obj, key) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round2 = (v) => Math.round(v * 100) / 100;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function enumValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Strip control characters, bidi overrides and markup from model-provided text.
 * Keeps newlines, tabs, bidi marks/isolates and joiners (needed for RTL/Arabic shaping).
 * @param {*} value
 * @param {number} maxLength
 * @returns {{ text: string, changed: boolean }}
 */
export function sanitizeText(value, maxLength = LIMITS.MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return { text: '', changed: value !== undefined && value !== null };
  let text = value.replace(/\r\n?/g, '\n');
  const original = text;
  text = text
    // C0/C1 controls except \t and \n; DEL
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    // Bidi embeddings/overrides (LRE, RLE, PDF, LRO, RLO) - can visually spoof text
    .replace(/[\u202A-\u202E]/g, '')
    // HTML-like tags and simple markdown emphasis; text is rendered as plain text
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1');
  if (text.length > maxLength) text = text.slice(0, maxLength);
  return { text, changed: text !== original };
}

/**
 * Detect base direction from the first strong directional character.
 * @param {string} text
 * @returns {'ltr'|'rtl'|null}
 */
export function detectDirection(text) {
  const match = String(text || '').match(STRONG_CHAR);
  if (!match) return null;
  return RTL_CHAR.test(match[0]) ? 'rtl' : 'ltr';
}

function sanitizeId(value, fallback) {
  const cleaned = typeof value === 'string' ? value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, LIMITS.MAX_ID_LENGTH) : '';
  return cleaned || fallback;
}

function hasTemplateSyntax(value) {
  return /\{\{[^}]+\}\}|\[\[[^\]]+\]\]/.test(value);
}

function utf8Length(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * Estimate QR module count (without quiet zone) for data at EC level M.
 * @param {string} data
 * @returns {number|null} null if data exceeds capacity
 */
export function estimateQRModules(data) {
  const bytes = utf8Length(data);
  const version = QR_CAPACITY_M.findIndex(cap => cap >= bytes);
  return version === -1 ? null : 17 + 4 * (version + 1);
}

/**
 * Estimate the number of barcode modules (narrowest bar units) for scannability checks.
 * @param {string} data
 * @param {string} format
 * @returns {number}
 */
export function estimateBarcodeModules(data, format) {
  switch (format) {
    case 'EAN13':
    case 'UPC':
      return 95;
    case 'CODE39':
      return (data.length + 2) * 13;
    default: {
      const n = data.length;
      // Code 128 set C packs two digits per symbol
      const symbols = /^\d+$/.test(data) && n >= 4 ? Math.ceil(n / 2) : n;
      return symbols * 11 + 35; // start + check + stop
    }
  }
}

function computeCheckDigit(digits, weightOddFirst) {
  // weightOddFirst: weight for index 0 (EAN-13 = 1, UPC-A = 3)
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const w = i % 2 === 0 ? weightOddFirst : (weightOddFirst === 1 ? 3 : 1);
    sum += Number(digits[i]) * w;
  }
  return String((10 - (sum % 10)) % 10);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

class IssueCollector {
  constructor() { this.items = []; }
  error(message) { this.items.push({ severity: 'error', message }); }
  warn(message) { this.items.push({ severity: 'warning', message }); }
  info(message) { this.items.push({ severity: 'info', message }); }
}

/**
 * Parse raw model text into an object.
 * @param {string} text
 * @returns {{ ok: boolean, value?: Object, error?: string }}
 */
export function parseDocumentText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Empty response' };
  try {
    const value = JSON.parse(text);
    if (!isPlainObject(value)) return { ok: false, error: 'Top-level JSON value is not an object' };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e.message}` };
  }
}

/**
 * Migrate a raw document to the current schema version.
 * @param {Object} raw
 * @param {IssueCollector} issues
 * @returns {Object|null} raw document at current version, or null if unsupported
 */
export function migrateDocument(raw, issues) {
  const version = has(raw, 'schemaVersion') ? raw.schemaVersion : undefined;
  if (version === undefined) {
    issues.info('schemaVersion missing; assuming version 1');
    return raw;
  }
  if (version === LABEL_DOCUMENT_VERSION) return raw;
  issues.error(`Unsupported schemaVersion ${JSON.stringify(version)} (expected ${LABEL_DOCUMENT_VERSION})`);
  return null;
}

function resolveCanvas(raw, constraints, issues) {
  const target = constraints.canvas;
  const rawCanvas = has(raw, 'canvas') && isPlainObject(raw.canvas) ? raw.canvas : {};
  const modelW = finite(rawCanvas.widthMm);
  const modelH = finite(rawCanvas.heightMm);
  const modelRound = rawCanvas.shape === 'round';
  const modelCanvas = modelW && modelH && modelW > 0 && modelH > 0 ? { widthMm: modelW, heightMm: modelH } : null;

  if (constraints.sizeMode !== 'flexible') {
    const canvas = { widthMm: target.widthMm, heightMm: target.heightMm, round: !!target.round };
    // If the model drew on a different canvas, scale its coordinates onto the real one.
    let scaleX = 1;
    let scaleY = 1;
    if (modelCanvas && (Math.abs(modelCanvas.widthMm - canvas.widthMm) > 0.5 || Math.abs(modelCanvas.heightMm - canvas.heightMm) > 0.5)) {
      scaleX = canvas.widthMm / modelCanvas.widthMm;
      scaleY = canvas.heightMm / modelCanvas.heightMm;
      issues.warn(`Layout was designed for ${round2(modelCanvas.widthMm)}×${round2(modelCanvas.heightMm)} mm and was scaled to the ${canvas.widthMm}×${canvas.heightMm} mm label`);
    }
    return { canvas, scaleX, scaleY };
  }

  const limits = constraints.limits;
  if (!modelCanvas) {
    issues.warn('AI did not provide a valid label size; using the current size');
    return { canvas: { widthMm: target.widthMm, heightMm: target.heightMm, round: !!target.round }, scaleX: 1, scaleY: 1 };
  }
  let widthMm = Math.round(clamp(modelCanvas.widthMm, limits.minWidthMm, limits.maxWidthMm));
  let heightMm = Math.round(clamp(modelCanvas.heightMm, limits.minHeightMm, limits.maxHeightMm));
  if (modelRound) heightMm = widthMm = Math.min(widthMm, Math.round(clamp(modelCanvas.heightMm, limits.minHeightMm, limits.maxHeightMm)));
  const scaleX = widthMm / modelCanvas.widthMm;
  const scaleY = heightMm / modelCanvas.heightMm;
  if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
    issues.warn(`Requested size ${round2(modelCanvas.widthMm)}×${round2(modelCanvas.heightMm)} mm is outside the supported range; using ${widthMm}×${heightMm} mm`);
  }
  if (constraints.orientation === 'portrait' && widthMm > heightMm) issues.warn('The AI chose a landscape layout although portrait was requested');
  if (constraints.orientation === 'landscape' && heightMm > widthMm) issues.warn('The AI chose a portrait layout although landscape was requested');
  return { canvas: { widthMm, heightMm, round: modelRound }, scaleX, scaleY };
}

function readBox(raw, scaleX, scaleY) {
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  const rotation = finite(raw.rotation) ?? 0;
  return {
    x: x * scaleX,
    y: y * scaleY,
    width: width * scaleX,
    height: height * scaleY,
    rotation: ((rotation % 360) + 360) % 360,
  };
}

function rotatedExtents(box) {
  const rad = (box.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return { w: box.width * cos + box.height * sin, h: box.width * sin + box.height * cos };
}

/**
 * Keep a box inside the canvas: shrink if larger than the canvas, then shift inside.
 * Mutates box; returns true if it was changed.
 */
function fitBoxInCanvas(box, canvas) {
  let changed = false;
  box.width = Math.max(box.width, LIMITS.MIN_ELEMENT_MM);
  box.height = Math.max(box.height, LIMITS.MIN_ELEMENT_MM);
  let ext = rotatedExtents(box);
  const scale = Math.min(1, canvas.widthMm / ext.w, canvas.heightMm / ext.h);
  if (scale < 0.999) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    box.width *= scale;
    box.height *= scale;
    box.x = cx - box.width / 2;
    box.y = cy - box.height / 2;
    ext = rotatedExtents(box);
    changed = true;
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const minCx = ext.w / 2;
  const maxCx = canvas.widthMm - ext.w / 2;
  const minCy = ext.h / 2;
  const maxCy = canvas.heightMm - ext.h / 2;
  const ncx = clamp(cx, minCx, Math.max(minCx, maxCx));
  const ncy = clamp(cy, minCy, Math.max(minCy, maxCy));
  if (Math.abs(ncx - cx) > 0.05 || Math.abs(ncy - cy) > 0.05) {
    box.x = ncx - box.width / 2;
    box.y = ncy - box.height / 2;
    changed = true;
  }
  return changed;
}

function outsideRoundLabel(box, canvas) {
  const r = Math.min(canvas.widthMm, canvas.heightMm) / 2;
  const cx = canvas.widthMm / 2;
  const cy = canvas.heightMm / 2;
  const ext = rotatedExtents(box);
  const bx = box.x + box.width / 2;
  const by = box.y + box.height / 2;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  // Allow a small tolerance: text boxes usually have empty corners.
  return corners.some(([sx, sy]) => Math.hypot(bx + sx * ext.w / 2 - cx, by + sy * ext.h / 2 - cy) > r * 1.08);
}

/**
 * Estimate wrapped text lines for overflow detection.
 * Mirrors CanvasRenderer.wrapText (split on newlines, then on spaces/tabs).
 */
function layoutLines(text, maxWidthPx, measure) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(/[ \t]+/)) {
      const test = current ? `${current} ${word}` : word;
      if (measure(test) > maxWidthPx && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

function makeMeasure(env, fontPx, family, bold, italic) {
  if (typeof env.measureTextWidth === 'function') {
    const css = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontPx}px ${family}`;
    return (str) => {
      const w = env.measureTextWidth(str, css);
      return Number.isFinite(w) ? w : str.length * fontPx * 0.6;
    };
  }
  // Conservative fallback: average glyph advance ~0.6em (0.65em bold)
  const factor = bold ? 0.65 : 0.6;
  return (str) => [...str].length * fontPx * factor;
}

/**
 * Returns true if the text does not fit its box at the given font size.
 */
function textOverflows({ text, widthMm, heightMm, fontPt, family, bold, italic, wrap }, env) {
  const fontPx = fontPt * PT_TO_MM * EDITOR_PX_PER_MM;
  const measure = makeMeasure(env, fontPx, family, bold, italic);
  const availableWidthPx = widthMm * EDITOR_PX_PER_MM - 8; // renderer uses 4px side padding
  const lines = wrap ? layoutLines(text, availableWidthPx, measure) : text.split('\n');
  const totalHeightPx = lines.length * fontPx * 1.2;
  const widest = Math.max(...lines.map(l => measure(l)));
  return totalHeightPx > heightMm * EDITOR_PX_PER_MM + 2 || widest > availableWidthPx + 2;
}

// ---------------------------------------------------------------------------
// Element normalizers. Each returns a normalized element or null (dropped).
// ---------------------------------------------------------------------------

function normalizeText(raw, base, ctx) {
  const { issues, env, docDirection, constraints } = ctx;
  const { text, changed } = sanitizeText(raw.text);
  if (changed) issues.info(`Text "${base.id}" was cleaned of unsupported characters or markup`);
  if (!text.trim()) {
    issues.warn(`Empty text element "${base.id}" was removed`);
    return null;
  }
  const fontKey = has(AI_FONTS, raw.fontFamily) ? raw.fontFamily : DEFAULT_AI_FONT;
  if (raw.fontFamily !== fontKey) issues.info(`Unsupported font "${String(raw.fontFamily).slice(0, 40)}" replaced with ${fontKey}`);

  let fontSizePt = finite(raw.fontSizePt) ?? 10;
  if (fontSizePt < LIMITS.MIN_FONT_PT || fontSizePt > LIMITS.MAX_FONT_PT) {
    const clamped = clamp(fontSizePt, LIMITS.MIN_FONT_PT, LIMITS.MAX_FONT_PT);
    issues.warn(`Font size ${round2(fontSizePt)} pt in "${base.id}" adjusted to ${clamped} pt`);
    fontSizePt = clamped;
  }

  let direction = enumValue(raw.direction, AI_ENUMS.direction, 'auto');
  if (direction === 'auto') {
    direction = detectDirection(text) || (constraints.direction === 'rtl' ? 'rtl' : null) || docDirection;
  }

  const el = {
    ...base,
    text,
    fontFamily: AI_FONTS[fontKey],
    fontSizePt,
    bold: bool(raw.bold),
    italic: bool(raw.italic),
    underline: bool(raw.underline),
    align: enumValue(raw.align, AI_ENUMS.align, 'start'),
    verticalAlign: enumValue(raw.verticalAlign, AI_ENUMS.verticalAlign, 'middle'),
    direction,
    color: enumValue(raw.color, AI_ENUMS.inkColor, 'black'),
    background: enumValue(raw.background, AI_ENUMS.textBackground, 'transparent'),
    wrap: bool(raw.wrap, true),
    autoFit: bool(raw.autoFit),
  };
  if (el.color === 'white' && el.background === 'white') el.color = 'black';
  return el;
}

function postCheckText(el, ctx) {
  if (el.autoFit) return;
  const overflow = textOverflows({
    text: el.text, widthMm: el.width, heightMm: el.height, fontPt: el.fontSizePt,
    family: el.fontFamily, bold: el.bold, italic: el.italic, wrap: el.wrap,
  }, ctx.env);
  if (overflow) {
    el.autoFit = true;
    ctx.issues.warn(`Text "${el.id}" did not fit its box and was set to auto-fit`);
  }
}

function normalizeQR(raw, base, ctx) {
  const { text: data } = sanitizeText(raw.data, 2953);
  const check = validateQRData(data);
  if (!check.valid) {
    ctx.issues.error(`QR code "${base.id}" removed: ${check.error}`);
    return null;
  }
  if (DANGEROUS_SCHEMES.test(check.sanitized)) {
    ctx.issues.error(`QR code "${base.id}" removed: unsafe content scheme`);
    return null;
  }
  const size = Math.min(base.width, base.height);
  const cx = base.x + base.width / 2;
  const cy = base.y + base.height / 2;
  return { ...base, x: cx - size / 2, y: cy - size / 2, width: size, height: size, data: check.sanitized };
}

function postCheckQR(el, ctx) {
  const modules = estimateQRModules(el.data);
  if (modules === null) {
    ctx.issues.warn(`QR code "${el.id}" contains too much data and may not render`);
    return;
  }
  const minMm = Math.max(LIMITS.MIN_QR_MM, ((modules + 2) * LIMITS.QR_DOTS_PER_MODULE) / EDITOR_PX_PER_MM);
  if (el.width >= minMm) return;
  const maxSize = Math.min(ctx.canvas.widthMm, ctx.canvas.heightMm);
  const size = Math.min(minMm, maxSize);
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  el.width = el.height = size;
  el.x = cx - size / 2;
  el.y = cy - size / 2;
  fitBoxInCanvas(el, ctx.canvas);
  if (size < minMm) ctx.issues.warn(`QR code "${el.id}" is smaller than recommended (${round2(minMm)} mm) and may be hard to scan`);
  else ctx.issues.warn(`QR code "${el.id}" enlarged to ${round2(size)} mm so it stays scannable`);
}

function normalizeBarcode(raw, base, ctx) {
  const { issues, env } = ctx;
  let format = enumValue(raw.format, AI_ENUMS.barcodeFormat, 'CODE128');
  let { text: data } = sanitizeText(raw.data, 80);
  data = data.replace(/\n/g, ' ').trim();
  if (!data) {
    issues.error(`Barcode "${base.id}" removed: no data`);
    return null;
  }

  const templated = hasTemplateSyntax(data);
  if (!templated) {
    if (format === 'EAN13' || format === 'UPC') {
      const len = format === 'EAN13' ? 13 : 12;
      const weight = format === 'EAN13' ? 1 : 3;
      const digits = data.replace(/[\s-]/g, '');
      if (/^\d+$/.test(digits) && (digits.length === len - 1 || digits.length === len)) {
        const body = digits.slice(0, len - 1);
        const fixed = body + computeCheckDigit(body, weight);
        if (fixed !== digits) issues.warn(`Barcode "${base.id}" check digit corrected`);
        data = fixed;
      } else {
        issues.warn(`Barcode "${base.id}" data is not a valid ${format}; using Code 128`);
        format = 'CODE128';
      }
    }
    if (format === 'CODE39') data = data.toUpperCase();
    let check = validateBarcodeData(data, format);
    if (!check.valid && format !== 'CODE128') {
      issues.warn(`Barcode "${base.id}": ${check.error}; using Code 128`);
      format = 'CODE128';
      check = validateBarcodeData(data, format);
    }
    if (!check.valid) {
      issues.error(`Barcode "${base.id}" removed: ${check.error}`);
      return null;
    }
    data = check.sanitized;
    if (typeof env.barcodeProbe === 'function' && !env.barcodeProbe(data, format)) {
      if (format !== 'CODE128' && env.barcodeProbe(data, 'CODE128')) {
        issues.warn(`Barcode "${base.id}" could not be encoded as ${format}; using Code 128`);
        format = 'CODE128';
      } else {
        issues.error(`Barcode "${base.id}" removed: data cannot be encoded`);
        return null;
      }
    }
  }

  const showText = bool(raw.showText, true);
  const textSizePt = clamp(finite(raw.textSizePt) ?? 8, LIMITS.MIN_BARCODE_TEXT_PT, LIMITS.MAX_BARCODE_TEXT_PT);
  return { ...base, data, format, showText, textSizePt };
}

function postCheckBarcode(el, ctx) {
  const { canvas, issues } = ctx;
  if (el.rotation % 180 !== 0 && el.rotation % 90 !== 0) {
    issues.warn(`Barcode "${el.id}" is rotated at an angle and may not scan`);
  }
  if (el.height < LIMITS.MIN_BARCODE_HEIGHT_MM) {
    const cy = el.y + el.height / 2;
    el.height = Math.min(LIMITS.MIN_BARCODE_HEIGHT_MM, canvas.heightMm);
    el.y = cy - el.height / 2;
    issues.warn(`Barcode "${el.id}" height increased for scannability`);
  }
  if (hasTemplateSyntax(el.data)) {
    fitBoxInCanvas(el, canvas);
    return;
  }
  const modules = estimateBarcodeModules(el.data, el.format);
  const minMm = modules / EDITOR_PX_PER_MM;       // 1 dot per module: renderer minimum
  const preferredMm = (modules * 2) / EDITOR_PX_PER_MM;
  const available = el.rotation % 180 === 0 ? canvas.widthMm : canvas.heightMm;
  if (el.width < minMm) {
    const cx = el.x + el.width / 2;
    el.width = Math.min(Math.max(minMm, Math.min(preferredMm, available * 0.95)), available);
    el.x = cx - el.width / 2;
    fitBoxInCanvas(el, canvas);
    if (el.width < minMm) issues.warn(`Barcode "${el.id}" is too dense for the label width and may not scan; shorten the data or use a wider label`);
    else issues.warn(`Barcode "${el.id}" widened to ${round2(el.width)} mm so the bars print cleanly`);
  }
}

function normalizeShape(raw, base, ctx, type) {
  let fill = enumValue(raw.fill, AI_ENUMS.shapeFill, 'none');
  let stroke = enumValue(raw.stroke, AI_ENUMS.shapeStroke, 'black');
  if (fill === 'none' && stroke === 'none') {
    stroke = 'black';
    ctx.issues.info(`Shape "${base.id}" had no fill or outline; outline added`);
  }
  const strokeWidthMm = clamp(finite(raw.strokeWidthMm) ?? 0.25, LIMITS.MIN_STROKE_MM, LIMITS.MAX_STROKE_MM);
  const el = { ...base, shapeType: type, fill, stroke, strokeWidthMm };
  if (type === 'rectangle') {
    el.cornerRadiusMm = clamp(finite(raw.cornerRadiusMm) ?? 0, 0, LIMITS.MAX_CORNER_RADIUS_MM);
  }
  return el;
}

function normalizeLine(raw, id, group, ctx) {
  const { canvas, scaleX, scaleY, issues } = ctx;
  const pts = [raw.x1, raw.y1, raw.x2, raw.y2].map(finite);
  if (pts.some(p => p === null)) {
    issues.error(`Line "${id}" removed: invalid coordinates`);
    return null;
  }
  let [x1, y1, x2, y2] = [pts[0] * scaleX, pts[1] * scaleY, pts[2] * scaleX, pts[3] * scaleY];
  const clampX = (v) => clamp(v, 0, canvas.widthMm);
  const clampY = (v) => clamp(v, 0, canvas.heightMm);
  const clamped = [clampX(x1), clampY(y1), clampX(x2), clampY(y2)];
  if (clamped.some((v, i) => Math.abs(v - [x1, y1, x2, y2][i]) > 0.05)) {
    issues.warn(`Line "${id}" was trimmed to the label edges`);
  }
  [x1, y1, x2, y2] = clamped;
  if (Math.hypot(x2 - x1, y2 - y1) < LIMITS.MIN_ELEMENT_MM) {
    issues.warn(`Line "${id}" removed: too short`);
    return null;
  }
  return {
    id, type: 'line', group,
    x1, y1, x2, y2,
    thicknessMm: clamp(finite(raw.thicknessMm) ?? 0.3, LIMITS.MIN_STROKE_MM, LIMITS.MAX_STROKE_MM),
    color: enumValue(raw.color, AI_ENUMS.inkColor, 'black'),
  };
}

function normalizeTable(raw, base, ctx) {
  const { issues, docDirection } = ctx;
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  if (rawRows.length > LIMITS.MAX_TABLE_ROWS) issues.warn(`Table "${base.id}" truncated to ${LIMITS.MAX_TABLE_ROWS} rows`);
  const rows = [];
  for (const r of rawRows.slice(0, LIMITS.MAX_TABLE_ROWS)) {
    if (!isPlainObject(r) || !Array.isArray(r.cells)) continue;
    const cells = r.cells.slice(0, LIMITS.MAX_TABLE_COLUMNS).map(c => sanitizeText(typeof c === 'number' ? String(c) : c, 300).text);
    if (cells.length === 0) continue;
    rows.push({ cells, bold: bool(r.bold) });
  }
  if (rows.length === 0) {
    issues.error(`Table "${base.id}" removed: it has no rows`);
    return null;
  }
  const columns = Math.max(...rows.map(r => r.cells.length));
  rows.forEach(r => { while (r.cells.length < columns) r.cells.push(''); });

  let weights = Array.isArray(raw.columnWeights) ? raw.columnWeights.map(finite) : [];
  if (weights.length !== columns || weights.some(w => w === null || w <= 0)) weights = Array(columns).fill(1);

  const fontKey = has(AI_FONTS, raw.fontFamily) ? raw.fontFamily : DEFAULT_AI_FONT;
  let fontSizePt = clamp(finite(raw.fontSizePt) ?? 8, LIMITS.MIN_FONT_PT, LIMITS.MAX_FONT_PT);
  const rowHeightMm = base.height / rows.length;
  const maxFontForRow = rowHeightMm / (1.25 * PT_TO_MM);
  if (fontSizePt > maxFontForRow) {
    const reduced = Math.max(LIMITS.MIN_FONT_PT, Math.floor(maxFontForRow * 2) / 2);
    if (maxFontForRow < LIMITS.MIN_FONT_PT) issues.warn(`Table "${base.id}" rows are very tight; text was set to auto-fit`);
    else issues.warn(`Table "${base.id}" font reduced to ${reduced} pt to fit its rows`);
    fontSizePt = reduced;
  }

  let direction = enumValue(raw.direction, AI_ENUMS.direction, 'auto');
  if (direction === 'auto') direction = detectDirection(rows.flatMap(r => r.cells).join(' ')) || docDirection;

  return {
    ...base,
    rows,
    columnWeights: weights,
    fontFamily: AI_FONTS[fontKey],
    fontSizePt,
    tight: maxFontForRow < LIMITS.MIN_FONT_PT,
    borders: enumValue(raw.borders, AI_ENUMS.tableBorders, 'grid'),
    direction,
    lastColumnAlign: enumValue(raw.lastColumnAlign, AI_ENUMS.align, 'start'),
  };
}

function normalizeImage(raw, base, ctx) {
  const description = sanitizeText(raw.description, 60).text.replace(/\n/g, ' ').trim() || 'Image';
  ctx.issues.info(`Placeholder added for "${description}" - replace it with your own image`);
  return { ...base, description };
}

const BOX_TYPES = new Set(['text', 'qr', 'barcode', 'rectangle', 'ellipse', 'triangle', 'table', 'image']);

/**
 * Validate and normalize a model-produced label document.
 *
 * @param {Object|string} input - Parsed object or raw JSON text from the model
 * @param {Object} constraints - See prompt.js buildUserMessage
 * @param {Object} [env] - Optional browser helpers
 * @param {Function} [env.measureTextWidth] - (text, cssFont) => width in px
 * @param {Function} [env.barcodeProbe] - (data, format) => boolean
 * @returns {{ ok: boolean, document: Object|null, issues: Array<{severity: string, message: string}> }}
 */
export function validateLabelDocument(input, constraints, env = {}) {
  const issues = new IssueCollector();
  let raw = input;
  if (typeof input === 'string') {
    const parsed = parseDocumentText(input);
    if (!parsed.ok) {
      issues.error(parsed.error);
      return { ok: false, document: null, issues: issues.items };
    }
    raw = parsed.value;
  }
  if (!isPlainObject(raw)) {
    issues.error('Document is not an object');
    return { ok: false, document: null, issues: issues.items };
  }

  raw = migrateDocument(raw, issues);
  if (!raw) return { ok: false, document: null, issues: issues.items };

  if (!Array.isArray(raw.elements)) {
    issues.error('Document has no elements array');
    return { ok: false, document: null, issues: issues.items };
  }

  const { canvas, scaleX, scaleY } = resolveCanvas(raw, constraints, issues);
  const docDirection = enumValue(raw.direction, AI_ENUMS.documentDirection, constraints.direction === 'rtl' ? 'rtl' : 'ltr');
  const ctx = { issues, env, canvas, scaleX, scaleY, docDirection, constraints };

  if (raw.elements.length > LIMITS.MAX_ELEMENTS) {
    issues.warn(`Only the first ${LIMITS.MAX_ELEMENTS} elements were used`);
  }

  const usedIds = new Set();
  const elements = [];
  raw.elements.slice(0, LIMITS.MAX_ELEMENTS).forEach((rawEl, index) => {
    if (!isPlainObject(rawEl)) {
      issues.error(`Element #${index + 1} is not an object and was removed`);
      return;
    }
    let id = sanitizeId(rawEl.id, `element_${index + 1}`);
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    usedIds.add(id);
    const group = typeof rawEl.group === 'string' && rawEl.group.trim() ? sanitizeId(rawEl.group, null) : null;
    const type = typeof rawEl.type === 'string' ? rawEl.type : '';

    if (type === 'line') {
      const line = normalizeLine(rawEl, id, group, ctx);
      if (line) elements.push(line);
      return;
    }
    if (!BOX_TYPES.has(type)) {
      issues.error(`Unsupported element type "${type.slice(0, 30) || '(none)'}" was removed`);
      return;
    }
    const box = readBox(rawEl, scaleX, scaleY);
    if (!box) {
      issues.error(`Element "${id}" removed: invalid position or size`);
      return;
    }
    const base = { id, type, group, ...box };
    let el;
    switch (type) {
      case 'text': el = normalizeText(rawEl, base, ctx); break;
      case 'qr': el = normalizeQR(rawEl, base, ctx); break;
      case 'barcode': el = normalizeBarcode(rawEl, base, ctx); break;
      case 'rectangle':
      case 'ellipse':
      case 'triangle': el = normalizeShape(rawEl, base, ctx, type); break;
      case 'table': el = normalizeTable(rawEl, base, ctx); break;
      case 'image': el = normalizeImage(rawEl, base, ctx); break;
    }
    if (el) elements.push(el);
  });

  // Layout pass: bounds, scannability, overflow.
  for (const el of elements) {
    if (el.type === 'line') continue;
    if (fitBoxInCanvas(el, canvas)) issues.warn(`Element "${el.id}" was moved or resized to stay inside the label`);
    if (el.type === 'qr') postCheckQR(el, ctx);
    if (el.type === 'barcode') postCheckBarcode(el, ctx);
    if (el.type === 'text') postCheckText(el, ctx);
    if (canvas.round && outsideRoundLabel(el, canvas)) issues.warn(`Element "${el.id}" extends beyond the round label edge and may be clipped`);
  }

  // Groups need at least two members.
  const groupCounts = new Map();
  elements.forEach(el => { if (el.group) groupCounts.set(el.group, (groupCounts.get(el.group) || 0) + 1); });
  elements.forEach(el => {
    if (el.group && groupCounts.get(el.group) < 2 && el.type !== 'table') {
      issues.info(`Group "${el.group}" has a single member and was dissolved`);
      el.group = null;
    }
  });

  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter(n => typeof n === 'string').slice(0, 10).map(n => sanitizeText(n, 300).text.trim()).filter(Boolean)
    : [];
  const title = sanitizeText(raw.title, 80).text.replace(/\n/g, ' ').trim();

  if (elements.length === 0) {
    issues.error('The label has no usable elements');
    return { ok: false, document: null, issues: issues.items };
  }

  for (const el of elements) {
    for (const k of ['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2']) {
      if (k in el) el[k] = round2(el[k]);
    }
  }

  return {
    ok: true,
    document: { schemaVersion: LABEL_DOCUMENT_VERSION, title, canvas, direction: docDirection, elements, notes },
    issues: issues.items,
  };
}
