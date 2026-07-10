// Recording Viewer — backend half. Renders a 3D scene from a RECORDED dimos
// "memory2" .db file (SQLite) instead of a live bridge. It opens a recording,
// builds one merged timeline across every stream, decodes each message on demand
// (@dimos/msgs), and forwards compact frames to the 3D frontend as a scrubbable
// playhead advances. Same frame vocabulary as dim-live-viewer
// (cloud / odom / tf / path / image) so the rendering is shared in spirit.
//
// Cold-storage friendly: recordings run to tens of GB, but the big message
// blobs live in separate "<stream>_blob" tables. We only scan the small
// (id, ts) columns up front into typed arrays, and read/decode a blob straight
// off disk exactly when the playhead reaches it — blobs never all sit in memory
// and never cross the app bus.

import { DimAppBackend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"
import { DatabaseSync } from "node:sqlite"
import { decode } from "jsr:@dimos/msgs@0.1.4"

const dimApp = new DimAppBackend()

const HOME = Deno.env.get("HOME") ?? ""
// Directories scanned for .db recordings (also one level deep, since go2
// recordings live at <root>/<recording-dir>/mem2.db). Drag-drop resolves a
// dropped basename against these too.
const RECORDING_ROOTS = [
    `${HOME}/datasets`,
    `${HOME}/datasets/go2_recordings`,
    `${HOME}/dimos_phase2_china`,
    Deno.cwd(),
]

const MAX_PTS = 24000   // per-cloud downsample cap (matches live viewer)

const KIND_NAMES = ["cloud", "odom", "tf", "path", "image"]
const KIND_CODES = { cloud: 0, odom: 1, tf: 2, path: 3, image: 4 }

// ── low-level helpers (shared shape with dim-live-viewer) ──────────────────
function toB64(bytes) {
    let binary = ""
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
}
function asBytes(data) {
    if (data instanceof Uint8Array) {
        return data
    }
    if (data?.buffer) {
        return new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.length)
    }
    if (Array.isArray(data)) {
        return Uint8Array.from(data)
    }
    return new Uint8Array(0)
}
function frameId(message) {
    return message?.header?.frame_id || ""
}
// Both Odometry (pose.pose) and PoseStamped (pose) show up as robot/pose streams.
function poseOf(message) {
    const wrapper = message?.pose
    return wrapper?.pose ?? wrapper ?? null
}

// Render kind from the stored payload type (known from _streams.config).
function kindOfType(typeName) {
    if (typeName === "PointCloud2") {
        return "cloud"
    }
    if (typeName === "Odometry" || typeName === "PoseStamped") {
        return "odom"
    }
    if (typeName === "TFMessage") {
        return "tf"
    }
    if (typeName === "Path") {
        return "path"
    }
    if (typeName === "Image" || typeName === "CompressedImage") {
        return "image"
    }
    return null
}
// Backup for streams whose payload type we didn't recognize by name.
function kindOfMessage(message) {
    if (!message || typeof message !== "object") {
        return null
    }
    if (Array.isArray(message.fields) && (message.point_step || message.width)) {
        return "cloud"
    }
    if (message.pose && (message.pose.pose?.position || message.pose.position)) {
        return "odom"
    }
    if (Array.isArray(message.transforms)) {
        return "tf"
    }
    if (Array.isArray(message.poses)) {
        return "path"
    }
    if (message.format !== undefined && message.width === undefined) {
        return "image"
    }
    if (message.width !== undefined && message.height !== undefined && message.encoding !== undefined && message.data !== undefined) {
        return "image"
    }
    return null
}

