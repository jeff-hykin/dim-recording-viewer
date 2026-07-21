# dim-recording-viewer

A [DimOS dashboard](https://github.com/jeff-hykin/dim-app) app that renders a
**recorded** DimOS stack in 3D. Drop (or browse to) a dimos "memory2" `.db`
recording and it plays back as a live 3D scene — the same way
[dim-live-viewer](https://github.com/jeff-hykin/dim-live-viewer) shows a *running*
stack, but sourced from a file on disk instead of the bridge.

- **Robot / pose** — body + pose gizmo + odometry trail (`Odometry`, `PoseStamped`).
- **Point clouds** — lidar / costmap, TF-placed and height-gradient colored (`PointCloud2`).
- **Planned paths** (`Path`) and the **camera PIP** (`Image` / `CompressedImage`).
- **TF tree** — every cloud/pose is transformed into a common world frame.
- **Scrubbable timeline** at the bottom: play / pause, speed, and seek anywhere.

Streams are discovered from the recording's `_streams` table and drawn by
**duck-typing the decoded message** — there is no hardcoded topic list.

## Install

```sh
dim install https://github.com/jeff-hykin/dim-recording-viewer
```

Open **Mapper** from the desktop rail, then drop a `.db` file or click
**Browse**.

## How it works

- `dim/apps/recording_viewer/main.js` — the backend half (runs in the Deno
  desktop). It opens the `.db` with `@db/sqlite`, scans only the small `(id, ts)`
  columns of every stream into typed arrays to build one merged, time-sorted
  timeline, then decodes each message with [`@dimos/msgs`](https://jsr.io/@dimos/msgs)
  **on demand** as the playhead reaches it. Message blobs live in separate
  `<stream>_blob` tables and are read straight off disk one at a time, so a
  30GB+ recording never loads into memory and never crosses the app bus.
- `dim/apps/recording_viewer/frontend/index.html` — the UI: a
  [three.js](https://threejs.org) scene (ROS Z-up) built from the forwarded
  frames, plus a transport bar that sends `play` / `pause` / `seek` / `speed`
  back to the backend.

### Loading a recording

Dropped files have their path stripped by the webview, and recordings are far
too large to send over the app bus, so:

- **Drag-drop** hands the backend the file *name*, which it resolves against the
  known recording folders (`~/datasets`, `~/datasets/go2_recordings`, …).
- **Browse** asks the backend to open a native file dialog (`osascript` on
  macOS, `zenity`/`kdialog` on Linux) and open the chosen path directly.

Either way the backend only ever holds a filesystem path; the bytes stay on disk.
