# Phomymo

A free, browser-based label designer for Phomemo thermal printers. No drivers needed - connects via Bluetooth or USB.

**Try it now: https://phomymo.affordablemagic.net**

<p>
  <img src="screenshot.png" alt="Phomymo Label Designer" width="600" />
  <img src="screenshot-mobile.png" alt="Mobile UI" width="200" />
</p>

## Quick Start

1. Open https://phomymo.affordablemagic.net in Chrome (or any Chromium-based browser)
2. Click **Connect** to pair with your printer via Bluetooth (or **USB** for PM-241)
3. Design your label and click **Print**

To run locally (Web Bluetooth requires HTTPS or localhost):

```bash
cd src/web
python3 -m http.server 8080
# Open http://localhost:8080 in Chrome
```

**Requires:** Chrome, Edge, or another Chromium-based browser. Web Bluetooth is not available in Firefox or Safari. Android Chrome is supported with full touch UI; iOS is not supported. PM-241 printers require USB (WebUSB).

## Features

**Design Elements** - Text (multiple fonts including local system fonts, sizes, styles, alignment, background colors), images with scale/aspect lock, barcodes (Code128, EAN-13, UPC-A, Code39), QR codes, and shapes (rectangle, ellipse, triangle, line) with solid, dithered grayscale, and stroke fills.

**Editing** - Drag to move, corner/edge resize handles, rotation. Multi-select (Shift+click), grouping (Ctrl/Cmd+G), undo/redo, keyboard nudge, layer ordering, clipboard image paste (Ctrl/Cmd+V).

**Label Sizes** - Preset sizes for each printer type, round labels, custom dimensions. Auto-switches based on connected printer. Multi-label rolls with clone or individual zone modes.

**Templates & Batch Printing** - Variable fields with `{{FieldName}}` syntax, CSV import, preview grid, and batch printing with progress tracking.

**Instant Expressions** - Dynamic values at print time using `[[expression]]` syntax: `[[date]]`, `[[time]]`, `[[datetime]]`, or custom formats like `[[date|MM/DD/YYYY]]`. Works in text, barcodes, and QR codes.

