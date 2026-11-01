import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// This program runs inside the real Codex OS sandbox. It never calls an AI model.
const [secret, outsideWrite, port, networkEnabled] = process.argv.slice(2);
let readDenied = false;
let writeDenied = false;
try { fs.readFileSync(secret); } catch { readDenied = true; }
try { fs.writeFileSync(outsideWrite, "sandbox escape"); } catch { writeDenied = true; }
const inside = path.join(process.cwd(), "inside.txt");
fs.writeFileSync(inside, "sandbox workspace check");
const workspaceWorks = fs.readFileSync(inside, "utf8") === "sandbox workspace check";
const connected = await new Promise<boolean>(resolve => {
  const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
  socket.setTimeout(1500);
  const finish = (value: boolean) => { socket.destroy(); resolve(value); };
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.once("timeout", () => finish(false));
});
const networkWorks = networkEnabled === "true" || !connected;
const passed = readDenied && writeDenied && workspaceWorks && networkWorks;
console.log(JSON.stringify({ passed, readDenied, writeDenied, workspaceWorks, networkDenied: !connected }));
process.exitCode = passed ? 0 : 1;
