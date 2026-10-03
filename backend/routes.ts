// Every action Mapper has, as an endpoint (http.ts). The page calls these; so can Desktop's agent. What changes reaches
// every open page as an event on api/events/ws; the 3D frames themselves stream on api/scene/ws (scene.ts).
import { HttpError, pageCount, publishEvent, type Route } from "./http.ts"
import { DATA_DIR, listDir, listRecordings, recentRecordings, recordRecent, resolveRecording } from "./files.ts"
import { type BuildOptions, type MapJob, mapperBinary, type MapResult, runMapper } from "./mapper.ts"
import { Playback, type Recording } from "./playback.ts"
import { everyViewer } from "./scene.ts"
import { unwrapBlob } from "./decode.ts"

export const DESCRIPTION =
    "Mapper: opens dimos recordings (.db, .mcap, .pc2.lcm) and plays them back in 3D (clouds placed by tf, robot pose + trail, paths, camera images), and builds lidar maps from them (voxel-deduplicated, optional column carving and outlier removal) that it saves into the recording or exports as .pc2.lcm"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}
const desktopUrl = () => flag("desktop-url") ?? Deno.env.get("DIMOS_DESKTOP_URL")

export const playback = new Playback(everyViewer)

// ── per-stream look, kept on disk by base name (before any "#") so a sensor keeps its style across recordings ──
type Style = Record<string, unknown>
const STYLE_FIELDS: Record<string, string> = {
    on: "boolean",
    accum: "string",
    gradStart: "color",
    gradMid: "color",
    gradEnd: "color",
    axis: "number",
    voxel: "boolean",
    voxelSize: "number",
    downsample: "number",
    rangeMax: "number",
    zMin: "number",
    zMax: "number",
    denoise: "boolean",
    denoiseCell: "number",
    denoiseMin: "number",
}
const stylesFile = () => `${DATA_DIR}/styles.json`
let styles: Record<string, Style> = {}
try {
    styles = JSON.parse(Deno.readTextFileSync(stylesFile())) ?? {}
} catch { /* none yet */ }
const styleKey = (stream: string) => stream.split("#")[0]
playback.accumulation = (stream, kind) => {
    const accum = styles[styleKey(stream)]?.accum
    return typeof accum === "string" ? accum : kind === "odom" ? "all" : "latest"
}
function saveStyles() {
    try {
        Deno.mkdirSync(DATA_DIR, { recursive: true })
        Deno.writeTextFileSync(stylesFile(), JSON.stringify(styles))
    } catch { /* best effort */ }
}

// ── markers and the z slice: shared by every page and the agent ──
type Marker = { id: string; x: number; y: number; label: string }
let markers: Marker[] = []
let nextMarker = 1
let slice: { zMin: number | null; zMax: number | null } = { zMin: null, zMax: null }

// ── the one map build at a time ──
let mapJob: MapJob | null = null
let mapAbort: AbortController | null = null
let mapRunning: Promise<unknown> | null = null
let lastMap: MapResult | null = null
let lastMapError: string | null = null
const mapStatus = () => ({ running: mapJob, last: lastMap, error: lastMapError, mapper: mapperBinary() })

