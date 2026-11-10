# NAS Docker 部署交接

這份設定已備妥部署方式；**沒有連上 NAS，也沒有執行 NAS 部署**。NAS 型號、位址、CPU、Docker／Container Manager 狀態及登入管道目前未知。程式採 Supabase Auth + PostgreSQL；SQL 已由使用者回報執行成功，兩個登入帳號與環境變數仍須完成設定。這份文件不代表雙人手機通話或永久紀錄驗收已通過。

## 執行前需要的資料

1. NAS 型號、64 位元 CPU 架構、可用記憶體與 Docker Compose v2／Container Manager 版本。
2. NAS 管理或部署位址，以及已授權的安全存取方式。帳號密碼、API Key、Service Role Key 和 TURN 密碼請放管理介面或私密的 `.env`，不要貼聊天或提交 GitHub。
3. 對外使用的 HTTPS 網域、有效 TLS 憑證與反向代理。手機取得麥克風／相機及 WebRTC 需要安全來源；不能只交付區域網路 HTTP 位址。
4. **確認**要使用哪一個 Supabase 專案及兩個已驗證的 Auth User UUID。不要猜測資料庫、複製私人 LAB 的 D1 資料，或覆蓋 NAS 上其他專案的資料。

使用 Synology 時可在 Container Manager 建立獨立「專案」；QNAP 可用 Container Station 對應的 Compose 功能。不同機型介面和支援程度不同，確認上述資料後再填入實際路徑與網域。此設定不需要 privileged、host network 或 Docker socket 掛載。

## 目錄與環境變數

將**已確認的完整 GitHub commit** 放在 NAS 上獨立的新目錄，保留既有專案。目錄需有 `Dockerfile`、`compose.yaml`、`.dockerignore`、`package-lock.json`、`server.js`、`lib/`、`public/`、`scripts/container-health.cjs`。

在該目錄建立私密的 `.env`，參照 `.env.example`。不要把範例空值當成可運行設定，也不要將實際 `.env` 放進映像檔。Docker 的 build context 排除環境檔；Compose 只在**執行時**載入 `.env`。

必要值：

- `SUPABASE_URL`：已確認 Supabase 專案的 HTTPS URL。
- `SUPABASE_ANON_KEY`：該專案的 publishable／anon key；不可填 Service Role Key。
- `SUPABASE_SERVICE_ROLE_KEY`：伺服器專用金鑰，只放 NAS 私密環境檔。
- `PRIVATE_USER_IDS`：兩個已確認電子郵件的 Auth User UUID，以逗號分隔。
- `BUILD_SHA`：這次部署的完整程式 commit，方便 `/api/health` 比對版本。

視需求設定 `OPENAI_API_KEY`／`OPENAI_MODEL`、TURN 及 Web Push 變數，名稱參照 `.env.example`。未設翻譯金鑰時翻譯不能使用；STUN-only 不保證跨國／行動網路能接通。`TRUST_PROXY=1` 只在反向代理確實覆寫 `X-Forwarded-For`、且無法繞過代理存取容器時使用，其他情況保留 `0`。

NAS 用這個檔案控制權限：

```sh
chmod 600 .env
```

不要執行 `docker compose config` 後把完整輸出貼出來；它可能展開私密環境變數。若 Compose 版本支援，可使用 `docker compose config --quiet` 只檢查格式。

## 建置與啟動

下列 `VERSION` 必須替換成實際交付的 commit 或已核准版本標籤，不能保留省略號。這不是金鑰，僅用來標記映像檔與回退版本。確定目前目錄是這個專案後執行：

```sh
VERSION=approved-commit-tag
OLW_IMAGE_TAG="$VERSION" docker compose build
OLW_IMAGE_TAG="$VERSION" docker compose up -d --no-build
OLW_IMAGE_TAG="$VERSION" docker compose ps
OLW_IMAGE_TAG="$VERSION" docker compose exec little-world node scripts/container-health.cjs
```

