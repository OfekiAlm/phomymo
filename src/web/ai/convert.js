/**
 * Create with AI - convert a validated label document into native editor elements
 *
 * Output elements are created with the editor's own factories (elements.js), so they are
 * indistinguishable from manually created ones: they can be selected, edited, grouped,
 * saved, exported and printed through the existing pipelines. Composite AI concepts
 * (tables, image placeholders, lines defined by end points) are decomposed into native
 * text/shape elements that share a group.
 */

import {
  createTextElement,
  createBarcodeElement,
  createQRElement,
  createShapeElement,
} from '../elements.js?v=100';
import { PT_TO_MM, EDITOR_PX_PER_MM } from './validate.js?v=1';

const mmToPx = (mm) => mm * EDITOR_PX_PER_MM;
const ptToPx = (pt) => Math.round(pt * PT_TO_MM * EDITOR_PX_PER_MM);
const strokePx = (mm) => Math.max(1, Math.min(20, Math.round(mm * EDITOR_PX_PER_MM)));

function newGroupId() {
  return 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

/**
 * Map logical alignment (start/center/end) to the editor's physical alignment.
 * @param {'start'|'center'|'end'} align
 * @param {'ltr'|'rtl'} direction
 * @returns {'left'|'center'|'right'}
 */
export function physicalAlign(align, direction) {
  if (align === 'center') return 'center';
  const rtl = direction === 'rtl';
  if (align === 'end') return rtl ? 'left' : 'right';
  return rtl ? 'right' : 'left';
}

function boxPx(el) {
  return {
    x: mmToPx(el.x),
    y: mmToPx(el.y),
    width: mmToPx(el.width),
    height: mmToPx(el.height),
    rotation: el.rotation || 0,
  };
}

function textOptions(el) {
  const options = {
    ...boxPx(el),
    fontSize: ptToPx(el.fontSizePt),
    fontFamily: el.fontFamily,
    fontWeight: el.bold ? 'bold' : 'normal',
    fontStyle: el.italic ? 'italic' : 'normal',
    textDecoration: el.underline ? 'underline' : 'none',
    align: physicalAlign(el.align, el.direction),
    verticalAlign: el.verticalAlign,
    color: el.color,
    background: el.background,
    noWrap: !el.wrap,
    autoScale: !!el.autoFit,
  };
  return options;
}

function withDirection(element, direction) {
  // Only RTL is stored; absence keeps the renderer's default (inherited LTR) behaviour.
  if (direction === 'rtl') element.direction = 'rtl';
  return element;
}

function convertText(el) {
  return [withDirection(createTextElement(el.text, textOptions(el)), el.direction)];
}

function convertQR(el) {
  return [createQRElement(el.data, boxPx(el))];
}

function convertBarcode(el) {
  const barcode = createBarcodeElement(el.data, { ...boxPx(el), barcodeFormat: el.format });
  barcode.showText = el.showText;
  barcode.textFontSize = ptToPx(el.textSizePt);
  return [barcode];
}

function convertShape(el) {
  return [createShapeElement(el.shapeType, {
    ...boxPx(el),
    fill: el.fill,
    stroke: el.stroke,
    strokeWidth: strokePx(el.strokeWidthMm),
    cornerRadius: el.shapeType === 'rectangle' ? Math.round(mmToPx(el.cornerRadiusMm || 0)) : 0,
  })];
}

/**
 * Native lines are horizontal strokes through the centre of their box, rotated by `rotation`.
 */
function lineElement(x1, y1, x2, y2, thicknessPx, color) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const height = Math.max(4, thicknessPx + 2);
  let rotation = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  rotation = ((rotation % 360) + 360) % 360;
  if (rotation >= 180) rotation -= 180; // a line is symmetric
  return createShapeElement('line', {
    x: cx - length / 2,
    y: cy - height / 2,
    width: length,
    height,
    rotation: Math.round(rotation * 100) / 100,
    fill: color,
    stroke: color,
    strokeWidth: thicknessPx,
  });
}

function convertLine(el) {
  return [lineElement(mmToPx(el.x1), mmToPx(el.y1), mmToPx(el.x2), mmToPx(el.y2), strokePx(el.thicknessMm), el.color)];
}

function convertImagePlaceholder(el) {
  const box = boxPx(el);
  const frame = createShapeElement('rectangle', {
    ...box,
    fill: 'dither-12',
    stroke: 'black',
    strokeWidth: 2,
    cornerRadius: 0,
  });
  const fontSize = Math.max(12, Math.min(28, Math.round(box.height / 4)));
  const label = createTextElement(el.description, {
    ...box,
    fontSize,
    align: 'center',
    verticalAlign: 'middle',
    background: 'transparent',
    autoScale: true,
  });
  return [frame, withDirection(label, el.direction || 'ltr')];
}

