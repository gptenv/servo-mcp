import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import servoWasm from '../servo-wasm/target/wasm32-unknown-unknown/production-stripped/servo_js_wasm.wasm';
import widgetHtml from './browser-widget.html';
import { createServoWorkerRuntime } from '../servo-wasm/ports/servo-js-wasm/worker-adapter.mjs';
import { assertPublicHttpUrl, assertPublicWebSocketUrl } from './security';

const WIDGET_URI = 'ui://servo/browser.html';
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_ACTIONS = 20;
const MAX_TOOL_DURATION_MS = 15_000;
const pageAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('evaluate'), script: z.string().max(MAX_SCRIPT_BYTES) }),
  z.object({ type: z.literal('click'), x: z.number().finite(), y: z.number().finite(), button: z.number().int().min(0).max(4).optional() }),
  z.object({ type: z.literal('type'), text: z.string().max(4096) }),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal('scroll'), deltaX: z.number().finite(), deltaY: z.number().finite(), x: z.number().finite().optional(), y: z.number().finite().optional() }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('forward') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('wait'), maxDurationMs: z.number().int().min(0).max(MAX_TOOL_DURATION_MS).optional() }),
  z.object({ type: z.literal('screenshot'), fullPage: z.boolean().optional() }),
  z.object({ type: z.literal('snapshot') }),
]);

const inputSchema = z.object({
  url: z.string().url().max(2048).optional(),
  html: z.string().max(MAX_HTML_BYTES).optional(),
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(240).max(1600).default(720),
  actions: z.array(pageAction).max(MAX_ACTIONS).default([]),
  fontBase64: z.string().max(44_739_244).optional(),
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000),
});

type PageAction = z.infer<typeof pageAction>;

async function publicFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = assertPublicHttpUrl(input instanceof Request ? input.url : String(input));
  return fetch(url, { ...init, redirect: 'manual' });
}

function publicWebSocket(url: string, protocols?: string | string[]): WebSocket {
  const target = assertPublicWebSocketUrl(url);
  return new WebSocket(target, protocols);
}

function pageSummaryExpression(): string {
  return `JSON.stringify({url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 20000)})`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function pump(runtime: Awaited<ReturnType<typeof createServoWorkerRuntime>>, maxDurationMs: number) {
  const status = await runtime.pumpUntilSettled({
    maxDurationMs,
    maxTurns: 2_000,
    networkIdleMs: 250,
  });
  if (!status.settled) throw new Error(`Servo did not settle within ${maxDurationMs} ms.`);
  return status;
}

async function evaluate(runtime: Awaited<ReturnType<typeof createServoWorkerRuntime>>, script: string,
  maxDurationMs: number) {
  if (!runtime.evaluatePage(script)) throw new Error('Servo rejected this page evaluation.');
  await pump(runtime, maxDurationMs);
  return runtime.pageResult();
}

function parseJsonEvaluationResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('Ok' in result)) return result;
  const value = (result as { Ok?: { String?: unknown } }).Ok?.String;
  if (typeof value !== 'string') return result;
  try { return JSON.parse(value); } catch { return result; }
}

