#!/usr/bin/env node
// 登录在 AGENTHUB_URL 指向的枢纽宿主机执行；stdout 只包含公开登录状态。
import { hubLogin } from "./hub.mjs";

const [worker, action = "status", ...extra] = process.argv.slice(2);
if (!worker || extra.length) {
  console.error("用法: node login.mjs <worker> [start|status|cancel]");
  process.exitCode = 1;
} else {
  const result = await hubLogin(worker, action);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}
