import {assert, byte, isDefined, isUndefined, Notifier, Option, panic, Terminable} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {MidiData} from "@opendaw/lib-midi"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {Capture} from "./Capture"
import {RecordMidi} from "./RecordMidi"
import {RecordingContext} from "./RecordingContext"

export class CaptureMidi extends Capture {
    #midiAccess: Option<MIDIAccess> = Option.None

    #filterDeviceId: Option<string> = Option.None
    #filterChannel: Option<byte> = Option.None

    constructor(box: AudioUnitBox) {super(box)}

    async prepareRecording({requestMIDIAccess}: RecordingContext): Promise<void> {
        return requestMIDIAccess()
            .then(midiAccess => {
                if (this.#filterDeviceId.nonEmpty()) {
                    const captureDevices = Array.from(midiAccess.inputs.values())
                    const id = this.#filterDeviceId.unwrap()
                    if (isUndefined(captureDevices.find(device => id === device.id))) {
                        return panic(`Could not find MIDI device with id: '${id}'`)
                    }
                }
                this.#midiAccess = Option.wrap(midiAccess)
            })
    }

    startRecording({project, engine}: RecordingContext): Terminable {
        assert(this.#midiAccess.nonEmpty(), "Stream not prepared.")
        const midiAccess = this.#midiAccess.unwrap()
        const notifier = new Notifier<MIDIMessageEvent>()
        const captureDevices = Array.from(midiAccess.inputs.values())
        this.#filterDeviceId.ifSome(id => captureDevices.filter(device => id === device.id))
        return Terminable.many(
            Terminable.many(
                ...captureDevices.map(input => Events.subscribe(input, "midimessage",
                    (event: MIDIMessageEvent) => {
                        const data = event.data
                        if (isDefined(data) &&
                            this.#filterChannel.mapOr(channel => MidiData.readChannel(data) === channel, true)) {
                            notifier.notify(event)
                        }
                    }))),
            RecordMidi.start({
                notifier,
                engine,
                project,
                capture: this
            })
        )
    }
}