function parseCloud(message) {
    const fields = message.fields || []
    const fieldX = fields.find((field) => field.name === "x")
    const fieldY = fields.find((field) => field.name === "y")
    const fieldZ = fields.find((field) => field.name === "z")
    const step = message.point_step | 0
    if (!fieldX || !fieldY || !fieldZ || !step) {
        return null
    }
    const data = asBytes(message.data)
    const total = Math.floor(data.byteLength / step)
    if (!total) {
        return null
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const littleEndian = !message.is_bigendian
    const read = (offset, datatype) => (datatype === 8 ? view.getFloat64(offset, littleEndian) : view.getFloat32(offset, littleEndian))
    const stride = Math.max(1, Math.ceil(total / MAX_PTS))
    const out = new Float32Array(Math.ceil(total / stride) * 3)
    let kept = 0
    for (let i = 0; i < total; i += stride) {
        const base = i * step
        const x = read(base + fieldX.offset, fieldX.datatype)
        const y = read(base + fieldY.offset, fieldY.datatype)
        const z = read(base + fieldZ.offset, fieldZ.datatype)
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
            continue
        }
        out[kept * 3] = x
        out[kept * 3 + 1] = y
        out[kept * 3 + 2] = z
        kept++
    }
    return { n: kept, b64: toB64(new Uint8Array(out.buffer, 0, kept * 3 * 4)) }
}
function parsePath(message) {
    const poses = message.poses || []
    const out = new Float32Array(poses.length * 3)
    let kept = 0
    for (const stamped of poses) {
        const position = stamped?.pose?.position
        if (!position || !isFinite(position.x) || !isFinite(position.y) || !isFinite(position.z)) {
            continue
        }
        out[kept * 3] = position.x
        out[kept * 3 + 1] = position.y
        out[kept * 3 + 2] = position.z
        kept++
    }
    return { n: kept, b64: toB64(new Uint8Array(out.buffer, 0, kept * 3 * 4)) }
}

// Turn one decoded message into the frontend frame for its kind.
function frameForMessage(streamName, kind, message) {
    if (kind === "cloud") {
        const cloud = parseCloud(message)
        if (cloud) {
            return ["cloud", { stream: streamName, frame: frameId(message), n: cloud.n, b64: cloud.b64 }]
        }
    } else if (kind === "odom") {
        const pose = poseOf(message)
        const position = pose?.position
        const orientation = pose?.orientation
        if (position && orientation) {
            return ["odom", {
                stream: streamName,
                frame: frameId(message),
                pos: [position.x, position.y, position.z],
                quat: [orientation.x, orientation.y, orientation.z, orientation.w],
            }]
        }
    } else if (kind === "tf") {
        const transforms = (message.transforms || []).map((transform) => ({
            parent: transform?.header?.frame_id || "",
            child: transform.child_frame_id || "",
            t: [transform.transform.translation.x, transform.transform.translation.y, transform.transform.translation.z],
            q: [transform.transform.rotation.x, transform.transform.rotation.y, transform.transform.rotation.z, transform.transform.rotation.w],
        }))
        if (transforms.length) {
            return ["tf", { transforms }]
        }
    } else if (kind === "path") {
        const path = parsePath(message)
        return ["path", { stream: streamName, frame: frameId(message), n: path.n, b64: path.b64 }]
    } else if (kind === "image") {
        if (message.format !== undefined && message.width === undefined) {
            return ["frame", { stream: streamName, kind: "compressed", format: String(message.format || "jpeg"), b64: toB64(asBytes(message.data)) }]
        }
        return ["frame", {
            stream: streamName,
            kind: "raw",
            encoding: String(message.encoding || ""),
            width: message.width | 0,
            height: message.height | 0,
            step: message.step | 0,
            bigendian: !!message.is_bigendian,
            b64: toB64(asBytes(message.data)),
        }]
    }
    return null
}

// ── recording discovery ────────────────────────────────────────────────────
async function scanDir(root, depth, seen, found) {
    let entries
    try {
        entries = Deno.readDir(root)
    } catch {
        return
    }
    try {
        for await (const entry of entries) {
            const path = `${root}/${entry.name}`
            if (entry.isDirectory && depth > 0) {
                await scanDir(path, depth - 1, seen, found)
            } else if (entry.isFile && entry.name.endsWith(".db") && !seen.has(path)) {
                seen.add(path)
                let size = 0
                let mtime = 0
                try {
                    const info = await Deno.stat(path)
                    size = info.size
                    mtime = info.mtime ? info.mtime.getTime() : 0
                } catch { /* stat raced with delete — list it anyway */ }
                found.push({ name: entry.name, label: `${root.split("/").pop()}/${entry.name}`, path, size, mtime })
            }
        }
    } catch { /* dir vanished mid-scan */ }
}
async function listRecordings() {
    const found = []
    const seen = new Set()
    for (const root of RECORDING_ROOTS) {
        await scanDir(root, 1, seen, found)
    }
    found.sort((a, b) => b.mtime - a.mtime)
    return found
}
// A dropped File in the webview is bytes-only (the SDK strips the path at
// v0.3.0), and recordings are far too big to cross the app bus. The backend runs
// as a full-permission Deno process, so it opens a native file dialog itself and
// reads the chosen absolute path from stdout.
async function pickFileNative() {
    const attempts = Deno.build.os === "darwin"
        ? [["osascript", "-e", "POSIX path of (choose file with prompt \"Select a dimos recording\")"]]
        : [
            ["zenity", "--file-selection", "--title=Select a dimos recording", "--file-filter=recordings (*.db) | *.db", "--file-filter=all | *"],
            ["kdialog", "--getopenfilename", HOME, "*.db"],
        ]
    for (const argv of attempts) {
        let output
        try {
            output = await new Deno.Command(argv[0], { args: argv.slice(1), stdout: "piped", stderr: "piped" }).output()
        } catch {
            continue   // picker binary not installed — try the next one
        }
        if (!output.success) {
            return null   // user cancelled the dialog
        }
        const path = new TextDecoder().decode(output.stdout).trim()
        if (path) {
            return path
        }
    }
    return null
}
// Drag-drop may only give us a basename; resolve it against the known roots.
async function resolveRecording(nameOrPath) {
    try {
        const info = await Deno.stat(nameOrPath)
        if (info.isFile) {
            return nameOrPath
        }
    } catch { /* not a direct path — fall through to basename search */ }
    const base = nameOrPath.split("/").pop()
    for (const record of await listRecordings()) {
        if (record.name === base) {
            return record.path
        }
    }
    return null
}

