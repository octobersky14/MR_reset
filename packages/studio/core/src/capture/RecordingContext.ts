import {Provider} from "@opendaw/lib-std"
import {SampleManager} from "@opendaw/studio-adapters"
import {Project} from "../Project"
import {Engine} from "../Engine"
import {Worklets} from "../Worklets"

export interface RecordingContext {
    project: Project
    worklets: Worklets
    engine: Engine
    audioContext: AudioContext
    sampleManager: SampleManager
    requestMIDIAccess: Provider<Promise<MIDIAccess>>
}