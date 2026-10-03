// Playback of one recording at a time: a dimos memory2 .db (SQLite), an .mcap, or a bare .pc2.lcm map. Opening builds
// one merged, time-sorted timeline from the small (id, ts) columns / the mcap message index into typed arrays (~13 bytes
// a row, so a multi-million-row recording fits); blobs are read off disk and decoded only when the playhead reaches them,
// so a 30 GB recording never loads into memory. Frames go to the pages through a SceneSink (scene.ts).
// deno-lint-ignore-file no-explicit-any
import { DatabaseSync } from "node:sqlite"
import { HttpError } from "./http.ts"
import type { SceneSink } from "./scene.ts"
import {
    AGG_RENDER_CAP,
    decodableCodec,
    decodeBlob,
    frameForMessage,
    frameId,
    type Kind,
    KIND_CODES,
    KIND_NAMES,
    kindOfMessage,
    kindOfType,
    parseCloud,
} from "./decode.ts"

export const STATIC_CLOUD_SUFFIX = ".pc2.lcm"
export const isRecordingFile = (name: string) =>
    name.endsWith(".db") || name.endsWith(".mcap") || name.endsWith(STATIC_CLOUD_SUFFIX)

export type StreamSummary = { name: string; type: string; kind: Kind | null; rows: number; codec?: string }
export type Recording = {
    path: string
    name: string
    format: "db" | "mcap" | "pc2.lcm"
    streams: StreamSummary[]
    t0: number
    t1: number
    duration: number
}
export type TfReport = {
    hasTf: boolean
    treeLines: { prefix: string; frame: string; note: string; problem: boolean }[]
    problems: { stream: string; frame: string; reason: string; detail: string }[]
    codecProblems?: { stream: string; detail: string }[]
}

// Frames already in world coordinates (a tf root or a conventional global name): no tf chain needed to place them.
const GLOBAL_FRAME_NAMES = /^(world|map|odom|earth|global)$/i
const ODOM_SEEK_CAP = 4000 // max odom trail points re-emitted per stream on seek
const CLOUD_SEEK_CAP = 240 // max cloud frames re-emitted per stream on seek (bounds cost)

type TfSource = { tfMessages(streamName: string): Iterable<any>; frameOf(streamName: string): string }
type Timeline = { ts: Float64Array; id: Int32Array; chunk: Int32Array; stream: Int32Array; kind: Uint8Array }
type ActiveStream = { name: string; kind: Kind; kindCode: number; count: number; channelId?: number }

