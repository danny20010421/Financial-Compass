/* store.js — 資料狀態、加密（AES-GCM）與 GitHub 同步
 * 財務資料（vault）以使用者密語加密後存於 repo 的 data/vault.enc.json，
 * GitHub Actions 以同一密語（Secret: VAULT_PASSPHRASE）解密產生每日報表。
 * API 金鑰與 GitHub Token 只存在本機瀏覽器，不會上傳。
 */
(function () {
  const LS_VAULT = 'fh.vault.v1';
  const LS_LOCAL = 'fh.local.v1';
  const LS_REPORT = 'fh.report.v1';
  const VAULT_PATH = 'data/vault.enc.json';
  const REPORT_PATH = 'data/report.enc.json';
  const WORKFLOW_PATH = '.github/workflows/daily-report.yml';
  const PBKDF2_ITER = 210000;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台北日期

  function defaultVault() {
    const y = new Date().getFullYear();
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      profile: {
        name: '', monthlyIncome: 0, monthlyBudget: 0, riskLevel: '', riskScore: null, riskAnswers: {},
        horizonYears: 5, goalsText: { short: '', mid: '', long: '' },
        targetAlloc: { core: 55, satellite: 15, bond: 20, defensive: 10 },
        emergencyMonths: 6, settlementAccountId: ''
      },
      accounts: [],       // {id,name,type,currency,balance}
      txns: [],           // {id,date,type:'expense'|'income',amount,currency,category,accountId,note}
      trades: [],         // {id,date,time,symbol,name,market:'TW'|'US',side,qty,price,fee,tax,currency,bucket,note}
      prices: {},         // 手動價格 {'TW:2330':{close,date,source:'manual'}}
      receivables: [],    // {id,name,amount,currency,due,done}
      payables: [],       // {id,name,amount,currency,due,done}
      otherAssets: [],    // {id,name,value,currency,kind}
      liabilities: [],    // {id,name,balance,currency,rate,monthly}
      goals: [{ id: uid(), name: `${y} 年度：金融資產達 100 萬`, target: 1000000, start: 0, startDate: `${y}-01-01`, deadline: `${y}-12-31`, metric: 'financial', current: 0 }],
      news: [],           // {id,date,title,url,note,region}
      fxManual: { USD: 32, JPY: 0.22, EUR: 35, CNY: 4.5, HKD: 4.1 },
      settings: { mailTo: '', sendTime: '07:30', sendDays: [2, 3, 4, 5, 6], aiProvider: 'gemini', verifyProvider: '', milestone: 1000000 },
      categories: { expense: ['餐飲', '交通', '居住', '日用', '娛樂', '醫療', '教育', '保險', '孝親', '服飾', '通訊', '旅遊', '其他'], income: ['薪資', '獎金', '股利', '利息', '副業', '其他'] }
    };
  }

  function defaultLocal() {
    return {
      gh: { owner: '', repo: '', branch: 'main', token: '' },
      rememberPass: false, pass: '',
      ai: { gemini: { key: '', model: 'gemini-3.8-flash' }, openai: { key: '', model: 'gpt-6-luna' }, claude: { key: '', model: 'claude-sonnet-5' }, provider: 'gemini', verify: '' },
      dirty: false, lastSync: '', vaultSha: ''
    };
  }

  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v || d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } };

  function merge(base, v) {
    const out = Object.assign({}, base, v);
    for (const k of ['profile', 'settings', 'categories', 'fxManual']) out[k] = Object.assign({}, base[k], v && v[k]);
    out.profile.targetAlloc = Object.assign({}, base.profile.targetAlloc, v && v.profile && v.profile.targetAlloc);
    return out;
  }

  const Store = {
    uid, today, VAULT_PATH, REPORT_PATH,
    vault: merge(defaultVault(), load(LS_VAULT, {})),
    local: Object.assign(defaultLocal(), load(LS_LOCAL, {})),
    report: load(LS_REPORT, null),
    listeners: [],
    onChange(fn) { this.listeners.push(fn); },
    commit(msg) {
      this.vault.updatedAt = new Date().toISOString();
      save(LS_VAULT, this.vault);
      this.local.dirty = true; this.saveLocal();
      this.listeners.forEach(f => f(msg));
      clearTimeout(this._t);
      if (this.canSync()) this._t = setTimeout(() => this.push().catch(() => {}), 2500);
    },
    saveLocal() { save(LS_LOCAL, this.local); },
    setReport(r) { this.report = r; save(LS_REPORT, r); },
    replaceVault(v) { this.vault = merge(defaultVault(), v); save(LS_VAULT, this.vault); },
    resetAll() { localStorage.removeItem(LS_VAULT); localStorage.removeItem(LS_REPORT); this.vault = defaultVault(); this.report = null; },
    passphrase: '',
    canSync() { const g = this.local.gh; return !!(g.owner && g.repo && g.token && this.passphrase); },

    /* ---------- Crypto ---------- */
    b64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); },
    unb64(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; },
    async deriveKey(pass, salt, iter) {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    },
    async encrypt(obj, pass) {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await this.deriveKey(pass, salt, PBKDF2_ITER);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
      return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: this.b64(salt), iv: this.b64(iv), data: this.b64(ct) };
    },
    async decrypt(env, pass) {
      const key = await this.deriveKey(pass, this.unb64(env.salt), env.iter || PBKDF2_ITER);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.unb64(env.iv) }, key, this.unb64(env.data));
      return JSON.parse(new TextDecoder().decode(pt));
    },

    /* ---------- GitHub API ---------- */
    async gh(path, opt = {}) {
      const g = this.local.gh;
      const res = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}${path}`, Object.assign({}, opt, {
        headers: Object.assign({ Authorization: `Bearer ${g.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opt.headers || {})
      }));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.status === 204 ? {} : res.json();
    },
    async getFile(path) {
      const g = this.local.gh;
      const meta = await this.gh(`/contents/${path}?ref=${encodeURIComponent(g.branch)}&t=${Date.now()}`);
      if (!meta) return null;
      let text;
      if (meta.content) text = new TextDecoder().decode(this.unb64(meta.content.replace(/\n/g, '')));
      else {
        const raw = await this.gh(`/git/blobs/${meta.sha}`);
        text = new TextDecoder().decode(this.unb64(raw.content.replace(/\n/g, '')));
      }
      return { sha: meta.sha, text };
    },
    async putFile(path, text, message, sha) {
      const body = { message, content: this.b64(new TextEncoder().encode(text)), branch: this.local.gh.branch };
      if (sha) body.sha = sha;
      return this.gh(`/contents/${path}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    },
    async push() {
      if (!this.canSync()) throw new Error('尚未完成 GitHub 同步設定');
      const env = await this.encrypt(this.vault, this.passphrase);
      env.updatedAt = this.vault.updatedAt;
      let sha = this.local.vaultSha;
      const cur = await this.gh(`/contents/${VAULT_PATH}?ref=${encodeURIComponent(this.local.gh.branch)}&t=${Date.now()}`);
      if (cur) sha = cur.sha; else sha = undefined;
      const r = await this.putFile(VAULT_PATH, JSON.stringify(env, null, 1), `vault: update ${this.vault.updatedAt}`, sha);
      this.local.vaultSha = r.content.sha; this.local.dirty = false; this.local.lastSync = new Date().toISOString(); this.saveLocal();
      this.listeners.forEach(f => f('synced'));
      return r;
    },
    async pull() {
      const f = await this.getFile(VAULT_PATH);
      if (!f) return null;
      const env = JSON.parse(f.text);
      const v = await this.decrypt(env, this.passphrase);
      this.replaceVault(v);
      this.local.vaultSha = f.sha; this.local.dirty = false; this.local.lastSync = new Date().toISOString(); this.saveLocal();
      return v;
    },
    async remoteInfo() {
      const f = await this.getFile(VAULT_PATH);
      if (!f) return null;
      const env = JSON.parse(f.text);
      return { sha: f.sha, updatedAt: env.updatedAt, env };
    },
    async pullReport() {
      const f = await this.getFile(REPORT_PATH);
      if (!f) return null;
      const r = await this.decrypt(JSON.parse(f.text), this.passphrase);
      this.setReport(r);
      return r;
    },
    async dispatchReport(sendMail) {
      return this.gh(`/actions/workflows/daily-report.yml/dispatches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: this.local.gh.branch, inputs: { send_mail: sendMail ? 'true' : 'false' } })
      });
    },
    async latestRun() {
      const r = await this.gh(`/actions/workflows/daily-report.yml/runs?per_page=1`);
      return r && r.workflow_runs && r.workflow_runs[0];
    },
    /* 以台北時間設定 cron（GitHub 用 UTC） */
    cronFor(time, days) {
      const [h, m] = time.split(':').map(Number);
      let uh = h - 8, shift = 0;
      if (uh < 0) { uh += 24; shift = -1; }
      const d = [...new Set(days.map(x => ((x + shift) % 7 + 7) % 7))].sort().join(',');
      return `${m} ${uh} * * ${d || '*'}`;
    },
    async updateSchedule(time, days) {
      const f = await this.getFile(WORKFLOW_PATH);
      if (!f) throw new Error('找不到 workflow 檔案');
      const cron = this.cronFor(time, days);
      const text = f.text.replace(/- cron: ['"][^'"]+['"]/, `- cron: '${cron}'`);
      if (text === f.text) return cron;
      await this.putFile(WORKFLOW_PATH, text, `schedule: daily report ${time} (Asia/Taipei) → ${cron} UTC`, f.sha);
      return cron;
    }
  };
  window.Store = Store;
})();
