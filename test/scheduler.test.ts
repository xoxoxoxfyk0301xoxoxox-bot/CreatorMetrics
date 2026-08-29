import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "darwin")("launchd configuration", () => {
  it("renders the verified npm path, schedule, command and no secrets", () => {
    const plist = execFileSync(process.execPath, ["scripts/scheduler.mjs", "render"], { encoding: "utf8" });
    expect(plist).toContain("com.creator-metrics-collector.daily");
    expect(plist).toContain("<integer>9</integer>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain("/usr/local/bin/npm");
    expect(plist).toContain("<string>daily</string>");
    expect(plist).not.toContain("GOOGLE_REFRESH_TOKEN");
    expect(plist).not.toContain("THREADS_ACCESS_TOKEN");
    expect(plist).not.toContain("__PROJECT_DIR__");
  });
  it("keeps the optional wrapper limited to the repository daily command", () => {
    const wrapper = readFileSync("scripts/run-daily.sh", "utf8");
    expect(wrapper).toContain('cd "$PROJECT_DIR"');
    expect(wrapper).toContain('run daily');
    expect(wrapper).not.toMatch(/TOKEN|SECRET|\.env/);
  });
  it("renders an isolated five-minute Threads publisher without secrets",()=>{const plist=execFileSync(process.execPath,["scripts/post-scheduler.mjs","render"],{encoding:"utf8"});expect(plist).toContain("com.creator-metrics-collector.threads-publisher");expect(plist).toContain("<integer>300</integer>");expect(plist).toContain("post:threads:due");expect(plist).toContain("threads-publisher.stdout.log");expect(plist).not.toMatch(/ACCESS_TOKEN|APP_SECRET|GOOGLE_REFRESH_TOKEN/);});
  it("exposes isolated publisher install, status, run, and uninstall routes",()=>{const helper=readFileSync("scripts/post-scheduler.mjs","utf8");for(const command of ["install","status","run","uninstall"])expect(helper).toContain(`command===\"${command}\"`);expect(helper).toContain("threads-publisher");expect(helper).not.toContain("com.creator-metrics-collector.daily");});
});
