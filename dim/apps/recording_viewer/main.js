// Mapper — backend half. Renders a 3D scene from a RECORDED dimos
// "memory2" .db file (SQLite) or .mcap instead of a live bridge. It opens a recording,
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

import { DimAppBackend } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.1/backend.js"
import { DatabaseSync } from "node:sqlite"
import { decode } from "jsr:@dimos/msgs@0.1.4"
import lz4 from "https://esm.sh/lz4js@0.2.0"

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
const AGG_RENDER_CAP = 1_000_000   // aggregated maps are a single static cloud; allow far more points

const KIND_NAMES = ["cloud", "odom", "tf", "path", "image"]
const KIND_CODES = { cloud: 0, odom: 1, tf: 2, path: 3, image: 4 }

// ── low-level helpers (shared shape with dim-live-viewer) ──────────────────
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
// _streams.config.codec_id names the codec chain outermost-first: "lcm", "jpeg", "lz4+lcm",
// "pickle". Wrappers ("lz4") compress whatever the inner codec produced; the base codec decides
// whether @dimos/msgs can read it at all — "lcm" and "jpeg" both land on `decode()` (a jpeg blob
// is still an LCM Image envelope, just with JPEG pixel bytes), while "pickle" is python-only.
const DECODABLE_BASE_CODECS = new Set(["lcm", "jpeg"])
function baseCodec(codecId) {
    return String(codecId || "lcm").split("+").pop()
}
// Blobs whose stream config isn't at hand (mcap, a bare .pc2.lcm file) still get their wrapper
// stripped: an LCM or JPEG payload never begins with the LZ4 frame magic.
function decodeBlob(data) {
    let bytes = asBytes(data)
    if (bytes[0] === 0x04 && bytes[1] === 0x22 && bytes[2] === 0x4D && bytes[3] === 0x18) {
        bytes = new Uint8Array(lz4.decompress(bytes))
    }
    return decode(bytes)
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

function parseCloud(message, maxPts = MAX_PTS) {
    const fields = message.fields || []
    const fieldX = fields.find((field) => field.name === "x")
    const fieldY = fields.find((field) => field.name === "y")
    const fieldZ = fields.find((field) => field.name === "z")
    const step = message.point_step | 0
    if (!fieldX || !fieldY || !fieldZ || !step) {
        return null
    }
    const data = asBytes(message.data)
    // A truncated/corrupt blob can report more points (via width/point_step) than its
    // bytes actually cover. Clamp the count so no field read runs past the buffer —
    // otherwise a getFloatXX throws RangeError and aborts the whole seek replay.
    const sizeOf = (field) => field.datatype === 8 ? 8 : 4
    const maxFieldEnd = Math.max(fieldX.offset + sizeOf(fieldX), fieldY.offset + sizeOf(fieldY), fieldZ.offset + sizeOf(fieldZ))
    const total = Math.max(0, Math.min(Math.floor(data.byteLength / step), Math.floor((data.byteLength - maxFieldEnd) / step) + 1))
    if (!total) {
        return null
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const littleEndian = !message.is_bigendian
    const read = (offset, datatype) => (datatype === 8 ? view.getFloat64(offset, littleEndian) : view.getFloat32(offset, littleEndian))
    const stride = Math.max(1, Math.ceil(total / maxPts))
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
    return { n: kept, bytes: new Uint8Array(out.buffer.slice(0, kept * 3 * 4)) }
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
    return { n: kept, bytes: new Uint8Array(out.buffer.slice(0, kept * 3 * 4)) }
}

// Byte payloads ride binary bus frames (SDK v0.3.1 sendBytes) instead of base64;
// everything else stays a plain JSON message.
function sendFrame(kind, payload) {
    if (payload.bytes) {
        const { bytes, ...meta } = payload
        dimApp.sendBytes(kind, bytes, meta)
    } else {
        dimApp.send(kind, payload)
    }
}

// Turn one decoded message into the frontend frame for its kind.
function frameForMessage(streamName, kind, message) {
    if (kind === "cloud") {
        const cloud = parseCloud(message, streamName.split("#")[0].endsWith("_aggregated") ? AGG_RENDER_CAP : MAX_PTS)
        if (cloud) {
            return ["cloud", { stream: streamName, frame: frameId(message), n: cloud.n, bytes: cloud.bytes }]
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
        return ["path", { stream: streamName, frame: frameId(message), n: path.n, bytes: path.bytes }]
    } else if (kind === "image") {
        // A CompressedImage carries `format` and no width/height. But some recordings
        // also store plain Image messages whose blob is already JPEG/PNG-encoded
        // (codec_id "jpeg"): the type is Image (has width/height) yet `encoding` names
        // the codec and `data` holds the compressed bytes. Both must take the compressed
        // path — otherwise the frontend draws codec bytes as raw pixels (a garbled
        // strip over black).
        const encoding = String(message.encoding || "").toLowerCase()
        const isCompressedImage = message.format !== undefined && message.width === undefined
        const isEncodedBlob = encoding === "jpeg" || encoding === "jpg" || encoding === "png"
        if (isCompressedImage || isEncodedBlob) {
            const format = isCompressedImage ? String(message.format || "jpeg") : (encoding === "jpg" ? "jpeg" : encoding)
            return ["frame", { stream: streamName, kind: "compressed", format, bytes: asBytes(message.data) }]
        }
        return ["frame", {
            stream: streamName,
            kind: "raw",
            encoding: String(message.encoding || ""),
            width: message.width | 0,
            height: message.height | 0,
            step: message.step | 0,
            bigendian: !!message.is_bigendian,
            bytes: asBytes(message.data),
        }]
    }
    return null
}

// ── recording discovery ────────────────────────────────────────────────────
// A ".pc2.lcm" is one bare LCM-encoded PointCloud2 on disk — an aggregated global
// map / relocalization premap, with no timeline and no SQLite around it. It opens
// like a recording that happens to hold a single static cloud.
const STATIC_CLOUD_SUFFIX = ".pc2.lcm"
function isRecordingFile(name) {
    return name.endsWith(".db") || name.endsWith(".mcap") || name.endsWith(STATIC_CLOUD_SUFFIX)
}

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
            } else if (entry.isFile && isRecordingFile(entry.name) && !seen.has(path)) {
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

// Recently-opened recordings, persisted to disk so they survive restarts and show
// files the user browsed to from anywhere (not just the scanned roots). Newest-opened
// first, deduped by path, capped. (Mirrors the recently-opened list in dim-urdf-editor.)
const RECENTS_FILE = `${HOME}/.local/share/dim/recording_viewer_recents.json`
const RECENTS_CAP = 15
async function loadRecents() {
    try {
        const list = JSON.parse(await Deno.readTextFile(RECENTS_FILE))
        return Array.isArray(list) ? list : []
    } catch {
        return []   // no file yet / unreadable
    }
}
async function recordRecent(path) {
    const list = (await loadRecents()).filter((entry) => entry && entry.path !== path)
    list.unshift({ path, openedAt: Date.now() })
    try {
        await Deno.mkdir(`${HOME}/.local/share/dim`, { recursive: true })
        await Deno.writeTextFile(RECENTS_FILE, JSON.stringify(list.slice(0, RECENTS_CAP)))
    } catch { /* best-effort: a missing recents file just means an empty list */ }
}
// Shape recents for the browser like scanned recordings, dropping any that have since
// vanished. mtime carries openedAt so the frontend can sort/merge them at the top.
async function recentRecordings() {
    const out = []
    for (const entry of await loadRecents()) {
        if (!entry || !entry.path) { continue }
        let size = 0
        try {
            const info = await Deno.stat(entry.path)
            if (!info.isFile) { continue }
            size = info.size
        } catch {
            continue   // opened file was moved/deleted — drop it from the list
        }
        out.push({ name: entry.path.split("/").pop(), label: entry.path.split("/").pop(), path: entry.path, size, mtime: entry.openedAt || 0, recent: true })
    }
    return out
}
// One directory listing for the frontend's in-page file browser. A dropped File
// in the webview is bytes-only (the SDK strips the path at v0.3.0) and recordings
// are far too big to cross the app bus, so the frontend browses by path and sends
// back the one it wants opened. This replaces a native dialog spawned by the
// backend, which surfaced unreliably from the desktop's background service and
// needed a different picker binary per platform.
async function listDir(dir) {
    const path = dir && dir !== "~" ? dir.replace(/^~(?=\/|$)/, HOME) : HOME
    const dirs = []
    const files = []
    for await (const entry of Deno.readDir(path)) {
        if (entry.name.startsWith(".")) {
            continue
        }
        const child = `${path}/${entry.name}`
        if (entry.isDirectory) {
            dirs.push({ name: entry.name, path: child })
        } else if (entry.isFile && isRecordingFile(entry.name)) {
            let size = 0
            let mtime = 0
            try {
                const info = await Deno.stat(child)
                size = info.size
                mtime = info.mtime ? info.mtime.getTime() : 0
            } catch { /* stat raced with delete — list it anyway */ }
            files.push({ name: entry.name, path: child, size, mtime })
        }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/"
    return { dir: path, parent, dirs, files }
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
    mcap: null,                      // .mcap only: { file, chunkIndexes, readers, chunkCache }
    count: 0,
    tsArray: new Float64Array(0),
    idArray: new Int32Array(0),      // .db: blob row id — .mcap: byte offset of the message inside its chunk
    chunkArray: new Int32Array(0),   // .mcap only: which chunk holds each message
    streamArray: new Int32Array(0),
    kindArray: new Uint8Array(0),
    order: new Uint32Array(0),       // indices into the above, sorted by ts
    t0: 0,
    t1: 0,
    cursor: 0,
    playhead: 0,
    playing: false,
    speed: 1,
    timer: null,
    lastTick: 0,
    accumConfig: new Map(),          // stream-name -> "latest" | "all" | window-seconds string
    staticCloud: null,               // .pc2.lcm only: the one decoded cloud frame, kept so a page reload can replay it
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
    if (playback.mcap) {
        try {
            playback.mcap.file.close()
        } catch { /* already closed */ }
    }
    playback.db = null
    playback.mcap = null
    playback.path = null
    playback.streamNames = []
    playback.blobStatements = []
    playback.count = 0
    playback.tsArray = new Float64Array(0)
    playback.idArray = new Int32Array(0)
    playback.chunkArray = new Int32Array(0)
    playback.streamArray = new Int32Array(0)
    playback.kindArray = new Uint8Array(0)
    playback.order = new Uint32Array(0)
    playback.cursor = 0
    playback.playhead = 0
    playback.playing = false
    playback.accumConfig = new Map()
    playback.staticCloud = null
}

// Frames whose data is already in world coordinates (a tf root or a conventional
// global name). A stream in one of these needs no tf chain to be placed.
const GLOBAL_FRAME_NAMES = /^(world|map|odom|earth|global)$/i

// How buildTfReport gets at messages, so the report works for any container.
// `tfMessages` walks a tf stream's decoded messages (already thinned — the tf
// structure is static, so a sample is enough) and `frameOf` reads one message
// per stream to learn its header frame_id.
function sqliteTfSource(db) {
    return {
        *tfMessages(streamName) {
            let ids
            try {
                ids = db.prepare(`SELECT id FROM "${streamName}"`).all().map((record) => record.id)
            } catch {
                return
            }
            // A frame published under two parents only shows the conflict if we look at
            // edges from across the recording, so sample evenly rather than head-first.
            const step = Math.max(1, Math.floor(ids.length / 4000))
            const blobStatement = db.prepare(`SELECT data FROM "${streamName}_blob" WHERE id=?`)
            for (let i = 0; i < ids.length; i += step) {
                const row = blobStatement.get(ids[i])
                if (!row || !row.data) { continue }
                try {
                    yield decodeBlob(row.data)
                } catch { /* undecodable message → skip */ }
            }
        },
        frameOf(streamName) {
            try {
                const row = db.prepare(`SELECT data FROM "${streamName}_blob" LIMIT 1`).get()
                if (row && row.data) {
                    return frameId(decodeBlob(row.data))
                }
            } catch { /* undecodable / no blob → unknown frame */ }
            return ""
        },
    }
}

// Build a deterministic tf forest for the WHOLE recording and diagnose which
// renderable streams (cloud / odom / path) can actually be placed in the map.
// Returns an ELI5 report the frontend pops as a click-to-close warning whenever a
// stream's frame can't be resolved to a single world root. Deterministic (scans the
// tf stream directly) rather than depending on the live playhead's tf state.
function buildTfReport(source, summary, active) {
    const childParents = new Map()    // child frame -> Set(parent frame)
    const parentChildren = new Map()  // parent frame -> Set(child frame)
    const addEdge = (parent, child) => {
        if (!parent || !child || parent === child) { return }
        if (!childParents.has(child)) { childParents.set(child, new Set()) }
        childParents.get(child).add(parent)
        if (!parentChildren.has(parent)) { parentChildren.set(parent, new Set()) }
        parentChildren.get(parent).add(child)
    }
    const tfNames = summary.filter((stream) => stream.kind === "tf" && stream.rows).map((stream) => stream.name)
    for (const tfName of tfNames) {
        for (const message of source.tfMessages(tfName)) {
            for (const transform of message?.transforms || []) {
                addEdge(transform?.header?.frame_id || "", transform?.child_frame_id || "")
            }
        }
    }

    const allFrames = new Set()
    for (const [child, parents] of childParents) {
        allFrames.add(child)
        for (const parent of parents) { allFrames.add(parent) }
    }
    const isRoot = (frame) => allFrames.has(frame) && !childParents.has(frame)
    const isGlobal = (frame) => GLOBAL_FRAME_NAMES.test(frame) || isRoot(frame)

    // Diagnose every renderable stream's frame.
    const problems = []
    const problemFrames = new Set()
    for (const stream of active) {
        if (stream.kind !== "cloud" && stream.kind !== "odom" && stream.kind !== "path") { continue }
        const frame = source.frameOf(stream.name)
        if (!frame) { continue }   // frameless pose/detection streams are drawn as loose markers, not a tf failure
        const parents = childParents.get(frame)
        let reason = null
        let detail = ""
        if (!parents) {
            if (!isGlobal(frame)) {
                reason = "no-tf"
                detail = `no transform found for "${frame}" — it never shows up in tf, so the viewer has nowhere to put it`
            }
        } else if (parents.size > 1) {
            reason = "ambiguous"
            detail = `"${frame}" is attached to ${parents.size} parents (${[...parents].sort().join(", ")}) — the viewer can't tell which one is the real map, so the cloud can land in the wrong place`
        } else {
            // Single parent: walk up the chain; flag cycles or dead-ends that never
            // reach a world root.
            let current = frame
            let reachedRoot = false
            const seen = new Set()
            for (let guard = 0; current && guard < 64; guard++) {
                if (seen.has(current)) { break }   // cycle
                seen.add(current)
                const chainParents = childParents.get(current)
                if (!chainParents) { reachedRoot = isGlobal(current); break }
                current = [...chainParents][0]
            }
            if (!reachedRoot) {
                reason = "disconnected"
                detail = `"${frame}" never connects up to a world/map frame`
            }
        }
        if (reason) {
            problems.push({ stream: stream.name, frame, reason, detail })
            problemFrames.add(frame)
        }
    }

    // Render each tree (like db_tree). A frame published under several parents shows
    // up under each of them, which makes the conflict visible.
    const treeLines = []
    const renderChild = (frame, prefix, isLast, onPath) => {
        const cycle = onPath.has(frame)
        treeLines.push({
            prefix: prefix + (isLast ? "└── " : "├── "),
            frame,
            note: cycle ? "  (cycle)" : "",
            problem: problemFrames.has(frame),
        })
        if (cycle) { return }
        const kids = [...(parentChildren.get(frame) || [])].sort()
        const childPrefix = prefix + (isLast ? "    " : "│   ")
        const nextPath = new Set(onPath).add(frame)
        kids.forEach((kid, index) => renderChild(kid, childPrefix, index === kids.length - 1, nextPath))
    }
    const roots = [...allFrames].filter((frame) => !childParents.has(frame)).sort()
    for (const root of roots) {
        treeLines.push({ prefix: "", frame: root, note: "", problem: problemFrames.has(root) })
        const kids = [...(parentChildren.get(root) || [])].sort()
        kids.forEach((kid, index) => renderChild(kid, "", index === kids.length - 1, new Set([root])))
    }

    return { hasTf: tfNames.length > 0, treeLines, problems }
}

// One bare PointCloud2 file: the whole thing is a single message, so it loads as a
// zero-length timeline with one cloud already emitted. That empty timeline makes
// seek/play no-ops — correct for a static map — and `playback.db` stays null, which
// keeps the aggregation handler (which needs a stream to walk) from accepting it.
async function openStaticCloud(path) {
    closeRecording()
    let message
    try {
        message = decodeBlob(await Deno.readFile(path))
    } catch (decodeError) {
        dimApp.send("error", { message: `Failed to read ${path}: ${decodeError.message}` })
        return
    }
    const cloud = parseCloud(message, AGG_RENDER_CAP)
    if (!cloud) {
        dimApp.send("error", { message: `${path} is not a PointCloud2 (no x/y/z fields)` })
        return
    }
    const name = path.split("/").pop()
    const stream = name.slice(0, -STATIC_CLOUD_SUFFIX.length)
    const stamp = message.header?.stamp
    const ts = stamp ? stamp.sec + (stamp.nsec || 0) / 1e9 : 0
    playback.path = path
    playback.streamNames = [stream]
    playback.t0 = ts
    playback.t1 = ts
    playback.playhead = ts
    playback.staticCloud = { stream, frame: frameId(message), n: cloud.n, bytes: cloud.bytes, ts }
    dimApp.send("loaded", {
        path,
        name,
        streams: [{ name: stream, type: "PointCloud2", kind: "cloud", rows: 1 }],
        t0: ts,
        t1: ts,
        duration: 0,
    })
    replayStaticCloud()
    sendTime()
    await recordRecent(path)
}

function replayStaticCloud() {
    dimApp.send("reset", {})
    sendFrame("cloud", playback.staticCloud)
}

// ── .mcap recordings ───────────────────────────────────────────────────────
// An mcap holds the same messages as the .db, but CDR-encoded against ros2msg
// schemas and packed into compressed chunks. Its summary section indexes every
// message by (chunk, byte offset) without touching any payload, which is the
// same bargain the .db gives us: build the whole timeline up front, then
// decompress and decode exactly one message when the playhead reaches it.
//
// Everything below the open is synchronous — file reads via readSync and the
// decompressors are sync once their wasm is up — so the playhead path stays
// sync like the sqlite one.

// Loaded on first .mcap open so a .db-only session never pays for the npm graph.
let mcapDeps = null
async function loadMcapDeps() {
    if (!mcapDeps) {
        const [core, support, rosmsg, cdr] = await Promise.all([
            import("npm:@mcap/core@2"),
            import("npm:@mcap/support@1"),
            import("npm:@foxglove/rosmsg@5"),
            import("npm:@foxglove/rosmsg2-serialization@3"),
        ])
        mcapDeps = {
            McapIndexedReader: core.McapIndexedReader,
            parseSchema: rosmsg.parse,
            MessageReader: cdr.MessageReader,
            decompressHandlers: await support.loadDecompressHandlers(),
        }
    }
    return mcapDeps
}

const MCAP_OP_MESSAGE = 0x05
const MCAP_OP_MESSAGE_INDEX = 0x07
const MCAP_CHUNK_CACHE = 6   // decompressed chunks held at once (a couple MB each)

function readAtSync(file, offset, length) {
    const out = new Uint8Array(length)
    file.seekSync(offset, Deno.SeekMode.Start)
    let filled = 0
    while (filled < length) {
        const read = file.readSync(out.subarray(filled))
        if (!read) { break }
        filled += read
    }
    return filled === length ? out : out.subarray(0, filled)
}

// Every message in one chunk, as (channel, log time, offset into the chunk's
// decompressed records). Read from the chunk's message-index records, which sit
// right after the chunk itself — so building a timeline never decompresses.
function forEachIndexedMessage(file, chunkIndex, onMessage) {
    const bytes = readAtSync(file, Number(chunkIndex.chunkStartOffset + chunkIndex.chunkLength), Number(chunkIndex.messageIndexLength))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let at = 0
    while (at + 9 <= bytes.byteLength) {
        const recordLength = Number(view.getBigUint64(at + 1, true))
        if (view.getUint8(at) === MCAP_OP_MESSAGE_INDEX) {
            const channelId = view.getUint16(at + 9, true)
            const arrayLength = view.getUint32(at + 11, true)
            for (let cursor = at + 15; cursor + 16 <= at + 15 + arrayLength; cursor += 16) {
                onMessage(channelId, Number(view.getBigUint64(cursor, true)), Number(view.getBigUint64(cursor + 8, true)))
            }
        }
        at += 9 + recordLength
    }
}

function chunkRecords(mcap, chunkNumber) {
    const cached = mcap.chunkCache.get(chunkNumber)
    if (cached) {
        mcap.chunkCache.delete(chunkNumber)   // reinsert to move it to the young end
        mcap.chunkCache.set(chunkNumber, cached)
        return cached
    }
    const chunkIndex = mcap.chunkIndexes[chunkNumber]
    const bytes = readAtSync(mcap.file, Number(chunkIndex.chunkStartOffset), Number(chunkIndex.chunkLength))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let cursor = 9 + 8 + 8 + 8 + 4   // record header, message start/end time, uncompressed size, crc
    const nameLength = view.getUint32(cursor, true)
    cursor += 4
    const compression = new TextDecoder().decode(bytes.subarray(cursor, cursor + nameLength))
    cursor += nameLength
    const payloadLength = Number(view.getBigUint64(cursor, true))
    cursor += 8
    const payload = bytes.subarray(cursor, cursor + payloadLength)
    const records = compression ? mcapDeps.decompressHandlers[compression](payload, chunkIndex.uncompressedSize) : payload
    mcap.chunkCache.set(chunkNumber, records)
    if (mcap.chunkCache.size > MCAP_CHUNK_CACHE) {
        mcap.chunkCache.delete(mcap.chunkCache.keys().next().value)
    }
    return records
}

function decodeMcapMessage(mcap, chunkNumber, offset) {
    let records
    try {
        records = chunkRecords(mcap, chunkNumber)
    } catch {
        return null   // unsupported compression / truncated chunk
    }
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength)
    if (offset + 9 > records.byteLength || view.getUint8(offset) !== MCAP_OP_MESSAGE) {
        return null
    }
    const recordLength = Number(view.getBigUint64(offset + 1, true))
    const reader = mcap.readers.get(view.getUint16(offset + 9, true))
    if (!reader) {
        return null
    }
    const dataStart = offset + 9 + 2 + 4 + 8 + 8   // channel id, sequence, log time, publish time
    try {
        return reader.readMessage(records.subarray(dataStart, offset + 9 + recordLength))
    } catch {
        return null
    }
}

// ROS2 topics are "/name" (dimos publishes under "rt/name"); memory2 flattens
// both the same way, so an mcap and its .db sibling agree on stream names.
function streamNameForTopic(topic) {
    return topic.replace(/^\/+/, "").replace(/^rt\//, "").replace(/\//g, "_")
}

// Same shape as sqliteTfSource, over the timeline we just built. Its tf sample is
// far smaller because every sample lands in a different chunk to decompress.
function mcapTfSource() {
    const cursorsFor = (streamName) => {
        const streamIndex = playback.streamNames.indexOf(streamName)
        const cursors = []
        for (let cursor = 0; cursor < playback.count; cursor++) {
            if (playback.streamArray[playback.order[cursor]] === streamIndex) { cursors.push(cursor) }
        }
        return cursors
    }
    return {
        *tfMessages(streamName) {
            const cursors = cursorsFor(streamName)
            const step = Math.max(1, Math.floor(cursors.length / 240))
            for (let i = 0; i < cursors.length; i += step) {
                const message = decodeAt(cursors[i])
                if (message) { yield message }
            }
        },
        frameOf(streamName) {
            const cursors = cursorsFor(streamName)
            return cursors.length ? frameId(decodeAt(cursors[0])) : ""
        },
    }
}

async function openMcap(path) {
    closeRecording()
    let deps
    try {
        deps = await loadMcapDeps()
    } catch (loadError) {
        dimApp.send("error", { message: `Could not load the mcap reader: ${loadError.message}` })
        return
    }
    let file
    let reader
    try {
        file = Deno.openSync(path, { read: true })
        const size = BigInt(Deno.statSync(path).size)
        reader = await deps.McapIndexedReader.Initialize({
            readable: {
                size: () => Promise.resolve(size),
                read: (offset, length) => Promise.resolve(readAtSync(file, Number(offset), Number(length))),
            },
            decompressHandlers: deps.decompressHandlers,
        })
    } catch (openError) {
        try {
            file?.close()
        } catch { /* never opened */ }
        dimApp.send("error", { message: `Failed to open ${path}: ${openError.message}` })
        return
    }

    // Pass 1: one stream per channel. Counts come from the summary's statistics;
    // a file written without them gets counted off the message indexes instead.
    const counts = new Map()
    for (const [channelId, count] of reader.statistics?.channelMessageCounts ?? []) {
        counts.set(channelId, Number(count))
    }
    if (!counts.size) {
        for (const chunkIndex of reader.chunkIndexes) {
            forEachIndexedMessage(file, chunkIndex, (channelId) => counts.set(channelId, (counts.get(channelId) ?? 0) + 1))
        }
    }
    const summary = []
    const active = []
    const readers = new Map()
    for (const [channelId, channel] of reader.channelsById) {
        const schema = reader.schemasById.get(channel.schemaId)
        const typeName = (schema?.name || "").split("/").pop() || "unknown"
        const kind = kindOfType(typeName)
        const count = counts.get(channelId) ?? 0
        const name = streamNameForTopic(channel.topic)
        summary.push({ name, type: typeName, kind, rows: count })
        if (!kind || !count || channel.messageEncoding !== "cdr" || schema?.encoding !== "ros2msg") {
            continue
        }
        try {
            readers.set(channelId, new deps.MessageReader(deps.parseSchema(new TextDecoder().decode(schema.data), { ros2: true })))
        } catch {
            continue   // schema we can't parse — the stream still shows up, it just never decodes
        }
        active.push({ name, kind, kindCode: KIND_CODES[kind], count, channelId })
    }

    // Pass 2: fill the timeline from the message indexes (no payload is touched).
    let total = 0
    for (const stream of active) {
        total += stream.count
    }
    const tsArray = new Float64Array(total)
    const idArray = new Int32Array(total)
    const chunkArray = new Int32Array(total)
    const streamArray = new Int32Array(total)
    const kindArray = new Uint8Array(total)
    const streamOfChannel = new Map(active.map((stream, streamIndex) => [stream.channelId, streamIndex]))
    let write = 0
    for (let chunkNumber = 0; chunkNumber < reader.chunkIndexes.length; chunkNumber++) {
        forEachIndexedMessage(file, reader.chunkIndexes[chunkNumber], (channelId, logTime, offset) => {
            const streamIndex = streamOfChannel.get(channelId)
            if (streamIndex === undefined || write >= total) {
                return
            }
            tsArray[write] = logTime / 1e9
            idArray[write] = offset
            chunkArray[write] = chunkNumber
            streamArray[write] = streamIndex
            kindArray[write] = active[streamIndex].kindCode
            write++
        })
    }

    const order = new Uint32Array(write)
    for (let i = 0; i < write; i++) {
        order[i] = i
    }
    order.sort((a, b) => tsArray[a] - tsArray[b])

    playback.mcap = { file, chunkIndexes: reader.chunkIndexes, readers, chunkCache: new Map() }
    playback.path = path
    playback.streamNames = active.map((stream) => stream.name)
    playback.count = write
    playback.tsArray = tsArray
    playback.idArray = idArray
    playback.chunkArray = chunkArray
    playback.streamArray = streamArray
    playback.kindArray = kindArray
    playback.order = order
    playback.t0 = write ? tsArray[order[0]] : 0
    playback.t1 = write ? tsArray[order[write - 1]] : 0
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
    seekTo(openingPlayhead())
    try {
        dimApp.send("tfReport", buildTfReport(mcapTfSource(), summary, active))
    } catch (reportError) {
        console.error("tf report failed:", reportError.message)
    }
    await recordRecent(path)
}

async function openRecording(nameOrPath) {
    const path = await resolveRecording(nameOrPath)
    if (!path) {
        dimApp.send("error", { message: `Could not locate recording: ${nameOrPath}` })
        return
    }
    dimApp.send("loading", { path, name: path.split("/").pop() })
    if (path.endsWith(STATIC_CLOUD_SUFFIX)) {
        await openStaticCloud(path)
        return
    }
    if (path.endsWith(".mcap")) {
        await openMcap(path)
        return
    }
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
    const codecProblems = []
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
        const codec = config.codec_id || "lcm"
        const count = db.prepare(`SELECT COUNT(*) AS c FROM "${row.name}"`).get().c
        summary.push({ name: row.name, type: typeName, kind, rows: count, codec })
        const hasBlob = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        ).get(`${row.name}_blob`) != null
        if (kind && count && hasBlob && !DECODABLE_BASE_CODECS.has(baseCodec(codec))) {
            // Say so rather than leaving the stream out of the panel with no explanation —
            // a silently missing stream reads as a bug in the viewer.
            codecProblems.push({ stream: row.name, detail: ` — stored with the "${codec}" codec, which this viewer can't read` })
        } else if (kind && count && hasBlob) {
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
    seekTo(openingPlayhead())   // render the opening frame but stay paused until the user hits play
    // Warn (ELI5 + tf tree) if any renderable stream's frame can't be placed.
    try {
        dimApp.send("tfReport", { ...buildTfReport(sqliteTfSource(db), summary, active), codecProblems })
    } catch (reportError) {
        console.error("tf report failed:", reportError.message)
    }
    await recordRecent(path)   // remember it as recently-opened for next time
}

// Decode the message at sorted position `cursor` (blob read straight off disk).
function decodeAt(sortedCursor) {
    const index = playback.order[sortedCursor]
    if (playback.mcap) {
        return decodeMcapMessage(playback.mcap, playback.chunkArray[index], playback.idArray[index])
    }
    const statement = playback.blobStatements[playback.streamArray[index]]
    if (!statement) {
        return null
    }
    const row = statement.get(playback.idArray[index])
    if (!row || !row.data) {
        return null
    }
    try {
        return decodeBlob(row.data)
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
        sendFrame(frame[0], frame[1])
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

// `t0` is the single earliest message in the whole recording, so seeking there emits
// that one message and nothing else — the app opens on an empty scene. Advance
// instead to the first moment every render kind has appeared, so the opening view
// has its clouds, robot pose, transforms and camera. Waiting for every *stream*
// instead would be dragged deep into the recording by sparse ones (a 2-row tag
// detection, a 1-row derived map).
function openingPlayhead() {
    const present = new Set()
    for (let index = 0; index < playback.count; index++) {
        present.add(playback.kindArray[index])
    }
    const seen = new Set()
    let cursor = 0
    while (cursor < playback.count && seen.size < present.size) {
        seen.add(playback.kindArray[playback.order[cursor]])
        cursor++
    }
    return playback.tsArray[playback.order[Math.max(0, cursor - 1)]]
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
    if (!playback.playing || !playback.count) {
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
    if (!playback.count) {
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
    if (!playback.count) {
        return
    }
    const clamped = Math.max(playback.t0, Math.min(playback.t1, targetTs))
    dimApp.send("reset", {})
    // Pass 1: bucket every entry up to the target by kind. A long recording has
    // hundreds of thousands of these; replaying them all as individual bus messages
    // freezes the frontend, so each kind is thinned to what's actually needed:
    //   clouds  → each stream's accumulation policy (selectCloudCursors)
    //   images  → only the latest frame per stream (each is a full blob off disk)
    //   odom    → subsampled trail (kept spacing stays under the frontend's TRAIL_JUMP)
    //   tf      → interleaved in Pass 2, coalesced per kept frame (see below)
    const cloudCursors = new Map()   // stream-index -> [sortedCursor, ...] up to target
    const odomCursors = new Map()    // stream-index -> [sortedCursor, ...] up to target
    const latestImage = new Map()    // stream-index -> last image sortedCursor up to target
    const bucket = (map, streamIndex, cursor) => {
        let list = map.get(streamIndex)
        if (!list) { list = []; map.set(streamIndex, list) }
        list.push(cursor)
    }
    let scan = 0
    while (scan < playback.count && playback.tsArray[playback.order[scan]] <= clamped) {
        const index = playback.order[scan]
        const kind = playback.kindArray[index]
        const streamIndex = playback.streamArray[index]
        if (kind === KIND_CODES.cloud) { bucket(cloudCursors, streamIndex, scan) }
        else if (kind === KIND_CODES.odom) { bucket(odomCursors, streamIndex, scan) }
        else if (kind === KIND_CODES.image) { latestImage.set(streamIndex, scan) }
        scan++
    }
    const keep = new Set()
    for (const [streamIndex, cursors] of cloudCursors) {
        for (const sortedCursor of selectCloudCursors(streamIndex, cursors, clamped)) {
            keep.add(sortedCursor)
        }
    }
    for (const [, cursors] of odomCursors) {
        for (const sortedCursor of subsampleCursors(cursors, ODOM_SEEK_CAP)) {
            keep.add(sortedCursor)
        }
    }
    for (const sortedCursor of latestImage.values()) { keep.add(sortedCursor) }
    // Pass 2: emit the kept cloud/odom/image frames (+ any path) in timeline order,
    // interleaving tf so each frame bakes against the transform tree current at ITS
    // timestamp. tf updates between two kept frames are coalesced (newest-per-child)
    // into ONE message flushed right before the frame — a moving frame like
    // world→lidar_link would otherwise resolve to the final pose and pile every
    // accumulated cloud onto the current robot frame. Coalescing bounds tf bus
    // messages to ~one per kept frame while decode stays cheap (blobs read on demand).
    playback.cursor = 0
    const pendingTf = new Map()   // child -> { parent, t, q } since the last flush
    const flushTf = () => {
        if (!pendingTf.size) { return }
        const transforms = []
        for (const [child, edge] of pendingTf) { transforms.push({ parent: edge.parent, child, t: edge.t, q: edge.q }) }
        dimApp.send("tf", { transforms })
        pendingTf.clear()
    }
    while (playback.cursor < playback.count && playback.tsArray[playback.order[playback.cursor]] <= clamped) {
        const kind = playback.kindArray[playback.order[playback.cursor]]
        if (kind === KIND_CODES.tf) {
            const message = decodeAt(playback.cursor)
            if (message && Array.isArray(message.transforms)) {
                for (const transform of message.transforms) {
                    if (!transform.transform) { continue }
                    const translation = transform.transform.translation
                    const rotation = transform.transform.rotation
                    pendingTf.set(transform.child_frame_id || "", {
                        parent: transform?.header?.frame_id || "",
                        t: [translation.x, translation.y, translation.z],
                        q: [rotation.x, rotation.y, rotation.z, rotation.w],
                    })
                }
            }
        } else if (kind === KIND_CODES.path || keep.has(playback.cursor)) {
            flushTf()
            emitAt(playback.cursor)
        }
        playback.cursor++
    }
    flushTf()   // trailing tf so the final tree matches the playhead
    playback.playhead = clamped
    sendTime()
}

// Evenly thin a cursor list to at most `cap`, always keeping the last (so the current
// pose — used for the robot body and cloud anchoring — is exact).
const ODOM_SEEK_CAP = 4000   // max odom trail points re-emitted per stream on seek
function subsampleCursors(cursors, cap) {
    if (cursors.length <= cap) {
        return cursors
    }
    const out = []
    const stride = cursors.length / cap
    for (let i = 0; i < cap - 1; i++) {
        out.push(cursors[Math.floor(i * stride)])
    }
    out.push(cursors[cursors.length - 1])
    return out
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

// ── lidar map aggregation ─────────────────────────────────────────────────────
// Accumulate every scan of a cloud stream into one world-frame map (dimos "map
// global"). The whole pipeline — SQLite read, LCM decode/encode, world transform,
// and voxel dedup — lives in the Rust mapper (mapper/, run via `nix run`, using the
// same lcm-msgs codec dimos uses). It opens the recording, aggregates, and writes
// the new "<name>_aggregated" PointCloud2 stream back in place. This side just
// launches it and forwards the JSON progress it prints.

// Resolved through symlinks: an install dir may be symlinked at the package root
// (dim installs/<pkg> -> a working clone), and nix refuses a `path:` flake whose
// path traverses a symlink. Falls back to the raw path rather than throwing here,
// since a throw at module load takes the whole backend down.
let MAPPER_DIR = new URL("./mapper", import.meta.url).pathname
try {
    MAPPER_DIR = Deno.realPathSync(MAPPER_DIR)
} catch { /* dir missing — let `nix run` report it */ }
const AGG_VOXEL = 0.05                          // voxel edge (m), matches dimos --voxel

// The single in-flight aggregation, so an "aggregateCancel" bus message can kill it.
let activeAggregate = null

async function aggregateStream(streamName, options = {}) {
    if (!playback.db || !playback.path) {
        // The Rust mapper reads and writes memory2 streams, so it needs the .db form.
        const message = playback.mcap ? "Aggregation needs a .db recording, not an .mcap" : "No recording open"
        dimApp.send("aggregateError", { stream: streamName, message })
        return
    }
    const aggregatedName = `${streamName}_aggregated`

    // Spawn the Rust mapper via `nix run`. path: reads the flake dir directly (no
    // git-tracking requirement); it stays cached after the first build. Map-cleaning
    // filters (column carving, outlier removal) are opt-in from the aggregate modal.
    const mapperArgs = [
        "run", `path:${MAPPER_DIR}`, "--",
        "--db", playback.path,
        "--stream", streamName,
        "--voxel", String(AGG_VOXEL),
    ]
    if (options.carve) {
        mapperArgs.push("--carve")
        if (Number.isFinite(options.carveHeight) && options.carveHeight >= 0) {
            mapperArgs.push("--carve-height", String(options.carveHeight))
        }
    }
    if (options.outlier) { mapperArgs.push("--outlier") }
    let child
    try {
        child = new Deno.Command("nix", {
            args: mapperArgs,
            stdout: "piped",
            stderr: "piped",
        }).spawn()
    } catch (spawnError) {
        dimApp.send("aggregateError", { stream: streamName, message: `Could not launch mapper: ${spawnError.message}` })
        return
    }
    activeAggregate = { stream: streamName, child, cancelled: false }
    dimApp.send("aggregateProgress", { stream: streamName, phase: "scanning", done: 0, total: 0 })

    // Forward the mapper's newline-delimited JSON progress as it streams.
    const stderrPromise = new Response(child.stderr).text()
    let donePayload = null
    let buffered = ""
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        buffered += chunk
        let newline
        while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline).trim()
            buffered = buffered.slice(newline + 1)
            if (!line) {
                continue
            }
            let event
            try {
                event = JSON.parse(line)
            } catch {
                continue
            }
            if (event.phase === "scanning") {
                dimApp.send("aggregateProgress", { stream: streamName, phase: "scanning", done: event.done || 0, total: event.total || 0 })
            } else if (event.phase === "outlier") {
                dimApp.send("aggregateProgress", { stream: streamName, phase: "outlier", done: 0, total: 0 })
            } else if (event.phase === "carving") {
                dimApp.send("aggregateProgress", { stream: streamName, phase: "carving", done: 0, total: 0 })
            } else if (event.phase === "writing") {
                dimApp.send("aggregateProgress", { stream: streamName, phase: "voxelizing", done: 0, total: 0 })
            } else if (event.phase === "done") {
                donePayload = event
            } else if (event.phase === "error") {
                dimApp.send("aggregateError", { stream: streamName, message: event.message || "mapper error" })
            }
        }
    }

    const status = await child.status
    const stderrText = await stderrPromise
    const wasCancelled = activeAggregate?.cancelled
    activeAggregate = null
    if (wasCancelled) {
        dimApp.send("aggregateCancelled", { stream: streamName })
        return
    }
    if (!status.success || !donePayload) {
        dimApp.send("aggregateError", { stream: streamName, message: `Mapper failed: ${stderrText.slice(-400) || "no output"}` })
        return
    }

    dimApp.send("aggregateProgress", { stream: streamName, phase: "reloading", done: 0, total: 0 })
    dimApp.send("aggregateDone", { stream: streamName, aggregated: donePayload.aggregated || aggregatedName, points: donePayload.points || 0 })
    // Reopen so the new stream appears in the list, timeline, and viewer.
    await openRecording(playback.path)
}

function cancelAggregate(streamName) {
    if (!activeAggregate || (streamName && activeAggregate.stream !== streamName)) { return }
    activeAggregate.cancelled = true
    try {
        activeAggregate.child.kill("SIGTERM")
    } catch { /* already exited */ }
}

// ── app bus ─────────────────────────────────────────────────────────────────
dimApp.onReceive(async (kind, payload) => {
    if (kind === "hello") {
        dimApp.send("recordings", { recordings: await listRecordings(), recent: await recentRecordings() })
        if (playback.path) {
            dimApp.send("loaded", {
                path: playback.path,
                name: playback.path.split("/").pop(),
                streams: playback.streamNames.map((name) => ({ name })),
                t0: playback.t0,
                t1: playback.t1,
                duration: playback.t1 - playback.t0,
            })
            // A webview refresh reconnects to this still-running backend with an empty
            // scene. Rebuild the frame at the current playhead (clouds/image/tf/odom +
            // the timestamp) so the reloaded page shows exactly what was on screen —
            // no play/pause nudge needed.
            if (playback.staticCloud) {
                replayStaticCloud()
                sendTime()
            } else {
                seekTo(playback.playhead)
            }
        }
    } else if (kind === "list") {
        dimApp.send("recordings", { recordings: await listRecordings(), recent: await recentRecordings() })
    } else if (kind === "open") {
        await openRecording(payload?.path || payload?.name || "")
    } else if (kind === "listDir") {
        const dir = payload?.dir
        try {
            dimApp.send("dirListing", await listDir(dir))
        } catch (err) {
            dimApp.send("dirListing", { dir: dir || "", parent: null, dirs: [], files: [], error: String(err?.message || err) })
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
    } else if (kind === "aggregate") {
        if (payload?.stream) {
            await aggregateStream(String(payload.stream), { carve: !!payload.carve, outlier: !!payload.outlier, carveHeight: Number(payload.carveHeight) })
        }
    } else if (kind === "aggregateCancel") {
        cancelAggregate(payload?.stream ? String(payload.stream) : null)
    } else if (kind === "close") {
        closeRecording()
    }
})