/** Every renderable stream whose frame can't be resolved to one world root, plus the tf forest drawn as a tree. */
export function buildTfReport(source: TfSource, summary: StreamSummary[], active: ActiveStream[]): TfReport {
    const childParents = new Map<string, Set<string>>()
    const parentChildren = new Map<string, Set<string>>()
    const addEdge = (parent: string, child: string) => {
        if (!parent || !child || parent === child) {
            return
        }
        if (!childParents.has(child)) {
            childParents.set(child, new Set())
        }
        childParents.get(child)!.add(parent)
        if (!parentChildren.has(parent)) {
            parentChildren.set(parent, new Set())
        }
        parentChildren.get(parent)!.add(child)
    }
    const tfNames = summary.filter((stream) => stream.kind === "tf" && stream.rows).map((stream) => stream.name)
    for (const tfName of tfNames) {
        for (const message of source.tfMessages(tfName)) {
            for (const transform of message?.transforms || []) {
                addEdge(transform?.header?.frame_id || "", transform?.child_frame_id || "")
            }
        }
    }
    const allFrames = new Set<string>()
    for (const [child, parents] of childParents) {
        allFrames.add(child)
        for (const parent of parents) {
            allFrames.add(parent)
        }
    }
    const isRoot = (frame: string) => allFrames.has(frame) && !childParents.has(frame)
    const isGlobal = (frame: string) => GLOBAL_FRAME_NAMES.test(frame) || isRoot(frame)

    const problems: TfReport["problems"] = []
    const problemFrames = new Set<string>()
    for (const stream of active) {
        if (stream.kind !== "cloud" && stream.kind !== "odom" && stream.kind !== "path") {
            continue
        }
        const frame = source.frameOf(stream.name)
        if (!frame) {
            continue // frameless pose/detection streams are drawn as loose markers, not a tf failure
        }
        const parents = childParents.get(frame)
        let reason = ""
        let detail = ""
        if (!parents) {
            if (!isGlobal(frame)) {
                reason = "no-tf"
                detail =
                    `no transform found for "${frame}" — it never shows up in tf, so the viewer has nowhere to put it`
            }
        } else if (parents.size > 1) {
            reason = "ambiguous"
            detail = `"${frame}" is attached to ${parents.size} parents (${
                [...parents].sort().join(", ")
            }) — the viewer can't tell which one is the real map, so the cloud can land in the wrong place`
        } else {
            let current = frame
            let reachedRoot = false
            const seen = new Set<string>()
            for (let guard = 0; current && guard < 64; guard++) {
                if (seen.has(current)) {
                    break // cycle
                }
                seen.add(current)
                const chainParents = childParents.get(current)
                if (!chainParents) {
                    reachedRoot = isGlobal(current)
                    break
                }
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

    // Each tree, like db_tree: a frame published under several parents shows up under each, making the conflict visible.
    const treeLines: TfReport["treeLines"] = []
    const renderChild = (frame: string, prefix: string, isLast: boolean, onPath: Set<string>) => {
        const cycle = onPath.has(frame)
        treeLines.push({
            prefix: prefix + (isLast ? "└── " : "├── "),
            frame,
            note: cycle ? "  (cycle)" : "",
            problem: problemFrames.has(frame),
        })
        if (cycle) {
            return
        }
        const kids = [...(parentChildren.get(frame) || [])].sort()
        const childPrefix = prefix + (isLast ? "    " : "│   ")
        const nextPath = new Set(onPath).add(frame)
        kids.forEach((kid, index) => renderChild(kid, childPrefix, index === kids.length - 1, nextPath))
    }
    for (const root of [...allFrames].filter((frame) => !childParents.has(frame)).sort()) {
        treeLines.push({ prefix: "", frame: root, note: "", problem: problemFrames.has(root) })
        const kids = [...(parentChildren.get(root) || [])].sort()
        kids.forEach((kid, index) => renderChild(kid, "", index === kids.length - 1, new Set([root])))
    }
    return { hasTf: tfNames.length > 0, treeLines, problems }
}

// ── .mcap ──
// The same messages as a .db, CDR-encoded against ros2msg schemas in compressed chunks. Its summary indexes every
// message by (chunk, offset) without touching a payload, so the timeline is built from the index; one chunk is
// decompressed (a few cached) when the playhead reaches a message in it. Loaded on first use.
let mcapDeps: any = null
async function loadMcapDeps() {
    if (!mcapDeps) {
        const [core, support, rosmsg, cdr] = await Promise.all([
            import("@mcap/core"),
            import("@mcap/support"),
            import("@foxglove/rosmsg"),
            import("@foxglove/rosmsg2-serialization"),
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
const MCAP_CHUNK_CACHE = 6

function readAtSync(file: Deno.FsFile, offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length)
    file.seekSync(offset, Deno.SeekMode.Start)
    let filled = 0
    while (filled < length) {
        const read = file.readSync(out.subarray(filled))
        if (!read) {
            break
        }
        filled += read
    }
    return filled === length ? out : out.subarray(0, filled)
}

// Every message in one chunk as (channel, log time, offset into the decompressed records), from the message-index
// records right after the chunk: building a timeline never decompresses.
function forEachIndexedMessage(
    file: Deno.FsFile,
    chunkIndex: any,
    onMessage: (channel: number, logTime: number, offset: number) => void,
) {
    const bytes = readAtSync(
        file,
        Number(chunkIndex.chunkStartOffset + chunkIndex.chunkLength),
        Number(chunkIndex.messageIndexLength),
    )
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let at = 0
    while (at + 9 <= bytes.byteLength) {
        const recordLength = Number(view.getBigUint64(at + 1, true))
        if (view.getUint8(at) === MCAP_OP_MESSAGE_INDEX) {
            const channelId = view.getUint16(at + 9, true)
            const arrayLength = view.getUint32(at + 11, true)
            for (let cursor = at + 15; cursor + 16 <= at + 15 + arrayLength; cursor += 16) {
                onMessage(
                    channelId,
                    Number(view.getBigUint64(cursor, true)),
                    Number(view.getBigUint64(cursor + 8, true)),
                )
            }
        }
        at += 9 + recordLength
    }
}

type Mcap = { file: Deno.FsFile; chunkIndexes: any[]; readers: Map<number, any>; chunkCache: Map<number, Uint8Array> }

function chunkRecords(mcap: Mcap, chunkNumber: number): Uint8Array {
    const cached = mcap.chunkCache.get(chunkNumber)
    if (cached) {
        mcap.chunkCache.delete(chunkNumber) // reinsert: move it to the young end
        mcap.chunkCache.set(chunkNumber, cached)
        return cached
    }
    const chunkIndex = mcap.chunkIndexes[chunkNumber]
    const bytes = readAtSync(mcap.file, Number(chunkIndex.chunkStartOffset), Number(chunkIndex.chunkLength))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let cursor = 9 + 8 + 8 + 8 + 4 // record header, message start/end time, uncompressed size, crc
    const nameLength = view.getUint32(cursor, true)
    cursor += 4
    const compression = new TextDecoder().decode(bytes.subarray(cursor, cursor + nameLength))
    cursor += nameLength
    const payloadLength = Number(view.getBigUint64(cursor, true))
    cursor += 8
    const payload = bytes.subarray(cursor, cursor + payloadLength)
    const records = compression
        ? mcapDeps.decompressHandlers[compression](payload, chunkIndex.uncompressedSize)
        : payload
    mcap.chunkCache.set(chunkNumber, records)
    if (mcap.chunkCache.size > MCAP_CHUNK_CACHE) {
        mcap.chunkCache.delete(mcap.chunkCache.keys().next().value!)
    }
    return records
}

function decodeMcapMessage(mcap: Mcap, chunkNumber: number, offset: number): any {
    let records: Uint8Array
    try {
        records = chunkRecords(mcap, chunkNumber)
    } catch {
        return null // unsupported compression / truncated chunk
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
    const dataStart = offset + 9 + 2 + 4 + 8 + 8 // channel id, sequence, log time, publish time
    try {
        return reader.readMessage(records.subarray(dataStart, offset + 9 + recordLength))
    } catch {
        return null
    }
}

// ROS2 topics are "/name" (dimos publishes "rt/name"); memory2 flattens both the same way, so an mcap and its .db
// sibling agree on stream names.
const streamNameForTopic = (topic: string) => topic.replace(/^\/+/, "").replace(/^rt\//, "").replace(/\//g, "_")

/** Thins a cursor list to at most `cap`, always keeping the last (the current pose stays exact). */
function subsampleCursors(cursors: number[], cap: number): number[] {
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

export class Playback {
    recording: Recording | null = null
    tfReport: TfReport | null = null
    playing = false
    speed = 1
    playhead = 0
    /** stream name → "latest" | "all" | window seconds, for clouds and odometry */
    accumulation: (stream: string, kind: Kind) => string = (_stream, kind) => kind === "odom" ? "all" : "latest"
    /** told when play state changes on its own (reaching the end) */
    onStateChange: () => void = () => {}

    #db: DatabaseSync | null = null
    #mcap: Mcap | null = null
    #streamNames: string[] = []
    #blobStatements: any[] = []
    #count = 0
    #tsArray: Float64Array = new Float64Array(0)
    #idArray: Int32Array = new Int32Array(0) // .db: blob row id; .mcap: the message's byte offset in its chunk
    #chunkArray: Int32Array = new Int32Array(0) // .mcap: the chunk holding each message
    #streamArray: Int32Array = new Int32Array(0)
    #kindArray: Uint8Array = new Uint8Array(0)
    #order: Uint32Array = new Uint32Array(0) // indices into the above, sorted by ts
    #t0 = 0
    #t1 = 0
    #cursor = 0
    #timer: number | null = null
    #lastTick = 0
    #staticCloud: Record<string, any> | null = null

    constructor(public sink: SceneSink) {}

    get isDb() {
        return !!this.#db
    }

    close() {
        if (this.#timer !== null) {
            clearInterval(this.#timer)
            this.#timer = null
        }
        try {
            this.#db?.close()
        } catch { /* already closed */ }
        try {
            this.#mcap?.file.close()
        } catch { /* already closed */ }
        this.#db = null
        this.#mcap = null
        this.recording = null
        this.tfReport = null
        this.#streamNames = []
        this.#blobStatements = []
        this.#count = 0
        this.#tsArray = new Float64Array(0)
        this.#idArray = new Int32Array(0)
        this.#chunkArray = new Int32Array(0)
        this.#streamArray = new Int32Array(0)
        this.#kindArray = new Uint8Array(0)
        this.#order = new Uint32Array(0)
        this.#cursor = 0
        this.playhead = 0
        this.playing = false
        this.#staticCloud = null
    }

    /** Opens a recording by absolute path, replacing the open one. */
    async open(path: string): Promise<Recording> {
        if (path.endsWith(STATIC_CLOUD_SUFFIX)) {
            await this.#openStaticCloud(path)
        } else if (path.endsWith(".mcap")) {
            await this.#openMcap(path)
        } else if (path.endsWith(".db")) {
            this.#openDb(path)
        } else {
            throw new HttpError(400, `${path} isn't a .db, .mcap or .pc2.lcm recording`)
        }
        return this.recording!
    }

    async #openStaticCloud(path: string) {
        let message
        try {
            message = decodeBlob(await Deno.readFile(path))
        } catch (error) {
            throw new HttpError(400, `Failed to read ${path}: ${(error as Error).message}`)
        }
        const cloud = parseCloud(message, AGG_RENDER_CAP)
        if (!cloud) {
            throw new HttpError(400, `${path} is not a PointCloud2 (no x/y/z fields)`)
        }
        this.close()
        const name = path.split("/").pop()!
        const stream = name.slice(0, -STATIC_CLOUD_SUFFIX.length)
        const stamp = message.header?.stamp
        const ts = stamp ? stamp.sec + (stamp.nsec || 0) / 1e9 : 0
        this.#streamNames = [stream]
        this.#t0 = this.#t1 = this.playhead = ts
        this.#staticCloud = { stream, frame: frameId(message), n: cloud.n, bytes: cloud.bytes, ts }
        this.recording = {
            path,
            name,
            format: "pc2.lcm",
            streams: [{ name: stream, type: "PointCloud2", kind: "cloud", rows: 1 }],
            t0: ts,
            t1: ts,
            duration: 0,
        }
        this.tfReport = { hasTf: false, treeLines: [], problems: [] }
        this.replay(this.sink)
    }

    async #openMcap(path: string) {
        let deps
        try {
            deps = await loadMcapDeps()
        } catch (error) {
            throw new HttpError(500, `Could not load the mcap reader: ${(error as Error).message}`)
        }
        let file: Deno.FsFile | undefined
        let reader
        try {
            file = Deno.openSync(path, { read: true })
            const opened = file
            const size = BigInt(Deno.statSync(path).size)
            reader = await deps.McapIndexedReader.Initialize({
                readable: {
                    size: () => Promise.resolve(size),
                    read: (offset: bigint, length: bigint) =>
                        Promise.resolve(readAtSync(opened, Number(offset), Number(length))),
                },
                decompressHandlers: deps.decompressHandlers,
            })
        } catch (error) {
            try {
                file?.close()
            } catch { /* never opened */ }
            throw new HttpError(400, `Failed to open ${path}: ${(error as Error).message}`)
        }
        this.close()
        // Pass 1: a stream per channel; counts from the summary statistics, else off the message indexes.
        const counts = new Map<number, number>()
        for (const [channelId, count] of reader.statistics?.channelMessageCounts ?? []) {
            counts.set(channelId, Number(count))
        }
        if (!counts.size) {
            for (const chunkIndex of reader.chunkIndexes) {
                forEachIndexedMessage(
                    file!,
                    chunkIndex,
                    (channelId) => counts.set(channelId, (counts.get(channelId) ?? 0) + 1),
                )
            }
        }
        const summary: StreamSummary[] = []
        const active: ActiveStream[] = []
        const readers = new Map<number, any>()
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
                readers.set(
                    channelId,
                    new deps.MessageReader(deps.parseSchema(new TextDecoder().decode(schema.data), { ros2: true })),
                )
            } catch {
                continue // a schema we can't parse: the stream is listed, it just never decodes
            }
            active.push({ name, kind, kindCode: KIND_CODES[kind], count, channelId })
        }
        // Pass 2: the timeline, from the message indexes (no payload touched).
        const total = active.reduce((sum, stream) => sum + stream.count, 0)
        const arrays = this.#allocate(total)
        const streamOfChannel = new Map(active.map((stream, streamIndex) => [stream.channelId!, streamIndex]))
        let write = 0
        for (let chunkNumber = 0; chunkNumber < reader.chunkIndexes.length; chunkNumber++) {
            forEachIndexedMessage(file!, reader.chunkIndexes[chunkNumber], (channelId, logTime, offset) => {
                const streamIndex = streamOfChannel.get(channelId)
                if (streamIndex === undefined || write >= total) {
                    return
                }
                arrays.ts[write] = logTime / 1e9
                arrays.id[write] = offset
                arrays.chunk[write] = chunkNumber
                arrays.stream[write] = streamIndex
                arrays.kind[write] = active[streamIndex].kindCode
                write++
            })
        }
        this.#mcap = { file: file!, chunkIndexes: reader.chunkIndexes, readers, chunkCache: new Map() }
        this.#finishOpen(path, "mcap", summary, active, arrays, write)
        try {
            this.tfReport = buildTfReport(this.#mcapTfSource(), summary, active)
        } catch (error) {
            console.error("tf report failed:", (error as Error).message)
        }
    }

    #openDb(path: string) {
        let db: DatabaseSync
        try {
            db = new DatabaseSync(path, { readOnly: true })
        } catch (error) {
            throw new HttpError(400, `Failed to open ${path}: ${(error as Error).message}`)
        }
        let streamRows: any[]
        try {
            streamRows = db.prepare("SELECT name, config FROM _streams").all()
        } catch {
            db.close()
            throw new HttpError(400, `${path} is not a dimos recording (no _streams table)`)
        }
        this.close()
        // Pass 1: stream metadata + row counts (to size the typed arrays).
        const summary: StreamSummary[] = []
        const active: ActiveStream[] = []
        const codecProblems: { stream: string; detail: string }[] = []
        let total = 0
        for (const row of streamRows) {
            let config: any
            try {
                config = JSON.parse(row.config)
            } catch {
                config = {}
            }
            const typeName = config.payload_module?.split(".").pop() ?? "unknown"
            const kind = kindOfType(typeName)
            const codec = config.codec_id || "lcm"
            const count = Number((db.prepare(`SELECT COUNT(*) AS c FROM "${row.name}"`).get() as any).c)
            summary.push({ name: row.name, type: typeName, kind, rows: count, codec })
            const hasBlob =
                db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`${row.name}_blob`) != null
            if (kind && count && hasBlob && !decodableCodec(codec)) {
                // say so, rather than a stream silently missing from the panel
                codecProblems.push({
                    stream: row.name,
                    detail: ` — stored with the "${codec}" codec, which this viewer can't read`,
                })
            } else if (kind && count && hasBlob) {
                active.push({ name: row.name, kind, kindCode: KIND_CODES[kind], count })
                total += count
            }
        }
        // Pass 2: the timeline (only the small id/ts columns load; blobs stay on disk). node:sqlite's row iterator
        // segfaults on large tables, so each stream's columns come in with .all() and are copied out.
        const arrays = this.#allocate(total)
        let write = 0
        for (let streamIndex = 0; streamIndex < active.length; streamIndex++) {
            const stream = active[streamIndex]
            this.#blobStatements.push(db.prepare(`SELECT data FROM "${stream.name}_blob" WHERE id=?`))
            for (const record of db.prepare(`SELECT id, ts FROM "${stream.name}"`).all() as any[]) {
                arrays.ts[write] = record.ts
                arrays.id[write] = record.id
                arrays.stream[write] = streamIndex
                arrays.kind[write] = stream.kindCode
                write++
            }
        }
        this.#db = db
        this.#finishOpen(path, "db", summary, active, arrays, write)
        try {
            this.tfReport = { ...buildTfReport(this.#sqliteTfSource(db), summary, active), codecProblems }
        } catch (error) {
            console.error("tf report failed:", (error as Error).message)
        }
    }

    #allocate(total: number): Timeline {
        return {
            ts: new Float64Array(total),
            id: new Int32Array(total),
            chunk: new Int32Array(total),
            stream: new Int32Array(total),
            kind: new Uint8Array(total),
        }
    }

    #finishOpen(
        path: string,
        format: Recording["format"],
        summary: StreamSummary[],
        active: ActiveStream[],
        arrays: Timeline,
        count: number,
    ) {
        const order = new Uint32Array(count)
        for (let i = 0; i < count; i++) {
            order[i] = i
        }
        order.sort((a, b) => arrays.ts[a] - arrays.ts[b])
        this.#streamNames = active.map((stream) => stream.name)
        this.#count = count
        this.#tsArray = arrays.ts
        this.#idArray = arrays.id
        this.#chunkArray = arrays.chunk
        this.#streamArray = arrays.stream
        this.#kindArray = arrays.kind
        this.#order = order
        this.#t0 = count ? arrays.ts[order[0]] : 0
        this.#t1 = count ? arrays.ts[order[count - 1]] : 0
        this.#cursor = 0
        this.playhead = this.#t0
        this.recording = {
            path,
            name: path.split("/").pop()!,
            format,
            streams: summary,
            t0: this.#t0,
            t1: this.#t1,
            duration: this.#t1 - this.#t0,
        }
        this.sink.send("loaded", { path, name: this.recording.name }) // in-band, so a page clears before this file's frames
        this.seek(this.#openingPlayhead()) // render the opening frame, paused
    }

    #sqliteTfSource(db: DatabaseSync): TfSource {
        return {
            *tfMessages(streamName) {
                let ids: number[]
                try {
                    ids = (db.prepare(`SELECT id FROM "${streamName}"`).all() as any[]).map((record) => record.id)
                } catch {
                    return
                }
                // a frame under two parents only shows if edges come from across the recording: sample evenly
                const step = Math.max(1, Math.floor(ids.length / 4000))
                const blobStatement = db.prepare(`SELECT data FROM "${streamName}_blob" WHERE id=?`)
                for (let i = 0; i < ids.length; i += step) {
                    const row = blobStatement.get(ids[i]) as any
                    if (!row?.data) {
                        continue
                    }
                    try {
                        yield decodeBlob(row.data)
                    } catch { /* undecodable: skip */ }
                }
            },
            frameOf(streamName) {
                try {
                    const row = db.prepare(`SELECT data FROM "${streamName}_blob" LIMIT 1`).get() as any
                    if (row?.data) {
                        return frameId(decodeBlob(row.data))
                    }
                } catch { /* undecodable / no blob: unknown frame */ }
                return ""
            },
        }
    }

    #mcapTfSource(): TfSource {
        const cursorsFor = (streamName: string) => {
            const streamIndex = this.#streamNames.indexOf(streamName)
            const cursors = []
            for (let cursor = 0; cursor < this.#count; cursor++) {
                if (this.#streamArray[this.#order[cursor]] === streamIndex) {
                    cursors.push(cursor)
                }
            }
            return cursors
        }
        const decodeAt = (cursor: number) => this.#decodeAt(cursor)
        return {
            *tfMessages(streamName) {
                // far smaller sample than the .db: every sample lands in a different chunk to decompress
                const cursors = cursorsFor(streamName)
                const step = Math.max(1, Math.floor(cursors.length / 240))
                for (let i = 0; i < cursors.length; i += step) {
                    const message = decodeAt(cursors[i])
                    if (message) {
                        yield message
                    }
                }
            },
            frameOf(streamName) {
                const cursors = cursorsFor(streamName)
                return cursors.length ? frameId(decodeAt(cursors[0])) : ""
            },
        }
    }

    #decodeAt(sortedCursor: number): any {
        const index = this.#order[sortedCursor]
        if (this.#mcap) {
            return decodeMcapMessage(this.#mcap, this.#chunkArray[index], this.#idArray[index])
        }
        const statement = this.#blobStatements[this.#streamArray[index]]
        const row = statement?.get(this.#idArray[index])
        if (!row?.data) {
            return null
        }
        try {
            return decodeBlob(row.data)
        } catch {
            return null
        }
    }

    #emitAt(sortedCursor: number, sink: SceneSink) {
        const message = this.#decodeAt(sortedCursor)
        if (!message) {
            return
        }
        const index = this.#order[sortedCursor]
        const streamName = this.#streamNames[this.#streamArray[index]]
        const kind = KIND_NAMES[this.#kindArray[index]] || kindOfMessage(message)
        const frame = frameForMessage(streamName, kind, message)
        if (!frame) {
            return
        }
        // clouds and odometry carry their timeline ts so the page can accumulate within a time window
        if (frame[0] === "cloud" || frame[0] === "odom") {
            frame[1].ts = this.#tsArray[index]
        }
        const { bytes, ...meta } = frame[1]
        if (bytes) {
            sink.sendBytes(frame[0], bytes, meta)
        } else {
            sink.send(frame[0], frame[1])
        }
    }

    /** The playhead, as the scene stream's clock message. */
    time() {
        return {
            t: this.playhead,
            t0: this.#t0,
            t1: this.#t1,
            playing: this.playing,
            speed: this.speed,
            atEnd: this.#cursor >= this.#count,
        }
    }

    #sendTime(sink: SceneSink) {
        sink.send("time", this.time())
    }

    // t0 is the single earliest message, so seeking there shows one message on an empty scene. Open instead at the first
    // moment every render kind has appeared (waiting for every *stream* would be dragged deep in by sparse ones).
    #openingPlayhead(): number {
        const present = new Set<number>()
        for (let index = 0; index < this.#count; index++) {
            present.add(this.#kindArray[index])
        }
        const seen = new Set<number>()
        let cursor = 0
        while (cursor < this.#count && seen.size < present.size) {
            seen.add(this.#kindArray[this.#order[cursor]])
            cursor++
        }
        return this.#tsArray[this.#order[Math.max(0, cursor - 1)]] ?? 0
    }

    #advanceTo(targetTs: number) {
        while (this.#cursor < this.#count && this.#tsArray[this.#order[this.#cursor]] <= targetTs) {
            this.#emitAt(this.#cursor, this.sink)
            this.#cursor++
        }
        this.playhead = targetTs
        this.#sendTime(this.sink)
    }

    #tick() {
        if (!this.playing || !this.#count) {
            return
        }
        const now = performance.now()
        const elapsed = (now - this.#lastTick) / 1000
        this.#lastTick = now
        this.#advanceTo(Math.min(this.#t1, this.playhead + elapsed * this.speed))
        if (this.#cursor >= this.#count) {
            this.pause()
            this.onStateChange()
        }
    }

    play() {
        if (!this.recording) {
            throw new HttpError(409, "No recording is open (POST api/open first)")
        }
        if (!this.#count) {
            return // a static map has no timeline
        }
        if (this.#cursor >= this.#count) {
            this.seek(this.#t0)
        }
        this.playing = true
        this.#lastTick = performance.now()
        this.#timer ??= setInterval(() => this.#tick(), 33)
        this.#sendTime(this.sink)
    }

    pause() {
        this.playing = false
        if (this.#timer !== null) {
            clearInterval(this.#timer)
            this.#timer = null
        }
        this.#sendTime(this.sink)
    }

    // A seek resets the scene and replays from the start, thinned: clouds by each stream's accumulation policy, images
    // to the latest per stream, odometry subsampled. The survivors go out in timeline order, interleaved with tf, so the
    // page bakes each cloud with the transform current at ITS timestamp (else every accumulated cloud would land on
    // the final pose and pile onto itself).
    seek(targetTs: number, sink: SceneSink = this.sink) {
        if (this.#staticCloud) {
            this.replay(sink, false)
            return
        }
        if (!this.#count) {
            return
        }
        const clamped = Math.max(this.#t0, Math.min(this.#t1, targetTs))
        sink.send("reset", {})
        const cloudCursors = new Map<number, number[]>()
        const odomCursors = new Map<number, number[]>()
        const latestImage = new Map<number, number>()
        const bucket = (map: Map<number, number[]>, streamIndex: number, cursor: number) => {
            let list = map.get(streamIndex)
            if (!list) {
                list = []
                map.set(streamIndex, list)
            }
            list.push(cursor)
        }
        let scan = 0
        while (scan < this.#count && this.#tsArray[this.#order[scan]] <= clamped) {
            const index = this.#order[scan]
            const kind = this.#kindArray[index]
            const streamIndex = this.#streamArray[index]
            if (kind === KIND_CODES.cloud) {
                bucket(cloudCursors, streamIndex, scan)
            } else if (kind === KIND_CODES.odom) {
                bucket(odomCursors, streamIndex, scan)
            } else if (kind === KIND_CODES.image) {
                latestImage.set(streamIndex, scan)
            }
            scan++
        }
        const keep = new Set<number>()
        for (const [streamIndex, cursors] of cloudCursors) {
            for (const cursor of this.#selectCloudCursors(streamIndex, cursors, clamped)) {
                keep.add(cursor)
            }
        }
        for (const cursors of odomCursors.values()) {
            for (const cursor of subsampleCursors(cursors, ODOM_SEEK_CAP)) {
                keep.add(cursor)
            }
        }
        for (const cursor of latestImage.values()) {
            keep.add(cursor)
        }
        // tf between two kept frames is coalesced (newest per child) into one message flushed right before the frame
        const pendingTf = new Map<string, { parent: string; t: number[]; q: number[] }>()
        const flushTf = () => {
            if (!pendingTf.size) {
                return
            }
            sink.send("tf", {
                transforms: [...pendingTf].map(([child, edge]) => ({
                    parent: edge.parent,
                    child,
                    t: edge.t,
                    q: edge.q,
                })),
            })
            pendingTf.clear()
        }
        let cursor = 0
        while (cursor < this.#count && this.#tsArray[this.#order[cursor]] <= clamped) {
            const kind = this.#kindArray[this.#order[cursor]]
            if (kind === KIND_CODES.tf) {
                const message = this.#decodeAt(cursor)
                for (const transform of message?.transforms ?? []) {
                    if (!transform.transform) {
                        continue
                    }
                    const translation = transform.transform.translation
                    const rotation = transform.transform.rotation
                    pendingTf.set(transform.child_frame_id || "", {
                        parent: transform?.header?.frame_id || "",
                        t: [translation.x, translation.y, translation.z],
                        q: [rotation.x, rotation.y, rotation.z, rotation.w],
                    })
                }
            } else if (kind === KIND_CODES.path || keep.has(cursor)) {
                flushTf()
                this.#emitAt(cursor, sink)
            }
            cursor++
        }
        flushTf()
        this.#cursor = cursor
        this.playhead = clamped
        this.#sendTime(sink)
    }

    #selectCloudCursors(streamIndex: number, cursors: number[], clamped: number): number[] {
        if (!cursors.length) {
            return cursors
        }
        const mode = this.accumulation(this.#streamNames[streamIndex], "cloud")
        if (mode === "latest") {
            return [cursors[cursors.length - 1]]
        }
        if (mode === "all") {
            return cursors.slice(-CLOUD_SEEK_CAP)
        }
        const windowSeconds = Number(mode)
        if (!isFinite(windowSeconds) || windowSeconds <= 0) {
            return [cursors[cursors.length - 1]]
        }
        const cutoff = clamped - windowSeconds
        return cursors.filter((cursor) => this.#tsArray[this.#order[cursor]] >= cutoff).slice(-CLOUD_SEEK_CAP)
    }

    /** Draws the current scene for a (new) page: the scene at the playhead. */
    replay(sink: SceneSink, announce = true) {
        if (this.recording && announce) {
            sink.send("loaded", { path: this.recording.path, name: this.recording.name })
        }
        if (this.#staticCloud) {
            sink.send("reset", {})
            const { bytes, ...meta } = this.#staticCloud
            sink.sendBytes("cloud", bytes, meta)
            this.#sendTime(sink)
        } else if (this.recording) {
            this.seek(this.playhead, sink)
        } else {
            sink.send("reset", {})
            this.#sendTime(sink)
        }
    }

    /** The raw blob of a .db stream's first message (an aggregated map is one message). */
    firstBlob(stream: string): Uint8Array | null {
        if (!this.#db) {
            return null
        }
        try {
            const row = this.#db.prepare(`SELECT data FROM "${stream}_blob" ORDER BY id LIMIT 1`).get() as any
            return row?.data ? new Uint8Array(row.data) : null
        } catch {
            return null
        }
    }
}
