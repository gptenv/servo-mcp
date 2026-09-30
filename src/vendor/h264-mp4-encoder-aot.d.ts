type H264MP4EncoderInstance = {
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

type H264MP4EncoderModule = {
  H264MP4Encoder: new () => H264MP4EncoderInstance;
  FS: {
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
};

declare const createH264MP4Module: (options: {
  instantiateWasm(
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance) => void,
  ): unknown;
}) => Promise<H264MP4EncoderModule>;

export default createH264MP4Module;
