import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  tools: new Map<string, { definition: any; handler: (input: any) => Promise<any> }>(),
  resources: new Map<string, { definition: any; handler: (uri: URL) => Promise<any> }>(),
  servers: [] as any[],
  handlerOptions: [] as any[],
}));

vi.mock('agents/mcp/server', () => ({
  createMcpHandler: (createServer: () => unknown, options: unknown) => {
    harness.handlerOptions.push(options);
    return async (request: Request) => {
      const server = createServer();
      harness.servers.push(server);
      return Response.json({ path: new URL(request.url).pathname });
    };
  },
}));

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    constructor(readonly info: unknown, readonly options: unknown) {}
    registerResource(name: string, _uri: string, definition: any, handler: (uri: URL) => Promise<any>) {
      harness.resources.set(name, { definition, handler });
    }
    registerTool(name: string, definition: any, handler: (input: any) => Promise<any>) {
      harness.tools.set(name, { definition, handler });
    }
  },
}));

vi.mock('../src/browser-session', () => ({ ServoBrowserSession: class {} }));

import worker, { mcpResult } from '../src/index';

type Session = Record<string, ReturnType<typeof vi.fn>>;
type ToolCall = (input: unknown) => Promise<any>;

const sessionId = '00000000-0000-4000-8000-000000000001';
const png = new Uint8Array([137, 80, 78, 71]);
const sessions = new Map<string, Session>();
let defaultSession: Session;
let env: Env;

function makeSession(): Session {
  return {
    initialize: vi.fn(async (options: unknown) => ({ status: 'active', options })),
    getStatus: vi.fn(async () => ({ status: 'active' })),
    close: vi.fn(async () => ({ status: 'closed' })),
    navigate: vi.fn(async (url: string) => ({ action: 'navigate', page: { url, title: 'Example', text: 'visible page text' } })),
    inspect: vi.fn(async () => ({ url: 'https://example.com/', title: 'Example', text: 'body' })),
    evaluate: vi.fn(async (script: string) => ({ action: 'evaluate', page: { script } })),
    click: vi.fn(async () => ({ action: 'click' })),
    typeText: vi.fn(async () => ({ action: 'type' })),
    pressKey: vi.fn(async () => ({ action: 'key' })),
    scroll: vi.fn(async () => ({ action: 'scroll' })),
    history: vi.fn(async () => ({ action: 'history' })),
    reload: vi.fn(async () => ({ action: 'reload' })),
    wait: vi.fn(async () => ({ action: 'wait' })),
    screenshot: vi.fn(async () => ({ page: { title: 'Example' }, png })),
    registerFont: vi.fn(async () => ({ faces: 1 })),
    capabilities: vi.fn(async () => ({ supported: ['dom'] })),
  };
}

function resetHarness(): void {
  harness.tools.clear();
  harness.resources.clear();
  harness.servers.length = 0;
  harness.handlerOptions.length = 0;
  sessions.clear();
  defaultSession = makeSession();
  sessions.set(sessionId, defaultSession);
  env = {
    BROWSER_SESSIONS: { getByName: vi.fn((id: string) => sessions.get(id) ?? defaultSession) },
  } as unknown as Env;
}

function registeredTool(name: string) {
  const tool = harness.tools.get(name);
  if (!tool) throw new Error(`Missing registered tool: ${name}`);
  return tool;
}

async function invoke(name: string, input: unknown): Promise<any> {
  const tool = registeredTool(name);
  return (tool.handler as ToolCall)(tool.definition.inputSchema.parse(input));
}

function structured(result: any): any {
  return result.structuredContent;
}

describe('MCP result encoding', () => {
  it('extracts binary screenshots into image blocks and omits invalid image values', () => {
    const largePng = new Uint8Array(0x8001).fill(3);
    const result = mcpResult({ png, images: [largePng, 'invalid', null], detail: 'kept' });
    expect(result.structuredContent).toEqual({ detail: 'kept' });
    expect(result.content).toHaveLength(3);
    expect(result.content[1]).toMatchObject({ type: 'image', data: Buffer.from(png).toString('base64') });
    expect(result.content[2]).toMatchObject({ type: 'image', data: Buffer.from(largePng).toString('base64') });
    expect(mcpResult({ images: 'not-an-array' }).content).toHaveLength(1);
  });
});

