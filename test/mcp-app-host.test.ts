/**
 * Headless MCP Apps host. It iframes the real browser widget, speaks the
 * ui/initialize bridge, and applies the CSP shapes hosts derive from
 * resourceDomains. Chrome is optional so CI without a browser still runs the
 * rest of the suite; this environment has Chrome and executes the cases.
 */
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import widgetHtml from '../src/browser-widget.html';

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
    if (message.method === 'ui/notifications/initialized') { window.__initialized = true; return; }
    if (message.method === 'tools/call' && message.id !== undefined) {
      window.__calls.push(message.params);
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
        response.end(widgetHtml);
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
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }) as { newPage: () => Promise<HostPage>; close: () => Promise<void> };
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function openWidget(csp: string) {
    if (!browser) throw new Error('Chrome is not available.');
    const page = await browser.newPage();
    await page.goto(`${origin}/host`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((src) => (window as unknown as { __load: (value: string) => void }).__load(src), `${origin}/widget?csp=${encodeURIComponent(csp)}`);
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
