import { scanPage } from './scanner.js';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const key = `scan-${crypto.randomUUID()}`;
  const previous = await chrome.storage.session.get(null);
  const entries = Object.entries(previous).filter(([name]) => name.startsWith('scan-')).sort((a, b) => b[1].createdAt - a[1].createdAt);
  const expired = entries.filter(([, value], index) => index >= 19 || Date.now() - value.createdAt > 24 * 60 * 60 * 1000).map(([name]) => name);
  if (expired.length) await chrome.storage.session.remove(expired);
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPage });
    await chrome.storage.session.set({ [key]: { ...result.result, tabId: tab.id, createdAt: Date.now() } });
  } catch {
    await chrome.storage.session.set({ [key]: { error: '無法讀取這個分頁。請切到已登入的課程影片頁，再按一次擴充功能圖示。', createdAt: Date.now() } });
  }
  // URLs stay in session storage and never enter sync storage.
  await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html?scan=${encodeURIComponent(key)}`) });
});
