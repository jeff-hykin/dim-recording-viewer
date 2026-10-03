// Messages → the compact frames the 3D page draws (cloud / odom / tf / path / image), shared by .db, .mcap and .pc2.lcm.
// deno-lint-ignore-file no-explicit-any
import { decode } from "@dimos/msgs"
// @ts-types="./lz4js.d.ts"
import lz4 from "lz4js"

export const MAX_PTS = 24000 // per-cloud downsample cap (matches the live viewer)
export const AGG_RENDER_CAP = 1_000_000 // an aggregated map is one static cloud: allow far more points

export type Kind = "cloud" | "odom" | "tf" | "path" | "image"
export const KIND_NAMES: Kind[] = ["cloud", "odom", "tf", "path", "image"]
export const KIND_CODES: Record<Kind, number> = { cloud: 0, odom: 1, tf: 2, path: 3, image: 4 }

export function asBytes(data: any): Uint8Array {
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

// _streams.config.codec_id names the codec chain outermost-first ("lcm", "jpeg", "lz4+lcm", "pickle"). Wrappers
// compress whatever the inner codec made; the base codec decides whether @dimos/msgs can read it at all.
const DECODABLE_BASE_CODECS = new Set(["lcm", "jpeg"])
export function decodableCodec(codecId: string): boolean {
    return DECODABLE_BASE_CODECS.has(String(codecId || "lcm").split("+").pop()!)
}

/** Strips an LZ4 frame if there is one (an LCM or JPEG payload never starts with its magic), then LCM-decodes. */
export function unwrapBlob(data: unknown): Uint8Array {
    const bytes = asBytes(data)
    if (bytes[0] === 0x04 && bytes[1] === 0x22 && bytes[2] === 0x4D && bytes[3] === 0x18) {
        return new Uint8Array(lz4.decompress(bytes))
    }
    return bytes
}

export function decodeBlob(data: unknown): any {
    return decode(unwrapBlob(data))
}

export function frameId(message: any): string {
    return message?.header?.frame_id || ""
}

// Odometry (pose.pose) and PoseStamped (pose) both show up as robot/pose streams.
function poseOf(message: any) {
    const wrapper = message?.pose
    return wrapper?.pose ?? wrapper ?? null
}

/** Render kind from the stored payload type. */
export function kindOfType(typeName: string): Kind | null {
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

/** Backup for streams whose type name wasn't recognized: duck-type the decoded message. */
export function kindOfMessage(message: any): Kind | null {
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
    if (
        message.width !== undefined && message.height !== undefined && message.encoding !== undefined &&
        message.data !== undefined
    ) {
        return "image"
    }
    return null
}

export function parseCloud(message: any, maxPts = MAX_PTS): { n: number; bytes: Uint8Array } | null {
    const fields = message.fields || []
    const fieldX = fields.find((field: any) => field.name === "x")
    const fieldY = fields.find((field: any) => field.name === "y")
    const fieldZ = fields.find((field: any) => field.name === "z")
    const step = message.point_step | 0
    if (!fieldX || !fieldY || !fieldZ || !step) {
        return null
    }
    const data = asBytes(message.data)
    // A truncated blob can claim more points than its bytes cover: clamp so no read runs past the buffer.
    const sizeOf = (field: any) => field.datatype === 8 ? 8 : 4
    const maxFieldEnd = Math.max(
        fieldX.offset + sizeOf(fieldX),
        fieldY.offset + sizeOf(fieldY),
        fieldZ.offset + sizeOf(fieldZ),
    )
    const total = Math.max(
        0,
        Math.min(Math.floor(data.byteLength / step), Math.floor((data.byteLength - maxFieldEnd) / step) + 1),
    )
    if (!total) {
        return null
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const littleEndian = !message.is_bigendian
    const read = (offset: number, datatype: number) =>
        datatype === 8 ? view.getFloat64(offset, littleEndian) : view.getFloat32(offset, littleEndian)
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

function parsePath(message: any): { n: number; bytes: Uint8Array } {
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

export type Frame = [string, Record<string, any>]

/** One decoded message → the page frame for its kind. */
export function frameForMessage(streamName: string, kind: Kind | null, message: any): Frame | null {
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
        const transforms = (message.transforms || []).filter((transform: any) => transform?.transform).map((
            transform: any,
        ) => ({
            parent: transform?.header?.frame_id || "",
            child: transform.child_frame_id || "",
            t: [
                transform.transform.translation.x,
                transform.transform.translation.y,
                transform.transform.translation.z,
            ],
            q: [
                transform.transform.rotation.x,
                transform.transform.rotation.y,
                transform.transform.rotation.z,
                transform.transform.rotation.w,
            ],
        }))
        if (transforms.length) {
            return ["tf", { transforms }]
        }
    } else if (kind === "path") {
        const path = parsePath(message)
        return ["path", { stream: streamName, frame: frameId(message), n: path.n, bytes: path.bytes }]
    } else if (kind === "image") {
        // A CompressedImage has `format` and no width; some recordings also store Image messages whose data is already
        // JPEG/PNG (codec "jpeg"): `encoding` names the codec. Both take the compressed path, else the page would draw
        // codec bytes as raw pixels.
        const encoding = String(message.encoding || "").toLowerCase()
        const isCompressedImage = message.format !== undefined && message.width === undefined
        const isEncodedBlob = encoding === "jpeg" || encoding === "jpg" || encoding === "png"
        if (isCompressedImage || isEncodedBlob) {
            const format = isCompressedImage
                ? String(message.format || "jpeg")
                : (encoding === "jpg" ? "jpeg" : encoding)
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
