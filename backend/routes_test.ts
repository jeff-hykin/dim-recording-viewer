// Every route: what it does, and that it says why when it can't. Runs against a small recording made here (a lidar
// stream in a sensor frame, odometry, tf), the real Rust mapper (`nix build .#mapper -o result-mapper`), and a fake
// page on the events socket for the view.
import { assert, assertEquals, assertMatch } from "@std/assert"
import { DatabaseSync } from "node:sqlite"
import { geometry_msgs, nav_msgs, sensor_msgs, std_msgs, tf2_msgs } from "@dimos/msgs"

const dir = await Deno.makeTempDir({ prefix: "mapper_test_" })
Deno.env.set("DIMOS_APP_DATA", `${dir}/data`)
Deno.env.set("DIMOS_RECORDINGS_DIR", `${dir}/recordings`)
await Deno.mkdir(`${dir}/recordings`)
const recordingPath = `${dir}/recordings/tiny.db`

/** A memory2 recording: 20 lidar scans of a 1 m wall in lidar_link, the robot driving along x, tf odom → lidar_link. */
function writeRecording(path: string) {
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE _streams (name TEXT PRIMARY KEY, config TEXT)")
    const stream = (name: string, module: string) => {
        db.exec(
            `CREATE TABLE "${name}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL UNIQUE, value NUMERIC, pose_x REAL, pose_y REAL, pose_z REAL, pose_qx REAL, pose_qy REAL, pose_qz REAL, pose_qw REAL, tags BLOB)`,
        )
        db.exec(`CREATE TABLE "${name}_blob" (id INTEGER PRIMARY KEY, data BLOB NOT NULL)`)
        db.prepare("INSERT INTO _streams VALUES (?, ?)").run(
            name,
            JSON.stringify({ payload_module: module, codec_id: "lcm" }),
        )
    }
    stream("lidar", "dimos.msgs.sensor_msgs.PointCloud2.PointCloud2")
    stream("odom", "dimos.msgs.nav_msgs.Odometry.Odometry")
    stream("tf", "dimos.msgs.tf2_msgs.TFMessage.TFMessage")
    const header = (frame: string, ts: number) =>
        new std_msgs.Header({
            stamp: new std_msgs.Time({ sec: Math.floor(ts), nsec: Math.round((ts % 1) * 1e9) }),
            frame_id: frame,
        })
    const position = (x: number) => new geometry_msgs.Point({ x, y: 0, z: 0 })
    const identity = () => new geometry_msgs.Quaternion({ x: 0, y: 0, z: 0, w: 1 })
    const fields = ["x", "y", "z"].map((name, index) =>
        new sensor_msgs.PointField({ name, offset: index * 4, datatype: 7, count: 1 })
    )
    for (let i = 0; i < 20; i++) {
        const ts = 1000 + i * 0.5
        const x = i * 0.1
        const points = new Float32Array(3 * 50)
        for (let p = 0; p < 50; p++) {
            points.set([2, (p % 10) * 0.1, Math.floor(p / 10) * 0.2], p * 3)
        }
        const cloud = new sensor_msgs.PointCloud2({
            header: header("lidar_link", ts),
            height: 1,
            width: 50,
            fields_length: 3,
            fields,
            is_bigendian: false,
            point_step: 12,
            row_step: 600,
            data_length: 600,
            data: new Uint8Array(points.buffer),
            is_dense: true,
        })
        db.prepare(
            `INSERT INTO lidar (id, ts, pose_x, pose_y, pose_z, pose_qx, pose_qy, pose_qz, pose_qw) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 1)`,
        ).run(i + 1, ts, x)
        db.prepare(`INSERT INTO lidar_blob VALUES (?, ?)`).run(i + 1, cloud.encode())
        const pose = new geometry_msgs.Pose({ position: position(x), orientation: identity() })
        const odometry = new nav_msgs.Odometry({
            header: header("odom", ts),
            child_frame_id: "base_link",
            pose: new geometry_msgs.PoseWithCovariance({ pose, covariance: new Array(36).fill(0) }),
        })
        db.prepare(`INSERT INTO odom (id, ts) VALUES (?, ?)`).run(i + 1, ts + 0.01)
        db.prepare(`INSERT INTO odom_blob VALUES (?, ?)`).run(i + 1, odometry.encode())
        const tf = new tf2_msgs.TFMessage({
            transforms_length: 1,
            transforms: [
                new geometry_msgs.TransformStamped({
                    header: header("odom", ts),
                    child_frame_id: "lidar_link",
                    transform: new geometry_msgs.Transform({
                        translation: new geometry_msgs.Vector3({ x, y: 0, z: 0 }),
                        rotation: identity(),
                    }),
                }),
            ],
        })
        db.prepare(`INSERT INTO tf (id, ts) VALUES (?, ?)`).run(i + 1, ts - 0.01)
        db.prepare(`INSERT INTO tf_blob VALUES (?, ?)`).run(i + 1, tf.encode())
    }
    db.close()
}
writeRecording(recordingPath)

