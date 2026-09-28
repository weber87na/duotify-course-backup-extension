# 驗證紀錄

日期：2026-09-27

## CLI v0.4.1 課程首頁章節解析（2026-09-29）

真實登入頁 `/courses/ai-prompt` 的章節連結使用 `href="javascript:void(0);"`，章節資料位於 `handleContentClickRedirect(event, 'ai-prompt', 281)`。掃描器現在只解析這個已觀察到的固定呼叫格式，產生同課程的播放網址；不執行頁面提供的 JavaScript。首頁上的介紹影片不再被當作章節目錄，也不會將沒有目錄的首頁建立成假章節。

`node --test --test-reporter=spec tests/*.test.js`：162 項測試中 161 項通過、0 項失敗、1 項略過（需明確啟用的 Chrome 實體生命週期測試）。新增回歸測試涵蓋 onclick 章節解析、一般連結去重與順序、錯誤格式及跨課程拒絕，以及從首頁依預設／`--all`／`--chapters` 進入所選播放頁的命令流程。CLI 與已安裝的 Skill wrapper 均回報 `0.4.1`。

透過既有 Chrome 的登入狀態，實際從 `/courses/ai-prompt` 自動找到章節 `281`，並開啟對應播放頁；不需使用者另外提供播放網址。後續播放器就緒檢查先後在 30 秒及 90 秒逾時，最後狀態為 `readyState=0`、`networkState=2`、沒有 MediaError、時長約 5380.44 秒；原因尚未確認。本次已驗證首頁解析與章節導覽，未驗證該課程影片分段下載，也沒有下載整部影片；未因此放寬既有播放授權檢查。

## CLI v0.4.0 existing Chrome 模式（2026-09-28）

預設連接正常執行中的 Chrome 144+，由使用者手動啟用 auto-connect 並接受 Chrome 的連線授權；不依賴 Chrome 擴充功能。已確認本機 Chrome 153 符合版本需求。既有 HLS、AES、檔案發布與合成 HTTP 測試仍適用。

`node --test tests/*.test.js` 通過；Chrome 實體瀏覽器測試預設略過，需指定 `COURSE_BACKUP_TEST_CHROME` 才執行。新增 14 項既有 Chrome adapter 測試涵蓋同課程限制、URL 範圍內的 Cookie、授權逾時／取消、延遲建立資源的清理；命令整合測試另確認預設使用 existing 並遵守章節選擇。

使用本機 Chrome 153、獨立 headless 臨時 profile 執行實體連線測試，通過：真正建立新分頁、關閉自身分頁並 disconnect 後，原分頁與原瀏覽器仍保留。此測試發現並修正 Chrome 新建 `tab` 的初始 URL 為空字串、先前被 filter 排除而逾時的問題；全程僅使用 `about:blank` 與 `data:` 測試內容，不使用真實登入。未啟用 auto-connect 時，實際 CLI 也已確認會顯示設定方法並以 exit 1 結束。

已完成真實 Chrome 153 auto-connect：使用者啟用原生設定並允許連線，CLI 沿用多奇登入、列出兩章目錄，依選擇下載第 1 章與字幕，exit 0、failed 空陣列，全程不依賴擴充功能。影片 1531 個分段、719,101,128 bytes；VTT 字幕 438,786 bytes。原有同名影片保留，新影片自動加 `(1)`，完成後沒有 `.part` 殘留。

對新完成影片以 PyAV 18.1.0 進行本機唯讀檢查：MPEG-TS、H.264 2560×1440／25 fps，視訊時長 14170.56 秒（3:56:10.56）；AAC 雙聲道 48 kHz，音訊時長 14170.496 秒。在開頭、中段、末段各解碼 5 個視訊影格與 10 個音訊 frame，抽樣成功、未標記 corrupt；檢查期間檔案大小及 mtime 均未改變。隨機 seek 曾有參考影格警告，之後解碼成功；這不是整部逐影格解碼或人工聽看驗證。SHA-256：`9cfdf74b44ccdd880fb13df57588de2f4d0efe117c2eb938d523947a3e1a4f82`。驗證工具與報告放在忽略的 `.cache/`，不是 CLI 執行依賴。

後續將抽樣起點調整至 seek 後第一個 keyframe，再次檢查開頭、中段與末段，影音解碼均成功且沒有解碼警告，檔案 SHA-256 不變。此結果仍屬抽樣檢查。

## CLI v0.3.0／Skill（2026-09-28）

CLI 重用既有 parser／transfer；新增命令解析、章節選擇、來源綁定、Cookie 重新導向隔離、瀏覽器資源清理、原子檔案發布與 Skill 安裝測試。Node 的下載測試使用本機臨時資料夾，成功才發布正式檔名；失敗、取消和並行同名皆有涵蓋。

