// The app's HTTP API: every user-facing action is a route here, so the UI and Desktop's agent drive the app the same
// way. `routes` is also served as agent.json (Desktop's agent finds the endpoints there; dimos.yaml repeats them, and
// `deno task check-endpoints` keeps the two in step). Docs: dimos-desktop docs/apps.md, docs/agent.md.

export type Params = Record<string, { type: string; description?: string; required?: boolean; items?: unknown }>

export type Route = {
    method: "GET" | "POST" | "PUT" | "DELETE"
    /** relative to the app, e.g. `api/scan`; `{name}` segments become params */
    path: string
    description: string
    params?: Params
    /** "view": what Desktop's screenshot() calls; "context": what desktop_context adds while the app is focused */
    role?: "view" | "context"
    handler: (args: Record<string, unknown>, request: Request) => unknown | Promise<unknown>
}

/** A readable error with an HTTP status: the UI and the agent both show `message`. */
export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

function match(route: Route, method: string, path: string): Record<string, string> | null {
    if (route.method !== method) {
        return null
    }
    const want = route.path.split("/")
    const got = path.split("/")
    if (want.length !== got.length) {
        return null
    }
    const params: Record<string, string> = {}
    for (let i = 0; i < want.length; i++) {
        const name = want[i].match(/^\{(.+)\}$/)?.[1]
        if (name) {
            params[name] = decodeURIComponent(got[i])
        } else if (want[i] !== got[i]) {
            return null
        }
    }
    return params
}

/** What agent.json / dimos.yaml say about the routes. */
export function describe(description: string, routes: Route[]) {
    return {
        description,
        endpoints: routes.map(({ method, path, description, params, role }) => ({
            method,
            path,
            description,
            ...(params ? { params } : {}),
            ...(role ? { role } : {}),
        })),
    }
}

/** Handles `/api/...` + `/agent.json`; null for anything else (the static frontend). */
export async function handle(request: Request, routes: Route[], description: string): Promise<Response | null> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/+/, "")
    if (path === "agent.json") {
        return Response.json(describe(description, routes))
    }
    for (const route of routes) {
        const pathParams = match(route, request.method, path)
        if (!pathParams) {
            continue
        }
        const args: Record<string, unknown> = { ...Object.fromEntries(url.searchParams), ...pathParams }
        if (request.method !== "GET" && request.method !== "DELETE") {
            const text = await request.text()
            if (text) {
                try {
                    Object.assign(args, JSON.parse(text))
                } catch {
                    return Response.json({ error: "the body isn't JSON" }, { status: 400 })
                }
            }
        }
        for (const [name, spec] of Object.entries(route.params ?? {})) {
            if (spec.required && args[name] === undefined) {
                return Response.json({ error: `${name} is required` }, { status: 400 })
            }
        }
        try {
            const result = await route.handler(args, request)
            return result instanceof Response ? result : Response.json(result ?? { ok: true })
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
        }
    }
    if (path.startsWith("api/")) {
        return Response.json({ error: `no such endpoint: ${request.method} /${path}` }, { status: 404 })
    }
    return null
}

/** Pages listening on `api/events/ws` (the standard backend → page channel): one JSON event per message. */
const pages = new Set<WebSocket>()

export function publishEvent(event: unknown) {
    const text = JSON.stringify(event)
    for (const ws of pages) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(text)
        }
    }
}

/** How many pages are listening (a capture needs at least one). */
export function pageCount(): number {
    return [...pages].filter((ws) => ws.readyState === WebSocket.OPEN).length
}

/** Pages may answer on the same socket (e.g. a capture): `onMessage` gets each JSON message they send. */
export function eventsSocket(request: Request, onMessage?: (message: Record<string, unknown>) => void): Response {
    const { socket, response } = Deno.upgradeWebSocket(request)
    socket.onopen = () => pages.add(socket)
    socket.onclose = () => pages.delete(socket)
    socket.onmessage = (event) => {
        try {
            onMessage?.(JSON.parse(String(event.data)))
        } catch {
            // not JSON
        }
    }
    return response
}
