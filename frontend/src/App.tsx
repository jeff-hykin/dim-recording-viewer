// Mapper's page: the 3D view (viewer.ts) with the stream list, tf tree, transport, z slice, map building and the open
// dialog around it. Every action is a backend endpoint (backend/routes.ts); what anyone changes comes back as events.
// deno-lint-ignore-file no-explicit-any
import { useCallback, useEffect, useRef, useState } from "react"
import { type AppEvent, call, events, reply } from "./api.ts"
import { CustomizePanel } from "./CustomizePanel.tsx"
import { FileBrowser, formatSize } from "./FileBrowser.tsx"
import { Icon } from "./icons.tsx"
import { sceneStream } from "./scene_stream.ts"
import { type Marker, type StreamEntry, type TfEdge, Viewer } from "./viewer.ts"

type Recording = { path: string; name: string; format: string; t0: number; t1: number; duration: number }
type RecordingFile = { name: string; label: string; path: string; size: number; source: string }
type Time = { t: number; t0: number; t1: number; playing: boolean; speed: number }
type MapStatus = {
    running: { stream: string; phase: string; done: number; total: number } | null
    last: { stream: string; aggregated: string; points: number; recording: string } | null
    error: string | null
}
type TfReport = {
    hasTf: boolean
    treeLines: { prefix: string; frame: string; note: string; problem: boolean }[]
    problems: { stream: string; detail: string }[]
    codecProblems?: { stream: string; detail: string }[]
}
type Slice = { zMin: number | null; zMax: number | null }

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16]