`node --test tests/*.test.js`：138 項通過、0 項失敗。包含真實 CLI 子程序透過 localhost 下載合成 AES-HLS 與 VTT，逐位元組驗證結果、JSON 與結束碼；错误首段 exit 1 且不產生正式檔或暫存檔。CLI／Skill wrapper 的 `--help`、`--version` 正常，Skill validator 通過，個人技能安裝後確認版本為 0.3.0。

登入瀏覽器的生命週期與課程操作使用 mock；未讀取真實 Cookie，未完成 CLI 真實課程下載或離線播放驗證。這與合成 HTTP／AES 測試分開記錄，不因 CLI 測試通過而宣稱所有課程均可下載。

## 自動化測試

v0.2：`node --test tests/*.test.js` 共 81 項通過、0 項失敗（2026-09-27）。

- HLS：包含主清單、有限隨選串流、位元組範圍、初始化區段、AES-128 IV／金鑰輪替與不支援格式的辨識。
- 頁面掃描：7 項，包含可序列化注入的獨立函式、實際觀察到的影片屬性、章節目錄順序與導覽連結排除。
- 傳輸：包含依序寫入、網路重試、不重複寫入部分資料、取消、逾時、HTML 偽裝、範圍回應、TS 與 fMP4 驗證、AES-CBC 解密、錯誤金鑰、padding、金鑰 URI 與不可匯出的記憶體 CryptoKey。
- 多奇：以合成 Cookie 測試公開播放器的日期選擇、索引和 IV；驗證網域、課程、章節、清單及播放狀態在 Cookie 讀取前符合預期，錯誤訊息不包含 Cookie／金鑰。
- 來源綁定：驗證掃描頁、目錄章節、原始與最終 API 清單仍屬於預期課程及影片。
- 工具函式：3 項，包含 Windows 檔名、網址驗證與既有檔案避讓。

JavaScript 語法檢查通過。擴充功能本身無外部 npm 套件、無建置步驟；CLI 的瀏覽器登入依賴另由 package.json 宣告。

## Chrome 中的本機整合測試

使用 `tests/preview-server.mjs` 提供真實管理介面，配合 `tests/browser-mock.js` 模擬 Chrome API 與資料夾。只連線 localhost，輸出保存在記憶體。v0.2 第一章高畫質改為合成 AES-128 串流；低畫質與第二章保持未加密。

v0.1 已操作並驗證（全為未加密 fixture）：

1. 選取兩個章節，分析時出現精確的來源授權提示。
2. 授權後讀取第一章的主清單、畫質清單與第二章 HTML。
3. 選擇測試資料夾，下載兩部測試串流與一份字幕。
4. 三個檔案均完成關閉：752 bytes TS、60 bytes VTT、1128 bytes TS；無錯誤。
5. 第一章切換低畫質後再次下載，新增 376 bytes TS，檔名自動帶 `(1)`；原檔保留。

合成 TS 僅供資料流程測試，不是真實可觀看的課程影片。這項測試不代表原生擴充功能權限、真實資料夾寫入、網站登入認證或真實影片播放已驗證。

v0.2 已在 Chrome 重新操作分析、來源授權、選擇記憶體資料夾與批次下載：AES-128 第一章輸出 752 bytes、字幕 60 bytes、未加密第二章 1128 bytes，3 項皆為 closed，0 項錯誤。金鑰來源只請求一次，所有請求均為 localhost。另有合成整合測試驗證網站 Cookie adapter → 不可匯出的 CryptoKey → 解密 → TS 寫入的完整資料流程。

## 擴充功能真實網站驗證狀態

已在使用者登入的 Chrome 分頁觀察播放器 DOM、HLS 與字幕入口，以及 Azure TS 分段來源。

使用者已安裝 v0.1，截圖顯示兩個真實 HLS 清單解析成功、字幕儲存成功，但加密影片未通過 TS 檢查。靜態檢查公開播放器後，已在 v0.2 加入網站專用處理。

v0.2 擴充功能尚未完成真實影片下載與離線播放驗證。使用者已回報重新載入並提供新助手分頁網址；瀏覽器工具的 URL 政策同時拒絕操作 `chrome://extensions` 和 `chrome-extension://`（只允許 HTTP／HTTPS），因此無法代為操作該下載介面。這是獨立擴充功能的歷史驗證狀態；CLI v0.4.0 不需安裝或操作該擴充功能，改用上方記錄的 Chrome 原生連線授權流程。
