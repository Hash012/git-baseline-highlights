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
  const result = new Map();
  for (const change of parseChanges(buffer)) {
    if (change.status === 'R' || change.status === 'C') {
      result.set(change.oldPath, 'D');
      result.set(change.path, change.status);
    } else {
      result.set(change.path, change.status);
    }
  }
  return result;
}
function parseChanges(buffer) {
  const parts = buffer.toString('utf8').split('\0');
  const result = [];
  for (let i = 0; i + 1 < parts.length;) {
    const status = parts[i];
    if (!status) { i += 1; continue; }
    const code = status[0];
    if ((code === 'R' || code === 'C') && i + 2 < parts.length && parts[i + 1] && parts[i + 2]) {
      result.push({status: code, score: Number(status.slice(1)) || 0, oldPath: parts[i + 1], path: parts[i + 2]});
      i += 3;
    } else if (parts[i + 1]) {
      result.push({status: code, path: parts[i + 1]});
      i += 2;
    } else {
      i += 1;
    }
  }
  return result;
}
async function scan(root, base) {
  const commit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).toString().trim();
  const changes = parseChanges(await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', commit, '--']));
  const statuses = new Map();
  for (const change of changes) {
    if (change.status === 'R' || change.status === 'C') {
      statuses.set(change.oldPath, 'D');
      statuses.set(change.path, change.status);
    } else {
      statuses.set(change.path, change.status);
    }
  }
  const others = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0');
  for (const file of others) if (file) {
    statuses.set(file, 'A');
    changes.push({status: 'A', path: file});
  }
  return {commit, statuses, changes};
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
function parseDetailedHunks(diff) {
  const result = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    result.push(current);
    current = null;
  };
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      finish();
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      current = {
        // 零行侧的位置是插入/删除边界；非零行侧才是从 1 开始的行号。
        oldStart: Number(match[1]) - (oldCount ? 1 : 0),
        oldCount,
        newStart: Number(match[3]) - (newCount ? 1 : 0),
        newCount,
        oldLines: [], newLines: [],
      };
    } else if (current && line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
    } else if (current && line.startsWith('+')) {
      current.newLines.push(line.slice(1));
    }
  }
  finish();
  return result;
}
function isText(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length <= MAX_BYTES && !buffer.includes(0);
}
function linesOf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function emptyProjectionMarks() {
  return {added: [], modified: [], deleted: [], weakAdded: [], weakModified: [], weakDeleted: []};
}
function pushLine(list, line, limit) {
  if (line >= 0 && line < limit && list[list.length - 1] !== line) list.push(line);
}
function mapLineThroughEdits(index, edits) {
  let offset = 0;
  for (const edit of edits) {
    const end = edit.oldStart + edit.oldCount;
    if (edit.oldCount > 0 && index >= edit.oldStart && index < end) {
      return {
        lines: Array.from({length: edit.newCount}, (_, i) => edit.newStart + i),
        changed: true,
      };
    }
    if (edit.oldStart <= index) offset += edit.newCount - edit.oldCount;
    else break;
  }
  return {lines: [index + offset], changed: false};
}
async function diffBuffers(root, before, after) {
  if (!isText(before) || !isText(after)) return [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-baseline-highlights-'));
  try {
    await fs.chmod(directory, 0o700);
    const beforeFile = path.join(directory, 'before');
    const afterFile = path.join(directory, 'after');
    await Promise.all([fs.writeFile(beforeFile, before, {mode: 0o600}), fs.writeFile(afterFile, after, {mode: 0o600})]);
    const output = await git(root, ['diff', '--no-color', '--no-index', '--no-ext-diff', '--no-textconv', '--unified=0', '--inter-hunk-context=0', '--', beforeFile, afterFile], [1]);
    return parseDetailedHunks(output.toString('utf8'));
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
}
async function compareBuffers(root, baseline, current, lineCount) {
  if (!isText(baseline) || !isText(current)) return null;
  const edits = await diffBuffers(root, baseline, current);
  const result = {added: [], modified: [], deleted: []};
  for (const edit of edits) {
    if (edit.newCount > 0) {
      const target = edit.oldCount ? result.modified : result.added;
      for (let line = edit.newStart; line < edit.newStart + edit.newCount; line++) pushLine(target, line, lineCount);
    } else if (edit.oldCount > 0 && lineCount > 0) {
      pushLine(result.deleted, Math.min(Math.max(edit.newStart - 1, 0), lineCount - 1), lineCount);
    }
  }
  return result;
}
async function projectBuffers(root, start, end, target, lineCount) {
  const result = emptyProjectionMarks();
  if (!isText(target) || !isText(end) || lineCount <= 0) return result;
  const endLines = linesOf(end);
  const targetLines = linesOf(target);
  const ab = !isText(start)
    ? [{oldStart: 0, oldCount: 0, newStart: 0, newCount: endLines.length, oldLines: [], newLines: endLines}]
    : await diffBuffers(root, start, end);
  if (!ab.length) return result;
  const bc = await diffBuffers(root, end, target);
  const ac = !isText(start)
    ? [{oldStart: 0, oldCount: 0, newStart: 0, newCount: targetLines.length, oldLines: [], newLines: targetLines}]
    : await diffBuffers(root, start, target);
  const changedTargetLines = new Set();
  for (const edit of ac) {
    for (let line = edit.newStart; line < edit.newStart + edit.newCount; line++) changedTargetLines.add(line);
  }
  const markBLines = (edit, kind) => {
    const weakKind = `weak${kind[0].toUpperCase()}${kind.slice(1)}`;
    for (let index = edit.newStart; index < edit.newStart + edit.newCount; index++) {
      const mapped = mapLineThroughEdits(index, bc);
      for (const line of mapped.lines) {
        // B→C 替换块可能包含已恢复到 A 的行，只有仍偏离 A 的行保留弱标记。
        if (!mapped.changed || changedTargetLines.has(line)) pushLine(mapped.changed ? result[weakKind] : result[kind], line, lineCount);
      }
    }
  };
  for (const edit of ab) {
    if (edit.newCount > 0) markBLines(edit, edit.oldCount ? 'modified' : 'added');
    else if (edit.oldCount > 0) {
      const relevant = ac.filter(candidate => {
        const left = Math.max(edit.oldStart, candidate.oldStart);
        const right = Math.min(edit.oldStart + edit.oldCount, candidate.oldStart + candidate.oldCount);
        return right > left;
      });
      const deletion = relevant.find(candidate => candidate.newCount === 0);
      if (deletion) pushLine(result.deleted, Math.min(Math.max(deletion.newStart - 1, 0), lineCount - 1), lineCount);
      else for (const candidate of relevant) {
        for (let line = candidate.newStart; line < candidate.newStart + candidate.newCount; line++) pushLine(result.weakDeleted, line, lineCount);
      }
    }
  }
  return result;
}
async function mapProjectedMarks(root, target, current, marks, lineCount) {
  const result = emptyProjectionMarks();
  if (!marks || !isText(target) || !isText(current) || lineCount <= 0) return result;
  const edits = await diffBuffers(root, target, current);
  for (const [kind, lines] of Object.entries(marks)) {
    for (const index of lines) {
      const mapped = mapLineThroughEdits(index, edits);
      for (const line of mapped.lines) pushLine(result[kind], line, lineCount);
    }
  }
  return result;
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
async function resolveBaseline(root, reference, mode = 'direct') {
  const commit = await resolveCommit(root, reference);
  if (mode !== 'mergeBase') return commit;
  return (await git(root, ['merge-base', commit, 'HEAD'])).toString().trim();
}
async function isAncestor(root, older, newer) {
  const left = await resolveCommit(root, older);
  const right = await resolveCommit(root, newer);
  return (await git(root, ['merge-base', left, right])).toString().trim() === left;
}
async function scanBetween(root, start, end) {
  const from = await resolveCommit(root, start);
  const to = await resolveCommit(root, end);
  const changes = parseChanges(await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', from, to, '--']));
  const statuses = new Map();
  for (const change of changes) {
    if (change.status === 'R' || change.status === 'C') {
      statuses.set(change.oldPath, 'D');
      statuses.set(change.path, change.status);
    } else statuses.set(change.path, change.status);
  }
  return {start: from, end: to, commit: to, statuses, changes};
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
async function discoverAll(directories, depth = 3) {
  const roots = Array.isArray(directories) ? directories : [directories];
  const queue = roots.filter(Boolean).map(directory => ({directory: path.resolve(directory), level: 0}));
  const seenDirectories = new Set();
  const repositories = new Map();
  while (queue.length) {
    const current = queue.shift();
    if (seenDirectories.has(current.directory) || current.level > depth) continue;
    seenDirectories.add(current.directory);
    let gitMarker = current.level === 0;
    if (!gitMarker) {
      try { await fs.lstat(path.join(current.directory, '.git')); gitMarker = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (gitMarker) {
      const repository = await discover(current.directory);
      if (repository) repositories.set(repository.root, repository);
    }
    if (current.level === depth) continue;
    let entries;
    try { entries = await fs.readdir(current.directory, {withFileTypes: true}); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.git' || entry.name === 'node_modules') continue;
      queue.push({directory: path.join(current.directory, entry.name), level: current.level + 1});
    }
  }
  return [...repositories.values()];
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
module.exports = {MAX_BYTES, git, relativeInside, parseStatuses, parseChanges, scan, scanBetween, parseHunks, parseDetailedHunks, isText, compareBuffers, projectBuffers, mapProjectedMarks, readBaseline, resolveCommit, resolveBaseline, isAncestor, discover, discoverAll, relativeFile};
