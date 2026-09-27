/* app.js — 啟動、路由、解鎖、同步 */
(function () {
  const { $, $$, toast, esc } = UI;
  const TITLES = { home: '總覽', ledger: '記帳', invest: '投資', report: '每日報表', more: '更多', assets: '資產與現金', goals: '年度計畫', profile: '財務診斷', ai: 'AI 顧問', news: '新聞分享', learn: '理財學堂', score: '財務評分', settings: '設定' };
  const TAB_OF = { assets: 'more', goals: 'more', profile: 'more', ai: 'more', news: 'more', learn: 'more', score: 'home', settings: 'more' };

  const App = {
    route() { return (location.hash.replace('#/', '') || 'home').split('?')[0]; },
    go(h) { if (location.hash === h) this.render(); else location.hash = h; },
    render() {
      const r = Views[this.route()] ? this.route() : 'home';
      UI.destroyCharts();
      const el = $('#view');
      try { Views[r](el); } catch (e) { console.error(e); el.innerHTML = `<div class="empty">頁面錯誤：${esc(e.message)}</div>`; }
      $$('#tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === (TAB_OF[r] || r)));
      $('#brandSub').textContent = TITLES[r] ? `${TITLES[r]}｜Personal Finance` : 'Personal Finance & Investment';
      this.syncDot();
    },
    syncDot() {
      const d = $('#syncDot'), L = Store.local;
      d.className = 'dot ' + (!Store.canSync() ? '' : L.dirty ? 'dirty' : 'ok');
    }
  };
  window.App = App;

  window.addEventListener('hashchange', () => { App.render(); window.scrollTo(0, 0); });
  Store.onChange(() => App.syncDot());

  $('#syncBtn').onclick = async () => {
    if (!Store.canSync()) { App.go('#/settings'); return toast('請先完成 GitHub 同步設定'); }
    const b = $('#syncBtn'); b.classList.add('spin');
    try {
      if (Store.local.dirty) await Store.push(); else await Store.pull();
      await Store.pullReport().catch(() => { });
      toast('同步完成'); App.render();
    } catch (e) { $('#syncDot').className = 'dot err'; toast('同步失敗：' + e.message, 4000); }
    b.classList.remove('spin');
  };

  async function startSync() {
    try {
      const info = await Store.remoteInfo();
      if (info) {
        const remoteNewer = info.updatedAt > Store.vault.updatedAt;
        if (remoteNewer && !Store.local.dirty) await Store.pull();
        else if (remoteNewer && Store.local.dirty) {
          if (confirm('雲端與本機都有新的變更。\n確定＝使用雲端版本；取消＝以本機版本覆蓋雲端')) await Store.pull(); else await Store.push();
        } else if (Store.local.dirty) await Store.push();
      } else await Store.push();
      await Store.pullReport().catch(() => { });
      App.render();
    } catch (e) { console.warn(e); $('#syncDot').className = 'dot err'; }
  }

  function lockScreen() {
    const lk = $('#lock'); lk.hidden = false;
    lk.innerHTML = `<h1>資產羅盤</h1><p class="muted small" style="margin:0 0 20px">請輸入同步密語以解密雲端資料（${esc(Store.local.gh.owner)}/${esc(Store.local.gh.repo)}）</p>
      <form id="lf"><label class="field"><span>同步密語</span><input type="password" name="p" autocomplete="current-password" autofocus></label>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin-bottom:14px"><input type="checkbox" name="r"> 在此裝置記住</label>
      <button class="btn block">解鎖</button></form><button class="btn ghost block" id="skip" style="margin-top:10px">暫時僅使用本機資料</button><div id="lerr" class="small" style="color:var(--bad);margin-top:8px"></div>`;
    $('#lf').onsubmit = async e => {
      e.preventDefault(); const p = e.target.p.value;
      Store.passphrase = p;
      try {
        const info = await Store.remoteInfo();
        if (info) await Store.decrypt(info.env, p);
        if (e.target.r.checked) { Store.local.rememberPass = true; Store.local.pass = p; Store.saveLocal(); }
        lk.hidden = true; App.render(); startSync();
      } catch (x) { Store.passphrase = ''; $('#lerr').textContent = /decrypt|operation/i.test(x.name + x.message) ? '密語錯誤' : '連線失敗：' + x.message; }
    };
    $('#skip').onclick = () => { lk.hidden = true; App.render(); };
  }

  // 啟動
  if (Store.local.rememberPass && Store.local.pass) Store.passphrase = Store.local.pass;
  const g = Store.local.gh;
  App.render();
  if (g.owner && g.repo && g.token) { if (Store.passphrase) startSync(); else lockScreen(); }
})();