describe('MCP Worker routes and server registration', () => {
  beforeEach(resetHarness);

  it('serves health without constructing the MCP server', async () => {
    const response = await worker.fetch(new Request('https://worker.example/health'), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: 'servo-mcp' });
    expect(harness.servers).toHaveLength(0);
    expect(harness.handlerOptions).toHaveLength(0);
  });

  it('constructs the MCP server, registers the UI and all focused browser tools, and delegates other paths', async () => {
    const response = await worker.fetch(new Request('https://worker.example/not-mcp'), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/not-mcp' });
    expect(harness.handlerOptions).toEqual([{ route: '/mcp' }]);
    expect(harness.servers).toHaveLength(1);
    expect([...harness.tools.keys()]).toEqual([
      'servo_session_create', 'servo_session_status', 'servo_session_close', 'servo_navigate',
      'servo_inspect', 'servo_http_request', 'servo_http_get', 'servo_http_post', 'servo_http_put',
      'servo_http_patch', 'servo_http_delete', 'servo_http_head', 'servo_http_options',
      'servo_evaluate', 'servo_click', 'servo_type_text', 'servo_press_key',
      'servo_scroll', 'servo_history', 'servo_reload', 'servo_wait', 'servo_screenshot',
      'servo_register_font', 'servo_get_capabilities',
    ]);

    const resource = harness.resources.get('servo-browser-ui')!;
    const widget = await resource.handler(new URL('ui://servo/browser.html'));
    expect(resource.definition.mimeType).toBe('text/html;profile=mcp-app');
    expect(widget.contents[0]).toMatchObject({
      uri: 'ui://servo/browser.html', mimeType: 'text/html;profile=mcp-app',
    });
    expect(widget.contents[0].text).toContain('Servo browser');
  });
});

describe('session management tools', () => {
  beforeEach(async () => {
    resetHarness();
    await worker.fetch(new Request('https://worker.example/mcp'), env, {} as ExecutionContext);
  });

  it('creates URL and inline HTML sessions with defaults and per-session failures', async () => {
    const create = registeredTool('servo_session_create');
    const parsed = create.definition.inputSchema.parse({ sessions: [{ url: 'https://example.com/' }, { html: '<p>Hi</p>' }] });
    expect(parsed.sessions[0]).toMatchObject({ width: 1280, height: 720, maxDurationMs: 10_000 });
    const result = await create.handler(parsed);
    const results = structured(result).results;
    expect(results).toHaveLength(2);
    expect(results.every((entry: any) => entry.ok)).toBe(true);
    expect(defaultSession.initialize).toHaveBeenCalledTimes(2);
    expect(result.content.filter((part: any) => part.type === 'image')).toHaveLength(0);
    expect(result.structuredContent.results[0].result).not.toHaveProperty('png');

    const unsafe = await invoke('servo_session_create', { sessions: [{ url: 'http://127.0.0.1/' }] });
    expect(structured(unsafe).results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Private, local/) });
    const conflicting = await invoke('servo_session_create', { sessions: [{ url: 'https://example.com/', html: '<p/>' }] });
    expect(structured(conflicting).results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Provide a URL or inline HTML/) });

    defaultSession.initialize.mockRejectedValueOnce(new Error('init failed'));
    const failed = await invoke('servo_session_create', { sessions: [{ html: '<p/>' }] });
    expect(structured(failed).results[0]).toMatchObject({ ok: false, error: 'init failed' });
    defaultSession.initialize.mockRejectedValueOnce('opaque failure');
    const opaque = await invoke('servo_session_create', { sessions: [{ html: '<p/>' }] });
    expect(structured(opaque).results[0]).toMatchObject({ ok: false, error: 'Servo request failed.' });
  });

  it('checks and closes multiple sessions with isolated failures', async () => {
    const ids = [sessionId, '00000000-0000-4000-8000-000000000002'];
    const second = makeSession();
    sessions.set(ids[1], second);
    expect(structured(await invoke('servo_session_status', { sessionIds: ids })).results).toMatchObject([
      { sessionId: ids[0], ok: true, result: { status: 'active' } },
      { sessionId: ids[1], ok: true, result: { status: 'active' } },
    ]);
    second.getStatus.mockRejectedValueOnce(new Error('status failed'));
    const status = structured(await invoke('servo_session_status', { sessionIds: ids }));
    expect(status.results[1]).toMatchObject({ ok: false, error: 'status failed' });
    second.getStatus.mockRejectedValueOnce('opaque status failure');
    expect(structured(await invoke('servo_session_status', { sessionIds: ids })).results[1].error).toBe('Servo request failed.');

    second.close.mockRejectedValueOnce(new Error('close failed'));
    const closed = structured(await invoke('servo_session_close', { sessionIds: ids }));
    expect(closed.results[0]).toMatchObject({ ok: true, result: { status: 'closed' } });
    expect(closed.results[1]).toMatchObject({ ok: false, error: 'close failed' });
    second.close.mockRejectedValueOnce('opaque close failure');
    expect(structured(await invoke('servo_session_close', { sessionIds: [ids[1]] })).results[0].error).toBe('Servo request failed.');
    expect(() => registeredTool('servo_session_status').definition.inputSchema.parse({ sessionIds: [sessionId, sessionId] })).toThrow(/only once/);
    expect(() => registeredTool('servo_session_close').definition.inputSchema.parse({ sessionIds: [] })).toThrow();
  });
});

