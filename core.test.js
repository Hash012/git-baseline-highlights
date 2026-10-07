/** 核心回归测试：覆盖差异语义、异常与特殊路径，并检查只读扫描不改变 Git 索引。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const core = require('./core');
function run(root, args) { return execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim(); }
test('空文件边界、纯新增、替换与删除位置', () => {
  assert.deepEqual(core.parseHunks('@@ -0,0 +1,2 @@\n+a\n+b', 2), {added:[0,1],modified:[],deleted:[]});
  assert.deepEqual(core.parseHunks('@@ -2 +2,2 @@\n-x\n+y\n+z', 4), {added:[],modified:[1,2],deleted:[]});
  assert.deepEqual(core.parseHunks('@@ -1,2 +0,0 @@\n-x\n-y', 1), {added:[],modified:[],deleted:[0]});
  assert.deepEqual(core.parseHunks('@@ -1 +0,0 @@', 0), {added:[],modified:[],deleted:[]});
  assert.deepEqual(core.parseDetailedHunks('--- before\n+++ after\n@@ -2 +2 @@\n-old\n+new\n'), [{oldStart:1,oldCount:1,newStart:1,newCount:1,oldLines:['old'],newLines:['new']}]);
});
test('NUL文件状态保留空格、中文与换行路径', () => {
  assert.deepEqual([...core.parseStatuses(Buffer.from('A\0中文 空格\n.txt\0M\0[x].py\0D\0gone\0'))], [['中文 空格\n.txt','A'], ['[x].py','M'], ['gone','D']]);
  const changes = Buffer.from('R087\0旧.txt\0新.txt\0D\0删除.txt\0M\0修改.txt\0');
  assert.deepEqual(core.parseChanges(changes), [
    {status:'R', score:87, oldPath:'旧.txt', path:'新.txt'},
    {status:'D', path:'删除.txt'},
    {status:'M', path:'修改.txt'},
  ]);
  assert.deepEqual([...core.parseStatuses(changes)], [['旧.txt','D'], ['新.txt','R'], ['删除.txt','D'], ['修改.txt','M']]);
  assert.equal(core.relativeInside('/tmp/repo', '/tmp/repository/a'), null);
  assert.equal(core.relativeInside('/tmp/repo', '/tmp/repo/../secret'), null);
  assert.equal(core.relativeInside('/tmp/repo', '/tmp/repo/中文.py'), '中文.py');
  assert.equal(core.isText(Buffer.from([1,0,2])), false);
  assert.equal(core.isText(Buffer.alloc(core.MAX_BYTES + 1, 65)), false);
});
test('真实Git：只读快照、特殊文件名、未跟踪与临时diff清理', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-test-'));
  try {
    run(root, ['init', '-q']);
    run(root, ['config', 'user.name', '测试']); run(root, ['config','user.email','test@example.invalid']);
    const name = process.platform === 'win32' ? '中文 [x].txt' : '中文 [x]*?.txt';
    await fs.writeFile(path.join(root,name), 'a\nb\nc\n');
    await fs.writeFile(path.join(root, 'gone'), 'deleted\n');
    run(root, ['add', '.']); run(root, ['commit','-qm','基线']);
    const base = run(root, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(root,name), 'a\nchanged\nc\ninsert\n');
    await fs.rm(path.join(root,'gone'));
    await fs.writeFile(path.join(root,'新 文件.txt'),'new\n');
    // 强制彩色配置验证核心仍获取可解析的无色输出。
    run(root,['config','color.ui','always']);
    const indexBefore = await fs.readFile(path.join(root,'.git/index'));
    const state = await core.scan(root, base);
    assert.equal(state.commit, base);
    assert.equal(state.statuses.get(name),'M');
    assert.equal(state.statuses.get('gone'),'D');
    assert.equal(state.statuses.get('新 文件.txt'),'A');
    const baseline = await core.readBaseline(root, base, name);
    assert.equal(baseline.toString(),'a\nb\nc\n');
    assert.equal(await core.readBaseline(root, base, process.platform === 'win32' ? 'missing[x].txt' : 'missing[x]*?.txt'),null);
    const marks = await core.compareBuffers(root, baseline, Buffer.from('a\nchanged\nc\ninsert\n'),5);
    assert.deepEqual(marks,{added:[3],modified:[1],deleted:[]});
    assert.deepEqual(await fs.readFile(path.join(root,'.git/index')),indexBefore);
    assert.equal(run(root,['rev-parse','HEAD']),base);
    await assert.rejects(core.scan(root,'--not-a-commit'), /Read-only Git operation failed/);
    assert.equal(await core.compareBuffers(root,Buffer.from([0]),Buffer.from('a'),1),null);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('三基线投影：保留的变更强标亮，后续演进的变更弱标亮', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-projection-'));
  try {
    run(root, ['init', '-q']);
    run(root, ['config', 'user.name', '测试']); run(root, ['config', 'user.email', 'test@example.invalid']);
    const file = path.join(root, 'value.txt');
    await fs.writeFile(file, 'one\nvalue = 1\nthree\n');
    run(root, ['add', '.']); run(root, ['commit', '-qm', 'A']);
    const a = run(root, ['rev-parse', 'HEAD']);
    await fs.writeFile(file, 'one\nvalue = 2\nthree\nadded by B\n');
    run(root, ['add', '.']); run(root, ['commit', '-qm', 'B']);
    const b = run(root, ['rev-parse', 'HEAD']);
    await fs.writeFile(file, 'one\nvalue = 3\nthree\nadded by B\n');
    run(root, ['add', '.']); run(root, ['commit', '-qm', 'C']);
    const c = run(root, ['rev-parse', 'HEAD']);
    const marks = await core.projectBuffers(root, await core.readBaseline(root, a, 'value.txt'), await core.readBaseline(root, b, 'value.txt'), await core.readBaseline(root, c, 'value.txt'), 4);
    assert.deepEqual(marks.modified, []);
    assert.deepEqual(marks.added, [3]);
    assert.deepEqual(marks.weakModified, [1]);
    assert.deepEqual(marks.weakAdded, []);
    assert.equal(await core.isAncestor(root, a, b), true);
    assert.equal(await core.isAncestor(root, b, c), true);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test('仓库子目录与worktree探测；分支解析得到固定提交', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-baseline-worktree-'));
  const repository = path.join(directory, 'main repository');
  const worktree = path.join(directory, '工作 tree');
  await fs.mkdir(repository);
  try {
    run(repository, ['init', '-q']);
    run(repository, ['config', 'user.name', 'test']); run(repository, ['config', 'user.email', 'test@example.invalid']);
    await fs.writeFile(path.join(repository,'file'),'first');
    run(repository,['add','.']); run(repository,['commit','-qm','first']);
    const selected = await core.resolveCommit(repository,'HEAD');
    await fs.mkdir(path.join(repository,'nested'));
    const discovered = await core.discover(path.join(repository,'nested'));
    assert.equal(discovered.root,await fs.realpath(repository));
    run(repository,['worktree','add','-qb','linked',worktree]);
    const linked = await core.discover(worktree);
    assert.equal(linked.root,await fs.realpath(worktree));
    assert.notEqual(linked.gitDir,linked.commonDir);
    assert.equal(path.resolve(linked.commonDir),path.resolve(discovered.gitDir));
    await fs.writeFile(path.join(repository,'file'),'second');
    run(repository,['add','.']); run(repository,['commit','-qm','second']);
    assert.notEqual(await core.resolveCommit(repository,'HEAD'),selected);
    assert.equal(await core.resolveCommit(repository,selected),selected);
    assert.equal(await core.discover(directory),null);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('symlink目录工作区将文件URI映射到canonical仓库路径', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-baseline-alias-'));
  const repository = path.join(directory, 'repository');
  const alias = path.join(directory, 'alias workspace');
  await fs.mkdir(repository);
  try {
    run(repository,['init','-q']);
    await fs.mkdir(path.join(repository,'nested'));
    await fs.writeFile(path.join(repository,'nested','file.txt'),'text');
    await fs.symlink(repository,alias,process.platform==='win32'?'junction':'dir');
    const discovered = await core.discover(path.join(alias,'nested'));
    assert.equal(discovered.root,await fs.realpath(repository));
    assert.equal(discovered.gitDir,path.resolve(discovered.gitDir));
    assert.equal(await core.relativeFile(discovered.root,path.join(alias,'nested','file.txt')),'nested/file.txt');
    assert.equal(await core.relativeFile(discovered.root,path.join(alias,'nested','new.txt')),'nested/new.txt');
    assert.equal(await core.relativeFile(discovered.root,path.join(directory,'outside.txt')),null);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
