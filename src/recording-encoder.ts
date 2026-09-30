import h264EncoderFactory from './vendor/h264-mp4-encoder-aot.js';
import h264Mp4Wasm from './vendor/h264-mp4-encoder.wasm';

type H264Encoder = {
  outputFilename: string;
  width: number;
  height: number;
  frameRate: number;
  kbps: number;
  speed: number;
  quantizationParameter: number;
  groupOfPictures: number;
  initialize(): void;
  addFrameRgba(rgba: Uint8Array): void;
  finalize(): void;
  delete(): void;
};

type H264MP4Module = {
  H264MP4Encoder: new () => H264Encoder;
  FS: {
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
};

type RecordingFrame = { slot: number; jpeg: Uint8Array };

let h264ModulePromise: Promise<H264MP4Module> | undefined;

function getH264Module(): Promise<H264MP4Module> {
  if (!h264ModulePromise) {
    h264ModulePromise = h264EncoderFactory({
      instantiateWasm(imports, receiveInstance) {
        receiveInstance(new WebAssembly.Instance(h264Mp4Wasm, imports));
        return {};
      },
    });
  }
  return h264ModulePromise;
}

let encoderQueue: Promise<void> = Promise.resolve();

async function encodeQueued(options: {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  nextFrame(afterSlot: number): Promise<RecordingFrame | undefined>;
  decode(jpeg: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }>;
}): Promise<Uint8Array> {
  if (options.totalFrames < 1) throw new Error('The recording contains no frames.');
  const module = await getH264Module();
  const encoder = new module.H264MP4Encoder();
  const filename = `servo-recording-${crypto.randomUUID()}.mp4`;
  encoder.outputFilename = filename;
  encoder.width = options.width;
  encoder.height = options.height;
  encoder.frameRate = options.fps;
  encoder.kbps = 500;
  encoder.speed = 10;
  encoder.quantizationParameter = 35;
  encoder.groupOfPictures = options.fps * 2;

  try {
    encoder.initialize();
    let nextOutputSlot = 0;
    let lastRgba: Uint8Array | undefined;
    let afterSlot = -1;
    while (true) {
      const frame = await options.nextFrame(afterSlot);
      if (!frame) break;
      if (frame.slot <= afterSlot || frame.slot >= options.totalFrames) {
        throw new Error('The recording frame sequence is invalid.');
      }
      while (nextOutputSlot < frame.slot) {
        if (!lastRgba) throw new Error('The recording is missing its first frame.');
        encoder.addFrameRgba(lastRgba);
        nextOutputSlot++;
      }
      const decoded = await options.decode(frame.jpeg);
      if (decoded.width !== options.width || decoded.height !== options.height) {
        throw new Error('Recording frame dimensions changed while encoding.');
      }
      encoder.addFrameRgba(decoded.rgba);
      lastRgba = decoded.rgba;
      nextOutputSlot = frame.slot + 1;
      afterSlot = frame.slot;
    }
    if (!lastRgba) throw new Error('The recording contains no decodable frames.');
    while (nextOutputSlot < options.totalFrames) {
      encoder.addFrameRgba(lastRgba);
      nextOutputSlot++;
    }
    encoder.finalize();
    const mp4 = module.FS.readFile(filename).slice();
    if (!mp4.byteLength) throw new Error('The MP4 encoder produced an empty file.');
    return mp4;
  } finally {
    try { module.FS.unlink(filename); } catch {}
    encoder.delete();
  }
}

/** Serialize jobs because the encoder module shares one Emscripten FS per Worker isolate. */
export function encodeRecordingMp4(options: Parameters<typeof encodeQueued>[0]): Promise<Uint8Array> {
  const result = encoderQueue.then(() => encodeQueued(options));
  encoderQueue = result.then(() => undefined, () => undefined);
  return result;
}
