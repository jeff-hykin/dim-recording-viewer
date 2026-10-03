// Map building: every scan of a cloud stream accumulated into one world-frame map (dimos "map global"). The work is
// the Rust `mapper` (mapper/: SQLite read, the LCM codec dimos uses, world transform, voxel dedup, carving, outlier
// removal): it writes "<stream>_aggregated" back into the recording and prints newline-delimited JSON progress, which
// this side forwards. The binary is built by nix (`nix build .#mapper`); the app server is given its path.

export type BuildOptions = {
    voxel: number
    carve: boolean
    carveHeight: number
    carveGap: number
    outlier: boolean
    outlierMin: number
}

export type MapJob = {
    stream: string
    recording: string
    options: BuildOptions
    phase: string
    done: number
    total: number
    startedAt: number
}

export type MapResult = {
    stream: string
    aggregated: string
    points: number
    recording: string
    seconds: number
    at: number
}

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

/** The mapper binary: --mapper / MAPPER_BIN (nix sets it), else a dev build in mapper/. */
export function mapperBinary(): string | null {
    const repo = new URL("..", import.meta.url).pathname
    const candidates = [
        flag("mapper"),
        Deno.env.get("MAPPER_BIN"),
        `${repo}mapper/target/release/mapper`,
        `${repo}result-mapper/bin/mapper`,
    ]
    for (const path of candidates) {
        try {
            if (path && Deno.statSync(path).isFile) {
                return path
            }
        } catch { /* not here */ }
    }
    return null
}

export function mapperArgs(recording: string, stream: string, options: BuildOptions): string[] {
    const args = ["--db", recording, "--stream", stream, "--voxel", String(options.voxel)]
    if (options.carve) {
        args.push("--carve", "--carve-height", String(options.carveHeight), "--carve-gap", String(options.carveGap))
    }
    if (options.outlier) {
        args.push("--outlier", "--outlier-min", String(options.outlierMin))
    }
    return args
}

/** Runs one build; `onProgress` gets each phase. Resolves with the result, rejects with a readable error. */
export async function runMapper(
    binary: string,
    job: MapJob,
    onProgress: (job: MapJob) => void,
    signal: AbortSignal,
): Promise<{ aggregated: string; points: number }> {
    const child = new Deno.Command(binary, {
        args: mapperArgs(job.recording, job.stream, job.options),
        stdout: "piped",
        stderr: "piped",
    }).spawn()
    const kill = () => {
        try {
            child.kill("SIGTERM")
        } catch { /* already exited */ }
    }
    signal.addEventListener("abort", kill)
    const stderr = new Response(child.stderr).text()
    let done: { aggregated?: string; points?: number } | null = null
    let failure: string | null = null
    let buffered = ""
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        buffered += chunk
        let newline
        while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline).trim()
            buffered = buffered.slice(newline + 1)
            let event
            try {
                event = JSON.parse(line)
            } catch {
                continue
            }
            if (event.phase === "done") {
                done = event
            } else if (event.phase === "error") {
                failure = event.message || "mapper error"
            } else {
                job.phase = event.phase === "writing" ? "voxelizing" : event.phase
                job.done = event.done ?? 0
                job.total = event.total ?? 0
                onProgress(job)
            }
        }
    }
    const status = await child.status
    const errorText = await stderr
    signal.removeEventListener("abort", kill)
    if (signal.aborted) {
        throw new Error("cancelled")
    }
    if (failure) {
        throw new Error(failure)
    }
    if (!status.success || !done) {
        throw new Error(`mapper failed: ${errorText.slice(-400) || `exit ${status.code}, no output`}`)
    }
    return { aggregated: done.aggregated || `${job.stream}_aggregated`, points: done.points || 0 }
}