// ── playback engine ─────────────────────────────────────────────────────────
// One recording open at a time. The merged timeline is held as parallel typed
// arrays (ts / id / stream-index / kind-code) plus a ts-sorted index, so even a
// multi-million-row recording is only ~13 bytes/row in memory. The playhead
// walks the sorted index; blobs are read+decoded on demand.
const playback = {
    db: null,
    path: null,
    streamNames: [],                 // stream-index -> name
    blobStatements: [],              // stream-index -> prepared blob SELECT (or null)
    count: 0,
    tsArray: new Float64Array(0),
    idArray: new Int32Array(0),
    streamArray: new Int32Array(0),
    kindArray: new Uint8Array(0),
    order: new Uint32Array(0),       // indices into the above, sorted by ts
    t0: 0,
    t1: 0,
    cursor: 0,
    playhead: 0,
    playing: false,
    speed: 4,
    timer: null,
    lastTick: 0,
    accumConfig: new Map(),          // stream-name -> "latest" | "all" | window-seconds string
}

function closeRecording() {
    if (playback.timer) {
        clearInterval(playback.timer)
        playback.timer = null
    }
    if (playback.db) {
        try {
            playback.db.close()
        } catch { /* already closed */ }
    }
    playback.db = null
    playback.path = null
    playback.streamNames = []
    playback.blobStatements = []
    playback.count = 0
    playback.tsArray = new Float64Array(0)
    playback.idArray = new Int32Array(0)
    playback.streamArray = new Int32Array(0)
    playback.kindArray = new Uint8Array(0)
    playback.order = new Uint32Array(0)
    playback.cursor = 0
    playback.playhead = 0
    playback.playing = false
    playback.accumConfig = new Map()
}

