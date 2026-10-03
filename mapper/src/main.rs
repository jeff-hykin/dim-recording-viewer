// Lidar map aggregation engine (port of dimos "map global").
//
// Reads every scan of a PointCloud2 stream out of a memory2 SQLite recording,
// places each scan in the world frame, then deduplicates every point into a voxel
// grid so the accumulated map is a single presence-per-voxel cloud instead of
// hundreds of overlapping scans. The surviving point for a voxel is the running
// mean of every source point that fell in it (position + intensity). The result
// is written back into the same recording as a new "<stream>_aggregated" stream.
//
// This binary owns the whole pipeline: SQLite IO (rusqlite), the LCM codec
// (lcm-msgs, the same generated types dimos uses), the world transform, and the
// voxel aggregation. The Deno side only launches it via `nix run` and forwards
// the progress it prints.
//
// Progress + result are emitted as newline-delimited JSON on stdout, each line
// flushed immediately so the frontend can drive a live progress bar:
//   {"phase":"scanning","done":N,"total":M}   (M>0 → a real fraction; the bar fills here)
//   {"phase":"outlier"}                        (post passes are quick; shown as labels)
//   {"phase":"carving"}
//   {"phase":"writing"}
//   {"phase":"done","aggregated":"<name>","points":P}
//   {"phase":"error","message":"..."}          (also exits non-zero)
//
// args:
//   --db <path>          memory2 .db to read from and write back into (required)
//   --stream <name>      source cloud stream name (required)
//   --voxel <meters>     voxel edge length (default 0.05, matching dimos --voxel)
//   --out <name>         output stream name (default "<stream>_aggregated")
//   --carve              enable column carving (remove floaters above a vertical gap)
//   --carve-gap <meters> vertical gap that triggers carving (default 0.5)
//   --carve-min-run <n>  only carve floating runs shorter than n voxels (default 4)
//   --carve-height <m>   carve voxels more than m meters above the column floor (default 2.1336 = 7ft; 0 disables)
//   --outlier            enable radius outlier removal (drop isolated specks)
//   --outlier-min <n>    min occupied neighbors (3x3x3) to keep a voxel (default 3)

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::process::exit;

use lcm_msgs::sensor_msgs::{PointCloud2, PointField};
use lcm_msgs::std_msgs::{Header, Time};
use rusqlite::{Connection, OpenFlags};

const GLOBAL_FRAMES: [&str; 5] = ["world", "map", "odom", "earth", "global"];

struct Cell {
    sum_x: f64,
    sum_y: f64,
    sum_z: f64,
    sum_i: f64,
    count: u64,
}

struct Args {
    db: String,
    stream: String,
    voxel: f64,
    out: Option<String>,
    carve: bool,
    carve_gap: f64,
    carve_min_run: usize,
    carve_height: f64,
    outlier: bool,
    outlier_min: usize,
}

fn parse_args() -> Result<Args, String> {
    let mut db = None;
    let mut stream = None;
    let mut voxel = 0.05_f64;
    let mut out = None;
    let mut carve = false;
    let mut carve_gap = 0.5_f64;
    let mut carve_min_run = 4_usize;
    let mut carve_height = 2.1336_f64;
    let mut outlier = false;
    let mut outlier_min = 3_usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = args.next(),
            "--stream" => stream = args.next(),
            "--out" => out = args.next(),
            "--carve" => carve = true,
            "--outlier" => outlier = true,
            "--voxel" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<f64>() {
                        if parsed > 0.0 {
                            voxel = parsed;
                        }
                    }
                }
            }
            "--carve-gap" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<f64>() {
                        if parsed > 0.0 {
                            carve_gap = parsed;
                        }
                    }
                }
            }
            "--carve-min-run" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<usize>() {
                        if parsed > 0 {
                            carve_min_run = parsed;
                        }
                    }
                }
            }
            "--carve-height" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<f64>() {
                        if parsed >= 0.0 {
                            carve_height = parsed;
                        }
                    }
                }
            }
            "--outlier-min" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<usize>() {
                        outlier_min = parsed;
                    }
                }
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args {
        db: db.ok_or("--db is required")?,
        stream: stream.ok_or("--stream is required")?,
        voxel,
        out,
        carve,
        carve_gap,
        carve_min_run,
        carve_height,
        outlier,
        outlier_min,
    })
}

