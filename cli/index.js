#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseOptions, HELP } from './options.js';
import { launchSession } from './browser.js';
import { downloadMedia } from './download.js';
import { launchExistingSession } from './existing.js';
import { navigateCourse, scanWhenReady, selectLessons, scanSummary, playbackFor } from './course.js';
import { mediaKind, formatBytes } from '../util.js';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
export const cleanMessage = value => String(value || '操作失敗。')
  .replace(/https?:\/\/[^\s<>"']+/gi, '[媒體來源]')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);

export async function run(argv, { stdout = process.stdout, stderr = process.stderr, launch = launchSession, download = downloadMedia, existing = launchExistingSession } = {}) {
  const options = parseOptions(argv);
  if (options.command === 'help') { stdout.write(HELP); return 0; }
  if (options.command === 'version') { stdout.write(`${version}\n`); return 0; }
  const log = value => stderr.write(`${cleanMessage(value)}\n`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const report = { version, completed: [], failed: [] };
  let session;
  try {
    const transfer = async (media, resolvePlayback, fetchImpl) => {
      if (controller.signal.aborted) throw new DOMException('已取消。', 'AbortError');
      media = { ...media, title: cleanMessage(media.title) };
      let lastProgress = 0;
      log(`開始：${media.title}`);
      try {
        const result = await download({ media, outputDir: options.outputDir, fetchImpl, resolvePlayback,
          signal: controller.signal, quality: options.quality, maxHeight: options.maxHeight,
          onProgress: ({ completed, total, bytes }) => {
            const now = Date.now();
            const finished = Number.isFinite(total) && completed === total;
            if (now - lastProgress < 1000 && !finished) return;
            lastProgress = now;
            log(`${completed ?? ''}${total ? ` / ${total} 分段` : ''} · 暫存 ${formatBytes(bytes)}`);
          },
        });
        report.completed.push({ title: media.title, ...result });
        log(`儲存完成：${result.path}（${formatBytes(result.bytes)}）`);
      } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') throw new DOMException('已取消。', 'AbortError');
        const reason = cleanMessage(error.message);
        report.failed.push({ title: media.title, reason }); log(`未完成：${reason}`);
      }
    };

    if (options.direct) {
      const url = new URL(options.url);
      if (url.origin === 'https://learn.duotify.com' && /^\/api\/video\/watch\/?$/.test(url.pathname)) {
        throw new Error('多奇登入媒體請使用 download 課程頁網址，讓 Chrome 取得當次播放資訊。');
      }
      const kind = mediaKind(options.url) || 'file';
      await transfer({ url: options.url, kind, title: options.title || '課程影片' });
    } else {
      if (options.browser === 'existing') {
        log('正在連接現有 Chrome，不需要擴充功能。請在 Chrome 出現的連線提示按「允許」。');
        log('首次使用請在 Chrome 手動開啟 chrome://inspect/#remote-debugging，啟用遠端偵錯。');
        session = await existing({ url: options.url, signal: controller.signal, timeoutMs: options.waitLoginMs, log });
      } else {
        log('正在開啟獨立瀏覽器。請在該視窗自行登入；不要關閉視窗，CLI 會自動等待課程。');
        session = await launch({ browser: options.browser, signal: controller.signal, log });
      }
      session.setAuthOrigin(options.url);
      await navigateCourse(session.page, options.url, controller.signal);
      const original = await scanWhenReady(session.page, options.url, { signal: controller.signal, timeoutMs: options.waitLoginMs });
      const rawSummary = scanSummary(original);
      const summary = { ...rawSummary, title: cleanMessage(rawSummary.title), lessons: rawSummary.lessons.map(lesson => ({
        ...lesson, title: cleanMessage(lesson.title), sectionId: lesson.sectionId ? cleanMessage(lesson.sectionId) : undefined,
      })) };
      if (options.command === 'scan') {
        if (options.json) stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        else {
          stdout.write(`${cleanMessage(summary.title)}\n`);
          for (const entry of summary.lessons) stdout.write(`${entry.index}. ${cleanMessage(entry.title)}${entry.sectionId ? ` [章節 ${cleanMessage(entry.sectionId)}]` : ''}\n`);
        }
        return 0;
      }
      report.lessons = summary.lessons;
      log(`課程目錄：${summary.title}`);
      for (const lesson of summary.lessons) log(`${lesson.index}. ${lesson.title}`);
      for (const lesson of selectLessons(original, options)) {
        if (controller.signal.aborted) throw new DOMException('已取消。', 'AbortError');
        log(`章節 ${lesson.index}：${lesson.title}；等待可播放的影片。`);
        if (session.page.url() !== lesson.url) await navigateCourse(session.page, lesson.url, controller.signal);
        let scan;
        try { scan = await scanWhenReady(session.page, lesson.url, { signal: controller.signal, timeoutMs: options.waitLoginMs, playable: true }); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          report.failed.push({ title: cleanMessage(lesson.title), reason: cleanMessage(error.message) }); log(`未完成：${error.message}`); continue;
        }
        const selected = scan.media.filter(media => options.subtitles || media.kind !== 'subtitle');
        for (const media of selected) {
          const item = { ...media, lessonUrl: lesson.url,
            title: `${String(lesson.index).padStart(2, '0')} ${lesson.title}${media.kind === 'subtitle' ? '（字幕）' : ''}` };
          await transfer(item, playlist => playbackFor(session.page, scan, item, playlist, controller.signal), session.fetchImpl);
        }
        if (!selected.length) report.failed.push({ title: cleanMessage(lesson.title), reason: '找不到所選類型的媒體。' });
      }
    }
    if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else stdout.write(`${report.completed.length} 項完成，${report.failed.length} 項未完成。\n`);
    return report.failed.length ? 1 : 0;
  } finally {
    await session?.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const finish = code => {
    process.exitCode = code;
    // Puppeteer's permission handshake has no cancellation API. After all of
    // our writes/cleanup finish, do not let a pending handshake keep CLI alive.
    // Normal runs exit naturally; the unref'ed guard only handles leftover I/O.
    setTimeout(() => process.exit(code), 1000).unref();
  };
  run(process.argv.slice(2)).then(finish).catch(error => {
    process.stderr.write(`${error.name === 'AbortError' ? '已取消，未完成項目不會標示成功。' : cleanMessage(error.message)}\n`);
    finish(error.name === 'AbortError' ? 130 : 1);
  });
}
