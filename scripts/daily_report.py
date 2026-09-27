"""daily_report.py — 產生每日財務報表（HTML 郵件＋網站加密報表）

用法（GitHub Actions 會自動執行）：
  VAULT_PASSPHRASE=... python scripts/daily_report.py [--send] [--offline] [--html out/report.html]
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import smtplib
import ssl
import sys
from datetime import date, datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import ai_client as AI  # noqa: E402
import market_data as MD  # noqa: E402
from finance_core import BUCKETS, TZ, Book, clamp, decrypt, encrypt, fmt, fmt_short, pct, today  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
VAULT = ROOT / "data" / "vault.enc.json"
REPORT = ROOT / "data" / "report.enc.json"
E = html.escape


# =====================================================================
# 1. 市場資料
# =====================================================================
def collect_market(vault, td, offline=False):
    trades = vault.get("trades", [])
    keys = {}
    for t in trades:
        keys[f'{t["market"]}:{t["symbol"]}'] = t
    if offline:
        prices = {k: {**v, "verified": "離線測試"} for k, v in (vault.get("prices") or {}).items()}
        return {"tw_date": td, "us_date": td, "prices": prices, "quotes": prices, "fx": {}, "market": {"indices": [], "institutional": None, "mood": "中性", "mood_score": 0}}
    tw_date = MD.tw_trade_date(td)
    us_date = MD.latest_session("^GSPC", tw_date) or tw_date
    print(f"[market] 台股基準日 {tw_date}；美股基準日 {us_date}")
    quotes, prices = {}, {}
    for key, t in keys.items():
        try:
            q = MD.tw_quote(t["symbol"], tw_date) if t["market"] == "TW" else MD.us_quote(t["symbol"], us_date)
        except Exception as e:
            print(f"[market] {key} failed: {e}")
            q = None
        if q:
            quotes[key] = q
            prices[key] = {"close": q["close"], "date": q["date"], "source": q["source"], "verified": q["verified"]}
            print(f"[market] {key} {q['close']} {q['date']} {q['verified']}")
    curs = {a.get("currency", "TWD") for a in vault.get("accounts", [])} | {t.get("currency", "TWD") for t in trades} | set((vault.get("fxManual") or {}).keys())
    fx = MD.fx_rates(sorted(curs), tw_date)
    mk = MD.market_snapshot(tw_date)
    return {"tw_date": tw_date, "us_date": us_date, "prices": prices, "quotes": quotes, "fx": fx, "market": mk}


# =====================================================================
# 2. 當日交易復盤（量化）
# =====================================================================
def review_trades(vault, book: Book, m, score, offline=False):
    out = []
    target = vault.get("profile", {}).get("targetAlloc") or {}
    tsum = sum(float(target.get(k, 0)) for k in BUCKETS) or 100
    em_target = float(vault.get("profile", {}).get("emergencyMonths") or 6)
    gp = score.get("gp")
    for t in vault.get("trades", []):
        day = m["tw_date"] if t["market"] == "TW" else m["us_date"]
        if t["date"] != day:
            continue
        key = f'{t["market"]}:{t["symbol"]}'
        q = m["quotes"].get(key) or {}
        price, side = float(t["price"]), t["side"]
        hi, lo = q.get("high"), q.get("low")
        vwap, vsrc = q.get("vwap"), q.get("vwap_source", "")
        if not vwap and not offline and q:
            try:
                vwap = MD.yahoo_intraday(q.get("yahoo", t["symbol"]), day)
                vsrc = "Yahoo 5 分 K 推算" if vwap else ""
            except Exception:
                vwap = None
        pos = (price - lo) / (hi - lo) if hi and lo and hi > lo else None
        vs = (price - vwap) / vwap if vwap else None
        if side == "buy":
            comps = [c for c in [(1 - pos) if pos is not None else None, clamp(0.5 - vs / 0.02) if vs is not None else None] if c is not None]
        else:
            comps = [c for c in [pos, clamp(0.5 + vs / 0.02) if vs is not None else None] if c is not None]
        pq = sum(comps) / len(comps) if comps else 0.5
        if side == "buy":
            label = "偏便宜" if pq >= 0.6 else "合理" if pq >= 0.4 else "偏貴"
        else:
            label = "偏貴（賣在相對高點）" if pq >= 0.6 else "合理" if pq >= 0.4 else "偏便宜（賣在相對低點）"

        # 交易前後配置
        pre_hs = book.holdings(exclude_id=t.get("id"))
        pre = book.snapshot(pre_hs)
        post = book.snapshot()
        fin_pre, fin_post = pre["financial"] or 1, post["financial"] or 1
        b = t.get("bucket") or "satellite"
        pre_w, tgt = pre["alloc"].get(b, 0) / fin_pre, float(target.get(b, 0)) / tsum
        gap = pre_w - tgt
        if side == "buy":
            fit = 25 if gap < -0.05 else 18 if gap <= 0.05 else 8
        else:
            fit = 25 if gap > 0.05 else 18 if gap >= -0.05 else 8
        h_post = next((h for h in post["hs"] if h["key"] == key), None)
        w_post = (h_post["mv_twd"] / fin_post) if h_post else 0
        conc = 20 if side == "sell" else (20 if w_post <= 0.10 else 14 if w_post <= 0.20 else 8 if w_post <= 0.25 else 0)
        months = score["months"]
        liq = 15 if months >= em_target else 9 if months >= 3 else 0
        h_pre = next((h for h in pre_hs if h["key"] == key), None)
        avg_down = side == "buy" and h_pre is not None and price < h_pre["avg"]
        plan = 10 if (t.get("note") or "").strip() else 3
        if avg_down and "攤平" not in (t.get("note") or ""):
            plan = max(0, plan - 5)
        total = round(pq * 30 + fit + conc + liq + plan)
        grade = "A+" if total >= 90 else "A" if total >= 80 else "B" if total >= 70 else "C" if total >= 60 else "D"
        flags = []
        if avg_down:
            flags.append(f"成交價低於原持有均價 {h_pre['avg']:.2f}，屬攤平；需有新的基本面/估值依據，而非「低於成本」。")
        if side == "buy" and w_post > 0.25:
            flags.append(f"交易後單一部位占金融資產 {pct(w_post)}，超過 25% 集中上限。")
        if side == "buy" and b == "satellite" and gap > 0.05:
            flags.append("衛星部位已高於目標仍加碼，實際風險高於設定的風險屬性。")
        if side == "buy" and gp and not gp["on_track"] and b == "satellite":
            flags.append("目標進度落後時加碼高波動部位，需避免「為達 100 萬而提高風險」。")
        if months < 3:
            flags.append("緊急預備金低於 3 個月，交易動用了防守資金。")
        good, improve = [], []
        (good if pq >= 0.5 else improve).append(f"成交位置：日內區間 {pct(pos, 0) if pos is not None else '—'}、相對 VWAP {pct(vs, 2) if vs is not None else '—'}，判定「{label}」。")
        (good if fit >= 18 else improve).append(f"配置：交易前「{BUCKETS[b]}」占 {pct(pre_w)}，目標 {pct(tgt, 0)}，{'補足低配' if gap < -0.05 and side == 'buy' else '接近目標' if abs(gap) <= 0.05 else '偏離擴大' if side == 'buy' else '降低超配'}。")
        (good if plan >= 10 else improve).append("已記錄交易理由與計畫。" if plan >= 10 else "未記錄交易理由/出場條件，復盤難以檢驗決策品質。")
        rule = ("買進前檢查：①類別是否低配 ②交易後單一部位 ≤20% ③以限價掛在 VWAP 或以下 ④寫下論點失效的停損條件。" if side == "buy"
                else "賣出前檢查：①是否因論點失效或再平衡 ②分批賣出 ③避開開盤前 15 分鐘的波動。")
        out.append({"trade": t, "quote": q, "vwap": vwap, "vwap_source": vsrc, "pos": pos, "vs_vwap": vs, "label": label, "pq": pq,
                    "scores": {"價格品質": round(pq * 30), "配置契合": fit, "集中度": conc, "流動性": liq, "紀律/計畫": plan},
                    "total": total, "grade": grade, "flags": flags, "good": good, "improve": improve, "rule": rule,
                    "pre_w": pre_w, "tgt": tgt, "w_post": w_post, "bucket": b})
    return out


# =====================================================================
# 3. AI：新聞、分析、交叉審核
# =====================================================================
def ai_sections(vault, facts, news_cands, has_trades):
    provs = AI.available()
    pref = (vault.get("settings") or {}).get("aiProvider") or os.getenv("AI_PROVIDER") or "gemini"
    primary = pref if pref in provs else (provs[0] if provs else None)
    ver_pref = (vault.get("settings") or {}).get("verifyProvider") or os.getenv("AI_VERIFY_PROVIDER") or ""
    verifier = ver_pref if ver_pref in provs and ver_pref != primary else next((p for p in provs if p != primary), None) if os.getenv("AI_VERIFY", "auto") != "off" else None
    res = {"provider": AI.NAMES.get(primary, "規則引擎"), "news": [], "analysis": None, "review": None, "sources": []}
    if not primary:
        return res
    cands = "\n".join(f"- [{c['region']}] {c['title']}｜{c['source']}｜{c['date']}｜{c['url']}" for c in news_cands[:40])
    news_prompt = f"""今天是 {today()}（台北）。請使用網路搜尋，挑選並驗證「2–3 則台灣重要財經/市場新聞」與「2–3 則國際重要財經/市場新聞」。
