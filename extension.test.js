/** 编辑器回归测试：用内存 VS Code 模型验证开关清理、未保存文本与异步基线切换。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const core = require('./core');
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
const tick = () => new Promise(resolve => setImmediate(resolve));
test('旧读取不覆盖新基线，未保存文本参与比较，关闭立即清除所有装饰', async t => {
  const commands = new Map();
  const rendered = new Map();
  const reads = [];
  const scans = [];
  const observedTexts = [];
  const old = deferred();
  let selectedBase = 'old';
  let selectedRoot = path.join(os.tmpdir(), 'mock-repository');
  let provider;
  const statusItem = {show(){},hide(){},dispose(){}};
  const resolving = new Map();
  const referenceCalls = [];
  const state = new Map();
  let requestedReference = 'selected-branch';
  let movingCommit = 'frozen-commit';
  const document = {uri:{scheme:'file',fsPath:selectedRoot+'/a.txt'},version:1,lineCount:2,getText:()=> '未保存\n内容',lineAt:()=>({text:'内容'})};
  const editor = {document,setDecorations(type,marks){ rendered.set(type.kind, marks); }};
  const disposable = {dispose(){}};
  const event = () => disposable;
  const vscode = {
    EventEmitter:class {constructor(){this.event=event;} fire(){} dispose(){}},
    ThemeColor:class {constructor(id){this.id=id;}},
    Range:class {constructor(line,start,endLine,end){Object.assign(this,{line,start,endLine,end});}},
    RelativePattern:class {},
    StatusBarAlignment:{Left:1},OverviewRulerLane:{Left:1},DecorationRangeBehavior:{ClosedClosed:1},
    commands:{registerCommand(name,fn){commands.set(name,fn);return disposable;}},
    window:{
      visibleTextEditors:[editor], activeTextEditor:editor, createOutputChannel:()=>({appendLine(){},dispose(){}}),
      createStatusBarItem:()=>statusItem,
      createTextEditorDecorationType(options){return {kind:options.gutterIconPath.split('/').pop(),dispose(){}};},
      registerFileDecorationProvider(p){provider=p;return disposable;},
      showInformationMessage(){},showErrorMessage(){},showInputBox:async()=>requestedReference,onDidChangeVisibleTextEditors:event,onDidChangeActiveTextEditor:event,onDidChangeWindowState:event,
    },
    workspace:{isTrusted:true, get workspaceFolders(){return [{uri:{scheme:'file',fsPath:selectedRoot}}];},
      getWorkspaceFolder:()=>({uri:{scheme:'file',fsPath:selectedRoot}}),
      getConfiguration:()=>({get:(key)=>key==='repository'?'':selectedBase}),
      createFileSystemWatcher:()=>({onDidChange:event,onDidCreate:event,onDidDelete:event,dispose(){}}),
      onDidChangeTextDocument:event,onDidSaveTextDocument:event,onDidCreateFiles:event,onDidDeleteFiles:event,
      onDidRenameFiles:event,onDidChangeConfiguration:event,onDidChangeWorkspaceFolders:event,
    },
  };
  const originalLoad = Module._load;
  const saved = {scan:core.scan,readBaseline:core.readBaseline,compareBuffers:core.compareBuffers,discover:core.discover,resolveCommit:core.resolveCommit};
  try {
    core.discover = async () => ({root:selectedRoot,gitDir:path.join(selectedRoot,'.git'),commonDir:path.join(selectedRoot,'.git')});
    core.resolveCommit = async (root,reference) => {referenceCalls.push(reference);return resolving.has(reference)?resolving.get(reference).promise:reference==='selected-branch'||reference==='HEAD'?movingCommit:reference;};
    core.scan = async (root,base) => {scans.push([root,base]);return {commit:base,statuses:new Map([['a.txt','M']])};};
    core.readBaseline = async (root,commit,file) => {reads.push([root,commit,file]);return file==='ignored.txt'?null:commit==='old'?old.promise:Buffer.from('基线');};
    core.compareBuffers = async (root,before,current) => {observedTexts.push(current.toString());return {added:[],modified:[0],deleted:[]};};
    Module._load = function(request,...args) {return request==='vscode'?vscode:originalLoad.call(this,request,...args);};
    delete require.cache[require.resolve('./extension')];
    const context = {subscriptions:[],workspaceState:{get:(key,fallback)=>state.has(key)?state.get(key):fallback,update:async(key,value)=>{state.set(key,value);}},asAbsolutePath:p=>'/extension/'+p};
    require('./extension').activate(context);
    await tick();
    assert.equal(reads.length,1);
    selectedBase='new';
    await commands.get('gitBaselineHighlights.refresh')();
    assert.equal(rendered.get('orange.svg').length,1);
    assert.equal((await provider.provideFileDecoration(document.uri)).badge,'M');
    old.resolve(Buffer.from('过时基线')); await tick();
    assert.equal(rendered.get('orange.svg').length,1);
    assert.ok(observedTexts.includes('未保存\n内容'));
    await commands.get('gitBaselineHighlights.toggle')();
    for (const marks of rendered.values()) assert.deepEqual(marks,[]);
    assert.equal(await provider.provideFileDecoration(document.uri),undefined);
    await t.test('关闭后状态栏仍绑定开关命令，可直接重新启用',async()=>{
      assert.equal(statusItem.command,'gitBaselineHighlights.toggle');
    });
    selectedRoot=path.join(os.tmpdir(),'other-workspace');
    document.uri.fsPath=selectedRoot+'/a.txt';
    await commands.get('gitBaselineHighlights.toggle')();
    assert.ok(reads.some(([root,commit]) => root===selectedRoot&&commit==='new'));
    document.uri.fsPath=selectedRoot+'/ignored.txt';
    await commands.get('gitBaselineHighlights.refresh')();
    for (const marks of rendered.values()) assert.deepEqual(marks,[]);
    assert.equal(await provider.provideFileDecoration(document.uri),undefined);
    document.uri.fsPath=selectedRoot+'/a.txt';
    await commands.get('gitBaselineHighlights.selectBaseline')();
    assert.equal(state.get(`baseline:${selectedRoot}`).commit,'frozen-commit');
    movingCommit='moved-commit';
    await commands.get('gitBaselineHighlights.refresh')();
    assert.equal(scans.at(-1)[1],'frozen-commit');
    await t.test('较慢的旧基线选择不能覆盖较快的新选择',async()=>{
    const slow = deferred(); const fast = deferred();
    resolving.set('slow',slow); resolving.set('fast',fast);
    requestedReference='slow';
    const slowSelection=commands.get('gitBaselineHighlights.selectBaseline')();
    await tick();
    requestedReference='fast';
    const fastSelection=commands.get('gitBaselineHighlights.selectBaseline')();
    await tick();
    fast.resolve('fast-commit'); await fastSelection;
    slow.resolve('slow-commit'); await slowSelection;
    assert.equal(state.get(`baseline:${selectedRoot}`).commit,'fast-commit');
    });
    await t.test('配置HEAD到空再HEAD会重新解析，并在清空期间保留基线',async()=>{
    selectedBase='HEAD'; movingCommit='head-first';
    await commands.get('gitBaselineHighlights.refresh')();
    selectedBase='';
    await commands.get('gitBaselineHighlights.refresh')();
    assert.equal(state.get(`baseline:${selectedRoot}`).commit,'head-first');
    assert.equal(state.get(`baseline:${selectedRoot}`).configuration,'');
    selectedBase='HEAD'; movingCommit='head-second';
    await commands.get('gitBaselineHighlights.refresh')();
    assert.equal(state.get(`baseline:${selectedRoot}`).commit,'head-second');
    assert.equal(referenceCalls.filter(reference=>reference==='HEAD').length,2);
    });
    selectedRoot=path.join(os.tmpdir(),'unselected-workspace'); selectedBase='';
    document.uri.fsPath=selectedRoot+'/a.txt';
    const scanCount=scans.length;
    await commands.get('gitBaselineHighlights.refresh')();
    assert.equal(scans.length,scanCount);
    for (const item of context.subscriptions) item.dispose();
  } finally {Module._load=originalLoad; Object.assign(core,saved); delete require.cache[require.resolve('./extension')];}
});
