/**
 * A scriptable in-memory stand-in for the Servo WASM worker runtime returned
 * by `createServoWorkerRuntime`. Tests control its behavior through the
 * options object; every call is recorded so assertions can inspect usage.
 */

export interface FakeEvalCall {
  script: string;
  result: unknown;
}

export interface FakeSummary {
  url?: string;
  title?: string;
  text?: string;
  invalid?: boolean;
}

export interface FakeRuntimeOptions {
  /** Value returned (or thrown) when no scripted evaluation matches. */
  evaluateDefault?: unknown;
  summary?: FakeSummary | FakeSummaryFn | (() => FakeSummary | FakeSummaryFn);
  resumeState?: ResumeStateScript[] | ((script: string) => ResumeStateScript);
  loadPageReturns?: boolean;
  loadHtmlReturns?: boolean;
  loadHtmlThrows?: Error;
  reloadReturns?: boolean;
  goBackReturns?: boolean;
  goForwardReturns?: boolean;
  pumpResult?: { settled: boolean };
  /** Optional factory consulted on every pump call (for scripted gating). */
  pumpFactory?: () => Promise<{ settled: boolean }>;
  pumpThrows?: Error;
  screenshotPng?: Uint8Array;
  screenshotThrows?: Error;
  capabilitiesValue?: unknown;
  registerFontFaces?: number;
  resetThrows?: boolean;
  trapped?: boolean;
  pageResultValue?: unknown;
  evaluateThrows?: Error;
  /** Extra scripted evaluations keyed by exact script text. */
  evaluations?: Record<string, unknown>;
}

export type FakeSummaryFn = (script: string) => FakeSummary;

/** Scripted outcomes for the restore-state expression used while restoring. */
export interface ResumeStateScript {
  evaluatePageReturns?: boolean;
  pageResultValue?: unknown;
}

export class FakeServoRuntime {
  readonly calls: string[] = [];
  readonly evaluations: FakeEvalCall[] = [];
  readonly fonts: Uint8Array[] = [];
  readonly restoredCookies: Uint8Array[] = [];
  trapped: boolean;
  private evaluatePageCount = 0;
  private capturedStorage: Record<string, [string, string][]> = {
    localStorage: [],
    sessionStorage: [],
  };
  private storageCaptures = new Map<string, [string, string][]>();

  constructor(private readonly options: FakeRuntimeOptions = {}) {
    this.trapped = options.trapped ?? false;
  }

  private resumeStep(): ResumeStateScript {
    const script = this.options.resumeState;
    // Always advance the step counter, even when no steps are scripted, so
    // `pageResult()` calls that occur before any `evaluatePage()` (e.g. during
    // restore reloads) consume the correct scripted entry.
    const index = this.evaluatePageCount++;
    if (!script) return {};
    if (typeof script === 'function') return script(String(index));
    return script[Math.min(index, script.length - 1)] ?? {};
  }

  private currentSummary(script: string): FakeSummary {
    const configuredSummary = this.options.summary;
    let summary = configuredSummary;
    if (typeof configuredSummary === 'function') {
      summary = configuredSummary.length === 0
        ? (configuredSummary as () => FakeSummary | FakeSummaryFn)()
        : (configuredSummary as FakeSummaryFn)(script);
    }
    if (typeof summary === 'function') summary = (summary as FakeSummaryFn)(script);
    return summary ?? {};
  }

  private summaryJson(script: string): string {
    const summary = this.currentSummary(script);
    if (summary.invalid) return JSON.stringify({ nope: true });
    return JSON.stringify({
      url: summary.url ?? 'about:blank',
      title: summary.title ?? '',
      text: summary.text ?? '',
    });
  }

  private scriptedEvaluation(script: string): { hit: boolean; value?: unknown } {
    const table = this.options.evaluations;
    if (!table) return { hit: false };
    if (script in table) return { hit: true, value: table[script] };
    // Prefix matching lets tests target the long built-in page-summary and
    // restore-state expressions without pasting their full text.
    for (const key of Object.keys(table)) {
      if (key.length > 0 && key !== '*' && script.startsWith(key)) return { hit: true, value: table[key] };
    }
    if ('*' in table) return { hit: true, value: table['*'] };
    return { hit: false };
  }