優先官方/原始來源（央行、金管會、主計總處、財政部、證交所、公開資訊觀測站、Fed、BLS、ECB、SEC、公司公告）；若只有媒體報導，請盡量找到原始公告連結替代；排除社群與論壇。
以下是 RSS 候選（可參考，但不限於此）：
{cands or '（無）'}

使用者持股與配置摘要：{json.dumps(facts['holdings_brief'], ensure_ascii=False)}

只輸出 JSON（```json 區塊）：
{{"news":[{{"region":"台灣|國際","title":"","source":"機構/媒體名稱","date":"YYYY-MM-DD","url":"可點擊原始來源","event":"事件（事實，含數字）","impact":"為何影響使用者（結合其持股/配置/現金流）","watch":"接下來觀察什麼（指標/日期）","official":true}}]}}"""
    try:
        t, s = AI.ask(primary, news_prompt, True)
        j = AI.extract_json(t) or {}
        res["news"] = j.get("news", [])[:6]
        res["sources"] += s
    except Exception as e:
        print(f"[ai] news failed: {e}")

    ana_prompt = f"""以下是使用者今日的財務與市場「已計算事實」（JSON，金額為新台幣）。請據此撰寫每日報表的顧問意見，必要時可用網路搜尋驗證市場背景，但不得更改任何已計算數字。
{json.dumps(facts, ensure_ascii=False, default=str)}

要求：繁體中文、精簡具體、可執行；市場事實與情緒判讀分開；避免結果偏誤；持有不等於繼續買；不因低於成本自動攤平；不為達目標提高風險。
只輸出 JSON（```json 區塊）：
{{"overall":"整體財務評分與建議（3–4 句）",
"allocation":"資產配置與集中度評論（2–3 句，含再平衡建議）",
"cashflow":"現金流與儲蓄規劃（2–3 句，含具體金額）",
"actions":{{"d7":["1–7 天行動"],"m3":["1–3 個月行動"],"goal":["至目標期行動"]}},
"market_view":"今日市場情緒判讀（與事實分開，說明依據）",
{'"trade_reviews":[{"id":"交易id","good":["做得好"],"improve":["需改善"],"rules":["下次規則"],"next_day":"下一交易日建議","weeks":"1–4 週建議"}],' if has_trades else ''}
"lesson":{{"title":"今日理財教學標題","body":"150–250 字，結合使用者狀況舉例"}}}}"""
    try:
        t, s = AI.ask(primary, ana_prompt, True)
        res["analysis"] = AI.extract_json(t)
        res["sources"] += s
    except Exception as e:
        print(f"[ai] analysis failed: {e}")

    if verifier and (res["news"] or res["analysis"]):
        v_prompt = f"""你是嚴格的財經事實查核者。請用網路搜尋驗證下列 AI 產出的新聞與分析：日期、數字、事件是否正確；來源是否為官方/原始來源；是否有未經數據支持的推薦或過度自信的判斷。
