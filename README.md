# 資產羅盤｜個人財務與投資顧問（GitHub Pages 版）

手機優先的個人財務網站：記帳、股票買賣、資產／外幣／應收應付、年度存錢目標、新聞分享、AI 財務顧問（Gemini／ChatGPT／Claude），並由 **GitHub Actions 每天自動抓取收盤價、匯率、新聞，產生完整財務報表寄到你的信箱**。

> 所有財務資料都以你的「同步密語」經 **AES-256-GCM** 加密後才存進 repo，公開 repo 也看不到內容。API 金鑰與 GitHub Token 只存在你的瀏覽器或 GitHub Secrets。

---

## 功能一覽

| 頁面 | 內容 |
|---|---|
| 總覽 | 2×2 KPI（淨資產、金融資產、未實現損益、目標達成率）、100 分制財務評分、年度目標進度條、資產配置圖、交割／收付提醒、本月收支 |
| 記帳 | 收入／支出、類別分析、六個月現金流、預算與儲蓄率，可同步扣帳戶餘額 |
| 投資 | 持股（平均成本法）、總成本／總市值／未實現與已實現損益、核心–衛星配置差距、交易紀錄、T+2／T+1 交割排程、手動價格、AI 個股分析 |
| 報表 | 雲端每日報表（與 email 相同）、本機即時報表、一鍵觸發產生／寄信 |
| 資產與現金 | 活存／數位／交割／定存／外幣帳戶、匯率、應收、應付、其他資產、負債 |
| 年度計畫 | 任意多個目標（金融資產、淨資產、期間儲蓄、股票市值、手動），含時間進度刻度與每月所需金額 |
| 財務診斷 | 短中長期目標、收入支出、投資期限、8 題風險屬性問卷 → 保守／穩健／積極，並建議核心–衛星配置 |
| AI 顧問 | 財務診斷、資產配置、再平衡、停損停利、個股分析、今日新聞、教學一課；可選第二家 AI 交叉審核 |
| 新聞分享 | 每日報表的重點新聞＋你自己收藏的新聞與筆記 |
| 理財學堂 | 18 堂內建課程＋AI 依你的狀況客製課程 |

### 每日報表內容

1. 最新財務狀況總覽（2×2 KPI）
2. 現金分類與總和、應收／應付
3. 外幣換算（臺灣銀行牌告即期中價，與 Yahoo 交叉比對）
4. 股票明細：總成本／總市值／總未實現損益，**全部採用同一交易日收盤價**，逐檔標註來源與驗證結果；若當日有買賣，加入完整「當日交易復盤」：開高低收、VWAP、日內位置、成交價格品質（偏便宜／合理／偏貴）、配置契合度、集中度、流動性、紀律，0–100 分＋A+～D、市場事實與情緒判讀分開、做得好／需改善／下次規則／下一交易日與 1–4 週建議
5. 金融資產總市值（含 100 萬里程碑進度）
6. 資產配置圖（實際 vs 目標、個股權重）
7. 專業財務評分 100 分制：流動性 20%、現金流／儲蓄紀律 20%、資產成長／目標進度 20%、投資組合分散／集中 25%、執行／交割／負債 15%；每項顯示得分、依據、優勢、風險與改善優先順序
8. 整體建議、配置與集中度、現金流與儲蓄、1–7 天／1–3 個月／至目標期行動、目標達成率與差額
9. 交割／現金流提醒（交割帳戶是否足額）
10. 每日新聞：台灣 2–3 則＋國際 2–3 則，優先官方／原始來源，說明事件、為何影響你、觀察什麼，附可點擊來源
11. 今日理財教學、AI 交叉審核結果、引用來源

---

## 安裝步驟（約 15 分鐘）

### 1. 建立 repo 並上傳檔案
1. GitHub → **New repository**（例如 `my-finance`）。免費帳號使用 GitHub Pages 需為 **Public**（資料已加密）；GitHub Pro 可用 Private。
2. 將本資料夾所有檔案上傳（含 `.github/`、`.nojekyll`）。

### 2. 開啟 GitHub Pages
Settings → **Pages** → Source：`Deploy from a branch` → Branch：`main`／`/(root)` → Save。
約 1 分鐘後網址為 `https://<你的帳號>.github.io/<repo>/`，用手機開啟後可「加入主畫面」當 App 使用。

### 3. 建立 Personal Access Token（讓網站能同步資料）
GitHub 右上頭像 → Settings → Developer settings → **Fine-grained tokens** → Generate new token
- Repository access：**Only select repositories** → 選你的 repo
- Permissions：**Contents：Read and write**、**Actions：Read and write**、**Workflows：Read and write**
- 建議設定到期日，到期後重新產生即可