  evaluate(script: string, _opts?: { maxDurationMs?: number }): Promise<unknown> {
    this.calls.push('evaluate');
    const scripted = this.scriptedEvaluation(script);
    if (script.includes('const nodePath=')) {
      const payload = scripted.hit ? scripted.value : validResumeStateValue;
      let resumeState: unknown = payload;
      if (payload && typeof payload === 'object' && 'Ok' in payload) {
        const raw = (payload as { Ok?: { String?: unknown } }).Ok?.String;
        if (typeof raw === 'string') {
          try { resumeState = JSON.parse(raw); } catch { /* leave malformed state for the caller to report */ }
        }
      }
      if (resumeState && typeof resumeState === 'object') {
        const state = resumeState as { localStorage?: [string, string][]; sessionStorage?: [string, string][] };
        this.capturedStorage = {
          localStorage: state.localStorage ?? [],
          sessionStorage: state.sessionStorage ?? [],
        };
      }
    }
    if (scripted.hit) {
      this.evaluations.push({ script, result: scripted.value });
      return Promise.resolve(scripted.value);
    }
    if (script.startsWith('JSON.stringify({url: location.href')) {
      const value: unknown = { Ok: { String: this.summaryJson(script) } };
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (this.options.evaluateThrows) return Promise.reject(this.options.evaluateThrows);
    if (script.includes('const nodePath=')) {
      // Default scripted restore state so captureSnapshot succeeds unless the
      // test explicitly scripts that expression via `evaluations`.
      const value: unknown = validResumeStateValue;
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (script.includes("location.origin==='null'") && script.includes('const store=globalThis[')) {
      const storageName = script.match(/const store=globalThis\[("localStorage"|"sessionStorage")\]/)?.[1];
      const temporaryName = script.match(/globalThis\[("__servoMcpStorageCapture_[^"]+")\]=entries/)?.[1];
      if (!storageName || !temporaryName) return Promise.resolve(null);
      const entries = this.capturedStorage[JSON.parse(storageName)] ?? [];
      this.storageCaptures.set(JSON.parse(temporaryName), entries);
      const value = { Ok: { String: JSON.stringify({ count: entries.length }) } };
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (script.includes('const entry=globalThis[')) {
      const temporaryName = script.match(/const entry=globalThis\[("__servoMcpStorageCapture_[^"]+")\]/)?.[1];
      const index = Number(script.match(/\?\.\[(\d+)\]/)?.[1]);
      const offset = Number(script.match(/\.slice\((\d+),/)?.[1]);
      const entry = temporaryName === undefined ? undefined : this.storageCaptures.get(JSON.parse(temporaryName))?.[index];
      if (!entry) return Promise.resolve(null);
      const value = {
        keyLength: entry[0].length,
        valueLength: entry[1].length,
        key: entry[0].slice(offset, offset + 32_768),
        value: entry[1].slice(offset, offset + 32_768),
      };
      const result = { Ok: { String: JSON.stringify(value) } };
      this.evaluations.push({ script, result });
      return Promise.resolve(result);
    }
    if (script.startsWith('delete globalThis[')) {
      const temporaryName = script.match(/delete globalThis\[("__servoMcpStorageCapture_[^"]+")\]/)?.[1];
      if (temporaryName) this.storageCaptures.delete(JSON.parse(temporaryName));
      this.evaluations.push({ script, result: null });
      return Promise.resolve(null);
    }
    if (script.startsWith('(async()=>{')) {
      const step = this.resumeStep();
      this.calls.push('evaluatePage');
      this.calls.push('pageResult');
      let value = step.evaluatePageReturns === false
        ? { Err: 'could not apply the saved tab state' }
        : step.pageResultValue ?? this.options.pageResultValue ?? { Ok: { String: '{"restored":true,"hasStorage":false,"hasCookies":false,"hasIndexedDBState":false,"indexedDatabases":0}' } };
      if (value && typeof value === 'object' && 'Ok' in value) {
        const raw = (value as { Ok?: { String?: unknown } }).Ok?.String;
        if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !('restored' in parsed)) {
              value = { Ok: { String: JSON.stringify({ restored: true, ...parsed }) } };
            }
          } catch { /* preserve scripted malformed JSON for error-path tests */ }
        }
      }
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    const value = this.options.evaluateDefault ?? null;
    this.evaluations.push({ script, result: value });
    return Promise.resolve(value);
  }

  evaluatePage(_script: string): boolean {
    this.calls.push('evaluatePage');
    return this.resumeStep().evaluatePageReturns ?? true;
  }

  pageResult(): unknown {
    this.calls.push('pageResult');
    const scripted = this.resumeStep();
    if ('pageResultValue' in scripted) return scripted.pageResultValue;
    return this.options.pageResultValue ?? { Ok: { String: '{"restored":true,"hasStorage":false,"hasCookies":false}' } };
  }

  pumpUntilSettled(_opts?: { maxDurationMs?: number; maxTurns?: number; networkIdleMs?: number }): Promise<{ settled: boolean }> {
    this.calls.push('pump');
    if (this.options.pumpFactory) return this.options.pumpFactory();
    if (this.options.pumpThrows) return Promise.reject(this.options.pumpThrows);
    return Promise.resolve(this.options.pumpResult ?? { settled: true });
  }

  loadPage(url: string): boolean {
    this.calls.push(`loadPage:${url}`);
    return this.options.loadPageReturns ?? true;
  }

  loadHtml(html: string, _opts?: { url?: string }): boolean {
    this.calls.push(`loadHtml:${html.slice(0, 32)}`);
    if (this.options.loadHtmlThrows) throw this.options.loadHtmlThrows;
    return this.options.loadHtmlReturns ?? true;
  }

  reload(): boolean {
    this.calls.push('reload');
    return this.options.reloadReturns ?? true;
  }

  goBack(): boolean {
    this.calls.push('goBack');
    return this.options.goBackReturns ?? true;
  }

  goForward(): boolean {
    this.calls.push('goForward');
    return this.options.goForwardReturns ?? true;
  }

  click(x: number, y: number, button = 0): void {
    this.calls.push(`click:${x}:${y}:${button}`);
  }

  typeText(text: string): void {
    this.calls.push(`typeText:${text}`);
  }

  pressKey(key: string): void {
    this.calls.push(`pressKey:${key}`);
  }

  scrollBy(deltaX: number, deltaY: number, point?: { x?: number; y?: number }): void {
    this.calls.push(`scrollBy:${deltaX}:${deltaY}:${point?.x}:${point?.y}`);
  }

  async screenshot(_options?: { fullPage?: boolean; maxDurationMs?: number }): Promise<Uint8Array> {
    this.calls.push('screenshot');
    if (this.options.screenshotThrows) throw this.options.screenshotThrows;
    return this.options.screenshotPng ?? new Uint8Array([1, 2, 3]);
  }

  capabilities(): unknown {
    this.calls.push('capabilities');
    return this.options.capabilitiesValue ?? { supported: ['dom'] };
  }

  registerFont(bytes: Uint8Array): number {
    this.calls.push('registerFont');
    this.fonts.push(bytes);
    return this.options.registerFontFaces ?? 1;
  }

  exportCookieState(): Uint8Array {
    this.calls.push('exportCookieState');
    return new Uint8Array([1, 2, 3]);
  }

  restoreCookieState(bytes: Uint8Array): void {
    this.calls.push('restoreCookieState');
    this.restoredCookies.push(bytes);
  }

  reset(): void {
    this.calls.push('reset');
    if (this.options.resetThrows) throw new Error('fake reset failed');
  }
}

/** A summary object missing required keys, used to trigger validation errors. */
export const invalidSummary = { nope: true };

/** The default valid restore-state payload returned by scripted evaluations. */
const validResumeStateValue = {
  Ok: {
    String: JSON.stringify({
      version: 1,
      url: 'https://public.example/page',
      scrollX: 0,
      scrollY: 0,
      fields: [],
      localStorage: [],
      sessionStorage: [],
      cookies: '',
    }),
  },
};

export function snapshotScriptMarker(): string {
  return 'JSON.stringify((()=>';
}
