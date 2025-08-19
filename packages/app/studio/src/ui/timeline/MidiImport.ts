import {
    Arrays,
    byte,
    DefaultObservableValue,
    int,
    isDefined,
    Nullish,
    quantizeCeil,
    tryCatch,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {showInfoDialog, showProcessDialog} from "@/ui/components/dialogs.tsx"
import {Promises, Wait} from "@opendaw/lib-runtime"
import {Errors, Files} from "@opendaw/lib-dom"
import {ColorCodes, Project} from "@opendaw/studio-core"
import {ControlType, MidiFile} from "@opendaw/lib-midi"

export namespace MidiImport {
    export const toTracks = async (project: Project, audioUnitBoxAdapter: AudioUnitBoxAdapter) => {
        const fileResult = await Promises.tryCatch(Files.open().then(([file]) => file.arrayBuffer()))
        if (fileResult.status === "rejected") {
            if (!Errors.isAbort(fileResult.error)) {throw fileResult.error}
            return
        }
        const formatResult = tryCatch(() => MidiFile.decoder(fileResult.value).decode())
        if (formatResult.status === "failure") {
            showInfoDialog({message: String(formatResult.error)}).then()
            return
        }
        const {value: format} = formatResult
        const {boxGraph, editing} = project
        const progress = new DefaultObservableValue(0.0)
        const dialogHandler = showProcessDialog("Import Midi", progress)
        let reuseTrackBox: Nullish<TrackBox> = Arrays.peekLast(audioUnitBoxAdapter.tracks.collection.adapters())?.box
        let trackIndex: int
        if (isDefined(reuseTrackBox)) {
            if (reuseTrackBox.type.getValue() === TrackType.Notes && reuseTrackBox.regions.pointerHub.isEmpty()) {
                trackIndex = reuseTrackBox.index.getValue()
            } else {
                trackIndex = reuseTrackBox.index.getValue() + 1
                reuseTrackBox = null
            }
        } else {
            trackIndex = 0
        }
        let lastTime = Date.now()
        function* generate() {
            for (const midiTrack of format.tracks) {
                for (const [channel, midiEvents] of midiTrack.controlEvents) {
                    console.debug(`Importing ${midiEvents.length} events of channel #${channel}.`)
                    if (midiEvents.length === 0) {continue}
                    if (midiEvents.every(event => event.type !== ControlType.NOTE_ON && event.type !== ControlType.NOTE_OFF)) {continue}
                    let trackBox: TrackBox
                    if (isDefined(reuseTrackBox)) {
                        trackBox = reuseTrackBox
                        reuseTrackBox = null
                        trackIndex++
                    } else {
                        trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                            box.type.setValue(TrackType.Notes)
                            box.tracks.refer(audioUnitBoxAdapter.box.tracks)
                            box.index.setValue(trackIndex++)
                            box.target.refer(audioUnitBoxAdapter.box)
                        })
                    }
                    const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
                    const map = new Map<byte, { position: ppqn, note: byte, velocity: unitValue }>
                    let duration = 0 | 0
                    for (const midiEvent of midiEvents) {
                        const index = midiEvents.indexOf(midiEvent)
                        const position = PPQN.fromSignature(midiEvent.ticks / format.timeDivision, 4) | 0
                        midiEvent.accept({
                            noteOn: (note: byte, velocity: number) => map.set(note, {position, note, velocity}),
                            noteOff: (note: byte) => {
                                const data = map.get(note)
                                map.delete(note)
                                if (!isDefined(data)) {return}
                                NoteEventBox.create(boxGraph, UUID.generate(), box => {
                                    box.position.setValue(data.position)
                                    box.duration.setValue(position - data.position)
                                    box.pitch.setValue(data.note)
                                    box.velocity.setValue(data.velocity)
                                    box.events.refer(collection.events)
                                })
                                duration = Math.max(duration, position)
                            }
                        })
                        progress.setValue(index / midiEvents.length)
                        if (Date.now() - lastTime > 16.0) {
                            lastTime = Date.now()
                            yield
                        }
                    }
                    duration = quantizeCeil(duration, PPQN.Bar)
                    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(0)
                        box.duration.setValue(duration)
                        box.loopDuration.setValue(duration)
                        box.events.refer(collection.owners)
                        box.hue.setValue(ColorCodes.forTrackType(TrackType.Notes))
                        box.label.setValue(`Ch#${channel}`)
                        box.regions.refer(trackBox.regions)
                    })
                }
            }
        }
        console.time("midi-import")
        const modificationProcess = editing.beginModification()
        const {status, error} = await Promises.tryCatch(Wait.complete(generate()))
        console.timeEnd("midi-import")
        if (status === "resolved") {
            modificationProcess.approve()
        } else {
            modificationProcess.revert()
            await showInfoDialog({headline: "Error Importing Midi-File", message: String(error)})
        }
        dialogHandler.close()
        console.debug("finished import.")
    }
}