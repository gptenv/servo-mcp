import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import servoWasm from '../servo-wasm/target/wasm32-unknown-unknown/production-stripped/servo_js_wasm.wasm';
import { createServoWorkerRuntime } from '../servo-wasm/ports/servo-js-wasm/worker-adapter.mjs';
import { assertPublicHttpUrl, assertPublicWebSocketUrl } from './security';

const MAX_PERSISTED_HTML_BYTES = 1 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_TOOL_DURATION_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RUNTIME_IDLE_TTL_MS = 90_000;
const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 1_500_000;
const ASSET_CHUNK_CHARS = 1_000_000;
const pageSummaryExpression = `JSON.stringify({url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 20000)})`;
const resumeStateExpression = `JSON.stringify((()=>{
  const nodePath=(node)=>{const path=[];for(let current=node;current&&current!==document.documentElement;current=current.parentElement){const parent=current.parentElement;if(!parent)return null;path.unshift(Array.prototype.indexOf.call(parent.children,current));}return path;};
  const fields=[];
  for(const element of Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]')).slice(0,200)){
    const tag=element.tagName.toLowerCase();
    if(tag==='input'&&['password','file'].includes((element.type||'').toLowerCase()))continue;
    const path=nodePath(element);if(!path)continue;
    if(tag==='input'&&['checkbox','radio'].includes((element.type||'').toLowerCase()))fields.push({path,kind:'checked',value:Boolean(element.checked)});
    else if(tag==='select')fields.push({path,kind:'selected',value:Array.from(element.options).map((option)=>Boolean(option.selected))});
    else if(element.isContentEditable)fields.push({path,kind:'html',value:element.innerHTML.slice(0,2048)});
    else {let selectionStart=null,selectionEnd=null;try{selectionStart=element.selectionStart??null;selectionEnd=element.selectionEnd??null;}catch{}fields.push({path,kind:'value',value:String(element.value??'').slice(0,2048),selectionStart,selectionEnd});}
  }
  const storage=(store)=>{const entries=[];try{for(let i=0;i<Math.min(store.length,50);i++){const key=store.key(i);if(key!==null)entries.push([key.slice(0,256),String(store.getItem(key)??'').slice(0,2048)]);}}catch{}return entries;};
  let cookies='';try{cookies=document.cookie.slice(0,8192);}catch{}
  return {version:1,url:location.href,scrollX:scrollX||0,scrollY:scrollY||0,fields,localStorage:storage(localStorage),sessionStorage:storage(sessionStorage),cookies};
})())`;

type ResumeField = { path: number[]; kind: 'checked' | 'selected' | 'html' | 'value'; value: boolean | boolean[] | string; selectionStart?: number | null; selectionEnd?: number | null };
type ResumeSnapshot = {
  version: 1;
  url: string;
  scrollX: number;
  scrollY: number;
  fields: ResumeField[];
  localStorage: [string, string][];
  sessionStorage: [string, string][];
  cookies: string;
};

export const browserSessionOptionsSchema = z.object({
  sessionId: z.string().uuid(),
  url: z.string().url().max(2048).optional(),
  html: z.string().max(MAX_PERSISTED_HTML_BYTES).optional(),
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(240).max(1600).default(720),
  fontBase64: z.string().max(44_739_244).optional(),
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000),
}).refine((value) => !(value.url && value.html !== undefined), {
  message: 'Provide a URL or inline HTML, not both.',
});

export type BrowserSessionOptions = z.infer<typeof browserSessionOptionsSchema>;
type ServoRuntime = Awaited<ReturnType<typeof createServoWorkerRuntime>>;
type SessionStatus = 'active' | 'closed' | 'expired' | 'interrupted' | 'failed';
type SessionRow = {
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
  width: number;
  height: number;
};

export type PageSummary = { url: string; title: string; text: string };
export type BrowserActionResult = { action: string; page: PageSummary };

function parseEvaluationResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('Ok' in result)) return result;
  const value = (result as { Ok?: { String?: unknown } }).Ok?.String;
  if (typeof value !== 'string') return result;
  try { return JSON.parse(value); } catch { return result; }
}

async function publicFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = assertPublicHttpUrl(input instanceof Request ? input.url : String(input));
  return fetch(url, { ...init, redirect: 'manual' });
}

function publicWebSocket(url: string, protocols?: string | string[]): WebSocket {
  return new WebSocket(assertPublicWebSocketUrl(url), protocols);
}

