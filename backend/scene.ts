// The 3D scene stream (api/scene/ws): the frames a page draws, as the playhead reaches them. JSON frames go as text
// (`{ k: kind, ...payload }`); frames carrying bytes (clouds, paths, images) go binary: a little-endian u32 header length,
// the JSON header, then the raw bytes. A page that connects gets the scene at the current playhead replayed to it alone.

export type SceneSink = {
    send(kind: string, payload: Record<string, unknown>): void
    sendBytes(kind: string, bytes: Uint8Array, meta: Record<string, unknown>): void
}

const encoder = new TextEncoder()

function binaryFrame(kind: string, bytes: Uint8Array, meta: Record<string, unknown>): Uint8Array {
    const header = encoder.encode(JSON.stringify({ k: kind, ...meta }))
    const out = new Uint8Array(4 + header.length + bytes.length)
    new DataView(out.buffer).setUint32(0, header.length, true)
    out.set(header, 4)
    out.set(bytes, 4 + header.length)
    return out
}

function sinkFor(sockets: () => Iterable<WebSocket>): SceneSink {
    return {
        send(kind, payload) {
            const text = JSON.stringify({ k: kind, ...payload })
            for (const ws of sockets()) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(text)
                }
            }
        },
        sendBytes(kind, bytes, meta) {
            let frame: Uint8Array | null = null
            for (const ws of sockets()) {
                if (ws.readyState === WebSocket.OPEN) {
                    frame ??= binaryFrame(kind, bytes, meta)
                    ws.send(frame)
                }
            }
        },
    }
}

const viewers = new Set<WebSocket>()

/** Every open page. */
export const everyViewer: SceneSink = sinkFor(() => viewers)

/** Upgrades to the scene socket; `replay(sink)` draws the current scene for the new page only. */
export function sceneSocket(request: Request, replay: (sink: SceneSink) => void): Response {
    const { socket, response } = Deno.upgradeWebSocket(request)
    socket.binaryType = "arraybuffer"
    socket.onopen = () => {
        viewers.add(socket)
        replay(sinkFor(() => [socket]))
    }
    socket.onclose = () => viewers.delete(socket)
    return response
}

/** A sink that records what it was sent (tests). */
export function recordingSink(): SceneSink & { frames: { kind: string; payload: Record<string, unknown> }[] } {
    const frames: { kind: string; payload: Record<string, unknown> }[] = []
    return {
        frames,
        send: (kind, payload) => frames.push({ kind, payload }),
        sendBytes: (kind, bytes, meta) => frames.push({ kind, payload: { ...meta, bytes } }),
    }
}
