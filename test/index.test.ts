import { z } from 'zod';
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
    navigateHtml: vi.fn(async (html: string) => ({ action: 'navigate', page: { url: 'https://servo-inline.invalid/', title: 'Inline', text: html } })),
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
    startScreenRecording: vi.fn(async (fps: number, maxDurationSeconds: number) => ({ recordingId: '00000000-0000-4000-8000-000000000003', status: 'recording', fps, maxDurationSeconds })),
    stopScreenRecording: vi.fn(async (recordingId: string) => ({ recordingId, status: 'encoding' })),
    getScreenRecordingStatus: vi.fn(async (recordingId: string) => ({ recordingId, status: 'ready' })),
    getScreenRecordingDownloadInfo: vi.fn(async (recordingId: string) => ({ recordingId, status: 'ready', downloadToken: 'token', sizeBytes: 42, expiresAt: 1_900_000_000_000 })),
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

function browserInput(groups: Array<Record<string, unknown>>) {
  return {
    actions: groups.map(({ sessionId, ...action }) => ({ ...(sessionId ? { sessionID: sessionId } : {}), ...action })),
  };
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
      'servo_web_search', 'servo_session_status', 'servo_navigate',
      'servo_inspect', 'servo_http_request', 'servo_http_get', 'servo_http_post', 'servo_http_put',
      'servo_http_patch', 'servo_http_delete', 'servo_http_head', 'servo_http_options',
      'servo_evaluate', 'servo_click', 'servo_type_text', 'servo_press_key',
      'servo_scroll', 'servo_history', 'servo_reload', 'servo_wait', 'servo_screenshot',
      'servo_recording_start', 'servo_recording_stop', 'servo_recording_status', 'servo_recording_download',
      'servo_register_font', 'servo_get_capabilities',
    ]);

    const searchResource = harness.resources.get('servo-web-search-ui')!;
    expect(searchResource.definition.mimeType).toBe('text/html;profile=mcp-app');
    const searchWidget = await searchResource.handler(new URL('ui://servo/search.html'));
    expect(searchWidget.contents[0].text).toContain('Servo web search');

    const browserResource = harness.resources.get('servo-browser-ui')!;
    const widget = await browserResource.handler(new URL('ui://servo/browser.html'));
    expect(browserResource.definition.mimeType).toBe('text/html;profile=mcp-app');
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

  it('loads new URL and inline tabs as part of navigation without a standalone creation tool', async () => {
    expect(harness.tools.has('servo_session_create')).toBe(false);
    expect(harness.tools.has('servo_session_close')).toBe(false);
    const result = structured(await invoke('servo_navigate', browserInput([
      { url: 'https://example.com/', width: 800, height: 600 }, { html: '<p>Hi</p>' },
    ])));
    expect(result.responses).toHaveLength(2);
    expect(result.responses.every((entry: any) => entry.ok)).toBe(true);
    expect(result.responses[0].sessionID).not.toBe(result.responses[1].sessionID);
    expect(defaultSession.initialize).toHaveBeenNthCalledWith(1, {
      sessionId: result.responses[0].sessionID, width: 800, height: 600,
      url: 'https://example.com/', html: undefined, maxDurationMs: 10_000,
    });
    expect(defaultSession.initialize).toHaveBeenNthCalledWith(2, {
      sessionId: result.responses[1].sessionID, width: 1280, height: 720,
      url: undefined, html: '<p>Hi</p>', maxDurationMs: 10_000,
    });
    expect(defaultSession.navigate).not.toHaveBeenCalled();
    expect(defaultSession.inspect).toHaveBeenCalledTimes(2);

    for (const input of [{ url: 'http://127.0.0.1/' }, { url: 'https://example.com/', html: '<p/>' }, {}, { html: 'é'.repeat(524289) }]) {
      expect(structured(await invoke('servo_navigate', browserInput([input]))).responses[0].ok).toBe(false);
    }
    expect(defaultSession.initialize).toHaveBeenCalledTimes(2);
    defaultSession.initialize.mockRejectedValueOnce(new Error('init failed'));
    expect(structured(await invoke('servo_navigate', browserInput([{ html: '<p/>' }]))).responses[0])
      .toMatchObject({ actionIndex: 0, ok: false, error: 'init failed', sessionID: expect.any(String) });
    defaultSession.initialize.mockRejectedValueOnce('opaque failure');
    expect(structured(await invoke('servo_navigate', browserInput([{ html: '<p/>' }]))).responses[0])
      .toMatchObject({ ok: false, error: 'Servo request failed.' });
  });

  it('returns errors for unknown IDs in status and close without initializing', async () => {
    defaultSession.getStatus.mockResolvedValue({ status: 'missing' });
    for (const tool of ['servo_session_status']) {
      const response = structured(await invoke(tool, { actions: [{ sessionID: sessionId }] }));
      expect(response.responses[0]).toMatchObject({ actionIndex: 0, sessionID: sessionId, ok: false, error: expect.stringMatching(/does not exist/) });
    }
    expect(defaultSession.initialize).not.toHaveBeenCalled();
    expect(defaultSession.close).not.toHaveBeenCalled();
  });

  it('checks and closes multiple sessions with isolated failures', async () => {
    const ids = [sessionId, '00000000-0000-4000-8000-000000000002'];
    const second = makeSession();
    sessions.set(ids[1], second);
    expect(structured(await invoke('servo_session_status', { actions: ids.map((sessionID) => ({ sessionID })) })).responses).toMatchObject([
      { actionIndex: 0, sessionID: ids[0], ok: true, response: { status: 'active' } },
      { actionIndex: 1, sessionID: ids[1], ok: true, response: { status: 'active' } },
    ]);
    second.getStatus.mockRejectedValueOnce(new Error('status failed'));
    const status = structured(await invoke('servo_session_status', { actions: ids.map((sessionID) => ({ sessionID })) }));
    expect(status.responses[1]).toMatchObject({ ok: false, error: 'status failed' });
    second.getStatus.mockRejectedValueOnce('opaque status failure');
    expect(structured(await invoke('servo_session_status', { actions: ids.map((sessionID) => ({ sessionID })) })).responses[1].error).toBe('Servo request failed.');

    expect((await invoke('servo_session_status', { actions: [{ sessionID: sessionId }, { sessionID: sessionId }] })).isError).toBe(true);
    expect(() => registeredTool('servo_session_status').definition.inputSchema.parse({ actions: [] })).toThrow();
  });
});

