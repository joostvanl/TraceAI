#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const tokenFile = resolve(process.cwd(), "data/bootstrap-token.txt");
const text = readFileSync(tokenFile, "utf8");
const tokenLine = text.split(/\r?\n/).find((l) => l.startsWith("token="));
if (!tokenLine) {
  console.error("No token= line in data/bootstrap-token.txt");
  process.exit(1);
}
const token = tokenLine.slice("token=".length).trim();
const env = {
  ...process.env,
  TRACEAI_API_URL: process.env.TRACEAI_API_URL ?? "http://127.0.0.1:3847",
  TRACEAI_TOKEN: token,
};

const build = spawnSync("pnpm", ["--filter", "@traceai/mcp", "build"], {
  stdio: "inherit",
  env,
  shell: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const smoke = spawnSync("pnpm", ["--filter", "@traceai/mcp", "smoke"], {
  stdio: "inherit",
  env,
  shell: true,
});
process.exit(smoke.status ?? 1);
