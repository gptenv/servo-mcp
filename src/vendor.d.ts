declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module '*.mjs' {
  export function createServoWorkerRuntime(wasm: WebAssembly.Module, config: Record<string, unknown>): Promise<any>;
}
