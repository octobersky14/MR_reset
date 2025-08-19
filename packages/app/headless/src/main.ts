import "./style.css"
import {assert, ProgressHandler, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AnimationFrame, Browser} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {AudioData, SampleMetaData} from "@opendaw/studio-adapters"
import {MainThreadSampleManager, Project, WorkerAgents, Worklets} from "@opendaw/studio-core"
import {testFeatures} from "./features"
import {SampleApi} from "./SampleApi"

import WorkersUrl from "@opendaw/studio-core/workers.js?worker&url"
import WorkletsUrl from "@opendaw/studio-core/processors.js?url"
import {createExampleProject} from "./ExampleProject"

(async () => {
    console.debug("openDAW -> headless")
    console.debug("Agent", Browser.userAgent)
    console.debug("isLocalHost", Browser.isLocalHost())
    assert(crossOriginIsolated, "window must be crossOriginIsolated")
    console.debug("booting...")
    document.body.textContent = "booting..."
    WorkerAgents.install(WorkersUrl)
    {
        const {status, error} = await Promises.tryCatch(testFeatures())
        if (status === "rejected") {
            document.querySelector("#preloader")?.remove()
            alert(`Could not test features (${error})`)
            return
        }
    }
    const context = new AudioContext({latencyHint: 0})
    console.debug(`AudioContext state: ${context.state}, sampleRate: ${context.sampleRate}`)
    {
        const {status, error} = await Promises.tryCatch(Worklets.install(context, WorkletsUrl))
        if (status === "rejected") {
            alert(`Could not install Worklets (${error})`)
            return
        }
    }
    {
        const sampleManager = new MainThreadSampleManager({
            fetch: (uuid: UUID.Format, progress: ProgressHandler): Promise<[AudioData, SampleMetaData]> =>
                SampleApi.load(context, uuid, progress)
        }, context)

        const loadProject = false
        const project = loadProject
            ? Project.load({sampleManager}, await fetch("subset.od").then(x => x.arrayBuffer()))
            : createExampleProject({sampleManager})
        const worklet = Worklets.get(context).createEngine(project)
        await worklet.isReady()
        while (!await worklet.queryLoadingComplete()) {}
        worklet.connect(context.destination)
        window.addEventListener("click", () => {
            worklet.play()
            AnimationFrame.add(() => {
                const ppqn = worklet.position.getValue()
                const {bars, beats} = PPQN.toParts(ppqn)
                document.body.textContent = `${bars + 1}:${beats + 1}`
            })
        }, {once: true})
    }
    if (context.state === "suspended") {
        window.addEventListener("click",
            async () => await context.resume().then(() =>
                console.debug(`AudioContext resumed (${context.state})`)), {capture: true, once: true})
    }
    AnimationFrame.start()
    document.querySelector("#preloader")?.remove()
    document.body.textContent = "Ready."
})()