// The 3D scene (three.js, ROS convention: Z up), rebuilt from the backend's scene stream (api/scene/ws): robot pose +
// trail (odometry), lidar clouds placed through the tf tree, planned paths, and floating camera windows. Owns the
// canvas, the fly camera and the camera windows' DOM; React (App.tsx) owns the rest of the page and drives this
// through its methods. Stream look comes from the backend (api/style) via setStyle.
// deno-lint-ignore-file no-explicit-any
import * as THREE from "three"
import { dimIcon } from "./icons.tsx"

export type Style = Record<string, any>
export type StreamEntry = Style & { kind: string; on: boolean }
export type Marker = { id: string; x: number; y: number; label: string }
export type TfEdge = { child: string; parent: string }

export type ViewerEvents = {
    /** the stream list changed (names → entry) */
    streams(known: Map<string, StreamEntry>): void
    /** the scene stream's clock */
    time(time: { t: number; t0: number; t1: number; playing: boolean; speed: number; atEnd: boolean }): void
    /** the tf edges changed (for the tf tree widget) */
    tf(edges: TfEdge[]): void
    /** a camera window's close button: hide that stream */
    hideStream(name: string): void
    /** right-click on the canvas (not a pan): open the marker menu */
    contextMenu(clientX: number, clientY: number, markerId: string | null): void
    /** a marker was dragged to a new spot */
    markerMoved(id: string, x: number, y: number): void
    /** the floor coordinates to show (null hides the readout) */
    coords(text: string | null): void
    /** the scene stream announced a newly opened recording */
    loaded(name: string): void
}

// ── cloud coloring: a start → mid → end gradient along one axis ──
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
function hexToRgb01(hex: string): [number, number, number] {
    const value = parseInt(String(hex || "#ffffff").slice(1), 16)
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}
// The color pickers are hue-only sliders (0..359°), so every picked color is a full-saturation mid-lightness hue.
export function hueToHex(hue: number): string {
    const sector = (((hue % 360) + 360) % 360) / 60
    const x = 1 - Math.abs((sector % 2) - 1)
    let r = 0, g = 0, b = 0
    if (sector < 1) {
        r = 1
        g = x
    } else if (sector < 2) {
        r = x
        g = 1
    } else if (sector < 3) {
        g = 1
        b = x
    } else if (sector < 4) {
        g = x
        b = 1
    } else if (sector < 5) {
        r = x
        b = 1
    } else {
        r = 1
        b = x
    }
    const toByte = (channel: number) => Math.round(channel * 255).toString(16).padStart(2, "0")
    return "#" + toByte(r) + toByte(g) + toByte(b)
}
export function hexToHue(hex: string): number {
    const [r, g, b] = hexToRgb01(hex)
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
    if (delta === 0) {
        return 0
    }
    let hue
    if (max === r) {
        hue = ((g - b) / delta) % 6
    } else if (max === g) {
        hue = (b - r) / delta + 2
    } else {
        hue = (r - g) / delta + 4
    }
    return (hue * 60 + 360) % 360
}
/** Channel average of two colors: the default mid stop, so an unset mid reads as a smooth two-color ramp. */
export function midpointHex(startHex: string, endHex: string): string {
    const [sr, sg, sb] = hexToRgb01(startHex)
    const [er, eg, eb] = hexToRgb01(endHex)
    const toByte = (channel: number) => Math.round(clamp01(channel) * 255).toString(16).padStart(2, "0")
    return "#" + toByte((sr + er) / 2) + toByte((sg + eg) / 2) + toByte((sb + eb) / 2)
}
// Each new cloud stream cycles through a default pair so overlapping clouds are easy to tell apart.
export const GRAD_PAIRS = [
    ["#1130ff", "#ff2a12"],
    ["#3b0f9e", "#f2f21a"],
    ["#0b3f8f", "#7ffcff"],
    ["#101010", "#ff9a00"],
    ["#2a2a2a", "#ffffff"],
]
function gradStops(entry: Style | undefined) {
    const startHex = entry?.gradStart || GRAD_PAIRS[0][0]
    const endHex = entry?.gradEnd || GRAD_PAIRS[0][1]
    const midHex = entry?.gradMid || midpointHex(startHex, endHex)
    return [hexToRgb01(startHex), hexToRgb01(midHex), hexToRgb01(endHex)]
}
function gradColorAt(stops: number[][], t: number): [number, number, number] {
    const [start, mid, end] = stops
    if (t < 0.5) {
        const u = t * 2
        return [
            start[0] + (mid[0] - start[0]) * u,
            start[1] + (mid[1] - start[1]) * u,
            start[2] + (mid[2] - start[2]) * u,
        ]
    }
    const u = (t - 0.5) * 2
    return [mid[0] + (end[0] - mid[0]) * u, mid[1] + (end[1] - mid[1]) * u, mid[2] + (end[2] - mid[2]) * u]
}

// Depth cue for points and voxels: dim each fragment by view-space distance (eased), in the shader.
const VOXEL_DEPTH_NEAR = 6.0, VOXEL_DEPTH_FAR = 35.0, VOXEL_DEPTH_FLOOR = 0.25
const VOXEL_DEPTH_EASE = 3.0
// Lambert shading dulls each voxel's hue; blend back toward the pure hue so colors stay vibrant but shaded.
const VOXEL_VIBRANCY = 0.55
const DENOISE_DEFER_POINTS = 40000
const CLOUD_ACCUM_CAP = 240 // max retained frames per stream (bounds GPU memory)
const TRAIL_COLORS = [0x45e0ff, 0xffb454, 0x7cff6b, 0xff6b9d, 0xb07cff, 0xffd93d]
const TRAIL_CAP = 120000 // trail vertices (2 per segment)
const TRAIL_JUMP = 2.5 // meters: a larger step is a discontinuity, not motion
const TF_AXIS_LEN = 0.35
const BASE_VFOV = 60, MAX_HFOV = 100
// A global (fixed) frame carries world coordinates already: identity, NOT anchored to the robot pose.
const GLOBAL_FRAME_NAMES = /^(world|map|odom|earth|global)$/i
const DEPTH_ENCODINGS = new Set(["16uc1", "mono16", "16sc1", "32fc1"])
const THEME = {
    dark: { grid1: 0x2b3a44, grid2: 0x19242b, sky: 0xbfd8ff, ground: 0x101820 },
    light: { grid1: 0x9aa7b2, grid2: 0xc3ccd4, sky: 0xffffff, ground: 0xb6c2ce },
}
// page-only: where each camera window sits (the look of a stream lives in the backend)
const WINDOW_STORAGE_KEY = "rv-window-geometry:v1"

// Statistical-ish outlier removal: bin into a grid, drop points whose 3×3×3 neighborhood has fewer than `min` points.
function denoiseLocal(kept: Float32Array, cell: number, min: number): Float32Array {
    const count = kept.length / 3
    if (count <= min) {
        return kept
    }
    const inv = 1 / cell
    const cells = new Int32Array(count * 3)
    const counts = new Map<string, number>()
    for (let i = 0; i < count; i++) {
        const ix = Math.floor(kept[i * 3] * inv)
        const iy = Math.floor(kept[i * 3 + 1] * inv)
        const iz = Math.floor(kept[i * 3 + 2] * inv)
        cells[i * 3] = ix
        cells[i * 3 + 1] = iy
        cells[i * 3 + 2] = iz
        const key = ix + "," + iy + "," + iz
        counts.set(key, (counts.get(key) || 0) + 1)
    }
    const out = new Float32Array(kept.length)
    let written = 0
    for (let i = 0; i < count; i++) {
        const ix = cells[i * 3], iy = cells[i * 3 + 1], iz = cells[i * 3 + 2]
        let neighbors = 0
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    neighbors += counts.get((ix + dx) + "," + (iy + dy) + "," + (iz + dz)) || 0
                }
            }
        }
        if (neighbors >= min) {
            out[written++] = kept[i * 3]
            out[written++] = kept[i * 3 + 1]
            out[written++] = kept[i * 3 + 2]
        }
    }
    return out.slice(0, written)
}

// The kept LOCAL xyz of a frame after downsample (every Nth) and world-space filters (max range from the sensor, z clip).
function computeKeptLocal(raw: Float32Array, entry: Style | undefined, pose: number[]): Float32Array {
    const count = raw.length / 3
    const stride = Math.max(1, Math.round(entry?.downsample || 1))
    const rangeMax = entry?.rangeMax || 0
    const rangeSq = rangeMax * rangeMax
    const zMin = Number.isFinite(entry?.zMin) ? entry!.zMin : -Infinity
    const zMax = Number.isFinite(entry?.zMax) ? entry!.zMax : Infinity
    const hasFilter = rangeMax > 0 || zMin > -Infinity || zMax < Infinity
    const denoise = !!entry?.denoise
    const denoiseCell = entry?.denoiseCell > 0 ? entry!.denoiseCell : 0.12
    const denoiseMin = entry?.denoiseMin > 0 ? entry!.denoiseMin : 4
    if (stride === 1 && !hasFilter) {
        return denoise ? denoiseLocal(raw, denoiseCell, denoiseMin) : raw
    }
    const sx = pose[12], sy = pose[13], sz = pose[14]
    const kept = new Float32Array(count * 3)
    let written = 0
    for (let i = 0; i < count; i++) {
        if (i % stride !== 0) {
            continue
        }
        const x = raw[i * 3], y = raw[i * 3 + 1], z = raw[i * 3 + 2]
        if (hasFilter) {
            const wx = pose[0] * x + pose[4] * y + pose[8] * z + pose[12]
            const wy = pose[1] * x + pose[5] * y + pose[9] * z + pose[13]
            const wz = pose[2] * x + pose[6] * y + pose[10] * z + pose[14]
            if (wz < zMin || wz > zMax) {
                continue
            }
            if (rangeSq > 0) {
                const dx = wx - sx, dy = wy - sy, dz = wz - sz
                if (dx * dx + dy * dy + dz * dz > rangeSq) {
                    continue
                }
            }
        }
        kept[written++] = x
        kept[written++] = y
        kept[written++] = z
    }
    const result = kept.slice(0, written)
    return denoise ? denoiseLocal(result, denoiseCell, denoiseMin) : result
}