async function pump(runtime: ServoRuntime, maxDurationMs: number): Promise<void> {
  const result = await runtime.pumpUntilSettled({ maxDurationMs, maxTurns: 2_000, networkIdleMs: 250 });
  if (!result.settled) throw new Error(`Servo did not settle within ${maxDurationMs} ms.`);
}

function pageSummary(runtime: ServoRuntime): Promise<PageSummary> {
  return (async () => {
    if (!runtime.evaluatePage(pageSummaryExpression)) {
      throw new Error('Servo rejected the page summary evaluation.');
    }
    await pump(runtime, 10_000);
    const parsed = parseEvaluationResult(runtime.pageResult());
    if (typeof parsed !== 'object' || parsed === null || !('url' in parsed) || !('title' in parsed) || !('text' in parsed)) {
      throw new Error('Servo returned an invalid page summary.');
    }
    return parsed as PageSummary;
  })();
}

function parseJsonResult(runtime: ServoRuntime): unknown {
  const result = parseEvaluationResult(runtime.pageResult());
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch { return result; }
  }
  return result;
}

const applyResumeState = (snapshot: ResumeSnapshot): string => `(()=>{
  const s=${JSON.stringify(snapshot)};
  const restoreStorage=(store,entries)=>{try{for(const [key,value] of entries)store.setItem(key,value);}catch{}};
  restoreStorage(localStorage,s.localStorage);restoreStorage(sessionStorage,s.sessionStorage);
  if(s.cookies){for(const cookie of s.cookies.split(/;\\s*/)){if(cookie)try{document.cookie=cookie;}catch{}}}
  const nodeAt=(path)=>{let node=document.documentElement;for(const index of path){node=node?.children?.[index];if(!node)return null;}return node;};
  for(const field of s.fields){const node=nodeAt(field.path);if(!node)continue;try{if(field.kind==='checked')node.checked=field.value;else if(field.kind==='selected')Array.from(node.options).forEach((option,index)=>option.selected=Boolean(field.value[index]));else if(field.kind==='html')node.innerHTML=field.value;else{node.value=field.value;if(field.selectionStart!==null&&field.selectionStart!==undefined&&typeof node.setSelectionRange==='function')node.setSelectionRange(field.selectionStart,field.selectionEnd);}}catch{}}
  try{scrollTo(s.scrollX,s.scrollY);}catch{}
  return JSON.stringify({restored:true,hasStorage:s.localStorage.length+s.sessionStorage.length>0,hasCookies:Boolean(s.cookies)});
})()`;

