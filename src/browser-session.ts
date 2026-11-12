import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import servoWasm from './vendor/servo-worker/servo_js_wasm.wasm';
import { createServoWorkerRuntime, renderOfflineHtmlPreview } from './vendor/servo-worker/worker-adapter.mjs';
import { createCloudflareServoBrowser } from './vendor/servo-worker/worker-adapter.mjs';
import { assertPublicHttpUrl } from './security';
import { type HttpRequest, type ServoHttpResponse } from './http-tools';

const MAX_PERSISTED_HTML_BYTES = 1 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SCREENSHOT_CHUNK_BYTES = 512 * 1024;
const SCREENSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_SCREENSHOTS = 8;
const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ASSET_CHUNK_CHARS = 1_000_000;
const SNAPSHOT_CHUNK_CHARS = 200_000;
const MAX_RECORDING_FPS = 3;
const MAX_RECORDING_DURATION_SECONDS = 60;
const MAX_RECORDING_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_RECORDING_STORAGE_BYTES = 24 * 1024 * 1024;
const MAX_RECORDING_OUTPUT_BYTES = 16 * 1024 * 1024;
const RECORDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_RECORDINGS = 3;
const MAX_RETAINED_RECORDING_BYTES = 64 * 1024 * 1024;
const RECORDING_FRAME_WIDTH = 960;
const RECORDING_FRAME_HEIGHT = 540;
const RECORDING_JPEG_QUALITY = 70;

// Servo keeps the requested HTTP URL on a network-error document, but its
// security origin is opaque. Its storage must never replace the site's state.
type StorageProbe = { localStorage: boolean; sessionStorage: boolean; indexedDB: boolean; fresh?: boolean };
const ALL_STORAGE_PROBES: StorageProbe = { localStorage: true, sessionStorage: true, indexedDB: true };

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
  cookieState?: string;
  indexedDB?: IndexedDatabaseSnapshot[];
  origin?: string;
  localStorageByOrigin?: Record<string, [string, string][]>;
  sessionStorageByOrigin?: Record<string, [string, string][]>;
  indexedDBByOrigin?: Record<string, IndexedDatabaseSnapshot[]>;
  indexedDBStatePresent?: boolean;
  originAssets?: Record<string, string>;
};

type PersistedSnapshotHeader = {
  version: 3;
  url: string;
  origin: string;
  scrollX: number;
  scrollY: number;
  fields: ResumeField[];
  cookies: string;
  cookieState?: string;
  originAssets: Record<string, string>;
};

type OriginStorageSnapshot = {
  localStorage: [string, string][];
  sessionStorage: [string, string][];
  indexedDB: IndexedDatabaseSnapshot[];
};

type IndexedDatabaseSnapshot = {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
    records: Array<{ primaryKey: EncodedGraph; value: EncodedGraph }>;
  }>;
};
type EncodedGraph = { root: unknown; nodes: Array<Record<string, unknown> | null> };

export type PageReadinessOptions = {
  strategy?: 'none' | 'commit' | 'load' | 'domquiet' | 'networkidle';
  quietMs?: number;
  networkIdleMs?: number;
  maxDurationMs?: number;
  pollIntervalMs?: number;
  selector?: string;
};

export const browserSessionOptionsSchema = z.object({
  sessionId: z.string().uuid(),
  url: z.string().url().max(2048).optional(),
  html: z.string().max(MAX_PERSISTED_HTML_BYTES).optional(),
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(240).max(1600).default(720),
  fontBase64: z.string().max(44_739_244).optional(),
  readiness: z.object({
    strategy: z.enum(['none', 'commit', 'load', 'domquiet', 'networkidle']).optional(),
    quietMs: z.number().finite().nonnegative().optional(),
    networkIdleMs: z.number().finite().nonnegative().optional(),
    maxDurationMs: z.number().finite().positive().optional(),
    pollIntervalMs: z.number().finite().positive().optional(),
    selector: z.string().min(1).max(2048).optional(),
  }).optional(),
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

type RecordingStatus = 'recording' | 'encoding' | 'ready' | 'failed' | 'expired';
type RecordingRow = {
  id: string;
  status: RecordingStatus;
  started_at: number;
  stopped_at: number | null;
  expires_at: number;
  fps: number;
  max_duration_ms: number;
  max_frames: number;
  target_frames: number;
  captured_frames: number;
  stored_bytes: number;
  width: number;
  height: number;
  download_token: string | null;
  error: string | null;
};

type RecordingFrameRow = { slot_index: number; jpeg_blob: ArrayBuffer };
type RecordingOutputRow = { chunk_blob: ArrayBuffer };

function sqlBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function sqlBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export type PageSummary = { url: string; title: string; text: string; loadError?: string };
export type BrowserActionResult = { action: string; page: PageSummary };

function parseEvaluationResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('Ok' in result)) return result;
  const value = (result as { Ok?: { String?: unknown } }).Ok?.String;
  if (typeof value !== 'string') return result;
  try { return JSON.parse(value); } catch { return result; }
}

async function pump(runtime: ServoRuntime): Promise<void> {
  await runtime.pumpCooperatively({ maxTurns: 2_000 });
}

async function awaitReady(runtime: ServoRuntime, readiness: PageReadinessOptions = {}): Promise<void> {
  const result = await runtime.waitForPageReady(readiness);
  if (!result.ready) throw new Error('Servo document readiness timed out.');
}

async function pageSummary(runtime: ServoRuntime): Promise<PageSummary> {
  const parsed = await runtime.pageSummary();
  if (typeof parsed !== 'object' || parsed === null || !('url' in parsed) || !('title' in parsed) || !('text' in parsed)) {
    throw new Error('Servo returned an invalid page summary.');
  }
  return parsed as PageSummary;
}

