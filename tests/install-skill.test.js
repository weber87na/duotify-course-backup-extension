import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill } from '../scripts/install-skill.mjs';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'course-skill-test-'));
  t.after(async () => {
    assert.equal(resolve(base), base);
    assert.equal(dirname(base), resolve(tmpdir()));
    assert.ok(basename(base).startsWith('course-skill-test-'));
    await rm(base, { recursive: true, force: true });
  });
  const projectDir = join(base, 'project with spaces');
  const source = join(projectDir, 'skills', 'course-backup');
  await mkdir(join(source, 'agents'), { recursive: true });
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(join(projectDir, 'cli'), { recursive: true });
  for (const file of ['SKILL.md', 'agents/openai.yaml', 'scripts/run.mjs']) {
    await copyFile(join(repo, 'skills', 'course-backup', file), join(source, file));
  }
  await writeFile(join(projectDir, 'cli', 'index.js'), 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
  return { base, projectDir, dest: join(base, 'installed skill') };
}

test('installer records only the project path and installed wrapper preserves caller cwd and literal arguments', async t => {
  const { base, projectDir, dest } = await fixture(t);
  assert.equal(await installSkill({ projectDir, dest }), dest);
  assert.deepEqual(JSON.parse(await readFile(join(dest, 'local-config.json'), 'utf8')), { projectDir });
  const caller = join(base, 'caller directory');
  await mkdir(caller);
  const args = ['download', 'https://example.com/watch?one=1&two=2', '--out', './backup', 'quote"value', '$(keep-literal)', '中文字'];
  const { stdout } = await exec(process.execPath, [join(dest, 'scripts', 'run.mjs'), ...args], {
    cwd: caller,
    env: { ...process.env, COURSE_BACKUP_HOME: '' },
  });
  assert.deepEqual(JSON.parse(stdout), { args, cwd: caller });
});

test('updating the same skill requires force and preserves unrelated files', async t => {
  const { projectDir, dest } = await fixture(t);
  await installSkill({ projectDir, dest });
  await writeFile(join(dest, 'notes.txt'), 'keep me');
  await assert.rejects(installSkill({ projectDir, dest }), /--force/);
  await installSkill({ projectDir, dest, force: true });
  assert.equal(await readFile(join(dest, 'notes.txt'), 'utf8'), 'keep me');
});

test('force refuses a different existing skill and preserves its contents', async t => {
  const { projectDir, dest } = await fixture(t);
  await mkdir(dest);
  const original = '---\nname: another-skill\ndescription: existing\n---\nKeep this.\n';
  await writeFile(join(dest, 'SKILL.md'), original);
  await assert.rejects(installSkill({ projectDir, dest, force: true }), /不同技能/);
  assert.equal(await readFile(join(dest, 'SKILL.md'), 'utf8'), original);
});

test('installer refuses a destination subdirectory junction or symbolic link', async t => {
  const { base, projectDir, dest } = await fixture(t);
  await mkdir(dest);
  await writeFile(join(dest, 'SKILL.md'), '---\nname: course-backup\ndescription: old\n---\n');
  const other = join(base, 'other');
  await mkdir(other);
  await symlink(other, join(dest, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill({ projectDir, dest, force: true }), /符號連結/);
  await assert.rejects(readFile(join(other, 'run.mjs')), { code: 'ENOENT' });
});

test('repository skill wrapper finds its sibling CLI without installation', async t => {
  const { projectDir } = await fixture(t);
  const { stdout } = await exec(process.execPath, [join(projectDir, 'skills', 'course-backup', 'scripts', 'run.mjs'), '--help'], {
    env: { ...process.env, COURSE_BACKUP_HOME: '' },
  });
  assert.deepEqual(JSON.parse(stdout).args, ['--help']);
});

test('wrapper honors an explicit project override and preserves child failure status', async t => {
  const { base, projectDir, dest } = await fixture(t);
  await installSkill({ projectDir, dest });
  const override = join(base, 'override');
  await mkdir(join(override, 'cli'), { recursive: true });
  await writeFile(join(override, 'cli', 'index.js'), 'process.exitCode = 7;');
  await assert.rejects(exec(process.execPath, [join(dest, 'scripts', 'run.mjs'), '--help'], {
    env: { ...process.env, COURSE_BACKUP_HOME: override },
  }), { code: 7 });
});

test('wrapper reports a moved or missing project without exposing config contents', async t => {
  const { base, projectDir, dest } = await fixture(t);
  await installSkill({ projectDir, dest });
  const secret = 'not-a-real-secret';
  await writeFile(join(dest, 'local-config.json'), `{broken ${secret}`);
  try {
    await exec(process.execPath, [join(dest, 'scripts', 'run.mjs'), '--help'], {
      env: { ...process.env, COURSE_BACKUP_HOME: '' },
    });
    assert.fail('Expected invalid configuration to fail');
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /技能設定無效/);
    assert.equal(error.stderr.includes(secret), false);
  }
  await writeFile(join(dest, 'local-config.json'), JSON.stringify({ projectDir: join(base, 'missing') }));
  await assert.rejects(exec(process.execPath, [join(dest, 'scripts', 'run.mjs'), '--help'], {
    env: { ...process.env, COURSE_BACKUP_HOME: '' },
  }), error => error.code === 1 && /找不到課程備份 CLI/.test(error.stderr));
});
