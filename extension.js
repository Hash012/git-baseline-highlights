/** VS Code 固定基线装饰入口：只读比较文件及未保存文本，不修改仓库、设置或 Git 更改区。 */
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const core = require('./core');
function activate(context) {
  const emitter = new vscode.EventEmitter();
  const treeEmitter = new vscode.EventEmitter();
  const output = vscode.window.createOutputChannel('Git Baseline Highlights');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'gitBaselineHighlights.selectBaseline';
  const types = {};
  let visual = {showGutterIcons: false, showOverviewRuler: false, showFileBadges: false};
  function rebuildVisualTypes() {
    const active = vscode.window.activeTextEditor;
    const folder = active && active.document.uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(active.document.uri) : (vscode.workspace.workspaceFolders || []).find(folder => folder.uri.scheme === 'file');
    const config = vscode.workspace.getConfiguration('gitBaselineHighlights', folder && folder.uri);
    const next = {
      showGutterIcons: config.get('showGutterIcons', false),
      showOverviewRuler: config.get('showOverviewRuler', false),
      showFileBadges: config.get('showFileBadges', false),
    };
    if (Object.keys(types).length && Object.keys(next).every(key => next[key] === visual[key])) return;
    editEpoch++;
    for (const type of Object.values(types)) {
      for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(type, []);
      type.dispose();
    }
    visual = next;
    for (const [kind, color] of [['added', 'green'], ['modified', 'orange'], ['deleted', 'red']]) {
      const options = {
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(`gitBaselineHighlights.${kind}Background`),
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      };
      if (visual.showOverviewRuler) {
        options.overviewRulerColor = new vscode.ThemeColor(`gitBaselineHighlights.${kind}`);
        options.overviewRulerLane = vscode.OverviewRulerLane.Left;
      }
      if (visual.showGutterIcons) {
        options.gutterIconPath = context.asAbsolutePath(`assets/${color}.svg`);
        options.gutterIconSize = 'contain';
      }
      types[kind] = vscode.window.createTextEditorDecorationType(options);
    }
    emitter.fire(undefined);
  }
  let enabled = context.workspaceState.get('enabled', true);
  let repositoryStates = new Map();
  let root = '';
  let base = '';
  let configuredBase = '';
  let watcherRoot = '';
  let watchers = [];
  let commit = '';
  let statuses = new Map();
  let changes = [];
  let folderChanges = new Set();
  const liveStatuses = new Map();
  let scanEpoch = 0;
  let editEpoch = 0;
  let editTimer;
  let scanTimer;
  let disposed = false;
  const blobs = new Map();
  const busy = new Map();
  const selections = new Map();
  const writes = new Map();
  let selectionSequence = 0;
  function persistBaseline(repositoryRoot, saved, valid) {
    const pending = (writes.get(repositoryRoot) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!valid()) return false;
      await context.workspaceState.update(`baseline:${repositoryRoot}`, saved);
      return valid();
    });
    writes.set(repositoryRoot, pending);
    return pending;
  }
  async function configure() {
    if (!vscode.workspace.isTrusted) return null;
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    const active = vscode.window.activeTextEditor;
    const folder = active && active.document.uri.scheme === 'file'
      ? vscode.workspace.getWorkspaceFolder(active.document.uri) : folders[0];
    if (!folder) return null;
    const config = vscode.workspace.getConfiguration('gitBaselineHighlights', folder.uri);
    const override = config.get('repository', '').trim();
    const directory = override ? path.resolve(folder.uri.fsPath, override)
      : active && active.document.uri.scheme === 'file' ? path.dirname(active.document.uri.fsPath) : folder.uri.fsPath;
    const configuredMode = config.get('comparisonMode', 'direct');
    return {
      repository: await core.discover(directory),
      expression: config.get('base', '').trim(),
      mode: configuredMode === 'mergeBase' ? 'mergeBase' : 'direct',
      followBase: config.get('followBase', false) === true,
    };
  }
  async function configureRepositories() {
    const single = await configure();
    if (!single) return null;
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    const active = vscode.window.activeTextEditor;
    const folder = active && active.document.uri.scheme === 'file'
      ? vscode.workspace.getWorkspaceFolder(active.document.uri) : folders[0];
    const config = folder ? vscode.workspace.getConfiguration('gitBaselineHighlights', folder.uri) : null;
    const depth = Math.max(0, Math.min(8, Number(config && config.get('scanDepth', 3)) || 3));
    const override = config && config.get('repository', '').trim();
    const directories = override && folder
      ? [path.resolve(folder.uri.fsPath, override)]
      : folders.map(item => item.uri.fsPath);
    let repositories = core.discoverAll ? await core.discoverAll(
      directories, depth,
    ) : [];
    // Keep the active-repository fallback for older workspaces and test hosts that do not expose recursive discovery.
    if (!repositories.length && single.repository) repositories = [single.repository];
    return {repositories, expression: single.expression, mode: single.mode, followBase: single.followBase};
  }
  function bindWatchers(repositories) {
    const list = Array.isArray(repositories) ? repositories : repositories ? [repositories] : [];
    const identity = list.map(repository => `${repository.root}\0${repository.gitDir}\0${repository.commonDir}`).sort().join('\0');
    if (watcherRoot === identity) return;
    for (const watcher of watchers) watcher.dispose();
    watchers = []; watcherRoot = identity;
    for (const directory of new Set(list.flatMap(repository => [repository.gitDir, repository.commonDir]))) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '{HEAD,index,refs/**,packed-refs}'));
      watchers.push(watcher, watcher.onDidChange(scheduleScan), watcher.onDidCreate(scheduleScan), watcher.onDidDelete(scheduleScan));
    }
  }
  async function baselineFor(repositoryRoot, expression, ticket, mode = 'direct', followBase = false) {
    const key = `baseline:${repositoryRoot}`;
    let saved = context.workspaceState.get(key);
    // 配置表达式改变时解析一次并冻结；后续刷新不会跟随分支移动。
    if (saved && !expression && saved.configuration !== '') {
      saved = {...saved, configuration: ''};
      await persistBaseline(repositoryRoot, saved, () => !disposed && ticket === scanEpoch);
    }
    if (expression && (!saved || saved.configuration !== expression || saved.mode !== mode || followBase)) {
      const commit = mode === 'mergeBase' && core.resolveBaseline
        ? await core.resolveBaseline(repositoryRoot, expression, mode)
        : await core.resolveCommit(repositoryRoot, expression);
      saved = {commit, reference: expression, configuration: expression, mode};
      if (disposed || ticket !== scanEpoch) return null;
      await persistBaseline(repositoryRoot, saved, () => !disposed && ticket === scanEpoch);
    }
    return saved || null;
  }
  function contains(rootDirectory, file) {
    const relative = path.relative(rootDirectory, file);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  function stateForPath(file) {
    const candidates = [...repositoryStates.values()]
      .filter(state => state.root && contains(state.root, file))
      .sort((left, right) => right.root.length - left.root.length);
    return candidates[0] || null;
  }
  function rebuildFolderChanges(state) {
    state.folderChanges = new Set();
    for (const file of state.statuses.keys()) {
      let directory = path.posix.dirname(file);
      while (directory && directory !== '.') {
        state.folderChanges.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
  }
  function selectActiveState() {
    const active = vscode.window.activeTextEditor;
    const selected = active && active.document.uri.scheme === 'file' ? stateForPath(active.document.uri.fsPath) : null;
    const fallback = selected || repositoryStates.values().next().value;
    root = fallback ? fallback.root : '';
    base = fallback ? fallback.base : '';
    commit = fallback ? fallback.commit : '';
    statuses = fallback ? fallback.statuses : new Map();
    changes = fallback ? fallback.changes : [];
    folderChanges = fallback ? fallback.folderChanges : new Set();
    configuredBase = fallback ? fallback.expression : '';
  }
  async function selectBaseline(repositoryRoot = '') {
    const sequence = ++selectionSequence;
    scanEpoch++; editEpoch++;
    const configuration = await configure();
    if (!configuration || !configuration.repository) return vscode.window.showInformationMessage('Open a Git repository to select a baseline.');
    const selectedRoot = repositoryRoot || configuration.repository.root;
    if ((selections.get(selectedRoot) || 0) > sequence) return;
    selections.set(selectedRoot, sequence);
    const valid = () => !disposed && selections.get(selectedRoot) === sequence;
    const reference = await vscode.window.showInputBox({
      title: 'Git Baseline Highlights: Select Baseline',
      prompt: configuration.mode === 'mergeBase'
        ? 'Enter a commit, tag, or branch. Its merge base with HEAD will be frozen as the baseline.'
        : 'Enter a commit, tag, or branch. Its current commit will be frozen as the baseline.',
      placeHolder: 'Commit SHA, tag, or branch',
      ignoreFocusOut: true,
      validateInput: async value => {
        if (!value.trim()) return 'Enter a commit, tag, or branch.';
        try {
          if (configuration.mode === 'mergeBase' && core.resolveBaseline) await core.resolveBaseline(selectedRoot, value.trim(), configuration.mode);
          else await core.resolveCommit(selectedRoot, value.trim());
          return null;
        }
        catch { return 'This reference does not resolve to a commit.'; }
      },
    });
    if (!valid() || reference === undefined || !reference.trim()) return;
    try {
      const resolved = configuration.mode === 'mergeBase' && core.resolveBaseline
        ? await core.resolveBaseline(selectedRoot, reference.trim(), configuration.mode)
        : await core.resolveCommit(selectedRoot, reference.trim());
      if (!valid()) return;
      scanEpoch++; editEpoch++;
      const written = await persistBaseline(selectedRoot, {commit: resolved, reference: reference.trim(), configuration: configuration.expression, mode: configuration.mode}, valid);
      if (written) await refresh();
    } catch { vscode.window.showErrorMessage('Cannot resolve this baseline. The previous selection is unchanged.'); }
  }
  async function selectBaselineForAll() {
    const configuration = await configureRepositories();
    if (!configuration || !configuration.repositories.length) return vscode.window.showInformationMessage('Open a Git repository to select a baseline.');
    const reference = await vscode.window.showInputBox({
      title: 'Git Baseline Highlights: Set Base for All Repositories',
      prompt: configuration.mode === 'mergeBase'
        ? 'Enter a commit, tag, or branch. Its merge base with HEAD will be frozen in every repository.'
        : 'Enter a commit, tag, or branch. Its current commit will be frozen in every repository.',
      placeHolder: 'Commit SHA, tag, or branch',
      ignoreFocusOut: true,
    });
    if (reference === undefined || !reference.trim()) return;
    const selected = reference.trim();
    try {
      for (const repository of configuration.repositories) {
        const resolved = configuration.mode === 'mergeBase' && core.resolveBaseline
          ? await core.resolveBaseline(repository.root, selected, configuration.mode)
          : await core.resolveCommit(repository.root, selected);
        await persistBaseline(repository.root, {commit: resolved, reference: selected, configuration: configuration.expression, mode: configuration.mode}, () => !disposed);
      }
      await refresh();
    } catch { vscode.window.showErrorMessage('Cannot resolve this baseline in every repository. No remaining repositories were changed.'); }
  }
  function clear() {
    for (const editor of vscode.window.visibleTextEditors) for (const type of Object.values(types)) editor.setDecorations(type, []);
    statuses = new Map();
    changes = [];
    folderChanges = new Set();
    liveStatuses.clear();
    emitter.fire(undefined);
  }
  function display(message) {
    status.text = !enabled ? '$(diff-ignored) Baseline off' : commit ? `$(diff) Baseline ${commit.slice(0, 8)}` : '$(diff) Select baseline';
    status.command = !enabled || commit ? 'gitBaselineHighlights.toggle' : 'gitBaselineHighlights.selectBaseline';
    status.tooltip = message || (!enabled ? 'Highlights are off. Click to turn them on.' : commit ? 'Fixed baseline backgrounds: green = added, orange = replaced, pale red = deletion anchor. Click to toggle.' : 'Choose a commit, tag, or branch. No baseline is selected for this repository.');
    status.show();
  }
  const treeProvider = {
    onDidChangeTreeData: treeEmitter.event,
    getChildren(element) {
      if (!element) return [...repositoryStates.values()].map(state => ({
        kind: 'repository', root: state.root,
        label: path.basename(state.root) || state.root,
        description: state.commit ? `Baseline ${state.commit.slice(0, 8)} · ${state.changes.length} changes` : 'Select baseline',
        collapsibleState: 1,
        command: {command: 'gitBaselineHighlights.selectBaselineForRepository', title: 'Select Baseline', arguments: [state.root]},
      }));
      if (element.kind !== 'repository') return [];
      const state = repositoryStates.get(element.root);
      if (!state) return [];
      return state.changes.map(change => ({
        kind: 'change', root: state.root, path: change.path,
        label: `${change.status}  ${change.path}`,
        description: change.oldPath && change.oldPath !== change.path ? `from ${change.oldPath}` : '',
        collapsibleState: 0,
        command: change.status === 'D' ? undefined : {command: 'vscode.open', title: 'Open File', arguments: [vscode.Uri.file(path.join(state.root, change.path))]},
      }));
    },
    getTreeItem(element) { return element; },
  };
  async function decorate(editor) {
    const document = editor.document;
    const ticket = editEpoch;
    const version = document.version;
    const currentState = document.uri.scheme === 'file' ? stateForPath(document.uri.fsPath) : null;
    const currentCommit = currentState ? currentState.commit : '';
    const currentRoot = currentState ? currentState.root : '';
    const file = document.uri.scheme === 'file' && currentRoot ? await core.relativeFile(currentRoot, document.uri.fsPath) : null;
    if (ticket !== editEpoch || repositoryStates.get(currentRoot) !== currentState) return;
    const cacheKey = `${currentRoot}\0${currentCommit}\0${file}`;
    if (!enabled || !file || !currentCommit || document.lineCount > 100000) {
      for (const type of Object.values(types)) editor.setDecorations(type, []);
      return;
    }
    try {
      const text = Buffer.from(document.getText(), 'utf8');
      let baseline;
      if (blobs.has(cacheKey)) baseline = blobs.get(cacheKey);
      else {
        if (!busy.has(cacheKey)) busy.set(cacheKey, core.readBaseline(currentRoot, currentCommit, file));
        const pending = busy.get(cacheKey);
        try { baseline = await pending; } finally { if (busy.get(cacheKey) === pending) busy.delete(cacheKey); }
        if (repositoryStates.get(currentRoot) === currentState) {
          blobs.set(cacheKey, baseline);
          if (blobs.size > 32) blobs.delete(blobs.keys().next().value);
        }
      }
      let marks = null;
      // 基线没有的文件须由只读扫描确认；忽略目录中的临时文件不参与装饰。
      const statusCode = currentState.statuses.get(file);
      if (core.isText(text) && (baseline !== null || statusCode === 'A' || statusCode === 'R' || statusCode === 'C')) {
        marks = baseline === null
          ? {added: Array.from({length: document.lineCount}, (_, i) => i), modified: [], deleted: []}
          : await core.compareBuffers(currentRoot, baseline, text, document.lineCount);
      }
      if (disposed || !enabled || ticket !== editEpoch || version !== document.version || repositoryStates.get(currentRoot) !== currentState) return;
      if (marks) {
        liveStatuses.set(`${currentRoot}\0${file}`, baseline === null ? (statusCode || 'A') : Object.values(marks).some(lines => lines.length) ? 'M' : '');
        emitter.fire(document.uri);
      } else {
        liveStatuses.delete(`${currentRoot}\0${file}`);
        emitter.fire(document.uri);
      }
      const labels = {added: 'added line', modified: 'replaced line', deleted: 'deletion anchor (deleted text is absent)'};
      for (const [kind, type] of Object.entries(types)) {
        editor.setDecorations(type, marks ? marks[kind].map(line => ({
          range: new vscode.Range(line, 0, line, document.lineAt(line).text.length),
          hoverMessage: `Fixed baseline ${currentCommit.slice(0, 8)}: ${labels[kind]}`,
        })) : []);
      }
    } catch (error) {
      if (ticket === editEpoch) for (const type of Object.values(types)) editor.setDecorations(type, []);
      output.appendLine(`Line highlights skipped: ${error.message}`);
    }
  }
  async function visible() {
    if (!disposed) await Promise.all(vscode.window.visibleTextEditors.map(decorate));
  }
  function scheduleText() {
    editEpoch++;
    clearTimeout(editTimer);
    editTimer = setTimeout(() => { visible(); }, 350);
  }
  async function refresh() {
    rebuildVisualTypes();
    const ticket = ++scanEpoch;
    editEpoch++;
    try {
      const configuration = await configureRepositories();
      if (disposed || ticket !== scanEpoch) return;
      if (!configuration || !configuration.repositories.length) {
        repositoryStates = new Map();
        root = ''; commit = ''; clear(); bindWatchers([]); treeEmitter.fire(undefined); status.hide(); return;
      }
      const next = new Map();
      for (const repository of configuration.repositories) {
        if (disposed || ticket !== scanEpoch) return;
        const expression = configuration.expression;
        const baseline = await baselineFor(repository.root, expression, ticket, configuration.mode, configuration.followBase);
        if (disposed || ticket !== scanEpoch) return;
        const state = {
          root: repository.root,
          repository,
          expression,
          mode: configuration.mode,
          followBase: configuration.followBase,
          base: baseline ? baseline.commit : '',
          commit: '',
          statuses: new Map(),
          changes: [],
          folderChanges: new Set(),
        };
        if (enabled && state.base) {
          try {
            const result = await core.scan(repository.root, state.base);
            state.commit = result.commit;
            state.statuses = result.statuses || new Map();
            state.changes = result.changes || [];
            rebuildFolderChanges(state);
          } catch (error) {
            output.appendLine(`Baseline refresh failed for ${repository.root}: ${error.message}`);
          }
        }
        next.set(repository.root, state);
      }
      if (disposed || ticket !== scanEpoch) return;
      repositoryStates = next;
      bindWatchers(configuration.repositories);
      blobs.clear(); busy.clear();
      selectActiveState();
      liveStatuses.clear(); emitter.fire(undefined); treeEmitter.fire(undefined); display(); await visible();
    } catch (error) {
      if (ticket !== scanEpoch || disposed) return;
      repositoryStates = new Map();
      commit = ''; clear(); display(`Baseline unavailable: ${error.message}. Select another baseline or refresh.`);
      output.appendLine(`Baseline refresh failed: ${error.message}`);
    }
  }
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { refresh(); }, 500);
  }
  const provider = {
    onDidChangeFileDecorations: emitter.event,
    async provideFileDecoration(uri) {
      if (!visual.showFileBadges || !enabled || uri.scheme !== 'file') return undefined;
      const repository = stateForPath(uri.fsPath);
      if (!repository || !repository.commit) return undefined;
      const providerRoot = repository.root;
      const providerCommit = repository.commit;
      const file = await core.relativeFile(providerRoot, uri.fsPath);
      const current = stateForPath(uri.fsPath);
      if (!visual.showFileBadges || !enabled || current !== repository || providerRoot !== current.root || providerCommit !== current.commit) return undefined;
      const liveKey = `${providerRoot}\0${file}`;
      const state = liveStatuses.has(liveKey) ? liveStatuses.get(liveKey) : repository.statuses.get(file);
      const colors = {A: 'added', M: 'modified', R: 'modified', C: 'modified', D: 'deleted'};
      const badges = {A: 'N', M: 'M', R: '⇄', C: 'C', D: '⊖'};
      if (state && colors[state]) return {badge: badges[state], color: new vscode.ThemeColor(`gitBaselineHighlights.${colors[state]}`), tooltip: `Fixed baseline ${providerCommit.slice(0, 8)}: ${state === 'R' ? 'renamed file' : state === 'D' ? 'deleted file' : 'changed file'}`, propagate: false};
      if (repository.folderChanges.has(file)) return {badge: '•', color: new vscode.ThemeColor('gitBaselineHighlights.modified'), tooltip: `Fixed baseline ${providerCommit.slice(0, 8)}: changed file inside`, propagate: false};
      return undefined;
    },
  };
  const treeRegistration = typeof vscode.window.registerTreeDataProvider === 'function'
    ? vscode.window.registerTreeDataProvider('gitBaselineHighlights.repositories', treeProvider)
    : {dispose() {}};
  context.subscriptions.push(emitter, output, status,
    treeEmitter, treeRegistration,
    vscode.window.registerFileDecorationProvider(provider),
    vscode.commands.registerCommand('gitBaselineHighlights.toggle', async () => {
      enabled = !enabled; editEpoch++; scanEpoch++;
      if (!enabled) { clear(); display(); }
      await context.workspaceState.update('enabled', enabled);
      await refresh();
    }),
    vscode.commands.registerCommand('gitBaselineHighlights.refresh', refresh),
    vscode.commands.registerCommand('gitBaselineHighlights.selectBaseline', selectBaseline),
    vscode.commands.registerCommand('gitBaselineHighlights.selectBaselineForRepository', selectBaseline),
    vscode.commands.registerCommand('gitBaselineHighlights.selectBaselineForAll', selectBaselineForAll),
    vscode.commands.registerCommand('gitBaselineHighlights.showLegend', () => vscode.window.showInformationMessage('Fixed baseline backgrounds: green = added lines; orange = replaced lines; pale red = deletion anchors. Git keeps its gutter, overview ruler, and file badges by default. Optional gutter icons, overview ruler marks, and A/M/D/R file badges plus changed-folder markers can be enabled separately in settings. Ignored files, binary text, files over 2 MiB, and documents over 100,000 lines are skipped.')),
    vscode.workspace.onDidChangeTextDocument(event => { if (vscode.window.visibleTextEditors.some(e => e.document === event.document)) scheduleText(); }),
    vscode.workspace.onDidSaveTextDocument(scheduleScan),
    vscode.workspace.onDidCreateFiles(scheduleScan), vscode.workspace.onDidDeleteFiles(scheduleScan), vscode.workspace.onDidRenameFiles(scheduleScan),
    vscode.window.onDidChangeVisibleTextEditors(() => { scheduleText(); }),
    vscode.window.onDidChangeActiveTextEditor(() => { scanEpoch++; editEpoch++; commit = ''; clear(); scheduleScan(); }),
    vscode.window.onDidChangeWindowState(event => { if (event.focused) scheduleScan(); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitBaselineHighlights')) refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    {dispose() { for (const type of Object.values(types)) type.dispose(); for (const watcher of watchers) watcher.dispose(); disposed = true; scanEpoch++; editEpoch++; clearTimeout(editTimer); clearTimeout(scanTimer); }},
  );
  refresh();
}
function deactivate() {}
module.exports = {activate, deactivate};
