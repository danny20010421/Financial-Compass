"""ai_client.py — Gemini / ChatGPT / Claude 串接（含網路搜尋），與新聞來源蒐集"""
from __future__ import annotations

import json
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import requests

SYSTEM = """你是一位具全球視野與深度市場洞察的「高級個人財務與投資規劃顧問（CFP / Senior Investment Strategist）」，一律使用繁體中文。
原則：
1. 個人化：依使用者的短中長期目標、風險承受度（保守/穩健/積極）、投資期限與資金狀況給建議；資料不足時明說。
2. 核心–衛星（Core-Satellite）配置思維：指數 ETF、成長個股、債券、防禦性資產。
3. 客觀基本面（營收成長、估值、護城河）、產業前景與風險；絕不提供無數據支持的推薦。
4. 三方驗證：優先採用官方與原始來源（公司財報、公開資訊觀測站、TWSE、TPEx、央行、金管會、主計總處、Fed、BLS、SEC、ECB 等），排除社群媒體、論壇與留言；每個關鍵數字附來源。無法驗證者標示「未驗證」。
5. 風險控管：停損停利邏輯、分批進場、定期再平衡。避免結果偏誤；持有不等於繼續買；不因低於成本自動攤平；不為達成目標而提高風險。
6. 市場事實與情緒判讀分開。僅供參考，非投資建議。"""

DEFAULT_MODELS = {"gemini": "gemini-3.8-flash", "openai": "gpt-6-luna", "claude": "claude-sonnet-5"}
KEYS = {"gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY", "claude": "ANTHROPIC_API_KEY"}
NAMES = {"gemini": "Gemini", "openai": "ChatGPT", "claude": "Claude"}


def available():
    return [p for p, k in KEYS.items() if os.getenv(k)]


def model_for(p):
    return os.getenv(f"{p.upper()}_MODEL") or DEFAULT_MODELS[p]


def _gemini(prompt, search):
    body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.3}}
    if search:
        body["tools"] = [{"google_search": {}}]
    r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model_for('gemini')}:generateContent",
                      params={"key": os.environ["GEMINI_API_KEY"]}, json=body, timeout=240)
    j = r.json()
    if r.status_code != 200:
        raise RuntimeError(j.get("error", {}).get("message", r.text[:200]))
    c = (j.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in (c.get("content") or {}).get("parts", []))
    src = [{"title": x["web"].get("title"), "url": x["web"].get("uri")} for x in (c.get("groundingMetadata") or {}).get("groundingChunks", []) if x.get("web")]
    return text, src


def _openai(prompt, search):
    body = {"model": model_for("openai"), "instructions": SYSTEM, "input": prompt}
    if search:
        body["tools"] = [{"type": "web_search"}]
    r = requests.post("https://api.openai.com/v1/responses", headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}, json=body, timeout=300)
    j = r.json()
    if r.status_code != 200:
        raise RuntimeError((j.get("error") or {}).get("message", r.text[:200]))
    text, src = "", []
    for o in j.get("output", []):
        if o.get("type") == "message":
            for c in o.get("content", []):
                if c.get("type") == "output_text":
                    text += c.get("text", "")
                    src += [{"title": a.get("title"), "url": a.get("url")} for a in c.get("annotations", []) if a.get("url")]
    return text or j.get("output_text", ""), src


def _claude(prompt, search):
    body = {"model": model_for("claude"), "max_tokens": 8000, "system": SYSTEM, "messages": [{"role": "user", "content": prompt}]}
    if search:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}]
    r = requests.post("https://api.anthropic.com/v1/messages", json=body, timeout=300,
                      headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"})
    j = r.json()
    if r.status_code != 200:
        raise RuntimeError((j.get("error") or {}).get("message", r.text[:200]))
    text, src = "", []
    for b in j.get("content", []):
        if b.get("type") == "text":
            text += b.get("text", "")
            src += [{"title": c.get("title"), "url": c.get("url")} for c in (b.get("citations") or []) if c.get("url")]
    return text, src


CALL = {"gemini": _gemini, "openai": _openai, "claude": _claude}


def ask(provider, prompt, search=True):
    try:
        return CALL[provider](prompt, search)
    except Exception as e:
        if search:
            print(f"[ai] {provider} search failed ({e}); retry without search")
            t, s = CALL[provider](prompt, False)
            return "（未使用即時搜尋）\n" + t, s
        raise


def extract_json(text):
    m = re.search(r"```json\s*([\s\S]*?)```", text) or re.search(r"(\{[\s\S]*\})", text)
    if not m:
        return None
    raw = m.group(1)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raw = re.sub(r",\s*([}\]])", r"\1", raw)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None


# ---------------- 新聞候選（RSS；官方來源優先） ----------------
FEEDS = [
    ("台灣", "中央銀行", "https://www.cbc.gov.tw/tw/lp-302-1.html?format=rss", 3),
    ("台灣", "中央社財經", "https://feeds.feedburner.com/rsscna/finance", 1),
    ("台灣", "Google News", "https://news.google.com/rss/search?q=%E5%8F%B0%E8%82%A1+OR+%E5%A4%AE%E8%A1%8C+OR+%E9%87%91%E7%AE%A1%E6%9C%83+OR+%E4%B8%BB%E8%A8%88%E7%B8%BD%E8%99%95+when:1d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", 0),
    ("國際", "Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", 3),
    ("國際", "ECB", "https://www.ecb.europa.eu/rss/press.html", 3),
    ("國際", "U.S. BLS", "https://www.bls.gov/feed/bls_latest.rss", 3),
    ("國際", "Google News", "https://news.google.com/rss/search?q=stock+market+OR+Fed+OR+Treasury+yields+OR+inflation+when:1d&hl=en-US&gl=US&ceid=US:en", 0),
]
OFFICIAL = ("gov", "cbc.gov.tw", "fsc.gov.tw", "dgbas", "twse.com.tw", "tpex.org.tw", "mops", "federalreserve.gov", "bls.gov", "ecb.europa.eu", "sec.gov", "treasury.gov", "imf.org", "boj.or.jp")


def gather_news(hours=36):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    items = []
    for region, name, url, prio in FEEDS:
        try:
            r = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
            root = ET.fromstring(r.content)
        except Exception as e:
            print(f"[news] {name} failed: {e}")
            continue
        for it in root.iter():
            tag = it.tag.split("}")[-1]
            if tag not in ("item", "entry"):
                continue
            g = lambda k: next((c for c in it if c.tag.split("}")[-1] == k), None)
            title = (g("title").text or "").strip() if g("title") is not None else ""
            link_el = g("link")
            link = (link_el.text or link_el.get("href") or "").strip() if link_el is not None else ""
            pd = g("pubDate") if g("pubDate") is not None else (g("updated") if g("updated") is not None else g("date"))
            try:
                dt = parsedate_to_datetime(pd.text) if pd is not None and "," in (pd.text or "") else datetime.fromisoformat((pd.text or "").replace("Z", "+00:00"))
            except Exception:
                dt = None
            if dt and dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt and dt < cutoff:
                continue
            src = g("source").text if g("source") is not None else name
            host = urlparse(link).netloc
            p = prio + (2 if any(o in host for o in OFFICIAL) else 0)
            items.append({"region": region, "title": title, "url": link, "source": src, "date": dt.astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M") if dt else "", "prio": p})
    seen, out = set(), []
    for x in sorted(items, key=lambda x: -x["prio"]):
        k = x["title"][:30]
        if k in seen or not x["title"]:
            continue
        seen.add(k)
        out.append(x)
    return out
