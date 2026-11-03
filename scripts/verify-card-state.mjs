// 用线上真实数据验证前端按钮会显示成什么
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { cardState } = require(join(process.cwd(), 'console', 'client', 'checkin-card-state.js'));

const base = process.argv[2] || 'http://192.168.2.29:8890';
const res = await fetch(`${base}/api/checkin/status`);
const data = await res.json();

console.log('today =', data.today);
console.log();
for (const [key, info] of Object.entries(data.platforms || {})) {
  if (!info) continue;
  const st = cardState({ ...info, platform: key });
  console.log(`${key.padEnd(12)} status=${String(info.status).padEnd(9)} reason=${String(info.pendingReason || '-').padEnd(18)}`);
  console.log(`             徽章: ${st.badge}`);
  console.log(`             按钮: 「${st.btn}」  可点=${st.clickable}`);
}