fn progress(json: &str) {
    println!("{json}");
    // stdout is block-buffered when piped (as it is under the Deno launcher), so
    // flush every line or the progress bar would only update in bursts / at the end.
    std::io::stdout().flush().ok();
}

fn fail(message: &str) -> ! {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    println!("{{\"phase\":\"error\",\"message\":\"{escaped}\"}}");
    exit(1);
}

/// Rotate a point by a quaternion (x, y, z, w) and translate. Mirrors the
/// frontend/Deno composeMatrix so a scan lands where the viewer would draw it.
fn transform_point(
    quaternion: [f64; 4],
    translation: [f64; 3],
    point: (f64, f64, f64),
) -> (f64, f64, f64) {
    let [qx, qy, qz, qw] = quaternion;
    let (xx, yy, zz) = (qx * qx, qy * qy, qz * qz);
    let (xy, xz, yz) = (qx * qy, qx * qz, qy * qz);
    let (wx, wy, wz) = (qw * qx, qw * qy, qw * qz);
    let (x, y, z) = point;
    let world_x = (1.0 - 2.0 * (yy + zz)) * x + 2.0 * (xy - wz) * y + 2.0 * (xz + wy) * z;
    let world_y = 2.0 * (xy + wz) * x + (1.0 - 2.0 * (xx + zz)) * y + 2.0 * (yz - wx) * z;
    let world_z = 2.0 * (xz - wy) * x + 2.0 * (yz + wx) * y + (1.0 - 2.0 * (xx + yy)) * z;
    (
        world_x + translation[0],
        world_y + translation[1],
        world_z + translation[2],
    )
}

/// Pull x/y/z/intensity out of a decoded PointCloud2, in source-frame order.
fn extract_xyzi(cloud: &PointCloud2) -> Vec<(f64, f64, f64, f64)> {
    let mut x_off = None;
    let mut y_off = None;
    let mut z_off = None;
    let mut i_off = None;
    for field in &cloud.fields {
        // FLOAT32 (7) and FLOAT64 (8) are the only layouts we read.
        let size = match field.datatype as i8 {
            PointField::FLOAT32 => 4,
            PointField::FLOAT64 => 8,
            _ => continue,
        };
        let slot = match field.name.as_str() {
            "x" => &mut x_off,
            "y" => &mut y_off,
            "z" => &mut z_off,
            "intensity" => &mut i_off,
            _ => continue,
        };
        *slot = Some((field.offset as usize, size));
    }
    let (Some(x_field), Some(y_field), Some(z_field)) = (x_off, y_off, z_off) else {
        return Vec::new();
    };
    let step = cloud.point_step as usize;
    if step == 0 || cloud.is_bigendian {
        return Vec::new();
    }
    let total = (cloud.width as usize).saturating_mul(cloud.height.max(1) as usize);
    let read = |offset_size: (usize, usize), base: usize| -> f64 {
        let (offset, size) = offset_size;
        let start = base + offset;
        if size == 8 {
            let bytes: [u8; 8] = cloud.data[start..start + 8].try_into().unwrap();
            f64::from_le_bytes(bytes)
        } else {
            let bytes: [u8; 4] = cloud.data[start..start + 4].try_into().unwrap();
            f32::from_le_bytes(bytes) as f64
        }
    };
    let mut out = Vec::with_capacity(total);
    for index in 0..total {
        let base = index * step;
        if base + step > cloud.data.len() {
            break;
        }
        let x = read(x_field, base);
        let y = read(y_field, base);
        let z = read(z_field, base);
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            continue;
        }
        let intensity = i_off.map(|field| read(field, base)).unwrap_or(0.0);
        out.push((x, y, z, intensity));
    }
    out
}

