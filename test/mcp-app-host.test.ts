/**
 * Headless MCP Apps host. It iframes the real browser widget, speaks the
 * ui/initialize bridge, and applies the CSP shapes hosts derive from
 * resourceDomains. CI supplies Chrome; local runs can set CHROME_PATH.
 */
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import widgetHtml from '../src/browser-widget.html';
import searchWidgetHtml from '../src/search-widget.html';

const ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function png(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const row = 1 + width * 4;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y += 1) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * row + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type), 0);
    body.set(data, 4);
    const out = new Uint8Array(8 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    view.setUint32(4 + body.length, (crc ^ 0xffffffff) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = chunk('IDAT', new Uint8Array(deflateSync(raw)));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), idat, chunk('IEND', new Uint8Array())];
  const image = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { image.set(part, offset); offset += part.length; }
  return image;
}

const TWO_PIXEL = png(2, 2, Uint8Array.from([
  10, 20, 30, 255, 10, 20, 30, 255,
  40, 50, 60, 255, 40, 50, 60, 255,
]));

function chromePath(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

const executablePath = chromePath();

function hostPage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<iframe id="app" sandbox="allow-scripts allow-forms" style="width:900px;height:1200px;border:0"></iframe>
<script>
  const frame = document.querySelector('#app');
  window.__calls = [];
  window.__sizes = [];
  window.__initialized = false;
  window.__reply = null;
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method === 'ui/initialize' && message.id !== undefined) {
      frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params && message.params.protocolVersion,
        hostCapabilities: {},
        hostInfo: { name: 'harness', version: '1' },
        hostContext: { theme: 'dark', displayMode: 'inline' },
      } }, '*');
      return;
    }
    if (message.method === 'ui/notifications/size-changed') {
      window.__sizes.push(message.params);
      if (window.__resize) frame.style.height = message.params.height + 'px';
      return;
    }
    if (message.method === 'ui/notifications/initialized') { window.__initialized = true; return; }
    if (message.method === 'tools/call' && message.id !== undefined) {
      window.__calls.push(message.params);
      if (window.__dropToolReply) return;
      if (window.__missingToolMethod) { frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }, '*'); return; }
      const result = window.__reply ? window.__reply(message.params) : { isError: true, content: [{ type: 'text', text: 'No harness reply.' }] };
      frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
      frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: message.params.arguments } }, '*');
      frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
    }
  });
  window.__deliver = (input, result) => {
    frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: input } }, '*');
    frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
  };
  window.__load = (src) => { frame.src = src; };
