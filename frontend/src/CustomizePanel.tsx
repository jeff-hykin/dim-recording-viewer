// The per-stream customize popup (cloud: colors, axis, accumulation, voxels, filters; odometry: accumulation). Applies
// on the native "change" event (a commit), not on every input: re-coloring every accumulated frame per drag tick chugs.
// The result goes to the backend (POST api/style), which tells every page.
import { useEffect, useLayoutEffect, useRef } from "react"
import { GRAD_PAIRS, hexToHue, hueToHex, midpointHex, type StreamEntry } from "./viewer.ts"

export function CustomizePanel(
    { name, entry, anchor, deferred, onCommit }: {
        name: string
        entry: StreamEntry
        anchor: DOMRect
        deferred: boolean
        onCommit: (style: Record<string, unknown>) => void
    },
) {
    const panel = useRef<HTMLDivElement>(null)
    const cloud = entry.kind === "cloud"
    const startHex = entry.gradStart || GRAD_PAIRS[0][0]
    const endHex = entry.gradEnd || GRAD_PAIRS[0][1]

    useLayoutEffect(() => {
        const element = panel.current!
        const width = element.offsetWidth, height = element.offsetHeight
        const left = Math.min(anchor.left, innerWidth - width - 8)
        const top = anchor.bottom + height + 8 > innerHeight ? anchor.top - height - 6 : anchor.bottom + 6
        element.style.left = `${Math.max(8, left)}px`
        element.style.top = `${Math.max(8, top)}px`
    }, [anchor])

    useEffect(() => {
        const element = panel.current!
        const value = (id: string) => (element.querySelector(`#${id}`) as HTMLInputElement).value
        const checked = (id: string) => (element.querySelector(`#${id}`) as HTMLInputElement).checked
        const commit = () => {
            const style: Record<string, unknown> = { accum: value("cp-accum") }
            if (cloud) {
                Object.assign(style, {
                    gradStart: hueToHex(+value("cp-start")),
                    gradMid: hueToHex(+value("cp-mid")),
                    gradEnd: hueToHex(+value("cp-end")),
                    axis: +value("cp-axis"),
                    voxel: checked("cp-voxel"),
                    voxelSize: +value("cp-voxel-size"),
                    downsample: +value("cp-down") || 1,
                    rangeMax: +value("cp-range") || 0,
                    zMin: value("cp-zmin") === "" ? null : +value("cp-zmin"),
                    zMax: value("cp-zmax") === "" ? null : +value("cp-zmax"),
                    denoise: checked("cp-denoise"),
                    denoiseCell: (+value("cp-denoise-cell") || 12) / 100, // cm in the field, m stored
                    denoiseMin: Math.max(1, Math.round(+value("cp-denoise-min")) || 4),
                })
            }
            onCommit(style)
        }
        element.addEventListener("change", commit)
        return () => element.removeEventListener("change", commit)
    }, [name, cloud, onCommit])

    const row = (label: string, control: React.ReactNode, id?: string) => (
        <div className="cp-row" id={id}>
            <span>{label}</span>
            {control}
        </div>
    )
    return (
        <div id="cust-panel" className="dim-panel glass" ref={panel} style={{ display: "block" }} key={name}>
            <span className="cp-title dim-label dim-mono">{name.split("#")[0]}</span>
            {cloud &&
                row(
                    "Start",
                    <input
                        type="range"
                        min="0"
                        max="359"
                        id="cp-start"
                        className="cp-hue"
                        defaultValue={Math.round(hexToHue(startHex))}
                    />,
                )}
            {cloud &&
                row(
                    "Mid",
                    <input
                        type="range"
                        min="0"
                        max="359"
                        id="cp-mid"
                        className="cp-hue"
                        defaultValue={Math.round(hexToHue(entry.gradMid || midpointHex(startHex, endHex)))}
                    />,
                )}
            {cloud &&
                row(
                    "End",
                    <input
                        type="range"
                        min="0"
                        max="359"
                        id="cp-end"
                        className="cp-hue"
                        defaultValue={Math.round(hexToHue(endHex))}
                    />,
                )}
            {cloud && row(
                "Axis",
                <select className="dim-select" id="cp-axis" defaultValue={String(entry.axis ?? 2)}>
                    <option value="2">z</option>
                    <option value="0">x</option>
                    <option value="1">y</option>
                </select>,
            )}
            {row(
                "Accumulate",
                <select
                    className="dim-select"
                    id="cp-accum"
                    defaultValue={String(entry.accum ?? (entry.kind === "odom" ? "all" : "latest"))}
                >
                    <option value="latest">latest</option>
                    <option value="all">accum</option>
                    <option value="2">2s</option>
                    <option value="5">5s</option>
                    <option value="10">10s</option>
                    <option value="30">30s</option>
                </select>,
                "cp-accum-row",
            )}
            {cloud && (
                <>
                    {row(
                        "Voxels",
                        <label className="dim-check">
                            <input type="checkbox" id="cp-voxel" defaultChecked={!!entry.voxel} />
                            <span className="box" />
                        </label>,
                    )}
                    {row(
                        "Size",
                        <select className="dim-select" id="cp-voxel-size" defaultValue={String(entry.voxelSize ?? 0.1)}>
                            <option value="0.05">5&nbsp;cm</option>
                            <option value="0.1">10&nbsp;cm</option>
                            <option value="0.2">20&nbsp;cm</option>
                            <option value="0.4">40&nbsp;cm</option>
                        </select>,
                    )}
                    <div className="cp-sep">Filter &amp; downsample</div>
                    {row(
                        "De-noise",
                        <label className="dim-check">
                            <input type="checkbox" id="cp-denoise" defaultChecked={!!entry.denoise} />
                            <span className="box" />
                        </label>,
                    )}
                    {row(
                        "· radius (cm)",
                        <input
                            type="number"
                            id="cp-denoise-cell"
                            className="cp-num dim-input dim-mono"
                            min="1"
                            step="1"
                            defaultValue={Math.round((entry.denoiseCell ?? 0.12) * 100)}
                        />,
                    )}
                    {row(
                        "· min pts",
                        <input
                            type="number"
                            id="cp-denoise-min"
                            className="cp-num dim-input dim-mono"
                            min="1"
                            step="1"
                            defaultValue={entry.denoiseMin ?? 4}
                        />,
                    )}
                    {deferred && <div className="cp-hint">de-noise applies when you close (large cloud)</div>}
                    {row(
                        "Downsample",
                        <select className="dim-select" id="cp-down" defaultValue={String(entry.downsample ?? 1)}>
                            <option value="1">none</option>
                            <option value="2">2&times;</option>
                            <option value="4">4&times;</option>
                            <option value="8">8&times;</option>
                            <option value="16">16&times;</option>
                        </select>,
                    )}
                    {row(
                        "Max range",
                        <select className="dim-select" id="cp-range" defaultValue={String(entry.rangeMax ?? 0)}>
                            <option value="0">none</option>
                            <option value="3">3&nbsp;m</option>
                            <option value="5">5&nbsp;m</option>
                            <option value="10">10&nbsp;m</option>
                            <option value="20">20&nbsp;m</option>
                            <option value="50">50&nbsp;m</option>
                        </select>,
                    )}
                    {row(
                        "Z min",
                        <input
                            type="number"
                            id="cp-zmin"
                            className="cp-num dim-input dim-mono"
                            step="0.1"
                            placeholder="—"
                            defaultValue={Number.isFinite(entry.zMin) ? entry.zMin : ""}
                        />,
                    )}
                    {row(
                        "Z max",
                        <input
                            type="number"
                            id="cp-zmax"
                            className="cp-num dim-input dim-mono"
                            step="0.1"
                            placeholder="—"
                            defaultValue={Number.isFinite(entry.zMax) ? entry.zMax : ""}
                        />,
                    )}
                </>
            )}
        </div>
    )
}
