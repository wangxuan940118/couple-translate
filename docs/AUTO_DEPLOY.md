# GitHub CI 與 Render 自動部署

這個設定讓 PR 先跑檢查，人工審查並合併到 `main` 後，再由選定的部署模式更新 Render。**不會自動合併 PR，也不會部署 NAS 或舊測試站。** LAB 仍是先行驗收環境。

## 目前完成範圍

- `.github/workflows/ci.yml`：PR 指向 `main`、以及 `main` 的 push，都用 Node.js 24 執行 `npm ci`、`npm run check`、`npm test`。
- 權限限於 `contents: read`；PR／fork 沒有部署步驟或部署秘密值。沒有 `pull_request_target` 或手動繞過 CI 的部署入口。
- 預設只跑 CI。**Render 後台自動部署選項尚未經本次工作確認，不能把此檔案存在當成已啟用自動部署。** GitHub 舊 commit 的 combined status 沒有完成檢查，也不能證明 Render 已設好。
- 可選 hook 模式的程式與模擬測試已備妥；未呼叫真實 hook，未建立任何付費服務。

擇一使用以下模式，避免同一 commit 重複部署。

## 建議：Render 原生 After CI Checks Pass

這個模式不需要新增 deploy hook 秘密值。

1. 在 Render 開啟正確的 `couple-translate` 測試服務 → **Settings**。確認 GitHub Repository 是 `wangxuan940118/couple-translate`、Branch 是 `main`，且透過 GitHub 連線，不是只有公開 Git URL。
2. 將 **Auto-Deploy** 設成 **After CI Checks Pass**，儲存。Build 使用 `npm ci`，Start 使用 `npm start`；Runtime 使用 Node.js 24。
3. GitHub Repository → **Settings → Secrets and variables → Actions → Variables**：`RENDER_DEPLOY_MODE` 留空，或設為 `native`。不要同時啟用 hook 模式。
4. GitHub → **Settings → Rules → Rulesets**（或 branch protection）：保護 `main`，要求 PR 審查與 **Checks (Node 24)** 通過；不要允許直接推送作為日常發布方式。這項管理設定需擁有者確認，程式不會自行變更。
5. 審查並合併這份設定 PR。到 GitHub **Actions → CI** 確認 `main` 檢查成功，再到 Render **Deploys** 確認相同 commit 的部署結果。
6. 開啟網站的 `/api/health`，核對 `commit` 等於已通過 CI 的 GitHub commit；再確認 `/api/ready` 回覆 HTTP 200 且 `ready: true`、`configured: true`。後者代表目前私有服務設定／資料庫 schema 可用，並不代表聊天永久儲存、備份恢復、雙人 iPhone 通話已實測。

若 Render 沒偵測到任何檢查，After CI Checks Pass 不會自行部署；先處理 GitHub Actions 權限／連線和檢查結果，不要改成略過檢查來掩蓋問題。此模式的 GitHub CI 成功只證明檢查通過，部署成功仍須看 Render 與上述版本驗證。

參考：[Render 自動部署與 CI 設定](https://render.com/docs/deploys#configuring-auto-deploys)。

## 可選：GitHub 在 CI 成功後呼叫 Render hook

只有需要由 GitHub 工作流程一併等待部署驗證時才選這個模式。它會把完整的已測試 SHA 放入 `ref`，而不是部署檢查完成時可能已移動的分支頭。

擁有者一次設定：

1. Render 正確服務 → **Settings**：先將 **Auto-Deploy 設為 Off**。不要與原生自動部署同時使用；對特定 SHA 的 hook 部署也會關閉 Render 原生自動部署，這是此模式的預期行為。
2. 同一頁複製 **Deploy Hook**。它是秘密值，**不要貼到聊天、PR、程式碼、Issues 或一般 Variables**。
3. GitHub Repository → **Settings → Secrets and variables → Actions → Secrets → New repository secret**：名稱填 `RENDER_DEPLOY_HOOK_URL`，值貼入完整 hook URL。程式只接受 `https://api.render.com/deploy/srv-…?key=…`。
4. 同一設定頁的 **Variables** 新增：

   | 名稱 | 值 |
   | --- | --- |
   | `RENDER_SERVICE_URL` | `https://couple-translate.onrender.com`，必須對應該 hook 的同一服務；不含路徑、查詢參數或帳密。 |
   | `RENDER_DEPLOY_MODE` | `hook` |

5. PR 仍只跑檢查。人工核准並合併後，`main` 的 **Checks (Node 24)** 成功才會執行 **Render hook deployment (opt-in)**。
6. 部署 job 只送出一次 POST，不跟隨重新導向，也不輸出秘密網址、金鑰或原始服務回應。HTTP 200 表示已開始、202 表示排隊，兩者都不是部署成功證明。它最多等待十分鐘，核對 `/api/health` 的精確 commit，再核對 `/api/ready`；成功才將此 job 標示通過。

秘密值缺少、網址格式錯誤、服務拒絕、commit 未更新或 readiness 未通過，都會清楚失敗。超時或網路錯誤時，程式不會重送 hook；**先到 Render Deploys 檢查，避免直接重跑造成另一批部署或額外用量**。若平台排隊超過十分鐘，job 可能失敗而部署稍後才完成，請按實際 SHA 與 readiness 判斷。

轉回原生模式時，先把 GitHub 的 `RENDER_DEPLOY_MODE` 改為 `native`（或刪除），再在 Render 選回 After CI Checks Pass。Deploy hook 若曾洩漏，請在 Render 重新產生並更新 GitHub Secret。

參考：[Render Deploy Hooks](https://render.com/docs/deploy-hooks)、[指定 commit 及自動部署的影響](https://render.com/docs/deploys#effect-on-automatic-deploys)。

## 可執行驗證與費用

```sh
node --check scripts/render-deploy.mjs
node --test test/render-deploy.test.mjs
```

測試注入假的 fetch、時鐘與 sleep，不會向 Render 發送部署請求。涵蓋秘密值遮蔽、網址／main／PR 限制、精確 SHA、200 與 202、失敗、版本不符、後端尚未 ready 及 workflow 權限／依賴關係。

這些設定不會自動購買服務。GitHub Actions 分鐘、Render 建置／執行資源仍依各帳戶方案與實際用量計算；資料庫、持久磁碟與 TURN 也必須各自配置，CI／readiness 通過不能代替它們的實際驗收。NAS 身分與存取仍未知，沒有 NAS 自動部署。
