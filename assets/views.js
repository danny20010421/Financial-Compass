/* views.js — 各頁面 */
(function () {
  const { $, $$, esc, toast, form, sec, kpi, signCls, ring, donut, bars, legend } = UI;
  const S = () => Store, V = () => Store.vault;
  const { fmt, fmtShort, pct } = Calc;
  const CUR = ['TWD', 'USD', 'JPY', 'EUR', 'CNY', 'HKD', 'GBP', 'AUD'];
  const ACC_TYPES = ['活存', '數位帳戶', '證券交割', '定存', '外幣', '現金', '電子支付'];
  const Views = {};

  /* ---------------- 總覽 ---------------- */
  Views.home = el => {
    const snap = Calc.snapshot(), sc = Calc.score(snap), v = V();
    const g = v.goals[0], gp = g ? Calc.goalProgress(g, snap) : null;
    const rep = S().report;
    const st = Calc.settlements().slice(0, 4);
    const td = S().today(), in14 = Calc.ymd(new Date(Date.now() + 14 * 864e5)).slice(0, 10);
    const dues = [...v.payables.map(x => ({ ...x, k: '應付' })), ...v.receivables.map(x => ({ ...x, k: '應收' }))].filter(x => !x.done && x.due && x.due <= in14).sort((a, b) => a.due.localeCompare(b.due));
    const allocL = Object.values(Calc.BUCKETS), allocV = Object.keys(Calc.BUCKETS).map(k => snap.alloc[k] || 0);
    const t = v.profile.targetAlloc, tsum = t.core + t.satellite + t.bond + t.defensive || 100;
    const cf = Calc.cashflow(1)[0];
    const empty = !v.accounts.length && !v.trades.length && !v.txns.length;

    el.innerHTML = `
      <div class="muted small" style="margin-bottom:10px">${td}（台北）${rep ? `・報表基準日 ${esc(rep.tradeDate || '')}` : '・尚無每日報表'}</div>
      ${empty ? `<div class="note">歡迎使用！建議步驟：①「更多 → 財務診斷」填寫風險屬性 ②「更多 → 資產與現金」新增帳戶 ③ 記帳、新增股票交易 ④「設定」完成 GitHub 同步與每日寄信。<br><button class="btn sm" id="demo" style="margin-top:8px">先載入範例資料看看</button></div>` : ''}
      ${sec('01', '財務狀況總覽', `<div class="kpi-grid">
        ${kpi('淨資產', fmt(snap.netWorth), `總資產 ${fmtShort(snap.totalAssets)}・負債 ${fmtShort(snap.pay + snap.debt)}`)}
        ${kpi('金融資產總市值', fmt(snap.financial), `現金 ${fmtShort(snap.cash.total)}・股票 ${fmtShort(snap.stockMV)}`)}
        ${kpi('股票未實現損益', fmt(snap.upl), `報酬率 ${pct(snap.stockCost ? snap.upl / snap.stockCost : 0)}`, signCls(snap.upl))}
        ${kpi('目標達成率', gp ? pct(gp.pct) : '—', gp ? `差額 ${fmtShort(gp.gap)}・剩 ${gp.daysLeft} 天` : '尚未設定')}
      </div>`)}
      ${sec('02', '專業財務評分', `<div class="card"><div class="score-hero">${ring(sc.total, sc.grade)}<div style="min-width:0;flex:1">
          ${sc.dims.map(d => `<div style="margin-bottom:6px"><div class="dim-h small"><span>${d.name}</span><span class="num">${d.score}/${d.weight}</span></div><div class="bar" style="margin:3px 0 0;height:5px"><i style="width:${d.pct * 100}%"></i></div></div>`).join('')}
        </div></div><div class="note" style="margin-bottom:0">改善優先：${sc.priority.slice(0, 3).map((x, i) => `${i + 1}. ${x}`).join('　')}</div></div>`, '<a class="sec-a" href="#/score">明細 ›</a>')}
      ${sec('03', '年度計畫進度', v.goals.length ? v.goals.slice(0, 3).map(goalHTML).join('') : '<div class="empty">尚未設定目標</div>', '<a class="sec-a" href="#/goals">管理 ›</a>')}
      ${sec('04', '資產配置', snap.financial ? `<div class="grid2" style="align-items:center"><div class="chart-box" style="height:170px"><div id="cAlloc" style="height:100%"></div></div>
        <div class="small">${Object.keys(Calc.BUCKETS).map((k, i) => `<div style="padding:4px 0;border-bottom:1px solid var(--line)"><i style="display:inline-block;width:9px;height:9px;background:${UI.PALETTE[i]};margin-right:6px"></i>${Calc.BUCKETS[k].replace(/（.*/, '')}<br><span class="num">${pct((snap.alloc[k] || 0) / snap.financial)}</span> <span class="muted">／目標 ${pct(t[k] / tsum, 0)}</span></div>`).join('')}</div></div>` : '<div class="empty">新增帳戶與持股後顯示</div>')}
      ${sec('05', '交割／收付提醒', (st.length || dues.length) ? `<ul class="list">${st.map(s => `<li class="row"><div class="row-main"><div class="row-t"><span class="tag solid">交割</span>${esc(s.trade.name || s.trade.symbol)} ${s.trade.side === 'buy' ? '買進' : '賣出'}</div><div class="row-s">${s.date}（${s.trade.market === 'US' ? 'T+1' : 'T+2'}）</div></div><div class="row-v num ${signCls(s.amount)}">${fmt(s.amount, s.currency)}</div></li>`).join('')}
        ${dues.map(d => `<li class="row"><div class="row-main"><div class="row-t"><span class="tag ${d.due < td ? 'bad' : 'warn'}">${d.k}</span>${esc(d.name)}</div><div class="row-s">${d.due}${d.due < td ? '・已逾期' : ''}</div></div><div class="row-v num">${fmt(d.amount, d.currency)}</div></li>`).join('')}</ul>` : '<div class="empty">14 天內無交割或收付款</div>')}
      ${sec('06', '本月收支', `<div class="kpi-grid">${kpi('收入', fmt(cf.income))}${kpi('支出', fmt(cf.expense))}${kpi('結餘', fmt(cf.net), '', signCls(cf.net))}${kpi('儲蓄率', cf.rate === null ? '—' : pct(cf.rate), `目標 30%`)}</div>`, '<a class="sec-a" href="#/ledger">記帳 ›</a>')}
      <div class="btn-row"><button class="btn" id="qTx">＋ 記一筆</button><button class="btn ghost" id="qTr">＋ 股票交易</button></div>`;
    if (snap.financial) donut($('#cAlloc'), allocL, allocV);
    $('#qTx').onclick = () => txnForm();
    $('#qTr').onclick = () => tradeForm();
    const demo = $('#demo'); if (demo) demo.onclick = () => { loadDemo(); App.render(); toast('已載入範例資料'); };
  };

  function goalHTML(g) {
    const gp = Calc.goalProgress(g);
    return `<div class="goal"><div class="goal-h"><div class="goal-n">${esc(g.name)}</div><div class="num" style="font-weight:700;color:var(--navy-900)">${pct(gp.pct)}</div></div>
      <div class="bar"><i style="width:${Math.min(100, gp.pct * 100)}%"></i><span class="pace" style="left:${gp.pace * 100}%" title="時間進度"></span></div>
      <div class="goal-f"><span class="num">${fmtShort(gp.cur)} / ${fmtShort(g.target)}</span><span>${gp.onTrack ? '<span class="tag ok">進度正常</span>' : '<span class="tag warn">落後</span>'}每月需 ${fmtShort(gp.perMonth)}</span></div></div>`;
  }

  /* ---------------- 評分明細 ---------------- */
  Views.score = el => {
    const snap = Calc.snapshot(), sc = Calc.score(snap);
    el.innerHTML = sec('01', '專業財務評分（100 分制）', `<div class="card"><div class="score-hero">${ring(sc.total, sc.grade)}<div class="small">
        <div>權重：流動性 20%｜現金流／儲蓄 20%｜資產成長／目標 20%｜分散／集中 25%｜執行／交割／負債 15%</div>
        <div style="margin-top:6px"><b>改善優先順序：</b>${sc.priority.map((x, i) => `${i + 1}. ${x}`).join('　')}</div></div></div></div>`) +
      sec('02', '分項評估', sc.dims.map(d => `<div class="dim"><div class="dim-h"><b>${d.name}</b><span class="num"><b>${d.score}</b> / ${d.weight}</span></div>
        <div class="bar"><i style="width:${d.pct * 100}%"></i></div>
        <div class="dim-d"><b>依據</b>　${esc(d.basis)}</div><div class="dim-d"><b>優勢</b>　${esc(d.strength)}</div>
        <div class="dim-d"><b>風險</b>　${esc(d.risk)}</div><div class="dim-d"><b>改善</b>　${esc(d.fix)}</div></div>`).join('')) +
      `<button class="btn block" id="aiDiag">請 AI 顧問進行完整財務診斷</button>`;
    $('#aiDiag').onclick = () => { App.go('#/ai'); setTimeout(() => Views._aiQuick('diag'), 50); };
  };

  /* ---------------- 記帳 ---------------- */
  let ledgerMonth = null;
  Views.ledger = el => {
    const v = V(); const td = S().today();
    ledgerMonth = ledgerMonth || td.slice(0, 7);
    const months = [...new Set([td.slice(0, 7), ...v.txns.map(t => t.date.slice(0, 7))])].sort().reverse().slice(0, 12);
    const tx = v.txns.filter(t => t.date.startsWith(ledgerMonth)).sort((a, b) => b.date.localeCompare(a.date));
    const inc = tx.filter(t => t.type === 'income').reduce((s, t) => s + Calc.toTWD(t.amount, t.currency), 0);
    const exp = tx.filter(t => t.type === 'expense').reduce((s, t) => s + Calc.toTWD(t.amount, t.currency), 0);
    const cats = Calc.categoryBreakdown(ledgerMonth);
    const budget = +v.profile.monthlyBudget || 0;
    const cf = Calc.cashflow(6);
    const byDate = {}; tx.forEach(t => (byDate[t.date] = byDate[t.date] || []).push(t));
    const acc = id => (v.accounts.find(a => a.id === id) || {}).name || '';
    el.innerHTML = `<div class="chips">${months.map(m => `<button class="chip ${m === ledgerMonth ? 'on' : ''}" data-m="${m}">${m.replace('-', '/')}</button>`).join('')}</div>` +
      sec('01', '月收支摘要', `<div class="kpi-grid">${kpi('收入', fmt(inc))}${kpi('支出', fmt(exp), budget ? `預算 ${fmtShort(budget)}・${pct(exp / budget, 0)}` : '')}${kpi('結餘', fmt(inc - exp), '', signCls(inc - exp))}${kpi('儲蓄率', inc ? pct((inc - exp) / inc) : '—', '建議 ≥ 30%')}</div>`) +
      sec('02', '支出類別', cats.length ? `<div id="cCat"></div>` : '<div class="empty">本月尚無支出</div>') +
      sec('03', '近六個月現金流', `<div class="chart-box"><div id="cCf" style="height:100%"></div></div>`) +
      sec('04', '明細', Object.keys(byDate).length ? Object.entries(byDate).map(([d, ts]) => `<div class="small muted" style="margin-top:10px">${d}</div><ul class="list">${ts.map(t => `<li class="row click" data-id="${t.id}"><div class="row-main"><div class="row-t"><span class="tag">${esc(t.category)}</span>${esc(t.note || t.category)}</div><div class="row-s">${esc(acc(t.accountId))}</div></div><div class="row-v num ${t.type === 'income' ? 'up' : ''}">${t.type === 'income' ? '+' : '-'}${fmt(t.amount, t.currency).replace('-', '')}</div></li>`).join('')}</ul>`).join('') : '<div class="empty">點右下角 ＋ 開始記帳</div>') +
      `<button class="fab" id="fab" aria-label="新增">＋</button>`;
    $$('.chip', el).forEach(c => c.onclick = () => { ledgerMonth = c.dataset.m; App.render(); });
    $$('.row.click', el).forEach(r => r.onclick = () => txnForm(v.txns.find(t => t.id === r.dataset.id)));
    $('#fab').onclick = () => txnForm();
    if (cats.length) UI.hbars($('#cCat'), cats.map(c => c[0]), cats.map(c => Math.round(c[1])));
    bars($('#cCf'), cf.map(m => m.month.slice(5) + '月'), [{ label: '收入', data: cf.map(m => Math.round(m.income)) }, { label: '支出', data: cf.map(m => Math.round(m.expense)) }]);
  };

  function txnForm(t) {
    const v = V(); const isNew = !t; t = t || { type: 'expense', date: S().today(), currency: 'TWD', category: '餐飲', accountId: (v.accounts[0] || {}).id };
    const cats = [...new Set([...v.categories.expense.map(c => ['支出', c]), ...v.categories.income.map(c => ['收入', c])].map(x => x[1]))];
    form({ title: isNew ? '記一筆' : '編輯收支', fields: [
      { k: 'type', label: '類型', type: 'select', options: [['expense', '支出'], ['income', '收入']], value: t.type, half: 1 },
      { k: 'date', label: '日期', type: 'date', value: t.date, half: 1 },
      { k: 'amount', label: '金額', type: 'number', value: t.amount, required: 1, half: 1 },
      { k: 'currency', label: '幣別', type: 'select', options: CUR, value: t.currency, half: 1 },
      { k: 'category', label: '類別', type: 'select', options: cats, value: t.category, half: 1 },
      { k: 'accountId', label: '帳戶', type: 'select', options: [['', '（不指定）'], ...v.accounts.map(a => [a.id, a.name])], value: t.accountId, half: 1 },
      { k: 'note', label: '備註', value: t.note, ph: '例如：午餐、捷運' },
      { k: 'adj', label: '同步調整帳戶餘額', type: 'checkbox', value: isNew }
    ], onSubmit: val => {
      const rec = Object.assign(t, val, { amount: +val.amount }); delete rec.adj;
      if (isNew) { rec.id = S().uid(); v.txns.push(rec); }
      if (val.adj && rec.accountId) { const a = v.accounts.find(a => a.id === rec.accountId); if (a) a.balance = +a.balance + (rec.type === 'income' ? 1 : -1) * rec.amount * (a.currency === rec.currency ? 1 : Calc.fxRate(rec.currency) / Calc.fxRate(a.currency)); }
      S().commit('txn'); App.render(); toast('已儲存');
    }, onDelete: isNew ? null : () => { v.txns = v.txns.filter(x => x.id !== t.id); S().commit('txn'); App.render(); } });
  }
  Views.txnForm = txnForm;

  /* ---------------- 投資 ---------------- */
  let invTab = 'hold';
  Views.invest = el => {
    const v = V(), hs = Calc.holdings(); const snap = Calc.snapshot();
    const cost = hs.reduce((s, h) => s + h.costTWD, 0), mv = hs.reduce((s, h) => s + h.mvTWD, 0);
    const dates = [...new Set(hs.map(h => h.priceDate).filter(Boolean))];
    let body = '';
    if (invTab === 'hold') {
      body = sec('01', '持股總覽', `<div class="kpi-grid">${kpi('股票總成本', fmt(cost))}${kpi('股票總市值', fmt(mv))}${kpi('未實現損益', fmt(mv - cost), pct(cost ? (mv - cost) / cost : 0), signCls(mv - cost))}${kpi('已實現損益', fmt(Calc.realizedTWD()), '累計（台幣）', signCls(Calc.realizedTWD()))}</div>
        <div class="note">價格基準：${dates.length ? dates.join('、') + ' 收盤價' : '尚無收盤價（以成本暫估）'}${dates.length > 1 ? '　<b>⚠ 價格日期不一致</b>' : ''}。每日報表產生後自動更新；點持股可手動更新價格。</div>`) +
        sec('02', '持股明細', hs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>標的</th><th>股數</th><th>均價</th><th>收盤</th><th>市值(台幣)</th><th>損益</th><th>%</th><th>權重</th></tr></thead><tbody>
          ${hs.map(h => `<tr class="click" data-k="${h.key}" style="cursor:pointer"><td><b>${esc(h.symbol)}</b><br><span class="muted small">${esc(h.name).slice(0, 8)}</span></td><td>${h.qty.toLocaleString()}</td><td>${h.avg.toFixed(2)}</td><td>${h.stale ? '<span class="muted">—</span>' : h.price.toFixed(2)}</td><td>${Math.round(h.mvTWD).toLocaleString()}</td><td class="${signCls(h.uplTWD)}">${Math.round(h.uplTWD).toLocaleString()}</td><td class="${signCls(h.upl)}">${pct(h.uplPct)}</td><td>${pct(h.weight)}</td></tr>`).join('')}
          <tr class="total"><td>合計</td><td></td><td></td><td></td><td>${Math.round(mv).toLocaleString()}</td><td class="${signCls(mv - cost)}">${Math.round(mv - cost).toLocaleString()}</td><td>${pct(cost ? (mv - cost) / cost : 0)}</td><td>100%</td></tr></tbody></table></div>` : '<div class="empty">尚無持股，點 ＋ 新增交易</div>') +
        sec('03', '核心–衛星配置', `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>類別</th><th>市值</th><th>實際</th><th>目標</th><th>差距</th></tr></thead><tbody>${Object.keys(Calc.BUCKETS).map(k => { const t = v.profile.targetAlloc, ts = t.core + t.satellite + t.bond + t.defensive || 100; const a = (snap.alloc[k] || 0) / (snap.financial || 1), tg = t[k] / ts; return `<tr><td>${Calc.BUCKETS[k]}</td><td>${fmtShort(snap.alloc[k] || 0)}</td><td>${pct(a)}</td><td>${pct(tg, 0)}</td><td class="${Math.abs(a - tg) > 0.05 ? 'up' : ''}">${(a - tg >= 0 ? '+' : '') + pct(a - tg)}</td></tr>`; }).join('')}</tbody></table></div><div class="small muted" style="margin-top:6px">差距超過 ±5 個百分點建議再平衡（紅字）。現金計入「防禦／現金」。</div>`);
    } else if (invTab === 'trades') {
      const tr = [...v.trades].sort((a, b) => b.date.localeCompare(a.date));
      body = sec('01', '交易紀錄', tr.length ? `<ul class="list">${tr.map(t => `<li class="row click" data-id="${t.id}"><div class="row-main"><div class="row-t"><span class="tag ${t.side === 'buy' ? 'solid' : ''}">${t.side === 'buy' ? '買' : '賣'}</span>${esc(t.symbol)} ${esc(t.name || '')}</div><div class="row-s">${t.date} ${t.time || ''}・${(+t.qty).toLocaleString()} 股 @ ${(+t.price).toFixed(2)}・${Calc.BUCKETS[t.bucket] ? Calc.BUCKETS[t.bucket].replace(/（.*/, '') : ''}</div></div><div class="row-v num">${fmt(t.qty * t.price, t.currency)}</div></li>`).join('')}</ul>` : '<div class="empty">尚無交易</div>');
    } else {
      const st = Calc.settlements();
      body = sec('01', '交割排程', `<div class="note">台股 T+2、美股 T+1（僅排除週末，國定假日請自行留意）。</div>` + (st.length ? `<ul class="list">${st.map(s => `<li class="row"><div class="row-main"><div class="row-t">${s.date}　${esc(s.trade.symbol)} ${s.trade.side === 'buy' ? '買進應付' : '賣出應收'}</div><div class="row-s">成交日 ${s.trade.date}</div></div><div class="row-v num ${signCls(s.amount)}">${fmt(s.amount, s.currency)}</div></li>`).join('')}</ul>` : '<div class="empty">無待交割款項</div>'));
    }
    el.innerHTML = `<div class="seg"><button data-t="hold" class="${invTab === 'hold' ? 'on' : ''}">持股</button><button data-t="trades" class="${invTab === 'trades' ? 'on' : ''}">交易紀錄</button><button data-t="settle" class="${invTab === 'settle' ? 'on' : ''}">交割</button></div>${body}
      <button class="btn ghost block" id="aiStock">AI 個股／產業分析</button><button class="fab" id="fab">＋</button>`;
    $$('.seg button', el).forEach(b => b.onclick = () => { invTab = b.dataset.t; App.render(); });
    $('#fab').onclick = () => tradeForm();
    $('#aiStock').onclick = () => stockAsk();
    $$('tr.click', el).forEach(r => r.onclick = () => holdingSheet(hs.find(h => h.key === r.dataset.k)));
    $$('.row.click', el).forEach(r => r.onclick = () => tradeForm(v.trades.find(t => t.id === r.dataset.id)));
  };

  function tradeForm(t) {
    const v = V(), isNew = !t;
    t = t || { date: S().today(), market: 'TW', side: 'buy', currency: 'TWD', bucket: 'satellite', fee: '', tax: '' };
    form({ title: isNew ? '新增股票／ETF 交易' : '編輯交易', fields: [
      { k: 'market', label: '市場', type: 'select', options: [['TW', '台股（上市/上櫃）'], ['US', '美股']], value: t.market, half: 1 },
      { k: 'side', label: '買賣', type: 'select', options: [['buy', '買進'], ['sell', '賣出']], value: t.side, half: 1 },
      { k: 'symbol', label: '代號', value: t.symbol, ph: '2330 / 0050 / VOO', required: 1, half: 1 },
      { k: 'name', label: '名稱', value: t.name, ph: '台積電', half: 1 },
      { k: 'date', label: '成交日', type: 'date', value: t.date, half: 1 },
      { k: 'time', label: '成交時間（選填）', type: 'time', value: t.time, half: 1 },
      { k: 'qty', label: '股數', type: 'number', value: t.qty, required: 1, half: 1, hint: '1 張 = 1000 股' },
      { k: 'price', label: '成交價', type: 'number', value: t.price, required: 1, half: 1 },
      { k: 'fee', label: '手續費', type: 'number', value: t.fee, half: 1, hint: '空白＝台股自動以 0.1425% 計' },
      { k: 'tax', label: '交易稅', type: 'number', value: t.tax, half: 1, hint: '空白＝台股賣出自動計算' },
      { k: 'bucket', label: '配置類別', type: 'select', options: Object.entries(Calc.BUCKETS), value: t.bucket },
      { k: 'note', label: '交易理由／計畫（復盤用）', type: 'textarea', value: t.note, ph: '進場理由、目標價、停損條件、占比上限' }
    ], onSubmit: val => {
      const r = Object.assign(t, val); r.symbol = r.symbol.toUpperCase(); r.currency = r.market === 'US' ? 'USD' : 'TWD';
      const gross = +r.qty * +r.price;
      if (r.fee === '' && r.market === 'TW') r.fee = Math.max(20, Math.floor(gross * 0.001425));
      if (r.tax === '' && r.market === 'TW' && r.side === 'sell') r.tax = Math.floor(gross * (/^00/.test(r.symbol) ? 0.001 : 0.003));
      r.fee = +r.fee || 0; r.tax = +r.tax || 0; r.qty = +r.qty; r.price = +r.price;
      if (isNew) { r.id = S().uid(); v.trades.push(r); }
      S().commit('trade'); App.render(); toast('已儲存；報表將於下次產生時加入當日交易復盤');
    }, onDelete: isNew ? null : () => { v.trades = v.trades.filter(x => x.id !== t.id); S().commit('trade'); App.render(); } });
  }
  Views.tradeForm = tradeForm;

  function holdingSheet(h) {
    if (!h) return;
    UI.sheet(`<h3>${esc(h.symbol)} ${esc(h.name)}</h3>
      <div class="kpi-grid">${kpi('持有股數', h.qty.toLocaleString())}${kpi('平均成本', h.avg.toFixed(2), h.currency)}${kpi('收盤價', h.stale ? '—' : h.price.toFixed(2), `${h.priceDate || ''} ${esc(h.priceSource || '')}`)}${kpi('未實現損益', fmt(h.uplTWD), pct(h.uplPct), signCls(h.upl))}</div>
      <div class="note">占股票部位 ${pct(h.weight)}。提醒：持有不等於繼續買；低於成本不自動攤平。</div>
      <form id="pf"><div class="grid2"><label class="field"><span>手動收盤價</span><input name="p" type="number" step="any" inputmode="decimal" value="${h.stale ? '' : h.price}"></label><label class="field"><span>價格日期</span><input name="d" type="date" value="${S().today()}"></label></div>
      <div class="btn-row"><button type="button" class="btn ghost" id="aiH">AI 分析此標的</button><button class="btn">更新價格</button></div></form>`, (el, close) => {
      $('#pf', el).onsubmit = e => { e.preventDefault(); const p = +el.querySelector('[name=p]').value; if (!p) return; V().prices[h.key] = { close: p, date: el.querySelector('[name=d]').value, source: '手動輸入' }; S().commit('price'); close(); App.render(); };
      $('#aiH', el).onclick = () => { close(); stockAsk(h.symbol + ' ' + h.name, h.market); };
    });
  }

  function stockAsk(pre = '', market = 'TW') {
    form({ title: 'AI 個股／產業分析', submit: '開始分析', fields: [
      { k: 'q', label: '股票代號或名稱', value: pre, required: 1, ph: '2330 台積電 / NVDA' },
      { k: 'm', label: '市場', type: 'select', options: [['TW', '台股'], ['US', '美股'], ['OTHER', '其他']], value: market }
    ], onSubmit: val => {
      App.go('#/ai');
      setTimeout(() => Views._aiSend(`請針對「${val.q}」（${val.m === 'TW' ? '台股' : val.m === 'US' ? '美股' : '其他市場'}）提供客觀分析，所有數據須三方驗證且優先引用官方來源（公開資訊觀測站/交易所/公司財報/SEC）：
1. 最新收盤價與日期（註明來源）
2. 基本面：近 4 季與近 3 年營收成長、毛利率、營業利益率、EPS、自由現金流
3. 估值：P/E、P/B、殖利率，與自身歷史區間及同業比較
4. 護城河與競爭優勢
5. 產業前景與主要風險（含地緣政治、法規、景氣循環）
6. 若我考慮持有：適合放核心或衛星？建議占比上限、分批進場區間、停損（論點失效條件）與停利邏輯
7. 結論：以「數據支持的觀察」呈現，避免未經驗證的推薦
請結合我的財務摘要評估是否適合我。`, true), 50);
    } });
  }

  /* ---------------- 報表 ---------------- */
  Views.report = el => {
    const rep = S().report, ok = S().canSync();
    el.innerHTML = `<div class="btn-row" style="margin-bottom:12px">
        <button class="btn sm ghost" id="rPull" ${ok ? '' : 'disabled'}>下載最新報表</button>
        <button class="btn sm" id="rRun" ${ok ? '' : 'disabled'}>立即產生</button>
        <button class="btn sm ghost" id="rMail" ${ok ? '' : 'disabled'}>產生並寄信</button></div>
      ${ok ? '' : '<div class="note">完成「設定 → GitHub 同步」後，即可由 GitHub Actions 取得收盤價、新聞與 AI 分析並產生每日報表。以下先顯示本機即時報表。</div>'}
      <div id="rStatus" class="small muted"></div>
      <div class="seg" style="margin-top:8px"><button data-r="cloud" class="${rep ? 'on' : ''}">每日報表${rep ? `（${esc(rep.tradeDate)}）` : ''}</button><button data-r="local" class="${rep ? '' : 'on'}">本機即時</button></div>
      <div id="rBody"></div>`;
    const show = mode => {
      $$('.seg button', el).forEach(b => b.classList.toggle('on', b.dataset.r === mode));
      if (mode === 'cloud' && rep) {
        $('#rBody').innerHTML = `<div class="small muted">產生時間 ${esc(rep.generatedAt)}・資料 ${esc(rep.provider || '')}</div><iframe class="report-frame" id="rFrame" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"></iframe>`;
        const fr = $('#rFrame'); fr.srcdoc = rep.html.replace('<head>', '<head><base target="_blank">');
        fr.onload = () => { try { fr.style.height = fr.contentDocument.body.scrollHeight + 30 + 'px'; } catch (e) { } };
      } else if (mode === 'cloud') $('#rBody').innerHTML = '<div class="empty">尚無每日報表</div>';
      else localReport($('#rBody'));
    };
    $$('.seg button', el).forEach(b => b.onclick = () => show(b.dataset.r));
    show(rep ? 'cloud' : 'local');
    const status = m => $('#rStatus').textContent = m;
    $('#rPull').onclick = async () => { try { status('下載中…'); const r = await S().pullReport(); status(r ? '已更新' : '雲端尚無報表'); App.render(); } catch (e) { status('失敗：' + e.message); } };
    const run = async mail => {
      try {
        if (S().local.dirty) { status('先同步資料…'); await S().push(); }
        await S().dispatchReport(mail); status('已觸發 GitHub Actions，約 2–4 分鐘完成，完成後自動下載…');
        const t0 = Date.now();
        const poll = async () => {
          const run = await S().latestRun().catch(() => null);
          if (run && run.status === 'completed' && new Date(run.created_at).getTime() > t0 - 60e3) {
            if (run.conclusion === 'success') { await S().pullReport(); toast('報表已更新'); App.render(); }
            else status(`執行失敗（${run.conclusion}），請至 GitHub Actions 查看紀錄`);
            return;
          }
          if (Date.now() - t0 < 10 * 60e3) setTimeout(poll, 15000); else status('逾時，請稍後按「下載最新報表」');
        };
        setTimeout(poll, 20000);
      } catch (e) { status('失敗：' + e.message); }
    };
    $('#rRun').onclick = () => run(false);
    $('#rMail').onclick = () => run(true);
  };

  function localReport(box) {
    const v = V(), snap = Calc.snapshot(), sc = Calc.score(snap), cash = snap.cash;
    const g = v.goals[0], gp = g ? Calc.goalProgress(g, snap) : null;
    const fxCur = [...new Set([...v.accounts.map(a => a.currency), ...snap.hs.map(h => h.currency)])].filter(c => c !== 'TWD');
    const st = Calc.settlements();
    box.innerHTML =
      sec('1', '最新財務狀況總覽', `<div class="kpi-grid">${kpi('淨資產', fmt(snap.netWorth))}${kpi('金融資產', fmt(snap.financial))}${kpi('財務評分', sc.total + ' 分', '評等 ' + sc.grade)}${kpi('目標達成率', gp ? pct(gp.pct) : '—', gp ? '差額 ' + fmtShort(gp.gap) : '')}</div>`) +
      sec('2', '現金分類與應收應付', `<div class="tbl-wrap"><table class="tbl"><tbody>${Object.entries(cash.byType).map(([k, x]) => `<tr><td>${esc(k)}</td><td>${fmt(x)}</td></tr>`).join('')}<tr class="total"><td>現金合計</td><td>${fmt(cash.total)}</td></tr><tr><td>應收款</td><td>${fmt(snap.recv)}</td></tr><tr><td>應付款</td><td class="up">${fmt(-snap.pay)}</td></tr></tbody></table></div>`) +
      sec('3', '外幣換算', fxCur.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>幣別</th><th>匯率</th><th>外幣金額</th><th>折台幣</th></tr></thead><tbody>${fxCur.map(c => `<tr><td>${c}</td><td>${Calc.fxRate(c).toFixed(4)}</td><td>${(cash.byCur[c] || 0).toLocaleString()}</td><td>${fmt(Calc.toTWD(cash.byCur[c] || 0, c))}</td></tr>`).join('')}</tbody></table></div><div class="small muted">匯率來源：${S().report && S().report.fx ? '每日報表（臺灣銀行即期中價等）' : '手動設定'}</div>` : '<div class="empty">無外幣資產</div>') +
      sec('4', '股票明細', snap.hs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>標的</th><th>成本</th><th>市值</th><th>損益</th></tr></thead><tbody>${snap.hs.map(h => `<tr><td>${esc(h.symbol)}</td><td>${fmtShort(h.costTWD)}</td><td>${fmtShort(h.mvTWD)}</td><td class="${signCls(h.uplTWD)}">${fmtShort(h.uplTWD)}</td></tr>`).join('')}<tr class="total"><td>合計</td><td>${fmtShort(snap.stockCost)}</td><td>${fmtShort(snap.stockMV)}</td><td class="${signCls(snap.upl)}">${fmtShort(snap.upl)}</td></tr></tbody></table></div>` : '<div class="empty">無持股</div>') +
      sec('5', '金融資產總市值', `<div class="kpi-v" style="font-size:24px">${fmt(snap.financial)}</div>`) +
      sec('6', '專業財務評分', sc.dims.map(d => `<div class="dim"><div class="dim-h"><b>${d.name}</b><span>${d.score}/${d.weight}</span></div><div class="dim-d">${esc(d.basis)}</div><div class="dim-d"><b>改善：</b>${esc(d.fix)}</div></div>`).join('')) +
      sec('7', '交割／現金流提醒', st.length ? st.map(s => `<div class="dim-d">${s.date}　${esc(s.trade.symbol)}　${fmt(s.amount, s.currency)}</div>`).join('') : '<div class="empty">無</div>') +
      '<div class="small muted">完整版（收盤價驗證、交易復盤、市場情緒、新聞與 AI 建議）請使用雲端每日報表。</div>';
  }

  /* ---------------- 更多 ---------------- */
  Views.more = el => {
    const items = [['#/assets', '資產與現金', '帳戶・外幣・應收應付・負債'], ['#/goals', '年度計畫', '存錢任務與進度條'], ['#/profile', '財務診斷', '目標・風險屬性・配置'], ['#/ai', 'AI 顧問', '診斷・配置・個股分析'],
      ['#/news', '新聞分享', '理財與國際新聞'], ['#/learn', '理財學堂', '定期教學知識'], ['#/score', '財務評分', '100 分制明細'], ['#/settings', '設定', '同步・AI・每日寄信']];
    el.innerHTML = sec('', '功能選單', `<div class="menu">${items.map(i => `<a href="${i[0]}"><b>${i[1]}</b><small>${i[2]}</small></a>`).join('')}</div>`);
  };

  /* ---------------- 資產 ---------------- */
  Views.assets = el => {
    const v = V(), snap = Calc.snapshot();
    const listOf = (arr, fn, empty) => arr.length ? `<ul class="list">${arr.map(fn).join('')}</ul>` : `<div class="empty">${empty}</div>`;
    const addBtn = (id, t = '新增') => `<button class="sec-a" id="${id}">＋ ${t}</button>`;
    const td = S().today();
    el.innerHTML =
      sec('01', '現金帳戶', `<div class="kpi-grid" style="margin-bottom:10px">${kpi('現金總額（台幣）', fmt(snap.cash.total))}${kpi('帳戶數', v.accounts.length + ' 個', Object.keys(snap.cash.byCur).join('・'))}</div>` +
        listOf(v.accounts, a => `<li class="row click" data-t="acc" data-id="${a.id}"><div class="row-main"><div class="row-t"><span class="tag">${esc(a.type)}</span>${esc(a.name)}${a.id === v.profile.settlementAccountId ? ' <span class="tag solid">交割</span>' : ''}</div><div class="row-s">${a.currency}${a.currency !== 'TWD' ? `・折台幣 ${fmt(Calc.toTWD(a.balance, a.currency))}` : ''}</div></div><div class="row-v num">${fmt(+a.balance, a.currency, a.currency === 'TWD' ? 0 : 2)}</div></li>`, '尚無帳戶'), addBtn('addAcc')) +
      sec('02', '外幣匯率', `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>幣別</th><th>1 單位 = 台幣</th><th>來源</th></tr></thead><tbody>${Object.keys(v.fxManual).map(c => { const r = S().report && S().report.fx && S().report.fx[c]; return `<tr><td>${c}</td><td>${Calc.fxRate(c).toFixed(4)}</td><td class="small">${r ? esc(r.source) + ' ' + esc(r.date || '') : '手動'}</td></tr>`; }).join('')}</tbody></table></div>`) +
      sec('03', '應收款', listOf(v.receivables, r => `<li class="row click" data-t="recv" data-id="${r.id}"><div class="row-main"><div class="row-t">${r.done ? '<span class="tag ok">已收</span>' : (r.due && r.due < td ? '<span class="tag bad">逾期</span>' : '')}${esc(r.name)}</div><div class="row-s">到期 ${r.due || '—'}</div></div><div class="row-v num">${fmt(+r.amount, r.currency)}</div></li>`, '無'), addBtn('addRecv')) +
      sec('04', '應付款', listOf(v.payables, r => `<li class="row click" data-t="pay" data-id="${r.id}"><div class="row-main"><div class="row-t">${r.done ? '<span class="tag ok">已付</span>' : (r.due && r.due < td ? '<span class="tag bad">逾期</span>' : '')}${esc(r.name)}</div><div class="row-s">到期 ${r.due || '—'}</div></div><div class="row-v num">${fmt(+r.amount, r.currency)}</div></li>`, '無'), addBtn('addPay')) +
      sec('05', '其他資產', listOf(v.otherAssets, a => `<li class="row click" data-t="oa" data-id="${a.id}"><div class="row-main"><div class="row-t"><span class="tag">${esc(a.kind)}</span>${esc(a.name)}</div></div><div class="row-v num">${fmt(+a.value, a.currency)}</div></li>`, '如儲蓄險保價金、不動產、車輛'), addBtn('addOA')) +
      sec('06', '負債', listOf(v.liabilities, l => `<li class="row click" data-t="li" data-id="${l.id}"><div class="row-main"><div class="row-t">${esc(l.name)}</div><div class="row-s">利率 ${l.rate || 0}%・月付 ${fmt(+l.monthly || 0)}</div></div><div class="row-v num">${fmt(+l.balance, l.currency)}</div></li>`, '如房貸、信貸、車貸'), addBtn('addLi'));
    const F = {
      acc: (a) => editItem('accounts', a, '現金帳戶', [
        { k: 'name', label: '名稱', required: 1, ph: '國泰世華活存' }, { k: 'type', label: '類型', type: 'select', options: ACC_TYPES, half: 1 }, { k: 'currency', label: '幣別', type: 'select', options: CUR, half: 1 },
        { k: 'balance', label: '餘額', type: 'number', required: 1 }, { k: 'isSettle', label: '設為證券交割帳戶', type: 'checkbox' }], { type: '活存', currency: 'TWD' }),
      recv: (a) => editItem('receivables', a, '應收款', [{ k: 'name', label: '項目', required: 1 }, { k: 'amount', label: '金額', type: 'number', required: 1, half: 1 }, { k: 'currency', label: '幣別', type: 'select', options: CUR, half: 1 }, { k: 'due', label: '預計收款日', type: 'date' }, { k: 'done', label: '已收款', type: 'checkbox' }], { currency: 'TWD' }),
      pay: (a) => editItem('payables', a, '應付款', [{ k: 'name', label: '項目', required: 1, ph: '信用卡帳單' }, { k: 'amount', label: '金額', type: 'number', required: 1, half: 1 }, { k: 'currency', label: '幣別', type: 'select', options: CUR, half: 1 }, { k: 'due', label: '到期日', type: 'date' }, { k: 'done', label: '已付款', type: 'checkbox' }], { currency: 'TWD' }),
      oa: (a) => editItem('otherAssets', a, '其他資產', [{ k: 'name', label: '名稱', required: 1 }, { k: 'kind', label: '類型', type: 'select', options: ['保險', '不動產', '車輛', '退休金', '加密資產', '其他'] }, { k: 'value', label: '估值', type: 'number', required: 1, half: 1 }, { k: 'currency', label: '幣別', type: 'select', options: CUR, half: 1 }], { kind: '保險', currency: 'TWD' }),
      li: (a) => editItem('liabilities', a, '負債', [{ k: 'name', label: '名稱', required: 1 }, { k: 'balance', label: '剩餘本金', type: 'number', required: 1, half: 1 }, { k: 'currency', label: '幣別', type: 'select', options: CUR, half: 1 }, { k: 'rate', label: '年利率 %', type: 'number', half: 1 }, { k: 'monthly', label: '月付金', type: 'number', half: 1 }], { currency: 'TWD' })
    };
    const map = { acc: 'accounts', recv: 'receivables', pay: 'payables', oa: 'otherAssets', li: 'liabilities' };
    $$('.row.click', el).forEach(r => r.onclick = () => F[r.dataset.t](v[map[r.dataset.t]].find(x => x.id === r.dataset.id)));
    $('#addAcc').onclick = () => F.acc(); $('#addRecv').onclick = () => F.recv(); $('#addPay').onclick = () => F.pay(); $('#addOA').onclick = () => F.oa(); $('#addLi').onclick = () => F.li();
  };

  function editItem(coll, item, title, fields, defaults) {
    const v = V(), isNew = !item; item = item || Object.assign({}, defaults);
    if (coll === 'accounts') item.isSettle = item.id && item.id === v.profile.settlementAccountId;
    fields.forEach(f => f.value = item[f.k] !== undefined ? item[f.k] : f.value);
    form({ title: (isNew ? '新增' : '編輯') + title, fields, onSubmit: val => {
      Object.assign(item, val);
      if (isNew) { item.id = S().uid(); v[coll].push(item); }
      if (coll === 'accounts') { if (item.isSettle) v.profile.settlementAccountId = item.id; else if (v.profile.settlementAccountId === item.id) v.profile.settlementAccountId = ''; delete item.isSettle; }
      S().commit(coll); App.render();
    }, onDelete: isNew ? null : () => { v[coll] = v[coll].filter(x => x.id !== item.id); S().commit(coll); App.render(); } });
  }

  /* ---------------- 年度計畫 ---------------- */
  Views.goals = el => {
    const v = V();
    el.innerHTML = sec('01', '年度計畫與存錢任務', `<p class="lead">第一個目標會作為財務評分「資產成長／目標進度」的依據。橘色刻度為時間進度。</p>` +
      (v.goals.length ? v.goals.map((g, i) => `<div class="click" data-i="${i}" style="cursor:pointer">${goalHTML(g)}</div>`).join('') : '<div class="empty">尚無目標</div>'),
      '<button class="sec-a" id="addG">＋ 新增</button>') +
      `<div class="note">原則：落後時優先提高儲蓄與收入，而非提高投資風險；必要時延長期限。</div>`;
    const edit = g => {
      const isNew = !g; const y = new Date().getFullYear();
      g = g || { name: '', target: 1000000, start: 0, startDate: S().today(), deadline: `${y}-12-31`, metric: 'financial' };
      form({ title: isNew ? '新增目標' : '編輯目標', fields: [
        { k: 'name', label: '目標名稱', value: g.name, required: 1, ph: '一年存到 30 萬' },
        { k: 'metric', label: '追蹤指標', type: 'select', value: g.metric, options: [['financial', '金融資產總額（現金＋股票）'], ['netWorth', '淨資產'], ['savings', '期間累計儲蓄（收入−支出）'], ['stock', '股票市值'], ['manual', '手動更新數值']] },
        { k: 'target', label: '目標金額', type: 'number', value: g.target, required: 1, half: 1 },
        { k: 'start', label: '起始金額', type: 'number', value: g.start, half: 1, hint: '計算進度的基準' },
        { k: 'startDate', label: '開始日', type: 'date', value: g.startDate, half: 1 },
        { k: 'deadline', label: '截止日', type: 'date', value: g.deadline, half: 1, required: 1 },
        { k: 'current', label: '目前數值（手動指標）', type: 'number', value: g.current }
      ], onSubmit: val => { Object.assign(g, val); if (isNew) { g.id = S().uid(); v.goals.push(g); } S().commit('goal'); App.render(); },
        onDelete: isNew ? null : () => { v.goals = v.goals.filter(x => x !== g); S().commit('goal'); App.render(); } });
    };
    $('#addG').onclick = () => edit();
    $$('[data-i]', el).forEach(d => d.onclick = () => edit(v.goals[+d.dataset.i]));
  };

  /* ---------------- 財務診斷（個人化） ---------------- */
  Views.profile = el => {
    const v = V(), p = v.profile;
    el.innerHTML = sec('01', '財務目標與現況', `<form id="pf">
        <label class="field"><span>短期目標（1 年內）</span><input name="short" value="${esc(p.goalsText.short)}" placeholder="存到緊急預備金 30 萬"></label>
        <label class="field"><span>中期目標（1–5 年）</span><input name="mid" value="${esc(p.goalsText.mid)}" placeholder="金融資產 100 萬、購車頭期"></label>
        <label class="field"><span>長期目標（5 年以上）</span><input name="long" value="${esc(p.goalsText.long)}" placeholder="45 歲財務自由、退休金"></label>
        <div class="grid2"><label class="field"><span>每月稅後收入</span><input name="monthlyIncome" type="number" inputmode="decimal" value="${p.monthlyIncome || ''}"></label>
        <label class="field"><span>每月支出預算</span><input name="monthlyBudget" type="number" inputmode="decimal" value="${p.monthlyBudget || ''}"></label>
        <label class="field"><span>投資期限（年）</span><input name="horizonYears" type="number" value="${p.horizonYears || ''}"></label>
        <label class="field"><span>預備金目標（月）</span><input name="emergencyMonths" type="number" value="${p.emergencyMonths || 6}"></label></div>
        <button class="btn block">儲存</button></form>`) +
      sec('02', '風險屬性評估', `${p.riskLevel ? `<div class="note">目前評估：<b>${p.riskLevel}</b>（${p.riskScore} 分 / 32）</div>` : ''}<form id="rq">${RISK_Q.map((q, i) => `<div class="field"><span>${i + 1}. ${q.q}</span><select name="q${i}">${q.o.map((o, j) => `<option value="${j + 1}" ${p.riskAnswers['q' + i] == j + 1 ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`).join('')}<button class="btn block">計算風險屬性並建議配置</button></form>`) +
      sec('03', '目標配置（核心–衛星）', `<form id="al"><div class="grid2">${Object.entries(Calc.BUCKETS).map(([k, l]) => `<label class="field"><span>${l} %</span><input name="${k}" type="number" value="${p.targetAlloc[k]}"></label>`).join('')}</div><button class="btn block ghost">儲存目標配置</button></form>`);
    $('#pf').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); p.goalsText = { short: f.get('short'), mid: f.get('mid'), long: f.get('long') }; ['monthlyIncome', 'monthlyBudget', 'horizonYears', 'emergencyMonths'].forEach(k => p[k] = +f.get(k) || 0); S().commit('profile'); toast('已儲存'); };
    $('#rq').onsubmit = e => {
      e.preventDefault(); const f = new FormData(e.target); let s = 0;
      RISK_Q.forEach((q, i) => { const x = +f.get('q' + i); p.riskAnswers['q' + i] = x; s += x; });
      p.riskScore = s; p.riskLevel = s <= 16 ? '保守型' : s <= 24 ? '穩健型' : '積極型';
      p.targetAlloc = s <= 16 ? { core: 25, satellite: 5, bond: 45, defensive: 25 } : s <= 24 ? { core: 50, satellite: 10, bond: 25, defensive: 15 } : { core: 60, satellite: 20, bond: 10, defensive: 10 };
      S().commit('risk'); App.render(); toast(`評估結果：${p.riskLevel}，已套用建議配置`);
    };
    $('#al').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); Object.keys(Calc.BUCKETS).forEach(k => p.targetAlloc[k] = +f.get(k) || 0); S().commit('alloc'); toast('已儲存'); };
  };

  /* ---------------- 新聞 ---------------- */
  Views.news = el => {
    const v = V(), rep = S().report;
    const rn = (rep && rep.news) || [];
    const item = n => `<div class="card"><div class="small muted">${esc(n.region || '')}${n.date ? '・' + esc(n.date) : ''}${n.source ? '・' + esc(n.source) : ''}</div><div style="font-weight:700;color:var(--navy-900);margin:2px 0 4px">${esc(n.title)}</div>
      ${n.event ? `<div class="dim-d"><b>事件</b>　${esc(n.event)}</div>` : ''}${n.impact ? `<div class="dim-d"><b>影響</b>　${esc(n.impact)}</div>` : ''}${n.watch ? `<div class="dim-d"><b>觀察</b>　${esc(n.watch)}</div>` : ''}${n.note ? `<div class="dim-d">${esc(n.note)}</div>` : ''}
      ${n.url ? `<div class="cite"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.url)}</a></div>` : ''}</div>`;
    el.innerHTML = sec('01', '每日重點新聞', rn.length ? rn.map(item).join('') : '<div class="empty">每日報表產生後顯示（台灣 2–3 篇＋國際 2–3 篇）</div>', '<button class="sec-a" id="aiNews">AI 即時整理 ›</button>') +
      sec('02', '我的新聞分享', (v.news.length ? [...v.news].reverse().map((n, i) => `<div data-i="${v.news.length - 1 - i}" style="cursor:pointer">${item(n)}</div>`).join('') : '<div class="empty">貼上值得保存的理財或國際新聞連結</div>'), '<button class="sec-a" id="addN">＋ 分享</button>');
    const edit = n => { const isNew = !n; n = n || { date: S().today(), region: '台灣' };
      form({ title: isNew ? '分享新聞' : '編輯新聞', fields: [{ k: 'title', label: '標題', value: n.title, required: 1 }, { k: 'url', label: '連結', type: 'url', value: n.url }, { k: 'region', label: '分類', type: 'select', options: ['台灣', '國際', '理財', '產業'], value: n.region, half: 1 }, { k: 'date', label: '日期', type: 'date', value: n.date, half: 1 }, { k: 'note', label: '我的筆記／為何重要', type: 'textarea', value: n.note }],
        onSubmit: val => { Object.assign(n, val); if (isNew) { n.id = S().uid(); v.news.push(n); } S().commit('news'); App.render(); }, onDelete: isNew ? null : () => { v.news = v.news.filter(x => x !== n); S().commit('news'); App.render(); } }); };
    $('#addN').onclick = () => edit();
    $$('[data-i]', el).forEach(d => d.onclick = () => edit(v.news[+d.dataset.i]));
    $('#aiNews').onclick = () => { App.go('#/ai'); setTimeout(() => Views._aiQuick('news'), 50); };
  };

  /* ---------------- 理財學堂 ---------------- */
  Views.learn = el => {
    const day = Math.floor(Date.now() / 864e5) % LESSONS.length, L = LESSONS[day];
    el.innerHTML = sec('01', '今日一課', `<div class="card"><span class="tag solid">${L.lv}</span><div style="font-weight:700;color:var(--navy-900);margin:6px 0">${L.t}</div><div class="small">${L.b}</div></div><button class="btn ghost block" id="aiL" style="margin-top:10px">請 AI 依我的狀況出一堂課</button>`) +
      sec('02', '課程目錄', ['基礎', '配置', '分析', '交易', '制度'].map(lv => `<div class="small muted" style="margin-top:10px">${lv}</div>` + LESSONS.filter(x => x.lv === lv).map(x => `<details class="acc"><summary>${x.t}</summary><div class="small" style="margin-top:6px">${x.b}</div></details>`).join('')).join(''));
    $('#aiL').onclick = () => { App.go('#/ai'); setTimeout(() => Views._aiQuick('lesson'), 50); };
  };

  /* ---------------- AI 顧問 ---------------- */
  const chat = [];
  function finSummary() {
    const v = V(), snap = Calc.snapshot(), sc = Calc.score(snap), p = v.profile;
    const g = v.goals[0], gp = g ? Calc.goalProgress(g, snap) : null;
    return `【我的財務摘要｜${S().today()}｜金額單位：新台幣】
- 目標：短期 ${p.goalsText.short || '未填'}；中期 ${p.goalsText.mid || '未填'}；長期 ${p.goalsText.long || '未填'}
- 風險屬性：${p.riskLevel || '未評估'}；投資期限 ${p.horizonYears || '未填'} 年；月收入 ${p.monthlyIncome || '未填'}；月支出預算 ${p.monthlyBudget || '未填'}
- 淨資產 ${Math.round(snap.netWorth)}；金融資產 ${Math.round(snap.financial)}（現金 ${Math.round(snap.cash.total)}、股票市值 ${Math.round(snap.stockMV)}、未實現損益 ${Math.round(snap.upl)}）；負債 ${Math.round(snap.debt + snap.pay)}
- 近三月月均收入 ${Math.round(sc.avgInc)}、支出 ${Math.round(sc.avgExp)}、儲蓄率 ${pct(sc.savingRate)}；預備金可支應 ${sc.months.toFixed(1)} 個月
- 目標配置：核心 ${p.targetAlloc.core}%／衛星 ${p.targetAlloc.satellite}%／債券 ${p.targetAlloc.bond}%／防禦現金 ${p.targetAlloc.defensive}%；實際：${Object.keys(Calc.BUCKETS).map(k => Calc.BUCKETS[k].replace(/（.*/, '') + ' ' + pct((snap.alloc[k] || 0) / (snap.financial || 1))).join('、')}
- 持股：${snap.hs.map(h => `${h.symbol}${h.name !== h.symbol ? '(' + h.name + ')' : ''} ${h.qty}股 均價${h.avg.toFixed(2)} 現價${h.price.toFixed(2)} 權重${pct(h.weight)} [${h.bucket}]`).join('；') || '無'}
- 主要目標：${g ? `${g.name}，達成率 ${pct(gp.pct)}，差額 ${Math.round(gp.gap)}，剩 ${gp.daysLeft} 天` : '無'}
- 財務評分 ${sc.total}/100（${sc.dims.map(d => d.name + ' ' + d.score + '/' + d.weight).join('、')}）`;
  }
  Views.finSummary = finSummary;

  const QUICK = {
    diag: '請進行完整的「個人化財務診斷」：先評估我的短中長期目標、風險承受度、投資期限與資金狀況是否一致，指出資料不足之處；再給出薪資／儲蓄規劃（比例與金額）、緊急預備金、保險缺口檢查清單，以及 1–7 天、1–3 個月、至目標期的行動清單。',
    alloc: '請依我的風險屬性與目標，設計「核心–衛星」資產配置：列出建議比例、各類別可考慮的標的類型（指數 ETF、債券 ETF、防禦性資產，請以類型與官方可查資料說明，並附最新價格與日期來源），以及從目前配置過渡到目標的分批執行計畫（考量交易成本與稅費）。',
    rebal: '請檢查我的投資組合是否需要再平衡：計算各類別偏離、集中度（最大部位、HHI），提出以新資金或減碼方式的再平衡步驟，並設定未來的再平衡規則（時間＋門檻）。',
    risk: '請為我的每一檔持股建立風險控管規則：適合的部位上限、分批加碼條件、停損（論點失效）與停利（分批/移動停利）邏輯，並提醒不因低於成本而自動攤平。',
    news: '請用網路搜尋整理今天最重要的 2–3 則台灣財經/市場新聞與 2–3 則國際財經/市場新聞，優先官方或原始來源（央行、金管會、主計總處、證交所、Fed、BLS、ECB、公司公告等），每則說明：事件（事實）、為何影響我（結合我的持股與配置）、接下來觀察什麼，並附可點擊來源連結。市場事實與情緒判讀請分開。',
    lesson: '請根據我目前的財務狀況與弱項，設計一堂 5 分鐘的理財／投資課程：一個核心概念、用我的數字舉例、常見錯誤、今天就能做的一個行動，最後出 3 題小測驗（附答案）。'
  };

  Views.ai = el => {
    const L = S().local.ai;
    el.innerHTML = sec('', 'AI 財務顧問', `<p class="lead">使用 ${AI.NAMES[L.provider]}${L.verify ? `，並由 ${AI.NAMES[L.verify]} 交叉審核` : ''}。回答會搜尋網路並優先引用官方來源。僅供參考，非投資建議。</p>
      <div class="chips">${[['diag', '財務診斷'], ['alloc', '資產配置'], ['rebal', '再平衡檢查'], ['risk', '停損停利'], ['news', '今日新聞'], ['lesson', '教學一課']].map(x => `<button class="chip" data-q="${x[0]}">${x[1]}</button>`).join('')}<button class="chip" id="qStock">個股分析</button></div>
      <div class="chat" id="chat"></div>
      <form id="cf"><label class="field"><textarea name="m" placeholder="輸入問題，例如：以我的狀況每月該投入多少？" style="min-height:70px"></textarea></label>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin:-6px 0 10px"><input type="checkbox" id="ctx" checked> 附上我的財務摘要（僅傳送給所選 AI）</label>
      <div class="btn-row"><button type="button" class="btn ghost" id="clr">清除對話</button><button class="btn">送出</button></div></form>`);
    drawChat();
    $$('[data-q]', el).forEach(b => b.onclick = () => Views._aiQuick(b.dataset.q));
    $('#qStock').onclick = () => stockAsk();
    $('#cf').onsubmit = e => { e.preventDefault(); const m = e.target.m.value.trim(); if (!m) return; e.target.m.value = ''; Views._aiSend(m, $('#ctx').checked); };
    $('#clr').onclick = () => { chat.length = 0; drawChat(); };
  };
  function drawChat() {
    const box = $('#chat'); if (!box) return;
    box.innerHTML = chat.map(m => m.role === 'user' ? `<div class="msg user">${esc(m.show || m.content)}</div>` :
      `<div class="msg ai">${m.pending ? '<span class="muted">分析中（搜尋與驗證約需 20–60 秒）…</span>' : AI.md(m.content)}
        ${m.sources && m.sources.length ? `<div class="cite">資料來源<br>${m.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join('')}</div>` : ''}
        ${m.review ? `<details class="acc"><summary>${esc(m.review.provider)} 交叉審核意見</summary><div>${AI.md(m.review.text)}</div></details>` : ''}
        ${m.provider ? `<div class="small muted" style="margin-top:4px">— ${esc(m.provider)}</div>` : ''}</div>`).join('');
    const last = box.lastElementChild; if (last) last.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  Views._aiQuick = k => Views._aiSend(QUICK[k], true, { diag: '財務診斷', alloc: '資產配置規劃', rebal: '再平衡檢查', risk: '停損停利規劃', news: '今日重點新聞', lesson: '今日教學' }[k]);
  Views._aiSend = async (text, withCtx, show) => {
    const content = withCtx ? `${finSummary()}\n\n【問題】\n${text}` : text;
    chat.push({ role: 'user', content, show: show || text });
    const ph = { role: 'assistant', content: '', pending: true }; chat.push(ph); drawChat();
    try {
      const r = await AI.ask(chat.filter(m => !m.pending).map(m => ({ role: m.role, content: m.content })));
      Object.assign(ph, { content: r.text, sources: r.sources, review: r.review, provider: r.provider, pending: false });
    } catch (e) { Object.assign(ph, { content: '⚠ ' + e.message, pending: false }); }
    drawChat();
  };

  /* ---------------- 設定 ---------------- */
  Views.settings = el => {
    const L = S().local, v = V();
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    el.innerHTML =
      sec('01', 'GitHub 同步（加密）', `<p class="lead">資料以你的「同步密語」AES-256 加密後存到 repo，任何人（含公開 repo 訪客）都無法讀取。密語遺失將無法解密，請妥善保存。</p>
        <form id="gh"><div class="grid2"><label class="field"><span>GitHub 帳號</span><input name="owner" value="${esc(L.gh.owner)}" autocomplete="off"></label><label class="field"><span>Repo 名稱</span><input name="repo" value="${esc(L.gh.repo)}" autocomplete="off"></label></div>
        <div class="grid2"><label class="field"><span>分支</span><input name="branch" value="${esc(L.gh.branch)}"></label><label class="field"><span>同步密語</span><input name="pass" type="password" value="${esc(S().passphrase)}" autocomplete="new-password"></label></div>
        <label class="field"><span>Personal Access Token（fine-grained）</span><input name="token" type="password" value="${esc(L.gh.token)}" autocomplete="off"><small class="hint">權限：此 repo 的 Contents（讀寫）、Actions（讀寫）、Workflows（讀寫）。只存在此瀏覽器。</small></label>
        <label class="small" style="display:flex;gap:6px;align-items:center;margin-bottom:10px"><input type="checkbox" name="remember" ${L.rememberPass ? 'checked' : ''}> 在此裝置記住密語（個人裝置才建議）</label>
        <div class="btn-row"><button class="btn">儲存並測試</button><button type="button" class="btn ghost" id="pull">從雲端下載</button><button type="button" class="btn ghost" id="push">上傳到雲端</button></div></form>
        <div class="small muted" style="margin-top:6px">上次同步：${L.lastSync ? new Date(L.lastSync).toLocaleString('zh-TW') : '—'}${L.dirty ? '・<span style="color:var(--warn)">有未同步變更</span>' : ''}</div>`) +
      sec('02', 'AI 串接', `<form id="ai"><div class="grid2"><label class="field"><span>主要 AI</span><select name="provider">${Object.entries(AI.NAMES).map(([k, n]) => `<option value="${k}" ${L.ai.provider === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>交叉審核 AI</span><select name="verify"><option value="">不使用</option>${Object.entries(AI.NAMES).map(([k, n]) => `<option value="${k}" ${L.ai.verify === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
        ${['gemini', 'openai', 'claude'].map(k => `<div class="grid2"><label class="field"><span>${AI.NAMES[k]} API Key</span><input name="${k}_key" type="password" value="${esc(L.ai[k].key)}" autocomplete="off"></label><label class="field"><span>模型</span><input name="${k}_model" value="${esc(L.ai[k].model)}"></label></div>`).join('')}
        <small class="hint" style="margin:-4px 0 10px;display:block">金鑰只存在此瀏覽器，供網站內 AI 顧問使用；每日報表使用的金鑰請另設於 GitHub Secrets。</small>
        <button class="btn block">儲存 AI 設定</button></form>`) +
      sec('03', '每日報表寄送', `<form id="ml"><label class="field"><span>收件信箱</span><input name="mailTo" type="email" value="${esc(v.settings.mailTo)}" placeholder="you@example.com"><small class="hint">存於加密資料中；寄件帳號（SMTP）請設定於 GitHub Secrets。</small></label>
        <div class="grid2"><label class="field"><span>寄送時間（台北）</span><input name="sendTime" type="time" value="${esc(v.settings.sendTime)}"><small class="hint">建議 07:30：台股與美股皆已收盤</small></label><label class="field"><span>100 萬里程碑</span><input name="milestone" type="number" value="${v.settings.milestone}"></label></div>
        <div class="field"><span>寄送日</span><div class="chips" style="flex-wrap:wrap">${days.map((d, i) => `<label class="chip ${v.settings.sendDays.includes(i) ? 'on' : ''}"><input type="checkbox" name="d${i}" ${v.settings.sendDays.includes(i) ? 'checked' : ''} hidden>週${d}</label>`).join('')}</div></div>
        <button class="btn block">儲存並更新排程</button></form><div class="small muted" id="cronInfo" style="margin-top:6px"></div>`) +
      sec('04', '手動匯率（報表匯率優先）', `<form id="fx"><div class="grid2">${Object.entries(v.fxManual).map(([c, r]) => `<label class="field"><span>${c} → TWD</span><input name="${c}" type="number" step="any" value="${r}"></label>`).join('')}</div><button class="btn block ghost">儲存匯率</button></form>`) +
      sec('05', '資料管理', `<div class="btn-row"><button class="btn ghost" id="exp">匯出 JSON</button><label class="btn ghost">匯入 JSON<input type="file" id="imp" accept="application/json" hidden></label></div>
        <div class="btn-row" style="margin-top:8px"><button class="btn ghost" id="demo">載入範例資料</button><button class="btn danger" id="wipe">清除本機資料</button></div>`);

    $$('#ml .chip').forEach(c => c.onclick = e => { if (e.target.tagName === 'INPUT') return; e.preventDefault(); const cb = c.querySelector('input'); cb.checked = !cb.checked; c.classList.toggle('on', cb.checked); });
    $('#gh').onsubmit = async e => {
      e.preventDefault(); const f = new FormData(e.target);
      Object.assign(L.gh, { owner: f.get('owner').trim(), repo: f.get('repo').trim(), branch: f.get('branch').trim() || 'main', token: f.get('token').trim() });
      S().passphrase = f.get('pass'); L.rememberPass = !!f.get('remember'); L.pass = L.rememberPass ? S().passphrase : ''; S().saveLocal();
      if (!S().canSync()) return toast('請填寫完整');
      try {
        const info = await S().remoteInfo();
        if (!info) { await S().push(); toast('連線成功，已建立雲端加密資料'); }
        else {
          try { await S().decrypt(info.env, S().passphrase); } catch (x) { return toast('密語與雲端資料不符，無法解密'); }
          if (confirm(`雲端已有資料（更新於 ${new Date(info.updatedAt).toLocaleString('zh-TW')}）。\n按「確定」下載雲端資料覆蓋本機；按「取消」以本機資料上傳覆蓋雲端。`)) await S().pull(); else await S().push();
          toast('同步完成');
        }
        S().pullReport().catch(() => { });
        App.render();
      } catch (x) { toast('失敗：' + x.message, 4000); }
    };
    $('#pull').onclick = async () => { try { await S().pull(); await S().pullReport().catch(() => { }); toast('已下載'); App.render(); } catch (x) { toast('失敗：' + x.message, 4000); } };
    $('#push').onclick = async () => { try { await S().push(); toast('已上傳'); App.render(); } catch (x) { toast('失敗：' + x.message, 4000); } };
    $('#ai').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); L.ai.provider = f.get('provider'); L.ai.verify = f.get('verify'); ['gemini', 'openai', 'claude'].forEach(k => { L.ai[k].key = f.get(k + '_key').trim(); L.ai[k].model = f.get(k + '_model').trim(); }); S().saveLocal(); v.settings.aiProvider = L.ai.provider; v.settings.verifyProvider = L.ai.verify; S().commit('ai'); toast('已儲存'); };
    $('#ml').onsubmit = async e => {
      e.preventDefault(); const f = new FormData(e.target);
      v.settings.mailTo = f.get('mailTo').trim(); v.settings.sendTime = f.get('sendTime') || '07:30'; v.settings.milestone = +f.get('milestone') || 1000000;
      v.settings.sendDays = days.map((_, i) => f.get('d' + i) ? i : -1).filter(i => i >= 0);
      S().commit('mail');
      const cron = S().cronFor(v.settings.sendTime, v.settings.sendDays);
      if (!S().canSync()) { $('#cronInfo').textContent = `已儲存。尚未設定 GitHub，請手動將 workflow 的 cron 改為 '${cron}'（UTC）`; return; }
      try { await S().push(); await S().updateSchedule(v.settings.sendTime, v.settings.sendDays); $('#cronInfo').textContent = `排程已更新：cron '${cron}'（UTC）。GitHub 排程可能延遲 5–30 分鐘。`; }
      catch (x) { $('#cronInfo').textContent = `資料已存，但排程更新失敗（${x.message}）。請確認 Token 具 Workflows 權限，或手動修改 cron 為 '${cron}'`; }
    };
    $('#fx').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); Object.keys(v.fxManual).forEach(c => v.fxManual[c] = +f.get(c) || v.fxManual[c]); S().commit('fx'); toast('已儲存'); };
    $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' })); a.download = `finance-backup-${S().today()}.json`; a.click(); };
    $('#imp').onchange = async e => { const file = e.target.files[0]; if (!file) return; try { S().replaceVault(JSON.parse(await file.text())); S().commit('import'); toast('已匯入'); App.render(); } catch (x) { toast('檔案格式錯誤'); } };
    $('#demo').onclick = () => { if (confirm('載入範例資料會覆蓋本機資料，確定？')) { loadDemo(); App.render(); toast('已載入範例資料'); } };
    $('#wipe').onclick = () => { if (confirm('確定清除本機所有財務資料？（雲端資料不受影響）')) { S().resetAll(); App.render(); } };
  };

  /* ---------------- 範例資料 ---------------- */
  function loadDemo() {
    const v = V(), u = S().uid, td = S().today();
    const d = n => { const x = new Date(td + 'T00:00:00'); x.setDate(x.getDate() - n); if (n > 0) while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() - 1); return Calc.ymd(x).slice(0, 10); };
    const a1 = u(), a2 = u(), a3 = u(), a4 = u();
    v.accounts = [{ id: a1, name: '薪轉活存', type: '活存', currency: 'TWD', balance: 128000 }, { id: a2, name: '證券交割戶', type: '證券交割', currency: 'TWD', balance: 86000 },
      { id: a3, name: '高利數位帳戶', type: '數位帳戶', currency: 'TWD', balance: 150000 }, { id: a4, name: '美元帳戶', type: '外幣', currency: 'USD', balance: 3200 }];
    v.profile = Object.assign(v.profile, { monthlyIncome: 62000, monthlyBudget: 35000, riskLevel: '穩健型', riskScore: 21, horizonYears: 7, settlementAccountId: a2,
      goalsText: { short: '緊急預備金 6 個月', mid: '金融資產 100 萬', long: '45 歲前被動收入覆蓋基本開銷' }, targetAlloc: { core: 50, satellite: 10, bond: 25, defensive: 15 } });
    v.trades = [
      { id: u(), date: d(120), market: 'TW', symbol: '0050', name: '元大台灣50', side: 'buy', qty: 1000, price: 178.5, fee: 254, tax: 0, currency: 'TWD', bucket: 'core', note: '核心定期買進' },
      { id: u(), date: d(60), market: 'TW', symbol: '2330', name: '台積電', side: 'buy', qty: 100, price: 1080, fee: 154, tax: 0, currency: 'TWD', bucket: 'satellite', note: 'AI 需求，衛星部位上限 10%' },
      { id: u(), date: d(45), market: 'TW', symbol: '00679B', name: '元大美債20年', side: 'buy', qty: 3000, price: 28.1, fee: 120, tax: 0, currency: 'TWD', bucket: 'bond' },
      { id: u(), date: d(30), market: 'US', symbol: 'VOO', name: 'Vanguard S&P 500', side: 'buy', qty: 4, price: 560, fee: 3, tax: 0, currency: 'USD', bucket: 'core' },
      { id: u(), date: d(1), market: 'TW', symbol: '0050', name: '元大台灣50', side: 'buy', qty: 200, price: 185.2, fee: 52, tax: 0, currency: 'TWD', bucket: 'core', note: '月初定期定額' }];
    const cats = [['餐飲', 9000], ['交通', 2200], ['居住', 12000], ['日用', 2500], ['娛樂', 3000], ['通訊', 999], ['保險', 2800]];
    v.txns = [];
    for (let m = 0; m < 4; m++) {
      const base = new Date(td.slice(0, 7) + '-01T00:00:00'); base.setMonth(base.getMonth() - m);
      const ym = Calc.ymd(base).slice(0, 7);
      const maxDay = m === 0 ? +td.slice(8) : 28;
      v.txns.push({ id: u(), date: `${ym}-05` <= td ? `${ym}-05` : td, type: 'income', amount: 62000, currency: 'TWD', category: '薪資', accountId: a1, note: '月薪' });
      cats.forEach(([c, amt], i) => { const day = Math.min(maxDay, 3 + i * 3); v.txns.push({ id: u(), date: `${ym}-${String(day).padStart(2, '0')}`, type: 'expense', amount: Math.round(amt * (0.8 + Math.random() * 0.4)), currency: 'TWD', category: c, accountId: a1, note: c }); });
    }
    v.receivables = [{ id: u(), name: '朋友代墊餐費', amount: 1800, currency: 'TWD', due: d(-5), done: false }];
    v.payables = [{ id: u(), name: '信用卡帳單', amount: 18500, currency: 'TWD', due: d(-9), done: false }];
    v.otherAssets = [{ id: u(), name: '儲蓄險保價金', kind: '保險', value: 85000, currency: 'TWD' }];
    v.liabilities = [];
    v.prices = { 'TW:0050': { close: 186.4, date: d(1), source: '範例' }, 'TW:2330': { close: 1135, date: d(1), source: '範例' }, 'TW:00679B': { close: 27.6, date: d(1), source: '範例' }, 'US:VOO': { close: 574.2, date: d(1), source: '範例' } };
    v.news = [{ id: u(), date: td, region: '理財', title: '範例：央行理監事會議利率決議', url: 'https://www.cbc.gov.tw/', note: '關注房貸與定存利率變化' }];
    S().commit('demo');
  }
  Views.loadDemo = loadDemo;

  window.Views = Views;
})();