async function openRecording(nameOrPath) {
    const path = await resolveRecording(nameOrPath)
    if (!path) {
        dimApp.send("error", { message: `Could not locate recording: ${nameOrPath}` })
        return
    }
    dimApp.send("loading", { path, name: path.split("/").pop() })
    closeRecording()

    let db
    try {
        db = new DatabaseSync(path, { readOnly: true })
    } catch (openError) {
        dimApp.send("error", { message: `Failed to open ${path}: ${openError.message}` })
        return
    }
    let streamRows
    try {
        streamRows = db.prepare("SELECT name, config FROM _streams").all()
    } catch {
        db.close()
        dimApp.send("error", { message: `${path} is not a dimos recording (no _streams table)` })
        return
    }

    // Pass 1: stream metadata + row counts (so we can size the typed arrays).
    const summary = []
    const active = []   // { name, kind, kindCode, count }
    let total = 0
    for (const row of streamRows) {
        let config
        try {
            config = JSON.parse(row.config)
        } catch {
            config = {}
        }
        const typeName = config.payload_module?.split(".").pop() ?? "unknown"
        const kind = kindOfType(typeName)
        const count = db.prepare(`SELECT COUNT(*) AS c FROM "${row.name}"`).get().c
        summary.push({ name: row.name, type: typeName, kind, rows: count })
        const hasBlob = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        ).get(`${row.name}_blob`) != null
        if (kind && count && hasBlob) {
            active.push({ name: row.name, kind, kindCode: KIND_CODES[kind], count })
            total += count
        }
    }

    // Pass 2: fill the timeline arrays (scans only the small id/ts columns).
    const tsArray = new Float64Array(total)
    const idArray = new Int32Array(total)
    const streamArray = new Int32Array(total)
    const kindArray = new Uint8Array(total)
    const streamNames = []
    const blobStatements = []
    let write = 0
    for (let streamIndex = 0; streamIndex < active.length; streamIndex++) {
        const stream = active[streamIndex]
        streamNames.push(stream.name)
        blobStatements.push(db.prepare(`SELECT data FROM "${stream.name}_blob" WHERE id=?`))
        // node:sqlite's row iterator segfaults on large tables, so read the small
        // id/ts columns per-stream with .all() (a transient array, freed after copy
        // into the typed timeline). Only these tiny columns load — blobs stay on disk.
        for (const record of db.prepare(`SELECT id, ts FROM "${stream.name}"`).all()) {
            tsArray[write] = record.ts
            idArray[write] = record.id
            streamArray[write] = streamIndex
            kindArray[write] = stream.kindCode
            write++
        }
    }

    // ts-sorted view over the arrays.
    const order = new Uint32Array(total)
    for (let i = 0; i < total; i++) {
        order[i] = i
    }
    order.sort((a, b) => tsArray[a] - tsArray[b])

    playback.db = db
    playback.path = path
    playback.streamNames = streamNames
    playback.blobStatements = blobStatements
    playback.count = total
    playback.tsArray = tsArray
    playback.idArray = idArray
    playback.streamArray = streamArray
    playback.kindArray = kindArray
    playback.order = order
    playback.t0 = total ? tsArray[order[0]] : 0
    playback.t1 = total ? tsArray[order[total - 1]] : 0
    playback.cursor = 0
    playback.playhead = playback.t0

    dimApp.send("loaded", {
        path,
        name: path.split("/").pop(),
        streams: summary,
        t0: playback.t0,
        t1: playback.t1,
        duration: playback.t1 - playback.t0,
    })
    startPlaying()   // a dropped/opened recording immediately renders in 3D
}

// Decode the message at sorted position `cursor` (blob read straight off disk).
function decodeAt(sortedCursor) {
    const index = playback.order[sortedCursor]
    const statement = playback.blobStatements[playback.streamArray[index]]
    if (!statement) {
        return null
    }
    const row = statement.get(playback.idArray[index])
    if (!row || !row.data) {
        return null
    }
    try {
        return decode(asBytes(row.data))
    } catch {
        return null
    }
}
function emitAt(sortedCursor) {
    const message = decodeAt(sortedCursor)
    if (!message) {
        return
    }
    const index = playback.order[sortedCursor]
    const streamName = playback.streamNames[playback.streamArray[index]]
    const kind = KIND_NAMES[playback.kindArray[index]] || kindOfMessage(message)
    const frame = frameForMessage(streamName, kind, message)
    if (frame) {
        // Stamp cloud/odom frames with their timeline ts so the frontend can
        // accumulate them within a time window.
        if (frame[0] === "cloud" || frame[0] === "odom") {
            frame[1].ts = playback.tsArray[index]
        }
        dimApp.send(frame[0], frame[1])
    }
}

function sendTime() {
    dimApp.send("time", {
        t: playback.playhead,
        t0: playback.t0,
        t1: playback.t1,
        playing: playback.playing,
        atEnd: playback.cursor >= playback.count,
    })
}

// Advance the playhead to `targetTs`, emitting every entry that comes due.
function advanceTo(targetTs) {
    while (playback.cursor < playback.count && playback.tsArray[playback.order[playback.cursor]] <= targetTs) {
        emitAt(playback.cursor)
        playback.cursor++
    }
    playback.playhead = targetTs
    sendTime()
}

function tick() {
    if (!playback.playing || !playback.db) {
        return
    }
    const now = performance.now()
    const elapsed = (now - playback.lastTick) / 1000
    playback.lastTick = now
    const target = Math.min(playback.t1, playback.playhead + elapsed * playback.speed)
    advanceTo(target)
    if (playback.cursor >= playback.count) {
        pausePlaying()
    }
}

function startPlaying() {
    if (!playback.db) {
        return
    }
    if (playback.cursor >= playback.count) {
        seekTo(playback.t0)
    }
    playback.playing = true
    playback.lastTick = performance.now()
    if (!playback.timer) {
        playback.timer = setInterval(tick, 33)
    }
    sendTime()
}
function pausePlaying() {
    playback.playing = false
    sendTime()
}

