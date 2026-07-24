import { join } from "node:path";
import { PiRpcProcess } from "../src/runner/pi-rpc-process.js";

const extension = join(process.cwd(), "src", "extension", "index.ts");
const rpc = new PiRpcProcess({
  command: join(process.cwd(), "node_modules", ".bin", "pi"),
  args: [
    "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension,
    "--offline", "--no-context-files", "--no-approve",
  ],
  cwd: process.cwd(),
  requestTimeoutMs: 15_000,
  onStderr: (text) => process.stderr.write(text),
});
const methods: string[] = [];
const unsubscribe = rpc.subscribe((event) => {
  if (event.type === "extension_ui_request" && typeof event.method === "string") methods.push(event.method);
});
try {
  const response = await rpc.send({ type: "prompt", message: "/agents check" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (!response.success) throw new Error(response.error ?? "extension command failed");
  console.log(`extension command: ${response.success ? "ok" : "failed"} · UI events: ${methods.join(", ") || "none"}`);
} finally {
  unsubscribe();
  await rpc.close();
}
