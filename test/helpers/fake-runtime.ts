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
  reloadReturns?: boolean;
  goBackReturns?: boolean;
  goForwardReturns?: boolean;
  pumpResult?: { settled: boolean };
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
  trapped: boolean;
  private evaluatePageCount = 0;

  constructor(private readonly options: FakeRuntimeOptions = {}) {
    this.trapped = options.trapped ?? false;
  }

  private resumeStep(): ResumeStateScript {
    const script = this.options.resumeState;
    if (!script) return {};
    const index = this.evaluatePageCount++;
    if (typeof script === 'function') return script(String(index));
    return script[Math.min(index, script.length - 1)] ?? {};
  }

  private currentSummary(script: string): FakeSummary {
    let summary = typeof this.options.summary === 'function' ? this.options.summary() : this.options.summary;
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

  evaluate(script: string, _opts?: { maxDurationMs?: number }): Promise<unknown> {
    this.calls.push('evaluate');
    if (this.options.evaluations && script in this.options.evaluations) {
      const value = this.options.evaluations[script];
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (script.startsWith('JSON.stringify({url: location.href')) {
      const value: unknown = { Ok: { String: this.summaryJson(script) } };
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (this.options.evaluateThrows) return Promise.reject(this.options.evaluateThrows);
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
    if (this.options.pumpThrows) return Promise.reject(this.options.pumpThrows);
    return Promise.resolve(this.options.pumpResult ?? { settled: true });
  }

  loadPage(url: string): boolean {
    this.calls.push(`loadPage:${url}`);
    return this.options.loadPageReturns ?? true;
  }

  loadHtml(html: string, _opts?: { url?: string }): boolean {
    this.calls.push(`loadHtml:${html.slice(0, 32)}`);
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

  reset(): void {
    this.calls.push('reset');
    if (this.options.resetThrows) throw new Error('fake reset failed');
  }
}

export function snapshotScriptMarker(): string {
  return 'JSON.stringify((()=>';
}
