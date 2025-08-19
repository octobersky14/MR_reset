import {assert, isUndefined, Option, panic, Terminable} from "@opendaw/lib-std"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {Capture} from "./Capture"
import {RecordAudio} from "./RecordAudio"
import {RecordingContext} from "./RecordingContext"

export class CaptureAudio extends Capture {
    #stream: Option<MediaStream> = Option.None

    #filterDeviceId: Option<string> = Option.None
    #requestChannels: Option<1 | 2> = Option.None

    constructor(box: AudioUnitBox) {super(box)}

    async prepareRecording({audioContext: {sampleRate}}: RecordingContext): Promise<void> {
        const deviceId = this.#filterDeviceId.unwrapOrUndefined()
        return navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId,
                sampleRate,
                sampleSize: 32,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: this.#requestChannels.unwrapOrElse(2) // as of today, browsers cap MediaStream audio to stereo.
            }
        }).then(stream => {
            const tracks = stream.getAudioTracks()
            console.debug(deviceId, tracks.at(0)?.getSettings().deviceId)
            if (isUndefined(deviceId) || deviceId === tracks.at(0)?.getSettings().deviceId) {
                this.#stream = Option.wrap(stream)
            } else {
                tracks.forEach(track => track.stop())
                return panic(`Could not find audio device with id: '${deviceId}'`)
            }
        })
    }

    startRecording({audioContext, worklets, project, engine, sampleManager}: RecordingContext): Terminable {
        assert(this.#stream.nonEmpty(), "Stream not prepared.")
        const mediaStream = this.#stream.unwrap()
        return Terminable.many(
            RecordAudio.start({
                recordingWorklet: worklets.createRecording(2, 128, audioContext.outputLatency),
                mediaStream,
                sampleManager,
                audioContext,
                engine,
                project,
                capture: this,
                gainDb: 6.0
            }),
            Terminable.create(() => mediaStream.getTracks().forEach(track => track.stop()))
        )
    }
}