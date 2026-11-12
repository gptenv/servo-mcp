import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Architectural contract: the MCP package may validate arguments and forward
// calls, but browser scripts and Cloudflare transport are Servo-WASM concerns.
const source = readFileSync(new URL('../src/browser-session.ts', import.meta.url), 'utf8');

describe('Servo-MCP / Servo-WASM implementation boundary', () => {
  it('creates browsers exclusively through the Servo-WASM Cloudflare factory', () => {
    expect(source).toContain('createCloudflareServoBrowser(servoWasm, this.env');
    expect(source).not.toContain('fetchImpl:');
    expect(source).not.toContain('webSocketFactory:');
    expect(source).not.toContain('env.MESH');
  });

  it('delegates DOM and browser-state operations through Servo APIs', () => {
    expect(source).toContain('runtime.captureResumeState(');
    expect(source).toContain('runtime.restoreResumeState(snapshot, url)');
    expect(source).toContain('runtime.captureWebStorage(');
    expect(source).toContain('runtime.documentHtml(');
    expect(source).toContain('runtime.pageSummary()');
    expect(source).toContain('runtime.reloadDocument(');
    expect(source).toContain('runtime.restoreBrowserTab(');
    expect(source).toContain('runtime.hasSavedOrigin(');
    expect(source).not.toContain('resumeStateExpression');
    expect(source).not.toContain('applyResumeState');
    expect(source).not.toContain('snapshotForOrigin');
    expect(source).not.toContain('pageSummaryExpression');
  });

  it('uses the engine implementation for offline previews', () => {
    expect(source).toContain('renderOfflineHtmlPreview(');
    expect(source).not.toContain('new WebSocketPair(');
    expect(source).not.toContain('new Response(html,');
  });
});
