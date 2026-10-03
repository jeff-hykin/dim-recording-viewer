// dimOS shared line icons (24-unit grid, stroke = currentColor), seeded from Live Viewer's icons.tsx.
// Plain pages: <i data-dim-icon="close"></i> is replaced by the SVG on load (and when added later).
// Code: dimIcon("close") returns the SVG markup; DIM_ICON_PATHS has the raw path data.
export const DIM_ICON_PATHS = {
    layers: "M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
    camera: "M4 7h3l2-2h6l2 2h3v12H4V7Zm8 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
    drive: "M12 3v4m0 10v4M3 12h4m10 0h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    record: "M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z",
    tree: "M6 4v16M6 8h6m-6 8h6m6-12v4h-6m6 4v4h-6",
    settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3a7.4 7.4 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-2.2-1.3L14.5 2h-5l-.3 2.5A7.3 7.3 0 0 0 7 5.8l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 2.2 1.3l.3 2.5h5l.3-2.5a7.3 7.3 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3Z",
    fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5m11-5v5h-5",
    close: "M6 6l12 12M18 6 6 18",
    expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    target: "M12 2v4m0 12v4M2 12h4m12 0h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
    top: "M4 4h16v16H4zM12 8v8m-4-4h8",
    download: "M12 4v11m-5-5 5 5 5-5M5 20h14",
    upload: "M12 20V9m-5 5 5-5 5 5M5 4h14",
    trash: "M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
    "chevron-down": "m6 9 6 6 6-6",
    "chevron-up": "m6 15 6-6 6 6",
    "chevron-left": "m15 6-6 6 6 6",
    "chevron-right": "m9 6 6 6-6 6",
    "arrow-up": "M12 19V5m-6 6 6-6 6 6",
    "arrow-down": "M12 5v14m-6-6 6 6 6-6",
    "arrow-left": "M19 12H5m6-6-6 6 6 6",
    "arrow-right": "M5 12h14m-6-6 6 6-6 6",
    "rotate-left": "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
    "rotate-right": "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
    menu: "M4 6h16M4 12h16M4 18h16",
    panels: "M4 4h16v16H4zM9 4v16",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
    moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z",
    signal: "M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01M2 9.5a14 14 0 0 1 20 0",
    play: "M7 4v16l13-8L7 4Z",
    pause: "M8 5v14M16 5v14",
    stop: "M6 6h12v12H6z",
    check: "M5 12.5 10 17l9-10",
    info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
    warn: "M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
    help: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
    eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    folder: "M3 6h6l2 2h10v11H3V6Z",
    file: "M6 3h8l5 5v13H6V3Zm8 0v5h5",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    power: "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0",
    keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
    gamepad: "M6 8h12a4 4 0 0 1 4 4v2a3 3 0 0 1-5.4 1.8L15 14H9l-1.6 1.8A3 3 0 0 1 2 14v-2a4 4 0 0 1 4-4Zm2 2v4m-2-2h4m6-1h.01M17 13h.01",
    robot: "M12 3v3M6 8h12v10H6zM9 12h.01M15 12h.01M9 15h6M3 12v3M21 12v3",
    map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14",
}

export function dimIcon(name, size = 18) {
    const d = DIM_ICON_PATHS[name] ?? ""
    return `<svg class="dim-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`
}

function upgrade(root) {
    for (const element of root.querySelectorAll("[data-dim-icon]")) {
        if (element.dataset.dimIconDone) {
            continue
        }
        element.dataset.dimIconDone = "1"
        element.innerHTML = dimIcon(element.dataset.dimIcon, element.dataset.dimIconSize || 18)
    }
}

if (typeof document !== "undefined") {
    const start = () => {
        upgrade(document)
        new MutationObserver(() => upgrade(document)).observe(document.body, { childList: true, subtree: true })
    }
    if (document.body) {
        start()
    } else {
        document.addEventListener("DOMContentLoaded", start)
    }
}
