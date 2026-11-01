//! Native test fixture. Never included in an installer.
use std::{io::Read, path::PathBuf};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["login", "status"] {
        return;
    }
    if args.first().map(String::as_str) != Some("exec") {
        std::process::exit(2);
    }
    for (key, _) in std::env::vars() {
        if [
            "CODEX_MCP_PASSWORD",
            "CODEX_MCP_TUNNEL_TOKEN",
            "CODEX_MCP_ACTIVITY",
            "TUNNEL_TOKEN",
        ]
        .contains(&key.to_uppercase().as_str())
        {
            std::process::exit(9);
        }
    }
    let index = args.iter().position(|a| a == "--cd").unwrap();
    let dir = PathBuf::from(&args[index + 1]);
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    eprintln!("exec");
    if prompt.contains("FAKE_TIMEOUT") {
        std::thread::sleep(std::time::Duration::from_secs(10));
    }
    if prompt.contains("FAKE_DELAY") {
        std::thread::sleep(std::time::Duration::from_millis(1200));
    }
    if prompt.contains("FAKE_FAILURE") {
        std::process::exit(7);
    }
    if prompt.contains("Generate an image:") {
        std::fs::create_dir_all(dir.join("output")).unwrap();
        image::RgbImage::from_pixel(16, 16, image::Rgb([120, 180, 220]))
            .save(dir.join("output/test.png"))
            .unwrap();
    } else {
        std::fs::write(dir.join("result.txt"), "native fixture output").unwrap();
    }
    eprintln!("apply patch");
    println!("Native fixture completed");
}