</script>`;
}

type WidgetFrame = {
  url: () => string;
  evaluate: <T>(fn: () => T) => Promise<T>;
  waitForFunction: (fn: () => unknown, options?: { timeout?: number }) => Promise<unknown>;
  type: (selector: string, text: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
};
type HostPage = {
  goto: (url: string, options: { waitUntil: 'domcontentloaded' }) => Promise<unknown>;
  evaluate: (fn: (arg: any) => unknown, arg?: any) => Promise<any>;
  waitForFunction: (fn: () => unknown, options?: { timeout?: number }) => Promise<unknown>;
  frames: () => WidgetFrame[];
  close: () => Promise<void>;
};

describe('MCP Apps browser widget host', () => {
  let server: Server;
  let origin = '';
  let browser: { newPage: () => Promise<HostPage>; close: () => Promise<void> } | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
      if (url.pathname === '/shot.png') {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        response.end(TWO_PIXEL);
        return;
      }
      if (url.pathname === '/widget') {
        const policy = url.searchParams.get('csp') || "default-src 'none'";
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': policy,
        });
        response.end(url.searchParams.get('kind') === 'search' ? searchWidgetHtml : widgetHtml);
        return;
      }
      if (url.pathname === '/host') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(hostPage());
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test host did not bind a port.');
    origin = `http://127.0.0.1:${address.port}`;
    if (!executablePath) return;
    const puppeteer = await import('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      timeout: 45_000,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
      ],
    }) as { newPage: () => Promise<HostPage>; close: () => Promise<void> };
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }, 30_000);

  async function openWidget(csp: string, kind = 'browser') {
    if (!browser) throw new Error('Chrome is not available.');
    const page = await browser.newPage();
    await page.goto(`${origin}/host`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((src) => (window as unknown as { __load: (value: string) => void }).__load(src), `${origin}/widget?kind=${kind}&csp=${encodeURIComponent(csp)}`);
    await page.waitForFunction(() => (window as unknown as { __initialized?: boolean }).__initialized, { timeout: 8000 });
    const frame = page.frames().find((entry) => entry.url().includes('/widget'));
    if (!frame) throw new Error('Widget frame was not created.');
    return { page, frame };
  }

  function toolResult(sessionID: string, shot: Record<string, unknown>, pageInfo = { url: 'https://example.com/agent', title: 'Agent page', text: 'hello' }) {
    return {
      content: [{ type: 'text', text: 'loaded' }],
      structuredContent: { responses: [{ actionIndex: 0, sessionID, ok: true, response: { action: 'navigate', page: pageInfo } }] },
      _meta: { ui: { screenshots: [{ sessionID, mimeType: 'image/png', ...shot }] } },
    };
  }

  const live = executablePath ? it : it.skip;

  live('displays a batch of HTTP results without running the returned HTML or repeating the requests', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    const result = {
      isError: true,
      structuredContent: { kind: 'http', responses: [
        { actionIndex: 0, ok: true, response: {
          request: { method: 'GET', url: 'https://example.com/' },
          response: { status: 200, statusText: 'OK', url: 'https://example.com/', bodyBytes: 42 },
          body: '<img src=x onerror="alert(1)">',
        } },
        { actionIndex: 1, ok: false, error: 'Blocked private address' },
      ] },
    };
    await page.evaluate((result) => (window as any).__deliver({}, result), result);
    await frame.waitForFunction(() => document.documentElement.dataset.view === 'http');
    const output = await frame.evaluate(() => document.querySelector<HTMLElement>('#http-responses')!.innerText);
    expect(output).toContain('GET 200 OK');
    expect(output).toContain('<img src=x onerror="alert(1)">');
    expect(output).toContain('Blocked private address');
    expect(await frame.evaluate(() => document.querySelector('#http-responses img') === null)).toBe(true);
    expect(await page.evaluate(() => (window as any).__calls)).toEqual([]);
    await page.close();
  });

  live('populates the HTTP request and response from split ChatGPT globals on opening the widget', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:");
    await frame.evaluate(() => {
      const request = { method: 'POST', url: 'https://example.org/requested' };
      const result = { kind: 'http', responses: [{ ok: true, actionIndex: 0, response: {
        request, response: { status: 201, url: 'https://example.org/redirected', bodyBytes: 7 }, body: 'created',
      } }] };
      const deliver = (globals: unknown) => window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
      deliver({ toolResponseMetadata: { call_tool_result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
      deliver({ toolResponseMetadata: { ui: { screenshots: [{ actionIndex: 0, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] } } });
      deliver({ toolInput: { actions: [{ ...request, body: 'original body' }] } });
    });
    await frame.waitForFunction(() => document.querySelector<HTMLImageElement>('#http-responses img')?.naturalWidth === 1);
    expect(await frame.evaluate(() => ({
      url: document.querySelector<HTMLInputElement>('#http-responses input')!.value,
      body: document.querySelector<HTMLTextAreaElement>('#http-responses [data-field="body"]')!.value,
      response: document.querySelector('#http-responses section > pre')!.textContent,
      status: document.querySelector('#http-responses h2')!.textContent,
      browserHidden: document.querySelector<HTMLElement>('#browser-view')!.hidden,
    }))).toEqual({ url: 'https://example.org/requested', body: 'original body', response: 'created', status: 'POST 201', browserHidden: true });
    expect(await page.evaluate(() => (window as any).__calls)).toEqual([]);
    await page.close();
  });

  live('keeps HTTP images and focused fields intact across host layout updates', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:");
    await frame.evaluate(() => {
      const globals = {
        toolInput: { actions: [{ url: 'https://example.org/', method: 'GET' }] },
        toolOutput: { kind: 'http', responses: [{ ok: true, actionIndex: 0, response: {
          request: { method: 'GET', url: 'https://example.org/' },
          response: { status: 200, bodyBytes: 2 }, body: 'ok',
        } }] },
        toolResponseMetadata: { ui: { screenshots: [{ actionIndex: 0, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] } },
      };
      (window as any).openai = globals;
      window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
    });
    await frame.waitForFunction(() => document.querySelector<HTMLImageElement>('#http-responses img')?.naturalWidth === 1);
    const stable = await frame.evaluate(async () => {
      const image = document.querySelector('#http-responses img');
      const field = document.querySelector<HTMLInputElement>('#http-responses input')!;
      field.focus();
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(document.querySelector('#http-responses')!, { subtree: true, childList: true, attributes: true });
      for (let i = 0; i < 40; i += 1) {
        window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { maxHeight: 600 + i, theme: 'dark' } } }));
      }
      // Some hosts resend a complete snapshot, with unchanged tool objects.
      window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: (window as any).openai } }));
      window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: JSON.parse(JSON.stringify((window as any).openai)) } }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      observer.disconnect();
      return { sameImage: image === document.querySelector('#http-responses img'), focused: document.activeElement === field, mutations };
    });
    expect(stable).toEqual({ sameImage: true, focused: true, mutations: 0 });
    expect(await page.evaluate(() => (window as any).__calls)).toEqual([]);
    await page.close();
  });

  for (const kind of ['browser', 'search']) {
    live(`reports intrinsic ${kind} height and settles after content grows and shrinks`, async () => {
      const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'", kind);
      await page.waitForFunction(() => (window as any).__sizes.length > 0);
      const initial = await page.evaluate(() => (window as any).__sizes.at(-1));
      expect(initial.height).toBeLessThan(900); // The host initially allocates 1200px.
      expect(initial.width).toBeUndefined(); // The host owns the available width.
      await page.evaluate(() => {
        (window as any).__resize = true;
        document.querySelector<HTMLIFrameElement>('#app')!.style.height = (window as any).__sizes.at(-1).height + 'px';
      });
      await frame.evaluate(() => {
        (window as any).__legacySizes = 0;
        (window as any).openai = { notifyIntrinsicHeight() { (window as any).__legacySizes += 1; } };
        const block = document.createElement('div');
        block.id = 'growth';
        block.style.height = '1600px';
        document.body.appendChild(block);
      });
      await page.waitForFunction(() => (window as any).__sizes.at(-1).height > 1600);
      await frame.evaluate(() => document.querySelector('#growth')!.remove());
      await page.waitForFunction(() => (window as any).__sizes.at(-1).height < 900);
      const before = await page.evaluate(() => (window as any).__sizes.length);
      await frame.evaluate(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
      expect(await page.evaluate(() => (window as any).__sizes.length)).toBe(before);
      expect(await page.evaluate(() => (window as any).__sizes.at(-1).height)).toBe(initial.height);
      expect(await frame.evaluate(() => (window as any).__legacySizes)).toBe(0);
      await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#app')!.contentWindow!.postMessage({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' }, '*'));
      await frame.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        document.body.style.paddingBottom = '1900px';
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(await page.evaluate(() => (window as any).__sizes.length)).toBe(before);
      await page.close();
    });
  }

  live('opens populated HTTP requests and sends edited methods, headers and bodies only on submit', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    await page.evaluate(() => {
      const request = { url: 'https://example.org/original', method: 'GET' };
      (window as any).__deliver({ actions: [{ url: request.url, followRedirects: false, maxDurationMs: 4321, maxResponseBytes: 1234 }] }, {
        structuredContent: { kind: 'http', responses: [{ actionIndex: 0, ok: true, response: {
          request, response: { status: 200, bodyBytes: 5 }, body: 'saved',
        } }] },
      });
      (window as any).__reply = (params: any) => ({ structuredContent: { kind: 'http', responses: params.arguments.actions.map((request: any, actionIndex: number) => ({
        actionIndex, ok: true, response: { request, response: { status: 201, bodyBytes: 5 }, body: 'fresh' },
      })) } });
    });
    await frame.waitForFunction(() => document.querySelector('#http-responses section > pre')?.textContent === 'saved');
    expect(await page.evaluate(() => (window as any).__calls)).toEqual([]);
    expect(await frame.evaluate(() => document.querySelector<HTMLInputElement>('[data-field="url"]')!.value)).toBe('https://example.org/original');
    await frame.evaluate(() => {
      const set = (key: string, value: string) => { document.querySelector<HTMLInputElement>('[data-field="' + key + '"]')!.value = value; };
      set('url', 'https://example.org/edited');
      set('method', 'PROPFIND');
      set('headers', JSON.stringify({ 'Content-Type': 'application/xml', 'X-Test': 'edited' }));
      set('body', '<query/>');
      const form = document.querySelector<HTMLFormElement>('#http-form')!;
      form.requestSubmit();
      form.requestSubmit(); // A double click must not duplicate the request.
    });
    await frame.waitForFunction(() => document.querySelector('#request-status')?.textContent === 'Request complete.');
    const expected = { url: 'https://example.org/edited', method: 'PROPFIND', headers: { 'Content-Type': 'application/xml', 'X-Test': 'edited' }, body: '<query/>', followRedirects: false, maxDurationMs: 4321, maxResponseBytes: 1234 };
    expect(await page.evaluate(() => (window as any).__calls)).toEqual([{ name: 'servo_http_request', arguments: { actions: [expected] } }]);
    expect(await frame.evaluate(() => document.querySelector('#http-responses section > pre')!.textContent)).toBe('fresh');
    // The same populated form can send another request, including after an error.
    await page.evaluate(() => { (window as any).__reply = () => ({ isError: true, content: [{ type: 'text', text: 'Request rejected' }] }); });
    await frame.click('#send-request');
    await frame.waitForFunction(() => document.querySelector('#request-status')?.textContent === 'Request rejected');
    expect(await frame.evaluate(() => document.querySelector<HTMLTextAreaElement>('[data-field="body"]')!.value)).toBe('<query/>');
    await frame.click('#send-request');
    await page.waitForFunction(() => (window as any).__calls.length === 3);
    await page.close();
  });

  live('reuses implicitly created HTTP sessions while preserving explicit falsy IDs', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    const existing = '00000000-0000-4000-8000-000000000001';
    const fresh = '00000000-0000-4000-8000-000000000002';
    await page.evaluate(({ existing, fresh }) => {
      const actions = [
        { url: 'https://example.org/a', method: 'GET' },
        { sessionID: null, url: 'https://example.org/b', method: 'GET' },
      ];
      const responses = actions.map((request, actionIndex) => ({
        actionIndex, sessionID: actionIndex === 0 ? existing : fresh, ok: true,
        response: { request, response: { status: 200, bodyBytes: 2 }, body: 'ok' },
      }));
      (window as any).__deliver({ actions }, { structuredContent: { kind: 'http', responses } });
    }, { existing, fresh });
    await frame.waitForFunction(() => document.querySelector('#send-request')?.textContent === 'Send 2 requests');
    expect(await frame.evaluate(() => [...document.querySelectorAll('#http-responses section p')]
      .map((p) => p.textContent).filter((text) => text?.startsWith('Servo session:'))))
      .toEqual(['Servo session: ' + existing, 'Servo session: ' + fresh]);
    await frame.click('#send-request');
    await page.waitForFunction(() => (window as any).__calls.length > 0);
    const actions = await page.evaluate(() => (window as any).__calls[0].arguments.actions);
    expect(actions[0].sessionID).toBe(existing);
    expect(actions[1].sessionID).toBeNull();
    await page.close();
  });

  live('labels and preserves all actions when resending a populated batch', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    await page.evaluate(() => {
      const actions = [{ url: 'https://example.org/a', method: 'GET' }, { url: 'https://example.org/b', method: 'POST', headers: { 'X-Test': 'batch' }, body: 'original body' }];
      const result = { structuredContent: { kind: 'http', responses: actions.map((request, actionIndex) => ({ actionIndex, ok: true, response: { request, response: { status: 200 }, body: 'saved ' + actionIndex } })) } };
      (window as any).__deliver({ actions }, result);
      (window as any).__reply = () => result;
    });
    await frame.waitForFunction(() => document.querySelector('#send-request')?.textContent === 'Send 2 requests');
    expect(await page.evaluate(() => (window as any).__calls)).toEqual([]);
    await frame.click('#send-request');
    await frame.waitForFunction(() => document.querySelector('#request-status')?.textContent === 'Request complete.');
    expect(await page.evaluate(() => (window as any).__calls)).toEqual([{ name: 'servo_http_request', arguments: { actions: [
      { url: 'https://example.org/a', method: 'GET' },
      { url: 'https://example.org/b', method: 'POST', headers: { 'X-Test': 'batch' }, body: 'original body' },
    ] } }]);
    await page.close();
  });

  live('shows the hosted screenshot when data URLs are blocked and fills the URL from tool input', async () => {
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${origin}`;
    const { page, frame } = await openWidget(csp);
    const hidden = await frame.evaluate(() => ({
      src: document.querySelector('#preview')?.getAttribute('src') ?? null,
      display: getComputedStyle(document.querySelector('#preview')!).display,
    }));
    expect(hidden).toEqual({ src: null, display: 'none' });
    const sessionID = '00000000-0000-4000-8000-000000000001';
    await page.evaluate((payload) => (window as unknown as { __deliver: (input: unknown, result: unknown) => void }).__deliver(payload.input, payload.result), {
      input: { actions: [{ url: 'https://example.com/agent', sessionID }] },
      result: toolResult(sessionID, { url: `${origin}/shot.png`, byteLength: TWO_PIXEL.length }),
    });
    await frame.waitForFunction(() => document.querySelector<HTMLImageElement>('#preview')?.dataset.state === 'loaded');
    const view = await frame.evaluate(() => ({
      url: (document.querySelector('#url') as HTMLInputElement).value,
      session: document.querySelector('#session-id')?.textContent,
      width: (document.querySelector('#preview') as HTMLImageElement).naturalWidth,
      src: (document.querySelector('#preview') as HTMLImageElement).currentSrc,
      status: document.querySelector('#status')?.textContent,
      theme: document.documentElement.style.colorScheme,
    }));
    expect(view.url).toBe('https://example.com/agent');
    expect(view.session).toBe(sessionID);
    expect(view.width).toBe(2);
    expect(view.src).toBe(`${origin}/shot.png`);
    expect(view.status).toBe('Agent page');
    expect(view.theme).toBe('dark');
    await page.close();
  });

  live('falls back to inline PNG bytes when the resource origin is blocked', async () => {
    const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
    const { page, frame } = await openWidget(csp);
    const sessionID = '00000000-0000-4000-8000-000000000001';
    await page.evaluate((payload) => (window as unknown as { __deliver: (input: unknown, result: unknown) => void }).__deliver(payload.input, payload.result), {
      input: { actions: [{ url: 'https://example.com/inline' }] },
      result: toolResult(sessionID, {
        url: `${origin}/shot.png`,
        data: ONE_PIXEL.toString('base64'),
        byteLength: ONE_PIXEL.length,
      }, { url: 'https://example.com/inline', title: 'Inline', text: 'x' }),
    });
    await frame.waitForFunction(() => document.querySelector<HTMLImageElement>('#preview')?.dataset.state === 'loaded');
    const width = await frame.evaluate(() => (document.querySelector('#preview') as HTMLImageElement).naturalWidth);
    const src = await frame.evaluate(() => (document.querySelector('#preview') as HTMLImageElement).currentSrc);
    expect(width).toBe(1);
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    await page.close();
  });

  live('uses the hosted PNG when inline bytes are not an image', async () => {
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: ${origin}`;
    const { page, frame } = await openWidget(csp);
    const sessionID = '00000000-0000-4000-8000-000000000001';
    await page.evaluate((payload) => (window as unknown as { __deliver: (input: unknown, result: unknown) => void }).__deliver(payload.input, payload.result), {
      input: { actions: [{ html: '<p>Hi</p>' }] },
      result: toolResult(sessionID, { url: `${origin}/shot.png`, data: 'AAAA', byteLength: 4 }),
    });
    await frame.waitForFunction(() => (document.querySelector('#preview') as HTMLImageElement).naturalWidth === 2);
    await page.close();
  });

  live('renders a screenshot that arrives only as an MCP image content block', async () => {
    const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
    const { page, frame } = await openWidget(csp);
    const sessionID = '00000000-0000-4000-8000-000000000001';
    await page.evaluate((payload) => (window as unknown as { __deliver: (input: unknown, result: unknown) => void }).__deliver(payload.input, payload.result), {
      input: { actions: [{ url: 'https://example.com/content' }] },
      result: {
        content: [
          { type: 'text', text: 'loaded' },
          { type: 'image', mimeType: 'image/png', data: ONE_PIXEL.toString('base64') },
        ],
        structuredContent: {
          responses: [{ actionIndex: 0, sessionID, ok: true, response: { page: { url: 'https://example.com/content', title: 'Content', text: 'x' } } }],
        },
      },
    });
    await frame.waitForFunction(() => document.querySelector<HTMLImageElement>('#preview')?.naturalWidth === 1);
    const src = await frame.evaluate(() => document.querySelector<HTMLImageElement>('#preview')?.currentSrc ?? '');
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    await page.close();
  });

  live('keeps the selected session and its image together in a mixed batch', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'; img-src data:");
    const selected = '00000000-0000-4000-8000-000000000002';
    const result = {
      isError: true,
      structuredContent: { responses: [
        { sessionID: 'other', ok: true, response: { imageIndex: 0 } },
        { sessionID: selected, ok: true, response: { imageIndex: 1, page: { title: 'Selected tab' } } },
        { sessionID: 'failed', ok: false, error: 'Unrelated error' },
      ] },
      content: [
        { type: 'text', text: 'Two screenshots' },
        { type: 'image', mimeType: 'image/png', data: ONE_PIXEL.toString('base64') },
        { type: 'image', mimeType: 'image/png', data: Buffer.from(TWO_PIXEL).toString('base64') },
      ],
    };
    await page.evaluate(({ input, result }) => (window as unknown as { __deliver(input: unknown, result: unknown): void }).__deliver(input, result), {
      input: { actions: [{ sessionID: selected }] }, result,
    });
    await frame.waitForFunction(() => document.querySelector<HTMLImageElement>('#preview')?.dataset.state === 'loaded');
    expect(await frame.evaluate(() => document.querySelector<HTMLImageElement>('#preview')!.naturalWidth)).toBe(2);
    expect(await frame.evaluate(() => document.querySelector('#status')!.textContent)).toBe('Selected tab');
    await page.close();
  });

  live('rejects an empty search and uses the host fallback for a missing bridge method', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'", 'search');
    await frame.click('#search');
    await frame.waitForFunction(() => document.querySelector('#status')?.textContent === 'Enter a search query.');
    expect(await page.evaluate(() => (window as unknown as { __calls: unknown[] }).__calls)).toEqual([]);
    await page.evaluate(() => { (window as unknown as { __missingToolMethod: boolean }).__missingToolMethod = true; });
    await frame.evaluate(() => {
      (window as unknown as { openai: unknown }).openai = {
        async callTool(name: string, args: { actions: Array<{ query: string }> }) {
          return { structuredContent: { responses: [{
            actionIndex: 0, sessionID: 'mock-browser', ok: true,
            response: { results: [{ title: name + ': ' + args.actions[0].query, url: 'https://example.org' }] },
          }] } };
        },
      };
    });
    await frame.type('#query', '  servo  ');
    await frame.click('#search');
    await frame.waitForFunction(() => document.querySelector('#results a')?.textContent === 'servo_web_search: servo');
    await page.close();
  });

  live('renders ordered batched Servo search results and reads the first input action', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'", 'search');
    await page.evaluate(() => {
      (window as any).__deliver({ actions: [
        { query: 'servo wasm', provider: 'bing', sessionID: null },
        { query: 'mcp', provider: 'brave', sessionID: false },
      ] }, { structuredContent: { responses: [
        { actionIndex: 0, sessionID: 'first', ok: true, response: {
          results: [{ title: 'Servo', url: 'https://example.com/servo', snippet: 'Engine' }],
        } },
        { actionIndex: 1, sessionID: 'second', ok: true, response: {
          results: [{ title: 'MCP', url: 'https://example.com/mcp', snippet: 'Protocol' }],
        } },
      ] } });
    });
    await frame.waitForFunction(() => document.querySelectorAll('#results a').length === 2);
    expect(await frame.evaluate(() => [...document.querySelectorAll('#results a')].map((link) => link.textContent)))
      .toEqual(['Servo', 'MCP']);
    expect(await frame.evaluate(() => document.querySelector<HTMLInputElement>('#query')!.value)).toBe('servo wasm');
    await page.close();
  });

  live('recovers from an unanswered search without leaving its button disabled', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'", 'search');
    await page.evaluate(() => { (window as unknown as { __dropToolReply: boolean }).__dropToolReply = true; });
    await frame.evaluate(() => {
      const clock: { setTimeout(callback: TimerHandler, delay?: number, ...args: unknown[]): number } = window;
      const timer = clock.setTimeout.bind(window);
      // Advance only this transport deadline. Keep the real message bridge and event loop.
      clock.setTimeout = (callback, delay, ...args) => timer(callback, delay === 30_000 ? 1 : delay, ...args);
      (window as unknown as { openai: unknown }).openai = {
        async callTool() { return { structuredContent: { responses: [{ actionIndex: 0, sessionID: 'mock-browser', ok: true, response: { results: [] } }] } }; },
      };
    });
    await frame.type('#query', 'servo');
    await frame.click('#search');
    await frame.waitForFunction(() => document.querySelector('#status')?.textContent === 'No results found.');
    expect(await frame.evaluate(() => document.querySelector<HTMLButtonElement>('#search')?.disabled)).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { __calls: unknown[] }).__calls.length)).toBe(1);
    await page.close();
  });

  live('displays rejected loads and retries without adopting a failed session ID', async () => {
    const { page, frame } = await openWidget("default-src 'none'; script-src 'unsafe-inline'");
    await page.evaluate(() => {
      let attempt = 0;
      (window as unknown as { __reply: () => unknown }).__reply = () => ++attempt === 1
        ? { isError: true, structuredContent: { responses: [{ sessionID: 'uncreated', ok: false, error: 'Blocked URL' }] } }
        : { isError: true, content: [{ type: 'text', text: 'Invalid arguments' }] };
    });
    await frame.type('#url', 'https://example.com/');
    await frame.click('#load');
    await frame.waitForFunction(() => document.querySelector('#status')?.textContent === 'Blocked URL');
    await frame.click('#load');
    await frame.waitForFunction(() => document.querySelector('#status')?.textContent === 'Invalid arguments');
    const calls = await page.evaluate(() => (window as unknown as { __calls: unknown[] }).__calls);
    expect(calls).toEqual(Array(2).fill({ name: 'servo_navigate', arguments: { actions: [{ url: 'https://example.com/' }] } }));
    await page.close();
  });

  live('navigates from the URL field, runs the page script, and refreshes the screenshot', async () => {
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: ${origin}`;
    const { page, frame } = await openWidget(csp);
    const sessionID = '00000000-0000-4000-8000-000000000009';
    await page.evaluate((reply) => {
      (window as unknown as { __reply: (params: { name: string; arguments: { actions: Array<Record<string, string>> } }) => unknown }).__reply = (params) => {
        const action = params.arguments.actions[0];
        if (params.name === 'servo_navigate') {
          return {
            content: [{ type: 'text', text: 'navigated' }],
            structuredContent: { responses: [{ actionIndex: 0, sessionID: reply.sessionID, ok: true, response: { action: 'navigate', page: { url: action.url, title: 'Next', text: 'next' } } }] },
            _meta: { ui: { screenshots: [{ sessionID: reply.sessionID, mimeType: 'image/png', data: reply.small, byteLength: 1 }] } },
          };
        }
        if (params.name === 'servo_evaluate') {
          return {
            content: [{ type: 'text', text: 'evaluated' }],
            structuredContent: { responses: [{ actionIndex: 0, sessionID: action.sessionID, ok: true, response: { action: 'evaluate', page: { url: 'https://example.com/next', title: 'Evaluated', text: action.script } } }] },
          };
        }
        return {
          content: [{ type: 'text', text: 'shot' }, { type: 'image', data: reply.small, mimeType: 'image/png' }],
          structuredContent: { responses: [{ actionIndex: 0, sessionID: action.sessionID, ok: true, response: { page: { url: 'https://example.com/next', title: 'Evaluated', text: 'done' }, imageIndex: 0 } }] },
          _meta: { ui: { screenshots: [{ sessionID: action.sessionID, mimeType: 'image/png', url: reply.shot, byteLength: 2 }] } },
        };
      };
    }, { sessionID, small: ONE_PIXEL.toString('base64'), shot: `${origin}/shot.png` });
    await frame.evaluate(() => {
      const url = document.querySelector<HTMLInputElement>('#url');
      const script = document.querySelector<HTMLTextAreaElement>('#script');
      if (!url || !script) throw new Error('Form fields are missing.');
      url.value = 'https://example.com/next';
      url.dispatchEvent(new Event('input', { bubbles: true }));
      script.value = 'document.title';
      script.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLFormElement>('#browser-form')?.requestSubmit();
    });
    try {
      await frame.waitForFunction(() => (document.querySelector<HTMLImageElement>('#preview'))?.naturalWidth === 2, { timeout: 8000 });
    } catch (error) {
      const state = await frame.evaluate(() => ({
        status: document.querySelector('#status')?.textContent,
        session: document.querySelector('#session-id')?.textContent,
        src: document.querySelector<HTMLImageElement>('#preview')?.currentSrc,
        width: document.querySelector<HTMLImageElement>('#preview')?.naturalWidth,
        state: document.querySelector<HTMLImageElement>('#preview')?.dataset.state,
      }));
      const calls = await page.evaluate(() => (window as unknown as { __calls: unknown[] }).__calls);
      throw new Error(`${error instanceof Error ? error.message : error} state=${JSON.stringify(state)} calls=${JSON.stringify(calls)}`);
    }
    const calls = await page.evaluate(() => (window as unknown as { __calls: Array<{ name: string; arguments: { actions: Array<Record<string, string>> } }> }).__calls) as Array<{ name: string; arguments: { actions: Array<Record<string, string>> } }>;
    expect(calls.map((call) => call.name)).toEqual(['servo_navigate', 'servo_evaluate', 'servo_screenshot']);
    expect(calls[0].arguments.actions[0].url).toBe('https://example.com/next');
    expect(calls[1].arguments.actions[0]).toMatchObject({ sessionID, script: 'document.title' });
    expect(calls[2].arguments.actions[0].sessionID).toBe(sessionID);
    const view = await frame.evaluate(() => ({
      session: document.querySelector('#session-id')?.textContent,
      status: document.querySelector('#status')?.textContent,
      script: (document.querySelector('#script') as HTMLTextAreaElement).value,
      src: (document.querySelector('#preview') as HTMLImageElement).currentSrc,
    }));
    expect(view.session).toBe(sessionID);
    expect(view.script).toBe('document.title');
    expect(view.status).toBe('Evaluated');
    expect(view.src).toBe(`${origin}/shot.png`);
    await page.close();
  }, 20_000);
});
