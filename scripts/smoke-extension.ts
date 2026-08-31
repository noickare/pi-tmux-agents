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
  const cleared = await rpc.send({ type: "clear_queue" });
  const queue = cleared.data as { steering?: unknown; followUp?: unknown } | undefined;
  if (!cleared.success || !Array.isArray(queue?.steering) || !Array.isArray(queue?.followUp)) {
    throw new Error(cleared.error ?? "clear_queue RPC failed");
  }
  const response = await rpc.send({ type: "prompt", message: "/activity check" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (!response.success) throw new Error(response.error ?? "extension command failed");
  console.log(`clear_queue: ok · extension command: ok · UI events: ${methods.join(", ") || "none"}`);
} finally {
  unsubscribe();
  await rpc.close();
}
