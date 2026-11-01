use crate::{config::Config, workspace};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{io::Cursor, path::Path};

pub fn mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}
fn text_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    [
        "",
        "txt",
        "md",
        "json",
        "yaml",
        "yml",
        "toml",
        "ini",
        "csv",
        "tsv",
        "js",
        "mjs",
        "cjs",
        "ts",
        "tsx",
        "jsx",
        "py",
        "rb",
        "go",
        "rs",
        "java",
        "c",
        "h",
        "cpp",
        "hpp",
        "cs",
        "sh",
        "bash",
        "ps1",
        "bat",
        "cmd",
        "html",
        "htm",
        "css",
        "scss",
        "xml",
        "svg",
        "sql",
        "env",
        "gitignore",
        "log",
        "diff",
        "patch",
    ]
    .contains(&ext.as_str())
}
pub fn text(s: impl Into<String>) -> Value {
    json!({"type":"text", "text":s.into()})
}
pub fn error(s: impl std::fmt::Display) -> Value {
    json!({"content":[text(format!("Error: {s}"))], "isError":true})
}

pub fn read_tool(config: &Config, path: &Path, max: usize) -> Result<Value> {
    let (data, real) = workspace::read(&config.root, path, max.min(50_000_000))?;
    let mut content = vec![text(format!("{} ({} bytes)", real.display(), data.len()))];
    if let Some(mime) = mime(&real) {
        content.push(json!({"type":"image", "mimeType":mime, "data":STANDARD.encode(data)}));
    } else if text_file(&real) {
        content.push(text(String::from_utf8_lossy(&data)));
    } else {
        content.push(text("Binary file (application/octet-stream); fetch it via its resource link to get the bytes."));
    }
    Ok(json!({"content": content}))
}

pub fn resource(config: &Config, uri: &str) -> Result<Value> {
    let path = url::Url::parse(uri)?
        .to_file_path()
        .map_err(|_| anyhow::anyhow!("Invalid file URI"))?;
    let (data, real) = workspace::read(&config.root, &path, 50_000_000)?;
    let content = if let Some(mime) = mime(&real) {
        json!({"uri":uri,"mimeType":mime,"blob":STANDARD.encode(data)})
    } else if text_file(&real) {
        json!({"uri":uri,"mimeType":"text/plain","text":String::from_utf8_lossy(&data)})
    } else {
        json!({"uri":uri,"mimeType":"application/octet-stream","blob":STANDARD.encode(data)})
    };
    Ok(json!({"contents":[content]}))
}

pub struct Collected {
    pub content: Vec<Value>,
    pub lines: Vec<String>,
    pub count: usize,
}

struct Preview {
    data: String,
    mime: &'static str,
    note: String,
}
fn make_preview(
    image: &image::DynamicImage,
    data: &[u8],
    mime: &'static str,
    budget: usize,
) -> Option<Preview> {
    if data.len().div_ceil(3) * 4 <= budget {
        return Some(Preview {
            data: STANDARD.encode(data),
            mime,
            note: String::new(),
        });
    }
    if budget < 1024 {
        return None;
    }
    for size in [1024, 768, 512, 256, 128] {
        let small = image.thumbnail(size, size).to_rgb8();
        let mut encoded = Vec::new();
        if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 70)
            .encode_image(&small)
            .is_err()
            || encoded.len().div_ceil(3) * 4 > budget
        {
            continue;
        }
        return Some(Preview {
            data: STANDARD.encode(encoded),
            mime: "image/jpeg",
            note: format!(
                "preview {}x{}; original available through resource link",
                small.width(),
                small.height()
            ),
        });
    }
    None
}

fn append_image(
    config: &Config,
    real: &Path,
    name: &str,
    line: &mut String,
    result: &mut Collected,
    spent: &mut usize,
) -> Result<()> {
    let Some(mime) = mime(real) else {
        return Ok(());
    };
    // Decode bounded files only. Decoder limits apply before pixel allocation.
    let (data, _) = workspace::read(&config.root, real, 50_000_000)?;
    let mut reader = image::ImageReader::new(Cursor::new(&data));
    reader.set_format(image::guess_format(&data)?);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode()?;
    line.push_str(&format!(", {}x{}", image.width(), image.height()));
    let remaining = config.inline.min(config.response.saturating_sub(*spent));
    if let Some(preview) = make_preview(&image, &data, mime, remaining) {
        *spent += preview.data.len();
        result.content.push(text(if preview.note.is_empty() {
            format!("Image: {name}")
        } else {
            format!("Image: {name} ({})", preview.note)
        }));
        result.content.push(json!({"type":"image", "mimeType":preview.mime, "data":preview.data, "annotations":{"audience":["user","assistant"],"priority":0.9}}));
    }
    Ok(())
}

pub fn collect(config: &Config, dir: &Path, paths: &[std::path::PathBuf], open: bool) -> Collected {
    let mut result = Collected {
        content: vec![],
        lines: vec![],
        count: 0,
    };
    let mut spent = 0;
    for path in paths.iter().take(config.files) {
        let Ok((file, real)) = workspace::open(&config.root, &dir.join(path)) else {
            continue;
        };
        let Ok(meta) = file.metadata() else {
            continue;
        };
        let Ok(uri) = url::Url::from_file_path(&real) else {
            continue;
        };
        let name = path.to_string_lossy().replace('\\', "/");
        let mut line = format!("- {name} ({} bytes)", meta.len());
        if mime(&real).is_some() {
            let _ = append_image(config, &real, &name, &mut line, &mut result, &mut spent);
            if open {
                let _ = open_image(&real);
            }
        }
        result.lines.push(line);
        result.count += 1;
        let mut link = json!({"type":"resource_link", "uri":uri.as_str(), "name":name,"description":format!("{} bytes, produced in this workspace", meta.len())});
        if let Some(kind) = mime(&real) {
            link["mimeType"] = json!(kind);
        }
        result.content.push(link);
    }
    if paths.len() > config.files {
        result.lines.push("(file list truncated)".into());
    }
    result
}

fn open_image(path: &Path) -> Result<()> {
    // The file was confined and has a recognized raster extension. Never invoke a shell.
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::{
                Foundation::HWND,
                UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
            },
            core::PCWSTR,
        };
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        unsafe {
            ShellExecuteW(
                Some(HWND::default()),
                PCWSTR(verb.as_ptr()),
                PCWSTR(path.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            );
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "/usr/bin/xdg-open"
        })
        .arg(path)
        .spawn()?;
    }
    Ok(())
}
