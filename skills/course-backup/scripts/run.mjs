#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function projectPath() {
  if (process.env.COURSE_BACKUP_HOME) return resolve(process.env.COURSE_BACKUP_HOME);
  try {
    const config = JSON.parse(await readFile(resolve(skillDir, 'local-config.json'), 'utf8'));
    if (typeof config.projectDir !== 'string' || !config.projectDir.trim()) throw new Error('invalid');
    return resolve(config.projectDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('技能設定無效，請從專案重新執行 scripts/install-skill.mjs --force。');
  }
  return resolve(skillDir, '..', '..');
}

async function main() {
  const projectDir = await projectPath();
  const entry = resolve(projectDir, 'cli', 'index.js');
  const valid = await stat(entry).then(info => info.isFile(), () => false);
  if (!valid) throw new Error('找不到課程備份 CLI；請重新安裝技能，或將 COURSE_BACKUP_HOME 設為專案資料夾。');
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal); } catch { /* Exit is handled below. */ }
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const clean = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  child.once('error', () => {
    clean();
    console.error('無法啟動課程備份 CLI，請確認 Node.js 與專案路徑。');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    clean();
    process.exitCode = code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1);
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