// ── captures: the page renders the view; the backend asks for it ──
const captures = new Map<string, (answer: Record<string, unknown>) => void>()
let nextCapture = 1
export function onPageMessage(message: Record<string, unknown>) {
    if (message.type === "capture-answer" && typeof message.request === "string") {
        captures.get(message.request)?.(message)
    }
}
async function askPage(kind: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!pageCount()) {
        throw new HttpError(503, "no Mapper page is open (open_app Mapper first)")
    }
    const request = `c${nextCapture++}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
        captures.set(request, resolve)
        timer = setTimeout(() => reject(new HttpError(504, "the Mapper page didn't answer (is it open?)")), 15000)
    })
    publishEvent({ type: "capture", request, kind, args })
    try {
        const { type: _type, request: _request, ...result } = await answer
        if (typeof result.error === "string") {
            throw new HttpError(500, result.error)
        }
        return result
    } finally {
        clearTimeout(timer)
        captures.delete(request)
    }
}

function state() {
    return {
        recording: playback.recording,
        ...playback.time(),
        offset: playback.recording ? playback.playhead - playback.recording.t0 : 0,
        tfProblems: (playback.tfReport?.problems.length ?? 0) + (playback.tfReport?.codecProblems?.length ?? 0),
        map: mapStatus(),
        markers,
        slice,
    }
}

function requireRecording(): Recording {
    if (!playback.recording) {
        throw new HttpError(409, "No recording is open (POST api/open first)")
    }
    return playback.recording
}

function number(value: unknown, name: string, fallback?: number): number {
    if (value === undefined || value === null || value === "") {
        if (fallback === undefined) {
            throw new HttpError(400, `${name} is required`)
        }
        return fallback
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        throw new HttpError(400, `${name} must be a number`)
    }
    return parsed
}

const jsType = (value: unknown): string => typeof value
const bool = (value: unknown, fallback: boolean) => value === undefined ? fallback : value === true || value === "true"

export async function openRecording(path: string): Promise<Recording> {
    const resolved = await resolveRecording(path, desktopUrl())
    if (!resolved) {
        throw new HttpError(404, `Could not find a recording at ${path}`)
    }
    publishEvent({ type: "loading", path: resolved, name: resolved.split("/").pop() })
    let recording: Recording
    try {
        recording = await playback.open(resolved)
    } catch (error) {
        publishEvent({ type: "error", message: (error as Error).message })
        throw error
    }
    publishEvent({ type: "loaded", recording })
    publishEvent({ type: "tfReport", report: playback.tfReport })
    await recordRecent(resolved)
    return recording
}

function buildOptions(args: Record<string, unknown>): BuildOptions {
    const options = {
        voxel: number(args.voxel, "voxel", 0.05),
        carve: bool(args.carve, true),
        carveHeight: number(args.carveHeight, "carveHeight", 2.13),
        carveGap: number(args.carveGap, "carveGap", 0.5),
        outlier: bool(args.outlier, true),
        outlierMin: Math.round(number(args.outlierMin, "outlierMin", 3)),
    }
    if (options.voxel <= 0 || options.carveHeight < 0 || options.carveGap <= 0 || options.outlierMin < 1) {
        throw new HttpError(400, "voxel and carveGap must be > 0, carveHeight >= 0, outlierMin >= 1")
    }
    return options
}

function startBuild(stream: string, options: BuildOptions): Promise<unknown> {
    const recording = requireRecording()
    if (!playback.isDb) {
        throw new HttpError(
            409,
            `Map building needs a .db recording (the mapper reads and writes memory2 streams); this is a .${recording.format}`,
        )
    }
    const source = recording.streams.find((entry) => entry.name === stream)
    if (!source) {
        throw new HttpError(
            404,
            `no stream named ${stream} (clouds: ${
                recording.streams.filter((entry) => entry.kind === "cloud").map((entry) => entry.name).join(", ") ||
                "none"
            })`,
        )
    }
    if (source.kind !== "cloud") {
        throw new HttpError(400, `${stream} is a ${source.type}, not a point cloud`)
    }
    if (stream.endsWith("_aggregated")) {
        throw new HttpError(400, `${stream} is already a built map; build from its source stream`)
    }
    if (mapJob) {
        throw new HttpError(409, `a map of ${mapJob.stream} is already building (POST api/map/cancel to stop it)`)
    }
    const binary = mapperBinary()
    if (!binary) {
        throw new HttpError(500, "the mapper binary is missing (nix build .#mapper, or pass --mapper)")
    }
    const job: MapJob = {
        stream,
        recording: recording.path,
        options,
        phase: "starting",
        done: 0,
        total: 0,
        startedAt: Date.now(),
    }
    mapJob = job
    mapAbort = new AbortController()
    lastMapError = null
    publishEvent({ type: "map", map: mapStatus() })
    return runMapper(binary, job, () => publishEvent({ type: "map", map: mapStatus() }), mapAbort.signal).then(
        async (result) => {
            lastMap = {
                stream,
                ...result,
                recording: job.recording,
                seconds: (Date.now() - job.startedAt) / 1000,
                at: Date.now(),
            }
            mapJob = null
            // reopen so the new stream shows up in the list, the timeline and the 3D view, at the same playhead
            if (playback.recording?.path === job.recording) {
                const playhead = playback.playhead
                job.phase = "reloading"
                await playback.open(job.recording)
                playback.seek(playhead)
                publishEvent({ type: "loaded", recording: playback.recording })
                publishEvent({ type: "tfReport", report: playback.tfReport })
            }
            publishEvent({ type: "map", map: mapStatus() })
        },
        (error: Error) => {
            mapJob = null
            lastMapError = error.message === "cancelled" ? null : error.message
            publishEvent({ type: "map", map: mapStatus(), cancelled: error.message === "cancelled" })
        },
    ).finally(() => {
        mapAbort = null
        mapRunning = null
    })
}

async function writable(dir: string): Promise<boolean> {
    const probe = `${dir}/.mapper-write-test-${Date.now()}`
    try {
        await Deno.writeFile(probe, new Uint8Array())
        await Deno.remove(probe)
        return true
    } catch {
        return false
    }
}

export const routes: Route[] = [
    {
        method: "GET",
        path: "api/state",
        description:
            "What Mapper shows: the open recording (path, streams with type/kind/rows, time range), the playhead (t, offset from the start, playing, speed), the map build status, markers and the z slice",
        role: "context",
        handler: () => state(),
    },
    {
        method: "GET",
        path: "api/view",
        description:
            "What the user sees: the 3D view rendered as an image, with the camera pose and the playhead (needs a Mapper page open)",
        role: "view",
        handler: async () => ({
            ...await askPage("view"),
            recording: playback.recording?.path ?? null,
            offset: state().offset,
        }),
    },
    {
        method: "GET",
        path: "api/recordings",
        description:
            "Recordings Mapper can open: Desktop's shared recordings folder (GET /recordings), the dataset folders it scans (~/datasets) and the recently opened ones. Each has a path to pass to POST api/open",
        handler: async () => ({ recordings: await listRecordings(desktopUrl()), recent: await recentRecordings() }),
    },
    {
        method: "GET",
        path: "api/files",
        description:
            "Browse a folder for recordings: its subfolders and its .db / .mcap / .pc2.lcm files (what the Open dialog shows)",
        params: { dir: { type: "string", description: "folder path; ~ is home (default home)" } },
        handler: async ({ dir }) => {
            try {
                return await listDir(dir === undefined ? undefined : String(dir))
            } catch (error) {
                throw new HttpError(404, `can't list ${dir}: ${(error as Error).message}`)
            }
        },
    },
    {
        method: "POST",
        path: "api/open",
        description:
            "Open a recording (.db, .mcap, .pc2.lcm) and show it paused at its opening frame; replaces the open one",
        params: {
            path: {
                type: "string",
                required: true,
                description: "absolute path, a Desktop recording id, or a file name in a known folder",
            },
        },
        handler: async ({ path }) => ({ recording: await openRecording(String(path)), tfReport: playback.tfReport }),
    },
    {
        method: "POST",
        path: "api/close",
        description: "Close the open recording",
        handler: () => {
            playback.close()
            everyViewer.send("reset", {})
            publishEvent({ type: "closed" })
            return { ok: true }
        },
    },
    {
        method: "GET",
        path: "api/tf-report",
        description:
            "The open recording's transform tree and which streams can't be placed in the world (no tf, ambiguous parents, disconnected) or can't be decoded",
        handler: () => {
            requireRecording()
            return playback.tfReport
        },
    },
    {
        method: "POST",
        path: "api/play",
        description: "Play from the playhead (from the start if it's at the end)",
        handler: () => {
            playback.play()
            return playback.time()
        },
    },
    {
        method: "POST",
        path: "api/pause",
        description: "Pause playback",
        handler: () => {
            requireRecording()
            playback.pause()
            return playback.time()
        },
    },
    {
        method: "POST",
        path: "api/seek",
        description:
            "Move the playhead; give one of t, offset or fraction. The scene rebuilds as it was at that moment",
        params: {
            t: { type: "number", description: "absolute time (seconds since the epoch, as in state's t0..t1)" },
            offset: { type: "number", description: "seconds from the start of the recording" },
            fraction: { type: "number", description: "0 = start, 1 = end" },
        },
        handler: ({ t, offset, fraction }) => {
            const recording = requireRecording()
            let target
            if (t !== undefined) {
                target = number(t, "t")
            } else if (offset !== undefined) {
                target = recording.t0 + number(offset, "offset")
            } else if (fraction !== undefined) {
                target = recording.t0 + number(fraction, "fraction") * recording.duration
            } else {
                throw new HttpError(400, "give t, offset or fraction")
            }
            playback.seek(target)
            return playback.time()
        },
    },
    {
        method: "POST",
        path: "api/speed",
        description: "Set the playback speed",
        params: { speed: { type: "number", required: true, description: "multiplier, e.g. 0.25, 1, 4, 16" } },
        handler: ({ speed }) => {
            const value = number(speed, "speed")
            if (value <= 0 || value > 64) {
                throw new HttpError(400, "speed must be > 0 and at most 64")
            }
            playback.speed = value
            everyViewer.send("time", playback.time())
            return playback.time()
        },
    },
    {
        method: "GET",
        path: "api/styles",
        description:
            "Each stream's display settings (visibility, accumulation, colors, voxels, filters), by stream name",
        handler: () => ({ styles }),
    },
    {
        method: "POST",
        path: "api/style",
        description:
            "Change how a stream is drawn; only the fields given change, null resets one. on: show/hide. accum: 'latest' | 'all' | seconds (how many scans/poses stay on screen). Clouds: gradStart/gradMid/gradEnd ('#rrggbb'), axis (0 x, 1 y, 2 z: what the gradient follows), voxel (draw as cubes), voxelSize (m), downsample (keep every Nth point), rangeMax (m from the sensor, 0 = off), zMin/zMax (m), denoise, denoiseCell (m), denoiseMin (points)",
        params: {
            stream: { type: "string", required: true },
            on: { type: "boolean" },
            accum: { type: "string" },
            gradStart: { type: "string" },
            gradMid: { type: "string" },
            gradEnd: { type: "string" },
            axis: { type: "number" },
            voxel: { type: "boolean" },
            voxelSize: { type: "number" },
            downsample: { type: "number" },
            rangeMax: { type: "number" },
            zMin: { type: "number" },
            zMax: { type: "number" },
            denoise: { type: "boolean" },
            denoiseCell: { type: "number" },
            denoiseMin: { type: "number" },
        },
        handler: (args) => {
            const stream = String(args.stream)
            const key = styleKey(stream)
            const style: Style = { ...styles[key] }
            for (const [field, value] of Object.entries(args)) {
                if (field === "stream") {
                    continue
                }
                const type = STYLE_FIELDS[field]
                if (!type) {
                    throw new HttpError(
                        400,
                        `unknown style field ${field} (known: ${Object.keys(STYLE_FIELDS).join(", ")})`,
                    )
                }
                if (value === null) {
                    delete style[field]
                } else if (type === "color" ? !/^#[0-9a-f]{6}$/i.test(String(value)) : jsType(value) !== type) {
                    throw new HttpError(400, `${field} must be ${type === "color" ? "a '#rrggbb' color" : `a ${type}`}`)
                } else if (field === "accum" && !["latest", "all"].includes(String(value)) && !(Number(value) > 0)) {
                    throw new HttpError(400, "accum must be 'latest', 'all' or a number of seconds")
                } else if (field === "axis" && ![0, 1, 2].includes(value as number)) {
                    throw new HttpError(400, "axis must be 0 (x), 1 (y) or 2 (z)")
                } else {
                    style[field] = value
                }
            }
            const accumChanged = style.accum !== styles[key]?.accum
            styles[key] = style
            saveStyles()
            publishEvent({ type: "style", stream: key, style })
            // accumulation decides which frames get sent: rebuild the scene under the new policy
            if (accumChanged && playback.recording) {
                playback.seek(playback.playhead)
            }
            return { stream: key, style }
        },
    },
    {
        method: "POST",
        path: "api/camera",
        description:
            "Move the 3D camera: preset 'fit' (frame the whole scene), 'top' (bird's-eye floor plan), or position + target in world meters",
        params: {
            preset: { type: "string", description: "fit | top" },
            position: { type: "array", items: { type: "number" }, description: "[x, y, z] camera position (m)" },
            target: { type: "array", items: { type: "number" }, description: "[x, y, z] point to look at (m)" },
        },
        handler: ({ preset, position, target }) => {
            const vector = (value: unknown) =>
                Array.isArray(value) && value.length === 3 && value.every((v) => Number.isFinite(v))
            if (preset !== undefined && preset !== "fit" && preset !== "top") {
                throw new HttpError(400, "preset must be fit or top")
            }
            if (preset === undefined && !(vector(position) && vector(target))) {
                throw new HttpError(400, "give a preset, or position and target as [x, y, z]")
            }
            publishEvent({ type: "camera", preset, position, target })
            return { ok: true, pages: pageCount() }
        },
    },
    {
        method: "GET",
        path: "api/markers",
        description: "The floor markers (pins) placed in the 3D view",
        handler: () => ({ markers }),
    },
    {
        method: "POST",
        path: "api/markers",
        description: "Pin a marker on the floor at x, y (world meters)",
        params: {
            x: { type: "number", required: true },
            y: { type: "number", required: true },
            label: { type: "string" },
        },
        handler: ({ x, y, label }) => {
            const marker = {
                id: `m${nextMarker++}`,
                x: number(x, "x"),
                y: number(y, "y"),
                label: label === undefined ? "" : String(label),
            }
            markers = [...markers, marker]
            publishEvent({ type: "markers", markers })
            return marker
        },
    },
    {
        method: "PUT",
        path: "api/markers/{id}",
        description: "Move a marker",
        params: {
            id: { type: "string", required: true },
            x: { type: "number", required: true },
            y: { type: "number", required: true },
        },
        handler: ({ id, x, y }) => {
            const marker = markers.find((entry) => entry.id === id)
            if (!marker) {
                throw new HttpError(404, `no marker ${id}`)
            }
            Object.assign(marker, { x: number(x, "x"), y: number(y, "y") })
            publishEvent({ type: "markers", markers })
            return marker
        },
    },
    {
        method: "DELETE",
        path: "api/markers/{id}",
        description: "Remove a marker",
        params: { id: { type: "string", required: true } },
        handler: ({ id }) => {
            if (!markers.some((entry) => entry.id === id)) {
                throw new HttpError(404, `no marker ${id}`)
            }
            markers = markers.filter((entry) => entry.id !== id)
            publishEvent({ type: "markers", markers })
            return { ok: true }
        },
    },
    {
        method: "DELETE",
        path: "api/markers",
        description: "Remove every marker",
        handler: () => {
            markers = []
            publishEvent({ type: "markers", markers })
            return { ok: true }
        },
    },
    {
        method: "POST",
        path: "api/slice",
        description:
            "Clip the 3D view to a height band (cut away a roof or the floor): zMin / zMax in world meters, null = open",
        params: { zMin: { type: "number" }, zMax: { type: "number" } },
        handler: ({ zMin, zMax }) => {
            const next = {
                zMin: zMin === null || zMin === undefined ? null : number(zMin, "zMin"),
                zMax: zMax === null || zMax === undefined ? null : number(zMax, "zMax"),
            }
            if (next.zMin !== null && next.zMax !== null && next.zMin >= next.zMax) {
                throw new HttpError(400, "zMin must be below zMax")
            }
            slice = next
            publishEvent({ type: "slice", slice })
            return slice
        },
    },
    {
        method: "GET",
        path: "api/map/status",
        description:
            "The map build: the running one (stream, phase, progress), the last result (aggregated stream, points, seconds) or error",
        handler: () => mapStatus(),
    },
    {
        method: "POST",
        path: "api/map/build",
        description:
            "Build (or rebuild) a lidar map from a cloud stream of the open .db recording: every scan placed in the world and voxel-deduplicated, then optionally cleaned. Saved into the recording as '<stream>_aggregated', which then appears as a stream. Progress: GET api/map/status or the 'map' events. wait=true answers when it's done",
        params: {
            stream: { type: "string", required: true, description: "the source point-cloud stream (e.g. lidar)" },
            voxel: { type: "number", description: "voxel edge in meters (default 0.05)" },
            carve: {
                type: "boolean",
                description: "column carving: drop floaters and everything above carveHeight (default true)",
            },
            carveHeight: {
                type: "number",
                description: "meters above each column's floor to keep (default 2.13; 0 = no height cut)",
            },
            carveGap: { type: "number", description: "vertical gap (m) that marks a floater (default 0.5)" },
            outlier: { type: "boolean", description: "drop isolated speckle points (default true)" },
            outlierMin: { type: "number", description: "occupied neighbors (3x3x3) a voxel needs to stay (default 3)" },
            wait: { type: "boolean", description: "answer when the build finishes (default false: answer at once)" },
        },
        handler: async (args) => {
            const running = startBuild(String(args.stream), buildOptions(args))
            mapRunning = running
            if (bool(args.wait, false)) {
                await running
                if (lastMapError) {
                    throw new HttpError(500, lastMapError)
                }
            }
            return mapStatus()
        },
    },
    {
        method: "POST",
        path: "api/map/cancel",
        description: "Stop the running map build (the recording is left as it was)",
        handler: async () => {
            if (!mapAbort) {
                throw new HttpError(409, "no map is building")
            }
            mapAbort.abort()
            await mapRunning
            return mapStatus()
        },
    },
    {
        method: "POST",
        path: "api/map/export",
        description:
            "Save a built map as a .pc2.lcm file (one LCM PointCloud2, what dimos loads as a global map / relocalization premap). Default: next to the recording, named <recording>.<stream>.pc2.lcm",
        params: {
            stream: {
                type: "string",
                description: "the map stream (default: the open recording's *_aggregated stream)",
            },
            path: { type: "string", description: "where to write (.pc2.lcm)" },
            overwrite: { type: "boolean", description: "replace an existing file (default false)" },
        },
        handler: async ({ stream, path, overwrite }) => {
            const recording = requireRecording()
            const maps = recording.streams.filter((entry) => entry.name.endsWith("_aggregated"))
            const name = stream === undefined ? (maps.length === 1 ? maps[0].name : null) : String(stream)
            if (!name) {
                throw new HttpError(
                    400,
                    maps.length
                        ? `several maps: give stream (${maps.map((entry) => entry.name).join(", ")})`
                        : "no built map in this recording (POST api/map/build first)",
                )
            }
            if (!recording.streams.some((entry) => entry.name === name && entry.kind === "cloud")) {
                throw new HttpError(404, `no cloud stream named ${name}`)
            }
            const blob = playback.firstBlob(name)
            if (!blob) {
                throw new HttpError(409, `${name} has no data to export (exports work on .db recordings)`)
            }
            const directory = recording.path.slice(0, recording.path.lastIndexOf("/"))
            const base = recording.name.replace(/\.(db|mcap)$/, "")
            let target = path === undefined
                ? `${directory}/${base}.${name}.pc2.lcm`
                : String(path).replace(/^~(?=\/|$)/, Deno.env.get("HOME") ?? "")
            if (!target.endsWith(".pc2.lcm")) {
                target += ".pc2.lcm"
            }
            if (path === undefined && !await writable(directory)) {
                await Deno.mkdir(`${DATA_DIR}/maps`, { recursive: true })
                target = `${DATA_DIR}/maps/${base}.${name}.pc2.lcm`
            }
            if (!bool(overwrite, false)) {
                try {
                    await Deno.stat(target)
                    throw new HttpError(409, `${target} exists (overwrite: true to replace it)`)
                } catch (error) {
                    if (error instanceof HttpError) {
                        throw error
                    }
                }
            }
            const bytes = unwrapBlob(blob)
            try {
                await Deno.writeFile(target, bytes)
            } catch (error) {
                throw new HttpError(400, `can't write ${target}: ${(error as Error).message}`)
            }
            await recordRecent(target)
            publishEvent({ type: "recordings" })
            return { path: target, bytes: bytes.length, stream: name }
        },
    },
]
