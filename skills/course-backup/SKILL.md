---
name: course-backup
description: 使用 Node.js CLI 備份使用者已購買且可正常播放的 Duotify 課程，或下載使用者授權的直接 HLS／影片網址。適用於列出章節、挑選畫質及保存影片與字幕；不處理任意網站登入、DRM、轉錄或影片發布。
---

# 課程備份

使用本技能的 `scripts/run.mjs` 呼叫本機專案 CLI。先以 `node "<本技能絕對路徑>/scripts/run.mjs" --help` 確認目前支援的選項。包裝程式依序使用 `COURSE_BACKUP_HOME`、安裝時的 `local-config.json` 或技能所在儲存庫定位 CLI；若專案搬家，重新執行專案的 `scripts/install-skill.mjs --force` 更新路徑。

## 執行

先確認使用者提供的課程網址與儲存位置；已經指定的選擇直接沿用。已知要下載的章節時直接執行 `download`，不要為驗證而額外執行 `scan`，避免多一次連線授權；`download` 開始時也會列出編號目錄，適合「列出章節並下載第 1 章」的合併需求。未指定章節時先列出章節供選擇，不自行下載整個帳號。相對輸出路徑以執行命令時的工作目錄為準。

```text
node "<技能路徑>/scripts/run.mjs" scan "<課程網址>" --json
node "<技能路徑>/scripts/run.mjs" download "<課程網址>" --out "<輸出資料夾>" --chapters 1,3 --quality best
node "<技能路徑>/scripts/run.mjs" download "<課程網址>" --out "<輸出資料夾>" --all --max-height 1080
node "<技能路徑>/scripts/run.mjs" download --media "<直接影片或 HLS 網址>" --out "<輸出資料夾>" --title "<檔名>"
```

課程命令預設 `--browser existing`，連接使用者正常開啟、已登入多奇的 Chrome 144+，只處理 `https://learn.duotify.com`。不需要安裝擴充功能。首次請使用者自行開啟 `chrome://inspect/#remote-debugging` 啟用遠端偵錯；CLI 連線時，使用者需接受 Chrome 原生「允許」提示。這兩步是 Chrome 官方 auto-connect 流程要求的使用者操作；已完成設定時不重複要求。CLI 接著建立自己的課程分頁，沿用既有登入；完成或取消時只關閉這個分頁並中斷連線，保留使用者原有瀏覽器與分頁。

不需在自動化視窗重新登入 Google。只有使用者明確選擇時，才加 `--browser chrome|msedge|chromium` 開啟獨立、非持久工作階段；這些模式每次需登入，Google 可能拒絕其登入。`--wait-login 600` 調整連線授權與課程等待秒數。預設保存字幕；使用者不需要時才加 `--no-subtitles`。直接媒體模式不開瀏覽器，也不帶 Cookie。

若程序仍在執行，依工具提供的 session 持續追蹤至完成或確定錯誤；不要重複啟動同一下載。取得明確錯誤後修正原因再重試，不以反覆登入或無限重試處理權限失敗。

## 驗證與資料處理

- 僅處理使用者授權且可正常播放的課程。existing 模式只讀取多奇所需的 Cookie，Cookie 與解密資訊只供當次 CLI 記憶體使用；不要要求貼密碼、Cookie 或金鑰，也不要複製 Chrome profile、讀取儲存密碼、加入遠端偵錯啟動旗標或匯出登入資料。
- Chrome 設定與原生授權由使用者操作。瀏覽器工具不允許操作的 `chrome://`、`chrome-extension://` 頁面，不能改用 CLI、CDP 或其他工具繞過 URL 限制；CLI 的自動化操作只在自身建立的課程分頁進行。需要使用者介入時，明確指出原因是 Chrome 原生設定或本次連線授權，並引用 [Chrome 官方 auto-connect 說明](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)。
- 完成前的影片使用 `.part` 暫存名稱；成功寫入及關閉後才取得正式檔名。存在檔案或 0 KB 檔案不代表成功，依 CLI 結束碼與完成訊息判定。不要刪除既有影片來重試。
- 錯誤訊息保持固定、可理解的描述。回報類型、章節與修正方式即可；不要貼原始 Cookie、金鑰、簽名 URL、網路回應或含權杖的 debug 記錄。
- 完成後列出實際生成的絕對檔案路徑與大小，並驗證離線播放的影音及長度；若本機播放器／探測工具不可用，明確說明離線播放尚未驗證。合成測試通過不能稱為真實課程下載已驗證。
