#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const token = readFileSync(resolve("data/bootstrap-token.txt"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("token="))
  ?.slice("token=".length)
  .trim();
if (!token) process.exit(1);

const api = "http://127.0.0.1:3847";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function req(path, init) {
  const res = await fetch(`${api}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const project = await req("/v1/projects/traceai");
console.log("PROJECT", JSON.stringify(project.data, null, 2));

const workflows = await req("/v1/workflows?project=traceai");
console.log("WORKFLOWS", JSON.stringify(workflows.data, null, 2));