function convertTable(el) {
  const box = boxPx(el);
  const rows = el.rows;
  const columns = rows[0].cells.length;
  const totalWeight = el.columnWeights.reduce((a, b) => a + b, 0);
  const rowHeight = box.height / rows.length;
  const rtl = el.direction === 'rtl';
  const thickness = 2;
  const out = [];

  // Column x positions in reading order
  const colWidths = el.columnWeights.map(w => (w / totalWeight) * box.width);
  const colStarts = [];
  let acc = 0;
  for (let c = 0; c < columns; c++) {
    colStarts.push(rtl ? box.x + box.width - acc - colWidths[c] : box.x + acc);
    acc += colWidths[c];
  }

  // Rules first (drawn below text)
  const hLine = (y) => lineElement(box.x, y, box.x + box.width, y, thickness, 'black');
  const vLine = (x) => lineElement(x, box.y, x, box.y + box.height, thickness, 'black');
  if (el.borders === 'grid' || el.borders === 'outer') {
    out.push(createShapeElement('rectangle', { ...box, rotation: 0, fill: 'none', stroke: 'black', strokeWidth: thickness }));
  }
  if (el.borders === 'grid' || el.borders === 'horizontal') {
    for (let r = 1; r < rows.length; r++) out.push(hLine(box.y + r * rowHeight));
  }
  if (el.borders === 'grid') {
    for (let c = 1; c < columns; c++) {
      const boundary = rtl ? colStarts[c] + colWidths[c] : colStarts[c];
      out.push(vLine(boundary));
    }
  }

  const fontSize = ptToPx(el.fontSizePt);
  rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (!cell.trim()) return;
      const cellDirection = el.direction;
      const align = c === columns - 1 && columns > 1 ? el.lastColumnAlign : 'start';
      const text = createTextElement(cell, {
        x: colStarts[c],
        y: box.y + r * rowHeight,
        width: colWidths[c],
        height: rowHeight,
        fontSize,
        fontFamily: el.fontFamily,
        fontWeight: row.bold ? 'bold' : 'normal',
        align: physicalAlign(align, cellDirection),
        verticalAlign: 'middle',
        noWrap: false,
        autoScale: !!el.tight,
      });
      out.push(withDirection(text, cellDirection));
    });
  });

  // A rotated table rotates as a unit around its centre: rotate member positions too.
  if (box.rotation) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rad = (box.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    out.forEach(m => {
      const mx = m.x + m.width / 2 - cx;
      const my = m.y + m.height / 2 - cy;
      m.x = cx + mx * cos - my * sin - m.width / 2;
      m.y = cy + mx * sin + my * cos - m.height / 2;
      m.rotation = (((m.rotation || 0) + box.rotation) % 360 + 360) % 360;
    });
  }
  return out;
}

const CONVERTERS = {
  text: convertText,
  qr: convertQR,
  barcode: convertBarcode,
  rectangle: convertShape,
  ellipse: convertShape,
  triangle: convertShape,
  line: convertLine,
  table: convertTable,
  image: convertImagePlaceholder,
};

/**
 * Convert a validated document to native editor elements.
 * @param {Object} doc - Output of validateLabelDocument().document
 * @param {Object} [options]
 * @param {number} [options.zone=0] - Multi-label zone to place elements in
 * @returns {{ elements: Array<Object>, labelSize: { width: number, height: number, round: boolean } }}
 */
export function documentToEditorElements(doc, options = {}) {
  const zone = options.zone ?? 0;
  const groupIds = new Map();
  const groupFor = (name) => {
    if (!groupIds.has(name)) groupIds.set(name, newGroupId());
    return groupIds.get(name);
  };

  const elements = [];
  doc.elements.forEach((el, index) => {
    const convert = CONVERTERS[el.type];
    if (!convert) return;
    const produced = convert(el);
    // Multi-element conversions (tables, placeholders) form their own group unless
    // the AI already grouped them with other elements.
    let groupId = null;
    if (el.group) groupId = groupFor(el.group);
    else if (produced.length > 1) groupId = groupFor(`__composite_${index}`);
    for (const native of produced) {
      native.zone = zone;
      if (groupId) native.groupId = groupId;
      elements.push(native);
    }
  });

  return {
    elements,
    labelSize: {
      width: doc.canvas.widthMm,
      height: doc.canvas.heightMm,
      round: !!doc.canvas.round,
    },
  };
}
