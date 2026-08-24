import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = await readJson(resolve(root, "package.json"));
const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

const expectedVersions = hostPackages.map((name) => {
  const version = manifest.devDependencies?.[name];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error(`${name} must have an exact devDependency version; received ${version ?? "missing"}`);
  }
  if (manifest.peerDependencies?.[name] !== "*") {
    throw new Error(`${name} must remain peer-provided with peerDependencies set to \"*\"`);
  }
  return version;
});

const expectedVersion = expectedVersions[0];
if (expectedVersions.some((version) => version !== expectedVersion)) {
  throw new Error(`Pi host devDependencies must use one coordinated version: ${expectedVersions.join(", ")}`);
}

for (const name of hostPackages) {
  const installed = await readJson(resolve(root, "node_modules", ...name.split("/"), "package.json"));
  if (installed.version !== expectedVersion) {
    throw new Error(`${name} ${installed.version} is installed; expected ${expectedVersion}`);
  }
}

const codingAgent = await readJson(resolve(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
const expectedTypebox = codingAgent.dependencies?.typebox;
const configuredTypebox = manifest.devDependencies?.typebox;
const installedTypebox = await readJson(resolve(root, "node_modules", "typebox", "package.json"));
if (manifest.peerDependencies?.typebox !== "*") {
  throw new Error('typebox must remain peer-provided with peerDependencies set to "*"');
}
if (configuredTypebox !== expectedTypebox || installedTypebox.version !== expectedTypebox) {
  throw new Error(`typebox must match Pi ${expectedVersion}: configured ${configuredTypebox}, installed ${installedTypebox.version}, expected ${expectedTypebox}`);
}

console.log(`Pi host packages are synchronized at ${expectedVersion} with typebox ${expectedTypebox}`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
