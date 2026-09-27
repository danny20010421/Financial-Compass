"""finance_core.py — 加解密與財務計算（與 assets/calc.js 規則一致）"""
from __future__ import annotations

import base64
import json
import math
import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

TZ = ZoneInfo("Asia/Taipei")
BUCKETS = {"core": "核心（指數ETF）", "satellite": "衛星（成長個股）", "bond": "債券", "defensive": "防禦／現金"}
ITER = 210000


# ---------------- Crypto（與 WebCrypto AES-GCM / PBKDF2-SHA256 相容） ----------------
def _key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(passphrase.encode("utf-8"))


def decrypt(env: dict, passphrase: str) -> dict:
    key = _key(passphrase, base64.b64decode(env["salt"]), int(env.get("iter", ITER)))
    pt = AESGCM(key).decrypt(base64.b64decode(env["iv"]), base64.b64decode(env["data"]), None)
    return json.loads(pt.decode("utf-8"))


def encrypt(obj: dict, passphrase: str) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    key = _key(passphrase, salt, ITER)
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode("utf-8"), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "alg": "AES-256-GCM", "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b(salt), "iv": b(iv), "data": b(ct)}


# ---------------- Helpers ----------------
def today() -> str:
    return datetime.now(TZ).date().isoformat()


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def fmt(x, cur="TWD", d=0):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    sym = {"TWD": "$", "USD": "US$"}.get(cur, cur + " ")
    return ("-" if x < 0 else "") + sym + f"{abs(x):,.{d}f}"


def fmt_short(x):
    a = abs(x)
    if a >= 1e8:
        return f"{x / 1e8:.2f}億"
    if a >= 1e4:
        return f"{x / 1e4:.{1 if a >= 1e6 else 2}f}萬"
    return f"{round(x):,}"


def pct(x, d=1):
    if x is None:
        return "—"
    return f"{x * 100:.{d}f}%"


def add_biz_days(ds: str, n: int) -> str:
    d = date.fromisoformat(ds)
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d.isoformat()


