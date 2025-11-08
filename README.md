# 美股財報一致性分析器 Pro

以 Node.js + Express 建立的 SEC / Finnhub / OpenRouter 整合服務，輸入股票代號與日期即可回傳最新 10-Q/10-K 摘要、分析師資料、目標價推估與 LLM 投資建議。前端為純靜態頁面（`public/index.html`），後端 API 位於 `/api/analyze`。

## 需求

- Node.js 18+（本地開發使用 `npm run dev`）
- 必要 API key（放進 `.env`）：
  - `SEC_USER_AGENT`：SEC 強制要求，可填 `YourApp/1.0 (email@example.com)`
  - `FINNHUB_KEY`：取得推薦 / 財報 / 報價
  - `OPENROUTER_KEY`：呼叫 LLM（預設模型 `gpt-5`，可自行調整 `OPENROUTER_MODEL`）
- 推薦 API key：
  - `SEC_API_KEY`：提升 SEC API 速率
  - `ALPHAVANTAGE_KEY`：Price Target 第三層備援

## 安裝與啟動

```bash
git clone https://github.com/garen0616/us-equity-analyzer-pro.git
cd us-equity-analyzer-pro
npm install

# 編輯 .env，至少填入 SEC/Finnhub/OpenRouter 金鑰
cp .env.example .env  # 如需範本

# 本地啟動
PORT=5000 npm run dev
# → http://localhost:5000
```

## 自動化自我測試（NVDA 範例）

伺服器啟動後，可以用 `curl` 直接測試 API：

```bash
DATE=$(date -I)
curl -s -X POST http://localhost:5000/api/analyze \
  -H 'Content-Type: application/json' \
  -d "{\"ticker\":\"NVDA\",\"date\":\"$DATE\"}" \
  > /tmp/nvda_api_response.json
```

本次實測（2025-11-08）關鍵輸出：

- `quote.c = 188.15`（Finnhub 現價）
- `price_target.targetMean = 229.67`（AlphaVantage 均價，系統已自動補齊高低區間）
- `analysis.action.rating = BUY`、`target_price = 225`、`stop_loss = 165`

前端頁面同時會顯示財報時間線、雷達圖與 ChatGPT 總結，可用瀏覽器打開 `http://localhost:5000` 驗證。

## 部署到 Zeabur

1. 在 Zeabur 建立新專案，選擇 **Deploy from GitHub** 並連結 `us-equity-analyzer-pro`。
2. Build 設定：
   - Runtime: Node.js 20+
   - Install command: `npm install`
   - Build command: _(留空)_
   - Start command: `npm run start`
3. Environment variables（與 `.env` 相同）：
   - `PORT=3000`（Zeabur 會自動指定，保留即可）
   - `SEC_USER_AGENT=...`
   - `SEC_API_KEY=...`
   - `FINNHUB_KEY=...`
   - `ALPHAVANTAGE_KEY=...`（如有）
   - `OPENROUTER_KEY=...`
   - `OPENROUTER_MODEL=gpt-5`
4. 部署完成後，Zeabur 會提供公開 URL，即可透過瀏覽器使用。

## 有用腳本

- `npm run dev`：載入 `.env` 並啟動本地伺服器。
- `npm start`：生產模式啟動（Zeabur / 其他 PaaS 使用）。
- `npm run test:self`：呼叫 `/selftest`，驗證整體串接。