const { eventsSocket, handle } = await import("./http.ts")
const { DESCRIPTION, onPageMessage, routes } = await import("./routes.ts")

const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
        new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        routes,
        DESCRIPTION,
    )
    // deno-lint-ignore no-explicit-any
    return { status: response!.status, json: await response!.json() as any }
}

Deno.test("agent.json lists every route", async () => {
    const { json } = await call("GET", "agent.json")
    assertEquals(json.endpoints.length, routes.length)
    assert(json.endpoints.some((endpoint: { role?: string }) => endpoint.role === "view"))
    assert(json.endpoints.some((endpoint: { role?: string }) => endpoint.role === "context"))
})

Deno.test("nothing open: playback routes say so", async () => {
    for (
        const [method, path] of [["POST", "api/play"], ["POST", "api/pause"], ["GET", "api/tf-report"], [
            "POST",
            "api/map/export",
        ]]
    ) {
        const { status, json } = await call(method, path)
        assertEquals(status, 409, path)
        assertMatch(json.error, /No recording is open/)
    }
    assertEquals((await call("POST", "api/seek", { offset: 1 })).status, 409)
    assertEquals((await call("GET", "api/state")).json.recording, null)
    assertEquals((await call("GET", "api/nope")).status, 404)
})

Deno.test("recordings and files", async () => {
    const { json } = await call("GET", "api/recordings")
    assert(json.recordings.some((recording: { path: string }) => recording.path === recordingPath))
    const listing = await call("GET", `api/files?dir=${encodeURIComponent(`${dir}/recordings`)}`)
    assertEquals(listing.json.files.map((file: { name: string }) => file.name), ["tiny.db"])
    assertEquals((await call("GET", "api/files?dir=/no/such/dir")).status, 404)
})

Deno.test("open, play, seek, speed, close", async () => {
    assertEquals((await call("POST", "api/open", {})).status, 400) // path is required
    assertEquals((await call("POST", "api/open", { path: `${dir}/missing.db` })).status, 404)
    await Deno.writeTextFile(`${dir}/notes.txt`, "hi")
    assertEquals((await call("POST", "api/open", { path: `${dir}/notes.txt` })).status, 400)

    const opened = await call("POST", "api/open", { path: "tiny.db" }) // a bare name, as a drag-drop gives
    assertEquals(opened.status, 200)
    assertEquals(opened.json.recording.path, recordingPath)
    assertEquals(opened.json.recording.streams.map((stream: { name: string }) => stream.name).sort(), [
        "lidar",
        "odom",
        "tf",
    ])
    assertEquals(opened.json.tfReport.problems, [])
    const report = await call("GET", "api/tf-report")
    assert(report.json.treeLines.some((line: { frame: string }) => line.frame === "lidar_link"))

    const seek = await call("POST", "api/seek", { fraction: 0.5 })
    assertEquals(seek.json.t, opened.json.recording.t0 + opened.json.recording.duration / 2)
    assertEquals((await call("POST", "api/seek", { offset: 2 })).json.t, opened.json.recording.t0 + 2)
    assertEquals((await call("POST", "api/seek", {})).status, 400)
    assertEquals((await call("POST", "api/seek", { t: "soon" })).status, 400)

    assertEquals((await call("POST", "api/speed", { speed: 4 })).json.speed, 4)
    assertEquals((await call("POST", "api/speed", { speed: -1 })).status, 400)
    assertEquals((await call("POST", "api/play")).json.playing, true)
    assertEquals((await call("POST", "api/pause")).json.playing, false)
    assertEquals((await call("GET", "api/state")).json.recording.name, "tiny.db")

    assertEquals((await call("POST", "api/close")).json.ok, true)
    assertEquals((await call("GET", "api/state")).json.recording, null)
})

Deno.test("styles", async () => {
    const changed = await call("POST", "api/style", {
        stream: "lidar#2",
        voxel: false,
        accum: "5",
        gradStart: "#ff0000",
    })
    assertEquals(changed.json, { stream: "lidar", style: { voxel: false, accum: "5", gradStart: "#ff0000" } })
    assertEquals((await call("POST", "api/style", { stream: "lidar", accum: null })).json.style, {
        voxel: false,
        gradStart: "#ff0000",
    })
    assertEquals((await call("GET", "api/styles")).json.styles.lidar.voxel, false)
    assertEquals((await call("POST", "api/style", { stream: "lidar", sparkle: true })).status, 400)
    assertEquals((await call("POST", "api/style", { stream: "lidar", gradEnd: "red" })).status, 400)
    assertEquals((await call("POST", "api/style", { stream: "lidar", accum: "forever" })).status, 400)
    assertEquals((await call("POST", "api/style", { on: false })).status, 400)
})

