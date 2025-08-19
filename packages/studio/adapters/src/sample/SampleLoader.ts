import {Observer, Option, Subscription, UUID} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {AudioData} from "../audio/AudioData"
import {SampleLoaderState} from "./SampleLoaderState"

export interface SampleLoader {
    readonly data: Option<AudioData>
    readonly peaks: Option<Peaks>
    readonly uuid: UUID.Format
    readonly state: SampleLoaderState
    invalidate(): void
    subscribe(observer: Observer<SampleLoaderState>): Subscription
}