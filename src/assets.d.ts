declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare module '*.mjs' {
  export function createServoWorkerRuntime(module: WebAssembly.Module, options?: Record<string, unknown>): Promise<any>;
  export function renderOfflineHtmlPreview(module: WebAssembly.Module, html: string): Promise<Uint8Array>;
  export function createCloudflareServoBrowser(module: WebAssembly.Module, env: any, options?: Record<string, unknown>): Promise<any>;
}

declare module '*.html' {
  const html: string;
  export default html;
}
