import {asDefined, int} from "@opendaw/lib-std"
import {ExportStemsConfiguration, RingBuffer} from "@opendaw/studio-adapters"
import {EngineWorklet} from "./EngineWorklet"
import {MeterWorklet} from "./MeterWorklet"
import {RecordingWorklet} from "./RecordingWorklet"
import {Project} from "./Project"
import {RenderQuantum} from "./RenderQuantum"

export class Worklets {
    static async install(context: BaseAudioContext, workletURL: string): Promise<Worklets> {
        return context.audioWorklet.addModule(workletURL).then(() => {
            const worklets = new Worklets(context)
            this.#map.set(context, worklets)
            return worklets
        })
    }

    static get(context: BaseAudioContext): Worklets {return asDefined(this.#map.get(context), "Worklets not installed")}

    static #map: WeakMap<BaseAudioContext, Worklets> = new WeakMap<AudioContext, Worklets>()

    readonly #context: BaseAudioContext

    constructor(context: BaseAudioContext) {this.#context = context}

    createMeter(numberOfChannels: int): MeterWorklet {
        return new MeterWorklet(this.#context, numberOfChannels)
    }

    createEngine(project: Project, exportConfiguration?: ExportStemsConfiguration): EngineWorklet {
        return new EngineWorklet(this.#context, project, exportConfiguration)
    }

    createRecording(numberOfChannels: int, numChunks: int, outputLatency: number): RecordingWorklet {
        const audioBytes = numberOfChannels * numChunks * RenderQuantum * Float32Array.BYTES_PER_ELEMENT
        const pointerBytes = Int32Array.BYTES_PER_ELEMENT * 2
        const sab = new SharedArrayBuffer(audioBytes + pointerBytes)
        const buffer: RingBuffer.Config = {sab, numChunks, numberOfChannels, bufferSize: RenderQuantum}
        return new RecordingWorklet(this.#context, buffer, outputLatency)
    }
}