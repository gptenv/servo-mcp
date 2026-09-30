import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const entry = require.resolve('h264-mp4-encoder');
const packageRoot = resolve(dirname(entry), '../..');
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
if (packageJson.version !== '1.0.12') {
  throw new Error(`Expected h264-mp4-encoder 1.0.12, found ${packageJson.version}`);
}

const source = await readFile(entry, 'utf8');
const anchor = 'const E=Q.n(I)()(),C=';
const replacement = 'const E=Q.n(I)()({instantiateWasm:(imports,receive)=>{const start=()=>{WebAssembly.instantiate(globalThis.__SERVO_H264_MP4_ENCODER_WASM_MODULE__,imports).then(result=>receive(result instanceof WebAssembly.Instance?result:result.instance));};globalThis.__SERVO_H264_MP4_ENCODER_START__=start;if(globalThis.__SERVO_H264_MP4_ENCODER_WASM_MODULE__)start();return {};}}),C=';
const previousReplacement = 'const E=Q.n(I)()({instantiateWasm:(imports,receive)=>{WebAssembly.instantiate(globalThis.__SERVO_H264_MP4_ENCODER_WASM_MODULE__,imports).then(result=>receive(result instanceof WebAssembly.Instance?result:result.instance));return {};}}),C=';
if (source.includes(previousReplacement)) {
  await writeFile(entry, source.replace(previousReplacement, replacement));
  process.exit(0);
}
if (source.includes(replacement)) process.exit(0);
if (source.split(anchor).length !== 2) {
  throw new Error('The pinned h264-mp4-encoder bundle changed; review its Worker WASM initialization before updating.');
}
await writeFile(entry, source.replace(anchor, replacement));