describe('focused browser tools', () => {
  beforeEach(async () => {
    resetHarness();
    await worker.fetch(new Request('https://worker.example/mcp'), env, {} as ExecutionContext);
  });

  it('routes every focused operation with its own arguments and defaults', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['servo_navigate', browserInput([{ sessionId, url: 'https://example.com/' }]), 'navigate'],
      ['servo_inspect', browserInput([{ sessionId }]), 'inspect'],
      ['servo_evaluate', browserInput([{ sessionId, script: '1 + 1' }]), 'evaluate'],
      ['servo_click', browserInput([{ sessionId, x: 3, y: 4 }]), 'click'],
      ['servo_type_text', browserInput([{ sessionId, text: 'text' }]), 'typeText'],
      ['servo_press_key', browserInput([{ sessionId, key: 'Enter' }]), 'pressKey'],
      ['servo_scroll', browserInput([{ sessionId, deltaX: 1, deltaY: 2 }]), 'scroll'],
      ['servo_history', browserInput([{ sessionId, direction: 'back' }]), 'history'],
      ['servo_reload', browserInput([{ sessionId }]), 'reload'],
      ['servo_wait', browserInput([{ sessionId }]), 'wait'],
      ['servo_register_font', browserInput([{ sessionId, fontBase64: 'Zm9udA==' }]), 'registerFont'],
      ['servo_get_capabilities', browserInput([{ sessionId }]), 'capabilities'],
    ];
    for (const [name, input, method] of cases) {
      const result = structured(await invoke(name, input));
      expect(result.responses[0]).toMatchObject({ sessionID: sessionId, ok: true });
      expect((defaultSession[method] as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    }
    const browsed = structured(await invoke('servo_navigate', browserInput([{ sessionId, url: 'https://example.com/' }])));
    expect(browsed.responses[0].response.results[0]).toEqual({
      title: 'Example', url: 'https://example.com/', snippet: 'visible page text', content: 'visible page text',
    });
    expect(defaultSession.navigate).toHaveBeenCalledWith('https://example.com/', 10_000);
    expect(defaultSession.click).toHaveBeenCalledWith(3, 4, 0, 10_000);
    expect(defaultSession.scroll).toHaveBeenCalledWith(1, 2, undefined, undefined, 10_000);
    expect(defaultSession.wait).toHaveBeenCalledWith(1_000);
    expect(defaultSession.registerFont).toHaveBeenCalledWith('Zm9udA==');
  });

  it('accepts mixed existing and omitted IDs for every browser-action array', async () => {
    const recordingId = '00000000-0000-4000-8000-000000000003';
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['servo_navigate', { url: 'https://example.com/' }, 'inspect'],
      ['servo_session_status', {}, 'getStatus'], ['servo_inspect', {}, 'inspect'], ['servo_evaluate', { script: '1' }, 'evaluate'],
      ['servo_click', { x: 1, y: 2 }, 'click'], ['servo_type_text', { text: 'x' }, 'typeText'],
      ['servo_press_key', { key: 'Enter' }, 'pressKey'], ['servo_scroll', { deltaX: 0, deltaY: 1 }, 'scroll'],
      ['servo_history', { direction: 'back' }, 'history'], ['servo_reload', {}, 'reload'],
      ['servo_wait', {}, 'wait'], ['servo_screenshot', {}, 'screenshot'],
      ['servo_register_font', { fontBase64: 'Zm9udA==' }, 'registerFont'], ['servo_get_capabilities', {}, 'capabilities'],
      ['servo_recording_start', {}, 'startScreenRecording'], ['servo_recording_stop', { recordingId }, 'stopScreenRecording'],
      ['servo_recording_status', { recordingId }, 'getScreenRecordingStatus'],
      ['servo_recording_download', { recordingId }, 'getScreenRecordingDownloadInfo'],
    ];
    for (const [tool, args, method] of cases) {
      defaultSession.initialize.mockClear();
      defaultSession[method].mockClear();
      const response = structured(await invoke(tool, browserInput([{ sessionId, ...args }, args, args])));
      expect(response.responses).toHaveLength(3);
      expect(response.responses.every((entry: any) => entry.ok)).toBe(true);
      expect(response.responses[0].sessionID).toBe(sessionId);
      expect(new Set(response.responses.map((entry: any) => entry.sessionID)).size).toBe(3);
      expect(defaultSession.initialize).toHaveBeenCalledTimes(2);
      expect(defaultSession[method]).toHaveBeenCalledTimes(tool === 'servo_navigate' ? 2 : tool === 'servo_session_status' ? 4 : 3);
      if (tool === 'servo_recording_download') {
        expect(response.responses[1].response.downloadUrl).toContain(`/recordings/${response.responses[1].sessionID}/`);
      }
    }
  });

  it('never initializes supplied IDs and rejects unknown IDs across every browser tool', async () => {
    defaultSession.getStatus.mockResolvedValue({ status: 'missing' });
    for (const [name, tool] of harness.tools) {
      if (name.startsWith('servo_http_')) continue;
      const inputs: Record<string, unknown> = {
        sessionID: sessionId, url: 'https://example.com/', script: '1', x: 1, y: 2, text: 'x', key: 'Enter',
        deltaX: 0, deltaY: 1, direction: 'back', fontBase64: 'Zm9udA==',
        recordingId: '00000000-0000-4000-8000-000000000003',
      };
      if (name === 'servo_web_search') continue;
      const allowed = tool.definition.inputSchema.shape.actions.element.shape;
      const action = Object.fromEntries(Object.entries(inputs).filter(([key]) => key in allowed));
      const response = structured(await invoke(name, { actions: [action] }));
      expect(response.responses[0]).toMatchObject({ actionIndex: 0, sessionID: sessionId, ok: false, error: expect.stringMatching(/does not exist/) });
    }
    expect(defaultSession.initialize).not.toHaveBeenCalled();
    expect(defaultSession.inspect).not.toHaveBeenCalled();
    expect(defaultSession.screenshot).not.toHaveBeenCalled();
  });

  it('accepts every JSON falsy ID, omission, and undefined without conflating truthy unknown IDs', async () => {
    for (const input of [
      { actions: [{ sessionID: null }, { sessionID: false }, { sessionID: 0 }, { sessionID: '' }, {}] },
      { actions: [{}, {}] },
      ...[null, false, 0, ''].map((sessionID) => ({ actions: [{ sessionID }] })),
    ]) {
      const result = structured(await invoke('servo_inspect', input));
      expect(result.responses.every((entry: any) => entry.ok)).toBe(true);
      expect(result.metadata).toEqual({ responseCount: result.responses.length, successfulCount: result.responses.length, failedCount: 0 });
      expect(new Set(result.responses.map((entry: any) => entry.sessionID)).size).toBe(input.actions.length);
    }
    expect(defaultSession.initialize).toHaveBeenCalledTimes(11);
    defaultSession.getStatus.mockResolvedValue({ status: 'missing' });
    const response = await invoke('servo_inspect', { actions: [{ sessionID: sessionId }, { sessionID: false }] });
    expect(response.isError).toBe(true);
    expect(structured(response).responses[0]).toMatchObject({ sessionID: sessionId, ok: false, code: 'SESSION_NOT_FOUND', status: 404 });
    expect(structured(response).responses[1].ok).toBe(true);
    expect(defaultSession.initialize).toHaveBeenCalledTimes(12);
    expect(() => registeredTool('servo_inspect').definition.inputSchema.parse({ actions: [{ sessionID: '00000000-0000-4000-8000-000000000099' }] })).not.toThrow();
  });

  it('exports the new arrays in every session tool JSON schema and rejects obsolete selectors', () => {
    for (const [name, tool] of harness.tools) {
      if (name === 'servo_web_search') continue;
      const schema = z.toJSONSchema(tool.definition.inputSchema, { io: 'input' }) as any;
      expect(schema.properties).toHaveProperty('actions');
      expect(schema.properties).not.toHaveProperty('sessionIDs');
      if (!name.startsWith('servo_http_')) expect(schema.properties.actions.items.properties).toHaveProperty('sessionID');
      expect(schema.properties).not.toHaveProperty('sessions');
      expect(schema.required).toContain('actions');
    }
    const schema = registeredTool('servo_inspect').definition.inputSchema;
    expect(() => schema.parse({ sessionIDs: [sessionId], actions: [{}] })).toThrow();
    expect(() => schema.parse({ actions: [{ sessionId }] })).toThrow();
  });

  it('validates corresponding array lengths before allocating resources', async () => {
    const tool = registeredTool('servo_inspect');
    expect(() => tool.definition.inputSchema.parse({ actions: [{}, {}], sessionIDs: [null] })).toThrow();
    // The MCP framework validates inputs before invoking a tool handler.
    // Direct handler calls bypass that validation, so assert the schema boundary.
    expect(defaultSession.initialize).not.toHaveBeenCalled();
    for (const name of ['servo_inspect', 'servo_screenshot']) {
      expect(() => registeredTool(name).definition.inputSchema.parse({ actions: [] })).toThrow();
    }
  });

  it('uses resumable IDs and rejects viewport changes on existing tabs', async () => {
    defaultSession.getStatus.mockResolvedValue({ status: 'active', runtimeAvailable: false, resumable: true });
    expect(structured(await invoke('servo_inspect', browserInput([{ sessionId }]))).responses[0].ok).toBe(true);
    expect(defaultSession.initialize).not.toHaveBeenCalled();
    expect(defaultSession.inspect).toHaveBeenCalledOnce();
    expect(structured(await invoke('servo_inspect', browserInput([{ sessionId, width: 800 }]))).responses[0].error)
      .toMatch(/Initial viewport/);
    expect(structured(await invoke('servo_navigate', browserInput([{ sessionId, html: '<p>Updated</p>' }]))).responses[0].ok).toBe(true);
    expect(defaultSession.navigateHtml).toHaveBeenCalledWith('<p>Updated</p>', 10_000);
  });

  it('routes recording start, stop, status, and download tools', async () => {
    const recordingId = '00000000-0000-4000-8000-000000000003';
    const started = structured(await invoke('servo_recording_start', browserInput([{ sessionId, fps: 3, maxDurationSeconds: 12 }])));
    expect(started.responses[0]).toMatchObject({ ok: true, response: { recordingId, status: 'recording' } });
    expect(defaultSession.startScreenRecording).toHaveBeenCalledWith(3, 12);

    const stopped = structured(await invoke('servo_recording_stop', browserInput([{ sessionId, recordingId }])));
    expect(stopped.responses[0]).toMatchObject({ ok: true, response: { status: 'encoding' } });
    expect(defaultSession.stopScreenRecording).toHaveBeenCalledWith(recordingId);

    expect(structured(await invoke('servo_recording_status', browserInput([{ sessionId, recordingId }]))).responses[0])
      .toMatchObject({ ok: true, response: { status: 'ready' } });
    const download = structured(await invoke('servo_recording_download', browserInput([{ sessionId, recordingId }])));
    expect(download.responses[0].response).toMatchObject({
      recordingId, status: 'ready', downloadUrl: `https://worker.example/recordings/${sessionId}/${recordingId}/token`,
      filename: `servo-recording-${recordingId}.mp4`, mimeType: 'video/mp4', sizeBytes: 42,
    });
  });

  it('isolates per-session failures and reports malformed or duplicate calls', async () => {
    const secondId = '00000000-0000-4000-8000-000000000002';
    const second = makeSession();
    sessions.set(secondId, second);
    defaultSession.inspect.mockRejectedValueOnce(new Error('one tab failed'));
    const response = structured(await invoke('servo_inspect', browserInput([{ sessionId }, { sessionId: secondId }])));
    expect(response.responses).toMatchObject([
      { actionIndex: 0, sessionID: sessionId, ok: false, error: 'one tab failed' },
      { actionIndex: 1, sessionID: secondId, ok: true },
    ]);
    defaultSession.inspect.mockRejectedValueOnce('non-error rejection');
    expect(structured(await invoke('servo_inspect', browserInput([{ sessionId }]))).responses[0].error).toBe('Servo request failed.');
    expect(structured(await invoke('servo_navigate', browserInput([{ sessionId, url: 'http://localhost/' }]))).responses[0].error).toMatch(/Private, local/);
    const duplicate = await invoke('servo_inspect', browserInput([{ sessionId }, { sessionId }]));
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toMatch(/only once/);
    const hostileGroups = new Proxy([] as unknown[], {
      get(target, property, receiver) {
        if (property === 'map') throw 'unexpected raw rejection';
        return Reflect.get(target, property, receiver);
      },
    });
    const rawError = await registeredTool('servo_inspect').handler({ actions: hostileGroups });
    expect(rawError.isError).toBe(true);
    expect(rawError.content[0].text).toBe('Servo request failed.');
    expect(() => registeredTool('servo_evaluate').definition.inputSchema.parse(browserInput([{ sessionId, script: 'x'.repeat(65_537) }]))).toThrow();
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
    const result = await invoke('servo_screenshot', browserInput([{ sessionId }, { sessionId: otherId }, { sessionId: thirdId }, { sessionId: fourthId }]));
    expect(result.structuredContent.responses).toMatchObject([
      { actionIndex: 0, sessionID: sessionId, ok: true, response: { imageIndex: 0 } },
      { actionIndex: 1, sessionID: otherId, ok: false, error: 'capture failed' },
      { actionIndex: 2, sessionID: thirdId, ok: true, response: { imageIndex: 1 } },
      { actionIndex: 3, sessionID: fourthId, ok: false, error: 'Servo request failed.' },
    ]);
    expect(result.structuredContent.images).toBeUndefined();
    expect(result.content[0].text).toContain('imageIndex');
    expect(result.content[1]).toMatchObject({ type: 'image', data: Buffer.from(largePng).toString('base64'), mimeType: 'image/png' });
    expect(result.content[2]).toMatchObject({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });
    const duplicate = await invoke('servo_screenshot', browserInput([{ sessionId }, { sessionId }]));
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
      const result = structured(await invoke('servo_http_request', { actions: [{
        url: 'https://example.com/api', method: 'POST', headers: { 'x-test': 'overridden' },
        body: '{"hello":"world"}',
      }] }));
      const requestResult = result.responses[0].response;
      expect(requestResult.request).toMatchObject({ method: 'POST', url: 'https://example.com/api' });
      expect(requestResult.response).toMatchObject({ status: 201, ok: true, contentType: 'text/html; charset=utf-8', headers: { 'x-origin': 'fixture' } });
      expect(requestResult.body).toContain('<title>Sample Page</title>');
      expect(requestResult.results).toEqual([{ title: 'Sample Page', url: 'https://example.com/api', snippet: 'Hello\nVisible & useful', content: 'Hello\nVisible & useful' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('batches HTTP actions in order with isolated failures and no browser allocation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(url.pathname)));
    try {
      for (const [name, tool] of harness.tools) {
        if (!name.startsWith('servo_http_')) continue;
        const response = await invoke(name, { actions: [
          { url: 'https://example.com/first' }, { url: 'http://127.0.0.1/private' }, { url: 'https://example.com/third' },
        ] });
        expect(response.isError).toBe(true);
        expect(structured(response).responses).toMatchObject([
          { actionIndex: 0, ok: true, response: { request: { url: 'https://example.com/first' } } },
          { actionIndex: 1, ok: false, error: expect.stringMatching(/Private, local/) },
          { actionIndex: 2, ok: true, response: { request: { url: 'https://example.com/third' } } },
        ]);
        expect(() => tool.definition.inputSchema.parse({ actions: { url: 'https://example.com/' } })).toThrow();
      }
      expect(env.BROWSER_SESSIONS.getByName).not.toHaveBeenCalled();
      expect(() => registeredTool('servo_navigate').definition.inputSchema.parse({ actions: { url: 'https://example.com/' } })).toThrow();
    } finally { vi.unstubAllGlobals(); }
  });

  it('supports verb-specific tools and blocks unsafe redirect targets and invalid method/body combinations', async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => init.method === 'OPTIONS'
      ? new Response(null, { status: 204 })
      : new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const denied = await invoke('servo_http_get', { actions: [{ url: 'https://example.com/' }] });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/Private, local/);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const options = await invoke('servo_http_options', { actions: [{ url: 'https://example.com/', headers: { 'x-check': 'yes' } }] });
      expect(options.structuredContent.responses[0].response.request.method).toBe('OPTIONS');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const getWithBody = await invoke('servo_http_request', { actions: [{ url: 'https://example.com/', method: 'GET', body: 'invalid' }] });
      expect(getWithBody.isError).toBe(true);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 207 }));
      const extension = await invoke('servo_http_request', { actions: [{ url: 'https://example.com/', method: 'PROPFIND' }] });
      expect(extension.structuredContent.responses[0].response.request.method).toBe('PROPFIND');
      expect(extension.structuredContent.responses[0].response.response.status).toBe(207);
      const unsupported = await invoke('servo_http_request', { actions: [{ url: 'https://example.com/', method: 'CONNECT' }] });
      expect(unsupported.isError).toBe(true);
      expect(unsupported.content[0].text).toMatch(/forbidden by the Fetch API/);
    } finally { vi.unstubAllGlobals(); }
  });
});