async function runPage(input: z.infer<typeof inputSchema>) {
  if (!input.url && input.html === undefined) throw new TypeError('Provide either a page URL or HTML.');
  if (input.url) assertPublicHttpUrl(input.url);
  if (input.html !== undefined && new TextEncoder().encode(input.html).byteLength > MAX_HTML_BYTES) {
    throw new RangeError(`Inline HTML exceeds ${MAX_HTML_BYTES} UTF-8 bytes.`);
  }
  const pageUrl = input.url ?? 'https://inline.servo.invalid/';
  const runtime = await createServoWorkerRuntime(servoWasm, {
    width: input.width,
    height: input.height,
    url: 'about:blank',
    fetchImpl: publicFetch,
    webSocketFactory: publicWebSocket,
    maxResponseBytes: 8 * 1024 * 1024,
    maxSubrequests: 50,
    log: (message: string) => console.error(`[servo] ${message.slice(0, 2048)}`),
  });
  const results: Array<{ action: string; result?: unknown; fullPage?: boolean }> = [];
  let screenshotBase64: string | undefined;
  try {
    if (input.html !== undefined) runtime.loadHtml(input.html, { url: pageUrl });
    else runtime.loadPage(pageUrl);
    await pump(runtime, input.maxDurationMs);

    if (input.fontBase64) {
      const binary = atob(input.fontBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      results.push({ action: 'registerFont', result: runtime.registerFont(bytes) });
    }

    for (const action of input.actions as PageAction[]) {
      switch (action.type) {
        case 'evaluate':
          results.push({ action: action.type, result: await evaluate(runtime, action.script, input.maxDurationMs) });
          break;
        case 'click':
          runtime.click(action.x, action.y, action.button ?? 0);
          await pump(runtime, input.maxDurationMs);
          results.push({ action: action.type });
          break;
        case 'type':
          runtime.typeText(action.text);
          await pump(runtime, input.maxDurationMs);
          results.push({ action: action.type });
          break;
        case 'key':
          runtime.pressKey(action.key);
          await pump(runtime, input.maxDurationMs);
          results.push({ action: action.type });
          break;
        case 'scroll':
          runtime.scrollBy(action.deltaX, action.deltaY, { x: action.x, y: action.y });
          await pump(runtime, input.maxDurationMs);
          results.push({ action: action.type });
          break;
        case 'back':
          results.push({ action: action.type, result: runtime.goBack() });
          await pump(runtime, input.maxDurationMs);
          break;
        case 'forward':
          results.push({ action: action.type, result: runtime.goForward() });
          await pump(runtime, input.maxDurationMs);
          break;
        case 'reload':
          results.push({ action: action.type, result: runtime.reload() });
          await pump(runtime, input.maxDurationMs);
          break;
        case 'wait':
          await pump(runtime, action.maxDurationMs ?? input.maxDurationMs);
          results.push({ action: action.type });
          break;
        case 'snapshot':
          results.push({ action: action.type,
            result: parseJsonEvaluationResult(
              await evaluate(runtime, pageSummaryExpression(), input.maxDurationMs),
            ) });
          break;
        case 'screenshot': {
          const png = await runtime.screenshot({ fullPage: action.fullPage ?? false,
            maxDurationMs: input.maxDurationMs });
          screenshotBase64 = toBase64(png);
          results.push({ action: action.type, fullPage: action.fullPage ?? false });
          break;
        }
      }
    }
    const page = await evaluate(runtime, pageSummaryExpression(), input.maxDurationMs);
    return {
      url: pageUrl,
      page: parseJsonEvaluationResult(page),
      results,
      capabilities: runtime.capabilities(),
      screenshot: screenshotBase64,
    };
  } finally {
    runtime.reset();
  }
}

function createServer() {
  const server = new McpServer({ name: 'servo-mcp', version: '0.1.0' }, {
    instructions: 'Use servo_run for isolated headless page loads, DOM inspection, script evaluation, browser input, and screenshots. Every call creates a fresh browser; provide the URL or HTML again on follow-up calls. The engine does not preserve cookies or sessions, does not await returned evaluation promises, and enforces public HTTP(S) networking only.',
  });

  server.registerResource('servo-browser-ui', WIDGET_URI, {
    title: 'Servo browser controls',
    description: 'Load a public web page with Servo WASM and inspect a rendered screenshot.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }, async (uri) => ({ contents: [{ uri: uri.href,
    mimeType: 'text/html;profile=mcp-app', text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));

  server.registerTool('servo_run', {
    title: 'Run Servo browser',
    description: 'Create a fresh Servo WASM browser, load a public HTTP(S) page or supplied HTML, run up to 20 browser actions, inspect the DOM, and optionally return a PNG screenshot. Page scripts run in the page realm. Evaluation is synchronous and returns one serialized value; it does not await JavaScript promises. Network access to private/local addresses is blocked.',
    inputSchema,
    outputSchema: z.object({
      url: z.string(),
      page: z.unknown(),
      results: z.array(z.object({ action: z.string(), result: z.unknown().optional(), fullPage: z.boolean().optional() })),
      capabilities: z.unknown(),
      screenshot: z.string().optional(),
    }),
    _meta: {
      ui: { resourceUri: WIDGET_URI },
      'openai/toolInvocation/invoking': 'Running Servo…',
      'openai/toolInvocation/invoked': 'Page rendered.',
    },
  }, async (args) => {
    try {
      const result = await runPage(args as z.infer<typeof inputSchema>);
      const { screenshot, ...structuredContent } = result;
      return {
        structuredContent,
        content: [
          { type: 'text' as const, text: JSON.stringify(structuredContent) },
          ...(screenshot ? [{ type: 'image' as const, data: screenshot, mimeType: 'image/png' }] : []),
        ],
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.' }] };
    }
  });

  return server;
}

const mcpHandler = createMcpHandler(createServer, {
  route: '/mcp',
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, name: 'servo-mcp' });
    return mcpHandler(request, env, ctx);
  },
};
