import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

export const HELP = `課程備份助手 CLI

用法：
  course-backup scan URL [--json]
  course-backup download URL --out DIR [--all | --chapters 1,3]
  course-backup download --media URL --out DIR [--title NAME]

選項：
  --out DIR             輸出資料夾，預設 ./downloads
  --all                 依目錄順序下載整門課（預設只下載目前章節）
  --chapters 1,3        選擇 scan 列出的章節編號（從 1 開始）
  --quality best|worst  選擇 HLS 畫質，預設 best
  --max-height NUMBER  選擇不超過此高度的畫質
  --no-subtitles        不下載字幕
  --browser NAME       existing（預設）、chrome、msedge 或 chromium
  --wait-login SECONDS 等待 Chrome 連線／登入，預設 600 秒
  --json               stdout 只輸出結果 JSON；進度在 stderr
  --media URL          直接媒體網址，不開瀏覽器、不帶登入 Cookie
  --title NAME         直接媒體的檔名
  --help, -h           顯示說明
  --version            顯示版本

預設連接已登入的 Chrome 144+，不需安裝擴充功能。
首次使用請手動開啟 chrome://inspect/#remote-debugging，啟用遠端偵錯。
Chrome 提示時按「允許」；CLI 沿用登入狀態，結束時保留原有分頁。
Cookie 與金鑰只供當次記憶體使用，不保存或匯出。
chrome/msedge/chromium 會另開獨立視窗；不適用 Google 登入。Ctrl+C 取消。
HLS 輸出 .ts 或分段式 .mp4；不重新編碼、不支援 DRM／直播。
下載完成前只寫暫存檔；失敗不會產生成功的正式影片。
`;

export function webUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('請提供完整的 HTTP(S) 網址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只接受沒有內嵌帳密的 HTTP(S) 網址。');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('請使用 HTTPS；HTTP 只供 localhost 測試。');
  }
  return url.href;
}

export function parseOptions(argv, cwd = process.cwd()) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
      out: { type: 'string' }, all: { type: 'boolean' }, chapters: { type: 'string' },
      quality: { type: 'string', default: 'best' }, 'max-height': { type: 'string' },
      'no-subtitles': { type: 'boolean' }, browser: { type: 'string', default: 'existing' },
      'wait-login': { type: 'string', default: '600' }, json: { type: 'boolean' },
      media: { type: 'string' }, title: { type: 'string' },
    } }));
  } catch { throw new Error('命令或選項無效，請執行 --help 查看用法。'); }
  if (values.help || !argv.length) return { command: 'help' };
  if (values.version) return { command: 'version' };
  const [command, input, ...extra] = positionals;
  if (!['scan', 'download'].includes(command) || extra.length) throw new Error('請使用 scan 或 download，並提供一個網址。');
  if (values.media && (command !== 'download' || input || values.all || values.chapters || values['no-subtitles'])) {
    throw new Error('--media 僅適用直接下載，不能同時指定課程網址、章節或字幕選項。');
  }
  if (!input && !values.media) throw new Error('缺少課程或媒體網址。');
  if (values.all && values.chapters) throw new Error('--all 與 --chapters 不能同時使用。');
  if (!['best', 'worst'].includes(values.quality)) throw new Error('--quality 必須為 best 或 worst。');
  if (!['existing', 'chrome', 'msedge', 'chromium'].includes(values.browser)) throw new Error('--browser 必須為 existing、chrome、msedge 或 chromium。');
  const wait = Number(values['wait-login']);
  if (!/^\d+$/.test(values['wait-login']) || wait < 1 || wait > 3600) throw new Error('--wait-login 必須為 1 至 3600 秒。');
  let maxHeight;
  if (values['max-height'] !== undefined) {
    maxHeight = Number(values['max-height']);
    if (!/^\d+$/.test(values['max-height']) || maxHeight < 1 || maxHeight > 16384) throw new Error('--max-height 必須為 1 至 16384。');
  }
  let chapters;
  if (values.chapters !== undefined) {
    if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(values.chapters)) throw new Error('--chapters 請使用正整數編號，例如 1,3。');
    chapters = [...new Set(values.chapters.split(',').map(Number))];
    if (chapters.some(n => !Number.isSafeInteger(n))) throw new Error('章節編號過大。');
  }
  if (command === 'scan' && (values.all || chapters || values['no-subtitles'] || values.title)) throw new Error('scan 不接受下載章節或檔名選項。');
  return { command, url: webUrl(input || values.media), direct: !!values.media,
    outputDir: resolve(cwd, values.out || 'downloads'), all: !!values.all, chapters,
    quality: values.quality, maxHeight, subtitles: !values['no-subtitles'],
    browser: values.browser, waitLoginMs: wait * 1000, json: !!values.json, title: values.title,
  };
}
