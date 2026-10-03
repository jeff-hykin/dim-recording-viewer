# Mapper (dim-recording-viewer)

A [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) app that opens **recorded** DimOS stacks and builds
lidar maps from them. Open a dimos memory2 `.db`, an `.mcap` or a `.pc2.lcm` map and it plays back in 3D:

- **Robot / pose**: body + pose gizmo + odometry trail (`Odometry`, `PoseStamped`).
- **Point clouds**: placed through the tf tree, as points or voxels, gradient-colored, with accumulation and filters.
- **Planned paths** (`Path`) and **camera windows** (`Image` / `CompressedImage`, depth colorized).
- **Timeline**: play / pause, speed, seek. A tf report warns about streams that can't be placed.
- **Map building**: every scan of a cloud stream placed in the world and voxel-deduplicated (optionally column-carved
  and de-speckled), saved into the recording as `<stream>_aggregated`, exportable as a `.pc2.lcm`.

Every action is an HTTP endpoint (`backend/routes.ts`, listed in `dimos.yaml` under `agent:` and served as
`agent.json`), so Desktop's agent can drive it like the page does: `GET api/recordings`, `POST api/open`,
`POST api/seek`, `POST api/map/build`, `GET api/view` (the 3D view as an image), and so on.

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-recording-viewer
```

## Layout

- `backend/` (Deno): `routes.ts` (the endpoints), `playback.ts` (one recording at a time: builds a time-sorted timeline
  from the small `(id, ts)` columns / the mcap message index, decodes a blob only when the playhead reaches it, so a 30
  GB recording never loads into memory), `decode.ts` (messages → frames), `scene.ts` (the 3D frames on `api/scene/ws`),
  `files.ts` (Desktop's `GET /recordings`, `~/datasets`, recents, folder browsing), `mapper.ts`.
- `mapper/` (Rust): the map builder (SQLite, the dimos LCM codec, world transform, voxel dedup, carving, outlier
  removal). The heavy part, so it's native; the backend runs it as a subprocess and forwards its progress.
- `frontend/` (TypeScript + Vite + React, three.js): `viewer.ts` is the scene, `App.tsx` the page around it.

`nix build .#dimosApp` builds all three into `bin/dimos-app-server` (`.#mapper`, `.#frontend`, `.#backendModules`
separately).

## Develop

```sh
npm ci && (cd frontend && npm ci && npm run build)   # the backend's decoders; the page
nix build .#mapper -o result-mapper                  # the map builder the backend finds there
deno task dev                                        # http://localhost:8787
deno task test && deno task check                    # tests; types + dimos.yaml matches the routes
deno task check-endpoints --write                    # after changing routes.ts
```
