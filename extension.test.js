/** 编辑器回归测试：用内存 VS Code 模型验证开关清理、未保存文本与异步基线切换。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const core = require('./core');
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
const tick = () => new Promise(resolve => setImmediate(resolve));
test('旧读取不覆盖新基线，未保存文本参与比较，关闭立即清除所有装饰', async t => {
  const commands = new Map();
  const rendered = new Map();
  const createdTypes = [];
  const decorationCalls = [];
  const visual = {showGutterIcons:false,showOverviewRuler:false,showFileBadges:false};
  let configurationChanged;
  let comparisonPending;
  let fileMappingPending;
  const reads = [];
  const scans = [];
  const observedTexts = [];
  const old = deferred();
  let selectedBase = 'old';
  let selectedRoot = path.join(os.tmpdir(), 'mock-repository');
  let workspaceFolders;
  let discoveredRepositories;
  let scanDepth = 3;
  const discoveryCalls = [];
  const folderSettings = new Map();
  let provider;
  const statusItem = {show(){},hide(){},dispose(){}};
  const resolving = new Map();
  const referenceCalls = [];
  const state = new Map();
  let requestedReference = 'selected-branch';
  let movingCommit = 'frozen-commit';
  const document = {uri:{scheme:'file',fsPath:selectedRoot+'/a.txt'},version:1,lineCount:2,getText:()=> '未保存\n内容',lineAt:()=>({text:'内容'})};
  const editor = {document,setDecorations(type,marks){ rendered.set(type.kind, marks); decorationCalls.push({type,marks}); }};
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
      createTextEditorDecorationType(options){const color={added:'green',modified:'orange',deleted:'red'}[options.backgroundColor.id.split('.').pop().replace('Background','')];const type={kind:color+'.svg',options,disposed:false,dispose(){this.disposed=true;}};createdTypes.push(type);return type;},
      registerFileDecorationProvider(p){provider=p;return disposable;},
      showInformationMessage(){},showErrorMessage(){},showInputBox:async()=>requestedReference,onDidChangeVisibleTextEditors:event,onDidChangeActiveTextEditor:event,onDidChangeWindowState:event,
    },
    workspace:{isTrusted:true, get workspaceFolders(){return workspaceFolders || [{uri:{scheme:'file',fsPath:selectedRoot}}];},
      getWorkspaceFolder:()=>({uri:{scheme:'file',fsPath:selectedRoot}}),
      getConfiguration:(_section,uri)=>({get:(key,fallback)=> {
        const settings = uri && folderSettings.get(uri.fsPath);
        if (settings) return key in settings ? settings[key] : key in visual ? visual[key] : fallback;
        return key in visual?visual[key]:key==='scanDepth'?scanDepth:['projectionStart','projectionEnd','projectionTarget'].includes(key)?'':key==='repository'?'':selectedBase;
      }}),
      createFileSystemWatcher:()=>({onDidChange:event,onDidCreate:event,onDidDelete:event,dispose(){}}),
      onDidChangeTextDocument:event,onDidSaveTextDocument:event,onDidCreateFiles:event,onDidDeleteFiles:event,
      onDidRenameFiles:event,onDidChangeConfiguration:fn=>{configurationChanged=fn;return disposable;},onDidChangeWorkspaceFolders:event,
    },
  };
  const originalLoad = Module._load;
  const saved = {scan:core.scan,readBaseline:core.readBaseline,compareBuffers:core.compareBuffers,discover:core.discover,discoverAll:core.discoverAll,resolveCommit:core.resolveCommit,resolveBaseline:core.resolveBaseline,relativeFile:core.relativeFile};
  try {
    core.discover = async () => ({root:selectedRoot,gitDir:path.join(selectedRoot,'.git'),commonDir:path.join(selectedRoot,'.git')});
    core.discoverAll = async (directories,depth) => {
      discoveryCalls.push({directories,depth});
      return discoveredRepositories ? directories.flatMap(directory => discoveredRepositories.get(directory) || []) : [];
    };
    core.resolveCommit = async (root,reference) => {referenceCalls.push(reference);return resolving.has(reference)?resolving.get(reference).promise:reference==='selected-branch'||reference==='HEAD'?movingCommit:reference;};
    core.scan = async (root,base) => {scans.push([root,base]);return {commit:base,statuses:new Map([['a.txt','M']])};};
    core.readBaseline = async (root,commit,file) => {reads.push([root,commit,file]);return file==='ignored.txt'?null:commit==='old'?old.promise:Buffer.from('基线');};
    core.compareBuffers = async (root,before,current) => {observedTexts.push(current.toString());return comparisonPending?comparisonPending.promise:{added:[1],modified:[0],deleted:[1]};};
    core.relativeFile = async (root,file)=>fileMappingPending?fileMappingPending.promise:saved.relativeFile(root,file);
    Module._load = function(request,...args) {return request==='vscode'?vscode:originalLoad.call(this,request,...args);};
    delete require.cache[require.resolve('./extension')];
    const context = {subscriptions:[],workspaceState:{get:(key,fallback)=>state.has(key)?state.get(key):fallback,update:async(key,value)=>{state.set(key,value);}},asAbsolutePath:p=>'/extension/'+p};
    require('./extension').activate(context);
    await tick();
    assert.equal(reads.length,1);
    selectedBase='new';
    await commands.get('gitBaselineHighlights.refresh')();
    assert.equal(rendered.get('orange.svg').length,1);
    await t.test('默认仅有淡色背景，新增替换删除可区分且不抢占Git标记',async()=>{
      for(const type of createdTypes.slice(-3)) {
        assert.equal(type.options.isWholeLine,true);
        assert.ok(type.options.backgroundColor.id.endsWith('Background'));
        assert.equal('gutterIconPath' in type.options,false);
        assert.equal('overviewRulerColor' in type.options,false);
      }
      assert.equal(rendered.get('green.svg').length,1);
      assert.equal(rendered.get('red.svg').length,1);
      assert.equal(await provider.provideFileDecoration(document.uri),undefined);
    });
    await t.test('配置独立开启旧模式并立即清除及释放旧类型',async()=>{
      const previous=createdTypes.slice(-3);
      Object.assign(visual,{showGutterIcons:true,showOverviewRuler:true,showFileBadges:true});
      configurationChanged({affectsConfiguration:()=>true});
      assert.ok(previous.every(type=>type.disposed));
      assert.ok(previous.every(type=>decorationCalls.some(call=>call.type===type&&call.marks.length===0)));
      await tick();
      for(const type of createdTypes.slice(-3)) {
        assert.ok(type.options.gutterIconPath.endsWith('.svg'));
        assert.ok(type.options.overviewRulerColor.id);
      }
      assert.equal((await provider.provideFileDecoration(document.uri)).badge,'M');
    });
    await t.test('三个显示开关各自独立生效',async()=>{
      for(const selected of Object.keys(visual)) {
        for(const key of Object.keys(visual)) visual[key]=key===selected;
        configurationChanged({affectsConfiguration:()=>true}); await tick();
        for(const type of createdTypes.slice(-3)) {
          assert.equal('gutterIconPath' in type.options,selected==='showGutterIcons');
          assert.equal('overviewRulerColor' in type.options,selected==='showOverviewRuler');
        }
        const badge=await provider.provideFileDecoration(document.uri);
        assert.equal(Boolean(badge),selected==='showFileBadges');
      }
      Object.assign(visual,{showGutterIcons:true,showOverviewRuler:true,showFileBadges:true});
      configurationChanged({affectsConfiguration:()=>true}); await tick();
    });
    await t.test('配置变化后过期比较不绘制旧类型，徽标返回前再次检查开关',async()=>{
      comparisonPending=deferred();
      const pending=commands.get('gitBaselineHighlights.refresh')();
      await tick();
      const previous=createdTypes.slice(-3);
      const callStart=decorationCalls.length;
      fileMappingPending=deferred();
      const pendingBadge=provider.provideFileDecoration(document.uri);
      Object.assign(visual,{showGutterIcons:false,showOverviewRuler:false,showFileBadges:false});
      configurationChanged({affectsConfiguration:()=>true});
      assert.ok(previous.every(type=>type.disposed));
      fileMappingPending.resolve('a.txt');
      assert.equal(await pendingBadge,undefined);
      fileMappingPending=null;
      comparisonPending.resolve({added:[1],modified:[0],deleted:[1]});
      await pending; await tick(); comparisonPending=null;
      assert.equal(decorationCalls.slice(callStart).some(call=>previous.includes(call.type)&&call.marks.length>0),false);
      assert.equal(createdTypes.slice(-3).some(type=>'gutterIconPath' in type.options||'overviewRulerColor' in type.options),false);
      Object.assign(visual,{showGutterIcons:true,showOverviewRuler:true,showFileBadges:true});
      configurationChanged({affectsConfiguration:()=>true}); await tick();
    });
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
    await t.test('scanDepth为0时不会使用默认递归深度',async()=>{
      scanDepth=0;
      await commands.get('gitBaselineHighlights.refresh')();
      assert.equal(discoveryCalls.at(-1).depth,0);
      scanDepth=3;
    });
    await t.test('多工作区分别使用各自的基线、比较模式与扫描深度',async()=>{
      const first = path.join(os.tmpdir(),'first-workspace');
      const second = path.join(os.tmpdir(),'second-workspace');
      workspaceFolders = [first,second].map(fsPath=>({uri:{scheme:'file',fsPath}}));
      discoveredRepositories = new Map([first,second].map(root=>[root,[{root,gitDir:path.join(root,'.git'),commonDir:path.join(root,'.git')}]]));
      folderSettings.set(first,{base:'alpha',scanDepth:0});
      folderSettings.set(second,{base:'beta',comparisonMode:'mergeBase',scanDepth:2});
      core.resolveBaseline = async (root,reference,mode) => {
        assert.equal(root,second); assert.equal(mode,'mergeBase');
        return `merge-${reference}`;
      };
      document.uri.fsPath=path.join(second,'a.txt');
      await commands.get('gitBaselineHighlights.refresh')();
      assert.deepEqual(scans.slice(-2),[[first,'alpha'],[second,'merge-beta']]);
      assert.deepEqual(discoveryCalls.slice(-2),[{directories:[first],depth:0},{directories:[second],depth:2}]);
      assert.ok(statusItem.text.endsWith('merge-be'));
      requestedReference='common';
      await commands.get('gitBaselineHighlights.selectBaselineForAll')();
      assert.equal(state.get(`baseline:${first}`).commit,'common');
      assert.equal(state.get(`baseline:${second}`).commit,'merge-common');
      assert.deepEqual(scans.slice(-2),[[first,'common'],[second,'merge-common']]);
      requestedReference='repository-selection';
      await commands.get('gitBaselineHighlights.selectBaselineForRepository')(second);
      assert.equal(state.get(`baseline:${second}`).commit,'merge-repository-selection');
      assert.equal(state.get(`baseline:${second}`).configuration,'beta');
      assert.equal(scans.at(-1)[1],'merge-repository-selection');
      workspaceFolders=undefined; discoveredRepositories=undefined; folderSettings.clear();
    });
    await t.test('工作区根目录没有仓库时仍发现扫描深度之外的活动仓库',async()=>{
      const workspace = path.join(os.tmpdir(),'container-workspace');
      const repository = path.join(workspace,'one','two','three','four','repository');
      const discover = core.discover;
      const workspaceFolder=vscode.workspace.getWorkspaceFolder;
      try {
        workspaceFolders=[{uri:{scheme:'file',fsPath:workspace}}];
        discoveredRepositories=new Map();
        folderSettings.set(workspace,{base:'deep-base',scanDepth:0});
        vscode.workspace.getWorkspaceFolder=()=>workspaceFolders[0];
        core.discover=async directory=>directory===repository?{root:repository,gitDir:path.join(repository,'.git'),commonDir:path.join(repository,'.git')}:null;
        document.uri.fsPath=path.join(repository,'a.txt');
        await commands.get('gitBaselineHighlights.refresh')();
        assert.deepEqual(scans.at(-1),[repository,'deep-base']);
        assert.equal(rendered.get('orange.svg').length,1);
      } finally {
        core.discover=discover;
        vscode.workspace.getWorkspaceFolder=workspaceFolder;
        workspaceFolders=undefined; discoveredRepositories=undefined; folderSettings.clear();
      }
    });
    await t.test('符号链接工作区匹配canonical仓库并正确标亮、显示徽标和状态栏',async()=>{
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'baseline-editor-alias-'));
      try {
        const repository = path.join(temporary,'repository');
        const alias = path.join(temporary,'workspace-alias');
        await fs.mkdir(repository);
        await fs.writeFile(path.join(repository,'a.txt'),'content');
        await fs.symlink(repository,alias,process.platform==='win32'?'junction':'dir');
        const canonical = await fs.realpath(repository);
        const other = path.join(temporary,'other-repository');
        workspaceFolders=[other,alias].map(fsPath=>({uri:{scheme:'file',fsPath}}));
        discoveredRepositories=new Map([[other,[{root:other,gitDir:path.join(other,'.git'),commonDir:path.join(other,'.git')}]],[alias,[{root:canonical,gitDir:path.join(canonical,'.git'),commonDir:path.join(canonical,'.git')}]]]);
        folderSettings.set(other,{base:'other-base'});
        folderSettings.set(alias,{base:'alias-base'});
        document.uri.fsPath=path.join(alias,'a.txt');
        await commands.get('gitBaselineHighlights.refresh')();
        assert.ok(reads.some(([root,commit,file])=>root===canonical&&commit==='alias-base'&&file==='a.txt'));
        assert.equal(rendered.get('orange.svg').length,1);
        assert.equal((await provider.provideFileDecoration(document.uri)).badge,'M');
        assert.ok(statusItem.text.endsWith('alias-ba'));
      } finally {
        workspaceFolders=undefined; discoveredRepositories=undefined; folderSettings.clear();
        await fs.rm(temporary,{recursive:true,force:true});
      }
    });
    selectedRoot=path.join(os.tmpdir(),'unselected-workspace'); selectedBase='';
    document.uri.fsPath=selectedRoot+'/a.txt';
    const scanCount=scans.length;
    await commands.get('gitBaselineHighlights.refresh')();
    assert.equal(scans.length,scanCount);
    for (const item of context.subscriptions) item.dispose();
  } finally {Module._load=originalLoad; Object.assign(core,saved); delete require.cache[require.resolve('./extension')];}
});