/// Radius outlier removal. Drop any voxel with fewer than `min_neighbors` occupied
/// voxels in its 26-neighborhood (the 3x3x3 cube around it, minus itself). Isolated
/// specks and thin floating strands vanish; dense surfaces (which have many in-plane
/// neighbors) are untouched. Operates on a snapshot of occupancy so removals don't
/// cascade within a single pass.
fn remove_outliers(grid: &mut HashMap<(i64, i64, i64), Cell>, min_neighbors: usize) {
    if min_neighbors == 0 {
        return;
    }
    let occupied: HashSet<(i64, i64, i64)> = grid.keys().copied().collect();
    let mut drop = Vec::new();
    for &(x, y, z) in &occupied {
        let mut neighbors = 0usize;
        'count: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if dx == 0 && dy == 0 && dz == 0 {
                        continue;
                    }
                    if occupied.contains(&(x + dx, y + dy, z + dz)) {
                        neighbors += 1;
                        if neighbors >= min_neighbors {
                            break 'count;
                        }
                    }
                }
            }
        }
        if neighbors < min_neighbors {
            drop.push((x, y, z));
        }
    }
    for key in drop {
        grid.remove(&key);
    }
}

/// Column carving. For each (x,y) column, split the occupied voxels into vertical
/// runs (groups of touching cells) and carve a run only when it BOTH floats above a
/// gap larger than `max_gap` cells AND is short (fewer than `min_run` voxels) — the
/// small hovering speckle clusters that outlier removal misses when they are locally
/// coplanar. Large surfaces (ceilings, beams, walls) are long runs and survive; the
/// lowest run in each column (ground) is always kept. Conservative by design so it
/// cleans clutter without gutting real structure.
///
/// If `max_height` > 0, every voxel more than `max_height` cells above its column's
/// lowest occupied voxel is also carved — a flat ceiling/overhead cutoff measured from
/// the local floor so uneven floors (ramps, steps) each keep their own head height.
fn carve_columns(grid: &mut HashMap<(i64, i64, i64), Cell>, max_gap: i64, min_run: usize, max_height: i64) {
    if max_gap < 1 || min_run == 0 {
        return;
    }
    let mut columns: HashMap<(i64, i64), Vec<i64>> = HashMap::new();
    for &(x, y, z) in grid.keys() {
        columns.entry((x, y)).or_default().push(z);
    }
    let mut drop = Vec::new();
    for ((x, y), mut zs) in columns {
        zs.sort_unstable();
        let floor = zs[0];
        // Height cap first: anything above (floor + max_height) is overhead clutter.
        if max_height > 0 {
            for &z in &zs {
                if z - floor > max_height {
                    drop.push((x, y, z));
                }
            }
        }
        // Walk the column bottom-up, tracking the current run's start index and the
        // gap to the previous run. Carve a completed run if it floated over a big gap
        // and is short. The first (lowest) run never carves.
        let mut run_start = 0usize;
        let mut prev_run_top: Option<i64> = None;
        let flush = |run: &[i64], prev_top: Option<i64>, drop: &mut Vec<(i64, i64, i64)>| {
            let floating = prev_top.map_or(false, |top| run[0] - top > max_gap);
            if floating && run.len() < min_run {
                for &z in run {
                    drop.push((x, y, z));
                }
            }
        };
        for i in 1..=zs.len() {
            let boundary = i == zs.len() || zs[i] - zs[i - 1] > 1;
            if boundary {
                let run = &zs[run_start..i];
                flush(run, prev_run_top, &mut drop);
                prev_run_top = Some(zs[i - 1]);
                run_start = i;
            }
        }
    }
    for key in drop {
        grid.remove(&key);
    }
}

