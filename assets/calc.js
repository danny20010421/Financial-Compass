/* calc.js — 財務計算與 100 分制評分（與 scripts/finance_core.py 邏輯一致） */
(function () {
  const S = () => window.Store;
  const round = (x, d = 0) => { const p = 10 ** d; return Math.round((x + Number.EPSILON) * p) / p; };
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const BUCKETS = { core: '核心（指數ETF）', satellite: '衛星（成長個股）', bond: '債券', defensive: '防禦／現金' };

  function fxRate(cur) {
    if (!cur || cur === 'TWD') return 1;
    const r = S().report && S().report.fx && S().report.fx[cur];
    if (r && r.rate) return r.rate;
    return S().vault.fxManual[cur] || 1;
  }
  const toTWD = (amt, cur) => (Number(amt) || 0) * fxRate(cur);

  function priceOf(key) {
    const rep = S().report && S().report.prices && S().report.prices[key];
    const man = S().vault.prices[key];
    if (rep && man) return (man.date > rep.date) ? man : rep;
    return rep || man || null;
  }

  function holdings() {
    const map = {};
    const trades = [...S().vault.trades].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    for (const t of trades) {
      const key = `${t.market}:${t.symbol}`;
      const h = map[key] || (map[key] = { key, symbol: t.symbol, name: t.name || t.symbol, market: t.market, currency: t.currency || (t.market === 'US' ? 'USD' : 'TWD'), bucket: t.bucket || 'satellite', qty: 0, cost: 0, realized: 0, fees: 0 });
      const q = Number(t.qty), p = Number(t.price), fee = Number(t.fee) || 0, tax = Number(t.tax) || 0;
      if (t.name) h.name = t.name; if (t.bucket) h.bucket = t.bucket;
      h.fees += fee + tax;
      if (t.side === 'buy') { h.qty += q; h.cost += q * p + fee; }
      else {
        const avg = h.qty > 0 ? h.cost / h.qty : 0;
        h.realized += q * p - fee - tax - avg * q;
        h.cost -= avg * q; h.qty -= q;
        if (h.qty <= 1e-9) { h.qty = 0; h.cost = 0; }
      }
    }
    const list = Object.values(map).filter(h => h.qty > 0);
    for (const h of list) {
      const pr = priceOf(h.key);
      h.avg = h.cost / h.qty;
      h.price = pr ? pr.close : h.avg;
      h.priceDate = pr ? pr.date : '';
      h.priceSource = pr ? pr.source : '以成本暫估';
      h.stale = !pr;
      h.mv = h.qty * h.price;
      h.upl = h.mv - h.cost;
      h.uplPct = h.cost ? h.upl / h.cost : 0;
      h.mvTWD = toTWD(h.mv, h.currency); h.costTWD = toTWD(h.cost, h.currency); h.uplTWD = h.mvTWD - h.costTWD;
    }
    const tot = list.reduce((s, h) => s + h.mvTWD, 0);
    list.forEach(h => h.weight = tot ? h.mvTWD / tot : 0);
    return list.sort((a, b) => b.mvTWD - a.mvTWD);
  }
  function realizedTWD() {
    const map = {};
    const trades = [...S().vault.trades].sort((a, b) => a.date.localeCompare(b.date));
    let total = 0;
    for (const t of trades) {
      const k = `${t.market}:${t.symbol}`; const h = map[k] || (map[k] = { qty: 0, cost: 0 });
      const q = +t.qty, p = +t.price, fee = +t.fee || 0, tax = +t.tax || 0;
      if (t.side === 'buy') { h.qty += q; h.cost += q * p + fee; }
      else { const avg = h.qty ? h.cost / h.qty : 0; total += toTWD(q * p - fee - tax - avg * q, t.currency); h.cost -= avg * q; h.qty -= q; }
    }
    return total;
  }

  function addBizDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) n--; }
    return ymd(d).slice(0, 10);
  }
  function settlements() {
    const td = S().today();
    return S().vault.trades.map(t => {
      const sd = addBizDays(t.date, t.market === 'US' ? 1 : 2);
      const gross = +t.qty * +t.price, fee = +t.fee || 0, tax = +t.tax || 0;
      const amt = t.side === 'buy' ? -(gross + fee) : (gross - fee - tax);
      return { trade: t, date: sd, amount: amt, currency: t.currency || (t.market === 'US' ? 'USD' : 'TWD'), amountTWD: toTWD(amt, t.currency || (t.market === 'US' ? 'USD' : 'TWD')) };
    }).filter(s => s.date >= td).sort((a, b) => a.date.localeCompare(b.date));
  }

  function cashSummary() {
    const byType = {}, byCur = {};
    let total = 0;
    for (const a of S().vault.accounts) {
      const v = toTWD(a.balance, a.currency);
      byType[a.type] = (byType[a.type] || 0) + v;
      byCur[a.currency] = (byCur[a.currency] || 0) + (+a.balance || 0);
      total += v;
    }
    return { total, byType, byCur };
  }

  function monthKey(d) { return d.slice(0, 7); }
  function cashflow(months = 6) {
    const td = S().today(); const res = [];
    const base = new Date(td.slice(0, 7) + '-01T00:00:00');
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(base); d.setMonth(d.getMonth() - i);
      const k = ymd(d).slice(0, 7);
      res.push({ month: k, income: 0, expense: 0 });
    }
    const idx = Object.fromEntries(res.map((r, i) => [r.month, i]));
    for (const t of S().vault.txns) {
      const i = idx[monthKey(t.date)]; if (i === undefined) continue;
      res[i][t.type === 'income' ? 'income' : 'expense'] += toTWD(t.amount, t.currency);
    }
    res.forEach(r => { r.net = r.income - r.expense; r.rate = r.income ? r.net / r.income : null; });
    return res;
  }
  function categoryBreakdown(month) {
    const out = {};
    for (const t of S().vault.txns) if (t.type === 'expense' && t.date.startsWith(month)) out[t.category] = (out[t.category] || 0) + toTWD(t.amount, t.currency);
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
  }

  function snapshot() {
    const v = S().vault;
    const hs = holdings();
    const cash = cashSummary();
    const stockMV = hs.reduce((s, h) => s + h.mvTWD, 0);
    const stockCost = hs.reduce((s, h) => s + h.costTWD, 0);
    const recv = v.receivables.filter(r => !r.done).reduce((s, r) => s + toTWD(r.amount, r.currency), 0);
    const pay = v.payables.filter(r => !r.done).reduce((s, r) => s + toTWD(r.amount, r.currency), 0);
    const other = v.otherAssets.reduce((s, a) => s + toTWD(a.value, a.currency), 0);
    const debt = v.liabilities.reduce((s, l) => s + toTWD(l.balance, l.currency), 0);
    const financial = cash.total + stockMV;
    const totalAssets = financial + recv + other;
    const netWorth = totalAssets - pay - debt;
    // 配置：股票依 bucket；現金歸「防禦／現金」
    const alloc = { core: 0, satellite: 0, bond: 0, defensive: cash.total };
    hs.forEach(h => alloc[h.bucket] = (alloc[h.bucket] || 0) + h.mvTWD);
    return { hs, cash, stockMV, stockCost, upl: stockMV - stockCost, recv, pay, other, debt, financial, totalAssets, netWorth, alloc };
  }

  function goalProgress(g, snap) {
    snap = snap || snapshot();
    let cur = 0;
    if (g.metric === 'financial') cur = snap.financial;
    else if (g.metric === 'netWorth') cur = snap.netWorth;
    else if (g.metric === 'savings') cur = S().vault.txns.filter(t => t.date >= (g.startDate || '0000')).reduce((s, t) => s + (t.type === 'income' ? 1 : -1) * toTWD(t.amount, t.currency), 0);
    else if (g.metric === 'stock') cur = snap.stockMV;
    else cur = +g.current || 0;
    const start = g.metric === 'savings' ? 0 : (+g.start || 0);
    const pct = g.target > start ? clamp((cur - start) / (g.target - start), 0, 1.5) : 0;
    const t0 = new Date((g.startDate || S().today()) + 'T00:00:00').getTime(), t1 = new Date(g.deadline + 'T23:59:59').getTime(), now = Date.now();
    const pace = t1 > t0 ? clamp((now - t0) / (t1 - t0)) : 1;
    const daysLeft = Math.max(0, Math.ceil((t1 - now) / 864e5));
    const gap = Math.max(0, g.target - cur);
    const monthsLeft = Math.max(daysLeft / 30.44, 0.5);
    return { cur, pct, pace, gap, daysLeft, perMonth: gap / monthsLeft, onTrack: pct >= pace - 0.02 };
  }

  function score(snap) {
    snap = snap || snapshot();
    const v = S().vault, p = v.profile;
    const cf = cashflow(3);
    const withData = cf.filter(m => m.income || m.expense);
    const avgExp = withData.length ? withData.reduce((s, m) => s + m.expense, 0) / withData.length : (+p.monthlyBudget || 0);
    const avgInc = withData.length ? withData.reduce((s, m) => s + m.income, 0) / withData.length : (+p.monthlyIncome || 0);
    const dims = [];
    const td = S().today();
    const in30 = ymd(new Date(Date.now() + 30 * 864e5)).slice(0, 10);

    // 1. 流動性 20%
    const liquid = Object.entries(snap.cash.byType).reduce((s, [k, x]) => s + (k === '定存' ? x * 0.5 : x), 0);
    const months = avgExp > 0 ? liquid / avgExp : (liquid > 0 ? 12 : 0);
    const pay30 = v.payables.filter(x => !x.done && x.due && x.due <= in30).reduce((s, x) => s + toTWD(x.amount, x.currency), 0);
    let s1 = clamp(months / (p.emergencyMonths || 6)) * 20;
    if (pay30 > liquid) s1 *= 0.5;
    dims.push({ key: 'liquidity', name: '流動性', weight: 20, score: s1,
      basis: `可動用現金 ${fmt(liquid)}（定存以 50% 計），月均支出 ${fmt(avgExp)}，可支應 ${round(months, 1)} 個月；目標 ${p.emergencyMonths || 6} 個月。`,
      strength: months >= 6 ? '緊急預備金充足。' : (months >= 3 ? '具基本緩衝。' : '—'),
      risk: months < 3 ? '預備金不足 3 個月，遇收入中斷易被迫賣股。' : (pay30 > liquid ? '30 天內應付款大於可動用現金。' : '無明顯流動性風險。'),
      fix: months < (p.emergencyMonths || 6) ? `補足預備金差額 ${fmt(Math.max(0, (p.emergencyMonths || 6) * avgExp - liquid))}，存放高利活存／貨幣型工具。` : '維持現況，超額現金可依計畫分批投入。' });

    // 2. 現金流／儲蓄紀律 20%
    const rate = avgInc ? (avgInc - avgExp) / avgInc : 0;
    const posMonths = withData.filter(m => m.net > 0).length;
    const s2 = withData.length ? clamp(rate / 0.3) * 16 + (posMonths / withData.length) * 4 : clamp(rate / 0.3) * 12;
    dims.push({ key: 'cashflow', name: '現金流／儲蓄紀律', weight: 20, score: s2,
      basis: `近 ${withData.length || 0} 個月月均收入 ${fmt(avgInc)}、支出 ${fmt(avgExp)}，儲蓄率 ${pct(rate)}；正結餘月數 ${posMonths}/${withData.length || 0}。${withData.length ? '' : '（記帳資料不足，以個人設定估算）'}`,
      strength: rate >= 0.3 ? '儲蓄率達 30% 以上，紀律良好。' : (rate >= 0.15 ? '儲蓄率尚可。' : '—'),
      risk: rate < 0.1 ? '儲蓄率低於 10%，目標推進速度受限。' : '支出波動需持續追蹤。',
      fix: rate < 0.3 ? `先付自己：發薪日自動轉存 ${fmt(Math.max(0, avgInc * 0.3 - (avgInc - avgExp)))} 以達 30% 儲蓄率；檢視前三大支出類別。` : '將儲蓄自動化並設定定期定額。' });

    // 3. 資產成長／目標進度 20%
    const g = v.goals[0];
    let s3 = 10, gp = null;
    if (g) { gp = goalProgress(g, snap); s3 = gp.pct >= 1 ? 20 : clamp(gp.pace > 0 ? gp.pct / gp.pace : gp.pct) * 20; }
    dims.push({ key: 'growth', name: '資產成長／目標進度', weight: 20, score: s3,
      basis: g ? `「${g.name}」達成率 ${pct(gp.pct)}，時間進度 ${pct(gp.pace)}；差額 ${fmt(gp.gap)}，剩 ${gp.daysLeft} 天，每月需增加 ${fmt(gp.perMonth)}。` : '尚未設定目標。',
      strength: gp && gp.onTrack ? '進度領先或符合時間進度。' : '—',
      risk: gp && !gp.onTrack ? '進度落後；請勿為追趕目標而提高風險。' : '市場回檔可能使進度暫時倒退。',
      fix: gp && !gp.onTrack ? `以提高儲蓄與收入為主（每月 ${fmt(gp.perMonth)}），而非加碼高波動資產；必要時調整目標期限。` : '維持定期投入與再平衡。' });

    // 4. 投資組合分散／集中 25%
    const fin = snap.financial || 1;
    const maxH = snap.hs[0];
    const maxW = maxH ? maxH.mvTWD / fin : 0;
    const t = p.targetAlloc; const tsum = (t.core + t.satellite + t.bond + t.defensive) || 100;
    let dev = 0; const allocPct = {};
    for (const k of Object.keys(BUCKETS)) { allocPct[k] = (snap.alloc[k] || 0) / fin; dev += Math.abs(allocPct[k] - (t[k] || 0) / tsum); }
    dev /= 2;
    const hhi = snap.hs.reduce((s, h) => s + h.weight ** 2, 0);
    const effN = hhi ? 1 / hhi : 0;
    let s4;
    if (!snap.hs.length) s4 = 12.5;
    else s4 = (1 - clamp((maxW - 0.1) / 0.3)) * 10 + (1 - clamp(dev / 0.5)) * 10 + clamp(effN / 8) * 5;
    dims.push({ key: 'diversification', name: '投資組合分散／集中', weight: 25, score: s4,
      basis: snap.hs.length ? `最大單一部位 ${maxH.name} 占金融資產 ${pct(maxW)}；配置偏離目標 ${pct(dev)}；有效持股數 ${round(effN, 1)} 檔。` : '尚無股票部位，以中性分數計。',
      strength: dev < 0.1 ? '配置貼近目標。' : (snap.hs.length && maxW < 0.15 ? '單一部位集中度低。' : '—'),
      risk: maxW > 0.25 ? `單一標的超過 25%，個股事件風險高。` : (dev > 0.2 ? '配置明顯偏離目標，風險特性與設定不符。' : '無重大集中風險。'),
      fix: maxW > 0.25 ? `新資金優先投入低配類別，不再加碼 ${maxH.name}；必要時分批減碼至 20% 以下。` : (dev > 0.1 ? '以新增資金往目標配置靠攏（現金流再平衡），降低交易成本。' : '每季檢視一次，偏離 >5% 再平衡。'),
      allocPct });

    // 5. 執行／交割／負債 15%
    const debtRatio = snap.totalAssets ? snap.debt / snap.totalAssets : 0;
    const st = settlements();
    const need = -st.filter(x => x.amountTWD < 0).reduce((s, x) => s + x.amountTWD, 0) - st.filter(x => x.amountTWD > 0).reduce((s, x) => s + x.amountTWD, 0);
    const sa = v.accounts.find(a => a.id === p.settlementAccountId);
    const saBal = sa ? toTWD(sa.balance, sa.currency) : snap.cash.total;
    const covered = need <= 0 || saBal >= need;
    const overdue = [...v.payables, ...v.receivables].filter(x => !x.done && x.due && x.due < td).length;
    const s5 = (1 - clamp((debtRatio - 0.1) / 0.4)) * 6 + (covered ? 5 : 0) + Math.max(0, 4 - overdue * 2);
    dims.push({ key: 'execution', name: '執行／交割／負債', weight: 15, score: s5,
      basis: `負債比 ${pct(debtRatio)}；未來交割淨需求 ${fmt(Math.max(0, need))}，交割帳戶 ${fmt(saBal)}${covered ? '（足額）' : '（不足）'}；逾期收付款 ${overdue} 筆。`,
      strength: covered && overdue === 0 ? '交割與收付款皆正常。' : '—',
      risk: !covered ? '交割款不足可能構成違約交割，影響信用。' : (debtRatio > 0.3 ? '負債比偏高。' : '無重大執行風險。'),
      fix: !covered ? `交割日前轉入 ${fmt(need - saBal)} 至交割帳戶。` : (overdue ? '處理逾期收付款項並更新狀態。' : '持續於交易前確認交割資金。') });

    dims.forEach(d => { d.score = round(d.score, 1); d.pct = d.score / d.weight; });
    const total = round(dims.reduce((s, d) => s + d.score, 0), 1);
    const grade = total >= 90 ? 'A+' : total >= 85 ? 'A' : total >= 75 ? 'B+' : total >= 65 ? 'B' : total >= 55 ? 'C' : 'D';
    const priority = [...dims].sort((a, b) => a.pct - b.pct).map(d => d.name);
    return { total, grade, dims, priority, avgExp, avgInc, savingRate: rate, months, goal: g, gp };
  }

  function fmt(x, cur = 'TWD', d = 0) {
    if (x === null || x === undefined || isNaN(x)) return '—';
    const s = Math.abs(x).toLocaleString('zh-TW', { maximumFractionDigits: d, minimumFractionDigits: d });
    const sym = cur === 'TWD' ? '$' : cur === 'USD' ? 'US$' : cur + ' ';
    return (x < 0 ? '-' : '') + sym + s;
  }
  function fmtShort(x) {
    const a = Math.abs(x);
    if (a >= 1e8) return (x / 1e8).toFixed(2) + '億';
    if (a >= 1e4) return (x / 1e4).toFixed(a >= 1e6 ? 1 : 2) + '萬';
    return Math.round(x).toLocaleString('zh-TW');
  }
  const pct = (x, d = 1) => (x === null || isNaN(x)) ? '—' : (x * 100).toFixed(d) + '%';

  window.Calc = { ymd, BUCKETS, fxRate, toTWD, priceOf, holdings, realizedTWD, settlements, cashSummary, cashflow, categoryBreakdown, snapshot, goalProgress, score, fmt, fmtShort, pct, round, clamp, addBizDays };
})();