export function App() {
    const sceneHost = useRef<HTMLDivElement>(null)
    const camLayer = useRef<HTMLDivElement>(null)
    const viewerRef = useRef<Viewer | null>(null)
    const [recording, setRecording] = useState<Recording | null>(null)
    const [time, setTime] = useState<Time>({ t: 0, t0: 0, t1: 0, playing: false, speed: 1 })
    const [streams, setStreams] = useState<[string, StreamEntry][]>([])
    const [tfEdges, setTfEdges] = useState<TfEdge[]>([])
    // idle | loading | error | ok; `notice` briefly replaces the ok text (a finished build, a saved map)
    const [status, setStatus] = useState<{ state: string; detail?: string }>({ state: "idle" })
    const [notice, setNotice] = useState<string | null>(null)
    const [recordings, setRecordings] = useState<{ recordings: RecordingFile[]; recent: RecordingFile[] } | null>(null)
    const [overlay, setOverlay] = useState(true)
    const [dropHot, setDropHot] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [map, setMap] = useState<MapStatus>({ running: null, last: null, error: null })
    const [cancelling, setCancelling] = useState(false)
    const [markers, setMarkers] = useState<Marker[]>([])
    const [slice, setSlice] = useState<Slice>({ zMin: null, zMax: null })
    const [tfWarning, setTfWarning] = useState<TfReport | null>(null)
    const [streamsCollapsed, setStreamsCollapsed] = useState(false)
    const [tfOpen, setTfOpen] = useState(false)
    const [tfHovered, setTfHovered] = useState<string | null>(null)
    const [customize, setCustomize] = useState<{ name: string; anchor: DOMRect } | null>(null)
    const [deferredRebuild, setDeferredRebuild] = useState(false)
    const [aggregate, setAggregate] = useState<string | null>(null)
    const [browser, setBrowser] = useState(false)
    const [browserDir, setBrowserDir] = useState<string | null>(null)
    const [menu, setMenu] = useState<{ x: number; y: number; markerId: string | null } | null>(null)
    const [coords, setCoords] = useState<string | null>(null)
    const [cameraText, setCameraText] = useState("")

    const fail = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem))
    const act = (method: string, path: string, body?: unknown) => call(method, path, body).catch(fail)

    // ── the 3D view and its two streams ──
    useEffect(() => {
        const viewer = new Viewer(sceneHost.current!, camLayer.current!, {
            streams: (known) => setStreams([...known.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
            time: (next) => setTime(next),
            tf: (edges) => setTfEdges(edges),
            hideStream: (name) => act("POST", "api/style", { stream: name, on: false }),
            contextMenu: (x, y, markerId) => setMenu({ x, y, markerId }),
            markerMoved: (id, x, y) => {
                setCoords(`x ${x.toFixed(2)}   y ${y.toFixed(2)}   z 0.00`)
                act("PUT", `api/markers/${encodeURIComponent(id)}`, { x, y })
            },
            coords: (text) => setCoords(text),
            loaded: () => {
                setOverlay(false)
                setTfWarning(null)
            },
        })
        viewerRef.current = viewer
        const stopScene = sceneStream((kind, payload, bytes) => viewer.handle(kind, payload, bytes))
        const cameraTimer = setInterval(() => setCameraText(viewer.cameraText()), 250)
        return () => {
            stopScene()
            clearInterval(cameraTimer)
            viewer.dispose()
        }
    }, [])

    const loadRecordings = useCallback(() => {
        call<{ recordings: RecordingFile[]; recent: RecordingFile[] }>("GET", "api/recordings").then(
            setRecordings,
            fail,
        )
    }, [])

    const loadState = useCallback(() => {
        call<any>("GET", "api/state").then((state) => {
            setRecording(state.recording)
            setOverlay(!state.recording)
            setMap(state.map)
            setMarkers(state.markers)
            setSlice(state.slice)
            setStatus({ state: state.recording ? "ok" : "idle" })
        }, fail)
        call<{ styles: Record<string, any> }>("GET", "api/styles").then(
            (reply) => viewerRef.current?.setStyles(reply.styles),
            fail,
        )
        loadRecordings()
    }, [])

    // ── backend events: what the page, other pages or the agent changed ──
    useEffect(() => {
        const onEvent = (event: AppEvent) => {
            const data = event as any
            if (event.type === "loading") {
                setStatus({ state: "loading", detail: `opening ${data.name ?? ""}` })
            } else if (event.type === "loaded") {
                setRecording(data.recording)
                setOverlay(false)
                setError(null)
                setStatus({ state: "ok" })
            } else if (event.type === "closed") {
                setRecording(null)
                setOverlay(true)
                setStatus({ state: "idle" })
            } else if (event.type === "tfReport") {
                const report = data.report as TfReport | null
                if (report && (report.problems.length || report.codecProblems?.length)) {
                    setTfWarning(report)
                }
            } else if (event.type === "error") {
                setStatus({ state: "error", detail: data.message })
                setOverlay(true)
            } else if (event.type === "map") {
                setMap(data.map)
                if (!data.map.running) {
                    setCancelling(false)
                }
                if (data.map.error) {
                    setStatus({ state: "error", detail: `map build failed: ${data.map.error}` })
                } else if (!data.map.running && data.map.last && !data.cancelled) {
                    setStatus({ state: "ok" })
                    setNotice(`${data.map.last.aggregated.split("#")[0]}: ${data.map.last.points.toLocaleString()} pts`)
                }
            } else if (event.type === "style") {
                viewerRef.current?.setStyle(data.stream, data.style)
                setDeferredRebuild(!!viewerRef.current?.heavyRebuildPending)
            } else if (event.type === "camera") {
                if (data.preset === "fit") {
                    viewerRef.current?.autoFit()
                } else if (data.preset === "top") {
                    viewerRef.current?.top()
                } else if (data.position && data.target) {
                    viewerRef.current?.lookAt(data.position, data.target)
                }
            } else if (event.type === "markers") {
                setMarkers(data.markers)
            } else if (event.type === "slice") {
                setSlice(data.slice)
            } else if (event.type === "recordings") {
                loadRecordings()
            } else if (event.type === "capture") {
                let answer: Record<string, unknown>
                try {
                    answer = data.kind === "view"
                        ? viewerRef.current!.snapshot()
                        : { error: `unknown capture ${data.kind}` }
                } catch (problem) {
                    answer = { error: String(problem) }
                }
                reply({ type: "capture-answer", request: data.request, ...answer })
            }
        }
        return events(onEvent, loadState)
    }, [])

    useEffect(() => viewerRef.current?.setMarkers(markers), [markers])
    useEffect(() => viewerRef.current?.setSlice(slice.zMin, slice.zMax), [slice])
    useEffect(() => viewerRef.current?.setTfAxes(tfOpen, tfHovered), [tfOpen, tfHovered, tfEdges])

    // ── open ──
    const open = (path: string) => {
        setStatus({ state: "loading" })
        call("POST", "api/open", { path }).catch((problem) => {
            setStatus({ state: "error", detail: problem.message })
            setOverlay(true)
        })
    }
    useEffect(() => {
        // drag-drop: a dropped file has no path in a webview, so hand the backend its name to find in the known folders
        const over = (event: DragEvent) => event.preventDefault()
        const enter = (event: DragEvent) => {
            event.preventDefault()
            setOverlay(true)
            setDropHot(true)
        }
        const leave = (event: DragEvent) => event.relatedTarget === null && setDropHot(false)
        const drop = (event: DragEvent) => {
            event.preventDefault()
            setDropHot(false)
            const file = event.dataTransfer?.files?.[0]
            if (file) {
                open(file.name)
            }
        }
        addEventListener("dragover", over)
        addEventListener("dragenter", enter)
        addEventListener("dragleave", leave)
        addEventListener("drop", drop)
        return () => {
            removeEventListener("dragover", over)
            removeEventListener("dragenter", enter)
            removeEventListener("dragleave", leave)
            removeEventListener("drop", drop)
        }
    }, [])

    // ── transport: one seek in flight at a time; a fast drag coalesces to the latest target ──
    const [scrubbing, setScrubbing] = useState<number | null>(null)
    const seekState = useRef({ inFlight: false, pending: null as number | null })
    const flushSeek = () => {
        const state = seekState.current
        if (state.inFlight || state.pending === null) {
            return
        }
        const target = state.pending
        state.pending = null
        state.inFlight = true
        call("POST", "api/seek", { t: target }).catch(fail).finally(() => {
            state.inFlight = false
            flushSeek()
        })
    }
    const scrubTo = (value: number, done: boolean) => {
        const target = time.t0 + (value / 1000) * (time.t1 - time.t0)
        setScrubbing(done ? null : target)
        seekState.current.pending = target
        flushSeek()
    }
    const shownT = scrubbing ?? time.t
    const duration = Math.max(0, time.t1 - time.t0)
    useEffect(() => {
        if (!notice) {
            return
        }
        const timer = setTimeout(() => setNotice(null), 6000)
        return () => clearTimeout(timer)
    }, [notice])

    // ── streams ──
    const anyOn = streams.some(([, entry]) => entry.on)
    const toggleAll = () =>
        Promise.all(streams.map(([name]) => call("POST", "api/style", { stream: name, on: !anyOn }))).catch(fail)
    const customizing = useRef<string | null>(null)
    customizing.current = customize?.name ?? null
    const commitStyle = useCallback((style: Record<string, unknown>) => {
        if (customizing.current) {
            act("POST", "api/style", { stream: customizing.current, ...style })
        }
    }, [])
    const closeCustomize = () => {
        viewerRef.current?.deferHeavyRebuilds(null)
        setDeferredRebuild(false)
        setCustomize(null)
    }
    useEffect(() => {
        if (!customize && !menu) {
            return
        }
        const down = (event: PointerEvent) => {
            const target = event.target as HTMLElement
            if (customize && !target.closest("#cust-panel") && !target.closest(".cust-btn")) {
                closeCustomize()
            }
            if (menu && !target.closest("#ctxmenu")) {
                setMenu(null)
            }
        }
        const key = (event: KeyboardEvent) => {
            if (event.code === "Escape") {
                closeCustomize()
                setMenu(null)
            }
        }
        addEventListener("pointerdown", down, true)
        addEventListener("keydown", key)
        return () => {
            removeEventListener("pointerdown", down, true)
            removeEventListener("keydown", key)
        }
    }, [customize, menu])

    // ── tf tree widget ──
    const tfRows: { frame: string; depth: number; root: boolean }[] = []
    if (tfOpen) {
        const children = new Map<string, string[]>()
        const isChild = new Set(tfEdges.filter((edge) => edge.parent).map((edge) => edge.child))
        for (const edge of tfEdges) {
            if (edge.parent) {
                children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge.child])
            }
        }
        const roots = [...new Set([...tfEdges.map((edge) => edge.child), ...tfEdges.map((edge) => edge.parent)])]
            .filter((frame) => frame && !isChild.has(frame)).sort()
        const walk = (frame: string, depth: number) => {
            if (depth > 32) {
                return
            }
            tfRows.push({ frame, depth, root: depth === 0 })
            for (const child of (children.get(frame) ?? []).sort()) {
                walk(child, depth + 1)
            }
        }
        roots.forEach((root) => walk(root, 0))
    }
    const tfFrameCount = new Set(tfEdges.flatMap((edge) => [edge.child, edge.parent]).filter(Boolean)).size

    // ── z slice: drag locally, commit to the backend on release ──
    const track = useRef<HTMLDivElement>(null)
    const [dragSlice, setDragSlice] = useState<Slice | null>(null)
    const extent = useRef<[number, number]>([0, 3])
    const shownSlice = dragSlice ?? slice
    const [low, high] = dragSlice ? extent.current : (viewerRef.current?.zExtent() ?? [0, 3])
    const fractionOf = (z: number | null, open: number) =>
        z === null ? open : Math.min(1, Math.max(0, (z - low) / (high - low)))
    const topFraction = fractionOf(shownSlice.zMax, 1)
    const bottomFraction = fractionOf(shownSlice.zMin, 0)
    const startSliceDrag = (which: "top" | "bottom", event: React.PointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
        extent.current = viewerRef.current?.zExtent() ?? [0, 3]
        const [from, to] = extent.current
        let current = { ...slice }
        const move = (moveEvent: PointerEvent) => {
            const rect = track.current!.getBoundingClientRect()
            const fraction = Math.min(1, Math.max(0, 1 - (moveEvent.clientY - rect.top) / rect.height))
            const gap = 0.02
            const top = current.zMax === null ? 1 : (current.zMax - from) / (to - from)
            const bottom = current.zMin === null ? 0 : (current.zMin - from) / (to - from)
            if (which === "top") {
                const next = Math.max(fraction, bottom + gap)
                current = { ...current, zMax: next >= 0.999 ? null : from + next * (to - from) }
            } else {
                const next = Math.min(fraction, top - gap)
                current = { ...current, zMin: next <= 0.001 ? null : from + next * (to - from) }
            }
            setDragSlice(current)
            viewerRef.current?.setSlice(current.zMin, current.zMax)
        }
        const up = () => {
            removeEventListener("pointermove", move)
            removeEventListener("pointerup", up)
            setDragSlice(null)
            setSlice(current)
            act("POST", "api/slice", current)
        }
        addEventListener("pointermove", move)
        addEventListener("pointerup", up)
    }
    const sliceReadout = shownSlice.zMin === null && shownSlice.zMax === null
        ? ""
        : `${shownSlice.zMin === null ? "flr" : shownSlice.zMin.toFixed(2)} – ${
            shownSlice.zMax === null ? "top" : shownSlice.zMax.toFixed(2)
        } m`

    // ── map build ──
    const [carve, setCarve] = useState(true)
    const [carveHeight, setCarveHeight] = useState("2.13")
    const [outlier, setOutlier] = useState(true)
    const startBuild = () => {
        const stream = aggregate!
        setAggregate(null)
        act("POST", "api/map/build", { stream, carve, outlier, carveHeight: Math.max(0, parseFloat(carveHeight) || 0) })
    }
    const running = map.running
    const progress = !running ? null : running.phase === "scanning"
        ? {
            label: running.total > 0 ? `reading ${Math.round((running.done / running.total) * 100)}%` : "reading…",
            fraction: running.total > 0 ? running.done / running.total : null,
        }
        : {
            label: {
                outlier: "cleaning…",
                carving: "carving…",
                voxelizing: "building…",
                reloading: "reloading…",
            }[running.phase] ?? "starting…",
            fraction: null,
        }

    const statusText = status.state === "loading"
        ? status.detail || "loading…"
        : status.state === "error"
        ? status.detail || "error"
        : status.state === "ok"
        ? notice ?? (time.playing ? `playing · ${streams.length} streams` : `${streams.length} streams`)
        : "idle"
    const recent = recordings?.recent ?? []
    const recentPaths = new Set(recent.map((entry) => entry.path))
    const rest = (recordings?.recordings ?? []).filter((entry) => !recentPaths.has(entry.path))
    const recordingRow = (entry: RecordingFile) => (
        <div
            key={entry.path}
            className="rec"
            title={entry.path}
            onClick={() => open(entry.path)}
        >
            <span className="rn">{entry.label || entry.name}</span>
            <span className="rmeta">
                {[formatSize(entry.size), entry.source === "desktop" ? "Desktop recordings" : ""].filter(Boolean).join(
                    " · ",
                )}
            </span>
        </div>
    )

    return (
        <>
            <div id="scene" ref={sceneHost} />
            <div className="topbar">
                <svg
                    className="brand"
                    viewBox="0 0 24 24"
                    fill="none"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    aria-hidden="true"
                >
                    <polygon
                        points="12,2.6 20.7,7.7 12,12.8 3.3,7.7"
                        fill="#7fe3ff"
                        stroke="#1c5f8f"
                        strokeWidth="0.7"
                    />
                    <polygon
                        points="3.3,7.7 12,12.8 12,21.4 3.3,16.3"
                        fill="#2f9bd6"
                        stroke="#1c5f8f"
                        strokeWidth="0.7"
                    />
                    <polygon
                        points="20.7,7.7 12,12.8 12,21.4 20.7,16.3"
                        fill="#1f6ca6"
                        stroke="#1c5f8f"
                        strokeWidth="0.7"
                    />
                </svg>
                <span className="title">Mapper</span>
                <span className="sub">· {recording?.name ?? "no recording"}</span>
                <span className="spacer" />
                {progress && (
                    <span className="agg-prog">
                        <span className="agg-prog-label">{cancelling ? "cancelling…" : progress.label}</span>
                        <span className="agg-prog-track">
                            <span
                                className={`agg-prog-fill${
                                    progress.fraction === null || cancelling ? " indeterminate" : ""
                                }`}
                                style={{ width: `${Math.round((progress.fraction ?? 0) * 100)}%` }}
                            />
                        </span>
                        <button
                            type="button"
                            className="agg-prog-cancel dim-btn round"
                            title="Cancel the map build"
                            disabled={cancelling}
                            onClick={() => {
                                setCancelling(true)
                                act("POST", "api/map/cancel")
                            }}
                        >
                            <Icon name="close" />
                        </button>
                    </span>
                )}
                {recording && map.last && map.last.recording === recording.path && !running && (
                    <button
                        type="button"
                        className="dim-btn sm"
                        title="Save the built map as a .pc2.lcm file next to the recording"
                        onClick={() =>
                            call<{ path: string }>("POST", "api/map/export", {
                                stream: map.last!.aggregated,
                                overwrite: true,
                            }).then(
                                (saved) => setNotice(`saved ${saved.path.split("/").pop()}`),
                                fail,
                            )}
                    >
                        Export map
                    </button>
                )}
                <button
                    type="button"
                    className="dim-btn sm"
                    title="Bird's-eye: look straight down on the whole map"
                    onClick={() => act("POST", "api/camera", { preset: "top" })}
                >
                    Top-down
                </button>
                <button
                    type="button"
                    className="dim-btn sm"
                    title="Auto-fit the camera to frame the whole scene"
                    onClick={() => act("POST", "api/camera", { preset: "fit" })}
                >
                    Fit view
                </button>
                <button type="button" className="dim-btn sm" onClick={() => setBrowser(true)}>Open…</button>
                <span className={`dim-badge dim-mono${status.state === "ok" ? " info" : ""}`}>
                    <span className="dot" />
                    <span>{statusText}</span>
                </span>
            </div>

            <div id="left-stack">
                {recording && (
                    <div className={`panel dim-panel glass${streamsCollapsed ? " collapsed" : ""}`} id="panel">
                        <div className="panel-head">
                            <h2
                                className="toggle dim-label"
                                title="Click to collapse/expand"
                                onClick={() =>
                                    setStreamsCollapsed(!streamsCollapsed)}
                            >
                                <i className="chev">
                                    <Icon name="chevron-down" />
                                </i>Streams
                            </h2>
                            <button
                                type="button"
                                className="mini-btn dim-btn sm ghost"
                                id="toggle-all"
                                title="Show or hide all streams at once"
                                style={{ visibility: streams.length ? "visible" : "hidden" }}
                                onClick={toggleAll}
                            >
                                {anyOn ? "Hide all" : "Show all"}
                            </button>
                        </div>
                        <div id="stream-list">
                            {!streams.length && <div className="empty">none yet</div>}
                            {streams.map(([name, entry]) => (
                                <div className="row" key={name}>
                                    <label className="dim-check">
                                        <input
                                            type="checkbox"
                                            checked={entry.on}
                                            onChange={(event) =>
                                                act("POST", "api/style", { stream: name, on: event.target.checked })}
                                        />
                                        <span className="box" />
                                        <span className="nm">{name.split("#")[0]}</span>
                                    </label>
                                    {entry.kind === "cloud" && !name.split("#")[0].endsWith("_aggregated") && (
                                        <button
                                            type="button"
                                            className="agg-btn dim-btn ghost icon"
                                            title="Build a map from this stream"
                                            onClick={() => !running && setAggregate(name)}
                                        >
                                            <Icon name="more-horizontal" />
                                        </button>
                                    )}
                                    {(entry.kind === "cloud" || entry.kind === "odom") && (
                                        <button
                                            type="button"
                                            className="cust-btn"
                                            onClick={(event) => {
                                                const anchor = event.currentTarget.getBoundingClientRect()
                                                viewerRef.current?.deferHeavyRebuilds(null)
                                                viewerRef.current?.deferHeavyRebuilds(name)
                                                setCustomize({ name, anchor })
                                            }}
                                        >
                                            <span className="cb-idle">
                                                {entry.kind === "odom" ? "odom" : entry.voxel ? "voxels" : "lidar"}
                                            </span>
                                            <span className="cb-hover">customize</span>
                                        </button>
                                    )}
                                    {entry.kind !== "cloud" && entry.kind !== "odom" && (
                                        <span className={`tag kc-${entry.kind}`}>{entry.kind}</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div
                    id="tf-tree"
                    className={`dim-panel glass${tfOpen ? "" : " collapsed"}`}
                    style={{ display: tfEdges.length ? "block" : "none" }}
                >
                    <div
                        className="tt-head dim-label"
                        onClick={() => {
                            setTfOpen(!tfOpen)
                            setTfHovered(null)
                        }}
                    >
                        <i className="chev">
                            <Icon name="chevron-down" />
                        </i>TF tree<span className="tt-count">{tfFrameCount || ""}</span>
                    </div>
                    <div id="tf-tree-list" onMouseLeave={() => setTfHovered(null)}>
                        {tfOpen && !tfRows.length && <div className="tt-empty">no transforms yet</div>}
                        {tfRows.map((row) => (
                            <div
                                key={row.frame + row.depth}
                                className={`tt-row${row.root ? " root" : ""}`}
                                onMouseOver={() => setTfHovered(row.frame)}
                            >
                                {"  ".repeat(row.depth)}
                                {row.frame}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div id="cam-layer" ref={camLayer} />

            <div
                id="zslice"
                title="Top slice: drag the handles to clip everything above/below a height (cut away a roof)"
            >
                <span className="dim-label">Z slice</span>
                <div id="zslice-track" ref={track}>
                    <div
                        id="zslice-fill"
                        style={{
                            top: `${(1 - topFraction) * 100}%`,
                            height: `${(topFraction - bottomFraction) * 100}%`,
                        }}
                    />
                    <div
                        className="zslice-thumb"
                        style={{ top: `${(1 - topFraction) * 100}%` }}
                        onPointerDown={(event) => startSliceDrag("top", event)}
                        onDoubleClick={() => act("POST", "api/slice", { ...slice, zMax: null })}
                    />
                    <div
                        className="zslice-thumb"
                        style={{ top: `${(1 - bottomFraction) * 100}%` }}
                        onPointerDown={(event) => startSliceDrag("bottom", event)}
                        onDoubleClick={() => act("POST", "api/slice", { ...slice, zMin: null })}
                    />
                </div>
                <span id="zslice-readout">{sliceReadout}</span>
            </div>

            <div id="help">
                WASD MOVE · Q/E DOWN/UP · DRAG LOOK · SCROLL DOLLY · RIGHT-DRAG PAN · RIGHT-CLICK MARKER · DBLCLICK
                RECENTER{cameraText}
            </div>

            {menu && (
                <div id="ctxmenu" className="dim-panel glass" style={{ display: "block", left: menu.x, top: menu.y }}>
                    {menu.markerId && (
                        <button
                            type="button"
                            className="dim-btn sm ghost"
                            onClick={() => {
                                viewerRef.current?.startMovingMarker(menu.markerId!)
                                setMenu(null)
                            }}
                        >
                            Move this marker
                        </button>
                    )}
                    <button
                        type="button"
                        className="dim-btn sm ghost"
                        onClick={() => {
                            const point = viewerRef.current?.floorPoint(menu.x, menu.y)
                            setMenu(null)
                            if (point) {
                                setCoords(`x ${point.x.toFixed(2)}   y ${point.y.toFixed(2)}   z 0.00`)
                                act("POST", "api/markers", { x: point.x, y: point.y })
                            }
                        }}
                    >
                        Place marker here
                    </button>
                    <button
                        type="button"
                        className="dim-btn sm ghost"
                        onClick={() => {
                            setMenu(null)
                            setCoords(null)
                            act("DELETE", "api/markers")
                        }}
                    >
                        Clear markers
                    </button>
                </div>
            )}
            {coords && markers.length > 0 && (
                <div id="marker-coords" className="dim-panel glass dim-mono" style={{ display: "block" }}>
                    <span className="mc-label dim-label">Marker · floor (m)</span>
                    <span>{coords}</span>
                </div>
            )}
            {customize && streams.find(([name]) => name === customize.name) && (
                <CustomizePanel
                    name={customize.name}
                    entry={streams.find(([name]) => name === customize.name)![1]}
                    anchor={customize.anchor}
                    deferred={deferredRebuild}
                    onCommit={commitStyle}
                />
            )}

            {aggregate && (
                <div
                    id="agg-backdrop"
                    onClick={(event) => event.target === event.currentTarget && setAggregate(null)}
                >
                    <div id="agg-modal" className="dim-panel" role="dialog" aria-modal="true">
                        <div className="am-title">Build map</div>
                        <div className="am-sub">{aggregate.split("#")[0]}</div>
                        <label className="am-opt dim-check">
                            <input
                                type="checkbox"
                                checked={carve}
                                onChange={(event) => setCarve(event.target.checked)}
                            />
                            <span className="box" />
                            <span className="am-opt-text">
                                <b>Column carving</b>
                                <em>remove floaters + everything above head height</em>
                            </span>
                        </label>
                        <div className="am-subopt">
                            carve above{" "}
                            <input
                                className="dim-input dim-mono"
                                type="number"
                                min="0"
                                step="0.05"
                                value={carveHeight}
                                disabled={!carve}
                                onChange={(event) => setCarveHeight(event.target.value)}
                            />{" "}
                            m from floor
                        </div>
                        <label className="am-opt dim-check">
                            <input
                                type="checkbox"
                                checked={outlier}
                                onChange={(event) => setOutlier(event.target.checked)}
                            />
                            <span className="box" />
                            <span className="am-opt-text">
                                <b>Outlier removal</b>
                                <em>drop isolated speckle points</em>
                            </span>
                        </label>
                        <div className="am-actions">
                            <button type="button" className="dim-btn sm" onClick={() => setAggregate(null)}>
                                Cancel
                            </button>
                            <button type="button" className="dim-btn sm primary" onClick={startBuild}>Start</button>
                        </div>
                    </div>
                </div>
            )}

            {tfWarning && (
                <div id="tf-warn" onClick={() => setTfWarning(null)}>
                    <div id="tf-warn-card" className="dim-panel">
                        <div className="tw-head">
                            <span className="tw-icon">
                                <Icon name="warn" />
                            </span>
                            <span className="tw-title">Some data can't be placed on the map</span>
                        </div>
                        <div className="tw-body">
                            {tfWarning.problems.length > 0 && (
                                <>
                                    <p>
                                        The 3D view places each sensor stream by following a chain of transforms (tf)
                                        from the sensor up to the map. These streams don't have a clear chain, so they
                                        may be missing or land in the wrong spot:
                                    </p>
                                    <ul className="tw-list">
                                        {tfWarning.problems.map((problem) => (
                                            <li key={problem.stream}>
                                                <b>{problem.stream}</b>
                                                <em>{problem.detail}</em>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                            {(tfWarning.codecProblems?.length ?? 0) > 0 && (
                                <>
                                    <p>
                                        These streams are in the recording but were left out, because their messages are
                                        stored in a format this viewer has no decoder for:
                                    </p>
                                    <ul className="tw-list">
                                        {tfWarning.codecProblems!.map((problem) => (
                                            <li key={problem.stream}>
                                                <b>{problem.stream}</b>
                                                <em>{problem.detail}</em>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                        </div>
                        <div className="tw-tree-label dim-label">transform tree(s) in this recording</div>
                        <div className="tw-tree">
                            {!tfWarning.treeLines.length &&
                                (tfWarning.hasTf ? "(no transform frames found)" : "(this recording has no tf stream)")}
                            {tfWarning.treeLines.map((line, index) => (
                                <span key={index}>
                                    <span className={line.problem ? "tw-bad" : undefined}>
                                        {line.prefix + line.frame + (line.note || "")}
                                    </span>
                                    {"\n"}
                                </span>
                            ))}
                        </div>
                        <div className="tw-foot">click anywhere to dismiss</div>
                    </div>
                </div>
            )}

            {browser && (
                <FileBrowser
                    startDir={browserDir}
                    onOpen={open}
                    onClose={(dir) => {
                        setBrowserDir(dir)
                        setBrowser(false)
                    }}
                />
            )}

            {recording && (
                <div className="transport dim-panel glass" id="transport">
                    <button
                        type="button"
                        className="playbtn dim-btn round"
                        title="Play/Pause"
                        onClick={() => act("POST", time.playing ? "api/pause" : "api/play")}
                    >
                        <Icon name={time.playing ? "pause" : "play"} />
                    </button>
                    <span className="clock">{Math.max(0, shownT - time.t0).toFixed(1)} / {duration.toFixed(1)}s</span>
                    <input
                        className="dim-range"
                        type="range"
                        min="0"
                        max="1000"
                        step="1"
                        value={duration > 0 ? Math.round(((shownT - time.t0) / duration) * 1000) : 0}
                        onChange={(event) => scrubTo(Number(event.target.value), false)}
                        onPointerUp={(event) => scrubTo(Number((event.target as HTMLInputElement).value), true)}
                        onKeyUp={(event) => scrubTo(Number((event.target as HTMLInputElement).value), true)}
                    />
                    <select
                        className="dim-select dim-mono"
                        title="Playback speed"
                        value={String(time.speed)}
                        onChange={(event) => act("POST", "api/speed", { speed: Number(event.target.value) })}
                    >
                        {SPEEDS.map((speed) => <option key={speed} value={String(speed)}>{speed}×</option>)}
                    </select>
                </div>
            )}

            {overlay && (
                <div className="overlay">
                    <div className={`drop${dropHot ? " hot" : ""}`}>
                        <h1>Drop a recording here</h1>
                        <p>
                            A dimos <code>.db</code> / <code>.mcap</code> recording or a <code>.pc2.lcm</code>{" "}
                            map — or use the button below to browse.
                        </p>
                        <button type="button" className="dim-btn primary" onClick={() => setBrowser(true)}>
                            Browse for a recording…
                        </button>
                        {recent.length > 0 && (
                            <div className="reclist">
                                <h2 className="dim-label">Recently opened</h2>
                                <div>{recent.slice(0, 15).map(recordingRow)}</div>
                            </div>
                        )}
                        <div className="reclist">
                            <h2 className="dim-label">All recordings</h2>
                            <div>
                                {!recordings && <div className="empty">scanning…</div>}
                                {recordings && !rest.length && (
                                    <div className="empty">no recordings found in known folders</div>
                                )}
                                {rest.slice(0, 40).map(recordingRow)}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {error && (
                <div
                    className="dim-alert danger inline-error"
                    title="click to dismiss"
                    onClick={() => setError(null)}
                >
                    {error}
                </div>
            )}
        </>
    )
}
