import {FloatArray, int, Procedure} from "@opendaw/lib-std"

export interface SamplePeakProtocol {
    generateAsync(progress: Procedure<number>,
                  shifts: Uint8Array,
                  frames: ReadonlyArray<FloatArray>,
                  numFrames: int,
                  numChannels: int): Promise<ArrayBufferLike>
}