/// Encode the aggregated voxel means into a PointCloud2 blob (x,y,z,intensity f32).
fn build_aggregated_blob(grid: &HashMap<(i64, i64, i64), Cell>, stamp: Time) -> (Vec<u8>, i32) {
    let point_count = grid.len() as i32;
    let mut data = Vec::with_capacity(grid.len() * 16);
    for cell in grid.values() {
        let inv = 1.0 / cell.count as f64;
        for value in [cell.sum_x, cell.sum_y, cell.sum_z, cell.sum_i] {
            data.extend_from_slice(&((value * inv) as f32).to_le_bytes());
        }
    }
    let field = |name: &str, offset: i32| PointField {
        name: name.to_string(),
        offset,
        datatype: PointField::FLOAT32 as u8,
        count: 1,
    };
    let cloud = PointCloud2 {
        header: Header {
            seq: 0,
            stamp,
            frame_id: "world".to_string(),
        },
        height: 1,
        width: point_count,
        fields: vec![
            field("x", 0),
            field("y", 4),
            field("z", 8),
            field("intensity", 12),
        ],
        is_bigendian: false,
        point_step: 16,
        row_step: 16 * point_count,
        data,
        is_dense: true,
    };
    (cloud.encode(), point_count)
}

struct ScanRow {
    id: i64,
    ts: f64,
    quaternion: Option<[f64; 4]>,
    translation: [f64; 3],
}

