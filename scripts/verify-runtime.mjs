import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { monotonicMs } from "../lib/clock.ts";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = "http://127.0.0.1:3000";
const user = randomUUID();
const session = randomUUID();
const headers = { cookie: `user_id=${user}; session_id=${session}` };
async function run(args) {
  const child = spawn("npm", args, { stdio: "inherit", shell: false });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `npm ${args.join(" ")} failed`);
}
async function start(command) {
  const child = spawn("npm", ["run", command, "--", "--hostname", "127.0.0.1"], { stdio: "inherit", detached: true });
  const started = monotonicMs();
  while (monotonicMs() - started < 60_000) {
    if (child.exitCode !== null) throw new Error(`${command} exited before becoming ready`);
    try { if ((await fetch(`${base}/api/models`)).ok) return child; } catch { /* Wait for server startup. */ }
    await pause(250);
  }
  process.kill(-child.pid, "SIGTERM");
  throw new Error(`${command} did not become ready`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([exited, pause(5000)]);
  if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
}
async function history() {
  const response = await fetch(`${base}/api/history?sessionId=${session}`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.sessions.flatMap(session => session.days.flatMap(day => day.turns));
}

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let server;
try {
  // This fixed DB name lives only in the disposable verification container.
  await admin.query("CREATE DATABASE chrona_shipping");
  server = await start("dev");
  assert.equal((await fetch(base)).status, 200);
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What are all the questions I asked you today?", tz: "UTC", sessionId: session }) });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.ok(stream.includes("event: done") && !stream.includes("event: error"));
  for (let attempt = 0; attempt < 30 && (await history()).length < 2; attempt++) await pause(100);
  assert.equal((await history()).length, 2);
  await stop(server); server = undefined;
  await run(["run", "build"]);
  await run(["run", "typecheck"]);
  await run(["run", "lint"]);
  await run(["test"]);
  await run(["run", "eval"]);
  server = await start("start");
  assert.equal((await fetch(base)).status, 200);
  assert.deepEqual((await history()).map(turn => turn.role), ["user", "assistant"]);
  console.log("PASS: clean install, dev startup, HTTP chat/history, build, typecheck, lint, tests, three sample-prompt evals and production restart persistence.");
} finally {
  await stop(server);
  await admin.end();
}
