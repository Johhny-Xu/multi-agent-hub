#!/usr/bin/env node
// CLI 一次性工具：把任务派给 Agent Hub 的一个 worker 并阻塞到出结果。
// 用法：node ask.mjs <worker> <task...> [timeout_s]
//   worker 支持简称 agy/cb/cbcnintl/mimo/gcp/mmx/trae 或规范名。
// 退出码：0=completed，1=failed/timeout/running（running 时 answer 里带 ref 可续查）。
// 供工作流 world.run、子代理 Bash 或任何脚本把 hub worker 当原语调用：
//   world.run("node", ["<插件目录>/mcp/ask.mjs", "antigravity", task, "600"])
import { ask, CANONICAL } from "./hub.mjs";

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("用法: node ask.mjs <worker> <task...> [timeout_s]");
  console.error("worker 可选: " + CANONICAL.join(" / ") + "（简称 agy/cb/cbcn/mimo/gcp/mmx/trae 亦可）");
  process.exit(2);
}
let timeoutS = 300;
if (argv.length > 2 && /^\d+(?:\.\d+)?$/.test(argv[argv.length - 1])) timeoutS = Number(argv.pop());
const worker = argv.shift();
const task = argv.join(" ");

const r = await ask(worker, task, timeoutS);
if (r.ok) {
  console.log(r.answer);
} else {
  console.log(JSON.stringify(r, null, 1));
  process.exit(1);
}
