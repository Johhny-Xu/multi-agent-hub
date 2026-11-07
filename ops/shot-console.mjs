// 用无头 Edge 给控制台签到卡片截图
// 用法: node scripts/shot-console.mjs <url> <out.png> [width] [height]
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const url = process.argv[2] || 'http://192.168.2.29:8890/';
const out = process.argv[3] || 'console-shot.png';
const width = Number(process.argv[4] || 1500);
const height = Number(process.argv[5] || 1000);

const edges = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
];
const exe = edges.find((p) => existsSync(p));
if (!exe) { console.error('找不到 Edge'); process.exit(1); }

const args = [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--force-device-scale-factor=1`, `--window-size=${width},${height}`,
  `--screenshot=${out}`,
  url,
];
const child = execFile(exe, args, { windowsHide: true });
child.on('error', (e) => console.error('exec 失败:', e.message));

const deadline = Date.now() + 40000;
let last = -1;
while (Date.now() < deadline) {
  await sleep(500);
  if (!existsSync(out)) continue;
  const size = statSync(out).size;
  if (size > 0 && size === last) break;
  last = size;
}
console.log(existsSync(out) ? `截图已生成: ${out} (${statSync(out).size} 字节)` : '截图未生成');
