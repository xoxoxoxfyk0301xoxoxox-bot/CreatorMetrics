#!/usr/bin/env node
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.creator-metrics-collector.daily";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "launchd", `${LABEL}.plist.template`);
const AGENT = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid()}`;

function xml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function commandPath(name) { return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim(); }

export async function schedulerConfiguration(overrides = {}) {
  if (process.platform !== "darwin") throw new Error("Scheduler helpers are supported only on macOS.");
  const npmPath = overrides.npmPath ?? commandPath("npm");
  await access(npmPath, constants.X_OK);
  const bin = dirname(npmPath), safePath = [...new Set([bin, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  const replacements = {
    __PROJECT_DIR__: ROOT, __SAFE_PATH__: safePath, __NPM_PATH__: npmPath,
    __STDOUT_PATH__: join(ROOT, "logs", "launchd.stdout.log"), __STDERR_PATH__: join(ROOT, "logs", "launchd.stderr.log"), ...overrides
  };
  let plist = await readFile(TEMPLATE, "utf8");
  for (const [key, value] of Object.entries(replacements)) plist = plist.replaceAll(key, xml(String(value)));
  return { label: LABEL, root: ROOT, npmPath, safePath, agentPath: AGENT, plist };
}

function launchctl(args, tolerateFailure = false) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.status !== 0 && !tolerateFailure) throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} failed`).trim());
  return result;
}

async function install() {
  const config = await schedulerConfiguration();
  await mkdir(join(ROOT, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(dirname(AGENT), { recursive: true, mode: 0o700 });
  await chmod(join(ROOT, "scripts", "run-daily.sh"), 0o755);
  const temporary = `${AGENT}.tmp-${process.pid}`;
  await writeFile(temporary, config.plist, { mode: 0o600 });
  execFileSync("/usr/bin/plutil", ["-lint", temporary], { stdio: "inherit" });
  launchctl(["bootout", DOMAIN, AGENT], true);
  await rename(temporary, AGENT);
  await chmod(AGENT, 0o600);
  launchctl(["bootstrap", DOMAIN, AGENT]);
  launchctl(["enable", `${DOMAIN}/${LABEL}`]);
  console.log(`Installed ${LABEL}`); console.log(`plist: ${AGENT}`); console.log(`npm: ${config.npmPath}`);
}
function status() {
  const result = launchctl(["print", `${DOMAIN}/${LABEL}`], true);
  if (result.status !== 0) { console.log(`${LABEL}: not installed`); process.exitCode = 1; return; }
  const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? "registered";
  console.log(`${LABEL}: installed (${state})`); console.log(`schedule: daily 09:30 local time`); console.log(`plist: ${AGENT}`);
}
function run() { launchctl(["kickstart", `${DOMAIN}/${LABEL}`]); console.log(`Triggered ${LABEL}`); }
async function uninstall() {
  launchctl(["bootout", DOMAIN, AGENT], true);
  await unlink(AGENT).catch((error) => { if (error.code !== "ENOENT") throw error; });
  console.log(`Uninstalled ${LABEL}`);
}

const command = process.argv[2];
if (command === "install") await install();
else if (command === "status") status();
else if (command === "run") run();
else if (command === "uninstall") await uninstall();
else if (command === "render") console.log((await schedulerConfiguration()).plist);
else throw new Error("Usage: scheduler.mjs install|status|run|uninstall");
