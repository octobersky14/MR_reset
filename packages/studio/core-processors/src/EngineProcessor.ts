import {
    Arrays,
    assert,
    byte,
    EmptyExec,
    int,
    isDefined,
    Notifier,
    Nullable,
    Observer,
    Option,
    panic,
    quantizeFloor,
    SortedSet,
    Subscription,
    SyncStream,
    Terminable,
    Terminator,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {Address, BoxGraph, createSyncTarget} from "@opendaw/lib-box"
import {AudioFileBox, BoxIO, BoxVisitor} from "@opendaw/studio-boxes"
import {EngineContext} from "./EngineContext"
import {TimeInfo} from "./TimeInfo"
import {
    AnyClipBoxAdapter,
    AudioData,
    AudioUnitBoxAdapter,
    BoxAdapters,
    ClipAdapters,
    ClipSequencing,
    ClipSequencingUpdates,
    EngineCommands,
    EngineProcessorOptions,
    EngineStateSchema,
    EngineToClient,
    ParameterFieldAdapters,
    ProjectDecoder,
    RootBoxAdapter,
    SampleManager,
    TimelineBoxAdapter,
    TrackBoxAdapter
} from "@opendaw/studio-adapters"
import {AudioUnit} from "./AudioUnit"
import {Processor, ProcessPhase} from "./processing"
import {Mixer} from "./Mixer"
import {LiveStreamBroadcaster} from "@opendaw/lib-fusion"
import {UpdateClock} from "./UpdateClock"
import {PeakBroadcaster} from "./PeakBroadcaster"
import {Metronome} from "./Metronome"
import {BlockRenderer} from "./BlockRenderer"
import {Graph, ppqn, PPQN, TopologicalSort} from "@opendaw/lib-dsp"
import {AudioManagerWorklet} from "./AudioManagerWorklet"
import {ClipSequencingAudioContext} from "./ClipSequencingAudioContext"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {AudioUnitOptions} from "./AudioUnitOptions"

const DEBUG = false

export class EngineProcessor extends AudioWorkletProcessor implements EngineContext {
    readonly #terminator: Terminator
    readonly #messenger: Messenger
    readonly #boxGraph: BoxGraph<BoxIO.TypeMap>
    readonly #timeInfo: TimeInfo
    readonly #engineToClient: EngineToClient
    readonly #boxAdapters: BoxAdapters
    readonly #audioManager: SampleManager
    readonly #audioUnits: SortedSet<UUID.Format, AudioUnit>
    readonly #rootBoxAdapter: RootBoxAdapter
    readonly #timelineBoxAdapter: TimelineBoxAdapter
    readonly #parameterFieldAdapters: ParameterFieldAdapters
    readonly #audioGraph: Graph<Processor>
    readonly #audioGraphSorting: TopologicalSort<Processor>
    readonly #notifier: Notifier<ProcessPhase>
    readonly #mixer: Mixer
    readonly #liveStreamBroadcaster: LiveStreamBroadcaster
    readonly #clipSequencing: ClipSequencingAudioContext
    readonly #updateClock: UpdateClock
    readonly #peaks: PeakBroadcaster
    readonly #metronome: Metronome

    readonly #renderer: BlockRenderer
    readonly #stateSender: SyncStream.Writer
    readonly #stemExports: ReadonlyArray<AudioUnit>

    #processQueue: Option<ReadonlyArray<Processor>> = Option.None
    #primaryOutput: Option<AudioUnit> = Option.None

    #context: Option<EngineContext> = Option.None
    #panic: boolean = false
    #running: boolean = true
    #metronomeEnabled: boolean = false
    #recordingStartTime: ppqn = 0.0
    #playbackTimestamp: ppqn = 0.0 // this is where we start playing again (after paused)
    #countInBeatsTotal: int = 4

    constructor({processorOptions: {sab, project, exportConfiguration}}: {
        processorOptions: EngineProcessorOptions
    } & AudioNodeOptions) {
        super()

        const {boxGraph, mandatoryBoxes: {rootBox, timelineBox}} = ProjectDecoder.decode(project)

        this.#terminator = new Terminator()
        this.#messenger = Messenger.for(this.port)
        this.#boxGraph = boxGraph
        this.#timeInfo = new TimeInfo()
        this.#engineToClient = Communicator.sender<EngineToClient>(
            this.#messenger.channel("engine-to-client"),
            dispatcher => new class implements EngineToClient {
                log(message: string): void {dispatcher.dispatchAndForget(this.log, message)}
                fetchAudio(uuid: UUID.Format): Promise<AudioData> {return dispatcher.dispatchAndReturn(this.fetchAudio, uuid)}
                notifyClipSequenceChanges(changes: ClipSequencingUpdates): void {dispatcher.dispatchAndForget(this.notifyClipSequenceChanges, changes)}
                switchMarkerState(state: Nullable<[UUID.Format, int]>): void {dispatcher.dispatchAndForget(this.switchMarkerState, state)}
                ready() {dispatcher.dispatchAndForget(this.ready)}
            })
        this.#audioManager = new AudioManagerWorklet(this.#engineToClient)
        this.#audioUnits = UUID.newSet(unit => unit.adapter.uuid)
        this.#parameterFieldAdapters = new ParameterFieldAdapters()
        this.#boxAdapters = this.#terminator.own(new BoxAdapters(this))
        this.#rootBoxAdapter = this.#boxAdapters.adapterFor(rootBox, RootBoxAdapter)
        this.#timelineBoxAdapter = this.#boxAdapters.adapterFor(timelineBox, TimelineBoxAdapter)
        this.#audioGraph = new Graph<Processor>()
        this.#audioGraphSorting = new TopologicalSort<Processor>(this.#audioGraph)
        this.#notifier = new Notifier<ProcessPhase>()
        this.#mixer = new Mixer()
        this.#metronome = new Metronome(this.#timeInfo)
        this.#renderer = new BlockRenderer(this)
        this.#stateSender = SyncStream.writer(EngineStateSchema(), sab, x => {
            const {transporting, isCountingIn, isRecording, position} = this.#timeInfo
            x.position = position
            x.playbackTimestamp = this.#playbackTimestamp
            x.countInBeatsTotal = this.#countInBeatsTotal
            x.countInBeatsRemaining = isCountingIn ? (this.#recordingStartTime - position) / PPQN.Quarter : 0
            x.isPlaying = transporting
            x.isRecording = isRecording
            x.isCountingIn = isCountingIn
        })
        this.#liveStreamBroadcaster = this.#terminator.own(LiveStreamBroadcaster.create(this.#messenger, "engine-live-data"))
        this.#updateClock = new UpdateClock(this)
        this.#peaks = this.#terminator.own(new PeakBroadcaster(this.#liveStreamBroadcaster, Address.compose(UUID.Lowest)))
        this.#clipSequencing = this.#terminator.own(new ClipSequencingAudioContext(this.#boxGraph))
        this.#terminator.ownAll(
            createSyncTarget(this.#boxGraph, this.#messenger.channel("engine-sync")),
            Communicator.executor<EngineCommands>(this.#messenger.channel("engine-commands"), {
                play: () => {
                    this.#timeInfo.position = this.#playbackTimestamp
                    this.#timeInfo.transporting = true
                },
                stop: (reset: boolean) => {
                    if (this.#timeInfo.isRecording || this.#timeInfo.isCountingIn) {
                        this.#timeInfo.isRecording = false
                        this.#timeInfo.isCountingIn = false
                        this.#timeInfo.position = this.#playbackTimestamp
                    }
                    const wasTransporting = this.#timeInfo.transporting
                    this.#timeInfo.transporting = false
                    this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
                    if (reset || !wasTransporting) {
                        this.#reset()
                    }
                },
                setPosition: (position: number) => {
                    if (!this.#timeInfo.isRecording) {
                        this.#timeInfo.position = this.#playbackTimestamp = position
                    }
                },
                startRecording: (countIn: boolean) => {
                    if (this.#timeInfo.isRecording || this.#timeInfo.isCountingIn) {return}
                    if (!this.#timeInfo.transporting && countIn) {
                        const position = this.#timeInfo.position
                        const nominator = this.#timelineBoxAdapter.box.signature.nominator.getValue()
                        const denominator = this.#timelineBoxAdapter.box.signature.denominator.getValue()
                        this.#recordingStartTime = quantizeFloor(position, PPQN.fromSignature(nominator, denominator))
                        this.#timeInfo.isCountingIn = true
                        this.#timeInfo.metronomeEnabled = true
                        this.#timeInfo.transporting = true
                        this.#timeInfo.position = this.#recordingStartTime - PPQN.fromSignature(this.#countInBeatsTotal, denominator)
                        const subscription = this.#renderer.setCallback(this.#recordingStartTime, () => {
                            this.#timeInfo.isCountingIn = false
                            this.#timeInfo.isRecording = true
                            this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
                            subscription.terminate()
                        })
                    } else {
                        this.#timeInfo.transporting = true
                        this.#timeInfo.isRecording = true
                    }
                },
                stopRecording: () => {
                    if (!this.#timeInfo.isRecording && !this.#timeInfo.isCountingIn) {return}
                    console.debug("STOP RECORDING")
                    this.#timeInfo.isRecording = false
                    this.#timeInfo.isCountingIn = false
                    this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
                    this.#timeInfo.transporting = false
                },
                setMetronomeEnabled: (value: boolean) => this.#timeInfo.metronomeEnabled = this.#metronomeEnabled = value,
                queryLoadingComplete: (): Promise<boolean> =>
                    Promise.resolve(this.#boxGraph.boxes().every(box => box.accept<BoxVisitor<boolean>>({
                        visitAudioFileBox: (box: AudioFileBox) =>
                            this.#audioManager.getOrCreate(box.address.uuid).data.nonEmpty() && box.pointerHub.nonEmpty()
                    }) ?? true)),
                panic: () => this.#panic = true,
                noteOn: (uuid: UUID.Format, pitch: byte, velocity: unitValue) =>
                    this.optAudioUnit(uuid).ifSome(unit => unit.midiDeviceChain.noteSequencer.pushRawNoteOn(pitch, velocity)),
                noteOff: (uuid: UUID.Format, pitch: byte) =>
                    this.optAudioUnit(uuid).ifSome(unit => unit.midiDeviceChain.noteSequencer.pushRawNoteOff(pitch)),
                scheduleClipPlay: (clipIds: ReadonlyArray<UUID.Format>) => {
                    clipIds.forEach(clipId => {
                        const optClipBox = this.#boxGraph.findBox(clipId)
                        if (optClipBox.isEmpty()) {
                            console.warn(`Could not scheduleClipPlay. Cannot find clip: '${UUID.toString(clipId)}'`)
                        } else {
                            const clipAdapter: AnyClipBoxAdapter = ClipAdapters.for(this.#boxAdapters, optClipBox.unwrap())
                            this.#clipSequencing.schedulePlay(clipAdapter)
                        }
                    })
                },
                scheduleClipStop: (trackIds: ReadonlyArray<UUID.Format>) => {
                    trackIds.forEach(trackId => {
                        const optClipBox = this.#boxGraph.findBox(trackId)
                        if (optClipBox.isEmpty()) {
                            console.warn(`Could not scheduleClipStop. Cannot find track: '${UUID.toString(trackId)}'`)
                        } else {
                            this.#clipSequencing.scheduleStop(this.#boxAdapters.adapterFor(optClipBox.unwrap(), TrackBoxAdapter))
                        }
                    })
                },
                terminate: () => {
                    this.#context.ifSome(context => context.terminate())
                    this.#context = Option.None
                    this.#running = false
                    this.#terminator.terminate()
                }
            }),
            this.#rootBoxAdapter.audioUnits.catchupAndSubscribe({
                onAdd: (adapter: AudioUnitBoxAdapter) => {
                    const uuidAsString = UUID.toString(adapter.uuid)
                    const options: AudioUnitOptions = isDefined(exportConfiguration?.[uuidAsString])
                        ? exportConfiguration[uuidAsString]
                        : AudioUnitOptions.Default
                    const audioUnit = new AudioUnit(this, adapter, options)
                    const added = this.#audioUnits.add(audioUnit)
                    assert(added, `Could not add ${audioUnit}`)
                    if (audioUnit.adapter.isOutput) {
                        assert(this.#primaryOutput.isEmpty(), "Output can only assigned once.")
                        this.#primaryOutput = Option.wrap(audioUnit)
                        return
                    }
                },
                onRemove: ({uuid}) => this.#audioUnits.removeByKey(uuid).terminate(),
                onReorder: EmptyExec
            })
        )

        this.#stemExports = Option.wrap(exportConfiguration).match({
            none: () => Arrays.empty(),
            some: configuration => Object.keys(configuration).map(uuidString => this.#audioUnits.get(UUID.parse(uuidString)))
        })

        this.#engineToClient.ready()

        // For Safari :(
        console.log = (...message: string[]) => this.#engineToClient.log(message.join(", "))
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        try {
            return this.render(inputs, outputs)
        } catch (error: any) {
            this.#engineToClient.log(error)
            throw error
        }
    }

    render(_inputs: Float32Array[][], [output]: Float32Array[][]): boolean {
        if (!this.#running) {return false}
        if (this.#panic) {return panic("Manual Panic")}
        const metronomeEnabled = this.#timeInfo.metronomeEnabled
        this.#notifier.notify(ProcessPhase.Before)
        if (this.#processQueue.isEmpty()) {
            this.#audioGraphSorting.update()
            this.#processQueue = Option.wrap(this.#audioGraphSorting.sorted().concat())
            if (DEBUG) {
                console.debug(`%cAudio-Graph%c\n${this.#processQueue.unwrap()
                    .map((x, index) => `${(index + 1)}: ${x}`).join("\n")}`, "color: hsl(200, 83%, 60%)", "color: inherit")
            }
        }
        const processors = this.#processQueue.unwrap()
        this.#renderer.process(processInfo => {
            processors.forEach(processor => processor.process(processInfo))
            if (metronomeEnabled) {this.#metronome.process(processInfo)}
        })
        if (this.#stemExports.length === 0) {
            this.#primaryOutput.unwrap().audioOutput().replaceInto(output)
            if (metronomeEnabled) {this.#metronome.output.mixInto(output)}
            this.#peaks.process(output[0], output[1])
        } else {
            this.#stemExports.forEach((unit: AudioUnit, index: int) => {
                const [l, r] = unit.audioOutput().channels()
                output[index * 2].set(l)
                output[index * 2 + 1].set(r)
            })
        }
        this.#notifier.notify(ProcessPhase.After)
        this.#clipSequencing.changes().ifSome(changes => this.#engineToClient.notifyClipSequenceChanges(changes))
        this.#stateSender.tryWrite()
        this.#liveStreamBroadcaster.flush()
        return true
    }

    getAudioUnit(uuid: UUID.Format): AudioUnit {return this.#audioUnits.get(uuid)}
    optAudioUnit(uuid: UUID.Format): Option<AudioUnit> {return this.#audioUnits.opt(uuid)}

    subscribeProcessPhase(observer: Observer<ProcessPhase>): Subscription {return this.#notifier.subscribe(observer)}

    registerProcessor(processor: Processor): Terminable {
        this.#audioGraph.addVertex(processor)
        this.#processQueue = Option.None
        return {
            terminate: () => {
                this.#audioGraph.removeVertex(processor)
                this.#processQueue = Option.None
            }
        }
    }

    registerEdge(source: Processor, target: Processor): Terminable {
        this.#audioGraph.addEdge([source, target])
        this.#processQueue = Option.None
        return {
            terminate: () => {
                this.#audioGraph.removeEdge([source, target])
                this.#processQueue = Option.None
            }
        }
    }

    get boxGraph(): BoxGraph<BoxIO.TypeMap> {return this.#boxGraph}
    get boxAdapters(): BoxAdapters {return this.#boxAdapters}
    get sampleManager(): SampleManager {return this.#audioManager}
    get rootBoxAdapter(): RootBoxAdapter {return this.#rootBoxAdapter}
    get timelineBoxAdapter(): TimelineBoxAdapter {return this.#timelineBoxAdapter}
    get bpm(): number {return this.#timelineBoxAdapter.box.bpm.getValue()}
    get liveStreamBroadcaster(): LiveStreamBroadcaster {return this.#liveStreamBroadcaster}
    get liveStreamReceiver(): never {return panic("Only available in main thread")}
    get parameterFieldAdapters(): ParameterFieldAdapters {return this.#parameterFieldAdapters}
    get clipSequencing(): ClipSequencing {return this.#clipSequencing}
    get broadcaster(): LiveStreamBroadcaster {return this.#liveStreamBroadcaster}
    get updateClock(): UpdateClock {return this.#updateClock}
    get timeInfo(): TimeInfo {return this.#timeInfo}
    get mixer(): Mixer {return this.#mixer}
    get engineToClient(): EngineToClient {return this.#engineToClient}
    get isMainThread(): boolean {return false}
    get isAudioContext(): boolean {return true}

    terminate(): void {
        console.debug(`terminate: ${this}`)
        this.#terminator.terminate()
        this.#audioUnits.forEach(unit => unit.terminate())
        this.#audioUnits.clear()
    }

    #reset(): void {
        console.debug("reset")
        this.#playbackTimestamp = 0.0
        this.#timeInfo.isRecording = false
        this.#timeInfo.isCountingIn = false
        this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
        this.#timeInfo.position = 0.0
        this.#timeInfo.transporting = false
        this.#renderer.reset()
        this.#clipSequencing.reset()
        this.#audioGraphSorting.sorted().forEach(processor => processor.reset())
        this.#peaks.clear()
    }
}