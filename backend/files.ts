// Where recordings come from: Desktop's shared recordings folder (its GET /recordings), the usual dataset folders, the
// recently-opened list, and an in-page file browser (a dropped file in a webview has no path, and recordings are far
// too big to upload, so the page browses by path and the backend opens the file where it lies).
import { isRecordingFile } from "./playback.ts"

export const HOME = Deno.env.get("HOME") ?? ""
/** The app's own writable folder (Desktop sets DIMOS_APP_DATA); else the one the old dashboard used. */
export const DATA_DIR = Deno.env.get("DIMOS_APP_DATA") || `${HOME}/.local/share/dim/recording_viewer`

export type RecordingFile = {
    name: string
    label: string
    path: string
    size: number
    mtime: number
    source: string
    id?: string
}

/** Folders scanned (one level deep: go2 recordings live at <root>/<recording-dir>/mem2.db). */
export function scanRoots(): string[] {
    const roots = [
        Deno.env.get("DIMOS_RECORDINGS_DIR") || `${HOME}/.dimos/recordings`,
        `${HOME}/datasets`,
        `${HOME}/datasets/go2_recordings`,
    ]
    return [...new Set(roots)]
}

async function stat(path: string): Promise<{ size: number; mtime: number; isFile: boolean } | null> {
    try {
        const info = await Deno.stat(path)
        return { size: info.size, mtime: info.mtime?.getTime() ?? 0, isFile: info.isFile }
    } catch {
        return null
    }
}

async function scanDir(root: string, depth: number, seen: Set<string>, found: RecordingFile[]) {
    try {
        for await (const entry of Deno.readDir(root)) {
            const path = `${root}/${entry.name}`
            if (entry.isDirectory && depth > 0) {
                await scanDir(path, depth - 1, seen, found)
            } else if (entry.isFile && isRecordingFile(entry.name) && !seen.has(path)) {
                seen.add(path)
                const info = await stat(path)
                found.push({
                    name: entry.name,
                    label: `${root.split("/").pop()}/${entry.name}`,
                    path,
                    size: info?.size ?? 0,
                    mtime: info?.mtime ?? 0,
                    source: "folder",
                })
            }
        }
    } catch { /* missing or vanished folder */ }
}

/** Desktop's shared recordings (GET <desktop>/recordings); [] when Desktop isn't reachable. */
export async function desktopRecordings(desktopUrl: string | undefined): Promise<RecordingFile[]> {
    if (!desktopUrl) {
        return []
    }
    try {
        const response = await fetch(`${desktopUrl.replace(/\/+$/, "")}/recordings`, {
            signal: AbortSignal.timeout(3000),
        })
        if (!response.ok) {
            await response.body?.cancel()
            return []
        }
        const listing = await response.json() as {
            recordings?: { id: string; name: string; path: string; size: number; modified: number }[]
        }
        return (listing.recordings ?? []).map((recording) => ({
            name: recording.name,
            label: `desktop/${recording.id}`,
            path: recording.path,
            size: recording.size,
            mtime: recording.modified * 1000,
            source: "desktop",
            id: recording.id,
        }))
    } catch {
        return []
    }
}

/** Every recording we know of, newest first: Desktop's first, then the scanned folders (deduplicated by path). */
export async function listRecordings(desktopUrl?: string): Promise<RecordingFile[]> {
    const found = await desktopRecordings(desktopUrl)
    const seen = new Set(found.map((recording) => recording.path))
    for (const root of scanRoots()) {
        await scanDir(root, 1, seen, found)
    }
    return found.sort((a, b) => b.mtime - a.mtime)
}

// ── recently opened (kept on disk so files browsed to from anywhere show up again) ──
const RECENTS_CAP = 15
const recentsFile = () => `${DATA_DIR}/recents.json`

async function loadRecents(): Promise<{ path: string; openedAt: number }[]> {
    try {
        const list = JSON.parse(await Deno.readTextFile(recentsFile()))
        return Array.isArray(list) ? list.filter((entry) => entry?.path) : []
    } catch {
        return []
    }
}

export async function recordRecent(path: string) {
    const list = (await loadRecents()).filter((entry) => entry.path !== path)
    list.unshift({ path, openedAt: Date.now() })
    try {
        await Deno.mkdir(DATA_DIR, { recursive: true })
        await Deno.writeTextFile(recentsFile(), JSON.stringify(list.slice(0, RECENTS_CAP)))
    } catch { /* best effort: no recents file just means an empty list */ }
}

/** Recently opened files that still exist, newest first. */
export async function recentRecordings(): Promise<RecordingFile[]> {
    const out: RecordingFile[] = []
    for (const entry of await loadRecents()) {
        const info = await stat(entry.path)
        if (info?.isFile) {
            const name = entry.path.split("/").pop()!
            out.push({
                name,
                label: name,
                path: entry.path,
                size: info.size,
                mtime: entry.openedAt || 0,
                source: "recent",
            })
        }
    }
    return out
}

export const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, HOME)

/** One directory: its folders and recording files (hidden entries skipped). */
export async function listDir(dir: string | undefined) {
    const path = dir && dir !== "~" ? expandHome(dir).replace(/(.)\/+$/, "$1") : HOME
    const dirs: { name: string; path: string }[] = []
    const files: { name: string; path: string; size: number; mtime: number }[] = []
    for await (const entry of Deno.readDir(path)) {
        if (entry.name.startsWith(".")) {
            continue
        }
        const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
        if (entry.isDirectory) {
            dirs.push({ name: entry.name, path: child })
        } else if (entry.isFile && isRecordingFile(entry.name)) {
            const info = await stat(child)
            files.push({ name: entry.name, path: child, size: info?.size ?? 0, mtime: info?.mtime ?? 0 })
        }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/"
    return { dir: path, parent, dirs, files }
}

/** A path as given, else a bare file name (what a drag-drop gives) looked up among the known recordings. */
export async function resolveRecording(nameOrPath: string, desktopUrl?: string): Promise<string | null> {
    const direct = expandHome(nameOrPath)
    if ((await stat(direct))?.isFile) {
        return direct
    }
    const base = nameOrPath.split("/").pop()
    for (const recording of [...await recentRecordings(), ...await listRecordings(desktopUrl)]) {
        if (recording.name === base || recording.id === nameOrPath) {
            return recording.path
        }
    }
    return null
}
