//! Collect only images from this CLI thread, after its entire process tree exits.
use crate::{artifacts, task_options::TaskOptions, workspace};
use anyhow::{Result, ensure};
use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

pub fn collect(home: &Path, thread: &str, dir: &Path, options: &TaskOptions) -> Result<usize> {
    ensure!(
        uuid::Uuid::parse_str(thread).is_ok(),
        "Invalid image session identifier"
    );
    let cache = home.join("generated_images").join(thread);
    if !cache.is_dir() {
        return Ok(0);
    }
    let root = cache.canonicalize()?;
    let home = home.canonicalize()?;
    ensure!(
        root.starts_with(home.join("generated_images")),
        "Image cache resolves outside its root"
    );
    let mut paths: Vec<_> = std::fs::read_dir(&root)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| artifacts::mime(p).is_some())
        .collect();
    paths.sort();
    ensure!(paths.len() <= 20, "Too many generated image files");
    let mut count = 0;
    let destination = dir.join(format!("output-{}", uuid::Uuid::new_v4()));
    for path in paths.iter().take(options.count as usize) {
        let (bytes, _) = workspace::read(&root, path, 50_000_000)?;
        let image = decode(&bytes)?;
        if count == 0 {
            std::fs::create_dir(&destination)?;
        }
        save(
            image,
            &destination.join(format!("image-{}", count + 1)),
            options,
        )?;
        count += 1;
    }
    Ok(count)
}

fn decode(bytes: &[u8]) -> Result<image::DynamicImage> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    Ok(reader.decode()?)
}

fn save(mut image: image::DynamicImage, stem: &Path, options: &TaskOptions) -> Result<PathBuf> {
    if options.size != "auto" {
        let (w, h) = options.size.split_once('x').unwrap();
        let (w, h) = (w.parse::<u32>()?, h.parse::<u32>()?);
        // Preserve the requested aspect ratio. Never enlarge a generated image.
        image = image.thumbnail(w, h);
    }
    let path = stem.with_extension(if options.output_format == "jpeg" {
        "jpg"
    } else {
        &options.output_format
    });
    let mut data = Cursor::new(Vec::new());
    if options.output_format == "jpeg" {
        let rgb = image.to_rgb8();
        let mut quality = options.output_compression;
        loop {
            data.get_mut().clear();
            data.set_position(0);
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut data, quality)
                .encode_image(&rgb)?;
            if data.get_ref().len() as u64 <= options.target_file_kb * 1024 || quality <= 35 {
                break;
            }
            quality = quality.saturating_sub(10).max(35);
        }
    } else {
        image.write_to(
            &mut data,
            if options.output_format == "png" {
                image::ImageFormat::Png
            } else {
                image::ImageFormat::WebP
            },
        )?;
    }
    // A fresh random output directory is created after the sandbox process exits.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(data.get_ref())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_collection_is_thread_scoped_and_compresses_images() {
        let home = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let thread = uuid::Uuid::new_v4().to_string();
        let cache = home.path().join("generated_images").join(&thread);
        std::fs::create_dir_all(&cache).unwrap();
        image::RgbImage::from_pixel(1024, 1024, image::Rgb([100, 180, 20]))
            .save(cache.join("image.png"))
            .unwrap();
        let options = TaskOptions {
            size: "512x512".into(),
            ..Default::default()
        };
        assert_eq!(
            collect(home.path(), &thread, dir.path(), &options).unwrap(),
            1
        );
        let output = std::fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("image-1.jpg");
        assert_eq!(image::image_dimensions(&output).unwrap(), (512, 512));
        assert!(output.metadata().unwrap().len() < 32 * 1024);
        assert!(collect(home.path(), "../escape", dir.path(), &options).is_err());
        assert!(cache.join("image.png").is_file());
    }
}
