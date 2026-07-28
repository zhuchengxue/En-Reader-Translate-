/* Cloudflare Pages Function: 兑换码校验端点。
 * 路由：POST /api/redeem  ->  { token } | { error }
 * 逻辑：
 *  - 校验码格式（ENRD-XXXX-XXXX）
 *  - 查 KV(env.CODES)：码不存在 -> 无效；已绑定设备达上限 -> 已用完
 *  - 首次/新设备激活：记录设备(dev, 限 3 台)，标记 used
 *  - 用 Ed25519 私钥(env.REDEEM_PRIVATE_KEY)对 {code,dev,iat,exp} 签名，返回 token
 *  - 客户端用内嵌公钥验签即解锁（无法伪造）
 * 部署：Cloudflare Pages 后台把本 Function 绑定 KV 命名空间(变量名 CODES)，
 *       并在环境变量设置 REDEEM_PRIVATE_KEY = worker/keys.private.txt 的内容。
 */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SEATS = 3;            // 每个兑换码最多绑定设备数
const TRIAL_MONTHS = 600;   // 令牌有效期(月)，≈50 年，等同买断永久

let _privKey = null;
async function getPrivKey(env) {
  if (_privKey) return _privKey;
  const jwk = JSON.parse(env.REDEEM_PRIVATE_KEY);
  _privKey = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
  return _privKey;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function normalizeCode(c) {
  return (c || '').toString().trim().toUpperCase().replace(/\s+/g, '');
}

function validFormat(c) {
  return /^ENRD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c);
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env || {};
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return new Response('Send POST {code, dev}', { status: 405, headers: cors });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const code = normalizeCode(body.code);
  const dev = (body.dev || '').toString().slice(0, 64);

  if (!code || !dev) {
    return new Response(JSON.stringify({ error: '参数缺失' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  if (!validFormat(code)) {
    return new Response(JSON.stringify({ error: '兑换码格式不正确' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  if (!env.CODES) {
    return new Response(JSON.stringify({ error: '服务端未配置 KV' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const raw = await env.CODES.get(code);
  if (!raw) {
    return new Response(JSON.stringify({ error: '兑换码无效或不存在' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  let rec = {};
  try { rec = JSON.parse(raw); } catch (e) { rec = {}; }
  if (rec.revoked) {
    return new Response(JSON.stringify({ error: '该兑换码已被作废' }), { status: 410, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  rec.devices = rec.devices || [];
  if (rec.devices.length >= SEATS && !rec.devices.includes(dev)) {
    return new Response(JSON.stringify({ error: '该兑换码已达绑定设备上限(' + SEATS + '台)' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  if (!rec.devices.includes(dev)) rec.devices.push(dev);
  rec.used = true;
  rec.redeemedAt = Date.now();
  await env.CODES.put(code, JSON.stringify(rec));

  // 签名令牌
  try {
    const priv = await getPrivKey(env);
    const payload = { code, dev, iat: Date.now(), exp: Date.now() + TRIAL_MONTHS * 30 * 864e5 };
    const data = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, new TextEncoder().encode(data));
    const token = data + '.' + b64url(sig);
    return new Response(JSON.stringify({ token }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: '签名失败：' + e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}