**Create with AI** - Describe a label in plain language and generate an editable design with your own OpenAI API key. See [Create with AI](#create-with-ai).

**Right-to-left text** - Per-element RTL direction for Hebrew/Arabic and mixed-direction text.

**Print Preview** - Toggle dither preview to see exact thermal print output before printing.

**Export** - Save/load designs to browser storage, export/import as JSON, export to PDF or PNG.

**Mobile** - Full-featured touch UI with pinch-to-zoom, two-finger pan, slide-up property panels, and complete feature parity with desktop.

**Printer Status** - Live battery level, paper status, firmware version, and serial number with auto-query on connect.

## Supported Printers

| Model | Width | Notes |
|-------|-------|-------|
| P12 / P12 Pro | 12mm | Continuous tape label maker |
| A30 | 12-15mm | Continuous tape, faster print speed |
| M02 / M02S / M02X | 48mm (384px) | Mini pocket printers, continuous paper |
| M02 Pro | 53mm (626px) | 300 DPI high-resolution mini printer |
| M03 | 53mm (432px) | Mini sticker printer |
| T02 | 48mm (384px) | Mini sticker printer |
| M04S / M04AS | 53/80/110mm | 300 DPI multi-width printer (select paper size in settings) |
| M110 / M120 | 48mm (384px) | Narrow label makers |
| M200 / M250 | 75mm (608px) | Mid-size labels |
| M220 / M221 | 72mm (576px) | Wide labels |
| M260 | 72mm (576px) | Wide label maker |
| D30 / D35 / D50 / D110 | 12-15mm | Smart mini label makers (rotated protocol) |
| Q30 / Q30S | 12-15mm | Similar to D30 |
| PM-241 / PM-241-BT | 102mm (4") | Shipping labels, USB only (TSPL protocol) |

The app auto-detects your printer model from the Bluetooth device name and configures the correct protocol, print width, DPI, and label presets. If auto-detection fails, you can manually select your model in Print Settings, or the app will prompt you on first connection.

D-series printers print labels rotated 90° - the app handles this automatically. PM-241 printers use Bluetooth Classic (not BLE), so use the USB connection instead.

## Custom Printer Definitions

You can add, edit, and override printer definitions through **Print Settings > Manage Printers**. This lets you:

- **Add new printers** not yet in the built-in list with your own protocol, width, DPI, and alignment settings
- **Override built-in printers** to adjust settings like alignment or width for your specific hardware
- **Set auto-detect patterns** so your custom definitions are recognized automatically by BLE device name

Custom definitions are saved in your browser's localStorage and take priority over built-ins. Modified built-in printers can be reset to defaults at any time.

Built-in definitions are loaded from `printers.json` at startup.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Ctrl/Cmd + D` | Duplicate selected |
| `Ctrl/Cmd + G` | Group selected |
| `Ctrl/Cmd + Shift + G` | Ungroup |
| `Ctrl/Cmd + V` | Paste image from clipboard |
| `Delete / Backspace` | Delete selected |
| `Arrow keys` | Nudge by 1px |
| `Shift + Arrow keys` | Nudge by 10px |
| `Shift + Click` | Add to selection |

## Connection Tips

When the Bluetooth device picker appears, select the device showing a **signal strength indicator**. Devices listed without signal strength may be cached/ghost entries that won't connect properly.

## Project Structure

```
phomymo/
├── src/
│   └── web/
│       ├── index.html     # Main UI
│       ├── app.js         # Application logic
│       ├── canvas.js      # Canvas rendering & dithering
│       ├── elements.js    # Element management
│       ├── handles.js     # Selection handles
│       ├── storage.js     # localStorage persistence
│       ├── templates.js   # Variable substitution & CSV
│       ├── ble.js         # Web Bluetooth transport
│       ├── usb.js         # WebUSB transport
│       ├── printer.js     # Print protocols
│       ├── printers.json  # Built-in printer definitions
│       ├── constants.js   # Shared constants
│       ├── ai/            # Create with AI (optional, lazy-loaded)
│       └── utils/
│           ├── bindings.js   # Event binding helpers
│           ├── errors.js     # Error handling
│           └── validation.js # Input validation
└── README.md
```

## Create with AI

Generate a complete, editable label from a description such as *"50 × 30 mm warehouse label with item name, SKU barcode, quantity and shelf location"*.

### Usage

1. Click **Create with AI** in the toolbar (mobile: menu → **Create with AI**).
2. Paste an OpenAI API key (create one at <https://platform.openai.com/api-keys>; the account needs API billing/credits).
3. Describe the label and click **Generate**.

The result is inserted as normal text, barcode, QR and shape elements, so you can select, move, resize, edit, group, save, export and print it like any hand-made label. One **Undo** restores your previous elements.

Optional settings: label size (current, let the AI choose, or custom), and under **Advanced options** orientation, text direction, model and "add to current design instead of replacing it". In multi-label mode the design goes into the selected label.

### API key storage and security

- The app is fully client-side; the key is sent **only** to `https://api.openai.com/v1/responses`, directly from your browser. There is no Phomymo server.
- By default the key is kept in memory and forgotten when the page closes. Ticking **Remember on this device** stores it in this browser's `localStorage` (`phomymo_openai_api_key`); **Forget saved key** removes it. `localStorage` is readable by any script on this origin, so only remember the key on devices you trust, and prefer a [project key with a spending limit](https://platform.openai.com/settings/organization/limits).
- The key is never logged and is redacted from error details. Requests use `store: false`.
- Model output is treated as untrusted: it is schema-checked, sanitized (no HTML or scripts, no `javascript:`/`data:` URLs in QR codes, no bidi overrides), clamped to the label bounds and converted only into existing element types.

### What it can generate

Text (fonts from the editor's list, size, bold/italic/underline, alignment, RTL), QR codes, barcodes (CODE128, EAN-13, UPC-A, CODE39), rectangles/ellipses/triangles with dithered fills, lines, tables (as grouped text cells and rules), and image placeholders (a captioned frame to replace with your own image). `{{Field}}` template fields and `[[date]]` expressions are preserved.

### Known limitations

- The AI cannot supply real logos or pictures; it inserts a placeholder.
- Undo restores elements but not a label-size change (same as manual size changes).
- Text is single-style per element (no mixed rich text in one box).
- Barcodes/QR codes are resized or converted (e.g. invalid EAN-13 → CODE128) when the request cannot be printed scannably.

### Troubleshooting

| Message | Fix |
|---|---|
| OpenAI rejected the API key | Re-copy the key; check it was not revoked. |
| Run out of credits / quota | Add billing or credits at platform.openai.com. |
| Rate-limiting | Wait a moment and press **Retry**. |
| Model not available | Clear the **Model** field to use the default. |
| Could not produce a valid layout | Simplify the request or allow a larger label. |
| Network error | Check your connection, VPN or content blockers for `api.openai.com`. |

Details for each error are under **Technical details** in the dialog.

### Development

Pipeline (all in `src/web/ai/`):

```
dialog.js ─▶ generate.js ─▶ prompt.js + client.js (OpenAI Responses API, Structured Outputs)
                         ─▶ validate.js (parse, version migration, schema/semantic/layout checks, normalization)
                         ─▶ (one repair request if unusable)
                         ─▶ convert.js (native elements via elements.js factories)
app.js applyGeneratedDesign() ─▶ editor state (one history entry, rollback on failure)
```

- `schema.js` defines the versioned, printer-independent label document (mm units). Bump `LABEL_DOCUMENT_VERSION` and extend `migrateDocument()` in `validate.js` when changing it.
- **Changing the model:** edit `DEFAULT_MODEL` (and `SUGGESTED_MODELS`) in `ai/config.js`. The model must support Structured Outputs with `strict` JSON Schema. Users can also enter a model under Advanced options.
- **Adding an element type:** add a variant to `schema.js` (and `AI_ENUMS.elementTypes`), a normalizer in `validate.js`, a converter in `convert.js` that produces existing editor elements, a rule in `prompt.js` if needed, plus a test.
- The app talks to the module only through a small host API (`getAIHost()` in `app.js`); removing the `ai/` folder and the two entry buttons leaves the editor unchanged.
- Debug logging (metadata only, never the key or prompt text): `localStorage.setItem('phomymo_ai_debug', '1')`.
- Tests: `tests/07-create-with-ai.spec.ts` with fixtures in `tests/fixtures/ai/`; OpenAI is always mocked.

## Acknowledgments

Protocol research and inspiration:

- [vivier/phomemo-tools](https://github.com/vivier/phomemo-tools) - CUPS driver with reverse-engineered protocol
- [yaddran/thermal-print](https://github.com/yaddran/thermal-print) - Printer status query commands
- [ooki1jp](https://github.com/vivier/phomemo-tools/issues/27#issuecomment-3850158579) - M04AS/M04S protocol reverse-engineering

Libraries: [JsBarcode](https://github.com/lindell/JsBarcode), [QRCode.js](https://github.com/davidshimjs/qrcodejs), [jsPDF](https://github.com/parallax/jsPDF)

## Support the Project

If Phomymo is useful to you, consider [making a donation](https://donate.stripe.com/7sY7sMese0182tXgn8eAg00) to support ongoing development.

## License

MIT License - see LICENSE file for details.