// Classic jet: near (t≈0) red, far (t≈1) blue.
function jetColor(t: number): [number, number, number] {
    const value = 4 * clamp01(1 - t)
    return [
        Math.round(clamp01(Math.min(value - 1.5, -value + 4.5)) * 255),
        Math.round(clamp01(Math.min(value - 0.5, -value + 3.5)) * 255),
        Math.round(clamp01(Math.min(value + 0.5, -value + 2.5)) * 255),
    ]
}
// Depth histograms are long-tailed: trim to the 5th/95th percentile so the colors spread over the depths in frame.
function percentileRange(histogram: Uint32Array, low: number, high: number, total: number): [number, number] {
    const step = (high - low) / histogram.length
    const cut = total * 0.05
    let seen = 0, first = 0, last = histogram.length - 1
    for (let bin = 0; bin < histogram.length; bin++) {
        seen += histogram[bin]
        if (seen >= cut) {
            first = bin
            break
        }
    }
    seen = 0
    for (let bin = histogram.length - 1; bin >= 0; bin--) {
        seen += histogram[bin]
        if (seen >= cut) {
            last = bin
            break
        }
    }
    if (last <= first) {
        return [low, high]
    }
    return [low + first * step, low + (last + 1) * step]
}

type CloudFrame = {
    ts: number
    points: THREE.Points
    geom: THREE.BufferGeometry
    rawXyz: Float32Array
    voxelMesh: THREE.InstancedMesh | null
}
type Cloud = { group: THREE.Group; material: THREE.PointsMaterial; frames: CloudFrame[]; frame: string; stream: string }
type Odom = {
    group: THREE.Group
    trail: THREE.LineSegments
    geom: THREE.BufferGeometry
    tsArray: Float64Array
    count: number
    start: number
    last: THREE.Vector3 | null
    lastTs: number | null
    startColor: THREE.Color
    endColor: THREE.Color
}
type ImageWindow = {
    el: HTMLDivElement
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    badgeEl: HTMLElement
    raw: ImageData | null
    decodeCanvas?: HTMLCanvasElement
    expandedHeight?: string
}

