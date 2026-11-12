declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module '*.mjs' {
  export function createServoWorkerRuntime(wasm: WebAssembly.Module, config: Record<string, unknown>): Promise<any>;
  export function renderOfflineHtmlPreview(wasm: WebAssembly.Module, html: string): Promise<Uint8Array>;
  export function createCloudflareServoBrowser(wasm: WebAssembly.Module, env: any, options?: Record<string, unknown>): Promise<any>;
}
