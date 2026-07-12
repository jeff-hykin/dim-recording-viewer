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
// Progress + result are emitted as newline-delimited JSON on stdout:
//   {"phase":"scanning","done":N,"total":M}
//   {"phase":"writing"}
//   {"phase":"done","aggregated":"<name>","points":P}
//   {"phase":"error","message":"..."}   (also exits non-zero)
//
// args:
//   --db <path>       memory2 .db to read from and write back into (required)
//   --stream <name>   source cloud stream name (required)
//   --voxel <meters>  voxel edge length (default 0.05, matching dimos --voxel)
//   --out <name>      output stream name (default "<stream>_aggregated")

use std::collections::HashMap;
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
}

fn parse_args() -> Result<Args, String> {
    let mut db = None;
    let mut stream = None;
    let mut voxel = 0.05_f64;
    let mut out = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = args.next(),
            "--stream" => stream = args.next(),
            "--out" => out = args.next(),
            "--voxel" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<f64>() {
                        if parsed > 0.0 {
                            voxel = parsed;
                        }
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
    })
}

fn progress(json: &str) {
    println!("{json}");
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
    progress("{\"phase\":\"writing\"}");

    let stamp = first_stamp.unwrap_or(Time { sec: 0, nsec: 0 });
    let (blob, point_count) = build_aggregated_blob(&grid, stamp);
    write_aggregated_stream(&mut connection, &args.stream, &out_name, &blob, t0)
        .unwrap_or_else(|e| fail(&format!("write failed: {e}")));

    progress(&format!(
        "{{\"phase\":\"done\",\"aggregated\":\"{out_name}\",\"points\":{point_count}}}"
    ));
}
