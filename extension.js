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
  const weakTypes = {};
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
    for (const type of [...Object.values(types), ...Object.values(weakTypes)]) {
      for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(type, []);
      type.dispose();
    }
    visual = next;
    for (const [kind, color] of [['added', 'green'], ['modified', 'orange'], ['deleted', 'red']]) {
      const options = {
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(`gitBaselineHighlights.${kind}WeakBackground`),
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      };
      weakTypes[kind] = vscode.window.createTextEditorDecorationType(options);
    }
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
  let projectionState = null;
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
  function repositorySettings(config) {
    const projection = {
      start: config.get('projectionStart', '').trim(),
      end: config.get('projectionEnd', '').trim(),
      target: config.get('projectionTarget', '').trim(),
    };
    const configuredBase = config.get('base', '').trim();
    return {
      // With only A configured, compare A with the current working state.
      expression: configuredBase || (projection.start && !projection.end && !projection.target ? projection.start : ''),
      projection,
      mode: config.get('comparisonMode', 'direct') === 'mergeBase' ? 'mergeBase' : 'direct',
      followBase: config.get('followBase', false) === true,
    };
  }
  async function configure(repositoryRoot = '') {
    if (!vscode.workspace.isTrusted) return null;
    if (repositoryRoot) {
      const configuration = await configureRepositories();
      const repository = configuration && configuration.repositories.find(item => item.root === repositoryRoot);
      return repository ? {repository, ...configuration.configurations.get(repositoryRoot)} : null;
    }
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    const active = vscode.window.activeTextEditor;
    const folder = active && active.document.uri.scheme === 'file'
      ? vscode.workspace.getWorkspaceFolder(active.document.uri) : folders[0];
    if (!folder) return null;
    const config = vscode.workspace.getConfiguration('gitBaselineHighlights', folder.uri);
    const override = config.get('repository', '').trim();
    const directory = override ? path.resolve(folder.uri.fsPath, override)
      : active && active.document.uri.scheme === 'file' ? path.dirname(active.document.uri.fsPath) : folder.uri.fsPath;
    return {
      repository: await core.discover(directory),
      ...repositorySettings(config),
    };
  }
  async function configureRepositories() {
    if (!vscode.workspace.isTrusted) return null;
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    const repositories = new Map();
    const configurations = new Map();
    // More specific workspace folders take precedence when the same repository is discovered twice.
    for (const folder of [...folders].sort((a, b) => a.uri.fsPath.length - b.uri.fsPath.length)) {
      const config = vscode.workspace.getConfiguration('gitBaselineHighlights', folder.uri);
      const configuredDepth = Number(config.get('scanDepth', 3));
      const depth = Number.isFinite(configuredDepth) ? Math.max(0, Math.min(8, Math.floor(configuredDepth))) : 3;
      const override = config.get('repository', '').trim();
      const directory = override ? path.resolve(folder.uri.fsPath, override) : folder.uri.fsPath;
      let discovered = core.discoverAll ? await core.discoverAll([directory], depth) : [];
      if (!discovered.length) {
        const repository = await core.discover(directory);
        if (repository) discovered = [repository];
      }
      for (const repository of discovered) {
        repositories.set(repository.root, repository);
        configurations.set(repository.root, repositorySettings(config));
      }
    }
    if (!repositories.size) {
      const active = await configure();
      if (active && active.repository) {
        repositories.set(active.repository.root, active.repository);
        configurations.set(active.repository.root, active);
      }
    }
    return {repositories: [...repositories.values()], configurations};
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
  async function projectionFor(repositoryRoot, expressions, ticket, followBase = false) {
    const key = `projection:${repositoryRoot}`;
    let saved = context.workspaceState.get(key);
    const values = expressions || {start: '', end: '', target: ''};
    const configured = Object.values(values).some(Boolean);
    const complete = values.start && values.end && values.target;
    const singleBaseline = values.start && !values.end && !values.target;
    if (configured && !complete && !singleBaseline) throw new Error('Projection requires projectionStart, projectionEnd, and projectionTarget.');
    if (!complete) {
      // Empty settings preserve a projection selected through the command
      // palette; only an explicit A-only configuration requests fallback.
      if (!configured) return saved || null;
      // Do not inherit a projection selected through the command palette when
      // settings explicitly request the single-baseline fallback.
      if (singleBaseline && saved) await context.workspaceState.update(key, undefined);
      return null;
    }
    if (complete && (!saved || saved.configuration?.start !== values.start || saved.configuration?.end !== values.end || saved.configuration?.target !== values.target || followBase)) {
      const start = await core.resolveCommit(repositoryRoot, values.start);
      const end = await core.resolveCommit(repositoryRoot, values.end);
      const target = await core.resolveCommit(repositoryRoot, values.target);
      if (core.isAncestor && !(await core.isAncestor(repositoryRoot, start, end))) throw new Error('Projection start must be an ancestor of projection end.');
      if (core.isAncestor && !(await core.isAncestor(repositoryRoot, end, target))) throw new Error('Projection target must be equal to or later than projection end.');
      saved = {start, end, target, references: {...values}, configuration: {...values}};
      if (disposed || ticket !== scanEpoch) return null;
      const pending = (writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        if (!(!disposed && ticket === scanEpoch)) return false;
        await context.workspaceState.update(key, saved);
        return !disposed && ticket === scanEpoch;
      });
      writes.set(key, pending);
      await pending;
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
  async function stateForFile(file) {
    const direct = stateForPath(file);
    if (direct) return direct;
    // Git discovers canonical roots, while editor URIs may use a symlink workspace path.
    const candidates = [...repositoryStates.values()].sort((a, b) => b.root.length - a.root.length);
    for (const state of candidates) {
      if (await core.relativeFile(state.root, file)) return state;
    }
    return null;
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
  async function selectActiveState(ticket) {
    const active = vscode.window.activeTextEditor;
    const selected = active && active.document.uri.scheme === 'file' ? await stateForFile(active.document.uri.fsPath) : null;
    if (disposed || ticket !== scanEpoch) return;
    const fallback = selected || repositoryStates.values().next().value;
    root = fallback ? fallback.root : '';
    base = fallback ? fallback.base : '';
    commit = fallback ? fallback.commit : '';
    statuses = fallback ? fallback.statuses : new Map();
    changes = fallback ? fallback.changes : [];
    folderChanges = fallback ? fallback.folderChanges : new Set();
    configuredBase = fallback ? fallback.expression : '';
    projectionState = fallback ? fallback.projection : null;
  }
  async function selectBaseline(repositoryRoot = '') {
    const sequence = ++selectionSequence;
    scanEpoch++; editEpoch++;
    const configuration = await configure(repositoryRoot);
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
      if (written) {
        await context.workspaceState.update(`projection:${selectedRoot}`, undefined);
        await refresh();
      }
    } catch { vscode.window.showErrorMessage('Cannot resolve this baseline. The previous selection is unchanged.'); }
  }
  async function selectProjection() {
    const sequence = ++selectionSequence;
    scanEpoch++; editEpoch++;
    const configuration = await configure();
    if (!configuration || !configuration.repository) return vscode.window.showInformationMessage('Open a Git repository to select a projection.');
    const selectedRoot = configuration.repository.root;
    if ((selections.get(selectedRoot) || 0) > sequence) return;
    selections.set(selectedRoot, sequence);
    const valid = () => !disposed && selections.get(selectedRoot) === sequence;
    const resolveInput = async (title, prompt, optional = false) => vscode.window.showInputBox({
      title: `Git Baseline Highlights: ${title}`, prompt, placeHolder: 'Commit SHA, tag, or branch', ignoreFocusOut: true,
      validateInput: async value => {
        if (!value.trim()) return optional ? null : 'Enter a commit, tag, or branch.';
        try { await core.resolveCommit(selectedRoot, value.trim()); return null; }
        catch { return 'This reference does not resolve to a commit.'; }
      },
    });
    const start = await resolveInput('Projection start (A)', 'Commit, tag, or branch at the beginning of the change');
    if (!valid() || start === undefined || !start.trim()) return;
    const end = await resolveInput('Projection end (B)', 'Optional. Leave empty to use A as the fixed baseline and compare with the current working state.', true);
    if (!valid() || end === undefined) return;
    if (!end.trim()) {
      try {
        const resolved = configuration.mode === 'mergeBase' && core.resolveBaseline
          ? await core.resolveBaseline(selectedRoot, start.trim(), configuration.mode)
          : await core.resolveCommit(selectedRoot, start.trim());
        if (!valid()) return;
        scanEpoch++; editEpoch++;
        const written = await persistBaseline(selectedRoot, {commit: resolved, reference: start.trim(), configuration: configuration.expression, mode: configuration.mode}, valid);
        if (written) {
          await context.workspaceState.update(`projection:${selectedRoot}`, undefined);
          await refresh();
        }
      } catch { vscode.window.showErrorMessage('Cannot resolve this baseline. The previous selection is unchanged.'); }
      return;
    }
    const target = await resolveInput('Projection target (C)', 'Commit, tag, or branch where the change is projected');
    if (!valid() || target === undefined || !target.trim()) return;
    const references = [start.trim(), end.trim(), target.trim()];
    try {
      const [start, end, target] = await Promise.all(references.map(reference => core.resolveCommit(selectedRoot, reference)));
      if (core.isAncestor && !(await core.isAncestor(selectedRoot, start, end))) throw new Error('Projection start must be an ancestor of projection end.');
      if (core.isAncestor && !(await core.isAncestor(selectedRoot, end, target))) throw new Error('Projection target must be equal to or later than projection end.');
      if (!valid()) return;
      scanEpoch++; editEpoch++;
      const saved = {start, end, target, references: {start: references[0], end: references[1], target: references[2]}, configuration: configuration.projection};
      await context.workspaceState.update(`projection:${selectedRoot}`, saved);
      await context.workspaceState.update(`baseline:${selectedRoot}`, undefined);
      await refresh();
    } catch (error) { vscode.window.showErrorMessage(`Cannot configure projection: ${error.message}`); }
  }
  async function selectBaselineForAll() {
    const configuration = await configureRepositories();
    if (!configuration || !configuration.repositories.length) return vscode.window.showInformationMessage('Open a Git repository to select a baseline.');
    const reference = await vscode.window.showInputBox({
      title: 'Git Baseline Highlights: Set Base for All Repositories',
      prompt: 'Enter a commit, tag, or branch. Each repository uses its configured comparison mode.',
      placeHolder: 'Commit SHA, tag, or branch',
      ignoreFocusOut: true,
    });
    if (reference === undefined || !reference.trim()) return;
    const selected = reference.trim();
    try {
      for (const repository of configuration.repositories) {
        const settings = configuration.configurations.get(repository.root);
        const resolved = settings.mode === 'mergeBase' && core.resolveBaseline
          ? await core.resolveBaseline(repository.root, selected, settings.mode)
          : await core.resolveCommit(repository.root, selected);
        await persistBaseline(repository.root, {commit: resolved, reference: selected, configuration: settings.expression, mode: settings.mode}, () => !disposed);
        await context.workspaceState.update(`projection:${repository.root}`, undefined);
      }
      await refresh();
    } catch { vscode.window.showErrorMessage('Cannot resolve this baseline in every repository. No remaining repositories were changed.'); }
  }
  function clear() {
    for (const editor of vscode.window.visibleTextEditors) for (const type of [...Object.values(types), ...Object.values(weakTypes)]) editor.setDecorations(type, []);
    statuses = new Map();
    changes = [];
    folderChanges = new Set();
    liveStatuses.clear();
    emitter.fire(undefined);
  }
  function display(message) {
    status.text = !enabled ? '$(diff-ignored) Baseline off' : projectionState
      ? `$(diff) Projection ${projectionState.start.slice(0, 8)}…${projectionState.end.slice(0, 8)}→${projectionState.target.slice(0, 8)}`
      : commit ? `$(diff) Baseline ${commit.slice(0, 8)}` : '$(diff) Select baseline';
    status.command = !enabled || commit ? 'gitBaselineHighlights.toggle' : 'gitBaselineHighlights.selectBaseline';
    status.tooltip = message || (!enabled ? 'Highlights are off. Click to turn them on.' : projectionState
      ? 'Projection highlights: strong color means the A→B change is retained in C; subdued color means C later evolved that change.'
      : commit ? 'Fixed baseline backgrounds: green = added, orange = replaced, pale red = deletion anchor. Click to toggle.' : 'Choose a commit, tag, or branch. No baseline is selected for this repository.');
    status.show();
  }
  const treeProvider = {
    onDidChangeTreeData: treeEmitter.event,
    getChildren(element) {
      if (!element) return [...repositoryStates.values()].map(state => ({
        kind: 'repository', root: state.root,
        label: path.basename(state.root) || state.root,
        description: state.projection
          ? `Projection ${state.projection.start.slice(0, 8)}…${state.projection.end.slice(0, 8)} → ${state.projection.target.slice(0, 8)} · ${state.changes.length} changes`
          : state.commit ? `Baseline ${state.commit.slice(0, 8)} · ${state.changes.length} changes` : 'Select baseline',
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
    const currentState = document.uri.scheme === 'file' ? await stateForFile(document.uri.fsPath) : null;
    const currentCommit = currentState ? currentState.commit : '';
    const currentRoot = currentState ? currentState.root : '';
    const file = document.uri.scheme === 'file' && currentRoot ? await core.relativeFile(currentRoot, document.uri.fsPath) : null;
    if (ticket !== editEpoch || repositoryStates.get(currentRoot) !== currentState) return;
    const cacheKey = currentState && currentState.projection
      ? `${currentRoot}\0projection\0${currentState.projection.start}\0${currentState.projection.end}\0${currentState.projection.target}\0${file}`
      : `${currentRoot}\0${currentCommit}\0${file}`;
    const allTypes = [...Object.values(types), ...Object.values(weakTypes)];
    if (!enabled || !file || !currentCommit || document.lineCount > 100000) {
      for (const type of allTypes) editor.setDecorations(type, []);
      return;
    }
    try {
      const text = Buffer.from(document.getText(), 'utf8');
      const readSnapshot = async (commit, role = '') => {
        const key = `${cacheKey}\0${role}\0${commit}`;
        if (blobs.has(key)) return blobs.get(key);
        if (!busy.has(key)) busy.set(key, core.readBaseline(currentRoot, commit, file));
        const pending = busy.get(key);
        let snapshot;
        try { snapshot = await pending; } finally { if (busy.get(key) === pending) busy.delete(key); }
        if (repositoryStates.get(currentRoot) === currentState) {
          blobs.set(key, snapshot);
          if (blobs.size > 48) blobs.delete(blobs.keys().next().value);
        }
        return snapshot;
      };
      let marks = null;
      const statusCode = currentState.statuses.get(file);
      if (currentState.projection) {
        const {start, end, target} = currentState.projection;
        const [startSnapshot, endSnapshot, targetSnapshot] = await Promise.all([
          readSnapshot(start, 'A'), readSnapshot(end, 'B'), readSnapshot(target, 'C'),
        ]);
        if (core.isText(text) && core.isText(targetSnapshot)) {
          const targetLineCount = targetSnapshot.toString('utf8').replace(/\r\n/g, '\n').split('\n').length - (targetSnapshot.toString('utf8').endsWith('\n') ? 1 : 0);
          const projected = await core.projectBuffers(currentRoot, startSnapshot, endSnapshot, targetSnapshot, Math.max(targetLineCount, 1));
          marks = await core.mapProjectedMarks(currentRoot, targetSnapshot, text, projected, document.lineCount);
        }
      } else {
        const baseline = await readSnapshot(currentCommit);
        // 基线没有的文件须由只读扫描确认；忽略目录中的临时文件不参与装饰。
        if (core.isText(text) && (baseline !== null || statusCode === 'A' || statusCode === 'R' || statusCode === 'C')) {
          marks = baseline === null
            ? {added: Array.from({length: document.lineCount}, (_, i) => i), modified: [], deleted: []}
            : await core.compareBuffers(currentRoot, baseline, text, document.lineCount);
        }
      }
      if (disposed || !enabled || ticket !== editEpoch || version !== document.version || repositoryStates.get(currentRoot) !== currentState) return;
      if (marks) {
        liveStatuses.set(`${currentRoot}\0${file}`, statusCode || (Object.values(marks).some(lines => lines.length) ? 'M' : ''));
        emitter.fire(document.uri);
      } else {
        liveStatuses.delete(`${currentRoot}\0${file}`);
        emitter.fire(document.uri);
      }
      const labels = {added: 'added line', modified: 'replaced line', deleted: 'deletion anchor (deleted text is absent)'};
      const prefix = currentState.projection
        ? `Projection ${currentState.projection.start.slice(0, 8)}…${currentState.projection.end.slice(0, 8)} → ${currentState.projection.target.slice(0, 8)}`
        : `Fixed baseline ${currentCommit.slice(0, 8)}`;
      for (const [kind, type] of Object.entries(types)) {
        editor.setDecorations(type, marks ? (marks[kind] || []).map(line => ({
          range: new vscode.Range(line, 0, line, document.lineAt(line).text.length),
          hoverMessage: `${prefix}: ${labels[kind]}`,
        })) : []);
      }
      for (const [kind, type] of Object.entries(weakTypes)) {
        const key = `weak${kind[0].toUpperCase()}${kind.slice(1)}`;
        editor.setDecorations(type, marks ? (marks[key] || []).map(line => ({
          range: new vscode.Range(line, 0, line, document.lineAt(line).text.length),
          hoverMessage: `${prefix}: later-evolved ${labels[kind]}`,
        })) : []);
      }
    } catch (error) {
      if (ticket === editEpoch) for (const type of allTypes) editor.setDecorations(type, []);
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
        root = ''; commit = ''; projectionState = null; clear(); bindWatchers([]); treeEmitter.fire(undefined); status.hide(); return;
      }
      const next = new Map();
      for (const repository of configuration.repositories) {
        if (disposed || ticket !== scanEpoch) return;
        const settings = configuration.configurations.get(repository.root);
        const expression = settings.expression;
        const selectedProjection = await projectionFor(repository.root, settings.projection, ticket, settings.followBase);
        const baseline = selectedProjection ? null : await baselineFor(repository.root, expression, ticket, settings.mode, settings.followBase);
        if (disposed || ticket !== scanEpoch) return;
        const state = {
          root: repository.root,
          repository,
          expression,
          projection: selectedProjection,
          mode: settings.mode,
          followBase: settings.followBase,
          base: selectedProjection ? selectedProjection.start : baseline ? baseline.commit : '',
          commit: '',
          statuses: new Map(),
          changes: [],
          folderChanges: new Set(),
        };
        if (enabled && state.projection) {
          try {
            const result = await core.scanBetween(repository.root, state.projection.start, state.projection.end);
            state.commit = state.projection.target;
            state.statuses = result.statuses || new Map();
            state.changes = result.changes || [];
            rebuildFolderChanges(state);
          } catch (error) {
            output.appendLine(`Projection refresh failed for ${repository.root}: ${error.message}`);
          }
        } else if (enabled && state.base) {
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
      await selectActiveState(ticket);
      if (disposed || ticket !== scanEpoch) return;
      liveStatuses.clear(); emitter.fire(undefined); treeEmitter.fire(undefined); display(); await visible();
    } catch (error) {
      if (ticket !== scanEpoch || disposed) return;
      repositoryStates = new Map();
      commit = ''; projectionState = null; clear(); display(`Baseline unavailable: ${error.message}. Select another baseline or refresh.`);
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
      const repository = await stateForFile(uri.fsPath);
      if (!repository || !repository.commit) return undefined;
      const providerRoot = repository.root;
      const providerCommit = repository.commit;
      const file = await core.relativeFile(providerRoot, uri.fsPath);
      const current = repositoryStates.get(providerRoot);
      if (!visual.showFileBadges || !enabled || current !== repository || providerRoot !== current.root || providerCommit !== current.commit) return undefined;
      const liveKey = `${providerRoot}\0${file}`;
      const state = liveStatuses.has(liveKey) ? liveStatuses.get(liveKey) : repository.statuses.get(file);
      const colors = {A: 'added', M: 'modified', R: 'modified', C: 'modified', D: 'deleted'};
      const badges = {A: 'N', M: 'M', R: '⇄', C: 'C', D: '⊖'};
      const prefix = repository.projection
        ? `Projection ${repository.projection.start.slice(0, 8)}…${repository.projection.end.slice(0, 8)} → ${providerCommit.slice(0, 8)}`
        : `Fixed baseline ${providerCommit.slice(0, 8)}`;
      if (state && colors[state]) return {badge: badges[state], color: new vscode.ThemeColor(`gitBaselineHighlights.${colors[state]}`), tooltip: `${prefix}: ${state === 'R' ? 'renamed file' : state === 'D' ? 'deleted file' : 'changed file'}`, propagate: false};
      if (repository.folderChanges.has(file)) return {badge: '•', color: new vscode.ThemeColor('gitBaselineHighlights.modified'), tooltip: `${prefix}: changed file inside`, propagate: false};
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
    vscode.commands.registerCommand('gitBaselineHighlights.selectProjection', selectProjection),
    vscode.commands.registerCommand('gitBaselineHighlights.selectBaselineForRepository', selectBaseline),
    vscode.commands.registerCommand('gitBaselineHighlights.selectBaselineForAll', selectBaselineForAll),
    vscode.commands.registerCommand('gitBaselineHighlights.showLegend', () => vscode.window.showInformationMessage('Fixed baseline backgrounds: green = added lines; orange = replaced lines; pale red = deletion anchors. Projection uses the same strong colors for retained A→B changes and subdued colors for changes later evolved in C. Git keeps its gutter, overview ruler, and file badges by default. Optional gutter icons, overview ruler marks, and A/M/D/R file badges plus changed-folder markers can be enabled separately in settings. Ignored files, binary text, files over 2 MiB, and documents over 100,000 lines are skipped.')),
    vscode.workspace.onDidChangeTextDocument(event => { if (vscode.window.visibleTextEditors.some(e => e.document === event.document)) scheduleText(); }),
    vscode.workspace.onDidSaveTextDocument(scheduleScan),
    vscode.workspace.onDidCreateFiles(scheduleScan), vscode.workspace.onDidDeleteFiles(scheduleScan), vscode.workspace.onDidRenameFiles(scheduleScan),
    vscode.window.onDidChangeVisibleTextEditors(() => { scheduleText(); }),
    vscode.window.onDidChangeActiveTextEditor(() => { scanEpoch++; editEpoch++; commit = ''; clear(); scheduleScan(); }),
    vscode.window.onDidChangeWindowState(event => { if (event.focused) scheduleScan(); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitBaselineHighlights')) refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    {dispose() { for (const type of [...Object.values(types), ...Object.values(weakTypes)]) type.dispose(); for (const watcher of watchers) watcher.dispose(); disposed = true; scanEpoch++; editEpoch++; clearTimeout(editTimer); clearTimeout(scanTimer); }},
  );
  refresh();
}
function deactivate() {}
module.exports = {activate, deactivate};
