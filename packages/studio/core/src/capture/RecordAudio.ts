import {Option, quantizeFloor, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {dbToGain, PPQN} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {SampleManager, TrackType} from "@opendaw/studio-adapters"
import {Engine} from "../Engine"
import {Project} from "../Project"
import {Capture} from "./Capture"
import {RecordTrack} from "./RecordTrack"
import {RecordingWorklet} from "../RecordingWorklet"
import {ColorCodes} from "../ColorCodes"

export namespace RecordAudio {
    type RecordAudioContext = {
        recordingWorklet: RecordingWorklet
        mediaStream: MediaStream
        sampleManager: SampleManager
        audioContext: AudioContext
        engine: Engine
        project: Project
        capture: Capture
        gainDb: number
    }

    export const start = (
        {
            recordingWorklet, mediaStream, sampleManager, audioContext, engine, project, capture, gainDb
        }: RecordAudioContext): Terminable => {
        console.debug("RecordAudio.start", audioContext)
        const terminator = new Terminator()
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, boxGraph} = project
        const trackBox: TrackBox = RecordTrack.findOrCreate(editing, capture.box, TrackType.Audio)
        const uuid = recordingWorklet.uuid
        sampleManager.record(recordingWorklet)
        const streamSource = audioContext.createMediaStreamSource(mediaStream)
        const streamGain = audioContext.createGain()
        streamGain.gain.value = dbToGain(gainDb)
        streamSource.connect(streamGain)
        let writing: Option<{ fileBox: AudioFileBox, regionBox: AudioRegionBox }> = Option.None
        const resizeRegion = () => {
            if (writing.isEmpty()) {return}
            const {regionBox} = writing.unwrap()
            editing.modify(() => {
                if (regionBox.isAttached()) {
                    const {duration, loopDuration} = regionBox
                    const newDuration = Math.floor(PPQN.samplesToPulses(
                        recordingWorklet.numberOfFrames, project.timelineBox.bpm.getValue(), audioContext.sampleRate))
                    duration.setValue(newDuration)
                    loopDuration.setValue(newDuration)
                }
            }, false)
        }
        terminator.ownAll(
            Terminable.create(() => {
                recordingWorklet.finalize().then()
                streamGain.disconnect()
                streamSource.disconnect()
            }),
            engine.position.catchupAndSubscribe(owner => {
                if (writing.isEmpty() && engine.isRecording.getValue()) {
                    streamGain.connect(recordingWorklet)
                    writing = editing.modify(() => {
                        const position = quantizeFloor(owner.getValue(), beats)
                        const fileBox = AudioFileBox.create(boxGraph, uuid, box => {
                            box.fileName.setValue("Recording")
                        })
                        const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                            box.file.refer(fileBox)
                            box.regions.refer(trackBox.regions)
                            box.position.setValue(position)
                            box.hue.setValue(ColorCodes.forTrackType(TrackType.Audio))
                            box.label.setValue("Recording")
                        })
                        return {fileBox, regionBox}
                    })
                }
                resizeRegion()
            }),
            Terminable.create(() => resizeRegion())
        )
        return terminator
    }
}