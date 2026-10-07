import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import widgetHtml from './browser-widget.html';
import searchWidgetHtml from './search-widget.html';
import { searchWeb } from './web-search';
import { ServoBrowserSession } from './browser-session';
import { assertPublicHttpUrl } from './security';
import { httpRequestSchema, httpVerbRequestSchema, HTTP_METHODS, requestHttp } from './http-tools';

const WIDGET_URI = 'ui://servo/browser.html';
const SEARCH_WIDGET_URI = 'ui://servo/search.html';
const MAX_TOOL_DURATION_MS = 15_000;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_FONT_BASE64_BYTES = 44_739_244;

const multiSession = <T extends z.ZodRawShape>(shape: T) => z.object({
  actions: z.array(z.object({
    sessionID: z.union([z.string().uuid(), z.literal(null), z.literal(false), z.literal(0), z.literal('')]).optional()
      .describe('Omit or set to a falsy value to create a new tab and perform this action; provide an existing ID to reuse or restore that tab.'),
    width: z.number().int().min(320).max(1920).optional().describe('Initial viewport width for a new tab only; defaults to 1280.'),
    height: z.number().int().min(240).max(1600).optional().describe('Initial viewport height for a new tab only; defaults to 720.'),
  }).extend(shape).strict()).min(1).max(20),
}).strict();
const navigateSchema = multiSession({
  url: z.string().url().max(2048).optional(),
  html: z.string().max(1 * 1024 * 1024).optional(),
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000),
});
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
const recordingStartSchema = multiSession({
  fps: z.number().int().min(1).max(3).default(2),
  maxDurationSeconds: z.number().int().min(1).max(60).default(30),
});
const recordingIdSchema = multiSession({ recordingId: z.string().uuid() });
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

