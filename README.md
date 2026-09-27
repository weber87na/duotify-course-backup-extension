# 課程備份助手

提供 Chrome Manifest V3 擴充功能、Node.js CLI 與 Codex Skill，從目前可播放的課程頁找出影片與字幕，再儲存到本機。多奇課程支援從章節目錄批次分析；其他網站可先開啟個別影片再掃描。

v0.2.0 加入一般 HLS AES-128 與多奇播放器的記憶體解密支援，處理原先「回應不是支援的 MPEG-TS 影片區段」問題。擴充功能的驗證狀態與診斷見 `DIAGNOSIS.md`、`TESTING.md`。

CLI v0.4.0 預設連接你已登入的正常 Chrome，不需要安裝擴充功能。Chrome 擴充功能 v0.2.0 仍可獨立使用；兩者共用 HLS 解析、解密與資料驗證邏輯。

已於 2026-09-28 以 Chrome 153 的既有登入完成真實課程第一章及字幕下載：1531 個分段、719,101,128 bytes，影片為 2560×1440 H.264／AAC、約 3 小時 56 分；開頭、中間、結尾的影音抽樣解碼成功。這是 CLI 的實測結果，不代表所有課程或擴充功能流程都已驗證。

## Node.js CLI

需要 Node.js 22.12 以上及 Chrome 144 以上。在專案資料夾安裝依賴：

```powershell
npm install
node cli/index.js --help
```

亦可使用 `pnpm install --frozen-lockfile`，依儲存庫的 `pnpm-lock.yaml` 安裝。

第一次使用預設的 `--browser existing` 模式：

1. 在你平常使用的 Chrome 登入多奇，確認已購買的課程可以播放。
2. 自行開啟 `chrome://inspect/#remote-debugging`，啟用遠端偵錯。這是 Chrome 內建的 auto-connect 設定，只需設定一次；不需啟動旗標或擴充功能。
3. 執行下面的 CLI 命令；Chrome 出現本次連線的授權提示時，按「允許」。CLI 會在現有 Chrome 工作階段建立自己的課程分頁，沿用目前的網站登入狀態。

