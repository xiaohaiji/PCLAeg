let dependencyView = null, dependencyOwner = '';
let launcherUpdate = null;
let state = { instances: [], catalog: [], sources: {}, running: [] }, page = 'home', source = 'official', pluginTab = 'installed', query = '', releases = null, releaseError = '', loading = false, busy = false, toastTimer, modalResolve, pluginComposing = false;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const current = () => state.instances.find(v => v.id === state.selected);
const date = s => s ? new Date(s).toLocaleDateString('zh-CN') : '尚未启动';
const sourceTypeLabel = type => ({ depctrl: 'DependencyControl · 默认频道', github: 'GitHub 仓库 / Gist', json: 'JSON 插件列表', script: '脚本链接' })[type] || 'DependencyControl · 默认频道';
const btn = (label, action, attrs = '', cls = 'button small') => `<button class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `toast${error ? ' error' : ''}`; toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), error ? 8000 : 3500); }
async function command(name, args = {}, message) {
  const result = await window.launcher.command(name, args);
  if (!result.ok) throw new Error(result.error);
  if (result.data?.instances) { state = { ...state, ...result.data }; render(); }
  if (message && result.data) toast(message);
  return result.data;
}
async function task(fn) {
  if (busy) return;
  busy = true; render(); $('#task').classList.remove('hidden'); $('#task-label').textContent = '正在处理…'; $('#task-percent').textContent = ''; $('#task-bar').style.width = '0%';
  try { await fn(); } catch (e) { try { await command('state'); } catch {} toast(e.message, true); }
  finally { busy = false; $('#task').classList.add('hidden'); render(); }
}
function heading(title, sub, actions = '') { return `<div class="page-heading"><div><h1>${title}</h1></div><div class="right">${actions}</div></div>`; }
function empty(title, text, actions = '') { return `<div class="card empty"><div class="empty-symbol">◇</div><h3>${title}</h3><p>${text}</p>${actions}</div>`; }
function versionRow(v, compact = false) {
  const selected = state.selected === v.id, running = state.running.includes(v.id);
  return `<div class="version-row"><div class="version-icon">A</div><div class="version-info"><h3>${esc(v.name)}${selected ? '<span class="badge blue">当前实例</span>' : ''}${running ? '<span class="badge">运行中</span>' : ''}</h3><p>${esc(v.version)} · ${esc(state.sources[v.source]?.name || '本地导入')} · ${v.plugins.filter(p => p.kind !== 'include').length} 个插件<br>启动文件：${esc(v.exe)}<br>上次启动：${date(v.lastLaunch)}</p></div><div class="row-actions">${btn(selected ? '已选择' : '选择', 'select', `data-id="${v.id}" ${selected ? 'disabled' : ''}`)}${compact ? btn('管理插件', 'manage-plugins', `data-id="${v.id}"`) + btn('删除版本', 'remove', `data-id="${v.id}" ${running ? 'disabled' : ''}`, 'button small danger') : `${btn('插件', 'manage-plugins', `data-id="${v.id}"`)}${btn('目录', 'folder', `data-id="${v.id}"`)}${btn('启动文件', 'change-executable', `data-id="${v.id}"`)}${btn('重命名', 'rename', `data-id="${v.id}"`, 'text-button')}${btn('克隆', 'clone', `data-id="${v.id}"`, 'text-button')}${btn('同步', 'profile-sync', `data-id="${v.id}"`, 'text-button')}${btn('删除版本', 'remove', `data-id="${v.id}" ${running ? 'disabled' : ''}`, 'button small danger')}`}</div></div>`;
}
function homePage() {
  const v = current(), totalPlugins = state.instances.reduce((n, v) => n + v.plugins.filter(p => p.kind !== 'include').length, 0);
  return heading('开始新的创作', '你的版本、插件与配置，在这里井井有条。', '<span class="badge">本地工作空间</span>') +
    `<div class="card add-version"><span>添加 Aegisub 版本</span>${btn('＋ 添加版本', 'go-downloads', '', 'primary')}</div>` +
    `<div class="stats"><div class="stat"><div class="stat-icon">▤</div><div><strong>${state.instances.length}</strong><small>已安装的版本实例</small></div></div><div class="stat"><div class="stat-icon">◇</div><div><strong>${totalPlugins}</strong><small>各实例管理的插件</small></div></div><div class="stat"><div class="stat-icon">⌘</div><div><strong>独立</strong><small>配置与自动保存目录</small></div></div></div><div class="section-title"><h3>我的创作环境</h3>${btn('查看全部 →', 'go-versions', '', 'text-button')}</div>` +
    (state.instances.length ? `<div class="card">${[...state.instances].sort((a, b) => (b.lastLaunch || b.created).localeCompare(a.lastLaunch || a.created)).slice(0, 3).map(v => versionRow(v, true)).join('')}</div>` : empty('准备好你的第一个工作空间', '从官方发布源下载，或导入已经使用的便携版。<br>导入的文件会被复制到独立目录。', btn('下载 Aegisub', 'go-downloads', '', 'primary'))) +
    `<div class="info-grid"><div class="card info-card"><h3>◈　版本各自独立</h3><p>试用新版本，或为某个项目保留熟悉的配置。程序、备份与自动保存，都留在各自的实例里。</p></div><div class="card info-card"><h3>◇　插件跟着环境走</h3><p>${v ? `当前插件安装目标：${esc(v.name)}。` : '先选择一个实例，再为它安装插件。'}插件启用或禁用，只影响所属的工作空间。</p></div></div>`;
}
function versionsPage() {
  return heading('版本管理', '为不同项目准备不同的 Aegisub 环境。', btn('打开版本文件夹', 'versions-folder', '', 'button') + btn('导入本地', 'import', '', 'button') + btn('安装本地 ZIP', 'import-zip', '', 'button') + btn('扫描本机', 'scan-local', '', 'button') + btn('＋ 下载版本', 'go-downloads', '', 'primary')) +
    `<div class="notice"><strong>版本隔离已开启</strong>　每个实例拥有独立的程序、配置、自动保存及插件目录。同一版本也可以克隆出多个环境。</div>` +
    (state.instances.length ? `<div class="card">${state.instances.map(v => versionRow(v)).join('')}</div>` : empty('还没有安装版本', '选择下载，或导入一个完整的 Aegisub 便携版目录。', btn('导入便携版 ZIP', 'import-zip', '', 'button'))) +
    localVersionsPanel() + `<p class="footer-note">删除版本会彻底删除该实例的程序、配置、插件、备份和自动保存文件，无法恢复。克隆会同时复制配置与插件。</p>`;
}
function downloadsPage() {
  let list = '';
  if (loading) list = `<div class="card loading"><span class="spinner"></span>正在获取真实发布版本…</div>`;
  else if (releaseError) list = empty('暂时无法获取版本', esc(releaseError), btn('重新获取', 'refresh', '', 'button'));
  else if (releases) list = releases.length ? `<div class="card">${releases.map((r, i) => `<div class="version-row"><div class="version-icon">↓</div><div class="version-info"><h3>${esc(r.tag)}<span class="badge ${r.prerelease ? 'gray' : ''}">${r.prerelease ? '预发布' : '稳定版'}</span>${i === 0 ? '<span class="badge blue">最新发布</span>' : ''}</h3><p>${date(r.date)} · Windows 便携版<br>${esc(r.assets[0].name)} · ${(r.assets[0].size / 1024 ** 2).toFixed(1)} MB</p></div><div class="row-actions">${btn('发布说明 ↗', 'external', `data-url="${esc(r.url)}"`, 'text-button')}${btn('下载并安装', 'install', `data-tag="${esc(r.tag)}" data-asset="${esc(r.assets[0].name)}"`, 'primary')}</div></div>`).join('')}</div>` : empty('暂无匹配的便携版', '这个发布源最近 30 个版本中没有匹配的 Windows ZIP。可下载便携包后手动导入。');
  return heading('下载 Aegisub', '来自项目发布页的真实版本，一键创建独立环境。', btn('管理源','go-releaseSources','','button') + btn('添加下载分支','release-source-add','','button') + btn('安装本地 ZIP', 'import-zip', '', 'button')) +
    `<div class="toolbar"><div class="chips">${Object.entries(state.sources).map(([id, info]) => btn(esc(info.name), 'source', `data-source="${id}"`, `chip ${source === id ? 'active' : ''}`)).join('')}</div>${btn('↻ 刷新', 'refresh', '', 'button small')}${state.sources[source]?.custom ? btn('移除分支', 'release-source-remove', '', 'text-button danger') : ''}</div><div class="notice">仅提供 Windows x64 便携 ZIP。下载后自动解压、配置隔离，${source === 'official' ? '适合日常字幕制作。' : '分支版本可能包含实验功能，请阅读发布说明。'}</div>${list}`;
}
function pluginSourcesPanel() {
  const feeds = state.pluginFeeds || [], discovered = state.discoveredFeeds || [];
  if (!feeds.length && !discovered.length) return '<div class="notice">尚未订阅插件源，可添加 GitHub、DependencyControl 或 JSON 源。</div>';
  const parentName = url => [...feeds, ...(state.feedDiscoveryCache || [])].find(f => f.url === url || f.manifestUrl === url)?.name || url;
  return '<div class="section-title"><h3>插件源</h3>' + btn('发现关联源', 'plugin-feed-discover', '', 'button small') + '</div>' +
    `<div class="card feed-list">${feeds.map(f => `<div class="settings-row"><div><h3>${esc(f.name)}</h3><p>${esc(f.url)}<br>${f.packages.filter(p => p.section === 'macros').length} 个插件 · ${esc(sourceTypeLabel(f.type))}${f.moduleCount ? ' · ' + f.moduleCount + ' 个依赖模块' : ''}${f.discoveryError ? '<br>发现失败：' + esc(f.discoveryError) : ''}</p></div><div class="row-actions">${btn('刷新源', 'plugin-feed-refresh', `data-url="${esc(f.url)}" data-type="${esc(f.requestedType || 'auto')}"`)}${btn('移除源', 'plugin-feed-remove', `data-url="${esc(f.url)}"`, 'text-button danger')}</div></div>`).join('')}</div>` +
    (discovered.length ? `<div class="section-title"><h3>发现的关联源 · ${discovered.length}</h3></div><div class="card feed-list known-feed-list">${discovered.map(f => `<div class="settings-row"><div><h3>${esc(f.name)}</h3><p>${esc(f.url)}<br>来自：${f.discoveredFrom.map(url => esc(parentName(url))).join('、')}${f.error ? '<br>读取失败：' + esc(f.error) : ''}</p></div>${btn('添加源', 'plugin-feed-known-add', `data-url="${esc(f.url)}"`)}</div>`).join('')}</div>` : '') +
    `<div class="notice">以下关联源尚未订阅。knownFeeds 中的关联源会自动列出，点击“发现关联源”可继续向下查找；点击“添加源”后才会订阅。${state.feedDiscoveryStatus?.limitReached ? '<br>本次已达到发现范围上限，添加关联源后可继续发现。' : ''}</div>`;
}
let pluginSourceFilter = '';
function pluginSourcesPage() {
  return heading('管理插件源', '', btn('返回插件中心', 'go-plugins') + btn('添加插件源', 'plugin-feed-add')) + '<div class="notice">删除源会取消订阅，保留已安装插件。已安装插件仍可单独更新。</div>' + `<div class="toolbar"><label for="source-view">查看来源</label><select id="source-view">${(state.pluginFeeds || []).map(f => `<option value="${esc(f.url)}">${esc(f.name)}</option>`).join('')}</select>${btn('查看插件','plugin-feed-view',state.pluginFeeds?.length ? '' : 'disabled')}</div>` + pluginSourcesPanel();
}
function releaseSourcesPage() {
  return heading('管理下载源', '', btn('返回下载', 'go-downloads') + btn('添加下载分支', 'release-source-add')) + '<div class="notice">删除自定义下载源不会删除已安装实例。</div><div class="card feed-list">' + Object.entries(state.sources).map(([key, info]) => '<div class="settings-row"><div><h3>' + esc(info.name) + '</h3><p>' + esc(info.repo) + '</p></div><div class="row-actions">' + btn('查看版本 / 刷新', 'release-source-view', 'data-source="' + esc(key) + '"') + (info.custom ? btn('删除源', 'release-source-remove', 'data-source="' + esc(key) + '"', 'text-button danger') : '<span class="badge">内置源</span>') + '</div></div>').join('') + '</div>';
}
function pluginsPage() {
  const v = current();
  if (!v) return heading('插件中心', '', btn('管理源', 'go-pluginSources', '', 'button') + btn('添加插件源', 'plugin-feed-add', '', 'button')) + pluginSourcesPanel() + (pluginSourceFilter ? `<div class="plugins-grid">${state.catalog.filter(p => p.sourceUrl === pluginSourceFilter || p.feedUrl === pluginSourceFilter).map(p => `<div class="card plugin-card"><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p></div>`).join('')}</div>` : '') + empty('先选择一个 Aegisub 实例', '插件会安装到选定实例的专属目录。', btn('添加版本', 'go-downloads', '', 'primary'));
  if (pluginTab === 'dependencies') return dependenciesPage(v);
  const search = query.trim().toLowerCase().split(/\s+/).filter(Boolean), installed = pluginTab === 'installed' || pluginTab === 'modules';
  const plugins = (installed ? v.plugins.filter(p => pluginTab === 'modules' ? p.kind === 'include' : p.kind !== 'include') : state.catalog).filter(p => { const text = `${p.name} ${p.file || ''} ${p.relativePath || ''} ${p.author || ''} ${p.description || ''} ${p.category || ''}`.toLowerCase(); return (installed || !pluginSourceFilter || p.sourceUrl === pluginSourceFilter || p.feedUrl === pluginSourceFilter) && search.every(word => text.includes(word)); });
  const cards = plugins.map(p => {
    const local = installed ? p : v.plugins.find(x => x.catalogId === p.id || (x.kind === 'autoload' && x.file.toLowerCase() === p.file.toLowerCase()));
    return `<div class="card plugin-card"><div class="plugin-top"><div class="plugin-icon">${installed ? '◇' : ({ '特效': '✧', '排版': '≡', '检查': '✓', '时间轴': '◷', '编辑': 'Aa' }[p.category] || '◇')}</div><div><h3>${esc(p.name)}</h3><small>${installed ? `${esc(p.version)} · ${p.kind === 'include' ? '依赖模块' : '自动加载脚本'}` : `${esc(p.author)} · Automation 4`}</small></div></div><p>${installed ? `${esc(p.relativePath || p.file)}<br>${p.imported && !p.installed ? '导入版本自带' : '安装于 ' + date(p.installed)}${p.depctrl ? ' · DependencyControl' : p.url ? ' · 在线来源' : ' · 本地导入'}` : esc(p.description)}</p><div class="plugin-footer"><span class="category">${installed ? (p.enabled ? '已启用' : '已禁用') : esc(p.category)}</span><div class="row-actions">${installed ? `${btn(p.enabled ? '禁用' : '启用', 'plugin-toggle', `data-plugin="${p.id}"`)}${p.url || p.depctrl ? btn('更新', 'plugin-update', `data-plugin="${p.id}"`) : ''}${btn('移除', 'plugin-remove', `data-plugin="${p.id}"`, 'text-button danger')}` : `${local ? `<span class="badge blue">已安装</span>${btn(local.enabled ? '禁用' : '启用', 'plugin-toggle', `data-plugin="${local.id}"`)}${btn('移除', 'plugin-remove', `data-plugin="${local.id}"`, 'text-button danger')}` : btn('安装到此实例', 'plugin-install', `data-catalog="${p.id}"`)}${p.homepage ? btn('↗', 'external', `data-url="${esc(p.homepage)}"`, 'text-button') : ''}`}</div></div></div>`;
  }).join('');
  return heading('插件中心', '', btn('依赖关系', 'dependency-view', '', 'button') + btn('重新扫描', 'plugin-scan', '', 'button') + btn('导入脚本', 'plugin-import', '', 'button') + btn('从链接安装', 'plugin-url', '', 'button') + btn('管理源', 'go-pluginSources', '', 'button') + btn('添加插件源', 'plugin-feed-add', '', 'button')) +
    `<div class="notice"><strong>安装目标：${esc(v.name)}</strong>　${esc(v.version)} · 当前操作仅影响这个实例${state.running.includes(v.id) ? '<br>此实例正在运行。关闭 Aegisub 后才能修改插件。' : ''}</div><div class="toolbar"><div class="chips">${btn(`发现插件 · ${state.catalog.length}`, 'plugin-tab', 'data-tab="browse"', `chip ${!installed ? 'active' : ''}`)}${btn(`已安装 · ${v.plugins.filter(p => p.kind !== 'include').length}`, 'plugin-tab', 'data-tab="installed"', `chip ${pluginTab === 'installed' ? 'active' : ''}`)}${btn(`依赖模块 · ${v.plugins.filter(p => p.kind === 'include').length}`, 'plugin-tab', 'data-tab="modules"', `chip ${pluginTab === 'modules' ? 'active' : ''}`)}</div>${btn('打开插件目录', 'plugin-folder', '', 'text-button')}</div><div class="plugin-search-row"><label for="plugin-search">搜索插件</label><input class="search" id="plugin-search" placeholder="名称、文件名、作者或说明" aria-label="搜索插件" value="${esc(query)}">${btn('搜索', 'plugin-search-submit', '', 'button')}${query ? btn('清空', 'plugin-search-clear', '', 'text-button') : ''}<span class="search-count">${query ? '找到' : '共'} ${plugins.length} 项</span></div>` +
    (pluginSourceFilter && !installed ? `<div class="notice">来源：${esc((state.pluginFeeds || []).find(f => f.url === pluginSourceFilter)?.name || pluginSourceFilter)} ${btn('显示全部来源', 'plugin-feed-filter-clear')}</div>` : '') + pluginSourcesPanel() + (cards ? `<div class="plugins-grid">${cards}</div>` : empty(installed ? '这个实例还没有匹配的插件' : '没有找到匹配的插件', '试试其他关键词，或导入自己的脚本。')) +
    `<p class="compat">${installed ? '已扫描当前实例原有的 Lua / MoonScript 脚本。一个脚本可以注册多个菜单功能，因此脚本数量与 Aegisub 菜单项数量可能不同。修改文件后可重新扫描。' : '本地可用脚本与在线脚本统一列出。安装本地脚本时会补齐缺少的依赖，保留目标版本已有模块；实际兼容性需在 Aegisub 中确认。'}<br>外部脚本的第三方依赖需另外安装，可在导入时选择“依赖模块”。</p>`;
}
function localVersionsPanel() {
  return '<div class="section-title"><h3>本机已有的 Aegisub</h3><div class="row-actions">' + btn('重新扫描', 'scan-local') + btn('扫描指定目录', 'scan-directory') + '</div></div>' +
    (state.localVersions?.length ? `<div class="card">${state.localVersions.map(v => `<div class="version-row"><div class="version-info"><h3>${esc(v.name)}${v.imported ? '<span class="badge">已导入</span>' : ''}</h3><p>${esc(v.version || '版本未知')}<br>${esc(v.file)}${v.possibleDuplicate && !v.imported ? '<br>已管理的实例中有相同版本，可按需再导入。' : ''}</p></div>${btn('导入此版本', 'import-detected', `data-token="${v.token}" ${v.imported ? 'disabled' : ''}`)}</div>`).join('')}</div>` : '<div class="notice">启动时自动扫描安装记录、常用目录和运行中的程序。找到后可选择导入；文件复制到独立实例，原目录保留。扫描指定目录也支持便携版。</div>') + (state.localScan?.truncated ? '<p class="footer-note">扫描达到范围上限，可选择指定目录继续查找。</p>' : '');
}
function settingsPage() {
  const prefs = state.preferences || {}, points = state.restorePoints || [];
  const choices = '<option value="">跟随当前选择的实例</option>' + state.instances.map(v => `<option value="${v.id}" ${prefs.defaultAss === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
  return heading('设置', '', btn('跨实例同步', 'profile-sync', '', 'button')) +
    `<div class="card"><div class="settings-row"><div><h3>启动器更新 · ${esc(state.launcherVersion || '0.2.1')}</h3><p>${launcherUpdate ? (launcherUpdate.available ? `发现新版 ${esc(launcherUpdate.version)}，更新后自动重启，保留实例与插件。` : '当前已经是最新稳定版。') : '从官方 GitHub 发布页检查稳定更新。'}${state.updateSupported === false ? '<br>开发模式或单文件版请手动下载目录 ZIP。' : ''}${state.updateResult ? `<br>上次更新：${esc(state.updateResult.version)} · ${{installed:'已完成', 'rolled-back':'失败后已恢复旧程序','restore-failed':'恢复失败，请从缓存中的程序备份恢复'}[state.updateResult.status]}${state.updateResult.error ? '<br>' + esc(state.updateResult.error) : ''}` : ''}</p></div><div class="row-actions">${btn('检查更新','launcher-update-check')}${launcherUpdate?.available ? btn('一键更新','launcher-update-install',state.updateSupported === false ? 'disabled' : '', 'primary') : ''}${btn('发布说明','external','data-url="https://github.com/xiaohaiji/PCLAeg/releases"')}</div></div></div>` +
    `<div class="card"><div class="settings-row"><div><h3>外观</h3><p>浅色、深色或跟随系统。</p></div><div class="chips">${[['system','跟随系统'],['light','浅色'],['dark','深色']].map(([id,name]) => btn(name,'theme',`data-theme="${id}"`,`chip ${prefs.theme === id ? 'active' : ''}`)).join('')}</div></div>
    <div class="settings-row"><div><h3>ASS / SSA 默认打开实例</h3><p>通过启动器打开字幕时使用此实例。首次关联请注册，再在 Windows 默认应用中选择 Aegisub Launcher。</p></div><div class="settings-controls"><select id="ass-instance" aria-label="ASS 默认实例">${choices}</select><div class="row-actions">${btn('注册 ASS 打开方式','ass-register')}${btn('打开 Windows 默认应用','ass-settings')}</div></div></div>
    <div class="settings-row"><div><h3>启动时扫描本机 Aegisub</h3><p>检测已有程序，导入前由你选择。</p></div><label><input type="checkbox" id="auto-scan" ${prefs.autoScan !== false ? 'checked' : ''}> 自动扫描</label></div>
    <div class="settings-row"><div><h3>数据目录</h3><p>${esc(state.root)}</p></div><div class="row-actions">${btn('更改位置','change-storage')}${btn('打开目录','data-folder')}</div></div>
    <div class="settings-row"><div><h3>版本文件夹</h3><p>${esc(state.versionsRoot)}</p></div>${btn('打开版本文件夹','versions-folder')}</div>
    <div class="settings-row"><div><h3>缓存与恢复点</h3><p>${esc(state.cacheRoot)}<br>修改插件与跨实例同步前自动备份，失败时自动回滚。保留最近 10 次修改前的配置和插件。</p></div>${btn('打开缓存','cache-folder')}</div>
    <div class="settings-row"><div><h3>删除版本</h3><p>彻底删除程序、配置、插件和该实例的备份，释放空间。</p></div><span class="settings-value">彻底删除</span></div></div>
    <div class="section-title"><h3>可回滚的修改 · ${points.length}</h3></div>${points.length ? `<div class="card">${points.map(p => `<div class="settings-row"><div><h3>${esc(p.label)}</h3><p>${date(p.created)} · ${p.records.map(r => esc(r.name)).join('、')} · ${p.status === 'auto-restored' ? '错误后已自动回滚' : p.status === 'restore-failed' ? '需要手动恢复' : '可恢复修改前状态'}</p></div>${btn('回滚','profile-restore',`data-point="${p.id}"`)}</div>`).join('')}</div>` : '<div class="notice">修改插件、修复依赖或同步配置后，恢复点会显示在这里。</div>'}
    <p class="footer-note">Aegisub Launcher · PCLAeg 0.2.1 · 各实例的程序、配置、插件保持独立。</p>`;
}
const dependencyStatus = value => ({ ready:'已满足', builtin:'内置 / 运行时提供', optional:'可选', missing:'缺失', conflict:'冲突', unknown:'版本未知' })[value] || value;
function dependenciesPage(v) {
  const graph = dependencyView?.id === v.id ? dependencyView : null;
  if (!graph) return heading('插件依赖') + empty('正在读取依赖', '稍候…');
  const owners = graph.nodes.filter(n => n.type === 'plugin');
  const reachable = new Set([dependencyOwner]);
  if (dependencyOwner) { let changed = true; while (changed) { changed = false; for (const edge of graph.edges) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } } }
  const edges = dependencyOwner ? graph.edges.filter(e => reachable.has(e.from)) : graph.edges;
  const modules = graph.nodes.filter(n => n.type === 'module' && edges.some(e => e.to === n.id));
  let diagram = '';
  if (dependencyOwner) {
    const owner = owners.find(n => n.id === dependencyOwner), visible = modules.slice(0,12), height = Math.max(140,visible.length * 62 + 24);
    diagram = `<div class="card dependency-diagram"><svg viewBox="0 0 820 ${height}" role="img" aria-label="插件和所需模块的关系"><rect x="16" y="${height/2-28}" width="250" height="56" rx="9" class="graph-node"/><text x="30" y="${height/2+5}">${esc(owner?.name?.slice(0,28))}</text>${edges.filter(e => visible.some(m => m.id === e.to) && (e.from === dependencyOwner || visible.some(m => m.id === e.from))).map(e => { const to = visible.findIndex(m => m.id === e.to), from = visible.findIndex(m => m.id === e.from); return `<path d="${e.from === dependencyOwner ? `M266 ${height/2} C340 ${height/2},340 ${to*62+40},416 ${to*62+40}` : `M741 ${from*62+40} C795 ${from*62+40},795 ${to*62+40},741 ${to*62+40}`}" class="graph-edge ${e.status}"><title>${esc(e.ownerName)} → ${esc(e.namespace)}</title></path>`; }).join('')}${visible.map((m,i) => `<rect x="416" y="${i*62+14}" width="325" height="52" rx="8" class="graph-node ${m.status}"/><text x="430" y="${i*62+35}">${esc(m.name)}</text><text x="430" y="${i*62+54}" class="graph-sub">${esc(m.version || '版本未知')} · ${dependencyStatus(m.status)}</text>`).join('')}</svg>${modules.length > 12 ? '<p>图中显示前 12 个模块，完整关系见下表。</p>' : ''}</div>`;
  }
  return heading('插件依赖', '', btn('返回插件','dependency-back') + btn('刷新关系','dependency-view') + btn('修复依赖','dependency-repair',state.running.includes(v.id) ? 'disabled' : '', 'primary')) +
    `<div class="notice">${esc(v.name)} · ${graph.conflicts.length} 个冲突 · ${graph.missing.length} 个声明的缺失依赖。DC 版本要求在安装前检查；动态依赖仍由 DC 在运行时检查。共享依赖使用中不能直接卸载。</div><div class="toolbar"><label for="dependency-owner">查看插件</label><select id="dependency-owner"><option value="">全部插件</option>${owners.map(n => `<option value="${n.id}" ${n.id === dependencyOwner ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select></div>` + diagram +
    `<div class="card dependency-table"><table><thead><tr><th>模块</th><th>版本 / 状态</th><th>使用者与要求</th><th>文件</th></tr></thead><tbody>${modules.map(m => `<tr><td>${esc(m.name)}</td><td><span class="dependency-state ${m.status}">${esc(m.version || '未知')} · ${dependencyStatus(m.status)}</span></td><td>${edges.filter(e => e.to === m.id).map(e => esc(e.ownerName) + ' ' + esc(e.version || '未声明版本')).join('<br>')}</td><td>${m.paths.map(p => `<div>${esc(p.relative)}${m.paths.length > 1 ? btn('保留这份','dependency-choose',`data-namespace="${esc(m.namespace)}" data-path="${esc(p.relative)}"`) : ''}</div>`).join('') || '—'}</td></tr>`).join('')}</tbody></table></div>`;
}
function render() {
  const theme = state.preferences?.theme || 'system';
  document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  const v = current();
  $('#side-name').textContent = v?.name || '还没有创作环境'; $('#side-version').textContent = v ? `${v.version} · 独立工作空间` : '添加一个版本，即可开始';
  $('#side-count').textContent = `${v?.plugins.filter(p => p.kind !== 'include').length || 0} 个插件`;
  $('#instance-select').innerHTML = state.instances.length ? state.instances.map(v => `<option value="${v.id}" ${v.id === state.selected ? 'selected' : ''}>${esc(v.name)} · ${esc(v.version)}</option>`).join('') : '<option value="">选择版本实例</option>';
  $('#launch').disabled = !v || busy || state.running.includes(v.id); $('#launch span').textContent = v && state.running.includes(v.id) ? 'Aegisub 运行中' : '启动 Aegisub'; $('#instance-select').disabled = busy;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.page === ({ pluginSources: 'plugins', releaseSources: 'downloads' }[page] || page)));
  $('#content').innerHTML = ({ home: homePage, versions: versionsPage, downloads: downloadsPage, plugins: pluginsPage, pluginSources: pluginSourcesPage, releaseSources: releaseSourcesPage, settings: settingsPage })[page]();
  if (busy) $('#content').querySelectorAll('button').forEach(b => b.disabled = true);
}
function navigate(next) { page = next; query = ''; render(); $('#content').scrollTop = 0; if (page === 'downloads' && !releases && !loading) fetchReleases(); }
async function fetchReleases() {
  loading = true; releaseError = ''; render(); const requestedSource = source;
  try { const result = await command('releases', { source: requestedSource }); if (source === requestedSource) releases = result; }
  catch (e) { if (source === requestedSource) releaseError = e.message; }
  finally { loading = false; render(); }
}
function promptModal(title, description, value = '', options = {}) {
  $('#modal-title').textContent = title; $('#modal-description').textContent = description; $('#modal-input').value = value;
  $('#modal-label').textContent = options.url ? (options.feed ? '插件源地址' : options.release ? 'GitHub Releases 地址' : 'HTTPS 原始脚本链接') : '实例名称'; $('#modal-input').maxLength = options.url ? 2048 : 80;
  $('#modal-input').placeholder = options.feed ? '粘贴仓库、插件列表或脚本的 HTTPS 链接' : '';
  $('#modal-input').required = !options.kindOnly; $('#modal-input').classList.toggle('hidden', !!options.kindOnly); $('#modal-label').classList.toggle('hidden', !!options.kindOnly);
  $('#modal-extra').innerHTML = options.kind ? '<label for="script-kind">脚本类型</label><select id="script-kind"><option value="autoload">插件脚本（自动加载）</option><option value="include">依赖模块（供其他脚本引用）</option></select>' : '';
  if (options.feed) $('#modal-extra').innerHTML = '<label for="source-type">源类型</label><select id="source-type"><option value="auto">自动识别</option><option value="github">GitHub 仓库 / 目录 / Gist</option><option value="depctrl">DependencyControl 订阅</option><option value="json">JSON 插件列表</option><option value="script">单个脚本链接</option></select>';
  if (options.extra) $('#modal-extra').innerHTML = options.extra;
  $('#modal-form button[type="submit"]').textContent = options.submit || '确定';
  $('#modal').showModal(); $('#modal-input').focus();
  return new Promise(resolve => modalResolve = resolve);
}
function closeModal(value) {
  const resolve = modalResolve, pluginComposing = false;
  modalResolve = null;
  $('#modal').close();
  // Finish removing the HTML modal before Windows opens the native picker.
  requestAnimationFrame(() => requestAnimationFrame(() => resolve?.(value)));
}
function modalFields() { const fields = {}; $('#modal-extra').querySelectorAll('[data-field]').forEach(el => { if(el.dataset.list) { fields[el.dataset.field] ||= []; if(el.checked) fields[el.dataset.field].push(el.value); } else fields[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value; }); return fields; }
$('#modal-form').addEventListener('submit', e => { e.preventDefault(); closeModal({ value: $('#modal-input').value.trim(), kind: $('#script-kind')?.value, sourceType: $('#source-type')?.value, fields: modalFields() }); });
$('#modal-close').onclick = $('#modal-cancel').onclick = () => closeModal(null);
$('#modal').addEventListener('cancel', e => { e.preventDefault(); closeModal(null); });
$('#navigation').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b) navigate(b.dataset.page); });
$('#instance-select').addEventListener('change', e => {
  const id = e.currentTarget.value;
  task(async () => { await command('select', { id }); if(pluginTab === 'dependencies'){dependencyOwner='';dependencyView=await command('dependencyGraph',{id});} });
});
$('#launch').addEventListener('click', () => task(() => command('launch', { id: current().id }, 'Aegisub 已启动')));
$('#cancel-task').addEventListener('click', () => command('cancel').catch(e => toast(e.message, true)));
function applyPluginSearch(input) {
  query = input.value; const pos = input.selectionStart; render();
  const field = $('#plugin-search'); if (field) { field.focus(); field.setSelectionRange(pos, pos); }
}
$('#content').addEventListener('compositionstart', e => { if (e.target.id === 'plugin-search') pluginComposing = true; });
$('#content').addEventListener('compositionend', e => { if (e.target.id === 'plugin-search') { pluginComposing = false; applyPluginSearch(e.target); } });
$('#content').addEventListener('input', e => { if (e.target.id === 'plugin-search' && !pluginComposing && !e.isComposing) applyPluginSearch(e.target); });
$('#content').addEventListener('keydown', e => { if (e.target.id === 'plugin-search' && e.key === 'Enter' && !pluginComposing && !e.isComposing) { e.preventDefault(); applyPluginSearch(e.target); } });
document.body.addEventListener('click', async e => {
  const b = e.target.closest('[data-action]'); if (!b || busy) return;
  const action = b.dataset.action, id = b.dataset.id || state.selected;
  if (action === 'plugin-search-submit') { applyPluginSearch($('#plugin-search')); return; }
  if (action === 'plugin-search-clear') { query = ''; render(); $('#plugin-search').focus(); return; }
  if (action.startsWith('go-')) { navigate(action.slice(3)); return; }
  try {
    if (action === 'launcher-update-check') { await task(async () => { launcherUpdate = await command('updateCheck'); toast(launcherUpdate.available ? `发现新版 ${launcherUpdate.version}` : '当前已经是最新版本'); }); return; }
    if (action === 'launcher-update-install') { await task(() => command('updateInstall',{},'更新已准备完成，正在重启…')); return; }
    if (action === 'theme') { await task(() => command('preference',{key:'theme',value:b.dataset.theme})); return; }
    if (action === 'scan-local' || action === 'scan-directory') { await task(() => command(action === 'scan-local' ? 'scanLocal' : 'scanDirectory',{},'扫描完成')); return; }
    if (action === 'import-detected') {
      const candidate = state.localVersions.find(v=>v.token===b.dataset.token);
      const answer = await promptModal('导入检测到的 Aegisub','将此程序所在文件夹复制到独立实例，原目录保留。',candidate.name);
      if(answer) await task(() => command('importDetected',{token:b.dataset.token,name:answer.value},'版本已导入')); return;
    }
    if (action === 'release-source-add') {
      const answer = await promptModal('添加 Aegisub 下载分支','填写 GitHub 仓库或 Releases 页地址，自动读取它的 Windows 便携 ZIP 发布。','',{url:true,release:true});
      if(answer) await task(async()=>{const result=await command('releaseSourceAdd',{url:answer.value},'分支已添加');source=result.addedSource;releases=null;await fetchReleases();});return;
    }
    if (action === 'release-source-remove') { const removed = b.dataset.source || source; await task(async()=>{await command('releaseSourceRemove',{source:removed});if(source===removed){source='official';releases=null;}if(page==='downloads')await fetchReleases();});return; }
    if (action === 'release-source-view') { source=b.dataset.source; releases=null; navigate('downloads'); return; }
    if (action === 'plugin-feed-view') { pluginSourceFilter=b.dataset.url || $('#source-view').value; pluginTab='browse'; navigate('plugins'); return; }
    if (action === 'plugin-feed-filter-clear') { pluginSourceFilter=''; render(); return; }
    if (action === 'ass-register' || action === 'ass-settings') { await task(()=>command(action === 'ass-register' ? 'assRegister' : 'assSettings',{},action === 'ass-register' ? '已注册，请在 Windows 默认应用中选择 Aegisub Launcher' : undefined));return; }
    if (action === 'profile-restore') { await task(()=>command('profileRestore',{pointId:b.dataset.point},'已回滚配置和插件'));return; }
    if (action === 'profile-sync') {
      if(state.instances.length<2){toast('需要至少两个实例才能同步',true);return;}
      const answer=await promptModal('跨实例同步','同步会替换目标实例的自动加载插件，并在修改前备份。可选择配置、快捷键和插件。','',{kindOnly:true,submit:'查看预览',extra:syncFields(id)});
      if(!answer)return;const options=answer.fields;
      const preview=await command('syncPreview',options);
      const summary=preview.items.map(t=>'<p><strong>'+esc(t.name)+'</strong>：'+t.changes.length+' 个文件变更，'+t.conflicts.length+' 个依赖文件不同</p>').join('');
      const confirmed=await promptModal('同步预览','同步前自动创建恢复点；发生错误会自动回滚。','',{kindOnly:true,submit:'备份并同步',extra:summary+'<p>依赖策略：'+(preview.policy==='keep'?'保留目标已有依赖':'使用来源依赖')+'</p>'});
      if(confirmed)await task(()=>command('syncApply',options,'同步完成，可在设置中回滚'));return;
    }
    if (action === 'dependency-view') { pluginTab='dependencies'; await task(async()=>{dependencyView=await command('dependencyGraph',{id});}); return; }
    if (action === 'dependency-back') {pluginTab='installed';render();return;}
    if (action === 'dependency-repair') {
      const choices=await promptModal('检查并修复依赖','先计算所有启用插件的版本要求，冲突时不会安装。','',{kindOnly:true,submit:'查看预览',extra:'<label><input type="checkbox" data-field="replace"> 允许替换手动模块（仍需满足所有使用者）</label>'});
      if(!choices)return;const plan=await command('dependencyPlan',{id,replace:choices.fields.replace});
      const answer=await promptModal('依赖修复预览',plan.modules.length ? '下载后校验文件，修改前自动备份。' : '当前声明的依赖已经满足。','',{kindOnly:true,submit:plan.modules.length?'备份并修复':'关闭',extra:plan.modules.map(m=>'<p>'+esc(m.namespace)+' '+esc(m.version)+'</p>').join('')});
      if(answer&&plan.modules.length)await task(async()=>{await command('dependencyRepair',{id,replace:choices.fields.replace},'依赖已修复');dependencyView=await command('dependencyGraph',{id});});return;
    }
    if (action === 'dependency-choose') {
      const answer=await promptModal('解决重复模块','保留所选文件，移除其他同名模块；修改前会创建恢复点。','',{kindOnly:true,submit:'备份并处理',extra:'<p>'+esc(b.dataset.path)+'</p>'});
      if(answer)await task(async()=>{await command('dependencyResolve',{id,namespace:b.dataset.namespace,keepPath:b.dataset.path});dependencyView=await command('dependencyGraph',{id});});return;
    }
    if (action === 'source') { source = b.dataset.source; releases = null; await fetchReleases(); return; }
    if (action === 'refresh') { await fetchReleases(); return; }
    if (action === 'plugin-tab') { pluginTab = b.dataset.tab; query = ''; render(); return; }
    if (action === 'manage-plugins') { pluginTab='installed'; await task(() => command('select', { id })); navigate('plugins'); return; }
    if (['import', 'import-zip', 'install', 'rename', 'clone'].includes(action)) {
      const importing = action === 'import' || action === 'import-zip';
      const picked = importing ? await command('chooseImport', { zip: action === 'import-zip' }) : null;
      if (importing && !picked) return;
      const old = state.instances.find(v => v.id === id);
      const defaultName = action === 'install' ? `Aegisub ${b.dataset.tag}` : action === 'rename' ? old.name : action === 'clone' ? `${old.name} · 副本` : '我的 Aegisub';
      const answer = await promptModal(({ import: '导入本地 Aegisub', 'import-zip': '安装本地 ZIP 版本', install: '创建独立实例', rename: '重命名实例', clone: '克隆工作空间' })[action], action === 'clone' ? '复制整个实例，包含版本、配置和已安装插件。' : action === 'rename' ? '给这个工作空间取一个方便识别的名字。' : '为版本取一个名字。程序和配置将保存在独立目录中。', defaultName);
      if (!answer) { if (importing) await command('cancelImport'); return; }
      await task(() => command(action === 'import-zip' ? 'import' : action, { id, name: answer.value, token: picked?.token, zip: action === 'import-zip', source, tag: b.dataset.tag, asset: b.dataset.asset }, action === 'rename' ? '名称已更新' : '独立实例已创建')); return;
    }
    if (action === 'plugin-feed-add') {
      const answer = await promptModal('添加插件源', '支持 GitHub 仓库、目录和 Gist，DependencyControl 订阅，JSON 插件列表，以及 .lua / .moon 脚本链接。添加后可在发现插件中选择安装。', '', { url: true, feed: true });
      if (answer) { pluginTab = 'browse'; pluginSourceFilter = ''; query = ''; await task(() => command('pluginFeedAdd', { url: answer.value, type: answer.sourceType }, '插件源已添加')); } return;
    }
    if (action === 'plugin-feed-discover') {
      await task(() => command('pluginFeedDiscover', {}, '关联源发现完成')); return;
    }
    if (action === 'plugin-feed-known-add') {
      pluginTab = 'browse'; query = '';
      await task(() => command('pluginFeedAdd', { url: b.dataset.url, type: 'auto' }, '关联源已添加')); return;
    }
    if (action === 'plugin-feed-refresh' || action === 'plugin-feed-remove') {
      if (action === 'plugin-feed-remove' && pluginSourceFilter === b.dataset.url) pluginSourceFilter = '';
      await task(() => command(action === 'plugin-feed-refresh' ? 'pluginFeedAdd' : 'pluginFeedRemove', { url: b.dataset.url, type: b.dataset.type || 'auto' }, action === 'plugin-feed-refresh' ? '插件源已刷新' : '已移除源，已安装的插件保留')); return;
    }
    if (action === 'plugin-url') {
      const answer = await promptModal('从链接安装插件', '填写 .lua 或 .moon 文件的原始 HTTPS 下载链接。第三方依赖需单独安装。', '', { url: true, kind: true });
      if (answer) await task(() => command('pluginInstall', { id, url: answer.value, kind: answer.kind }, '插件已安装到当前实例')); return;
    }
    if (action === 'plugin-import') {
      const answer = await promptModal('导入 Automation 脚本', '选择插件脚本或依赖模块。下一步将选择本地 .lua / .moon 文件。', '', { kind: true, kindOnly: true });
      if (answer) await task(() => command('pluginImport', { id, kind: answer.kind }, '脚本已导入当前实例')); return;
    }
    if (action === 'plugin-update') {
      await task(() => command('pluginUpdate', { id, pluginId: b.dataset.plugin }, '插件已更新，源订阅保持不变')); return;
    }
    const commands = {
      select: ['select', { id }], 'change-executable': ['changeExecutable', { id }, '启动文件已更新'], remove: ['remove', { id }, '版本及全部文件已彻底删除'], folder: ['folder', { id }], 'open-instance': ['folder', { id }], 'data-folder': ['folder', {}], 'change-storage': ['changeStorage', {}, '迁移完成，正在重启…'], 'versions-folder': ['folder', { kind: 'versions' }], 'cache-folder': ['folder', { kind: 'cache' }], 'plugin-folder': ['folder', { id, plugins: true }], external: ['external', { url: b.dataset.url }],
      'plugin-scan': ['pluginScan', { id }, '原有插件已扫描'], 'plugin-install': ['pluginInstall', { id, catalogId: b.dataset.catalog }, '插件已安装到当前实例'], 'plugin-toggle': ['pluginToggle', { id, pluginId: b.dataset.plugin }, '插件状态已更新'], 'plugin-remove': ['pluginRemove', { id, pluginId: b.dataset.plugin }, '插件已移除，下次启动生效']
    };
    if (commands[action]) { const [cmd, args, message] = commands[action]; await task(() => command(cmd, args, message)); }
  } catch (e) { toast(e.message, true); }
});
window.launcher.onProgress(event => {
  if (event.stateChanged) { command('state').catch(e => toast(e.message, true)); return; }
  $('#task-label').textContent = event.label; $('#task-percent').textContent = event.percent != null ? `${event.percent}%` : event.received ? `${(event.received / 1024 ** 2).toFixed(1)} MB` : '';
  $('#task-bar').style.width = `${event.percent ?? 35}%`;
});
command('state').catch(e => toast(`初始化失败：${e.message}`, true));

function syncFields(id) { return '<label>来源实例</label><select id="sync-source" data-field="sourceId">'+state.instances.map(v=>'<option value="'+v.id+'" '+(v.id===id?'selected':'')+' '+(state.running.includes(v.id)?'disabled':'')+'>'+esc(v.name)+'</option>').join('')+'</select><label>目标实例</label><div class="sync-targets">'+state.instances.map(v=>'<label><input type="checkbox" data-field="targetIds" data-list="true" value="'+v.id+'" '+(v.id===id||state.running.includes(v.id)?'disabled':'')+'>'+esc(v.name)+(state.running.includes(v.id)?'（运行中）':'')+'</label>').join('')+'</div><label><input type="checkbox" data-field="config" checked> 配置和插件设置</label><label><input type="checkbox" data-field="hotkeys" checked> 快捷键</label><label><input type="checkbox" data-field="plugins" checked> 插件与依赖</label><label>依赖冲突策略</label><select data-field="policy"><option value="keep">保留目标已有依赖</option><option value="source">使用来源依赖（检查使用者兼容性）</option></select>'; }
document.body.addEventListener('change',e=>{
  if(e.target.id==='ass-instance')task(()=>command('preference',{key:'defaultAss',value:e.target.value||null},'ASS 默认实例已保存'));
  if(e.target.id==='auto-scan')task(()=>command('preference',{key:'autoScan',value:e.target.checked}));
  if(e.target.id==='dependency-owner'){dependencyOwner=e.target.value;render();}
  if(e.target.id==='sync-source')$('#modal-extra').querySelectorAll('[data-field="targetIds"]').forEach(el=>{el.disabled=el.value===e.target.value||state.running.includes(el.value);if(el.disabled)el.checked=false;});
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>render());