// Seek by resetting the scene and fast-forwarding from the start. Odom/tf/path
// replay in full (rebuild trails + transform tree). Each cloud stream's accumulation
// policy (latest / time-window / all) decides WHICH cloud frames survive, but the
// survivors are still emitted in timeline order and interleaved with tf/odom, so the
// frontend bakes each cloud with the transform that was current at ITS timestamp.
// (Emitting all clouds at the end would place them with the final pose, stacking an
// accumulated cloud on top of itself — it would look like a single instantaneous scan.)
function seekTo(targetTs) {
    if (!playback.db) {
        return
    }
    const clamped = Math.max(playback.t0, Math.min(playback.t1, targetTs))
    dimApp.send("reset", {})
    // Pass 1: gather each cloud stream's cursors so we can pick the accumulation set.
    const cloudCursors = new Map()   // stream-index -> [sortedCursor, ...] up to target
    let scan = 0
    while (scan < playback.count && playback.tsArray[playback.order[scan]] <= clamped) {
        const index = playback.order[scan]
        if (playback.kindArray[index] === KIND_CODES.cloud) {
            const streamIndex = playback.streamArray[index]
            let list = cloudCursors.get(streamIndex)
            if (!list) { list = []; cloudCursors.set(streamIndex, list) }
            list.push(scan)
        }
        scan++
    }
    const keepClouds = new Set()
    for (const [streamIndex, cursors] of cloudCursors) {
        for (const sortedCursor of selectCloudCursors(streamIndex, cursors, clamped)) {
            keepClouds.add(sortedCursor)
        }
    }
    // Pass 2: emit in timeline order — every non-cloud, plus the kept cloud frames.
    playback.cursor = 0
    while (playback.cursor < playback.count && playback.tsArray[playback.order[playback.cursor]] <= clamped) {
        const isCloud = playback.kindArray[playback.order[playback.cursor]] === KIND_CODES.cloud
        if (!isCloud || keepClouds.has(playback.cursor)) {
            emitAt(playback.cursor)
        }
        playback.cursor++
    }
    playback.playhead = clamped
    sendTime()
}

const CLOUD_SEEK_CAP = 240   // max cloud frames re-emitted per stream on seek (bounds cost)
function selectCloudCursors(streamIndex, cursors, clamped) {
    if (!cursors.length) { return cursors }
    const mode = playback.accumConfig.get(playback.streamNames[streamIndex]) || "latest"
    if (mode === "latest") { return [cursors[cursors.length - 1]] }
    if (mode === "all") { return cursors.slice(-CLOUD_SEEK_CAP) }
    const windowSeconds = Number(mode)
    if (!isFinite(windowSeconds) || windowSeconds <= 0) { return [cursors[cursors.length - 1]] }
    const cutoff = clamped - windowSeconds
    const withinWindow = cursors.filter((sortedCursor) => playback.tsArray[playback.order[sortedCursor]] >= cutoff)
    return withinWindow.slice(-CLOUD_SEEK_CAP)
}

// ── app bus ─────────────────────────────────────────────────────────────────
dimApp.onReceive(async (kind, payload) => {
    if (kind === "hello") {
        dimApp.send("recordings", { recordings: await listRecordings() })
        if (playback.path) {
            dimApp.send("loaded", {
                path: playback.path,
                name: playback.path.split("/").pop(),
                streams: playback.streamNames.map((name) => ({ name })),
                t0: playback.t0,
                t1: playback.t1,
                duration: playback.t1 - playback.t0,
            })
        }
    } else if (kind === "list") {
        dimApp.send("recordings", { recordings: await listRecordings() })
    } else if (kind === "open") {
        await openRecording(payload?.path || payload?.name || "")
    } else if (kind === "pickFile") {
        const path = await pickFileNative()
        if (path) {
            await openRecording(path)
        } else {
            dimApp.send("pickCancelled", {})
        }
    } else if (kind === "play") {
        startPlaying()
    } else if (kind === "pause") {
        pausePlaying()
    } else if (kind === "seek") {
        seekTo(Number(payload?.t) || playback.t0)
    } else if (kind === "speed") {
        const value = Number(payload?.speed)
        if (isFinite(value) && value > 0) {
            playback.speed = value
        }
    } else if (kind === "accum") {
        // Per-stream cloud accumulation policy; consulted by seekTo when rebuilding.
        if (payload?.stream) {
            playback.accumConfig.set(String(payload.stream), String(payload.mode || "latest"))
        }
    } else if (kind === "close") {
        closeRecording()
    }
})
