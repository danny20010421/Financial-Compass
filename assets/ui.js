/* ui.js — 共用 UI 工具：表單底部面板、提示、圖表、區塊 */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, ms = 2200) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms);
  }

  function sheet(html, onMount) {
    const sh = $('#sheet'); $('#sheetBody').innerHTML = html; sh.hidden = false;
    document.body.style.overflow = 'hidden';
    const close = () => { sh.hidden = true; document.body.style.overflow = ''; };
    $$('[data-close]', sh).forEach(b => b.onclick = close);
    if (onMount) onMount($('#sheetBody'), close);
    return close;
  }

  /* fields: {k,label,type:text|number|date|time|select|textarea|checkbox,options:[[v,l]]|[v],value,hint,step,required,full} */
  function form({ title, fields, submit = '儲存', onSubmit, onDelete, extra = '' }) {
    const f = fields.map(fd => {
      const v = fd.value == null ? '' : fd.value;
      let input;
      if (fd.type === 'select') input = `<select name="${fd.k}">${fd.options.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
      else if (fd.type === 'textarea') input = `<textarea name="${fd.k}" placeholder="${esc(fd.ph || '')}">${esc(v)}</textarea>`;
      else if (fd.type === 'checkbox') input = `<input type="checkbox" name="${fd.k}" ${v ? 'checked' : ''} style="width:auto">`;
      else input = `<input name="${fd.k}" type="${fd.type || 'text'}" value="${esc(v)}" ${fd.step ? `step="${fd.step}"` : (fd.type === 'number' ? 'step="any"' : '')} ${fd.type === 'number' ? 'inputmode="decimal"' : ''} placeholder="${esc(fd.ph || '')}" ${fd.required ? 'required' : ''} autocomplete="off">`;
      return `<label class="field" ${fd.half ? 'data-half' : ''}><span>${esc(fd.label)}</span>${input}${fd.hint ? `<small class="hint">${esc(fd.hint)}</small>` : ''}</label>`;
    });
    // 兩兩並排 half 欄位
    let body = '', buf = [];
    fields.forEach((fd, i) => {
      if (fd.half) { buf.push(f[i]); if (buf.length === 2) { body += `<div class="grid2">${buf.join('')}</div>`; buf = []; } }
      else { if (buf.length) { body += `<div class="grid2">${buf.join('')}</div>`; buf = []; } body += f[i]; }
    });
    if (buf.length) body += `<div class="grid2">${buf.join('')}</div>`;
    const html = `<h3>${esc(title)}</h3><form id="fm">${body}${extra}<div class="btn-row" style="margin-top:6px">
      ${onDelete ? '<button type="button" class="btn danger" id="fmDel">刪除</button>' : ''}
      <button type="button" class="btn ghost" data-close>取消</button><button class="btn" type="submit">${esc(submit)}</button></div></form>`;
    return sheet(html, (el, close) => {
      $('#fm', el).onsubmit = e => {
        e.preventDefault();
        const vals = {};
        fields.forEach(fd => {
          const inp = el.querySelector(`[name="${fd.k}"]`);
          vals[fd.k] = fd.type === 'checkbox' ? inp.checked : fd.type === 'number' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value.trim();
        });
        if (onSubmit(vals, el) !== false) close();
      };
      if (onDelete) $('#fmDel', el).onclick = () => { if (confirm('確定刪除？')) { onDelete(); close(); } };
    });
  }

  function sec(no, title, body, action = '') {
    return `<section class="sec"><div class="sec-h"><span class="sec-no">${no}</span><h2 class="sec-t">${title}</h2>${action}</div>${body}</section>`;
  }
  function kpi(label, value, sub = '', cls = '') {
    return `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v ${cls}" title="${esc(value)}">${value}</div><div class="kpi-s">${sub}</div></div>`;
  }
  const signCls = x => x > 0 ? 'up' : x < 0 ? 'down' : '';

  function ring(score, grade) {
    const r = 40, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, score)) / 100;
    return `<svg class="ring" viewBox="0 0 96 96"><circle cx="48" cy="48" r="${r}" fill="none" stroke="#E8EEF7" stroke-width="7"/>
      <circle cx="48" cy="48" r="${r}" fill="none" stroke="#0B2447" stroke-width="7" stroke-linecap="round" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 48 48)"/>
      <text x="48" y="52" text-anchor="middle" class="score-num">${Math.round(score)}</text><text x="48" y="68" text-anchor="middle" class="score-lbl">評等 ${grade}</text></svg>`;
  }

  /* 純 SVG 圖表（無外部依賴，離線與 GitHub Pages 皆可用） */
  function destroyCharts() { }
  const PALETTE = ['#0B2447', '#2F5597', '#6C8EBF', '#A9C1E3', '#B7791F', '#7A8BA6', '#3C6E71', '#9B6B9E', '#C9D6EA', '#5A6B85'];
  function donut(el, labels, data) {
    if (!el) return;
    const tot = data.reduce((a, b) => a + Math.max(0, b), 0) || 1, r = 38, c = 2 * Math.PI * r; let off = 0;
    const segs = data.map((d, i) => { const len = Math.max(0, d) / tot * c; const s = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="16" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 50 50)"><title>${esc(labels[i])}：${Calc.fmt(d)}</title></circle>`; off += len; return s; }).join('');
    el.innerHTML = `<svg viewBox="0 0 100 100" style="width:100%;height:100%">${segs}<text x="50" y="47" text-anchor="middle" font-size="7" fill="#8791A3">合計</text><text x="50" y="58" text-anchor="middle" font-size="9.5" font-weight="700" fill="#0B2447">${Calc.fmtShort(tot)}</text></svg>`;
  }
  function bars(el, labels, sets) {
    if (!el) return;
    const W = 340, H = 200, pl = 40, pb = 22, pt = 18, n = labels.length, k = sets.length;
    const max = Math.max(1, ...sets.flatMap(s => s.data)) * 1.1;
    const gw = (W - pl) / n, bw = Math.min(16, gw * 0.7 / k);
    let g = '';
    for (let i = 0; i <= 3; i++) { const y = pt + (H - pt - pb) * (1 - i / 3); g += `<line x1="${pl}" x2="${W}" y1="${y}" y2="${y}" stroke="#EEF1F6"/><text x="${pl - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="#8791A3">${Calc.fmtShort(max * i / 3)}</text>`; }
    labels.forEach((l, i) => {
      const x0 = pl + gw * i + (gw - bw * k) / 2;
      sets.forEach((s, j) => { const h = (H - pt - pb) * Math.max(0, s.data[i]) / max; g += `<rect x="${x0 + j * bw}" y="${H - pb - h}" width="${bw - 1}" height="${h}" rx="2" fill="${PALETTE[j * 2 % PALETTE.length]}"><title>${esc(s.label)} ${Calc.fmt(s.data[i])}</title></rect>`; });
      g += `<text x="${pl + gw * i + gw / 2}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="#4A5568">${esc(l)}</text>`;
    });
    const lg = k > 1 ? sets.map((s, j) => `<rect x="${pl + j * 60}" y="2" width="9" height="9" fill="${PALETTE[j * 2 % PALETTE.length]}"/><text x="${pl + j * 60 + 13}" y="10" font-size="9.5" fill="#4A5568">${esc(s.label)}</text>`).join('') : '';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%">${lg}${g}</svg>`;
  }
  function hbars(el, labels, data) {
    if (!el) return;
    const max = Math.max(1, ...data), tot = data.reduce((a, b) => a + b, 0) || 1;
    el.innerHTML = labels.map((l, i) => `<div style="display:grid;grid-template-columns:4.5em 1fr auto;gap:8px;align-items:center;font-size:12.5px;margin:5px 0"><span>${esc(l)}</span><span class="bar" style="margin:0"><i style="width:${data[i] / max * 100}%"></i></span><span class="num">${Calc.fmtShort(data[i])} <span class="muted">${Calc.pct(data[i] / tot, 0)}</span></span></div>`).join('');
  }
  function legend(labels, values, total) {
    return `<div class="legend">${labels.map((l, i) => `<div><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(l)} <span class="muted num">${total ? Calc.pct(values[i] / total) : ''}</span></div>`).join('')}</div>`;
  }

  window.UI = { $, $$, esc, toast, sheet, form, sec, kpi, signCls, ring, donut, bars, hbars, legend, destroyCharts, PALETTE };
})();
