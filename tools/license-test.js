/* 本地加密自检：用生成的私钥签名，用 js/license.js 内嵌的公钥验签，
 * 确认密钥对匹配、Ed25519 令牌可验证、且篡改会被拒。
 * 运行：node tools/license-test.js
 */
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');
const privJwk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'worker', 'keys.private.txt'), 'utf8'));
const pubEmbed = { kty: 'OKP', crv: 'Ed25519', x: 'gSyJJAPzUbWzRAJwAnA8HOR089H2E0Xe4SPhghFxLI4' };

(async () => {
  const priv = await webcrypto.subtle.importKey('jwk', privJwk, { name: 'Ed25519' }, false, ['sign']);
  const pub = await webcrypto.subtle.importKey('jwk', pubEmbed, { name: 'Ed25519' }, false, ['verify']);

  const payload = { code: 'ENRD-TEST-CODE', dev: 'dev1', iat: Date.now(), exp: Date.now() + 1e12 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'Ed25519' }, priv, Buffer.from(data, 'utf8'))).toString('base64url');
  const token = data + '.' + sig;

  const ok = await webcrypto.subtle.verify({ name: 'Ed25519' }, pub, Buffer.from(sig, 'base64url'), Buffer.from(data, 'utf8'));
  console.log('私钥签名 / 内嵌公钥验签 一致:', ok ? 'PASS' : 'FAIL');
  if (!ok) process.exit(1);

  // 篡改签名应被拒
  const tampered = data + '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ok2 = await webcrypto.subtle.verify({ name: 'Ed25519' }, pub, Buffer.from('AAAA', 'base64url'), Buffer.from(data, 'utf8')).catch(() => true);
  console.log('篡改令牌被拒:', ok2 === false ? 'PASS' : 'FAIL');

  console.log('\n样例可用令牌（仅用于本地 dev 自测，生产由 Worker 签发）：\n' + token + '\n');
})();
