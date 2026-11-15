import { cp, mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = await mkdtemp(join(tmpdir(), "fukidashi-package-"));
const app = join(staging, "fukidashi");
const output = join(root, "artifacts/fukidashi-colorfulbox.tar.gz");
try {
  await mkdir(join(app, "config"), { recursive: true });
  await mkdir(join(app, "public"));
  for (const name of ["app.js", "styles.css", "index.html", "api.php", "qrcode.min.js", ".htaccess"]) {
    await cp(join(root, "public", name), join(app, "public", name));
  }
  await cp(join(root, "php"), join(app, "php"), { recursive: true });
  for (const name of ["config.example.php", ".htaccess"]) await cp(join(root, "config", name), join(app, "config", name));
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await cp(join(root, name), join(app, name));
  await cp(join(root, "php/README.md"), join(app, "DEPLOY.md"));
  await mkdir(join(root, "artifacts"), { recursive: true });
  await promisify(execFile)("tar", ["-czf", output, "-C", staging, "fukidashi"]);
  await access(output);
  console.log(output);
} finally { await rm(staging, { recursive: true, force: true }); }
