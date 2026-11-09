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
    assert!(args.iter().any(|a| a == "--json"));
    println!(
        "{}",
        serde_json::json!({"type":"item.started","item":{"id":"one","type":"command_execution","command":"private-command-sentinel","status":"in_progress"}})
    );
    if prompt.contains("FAKE_TIMEOUT") {
        std::thread::sleep(std::time::Duration::from_secs(10));
    }
    if prompt.contains("FAKE_DELAY") {
        std::thread::sleep(std::time::Duration::from_millis(1200));
    }
    let millis = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    };
    // Records when this run was active, so a test can prove runs overlap.
    if prompt.contains("FAKE_PARALLEL") {
        let start = millis();
        std::thread::sleep(std::time::Duration::from_millis(1000));
        std::fs::create_dir_all(dir.join("runs")).unwrap();
        let record = format!("runs/{}.txt", std::process::id());
        std::fs::write(dir.join(record), format!("{start} {}", millis())).unwrap();
    }
    if prompt.contains("FAKE_FAILURE") {
        std::process::exit(7);
    }
    if prompt.contains("Generate an image:") {
        std::fs::create_dir_all(dir.join("output")).unwrap();
        // Parallel runs share the workspace, so each writes its own file.
        let name = format!("output/test-{}.png", std::process::id());
        image::RgbImage::from_pixel(16, 16, image::Rgb([120, 180, 220]))
            .save(dir.join(name))
            .unwrap();
    } else {
        std::fs::write(dir.join("result.txt"), "native fixture output").unwrap();
    }
    // Stands in for a coding task: change a tracked file, add an untracked one,
    // and record the prompt that arrived.
    if prompt.contains("EDIT_REPO") {
        let readme = dir.join("README.md");
        let mut text = std::fs::read_to_string(&readme).unwrap_or_default();
        text.push_str("Edited by fake codex.\n");
        std::fs::write(readme, text).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/added.txt"), "a new untracked file\n").unwrap();
        std::fs::write(dir.join("notes.txt"), format!("prompt: {prompt}\n")).unwrap();
    }
    if let Some(n) = prompt
        .split("BIGPATCH:")
        .nth(1)
        .and_then(|s| s.split_whitespace().next()?.parse::<usize>().ok())
    {
        let line = format!("{}\n", "x".repeat(79));
        std::fs::write(dir.join("big.txt"), line.repeat(n.div_ceil(80))).unwrap();
    }
    // Codex writes its final message to --output-last-message.
    if let Some(i) = args.iter().position(|a| a == "--output-last-message") {
        let after = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map_or("none".to_owned(), |i| args[i + 1].clone())
        };
        let roots = args
            .iter()
            .find(|a| a.starts_with("sandbox_workspace_write.writable_roots="))
            .cloned()
            .unwrap_or_else(|| "none".into());
        std::fs::write(
            &args[i + 1],
            format!(
                "fake codex final message\nsandbox: {}\nnpm cache: {}\nwritable roots: {roots}\n",
                after("--sandbox"),
                std::env::var("npm_config_cache").unwrap_or_else(|_| "unset".into())
            ),
        )
        .unwrap();
    }
    println!(
        "{}",
        serde_json::json!({"type":"item.completed","item":{"id":"one","type":"command_execution","status":"completed"}})
    );
    println!(
        "{}",
        serde_json::json!({"type":"item.started","item":{"id":"two","type":"file_change"}})
    );
    println!(
        "{}",
        serde_json::json!({"type":"item.completed","item":{"id":"two","type":"file_change"}})
    );
    println!(
        "{}",
        serde_json::json!({"type":"item.completed","item":{"id":"three","type":"agent_message","text":"Native fixture completed"}})
    );
    println!(
        "{}",
        serde_json::json!({"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}})
    );
}
