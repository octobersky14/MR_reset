import css from "./CountIn.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, TAU, Terminable, unitValue} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {Engine} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "CountIn")

type Construct = {
    lifecycle: Lifecycle
    engine: Engine
}

export const CountIn = ({lifecycle, engine}: Construct) => {
    const textElement: SVGTextElement = (
        <text x="50%" y="50%" dy="0.08em"
              font-size="84"
              font-family="Rubik"
              text-anchor="middle"
              dominant-baseline="middle"
              text-rendering="geometricPrecision"
              fill="black"/>
    )
    const outlineWidth = 3
    const r = 50.0 - outlineWidth / 2.0
    const C = TAU * r

    const maskId = Html.nextID()
    const processCircle: SVGCircleElement = (
        <circle
            cx="50" cy="50" r={r} fill="none"
            stroke="white"
            stroke-width={outlineWidth}
            stroke-linecap="butt"
            stroke-dasharray={C}
            stroke-dashoffset="0"
            stroke-opacity={0.33}
            transform="rotate(-90 50 50)"
        />)
    const showProgress = (progress: unitValue) =>
        processCircle.setAttribute("stroke-dashoffset", String((1.0 - progress) * C))
    const element: DomElement = (
        <svg classList={className} viewBox="0 0 100 100" width={100} height={100}>
            <defs>
                <mask id={maskId} maskUnits="userSpaceOnUse">
                    <circle cx="50" cy="50" r="50" fill="white"/>
                    {textElement}
                </mask>
            </defs>
            <circle cx="50" cy="50" r="50" fill="white" fill-opacity={0.25} mask={`url(#${maskId})`}/>
            {processCircle}
        </svg>
    )
    lifecycle.ownAll(
        engine.countInBeatsRemaining
            .catchupAndSubscribe(owner => {
                const remaining = owner.getValue()
                showProgress(remaining / engine.countInBeatsTotal.getValue())
                textElement.textContent = Math.floor(remaining + 1).toString()
            }),
        Terminable.create(() => element.remove())
    )
    showProgress(1.0)
    return element
}