describe('focused browser tools', () => {
  beforeEach(async () => {
    resetHarness();
    await worker.fetch(new Request('https://worker.example/mcp'), env, {} as ExecutionContext);
  });

  it('routes every focused operation with its own arguments and defaults', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['servo_navigate', { sessions: [{ sessionId, url: 'https://example.com/' }] }, 'navigate'],
      ['servo_inspect', { sessions: [{ sessionId }] }, 'inspect'],
      ['servo_evaluate', { sessions: [{ sessionId, script: '1 + 1' }] }, 'evaluate'],
      ['servo_click', { sessions: [{ sessionId, x: 3, y: 4 }] }, 'click'],
      ['servo_type_text', { sessions: [{ sessionId, text: 'text' }] }, 'typeText'],
      ['servo_press_key', { sessions: [{ sessionId, key: 'Enter' }] }, 'pressKey'],
      ['servo_scroll', { sessions: [{ sessionId, deltaX: 1, deltaY: 2 }] }, 'scroll'],
      ['servo_history', { sessions: [{ sessionId, direction: 'back' }] }, 'history'],
      ['servo_reload', { sessions: [{ sessionId }] }, 'reload'],
      ['servo_wait', { sessions: [{ sessionId }] }, 'wait'],
      ['servo_register_font', { sessions: [{ sessionId, fontBase64: 'Zm9udA==' }] }, 'registerFont'],
      ['servo_get_capabilities', { sessions: [{ sessionId }] }, 'capabilities'],
    ];
    for (const [name, input, method] of cases) {
      const result = structured(await invoke(name, input));
      expect(result.results[0]).toMatchObject({ sessionId, ok: true });
      expect((defaultSession[method] as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    }
    const browsed = structured(await invoke('servo_navigate', { sessions: [{ sessionId, url: 'https://example.com/' }] }));
    expect(browsed.results[0].result.results[0]).toEqual({
      title: 'Example', url: 'https://example.com/', snippet: 'visible page text', content: 'visible page text',
    });
    expect(defaultSession.navigate).toHaveBeenCalledWith('https://example.com/', 10_000);
    expect(defaultSession.click).toHaveBeenCalledWith(3, 4, 0, 10_000);
    expect(defaultSession.scroll).toHaveBeenCalledWith(1, 2, undefined, undefined, 10_000);
    expect(defaultSession.wait).toHaveBeenCalledWith(1_000);
    expect(defaultSession.registerFont).toHaveBeenCalledWith('Zm9udA==');
  });

  it('isolates per-session failures and reports malformed or duplicate calls', async () => {
    const secondId = '00000000-0000-4000-8000-000000000002';
    const second = makeSession();
    sessions.set(secondId, second);
    defaultSession.inspect.mockRejectedValueOnce(new Error('one tab failed'));
    const response = structured(await invoke('servo_inspect', { sessions: [{ sessionId }, { sessionId: secondId }] }));
    expect(response.results).toMatchObject([
      { sessionId, ok: false, error: 'one tab failed' },
      { sessionId: secondId, ok: true },
    ]);
    defaultSession.inspect.mockRejectedValueOnce('non-error rejection');
    expect(structured(await invoke('servo_inspect', { sessions: [{ sessionId }] })).results[0].error).toBe('Servo request failed.');
    expect(structured(await invoke('servo_navigate', { sessions: [{ sessionId, url: 'http://localhost/' }] })).results[0].error).toMatch(/Private, local/);
    const duplicate = await invoke('servo_inspect', { sessions: [{ sessionId }, { sessionId }] });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toMatch(/only once/);
    const hostileGroups = new Proxy([] as unknown[], {
      get(target, property, receiver) {
        if (property === 'map') throw 'unexpected raw rejection';
        return Reflect.get(target, property, receiver);
      },
    });
    const rawError = await registeredTool('servo_inspect').handler({ sessions: hostileGroups });
    expect(rawError.isError).toBe(true);
    expect(rawError.content[0].text).toBe('Servo request failed.');
    expect(() => registeredTool('servo_evaluate').definition.inputSchema.parse({ sessions: [{ sessionId, script: 'x'.repeat(65_537) }] })).toThrow();
  });

  it('maps successful screenshot bytes to image blocks and retains per-session errors', async () => {
    const otherId = '00000000-0000-4000-8000-000000000002';
    const thirdId = '00000000-0000-4000-8000-000000000003';
    const largePng = new Uint8Array(0x8001).fill(7);
    defaultSession.screenshot.mockResolvedValueOnce({ page: { title: 'Large' }, png: largePng });
    const other = makeSession();
    other.screenshot.mockRejectedValueOnce(new Error('capture failed'));
    sessions.set(otherId, other);
    const third = makeSession();
    third.screenshot.mockResolvedValueOnce({ page: { title: 'Small' }, png });
    sessions.set(thirdId, third);
    const fourthId = '00000000-0000-4000-8000-000000000004';
    const fourth = makeSession();
    fourth.screenshot.mockRejectedValueOnce('opaque capture failure');
    sessions.set(fourthId, fourth);
    const result = await invoke('servo_screenshot', { sessions: [{ sessionId }, { sessionId: otherId }, { sessionId: thirdId }, { sessionId: fourthId }] });
    expect(result.structuredContent.results).toMatchObject([
      { sessionId, ok: true, result: { imageIndex: 0 } },
      { sessionId: otherId, ok: false, error: 'capture failed' },
      { sessionId: thirdId, ok: true, result: { imageIndex: 1 } },
      { sessionId: fourthId, ok: false, error: 'Servo request failed.' },
    ]);
    expect(result.structuredContent.images).toBeUndefined();
    expect(result.content[0].text).toContain('imageIndex');
    expect(result.content[1]).toMatchObject({ type: 'image', data: Buffer.from(largePng).toString('base64'), mimeType: 'image/png' });
    expect(result.content[2]).toMatchObject({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });
    const duplicate = await invoke('servo_screenshot', { sessions: [{ sessionId }, { sessionId }] });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toMatch(/only once/);
  });

  it('sends configurable HTTP requests and returns headers, status, body and web-style page results', async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('x-test')).toBe('overridden');
      expect(await new Response(init.body).text()).toBe('{"hello":"world"}');
      return new Response('<html><title>Sample Page</title><body><h1>Hello</h1><script>secret()</script><p>Visible &amp; useful</p></body></html>', {
        status: 201, headers: { 'content-type': 'text/html; charset=utf-8', 'x-origin': 'fixture' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = structured(await invoke('servo_http_request', {
        url: 'https://example.com/api', method: 'POST', headers: { 'x-test': 'overridden' },
        body: '{"hello":"world"}',
      }));
      expect(result.request).toMatchObject({ method: 'POST', url: 'https://example.com/api' });
      expect(result.response).toMatchObject({ status: 201, ok: true, contentType: 'text/html; charset=utf-8', headers: { 'x-origin': 'fixture' } });
      expect(result.body).toContain('<title>Sample Page</title>');
      expect(result.results).toEqual([{ title: 'Sample Page', url: 'https://example.com/api', snippet: 'Hello\nVisible & useful', content: 'Hello\nVisible & useful' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('supports verb-specific tools and blocks unsafe redirect targets and invalid method/body combinations', async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => init.method === 'OPTIONS'
      ? new Response(null, { status: 204 })
      : new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const denied = await invoke('servo_http_get', { url: 'https://example.com/' });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/Private, local/);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const options = await invoke('servo_http_options', { url: 'https://example.com/', headers: { 'x-check': 'yes' } });
      expect(options.structuredContent.request.method).toBe('OPTIONS');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const getWithBody = await invoke('servo_http_request', { url: 'https://example.com/', method: 'GET', body: 'invalid' });
      expect(getWithBody.isError).toBe(true);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 207 }));
      const extension = await invoke('servo_http_request', { url: 'https://example.com/', method: 'PROPFIND' });
      expect(extension.structuredContent.request.method).toBe('PROPFIND');
      expect(extension.structuredContent.response.status).toBe(207);
      const unsupported = await invoke('servo_http_request', { url: 'https://example.com/', method: 'CONNECT' });
      expect(unsupported.isError).toBe(true);
      expect(unsupported.content[0].text).toMatch(/forbidden by the Fetch API/);
    } finally { vi.unstubAllGlobals(); }
  });
});
