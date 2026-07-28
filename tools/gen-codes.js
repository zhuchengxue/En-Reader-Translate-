/* 批量生成兑换码并写入 Cloudflare KV。
 *
 * 用法：
 *   node tools/gen-codes.js 20                # 生成 20 个码
 *
 * 写入方式（二选一）：
 *   A. 配了环境变量 -> 直接 bulk put 到 KV：
 *      set CLOUDFLARE_API_TOKEN=xxx
 *      set CLOUDFLARE_ACCOUNT_ID=xxx
 *      set KV_NAMESPACE_ID=xxx
 *      node tools/gen-codes.js 20
 *   B. 未配 -> 生成 codes.json，再用 wrangler 手动批量写入：
 *      npx wrangler kv bulk put codes.json --binding CODES
 *
 * 码格式：ENRD-XXXX-XXXX（大写字母+数字，去歧义：无 0/O/1/I）
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const COUNT = parseInt(process.argv[2] || '10', 10);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去 0/O/1/I

function genCode() {
  let s = '';
  const b = randomBytes(8);
  for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return 'ENRD-' + s.slice(0, 4) + '-' + s.slice(4, 8);
}

const codes = [];
const seen = new Set();
while (codes.length < COUNT) {
  const c = genCode();
  if (!seen.has(c)) { seen.add(c); codes.push(c); }
}

const kvRecords = codes.map(c => ({ key: c, value: JSON.stringify({ used: false, devices: [], createdAt: Date.now() }) }));

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const NS = process.env.KV_NAMESPACE_ID;

if (TOKEN && ACCOUNT && NS) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}/bulk/put`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(kvRecords),
  });
  const json = await res.json().catch(() => ({}));
  if (json.success) {
    console.log(`✅ 已写入 ${codes.length} 个兑换码到 KV`);
  } else {
    console.error('❌ KV 写入失败:', JSON.stringify(json.errors || json));
    process.exit(1);
  }
} else {
  writeFileSync('codes.json', JSON.stringify(kvRecords, null, 2));
  console.log(`✅ 已生成 ${codes.length} 个兑换码到 codes.json`);
  console.log('   手动写入：npx wrangler kv bulk put codes.json --binding CODES');
}

console.log('\n生成的兑换码：');
console.log(codes.join('\n'));
console.log('');
