import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = dirname(fileURLToPath(import.meta.url));
let publicDir = resolve(root, "public");
try { await access(publicDir); } catch { publicDir = resolve(root, "../public"); }
const types = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8", "qrcode.min.js": "text/javascript; charset=utf-8" };
const assets = {};
for (const [name, type] of Object.entries(types)) {
  let text = await readFile(resolve(publicDir, name), "utf8");
  if (name === "index.html") text = text.replace("<head>", '<head><meta name="cloud-app" content="true">');
  assets[`/${name}`] = { text, type };
}
const source = await readFile(resolve(root, "worker.js"), "utf8");
await mkdir(resolve(root, "dist/server"), { recursive: true });
await mkdir(resolve(root, "dist/.openai"), { recursive: true });
await writeFile(resolve(root, "dist/server/index.js"), `const ASSETS = ${JSON.stringify(assets)};\n` + source.replace('import { ASSETS } from "./assets.js";', ""));
await writeFile(resolve(root, "dist/.openai/hosting.json"), await readFile(resolve(root, ".openai/hosting.json")));
console.log("Built cloud Worker with embedded browser assets");