fn load_scan_rows(connection: &Connection, stream: &str) -> Result<Vec<ScanRow>, String> {
    let sql = format!(
        "SELECT id, ts, pose_x, pose_y, pose_z, pose_qx, pose_qy, pose_qz, pose_qw \
         FROM \"{stream}\" ORDER BY ts"
    );
    let mut statement = connection.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let quaternion = match (
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<f64>>(6)?,
                row.get::<_, Option<f64>>(7)?,
                row.get::<_, Option<f64>>(8)?,
            ) {
                (Some(qx), Some(qy), Some(qz), Some(qw)) => Some([qx, qy, qz, qw]),
                _ => None,
            };
            Ok(ScanRow {
                id: row.get(0)?,
                ts: row.get(1)?,
                translation: [
                    row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                    row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                ],
                quaternion,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn write_aggregated_stream(
    connection: &mut Connection,
    source: &str,
    out_name: &str,
    blob: &[u8],
    ts: f64,
) -> Result<(), String> {
    let source_config: Option<String> = connection
        .query_row(
            "SELECT config FROM _streams WHERE name=?1",
            [source],
            |row| row.get(0),
        )
        .ok();
    let config = aggregated_config(source_config.as_deref(), source);

    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute_batch(&format!(
            "DROP TABLE IF EXISTS \"{out_name}\";\
             DROP TABLE IF EXISTS \"{out_name}_blob\";\
             CREATE TABLE \"{out_name}\" (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL UNIQUE, value NUMERIC, pose_x REAL, pose_y REAL, pose_z REAL, pose_qx REAL, pose_qy REAL, pose_qz REAL, pose_qw REAL, tags BLOB DEFAULT (jsonb('{{}}')));\
             CREATE TABLE \"{out_name}_blob\" (id INTEGER PRIMARY KEY, data BLOB NOT NULL);"
        ))
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            &format!("INSERT INTO \"{out_name}\" (id, ts) VALUES (1, ?1)"),
            [ts],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            &format!("INSERT INTO \"{out_name}_blob\" (id, data) VALUES (1, ?1)"),
            [blob],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO _streams (name, config) VALUES (?1, ?2)",
            rusqlite::params![out_name, config],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reuse the source stream's config (so the loader treats the aggregated stream as
/// an LCM PointCloud2), tagging where it came from. Falls back to a minimal config.
fn aggregated_config(source_config: Option<&str>, source: &str) -> String {
    if let Some(text) = source_config {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text) {
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "aggregated_from".to_string(),
                    serde_json::Value::String(source.to_string()),
                );
                if let Ok(serialized) = serde_json::to_string(&value) {
                    return serialized;
                }
            }
        }
    }
    format!(
        "{{\"payload_module\":\"dimos.msgs.sensor_msgs.PointCloud2.PointCloud2\",\"codec_id\":\"lcm\",\"aggregated_from\":\"{source}\"}}"
    )
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => fail(&message),
    };
    let out_name = args
        .out
        .clone()
        .unwrap_or_else(|| format!("{}_aggregated", args.stream));

    let mut connection = Connection::open_with_flags(
        &args.db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap_or_else(|e| fail(&format!("cannot open db: {e}")));
    connection
        .busy_timeout(std::time::Duration::from_secs(30))
        .ok();

    let scans = load_scan_rows(&connection, &args.stream)
        .unwrap_or_else(|e| fail(&format!("cannot read stream rows: {e}")));
    if scans.is_empty() {
        fail(&format!("no scans found for {}", args.stream));
    }
    let total = scans.len();
    let t0 = scans[0].ts;
    progress(&format!(
        "{{\"phase\":\"scanning\",\"done\":0,\"total\":{total}}}"
    ));

    let mut blob_statement = connection
        .prepare(&format!("SELECT data FROM \"{}_blob\" WHERE id=?1", args.stream))
        .unwrap_or_else(|e| fail(&format!("cannot prepare blob read: {e}")));

    let inv_voxel = 1.0 / args.voxel;
    let mut grid: HashMap<(i64, i64, i64), Cell> = HashMap::new();
    let mut first_stamp: Option<Time> = None;

    for (index, scan) in scans.iter().enumerate() {
        let blob: Vec<u8> = match blob_statement.query_row([scan.id], |row| row.get(0)) {
            Ok(data) => data,
            Err(_) => continue,
        };
        let cloud = match PointCloud2::decode(&blob) {
            Ok(cloud) => cloud,
            Err(_) => continue,
        };
        if first_stamp.is_none() {
            first_stamp = Some(cloud.header.stamp.clone());
        }
        let frame = cloud.header.frame_id.to_ascii_lowercase();
        let is_global = GLOBAL_FRAMES.contains(&frame.as_str());
        let points = extract_xyzi(&cloud);
        for (x, y, z, intensity) in points {
            let (world_x, world_y, world_z) = if is_global {
                (x, y, z)
            } else if let Some(quaternion) = scan.quaternion {
                transform_point(quaternion, scan.translation, (x, y, z))
            } else {
                (x, y, z)
            };
            let key = (
                (world_x * inv_voxel).floor() as i64,
                (world_y * inv_voxel).floor() as i64,
                (world_z * inv_voxel).floor() as i64,
            );
            let cell = grid.entry(key).or_insert(Cell {
                sum_x: 0.0,
                sum_y: 0.0,
                sum_z: 0.0,
                sum_i: 0.0,
                count: 0,
            });
            cell.sum_x += world_x;
            cell.sum_y += world_y;
            cell.sum_z += world_z;
            cell.sum_i += intensity;
            cell.count += 1;
        }
        if index % 200 == 0 {
            progress(&format!(
                "{{\"phase\":\"scanning\",\"done\":{index},\"total\":{total}}}"
            ));
        }
    }
    drop(blob_statement);

    if grid.is_empty() {
        fail("no points aggregated (empty or unreadable clouds)");
    }

    // Clean the map: drop isolated specks first (so they can't bridge column gaps),
    // then carve floaters above vertical gaps. Both are opt-in from the modal.
    if args.outlier {
        progress("{\"phase\":\"outlier\"}");
        remove_outliers(&mut grid, args.outlier_min);
    }
    if args.carve {
        progress("{\"phase\":\"carving\"}");
        let gap_cells = (args.carve_gap * inv_voxel).round() as i64;
        let height_cells = if args.carve_height > 0.0 {
            (args.carve_height * inv_voxel).round() as i64
        } else {
            0
        };
        carve_columns(&mut grid, gap_cells.max(1), args.carve_min_run, height_cells);
    }
    if grid.is_empty() {
        fail("all points removed by carving/outlier filters (try disabling them)");
    }
    progress("{\"phase\":\"writing\"}");

    let stamp = first_stamp.unwrap_or(Time { sec: 0, nsec: 0 });
    let (blob, point_count) = build_aggregated_blob(&grid, stamp);
    write_aggregated_stream(&mut connection, &args.stream, &out_name, &blob, t0)
        .unwrap_or_else(|e| fail(&format!("write failed: {e}")));

    progress(&format!(
        "{{\"phase\":\"done\",\"aggregated\":\"{out_name}\",\"points\":{point_count}}}"
    ));
}
