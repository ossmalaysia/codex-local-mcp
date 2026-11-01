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
}