export class ServoBrowserSession extends DurableObject<Env> {
  private runtime: ServoRuntime | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_session (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_snapshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          snapshot_json TEXT NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_asset (
          name TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          chunk_text TEXT NOT NULL,
          PRIMARY KEY (name, chunk_index)
        )
      `);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private row(): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>(
      'SELECT status, created_at, updated_at, expires_at, width, height FROM browser_session WHERE singleton = 1',
    ).toArray()[0];
  }

  private writeStatus(status: SessionStatus, expiresAt = Date.now()): void {
    this.ctx.storage.sql.exec(
      'UPDATE browser_session SET status = ?, updated_at = ?, expires_at = ? WHERE singleton = 1',
      status, Date.now(), expiresAt,
    );
  }

  private async storeAsset(name: string, value: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM browser_asset WHERE name = ?', name);
    for (let offset = 0, chunkIndex = 0; offset < value.length; offset += ASSET_CHUNK_CHARS, chunkIndex++) {
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_asset (name, chunk_index, chunk_text) VALUES (?, ?, ?)',
        name, chunkIndex, value.slice(offset, offset + ASSET_CHUNK_CHARS),
      );
    }
  }

  private readAsset(name: string): string | undefined {
    const chunks = this.ctx.storage.sql.exec<{ chunk_text: string }>(
      'SELECT chunk_text FROM browser_asset WHERE name = ? ORDER BY chunk_index', name,
    ).toArray();
    return chunks.length ? chunks.map((chunk) => chunk.chunk_text).join('') : undefined;
  }

  private saveSnapshot(snapshot: ResumeSnapshot): void {
    const json = JSON.stringify(snapshot);
    if (new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError('Browser restore snapshot exceeded the 1.5 MiB storage limit.');
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO browser_snapshot (singleton, snapshot_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET snapshot_json = excluded.snapshot_json',
      json,
    );
  }

  private loadSnapshot(): ResumeSnapshot | undefined {
    const text = this.ctx.storage.sql.exec<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM browser_snapshot WHERE singleton = 1',
    ).toArray()[0]?.snapshot_json;
    if (!text) return undefined;
    const value = JSON.parse(text) as ResumeSnapshot;
    if (value.version !== 1 || typeof value.url !== 'string' || !Array.isArray(value.fields)) {
      throw new Error('Stored browser restore snapshot has an unsupported format.');
    }
    return value;
  }

  private async captureSnapshot(runtime: ServoRuntime): Promise<void> {
    if (!runtime.evaluatePage(resumeStateExpression)) throw new Error('Servo could not capture browser restore state.');
    await pump(runtime, 2_000);
    const value = parseJsonResult(runtime);
    if (typeof value !== 'object' || value === null || !('url' in value) || !('fields' in value)) {
      throw new Error('Servo returned invalid browser restore state.');
    }
    this.saveSnapshot(value as ResumeSnapshot);
  }

  private async createRuntime(width: number, height: number, sessionId: string): Promise<ServoRuntime> {
    const runtime = await createServoWorkerRuntime(servoWasm, {
      width,
      height,
      url: 'about:blank',
      fetchImpl: publicFetch,
      webSocketFactory: publicWebSocket,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxSubrequests: 50,
      log: (message: string) => console.error(`[servo:${sessionId}] ${message.slice(0, 2048)}`),
    });
    const names = this.ctx.storage.sql.exec<{ name: string }>(
      'SELECT DISTINCT name FROM browser_asset WHERE name LIKE ?', 'font:%',
    ).toArray().map((row) => row.name).sort();
    for (const name of names) {
      const base64 = this.readAsset(name);
      if (!base64) continue;
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      runtime.registerFont(bytes);
    }
    return runtime;
  }

  private async restoreRuntime(row: SessionRow): Promise<ServoRuntime> {
    const snapshot = this.loadSnapshot();
    if (!snapshot) throw new Error('Browser session has no saved tab state to restore.');
    const runtime = await this.createRuntime(row.width, row.height, this.sessionId());
    try {
      const initialHtml = this.readAsset('initial-html');
      const parsedUrl = new URL(snapshot.url);
      const isInlineDocument = parsedUrl.origin === 'https://servo-inline.invalid' && initialHtml !== undefined;
      const isBlankDocument = snapshot.url === 'about:blank';
      const url = isBlankDocument ? snapshot.url : isInlineDocument ? parsedUrl.href : assertPublicHttpUrl(snapshot.url).href;
      const loaded = isBlankDocument || (isInlineDocument
        ? runtime.loadHtml(initialHtml, { url })
        : runtime.loadPage(url));
      if (!loaded) throw new Error('Servo could not reopen the saved tab URL.');
      let restored: { hasStorage?: boolean; hasCookies?: boolean } | undefined;
      if (!isBlankDocument) {
        await pump(runtime, 10_000);
        if (!runtime.evaluatePage(applyResumeState(snapshot))) throw new Error('Servo could not apply the saved tab state.');
        await pump(runtime, 2_000);
        restored = parseJsonResult(runtime) as { hasStorage?: boolean; hasCookies?: boolean } | undefined;
      }
      // Give restored storage and script-visible cookies a chance to initialize
      // the re-opened page, as a browser does when restoring a tab profile.
      if (!isInlineDocument && !isBlankDocument && (restored?.hasStorage || restored?.hasCookies)) {
        if (!runtime.reload()) throw new Error('Servo could not reload the restored tab.');
        await pump(runtime, 10_000);
        if (!runtime.evaluatePage(applyResumeState(snapshot))) throw new Error('Servo could not reapply the saved tab state.');
        await pump(runtime, 2_000);
        runtime.pageResult();
      }
      this.runtime = runtime;
      return runtime;
    } catch (error) {
      try { runtime.reset(); } catch { /* discard a partially restored runtime */ }
      throw error;
    }
  }

  private sessionId(): string {
    return this.ctx.id.toString();
  }

  private async renewLease(): Promise<void> {
    const expiresAt = Date.now() + SESSION_IDLE_TTL_MS;
    this.ctx.storage.sql.exec(
      'UPDATE browser_session SET updated_at = ?, expires_at = ? WHERE singleton = 1 AND status = ?',
      Date.now(), expiresAt, 'active',
    );
    await this.ctx.storage.setAlarm(expiresAt);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Retain the live runtime briefly as a cache. The snapshot and session lease
    // outlive it, so a hibernated or evicted DO can restore the tab on demand.
    this.idleTimer = setTimeout(() => {
      this.serial(async () => {
        this.idleTimer = undefined;
        this.clearRuntime();
      }).catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'servo_runtime_discard_failed', error: String(error) }));
      });
    }, RUNTIME_IDLE_TTL_MS);
  }

  private clearRuntime(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      this.runtime?.reset();
    } catch (error) {
      console.error(JSON.stringify({ event: 'servo_session_reset_failed', error: String(error) }));
    }
    this.runtime = undefined;
  }

  private async expireIfIdle(): Promise<void> {
    const row = this.row();
    if (row?.status !== 'active') return;
    if (row.expires_at > Date.now()) {
      await this.renewLease();
      return;
    }
    this.clearRuntime();
    this.writeStatus('expired');
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
    this.ctx.storage.sql.exec('DELETE FROM browser_asset');
  }

  private async requireRuntime(): Promise<ServoRuntime> {
    const row = this.row();
    if (!row) throw new Error('Browser session does not exist. Create a new Servo browser session.');
    if (row.status !== 'active') {
      throw new Error(`Browser session is ${row.status}. Create a new Servo browser session.`);
    }
    if (row.expires_at <= Date.now()) {
      this.clearRuntime();
      this.writeStatus('expired');
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
      this.ctx.storage.sql.exec('DELETE FROM browser_asset');
      throw new Error('Browser session was reaped after 30 days of inactivity. Create a new Servo browser session.');
    }
    if (this.runtime?.trapped) {
      this.clearRuntime();
    }
    if (!this.runtime) {
      try {
        await this.restoreRuntime(row);
      } catch (error) {
        this.writeStatus('failed');
        await this.ctx.storage.deleteAlarm();
        throw new Error(`Saved tab could not be restored: ${String(error)}`);
      }
    }
    await this.renewLease();
    return this.runtime;
  }

  private async operate<T>(operation: (runtime: ServoRuntime) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const runtime = await this.requireRuntime();
      try {
        return await operation(runtime);
      } finally {
        if (this.runtime === runtime && this.row()?.status === 'active') {
          try {
            await this.captureSnapshot(runtime);
          } catch (error) {
            console.error(JSON.stringify({ event: 'servo_snapshot_failed', error: String(error) }));
          }
          await this.renewLease();
        }
      }
    });
  }

  async initialize(options: BrowserSessionOptions): Promise<{ sessionId: string; page: PageSummary; capabilities: unknown; expiresAt: number }> {
    return this.serial(async () => {
      if (this.row()) throw new Error('This browser session ID has already been initialized.');
      if (options.url) assertPublicHttpUrl(options.url);
      if (options.html !== undefined && new TextEncoder().encode(options.html).byteLength > MAX_PERSISTED_HTML_BYTES) {
        throw new RangeError(`Inline HTML exceeds ${MAX_PERSISTED_HTML_BYTES} UTF-8 bytes, the resumable-session limit.`);
      }

      const now = Date.now();
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_session (singleton, status, created_at, updated_at, expires_at, width, height) VALUES (1, ?, ?, ?, ?, ?, ?)',
        'failed', now, now, now, options.width, options.height,
      );
      try {
        if (options.html !== undefined) await this.storeAsset('initial-html', options.html);
        if (options.fontBase64) await this.storeAsset('font:000000', options.fontBase64);
        const runtime = await this.createRuntime(options.width, options.height, options.sessionId);
        this.runtime = runtime;
        if (options.html !== undefined) {
          if (!runtime.loadHtml(options.html)) throw new Error('Servo rejected the supplied HTML document.');
        } else if (options.url && !runtime.loadPage(options.url)) {
          throw new Error('Servo rejected the requested URL.');
        }
        if (options.url || options.html !== undefined) await pump(runtime, options.maxDurationMs);
        const page = await pageSummary(runtime);
        await this.captureSnapshot(runtime);
        this.writeStatus('active', Date.now() + SESSION_IDLE_TTL_MS);
        await this.renewLease();
        return {
          sessionId: options.sessionId,
          page,
          capabilities: runtime.capabilities(),
          expiresAt: Date.now() + SESSION_IDLE_TTL_MS,
        };
      } catch (error) {
        this.clearRuntime();
        this.writeStatus('failed');
        this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
        this.ctx.storage.sql.exec('DELETE FROM browser_asset');
        throw error;
      }
    });
  }

  async getStatus(): Promise<{ status: SessionStatus | 'missing'; updatedAt?: number; expiresAt?: number; runtimeAvailable: boolean; resumable: boolean }> {
    return this.serial(async () => {
      const row = this.row();
      if (!row) return { status: 'missing', runtimeAvailable: false, resumable: false };
      if (row.status === 'active' && row.expires_at <= Date.now()) {
        this.clearRuntime();
        this.writeStatus('expired');
        await this.ctx.storage.deleteAlarm();
        this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
        this.ctx.storage.sql.exec('DELETE FROM browser_asset');
        return { status: 'expired', updatedAt: row.updated_at, expiresAt: row.expires_at, runtimeAvailable: false, resumable: false };
      }
      if (row.status === 'active' && this.runtime?.trapped) {
        this.clearRuntime();
      }
      return {
        status: row.status,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        runtimeAvailable: Boolean(this.runtime && !this.runtime.trapped),
        resumable: row.status === 'active' && Boolean(this.loadSnapshot()),
      };
    });
  }

  async navigate(url: string, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    assertPublicHttpUrl(url);
    return this.operate(async (runtime) => {
      if (!runtime.loadPage(url)) throw new Error('Servo rejected the requested URL.');
      await pump(runtime, maxDurationMs);
      return { action: 'navigate', page: await pageSummary(runtime) };
    });
  }

  async inspect(): Promise<PageSummary> {
    return this.operate((runtime) => pageSummary(runtime));
  }

  async wait(maxDurationMs = 10_000): Promise<PageSummary> {
    return this.operate(async (runtime) => {
      await pump(runtime, maxDurationMs);
      return pageSummary(runtime);
    });
  }

  async evaluate(script: string, maxDurationMs = 10_000): Promise<{ value: unknown; page: PageSummary }> {
    if (new TextEncoder().encode(script).byteLength > MAX_SCRIPT_BYTES) throw new RangeError('Script exceeds 64 KiB.');
    return this.operate(async (runtime) => {
      if (!runtime.evaluatePage(script)) throw new Error('Servo rejected this page evaluation.');
      await pump(runtime, maxDurationMs);
      return { value: runtime.pageResult(), page: await pageSummary(runtime) };
    });
  }

  async click(x: number, y: number, button = 0, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.click(x, y, button);
      await pump(runtime, maxDurationMs);
      return { action: 'click', page: await pageSummary(runtime) };
    });
  }

  async typeText(text: string, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.typeText(text);
      await pump(runtime, maxDurationMs);
      return { action: 'type', page: await pageSummary(runtime) };
    });
  }

  async pressKey(key: string, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.pressKey(key);
      await pump(runtime, maxDurationMs);
      return { action: 'key', page: await pageSummary(runtime) };
    });
  }

  async scroll(deltaX: number, deltaY: number, x?: number, y?: number, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.scrollBy(deltaX, deltaY, { x, y });
      await pump(runtime, maxDurationMs);
      return { action: 'scroll', page: await pageSummary(runtime) };
    });
  }

  async history(direction: 'back' | 'forward', maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      const navigated = direction === 'back' ? runtime.goBack() : runtime.goForward();
      if (navigated) await pump(runtime, maxDurationMs);
      return { action: direction, page: await pageSummary(runtime) };
    });
  }

  async reload(maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      if (!runtime.reload()) throw new Error('Servo could not reload the current page.');
      await pump(runtime, maxDurationMs);
      return { action: 'reload', page: await pageSummary(runtime) };
    });
  }

  async screenshot(fullPage = false, maxDurationMs = 5_000): Promise<{ page: PageSummary; png: Uint8Array }> {
    return this.operate(async (runtime) => ({
      page: await pageSummary(runtime),
      png: await runtime.screenshot({ fullPage, maxDurationMs }),
    }));
  }

  async capabilities(): Promise<unknown> {
    return this.operate(async (runtime) => runtime.capabilities());
  }

  async registerFont(fontBase64: string): Promise<{ faces: number }> {
    return this.operate(async (runtime) => {
      const binary = atob(fontBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const faces = runtime.registerFont(bytes);
      const count = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(DISTINCT name) AS count FROM browser_asset WHERE name LIKE 'font:%'",
      ).toArray()[0]?.count ?? 0;
      await this.storeAsset(`font:${String(count).padStart(6, '0')}`, fontBase64);
      return { faces };
    });
  }

  async close(): Promise<{ status: 'closed' }> {
    return this.serial(async () => {
      this.clearRuntime();
      const row = this.row();
      if (row && row.status !== 'closed') this.writeStatus('closed');
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
      this.ctx.storage.sql.exec('DELETE FROM browser_asset');
      return { status: 'closed' };
    });
  }

  async alarm(): Promise<void> {
    await this.serial(() => this.expireIfIdle());
  }
}
