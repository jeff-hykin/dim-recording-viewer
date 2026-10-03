// The backend's 3D frames (api/scene/ws, backend/scene.ts): text = JSON `{ k: kind, ...payload }`; binary = u32 header
// length (little-endian), the JSON header, then the frame's bytes. Reconnects with backoff; returns a stop function.
// deno-lint-ignore-file no-explicit-any
export function sceneStream(onFrame: (kind: string, payload: any, bytes: Uint8Array | null) => void): () => void {
    let socket: WebSocket | null = null
    let delay = 500
    let stopped = false
    const decoder = new TextDecoder()
    const open = () => {
        const url = new URL("api/scene/ws", location.href)
        url.protocol = url.protocol.replace("http", "ws")
        socket = new WebSocket(url)
        socket.binaryType = "arraybuffer"
        socket.onopen = () => (delay = 500)
        socket.onmessage = (message) => {
            try {
                if (typeof message.data === "string") {
                    const { k, ...payload } = JSON.parse(message.data)
                    onFrame(k, payload, null)
                } else {
                    const buffer = message.data as ArrayBuffer
                    const headerLength = new DataView(buffer).getUint32(0, true)
                    const { k, ...payload } = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, headerLength)))
                    // a fresh, 4-byte-aligned copy so Float32Array views of it are valid
                    onFrame(k, payload, new Uint8Array(buffer.slice(4 + headerLength)))
                }
            } catch (error) {
                console.error("scene frame failed:", error)
            }
        }
        socket.onclose = () => {
            if (!stopped) {
                setTimeout(open, delay)
                delay = Math.min(delay * 2, 10_000)
            }
        }
    }
    open()
    return () => {
        stopped = true
        socket?.close()
    }
}
