import { test, expect, Page } from '@playwright/test';
import { waitForAppReady, dismissInfoDialog } from './helpers/app';
import fs from 'fs';
import path from 'path';

/**
 * Create with AI.
 * All OpenAI traffic is mocked (module-level fetch injection or page.route); no real API calls.
 */

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const FAKE_KEY = 'sk-test-0123456789abcdefABCDEF';

function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ai', name), 'utf8'));
}

/** Wrap a label document in a Responses API payload */
function responsesPayload(doc: unknown) {
  return {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof doc === 'string' ? doc : JSON.stringify(doc) }] },
    ],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
  };
}

const CONSTRAINTS_50x30 = {
  canvas: { widthMm: 50, heightMm: 30, round: false },
  sizeMode: 'fixed',
  limits: { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 },
  orientation: 'any',
  direction: 'auto',
  dpi: 203,
};

// Visibility is asserted via the `hidden` class the app toggles, so tests do not depend on
// the Tailwind CDN stylesheet being reachable.
const HIDDEN = /(^|\s)hidden(\s|$)/;

async function openAIDialog(page: Page) {
  await page.click('#create-ai-btn');
  // The dialog module is loaded on first use; wait until it has opened (and pre-filled) the form.
  await page.waitForSelector('#ai-dialog:not(.hidden)', { state: 'attached' });
}

async function openApp(page: Page) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await waitForAppReady(page);
  await dismissInfoDialog(page);
}

/** Save the current design through the normal Save dialog and read it back from storage */
async function saveAndRead(page: Page, name: string) {
  await page.click('#save-btn');
  await page.fill('#save-name', name);
  await page.click('#save-confirm');
  await page.waitForTimeout(200);
  return page.evaluate((n) => JSON.parse(localStorage.getItem('phomymo_designs') || '{}')[n], name);
}

