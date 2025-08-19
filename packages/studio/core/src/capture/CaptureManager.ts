import {
    asInstanceOf,
    isUndefined,
    MutableObservableValue,
    SortedSet,
    Subscription,
    Terminable,
    UUID
} from "@opendaw/lib-std"
import {
    AudioUnitBox,
    BoxVisitor,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {Capture} from "./Capture"
import {Project} from "../Project"
import {Engine} from "../Engine"
import {CaptureMidi} from "./CaptureMidi"
import {CaptureAudio} from "./CaptureAudio"

export class CaptureManager implements Terminable {
    readonly #subscription: Subscription
    readonly #captures: SortedSet<UUID.Format, Capture>

    constructor(project: Project) {
        this.#captures = UUID.newSet<Capture>(unit => unit.uuid)

        this.#subscription = project.rootBox.audioUnits.pointerHub.catchupAndSubscribeTransactual({
            onAdd: ({box}) => {
                const audioUnitBox = asInstanceOf(box, AudioUnitBox)
                const inputBox = audioUnitBox.input.pointerHub.incoming().at(0)?.box
                if (isUndefined(inputBox)) {return}
                // TODO We need to have this information easier to retrieve.
                //  AudioUnit has no default content type yet.
                //  Same for DAWproject :(
                const capture = inputBox.accept<BoxVisitor<Capture>>({
                    visitVaporisateurDeviceBox: (_box: VaporisateurDeviceBox): Capture => new CaptureMidi(audioUnitBox),
                    visitPlayfieldDeviceBox: (_box: PlayfieldDeviceBox): Capture => new CaptureMidi(audioUnitBox),
                    visitNanoDeviceBox: (_box: NanoDeviceBox): Capture => new CaptureMidi(audioUnitBox),
                    visitTapeDeviceBox: (_box: TapeDeviceBox): Capture => new CaptureAudio(audioUnitBox)
                })
                if (isUndefined(capture)) {return}
                this.#captures.add(capture)
            },
            onRemove: ({box: {address: {uuid}}}) => this.#captures.removeByKey(uuid)
        })
    }

    filterArmed(): ReadonlyArray<Capture> {
        return this.#captures.values()
            .filter(capture => capture.armed.getValue() && capture.box.input.pointerHub.nonEmpty())
    }

    getObservableArmedState(uuid: UUID.Format): MutableObservableValue<boolean> {
        return this.#captures.get(uuid).armed
    }
    terminate(): void {
        this.#subscription.terminate()
        this.#captures.clear()
    }
}