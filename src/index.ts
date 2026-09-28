import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import widgetHtml from './browser-widget.html';
import { ServoBrowserSession, type BrowserSessionOptions } from './browser-session';
import { assertPublicHttpUrl } from './security';

const WIDGET_URI = 'ui://servo/browser.html';
const MAX_TOOL_DURATION_MS = 15_000;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_FONT_BASE64_BYTES = 44_739_244;

const sessionCreateOptionsSchema = z.object({
  url: z.string().url().max(2048).optional(),
  html: z.string().max(1 * 1024 * 1024).optional(),
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(240).max(1600).default(720),
  fontBase64: z.string().max(MAX_FONT_BASE64_BYTES).optional(),
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000),
});
const sessionCreateSchema = z.object({ sessions: z.array(sessionCreateOptionsSchema).min(1).max(20) });
const sessionIdsSchema = z.object({ sessionIds: z.array(z.string().uuid()).min(1).max(20) }).refine(
  ({ sessionIds }) => new Set(sessionIds).size === sessionIds.length,
  { message: 'Each sessionId may appear only once.' },
);
const multiSession = <T extends z.ZodRawShape>(shape: T) => z.object({
  sessions: z.array(z.object({ sessionId: z.string().uuid() }).extend(shape)).min(1).max(20),
});
const navigateSchema = multiSession({ url: z.string().url().max(2048), maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000) });
const evaluateSchema = multiSession({ script: z.string().max(MAX_SCRIPT_BYTES), maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000) });
const clickSchema = multiSession({
  x: z.number().finite(), y: z.number().finite(), button: z.number().int().min(0).max(4).default(0),
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000),
});
const typeTextSchema = multiSession({ text: z.string().max(4096), maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000) });
const keySchema = multiSession({ key: z.string().min(1).max(64), maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000) });
const scrollSchema = multiSession({
  deltaX: z.number().finite(), deltaY: z.number().finite(), x: z.number().finite().optional(), y: z.number().finite().optional(),
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000),
});
const historySchema = multiSession({ direction: z.enum(['back', 'forward']), maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000) });
const waitSchema = multiSession({
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(1_000),
});
const screenshotSchema = multiSession({
  fullPage: z.boolean().default(false), maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(5_000),
});
const registerFontSchema = multiSession({ fontBase64: z.string().min(1).max(MAX_FONT_BASE64_BYTES) });
const capabilitiesSchema = multiSession({});
const inspectSchema = multiSession({});

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function mcpResult(value: object) {
  const data: Record<string, unknown> = { ...value };
  const png = data.png;
  const images = data.images;
  delete data.png;
  delete data.images;
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
    { type: 'text', text: JSON.stringify(data) },
  ];
  if (png instanceof Uint8Array) content.push({ type: 'image', data: toBase64(png), mimeType: 'image/png' });
  if (Array.isArray(images)) {
    for (const image of images) {
      if (image instanceof Uint8Array) content.push({ type: 'image', data: toBase64(image), mimeType: 'image/png' });
    }
  }
  return { structuredContent: data, content };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.';
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function createServer(env: Env) {
  const server = new McpServer({ name: 'servo-mcp', version: '0.3.0' }, {
    instructions: [
      'Each Servo session is one independent browser tab. Create one session per tab, keep a mapping from a short description to its returned sessionId, and pass that exact ID in the sessions list for later operations. Each focused browser tool accepts multiple per-session entries and runs them concurrently. Close only the sessions you are done with.',
      'A live WASM runtime is cached for 90 seconds after activity; afterward, the selected session is reopened from a persisted snapshot. No prior tool actions are replayed.',
      'Each tool keeps one focused purpose. For example, servo_navigate accepts multiple {sessionId,url,maxDurationMs} entries and servo_click accepts multiple entries with independent coordinates. To run dependent actions on one tab, call the focused tools in order. Browser operations automatically reopen saved tabs when their WASM runtime is not resident.',
      'Snapshots preserve the current URL, viewport, scroll position, common form values, web storage, script-visible cookies, and registered fonts. Restoring reloads the page, so page scripts run again; JavaScript heap state, HttpOnly cookies, and arbitrary in-memory DOM/application state are not restored. Sessions expire after 30 days without use or when closed with servo_session_close.',
      'A sessionId is a bearer capability because this public MCP server currently has no authentication. Do not share it. Only navigate to public HTTP(S) pages; private/local network targets are blocked.',
      'servo_click, servo_type_text, servo_press_key, and servo_evaluate may cause page-side effects. Use them only for actions the user requested, and do not repeat a call merely because its response was unclear.',
      'Servo capabilities are partial. Use servo_get_capabilities and inspect returned errors before concluding a page is broken.',
    ].join(' '),
  });
  const session = (sessionId: string) => env.BROWSER_SESSIONS.getByName(sessionId);
  const safely = async (operation: () => Promise<object>) => {
    try { return mcpResult(await operation()); } catch (error) { return errorResult(error); }
  };

  server.registerResource('servo-browser-ui', WIDGET_URI, {
    title: 'Servo browser controls',
    description: 'Create a Servo browser session, inspect a public page, and view its rendered screenshot.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }, async (uri) => ({ contents: [{ uri: uri.href,
    mimeType: 'text/html;profile=mcp-app', text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));

  const runSessions = async <T extends { sessionId: string }, R>(
    groups: T[],
    operation: (browser: ReturnType<typeof session>, group: T) => Promise<R>,
  ) => {
    if (new Set(groups.map(({ sessionId }) => sessionId)).size !== groups.length) {
      throw new TypeError('Each sessionId may appear only once in a tool call.');
    }
    return { results: await Promise.all(groups.map(async (group) => {
    try {
      return { sessionId: group.sessionId, ok: true, result: await operation(session(group.sessionId), group) };
    } catch (error) {
      return { sessionId: group.sessionId, ok: false, error: error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.' };
    }
    })) };
  };

  server.registerTool('servo_session_create', {
    title: 'Servo session create',
    description: 'Create one or more independent Servo browser tabs in parallel. Each sessions entry may include a public URL or inline HTML plus its own viewport, font, and load-budget settings. Returns a separate server-generated sessionId for each tab; pass those IDs in later tools to choose the tabs.',
    inputSchema: sessionCreateSchema,
  }, async ({ sessions }) => safely(async () => ({ results: await Promise.all(sessions.map(async (options) => {
    const sessionId = crypto.randomUUID();
    try {
      if (options.url && options.html !== undefined) throw new TypeError('Provide a URL or inline HTML, not both.');
      if (options.url) assertPublicHttpUrl(options.url);
      const result = await session(sessionId).initialize({ sessionId, ...options } as BrowserSessionOptions);
      return { sessionId, ok: true, result };
    } catch (error) {
      return { sessionId, ok: false, error: error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.' };
    }
  })) })));

  server.registerTool('servo_session_status', {
    title: 'Servo session status',
    description: 'Check multiple browser sessions in parallel. runtimeAvailable=false with resumable=true is normal after the live runtime is discarded; browser tools will restore the saved tab automatically.',
    inputSchema: sessionIdsSchema,
  }, async ({ sessionIds }) => safely(async () => ({ results: await Promise.all(sessionIds.map(async (sessionId) => {
    try { return { sessionId, ok: true, result: await session(sessionId).getStatus() }; }
    catch (error) { return { sessionId, ok: false, error: error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.' }; }
  })) })));

  server.registerTool('servo_session_close', {
    title: 'Servo session close',
    description: 'Close multiple selected tabs in parallel and delete their saved snapshots and assets. Only include sessions you are finished with; closed sessions cannot be resumed.',
    inputSchema: sessionIdsSchema,
  }, async ({ sessionIds }) => safely(async () => ({ results: await Promise.all(sessionIds.map(async (sessionId) => {
    try { return { sessionId, ok: true, result: await session(sessionId).close() }; }
    catch (error) { return { sessionId, ok: false, error: error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.' }; }
  })) })));

  server.registerTool('servo_navigate', {
    title: 'Servo navigate',
    description: 'Navigate multiple selected tabs in parallel. Each sessions entry carries its own sessionId, URL, and optional load budget. Private/local network addresses are blocked.',
    inputSchema: navigateSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => {
    assertPublicHttpUrl(group.url);
    return browser.navigate(group.url, group.maxDurationMs);
  })));

  server.registerTool('servo_inspect', {
    title: 'Servo inspect',
    description: 'Read the URL, title, and visible body text for multiple selected tabs in parallel.',
    inputSchema: inspectSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser) => browser.inspect())));

  server.registerTool('servo_evaluate', {
    title: 'Servo evaluate',
    description: 'Evaluate a JavaScript expression in each selected page in parallel. Every entry carries its own script and budget. If the script returns a promise, it is awaited within the budget. Results are WebDriver-style JSON clones, such as {"Ok":{"String":"…"}} or {"Err":…}; return JSON.stringify(value) for complex data. Scripts can modify pages or cause external effects.',
    inputSchema: evaluateSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.evaluate(group.script, group.maxDurationMs))));

  server.registerTool('servo_click', {
    title: 'Servo click',
    description: 'Click different device-pixel coordinates in multiple selected tabs in parallel. Ground each entry’s coordinates in that tab’s screenshot or measured DOM bounds. Clicks can submit forms or trigger page actions.',
    inputSchema: clickSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.click(group.x, group.y, group.button, group.maxDurationMs))));

  server.registerTool('servo_type_text', {
    title: 'Servo type text',
    description: 'Type per-session text into each selected tab’s currently focused control in parallel. Focus the intended fields first. Typing can trigger live search, autosave, or other page effects.',
    inputSchema: typeTextSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.typeText(group.text, group.maxDurationMs))));

  server.registerTool('servo_press_key', {
    title: 'Servo press key',
    description: 'Press a key in multiple selected tabs in parallel. Each entry has its own key. Focus intended controls first; Enter may submit forms.',
    inputSchema: keySchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.pressKey(group.key, group.maxDurationMs))));

  server.registerTool('servo_scroll', {
    title: 'Servo scroll',
    description: 'Scroll multiple selected tabs in parallel. Each entry has its own pixel deltas and optional viewport point.',
    inputSchema: scrollSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.scroll(group.deltaX, group.deltaY, group.x, group.y, group.maxDurationMs))));

  server.registerTool('servo_history', {
    title: 'Servo history',
    description: 'Move multiple selected tabs backward or forward in their live Servo history. Each entry chooses its own direction. History is not part of the restore snapshot and resets after the runtime is discarded.',
    inputSchema: historySchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.history(group.direction, group.maxDurationMs))));

  server.registerTool('servo_reload', {
    title: 'Servo reload',
    description: 'Reload multiple selected tabs in parallel and wait for each page to settle.',
    inputSchema: multiSession({ maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000) }),
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.reload(group.maxDurationMs))));

  server.registerTool('servo_wait', {
    title: 'Servo wait',
    description: 'Let multiple selected pages process browser timers and pending network work in parallel, using each entry’s own time budget.',
    inputSchema: waitSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.wait(group.maxDurationMs))));

  server.registerTool('servo_screenshot', {
    title: 'Servo screenshot',
    description: 'Capture viewport or full-page screenshots from multiple selected tabs in parallel. Results map imageIndex values to session IDs.',
    inputSchema: screenshotSchema,
  }, async ({ sessions }) => safely(async () => {
    if (new Set(sessions.map(({ sessionId }) => sessionId)).size !== sessions.length) {
      throw new TypeError('Each sessionId may appear only once in a tool call.');
    }
    const images: Uint8Array[] = [];
    const results = await Promise.all(sessions.map(async (group) => {
      try {
        const result = await session(group.sessionId).screenshot(group.fullPage, group.maxDurationMs);
        const imageIndex = images.push(result.png) - 1;
        return { sessionId: group.sessionId, ok: true, result: { page: result.page, imageIndex } };
      } catch (error) {
        return { sessionId: group.sessionId, ok: false, error: error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.' };
      }
    }));
    return { results, images };
  }));

  server.registerTool('servo_register_font', {
    title: 'Servo register font',
    description: 'Register per-session base64-encoded TTF/OTF/TTC/OTC fonts in multiple tabs in parallel. Register before navigating to pages that need them.',
    inputSchema: registerFontSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser, group) => browser.registerFont(group.fontBase64))));

  server.registerTool('servo_get_capabilities', {
    title: 'Servo get capabilities',
    description: 'Return supported, partial, unsupported, and unverified Servo features for multiple selected sessions in parallel.',
    inputSchema: capabilitiesSchema,
  }, async ({ sessions }) => safely(async () => runSessions(sessions, (browser) => browser.capabilities())));

  return server;
}

export { ServoBrowserSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, name: 'servo-mcp' });
    return createMcpHandler(() => createServer(env), { route: '/mcp' })(request, env, ctx);
  },
};
