import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
function binary(name, preferred) {
  for (const dir of [preferred, ...(process.env.PATH || "").split(":"), "/opt/homebrew/opt/php@8.4/bin", "/opt/homebrew/opt/mariadb@10.6/bin", "/usr/local/opt/php@8.4/bin", "/usr/local/opt/mariadb@10.6/bin"].filter(Boolean)) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(`${name} is required; set PHP_BIN and/or MARIADB_BIN_DIR. No production DB is used.`);
}
const php = process.env.PHP_BIN || binary("php");
const mariadbd = binary("mariadbd", process.env.MARIADB_BIN_DIR);
const installDb = binary("mysql_install_db", process.env.MARIADB_BIN_DIR);
const quote = value => "'" + String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error("Test server exited before readiness.");
    try { if (await check()) return; } catch {}
    await delay(100);
  }
  throw new Error("Test server startup timed out.");
}
async function unusedPort() {
  const s = createServer();
  await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}
async function stop(child, group = false) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once("exit", resolve));
  try { if (group) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {}
  await ended;
}
function hostRequest(url, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host } }, res => {
      let body = "";
      res.on("data", data => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
}

test("PHP 8.4 + real MariaDB: sharing, concurrency, authorization, persistence and restore", { timeout: 90000 }, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fukidashi-php-test-")));
  const socket = join(dir, "db.sock");
  const datadir = join(dir, "mysql");
  const backupDir = join(dir, "backups");
  const mainPublic = join(dir, "public_html");
  await mkdir(backupDir, { mode: 0o700 });
  await mkdir(mainPublic);
  let db, server;
  t.after(async () => { await stop(server, true); await stop(db); await rm(dir, { recursive: true, force: true }); });
  await run(installDb, ["--no-defaults", `--datadir=${datadir}`, "--auth-root-authentication-method=normal", "--skip-test-db"], { maxBuffer: 1024 * 1024 });
  db = spawn(mariadbd, ["--no-defaults", `--datadir=${datadir}`, `--socket=${socket}`, `--pid-file=${join(dir, "db.pid")}`, "--skip-networking", `--log-error=${join(dir, "db.log")}`, "--innodb-buffer-pool-size=32M", "--innodb-log-file-size=8M"], { stdio: "ignore" });
  const adminDsn = `mysql:unix_socket=${socket};charset=utf8mb4`;
  await waitFor(async () => { await run(php, ["-r", 'new PDO($argv[1], "root", "");', adminDsn]); return true; }, db);
  const primaryDb = "fukidashi_test_primary", restoredDb = "fukidashi_test_restored";
  await run(php, ["-r", ' $p = new PDO($argv[1], "root", ""); $p->exec("CREATE DATABASE fukidashi_test_primary CHARACTER SET utf8mb4; CREATE DATABASE fukidashi_test_restored CHARACTER SET utf8mb4;");', adminDsn]);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const configPath = join(dir, "local.php");
  const restoredConfig = join(dir, "restored.php");
  const configText = (database, secure = false, url = origin) => `<?php return [ 'origin' => ${quote(url)}, 'cookie_secure' => ${secure ? "true" : "false"}, 'public_roots' => [${quote(mainPublic)}], 'backup_dir' => ${quote(backupDir)}, 'database' => ['dsn' => ${quote(`mysql:unix_socket=${socket};dbname=${database};charset=utf8mb4`)}, 'user' => 'root', 'password' => ''] ];`;
  await writeFile(configPath, configText(primaryDb), { mode: 0o600 });
  await writeFile(restoredConfig, configText(restoredDb), { mode: 0o600 });
  const cli = (args, config = configPath) => run(php, [join(root, "php/bin/manage.php"), ...args], { env: { ...process.env, FUKIDASHI_CONFIG: config } });
  assert.match((await cli(["setup"])).stdout, /Created boards/);
  await assert.rejects(cli(["setup"]), /EMPTY dedicated/);
  assert.match((await cli(["check"])).stdout, /InnoDB/);
  const start = async (config = configPath, host) => {
    server = spawn(php, ["-S", `127.0.0.1:${port}`, "-t", join(root, "public"), join(root, "php/dev-router.php")], { detached: true, stdio: "ignore", env: { ...process.env, FUKIDASHI_CONFIG: config, PHP_CLI_SERVER_WORKERS: "4" } });
    await waitFor(async () => host ? (await hostRequest(origin + "/api/session", host)).status === 200 : (await fetch(origin + "/api/session")).ok, server);
  };
  await start();
  async function request(path, { method = "GET", body, cookie = "", key = "", headers = {}, raw } = {}) {
    return fetch(origin + path, { method, headers: { "content-type": "application/json", "origin": origin, "cookie": cookie, "x-owner-key": key, ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(10000) });
  }
  async function json(path, options = {}) {
    const r = await request(path, options);
    const body = await r.json();
    assert.ok(r.ok, `${options.method || "GET"} ${path}: ${r.status} ${JSON.stringify(body)}`);
    return body;
  }
  async function session() {
    const r = await request("/api/session");
    const setCookie = r.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    return { ...await r.json(), cookie: setCookie.split(";")[0] };
  }
  const alice = await session(), bob = await session();
  const html = await (await request("/admin")).text();
  assert.match(html, /name="server-session"/);
  assert.ok(!html.includes("displayModeButton"));
  assert.equal((await request("/styles.css")).status, 200);
  assert.equal((await request("/config/local.php")).status, 403);
  assert.equal((await request("/api/boards", { method: "POST", body: { title: "No session" } })).status, 401);
  const board = await json("/api/boards", { method: "POST", body: { title: "吹き出しくん 🍀" }, cookie: alice.cookie });
  const ownerPath = `/api/boards/${board.id}`;
  const owner = body => ({ method: "PATCH", body: { ...body, ownerKey: board.ownerKey }, cookie: alice.cookie });
  assert.equal((await request(ownerPath)).status, 404);
  const publish = () => json("/api/publish", { method: "POST", body: { boardId: board.id, ownerKey: board.ownerKey }, cookie: alice.cookie });
  let published = await publish();
  const path = `/api/public/${published.publicToken}`;
  assert.equal((await request(`/join/${published.publicToken}`)).status, 200);
  await Promise.all(Array.from({ length: 16 }, (_, i) => json(path + "/bubbles", { method: "POST", cookie: alice.cookie, body: { text: `同時投稿 ${i} 🐱`, name: "ニンジャ", userId: bob.userId } })));
  let shared = await json(path);
  assert.equal(shared.bubbles.length, 16, "transaction locks must preserve every simultaneous post");
  assert.equal(shared.bubbles[0].authorId, alice.userId);
  assert.equal(shared.ownerKey, undefined);
  assert.equal(shared.publicToken, undefined);
  const bubbleId = shared.bubbles[0].id;
  assert.equal((await request(path + "/bubbles", { method: "PATCH", cookie: bob.cookie, body: { bubbleId, text: "spoof", userId: alice.userId } })).status, 403);
  assert.equal((await request(path + "/bubbles", { method: "PATCH", cookie: `fukidashi_session_dev=${alice.userId}`, body: { bubbleId, text: "spoof" } })).status, 403);
  await json(path + "/bubbles", { method: "PATCH", cookie: alice.cookie, body: { bubbleId, text: "編集 🐱", x: 99, y: 1 } });
  await json(path + "/like", { method: "POST", cookie: bob.cookie, body: { bubbleId } });
  assert.equal((await json(path)).bubbles[0].likes.length, 1);
  await json(path + "/like", { method: "POST", cookie: bob.cookie, body: { bubbleId } });
  assert.equal((await json(path)).bubbles[0].likes.length, 0);
  assert.equal((await request(path + "/bubbles", { method: "POST", cookie: alice.cookie, body: { text: "CSRF" }, headers: { origin: "https://other.example" } })).status, 403);
  assert.equal((await request(path + "/bubbles", { method: "POST", cookie: alice.cookie, raw: "{}", headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await request(path + "/bubbles", { method: "POST", cookie: alice.cookie, raw: "[1]" })).status, 400);
  assert.equal((await request(path + "/bubbles", { method: "POST", cookie: alice.cookie, raw: "{" })).status, 400);
  assert.equal((await request(path + "/bubbles", { method: "POST", cookie: alice.cookie, body: { text: "x".repeat(17000) } })).status, 413);
  assert.equal((await request(ownerPath + "/event", owner({ publishEndsAt: "not-a-date" }))).status, 400);
  assert.equal((await json(path)).bubbles.length, 16, "failed writes must roll back");
  await stop(server, true); await start();
  assert.equal((await json(path)).bubbles.length, 16, "posts survive PHP server restarts");
  published = await publish();
  assert.equal((await request(path)).status, 404, "old public token is revoked");
  const currentPath = `/api/public/${published.publicToken}`;
  await json(ownerPath + "/event", owner({ publishEndsAt: "2000-01-01T00:00:00Z" }));
  assert.equal((await request(currentPath)).status, 404);
  await json(ownerPath + "/event", owner({ publishEndsAt: null }));
  assert.equal((await request(currentPath)).status, 200);
  await json(ownerPath + "/event", owner({ endPublishNow: true }));
  assert.equal((await request(`/join/${published.publicToken}`)).status, 404);
  const backupPath = (await cli(["backup"])).stdout.trim();
  assert.ok(backupPath.startsWith(backupDir + "/"));
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const snapshot = JSON.parse(await readFile(backupPath, "utf8"));
  assert.equal(snapshot.boards[0].bubbles.length, 16);
  assert.equal(snapshot.boards[0].ownerKey, board.ownerKey);
  await assert.rejects(cli(["restore", backupPath]), /EMPTY application table/);
  await cli(["setup"], restoredConfig);
  assert.match((await cli(["restore", backupPath], restoredConfig)).stdout, /Restored 1 boards/);
  const restoredBackup = (await cli(["backup"], restoredConfig)).stdout.trim();
  assert.deepEqual(JSON.parse(await readFile(restoredBackup, "utf8")).boards, snapshot.boards);
  // Configuration errors must fail closed before DB writes or private file disclosure.
  const publicConfig = join(mainPublic, "misplaced.php");
  await writeFile(publicConfig, configText(primaryDb));
  await assert.rejects(cli(["check"], publicConfig), /outside all public roots/);
  const unsafeConfig = join(dir, "insecure.php");
  await writeFile(unsafeConfig, configText(primaryDb, false, "http://fukidashi.example"));
  await assert.rejects(cli(["check"], unsafeConfig), /HTTPS/);
  const secureConfig = join(dir, "secure.php");
  await writeFile(secureConfig, configText(primaryDb, true, "https://fukidashi.example"));
  const secureCookie = await run(php, ["-r", `require ${quote(join(root, "php/bootstrap.php"))}; $c=Fukidashi\\loadConfig(); echo Fukidashi\\sessionCookieName($c);`], { env: { ...process.env, FUKIDASHI_CONFIG: secureConfig } });
  assert.equal(secureCookie.stdout, "__Host-fukidashi_session");
  await stop(server, true); await start(secureConfig, "fukidashi.example");
  const productionSession = await hostRequest(origin + "/api/session", "fukidashi.example");
  assert.equal(productionSession.status, 200, productionSession.body);
  const cookieHeader = productionSession.headers["set-cookie"].join(";");
  assert.match(cookieHeader, /^__Host-fukidashi_session=/);
  assert.match(cookieHeader, /; secure/i);
  assert.match(cookieHeader, /; HttpOnly/i);
  assert.match(cookieHeader, /; path=\//i);
  assert.ok(!/; domain=/i.test(cookieHeader), "do not share the app's cookie with WordPress");
});
