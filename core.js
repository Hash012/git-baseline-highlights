/** 固定提交装饰的只读核心：安全执行 Git、解析文件状态与行差异，并清理临时文件。 */
'use strict';
const {execFile} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const MAX_BYTES = 2 * 1024 * 1024;
function git(root, args, allowedExit = []) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
      timeout: 15000, windowsHide: true,
      env: {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'},
    }, (error, stdout) => {
      if (error && !allowedExit.includes(error.code)) {
        const safe = new Error(`Read-only Git operation failed (${error.code || 'execution failed'})`);
        safe.code = error.code;
        reject(safe);
      } else resolve(stdout);
    });
  });
}
function relativeInside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/') : null;
}
function parseStatuses(buffer) {
  const parts = buffer.toString('utf8').split('\0');
  const result = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] && parts[i + 1]) result.set(parts[i + 1], parts[i][0]);
  }
  return result;
}
async function scan(root, base) {
  const commit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).toString().trim();
  const statuses = parseStatuses(await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--no-renames', commit, '--']));
  const others = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0');
  for (const file of others) if (file) statuses.set(file, 'A');
  return {commit, statuses};
}
function parseHunks(diff, lineCount) {
  const result = {added: [], modified: [], deleted: []};
  const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match;
  while ((match = pattern.exec(diff))) {
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const start = Number(match[3]);
    const count = match[4] === undefined ? 1 : Number(match[4]);
    if (count > 0) {
      const target = oldCount ? result.modified : result.added;
      for (let line = start - 1; line < start - 1 + count && line < lineCount; line++) if (line >= 0) target.push(line);
    } else if (oldCount > 0 && lineCount > 0) {
      result.deleted.push(Math.min(Math.max(start - 1, 0), lineCount - 1));
    }
  }
  return result;
}
function isText(buffer) {
  return buffer.length <= MAX_BYTES && !buffer.includes(0);
}
async function compareBuffers(root, baseline, current, lineCount) {
  if (!isText(baseline) || !isText(current)) return null;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-baseline-highlights-'));
  try {
    await fs.chmod(directory, 0o700);
    const before = path.join(directory, 'before');
    const after = path.join(directory, 'after');
    await Promise.all([fs.writeFile(before, baseline, {mode: 0o600}), fs.writeFile(after, current, {mode: 0o600})]);
    const output = await git(root, ['diff', '--no-color', '--no-index', '--no-ext-diff', '--no-textconv', '--unified=0', '--', before, after], [1]);
    return parseHunks(output.toString('utf8'), lineCount);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
}
async function readBaseline(root, commit, file) {
  // 先检查字面路径：含通配符的不存在路径可能被 Git 当作零匹配版本模式处理。
  const tracked = (await git(root, ['ls-tree', '-z', '--name-only', commit, '--', file])).toString('utf8').split('\0');
  if (!tracked.includes(file)) return null;
  return git(root, ['show', '--no-color', '--no-ext-diff', '--no-textconv', `${commit}:${file}`, '--']);
}
async function resolveCommit(root, reference) {
  return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`])).toString().trim();
}
async function discover(directory) {
  try {
    const root = await fs.realpath(path.resolve((await git(directory, ['rev-parse', '--show-toplevel'])).toString().replace(/\r?\n$/, '')));
    const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).toString().replace(/\r?\n$/, '');
    const common = (await git(root, ['rev-parse', '--git-common-dir'])).toString().replace(/\r?\n$/, '');
    return {root, gitDir: path.resolve(gitDir), commonDir: path.resolve(root, common)};
  } catch (error) {
    if (error.code === 128 || error.code === 'ENOENT') return null;
    throw error;
  }
}
async function relativeFile(root, file) {
  const direct = relativeInside(root, file);
  if (direct) return direct;
  try {
    return relativeInside(root, await fs.realpath(file));
  } catch (error) {
    if (error.code !== 'ENOENT') return null;
    try { return relativeInside(root, path.join(await fs.realpath(path.dirname(file)), path.basename(file))); }
    catch { return null; }
  }
}
module.exports = {MAX_BYTES, git, relativeInside, parseStatuses, scan, parseHunks, isText, compareBuffers, readBaseline, resolveCommit, discover, relativeFile};
