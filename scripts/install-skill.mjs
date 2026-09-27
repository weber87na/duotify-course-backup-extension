#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ownedFiles = ['SKILL.md', 'agents/openai.yaml', 'scripts/run.mjs'];

async function info(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkPath(path, expectedDirectory) {
  const found = await info(path);
  if (!found) return;
  if (found.isSymbolicLink() || (expectedDirectory ? !found.isDirectory() : !found.isFile())) {
    throw new Error('技能目的地含有符號連結或不相容的檔案，未進行安裝。');
  }
}

export async function installSkill({ dest, force = false, projectDir = repoDir } = {}) {
  const project = resolve(projectDir);
  const source = join(project, 'skills', 'course-backup');
  const target = resolve(dest ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'course-backup'));
  if (target === source) throw new Error('安裝目的地不可與儲存庫的技能來源相同。');
  // Validate all inputs and destination entries before any write.
  for (const path of [...ownedFiles.map(file => join(source, file)), join(project, 'cli', 'index.js')]) {
    const sourceInfo = await info(path);
    if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) throw new Error('專案缺少完整技能或 CLI 檔案，未進行安裝。');
  }
  await checkPath(target, true);
  const existing = await info(target);
  if (existing && (await readdir(target)).length) {
    await checkPath(join(target, 'SKILL.md'), false);
    const previous = await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => '');
    const frontmatter = previous.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
    if (!/^name:\s*['"]?course-backup['"]?\s*$/m.test(frontmatter)) {
      throw new Error('目的地已包含其他內容或不同技能，不會覆寫；請使用 --dest 指定新的技能資料夾。');
    }
    if (!force) throw new Error('course-backup 技能已存在；更新此技能請加上 --force。');
  }
  for (const subdir of ['agents', 'scripts']) await checkPath(join(target, subdir), true);
  for (const file of [...ownedFiles, 'local-config.json']) await checkPath(join(target, file), false);

  await mkdir(join(target, 'agents'), { recursive: true });
  await mkdir(join(target, 'scripts'), { recursive: true });
  for (const file of ownedFiles) await copyFile(join(source, file), join(target, file));
  await writeFile(join(target, 'local-config.json'), `${JSON.stringify({ projectDir: project }, null, 2)}\n`, 'utf8');
  return target;
}

async function main(args) {
  let dest;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/install-skill.mjs [--dest SKILL_DIR] [--force]\n預設安裝到 $CODEX_HOME/skills/course-backup（未設定時使用 ~/.codex）。\n--dest 指定技能資料夾本身；--force 更新同名技能，保留其他檔案。');
      return;
    }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--dest' && args[index + 1] && !args[index + 1].startsWith('--')) {
      if (dest) throw new Error('--dest 只能指定一次。');
      dest = args[++index];
      continue;
    }
    throw new Error('不支援的參數；請執行 node scripts/install-skill.mjs --help。');
  }
  const target = await installSkill({ dest, force });
  console.log(`已安裝 course-backup 技能：${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
