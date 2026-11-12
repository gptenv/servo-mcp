declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module '*.mjs' {
  export function createServoWorkerRuntime(wasm: WebAssembly.Module, config: Record<string, unknown>): Promise<any>;
  export function renderOfflineHtmlPreview(wasm: WebAssembly.Module, html: string): Promise<Uint8Array>;
  export function planServoRecordingCapture(recording: { status: string; started_at: number; max_duration_ms: number; max_frames: number; fps: number }, now: number, initial?: boolean, lastSlot?: number | null):
    { action: 'skip' } | { action: 'finish'; stoppedAt: number } | { action: 'capture'; slot: number; deadline: number };
  export function planServoRecordingFinalization(recording: { status: string; started_at: number; max_duration_ms: number; max_frames: number; fps: number }, stoppedAt: number, lastSlot?: number | null):
    { end: number; targetFrames: number } | null;
  export function createCloudflareServoBrowser(wasm: WebAssembly.Module, env: any, options?: Record<string, unknown>): Promise<any>;
}
