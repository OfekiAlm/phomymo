/**
 * Create with AI - generic label document schema (version 1)
 *
 * This is a printer-independent, domain-agnostic description of a label: a canvas
 * (in millimetres) holding positioned visual elements. It is what the model returns
 * (enforced by OpenAI Structured Outputs) and what validate.js / convert.js consume.
 *
 * Units: all positions and sizes are millimetres from the top-left corner of the label.
 * Font sizes are typographic points (1pt = 1/72 inch). Array order is z-order
 * (later elements are drawn on top).
 *
 * To support a new element type: add a variant here, normalize it in validate.js,
 * map it to native elements in convert.js and describe it in prompt.js.
 */

export const LABEL_DOCUMENT_VERSION = 1;

// Capability lists shared by schema, prompt and validator.
// Font keys map to font-family values available in the editor's font dropdown.
export const AI_FONTS = {
  'Inter': 'Inter, sans-serif',
  'Roboto': 'Roboto, sans-serif',
  'Open Sans': 'Open Sans, sans-serif',
  'Lato': 'Lato, sans-serif',
  'Montserrat': 'Montserrat, sans-serif',
  'Oswald': 'Oswald, sans-serif',
  'Arial': 'Arial, sans-serif',
  'Playfair Display': 'Playfair Display, serif',
  'Merriweather': 'Merriweather, serif',
  'Georgia': 'Georgia, serif',
  'Times New Roman': 'Times New Roman, serif',
  'Roboto Mono': 'Roboto Mono, monospace',
  'Courier New': 'Courier New, monospace',
  'Impact': 'Impact, sans-serif',
};
export const DEFAULT_AI_FONT = 'Inter';

export const AI_ENUMS = {
  elementTypes: ['text', 'qr', 'barcode', 'rectangle', 'ellipse', 'triangle', 'line', 'table', 'image'],
  align: ['start', 'center', 'end'],
  verticalAlign: ['top', 'middle', 'bottom'],
  direction: ['auto', 'ltr', 'rtl'],
  inkColor: ['black', 'white'],
  textBackground: ['transparent', 'black', 'white'],
  barcodeFormat: ['CODE128', 'EAN13', 'UPC', 'CODE39'],
  shapeFill: ['none', 'white', 'black', 'dither-12', 'dither-25', 'dither-50', 'dither-75'],
  shapeStroke: ['none', 'black', 'white'],
  tableBorders: ['none', 'grid', 'horizontal', 'outer'],
  canvasShape: ['rectangle', 'round'],
  documentDirection: ['ltr', 'rtl'],
};

const num = (description) => ({ type: 'number', description });
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const enumOf = (values, description) => ({ type: 'string', enum: values, description });

const BOX_PROPERTIES = {
  id: str('Unique id for this element, e.g. "title" or "sku_barcode".'),
  group: { type: ['string', 'null'], description: 'Group name shared by elements that move together, or null.' },
  x: num('Left edge in mm from the label left edge.'),
  y: num('Top edge in mm from the label top edge.'),
  width: num('Width in mm.'),
  height: num('Height in mm.'),
  rotation: num('Clockwise rotation in degrees around the element centre. Usually 0.'),
};
const BOX_KEYS = Object.keys(BOX_PROPERTIES);

function variant(type, properties, description) {
  const props = { type: { type: 'string', enum: [type] }, ...properties };
  return {
    type: 'object',
    description,
    properties: props,
    required: Object.keys(props),
    additionalProperties: false,
  };
}

const TEXT_VARIANT = variant('text', {
  ...BOX_PROPERTIES,
  text: str('Plain text (no HTML/markdown). Use \\n for line breaks. {{Field}} creates a template field, [[date]] a print-time date.'),
  fontFamily: enumOf(Object.keys(AI_FONTS), 'Font family.'),
  fontSizePt: num('Font size in points. Minimum 6, prefer >= 8 for body text.'),
  bold: bool('Bold weight.'),
  italic: bool('Italic style.'),
  underline: bool('Underline.'),
  align: enumOf(AI_ENUMS.align, 'Horizontal alignment relative to text direction (start = left in LTR, right in RTL).'),
  verticalAlign: enumOf(AI_ENUMS.verticalAlign, 'Vertical alignment inside the box.'),
  direction: enumOf(AI_ENUMS.direction, 'Text direction. Use rtl for Hebrew/Arabic, auto to detect.'),
  color: enumOf(AI_ENUMS.inkColor, 'Text colour. white only on a black background/shape.'),
  background: enumOf(AI_ENUMS.textBackground, 'Box background fill.'),
  wrap: bool('Wrap long lines to the box width.'),
  autoFit: bool('Shrink/grow font to fill the box (good for headlines with unknown length).'),
}, 'A text box.');

const QR_VARIANT = variant('qr', {
  ...BOX_PROPERTIES,
  data: str('Exact content to encode (URL, text, vCard, etc.).'),
}, 'A QR code. Must be square (width == height).');