Deno.test("camera, markers, slice", async () => {
    assertEquals((await call("POST", "api/camera", { preset: "top" })).json.ok, true)
    assertEquals((await call("POST", "api/camera", { position: [1, 2, 3], target: [0, 0, 0] })).json.ok, true)
    assertEquals((await call("POST", "api/camera", { preset: "sideways" })).status, 400)
    assertEquals((await call("POST", "api/camera", { position: [1, 2] })).status, 400)

    const marker = (await call("POST", "api/markers", { x: 1, y: 2, label: "door" })).json
    assertEquals([marker.x, marker.y, marker.label], [1, 2, "door"])
    assertEquals((await call("POST", "api/markers", { x: 1 })).status, 400)
    assertEquals((await call("PUT", `api/markers/${marker.id}`, { x: 3, y: 4 })).json.x, 3)
    assertEquals((await call("PUT", "api/markers/nope", { x: 3, y: 4 })).status, 404)
    assertEquals((await call("GET", "api/markers")).json.markers.length, 1)
    assertEquals((await call("DELETE", `api/markers/${marker.id}`)).json.ok, true)
    assertEquals((await call("DELETE", `api/markers/${marker.id}`)).status, 404)
    await call("POST", "api/markers", { x: 0, y: 0 })
    assertEquals((await call("DELETE", "api/markers")).json.ok, true)
    assertEquals((await call("GET", "api/markers")).json.markers, [])

    assertEquals((await call("POST", "api/slice", { zMax: 2.5 })).json, { zMin: null, zMax: 2.5 })
    assertEquals((await call("POST", "api/slice", { zMin: 3, zMax: 1 })).status, 400)
    assertEquals((await call("POST", "api/slice", {})).json, { zMin: null, zMax: null })
})

Deno.test("build a map, export it, open the export", async () => {
    await call("POST", "api/open", { path: recordingPath })
    assertEquals((await call("POST", "api/map/cancel")).status, 409)
    assertEquals((await call("POST", "api/map/build", { stream: "nope" })).status, 404)
    assertEquals((await call("POST", "api/map/build", { stream: "odom" })).status, 400)
    assertEquals((await call("POST", "api/map/build", { stream: "lidar", voxel: -1 })).status, 400)
    assertEquals((await call("POST", "api/map/export")).status, 400) // nothing built yet

    const built = await call("POST", "api/map/build", {
        stream: "lidar",
        voxel: 0.1,
        carve: false,
        outlier: false,
        wait: true,
    })
    assertEquals(built.status, 200, built.json.error)
    assertEquals(built.json.last.aggregated, "lidar_aggregated")
    assert(built.json.last.points > 0)
    // the recording was reopened with the new stream
    const state = (await call("GET", "api/state")).json
    assert(state.recording.streams.some((stream: { name: string }) => stream.name === "lidar_aggregated"))
    assertEquals((await call("GET", "api/map/status")).json.running, null)

    // a running build can be cancelled (a stand-in mapper that takes its time)
    await Deno.writeTextFile(`${dir}/slow-mapper`, "#!/bin/sh\nexec sleep 30\n")
    await Deno.chmod(`${dir}/slow-mapper`, 0o755)
    Deno.env.set("MAPPER_BIN", `${dir}/slow-mapper`)
    const started = await call("POST", "api/map/build", { stream: "lidar" })
    assertEquals(started.json.running.stream, "lidar")
    assertEquals((await call("POST", "api/map/build", { stream: "lidar" })).status, 409)
    const cancelled = await call("POST", "api/map/cancel")
    assertEquals([cancelled.json.running, cancelled.json.error], [null, null])
    Deno.env.delete("MAPPER_BIN")

    const exported = await call("POST", "api/map/export", {})
    assertEquals(exported.json.path, `${dir}/recordings/tiny.lidar_aggregated.pc2.lcm`)
    assertEquals((await call("POST", "api/map/export", {})).status, 409) // exists
    assertEquals((await call("POST", "api/map/export", { overwrite: true })).status, 200)
    const map = await call("POST", "api/open", { path: exported.json.path })
    assertEquals(map.json.recording.format, "pc2.lcm")
    assertEquals(map.json.recording.streams[0].rows, 1)
    assertEquals((await call("POST", "api/map/build", { stream: "tiny.lidar_aggregated" })).status, 409) // not a .db
})

Deno.test("view: asks the open page for its picture", async () => {
    assertEquals((await call("GET", "api/view")).status, 503) // no page
    const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => eventsSocket(request, onPageMessage))
    const page = new WebSocket(`ws://127.0.0.1:${server.addr.port}/`)
    page.onmessage = (message) => {
        const event = JSON.parse(message.data)
        if (event.type === "capture") {
            page.send(
                JSON.stringify({
                    type: "capture-answer",
                    request: event.request,
                    view: { mimeType: "image/png", data: "AAAA" },
                }),
            )
        }
    }
    await new Promise((resolve) => page.onopen = resolve)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const view = await call("GET", "api/view")
    assertEquals(view.json.view, { mimeType: "image/png", data: "AAAA" })
    assertEquals(view.json.type, undefined)
    const closed = new Promise((resolve) => page.onclose = resolve)
    page.close()
    await closed
    await new Promise((resolve) => setTimeout(resolve, 100)) // the server side of the socket closes too
    await server.shutdown()
})
