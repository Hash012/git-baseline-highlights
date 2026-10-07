/** VS Code 固定基线装饰入口：只读比较文件及未保存文本，不修改仓库、设置或 Git 更改区。 */
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const core = require('./core');
function activate(context) {
  const emitter = new vscode.EventEmitter();
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
  let root = '';
  let base = '';
  let configuredBase = '';
  let watcherRoot = '';
  let watchers = [];
  let commit = '';
  let statuses = new Map();
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
    return {repository: await core.discover(directory), expression: config.get('base', '').trim()};
  }
  function bindWatchers(repository) {
    const identity = repository ? `${repository.root}\0${repository.gitDir}\0${repository.commonDir}` : '';
    if (watcherRoot === identity) return;
    for (const watcher of watchers) watcher.dispose();
    watchers = []; watcherRoot = identity;
    if (!repository) return;
    for (const directory of new Set([repository.gitDir, repository.commonDir])) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '{HEAD,index,refs/**,packed-refs}'));
      watchers.push(watcher, watcher.onDidChange(scheduleScan), watcher.onDidCreate(scheduleScan), watcher.onDidDelete(scheduleScan));
    }
  }
  async function baselineFor(repositoryRoot, expression, ticket) {
    const key = `baseline:${repositoryRoot}`;
    let saved = context.workspaceState.get(key);
    // 配置表达式改变时解析一次并冻结；后续刷新不会跟随分支移动。
    if (saved && !expression && saved.configuration !== '') {
      saved = {...saved, configuration: ''};
      await persistBaseline(repositoryRoot, saved, () => !disposed && ticket === scanEpoch && root === repositoryRoot);
    }
    if (expression && (!saved || saved.configuration !== expression)) {
      saved = {commit: await core.resolveCommit(repositoryRoot, expression), reference: expression, configuration: expression};
      if (disposed || ticket !== scanEpoch || root !== repositoryRoot) return null;
      await persistBaseline(repositoryRoot, saved, () => !disposed && ticket === scanEpoch && root === repositoryRoot);
    }
    return saved || null;
  }
  async function selectBaseline() {
    const sequence = ++selectionSequence;
    scanEpoch++; editEpoch++;
    const configuration = await configure();
    if (!configuration || !configuration.repository) return vscode.window.showInformationMessage('Open a Git repository to select a baseline.');
    const selectedRoot = configuration.repository.root;
    if ((selections.get(selectedRoot) || 0) > sequence) return;
    selections.set(selectedRoot, sequence);
    const valid = () => !disposed && selections.get(selectedRoot) === sequence;
    const reference = await vscode.window.showInputBox({
      title: 'Git Baseline Highlights: Select Baseline',
      prompt: 'Enter a commit, tag, or branch. Its current commit will be frozen as the baseline.',
      placeHolder: 'Commit SHA, tag, or branch',
      ignoreFocusOut: true,
      validateInput: async value => {
        if (!value.trim()) return 'Enter a commit, tag, or branch.';
        try { await core.resolveCommit(selectedRoot, value.trim()); return null; }
        catch { return 'This reference does not resolve to a commit.'; }
      },
    });
    if (!valid() || reference === undefined || !reference.trim()) return;
    try {
      const resolved = await core.resolveCommit(selectedRoot, reference.trim());
      if (!valid()) return;
      scanEpoch++; editEpoch++;
      const written = await persistBaseline(selectedRoot, {commit: resolved, reference: reference.trim(), configuration: configuration.expression}, valid);
      if (written) await refresh();
    } catch { vscode.window.showErrorMessage('Cannot resolve this baseline. The previous selection is unchanged.'); }
  }
  function clear() {
    for (const editor of vscode.window.visibleTextEditors) for (const type of Object.values(types)) editor.setDecorations(type, []);
    statuses = new Map();
    liveStatuses.clear();
    emitter.fire(undefined);
  }
  function display(message) {
    status.text = !enabled ? '$(diff-ignored) Baseline off' : commit ? `$(diff) Baseline ${commit.slice(0, 8)}` : '$(diff) Select baseline';
    status.command = !enabled || commit ? 'gitBaselineHighlights.toggle' : 'gitBaselineHighlights.selectBaseline';
    status.tooltip = message || (!enabled ? 'Highlights are off. Click to turn them on.' : commit ? 'Fixed baseline backgrounds: green = added, orange = replaced, pale red = deletion anchor. Click to toggle.' : 'Choose a commit, tag, or branch. No baseline is selected for this repository.');
    status.show();
  }
  async function decorate(editor) {
    const document = editor.document;
    const ticket = editEpoch;
    const version = document.version;
    const currentCommit = commit;
    const currentRoot = root;
    const file = document.uri.scheme === 'file' && currentRoot ? await core.relativeFile(currentRoot, document.uri.fsPath) : null;
    if (ticket !== editEpoch || currentRoot !== root || currentCommit !== commit) return;
    const cacheKey = `${currentRoot}\0${currentCommit}\0${file}`;
    if (!enabled || !file || !commit || document.lineCount > 100000) {
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
        if (commit === currentCommit && root === currentRoot) {
          blobs.set(cacheKey, baseline);
          if (blobs.size > 32) blobs.delete(blobs.keys().next().value);
        }
      }
      let marks = null;
      // 基线没有的文件须由只读扫描确认；忽略目录中的临时文件不参与装饰。
      if (core.isText(text) && (baseline !== null || statuses.get(file) === 'A')) {
        marks = baseline === null
          ? {added: Array.from({length: document.lineCount}, (_, i) => i), modified: [], deleted: []}
          : await core.compareBuffers(currentRoot, baseline, text, document.lineCount);
      }
      if (disposed || !enabled || ticket !== editEpoch || version !== document.version || commit !== currentCommit || root !== currentRoot) return;
      if (marks) {
        liveStatuses.set(file, baseline === null ? 'A' : Object.values(marks).some(lines => lines.length) ? 'M' : '');
        emitter.fire(document.uri);
      } else {
        liveStatuses.delete(file);
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
      const configuration = await configure();
      if (disposed || ticket !== scanEpoch) return;
      if (!configuration || !configuration.repository) {
        root = ''; commit = ''; clear(); bindWatchers(null); status.hide(); return;
      }
      const repository = configuration.repository;
      if (root !== repository.root) { root = repository.root; commit = ''; clear(); blobs.clear(); busy.clear(); }
      configuredBase = configuration.expression;
      bindWatchers(repository);
      const baseline = await baselineFor(root, configuredBase, ticket);
      if (disposed || ticket !== scanEpoch) return;
      base = baseline ? baseline.commit : '';
      if (!enabled || !base) { commit = ''; clear(); display(); return; }
      const result = await core.scan(root, base);
      if (disposed || ticket !== scanEpoch || !enabled) return;
      if (result.commit !== commit) { blobs.clear(); busy.clear(); }
      commit = result.commit;
      statuses = result.statuses;
      liveStatuses.clear(); emitter.fire(undefined); display(); await visible();
    } catch (error) {
      if (ticket !== scanEpoch || disposed) return;
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
      if (!visual.showFileBadges || !enabled || !commit || uri.scheme !== 'file') return undefined;
      const providerRoot = root;
      const providerCommit = commit;
      const file = await core.relativeFile(providerRoot, uri.fsPath);
      if (!visual.showFileBadges || !enabled || providerRoot !== root || providerCommit !== commit) return undefined;
      const state = liveStatuses.has(file) ? liveStatuses.get(file) : statuses.get(file);
      if (state === 'A') return {badge: 'N', color: new vscode.ThemeColor('gitBaselineHighlights.added'), tooltip: `Fixed baseline ${commit.slice(0, 8)}: new file`, propagate: false};
      if (state && state !== 'D') return {badge: 'M', color: new vscode.ThemeColor('gitBaselineHighlights.modified'), tooltip: `Fixed baseline ${commit.slice(0, 8)}: changed file`, propagate: false};
      return undefined;
    },
  };
  context.subscriptions.push(emitter, output, status,
    vscode.window.registerFileDecorationProvider(provider),
    vscode.commands.registerCommand('gitBaselineHighlights.toggle', async () => {
      enabled = !enabled; editEpoch++; scanEpoch++;
      if (!enabled) { clear(); display(); }
      await context.workspaceState.update('enabled', enabled);
      await refresh();
    }),
    vscode.commands.registerCommand('gitBaselineHighlights.refresh', refresh),
    vscode.commands.registerCommand('gitBaselineHighlights.selectBaseline', selectBaseline),
    vscode.commands.registerCommand('gitBaselineHighlights.showLegend', () => vscode.window.showInformationMessage('Fixed baseline backgrounds: green = added lines; orange = replaced lines; pale red = deletion anchors. Git keeps its gutter, overview ruler, and file badges by default. Optional gutter icons, overview ruler marks, and N/M file badges can be enabled separately in settings. Ignored files, binary text, files over 2 MiB, and documents over 100,000 lines are skipped.')),
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
