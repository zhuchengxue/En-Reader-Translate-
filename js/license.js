/* 客户端授权模块：兑换码激活 + 试用限次 + 令牌验签。
 * 装载顺序：必须在 app.js 之前（index.html 里排在 app.js 前）。
 * 安全模型：
 *  - 令牌由服务端用 Ed25519 私钥签名；本文件只内嵌【公钥】验签，无法伪造令牌。
 *  - 仓库私有 + 后续构建混淆作为额外门槛，挡住 casual 逆向。
 *  - 自动化测试(navigator.webdriver)下关闭拦截闸门，保证回归/功能测试不被挡。
 */
(function () {
  /* 内嵌公钥（由 tools/keys.js 生成，对应 worker/keys.private.txt 的私钥）。可公开，无法反推私钥。 */
  const LICENSE_PUBLIC_KEY = { kty: 'OKP', crv: 'Ed25519', x: 'gSyJJAPzUbWzRAJwAnA8HOR089H2E0Xe4SPhghFxLI4' };

  /* 兑换码模块总开关：false = 临时关闭（调试 / 开发期、准备加新功能时，让闸门放行、不拦打开书）；
   * 上线收费时改回 true 即可完整恢复激活流程（UI 由 body.no-license 控制显隐）。 */
  const LICENSE_ENABLED = false;

  const TRIAL_LIMIT = 3;          // 试用可打开书本次数
  const LS_TOKEN = 'enr_license_token';
  const LS_TRIAL = 'enr_trial_used';
  const LS_DEVID = 'enr_devid';

  function b64urlToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function bytesToB64url(u) {
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  let _pubKey = null;
  async function pubKey() {
    if (_pubKey) return _pubKey;
    _pubKey = await crypto.subtle.importKey('jwk', LICENSE_PUBLIC_KEY, { name: 'Ed25519' }, false, ['verify']);
    return _pubKey;
  }

  function getDevId() {
    let id = localStorage.getItem(LS_DEVID);
    if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + Math.random()); localStorage.setItem(LS_DEVID, id); }
    return id;
  }

  const License = {
    /* 模块是否启用（总开关） */
    enabled() { return LICENSE_ENABLED; },

    /* 闸门是否生效：模块开启且非自动化测试(真实浏览器)才拦截 */
    gateEnabled() { return LICENSE_ENABLED && !navigator.webdriver; },

    async verify(token) {
      try {
        if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return false;
        const parts = token.split('.');
        if (parts.length !== 2) return false;
        const [data, sig] = parts;
        const key = await pubKey();
        const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64urlToBytes(sig), new TextEncoder().encode(data));
        if (!ok) return false;
        const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(data)));
        if (!payload || typeof payload !== 'object') return false;
        if (!payload.code || payload.dev !== getDevId()) return false;
        if (!Number.isFinite(payload.iat) || payload.iat > Date.now() + 300000) return false;
        if (payload.exp && Date.now() > payload.exp) return false;
        return true;
      } catch (e) { return false; }
    },

    getToken() { return localStorage.getItem(LS_TOKEN) || ''; },
    setToken(t) { localStorage.setItem(LS_TOKEN, t); },

    async isActivated() {
      if (!LICENSE_ENABLED) return false;
      const t = this.getToken();
      if (!t) return false;
      return this.verify(t);
    },

    /* 试用计数 */
    getTrialUsed() { return parseInt(localStorage.getItem(LS_TRIAL) || '0', 10) || 0; },
    getTrialRemaining() { if (!LICENSE_ENABLED) return 9999; return Math.max(0, TRIAL_LIMIT - this.getTrialUsed()); },
    useTrial() {
      const n = this.getTrialUsed() + 1;
      localStorage.setItem(LS_TRIAL, String(n));
      return this.getTrialRemaining();
    },

    /* 调用服务端校验兑换码并保存令牌 */
    async activate(code) {
      const dev = getDevId();
      const res = await fetch('/api/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, dev })
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || ('激活失败(' + res.status + ')'));
      }
      const { token } = await res.json();
      if (!token || !(await this.verify(token))) throw new Error('返回的令牌验签失败');
      this.setToken(token);
      return true;
    }
  };

  window.License = License;
})();