export function mcpResult(value: object) {
  const data: Record<string, unknown> = { ...value };
  const png = data.png;
  const images = data.images;
  delete data.png;
  delete data.images;
  const responses = data.responses;
  if (Array.isArray(responses)) {
    const successfulCount = responses.filter((entry) => entry?.ok === true).length;
    data.metadata = { responseCount: responses.length, successfulCount, failedCount: responses.length - successfulCount };
  }
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
    { type: 'text', text: JSON.stringify(data) },
  ];
  if (png instanceof Uint8Array) content.push({ type: 'image', data: toBase64(png), mimeType: 'image/png' });
  if (Array.isArray(images)) {
    for (const image of images) {
      if (image instanceof Uint8Array) content.push({ type: 'image', data: toBase64(image), mimeType: 'image/png' });
    }
  }
  return { structuredContent: data, content,
    ...(Array.isArray(responses) && responses.some((entry) => entry?.ok === false) ? { isError: true } : {}),
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.';
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function createServer(env: Env, publicOrigin: string) {
  const server = new McpServer({ name: 'servo-mcp', version: '0.5.0' }, {
    instructions: [
      'Each Servo session is one independent browser tab. Omit sessionID or use a falsy value on an action to create a new tab automatically and perform that action. There is no standalone session creation tool. Keep a mapping from a short description to its returned sessionID, and pass that exact ID on the action as sessionID for later operations. Every tool returns an ordered top-level responses array with one response object per action, plus metadata counts for all actions. Each focused browser tool runs its action entries concurrently. Sessions expire automatically after 30 days without use.',
      'The live WASM runtime has no application-level idle hold. After a browser tool call and snapshot writes finish, Cloudflare can hibernate the Durable Object; a later call restores the selected session from its persisted snapshot. No prior tool actions are replayed, and JavaScript heap state is not preserved.',
      'Screen recordings capture the viewport as low-frame-rate H.264 MP4 without audio. Start with servo_recording_start, browse while it records, stop with servo_recording_stop, check asynchronous encoding with servo_recording_status, then get a direct download link with servo_recording_download. The Durable Object stays active while a recording is running, which can add duration charges; recordings default to 2 fps and 30 seconds and are capped at 3 fps and 60 seconds. Up to three completed recordings per tab are kept for 24 hours. Download URLs are bearer links; do not share them.',
      'Each tool keeps one focused purpose. Every browser action accepts an actions array of objects, each with an optional sessionID; servo_navigate actions contain {url,maxDurationMs} and servo_click actions contain independent coordinates. To run dependent actions on one tab, call the focused tools in order. Browser operations automatically reopen saved tabs when their WASM runtime is not resident. Supplied IDs must already exist; unknown, closed, or expired IDs are never replaced with new tabs. Initial width and height options apply only when an action has no truthy sessionID. Status accepts the same arrays and reports whether existing runtimes are available; HTTP tools do not use browser sessions.',
      'Snapshots preserve the current URL, viewport, scroll position, common form values, every localStorage and sessionStorage entry, the full cookie jar including HttpOnly cookies, IndexedDB schemas and records for each visited origin, and registered fonts. Restoring reloads the page so page scripts run again; JavaScript heap state, browser history, and arbitrary in-memory DOM/application state are not restored. Cache Storage remains runtime-local and incomplete. Sessions expire after 30 days without use.',
      'A sessionId is a bearer capability because this public MCP server currently has no authentication. Do not share it. Only navigate to public HTTP(S) pages; private/local network targets are blocked.',
      'servo_click, servo_type_text, servo_press_key, and servo_evaluate may cause page-side effects. Use them only for actions the user requested, and do not repeat a call merely because its response was unclear.',
      'HTTP request tools make outbound requests to public HTTP(S) URLs. They accept custom request headers and bounded text bodies, follow at most five redirects while rechecking each destination, and return status, response headers, body data, and citation-style page results. Requests can cause remote side effects; use the requested method and endpoint only.',
      'Servo capabilities are partial. Use servo_get_capabilities and inspect returned errors before concluding a page is broken.',
    ].join(' '),
  });
  const session = (sessionId: string) => env.BROWSER_SESSIONS.getByName(sessionId);
  const safely = async (operation: () => Promise<object>) => {
    try { return mcpResult(await operation()); } catch (error) { return errorResult(error); }
  };

  server.registerResource('servo-browser-ui', WIDGET_URI, {
    title: 'Servo browser controls',
    description: 'Load a public page, inspect it, and view its rendered screenshot. The first navigation creates a tab automatically.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }, async (uri) => ({ contents: [{ uri: uri.href,
    mimeType: 'text/html;profile=mcp-app', text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));

  server.registerResource('servo-web-search-ui', SEARCH_WIDGET_URI, {
    title: 'Servo web search',
    description: 'Search the public web and inspect ranked results.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }, async (uri) => ({ contents: [{ uri: uri.href,
    mimeType: 'text/html;profile=mcp-app', text: searchWidgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));

  const browserUiMeta = {
    ui: { resourceUri: WIDGET_URI },
    'openai/outputTemplate': WIDGET_URI,
    'openai/ui': { entrypoints: [{ type: 'global' }] },
  };
  const searchUiMeta = {
    ui: { resourceUri: SEARCH_WIDGET_URI },
    'openai/outputTemplate': SEARCH_WIDGET_URI,
  };

  server.registerTool('servo_web_search', {
    title: 'Servo web search',
    description: 'Search the public web across Google, Bing, DuckDuckGo, and Yandex. The auto/all modes query providers in parallel, tolerate individual provider failures, and deduplicate results. Use this before browsing when you need to discover relevant pages; use servo_navigate to open a result.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(512),
      limit: z.number().int().min(1).max(10).default(8),
      provider: z.enum(['auto', 'google', 'bing', 'duckduckgo', 'yandex', 'all']).default('auto'),
    }).strict(),
    _meta: searchUiMeta,
  }, async ({ query, limit, provider }) => safely(async () => ({
    query,
    provider,
    ...(await searchWeb(query, limit, provider)),
  })));

  type SessionGroup = { width?: number; height?: number };
  type SessionInput<T extends { sessionID?: unknown }> = { actions: T[] };
  const sessionError = (error: unknown) => ({
    error: error instanceof Error ? error.message.slice(0, 2048) : 'Servo request failed.',
    ...(error instanceof Error && 'code' in error && error.code === 'SESSION_NOT_FOUND'
      ? { code: 'SESSION_NOT_FOUND', status: 404 } : {}),
  });
  const existingSession = async (sessionId: string) => {
    const browser = session(sessionId);
    if ((await browser.getStatus()).status === 'missing') throw Object.assign(new Error('Browser session does not exist. Omit sessionID or use a falsy value to create a new tab with an action.'), { code: 'SESSION_NOT_FOUND', status: 404 });
    return browser;
  };
  const runSessions = async <T extends SessionGroup, R>(
    input: SessionInput<T & { sessionID?: string | null | false | 0 | '' }>,
    operation: (browser: ReturnType<typeof session>, group: T & { sessionId: string }, created: boolean) => Promise<R>,
    initialOptions: (group: T) => { url?: string; html?: string; maxDurationMs?: number } = () => ({}),
  ) => {
    const idCounts = new Map<string, number>();
    for (const { sessionID } of input.actions) if (sessionID) idCounts.set(sessionID, (idCounts.get(sessionID) ?? 0) + 1);
    return { responses: await Promise.all(input.actions.map(async (group, index) => {
      const suppliedID = group.sessionID || undefined;
      const sessionId = suppliedID ?? crypto.randomUUID();
      try {
        // Validate navigation before allocating a runtime or restoring an existing tab.
        if (suppliedID && (idCounts.get(suppliedID) ?? 0) > 1) throw new TypeError('Each sessionID may appear only once in a tool call.');
        const options = initialOptions(group);
        if (suppliedID !== undefined && (group.width !== undefined || group.height !== undefined)) {
          throw new TypeError('Initial viewport options require a new tab (omit sessionID or use a falsy value).');
        }
        const browser = suppliedID === undefined ? session(sessionId) : await existingSession(sessionId);
        if (suppliedID === undefined) {
          await browser.initialize({ sessionId, width: group.width ?? 1280, height: group.height ?? 720,
            maxDurationMs: 10_000, ...options });
        }
        return { actionIndex: index, sessionID: sessionId, ok: true, response: await operation(browser, { ...group, sessionId }, suppliedID === undefined) };
      } catch (error) {
        return { actionIndex: index, sessionID: sessionId, ok: false, ...sessionError(error) };
      }
    })) };
  };

  const withWebResult = <T extends { page?: { url: string; title: string; text: string } }>(value: T) => {
    if (!value.page) return value;
    const { page } = value;
    return { ...value, results: [{ title: page.title || page.url, url: page.url, snippet: page.text.slice(0, 500), content: page.text }] };
  };

  server.registerTool('servo_session_status', {
    title: 'Servo session status',
    description: 'Check browser sessions in parallel with an actions array of objects, each carrying an optional sessionID. Returns one ordered response object per action; runtimeAvailable=false with resumable=true is normal after runtime eviction.',
    inputSchema: multiSession({}),
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser) => browser.getStatus())));

  server.registerTool('servo_navigate', {
    title: 'Servo navigate',
    description: 'Load a public URL or inline HTML in multiple tabs. Omit sessionID or use a falsy value to create a new tab as part of navigation; include it to reuse or restore an existing tab. Returns ordered action responses with the final page title, URL, visible text, and a web-search-style results entry with title, URL, snippet, and content. Each actions entry has its own load budget; private/local network addresses are blocked.',
    inputSchema: navigateSchema,
    _meta: browserUiMeta,
  }, async (input) => safely(async () => runSessions(input, async (browser, group, created) => {
    // Initialization already loads new tabs; do not execute navigation twice.
    if (created) return withWebResult({ action: 'navigate', page: await browser.inspect() });
    return withWebResult(group.html !== undefined
      ? await browser.navigateHtml(group.html, group.maxDurationMs)
      : await browser.navigate(group.url!, group.maxDurationMs));
  }, (group) => {
    if ((group.url === undefined) === (group.html === undefined)) throw new TypeError('Provide a URL or inline HTML, not both.');
    if (group.url) assertPublicHttpUrl(group.url);
    if (group.html !== undefined && new TextEncoder().encode(group.html).byteLength > 1 * 1024 * 1024) {
      throw new RangeError('Inline HTML exceeds 1048576 UTF-8 bytes, the resumable-session limit.');
    }
    return { url: group.url, html: group.html, maxDurationMs: group.maxDurationMs };
  })));

  server.registerTool('servo_inspect', {
    title: 'Servo inspect',
    description: 'Read the final URL, page title, and visible text for multiple selected tabs. Returns one response object per action, with a web-search-style result entry containing title, URL, snippet, and content.',
    inputSchema: inspectSchema,
    _meta: browserUiMeta,
  }, async (input) => safely(async () =>
    runSessions(input, (browser) => browser.inspect().then((page) => withWebResult({ page }))),
  ));

  const runHttpActions = async <T>(actions: T[], operation: (action: T) => Promise<object>) => ({
    responses: await Promise.all(actions.map(async (action, actionIndex) => {
      try { return { actionIndex, ok: true, response: await operation(action) }; }
      catch (error) { return { actionIndex, ok: false, ...sessionError(error) }; }
    })),
  });

  server.registerTool('servo_http_request', {
    title: 'Servo HTTP request',
    description: 'Send an array of public HTTP(S) requests. Each actions entry accepts any valid Fetch API method (including custom extension methods), optional custom request headers and UTF-8 body, redirect policy, timeout, and response-size limit. Returns one response object per request with status, response headers, body (or base64 for binary), and citation-style page results. CONNECT, TRACE, and TRACK are forbidden by the Fetch API.',
    inputSchema: z.object({ actions: z.array(httpRequestSchema.strict()).min(1).max(20) }).strict(),
  }, async ({ actions }) => safely(() => runHttpActions(actions, requestHttp)));

  for (const method of HTTP_METHODS) {
    const name = `servo_http_${method.toLowerCase()}`;
    server.registerTool(name, {
      title: `Servo HTTP ${method}`,
      description: `Send an array of ${method} requests to public HTTP(S) URLs with optional custom request headers${['GET', 'HEAD'].includes(method) ? '' : ' and UTF-8 body'}. Returns one response object per request with status, headers, bounded body data, and citation-style page results.`,
      inputSchema: z.object({ actions: z.array(httpVerbRequestSchema.strict()).min(1).max(20) }).strict(),
    }, async ({ actions }) => safely(() => runHttpActions(actions, (action) => requestHttp({ ...action, method }))));
  }

  server.registerTool('servo_evaluate', {
    title: 'Servo evaluate',
    description: 'Evaluate a JavaScript expression in each selected page in parallel. Every entry carries its own script and budget. If the script returns a promise, it is awaited within the budget. Each action returns a response with a WebDriver-style JSON clone, such as {"Ok":{"String":"…"}} or {"Err":…}; return JSON.stringify(value) for complex data. Scripts can modify pages or cause external effects.',
    inputSchema: evaluateSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.evaluate(group.script, group.maxDurationMs))));

  server.registerTool('servo_click', {
    title: 'Servo click',
    description: 'Click different device-pixel coordinates in multiple selected tabs in parallel. Ground each entry’s coordinates in that tab’s screenshot or measured DOM bounds. Clicks can submit forms or trigger page actions.',
    inputSchema: clickSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.click(group.x, group.y, group.button, group.maxDurationMs))));

  server.registerTool('servo_type_text', {
    title: 'Servo type text',
    description: 'Type per-session text into each selected tab’s currently focused control in parallel. Focus the intended fields first. Typing can trigger live search, autosave, or other page effects.',
    inputSchema: typeTextSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.typeText(group.text, group.maxDurationMs))));

  server.registerTool('servo_press_key', {
    title: 'Servo press key',
    description: 'Press a key in multiple selected tabs in parallel. Each entry has its own key. Focus intended controls first; Enter may submit forms.',
    inputSchema: keySchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.pressKey(group.key, group.maxDurationMs))));

  server.registerTool('servo_scroll', {
    title: 'Servo scroll',
    description: 'Scroll multiple selected tabs in parallel. Each entry has its own pixel deltas and optional viewport point.',
    inputSchema: scrollSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.scroll(group.deltaX, group.deltaY, group.x, group.y, group.maxDurationMs))));

  server.registerTool('servo_history', {
    title: 'Servo history',
    description: 'Move multiple selected tabs backward or forward in their live Servo history. Each entry chooses its own direction. History is not part of the restore snapshot and resets after the runtime is discarded.',
    inputSchema: historySchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.history(group.direction, group.maxDurationMs))));

  server.registerTool('servo_reload', {
    title: 'Servo reload',
    description: 'Reload multiple selected tabs in parallel and wait for each page to settle.',
    inputSchema: multiSession({ maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000) }),
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.reload(group.maxDurationMs))));

  server.registerTool('servo_wait', {
    title: 'Servo wait',
    description: 'Let multiple selected pages process browser timers and pending network work in parallel, using each entry’s own time budget.',
    inputSchema: waitSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.wait(group.maxDurationMs))));

  server.registerTool('servo_screenshot', {
    title: 'Servo screenshot',
    description: 'Capture viewport or full-page screenshots with an actions array of objects, each carrying an optional sessionID. Returns an ordered responses array; imageIndex maps each response to its screenshot image block.',
    inputSchema: screenshotSchema,
    _meta: browserUiMeta,
  }, async (input) => safely(async () => {
    const images: Uint8Array[] = [];
    const { responses } = await runSessions(input, async (browser, group) => {
      const result = await browser.screenshot(group.fullPage, group.maxDurationMs);
      const imageIndex = images.push(result.png) - 1;
      return { page: result.page, imageIndex };
    });
    return { responses, images };
  }));

  server.registerTool('servo_recording_start', {
    title: 'Servo recording start',
    description: 'Start asynchronous screen recording with an actions array of objects, each carrying an optional sessionID. Captures a downscaled viewport as H.264 MP4 at 1–3 fps, without audio. The Durable Object remains active during recording; the default maximum is 30 seconds and the hard limit is 60 seconds. Returns a recordingId for stop, status, and download calls.',
    inputSchema: recordingStartSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) =>
    browser.startScreenRecording(group.fps, group.maxDurationSeconds),
  )));

  server.registerTool('servo_recording_stop', {
    title: 'Servo recording stop',
    description: 'Stop a screen recording with an actions array of objects, each carrying an optional sessionID. Returns immediately with the encoding status; use servo_recording_status to check completion.',
    inputSchema: recordingIdSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) =>
    browser.stopScreenRecording(group.recordingId),
  )));

  server.registerTool('servo_recording_status', {
    title: 'Servo recording status',
    description: 'Check recordings with an actions array of objects, each carrying an optional sessionID. Poll this tool after stop until the status is ready.',
    inputSchema: recordingIdSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) =>
    browser.getScreenRecordingStatus(group.recordingId),
  )));

  server.registerTool('servo_recording_download', {
    title: 'Servo recording download',
    description: 'Return MP4 download information for an actions array of objects, each carrying an optional sessionID. If status is still encoding, check again later. Download links expire after 24 hours.',
    inputSchema: recordingIdSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, async (browser, group) => {
    const info = await browser.getScreenRecordingDownloadInfo(group.recordingId);
    const downloadUrl = info.downloadToken
      ? new URL(`/recordings/${group.sessionId}/${group.recordingId}/${info.downloadToken}`, publicOrigin).href
      : undefined;
    return {
      recordingId: info.recordingId,
      status: info.status,
      downloadUrl,
      filename: downloadUrl ? `servo-recording-${group.recordingId}.mp4` : undefined,
      mimeType: downloadUrl ? 'video/mp4' : undefined,
      sizeBytes: info.sizeBytes,
      expiresAt: info.expiresAt,
    };
  })));

  server.registerTool('servo_register_font', {
    title: 'Servo register font',
    description: 'Register per-session base64-encoded TTF/OTF/TTC/OTC fonts with an actions array of objects, each carrying an optional sessionID. Register before navigating to pages that need them.',
    inputSchema: registerFontSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser, group) => browser.registerFont(group.fontBase64))));

  server.registerTool('servo_get_capabilities', {
    title: 'Servo get capabilities',
    description: 'Return Cloudflare WASM Worker capabilities for an actions array of objects, each carrying an optional sessionID. The report distinguishes supported, partial, unsupported, and unverified features; unsupportedReasons explains known port constraints. It does not describe every feature in Servo native builds.',
    inputSchema: capabilitiesSchema,
    _meta: browserUiMeta
  }, async (input) => safely(async () => runSessions(input, (browser) => browser.capabilities())));

  return server;
}

export { ServoBrowserSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, name: 'servo-mcp' });
    if (url.pathname.startsWith('/recordings/')) {
      const sessionId = url.pathname.split('/')[2];
      if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return new Response('Not found', { status: 404 });
      return env.BROWSER_SESSIONS.getByName(sessionId).fetch(request);
    }
    return createMcpHandler(() => createServer(env, url.origin), { route: '/mcp' })(request, env, ctx);
  },
};