test.describe('Create with AI - pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('JSON schema is valid for strict Structured Outputs', async ({ page }) => {
    const problems = await page.evaluate(async () => {
      const { LABEL_DOCUMENT_JSON_SCHEMA } = await import('/ai/schema.js?v=1');
      const out: string[] = [];
      const visit = (node: any, where: string) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'object') {
          if (node.additionalProperties !== false) out.push(`${where}: additionalProperties`);
          const keys = Object.keys(node.properties || {});
          const req = node.required || [];
          if (keys.length !== req.length || keys.some((k: string) => !req.includes(k))) out.push(`${where}: required`);
          for (const k of keys) visit(node.properties[k], `${where}.${k}`);
        }
        if (node.items) visit(node.items, `${where}[]`);
        (node.anyOf || []).forEach((v: any, i: number) => visit(v, `${where}|${i}`));
      };
      visit(LABEL_DOCUMENT_JSON_SCHEMA, '$');
      return out;
    });
    expect(problems).toEqual([]);
  });

  test('request body uses Responses API structured output without leaking the key', async ({ page }) => {
    const body = await page.evaluate(async () => {
      const { buildRequestBody } = await import('/ai/client.js?v=1');
      const { buildSystemPrompt, buildUserMessage } = await import('/ai/prompt.js?v=1');
      return buildRequestBody({
        model: '',
        instructions: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserMessage('A cable label', {
          canvas: { widthMm: 40, heightMm: 12, round: false }, sizeMode: 'fixed', limits: {}, direction: 'auto',
        }) }],
      });
    });
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect(body.store).toBe(false);
    expect(body.model).toBeTruthy();
    expect(body.input[0].content).toContain('40 mm wide x 12 mm tall');
    expect(JSON.stringify(body)).not.toContain('sk-');
  });

  test('valid warehouse document validates and converts to native elements', async ({ page }) => {
    const doc = fixture('warehouse-label.json');
    const result = await page.evaluate(async ({ doc, constraints }) => {
      const { validateLabelDocument } = await import('/ai/validate.js?v=1');
      const { documentToEditorElements } = await import('/ai/convert.js?v=1');
      const v = validateLabelDocument(JSON.stringify(doc), constraints, {});
      const c = documentToEditorElements(v.document, { zone: 0 });
      return { ok: v.ok, issues: v.issues, elements: c.elements, labelSize: c.labelSize };
    }, { doc, constraints: CONSTRAINTS_50x30 });

    expect(result.ok).toBe(true);
    expect(result.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    expect(result.labelSize).toEqual({ width: 50, height: 30, round: false });

    const types = result.elements.map((e: any) => e.type);
    expect(types).toEqual(['shape', 'text', 'shape', 'text', 'barcode', 'qr']);
    const ids = new Set(result.elements.map((e: any) => e.id));
    expect(ids.size).toBe(result.elements.length);

    // mm -> editor px (8 px/mm)
    const frame = result.elements[0];
    expect(frame.shapeType).toBe('rectangle');
    expect(frame.x).toBeCloseTo(4, 1);
    expect(frame.width).toBeCloseTo(392, 1);

    const title = result.elements[1];
    expect(title.text).toBe('Steel Hex Bolts M8');
    expect(title.fontWeight).toBe('bold');
    expect(title.align).toBe('left');
    expect(title.autoScale).toBe(true);
    expect(title.direction).toBeUndefined();
    // "header" group = title + rule share a native group id
    expect(title.groupId).toMatch(/^grp_/);
    expect(result.elements[2].groupId).toBe(title.groupId);
    expect(result.elements[2].shapeType).toBe('line');

    const barcode = result.elements[4];
    expect(barcode.barcodeData).toBe('SKU-12345');
    expect(barcode.barcodeFormat).toBe('CODE128');
    expect(barcode.showText).toBe(true);

    const qr = result.elements[5];
    expect(qr.qrData).toBe('https://example.com/item/12345');
    expect(qr.width).toBe(qr.height);
    expect(qr.width).toBeGreaterThanOrEqual(64); // >= 8 mm
    for (const el of result.elements) {
      expect(el.zone).toBe(0);
      expect(Number.isFinite(el.x) && Number.isFinite(el.y)).toBe(true);
    }
  });

  test('RTL document keeps Unicode, sets direction and mirrors start alignment and table columns', async ({ page }) => {
    const doc = fixture('hebrew-nutrition.json');
    const result = await page.evaluate(async ({ doc }) => {
      const { validateLabelDocument } = await import('/ai/validate.js?v=1');
      const { documentToEditorElements } = await import('/ai/convert.js?v=1');
      const constraints = {
        canvas: { widthMm: 50, heightMm: 50, round: false }, sizeMode: 'fixed',
        limits: { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 }, orientation: 'any', direction: 'auto',
      };
      const v = validateLabelDocument(doc, constraints, {});
      return { ok: v.ok, elements: documentToEditorElements(v.document).elements };
    }, { doc });

    expect(result.ok).toBe(true);
    const texts = result.elements.filter((e: any) => e.type === 'text');
    const title = texts.find((e: any) => e.text.startsWith('גלידת'));
    expect(title.text).toBe('גלידת חלבון 150 גרם');
    expect(title.direction).toBe('rtl');      // auto-detected from Hebrew
    expect(title.align).toBe('right');        // logical start in RTL

    const header = texts.find((e: any) => e.text === 'ערכים תזונתיים');
    const headerValue = texts.find((e: any) => e.text === 'ל-100 גרם');
    expect(header.direction).toBe('rtl');
    expect(header.fontWeight).toBe('bold');
    // First column sits on the right in an RTL table
    expect(header.x).toBeGreaterThan(headerValue.x);
    // lastColumnAlign "end" in RTL is physical left
    expect(headerValue.align).toBe('left');

    // Table cells + rules share one group
    const tableMembers = result.elements.filter((e: any) => e.groupId && e.groupId === header.groupId);
    expect(tableMembers.length).toBeGreaterThan(8);
  });

  test('untrusted output is sanitized, bounded and normalized', async ({ page }) => {
    const doc = fixture('problematic-label.json');
    const result = await page.evaluate(async ({ doc }) => {
      const { validateLabelDocument } = await import('/ai/validate.js?v=1');
      const { documentToEditorElements } = await import('/ai/convert.js?v=1');
      const constraints = {
        canvas: { widthMm: 50, heightMm: 30, round: false }, sizeMode: 'fixed',
        limits: { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 }, orientation: 'any', direction: 'auto',
      };
      const v = validateLabelDocument(doc, constraints, {});
      return { ok: v.ok, doc: v.document, issues: v.issues, elements: documentToEditorElements(v.document).elements };
    }, { doc });

    expect(result.ok).toBe(true);
    const messages = result.issues.map((i: any) => i.message).join('\n');
    // Unsupported type and invalid coordinates are dropped, not inserted
    expect(messages).toMatch(/Unsupported element type "hologram"/);
    expect(messages).toMatch(/invalid position or size/);
    expect(result.doc.elements.map((e: any) => e.type)).not.toContain('hologram');
    // Designed on 80x60 but label is fixed at 50x30 -> scaled
    expect(messages).toMatch(/scaled/);
    // Markup stripped from text and title
    expect(result.doc.title).not.toContain('<');
    const texts = result.elements.filter((e: any) => e.type === 'text');
    expect(texts.some((t: any) => t.text === 'Property of Example Corp')).toBe(true);
    expect(texts.every((t: any) => !t.text.includes('<'))).toBe(true);
    // Duplicate ids made unique
    const ids = result.doc.elements.map((e: any) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every element inside the 50x30 mm label (400x240 px)
    for (const el of result.elements) {
      if (el.type === 'shape' && el.shapeType === 'line') continue;
      expect(el.x).toBeGreaterThanOrEqual(-0.01);
      expect(el.y).toBeGreaterThanOrEqual(-0.01);
      expect(el.x + el.width).toBeLessThanOrEqual(400.01);
      expect(el.y + el.height).toBeLessThanOrEqual(240.01);
    }
    // Fonts and colours normalized to supported values
    for (const t of texts) {
      expect(['black', 'white']).toContain(t.color);
      expect(t.fontSize).toBeGreaterThanOrEqual(17); // >= 6 pt
    }
    // QR forced square
    const qr = result.elements.find((e: any) => e.type === 'qr');
    expect(qr.width).toBeCloseTo(qr.height, 1);
    // Image placeholder becomes an editable frame + caption group
    const caption = texts.find((t: any) => t.text === 'Company logo');
    expect(caption.groupId).toBeTruthy();
    // Single-member group dissolved
    const asset = texts.find((t: any) => t.text === 'ASSET 0042');
    expect(asset.groupId).toBeUndefined();
  });

  test('barcode and QR content is validated', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { validateLabelDocument } = await import('/ai/validate.js?v=1');
      const base = (el: any) => ({
        schemaVersion: 1, title: 't', canvas: { widthMm: 50, heightMm: 30, shape: 'rectangle' }, direction: 'ltr', notes: [],
        elements: [{ id: 'a', group: null, x: 2, y: 2, width: 46, height: 14, rotation: 0, ...el }],
      });
      const constraints = {
        canvas: { widthMm: 50, heightMm: 30, round: false }, sizeMode: 'fixed',
        limits: { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 }, orientation: 'any', direction: 'auto',
      };
      const run = (el: any) => validateLabelDocument(base(el), constraints, {});
      return {
        eanBadCheck: run({ type: 'barcode', data: '5901234123451', format: 'EAN13', showText: true, textSizePt: 7 }),
        eanLetters: run({ type: 'barcode', data: 'ABC-123', format: 'EAN13', showText: true, textSizePt: 7 }),
        code39Lower: run({ type: 'barcode', data: 'abc-1', format: 'CODE39', showText: false, textSizePt: 7 }),
        emptyBarcode: run({ type: 'barcode', data: '', format: 'CODE128', showText: true, textSizePt: 7 }),
        qrJs: run({ type: 'qr', data: 'javascript:alert(1)', width: 14, height: 14 }),
        qrOk: run({ type: 'qr', data: 'https://example.com', width: 14, height: 14 }),
      };
    });
    const el = (r: any) => r.document?.elements?.[0];
    expect(el(out.eanBadCheck).data).toBe('5901234123457');
    expect(el(out.eanLetters).format).toBe('CODE128');
    expect(el(out.eanLetters).data).toBe('ABC-123');
    expect(el(out.code39Lower).data).toBe('ABC-1');
    expect(out.emptyBarcode.ok).toBe(false);
    expect(out.qrJs.ok).toBe(false);
    expect(out.qrOk.ok).toBe(true);
    expect(el(out.qrOk).data).toBe('https://example.com');
  });

  test('text overflow is detected with real font metrics and auto-fit enabled', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { validateLabelDocument } = await import('/ai/validate.js?v=1');
      const canvas = document.createElement('canvas').getContext('2d')!;
      const env = { measureTextWidth: (t: string, f: string) => { canvas.font = f; return canvas.measureText(t).width; } };
      const doc = {
        schemaVersion: 1, title: 't', canvas: { widthMm: 40, heightMm: 12, shape: 'rectangle' }, direction: 'ltr', notes: [],
        elements: [{
          type: 'text', id: 'long', group: null, x: 1, y: 1, width: 20, height: 5, rotation: 0,
          text: 'An extremely long product name that will never fit', fontFamily: 'Inter', fontSizePt: 14,
          bold: false, italic: false, underline: false, align: 'start', verticalAlign: 'middle', direction: 'auto',
          color: 'black', background: 'transparent', wrap: false, autoFit: false,
        }],
      };
      const constraints = {
        canvas: { widthMm: 40, heightMm: 12, round: false }, sizeMode: 'fixed',
        limits: { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 }, orientation: 'any', direction: 'auto',
      };
      return validateLabelDocument(doc, constraints, env);
    });
    expect(out.ok).toBe(true);
    expect(out.document.elements[0].autoFit).toBe(true);
    expect(out.issues.some((i: any) => /overflow|fit/i.test(i.message))).toBe(true);
  });

  test('flexible size uses AI size within limits; schema version mismatch is rejected', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { validateLabelDocument } = await import('/ai/validate.js?v=1');
      const flexible = {
        canvas: { widthMm: 40, heightMm: 30, round: false }, sizeMode: 'flexible',
        limits: { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 }, orientation: 'any', direction: 'auto',
      };
      const doc = (canvas: any, extra: any = {}) => ({
        schemaVersion: 1, title: 't', canvas, direction: 'ltr', notes: [], ...extra,
        elements: [{ type: 'ellipse', id: 'c', group: null, x: 1, y: 1, width: 8, height: 8, rotation: 0, fill: 'black', stroke: 'none', strokeWidthMm: 0.5 }],
      });
      return {
        round: validateLabelDocument(doc({ widthMm: 50, heightMm: 50, shape: 'round' }), flexible, {}),
        huge: validateLabelDocument(doc({ widthMm: 500, heightMm: 30, shape: 'rectangle' }), flexible, {}),
        v2: validateLabelDocument(doc({ widthMm: 50, heightMm: 30, shape: 'rectangle' }, { schemaVersion: 2 }), flexible, {}),
        notJson: validateLabelDocument('Sure! Here is your label: {', flexible, {}),
        empty: validateLabelDocument({ ...doc({ widthMm: 50, heightMm: 30, shape: 'rectangle' }), elements: [] }, flexible, {}),
      };
    });
    expect(out.round.document.canvas).toEqual({ widthMm: 50, heightMm: 50, round: true });
    expect(out.huge.document.canvas.widthMm).toBe(100);
    expect(out.v2.ok).toBe(false);
    expect(out.notJson.ok).toBe(false);
    expect(out.empty.ok).toBe(false);
  });

  test('API errors map to user-friendly messages and never expose the key', async ({ page }) => {
    const out = await page.evaluate(async (key) => {
      const { callResponsesApi } = await import('/ai/client.js?v=1');
      const respond = (status: number, body: any) => async () =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const attempt = async (fetchImpl: any, opts: any = {}) => {
        try {
          await callResponsesApi({ apiKey: key, body: {}, fetchImpl, ...opts });
          return { ok: true };
        } catch (e: any) {
          return { code: e.code, message: e.message, detail: e.detail, retryable: e.retryable, status: e.status };
        }
      };
      return {
        missing: await (async () => {
          try { await callResponsesApi({ apiKey: '  ', body: {}, fetchImpl: respond(200, {}) }); return null; } catch (e: any) { return e.code; }
        })(),
        invalid: await attempt(respond(401, { error: { message: `Incorrect API key provided: ${key}`, code: 'invalid_api_key' } })),
        permission: await attempt(respond(403, { error: { message: 'no access' } })),
        quota: await attempt(respond(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } })),
        rate: await attempt(respond(429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } })),
        model: await attempt(respond(404, { error: { message: 'The model does not exist', code: 'model_not_found' } })),
        server: await attempt(respond(503, { error: { message: 'overloaded' } })),
        network: await attempt(async () => { throw new TypeError('Failed to fetch'); }),
        malformed: await attempt(async () => new Response('<html>', { status: 200 })),
        refusal: await attempt(respond(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] })),
        incomplete: await attempt(respond(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })),
        timeout: await attempt((url: string, init: any) => new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }), { timeoutMs: 50 }),
        cancelled: await (async () => {
          const c = new AbortController();
          const p = attempt((url: string, init: any) => new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }), { signal: c.signal });
          setTimeout(() => c.abort(), 20);
          return p;
        })(),
      };
    }, FAKE_KEY);

    expect(out.missing).toBe('MISSING_API_KEY');
    expect(out.invalid.code).toBe('INVALID_API_KEY');
    expect(out.invalid.status).toBe(401);
    expect(out.permission.code).toBe('PERMISSION_DENIED');
    expect(out.quota.code).toBe('QUOTA_EXCEEDED');
    expect(out.quota.retryable).toBe(false);
    expect(out.rate.code).toBe('RATE_LIMITED');
    expect(out.rate.retryable).toBe(true);
    expect(out.model.code).toBe('MODEL_UNAVAILABLE');
    expect(out.server.code).toBe('SERVICE_ERROR');
    expect(out.network.code).toBe('NETWORK_ERROR');
    expect(out.malformed.code).toBe('MALFORMED_RESPONSE');
    expect(out.refusal.code).toBe('REFUSAL');
    expect(out.incomplete.code).toBe('INCOMPLETE');
    expect(out.timeout.code).toBe('TIMEOUT');
    expect(out.cancelled.code).toBe('CANCELLED');
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(out)).not.toContain('0123456789abcdef');
  });

  test('invalid output triggers exactly one repair request, then succeeds or fails cleanly', async ({ page }) => {
    const good = fixture('warehouse-label.json');
    const out = await page.evaluate(async ({ key, good }) => {
      const { generateLabel } = await import('/ai/generate.js?v=1');
      const payload = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
      const makeFetch = (texts: string[]) => {
        const calls: any[] = [];
        const fetchImpl = async (url: string, init: any) => {
          calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
          const text = texts[Math.min(calls.length - 1, texts.length - 1)];
          return new Response(JSON.stringify(payload(text)), { status: 200 });
        };
        return { calls, fetchImpl };
      };
      const constraints = {
        canvas: { widthMm: 50, heightMm: 30, round: false }, sizeMode: 'fixed',
        limits: { minWidthMm: 10, maxWidthMm: 100, minHeightMm: 10, maxHeightMm: 200 }, orientation: 'any', direction: 'auto',
      };
      const bad = JSON.stringify({ schemaVersion: 1, title: 'x', canvas: { widthMm: 50, heightMm: 30, shape: 'rectangle' }, direction: 'ltr', elements: [], notes: [] });

      const repaired = makeFetch([bad, JSON.stringify(good)]);
      const r1 = await generateLabel({ apiKey: key, prompt: 'warehouse label', constraints, fetchImpl: repaired.fetchImpl });

      const broken = makeFetch([bad]);
      let failure: any = null;
      try {
        await generateLabel({ apiKey: key, prompt: 'warehouse label', constraints, fetchImpl: broken.fetchImpl });
      } catch (e: any) {
        failure = { code: e.code, message: e.message };
      }

      let emptyPrompt: any = null;
      try { await generateLabel({ apiKey: key, prompt: '   ', constraints, fetchImpl: broken.fetchImpl }); } catch (e: any) { emptyPrompt = e.code; }
      let noKey: any = null;
      try { await generateLabel({ apiKey: '', prompt: 'x', constraints, fetchImpl: broken.fetchImpl }); } catch (e: any) { noKey = e.code; }

      return {
        r1: { attempts: r1.attempts, count: r1.elements.length },
        repairedCalls: repaired.calls.length,
        repairInput: repaired.calls[1].body.input.map((m: any) => m.role),
        repairText: repaired.calls[1].body.input[2].content,
        endpoint: repaired.calls[0].url,
        authScheme: repaired.calls[0].auth.split(' ')[0],
        brokenCalls: broken.calls.length,
        failure,
        emptyPrompt,
        noKey,
      };
    }, { key: FAKE_KEY, good });

    expect(out.r1.attempts).toBe(2);
    expect(out.r1.count).toBe(6);
    expect(out.repairedCalls).toBe(2);
    expect(out.repairInput).toEqual(['user', 'assistant', 'user']);
    expect(out.repairText).toContain('no usable elements');
    expect(out.endpoint).toBe(OPENAI_URL);
    expect(out.authScheme).toBe('Bearer');
    expect(out.brokenCalls).toBe(2); // original + one repair, no infinite loop
    expect(out.failure.code).toBe('VALIDATION_FAILED');
    expect(out.emptyPrompt).toBe('EMPTY_PROMPT');
    expect(out.noKey).toBe('MISSING_API_KEY');
  });
});

