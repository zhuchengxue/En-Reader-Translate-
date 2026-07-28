/* 生成 Ed25519 密钥对，用于兑换码 token 的签名/验签。
 *
 * 设计：
 * - 服务端（Cloudflare Worker /api/redeem）用【私钥】给兑换令牌签名，私钥不离开服务端。
 * - 客户端（js/license.js）用【公钥】验签，公钥可安全内嵌到前端代码（暴露也无妨，无法反推私钥）。
 * - 这样即使仓库私有被逆向、或有人拿到前端代码，也无法伪造能通过验签的令牌。
 *
 * 产物：
 * - worker/keys.private.txt  -> 私钥 JWK（gitignore，仅服务端用；配到 Cloudflare 环境变量 REDEEM_PRIVATE_KEY）
 * - 终端打印公钥 JWK，复制到 js/license.js 的 LICENSE_PUBLIC_KEY
 *
 * 运行：node tools/keys.js
 */
import { webcrypto } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: 'Ed25519' },
  true,
  ['sign', 'verify']
);
const pubJwk = await webcrypto.subtle.exportKey('jwk', publicKey);
const privJwk = await webcrypto.subtle.exportKey('jwk', privateKey);

// 私钥落盘（gitignore）
const privPath = join(__dirname, '..', 'worker', 'keys.private.txt');
mkdirSync(dirname(privPath), { recursive: true });
writeFileSync(privPath, JSON.stringify(privJwk), { mode: 0o600 });

// 只导出公钥的 {kty,crv,x}（d 字段绝不下发）
const pubEmbed = JSON.stringify({ kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x });

console.log('\n✅ 私钥已写入:', privPath, '（请将其内容配到 Cloudflare 环境变量 REDEEM_PRIVATE_KEY，切勿提交到仓库）');
console.log('\n📋 把下面的公钥复制到 js/license.js 的 LICENSE_PUBLIC_KEY：\n');
console.log(pubEmbed);
console.log('');
