import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const script = resolve("scripts/secrets-pushed.sh");
const config = resolve(".gitleaks.toml");
const zero = "0".repeat(40);
const hasGitleaks = spawnSync("sh", ["-c", "command -v gitleaks"]).status === 0;
const scenario = hasGitleaks ? describe : describe.skip;

// hooks export GIT_INDEX_FILE and friends; drop them so scratch repos stay isolated
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const env = { ...inherited, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd, env, encoding: "utf8" }
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const scan = (cwd: string, stdin: string) => {
  const r = spawnSync("sh", [script], { cwd, input: stdin, env, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// spawns git and gitleaks; exceeds the 500ms CLI timeout
const slow = { timeout: 30_000 };

scenario("推送前密钥扫描", () => {
  const origin = tmp("lbcat-origin-");
  const repo = tmp("lbcat-repo-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(repo, "init", "-q", "-b", "main");
  copyFileSync(config, join(repo, ".gitleaks.toml"));
  writeFileSync(join(repo, "readme.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD").out.trim();

  // fake github token built at run time so no secret literal sits in the repo
  const token = `ghp_${randomBytes(18).toString("base64url").replace(/[-_]/g, "a").slice(0, 36)}`;
  git(repo, "checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "leak.txt"), `token = "${token}"\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "leak");
  const leak = git(repo, "rev-parse", "HEAD").out.trim();
  git(repo, "checkout", "-q", "main");

  it("当前分支之外的分支含密钥时应拦截", slow, () => {
    const r = scan(repo, `refs/heads/side ${leak} refs/heads/side ${zero}\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("leaks found");
  });

  it("远端分支已存在时也应拦截", slow, () => {
    expect(scan(repo, `refs/heads/side ${leak} refs/heads/main ${base}\n`).code).not.toBe(0);
  });

  it("干净推送放行，删除与空输入跳过", slow, () => {
    expect(scan(repo, `refs/heads/main ${base} refs/heads/main ${base}\n`).code).toBe(0);
    expect(scan(repo, `(delete) ${zero} refs/heads/side ${leak}\n`).code).toBe(0);
    expect(scan(repo, "").code).toBe(0);
  });

  it("真实 git push 被 pre-push 钩子拦截，远端不收到提交", slow, () => {
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    const hook = join(repo, ".git/hooks/pre-push");
    writeFileSync(hook, `#!/bin/sh\nexec sh "${script}"\n`);
    chmodSync(hook, 0o755);
    const r = git(repo, "push", "origin", "side");
    expect(r.code).not.toBe(0);
    expect(git(origin, "branch", "--list", "side").out.trim()).toBe("");
  });

  it("缺少 gitleaks 时应失败并给出安装提示", slow, () => {
    const bin = tmp("lbcat-bin-");
    symlinkSync(spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim(), join(bin, "sh"));
    const r = spawnSync("sh", [script], {
      cwd: repo,
      input: `refs/heads/main ${base} refs/heads/main ${base}\n`,
      env: { PATH: bin },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("brew install gitleaks");
  });
});
