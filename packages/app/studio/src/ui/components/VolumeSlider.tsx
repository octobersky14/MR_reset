import css from "./VolumeSlider.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, Option, Parameter, Terminator, unitValue} from "@opendaw/lib-std"
import {ValueDragging} from "@/ui/hooks/dragging.ts"
import {ValueTooltip} from "@/ui/surface/ValueTooltip.tsx"
import {Editing} from "@opendaw/lib-box"
import {CssUtils, Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "vertical-slider")

const enum MarkerLength {Short, Long}

const markers: ReadonlyArray<{ length: MarkerLength, decibel: number }> = [
    {length: MarkerLength.Long, decibel: +6.0},
    {length: MarkerLength.Short, decibel: +5.0},
    {length: MarkerLength.Short, decibel: +4.0},
    {length: MarkerLength.Long, decibel: +3.0},
    {length: MarkerLength.Short, decibel: +2.0},
    {length: MarkerLength.Short, decibel: +1.0},
    {length: MarkerLength.Long, decibel: +0.0},
    {length: MarkerLength.Short, decibel: -1.0},
    {length: MarkerLength.Short, decibel: -2.0},
    {length: MarkerLength.Long, decibel: -3.0},
    {length: MarkerLength.Short, decibel: -4.0},
    {length: MarkerLength.Short, decibel: -5.0},
    {length: MarkerLength.Long, decibel: -6.0},
    {length: MarkerLength.Short, decibel: -7.0},
    {length: MarkerLength.Short, decibel: -8.0},
    {length: MarkerLength.Short, decibel: -9.0},
    {length: MarkerLength.Long, decibel: -10.0},
    {length: MarkerLength.Short, decibel: -11.25},
    {length: MarkerLength.Short, decibel: -12.5},
    {length: MarkerLength.Short, decibel: -13.5},
    {length: MarkerLength.Long, decibel: -15.0},
    {length: MarkerLength.Short, decibel: -16.5},
    {length: MarkerLength.Short, decibel: -17.75},
    {length: MarkerLength.Short, decibel: -19.5},
    {length: MarkerLength.Long, decibel: -21.0},
    {length: MarkerLength.Short, decibel: -23.0},
    {length: MarkerLength.Short, decibel: -25.5},
    {length: MarkerLength.Short, decibel: -28.0},
    {length: MarkerLength.Long, decibel: -30.0},
    {length: MarkerLength.Short, decibel: -34.0},
    {length: MarkerLength.Short, decibel: -39.0},
    {length: MarkerLength.Short, decibel: -44.0},
    {length: MarkerLength.Long, decibel: -50.0},
    {length: MarkerLength.Short, decibel: -56.0},
    {length: MarkerLength.Short, decibel: -63.0},
    {length: MarkerLength.Short, decibel: -72.0},
    {length: MarkerLength.Short, decibel: -84.0},
    {length: MarkerLength.Long, decibel: -96.0}
] as const

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    parameter: Parameter<number>
}

export const VolumeSlider = ({lifecycle, editing, parameter}: Construct) => {
    const strokeWidth = 1.0 / devicePixelRatio
    const guide: SVGRectElement = (
        <rect width="0.125em"
              rx="0.0625em"
              ry="0.0625em"
              stroke="none"
              fill="rgba(0, 0, 0, 0.25)"/>
    )

    const lines: ReadonlyArray<SVGLineElement> = markers.map(({length, decibel}) => {
        const y = `${(1.0 - parameter.valueMapping.x(decibel)) * 100.0}%`
        return <line x1={length === MarkerLength.Long ? 0 : "25%"}
                     y1={y}
                     y2={y}
                     stroke={decibel === 0 && Colors.orange}/>
    })
    const lineContainer: SVGSVGElement = <svg y="1em"
                                              overflow="visible"
                                              stroke={Colors.dark}
                                              shape-rendering="crispEdges">{lines}</svg>
    const svg: SVGSVGElement = (<svg viewBox="0 0 0 0">{guide}{lineContainer}</svg>)
    const thumb: HTMLElement = (<div className="thumb"/>)
    const wrapper: HTMLDivElement = (<div className={className} data-class="vertical-slider">{svg}{thumb}</div>)
    const dragLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(Html.watchResize(wrapper, () => {
        if (!wrapper.isConnected) {return}
        lineContainer.setAttribute("stroke-width", String(strokeWidth))

        const {baseVal: rect} = svg.viewBox
        const {clientWidth, clientHeight} = wrapper
        rect.width = clientWidth
        rect.height = clientHeight
        const em = parseFloat(getComputedStyle(wrapper).fontSize)

        guide.x.baseVal.value = CssUtils.calc("50% - 0.0625em", clientWidth, em)
        guide.y.baseVal.value = CssUtils.calc("1em - 1px", clientHeight, em)
        guide.height.baseVal.value = CssUtils.calc("100% - 2em + 1.5px", clientHeight, em)
        lines.forEach(line => {line.x2.baseVal.value = CssUtils.calc("50% - 0.0625em - 1px", clientWidth, em)})
        lineContainer.height.baseVal.value = CssUtils.calc("100% - 2em", clientHeight, em)

        // attach a new dragging function with updated options
        //
        const snapLength = 8
        const guideBounds = guide.getBoundingClientRect()
        const trackLength = guideBounds.height
        dragLifecycle.terminate()
        dragLifecycle.own(ValueDragging.installUnitValueRelativeDragging((event: PointerEvent) => Option.wrap({
            start: (): unitValue => {
                if (event.target === thumb) {
                    return parameter.getUnitValue()
                } else {
                    const startValue: unitValue = 1.0 - (event.clientY - guideBounds.top) / guideBounds.height
                    editing.modify(() => parameter.setUnitValue(startValue), false)
                    return startValue
                }
            },
            modify: (value: unitValue) => editing.modify(() => parameter.setUnitValue(value), false),
            cancel: (prevValue: unitValue) => editing.modify(() => parameter.setUnitValue(prevValue), false),
            finalise: (_prevValue: unitValue, _newValue: unitValue): void => editing.mark(),
            finally: (): void => {}
        }), wrapper, {
            trackLength: trackLength - snapLength,
            snap: {snapLength, threshold: parameter.valueMapping.x(0.0)}
        }))
    }))
    const observer = (parameter: Parameter<number>) =>
        wrapper.style.setProperty("--value", parameter.getUnitValue().toString())
    lifecycle.own(parameter.subscribe(observer))
    lifecycle.own(ValueTooltip.default(wrapper, () => {
        const clientRect = thumb.getBoundingClientRect()
        return ({
            clientX: clientRect.left + clientRect.width + 8,
            clientY: clientRect.top + clientRect.height + 8,
            ...parameter.getPrintValue()
        })
    }))
    observer(parameter)
    return wrapper
}