import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, lstat, writeFile } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";

const root = process.cwd();
const runId = randomUUID().replaceAll("-", "");
const project = `chrona-verify-${runId}`;
const output = resolve(root, "data", "ship-check", runId);
const source = resolve(output, "source");
const compose = ["compose", "-p", project, "-f", resolve(source, "scripts", "compose.verify.yaml")];
const run = args => new Promise((resolve, reject) => {
  const child = spawn("docker", args, { stdio: "inherit", shell: false });
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Clean-clone Docker check exited with ${code}`)));
});

let succeeded = false;
try {
  // Include uncommitted source so this also verifies a change before it is shipped.
  // git's ignore rules exclude private env files, backups and installed packages.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
  for (const file of new Set(files)) {
    if (/(^|\/)\.env(?:\.|$)/.test(file) && file !== ".env.example") throw new Error("Refusing to copy a private environment file");
    if (/^(?:data|node_modules|\.next|\.git)\//.test(file)) continue;
    const original = resolve(root, file);
    const target = resolve(source, file);
    if (!original.startsWith(root + sep) || !target.startsWith(source + sep)) throw new Error("Unsafe snapshot path");
    let stat;
    try { stat = await lstat(original); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile()) throw new Error(`Clean-clone snapshot requires a regular source file: ${file}`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(original, target);
  }
  console.log("Verifying a source-only snapshot in fresh Linux Node/Postgres containers. No real provider keys, local databases, node_modules or .next output are copied.");
  await run([...compose, "up", "--build", "--attach", "verify", "--abort-on-container-exit", "--exit-code-from", "verify"]);
  succeeded = true;
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  // Only this randomly named verification project is removed. No host volume is used.
  try { await run([...compose, "down", "--volumes", "--remove-orphans", "--rmi", "local"]); }
  catch { console.error("Verification-container cleanup failed; project:", project); process.exitCode = 1; succeeded = false; }
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "result.json"), JSON.stringify({ passed: succeeded, project, source }, null, 2));
  console.log(`${succeeded ? "PASS" : "FAIL"}: clean-clone verification. Local report: ${resolve(output, "result.json")}`);
}
