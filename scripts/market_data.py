"""market_data.py — 收盤價（多來源交叉驗證）、日內 VWAP、匯率、市場指標

來源優先序：
  台股：臺灣證券交易所 TWSE / 證券櫃檯買賣中心 TPEx（官方） → Yahoo Finance
  美股：Yahoo Finance、Stooq（兩個獨立資料源交叉比對）
  匯率：臺灣銀行牌告即期（官方） → Yahoo Finance
所有數值標註來源與日期；多來源差異 > 0.5% 會標示「⚠ 待確認」。
"""
from __future__ import annotations

import csv
import io
import time
from datetime import date, datetime, timedelta, timezone

import requests

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept": "application/json,text/csv,text/plain,*/*"}
S = requests.Session()
S.headers.update(UA)


def _get(url, **kw):
    for i in range(3):
        try:
            r = S.get(url, timeout=20, **kw)
            if r.status_code == 429:
                time.sleep(2 + i * 3)
                continue
            r.raise_for_status()
            return r
        except requests.RequestException as e:  # noqa: PERF203
            last = e
            time.sleep(1 + i)
    raise last  # type: ignore[name-defined]


def _num(s):
    try:
        return float(str(s).replace(",", "").replace("+", "").strip())
    except (ValueError, TypeError):
        return None


def _roc(s: str) -> str:
    """'115/09/25' -> '2026-09-25'"""
    y, m, d = s.strip().split("/")
    return f"{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}"


# ---------------- 官方：TWSE / TPEx 日成交資訊 ----------------
def _parse_official(fields, rows, unit_thousand=False):
    idx = {}
    for i, f in enumerate(fields):
        if "日期" in f: idx["date"] = i
        elif "開盤" in f: idx["open"] = i
        elif "最高" in f: idx["high"] = i
        elif "最低" in f: idx["low"] = i
        elif "收盤" in f: idx["close"] = i
        elif ("成交股數" in f) or ("仟股" in f) or ("成交張數" in f): idx["vol"] = i
        elif "成交金額" in f or "仟元" in f: idx["val"] = i
    out = {}
    for r in rows:
        try:
            d = _roc(r[idx["date"]])
        except Exception:
            continue
        o, h, l, c = (_num(r[idx[k]]) for k in ("open", "high", "low", "close"))
        vol, val = _num(r[idx["vol"]]) if "vol" in idx else None, _num(r[idx["val"]]) if "val" in idx else None
        if unit_thousand and vol:
            vol, val = vol * 1000, (val or 0) * 1000
        if c is None:
            continue
        out[d] = {"open": o, "high": h, "low": l, "close": c, "volume": vol, "value": val,
                  "vwap": (val / vol) if (vol and val) else None}
    return out


def twse_month(code: str, d: date):
    url = f"https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date={d:%Y%m01}&stockNo={code}&response=json"
    j = _get(url).json()
    if j.get("stat") != "OK" or not j.get("data"):
        return {}
    return _parse_official(j["fields"], j["data"])


def tpex_month(code: str, d: date):
    url = f"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code={code}&date={d:%Y/%m/01}&response=json"
    j = _get(url).json()
    tables = j.get("tables") or []
    if not tables or not tables[0].get("data"):
        return {}
    t = tables[0]
    thousand = any("仟" in f for f in t.get("fields", []))
    return _parse_official(t["fields"], t["data"], unit_thousand=thousand)


def official_tw(code: str, upto: date):
    """回傳 (bars, source)；合併本月與上月資料。"""
    for fn, name in ((twse_month, "臺灣證券交易所 TWSE"), (tpex_month, "證券櫃檯買賣中心 TPEx")):
        try:
            bars = fn(code, upto)
            prev = fn(code, (upto.replace(day=1) - timedelta(days=1)))
            bars = {**prev, **bars}
            if bars:
                return bars, name
        except Exception:
            continue
    return {}, ""


# ---------------- Yahoo Finance（chart API） ----------------
def yahoo_daily(sym: str, days=45):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range={days}d&interval=1d&includePrePost=false"
    j = _get(url).json()
    res = (j.get("chart") or {}).get("result")
    if not res:
        return {}
    res = res[0]
    off = res["meta"].get("gmtoffset", 0)
    q = res["indicators"]["quote"][0]
    out = {}
    for i, ts in enumerate(res.get("timestamp") or []):
        c = q["close"][i]
        if c is None:
            continue
        d = datetime.fromtimestamp(ts + off, tz=timezone.utc).date().isoformat()
        out[d] = {"open": q["open"][i], "high": q["high"][i], "low": q["low"][i], "close": c, "volume": q["volume"][i]}
    return out


def yahoo_intraday(sym: str, d: str):
    """取 5 分 K 計算當日 VWAP（Yahoo 保留約 60 天）。"""
    dd = date.fromisoformat(d)
    p1 = int(datetime(dd.year, dd.month, dd.day, tzinfo=timezone.utc).timestamp()) - 86400
    p2 = p1 + 3 * 86400
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2={p2}&interval=5m"
    j = _get(url).json()
    res = (j.get("chart") or {}).get("result")
    if not res:
        return None
    res = res[0]
    off = res["meta"].get("gmtoffset", 0)
    q = res["indicators"]["quote"][0]
    pv = vv = 0.0
    for i, ts in enumerate(res.get("timestamp") or []):
        if datetime.fromtimestamp(ts + off, tz=timezone.utc).date().isoformat() != d:
            continue
        h, l, c, v = q["high"][i], q["low"][i], q["close"][i], q["volume"][i]
        if None in (h, l, c) or not v:
            continue
        pv += (h + l + c) / 3 * v
        vv += v
    return pv / vv if vv else None


def stooq_daily(sym: str):
    url = f"https://stooq.com/q/d/l/?s={sym.lower()}.us&i=d"
    txt = _get(url).text
    out = {}
    for r in csv.DictReader(io.StringIO(txt)):
        try:
            out[r["Date"]] = {"open": float(r["Open"]), "high": float(r["High"]), "low": float(r["Low"]), "close": float(r["Close"]), "volume": float(r.get("Volume") or 0)}
        except (KeyError, ValueError):
            continue
    return out


# ---------------- 交易日判定 ----------------
def latest_session(sym: str, upto: str):
    try:
        bars = yahoo_daily(sym, 20)
        ds = sorted(d for d in bars if d <= upto)
        return ds[-1] if ds else None
    except Exception:
        return None


def tw_trade_date(upto: str) -> str:
    d = latest_session("^TWII", upto)
    if d:
        return d
    # 後援：以 TWSE 0050 月資料判定
    bars, _ = official_tw("0050", date.fromisoformat(upto))
    ds = sorted(x for x in bars if x <= upto)
    if ds:
        return ds[-1]
    dd = date.fromisoformat(upto)
    while dd.weekday() >= 5:
        dd -= timedelta(days=1)
    return dd.isoformat()


# ---------------- 收盤價：多來源驗證 ----------------
def verify(values: list[tuple[str, float]], official: str | None):
    vals = [v for _, v in values if v]
    if not vals:
        return None, "無資料"
    chosen = next((v for n, v in values if n == official and v), None)
    if chosen is None:
        s = sorted(vals)
        chosen = s[len(s) // 2]
    spread = (max(vals) - min(vals)) / chosen if chosen else 0
    n = len(vals)
    if n >= 2 and spread <= 0.005:
        tag = f"✓ {n} 源一致"
    elif n >= 2:
        tag = f"⚠ 來源差異 {spread * 100:.2f}%"
    else:
        tag = "單一來源"
    return chosen, tag


def tw_quote(code: str, d: str):
    """台股：官方 + Yahoo(.TW/.TWO)。回傳 dict（含 OHLC、VWAP、來源、驗證）。"""
    dd = date.fromisoformat(d)
    off_bars, off_src = official_tw(code, dd)
    ybars, ysrc = {}, ""
    for suf in (".TW", ".TWO"):
        try:
            ybars = yahoo_daily(code + suf)
            if ybars:
                ysrc = f"Yahoo Finance ({code}{suf})"
                break
        except Exception:
            continue
    ob, yb = off_bars.get(d), ybars.get(d)
    if not ob and not yb:
        # 當日停牌或無資料：取 ≤ d 最近一日
        cand = sorted([x for x in off_bars if x <= d] + [x for x in ybars if x <= d])
        if not cand:
            return None
        if cand[-1] == d:
            return None
        q = tw_quote(code, cand[-1])
        return {**q, "note": f"{d} 無成交資料，採 {cand[-1]} 收盤"} if q else None
    vals = []
    if ob: vals.append((off_src, ob["close"]))
    if yb: vals.append((ysrc, yb["close"]))
    close, tag = verify(vals, off_src)
    base = ob or yb
    return {"close": close, "date": d, "open": base["open"], "high": base["high"], "low": base["low"],
            "volume": base.get("volume"), "vwap": (ob or {}).get("vwap"), "vwap_source": off_src + "（成交金額÷成交股數）" if ob and ob.get("vwap") else "",
            "source": " / ".join(n for n, _ in vals), "verified": tag, "yahoo": ysrc.split("(")[-1].rstrip(")") if ysrc else code + ".TW"}


def us_quote(sym: str, d: str):
    ysym = sym.replace(".", "-")
    vals, bars = [], {}
    try:
        yb = yahoo_daily(ysym)
        dd = max([x for x in yb if x <= d], default=None)
        if dd:
            bars["y"] = (dd, yb[dd]); vals.append(("Yahoo Finance", yb[dd]["close"]))
    except Exception:
        pass
    try:
        sb = stooq_daily(sym.replace(".", "-"))
        dd = max([x for x in sb if x <= d], default=None)
        if dd:
            bars["s"] = (dd, sb[dd])
    except Exception:
        pass
    if "y" in bars and "s" in bars and bars["s"][0] == bars["y"][0]:
        vals.append(("Stooq", bars["s"][1]["close"]))
    elif "s" in bars and "y" not in bars:
        vals.append(("Stooq", bars["s"][1]["close"]))
    if not vals:
        return None
    dd, b = bars.get("y") or bars.get("s")
    close, tag = verify(vals, None)
    return {"close": close, "date": dd, "open": b["open"], "high": b["high"], "low": b["low"], "volume": b.get("volume"),
            "vwap": None, "source": " / ".join(n for n, _ in vals), "verified": tag, "yahoo": ysym,
            "note": "" if dd == d else f"美股最近交易日為 {dd}"}


# ---------------- 匯率 ----------------
def bot_rates():
    """臺灣銀行牌告匯率（即期買入/賣出中價）。"""
    txt = _get("https://rate.bot.com.tw/xrt/flcsv/0/day").content.decode("utf-8-sig", errors="ignore")
    out = {}
    for row in csv.reader(io.StringIO(txt)):
        if len(row) < 14 or row[1] != "本行買入":
            continue
        try:
            si = row.index("本行賣出")
            buy, sell = _num(row[3]), _num(row[si + 2])
            if buy and sell:
                out[row[0].strip()] = {"buy": buy, "sell": sell, "rate": (buy + sell) / 2}
        except ValueError:
            continue
    return out


def fx_rates(currencies, d):
    res = {}
    try:
        bot = bot_rates()
    except Exception:
        bot = {}
    for c in currencies:
        if c == "TWD":
            continue
        y = None
        try:
            yb = yahoo_daily(f"{c}TWD=X", 10)
            ds = sorted(x for x in yb if x <= d) or sorted(yb)
            y = yb[ds[-1]]["close"] if ds else None
        except Exception:
            pass
        if c in bot:
            r = bot[c]
            if y:
                diff = abs(y - r["rate"]) / r["rate"]
                tag = f"{'✓' if diff <= 0.005 else '⚠'} Yahoo {y:.4f}（差異 {diff * 100:.2f}%）"
            else:
                tag = "單一來源"
            res[c] = {"rate": round(r["rate"], 4), "buy": r["buy"], "sell": r["sell"], "source": "臺灣銀行牌告（即期中價）", "date": d, "verified": tag}
        elif y:
            res[c] = {"rate": round(y, 4), "source": "Yahoo Finance", "date": d, "verified": "單一來源"}
    return res


# ---------------- 市場指標與情緒 ----------------
INDICES = [("^TWII", "台灣加權指數"), ("^GSPC", "S&P 500"), ("^IXIC", "Nasdaq"), ("^SOX", "費城半導體"), ("^VIX", "VIX 波動率"), ("^TNX", "美 10 年債殖利率"), ("TWD=X", "美元/新台幣")]


def market_snapshot(d: str):
    out = []
    for sym, name in INDICES:
        try:
            b = yahoo_daily(sym, 15)
            ds = sorted(x for x in b if x <= d)
            if len(ds) < 2:
                continue
            c, p = b[ds[-1]]["close"], b[ds[-2]]["close"]
            out.append({"sym": sym, "name": name, "date": ds[-1], "close": c, "chg": (c - p) / p})
        except Exception:
            continue
    inst = None
    try:
        dd = d.replace("-", "")
        j = _get(f"https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate={dd}&type=day&response=json").json()
        if j.get("stat") == "OK":
            for r in j["data"]:
                if r[0].startswith("外資及陸資") and "不含" in r[0]:
                    inst = {"foreign_net": _num(r[3]), "source": "TWSE 三大法人買賣金額統計"}
                elif r[0].startswith("外資") and inst is None:
                    inst = {"foreign_net": _num(r[3]), "source": "TWSE 三大法人買賣金額統計"}
    except Exception:
        pass
    # 規則式情緒判讀（與事實分開呈現）
    g = {x["sym"]: x["chg"] for x in out}
    s = 0.0
    for k, w in (("^TWII", 1), ("^GSPC", 1), ("^SOX", 0.8)):
        if k in g:
            s += w if g[k] > 0.005 else (-w if g[k] < -0.005 else 0)
    vix = next((x for x in out if x["sym"] == "^VIX"), None)
    if vix:
        s += -1 if (vix["close"] > 20 and vix["chg"] > 0) else (0.5 if vix["close"] < 15 else 0)
    if "TWD=X" in g:
        s += -0.5 if g["TWD=X"] > 0.003 else (0.5 if g["TWD=X"] < -0.003 else 0)
    if inst and inst.get("foreign_net") is not None:
        s += 0.5 if inst["foreign_net"] > 0 else -0.5
    mood = "Risk-on（風險偏好）" if s >= 1.5 else "Risk-off（避險）" if s <= -1.5 else "中性"
    return {"indices": out, "institutional": inst, "mood": mood, "mood_score": s}
