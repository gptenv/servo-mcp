export async function createServoWorkerRuntime(): Promise<never> {
  throw new Error('The real Servo Worker adapter is not used by unit tests.');
}

export async function createCloudflareServoBrowser(): Promise<never> {
  throw new Error('The real Servo Worker adapter is not used by unit tests.');
}

export async function renderOfflineHtmlPreview(): Promise<never> {
  throw new Error('Real offline preview is not used by MCP unit tests.');
}

export function planServoRecordingCapture(): never {
  throw new Error('Real recording planning is not used by MCP unit tests.');
}
export function planServoRecordingFinalization(): never {
  throw new Error('Real recording planning is not used by MCP unit tests.');
}