### 4. 在網站完成同步設定
網站 → 更多 → **設定 → GitHub 同步**：填入帳號、repo、分支、Token 與**同步密語**（請用 12 字以上、自己記得住的句子；**遺失無法復原**）→「儲存並測試」。成功後 repo 會出現 `data/vault.enc.json`。

### 5. 設定 GitHub Secrets（每日報表用）
Repo → Settings → Secrets and variables → **Actions → New repository secret**：

| Secret | 必要 | 說明 |
|---|---|---|
| `VAULT_PASSPHRASE` | ✅ | 與網站相同的同步密語 |
| `GEMINI_API_KEY` | 擇一以上 | Google AI Studio 取得 |
| `OPENAI_API_KEY` | 擇一以上 | OpenAI Platform 取得 |
| `ANTHROPIC_API_KEY` | 擇一以上 | Claude Console 取得 |
| `SMTP_USER` | ✅ 寄信 | 寄件信箱，例如 Gmail 地址 |
| `SMTP_PASS` | ✅ 寄信 | Gmail 請用「應用程式密碼」（需開啟兩步驟驗證：Google 帳戶 → 安全性 → 應用程式密碼） |
| `SMTP_HOST` / `SMTP_PORT` | 選填 | 預設 `smtp.gmail.com` / `465` |
| `MAIL_TO` | 選填 | 收件者（網站設定優先） |

設定兩家以上 AI 金鑰時，會自動由第二家進行**交叉審核**（不需要可在 Variables 設 `AI_VERIFY=off`）。

選填 **Variables**（同頁 Variables 分頁）：`AI_PROVIDER`（gemini／openai／claude）、`GEMINI_MODEL`、`OPENAI_MODEL`、`CLAUDE_MODEL`（模型名稱更新時在這裡改，不必改程式）。

### 6. 設定寄送時間並測試
- 網站 → 設定 → **每日報表寄送**：填收件信箱、時間（台北）、星期 → 儲存，網站會自動改寫 workflow 的排程。預設台北 **週二～週六 07:30**，此時台股與美股前一交易日皆已收盤，能用同一交易日收盤價。
- 立即測試：網站「報表 → 產生並寄信」，或 GitHub → Actions → **Daily Financial Report** → Run workflow（send_mail = true）。

### 7. 網站內 AI 顧問
網站 → 設定 → **AI 串接**：填入金鑰（僅存在該瀏覽器）、選主要 AI 與交叉審核 AI。

---

## 資料來源與驗證規則

| 資料 | 來源（優先序） | 驗證 |
|---|---|---|
| 台股收盤、開高低、VWAP | 臺灣證券交易所 TWSE／證券櫃檯買賣中心 TPEx（官方）→ Yahoo Finance | 官方價優先；多來源差異 > 0.5% 標示 ⚠ |
| 美股收盤 | Yahoo Finance、Stooq | 兩個獨立來源比對、同一交易日 |
| 匯率 | 臺灣銀行牌告（即期買賣中價）→ Yahoo | 差異 > 0.5% 標示 ⚠ |
| 市場指標 | 加權指數、S&P 500、Nasdaq、費半、VIX、美 10 年債、USD/TWD；TWSE 三大法人 | 事實與規則式情緒判讀分開 |
| 新聞 | 央行、Fed、ECB、BLS 官方 RSS＋中央社、Google News 候選 → AI 搜尋並回溯原始來源 | 第二家 AI 事實查核 |

## 注意事項
- 交割日僅排除週末，**國定假日**請自行留意。
- GitHub 排程可能延遲 5–30 分鐘；repo 60 天無活動會暫停排程（每日報表會自動 commit，通常不會發生）。
- Yahoo／Stooq 為非官方資料源，偶有中斷，系統會自動改用其他來源並標示。
- AI 模型名稱會隨時間更新，若出現「model not found」請到網站設定或 GitHub Variables 更換。
- 本系統內容僅供個人理財參考，**不構成投資建議**。

## 檔案結構
```
index.html               網站入口（手機優先 SPA）
assets/                  前端：store（加密同步）、calc（計算與評分）、ai、views、ui、lessons
scripts/daily_report.py  每日報表主程式
scripts/market_data.py   收盤價／匯率／市場指標
scripts/ai_client.py     AI 串接與新聞蒐集
scripts/finance_core.py  加解密與評分（與前端一致）
.github/workflows/       每日排程
data/                    加密資料（vault.enc.json、report.enc.json）
```

本機測試報表：`VAULT_PASSPHRASE=... python scripts/daily_report.py --html out/report.html --no-write`