只輸出 JSON（```json 區塊）：{{"confidence":"高|中|低","summary":"一句話結論","issues":[{{"item":"","problem":"","fix":"","source":""}}]}}
---
{json.dumps({'news': res['news'], 'analysis': res['analysis']}, ensure_ascii=False)}"""
        try:
            t, _ = AI.ask(verifier, v_prompt, True)
            res["review"] = AI.extract_json(t) or {"confidence": "—", "summary": t[:400], "issues": []}
            res["review"]["provider"] = AI.NAMES[verifier]
        except Exception as e:
            print(f"[ai] verify failed: {e}")
    return res


def fallback_news(cands):
    out = []
    for region in ("台灣", "國際"):
        for c in [x for x in cands if x["region"] == region][:3]:
            out.append({"region": region, "title": c["title"], "source": c["source"], "date": c["date"][:10], "url": c["url"],
                        "event": "（未啟用 AI，僅列標題；請點來源閱讀原文）", "impact": "", "watch": ""})
    return out


def builtin_lesson():
    try:
        js = (ROOT / "assets" / "lessons.js").read_text(encoding="utf-8")
        ls = re.findall(r"\{ lv: '([^']*)', t: '([^']*)', b: '([^']*)' \}", js)
        lv, t, b = ls[date.today().toordinal() % len(ls)]
        return {"title": f"【{lv}】{t}", "body": b}
    except Exception:
        return {"title": "複利與時間", "body": "越早開始、越低成本、越能持續，複利效果越大。"}


# =====================================================================
# 4. HTML（郵件相容：表格排版＋行內樣式）
# =====================================================================
NAVY, NAVY2, LINE, INK2, MUTED, BG2 = "#0B2447", "#2F5597", "#E3E8F0", "#4A5568", "#8791A3", "#F4F7FB"
UP, DOWN = "#C0392B", "#1E8449"
FONT = "'Noto Sans TC','PingFang TC','Hiragino Sans','Microsoft JhengHei',Arial,sans-serif"


def sc(x):
    return UP if x > 0 else DOWN if x < 0 else NAVY


def section(no, title, body):
    return f"""<tr><td style="padding:22px 16px 4px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-bottom:1px solid {NAVY};padding-bottom:6px">
<span style="font-family:Georgia,serif;color:{NAVY2};font-size:13px;letter-spacing:1px">{no:02d}</span>
<span style="font-size:16px;font-weight:700;color:{NAVY};letter-spacing:2px;margin-left:8px">{title}</span></td></tr></table>
<div style="padding-top:10px">{body}</div></td></tr>"""


def kpi_grid(items):
    cells = []
    for lbl, val, sub, color in items:
        cells.append(f"""<td width="50%" valign="top" style="width:50%;padding:3px">
<div style="border:1px solid {LINE};border-top:3px solid {NAVY};padding:10px 10px 8px;height:78px;overflow:hidden">
<div style="font-size:11px;color:{INK2};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{lbl}</div>
<div style="font-size:19px;font-weight:700;color:{color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin:4px 0 2px">{val}</div>
<div style="font-size:11px;color:{MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{sub}</div></div></td>""")
    rows = "".join(f"<tr>{cells[i]}{cells[i + 1] if i + 1 < len(cells) else '<td></td>'}</tr>" for i in range(0, len(cells), 2))
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed">{rows}</table>'


def table(head, rows, total=None, first_left=True):
    th = "".join(f'<th style="font-size:11px;font-weight:500;color:{INK2};background:{BG2};padding:7px 5px;text-align:{"left" if i == 0 and first_left else "right"};border-bottom:1px solid {LINE}">{h}</th>' for i, h in enumerate(head))
    body = ""
    for r in rows:
        body += "<tr>" + "".join(f'<td style="font-size:12px;padding:7px 4px;border-bottom:1px solid {LINE};text-align:{"left" if i == 0 and first_left else "right"}">{c}</td>' for i, c in enumerate(r)) + "</tr>"
    if total:
        body += "<tr>" + "".join(f'<td style="font-size:12px;padding:7px 5px;border-top:1px solid {NAVY};font-weight:700;color:{NAVY};text-align:{"left" if i == 0 else "right"};white-space:nowrap">{c}</td>' for i, c in enumerate(total)) + "</tr>"
    return f'<div style="overflow-x:auto"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid {NAVY}"><tr>{th}</tr>{body}</table></div>'


def para(t, size=13, color="#1A2233"):
    return f'<p style="margin:6px 0;font-size:{size}px;line-height:1.7;color:{color}">{t}</p>'


def note(t):
    return f'<div style="font-size:12px;color:{INK2};background:{BG2};border-left:3px solid {NAVY2};padding:8px 10px;margin:8px 0;line-height:1.7">{t}</div>'


def bar(p, color=NAVY, h=8):
    w = max(0, min(100, p * 100))
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8EEF7;border-radius:4px"><tr><td width="{w:.1f}%" style="background:{color};height:{h}px;line-height:{h}px;font-size:0;border-radius:4px">&nbsp;</td><td style="font-size:0">&nbsp;</td></tr></table>'


def ul(items):
    items = [i for i in (items or []) if i]
    if not items:
        return ""
    return '<ul style="margin:4px 0 6px;padding-left:18px">' + "".join(f'<li style="font-size:12.5px;line-height:1.7;margin:2px 0">{E(str(i))}</li>' for i in items) + "</ul>"


def render(vault, book: Book, m, score, trades_rev, ai, lesson):
    snap = score["_snap"]
    hs = snap["hs"]
    g, gp = score["goal"], score["gp"]
    an = ai.get("analysis") or {}
    td = today()
    S = []

    # 01 總覽
    S.append(section(1, "最新財務狀況總覽", kpi_grid([
        ("淨資產", fmt(snap["net_worth"]), f"總資產 {fmt_short(snap['total_assets'])}・負債 {fmt_short(snap['pay'] + snap['debt'])}", NAVY),
        ("金融資產總市值", fmt(snap["financial"]), f"現金 {fmt_short(snap['cash']['total'])}・股票 {fmt_short(snap['stock_mv'])}", NAVY),
        ("財務評分", f"{score['total']} 分", f"評等 {score['grade']}", NAVY),
        ("目標達成率", pct(gp["pct"]) if gp else "—", (f"差額 {fmt_short(gp['gap'])}・剩 {gp['days_left']} 天") if gp else "尚未設定", NAVY),
    ]) + note(f"報表基準：台股 {m['tw_date']}、美股 {m['us_date']} 收盤。產生時間 {datetime.now(TZ):%Y-%m-%d %H:%M}（台北）。")))

    # 02 現金
    cash = snap["cash"]
    rows = [[E(k), fmt(v)] for k, v in sorted(cash["by_type"].items(), key=lambda x: -x[1])]
    rv = [x for x in vault.get("receivables", []) if not x.get("done")]
    pv = [x for x in vault.get("payables", []) if not x.get("done")]
    body = table(["現金分類", "金額（台幣）"], rows, ["現金合計", fmt(cash["total"])])
    body += table(["應收／應付", "到期日", "金額"],
                  [[f"應收｜{E(x['name'])}", x.get("due") or "—", fmt(book.to_twd(x["amount"], x.get("currency")))] for x in rv] +
                  [[f"應付｜{E(x['name'])}", x.get("due") or "—", f'<span style="color:{UP}">-{fmt(book.to_twd(x["amount"], x.get("currency")))}</span>'] for x in pv],
                  ["淨應收", "", fmt(snap["recv"] - snap["pay"])]) if (rv or pv) else para("無未結應收／應付款。", 12, MUTED)
    S.append(section(2, "現金分類與總和・應收／應付", body))

    # 03 外幣
    fx_rows = []
    curs = sorted({c for c in cash["by_cur"] if c != "TWD"} | {h["currency"] for h in hs if h["currency"] != "TWD"})
    for c in curs:
        r = m["fx"].get(c)
        amt_cash = cash["by_cur"].get(c, 0)
        amt_stock = sum(h["mv"] for h in hs if h["currency"] == c)
        fx_rows.append([c, f"{book.fx_rate(c):.4f}", f"{amt_cash + amt_stock:,.2f}", fmt(book.to_twd(amt_cash + amt_stock, c)),
                        E(r["source"] if r else "手動設定") + (f"<br><span style='color:{MUTED};font-size:10px'>{E(r.get('verified', ''))}</span>" if r else "")])
    S.append(section(3, "外幣換算", table(["幣別", "匯率", "外幣金額", "折合台幣", "來源"], fx_rows) if fx_rows else para("無外幣資產。", 12, MUTED)))

    # 04 股票
    rows = []
    for h in hs:
        rows.append([f"<b>{E(h['symbol'])}</b><br><span style='color:{MUTED};font-size:10.5px'>{E(h['name'][:8])}</span>",
                     f"{h['qty']:,.0f}<br><span style='color:{MUTED};font-size:10.5px'>均 {h['avg']:,.2f}</span>",
                     (f"{h['price']:,.2f}<br><span style='color:{MUTED};font-size:10px'>{h['price_date'][5:]}</span>" if not h["stale"] else "—"),
                     f"{h['mv_twd']:,.0f}<br><span style='color:{MUTED};font-size:10.5px'>本 {h['cost_twd']:,.0f}</span>",
                     f"<span style='color:{sc(h['upl_twd'])}'>{h['upl_twd']:,.0f}<br>{pct(h['upl_pct'])}</span>"])
    body = kpi_grid([("股票總成本", fmt(snap["stock_cost"]), "含手續費", NAVY), ("股票總市值", fmt(snap["stock_mv"]), "同一交易日收盤價", NAVY),
                     ("總未實現損益", fmt(snap["upl"]), pct(snap["upl"] / snap["stock_cost"]) if snap["stock_cost"] else "—", sc(snap["upl"])),
                     ("已實現損益（累計）", fmt(book.realized_twd()), "台幣", sc(book.realized_twd()))])
    if hs:
        body += table(["標的", "股數／均價", "收盤", "市值／成本", "損益"], rows, ["合計", "", "", f"{snap['stock_mv']:,.0f}", f"{snap['upl']:,.0f}"])
        vtxt = "；".join(f"{E(h['symbol'])}：{E(h['price_source'])}（{E(h.get('verified') or '')}）" for h in hs)
        dates = sorted({h["price_date"] for h in hs if h["price_date"]})
        body += note(f"<b>價格驗證</b>　{vtxt}" + (f"<br>⚠ 價格日期不一致：{'、'.join(dates)}" if len({h['market'] for h in hs}) == 1 and len(dates) > 1 else ""))
    else:
        body += para("目前無持股。", 12, MUTED)
    if trades_rev:
        body += trade_review_html(trades_rev, m, an)
    S.append(section(4, "股票明細" + ("＋當日交易復盤" if trades_rev else ""), body))

    # 05 金融資產
    S.append(section(5, "金融資產總市值", f'<div style="font-size:26px;font-weight:700;color:{NAVY}">{fmt(snap["financial"])}</div>' +
                     para(f"現金 {fmt(cash['total'])}（{pct(cash['total'] / (snap['financial'] or 1))}）＋ 股票 {fmt(snap['stock_mv'])}（{pct(snap['stock_mv'] / (snap['financial'] or 1))}）", 12, INK2) +
                     (para(f"100 萬里程碑進度：{pct(snap['financial'] / float((vault.get('settings') or {}).get('milestone') or 1_000_000))}", 12, INK2))))

    # 06 配置圖
    t = vault.get("profile", {}).get("targetAlloc") or {}
    tsum = sum(float(t.get(k, 0)) for k in BUCKETS) or 100
    colors = ["#0B2447", "#2F5597", "#6C8EBF", "#A9C1E3"]
    fin = snap["financial"] or 1
    stack = "".join(f'<td width="{snap["alloc"].get(k, 0) / fin * 100:.1f}%" style="background:{colors[i]};height:18px;font-size:0">&nbsp;</td>' for i, k in enumerate(BUCKETS) if snap["alloc"].get(k, 0) > 0)
    body = f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{stack}</tr></table>'
    rows = []
    for i, (k, lbl) in enumerate(BUCKETS.items()):
        a, tg = snap["alloc"].get(k, 0) / fin, float(t.get(k, 0)) / tsum
        rows.append(f"""<tr><td style="padding:8px 0 2px;font-size:12.5px"><span style="display:inline-block;width:9px;height:9px;background:{colors[i]};margin-right:6px"></span>{lbl}</td>
<td style="text-align:right;font-size:12.5px;padding:8px 0 2px">{pct(a)} <span style="color:{MUTED}">/ 目標 {pct(tg, 0)}</span> <b style="color:{UP if abs(a - tg) > 0.05 else MUTED}">{'+' if a - tg >= 0 else ''}{pct(a - tg)}</b></td></tr>
<tr><td colspan="2">{bar(a, colors[i], 6)}</td></tr>""")
    body += f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">{"".join(rows)}</table>'
    if hs:
        body += para("<b>個股權重</b>", 12.5) + "".join(f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="28%" style="font-size:12px;padding:3px 0">{E(h["symbol"])}</td><td>{bar(h["mv_twd"] / fin, NAVY2, 6)}</td><td width="18%" style="text-align:right;font-size:12px">{pct(h["mv_twd"] / fin)}</td></tr></table>' for h in hs)
    S.append(section(6, "資產配置", body + para("紅字表示偏離目標超過 ±5 個百分點；現金計入「防禦／現金」。", 11, MUTED)))

    # 07 評分
    body = f'<table role="presentation" width="100%"><tr><td style="font-size:36px;font-weight:700;color:{NAVY};font-family:Georgia,serif;width:96px">{score["total"]}</td><td style="font-size:12.5px;color:{INK2}">總分 / 100　評等 <b style="color:{NAVY}">{score["grade"]}</b><br>改善優先：{"　".join(f"{i + 1}. {x}" for i, x in enumerate(score["priority"]))}</td></tr></table>'
    for d in score["dims"]:
        body += f"""<div style="border-bottom:1px solid {LINE};padding:10px 0"><table role="presentation" width="100%"><tr><td style="font-size:13.5px;font-weight:700;color:{NAVY}">{d['name']}<span style="color:{MUTED};font-weight:400;font-size:11px">（{d['weight']}%）</span></td><td style="text-align:right;font-size:13.5px;font-weight:700">{d['score']} / {d['weight']}</td></tr></table>
{bar(d['pct'])}<div style="font-size:12px;line-height:1.7;margin-top:6px;color:#1A2233"><b>依據</b>　{E(d['basis'])}<br><b>優勢</b>　{E(d['strength'])}<br><b>風險</b>　{E(d['risk'])}<br><b>改善</b>　{E(d['fix'])}</div></div>"""
    S.append(section(7, "專業財務評分（100 分制）", body))

    # 08 建議與行動
    div = next(d for d in score["dims"] if d["key"] == "diversification")
    acts = an.get("actions") or {}
    d7 = acts.get("d7") or [score["dims"][[d["name"] for d in score["dims"]].index(score["priority"][0])]["fix"], "核對本週交割與信用卡應付款。"]
    m3 = acts.get("m3") or ["每月發薪日自動轉存，並以新資金往目標配置靠攏。", "每季檢視一次配置偏離（>5% 再平衡）。"]
    if gp and gp["gap"] <= 0:
        gl_default = [f"「{g['name']}」已達成，建議設定下一階段目標，並維持原風險水準。"]
    elif gp:
        gl_default = [f"每月需增加 {fmt(gp['per_month'])} 以如期達成「{g['name']}」；以儲蓄與收入推進，不提高風險。"]
    else:
        gl_default = ["設定明確的年度目標。"]
    gl = acts.get("goal") or gl_default
    overall_default = f"總分 {score['total']}（{score['grade']}）。優先改善：" + "、".join(score["priority"][:2]) + "。"
    body = para(f"<b>整體評分與建議</b>　{E(an.get('overall') or overall_default)}")
    body += para(f"<b>資產配置與集中度</b>　{E(an.get('allocation') or '')}" + (f"　最大部位 {pct(div['max_w'])}、有效持股 {div['eff_n']:.1f} 檔、配置偏離 {pct(div['dev'])}。"))
    body += para(f"<b>現金流與儲蓄</b>　{E(an.get('cashflow') or '')}　月均收入 {fmt(score['avg_inc'])}、支出 {fmt(score['avg_exp'])}、儲蓄率 {pct(score['saving_rate'])}。")
    body += para("<b>1–7 天行動</b>") + ul(d7) + para("<b>1–3 個月行動</b>") + ul(m3) + para("<b>至目標期行動</b>") + ul(gl)
    if gp:
        body += f"""<div style="margin-top:10px;padding:10px;border:1px solid {LINE}"><div style="font-size:13px;font-weight:700;color:{NAVY}">{E(g['name'])}</div>
{bar(min(1, gp['pct']))}<table role="presentation" width="100%" style="font-size:12px;color:{INK2};margin-top:4px"><tr><td>達成率 <b style="color:{NAVY}">{pct(gp['pct'])}</b>（時間進度 {pct(gp['pace'])}）</td><td style="text-align:right">差額 <b>{fmt(gp['gap'])}</b></td></tr>
<tr><td>剩餘 {gp['days_left']} 天</td><td style="text-align:right">每月需 {fmt(gp['per_month'])}</td></tr></table></div>"""
    S.append(section(8, "整體建議・行動清單・目標差額", body))

    # 09 交割
    st = book.settlements()
    in14 = [x for x in vault.get("payables", []) + vault.get("receivables", []) if not x.get("done") and x.get("due")]
    rows = [[f"交割｜{E(s['trade']['symbol'])} {'買進' if s['trade']['side'] == 'buy' else '賣出'}", s["date"], f"<span style='color:{sc(s['amount'])}'>{fmt(s['amount'], s['currency'], 0 if s['currency'] == 'TWD' else 2)}</span>"] for s in st]
    rows += [[("應付｜" if x in vault.get("payables", []) else "應收｜") + E(x["name"]), x["due"] + (" ⚠逾期" if x["due"] < td else ""), fmt(float(x["amount"]), x.get("currency", "TWD"))] for x in sorted(in14, key=lambda x: x["due"])[:8]]
    exe = next(d for d in score["dims"] if d["key"] == "execution")
    body = (table(["項目", "日期", "金額"], rows) if rows else para("近期無交割與收付款。", 12, MUTED))
    cov = '<b style="color:#1E8449">足額</b>' if exe["covered"] else '<b style="color:#C0392B">不足，請於交割日上午 10 點前補足</b>'
    body += note(f"交割淨需求 {fmt(max(0, exe['need']))}；交割帳戶餘額 {fmt(exe['sa_bal'])} → {cov}。台股 T+2、美股 T+1（未計國定假日）。")
    S.append(section(9, "交割／現金流提醒", body))

    # 10 新聞
    mk = m["market"]
    idx_rows = [[E(x["name"]), f"{x['close']:,.2f}", f"<span style='color:{sc(x['chg'])}'>{'+' if x['chg'] >= 0 else ''}{pct(x['chg'], 2)}</span>", x["date"]] for x in mk["indices"]]
    body = ""
    if idx_rows:
        body += para("<b>市場事實</b>", 12.5) + table(["指標", "收盤", "漲跌", "日期"], idx_rows)
        if mk.get("institutional") and mk["institutional"].get("foreign_net") is not None:
            body += para(f"外資買賣超：{mk['institutional']['foreign_net'] / 1e8:,.1f} 億元（{mk['institutional']['source']}）", 12, INK2)
        body += note(f"<b>情緒判讀</b>（規則模型）：{mk['mood']}（分數 {mk['mood_score']:+.1f}）" + (f"<br><b>AI 觀點</b>：{E(an.get('market_view'))}" if an.get("market_view") else ""))
    for n in ai.get("news") or []:
        body += f"""<div style="border:1px solid {LINE};padding:10px;margin:8px 0"><div style="font-size:11px;color:{MUTED}">{E(n.get('region', ''))}・{E(n.get('source', ''))}・{E(n.get('date', ''))}{' ・<b style="color:#2F855A">官方/原始來源</b>' if n.get('official') else ''}</div>
<div style="font-size:14px;font-weight:700;color:{NAVY};margin:3px 0 4px"><a href="{E(n.get('url', ''))}" style="color:{NAVY};text-decoration:none">{E(n.get('title', ''))}</a></div>
<div style="font-size:12.5px;line-height:1.7">{('<b>事件</b>　' + E(n['event']) + '<br>') if n.get('event') else ''}{('<b>影響</b>　' + E(n['impact']) + '<br>') if n.get('impact') else ''}{('<b>觀察</b>　' + E(n['watch'])) if n.get('watch') else ''}</div>
<div style="font-size:11px;margin-top:4px;word-break:break-all"><a href="{E(n.get('url', ''))}" style="color:{NAVY2}">{E(n.get('url', ''))}</a></div></div>"""
    if not ai.get("news"):
        body += para("今日無新聞資料。", 12, MUTED)
    S.append(section(10, "每日新聞摘要", body))

    # 11 教學 + AI 審核
    body = f'<div style="font-size:14px;font-weight:700;color:{NAVY}">{E(lesson["title"])}</div>' + para(E(lesson["body"]), 12.5)
    S.append(section(11, "今日理財教學", body))
    rv = ai.get("review")
    if rv:
        body = para(f"審核模型：{E(rv.get('provider', ''))}　可信度：<b>{E(str(rv.get('confidence', '—')))}</b>　{E(rv.get('summary', ''))}", 12.5)
        issues = rv.get("issues") or []
        if issues:
            body += table(["項目", "問題", "修正"], [[E(str(i.get("item", "")))[:30], E(str(i.get("problem", ""))), E(str(i.get("fix", "")))] for i in issues[:8]])
        S.append(section(12, "AI 交叉審核", body))

    srcs = []
    seen = set()
    for s in ai.get("sources") or []:
        if s.get("url") and s["url"] not in seen:
            seen.add(s["url"]); srcs.append(s)
    src_html = "".join(f'<div style="font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="{E(s["url"])}" style="color:{NAVY2}">{E(s.get("title") or s["url"])}</a></div>' for s in srcs[:15])

    return f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>每日財務報表 {m['tw_date']}</title></head>
<body style="margin:0;padding:0;background:#FFFFFF;font-family:{FONT};color:#1A2233;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF">
<tr><td style="background:{NAVY};padding:18px 16px;color:#fff">
<div style="font-size:10px;letter-spacing:3px;opacity:.75">DAILY FINANCIAL REPORT</div>
<div style="font-size:20px;font-weight:700;letter-spacing:4px;margin-top:2px">每日財務報表</div>
<div style="font-size:12px;opacity:.85;margin-top:4px">{m['tw_date']}　｜　評分 {score['total']}（{score['grade']}）　｜　{E(ai.get('provider') or '')}</div></td></tr>
{''.join(S)}
<tr><td style="padding:22px 16px 30px;border-top:1px solid {LINE}">
{('<div style="font-size:11px;color:' + MUTED + ';margin-bottom:4px">資料來源（AI 搜尋引用）</div>' + src_html) if src_html else ''}
<div style="font-size:10.5px;color:{MUTED};line-height:1.7;margin-top:10px">本報表由個人財務系統自動產生，內容僅供個人參考，不構成投資建議；投資有風險，過去績效不代表未來表現。股價來源：TWSE／TPEx 官方、Yahoo Finance、Stooq；匯率：臺灣銀行牌告。</div>
</td></tr></table></td></tr></table></body></html>"""


def trade_review_html(revs, m, an):
    ai_map = {r.get("id"): r for r in (an.get("trade_reviews") or [])}
    mk = m["market"]
    out = f'<div style="margin-top:16px;padding:12px;border:2px solid {NAVY}"><div style="font-size:15px;font-weight:700;color:{NAVY};letter-spacing:2px">當日交易復盤</div>'
    facts = "、".join(f"{x['name']} {'+' if x['chg'] >= 0 else ''}{pct(x['chg'], 2)}" for x in mk["indices"][:5])
    out += note(f"<b>市場事實</b>　{facts or '—'}<br><b>情緒判讀</b>　{mk['mood']}" + (f"｜{E(an.get('market_view'))}" if an.get("market_view") else ""))
    for r in revs:
        t, q, a = r["trade"], r["quote"], ai_map.get(r["trade"].get("id")) or {}
        side = "買進" if t["side"] == "buy" else "賣出"
        out += f"""<div style="border-top:1px solid {LINE};padding-top:10px;margin-top:10px">
<table role="presentation" width="100%"><tr><td style="font-size:14px;font-weight:700;color:{NAVY}">{side} {E(t['symbol'])} {E(t.get('name') or '')}</td>
<td style="text-align:right"><span style="font-size:22px;font-weight:700;color:{NAVY};font-family:Georgia,serif">{r['total']}</span><span style="font-size:12px;color:{INK2}"> /100　{r['grade']}</span></td></tr></table>
<div style="font-size:12px;color:{INK2}">{t.get('time') or ''} 成交 {float(t['price']):,.2f} × {float(t['qty']):,.0f} 股</div>"""
        out += table(["開", "高", "低", "收"], [[f"{q.get(k) or 0:,.2f}" for k in ("open", "high", "low", "close")]], first_left=False)
        out += table(["VWAP", "日內位置", "vs VWAP"], [[f"{r['vwap']:,.2f}" if r["vwap"] else "—", pct(r["pos"], 0) if r["pos"] is not None else "—",
                                                      pct(r["vs_vwap"], 2) if r["vs_vwap"] is not None else "—"]], first_left=False)
        out += para(f"成交價格品質：<b>{r['label']}</b>" + (f"<span style='color:{MUTED};font-size:11px'>（VWAP：{E(r['vwap_source'])}）</span>" if r["vwap_source"] else ""), 12.5)
        out += para("評分拆解：" + "｜".join(f"{k} {v}" for k, v in r["scores"].items()) + "（滿分 30/25/20/15/10）", 11.5, INK2)
        out += para(f"投資合理性：{BUCKETS[r['bucket']]} 交易前 {pct(r['pre_w'])} / 目標 {pct(r['tgt'], 0)}；交易後此標的占金融資產 {pct(r['w_post'])}。", 12)
        if r["flags"]:
            out += f'<div style="font-size:12px;color:{UP};margin:4px 0">⚠ ' + "<br>⚠ ".join(E(f) for f in r["flags"]) + "</div>"
        out += para("<b>做得好</b>", 12.5) + ul(a.get("good") or r["good"])
        out += para("<b>需改善</b>", 12.5) + ul(a.get("improve") or r["improve"] or ["—"])
        out += para("<b>下次規則</b>", 12.5) + ul(a.get("rules") or [r["rule"]])
        out += para(f"<b>下一交易日</b>　{E(a.get('next_day') or '不追價；若回到 VWAP 以下且配置仍低配再考慮分批，否則觀望。')}", 12.5)
        out += para(f"<b>1–4 週</b>　{E(a.get('weeks') or '依計畫分批，單一部位不超過 20%；每週檢視論點是否仍成立，不因低於成本自動攤平。')}", 12.5)
        out += "</div>"
    return out + "</div>"


# =====================================================================
# 5. 寄信
# =====================================================================
def send_mail(to, subject, html_body):
    host, port = os.getenv("SMTP_HOST", "smtp.gmail.com"), int(os.getenv("SMTP_PORT", "465"))
    user, pw = os.getenv("SMTP_USER"), os.getenv("SMTP_PASS")
    if not (user and pw and to):
        print("[mail] 缺少 SMTP_USER / SMTP_PASS / 收件者，略過寄信")
        return False
    msg = MIMEMultipart("alternative")
    msg["Subject"], msg["From"], msg["To"] = subject, formataddr(("資產羅盤", user)), to
    msg.attach(MIMEText("請使用支援 HTML 的郵件程式檢視每日財務報表。", "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=60) as s:
            s.login(user, pw); s.sendmail(user, [x.strip() for x in to.split(",")], msg.as_string())
    else:
        with smtplib.SMTP(host, port, timeout=60) as s:
            s.starttls(context=ctx); s.login(user, pw); s.sendmail(user, [x.strip() for x in to.split(",")], msg.as_string())
    print(f"[mail] 已寄送至 {to}")
    return True


# =====================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true", help="寄送 email")
    ap.add_argument("--offline", action="store_true", help="不連網（測試用，使用 vault 內價格）")
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--vault", default=str(VAULT))
    ap.add_argument("--html", default="", help="另存 HTML 檔（本機預覽）")
    ap.add_argument("--no-write", action="store_true", help="不寫入 data/report.enc.json")
    a = ap.parse_args()

    pw = os.getenv("VAULT_PASSPHRASE")
    if not pw:
        sys.exit("缺少環境變數 VAULT_PASSPHRASE（GitHub Secret）")
    vp = Path(a.vault)
    if not vp.exists():
        sys.exit(f"找不到 {vp}；請先在網站「設定」完成 GitHub 同步")
    vault = decrypt(json.loads(vp.read_text()), pw)
    td = today()

    m = collect_market(vault, td, a.offline)
    book = Book(vault, m["prices"], m["fx"], td)
    snap = book.snapshot()
    score = book.score(snap)
    score["_snap"] = snap
    revs = review_trades(vault, book, m, score, a.offline)

    facts = {
        "date": td, "tw_trade_date": m["tw_date"], "us_trade_date": m["us_date"],
        "profile": {k: vault.get("profile", {}).get(k) for k in ("riskLevel", "horizonYears", "goalsText", "targetAlloc", "monthlyIncome", "monthlyBudget", "emergencyMonths")},
        "net_worth": round(snap["net_worth"]), "financial_assets": round(snap["financial"]), "cash": round(snap["cash"]["total"]),
        "stock_mv": round(snap["stock_mv"]), "stock_cost": round(snap["stock_cost"]), "unrealized": round(snap["upl"]),
        "alloc_pct": {k: round(v / (snap["financial"] or 1), 4) for k, v in snap["alloc"].items()},
        "score": {"total": score["total"], "grade": score["grade"], "dims": [{k: d[k] for k in ("name", "score", "weight", "basis")} for d in score["dims"]], "priority": score["priority"]},
        "goal": ({"name": score["goal"]["name"], "target": score["goal"]["target"], **{k: round(v, 4) if isinstance(v, float) else v for k, v in score["gp"].items()}} if score["goal"] else None),
        "cashflow_3m": {"avg_income": round(score["avg_inc"]), "avg_expense": round(score["avg_exp"]), "saving_rate": round(score["saving_rate"], 4)},
        "holdings_brief": [{"symbol": h["symbol"], "name": h["name"], "market": h["market"], "bucket": h["bucket"], "weight_in_stocks": round(h["weight"], 4), "upl_pct": round(h["upl_pct"], 4)} for h in snap["hs"]],
        "market": {"indices": [{k: x[k] for k in ("name", "close", "chg", "date")} for x in m["market"]["indices"]], "mood_rule": m["market"]["mood"], "institutional": m["market"]["institutional"]},
        "trades_today": [{"id": r["trade"].get("id"), "side": r["trade"]["side"], "symbol": r["trade"]["symbol"], "price": r["trade"]["price"], "qty": r["trade"]["qty"],
                          "note": r["trade"].get("note"), "label": r["label"], "pos_in_range": r["pos"], "vs_vwap": r["vs_vwap"], "score": r["total"], "grade": r["grade"], "flags": r["flags"]} for r in revs],
    }
    if a.no_ai or a.offline:
        ai = {"provider": "規則引擎", "news": [], "analysis": None, "review": None, "sources": []}
        cands = [] if a.offline else AI.gather_news()
    else:
        cands = AI.gather_news()
        print(f"[news] 候選 {len(cands)} 則；AI：{AI.available()}")
        ai = ai_sections(vault, facts, cands, bool(revs))
    if not ai["news"] and cands:
        ai["news"] = fallback_news(cands)
    lesson = (ai.get("analysis") or {}).get("lesson") or builtin_lesson()

    html_out = render(vault, book, m, score, revs, ai, lesson)
    if a.html:
        Path(a.html).parent.mkdir(parents=True, exist_ok=True)
        Path(a.html).write_text(html_out, encoding="utf-8")
        print(f"[out] {a.html}")

    report = {"generatedAt": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"), "tradeDate": m["tw_date"], "usDate": m["us_date"],
              "prices": m["prices"], "fx": m["fx"], "news": ai.get("news") or [], "score": {"total": score["total"], "grade": score["grade"]},
              "provider": ai.get("provider"), "html": html_out}
    if not a.no_write:
        REPORT.write_text(json.dumps(encrypt(report, pw)), encoding="utf-8")
        print(f"[out] {REPORT}")

    if a.send:
        to = (vault.get("settings") or {}).get("mailTo") or os.getenv("MAIL_TO", "")
        send_mail(to, f"【資產羅盤】每日財務報表 {m['tw_date']}｜評分 {score['total']}（{score['grade']}）", html_out)


if __name__ == "__main__":
    main()
