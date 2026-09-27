/* ai.js — 串接 Gemini / ChatGPT / Claude（瀏覽器直連，金鑰僅存本機） */
(function () {
  const SYSTEM = `你是一位具全球視野與深度市場洞察的「高級個人財務與投資規劃顧問（CFP / Senior Investment Strategist）」，一律使用繁體中文回覆。
【工作原則】
1. 個人化診斷優先：在給出薪資規劃或具體投資建議前，先確認（或從提供的資料中評估）使用者的短中長期財務目標、風險承受度（保守/穩健/積極）、投資期限與現有資金狀況；資料不足時明確列出需要補充的項目。
2. 資產配置：以核心–衛星（Core-Satellite）架構思考，合理分配指數型 ETF、高成長個股、債券與防禦性資產，並說明比例理由。
3. 股票與產業分析：客觀呈現基本面（營收成長、獲利率、估值水準如 P/E、P/B、殖利率、護城河）、產業前景與風險。絕不提供無數據支持的推薦。
4. 資訊驗證：引用任何數據前，須以「三方驗證」原則確認，優先採用官方與原始來源（公司財報／法說會、公開資訊觀測站 MOPS、證交所 TWSE、櫃買 TPEx、SEC EDGAR、央行、主計總處、Fed、BLS 等），不得採用社群媒體、論壇或留言。每個關鍵數字標註來源與日期；無法驗證者標示「未驗證」。
5. 風險控管：提供停損停利邏輯、分批進場策略與定期再平衡機制。避免結果偏誤；持有不等於應繼續買；不因股價低於成本就自動攤平；不為達成目標而提高風險。
6. 教學：適時用簡明方式解釋專業概念，提升使用者的理財知識。
7. 市場事實與情緒判讀分開陳述。所有內容僅供參考，非投資建議；不保證報酬。
【格式】手機閱讀優先：短段落、條列、必要時使用小表格；結尾附「資料來源」清單（可點擊網址）。`;

  function extractJSON(text) {
    const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  async function callGemini(cfg, messages, search) {
    const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const body = { systemInstruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig: { temperature: 0.4 } };
    if (search) body.tools = [{ google_search: {} }];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ? j.error.message : res.status);
    const c = j.candidates && j.candidates[0];
    const text = (c && c.content && c.content.parts || []).map(p => p.text || '').join('');
    const chunks = (c && c.groundingMetadata && c.groundingMetadata.groundingChunks) || [];
    return { text, sources: chunks.filter(x => x.web).map(x => ({ title: x.web.title, url: x.web.uri })) };
  }

  async function callOpenAI(cfg, messages, search) {
    const body = { model: cfg.model, instructions: SYSTEM, input: messages.map(m => ({ role: m.role, content: m.content })) };
    if (search) body.tools = [{ type: 'web_search' }];
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` }, body: JSON.stringify(body)
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ? j.error.message : res.status);
    let text = '', sources = [];
    for (const o of j.output || []) if (o.type === 'message') for (const c of o.content || []) {
      if (c.type === 'output_text') { text += c.text; (c.annotations || []).forEach(a => a.url && sources.push({ title: a.title || a.url, url: a.url })); }
    }
    return { text: text || j.output_text || '', sources };
  }

  async function callClaude(cfg, messages, search) {
    const body = { model: cfg.model, max_tokens: 4096, system: SYSTEM, messages: messages.map(m => ({ role: m.role, content: m.content })) };
    if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ? j.error.message : res.status);
    let text = '', sources = [];
    for (const b of j.content || []) if (b.type === 'text') { text += b.text; (b.citations || []).forEach(c => c.url && sources.push({ title: c.title || c.url, url: c.url })); }
    return { text, sources };
  }

  const CALL = { gemini: callGemini, openai: callOpenAI, claude: callClaude };
  const NAMES = { gemini: 'Gemini', openai: 'ChatGPT', claude: 'Claude' };

  async function ask(messages, opt = {}) {
    const L = window.Store.local.ai;
    const prov = opt.provider || L.provider;
    const cfg = L[prov];
    if (!cfg || !cfg.key) throw new Error(`尚未設定 ${NAMES[prov] || prov} API 金鑰（設定 → AI）`);
    let r;
    try { r = await CALL[prov](cfg, messages, opt.search !== false); }
    catch (e) {
      if (opt.search !== false) { r = await CALL[prov](cfg, messages, false); r.text = '（此模型不支援即時搜尋，以下未經網路驗證）\n\n' + r.text; }
      else throw e;
    }
    const seen = new Set(); r.sources = r.sources.filter(s => !seen.has(s.url) && seen.add(s.url));
    r.provider = NAMES[prov];
    // 交叉審核：若設定第二家 AI，請其驗證事實與數字
    const ver = opt.verify === false ? '' : L.verify;
    if (ver && ver !== prov && L[ver] && L[ver].key) {
      try {
        const v = await CALL[ver](L[ver], [{ role: 'user', content: `請以嚴格的事實查核者角色，使用網路搜尋驗證下列財經內容中的數字、日期與事件是否正確，並確認來源是否為官方／原始來源。輸出：\n1) 驗證結果表（項目｜原文｜查核結果：正確/有誤/無法驗證｜官方來源）\n2) 需修正之處\n3) 整體可信度（高/中/低）\n\n---\n${r.text}` }], true);
        r.review = { provider: NAMES[ver], text: v.text, sources: v.sources };
      } catch (e) { r.review = { provider: NAMES[ver], text: '審核失敗：' + e.message, sources: [] }; }
    }
    return r;
  }

  /* 極簡 Markdown → HTML（標題、粗體、條列、表格、連結） */
  function md(src) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    const lines = src.split('\n'); let out = '', list = null, tbl = null;
    const close = () => { if (list) { out += `</${list}>`; list = null; } if (tbl) { out += '</table>'; tbl = null; } };
    for (const ln of lines) {
      const l = ln.trimEnd();
      if (/^\s*\|.*\|\s*$/.test(l)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue;
        if (!tbl) { close(); out += '<table>'; tbl = 1; }
        out += '<tr>' + l.trim().slice(1, -1).split('|').map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>'; continue;
      }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); out += `<h3>${inline(m[2])}</h3>`; }
      else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
      else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
      else if (!l.trim()) close();
      else { close(); out += `<p>${inline(l)}</p>`; }
    }
    close(); return out;
  }

  window.AI = { SYSTEM, ask, md, extractJSON, NAMES };
})();
