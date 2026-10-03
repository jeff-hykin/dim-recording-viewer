// dimos-app-server: this app's API and its built frontend on the unix socket Desktop gives (--socket), else a port.
// Desktop's flags: --socket --desktop-url --zenoh-web-url --zenoh-connect --dimos-dir --dimos-python (docs/apps.md);
// nix adds --mapper (the map builder binary) and --frontend.
import { eventsSocket, handle } from "./http.ts"
import { DESCRIPTION, onPageMessage, playback, routes } from "./routes.ts"
import { sceneSocket } from "./scene.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const frontend = flag("frontend") ?? new URL("../frontend/dist", import.meta.url).pathname
const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    json: "application/json",
    wasm: "application/wasm",
}

async function file(path: string): Promise<Response> {
    const clean = path.split("/").filter((part) => part && part !== "..").join("/") || "index.html"
    for (const candidate of [clean, "index.html"]) {
        try {
            const bytes = await Deno.readFile(`${frontend}/${candidate}`)
            const type = types[candidate.split(".").pop() ?? ""] ?? "application/octet-stream"
            return new Response(bytes, { headers: { "content-type": type } })
        } catch {
            // next candidate: unknown paths get the app (hash routing)
        }
    }
    return new Response("not found", { status: 404 })
}

async function serve(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/api/events/ws") {
        return eventsSocket(request, onPageMessage)
    }
    if (path === "/api/scene/ws") {
        return sceneSocket(request, (sink) => playback.replay(sink))
    }
    return (await handle(request, routes, DESCRIPTION)) ?? file(path)
}

const socket = flag("socket")
if (socket) {
    try {
        Deno.removeSync(socket)
    } catch {
        // not there
    }
    Deno.serve({ path: socket, transport: "unix", onListen: () => console.error(`listening on ${socket}`) }, serve)
} else {
    Deno.serve({ port: Number(flag("port") ?? 8787) }, serve)
}
