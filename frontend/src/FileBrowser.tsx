// The Open dialog: an in-page file browser over GET api/files (a dropped file in a webview has no path, and an
// <input type=file> hands back bytes, so the page browses by path and the backend opens the file where it lies).
import { useEffect, useRef, useState } from "react"
import { call } from "./api.ts"
import { Icon } from "./icons.tsx"

type Entry = { name: string; path: string; size?: number; isDir: boolean; isParent?: boolean }
type Listing = {
    dir: string
    parent: string | null
    dirs: { name: string; path: string }[]
    files: { name: string; path: string; size: number }[]
    error?: string
}

export function formatSize(bytes: number): string {
    if (!bytes) {
        return ""
    }
    const units = ["B", "KB", "MB", "GB"]
    let value = bytes, unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)}${units[unit]}`
}

// Everything past the last "/" is the fragment being typed; before it, the directory to list.
function split(value: string) {
    const cut = value.lastIndexOf("/")
    return cut < 0
        ? { dir: null, fragment: value }
        : { dir: value.slice(0, cut) || "/", fragment: value.slice(cut + 1) }
}

export function FileBrowser(
    { startDir, onOpen, onClose }: {
        startDir: string | null
        onOpen: (path: string) => void
        onClose: (lastDir: string | null) => void
    },
) {
    const [value, setValue] = useState("")
    const [listing, setListing] = useState<Listing | null>(null)
    const [selected, setSelected] = useState(-1)
    const requested = useRef<string | null>(null) // the dir as typed: the reply comes back resolved (~/x → /Users/me/x)
    const typing = useRef(false) // while typing, a reply must not overwrite the field
    const typed = useRef("")
    const growing = useRef(false) // the last edit added characters: only then autocomplete
    const input = useRef<HTMLInputElement>(null)
    const list = useRef<HTMLDivElement>(null)

    const request = (dir: string) => {
        requested.current = dir
        call<Listing>("GET", `api/files?dir=${encodeURIComponent(dir)}`).then(
            (reply) => receive(reply),
            (error) => receive({ dir, parent: null, dirs: [], files: [], error: error.message }),
        )
    }
    const receive = (reply: Listing) => {
        setListing(reply)
        setSelected(-1)
        if (!typing.current) {
            // the trailing slash: without it the last segment reads as a half-typed fragment and filters everything out
            const shown = reply.dir.endsWith("/") ? reply.dir : reply.dir + "/"
            setValue(shown)
            typed.current = shown
            requested.current = reply.dir
        }
    }
    useEffect(() => {
        request(startDir || "~")
        input.current?.focus()
    }, [])

    const matches = (text: string): Entry[] => {
        if (!listing || listing.error) {
            return []
        }
        const entries: Entry[] = [
            ...listing.dirs.map((entry) => ({ ...entry, isDir: true })),
            ...listing.files.map((entry) => ({ ...entry, isDir: false })),
        ]
        const fragment = split(text).fragment.toLowerCase()
        if (!fragment) {
            return entries
        }
        const starts = (entry: Entry) => entry.name.toLowerCase().startsWith(fragment)
        return [
            ...entries.filter(starts),
            ...entries.filter((entry) => !starts(entry) && entry.name.toLowerCase().includes(fragment)),
        ]
    }
    let shown = matches(value)
    if (listing?.parent && !split(value).fragment && !listing.error) {
        shown = [{ name: "..", path: listing.parent, isDir: true, isParent: true }, ...shown]
    }

    // inline autocomplete: append the longest prefix every match shares, selected, so the next keystroke types over it
    useEffect(() => {
        if (!typing.current || !growing.current || !input.current) {
            return
        }
        const fragment = split(value).fragment
        if (!fragment) {
            return
        }
        const names = matches(value).filter((entry) => entry.name.toLowerCase().startsWith(fragment.toLowerCase())).map(
            (entry) => entry.name,
        )
        if (!names.length) {
            return
        }
        let shared = names[0]
        for (const name of names) {
            let index = 0
            while (index < shared.length && shared[index].toLowerCase() === name[index]?.toLowerCase()) {
                index++
            }
            shared = shared.slice(0, index)
        }
        if (shared.length <= fragment.length) {
            return
        }
        const base = value.slice(0, value.length - fragment.length)
        const completed = base + shared
        growing.current = false
        input.current.value = completed
        setValue(completed)
        requestAnimationFrame(() => input.current?.setSelectionRange(base.length + fragment.length, completed.length))
    }, [value, listing])

    useEffect(() => {
        list.current?.querySelector(".fb-row.sel")?.scrollIntoView({ block: "nearest" })
    }, [selected])

    const choose = (entry: Entry | undefined) => {
        if (!entry) {
            return
        }
        if (entry.isDir) {
            typing.current = false
            setListing(null)
            request(entry.path)
        } else {
            onClose(listing?.dir ?? null)
            onOpen(entry.path)
        }
    }
    const onInput = (next: string) => {
        typing.current = true
        growing.current = next.length > typed.current.length && next.startsWith(typed.current)
        typed.current = next
        setValue(next)
        setSelected(-1)
        const { dir } = split(next)
        if (dir !== null && dir !== requested.current) {
            // drop the old listing, else the first characters after a "/" complete against the previous folder
            setListing(null)
            request(dir)
        }
    }
    const onKey = (event: React.KeyboardEvent) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            if (shown.length) {
                setSelected(Math.max(0, Math.min(shown.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1))))
            }
        } else if (event.key === "Tab") {
            event.preventDefault()
            const entry = shown[selected >= 0 ? selected : 0]
            if (!entry || entry.isParent) {
                return
            }
            typing.current = true
            const next = entry.isDir ? entry.path + "/" : entry.path
            typed.current = next
            setValue(next)
            if (entry.isDir) {
                request(entry.path)
            }
            setSelected(-1)
        } else if (event.key === "Enter") {
            event.preventDefault()
            if (selected >= 0) {
                choose(shown[selected])
                return
            }
            const text = value.trim()
            if (!text) {
                return
            }
            if (/\.(db|mcap|pc2\.lcm)$/.test(text)) {
                onClose(listing?.dir ?? null)
                onOpen(text)
                return
            }
            const candidates = shown.filter((entry) => !entry.isParent)
            if (split(text).fragment && candidates.length === 1) {
                choose(candidates[0])
                return
            }
            typing.current = false
            request(text)
        } else if (event.key === "Escape") {
            onClose(listing?.dir ?? null)
        }
    }

    return (
        <div
            id="fb-backdrop"
            style={{ display: "flex" }}
            onClick={(event) => event.target === event.currentTarget && onClose(listing?.dir ?? null)}
        >
            <div id="fb-card" className="dim-panel">
                <div className="fb-title">Open a recording</div>
                <input
                    id="fb-path"
                    ref={input}
                    className="dim-input dim-mono"
                    spellCheck={false}
                    autoComplete="off"
                    value={value}
                    onChange={(event) => onInput(event.target.value)}
                    onKeyDown={onKey}
                />
                <div id="fb-list" ref={list}>
                    {!listing && <div className="fb-empty">loading…</div>}
                    {listing?.error && <div className="fb-empty">{listing.error}</div>}
                    {listing && !listing.error && !shown.length && <div className="fb-empty">no matches</div>}
                    {listing && !listing.error &&
                        shown.map((entry, index) => (
                            <div
                                key={entry.path + index}
                                className={`fb-row${index === selected ? " sel" : ""}`}
                                onClick={() => choose(entry)}
                            >
                                <span className="fb-icon">
                                    <Icon name={entry.isParent ? "arrow-up" : entry.isDir ? "folder" : "file"} />
                                </span>
                                <span className="fb-name">{entry.name}</span>
                                {!entry.isDir && <span className="fb-size">{formatSize(entry.size ?? 0)}</span>}
                            </div>
                        ))}
                </div>
                <div className="fb-hint">tab completes · ↑↓ picks · enter opens</div>
                <div className="fb-actions">
                    <button type="button" className="dim-btn sm" onClick={() => onClose(listing?.dir ?? null)}>
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}
