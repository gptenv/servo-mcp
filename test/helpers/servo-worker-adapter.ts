export async function createServoWorkerRuntime(): Promise<never> {
  throw new Error('The real Servo Worker adapter is not used by unit tests.');
}