const BARCODE_VARIANT = variant('barcode', {
  ...BOX_PROPERTIES,
  data: str('Content to encode. EAN13 = 12 or 13 digits, UPC = 11 or 12 digits, CODE39 = A-Z 0-9 -. $/+%, CODE128 = ASCII.'),
  format: enumOf(AI_ENUMS.barcodeFormat, 'Barcode symbology.'),
  showText: bool('Print the human-readable value under the bars.'),
  textSizePt: num('Human-readable text size in points (ignored when showText is false).'),
}, 'A 1D barcode.');

const SHAPE_PROPS = {
  fill: enumOf(AI_ENUMS.shapeFill, 'Fill. dither-N = N% grey pattern.'),
  stroke: enumOf(AI_ENUMS.shapeStroke, 'Outline colour.'),
  strokeWidthMm: num('Outline thickness in mm (0.25 - 2).'),
};

const RECTANGLE_VARIANT = variant('rectangle', {
  ...BOX_PROPERTIES,
  ...SHAPE_PROPS,
  cornerRadiusMm: num('Corner radius in mm (0 for square corners).'),
}, 'A rectangle, box, border or filled band.');

const ELLIPSE_VARIANT = variant('ellipse', { ...BOX_PROPERTIES, ...SHAPE_PROPS }, 'An ellipse or circle.');
const TRIANGLE_VARIANT = variant('triangle', { ...BOX_PROPERTIES, ...SHAPE_PROPS }, 'An upward-pointing triangle.');

const LINE_VARIANT = variant('line', {
  id: BOX_PROPERTIES.id,
  group: BOX_PROPERTIES.group,
  x1: num('Start x in mm.'),
  y1: num('Start y in mm.'),
  x2: num('End x in mm.'),
  y2: num('End y in mm.'),
  thicknessMm: num('Line thickness in mm (0.25 - 2).'),
  color: enumOf(AI_ENUMS.inkColor, 'Line colour.'),
}, 'A straight line or divider.');

const TABLE_VARIANT = variant('table', {
  ...BOX_PROPERTIES,
  rows: {
    type: 'array',
    description: 'Table rows, top to bottom. Every row should have the same number of cells.',
    items: {
      type: 'object',
      properties: {
        cells: { type: 'array', items: { type: 'string' }, description: 'Cell texts in reading order (right-to-left for RTL tables).' },
        bold: bool('Bold row (e.g. header).'),
      },
      required: ['cells', 'bold'],
      additionalProperties: false,
    },
  },
  columnWeights: { type: 'array', items: { type: 'number' }, description: 'Relative column widths in reading order, one per column.' },
  fontFamily: enumOf(Object.keys(AI_FONTS), 'Font family for all cells.'),
  fontSizePt: num('Cell font size in points.'),
  borders: enumOf(AI_ENUMS.tableBorders, 'Rule style.'),
  direction: enumOf(AI_ENUMS.direction, 'Column order direction. rtl puts the first column on the right.'),
  lastColumnAlign: enumOf(AI_ENUMS.align, 'Alignment of the last column (e.g. end for numbers). Other columns align start.'),
}, 'A simple table (e.g. nutrition facts, specs). Rendered as editable text cells and rules.');

const IMAGE_VARIANT = variant('image', {
  ...BOX_PROPERTIES,
  description: str('Short description of the intended image/logo, e.g. "Company logo". A placeholder is inserted that the user replaces.'),
}, 'Placeholder for a logo or picture the user will add later.');

export const LABEL_DOCUMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', enum: [LABEL_DOCUMENT_VERSION], description: 'Always 1.' },
    title: str('Short descriptive name for the design.'),
    canvas: {
      type: 'object',
      properties: {
        widthMm: num('Label width in mm.'),
        heightMm: num('Label height in mm.'),
        shape: enumOf(AI_ENUMS.canvasShape, 'Label outline.'),
      },
      required: ['widthMm', 'heightMm', 'shape'],
      additionalProperties: false,
    },
    direction: enumOf(AI_ENUMS.documentDirection, 'Dominant reading direction of the label.'),
    elements: {
      type: 'array',
      description: 'Visual elements in z-order (first = bottom).',
      items: {
        anyOf: [
          TEXT_VARIANT, QR_VARIANT, BARCODE_VARIANT, RECTANGLE_VARIANT, ELLIPSE_VARIANT,
          TRIANGLE_VARIANT, LINE_VARIANT, TABLE_VARIANT, IMAGE_VARIANT,
        ],
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Assumptions or limitations worth telling the user (may be empty).' },
  },
  required: ['schemaVersion', 'title', 'canvas', 'direction', 'elements', 'notes'],
  additionalProperties: false,
};

export const LABEL_DOCUMENT_FORMAT_NAME = 'label_document';

export { BOX_KEYS };
