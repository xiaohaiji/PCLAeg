const { app, BrowserWindow, ipcMain, dialog, shell, net, nativeTheme } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Manager } = require('./core.cjs');
const { resolveStorage, configureStorage, migrateLibrary, relocateLibrary } = require('./storage.cjs');
const { registerAssociation } = require('./platform.cjs');
const { Updater } = require('./updater.cjs');
let win, manager, updater, pendingImport;
let pendingSubtitleFiles = process.argv.filter(arg => /\.(ass|ssa)$/i.test(arg)).map(file => path.resolve(file));
async function openSubtitles(files) {
  if (!files.length) return;
  if (!manager || !win) { pendingSubtitleFiles.push(...files); return; }
  try { const id = manager.state.preferences.defaultAss || manager.state.selected; if (!id) throw new Error('请先导入 Aegisub，并在设置中选择 ASS 默认实例'); await manager.launch(id, files); win.webContents.send('progress', { stateChanged: true }); }
  catch (error) { dialog.showErrorBox('字幕打开失败', error.message); }
}
const legacyRoots = ['aegisub-launcher', 'Aegisub Launcher', 'Electron'].map(name => path.join(app.getPath('appData'), name, 'library'));
let storage;
try {
  storage = resolveStorage({ packaged: app.isPackaged, executable: app.getPath('exe'), portableDir: process.env.PORTABLE_EXECUTABLE_DIR, testRoot: process.env.PCLAEG_TEST_ROOT, projectRoot: path.join(__dirname, '..') });
  configureStorage(app, storage.root);
} catch (e) {
  dialog.showErrorBox('存储位置不可用', `无法在启动器目录创建数据，请将启动器放到可写目录。\n${e.message}`);
  app.exit(1);
}
const gotLock = app.requestSingleInstanceLock();
app.setName('aegisub-launcher');
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } openSubtitles(argv.filter(arg => /\.(ass|ssa)$/i.test(arg)).map(file => path.resolve(file))); });
  app.whenReady().then(async () => {
    const dataRoot = storage.root;
    try { if (!process.env.PCLAEG_TEST_ROOT) await migrateLibrary(dataRoot, legacyRoots); }
    catch (e) { dialog.showErrorBox('旧数据迁移失败', e.message); app.quit(); return; }
    manager = new Manager(dataRoot, event => { if (win && !win.isDestroyed()) win.webContents.send('progress', event); }, net.fetch.bind(net));
    updater = new Updater({ current: app.getVersion(), root: dataRoot, launcherDir: storage.launcherDir, fetcher: net.fetch.bind(net), progress: manager.progress });
    manager.chooseExecutable = async candidates => {
      const result = await dialog.showMessageBox(win, { type: 'question', noLink: true, buttons: ['取消', ...candidates.map(c => `${path.basename(c.path)} · ${c.version || '版本未知'}`)], defaultId: 0, cancelId: 0, message: '发现多个 Aegisub 程序，请选择要启动的版本', detail: candidates.map(c => `${c.relative}  →  ${c.version || '版本未知'}`).join('\n') });
      return result.response === 0 ? null : candidates[result.response - 1]?.path;
    };
    manager.browseExecutable = async (root, { sameDirectory }) => {
      manager.progress({ label: '等待选择 Aegisub 主程序…', percent: null });
      const result = await chooseFiles({
        title: sameDirectory ? '未自动识别到 Aegisub，请选择当前主程序所在目录内的 EXE 文件' : '未自动识别到 Aegisub，请选择此实例目录内的主程序。取消将撤销本次安装。',
        defaultPath: root, properties: ['openFile'], filters: [{ name: '可执行文件', extensions: ['exe'] }]
      });
      return result.canceled ? null : result.filePaths[0];
    };
    try { await manager.init(); } catch (e) { dialog.showErrorBox('数据读取失败', e.message); app.quit(); return; }
    nativeTheme.themeSource = manager.state.preferences.theme;
    win = new BrowserWindow({ width: 1240, height: 820, minWidth: 1000, minHeight: 680, icon: path.join(__dirname, 'assets', 'icon.png'), backgroundColor: '#f3f6fa', title: 'Aegisub Launcher', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    await win.loadFile(path.join(__dirname, 'index.html'));
    const files = pendingSubtitleFiles; pendingSubtitleFiles = []; await openSubtitles(files);
    if (!process.env.PCLAEG_TEST_ROOT && manager.state.preferences.autoScan) manager.scanLocalVersions().catch(() => {});
  });
}
app.on('window-all-closed', () => app.quit());
async function chooseFiles(options) {
  try {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        document.activeElement?.blur();
        document.documentElement.classList.add('native-picker');
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
    }
    return await dialog.showOpenDialog(win, options);
  } finally {
    if (win && !win.isDestroyed()) {
      await win.webContents.executeJavaScript("document.documentElement.classList.remove('native-picker')");
      win.focus();
      win.webContents.focus();
    }
  }
}
ipcMain.handle('command', async (event, command, args = {}) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: '无效调用' };
  try {
    const run = async () => {
      switch (command) {
        case 'state': return { ...manager.snapshot(), launcherVersion: app.getVersion(), updateSupported: app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE, updateResult: await updater.lastResult() };
        case 'updateCheck': return updater.check();
        case 'updateInstall': {
          if (!app.isPackaged || process.platform !== 'win32' || process.env.PORTABLE_EXECUTABLE_FILE) throw new Error('一键更新仅支持 Windows 目录版，请下载 ZIP 并解压使用');
          if (manager.running.size) throw new Error('请先关闭由启动器启动的 Aegisub，再更新');
          const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '更新并重启'], defaultId: 0, cancelId: 0, message: '更新启动器并重启？', detail: '下载并校验官方稳定版，保留实例、配置、插件与数据目录设置。替换失败时恢复旧程序。' });
          if (answer.response !== 1) return null;
          const prepared = await updater.prepare(manager.abort?.signal);
          const { spawn } = require('node:child_process');
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', prepared.worker, '-PlanFile', prepared.planFile], { detached: true, windowsHide: true, stdio: 'ignore', cwd: prepared.job });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref(); setTimeout(() => app.quit(), 800);
          return { restarting: true, version: prepared.version };
        }
        case 'cancel': manager.abort?.abort(); return null;
        case 'releases': return manager.releases(args.source);
        case 'install': return manager.installRelease(args.source, args.tag, args.asset, args.name);
        case 'chooseImport': {
          pendingImport = null;
          const result = await chooseFiles({ title: args.zip ? '导入 Aegisub 便携版 ZIP' : '选择完整的 Aegisub 目录（将复制到独立实例）', properties: [args.zip ? 'openFile' : 'openDirectory'], ...(args.zip ? { filters: [{ name: '便携版压缩包', extensions: ['zip'] }] } : {}) });
          if (result.canceled) return null;
          pendingImport = { token: randomUUID(), file: result.filePaths[0] };
          return { token: pendingImport.token };
        }
        case 'cancelImport': pendingImport = null; return null;
        case 'import': {
          if (args.token) {
            if (pendingImport?.token !== args.token) throw new Error('文件选择已过期，请重新选择');
            const file = pendingImport.file; pendingImport = null;
            return manager.importVersion(file, args.name);
          }
          const result = await chooseFiles({ title: args.zip ? '导入 Aegisub 便携版 ZIP' : '选择完整的 Aegisub 目录（将复制到独立实例）', properties: [args.zip ? 'openFile' : 'openDirectory'], ...(args.zip ? { filters: [{ name: '便携版压缩包', extensions: ['zip'] }] } : {}) });
          return result.canceled ? null : manager.importVersion(result.filePaths[0], args.name);
        }
        case 'select': return manager.select(args.id);
        case 'preference': { const result = await manager.setPreference(args.key, args.value); if (args.key === 'theme') nativeTheme.themeSource = args.value; return result; }
        case 'syncPreview': return manager.previewSync(args);
        case 'syncApply': return manager.syncProfiles(args);
        case 'profileCheck': return manager.checkRestorePoints();
        case 'profileRestore': {
          const point = manager.state.restorePoints.find(p => p.id === args.pointId); if (!point) throw new Error('恢复点不存在');
          const result = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '回滚配置和插件'], defaultId: 0, cancelId: 0, message: `回滚“${point.label}”？`, detail: '恢复修改前的配置和插件。回滚前也会创建恢复点，不改变 Aegisub 程序或字幕文件。' });
          return result.response === 1 ? manager.restoreProfile(args.pointId) : null;
        }
        case 'dependencyGraph': return manager.dependencyGraph(args.id);
        case 'dependencyPlan': return manager.planDependencies(args.id, null, !!args.replace);
        case 'dependencyRepair': return manager.repairDependencies(args.id, !!args.replace);
        case 'dependencyResolve': return manager.resolveModuleDuplicate(args.id, args.namespace, args.keepPath);
        case 'scanLocal': return manager.scanLocalVersions();
        case 'scanDirectory': { const result = await chooseFiles({ title: '选择要查找 Aegisub 的目录', properties: ['openDirectory'] }); return result.canceled ? null : manager.scanLocalVersions(result.filePaths); }
        case 'importDetected': return manager.importLocalCandidate(args.token, args.name);
        case 'releaseSourceAdd': return manager.addReleaseSource(args.url);
        case 'releaseSourceRemove': return manager.removeReleaseSource(args.source);
        case 'assRegister': {
          const executable = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
          await registerAssociation(executable, app.isPackaged ? [] : [path.join(__dirname, '..')]);
          await shell.openExternal('ms-settings:defaultapps'); return { registered: true };
        }
        case 'assSettings': await shell.openExternal('ms-settings:defaultapps'); return null;
        case 'rename': return manager.rename(args.id, args.name);
        case 'clone': return manager.clone(args.id, args.name);
        case 'changeExecutable': return manager.changeExecutable(args.id);
        case 'launch': return manager.launch(args.id);
        case 'remove': {
          manager.ensureStopped(args.id);
          const v = manager.instance(args.id);
          const result = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '删除版本'], defaultId: 0, cancelId: 0, message: `彻底删除版本「${v.name}」？`, detail: '将删除此版本的全部程序、配置、插件、备份和自动保存文件，释放磁盘空间。此操作无法恢复。其他版本不受影响。' });
          return result.response === 1 ? manager.remove(args.id) : null;
        }
        case 'pluginInstall': return manager.addPlugin(args.id, args);
        case 'pluginFeedAdd': return manager.addPluginFeed(args.url, args.type || 'auto');
        case 'pluginFeedRemove': return manager.removePluginFeed(args.url);
        case 'pluginFeedDiscover': return manager.discoverPluginFeeds();
        case 'pluginScan': return manager.scanPlugins(args.id);
        case 'changeStorage': {
          if (manager.running.size) throw new Error('请先关闭由启动器打开的 Aegisub，再迁移数据目录');
          const result = await chooseFiles({ title: '选择新的数据目录（迁移版本与插件，完成后重启）', defaultPath: manager.root, properties: ['openDirectory', 'createDirectory'] });
          if (result.canceled) return null;
          manager.progress({ label: '正在迁移版本与插件，旧目录将保留…', percent: null });
          const changed = await relocateLibrary(manager.root, result.filePaths[0], storage.configFile);
          if (changed) setTimeout(() => { app.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe') }); app.quit(); }, 700);
          return changed ? { relocated: true } : null;
        }
        case 'pluginImport': {
          const result = await chooseFiles({ title: '选择 Automation 脚本', properties: ['openFile'], filters: [{ name: 'Automation 脚本', extensions: ['lua', 'moon'] }] });
          return result.canceled ? null : manager.addPlugin(args.id, { file: result.filePaths[0], kind: args.kind });
        }
        case 'pluginToggle': return manager.togglePlugin(args.id, args.pluginId);
        case 'pluginRemove': {
          const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '卸载插件'], defaultId: 0, cancelId: 0, message: '卸载这个插件？', detail: '仅删除当前实例内的该脚本。' });
          return result.response === 1 ? manager.removePlugin(args.id, args.pluginId) : null;
        }
        case 'folder': {
          let folder = args.kind === 'versions' ? path.join(manager.root, 'versions') : args.kind === 'cache' ? path.join(manager.root, 'cache') : manager.root;
          if (args.id) { const v = manager.instance(args.id); folder = args.plugins ? path.join(path.dirname(manager.appDir(v)), 'automation') : manager.dir(v); }
          const error = await shell.openPath(folder); if (error) throw new Error(error); return null;
        }
        case 'external': {
          const url = new URL(args.url); if (url.protocol !== 'https:') throw new Error('仅支持 HTTPS 页面');
          await shell.openExternal(url.href); return null;
        }
        default: throw new Error('未知操作');
      }
    };
    const readOnly = ['state', 'updateCheck', 'cancel', 'cancelImport', 'releases', 'folder', 'external', 'scanLocal', 'dependencyGraph', 'syncPreview', 'dependencyPlan'].includes(command);
    return { ok: true, data: await (readOnly ? run() : manager.mutate(run)) };
  } catch (e) { return e.code === 'EXECUTABLE_SELECTION_CANCELLED' ? { ok: true, data: null } : { ok: false, error: e.message }; }
});