class Book:
    """以 vault 與市場資料（prices/fx）計算所有財務指標。"""

    def __init__(self, vault: dict, prices: dict | None = None, fx: dict | None = None, as_of: str | None = None):
        self.v = vault
        self.prices = prices or {}
        self.fx = fx or {}
        self.td = as_of or today()

    # ---- FX / 價格 ----
    def fx_rate(self, cur):
        if not cur or cur == "TWD":
            return 1.0
        r = self.fx.get(cur)
        if r and r.get("rate"):
            return float(r["rate"])
        return float(self.v.get("fxManual", {}).get(cur, 1) or 1)

    def to_twd(self, amt, cur):
        try:
            return float(amt or 0) * self.fx_rate(cur)
        except (TypeError, ValueError):
            return 0.0

    def price_of(self, key):
        rep = self.prices.get(key)
        man = (self.v.get("prices") or {}).get(key)
        # 報表一律採用同一交易日的市場收盤價；無市場資料時才使用手動價格
        if rep:
            return rep
        return {**man, "verified": "手動輸入（未驗證）"} if man else None

    # ---- 持股（平均成本法） ----
    def _sorted_trades(self):
        return sorted(self.v.get("trades", []), key=lambda t: (t.get("date", ""), t.get("time") or ""))

    def holdings(self, until: str | None = None, exclude_id: str | None = None):
        m = {}
        for t in self._sorted_trades():
            if until and t["date"] > until:
                continue
            if exclude_id and t.get("id") == exclude_id:
                continue
            key = f'{t["market"]}:{t["symbol"]}'
            h = m.setdefault(key, {"key": key, "symbol": t["symbol"], "name": t.get("name") or t["symbol"], "market": t["market"],
                                   "currency": t.get("currency") or ("USD" if t["market"] == "US" else "TWD"),
                                   "bucket": t.get("bucket") or "satellite", "qty": 0.0, "cost": 0.0, "realized": 0.0})
            if t.get("name"):
                h["name"] = t["name"]
            if t.get("bucket"):
                h["bucket"] = t["bucket"]
            q, p = float(t["qty"]), float(t["price"])
            fee, tax = float(t.get("fee") or 0), float(t.get("tax") or 0)
            if t["side"] == "buy":
                h["qty"] += q
                h["cost"] += q * p + fee
            else:
                avg = h["cost"] / h["qty"] if h["qty"] > 0 else 0
                h["realized"] += q * p - fee - tax - avg * q
                h["cost"] -= avg * q
                h["qty"] -= q
                if h["qty"] <= 1e-9:
                    h["qty"], h["cost"] = 0.0, 0.0
        out = [h for h in m.values() if h["qty"] > 0]
        for h in out:
            pr = self.price_of(h["key"])
            h["avg"] = h["cost"] / h["qty"]
            h["price"] = float(pr["close"]) if pr else h["avg"]
            h["price_date"] = pr.get("date", "") if pr else ""
            h["price_source"] = pr.get("source", "") if pr else "以成本暫估"
            h["verified"] = pr.get("verified", "") if pr else ""
            h["stale"] = not pr
            h["mv"] = h["qty"] * h["price"]
            h["upl"] = h["mv"] - h["cost"]
            h["upl_pct"] = h["upl"] / h["cost"] if h["cost"] else 0
            h["mv_twd"] = self.to_twd(h["mv"], h["currency"])
            h["cost_twd"] = self.to_twd(h["cost"], h["currency"])
            h["upl_twd"] = h["mv_twd"] - h["cost_twd"]
        tot = sum(h["mv_twd"] for h in out)
        for h in out:
            h["weight"] = h["mv_twd"] / tot if tot else 0
        return sorted(out, key=lambda h: -h["mv_twd"])

    def realized_twd(self):
        m, total = {}, 0.0
        for t in self._sorted_trades():
            h = m.setdefault(f'{t["market"]}:{t["symbol"]}', {"qty": 0.0, "cost": 0.0})
            q, p = float(t["qty"]), float(t["price"])
            fee, tax = float(t.get("fee") or 0), float(t.get("tax") or 0)
            if t["side"] == "buy":
                h["qty"] += q
                h["cost"] += q * p + fee
            else:
                avg = h["cost"] / h["qty"] if h["qty"] else 0
                total += self.to_twd(q * p - fee - tax - avg * q, t.get("currency"))
                h["cost"] -= avg * q
                h["qty"] -= q
        return total

    def settlements(self):
        res = []
        for t in self.v.get("trades", []):
            cur = t.get("currency") or ("USD" if t["market"] == "US" else "TWD")
            sd = add_biz_days(t["date"], 1 if t["market"] == "US" else 2)
            gross = float(t["qty"]) * float(t["price"])
            fee, tax = float(t.get("fee") or 0), float(t.get("tax") or 0)
            amt = -(gross + fee) if t["side"] == "buy" else gross - fee - tax
            if sd >= self.td:
                res.append({"trade": t, "date": sd, "amount": amt, "currency": cur, "amount_twd": self.to_twd(amt, cur)})
        return sorted(res, key=lambda s: s["date"])

    def cash_summary(self):
        by_type, by_cur, total = {}, {}, 0.0
        for a in self.v.get("accounts", []):
            val = self.to_twd(a.get("balance"), a.get("currency"))
            by_type[a.get("type", "其他")] = by_type.get(a.get("type", "其他"), 0) + val
            by_cur[a.get("currency", "TWD")] = by_cur.get(a.get("currency", "TWD"), 0) + float(a.get("balance") or 0)
            total += val
        return {"total": total, "by_type": by_type, "by_cur": by_cur}

    def cashflow(self, months=6):
        td = date.fromisoformat(self.td)
        keys = []
        y, mo = td.year, td.month
        for _ in range(months):
            keys.append(f"{y:04d}-{mo:02d}")
            mo -= 1
            if mo == 0:
                y, mo = y - 1, 12
        keys.reverse()
        res = {k: {"month": k, "income": 0.0, "expense": 0.0} for k in keys}
        for t in self.v.get("txns", []):
            k = t["date"][:7]
            if k in res:
                res[k]["income" if t["type"] == "income" else "expense"] += self.to_twd(t["amount"], t.get("currency"))
        out = list(res.values())
        for r in out:
            r["net"] = r["income"] - r["expense"]
            r["rate"] = r["net"] / r["income"] if r["income"] else None
        return out

    def snapshot(self, hs=None):
        v = self.v
        hs = hs if hs is not None else self.holdings()
        cash = self.cash_summary()
        stock_mv = sum(h["mv_twd"] for h in hs)
        stock_cost = sum(h["cost_twd"] for h in hs)
        recv = sum(self.to_twd(r["amount"], r.get("currency")) for r in v.get("receivables", []) if not r.get("done"))
        pay = sum(self.to_twd(r["amount"], r.get("currency")) for r in v.get("payables", []) if not r.get("done"))
        other = sum(self.to_twd(a["value"], a.get("currency")) for a in v.get("otherAssets", []))
        debt = sum(self.to_twd(l["balance"], l.get("currency")) for l in v.get("liabilities", []))
        financial = cash["total"] + stock_mv
        total_assets = financial + recv + other
        alloc = {"core": 0.0, "satellite": 0.0, "bond": 0.0, "defensive": cash["total"]}
        for h in hs:
            alloc[h["bucket"]] = alloc.get(h["bucket"], 0) + h["mv_twd"]
        return {"hs": hs, "cash": cash, "stock_mv": stock_mv, "stock_cost": stock_cost, "upl": stock_mv - stock_cost, "recv": recv, "pay": pay,
                "other": other, "debt": debt, "financial": financial, "total_assets": total_assets,
                "net_worth": total_assets - pay - debt, "alloc": alloc}

    def goal_progress(self, g, snap):
        metric = g.get("metric", "financial")
        if metric == "financial":
            cur = snap["financial"]
        elif metric == "netWorth":
            cur = snap["net_worth"]
        elif metric == "savings":
            cur = sum((1 if t["type"] == "income" else -1) * self.to_twd(t["amount"], t.get("currency"))
                      for t in self.v.get("txns", []) if t["date"] >= (g.get("startDate") or "0000"))
        elif metric == "stock":
            cur = snap["stock_mv"]
        else:
            cur = float(g.get("current") or 0)
        start = 0 if metric == "savings" else float(g.get("start") or 0)
        target = float(g.get("target") or 0)
        p = clamp((cur - start) / (target - start), 0, 1.5) if target > start else 0
        now = datetime.now(TZ)
        t0 = datetime.fromisoformat((g.get("startDate") or self.td) + "T00:00:00").replace(tzinfo=TZ)
        t1 = datetime.fromisoformat(g["deadline"] + "T23:59:59").replace(tzinfo=TZ)
        pace = clamp((now - t0) / (t1 - t0)) if t1 > t0 else 1
        days_left = max(0, math.ceil((t1 - now).total_seconds() / 86400))
        gap = max(0.0, target - cur)
        months_left = max(days_left / 30.44, 0.5)
        return {"cur": cur, "pct": p, "pace": pace, "gap": gap, "days_left": days_left, "per_month": gap / months_left, "on_track": p >= pace - 0.02}

    # ---- 100 分制評分 ----
    def score(self, snap=None):
        v, p = self.v, self.v.get("profile", {})
        snap = snap or self.snapshot()
        cf = self.cashflow(3)
        with_data = [m for m in cf if m["income"] or m["expense"]]
        avg_exp = sum(m["expense"] for m in with_data) / len(with_data) if with_data else float(p.get("monthlyBudget") or 0)
        avg_inc = sum(m["income"] for m in with_data) / len(with_data) if with_data else float(p.get("monthlyIncome") or 0)
        in30 = (date.fromisoformat(self.td) + timedelta(days=30)).isoformat()
        em = float(p.get("emergencyMonths") or 6)
        dims = []

        liquid = sum(x * (0.5 if k == "定存" else 1) for k, x in snap["cash"]["by_type"].items())
        months = liquid / avg_exp if avg_exp > 0 else (12 if liquid > 0 else 0)
        pay30 = sum(self.to_twd(x["amount"], x.get("currency")) for x in v.get("payables", []) if not x.get("done") and x.get("due") and x["due"] <= in30)
        s1 = clamp(months / em) * 20
        if pay30 > liquid:
            s1 *= 0.5
        dims.append({"key": "liquidity", "name": "流動性", "weight": 20, "score": s1,
                     "basis": f"可動用現金 {fmt(liquid)}（定存以 50% 計），月均支出 {fmt(avg_exp)}，可支應 {months:.1f} 個月；目標 {em:.0f} 個月。",
                     "strength": "緊急預備金充足。" if months >= 6 else ("具基本緩衝。" if months >= 3 else "—"),
                     "risk": "預備金不足 3 個月，遇收入中斷易被迫賣股。" if months < 3 else ("30 天內應付款大於可動用現金。" if pay30 > liquid else "無明顯流動性風險。"),
                     "fix": f"補足預備金差額 {fmt(max(0, em * avg_exp - liquid))}，存放高利活存／貨幣型工具。" if months < em else "維持現況，超額現金可依計畫分批投入。"})

        rate = (avg_inc - avg_exp) / avg_inc if avg_inc else 0
        pos = len([m for m in with_data if m["net"] > 0])
        s2 = clamp(rate / 0.3) * 16 + (pos / len(with_data)) * 4 if with_data else clamp(rate / 0.3) * 12
        dims.append({"key": "cashflow", "name": "現金流／儲蓄紀律", "weight": 20, "score": s2,
                     "basis": f"近 {len(with_data)} 個月月均收入 {fmt(avg_inc)}、支出 {fmt(avg_exp)}，儲蓄率 {pct(rate)}；正結餘月數 {pos}/{len(with_data)}。" + ("" if with_data else "（記帳資料不足，以個人設定估算）"),
                     "strength": "儲蓄率達 30% 以上，紀律良好。" if rate >= 0.3 else ("儲蓄率尚可。" if rate >= 0.15 else "—"),
                     "risk": "儲蓄率低於 10%，目標推進速度受限。" if rate < 0.1 else "支出波動需持續追蹤。",
                     "fix": f"先付自己：發薪日自動轉存 {fmt(max(0, avg_inc * 0.3 - (avg_inc - avg_exp)))} 以達 30% 儲蓄率；檢視前三大支出類別。" if rate < 0.3 else "將儲蓄自動化並設定定期定額。"})

        goals = v.get("goals", [])
        g = goals[0] if goals else None
        gp = self.goal_progress(g, snap) if g else None
        s3 = 10.0
        if gp:
            s3 = 20 if gp["pct"] >= 1 else clamp(gp["pct"] / gp["pace"] if gp["pace"] > 0 else gp["pct"]) * 20
        dims.append({"key": "growth", "name": "資產成長／目標進度", "weight": 20, "score": s3,
                     "basis": (f"「{g['name']}」達成率 {pct(gp['pct'])}，時間進度 {pct(gp['pace'])}；差額 {fmt(gp['gap'])}，剩 {gp['days_left']} 天，每月需增加 {fmt(gp['per_month'])}。") if g else "尚未設定目標。",
                     "strength": "進度領先或符合時間進度。" if gp and gp["on_track"] else "—",
                     "risk": "進度落後；請勿為追趕目標而提高風險。" if gp and not gp["on_track"] else "市場回檔可能使進度暫時倒退。",
                     "fix": f"以提高儲蓄與收入為主（每月 {fmt(gp['per_month'])}），而非加碼高波動資產；必要時調整目標期限。" if gp and not gp["on_track"] else "維持定期投入與再平衡。"})

        fin = snap["financial"] or 1
        hs = snap["hs"]
        max_h = hs[0] if hs else None
        max_w = max_h["mv_twd"] / fin if max_h else 0
        t = p.get("targetAlloc") or {"core": 55, "satellite": 15, "bond": 20, "defensive": 10}
        tsum = sum(float(t.get(k, 0)) for k in BUCKETS) or 100
        alloc_pct, dev = {}, 0.0
        for k in BUCKETS:
            alloc_pct[k] = snap["alloc"].get(k, 0) / fin
            dev += abs(alloc_pct[k] - float(t.get(k, 0)) / tsum)
        dev /= 2
        hhi = sum(h["weight"] ** 2 for h in hs)
        eff_n = 1 / hhi if hhi else 0
        s4 = 12.5 if not hs else (1 - clamp((max_w - 0.1) / 0.3)) * 10 + (1 - clamp(dev / 0.5)) * 10 + clamp(eff_n / 8) * 5
        dims.append({"key": "diversification", "name": "投資組合分散／集中", "weight": 25, "score": s4,
                     "basis": f"最大單一部位 {max_h['name']} 占金融資產 {pct(max_w)}；配置偏離目標 {pct(dev)}；有效持股數 {eff_n:.1f} 檔。" if hs else "尚無股票部位，以中性分數計。",
                     "strength": "配置貼近目標。" if dev < 0.1 else ("單一部位集中度低。" if hs and max_w < 0.15 else "—"),
                     "risk": "單一標的超過 25%，個股事件風險高。" if max_w > 0.25 else ("配置明顯偏離目標，風險特性與設定不符。" if dev > 0.2 else "無重大集中風險。"),
                     "fix": (f"新資金優先投入低配類別，不再加碼 {max_h['name']}；必要時分批減碼至 20% 以下。" if max_w > 0.25 else
                             ("以新增資金往目標配置靠攏（現金流再平衡），降低交易成本。" if dev > 0.1 else "每季檢視一次，偏離 >5% 再平衡。")),
                     "alloc_pct": alloc_pct, "dev": dev, "max_w": max_w, "eff_n": eff_n, "hhi": hhi})

        debt_ratio = snap["debt"] / snap["total_assets"] if snap["total_assets"] else 0
        st = self.settlements()
        need = -sum(x["amount_twd"] for x in st if x["amount_twd"] < 0) - sum(x["amount_twd"] for x in st if x["amount_twd"] > 0)
        sa = next((a for a in v.get("accounts", []) if a.get("id") and a["id"] == p.get("settlementAccountId")), None)
        sa_bal = self.to_twd(sa["balance"], sa.get("currency")) if sa else snap["cash"]["total"]
        covered = need <= 0 or sa_bal >= need
        overdue = len([x for x in v.get("payables", []) + v.get("receivables", []) if not x.get("done") and x.get("due") and x["due"] < self.td])
        s5 = (1 - clamp((debt_ratio - 0.1) / 0.4)) * 6 + (5 if covered else 0) + max(0, 4 - overdue * 2)
        dims.append({"key": "execution", "name": "執行／交割／負債", "weight": 15, "score": s5,
                     "basis": f"負債比 {pct(debt_ratio)}；未來交割淨需求 {fmt(max(0, need))}，交割帳戶 {fmt(sa_bal)}{'（足額）' if covered else '（不足）'}；逾期收付款 {overdue} 筆。",
                     "strength": "交割與收付款皆正常。" if covered and overdue == 0 else "—",
                     "risk": "交割款不足可能構成違約交割，影響信用。" if not covered else ("負債比偏高。" if debt_ratio > 0.3 else "無重大執行風險。"),
                     "fix": f"交割日前轉入 {fmt(need - sa_bal)} 至交割帳戶。" if not covered else ("處理逾期收付款項並更新狀態。" if overdue else "持續於交易前確認交割資金。"),
                     "need": need, "covered": covered, "sa_bal": sa_bal})

        for d in dims:
            d["score"] = round(d["score"], 1)
            d["pct"] = d["score"] / d["weight"]
        total = round(sum(d["score"] for d in dims), 1)
        grade = "A+" if total >= 90 else "A" if total >= 85 else "B+" if total >= 75 else "B" if total >= 65 else "C" if total >= 55 else "D"
        priority = [d["name"] for d in sorted(dims, key=lambda d: d["pct"])]
        return {"total": total, "grade": grade, "dims": dims, "priority": priority, "avg_exp": avg_exp, "avg_inc": avg_inc,
                "saving_rate": rate, "months": months, "goal": g, "gp": gp}