映像採 Node.js 24 Debian bookworm-slim，僅安裝 lockfile 中的正式依賴，以非 root 使用者啟動。容器根檔案系統唯讀，`/tmp` 是有限的暫存記憶體；不掛聊天資料目錄。訊息只能存入已配置的 PostgreSQL，沒有本機檔案／記憶體替代保存。

Compose 只把 `127.0.0.1:3000` 綁到 NAS 本機。NAS 反向代理應將對外 `https://你的網域` 轉送至本機 `http://127.0.0.1:3000`，並支援 `Upgrade: websocket`、`Connection: upgrade` 及足夠的 WebSocket 讀取逾時。**不要**把 3000 埠直接對外開放。若反向代理也在另一個容器，需依 NAS 實況配置獨立私人 bridge network；不要逕改 host network 或公開綁定作為替代。

反向代理不會替代 TURN。若要跨不同 NAT／行動網路可靠通話，另配置自己的 TURN 服務；它可能產生頻寬費用。Supabase 和翻譯 API 的額度、費用與備份政策也由各供應商方案決定，這份設定不會自動開通付費服務。

## 健康狀態的意思

`container-health.cjs` 只呼叫容器本機 `/api/health`，不輸出金鑰、房間碼或聊天文字：

- `privateChat.configured=false`：必要設定未完成，檢查失敗，不會自動退回暫存聊天。
- `database=not-yet-verified`：設定完整，但應用程式尚未發出成功的資料庫請求。容器可啟動；**不能因此聲稱資料已永久保存**。
- `database=last-request-succeeded`：應用程式最近的資料庫請求成功，仍不等於關閉分頁／重新部署的完整驗收。
- `database=last-request-failed`：最近請求失敗，檢查失敗；可能是服務連線、SQL、權限或其他請求錯誤，需在不公開私密內容的前提下診斷。

Docker 顯示 healthy 不代表 Supabase 備份、雙人 iPhone 通話、背景通知或 TURN 已通過測試。此版本 Dockerfile 尚需在實際可用的 Docker daemon 建置驗證；不能把語法／模擬測試當作容器已成功運行。

## 首次驗收與重部署

完成 HTTPS、環境變數與帳號設定後，依 `docs/TESTING.md` 的真實雙人驗收清單執行：兩個帳號登入、發訊、都關閉網站再回來、離線訊息、相同 UUID 重試不重複、未授權第三者拒絕、容器重啟後紀錄仍存在，以及聲音／視訊與雙語字幕。檢查 `/api/health` 的 commit 與 `BUILD_SHA` 一致；手動填寫的 SHA 僅是版本標記，必須同時核對實際建置來源。

重啟測試可使用：

```sh
OLW_IMAGE_TAG="$VERSION" docker compose restart little-world
```

重部署以新版本標籤建置後 `up -d --no-build`，沿用**已確認的同一 Supabase 專案**才會讀到相同歷史紀錄。網站 origin 改變時瀏覽器登入狀態不共用，使用者須重新登入；不要將驗證 Token 複製到聊天或網址。

LAB／Render／NAS 若共用 Supabase 專案，會共同影響同一套帳號、房間與訊息，不能宣稱彼此資料隔離；測試環境應優先使用獨立專案。正式部署必須先確認採用哪個專案及遷移方式，不會自動把既有其他平台資料搬移或刪除。

## 回退

保留上一個可用映像標籤及其相容環境設定。若新版本有問題，先核對舊版仍支援目前的資料庫結構，再切回已保留的舊映像；不要重新 build 舊標籤，也不要刪除資料庫或執行反向 migration：

```sh
PREVIOUS_VERSION=previous-approved-tag
OLW_IMAGE_TAG="$PREVIOUS_VERSION" docker compose up -d --no-build
```

回退網站程式不會回復或刪除 PostgreSQL 資料。不要用 `down -v`、清除資料表、還原舊備份或刪除其他 NAS 專案來處理回退；資料庫還原需要另外確認範圍與資料損失影響。