test.describe('Create with AI - editor integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('phomymo_openai_api_key');
      localStorage.removeItem('phomymo_ai_prefs');
    });
    await openApp(page);
  });

  test('generates an editable label that supports undo, save and export', async ({ page }) => {
    const requests: any[] = [];
    await page.route(OPENAI_URL, async (route) => {
      requests.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(responsesPayload(fixture('warehouse-label.json'))),
      });
    });

    // Existing manual element
    await page.click('#add-text');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    await openAIDialog(page);
    await expect(page.locator('#ai-api-key')).toHaveAttribute('type', 'password');

    // Missing key: friendly error, no request
    await page.fill('#ai-prompt', 'A 50 x 30 mm warehouse label');
    await page.click('#ai-generate');
    await expect(page.locator('#ai-error')).not.toHaveClass(HIDDEN);
    await expect(page.locator('#ai-error-message')).toContainText('API key');
    expect(requests.length).toBe(0);

    await page.fill('#ai-api-key', FAKE_KEY);
    await page.click('#ai-key-toggle');
    await expect(page.locator('#ai-api-key')).toHaveAttribute('type', 'text');
    await page.click('#ai-key-toggle');
    await page.selectOption('#ai-size-mode', 'auto');
    await page.click('#ai-generate');

    await expect(page.locator('#ai-dialog')).toHaveClass(HIDDEN, { timeout: 10_000 });
    expect(requests.length).toBe(1);
    expect(requests[0].headers.authorization).toBe(['Bearer', FAKE_KEY].join(' '));
    expect(requests[0].body.input[0].content).toContain('A 50 x 30 mm warehouse label');
    // Key was not persisted (Remember unchecked)
    expect(await page.evaluate(() => localStorage.getItem('phomymo_openai_api_key'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('phomymo_ai_prefs'))).not.toContain('sk-');

    // Label size switched to the generated size
    await expect(page.locator('#label-size')).toHaveValue('50x30');

    // Saved like any manual design
    const saved = await saveAndRead(page, 'ai-warehouse');
    expect(saved.labelSize.width).toBe(50);
    expect(saved.elements.length).toBe(6);
    expect(saved.elements.map((e: any) => e.type)).toContain('barcode');

    // Elements are selectable/editable through the normal UI
    await page.click('#elements-btn');
    await page.locator('.element-list-item', { hasText: 'SKU-12345' }).click();
    await expect(page.locator('#props-barcode')).not.toHaveClass(HIDDEN);
    await expect(page.locator('#prop-barcode-data')).toHaveValue('SKU-12345');

    // One undo restores the previous design
    await page.click('#undo-btn');
    await page.waitForTimeout(200);
    const afterUndo = await saveAndRead(page, 'after-undo');
    expect(afterUndo.elements.length).toBe(1);
    expect(afterUndo.elements[0].text).toBe('New Text');

    // Redo brings it back
    await page.click('#redo-btn');
    await page.waitForTimeout(200);
    const afterRedo = await saveAndRead(page, 'after-redo');
    expect(afterRedo.elements.length).toBe(6);

    // JSON export still works
    await page.click('#export-btn');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-json-btn'),
    ]);
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    expect(exported.elements.length).toBe(6);
  });

  test('errors leave the current design untouched and allow retry', async ({ page }) => {
    let calls = 0;
    await page.route(OPENAI_URL, async (route) => {
      calls++;
      if (calls === 1) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}`, code: 'invalid_api_key' } }),
        });
      } else if (calls === 2) {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(responsesPayload(fixture('hebrew-nutrition.json'))),
        });
      }
    });

    await page.click('#add-qr');
    await page.waitForTimeout(200);
    const before = await saveAndRead(page, 'before');

    await openAIDialog(page);
    await page.fill('#ai-api-key', FAKE_KEY);
    await page.fill('#ai-prompt', 'Hebrew protein ice cream label with nutrition table');
    await page.click('#ai-generate');

    await expect(page.locator('#ai-error')).not.toHaveClass(HIDDEN);
    await expect(page.locator('#ai-error-message')).toContainText('rejected the API key');
    await expect(page.locator('#ai-generate')).toBeEnabled();
    const errorText = await page.locator('#ai-error').textContent();
    expect(errorText).not.toContain(FAKE_KEY);

    // Design untouched
    await page.click('#ai-cancel');
    const afterError = await saveAndRead(page, 'after-error');
    expect(afterError.elements).toEqual(before.elements);

    // Rate limit -> Retry
    await openAIDialog(page);
    await page.click('#ai-generate');
    await expect(page.locator('#ai-generate')).toHaveText('Retry');
    await page.click('#ai-generate');
    await expect(page.locator('#ai-dialog')).toHaveClass(HIDDEN, { timeout: 10_000 });

    const after = await saveAndRead(page, 'hebrew');
    // Current label size kept (default mode), Hebrew preserved and marked RTL
    expect(after.labelSize).toEqual(before.labelSize);
    const title = after.elements.find((e: any) => e.type === 'text' && e.text.includes('גלידת'));
    expect(title.text).toBe('גלידת חלבון 150 גרם');
    expect(title.direction).toBe('rtl');

    // RTL toggle reflects the element in the properties panel
    await page.click('#elements-btn');
    await page.locator('.element-list-item', { hasText: 'גלידת' }).click();
    await expect(page.locator('#prop-rtl')).toBeChecked();
    await expect(page.locator('#prop-text-content')).toHaveAttribute('dir', 'rtl');
  });

  test('cancel aborts an in-flight request without changing the design', async ({ page }) => {
    await page.route(OPENAI_URL, async () => {
      // Never respond; the client must abort.
    });
    await openAIDialog(page);
    await page.fill('#ai-api-key', FAKE_KEY);
    await page.fill('#ai-prompt', 'Cable label DEVICE-12 port ETH0');
    await page.click('#ai-generate');
    await expect(page.locator('#ai-progress')).not.toHaveClass(HIDDEN);
    await expect(page.locator('#ai-generate')).toBeDisabled();
    await page.click('#ai-cancel');
    await expect(page.locator('#ai-progress')).toHaveClass(HIDDEN);
    await expect(page.locator('#ai-generate')).toBeEnabled();
    const saved = await saveAndRead(page, 'cancelled');
    expect(saved.elements.length).toBe(0);
  });

  test('remembered key is stored only on opt-in and can be forgotten', async ({ page }) => {
    await page.route(OPENAI_URL, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(responsesPayload(fixture('warehouse-label.json'))),
    }));
    await openAIDialog(page);
    await page.fill('#ai-api-key', FAKE_KEY);
    await page.check('#ai-remember-key');
    await page.fill('#ai-prompt', 'warehouse label');
    await page.click('#ai-generate');
    await expect(page.locator('#ai-dialog')).toHaveClass(HIDDEN, { timeout: 10_000 });
    expect(await page.evaluate(() => localStorage.getItem('phomymo_openai_api_key'))).toBe(FAKE_KEY);

    await openAIDialog(page);
    await expect(page.locator('#ai-api-key')).toHaveValue(FAKE_KEY);
    await expect(page.locator('#ai-forget-key')).not.toHaveClass(HIDDEN);
    await page.click('#ai-forget-key');
    await expect(page.locator('#ai-api-key')).toHaveValue('');
    expect(await page.evaluate(() => localStorage.getItem('phomymo_openai_api_key'))).toBeNull();
  });

  test('existing designs without AI fields still load and render (backward compatibility)', async ({ page }) => {
    const legacy = {
      elements: [
        { id: 'el_legacy1', type: 'text', x: 10, y: 10, width: 150, height: 40, rotation: 0, text: 'Legacy', fontSize: 24, align: 'left' },
        { id: 'el_legacy2', type: 'qr', x: 200, y: 20, width: 80, height: 80, rotation: 0, qrData: 'https://example.com' },
      ],
      labelSize: { width: 40, height: 30 },
    };
    await page.evaluate((d) => {
      localStorage.setItem('phomymo_designs', JSON.stringify({ legacy: { ...d, savedAt: Date.now() } }));
    }, legacy);
    await page.click('#load-btn');
    await page.locator('#load-dialog').getByText('legacy', { exact: true }).click();
    await page.waitForTimeout(300);
    const saved = await saveAndRead(page, 'legacy-resaved');
    expect(saved.elements).toEqual(legacy.elements);
    await page.click('#elements-btn');
    await page.locator('.element-list-item', { hasText: 'Legacy' }).click();
    await expect(page.locator('#prop-rtl')).not.toBeChecked();
  });
});
