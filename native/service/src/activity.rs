use serde_json::{Value, json};
use std::io::Write;

pub fn emit(enabled: bool, mut event: Value) {
    if !enabled {
        return;
    }
    event["v"] = json!(1);
    let _ = writeln!(
        std::io::stderr().lock(),
        "codex-local-mcp activity: {event}"
    );
}

#[derive(Default)]
pub struct Marker {
    line: Vec<u8>,
    overflow: bool,
}

/// JSONL framing is bounded even when a tool emits a multi-megabyte image.
#[derive(Default)]
pub struct Events {
    line: Vec<u8>,
    overflow: bool,
}
impl Events {
    pub fn push(&mut self, bytes: &[u8], mut consume: impl FnMut(Value)) {
        for b in bytes {
            if *b == b'\n' {
                if !self.overflow
                    && let Ok(event) = serde_json::from_slice(&self.line)
                {
                    consume(event);
                }
                self.line.clear();
                self.overflow = false;
            } else if !self.overflow {
                if self.line.len() < 2_000_000 {
                    self.line.push(*b);
                } else {
                    self.line.clear();
                    self.overflow = true;
                }
            }
        }
    }
}

pub fn phase(event: &Value) -> &'static str {
    let item = &event["item"];
    match item["type"].as_str().unwrap_or("") {
        "command_execution" => "running_command",
        "file_change" => "writing_files",
        "web_search" => "searching",
        "reasoning" => "thinking",
        "mcp_tool_call" | "dynamic_tool_call" | "tool_call" | "custom_tool_call" => {
            let tool = item["tool"]
                .as_str()
                .or_else(|| item["name"].as_str())
                .unwrap_or("");
            let args = item["arguments"]
                .as_str()
                .or_else(|| item["input"].as_str())
                .unwrap_or("");
            if tool.contains("imagegen") || args.contains("image_gen__imagegen") {
                "generating_image"
            } else if tool == "apply_patch" || args.contains("tools.apply_patch") {
                "writing_files"
            } else {
                "using_tool"
            }
        }
        _ => "running",
    }
}
impl Marker {
    pub fn push(&mut self, bytes: &[u8], mut report: impl FnMut(&'static str)) {
        for b in bytes {
            if *b == b'\n' {
                if !self.overflow {
                    match String::from_utf8_lossy(&self.line).trim() {
                        "exec" => report("running_command"),
                        "apply patch" => report("writing_files"),
                        "codex" => report("running"),
                        _ => (),
                    }
                }
                self.line.clear();
                self.overflow = false;
            } else if !self.overflow {
                if self.line.len() < 512 {
                    self.line.push(*b);
                } else {
                    self.line.clear();
                    self.overflow = true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fixed_markers_cross_the_activity_boundary() {
        let mut marker = Marker::default();
        let mut phases = vec![];
        marker.push(b"secret prompt\nex", |p| phases.push(p));
        marker.push(b"ec\r\napply patch\ncodex\n", |p| phases.push(p));
        marker.push(&vec![b'x'; 10000], |p| phases.push(p));
        marker.push(b"exec\n", |p| phases.push(p));
        assert_eq!(phases, ["running_command", "writing_files", "running"]);
    }
    #[test]
    fn json_events_recover_after_oversized_lines_and_split_chunks() {
        let mut parser = Events::default();
        let mut events = vec![];
        parser.push(b"{\"type\":\"item.", |e| events.push(e));
        parser.push(
            b"started\",\"item\":{\"type\":\"command_execution\",\"command\":\"private value\"}}\n",
            |e| events.push(e),
        );
        parser.push(&vec![b'x'; 2_000_010], |e| events.push(e));
        parser.push(b"\n{\"type\":\"turn.completed\"}\n", |e| events.push(e));
        assert_eq!(events.len(), 2);
        assert_eq!(phase(&events[0]), "running_command");
        assert!(parser.line.is_empty());
    }
}
