// @ts-check
// 签到模块用到的两个账号工具，从老 MAH 的 console/accounts.mjs 原样截取：
// findCodeBuddySharedAuth（读 CodeBuddy 桌面版共享会话，只读）与 isMutableIdentity。
// 账号档案的增删切换（saveAccount/switchAccount 等）不在签到回归范围内，未一并搬入。

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

/**
 * CodeBuddy 新版 CLI（≥2.164）的真实会话存储：XDG sharedDataPath 下的 auth/<产品认证ID>.info。
 * 注意它跟随 HOME，不随 CODEBUDDY_CONFIG_DIR；官方 CN/国际版共用同一文件（同 authentication.id）。
 */
const CODEBUDDY_SHARED_AUTH_REL = join('.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');

/**
 * 在指定 HOME 下扫描 CodeBuddy 共享会话存储，返回首个有效凭据（auth.accessToken 为真实 JWT 而非跳转 URL）。
 * 备份轮换文件（文件名带日期戳）自动排在后面。
 * @returns {Promise<{ file: string, data: any } | null>}
 */
export async function findCodeBuddySharedAuth(baseHome = HOME) {
  const dir = join(baseHome, CODEBUDDY_SHARED_AUTH_REL);
  const files = await readdir(dir).catch(() => []);
  const cands = files.filter((f) => f.endsWith('.info')).sort((a, b) => a.length - b.length);
  for (const f of cands) {
    try {
      const d = JSON.parse((await readFile(join(dir, f), 'utf-8')).replace(/^\uFEFF/, ''));
      const tok = String(d?.auth?.accessToken || '').trim();
      if (tok && !tok.startsWith('http')) return { file: join(dir, f), data: d };
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/**
 * 身份方案是否「可变异」：这类身份描述的是**当前这一份凭据文件**的属性，
 * 而不是某个独立账号，所以一旦与线上不一致，只说明它是旧快照，不可能是「另一个账号」。
 * 邮箱 / UID / AK 这类稳定身份不在此列——它们不一致代表真的是不同账号，必须保留。
 * @param {string} identity
 */
export function isMutableIdentity(identity) {
  const s = String(identity || '');
  if (!s) return false;
  if (s.startsWith('providers:') || s.startsWith('mcode:') || s.startsWith('mmx:') || s.startsWith('qoder-token:')) return true;
  return /^[0-9a-f]{12}$/.test(s); // 纯文件指纹
}