export class Viewer {
    readonly renderer: THREE.WebGLRenderer
    readonly scene = new THREE.Scene()
    readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 5000)
    known = new Map<string, StreamEntry>()
    timeline = { t0: 0, t1: 0, t: 0, playing: false }

    #styles = new Map<string, Style>() // backend styles by base name
    #look = { yaw: 0, pitch: 0 }
    #heldKeys = new Set<string>()
    #userMovedCamera = false
    #fitDirty = false
    #lastFit = 0
    #tfDirty = false
    #rebuilding = false
    #dragButton = -1
    #rightDragDist = 0
    #raycaster = new THREE.Raycaster()
    #floorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    #markerGroup = new THREE.Group()
    #movingMarker: THREE.Object3D | null = null
    #movingMarkerOrigin: THREE.Vector3 | null = null
    #grid: THREE.GridHelper | null = null
    #hemi: THREE.HemisphereLight | null = null
    #zClipTop = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
    #zClipBottom = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    #tf = new Map<string, { parent: string; matrix: THREE.Matrix4 }>()
    #tfParents = new Set<string>()
    #tfAxesGroup = new THREE.Group()
    #tfAxes = new Map<string, THREE.Group>()
    #tfHovered: string | null = null
    #clouds = new Map<string, Cloud>()
    #odoms = new Map<string, Odom>()
    #paths = new Map<string, { line: THREE.Line; geom: THREE.BufferGeometry }>()
    #imageWindows = new Map<string, ImageWindow>()
    #camCascade = 0
    #lastOdomWorld: THREE.Matrix4 | null = null
    #deferStream: string | null = null
    #pendingHeavyRebuild: string | null = null
    #windowGeometry: Record<string, Record<string, any>> = {}
    #tokenProbe: HTMLSpanElement
    #tokenPixel: CanvasRenderingContext2D
    #stop: (() => void)[] = []
    #frameClock = new THREE.Clock()

    constructor(readonly host: HTMLElement, readonly camLayer: HTMLElement, readonly on: ViewerEvents) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
        this.renderer.setClearColor(0x000000, 0)
        this.renderer.setPixelRatio(Math.min(2, devicePixelRatio))
        host.appendChild(this.renderer.domElement)
        this.camera.up.set(0, 0, 1)
        this.#setLookFrom(new THREE.Vector3(6, -6, 4), new THREE.Vector3(0, 0, 0))
        this.scene.add(this.#markerGroup)
        this.#tfAxesGroup.visible = false
        this.scene.add(this.#tfAxesGroup)
        this.#tokenProbe = document.body.appendChild(Object.assign(document.createElement("span"), { hidden: true }))
        this.#tokenPixel = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", {
            willReadFrequently: true,
        })!
        try {
            this.#windowGeometry = JSON.parse(localStorage.getItem(WINDOW_STORAGE_KEY) || "{}") || {}
        } catch { /* blocked storage */ }
        this.#applyTheme()
        this.scene.add(this.#makeAxes(1.5, 0.02))
        this.#bindInput()
        const observer = new ResizeObserver(() => this.#resize())
        observer.observe(host)
        this.#resize()
        let frame = 0
        const loop = () => {
            frame = requestAnimationFrame(loop)
            this.#renderLoop()
        }
        loop()
        this.#stop.push(() => cancelAnimationFrame(frame), () => observer.disconnect())
    }

    dispose() {
        for (const stop of this.#stop) {
            stop()
        }
        this.renderer.dispose()
        this.renderer.domElement.remove()
        this.#tokenProbe.remove()
    }

    // ── input: WASD move, Q/E down/up, drag to look, right-drag pan, scroll dolly, double-click recenter ──
    #listen<K extends keyof WindowEventMap>(
        target: Window | HTMLElement,
        type: K,
        handler: (event: WindowEventMap[K]) => void,
        options?: AddEventListenerOptions,
    ) {
        target.addEventListener(type, handler as EventListener, options)
        this.#stop.push(() => target.removeEventListener(type, handler as EventListener, options))
    }

    #bindInput() {
        const canvas = this.renderer.domElement
        this.#listen(globalThis as unknown as Window, "keydown", (event) => {
            if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) {
                return
            }
            this.#heldKeys.add(event.code)
            if (event.code === "Space") {
                event.preventDefault()
            }
            if (event.code === "Escape") {
                this.cancelMovingMarker()
            }
        })
        this.#listen(globalThis as unknown as Window, "keyup", (event) => this.#heldKeys.delete(event.code))
        this.#listen(globalThis as unknown as Window, "blur", () => this.#heldKeys.clear())
        this.#listen(globalThis as unknown as Window, "dim-theme" as keyof WindowEventMap, () => {
            this.#applyTheme()
            this.scene.traverse((object: any) => {
                const token = object.material?.userData?.axisToken
                if (token) {
                    object.material.color.set(this.#cssColor(token))
                }
            })
        })
        this.#listen(canvas, "pointerdown", (event) => {
            if (this.#movingMarker) { // a left-click while moving drops the marker where it sits
                if (event.button === 0) {
                    event.preventDefault()
                    this.#commitMovingMarker()
                    return
                }
                if (event.button === 2) {
                    event.preventDefault()
                    this.cancelMovingMarker()
                    return
                }
            }
            this.#dragButton = event.button
            this.#userMovedCamera = true
            if (event.button === 2) {
                this.#rightDragDist = 0
            }
            canvas.setPointerCapture(event.pointerId)
        })
        this.#listen(canvas, "pointerup", () => this.#dragButton = -1)
        this.#listen(canvas, "pointercancel", () => this.#dragButton = -1)
        this.#listen(canvas, "pointermove", (event) => {
            if (this.#movingMarker) {
                const point = this.floorPoint(event.clientX, event.clientY)
                if (point) {
                    this.#movingMarker.position.set(point.x, point.y, 0)
                    this.on.coords(`x ${point.x.toFixed(2)}   y ${point.y.toFixed(2)}   z 0.00`)
                }
                return
            }
            if (this.#dragButton === -1) {
                return
            }
            if (event.buttons === 0) { // missed pointerup (released off-window)
                this.#dragButton = -1
                return
            }
            if (this.#dragButton === 0) {
                // grab-the-world look; pitch clamped to ±80° so yaw never reads as roll
                this.#look.yaw += event.movementX * 0.004
                this.#look.pitch = THREE.MathUtils.clamp(this.#look.pitch + event.movementY * 0.004, -1.4, 1.4)
            } else if (this.#dragButton === 2) {
                this.#rightDragDist += Math.abs(event.movementX) + Math.abs(event.movementY)
                const forward = this.#viewDir()
                const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize()
                const screenUp = new THREE.Vector3().crossVectors(right, forward)
                this.camera.position.addScaledVector(right, -event.movementX * 0.015)
                this.camera.position.addScaledVector(screenUp, event.movementY * 0.015)
            }
        })
        // a plain right-click (no pan) opens the marker menu
        this.#listen(canvas, "contextmenu", (event) => {
            event.preventDefault()
            if (this.#rightDragDist > 6 || this.#movingMarker) {
                return
            }
            const marker = this.#pickMarkerAt(event.clientX, event.clientY)
            this.on.contextMenu(event.clientX, event.clientY, marker ? String(marker.userData.id) : null)
        })
        // scroll flies along the view direction; clamped per event so trackpad flings don't teleport
        this.#listen(canvas, "wheel", (event) => {
            this.#userMovedCamera = true
            this.camera.position.addScaledVector(this.#viewDir(), THREE.MathUtils.clamp(-event.deltaY * 0.01, -1, 1))
        }, { passive: true })
        this.#listen(canvas, "dblclick", () => {
            this.#userMovedCamera = false
            this.fit()
        })
    }

    #viewDir() {
        const cosPitch = Math.cos(this.#look.pitch)
        return new THREE.Vector3(
            cosPitch * Math.cos(this.#look.yaw),
            cosPitch * Math.sin(this.#look.yaw),
            Math.sin(this.#look.pitch),
        )
    }

    #setLookFrom(position: THREE.Vector3, target: THREE.Vector3) {
        this.camera.position.copy(position)
        const direction = new THREE.Vector3().subVectors(target, position).normalize()
        this.#look.yaw = Math.atan2(direction.y, direction.x)
        this.#look.pitch = Math.asin(THREE.MathUtils.clamp(direction.z, -1, 1))
    }

    #updateCamera(dt: number) {
        const keys = this.#heldKeys
        const forward = this.#viewDir()
        const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize()
        const flat = new THREE.Vector3(forward.x, forward.y, 0)
        if (flat.lengthSq() > 1e-6) {
            flat.normalize()
        } else {
            flat.copy(right).cross(this.camera.up).negate()
        }
        const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 15 : 5) * dt
        let moved = false
        const move = (vector: THREE.Vector3, amount: number) => {
            this.camera.position.addScaledVector(vector, amount)
            moved = true
        }
        if (keys.has("KeyW")) move(flat, speed)
        if (keys.has("KeyS")) move(flat, -speed)
        if (keys.has("KeyA")) move(right, -speed)
        if (keys.has("KeyD")) move(right, speed)
        if (keys.has("KeyE") || keys.has("Space")) move(new THREE.Vector3(0, 0, 1), speed)
        if (keys.has("KeyQ")) move(new THREE.Vector3(0, 0, 1), -speed)
        if (moved) {
            this.#userMovedCamera = true
        }
        this.camera.lookAt(new THREE.Vector3().addVectors(this.camera.position, forward))
    }

    #renderLoop() {
        if (this.#fitDirty && !this.#userMovedCamera) {
            const now = performance.now()
            if (now - this.#lastFit > 200) {
                this.fit()
                this.#lastFit = now
                this.#fitDirty = false
            }
        }
        this.#updateCamera(Math.min(this.#frameClock.getDelta(), 0.1))
        // coalesced: a seek replays thousands of tf edges
        if (this.#tfDirty) {
            this.#tfDirty = false
            this.on.tf(
                [...this.#tf].map(([child, edge]) => ({ child, parent: edge.parent })).concat(
                    [...this.#tfParents].filter((parent) => !this.#tf.has(parent)).map((root) => ({
                        child: root,
                        parent: "",
                    })),
                ),
            )
            this.#syncTfAxes()
        }
        // hold the last frame while a seek rebuilds, so the replay (robot sweeping from the start) never shows
        if (!this.#rebuilding) {
            this.renderer.render(this.scene, this.camera)
        }
    }

    cameraText() {
        const position = this.camera.position
        return ` · CAM ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`
    }

    // ── theme ──
    #isDark = () => document.body.classList.contains("dark")
    #applyTheme() {
        const theme = this.#isDark() ? THEME.dark : THEME.light
        if (this.#grid) {
            this.scene.remove(this.#grid)
            this.#grid.geometry.dispose()
            ;(this.#grid.material as THREE.Material).dispose()
        }
        this.#grid = new THREE.GridHelper(40, 40, theme.grid1, theme.grid2)
        this.#grid.rotation.x = Math.PI / 2
        this.scene.add(this.#grid)
        if (this.#hemi) {
            this.scene.remove(this.#hemi)
        } else {
            // a key light so lit meshes (the voxel cubes) get facet shading instead of a flat fill
            const sun = new THREE.DirectionalLight(0xffffff, 0.85)
            sun.position.set(6, 4, 12)
            this.scene.add(sun)
        }
        this.#hemi = new THREE.HemisphereLight(theme.sky, theme.ground, 1.1)
        this.scene.add(this.#hemi)
    }
    // theme.css token → 0xrrggbb (THREE.Color can't parse oklch/color-mix: let the browser paint one pixel)
    #cssColor(token: string): number {
        this.#tokenProbe.style.color = `var(${token})`
        this.#tokenPixel.clearRect(0, 0, 1, 1)
        this.#tokenPixel.fillStyle = getComputedStyle(this.#tokenProbe).color
        this.#tokenPixel.fillRect(0, 0, 1, 1)
        const [r, g, b] = this.#tokenPixel.getImageData(0, 0, 1, 1).data
        return (r << 16) | (g << 8) | b
    }
    // Solid cylinder axes: 1px lines in the grid plane z-fight with the GridHelper.
    #makeAxes(length: number, radius: number) {
        const group = new THREE.Group()
        const specs = [
            { token: "--axis-x", dir: new THREE.Vector3(1, 0, 0) },
            { token: "--axis-y", dir: new THREE.Vector3(0, 1, 0) },
            { token: "--axis-z", dir: new THREE.Vector3(0, 0, 1) },
        ]
        for (const { token, dir } of specs) {
            const material = new THREE.MeshBasicMaterial({ color: this.#cssColor(token) })
            material.userData.axisToken = token
            const rod = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), material)
            rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
            rod.position.copy(dir).multiplyScalar(length / 2)
            group.add(rod)
        }
        group.position.z = 0.002
        return group
    }
    // Box outline as 12 cylinders: WebGL clamps line width to 1px.
    #makeBoxWireframe(width: number, depth: number, height: number, color: number, radius: number) {
        const group = new THREE.Group()
        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(width, depth, height))
        const corners = edges.getAttribute("position")
        const material = new THREE.MeshBasicMaterial({ color })
        const start = new THREE.Vector3()
        const end = new THREE.Vector3()
        for (let i = 0; i < corners.count; i += 2) {
            start.fromBufferAttribute(corners, i)
            end.fromBufferAttribute(corners, i + 1)
            const rod = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, start.distanceTo(end), 8), material)
            rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize())
            rod.position.copy(start).add(end).multiplyScalar(0.5)
            group.add(rod)
        }
        edges.dispose()
        return group
    }

    // Cap the horizontal FOV on wide windows so edges don't fisheye-stretch.
    #resize() {
        const width = this.host.clientWidth, height = this.host.clientHeight
        if (!width || !height) {
            return
        }
        this.renderer.setSize(width, height)
        this.camera.aspect = width / height
        const halfHorizontal = Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_VFOV) / 2) * this.camera.aspect)
        this.camera.fov = halfHorizontal > THREE.MathUtils.degToRad(MAX_HFOV) / 2
            ? THREE.MathUtils.radToDeg(
                2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(MAX_HFOV) / 2) / this.camera.aspect),
            )
            : BASE_VFOV
        this.camera.updateProjectionMatrix()
    }

    // ── framing ──
    #sceneBounds() {
        // the trajectory is the meaningful extent; clouds carry long-range outliers that blow the fit out
        const box = new THREE.Box3(), tmp = new THREE.Box3(), point = new THREE.Vector3()
        let haveTrail = false
        for (const odom of this.#odoms.values()) {
            if (!odom.trail.visible || !odom.count) {
                continue
            }
            const array = odom.geom.getAttribute("position").array
            for (let i = 0; i < odom.count; i++) {
                point.set(array[i * 3], array[i * 3 + 1], array[i * 3 + 2])
                box.expandByPoint(point)
                haveTrail = true
            }
        }
        if (haveTrail) {
            return box
        }
        for (const cloud of this.#clouds.values()) {
            if (!cloud.group.visible) {
                continue
            }
            for (const frame of cloud.frames) {
                frame.geom.computeBoundingBox()
                if (frame.geom.boundingBox) {
                    tmp.copy(frame.geom.boundingBox).applyMatrix4(frame.points.matrix)
                    box.union(tmp)
                }
            }
        }
        return box
    }

    /** Frames the whole scene from a 3/4 view, across its longer horizontal axis. */
    fit() {
        const box = this.#sceneBounds()
        if (box.isEmpty()) {
            return
        }
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const horizontal = Math.max(size.x, size.y, 1)
        const distance = (horizontal * 0.5 / Math.tan((this.camera.fov * Math.PI / 180) / 2)) * 1.2
        const position = size.x >= size.y
            ? new THREE.Vector3(center.x - distance * 0.12, center.y - distance * 0.72, center.z + distance * 0.62)
            : new THREE.Vector3(center.x + distance * 0.72, center.y - distance * 0.12, center.z + distance * 0.62)
        this.#setLookFrom(position, center)
        this.#setClip(distance)
    }

    /** Bird's-eye: almost straight down on the scene center (a tiny south offset keeps Z-up stable). */
    top() {
        const box = this.#sceneBounds()
        if (box.isEmpty()) {
            return
        }
        this.#userMovedCamera = true
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const horizontal = Math.max(size.x, size.y, 1)
        const distance = (horizontal * 0.5 / Math.tan((this.camera.fov * Math.PI / 180) / 2)) * 1.25
        this.#setLookFrom(new THREE.Vector3(center.x, center.y - horizontal * 0.02, center.z + distance), center)
        this.#setClip(distance)
    }

    lookAt(position: number[], target: number[]) {
        this.#userMovedCamera = true
        const from = new THREE.Vector3(position[0], position[1], position[2])
        const to = new THREE.Vector3(target[0], target[1], target[2])
        this.#setLookFrom(from, to)
        this.#setClip(from.distanceTo(to))
    }

    autoFit() {
        this.#userMovedCamera = false
        this.fit()
    }

    #setClip(distance: number) {
        this.camera.far = Math.max(distance * 30, 5000)
        this.camera.near = Math.max(0.05, distance / 800)
        this.camera.updateProjectionMatrix()
    }

    // ── z slice: two clipping planes, in world meters (null = open) ──
    /** World-space z range of what is drawn (clouds + trajectory), padded. */
    zExtent(): [number, number] {
        let low = Infinity, high = -Infinity
        const tmp = new THREE.Box3()
        for (const cloud of this.#clouds.values()) {
            if (!cloud.group.visible) {
                continue
            }
            for (const frame of cloud.frames) {
                frame.geom.computeBoundingBox()
                if (!frame.geom.boundingBox) {
                    continue
                }
                tmp.copy(frame.geom.boundingBox).applyMatrix4(frame.points.matrix)
                low = Math.min(low, tmp.min.z)
                high = Math.max(high, tmp.max.z)
            }
        }
        for (const odom of this.#odoms.values()) {
            if (!odom.trail.visible || !odom.count) {
                continue
            }
            const array = odom.geom.getAttribute("position").array
            for (let i = 0; i < odom.count; i++) {
                low = Math.min(low, array[i * 3 + 2])
                high = Math.max(high, array[i * 3 + 2])
            }
        }
        if (!isFinite(low) || !isFinite(high) || high - low < 0.1) {
            return [0, 3]
        }
        const pad = (high - low) * 0.04
        return [low - pad, high + pad]
    }

    setSlice(zMin: number | null, zMax: number | null) {
        const planes = []
        if (zMax !== null) {
            this.#zClipTop.constant = zMax
            planes.push(this.#zClipTop)
        }
        if (zMin !== null) {
            this.#zClipBottom.constant = -zMin
            planes.push(this.#zClipBottom)
        }
        this.renderer.clippingPlanes = planes
    }

    // ── floor markers ──
    floorPoint(clientX: number, clientY: number): THREE.Vector3 | null {
        const rect = this.renderer.domElement.getBoundingClientRect()
        const ndc = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
        )
        this.#raycaster.setFromCamera(ndc, this.camera)
        const hit = new THREE.Vector3()
        return this.#raycaster.ray.intersectPlane(this.#floorPlane, hit) ? hit : null
    }

    #makeMarker(x: number, y: number) {
        // ring + stalk + ball, depth-tested so nearer geometry occludes the pin
        const material = () => new THREE.MeshBasicMaterial({ color: 0xffcc33, side: THREE.DoubleSide })
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.19, 28), material())
        ring.position.z = 0.01
        const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 8), material())
        stalk.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1))
        stalk.position.z = 0.25
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), material())
        ball.position.z = 0.5
        const marker = new THREE.Group()
        marker.add(ring, stalk, ball)
        marker.position.set(x, y, 0)
        return marker
    }

    /** Shows exactly these markers (the backend's list). */
    setMarkers(markers: Marker[]) {
        const wanted = new Map(markers.map((marker) => [marker.id, marker]))
        for (const object of [...this.#markerGroup.children]) {
            if (!wanted.has(object.userData.id) && object !== this.#movingMarker) {
                this.#markerGroup.remove(object)
                object.traverse((child: any) => {
                    child.geometry?.dispose()
                    child.material?.dispose()
                })
            }
        }
        for (const marker of markers) {
            let object = this.#markerGroup.children.find((child) => child.userData.id === marker.id)
            if (!object) {
                object = this.#makeMarker(marker.x, marker.y)
                object.userData.id = marker.id
                this.#markerGroup.add(object)
            } else if (object !== this.#movingMarker) {
                object.position.set(marker.x, marker.y, 0)
            }
        }
    }

    #pickMarkerAt(clientX: number, clientY: number): THREE.Object3D | null {
        const rect = this.renderer.domElement.getBoundingClientRect()
        const ndc = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
        )
        this.#raycaster.setFromCamera(ndc, this.camera)
        const hits = this.#raycaster.intersectObjects(this.#markerGroup.children, true)
        if (hits.length) {
            let object = hits[0].object
            while (object.parent && object.parent !== this.#markerGroup) {
                object = object.parent
            }
            return object
        }
        // thin geometry can be missed: also take the nearest pin near where the ray meets the floor
        const point = this.floorPoint(clientX, clientY)
        if (!point) {
            return null
        }
        let nearest: THREE.Object3D | null = null, nearestDist = 0.45
        for (const marker of this.#markerGroup.children) {
            const dist = Math.hypot(marker.position.x - point.x, marker.position.y - point.y)
            if (dist < nearestDist) {
                nearestDist = dist
                nearest = marker
            }
        }
        return nearest
    }

    startMovingMarker(id: string) {
        const marker = this.#markerGroup.children.find((child) => child.userData.id === id)
        if (!marker) {
            return
        }
        this.#movingMarker = marker
        this.#movingMarkerOrigin = marker.position.clone()
        this.renderer.domElement.style.cursor = "grabbing"
    }

    #commitMovingMarker() {
        const marker = this.#movingMarker
        this.#movingMarker = null
        this.#movingMarkerOrigin = null
        this.renderer.domElement.style.cursor = ""
        if (marker) {
            this.on.markerMoved(String(marker.userData.id), marker.position.x, marker.position.y)
        }
    }

    cancelMovingMarker() {
        if (this.#movingMarker && this.#movingMarkerOrigin) {
            this.#movingMarker.position.copy(this.#movingMarkerOrigin)
        }
        this.#movingMarker = null
        this.#movingMarkerOrigin = null
        this.renderer.domElement.style.cursor = ""
    }

    // ── tf tree: child → { parent, T_parent_child } ──
    #setTf(parent: string, child: string, translation: number[], rotation: number[]) {
        const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(translation[0], translation[1], translation[2]),
            new THREE.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
            new THREE.Vector3(1, 1, 1),
        )
        this.#tf.set(child, { parent, matrix })
        this.#tfParents.add(parent)
        this.#tfDirty = true
    }

    #worldMatrix(frame: string) {
        const chain = []
        let current = frame, guard = 0
        while (current && this.#tf.has(current) && guard++ < 64) {
            const edge = this.#tf.get(current)!
            chain.push(edge.matrix)
            current = edge.parent
        }
        const matrix = new THREE.Matrix4()
        for (let i = chain.length - 1; i >= 0; i--) {
            matrix.multiply(chain[i])
        }
        return matrix
    }

    #isGlobalFrame(frame: string) {
        return GLOBAL_FRAME_NAMES.test(frame) || (this.#tfParents.has(frame) && !this.#tf.has(frame))
    }

    /** The tf widget is open: draw a small basis triad at every frame (a hovered one bigger). */
    setTfAxes(visible: boolean, hovered: string | null) {
        this.#tfAxesGroup.visible = visible
        this.#tfHovered = hovered
        this.#syncTfAxes()
    }

    #syncTfAxes() {
        if (!this.#tfAxesGroup.visible) {
            return
        }
        const live = new Set([...this.#tf.keys(), ...this.#tfParents])
        for (const [frame, triad] of this.#tfAxes) {
            if (!live.has(frame)) {
                this.#tfAxesGroup.remove(triad)
                this.#tfAxes.delete(frame)
            }
        }
        for (const frame of live) {
            let triad = this.#tfAxes.get(frame)
            if (!triad) {
                triad = this.#makeAxes(TF_AXIS_LEN, TF_AXIS_LEN * 0.035)
                triad.matrixAutoUpdate = false
                this.#tfAxesGroup.add(triad)
                this.#tfAxes.set(frame, triad)
            }
            const scale = frame === this.#tfHovered ? 3.5 : 1
            triad.matrix.copy(this.#worldMatrix(frame)).scale(new THREE.Vector3(scale, scale, scale))
        }
    }

    // ── stream styles (from the backend) ──
    #styleOf(name: string): Style {
        return this.#styles.get(name.split("#")[0]) ?? {}
    }

    /** Every style the backend has (on load). */
    setStyles(styles: Record<string, Style>) {
        this.#styles = new Map(Object.entries(styles))
        for (const name of this.known.keys()) {
            this.#restyle(name)
        }
    }

    /** One stream's style changed (by this page, another page or the agent). */
    setStyle(key: string, style: Style) {
        this.#styles.set(key, style)
        for (const name of this.known.keys()) {
            if (name.split("#")[0] === key) {
                this.#restyle(name)
            }
        }
    }

    /** While the customize popup is open on a big cloud, de-noise rebuilds wait for it to close. */
    deferHeavyRebuilds(stream: string | null) {
        this.#deferStream = stream
        if (!stream && this.#pendingHeavyRebuild) {
            const cloud = this.#clouds.get(this.#pendingHeavyRebuild)
            this.#pendingHeavyRebuild = null
            if (cloud) {
                this.#applyCloudDisplay(cloud)
            }
        }
    }

    get heavyRebuildPending() {
        return this.#pendingHeavyRebuild !== null
    }

    #defaults(name: string, kind: string, anchored: boolean): StreamEntry {
        const entry: StreamEntry = { kind, on: anchored }
        if (kind === "cloud") {
            const used = [...this.known.values()].filter((other) => other.kind === "cloud").length
            const pair = GRAD_PAIRS[used % GRAD_PAIRS.length]
            Object.assign(entry, {
                gradStart: pair[0],
                gradEnd: pair[1],
                axis: 2,
                accum: "latest",
                downsample: 1,
                rangeMax: 0,
                zMin: null,
                zMax: null,
                denoise: false,
                denoiseCell: 0.12,
                denoiseMin: 4,
                voxel: true,
                voxelSize: 0.1,
            })
        }
        if (kind === "odom") {
            entry.accum = "all"
        }
        return Object.assign(entry, this.#styleOf(name))
    }

    #restyle(name: string) {
        const current = this.known.get(name)
        if (!current) {
            return
        }
        const before = { ...current }
        const anchored = current.anchored !== false
        const next = this.#defaults(name, current.kind, anchored)
        next.anchored = current.anchored
        // keep the default gradient this stream was first given
        if (current.kind === "cloud" && !this.#styleOf(name).gradStart) {
            next.gradStart = before.gradStart
            next.gradEnd = before.gradEnd
        }
        this.known.set(name, next)
        const cloud = this.#clouds.get(name)
        if (cloud) {
            const changed = (keys: string[]) => keys.some((key) => before[key] !== next[key])
            if (changed(["downsample", "rangeMax", "zMin", "zMax", "denoise", "denoiseCell", "denoiseMin"])) {
                if (next.denoise && this.#deferStream === name && this.#cloudPointCount(cloud) > DENOISE_DEFER_POINTS) {
                    this.#pendingHeavyRebuild = name
                } else {
                    this.#applyCloudDisplay(cloud)
                }
            } else if (changed(["gradStart", "gradMid", "gradEnd", "axis", "voxel", "voxelSize"])) {
                this.#recolor(cloud)
            }
        }
        this.#setVisible(name, next.on)
        const odom = this.#odoms.get(name)
        if (odom) {
            this.#updateOdomTrailDisplay(odom, name, odom.lastTs ?? 0)
        }
        this.on.streams(this.known)
    }

    #addStream(name: string, kind: string, anchored = true) {
        const current = this.known.get(name)
        if (!current) {
            const entry = this.#defaults(name, kind, anchored)
            entry.anchored = anchored
            this.known.set(name, entry)
            this.on.streams(this.known)
        } else if (current.kind !== kind) {
            current.kind = kind
            this.#restyle(name)
        }
        if (this.known.get(name)?.on === false) {
            this.#setVisible(name, false)
        }
    }

    #setVisible(name: string, on: boolean) {
        const cloud = this.#clouds.get(name)
        if (cloud) {
            cloud.group.visible = on
        }
        const odom = this.#odoms.get(name)
        if (odom) {
            odom.group.visible = on
            odom.trail.visible = on && (this.known.get(name)?.accum || "all") !== "latest"
        }
        const path = this.#paths.get(name)
        if (path) {
            path.line.visible = on
        }
        const win = this.#imageWindows.get(name)
        if (win) {
            win.el.style.display = on ? "flex" : "none"
        }
    }

    // ── point clouds: each stream a group of frames ("latest" keeps one; accumulation keeps a window / capped history) ──
    #ensureCloud(stream: string): Cloud {
        let cloud = this.#clouds.get(stream)
        if (cloud) {
            return cloud
        }
        const material = new THREE.PointsMaterial({ size: 0.04, vertexColors: true, sizeAttenuation: true })
        // round dots instead of squares, with the same distance dimming as the voxels
        material.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace("#include <common>", "#include <common>\nvarying float vPointViewDepth;")
                .replace("#include <project_vertex>", "#include <project_vertex>\nvPointViewDepth = -mvPosition.z;")
            shader.fragmentShader = shader.fragmentShader
                .replace("#include <common>", "#include <common>\nvarying float vPointViewDepth;")
                .replace("void main() {", "void main() {\n  if (length(gl_PointCoord - vec2(0.5)) > 0.5) { discard; }")
                .replace(
                    "#include <premultiplied_alpha_fragment>",
                    "float pointDepthX = clamp((vPointViewDepth - " + VOXEL_DEPTH_NEAR.toFixed(3) + ") / (" +
                        VOXEL_DEPTH_FAR.toFixed(3) + " - " + VOXEL_DEPTH_NEAR.toFixed(3) + "), 0.0, 1.0);\n" +
                        "float pointDepthT = 1.0 - pow(1.0 - pointDepthX, " + VOXEL_DEPTH_EASE.toFixed(3) + ");\n" +
                        "gl_FragColor.rgb *= mix(1.0, " + VOXEL_DEPTH_FLOOR.toFixed(3) +
                        ", pointDepthT);\n#include <premultiplied_alpha_fragment>",
                )
        }
        const group = new THREE.Group()
        this.scene.add(group)
        cloud = { group, material, frames: [], frame: "", stream }
        this.#clouds.set(stream, cloud)
        return cloud
    }

    #colorGeom(geom: THREE.BufferGeometry, entry: Style | undefined) {
        const position = geom.getAttribute("position")
        if (!position || !position.count) {
            return
        }
        const color = geom.getAttribute("color") as THREE.BufferAttribute
        const array = position.array, count = position.count
        const axisIdx = entry?.axis ?? 2
        let low = Infinity, high = -Infinity
        for (let i = 0; i < count; i++) {
            const value = array[i * 3 + axisIdx]
            low = Math.min(low, value)
            high = Math.max(high, value)
        }
        const span = high > low ? high - low : 1
        const stops = gradStops(entry)
        const colors = color.array
        for (let i = 0; i < count; i++) {
            const [r, g, b] = gradColorAt(stops, clamp01((array[i * 3 + axisIdx] - low) / span))
            colors[i * 3] = r
            colors[i * 3 + 1] = g
            colors[i * 3 + 2] = b
        }
        color.needsUpdate = true
    }

    #rebuildFrameGeom(frame: CloudFrame, entry: Style | undefined) {
        const kept = computeKeptLocal(frame.rawXyz, entry, frame.points.matrix.elements)
        const geom = new THREE.BufferGeometry()
        geom.setAttribute("position", new THREE.BufferAttribute(kept, 3))
        geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(kept.length), 3))
        geom.computeBoundingSphere()
        this.#colorGeom(geom, entry)
        frame.geom?.dispose()
        frame.geom = geom
        frame.points.geometry = geom
    }

    #applyCloudDisplay(cloud: Cloud) {
        const entry = this.known.get(cloud.stream)
        for (const frame of cloud.frames) {
            this.#rebuildFrameGeom(frame, entry)
        }
        this.#syncCloud(cloud, true)
    }

    #cloudPointCount(cloud: Cloud) {
        return cloud.frames.reduce((total, frame) => total + frame.rawXyz.length / 3, 0)
    }

    #applyVoxelShading(material: THREE.Material) {
        material.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace(
                    "#include <common>",
                    "#include <common>\nvarying float vVoxelViewDepth;\nvarying vec3 vVoxelPureColor;",
                )
                .replace("#include <color_vertex>", "#include <color_vertex>\nvVoxelPureColor = vColor;")
                .replace("#include <project_vertex>", "#include <project_vertex>\nvVoxelViewDepth = -mvPosition.z;")
            shader.fragmentShader = shader.fragmentShader
                .replace(
                    "#include <common>",
                    "#include <common>\nvarying float vVoxelViewDepth;\nvarying vec3 vVoxelPureColor;",
                )
                .replace(
                    "#include <dithering_fragment>",
                    "gl_FragColor.rgb = mix(gl_FragColor.rgb, vVoxelPureColor, " + VOXEL_VIBRANCY.toFixed(3) + ");\n" +
                        "float voxelDepthX = clamp((vVoxelViewDepth - " + VOXEL_DEPTH_NEAR.toFixed(3) + ") / (" +
                        VOXEL_DEPTH_FAR.toFixed(3) + " - " + VOXEL_DEPTH_NEAR.toFixed(3) + "), 0.0, 1.0);\n" +
                        "float voxelDepthT = 1.0 - pow(1.0 - voxelDepthX, " + VOXEL_DEPTH_EASE.toFixed(3) + ");\n" +
                        "float voxelDepthDim = mix(1.0, " + VOXEL_DEPTH_FLOOR.toFixed(3) + ", voxelDepthT);\n" +
                        "gl_FragColor.rgb *= voxelDepthDim;\n#include <dithering_fragment>",
                )
        }
    }

    // One instanced cube per occupied cell, quantized in WORLD space so every accumulated frame shares one lattice.
    #buildFrameVoxels(cloud: Cloud, frame: CloudFrame, entry: Style) {
        const position = frame.geom.getAttribute("position")
        if (!position || !position.count) {
            return
        }
        const array = position.array, count = position.count
        const size = entry.voxelSize || 0.1, inv = 1 / size
        const pose = frame.points.matrix.elements
        const cells = new Map<string, number[]>()
        for (let i = 0; i < count; i++) {
            const x = array[i * 3], y = array[i * 3 + 1], z = array[i * 3 + 2]
            const wx = pose[0] * x + pose[4] * y + pose[8] * z + pose[12]
            const wy = pose[1] * x + pose[5] * y + pose[9] * z + pose[13]
            const wz = pose[2] * x + pose[6] * y + pose[10] * z + pose[14]
            const ix = Math.floor(wx * inv), iy = Math.floor(wy * inv), iz = Math.floor(wz * inv)
            const key = ix + "," + iy + "," + iz
            if (!cells.has(key)) {
                cells.set(key, [(ix + 0.5) * size, (iy + 0.5) * size, (iz + 0.5) * size])
            }
        }
        const centers = [...cells.values()]
        if (!centers.length) {
            return
        }
        const axisIdx = entry.axis ?? 2
        let low = Infinity, high = -Infinity
        for (const center of centers) {
            low = Math.min(low, center[axisIdx])
            high = Math.max(high, center[axisIdx])
        }
        const span = high > low ? high - low : 1
        const stops = gradStops(entry)
        const material = new THREE.MeshLambertMaterial()
        this.#applyVoxelShading(material)
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(size, size, size), material, centers.length)
        const matrix = new THREE.Matrix4(), color = new THREE.Color()
        for (let i = 0; i < centers.length; i++) {
            const center = centers[i]
            mesh.setMatrixAt(i, matrix.makeTranslation(center[0], center[1], center[2]))
            const [r, g, b] = gradColorAt(stops, clamp01((center[axisIdx] - low) / span))
            mesh.setColorAt(i, color.setRGB(r, g, b))
        }
        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) {
            mesh.instanceColor.needsUpdate = true
        }
        mesh.frustumCulled = false
        mesh.matrixAutoUpdate = false
        mesh.matrix.identity()
        cloud.group.add(mesh)
        frame.voxelMesh = mesh
    }

    #disposeFrameVoxels(cloud: Cloud, frame: CloudFrame) {
        if (!frame.voxelMesh) {
            return
        }
        cloud.group.remove(frame.voxelMesh)
        frame.voxelMesh.geometry.dispose()
        ;(frame.voxelMesh.material as THREE.Material).dispose()
        frame.voxelMesh.dispose()
        frame.voxelMesh = null
    }

    #syncCloud(cloud: Cloud, rebuild = false) {
        const entry = this.known.get(cloud.stream)
        const voxel = !!entry?.voxel
        for (const frame of cloud.frames) {
            if (voxel) {
                if (rebuild) {
                    this.#disposeFrameVoxels(cloud, frame)
                }
                if (!frame.voxelMesh) {
                    this.#buildFrameVoxels(cloud, frame, entry!)
                }
                if (frame.voxelMesh) {
                    frame.voxelMesh.visible = true
                }
                frame.points.visible = false
            } else {
                this.#disposeFrameVoxels(cloud, frame)
                frame.points.visible = true
            }
        }
    }

    #recolor(cloud: Cloud) {
        const entry = this.known.get(cloud.stream)
        for (const frame of cloud.frames) {
            this.#colorGeom(frame.geom, entry)
        }
        this.#syncCloud(cloud, true)
    }

    #disposeCloudFrame(cloud: Cloud, frame: CloudFrame) {
        cloud.group.remove(frame.points)
        frame.geom.dispose()
        this.#disposeFrameVoxels(cloud, frame)
    }

    #pruneCloudFrames(cloud: Cloud, latestTs: number) {
        const mode = this.known.get(cloud.stream)?.accum || "latest"
        if (mode === "latest") {
            while (cloud.frames.length > 1) {
                this.#disposeCloudFrame(cloud, cloud.frames.shift()!)
            }
        } else if (mode !== "all") {
            const windowSeconds = Number(mode)
            if (isFinite(windowSeconds) && windowSeconds > 0) {
                while (cloud.frames.length > 1 && (latestTs - cloud.frames[0].ts) > windowSeconds) {
                    this.#disposeCloudFrame(cloud, cloud.frames.shift()!)
                }
            }
        }
        while (cloud.frames.length > CLOUD_ACCUM_CAP) {
            this.#disposeCloudFrame(cloud, cloud.frames.shift()!)
        }
    }

    #onCloud(payload: any, bytes: Uint8Array) {
        const cloud = this.#ensureCloud(payload.stream)
        cloud.frame = payload.frame
        this.#addStream(payload.stream, "cloud") // before building, so the first frame sees the stream's style
        const rawXyz = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        const points = new THREE.Points(new THREE.BufferGeometry(), cloud.material)
        points.matrixAutoUpdate = false
        // Placement: the tf chain if tf knows the frame; identity for a global frame (already world coords); else ride
        // the robot's latest odometry so accumulated sensor-frame scans lay down a map instead of stacking at the origin.
        if (this.#tf.has(payload.frame)) {
            points.matrix.copy(this.#worldMatrix(payload.frame))
        } else if (this.#isGlobalFrame(payload.frame)) {
            points.matrix.identity()
        } else if (this.#lastOdomWorld) {
            points.matrix.copy(this.#lastOdomWorld)
        }
        cloud.group.add(points)
        const frame: CloudFrame = {
            ts: payload.ts ?? 0,
            points,
            geom: new THREE.BufferGeometry(),
            rawXyz,
            voxelMesh: null,
        }
        this.#rebuildFrameGeom(frame, this.known.get(cloud.stream))
        cloud.frames.push(frame)
        this.#pruneCloudFrames(cloud, frame.ts)
        this.#syncCloud(cloud)
        this.#fitDirty = true
    }

    // ── odometry / pose: body + gizmo + trail per stream. Only frame-anchored streams get a trail; a frameless pose
    // (tag detections) is a loose marker that never steers the camera. Trails are LineSegments so a jump leaves a gap. ──
    #ensureOdom(stream: string): Odom {
        let odom = this.#odoms.get(stream)
        if (odom) {
            return odom
        }
        const color = TRAIL_COLORS[this.#odoms.size % TRAIL_COLORS.length]
        const group = new THREE.Group()
        group.matrixAutoUpdate = false
        const body = this.#makeBoxWireframe(0.5, 0.28, 0.22, color, 0.012)
        body.position.z = 0.11
        group.add(body)
        group.add(this.#makeAxes(0.6, 0.012))
        const geom = new THREE.BufferGeometry()
        geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * TRAIL_CAP), 3))
        geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * TRAIL_CAP), 3))
        geom.setDrawRange(0, 0)
        // per-vertex colors fade from a dim start to the full stream color, so the path reads start → finish
        const trail = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }))
        this.scene.add(group)
        this.scene.add(trail)
        const endColor = new THREE.Color(color)
        odom = {
            group,
            trail,
            geom,
            tsArray: new Float64Array(TRAIL_CAP),
            count: 0,
            start: 0,
            last: null,
            lastTs: null,
            startColor: endColor.clone().multiplyScalar(0.2),
            endColor,
        }
        this.#odoms.set(stream, odom)
        return odom
    }

    // latest = no trail; all = the full path; seconds = the last N seconds (older segments skipped by the draw range)
    #updateOdomTrailDisplay(odom: Odom, stream: string, latestTs: number) {
        const entry = this.known.get(stream)
        const mode = entry?.accum || "all"
        if (mode === "latest") {
            odom.trail.visible = false
            return
        }
        odom.trail.visible = entry?.on !== false
        const windowSeconds = Number(mode)
        if (mode === "all" || !isFinite(windowSeconds) || windowSeconds <= 0) {
            odom.start = 0
            odom.geom.setDrawRange(0, odom.count)
            return
        }
        const cutoff = latestTs - windowSeconds
        while (odom.start + 2 < odom.count && odom.tsArray[odom.start] < cutoff) {
            odom.start += 2
        }
        odom.geom.setDrawRange(odom.start, Math.max(0, odom.count - odom.start))
    }

    #trailColorAt(odom: Odom, ts: number) {
        const timeline = this.timeline
        const t = timeline.t1 > timeline.t0 ? clamp01((ts - timeline.t0) / (timeline.t1 - timeline.t0)) : 0.5
        return odom.startColor.clone().lerp(odom.endColor, t)
    }

    #onOdom(payload: any) {
        const odom = this.#ensureOdom(payload.stream)
        const pose = new THREE.Matrix4().compose(
            new THREE.Vector3(payload.pos[0], payload.pos[1], payload.pos[2]),
            new THREE.Quaternion(payload.quat[0], payload.quat[1], payload.quat[2], payload.quat[3]),
            new THREE.Vector3(1, 1, 1),
        )
        const world = this.#worldMatrix(payload.frame).multiply(pose)
        odom.group.matrix.copy(world)
        const worldPosition = new THREE.Vector3().setFromMatrixPosition(world)
        const anchored = payload.frame !== ""
        if (anchored) {
            this.#lastOdomWorld = world.clone()
        }
        const step = odom.last ? odom.last.distanceTo(worldPosition) : Infinity
        const ts = payload.ts ?? 0
        if (anchored && odom.last && step <= TRAIL_JUMP) {
            // full buffer: compact away pruned segments if any, else stop growing
            if (odom.count + 2 > TRAIL_CAP && odom.start > 0) {
                const positions = odom.geom.getAttribute("position").array as Float32Array
                const colors = odom.geom.getAttribute("color").array as Float32Array
                positions.copyWithin(0, odom.start * 3, odom.count * 3)
                colors.copyWithin(0, odom.start * 3, odom.count * 3)
                odom.tsArray.copyWithin(0, odom.start, odom.count)
                odom.count -= odom.start
                odom.start = 0
            }
            if (odom.count + 2 <= TRAIL_CAP) {
                const array = odom.geom.getAttribute("position").array as Float32Array
                const base = odom.count * 3
                array.set(
                    [odom.last.x, odom.last.y, odom.last.z, worldPosition.x, worldPosition.y, worldPosition.z],
                    base,
                )
                const colors = odom.geom.getAttribute("color").array as Float32Array
                const from = this.#trailColorAt(odom, odom.lastTs ?? ts), to = this.#trailColorAt(odom, ts)
                colors.set([from.r, from.g, from.b, to.r, to.g, to.b], base)
                odom.tsArray[odom.count] = ts
                odom.tsArray[odom.count + 1] = ts
                odom.count += 2
                odom.geom.getAttribute("position").needsUpdate = true
                odom.geom.getAttribute("color").needsUpdate = true
                this.#fitDirty = true
            }
        }
        odom.last = worldPosition
        odom.lastTs = ts
        this.#addStream(payload.stream, "odom", anchored)
        this.#updateOdomTrailDisplay(odom, payload.stream, ts)
    }

    // ── planned paths ──
    #onPath(payload: any, bytes: Uint8Array) {
        let path = this.#paths.get(payload.stream)
        if (!path) {
            const geom = new THREE.BufferGeometry()
            geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 8000), 3))
            geom.setDrawRange(0, 0)
            const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x7CFF6B }))
            line.matrixAutoUpdate = false
            this.scene.add(line)
            path = { line, geom }
            this.#paths.set(payload.stream, path)
        }
        const xyz = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        const capacity = path.geom.getAttribute("position") as THREE.BufferAttribute
        if (xyz.length > capacity.array.length) {
            path.geom.setAttribute("position", new THREE.BufferAttribute(xyz.slice(), 3))
        } else {
            ;(capacity.array as Float32Array).set(xyz)
            capacity.needsUpdate = true
        }
        path.geom.setDrawRange(0, xyz.length / 3)
        path.line.matrix.copy(this.#worldMatrix(payload.frame))
        this.#addStream(payload.stream, "path")
    }

    // ── floating image windows: each image stream its own draggable, resizable window over the 3D view ──
    #saveWindowGeometry(name: string, win: ImageWindow) {
        // a hidden window measures 0×0: saving then would bring it back invisible
        if (!win.el.offsetWidth || !win.el.offsetHeight) {
            return
        }
        const key = name.split("#")[0]
        this.#windowGeometry[key] = {
            ...this.#windowGeometry[key],
            winX: win.el.offsetLeft,
            winY: win.el.offsetTop,
            winW: win.el.offsetWidth,
            winH: win.el.offsetHeight,
        }
        try {
            localStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify(this.#windowGeometry))
        } catch { /* storage full/blocked */ }
    }

    #toggleWindowCollapse(name: string, win: ImageWindow) {
        const collapsed = !win.el.classList.contains("collapsed")
        if (collapsed) {
            win.expandedHeight = win.el.style.height || (win.el.offsetHeight + "px")
            win.el.classList.add("collapsed")
            win.el.style.height = ""
        } else {
            win.el.classList.remove("collapsed")
            if (win.expandedHeight) {
                win.el.style.height = win.expandedHeight
            }
        }
        const key = name.split("#")[0]
        this.#windowGeometry[key] = { ...this.#windowGeometry[key], winCollapsed: collapsed }
        try {
            localStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify(this.#windowGeometry))
        } catch { /* storage full/blocked */ }
    }

    #ensureImageWindow(name: string): ImageWindow {
        const existing = this.#imageWindows.get(name)
        if (existing) {
            return existing
        }
        const saved = this.#windowGeometry[name.split("#")[0]] ?? {}
        const el = document.createElement("div")
        el.className = "cam-win dim-panel glass"
        el.innerHTML = '<div class="cam-head"><span class="cam-title"></span><span class="cam-badge"></span>' +
            '<button class="cam-close dim-btn ghost icon" title="Hide">' + dimIcon("close") +
            '</button></div><div class="cam-body"><canvas></canvas></div>'
        el.querySelector(".cam-title")!.textContent = name.split("#")[0]
        const canvas = el.querySelector("canvas")!
        // restored geometry is clamped to the viewport; a non-positive saved size is dropped
        const layerWidth = this.camLayer.clientWidth, layerHeight = this.camLayer.clientHeight
        if (saved.winW > 0 && saved.winH > 0) {
            el.style.width = Math.min(saved.winW, layerWidth) + "px"
            el.style.height = Math.min(saved.winH, layerHeight) + "px"
        }
        if (Number.isFinite(saved.winX)) {
            el.style.left = Math.max(0, Math.min(saved.winX, layerWidth - 40)) + "px"
            el.style.top = Math.max(0, Math.min(saved.winY, layerHeight - 24)) + "px"
        } else {
            const offset = 18 * (this.#camCascade++ % 6)
            el.style.right = (14 + offset) + "px"
            el.style.top = (60 + offset) + "px"
        }
        this.camLayer.appendChild(el)
        const win: ImageWindow = {
            el,
            canvas,
            ctx: canvas.getContext("2d")!,
            badgeEl: el.querySelector(".cam-badge")!,
            raw: null,
        }
        this.#imageWindows.set(name, win)
        el.querySelector(".cam-close")!.addEventListener("click", (event) => {
            event.stopPropagation()
            el.style.display = "none"
            this.on.hideStream(name)
        })
        const head = el.querySelector(".cam-head") as HTMLElement
        head.addEventListener("pointerdown", (event) => {
            if ((event.target as HTMLElement).closest(".cam-close")) {
                return
            }
            event.preventDefault()
            const rect = el.getBoundingClientRect(), parent = this.camLayer.getBoundingClientRect()
            el.style.left = (rect.left - parent.left) + "px"
            el.style.top = (rect.top - parent.top) + "px"
            el.style.right = "auto"
            const startX = event.clientX, startY = event.clientY, baseLeft = el.offsetLeft, baseTop = el.offsetTop
            let dragged = false
            head.setPointerCapture(event.pointerId)
            const move = (moveEvent: PointerEvent) => {
                if (!dragged && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 4) {
                    return
                }
                dragged = true // a real move; under the threshold it stays a click
                const maxLeft = this.camLayer.clientWidth - 40, maxTop = this.camLayer.clientHeight - 24
                el.style.left = Math.max(0, Math.min(maxLeft, baseLeft + moveEvent.clientX - startX)) + "px"
                el.style.top = Math.max(0, Math.min(maxTop, baseTop + moveEvent.clientY - startY)) + "px"
            }
            const up = () => {
                head.releasePointerCapture(event.pointerId)
                head.removeEventListener("pointermove", move)
                head.removeEventListener("pointerup", up)
                if (dragged) {
                    this.#saveWindowGeometry(name, win)
                } else {
                    this.#toggleWindowCollapse(name, win)
                }
            }
            head.addEventListener("pointermove", move)
            head.addEventListener("pointerup", up)
        })
        if (saved.winCollapsed) {
            el.classList.add("collapsed")
            el.style.height = ""
        }
        let resizeTimer: ReturnType<typeof setTimeout> | undefined
        new ResizeObserver(() => {
            clearTimeout(resizeTimer)
            resizeTimer = setTimeout(() => this.#saveWindowGeometry(name, win), 250)
        }).observe(el)
        return win
    }

    #decodeImage(payload: any, bytes: Uint8Array, onLoad: (image: HTMLImageElement) => void) {
        const image = new Image()
        image.onload = () => {
            URL.revokeObjectURL(image.src)
            onLoad(image)
        }
        const format = String(payload.format || "jpeg").replace(/[^a-z0-9]/gi, "") || "jpeg"
        image.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: `image/${format}` }))
    }

    #fitCanvas(win: ImageWindow, width: number, height: number) {
        if (win.canvas.width !== width || win.canvas.height !== height) {
            win.canvas.width = width
            win.canvas.height = height
            win.raw = null
        }
        win.raw ??= win.ctx.createImageData(width, height)
        return win.raw.data
    }

    // JPEG/PNG depth arrives as 8-bit grayscale: re-color it through the jet ramp so it reads as depth
    #drawCompressedDepth(win: ImageWindow, payload: any, bytes: Uint8Array) {
        this.#decodeImage(payload, bytes, (image) => {
            const width = image.width, height = image.height
            win.decodeCanvas ??= document.createElement("canvas")
            win.decodeCanvas.width = width
            win.decodeCanvas.height = height
            const decodeCtx = win.decodeCanvas.getContext("2d", { willReadFrequently: true })!
            decodeCtx.drawImage(image, 0, 0)
            const source = decodeCtx.getImageData(0, 0, width, height).data
            const histogram = new Uint32Array(256)
            let valid = 0
            for (let i = 0; i < source.length; i += 4) {
                if (source[i] > 0) {
                    histogram[source[i]]++
                    valid++
                }
            }
            const [low, high] = percentileRange(histogram, 0, 256, valid)
            const span = high > low ? high - low : 1
            const destination = this.#fitCanvas(win, width, height)
            for (let i = 0; i < source.length; i += 4) {
                const gray = source[i]
                const [r, g, b] = gray > 0 ? jetColor((gray - low) / span) : [0, 0, 0]
                destination[i] = r
                destination[i + 1] = g
                destination[i + 2] = b
                destination[i + 3] = 255
            }
            win.ctx.putImageData(win.raw!, 0, 0)
        })
    }

    #drawColorImage(win: ImageWindow, payload: any, bytes: Uint8Array) {
        if (payload.kind === "compressed") {
            this.#decodeImage(payload, bytes, (image) => {
                this.#fitCanvas(win, image.width, image.height)
                win.ctx.drawImage(image, 0, 0)
            })
            return
        }
        const width = payload.width, height = payload.height
        if (!width || !height) {
            return
        }
        const encoding = (payload.encoding || "rgb8").toLowerCase()
        const channels = encoding === "rgba8" || encoding === "bgra8" ? 4 : encoding === "mono8" ? 1 : 3
        const step = payload.step || width * channels
        const destination = this.#fitCanvas(win, width, height)
        const isBgr = encoding === "bgr8" || encoding === "bgra8"
        for (let y = 0; y < height; y++) {
            let sourceIndex = y * step, destIndex = y * width * 4
            for (let x = 0; x < width; x++) {
                if (channels === 1) {
                    const value = bytes[sourceIndex]
                    destination[destIndex] = destination[destIndex + 1] = destination[destIndex + 2] = value
                    sourceIndex += 1
                } else {
                    destination[destIndex] = bytes[sourceIndex + (isBgr ? 2 : 0)]
                    destination[destIndex + 1] = bytes[sourceIndex + 1]
                    destination[destIndex + 2] = bytes[sourceIndex + (isBgr ? 0 : 2)]
                    sourceIndex += channels
                }
                destination[destIndex + 3] = 255
                destIndex += 4
            }
        }
        win.ctx.putImageData(win.raw!, 0, 0)
    }

    #drawDepthImage(win: ImageWindow, payload: any, bytes: Uint8Array) {
        const width = payload.width, height = payload.height
        if (!width || !height) {
            return
        }
        const isFloat = String(payload.encoding || "").toLowerCase() === "32fc1"
        const littleEndian = !payload.bigendian
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const bytesPerPixel = isFloat ? 4 : 2
        const step = payload.step || width * bytesPerPixel
        const readAt = (offset: number) =>
            isFloat ? view.getFloat32(offset, littleEndian) : view.getUint16(offset, littleEndian)
        let minimum = Infinity, maximum = -Infinity
        for (let y = 0; y < height; y++) {
            for (let x = 0, offset = y * step; x < width; x++, offset += bytesPerPixel) {
                const value = readAt(offset)
                if (value > 0 && Number.isFinite(value)) {
                    minimum = Math.min(minimum, value)
                    maximum = Math.max(maximum, value)
                }
            }
        }
        const histogram = new Uint32Array(512)
        const binScale = maximum > minimum ? histogram.length / (maximum - minimum) : 0
        let valid = 0
        for (let y = 0; y < height; y++) {
            for (let x = 0, offset = y * step; x < width; x++, offset += bytesPerPixel) {
                const value = readAt(offset)
                if (value > 0 && Number.isFinite(value)) {
                    histogram[Math.min(histogram.length - 1, ((value - minimum) * binScale) | 0)]++
                    valid++
                }
            }
        }
        const [low, high] = percentileRange(histogram, minimum, maximum, valid)
        const span = high > low ? high - low : 1
        const destination = this.#fitCanvas(win, width, height)
        for (let y = 0; y < height; y++) {
            for (
                let x = 0, offset = y * step, destIndex = y * width * 4;
                x < width;
                x++, offset += bytesPerPixel, destIndex += 4
            ) {
                const value = readAt(offset)
                const [r, g, b] = value > 0 && Number.isFinite(value) ? jetColor(1 - (value - low) / span) : [0, 0, 0] // near = blue
                destination[destIndex] = r
                destination[destIndex + 1] = g
                destination[destIndex + 2] = b
                destination[destIndex + 3] = 255
            }
        }
        win.ctx.putImageData(win.raw!, 0, 0)
    }

    #onImage(payload: any, bytes: Uint8Array) {
        this.#addStream(payload.stream, "image")
        const win = this.#ensureImageWindow(payload.stream)
        const encoding = String(payload.encoding || "").toLowerCase()
        const depth = DEPTH_ENCODINGS.has(encoding) || /depth/i.test(payload.stream)
        win.badgeEl.textContent = depth ? "depth" : "color"
        const visible = this.known.get(payload.stream)?.on !== false
        win.el.style.display = visible ? "flex" : "none"
        if (!visible) {
            return // skip the decode while hidden
        }
        if (depth && payload.kind === "compressed") {
            this.#drawCompressedDepth(win, payload, bytes)
        } else if (depth) {
            this.#drawDepthImage(win, payload, bytes)
        } else {
            this.#drawColorImage(win, payload, bytes)
        }
    }

    // ── scene reset (seek) and a new recording (clears the stream list and windows too) ──
    #clearScene() {
        for (const cloud of this.#clouds.values()) {
            this.scene.remove(cloud.group)
            for (const frame of cloud.frames) {
                frame.geom.dispose()
                this.#disposeFrameVoxels(cloud, frame)
            }
            cloud.material.dispose()
        }
        this.#clouds.clear()
        for (const odom of this.#odoms.values()) {
            this.scene.remove(odom.group)
            this.scene.remove(odom.trail)
            odom.geom.dispose()
        }
        this.#odoms.clear()
        for (const path of this.#paths.values()) {
            this.scene.remove(path.line)
            path.geom.dispose()
        }
        this.#paths.clear()
        this.#tf.clear()
        this.#tfParents.clear()
        for (const triad of this.#tfAxes.values()) {
            this.#tfAxesGroup.remove(triad)
        }
        this.#tfAxes.clear()
        this.#tfDirty = true
        this.#lastOdomWorld = null
    }

    #onLoaded(name: string) {
        this.#clearScene()
        this.known.clear()
        this.#imageWindows.clear()
        this.camLayer.replaceChildren()
        this.#camCascade = 0
        this.#rebuilding = false
        this.#userMovedCamera = false
        this.#fitDirty = true
        this.on.streams(this.known)
        this.on.loaded(name)
    }

    /** One scene-stream frame (scene_stream.ts). */
    handle(kind: string, payload: any, bytes: Uint8Array | null) {
        if (kind === "loaded") {
            this.#onLoaded(payload.name)
        } else if (kind === "reset") {
            // a seek: keep the stream list and styles, rebuild the scene
            this.#clearScene()
            this.#rebuilding = true
        } else if (kind === "time") {
            this.timeline = { t0: payload.t0, t1: payload.t1, t: payload.t, playing: payload.playing }
            if (this.#rebuilding) { // paint the finished state now
                this.#rebuilding = false
                this.renderer.render(this.scene, this.camera)
            }
            this.on.time(payload)
        } else if (kind === "cloud" && bytes) {
            this.#onCloud(payload, bytes)
        } else if (kind === "odom") {
            this.#onOdom(payload)
        } else if (kind === "tf") {
            for (const transform of payload.transforms || []) {
                this.#setTf(transform.parent, transform.child, transform.t, transform.q)
            }
        } else if (kind === "path" && bytes) {
            this.#onPath(payload, bytes)
        } else if (kind === "frame" && bytes) {
            this.#onImage(payload, bytes)
        }
    }

    /** The view as an image (≤1280 px wide PNG, base64) plus the camera pose: what api/view returns. */
    snapshot() {
        this.renderer.render(this.scene, this.camera)
        const source = this.renderer.domElement
        const scale = Math.min(1, 1280 / source.width)
        const canvas = document.createElement("canvas")
        canvas.width = Math.round(source.width * scale)
        canvas.height = Math.round(source.height * scale)
        const ctx = canvas.getContext("2d")!
        ctx.fillStyle = this.#isDark() ? "#1b2230" : "#eef1f5"
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
        const forward = this.#viewDir()
        const position = this.camera.position
        return {
            view: { mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] },
            camera: {
                position: [position.x, position.y, position.z].map((v) => +v.toFixed(3)),
                target: [position.x + forward.x, position.y + forward.y, position.z + forward.z].map((v) =>
                    +v.toFixed(3)
                ),
                fovDegrees: +this.camera.fov.toFixed(1),
            },
            streams: [...this.known].map(([name, entry]) => ({ name, kind: entry.kind, on: entry.on })),
        }
    }
}