async function pageUrl(runtime: ServoRuntime): Promise<string> {
  try {
    const value = parseEvaluationResult(await runtime.evaluate('location.href'));
    if (typeof value === 'string') return value;
  } catch {
    // Fall back to the complete summary for older runtime adapters.
  }
  return (await pageSummary(runtime)).url;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class ServoBrowserSession extends DurableObject<Env> {
  private runtime: ServoRuntime | undefined;
  private cachedSessionRow: SessionRow | undefined;
  private sessionRowLoaded = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly storageProbeKey = `__servoMcpStorageProbe_${crypto.randomUUID().replaceAll('-', '')}`;
  private recordingTimer: ReturnType<typeof setInterval> | undefined;
  private recordingCapturePending = false;
  // Host fetch failures (DNS, TLS, connection errors) during the current
  // operation, keyed by URL, so a failed page load is reported to the caller.
  private fetchFailures = new Map<string, string>();

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
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_recording (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          stopped_at INTEGER,
          expires_at INTEGER NOT NULL,
          fps INTEGER NOT NULL,
          max_duration_ms INTEGER NOT NULL,
          max_frames INTEGER NOT NULL,
          target_frames INTEGER NOT NULL DEFAULT 0,
          captured_frames INTEGER NOT NULL DEFAULT 0,
          stored_bytes INTEGER NOT NULL DEFAULT 0,
          width INTEGER NOT NULL DEFAULT 0,
          height INTEGER NOT NULL DEFAULT 0,
          download_token TEXT,
          error TEXT
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_recording_frame (
          recording_id TEXT NOT NULL,
          slot_index INTEGER NOT NULL,
          captured_at INTEGER NOT NULL,
          jpeg_blob BLOB NOT NULL,
          PRIMARY KEY (recording_id, slot_index)
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_recording_output (
          recording_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          chunk_blob BLOB NOT NULL,
          PRIMARY KEY (recording_id, chunk_index)
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_widget_screenshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          token TEXT NOT NULL,
          png_blob BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_widget_screenshot_chunk (
          token TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          png_blob BLOB NOT NULL,
          PRIMARY KEY (token, chunk_index)
        )
      `);
      const legacy = ctx.storage.sql.exec<{ token: string; png_blob: ArrayBuffer; updated_at: number }>(
        'SELECT token, png_blob, updated_at FROM browser_widget_screenshot WHERE singleton = 1',
      ).toArray()[0];
      if (legacy) ctx.storage.transactionSync(() => {
        const expiresAt = legacy.updated_at + SCREENSHOT_RETENTION_MS;
        if (expiresAt > Date.now()) this.storeScreenshotChunks(legacy.token, sqlBytes(legacy.png_blob), expiresAt);
        ctx.storage.sql.exec('DELETE FROM browser_widget_screenshot');
      });
      const active = ctx.storage.sql.exec<{ id: string; fps: number }>(
        "SELECT id, fps FROM browser_recording WHERE status = 'recording' LIMIT 1",
      ).toArray()[0];
      if (active) this.startRecordingTimer(active.id, active.fps);
      await this.scheduleNextAlarm();
    });
  }

  private async storageProbe(runtime: ServoRuntime, reset: boolean): Promise<StorageProbe | undefined> {
    try {
      const value = await runtime.probeStorage(this.storageProbeKey, reset);
      if (typeof value !== 'object' || value === null || !('supported' in value) || value.supported !== true
        || !('localStorage' in value) || typeof value.localStorage !== 'boolean'
        || !('sessionStorage' in value) || typeof value.sessionStorage !== 'boolean'
        || !('indexedDB' in value) || typeof value.indexedDB !== 'boolean') return undefined;
      return value as StorageProbe;
    } catch {
      return undefined;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private row(): SessionRow | undefined {
    if (this.sessionRowLoaded) return this.cachedSessionRow;
    this.cachedSessionRow = this.ctx.storage.sql.exec<SessionRow>(
      'SELECT status, created_at, updated_at, expires_at, width, height FROM browser_session WHERE singleton = 1',
    ).toArray()[0];
    this.sessionRowLoaded = this.cachedSessionRow !== undefined;
    return this.cachedSessionRow;
  }

  private recording(id: string): RecordingRow | undefined {
    return this.ctx.storage.sql.exec<RecordingRow>(
      'SELECT * FROM browser_recording WHERE id = ?', id,
    ).toArray()[0];
  }

  private activeRecording(): RecordingRow | undefined {
    return this.ctx.storage.sql.exec<RecordingRow>(
      "SELECT * FROM browser_recording WHERE status = 'recording' LIMIT 1",
    ).toArray()[0];
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer !== undefined) clearInterval(this.recordingTimer);
    this.recordingTimer = undefined;
  }

  private startRecordingTimer(recordingId: string, fps: number): void {
    this.clearRecordingTimer();
    this.recordingTimer = setInterval(() => {
      if (this.recordingCapturePending) return;
      this.recordingCapturePending = true;
      void this.serial(() => this.captureRecordingFrame(recordingId))
        .catch((error) => console.error(JSON.stringify({ event: 'servo_recording_capture_failed', recordingId, error: String(error) })))
        .finally(() => { this.recordingCapturePending = false; });
    }, Math.max(100, Math.floor(1000 / fps)));
  }

  private async scheduleNextAlarm(): Promise<void> {
    const candidates: number[] = [];
    const session = this.row();
    if (session?.status === 'active') candidates.push(session.expires_at);
    const recordingExpiry = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      "SELECT MIN(expires_at) AS expires_at FROM browser_recording WHERE status IN ('ready', 'failed')",
    ).toArray()[0]?.expires_at;
    if (typeof recordingExpiry === 'number') candidates.push(recordingExpiry);
    const screenshotExpiry = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      'SELECT MIN(expires_at) AS expires_at FROM browser_widget_screenshot_chunk WHERE chunk_index = 0',
    ).toArray()[0]?.expires_at;
    if (typeof screenshotExpiry === 'number') candidates.push(screenshotExpiry);
    const encoding = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM browser_recording WHERE status = 'encoding' LIMIT 1",
    ).toArray()[0];
    if (encoding) candidates.push(Date.now() + 1_000);
    if (candidates.length) {
      const nextAlarm = Math.min(...candidates);
      const currentAlarm = await this.ctx.storage.getAlarm();
      // Repeated status polls can call this method while an encode is pending.
      // Preserve an already scheduled earlier wakeup so polling does not keep
      // moving the asynchronous encoder's alarm into the future.
      if (currentAlarm === null || currentAlarm > nextAlarm) {
        await this.ctx.storage.setAlarm(nextAlarm);
      }
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async failRecording(recordingId: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
    const expiresAt = Date.now() + RECORDING_RETENTION_MS;
    this.ctx.storage.sql.exec(
      "UPDATE browser_recording SET status = 'failed', expires_at = ?, error = ?, download_token = NULL WHERE id = ? AND status IN ('recording', 'encoding')",
      expiresAt, message, recordingId,
    );
    this.ctx.storage.sql.exec('DELETE FROM browser_recording_frame WHERE recording_id = ?', recordingId);
    this.ctx.storage.sql.exec('DELETE FROM browser_recording_output WHERE recording_id = ?', recordingId);
    this.clearRecordingTimer();
    await this.scheduleNextAlarm();
  }

  private async beginRecordingEncoding(recording: RecordingRow, stoppedAt = Date.now()): Promise<void> {
    if (recording.status !== 'recording') return;
    const end = Math.min(stoppedAt, recording.started_at + recording.max_duration_ms);
    const elapsed = Math.max(1, end - recording.started_at);
    const lastSlot = this.ctx.storage.sql.exec<{ slot_index: number | null }>(
      'SELECT MAX(slot_index) AS slot_index FROM browser_recording_frame WHERE recording_id = ?', recording.id,
    ).toArray()[0]?.slot_index;
    const targetFrames = Math.min(recording.max_frames, Math.max(
      1,
      Math.ceil(elapsed * recording.fps / 1000),
      typeof lastSlot === 'number' ? lastSlot + 1 : 0,
    ));
    this.ctx.storage.sql.exec(
      "UPDATE browser_recording SET status = 'encoding', stopped_at = ?, target_frames = ?, expires_at = ?, error = NULL WHERE id = ? AND status = 'recording'",
      end, targetFrames, Date.now() + RECORDING_RETENTION_MS, recording.id,
    );
    this.clearRecordingTimer();
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  private async captureRecordingFrame(recordingId: string, initial = false): Promise<void> {
    const recording = this.recording(recordingId);
    if (!recording || recording.status !== 'recording') return;
    const now = Date.now();
    const deadline = recording.started_at + recording.max_duration_ms;
    if (!initial && now >= deadline) {
      await this.beginRecordingEncoding(recording, deadline);
      return;
    }
    const slot = initial ? 0 : Math.min(
      recording.max_frames - 1,
      Math.floor((now - recording.started_at) * recording.fps / 1000),
    );
    const lastSlot = this.ctx.storage.sql.exec<{ slot_index: number | null }>(
      'SELECT MAX(slot_index) AS slot_index FROM browser_recording_frame WHERE recording_id = ?', recordingId,
    ).toArray()[0]?.slot_index;
    if (typeof lastSlot === 'number' && slot <= lastSlot) return;

    try {
      const runtime = await this.requireRuntime();
      const frame = await runtime.captureRecordingFrame({
        maxWidth: RECORDING_FRAME_WIDTH,
        maxHeight: RECORDING_FRAME_HEIGHT,
        quality: RECORDING_JPEG_QUALITY,
      });
      if (frame.jpeg.byteLength > MAX_RECORDING_FRAME_BYTES) {
        throw new RangeError(`A recording frame exceeded ${MAX_RECORDING_FRAME_BYTES} bytes.`);
      }
      const current = this.recording(recordingId);
      if (!current || current.status !== 'recording') return;
      if (current.stored_bytes + frame.jpeg.byteLength > MAX_RECORDING_STORAGE_BYTES) {
        throw new RangeError(`Recording frames exceeded ${MAX_RECORDING_STORAGE_BYTES} bytes of temporary storage.`);
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_recording_frame (recording_id, slot_index, captured_at, jpeg_blob) VALUES (?, ?, ?, ?)',
        recordingId, slot, Date.now(), sqlBuffer(frame.jpeg),
      );
      this.ctx.storage.sql.exec(
        'UPDATE browser_recording SET captured_frames = captured_frames + 1, stored_bytes = stored_bytes + ?, width = ?, height = ? WHERE id = ? AND status = ?',
        frame.jpeg.byteLength, frame.width, frame.height, recordingId, 'recording',
      );
      const updated = this.recording(recordingId);
      if (updated && (updated.captured_frames >= updated.max_frames || Date.now() >= deadline)) {
        await this.beginRecordingEncoding(updated, Math.min(Date.now(), deadline));
      }
    } catch (error) {
      await this.failRecording(recordingId, error);
    }
  }

  private async pruneExpiredRecordings(now = Date.now()): Promise<void> {
    const expired = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM browser_recording WHERE status IN ('ready', 'failed') AND expires_at <= ?", now,
    ).toArray();
    for (const { id } of expired) {
      this.ctx.storage.sql.exec('DELETE FROM browser_recording_frame WHERE recording_id = ?', id);
      this.ctx.storage.sql.exec('DELETE FROM browser_recording_output WHERE recording_id = ?', id);
      this.ctx.storage.sql.exec("UPDATE browser_recording SET status = 'expired', download_token = NULL, error = NULL WHERE id = ?", id);
    }
  }

  private evictOldRecordingsFor(incomingBytes: number): void {
    const ready = this.ctx.storage.sql.exec<{ id: string; stored_bytes: number }>(
      "SELECT id, stored_bytes FROM browser_recording WHERE status = 'ready' ORDER BY started_at ASC",
    ).toArray();
    let retainedBytes = ready.reduce((total, recording) => total + recording.stored_bytes, 0);
    while (ready.length >= MAX_RETAINED_RECORDINGS || retainedBytes + incomingBytes > MAX_RETAINED_RECORDING_BYTES) {
      const oldest = ready.shift();
      if (!oldest) break;
      retainedBytes -= oldest.stored_bytes;
      this.ctx.storage.sql.exec('DELETE FROM browser_recording_output WHERE recording_id = ?', oldest.id);
      this.ctx.storage.sql.exec('DELETE FROM browser_recording_frame WHERE recording_id = ?', oldest.id);
      this.ctx.storage.sql.exec(
        "UPDATE browser_recording SET status = 'expired', download_token = NULL, error = NULL WHERE id = ?",
        oldest.id,
      );
    }
  }

  private clearStoredPage(): void {
    this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
    this.ctx.storage.sql.exec('DELETE FROM browser_asset');
    this.ctx.storage.sql.exec('DELETE FROM browser_widget_screenshot_chunk');
  }

  private writeStatus(status: SessionStatus, expiresAt = Date.now()): void {
    const updatedAt = Date.now();
    this.ctx.storage.sql.exec(
      'UPDATE browser_session SET status = ?, updated_at = ?, expires_at = ? WHERE singleton = 1',
      status, updatedAt, expiresAt,
    );
    if (this.cachedSessionRow) {
      this.cachedSessionRow = { ...this.cachedSessionRow, status, updated_at: updatedAt, expires_at: expiresAt };
    }
  }

  private storeAsset(name: string, value: string, chunkChars = ASSET_CHUNK_CHARS): void {
    this.ctx.storage.sql.exec('DELETE FROM browser_asset WHERE name = ?', name);
    let chunkIndex = 0;
    for (let offset = 0; offset < value.length; chunkIndex++) {
      let end = Math.min(offset + chunkChars, value.length);
      if (end < value.length && end > offset && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_asset (name, chunk_index, chunk_text) VALUES (?, ?, ?)',
        name, chunkIndex, value.slice(offset, end),
      );
      offset = end;
    }
  }

  private readAsset(name: string): string | undefined {
    const chunks = this.ctx.storage.sql.exec<{ chunk_text: string }>(
      'SELECT chunk_text FROM browser_asset WHERE name = ? ORDER BY chunk_index', name,
    ).toArray();
    return chunks.length ? chunks.map((chunk) => chunk.chunk_text).join('') : undefined;
  }

  private snapshotRecord(): { json: string; value: Record<string, unknown> } | undefined {
    const json = this.ctx.storage.sql.exec<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM browser_snapshot WHERE singleton = 1',
    ).toArray()[0]?.snapshot_json;
    if (!json) return undefined;
    return { json, value: JSON.parse(json) as Record<string, unknown> };
  }

  private loadSnapshot(url?: string): ResumeSnapshot | undefined {
    const record = this.snapshotRecord();
    if (!record) return undefined;
    if (record.value.version === 3 && typeof record.value.url === 'string'
      && typeof record.value.origin === 'string' && typeof record.value.originAssets === 'object'
      && record.value.originAssets !== null) {
      const header = record.value as unknown as PersistedSnapshotHeader;
      const targetUrl = url ?? header.url;
      const origin = new URL(targetUrl).origin;
      const assetName = header.originAssets[origin];
      if (!assetName) return undefined;
      const data = this.readAsset(assetName);
      if (!data) throw new Error(`Browser restore data for ${origin} is missing.`);
      const storage = JSON.parse(data) as OriginStorageSnapshot;
      return {
        version: 1,
        url: targetUrl,
        origin,
        scrollX: targetUrl === header.url ? header.scrollX : 0,
        scrollY: targetUrl === header.url ? header.scrollY : 0,
        fields: targetUrl === header.url ? header.fields : [],
        cookies: header.cookies,
        cookieState: header.cookieState,
        localStorage: storage.localStorage,
        sessionStorage: storage.sessionStorage,
        indexedDB: storage.indexedDB,
        indexedDBStatePresent: true,
        originAssets: header.originAssets,
      };
    }

    let text = record.json;
    try {
      const pointer = record.value as { version?: number; assetName?: string };
      if (pointer.version === 2 && typeof pointer.assetName === 'string') {
        const chunked = this.readAsset(pointer.assetName);
        if (!chunked) throw new Error('Browser restore snapshot data is missing.');
        text = chunked;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Browser restore snapshot data is missing.') throw error;
      // Snapshot version 1 stored the full JSON directly in this column.
    }
    const value = JSON.parse(text) as ResumeSnapshot;
    if (value.version !== 1 || typeof value.url !== 'string' || !Array.isArray(value.fields)) {
      throw new Error('Stored browser restore snapshot has an unsupported format.');
    }
    return value;
  }

  private hasSnapshot(): boolean {
    const record = this.snapshotRecord();
    if (!record) return false;
    if (record.value.version === 3 && typeof record.value.url === 'string'
      && typeof record.value.originAssets === 'object' && record.value.originAssets !== null) {
      const origin = new URL(record.value.url).origin;
      return typeof (record.value.originAssets as Record<string, unknown>)[origin] === 'string';
    }
    return true;
  }

  private async captureSnapshot(runtime: ServoRuntime, resources: StorageProbe = ALL_STORAGE_PROBES): Promise<void> {
    const cookieState = bytesToBase64(runtime.exportCookieState());
    const value = await runtime.captureResumeState({ captureIndexedDB: resources.indexedDB });
    if (typeof value === 'object' && value !== null && 'opaqueDocument' in value && value.opaqueDocument === true) return;
    if (typeof value !== 'object' || value === null || !('url' in value) || !('fields' in value)) {
      throw new Error(`Servo returned invalid browser restore state: ${JSON.stringify(value).slice(0, 512)}`);
    }
    const snapshot = value as ResumeSnapshot;
    snapshot.cookieState = cookieState;
    const resourcesTouched = resources.localStorage || resources.sessionStorage || resources.indexedDB;
    const existingStorage = resourcesTouched ? this.loadSnapshot(snapshot.url) : undefined;
    snapshot.localStorage = resources.localStorage
      ? await runtime.captureWebStorage('localStorage')
      : existingStorage?.localStorage ?? [];
    snapshot.sessionStorage = resources.sessionStorage
      ? await runtime.captureWebStorage('sessionStorage')
      : existingStorage?.sessionStorage ?? [];
    snapshot.indexedDB = resources.indexedDB ? snapshot.indexedDB ?? [] : existingStorage?.indexedDB ?? [];
    const origin = snapshot.origin ?? new URL(snapshot.url).origin;
    const previous = this.snapshotRecord();
    const originAssets: Record<string, string> = {};
    const legacyAssetNames: string[] = [];
    if (previous?.value.version === 3 && typeof previous.value.originAssets === 'object' && previous.value.originAssets !== null) {
      Object.assign(originAssets, previous.value.originAssets);
    } else if (previous) {
      const legacy = this.loadSnapshot();
      if (legacy) {
        const localByOrigin = legacy.localStorageByOrigin ?? {};
        const sessionByOrigin = legacy.sessionStorageByOrigin ?? {};
        const indexedByOrigin = legacy.indexedDBByOrigin ?? {};
        const origins = new Set([
          ...Object.keys(localByOrigin),
          ...Object.keys(sessionByOrigin),
          ...Object.keys(indexedByOrigin),
        ]);
        const legacyOrigin = legacy.origin ?? new URL(legacy.url).origin;
        origins.add(legacyOrigin);
        for (const savedOrigin of origins) {
          const name = `origin:${crypto.randomUUID()}`;
          const state: OriginStorageSnapshot = {
            localStorage: localByOrigin[savedOrigin] ?? (savedOrigin === legacyOrigin ? legacy.localStorage : []),
            sessionStorage: sessionByOrigin[savedOrigin] ?? (savedOrigin === legacyOrigin ? legacy.sessionStorage : []),
            indexedDB: indexedByOrigin[savedOrigin] ?? (savedOrigin === legacyOrigin ? legacy.indexedDB ?? [] : []),
          };
          this.storeAsset(name, JSON.stringify(state), SNAPSHOT_CHUNK_CHARS);
          originAssets[savedOrigin] = name;
        }
      }
      const oldPointer = previous.value as { version?: number; assetName?: string };
      if (oldPointer.version === 2 && oldPointer.assetName) legacyAssetNames.push(oldPointer.assetName);
    }

    let replacedOriginAsset: string | undefined;
    if (resourcesTouched || typeof originAssets[origin] !== 'string') {
      const assetName = `origin:${crypto.randomUUID()}`;
      const originState: OriginStorageSnapshot = {
        localStorage: snapshot.localStorage,
        sessionStorage: snapshot.sessionStorage,
        indexedDB: snapshot.indexedDB ?? [],
      };
      this.storeAsset(assetName, JSON.stringify(originState), SNAPSHOT_CHUNK_CHARS);
      replacedOriginAsset = originAssets[origin];
      originAssets[origin] = assetName;
    }
    const header: PersistedSnapshotHeader = {
      version: 3,
      url: snapshot.url,
      origin,
      scrollX: snapshot.scrollX,
      scrollY: snapshot.scrollY,
      fields: snapshot.fields,
      cookies: snapshot.cookies,
      cookieState,
      originAssets,
    };
    this.ctx.storage.sql.exec(
      'INSERT INTO browser_snapshot (singleton, snapshot_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET snapshot_json = excluded.snapshot_json',
      JSON.stringify(header),
    );
    if (replacedOriginAsset && replacedOriginAsset !== originAssets[origin]) {
      this.ctx.storage.sql.exec('DELETE FROM browser_asset WHERE name = ?', replacedOriginAsset);
    }
    for (const legacyAsset of legacyAssetNames) {
      this.ctx.storage.sql.exec('DELETE FROM browser_asset WHERE name = ?', legacyAsset);
    }
  }

  private async applySavedState(runtime: ServoRuntime, snapshot: ResumeSnapshot, url: string, reapplying = false) {
    const result = await runtime.restoreResumeState(snapshot, url);
    if (typeof result !== 'object' || result === null || !('restored' in result)) {
      const action = reapplying ? 'reapply' : 'apply';
      throw new Error(`Servo could not ${action} the saved tab state: ${JSON.stringify(result).slice(0, 512)}`);
    }
    await pump(runtime);
    return result as { hasStorage?: boolean; hasCookies?: boolean; hasIndexedDBState?: boolean; indexedDatabases?: number };
  }

  private inlineDocumentHtml(url: string | null): string | undefined {
    if (!url || new URL(url).origin !== 'https://servo-inline.invalid') return undefined;
    return this.readAsset('initial-html');
  }

  private async reloadDocument(runtime: ServoRuntime, readiness: PageReadinessOptions, rejectionMessage: string): Promise<void> {
    const current = await runtime.navigationIdentity();
    await runtime.reloadDocument({
      readiness, rejectionMessage,
      inlineHtml: this.inlineDocumentHtml(current.url),
    });
  }

  private async restoreNavigatedOrigin(runtime: ServoRuntime, url: string): Promise<void> {
    const snapshot = this.loadSnapshot(url);
    if (!snapshot) return;
    if (!snapshot.originAssets && !runtime.hasSavedOrigin(snapshot, url)) return;
    const restored = await this.applySavedState(runtime, snapshot, url);
    if (restored.hasStorage || restored.hasCookies || restored.hasIndexedDBState || restored.indexedDatabases) {
      await this.reloadDocument(runtime, {}, 'Servo could not reload after restoring this tab origin.');
      await this.applySavedState(runtime, snapshot, url, true);
    }
  }

  // URL-based initialization passes its URL to the adapter bootstrap; do not queue a second loadPage().

  private async createRuntime(width: number, height: number, sessionId: string, savedCookieState?: string, initialUrl = 'about:blank', readiness?: PageReadinessOptions): Promise<ServoRuntime> {
    const runtime = await createCloudflareServoBrowser(servoWasm, this.env, {
      width,
      height,
      url: initialUrl,
      readiness: readiness ?? {},
      onNetworkResult: (url: string, status: number | null, error: unknown) => {
        if (error !== null) this.fetchFailures.set(url, error instanceof Error ? error.message : String(error));
        else if (status !== null && status >= 400) this.fetchFailures.set(url, 'HTTP ' + status);
      },
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
    const cookieState = savedCookieState ?? this.readAsset('cookie-state');
    if (cookieState) runtime.restoreCookieState(base64ToBytes(cookieState));
    return runtime;
  }

  private async restoreRuntime(row: SessionRow): Promise<ServoRuntime> {
    const snapshot = this.loadSnapshot();
    if (!snapshot) throw new Error('Browser session has no saved tab state to restore.');
    const runtime = await this.createRuntime(row.width, row.height, this.sessionId(), snapshot.cookieState);
    try {
      const inlineHtml = this.inlineDocumentHtml(snapshot.url);
      const url = inlineHtml !== undefined || snapshot.url === 'about:blank'
        ? snapshot.url
        : assertPublicHttpUrl(snapshot.url).href;
      await runtime.restoreBrowserTab({ snapshot, url, inlineHtml });
      await this.storageProbe(runtime, true);
      this.runtime = runtime;
      return runtime;
    } catch (error) {
      try { runtime.reset(); } catch { /* discard a partially restored runtime */ }
      throw error;
    }
  }

  private async summary(runtime: ServoRuntime): Promise<PageSummary> {
    const page = await pageSummary(runtime);
    const failure = this.fetchFailures.get(page.url);
    return failure === undefined ? page : { ...page, loadError: `The page could not be loaded: ${failure}` };
  }

  private sessionId(): string {
    return this.ctx.id.toString();
  }

  private async renewLease(): Promise<void> {
    const updatedAt = Date.now();
    const expiresAt = Date.now() + SESSION_IDLE_TTL_MS;
    this.ctx.storage.sql.exec(
      'UPDATE browser_session SET updated_at = ?, expires_at = ? WHERE singleton = 1 AND status = ?',
      updatedAt, expiresAt, 'active',
    );
    if (this.cachedSessionRow?.status === 'active') {
      this.cachedSessionRow = { ...this.cachedSessionRow, updated_at: updatedAt, expires_at: expiresAt };
    }
    await this.scheduleNextAlarm();
    // Do not retain the runtime with a JS timer. Any pending setTimeout keeps
    // this Durable Object from hibernating and accruing duration charges. Once
    // the request and snapshot writes finish, let Cloudflare hibernate the DO;
    // a later browser operation restores the runtime from the durable snapshot.
  }

  private clearRuntime(): void {
    try {
      this.runtime?.reset();
    } catch (error) {
      console.error(JSON.stringify({ event: 'servo_session_reset_failed', error: String(error) }));
    }
    this.runtime = undefined;
  }

  private async expireIfIdle(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM browser_widget_screenshot_chunk WHERE expires_at <= ?', Date.now());
    await this.pruneExpiredRecordings();
    const row = this.row();
    if (row?.status === 'active') {
      if (row.expires_at > Date.now()) {
        await this.scheduleNextAlarm();
        return;
      }
      const recording = this.activeRecording();
      if (recording) await this.failRecording(recording.id, 'The browser session expired while recording.');
      this.clearRuntime();
      this.writeStatus('expired');
      this.clearStoredPage();
    }
    await this.scheduleNextAlarm();
  }

  private async requireRuntime(): Promise<ServoRuntime> {
    const row = this.row();
    if (!row) throw new Error('Browser session does not exist. Omit sessionID or supply a falsy value on a browser action to create a new tab.');
    if (row.status !== 'active') {
      throw new Error(`Browser session is ${row.status}. Omit sessionID or supply a falsy value on a browser action to create a new tab.`);
    }
    if (row.expires_at <= Date.now()) {
      const recording = this.activeRecording();
      if (recording) await this.failRecording(recording.id, 'The browser session expired while recording.');
      this.clearRuntime();
      this.writeStatus('expired');
      this.clearStoredPage();
      await this.scheduleNextAlarm();
      throw new Error('Browser session was reaped after 30 days of inactivity. Omit sessionID or supply a falsy value on a browser action to create a new tab.');
    }
    if (this.runtime?.trapped) {
      this.clearRuntime();
    }
    if (!this.runtime) {
      try {
        await this.restoreRuntime(row);
      } catch (error) {
        this.writeStatus('failed');
        await this.scheduleNextAlarm();
        throw new Error(`Saved tab could not be restored: ${String(error)}`);
      }
    }
    return this.runtime;
  }

  private async operate<T>(
    operation: (runtime: ServoRuntime) => Promise<T>,
    afterOriginRestore?: (runtime: ServoRuntime, result: Awaited<T>) => Promise<Awaited<T>>,
  ): Promise<T> {
    return this.serial(async () => {
      this.fetchFailures.clear();
      const runtime = await this.requireRuntime();
      try {
        const previousUrl = await pageUrl(runtime);
        let result: Awaited<T> = await operation(runtime);
        const resultObject = typeof result === 'object' && result !== null ? result as Record<string, unknown> : undefined;
        const resultPage = resultObject && 'page' in resultObject ? resultObject.page as PageSummary : resultObject as PageSummary | undefined;
        // An HTTP response also has a URL. Never mistake response metadata for
        // the active browsing document's origin when deciding which saved
        // storage to restore. Only the Servo browsing context is authoritative.
        const currentUrl = await pageUrl(runtime);
        if (new URL(previousUrl).origin !== new URL(currentUrl).origin) {
          await this.restoreNavigatedOrigin(runtime, currentUrl);
          const restoredPage = await this.summary(runtime);
          if (typeof result === 'object' && result !== null && 'page' in result) {
            result = { ...result, page: restoredPage } as Awaited<T>;
          } else if (typeof result === 'object' && result !== null && 'url' in result && 'title' in result) {
            result = restoredPage as Awaited<T>;
          }
        }
        if (afterOriginRestore) result = await afterOriginRestore(runtime, result);
        return result;
      } finally {
        if (this.runtime === runtime && this.row()?.status === 'active') {
          try {
            const probeAtEnd = await this.storageProbe(runtime, false);
            const resources = !probeAtEnd || probeAtEnd.fresh
              ? ALL_STORAGE_PROBES
              : probeAtEnd;
            await this.captureSnapshot(runtime, resources);
            await this.storageProbe(runtime, true);
          } catch (error) {
            console.error(JSON.stringify({ event: 'servo_snapshot_failed', error: String(error) }));
            throw error;
          }
          await this.renewLease();
        }
      }
    });
  }

  async initialize(options: BrowserSessionOptions): Promise<{ sessionId: string; page: PageSummary; capabilities: unknown; expiresAt: number }> {
    return this.serial(async () => {
      if (this.row()) throw new Error('This browser session ID has already been initialized.');
      this.fetchFailures.clear();
      if (options.url) assertPublicHttpUrl(options.url);
      if (options.html !== undefined && new TextEncoder().encode(options.html).byteLength > MAX_PERSISTED_HTML_BYTES) {
        throw new RangeError(`Inline HTML exceeds ${MAX_PERSISTED_HTML_BYTES} UTF-8 bytes, the resumable-session limit.`);
      }

      const now = Date.now();
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_session (singleton, status, created_at, updated_at, expires_at, width, height) VALUES (1, ?, ?, ?, ?, ?, ?)',
        'failed', now, now, now, options.width, options.height,
      );
      this.cachedSessionRow = {
        status: 'failed', created_at: now, updated_at: now, expires_at: now,
        width: options.width, height: options.height,
      };
      this.sessionRowLoaded = true;
      try {
        if (options.html !== undefined) await this.storeAsset('initial-html', options.html);
        if (options.fontBase64) await this.storeAsset('font:000000', options.fontBase64);
        const runtime = await this.createRuntime(options.width, options.height, options.sessionId, undefined, options.url ?? 'about:blank', options.readiness);
        this.runtime = runtime;
        if (options.html !== undefined) {
          await runtime.navigateHtml(options.html, { readiness: options.readiness ?? {} });
        }
        const page = await this.summary(runtime);
        if ((options.url || options.html !== undefined) && page.url === 'about:blank') {
          throw new Error('Servo accepted the initial navigation but remained at about:blank; the page was not loaded.');
        }
        await this.captureSnapshot(runtime);
        await this.storageProbe(runtime, true);
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
        this.clearStoredPage();
        throw error;
      }
    });
  }

  async getStatus(): Promise<{ status: SessionStatus | 'missing'; updatedAt?: number; expiresAt?: number; runtimeAvailable: boolean; resumable: boolean }> {
    return this.serial(async () => {
      const row = this.row();
      if (!row) return { status: 'missing', runtimeAvailable: false, resumable: false };
      if (row.status === 'active' && row.expires_at <= Date.now()) {
        const recording = this.activeRecording();
        if (recording) await this.failRecording(recording.id, 'The browser session expired while recording.');
        this.clearRuntime();
        this.writeStatus('expired');
        this.clearStoredPage();
        await this.scheduleNextAlarm();
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
        resumable: row.status === 'active' && this.hasSnapshot(),
      };
    });
  }

  async navigate(url: string, readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    assertPublicHttpUrl(url);
    return this.operate(async (runtime) => {
      await runtime.navigate(url, readiness);
      const page = await this.summary(runtime);
      return { action: 'navigate', page };
    });
  }

  async navigateHtml(html: string, readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    if (new TextEncoder().encode(html).byteLength > MAX_PERSISTED_HTML_BYTES) {
      throw new RangeError(`Inline HTML exceeds ${MAX_PERSISTED_HTML_BYTES} UTF-8 bytes, the resumable-session limit.`);
    }
    return this.operate(async (runtime) => {
      await runtime.navigateHtml(html, { readiness });
      await this.storeAsset('initial-html', html);
      return { action: 'navigate', page: await this.summary(runtime) };
    });
  }

  /**
   * Run HTTP requests inside the current Servo browsing context, preserving
   * Servo's cookie jar, origin, redirect behavior, and CORS enforcement.
   */
  async requestHttp(input: HttpRequest): Promise<ServoHttpResponse> {
    const url = assertPublicHttpUrl(input.url).href;
    return this.operate(async runtime => runtime.requestHttp({ ...input, url }) as Promise<ServoHttpResponse>);
  }

  /**
   * Navigate a real Servo tab and parse its final DOM after any saved
   * per-origin state was restored. Keep navigation, restoration and extraction
   * inside the same serialized operation to prevent interleaved actions.
   */
  async navigateAndReadHtml(url: string): Promise<{ html: string; page: PageSummary }> {
    assertPublicHttpUrl(url);
    return this.operate(async (runtime) => {
      await runtime.navigate(url, { maxDurationMs: 5000 });
      const page = await this.summary(runtime);
      if (page.loadError) throw new Error(page.loadError);
      return { html: '', page };
    }, async (runtime) => {
      const page = await this.summary(runtime);
      if (page.loadError) throw new Error(page.loadError);
      const html = await runtime.documentHtml();
      return { html, page };
    });
  }

  async inspect(readiness: PageReadinessOptions = {}): Promise<PageSummary> {
    return this.operate(async (runtime) => {
      await awaitReady(runtime, readiness);
      return this.summary(runtime);
    });
  }

  async wait(readiness: PageReadinessOptions = {}): Promise<PageSummary> {
    return this.operate(async (runtime) => {
      await pump(runtime);
      await awaitReady(runtime, readiness);
      return this.summary(runtime);
    });
  }

  async evaluate(script: string, readiness: PageReadinessOptions = {}): Promise<{ value: unknown; page: PageSummary }> {
    if (new TextEncoder().encode(script).byteLength > MAX_SCRIPT_BYTES) throw new RangeError('Script exceeds 64 KiB.');
    return this.operate(async (runtime) => {
      const value = await runtime.evaluate(script);
      await awaitReady(runtime, readiness);
      return { value, page: await this.summary(runtime) };
    });
  }

  async click(x: number, y: number, button = 0, readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.click(x, y, button);
      await pump(runtime);
      await awaitReady(runtime, readiness);
      return { action: 'click', page: await this.summary(runtime) };
    });
  }

  async typeText(text: string, readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.typeText(text);
      await pump(runtime);
      await awaitReady(runtime, readiness);
      return { action: 'type', page: await this.summary(runtime) };
    });
  }

  async pressKey(key: string, readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.pressKey(key);
      await pump(runtime);
      await awaitReady(runtime, readiness);
      return { action: 'key', page: await this.summary(runtime) };
    });
  }

  async scroll(deltaX: number, deltaY: number, x?: number, y?: number, readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.scrollBy(deltaX, deltaY, { x, y });
      await pump(runtime);
      await awaitReady(runtime, readiness);
      return { action: 'scroll', page: await this.summary(runtime) };
    });
  }

  async history(direction: 'back' | 'forward', readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      const navigated = direction === 'back' ? runtime.goBack() : runtime.goForward();
      if (navigated) {
        await pump(runtime);
        await awaitReady(runtime, readiness);
      }
      return { action: direction, page: await this.summary(runtime) };
    });
  }

  async reload(readiness: PageReadinessOptions = {}): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      await this.reloadDocument(runtime, readiness, 'Servo could not reload the current page.');
      return { action: 'reload', page: await this.summary(runtime) };
    });
  }

  async screenshot(fullPage = false, readiness: PageReadinessOptions = {}): Promise<{ page: PageSummary; png: Uint8Array }> {
    return this.operate(async (runtime) => {
      const png = await runtime.screenshot({ fullPage, readiness });
      return { page: await this.summary(runtime), png };
    });
  }

  private async finalizeRecording(recordingId: string): Promise<void> {
    const recording = this.recording(recordingId);
    if (!recording || recording.status !== 'encoding') return;
    try {
      const runtime = await this.requireRuntime();
      const { encodeRecordingMp4 } = await import('./recording-encoder');
      const encodedOutput = await encodeRecordingMp4({
        width: recording.width,
        height: recording.height,
        fps: recording.fps,
        totalFrames: recording.target_frames,
        maxOutputBytes: MAX_RECORDING_OUTPUT_BYTES,
        nextFrame: async (afterSlot) => {
          const frame = this.ctx.storage.sql.exec<RecordingFrameRow>(
            'SELECT slot_index, jpeg_blob FROM browser_recording_frame WHERE recording_id = ? AND slot_index > ? ORDER BY slot_index LIMIT 1',
            recordingId, afterSlot,
          ).toArray()[0];
          return frame
            ? { slot: frame.slot_index, jpeg: sqlBytes(frame.jpeg_blob) }
            : undefined;
        },
        decode: async (jpeg) => runtime.decodeRecordingFrame(jpeg),
        writeOutputChunk: (chunkIndex, chunk) => {
          this.ctx.storage.sql.exec(
            'INSERT INTO browser_recording_output (recording_id, chunk_index, chunk_blob) VALUES (?, ?, ?)',
            recordingId, chunkIndex, sqlBuffer(chunk),
          );
        },
      });
      // Retain compatibility with older encoder mocks while production sends
      // each chunk directly to storage from writeOutputChunk above.
      let outputBytes: number;
      if (typeof encodedOutput === 'number') {
        outputBytes = encodedOutput;
      } else {
        const legacyOutput = encodedOutput as unknown as Uint8Array;
        outputBytes = legacyOutput.byteLength;
        for (let offset = 0, chunkIndex = 0; offset < legacyOutput.length; offset += 512 * 1024, chunkIndex++) {
          this.ctx.storage.sql.exec(
            'INSERT INTO browser_recording_output (recording_id, chunk_index, chunk_blob) VALUES (?, ?, ?)',
            recordingId, chunkIndex, sqlBuffer(legacyOutput.subarray(offset, Math.min(offset + 512 * 1024, legacyOutput.length))),
          );
        }
      }
      this.evictOldRecordingsFor(outputBytes);
      const downloadToken = crypto.randomUUID();
      const expiresAt = Date.now() + RECORDING_RETENTION_MS;
      this.ctx.storage.sql.exec(
        "UPDATE browser_recording SET status = 'ready', stored_bytes = ?, expires_at = ?, download_token = ?, error = NULL WHERE id = ? AND status = 'encoding'",
        outputBytes, expiresAt, downloadToken, recordingId,
      );
      this.ctx.storage.sql.exec('DELETE FROM browser_recording_frame WHERE recording_id = ?', recordingId);
      await this.scheduleNextAlarm();
    } catch (error) {
      await this.failRecording(recordingId, error);
    }
  }

  async startScreenRecording(fps = 2, maxDurationSeconds = 30, readiness: PageReadinessOptions = {}): Promise<{
    recordingId: string; status: RecordingStatus; fps: number; maxDurationSeconds: number; startedAt: number;
  }> {
    return this.serial(async () => {
      if (!Number.isInteger(fps) || fps < 1 || fps > MAX_RECORDING_FPS) {
        throw new RangeError(`Recording fps must be between 1 and ${MAX_RECORDING_FPS}.`);
      }
      if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > MAX_RECORDING_DURATION_SECONDS) {
        throw new RangeError(`Recording duration must be between 1 and ${MAX_RECORDING_DURATION_SECONDS} seconds.`);
      }
      const inProgress = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM browser_recording WHERE status IN ('recording', 'encoding') LIMIT 1",
      ).toArray()[0];
      if (inProgress) throw new Error('This tab already has a recording in progress.');
      const runtime = await this.requireRuntime();
      const ready = await runtime.waitForPageReady(readiness);
      if (!ready.ready) throw new Error('Recording startup document readiness timed out.');
      const recordingId = crypto.randomUUID();
      const startedAt = Date.now();
      const maxDurationMs = maxDurationSeconds * 1000;
      const maxFrames = fps * maxDurationSeconds;
      this.ctx.storage.sql.exec(
        "INSERT INTO browser_recording (id, status, started_at, expires_at, fps, max_duration_ms, max_frames) VALUES (?, 'recording', ?, ?, ?, ?, ?)",
        recordingId, startedAt, startedAt + maxDurationMs + RECORDING_RETENTION_MS, fps, maxDurationMs, maxFrames,
      );
      await this.captureRecordingFrame(recordingId, true);
      const recording = this.recording(recordingId);
      if (!recording || recording.status !== 'recording') {
        throw new Error(recording?.error ?? 'The first screen recording frame could not be captured.');
      }
      this.startRecordingTimer(recordingId, fps);
      await this.renewLease();
      return { recordingId, status: 'recording', fps, maxDurationSeconds, startedAt };
    });
  }

  async stopScreenRecording(recordingId: string): Promise<{ recordingId: string; status: RecordingStatus; targetFrames: number; stoppedAt?: number }> {
    return this.serial(async () => {
      const recording = this.recording(recordingId);
      if (!recording) throw new Error('Screen recording was not found for this tab.');
      if (recording.status === 'recording') await this.beginRecordingEncoding(recording);
      const updated = this.recording(recordingId)!;
      return { recordingId, status: updated.status, targetFrames: updated.target_frames, stoppedAt: updated.stopped_at ?? undefined };
    });
  }

  async getScreenRecordingStatus(recordingId: string): Promise<{
    recordingId: string; status: RecordingStatus; fps: number; capturedFrames: number; targetFrames: number;
    width: number; height: number; sizeBytes: number; startedAt: number; stoppedAt?: number; expiresAt: number; error?: string;
  }> {
    return this.serial(async () => {
      await this.pruneExpiredRecordings();
      await this.scheduleNextAlarm();
      const recording = this.recording(recordingId);
      if (!recording) throw new Error('Screen recording was not found for this tab.');
      const targetFrames = recording.status === 'recording'
        ? Math.min(recording.max_frames, Math.max(1, Math.ceil(
          Math.min(Date.now() - recording.started_at, recording.max_duration_ms) * recording.fps / 1000,
        )))
        : recording.target_frames;
      return {
        recordingId,
        status: recording.status,
        fps: recording.fps,
        capturedFrames: recording.captured_frames,
        targetFrames,
        width: recording.width,
        height: recording.height,
        sizeBytes: recording.status === 'ready' ? recording.stored_bytes : 0,
        startedAt: recording.started_at,
        stoppedAt: recording.stopped_at ?? undefined,
        expiresAt: recording.expires_at,
        error: recording.error ?? undefined,
      };
    });
  }

  async getScreenRecordingDownloadInfo(recordingId: string): Promise<{
    recordingId: string; status: RecordingStatus; downloadToken?: string; sizeBytes: number; expiresAt: number;
  }> {
    return this.serial(async () => {
      await this.pruneExpiredRecordings();
      await this.scheduleNextAlarm();
      const recording = this.recording(recordingId);
      if (!recording) throw new Error('Screen recording was not found for this tab.');
      const ready = recording.status === 'ready' && recording.expires_at > Date.now() && recording.download_token !== null;
      return {
        recordingId,
        status: recording.status,
        downloadToken: ready ? recording.download_token! : undefined,
        sizeBytes: ready ? recording.stored_bytes : 0,
        expiresAt: recording.expires_at,
      };
    });
  }

  private storeScreenshotChunks(token: string, png: Uint8Array, expiresAt: number): void {
    for (let offset = 0; offset < png.byteLength; offset += SCREENSHOT_CHUNK_BYTES) {
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_widget_screenshot_chunk (token, chunk_index, expires_at, png_blob) VALUES (?, ?, ?, ?)',
        token, offset / SCREENSHOT_CHUNK_BYTES, expiresAt, sqlBuffer(png.subarray(offset, offset + SCREENSHOT_CHUNK_BYTES)),
      );
    }
  }

  async captureHttpPreview(html: string): Promise<{ token: string; byteLength: number; inline?: Uint8Array }> {
    const png: Uint8Array = await renderOfflineHtmlPreview(servoWasm, html);
    if (!png.byteLength || png.byteLength > MAX_RESPONSE_BYTES) throw new Error('Invalid HTTP preview.');
    const token = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => this.storeScreenshotChunks(token, png, Date.now() + SCREENSHOT_RETENTION_MS));
    await this.scheduleNextAlarm();
    return { token, byteLength: png.byteLength, inline: png.byteLength <= 96 * 1024 ? png : undefined };
  }

    async publishWidgetScreenshot(png: Uint8Array): Promise<{ token: string }> {
    if (!(png instanceof Uint8Array) || png.byteLength === 0) throw new TypeError('Screenshot bytes are empty.');
    if (png.byteLength > MAX_RESPONSE_BYTES) throw new RangeError('Screenshot exceeds 8388608 bytes.');
    return this.serial(async () => {
      const now = Date.now();
      const session = this.row();
      if (session?.status !== 'active' || session.expires_at <= now) throw new Error('Browser session is not active.');
      const token = crypto.randomUUID();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM browser_widget_screenshot_chunk WHERE expires_at <= ?', now);
        this.storeScreenshotChunks(token, png, now + SCREENSHOT_RETENTION_MS);
        this.ctx.storage.sql.exec(
          `DELETE FROM browser_widget_screenshot_chunk WHERE token IN (
             SELECT token FROM browser_widget_screenshot_chunk WHERE chunk_index = 0
             ORDER BY expires_at DESC, rowid DESC LIMIT -1 OFFSET ?
           )`, MAX_RETAINED_SCREENSHOTS,
        );
      });
      await this.scheduleNextAlarm();
      return { token };
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    if (parts[0] === 'screenshots') return this.fetchWidgetScreenshot(parts);
    if (parts.length !== 4 || parts[0] !== 'recordings') return new Response('Not found', { status: 404 });
    const [, sessionId, recordingId, token] = parts;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^[0-9a-f-]{36}$/i.test(recordingId) || !/^[0-9a-f-]{36}$/i.test(token)) {
      return new Response('Not found', { status: 404 });
    }
    return this.serial(async () => {
      const recording = this.recording(recordingId);
      if (!recording || recording.status !== 'ready' || recording.expires_at <= Date.now() || recording.download_token !== token) {
        return new Response('Recording is unavailable or its download link has expired.', { status: 404 });
      }
      const rows = this.ctx.storage.sql.exec<RecordingOutputRow>(
        'SELECT chunk_blob FROM browser_recording_output WHERE recording_id = ? ORDER BY chunk_index', recordingId,
      ).toArray();
      if (!rows.length) return new Response('Recording data is missing.', { status: 410 });
      const chunks = rows.map(({ chunk_blob }) => sqlBytes(chunk_blob));
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(chunks[index++]);
        },
      });
      return new Response(body, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="servo-recording-${recordingId}.mp4"`,
          'Content-Length': String(recording.stored_bytes),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });
  }

  private fetchWidgetScreenshot(parts: string[]): Promise<Response> | Response {
    if (parts.length !== 3) return new Response('Not found', { status: 404 });
    const token = parts[2];
    if (!/^[0-9a-f-]{36}$/i.test(parts[1] ?? '') || !/^[0-9a-f-]{36}$/i.test(token ?? '')) {
      return new Response('Not found', { status: 404 });
    }
    return this.serial(async () => {
      const chunks = this.ctx.storage.sql.exec<{ png_blob: ArrayBuffer }>(
        'SELECT png_blob FROM browser_widget_screenshot_chunk WHERE token = ? AND expires_at > ? ORDER BY chunk_index',
        token, Date.now(),
      ).toArray();
      if (!chunks.length) return new Response('Not found', { status: 404 });
      const body = new Blob(chunks.map((chunk) => chunk.png_blob), { type: 'image/png' });
      return new Response(body, {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(body.size),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });
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
      this.clearRecordingTimer();
      const active = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM browser_recording WHERE status IN ('recording', 'encoding') LIMIT 1",
      ).toArray()[0];
      if (active) await this.failRecording(active.id, 'The browser session was closed before recording completed.');
      this.clearRuntime();
      const row = this.row();
      if (row && row.status !== 'closed') this.writeStatus('closed');
      this.clearStoredPage();
      await this.scheduleNextAlarm();
      return { status: 'closed' };
    });
  }

  async alarm(): Promise<void> {
    await this.serial(async () => {
      const pending = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM browser_recording WHERE status = 'encoding' LIMIT 1",
      ).toArray()[0];
      if (pending) await this.finalizeRecording(pending.id);
      await this.expireIfIdle();
    });
  }
}