設定頁與 Chrome 授權提示需要由你操作，詳見 [Chrome 官方 auto-connect 設定](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)。CLI 使用 [Puppeteer ConnectOptions 的 `channel`](https://pptr.dev/api/puppeteer.connectoptions) 連接目前執行中的 Chrome；該 API 仍標示為實驗性功能。

下載目前章節到指定資料夾：

```powershell
node cli/index.js download "https://learn.duotify.com/video/watch?slug=claude-code&sectionId=280" --out "D:\claude"
```

課程命令預設使用 `--browser existing`，目前只支援 `https://learn.duotify.com`。已在正常 Chrome 登入 Google／多奇時，不必在自動化瀏覽器重做登入。`--wait-login 900` 可調整連線授權與課程等待時間，預設 600 秒。完成或 `Ctrl+C` 取消時，只關閉 CLI 建立的課程分頁並中斷連線；你原有的 Chrome 視窗和其他分頁會保留。

常用指令：

```powershell
# 只列出目錄（JSON 不包含媒體網址）
node cli/index.js scan "https://learn.duotify.com/courses/claude-code" --json

# 依目錄編號選取章節
node cli/index.js download "https://learn.duotify.com/courses/claude-code" --chapters 1,2 --out "D:\claude"

# 下載這門課所有目錄章節，優先使用不超過 1080p 的畫質
node cli/index.js download "https://learn.duotify.com/courses/claude-code" --all --max-height 1080 --out "D:\claude"

# 直接下載已授權的 HLS／影片網址；此模式不帶登入資訊
node cli/index.js download --media "https://example.com/video.m3u8" --title "課程影片" --out "D:\videos"
```

已知道要下載的章節時，直接用 `download`，它也會列出目錄；不必先跑 `scan` 多授權一次連線。`--quality worst` 選較低畫質，`--no-subtitles` 略過字幕，`--json` 將結果輸出到 stdout、進度留在 stderr。結束碼 `0` 表示所選項目成功，`1` 表示失敗，`130` 表示取消。

CLI 每個章節都重新開啟對應播放頁並取得該章節的解密資訊，避免假設整門課共用金鑰。existing 模式只讀取多奇網站所需的 Cookie；Cookie 與解密資訊只供當次 CLI 記憶體使用，不保存、不輸出記錄、不傳給第三方。登入 Cookie 只送往多奇同一 origin，跨來源媒體請求不帶該 Cookie，重導向逐步重新檢查。CLI 不複製 Chrome profile、不讀取儲存的密碼，也不提供匯出 Cookie／金鑰的選項。

若你明確需要獨立瀏覽器，可加 `--browser chrome`、`--browser msedge` 或 `--browser chromium`。這些模式開啟全新、非持久的工作階段，每次需要登入；Google 可能拒絕自動化瀏覽器登入，因此多奇課程優先使用 existing 模式。Chromium 首次使用前需執行 `npx playwright install chromium`。獨立模式的隔離方式見 [Playwright BrowserContext 說明](https://playwright.dev/docs/api/class-browser#browser-new-context)。`--media` 直接媒體模式維持不啟動瀏覽器、不攜帶 Cookie。

CLI 在收到有效資料後才建立隨機 `.part` 暫存檔，全部成功後才以正式檔名發布；既有檔案不覆寫，同名自動加 `(1)`。取消或一般失敗會清理該次暫存檔；強制關閉程序或斷電可能留下 `.part`，不可視為完整影片。輸出資料夾需支援硬連結，例如本機 NTFS、APFS、ext4；FAT／exFAT 或部分網路磁碟不適用，請先下載到本機支援的磁碟。CLI 不提供斷點續傳。

也可執行 `npm link`，之後使用 `course-backup ...` 命令；不需要發布 npm 套件。

## Codex Skill

技能來源在 `skills/course-backup/`。安裝到自己的 Codex：

```powershell
node scripts/install-skill.mjs
```

預設目的地為 `$CODEX_HOME/skills/course-backup`；未設定時使用 `~/.codex/skills/course-backup`。技能只保存本機專案路徑，不複製登入資訊。更新同名技能或搬移專案後，可重新執行並加 `--force`；安裝器不覆寫不同名稱的技能。

在後續對話可使用：

```text
使用 $course-backup，將這門課第 1 章下載到 D:\claude：<課程網址>
```

Skill 透過 Node.js 呼叫同一套 CLI，預設沿用正常 Chrome 的登入狀態。首次需自行啟用 Chrome auto-connect，連線時接受 Chrome 提示；不需要安裝 Chrome 擴充功能，也不會要求貼密碼或 Cookie。

## 獨立 Chrome 擴充功能（選用）

以下是原有擴充功能的使用方式，使用 CLI／Skill 不需要安裝它。

1. 使用桌面版 Chrome 114 或更新版本。
2. 在網址列輸入 `chrome://extensions`。
3. 開啟右上角「開發人員模式」。
4. 按「載入未封裝項目」，選擇整個資料夾：

   ```text
   D:\will\course-backup-extension
   ```

5. 確認出現「課程備份助手」。可在工具列的拼圖選單將它釘選。

這是可直接載入的原始碼，不需要執行 npm、建置程式或安裝 ffmpeg。更新程式後，回到擴充功能頁按該項目的重新載入按鈕，並重新開啟備份助手。安裝方式依照 [Chrome 官方未封裝擴充功能說明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)。

## 擴充功能下載課程

1. 在**安裝此外掛的 Chrome** 登入[課程網站](https://learn.duotify.com/courses/claude-code)，開啟已購買且能播放的影片。Codex 內建瀏覽器的登入狀態不一定與 Chrome 共用，請在 Chrome 確認可以播放。
2. 在課程影片頁按工具列的「課程備份助手」圖示，開啟管理分頁。
3. 在「選擇內容」勾選章節，按「分析已選內容」。第一次先選一章即可。
4. 如果出現媒體來源清單，確認網域後按「允許列出的來源並繼續」。影片清單、畫質清單、影片片段可能分屬不同網域，因此後續可能再出現新的來源要求。
5. 在「確認影片與畫質」勾選要儲存的影片與字幕，並選擇提供的畫質。
6. 按「選擇儲存資料夾」，選擇有足夠空間的本機資料夾，接受 Chrome 的資料夾寫入提示。HLS 影片及字幕會寫到這個資料夾；直接影片檔交由 Chrome 下載管理員處理，其位置依 Chrome 下載設定決定。
7. 按「下載已選影片與字幕」。多奇課程需保留原先已登入、可播放的課程分頁；下載時才在記憶體中取得該頁播放解密資訊。下載 HLS 時保持管理分頁開啟，避免重新整理或讓電腦休眠。
8. 下載完成後，離線播放檔案，檢查開頭、中間、結尾與聲音。字幕是獨立檔案，可在播放器中載入。

「重新掃描」適合頁面開始播放後才產生媒體網址的情況。若已切換課程，請回到新課程頁再次按擴充功能圖示，建立該頁的掃描結果。

## 檔案格式

| 來源 | 儲存方式 |
| --- | --- |
| 直接 MP4、WebM 等影片 | 由 Chrome 下載管理員下載來源檔案 |
| 支援的 HLS / MPEG-TS | 未加密或支援的 AES-128 解密後，依播放清單順序寫入 `.ts` 檔案 |
| 支援的 HLS / fragmented MP4 | 寫入初始化片段與媒體片段，輸出分段式 `.mp4`；支援一般 AES-128 |
| VTT 等字幕 | 儲存為獨立字幕檔案，不內嵌到影片 |

`.ts` 是實際的 MPEG-TS 容器，不能靠改副檔名轉成 MP4。擴充功能本身不進行影音重新編碼。分段式 MP4 與 TS 的播放支援也取決於播放器。

如果電腦已有 ffmpeg，下載後可選擇在本機重新封裝 TS：

```powershell
ffmpeg -i "input.ts" -c copy "output.mp4"
```

這個步驟完全處理本機檔案；`-c copy` 保留原有音訊與視訊編碼，不重新壓縮。能否寫入 MP4 仍取決於來源編碼與檔案完整性，詳見 [ffmpeg 官方 streamcopy 說明](https://ffmpeg.org/ffmpeg.html#Streamcopy)。安裝或使用 ffmpeg 不是使用此外掛的必要步驟。

## 支援範圍與限制

- 多奇網站的批次功能依賴目前的章節連結、播放器 HTML 與公開播放器的解密流程。網站改版後可能需要更新。若其他章節使用不同的播放解密資訊，請在該章節確認可播放後重新掃描，再單獨下載。
- 其他網站目前是通用掃描：影片標籤、字幕標籤、可辨識的下載連結與已曝光的串流清單。無法保證辨識所有平台，也不會自動批次走訪每個網站的課程。
- HLS 支援未加密隨選影片與一般 `METHOD=AES-128` / identity 加密，包括明確 IV、依序號產生 IV、金鑰輪替及有明確 IV 的初始化區段。加密 byte-range、SAMPLE-AES、DRM、直播、獨立音軌、串流不連續標記等不支援情況會顯示錯誤，停止該項下載。
- DASH 清單可辨識，但不提供 DASH 下載。
- 只有 `blob:` 網址而找不到實際來源時，無法直接下載該網址。播放器在跨網域 iframe 內時，可能需要開啟播放器所在頁面再掃描。
- 下載期間會對可重試的網路錯誤重試；**HLS 不支援關閉分頁、重新整理或重啟 Chrome 後接續下載**。中斷後請重新開始，未完成檔案不可視為完整備份。
- 來源網址可能過期。出現 401、403、登入頁或無法取得媒體時，先回到課程頁確認仍能播放，再重新掃描、分析。外掛獲得網域權限不代表伺服器一定允許該次請求。
- 此外掛不會延長網站的課程存取期限；所有下載仍取決於網站當下提供的媒體與登入狀態。

## 擴充功能權限與本機資料

| 權限 | 用途 |
| --- | --- |
| `activeTab` | 按下圖示後，暫時讀取目前頁面的影片與章節資訊 |
| `scripting` | 在該頁執行掃描函式；多奇下載時取得已登入播放器的解密資訊 |
| `downloads` | 將直接影片檔交給 Chrome 下載管理員 |
| `storage` | 在本次瀏覽器工作階段暫存掃描結果，讓管理分頁讀取 |
| `https://learn.duotify.com/*` | 固定允許讀取多奇網站的課程頁與媒體入口 |
| 個別媒體來源網域 | 分析或下載時，按需要由使用者授權 |

`optional_host_permissions` 宣告 HTTP / HTTPS 網址範圍，供執行時要求實際發現的來源。程式逐一列出所需來源並在按鈕操作後申請，不會自動要求所有網站的存取權限。這是 [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) 支援的模式；`activeTab` 的暫時存取行為見 [Chrome 官方說明](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)。

程式不讀取密碼或網站 localStorage，也沒有資料上傳服務或遙測端點。多奇專用支援經使用者授權，只在確定原分頁為同課程、可播放的 HTTPS 影片頁後，讀取該播放器所需的非 HttpOnly Cookie 資料，在記憶體內產生 AES-CBC 解密金鑰；不保存或匯出 Cookie／金鑰，不傳送給第三方，不修改 Cookie。金鑰以不可匯出的 CryptoKey 用於單次傳輸，原始位元組匯入後清除；JavaScript 記憶體由瀏覽器管理，無法保證每個暫時字串被立即覆寫。

一般 AES-128 清單從清單指定的已授權來源取得金鑰，僅快取於單次傳輸的記憶體。請求可能由瀏覽器依現有登入狀態攜帶必要認證資訊。掃描結果包含當下的媒體網址，可能帶有效期限或簽章；它們保留在 `chrome.storage.session`，不含 Cookie／金鑰，也不寫入 Chrome 同步儲存空間。不要公開貼出完整媒體網址。Chrome API 的用途可參考 [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads) 與 [storage](https://developer.chrome.com/docs/extensions/reference/api/storage)。

## 本機測試

開發者可在已有 Node.js 的環境執行：

```powershell
Set-Location 'D:\will\course-backup-extension'
node --test tests/*.test.js
```

這些測試驗證本機程式與測試資料，不能取代登入網站後的實際下載與離線播放檢查。

本機瀏覽器整合測試可執行 `node tests/preview-server.mjs`，再開啟終端機顯示的網址。測試頁使用假的 Chrome API、合成 TS 分段與記憶體檔案，不會連線到課程網站，也不會寫入真實影片檔。
