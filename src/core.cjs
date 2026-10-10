const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const AdmZip = require('adm-zip');
const { parse: parseJSONC, printParseErrorCode } = require('jsonc-parser');
const packagedPlugins = process.resourcesPath && path.join(process.resourcesPath, 'plugin-library');
const BUNDLED_ROOT = packagedPlugins && require('node:fs').existsSync(path.join(packagedPlugins, 'catalog.json')) ? packagedPlugins : path.join(__dirname, 'assets', 'plugin-library');
const BUNDLED_PLUGINS = require('./assets/plugin-library/catalog.json');
const { loadSource, sourceUrl, scriptName } = require('./plugin-sources.cjs');

const SOURCES = {
  official: { name: '官方版本', repo: 'TypesettingTools/Aegisub' },
  arch: { name: 'arch1t3cht 分支', repo: 'arch1t3cht/Aegisub' }
};
const CATALOG = [
  ['blur', 'Blur and Glow', 'ua.BlurAndGlow.lua', '为字幕添加模糊、辉光和多层描边。', '特效'],
  ['case', 'Change Case', 'ua.ChangeCase.lua', '批量调整字幕大小写，整理英文台词。', '编辑'],
  ['line', 'Line Breaker', 'ua.LineBreaker.lua', '自动断行与行长平衡，让字幕更易阅读。', '排版'],
  ['qc', 'Quality Check', 'ua.QC.lua', '检查重叠、空行、阅读速度和常见字幕问题。', '检查'],
  ['join', 'Join / Split / Snap', 'ua.JoinSplitSnap.lua', '合并、分割字幕，吸附视频关键帧。', '时间轴'],
  ['color', 'Colourise', 'ua.Colorize.lua', '逐字渐变、颜色轮换与色彩调整。', '特效'],
  ['cycles', 'Cycles', 'ua.Cycles.lua', '批量循环修改标签、样式与字幕属性。', '编辑'],
  ['encode', 'Encode Hardsub', 'ua.EncodeHardsub.lua', '辅助生成压制硬字幕所需的命令与配置。', '工具'],
  ['fade', 'Fade Works', 'ua.FadeWorks.lua', '制作淡入淡出、逐字淡出及透明度动画。', '特效'],
  ['hydra', 'HYDRA', 'ua.HYDRA.lua', '综合标签编辑工具，调整位置、描边、变形和动画。', '排版'],
  ['jump', 'Jump to Next', 'ua.JumpToNext.lua', '快速跳到下一条需要处理的字幕。', '时间轴'],
  ['masquerade', 'Masquerade', 'ua.Masquerade.lua', '处理遮罩、剪裁与复杂标签组合。', '特效'],
  ['multi-copy', 'MultiCopy', 'ua.MultiCopy.lua', '批量复制字幕文本、标签和其他属性。', '编辑'],
  ['multi-edit', 'MultiLine Editor', 'ua.MultiLineEditor.lua', '同时编辑多行字幕并进行批量替换。', '编辑'],
  ['multiplexer', 'Multiplexer', 'ua.Multiplexer.lua', '组合和批量处理字幕内容。', '编辑'],
  ['necros', 'NecrosCopy', 'ua.NecrosCopy.lua', '复制与粘贴标签、坐标和字幕属性。', '编辑'],
  ['recalculator', 'Recalculator', 'ua.Recalculator.lua', '批量计算并调整字号、比例与标签数值。', '排版'],
  ['relocator', 'Hyperdimensional Relocator', 'ua.Relocator.lua', '移动、缩放及重新定位字幕与绘图。', '排版'],
  ['cleanup', 'Script Cleanup', 'ua.ScriptCleanup.lua', '清理多余标签、空行和字幕脚本。', '检查'],
  ['selectrix', 'Selectrix', 'ua.Selectrix.lua', '按文本、样式、标签等条件筛选字幕行。', '编辑'],
  ['shift', 'Shift Cut', 'ua.ShiftCut.lua', '批量移动和调整字幕时间。', '时间轴'],
  ['significance', 'Significance', 'ua.Significance.lua', '辅助处理标牌字幕与排版。', '排版'],
  ['time-signs', 'Time Signs', 'ua.TimeSigns.lua', '辅助校准标牌字幕的显示时间。', '时间轴'],
  ['ibus', 'iBus', 'ua.iBus.lua', '辅助快速调整字幕排版属性。', '排版']
].map(([id, name, file, description, category]) => ({ id, name, file, description, category, author: 'unanimated', url: `https://raw.githubusercontent.com/TypesettingTools/unanimated-Aegisub-Scripts/master/${file}`, homepage: 'https://github.com/TypesettingTools/unanimated-Aegisub-Scripts', compatibility: 'Automation 4 Lua；使用 Aegisub 内置模块，DependencyControl 可选' }));

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径必须位于管理目录内');
  return target;
}
function safeEntry(name) {
  if (!name || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|:|\x00/.test(name)) throw new Error('压缩包包含不安全的路径');
  if (name.split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error('压缩包包含无效的 Windows 文件名');
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function writeJSON(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, p);
}
function folderName(name) {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80);
  return !clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean) ? 'Aegisub' : clean;
}
async function executableVersion(file) {
  if (process.platform !== 'win32') return null;
  const handle = await fs.open(file, 'r');
  try {
    const signature = Buffer.alloc(2); await handle.read(signature, 0, 2, 0);
    if (signature.toString() !== 'MZ') return null;
  } finally { await handle.close(); }
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:PCLAEG_EXE_PATH).FileVersion'], { env: { ...process.env, PCLAEG_EXE_PATH: file }, windowsHide: true, timeout: 10000 });
    return stdout.trim() || null;
  } catch { return null; }
}
async function findExecutables(dir, depth = 0, maxDepth = 5) {
  const result = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.isFile() && /^aegisub(?:\d+)?\.exe$/i.test(ent.name)) {
      const file = path.join(dir, ent.name);
      result.push({ path: file, version: await executableVersion(file) });
    }
  }
  if (depth < maxDepth) for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) result.push(...await findExecutables(path.join(dir, ent.name), depth + 1, maxDepth));
  }
  return result;
}
function cancelledExecutableSelection() {
  return Object.assign(new Error('已取消版本选择'), { code: 'EXECUTABLE_SELECTION_CANCELLED' });
}
async function validateExecutable(root, file, sameDirectory = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.exe$/i.test(file)) throw new Error('请选择有效的 EXE 文件');
  const resolved = path.resolve(file);
  inside(root, resolved);
  if (sameDirectory && path.relative(root, path.dirname(resolved))) throw new Error('请选择当前主程序所在目录内的 EXE 文件');
  let stat;
  try { stat = await fs.lstat(resolved); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('选择的启动文件不存在'); throw error; }
  if (!stat.isFile()) throw new Error('请选择普通 EXE 文件，不能选择目录或链接');
  const realRoot = await fs.realpath(root), realFile = await fs.realpath(resolved);
  inside(realRoot, realFile);
  if (sameDirectory && path.relative(realRoot, path.dirname(realFile))) throw new Error('请选择当前主程序所在目录内的 EXE 文件');
  return { path: resolved, version: await executableVersion(resolved) };
}
async function extractZip(zipFile, dest) {
  const zip = new AdmZip(zipFile);
  let total = 0;
  for (const entry of zip.getEntries()) {
    safeEntry(entry.entryName);
    inside(dest, path.join(dest, entry.entryName));
    if (((entry.header.attr >>> 16) & 0xf000) === 0xa000) throw new Error('不支持包含符号链接的压缩包');
    total += entry.header.size;
    if (total > 2 * 1024 ** 3) throw new Error('压缩包解压后超过 2 GB');
  }
  zip.extractAllTo(dest, false);
}
async function extractVersionZip(zipFile, dest, depth = 0) {
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries();
  const containsExe = entries.some(e => /(^|[\\/])aegisub(?:\d+)?\.exe$/i.test(e.entryName));
  const containsAnyExe = entries.some(e => !e.isDirectory && /\.exe$/i.test(e.entryName));
  if (!containsAnyExe && entries.some(e => /(^|[\\/])(CMakeLists\.txt|meson\.build)$/i.test(e.entryName))) throw new Error('这是 Aegisub 源码 ZIP，里面没有 EXE 程序。请使用 Windows 便携版 ZIP，不是 Source code 源码包。');
  await extractZip(zipFile, dest);
  if (containsExe || depth >= 2) return;
  const nested = entries.filter(e => !e.isDirectory && /(^|[\\/])aegisub[^\\/]*\.zip$/i.test(e.entryName));
  if (nested.length === 1) await extractVersionZip(path.join(dest, nested[0].entryName), path.join(dest, 'portable'), depth + 1);
}
async function download(url, dest, progress = () => {}, limit = 1024 ** 3, fetcher = fetch, signal) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('下载链接必须使用 HTTPS');
  const handle = await fs.open(dest, 'wx');
  let count = 0;
  try {
    let failures = 0;
    for (let request = 0; request < 512; request++) {
      try {
        if (signal?.aborted) throw new Error('下载已取消');
        const headers = { 'User-Agent': 'PCLAeg/0.1', 'Accept-Encoding': 'identity' };
        headers.Range = `bytes=${count}-${count + 4 * 1024 ** 2 - 1}`;
        const response = await fetcher(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}${response.status === 403 ? '（可能达到 GitHub 访问限额）' : ''}`);
        if (count && response.status !== 206) { count = 0; await handle.truncate(0); }
        if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${count}-`)) throw new Error('服务器返回的续传范围无效');
        const partLength = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length'));
        const expectedEnd = partLength ? count + partLength : 0;
        const rangeTotal = Number(response.headers.get('content-range')?.split('/')[1]);
        const length = response.status === 206 ? rangeTotal : expectedEnd;
        if (response.status === 206 && !length) throw new Error('服务器返回的续传范围无效');
        if (length > limit) throw new Error('下载文件超过大小限制');
        for await (const chunk of response.body) {
          if (count + chunk.length > limit) throw new Error('下载文件超过大小限制');
          let written = 0;
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written, count);
            written += result.bytesWritten; count += result.bytesWritten;
          }
          progress({ received: count, total: length || null, percent: length ? Math.round(count / length * 100) : null });
        }
        if (expectedEnd && count !== expectedEnd) throw new Error('下载不完整');
        if (response.status !== 206 || count === length) return;
        failures = 0;
      } catch (e) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (++failures > 3 || /大小限制|续传范围|HTTP 4/.test(e.message)) throw e;
        progress({ received: count, percent: null, retry: failures });
      }
    }
    throw new Error('下载请求次数超过限制');
  } finally { await handle.close(); }
}

class Manager {
  constructor(root, progress = () => {}, fetcher = fetch) { this.root = path.resolve(root); this.progress = progress; this.fetcher = fetcher; this.running = new Map(); this.busy = false; }
  async init() {
    await fs.mkdir(path.join(this.root, 'versions'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'cache', 'downloads'), { recursive: true });
    if (!await exists(path.join(this.root, 'state.json'))) await writeJSON(path.join(this.root, 'state.json'), { instances: [], selected: null });
    this.state = JSON.parse(await fs.readFile(path.join(this.root, 'state.json'), 'utf8'));
    let migrated = false;
    for (const v of this.state.instances) {
      if (v.folder) continue;
      v.folder = `${folderName(v.name)}-${v.id.slice(0, 8)}`;
      const old = inside(path.join(this.root, 'instances'), path.join(this.root, 'instances', v.id));
      const dest = this.dir(v);
      if (await exists(old)) {
        if (await exists(dest)) throw new Error('旧版本目录迁移目标已存在，请检查目录');
        await fs.rename(old, dest);
      }
      migrated = true;
    }
    if (migrated) await this.save();
    await this.scanPlugins();
    return this.snapshot();
  }
  catalog() {
    const source = this.state.instances.find(v => /^9820(?:\D|$)/.test(v.version || '') || v.name === '9820');
    const local = (source?.plugins || []).filter(p => p.kind === 'autoload').map(p => ({
      id: `local-${source.id}-${p.id}`, name: p.name, file: p.file,
      description: p.description || '字幕自动化脚本，可安装到当前版本。',
      category: /motion|tracking|clip|shape|gradient|wobble|typewriter|ruby/i.test(p.file) ? '特效' : /tim|qc|overlap/i.test(p.file) ? '时间轴' : '编辑',
      author: p.author || '字幕工具', version: p.version, sourceInstanceId: source.id, sourcePluginId: p.id,
      compatibility: '安装时补齐缺少的依赖模块，保留目标版本已有模块。'
    }));
    const localFiles = new Set(local.map(p => p.file.toLowerCase()));
    const available = [...local, ...BUNDLED_PLUGINS.filter(p => !localFiles.has(p.file.toLowerCase()))];
    const files = new Set(available.map(p => p.file.toLowerCase()));
    const subscribed = (this.state.pluginFeeds || []).flatMap(feed => feed.packages.filter(p => p.section === 'macros'));
    return [...available, ...CATALOG.filter(p => !files.has(p.file.toLowerCase())), ...subscribed];
  }
  sources() { return { ...SOURCES, ...(this.state.releaseSources || {}) }; }
  snapshot() { return { ...structuredClone(this.state), root: this.root, versionsRoot: path.join(this.root, 'versions'), cacheRoot: path.join(this.root, 'cache'), running: [...this.running.keys()], catalog: this.catalog(), sources: this.sources(), localVersions: structuredClone(this.localVersions || []), localScan: this.localScan || null }; }
  save() { return writeJSON(path.join(this.root, 'state.json'), this.state); }
  instance(id) { const v = this.state.instances.find(v => v.id === id); if (!v) throw new Error('找不到该实例'); return v; }
  dir(v) { return inside(path.join(this.root, 'versions'), path.join(this.root, 'versions', v.folder || v.id)); }
  appDir(v) { return inside(this.dir(v), path.join(this.dir(v), v.exe)); }
  pluginPath(v, plugin, enabled = plugin.enabled) {
    const dir = path.dirname(this.appDir(v));
    if (plugin.relativePath) return inside(dir, path.join(dir, enabled ? plugin.relativePath : plugin.disabledPath));
    return inside(dir, path.join(dir, 'automation', 'launcher', enabled ? (plugin.kind === 'include' ? 'include' : 'autoload') : 'disabled', plugin.file));
  }
  async scanInstance(v) {
    const root = path.dirname(this.appDir(v));
    const previous = JSON.stringify(v.plugins);
    const records = [];
    for (const p of v.plugins || []) if (await exists(this.pluginPath(v, p))) records.push(p);
    const indexed = new Map(records.map(p => [path.resolve(this.pluginPath(v, p)).toLowerCase(), p]));
    const inspect = async (dir, kind, recursive) => {
      if (!await exists(dir)) return;
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, ent.name);
        if (ent.isDirectory() && recursive) { await inspect(file, kind, recursive); continue; }
        if (!ent.isFile() || !/\.(lua|moon)$/i.test(ent.name)) continue;
        if ((await fs.stat(file)).size > 10 * 1024 ** 2) continue;
        const key = path.resolve(file).toLowerCase();
        let p = indexed.get(key);
        if (!p) {
          const id = crypto.randomUUID();
          p = { id, file: ent.name, kind, enabled: true, imported: true, relativePath: path.relative(root, file), disabledPath: path.join('automation', 'launcher', 'disabled', `${id}-${ent.name}`), installed: null, url: null, catalogId: CATALOG.find(c => c.file.toLowerCase() === ent.name.toLowerCase())?.id || null };
          records.push(p); indexed.set(key, p);
        }
        const body = await fs.readFile(file, 'utf8');
        const field = name => body.match(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?${name}\\s*=\\s*["']([^"'\\r\\n]+)`))?.[1];
        p.name = field('script_name') || p.name || ent.name;
        p.version = field('script_version') || p.version || '未声明';
        p.author = field('script_author') || p.author || '';
        p.description = field('script_description') || p.description || '';
        p.namespace = field('script_namespace') || p.namespace;
      }
    };
    for (const [dir, kind, recursive] of [['automation/autoload', 'autoload', false], ['automation/launcher/autoload', 'autoload', false], ['automation/include', 'include', true], ['automation/launcher/include', 'include', true]]) await inspect(path.join(root, dir), kind, recursive);
    v.plugins = records;
    return previous !== JSON.stringify(records);
  }
  async scanPlugins(id) {
    let changed = false;
    for (const v of id ? [this.instance(id)] : this.state.instances) if (await this.scanInstance(v)) changed = true;
    if (changed) await this.save();
    return this.snapshot();
  }
  ensureStopped(id) { if (this.running.has(id)) throw new Error('请先关闭该实例的 Aegisub，再修改配置或插件'); }
  async mutate(fn, { wait = false } = {}) {
    while (this.busy) {
      if (!wait) throw new Error('已有任务正在进行，请稍后再试');
      await new Promise(resolve => (this.idleWaiters ||= []).push(resolve));
    }
    this.busy = true;
    this.abort = new AbortController();
    try { return await fn(); } finally { this.busy = false; this.abort = null; for (const resolve of this.idleWaiters?.splice(0) || []) resolve(); }
  }
  async portable(exe) {
    const dir = path.dirname(exe), configFile = path.join(dir, 'config.json');
    let config = {};
    if (await exists(configFile)) {
      const errors = [];
      config = parseJSONC(await fs.readFile(configFile, 'utf8'), errors, { allowTrailingComma: true, disallowComments: false });
      if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Aegisub 配置无法读取：${errors.length ? printParseErrorCode(errors[0].error) : '配置必须是对象'}`);
    }
    config.App = { Language: 'zh_CN', ...config.App, 'Local Config': true };
    config.Path = { ...config.Path,
      Dictionary: '?user/dictionaries',
      Auto: { Backup: '?user/autoback', Save: '?user/autosave' },
      Automation: { Base: '?data/automation/', Autoload: '?user/automation/launcher/autoload/|?data/automation/autoload/', Include: '?data/automation/include/|?user/automation/launcher/include/' }
    };
    await writeJSON(configFile, config);
    for (const name of ['autoload', 'include', 'disabled']) await fs.mkdir(path.join(dir, 'automation', 'launcher', name), { recursive: true });
  }
  async pickExecutable(candidates, root, preferredExe, sameDirectory = false) {
    if (preferredExe) {
      const preferred = inside(root, path.resolve(root, preferredExe));
      if (!await exists(preferred)) throw new Error('原实例的启动文件不存在');
      return validateExecutable(root, preferred, sameDirectory);
    }
    if (!candidates.length) {
      if (!this.browseExecutable) throw new Error('没有找到 Aegisub 可执行文件，请选择完整的便携版目录或 ZIP');
      if (this.abort?.signal.aborted) throw cancelledExecutableSelection();
      const selected = await this.browseExecutable(root, { sameDirectory });
      if (!selected || this.abort?.signal.aborted) throw cancelledExecutableSelection();
      return validateExecutable(root, selected, sameDirectory);
    }
    if (candidates.length === 1) return candidates[0];
    if (!this.chooseExecutable) throw new Error('目录包含多个 Aegisub，请明确选择要启动的版本');
    const selected = await this.chooseExecutable(candidates.map(c => ({ ...c, relative: path.relative(root, c.path) })));
    if (!selected || this.abort?.signal.aborted) throw cancelledExecutableSelection();
    const result = candidates.find(c => c.path === selected);
    if (!result) throw new Error('选择的启动文件无效');
    return result;
  }
  async create({ name, version = '本地版本', source = 'local', populate, plugins = [], preferredExe }) {
    if (!name?.trim() || name.length > 80) throw new Error('实例名称需要 1–80 个字符');
    const id = crypto.randomUUID(), baseName = folderName(name);
    let folder = baseName, suffix = 2;
    while (await exists(path.join(this.root, 'versions', folder))) folder = `${baseName}-${suffix++}`;
    const dest = inside(path.join(this.root, 'versions'), path.join(this.root, 'versions', folder));
    await fs.mkdir(dest);
    try {
      await populate(dest);
      const chosen = await this.pickExecutable(await findExecutables(dest), dest, preferredExe);
      const exe = chosen.path;
      await this.portable(exe);
      const item = { id, folder, name: name.trim(), version: source === 'local' ? chosen.version || version : version, executableVersion: chosen.version, source, exe: path.relative(dest, exe), plugins: structuredClone(plugins), created: new Date().toISOString(), lastLaunch: null };
      await this.scanInstance(item);
      const previousSelected = this.state.selected;
      this.state.instances.push(item); this.state.selected = id;
      try { await this.save(); } catch (e) { this.state.instances.pop(); this.state.selected = previousSelected; throw e; }
      return this.snapshot();
    } catch (e) { await fs.rm(dest, { recursive: true, force: true }); throw e; }
  }
  async releases(source) {
    const info = this.sources()[source]; if (!info) throw new Error('未知发布源');
    const r = await this.fetcher(`https://api.github.com/repos/${info.repo}/releases?per_page=30`, { headers: { 'User-Agent': 'PCLAeg/0.1', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`无法获取版本：HTTP ${r.status}，请检查网络或稍后重试`);
    return (await r.json()).filter(v => !v.draft).map(v => ({ tag: v.tag_name, name: v.name || v.tag_name, prerelease: v.prerelease, date: v.published_at, url: v.html_url, assets: v.assets.filter(a => /\.zip$/i.test(a.name) && /portable|windows|win64|x64|x86_64/i.test(a.name) && !/arm64|win32|x86(?!_64)|macos|darwin|linux|ubuntu|installer|setup|source/i.test(a.name)).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest })) })).filter(v => v.assets.length);
  }
  async installRelease(source, tag, assetName, name) {
    const releases = await this.releases(source);
    const asset = releases.find(r => r.tag === tag)?.assets.find(a => a.name === assetName);
    if (!asset) throw new Error('该下载项已变更，请刷新版本列表');
    return this.create({ name, source, version: tag, populate: async dest => {
      const temp = path.join(this.root, 'cache', 'downloads', crypto.randomUUID() + '.zip');
      try {
      this.progress({ label: `下载 ${tag}`, percent: 0 });
      await download(asset.url, temp, p => this.progress({ label: p.retry ? `连接中断，正在续传 ${tag}（${p.retry}/3）` : `下载 ${tag}`, ...p }), 1024 ** 3, this.fetcher, this.abort?.signal);
      if (asset.digest?.startsWith('sha256:')) {
        const hash = crypto.createHash('sha256').update(await fs.readFile(temp)).digest('hex');
        if (hash !== asset.digest.slice(7)) throw new Error('下载文件校验失败');
      }
      this.progress({ label: '正在解压并配置独立环境…', percent: null });
      await extractVersionZip(temp, dest); await fs.unlink(temp);
      } finally { await fs.rm(temp, { force: true }); }
    } });
  }
  async importVersion(input, name) {
    const stat = await fs.lstat(input);
    if (stat.isSymbolicLink()) throw new Error('请选择真实目录或文件');
    if (stat.isDirectory()) {
      const rel = path.relative(input, this.root);
      if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('不能导入包含管理工具数据的目录');
      return this.create({ name, populate: dest => fs.cp(input, dest, { recursive: true, filter: async src => !(await fs.lstat(src)).isSymbolicLink() }) });
    }
    if (!/\.zip$/i.test(input)) throw new Error('请选择便携版 ZIP 压缩包');
    return this.create({ name, populate: dest => extractVersionZip(input, dest) });
  }
  async clone(id, name) {
    this.ensureStopped(id); const v = this.instance(id);
    return this.create({ name, version: v.version, source: v.source, plugins: v.plugins, preferredExe: v.exe, populate: dest => fs.cp(this.dir(v), dest, { recursive: true, filter: async src => !(await fs.lstat(src)).isSymbolicLink() }) });
  }
  async changeExecutable(id) {
    this.ensureStopped(id);
    const v = this.instance(id), folder = path.dirname(this.appDir(v));
    const chosen = await this.pickExecutable(await findExecutables(folder, 0, 0), folder, undefined, true);
    await this.portable(chosen.path);
    v.exe = path.relative(this.dir(v), chosen.path);
    v.executableVersion = chosen.version;
    v.version = chosen.version || v.version;
    await this.save(); return this.snapshot();
  }
  async select(id) { this.instance(id); this.state.selected = id; await this.save(); return this.snapshot(); }
  async rename(id, name) {
    if (!name?.trim() || name.length > 80) throw new Error('实例名称需要 1–80 个字符');
    this.instance(id).name = name.trim(); await this.save(); return this.snapshot();
  }
  async remove(id) {
    this.ensureStopped(id); const v = this.instance(id);
    const target = this.dir(v);
    await fs.rm(target, { recursive: true, force: true });
    const backupsRoot = path.join(this.root, 'cache', 'plugin-dependency-backups');
    await fs.rm(inside(backupsRoot, path.join(backupsRoot, v.id)), { recursive: true, force: true });
    this.state.instances = this.state.instances.filter(v => v.id !== id);
    if (this.state.selected === id) this.state.selected = this.state.instances[0]?.id || null;
    await this.save(); return this.snapshot();
  }
  async launch(id, files = []) {
    const v = this.instance(id);
    if (!Array.isArray(files) || files.length > 16) throw new Error('字幕文件列表无效');
    for (const file of files) if (typeof file !== 'string' || !/\.(ass|ssa)$/i.test(file) || !(await fs.stat(file)).isFile()) throw new Error('请选择有效的 ASS / SSA 字幕文件');
    if (!files.length) this.ensureStopped(id);
    const exe = this.appDir(v);
    if (!this.running.has(id)) {
      await this.repairLocalDependencies(v); await this.repairMotionCompatibility(v); await this.portable(exe);
    }
    const child = (this.spawnProcess || spawn)(exe, files.map(file => path.resolve(file)), { cwd: path.dirname(exe), detached: false, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    this.running.set(id, child);
    this.runningChildren ||= new Map();
    const children = this.runningChildren.get(id) || new Set(); children.add(child); this.runningChildren.set(id, children);
    child.once('exit', () => { children.delete(child); if (!children.size) { this.running.delete(id); this.runningChildren.delete(id); } else this.running.set(id, children.values().next().value); this.progress({ label: `${v.name} 已关闭`, stateChanged: true }); });
    v.lastLaunch = new Date().toISOString(); await this.save(); return this.snapshot();
  }
  async addPlugin(id, { catalogId, file, url, kind = 'autoload' }) {
    this.ensureStopped(id); const v = this.instance(id);
    const entry = catalogId ? this.catalog().find(p => p.id === catalogId) : null;
    if (catalogId && !entry) throw new Error('插件不存在');
    if (entry?.depctrl) return this.installFeedPlugin(id, entry);
    if (entry?.sourceInstanceId || entry?.bundled) return this.installLocalPlugin(id, entry);
    const filename = scriptName(entry?.file || (file ? path.basename(file) : decodeURIComponent(path.basename(new URL(url).pathname))));
    if (!['autoload', 'include'].includes(kind)) throw new Error('插件类型无效');
    const old = v.plugins.find(p => p.file.toLowerCase() === filename.toLowerCase() && p.kind === kind);
    if (entry?.sourcePlugin && old && old.catalogId !== entry.id) throw new Error('当前版本已有同名脚本，请先卸载后再从此源安装');
    if (old && !old.enabled) throw new Error('该插件已禁用，请先启用后再更新');
    const plugin = { ...old, id: old?.id || crypto.randomUUID(), name: entry?.name || filename, file: filename, enabled: true, kind: old?.kind || kind, catalogId: entry?.id || null, url: entry?.url || url || null, installed: new Date().toISOString() };
    if (entry?.sourcePlugin) Object.assign(plugin, { feedUrl: entry.feedUrl, feedType: (this.state.pluginFeeds || []).find(f => f.url === entry.feedUrl)?.requestedType || entry.feedType, sourcePlugin: true });
    const dest = this.pluginPath(v, plugin);
    if (!old && await exists(dest)) throw new Error('已有同名文件，请先在插件目录中处理');
    const temp = dest + '.' + crypto.randomUUID() + '.tmp';
    try {
      if (file) { if ((await fs.stat(file)).size > 10 * 1024 ** 2) throw new Error('脚本超过 10 MB'); await fs.copyFile(file, temp); }
      else await download(entry?.url || url, temp, p => this.progress({ label: `下载 ${plugin.name}`, ...p }), 10 * 1024 ** 2, this.fetcher, this.abort?.signal);
      const bytes = await fs.readFile(temp), body = bytes.toString('utf8');
      if (/^\s*<!doctype|^\s*<html/i.test(body)) throw new Error('下载到了网页，请使用脚本文件的原始链接');
      const version = body.match(/script_version\s*=\s*["']([^"']+)/)?.[1];
      plugin.version = version || '未声明';
      plugin.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (entry?.sha256 && plugin.sha256 !== entry.sha256) throw new Error('插件文件 SHA-256 校验失败');
      if (entry?.gitBlobSha && crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.gitBlobSha) throw new Error('GitHub 脚本内容校验失败，请刷新插件源');
      await fs.rename(temp, dest);
      if (old) v.plugins[v.plugins.indexOf(old)] = plugin; else v.plugins.push(plugin);
      await this.save(); return this.snapshot();
    } finally { await fs.rm(temp, { force: true }); }
  }
  async readPluginSource(url, type = 'auto', discovery = false) {
    const read = async remoteUrl => {
      const temp = path.join(this.root, 'cache', 'downloads', crypto.randomUUID());
      const timeout = discovery ? AbortSignal.timeout(20000) : null;
      const signal = timeout ? this.abort?.signal ? AbortSignal.any([this.abort.signal, timeout]) : timeout : this.abort?.signal;
      try {
        await download(remoteUrl, temp, p => this.progress({ label: discovery ? '正在发现关联源…' : '正在识别插件源…', ...p }), 10 * 1024 ** 2, this.fetcher, signal);
        return await fs.readFile(temp, 'utf8');
      } catch (error) { if (timeout?.aborted && !this.abort?.signal.aborted) throw new Error('关联源读取超时'); error.status = Number(error.message.match(/HTTP (\d+)/)?.[1]) || null; throw error; }
      finally { await fs.rm(temp, { force: true }); }
    };
    return loadSource(url, type, read);
  }
  updateDiscoveredFeeds() {
    const subscriptions = this.state.pluginFeeds || [], cache = this.state.feedDiscoveryCache || [];
    const subscribed = new Set(subscriptions.flatMap(f => [f.url, f.manifestUrl].filter(Boolean)));
    const records = new Map([...cache, ...subscriptions].flatMap(f => [f.url, f.manifestUrl].filter(Boolean).map(url => [url, f])));
    const queue = [...subscriptions], expanded = new Set(), candidates = new Map();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const parent = queue[cursor];
      if (expanded.has(parent.url)) continue;
      expanded.add(parent.url);
      for (const reference of parent.knownFeeds || []) {
        const cached = records.get(reference.url);
        if (!subscribed.has(reference.url) && !subscribed.has(cached?.url) && !subscribed.has(cached?.manifestUrl)) {
          const candidateUrl = cached?.url || reference.url;
          let candidate = candidates.get(candidateUrl);
          if (!candidate) { candidate = { ...reference, url: candidateUrl, name: cached?.name || reference.name, type: cached?.type, error: cached?.error || null, discoveredFrom: [] }; candidates.set(candidateUrl, candidate); }
          if (!candidate.discoveredFrom.includes(parent.url)) candidate.discoveredFrom.push(parent.url);
        }
        if (cached && !cached.error) queue.push(cached);
      }
    }
    this.state.discoveredFeeds = [...candidates.values()];
  }
  async addPluginFeed(url, type = 'auto') {
    url = sourceUrl(url.trim());
    const feed = await this.readPluginSource(url, type);
    this.state.pluginFeeds = [...(this.state.pluginFeeds || []).filter(f => f.url !== url), feed];
    this.state.feedDiscoveryCache = [...(this.state.feedDiscoveryCache || []).filter(f => f.url !== url), { url: feed.url, manifestUrl: feed.manifestUrl, name: feed.name, type: feed.type, knownFeeds: feed.knownFeeds, error: null }];
    this.updateDiscoveredFeeds();
    await this.save(); return this.snapshot();
  }
  async discoverPluginFeeds() {
    const subscriptions = [];
    let requested = 0, limitReached = false;
    for (const current of this.state.pluginFeeds || []) {
      if (this.abort?.signal.aborted) throw new Error('发现已取消');
      if (requested >= 32) { subscriptions.push(current); limitReached = true; continue; }
      requested++;
      try { subscriptions.push(await this.readPluginSource(current.url, current.requestedType || 'auto', true)); }
      catch (error) { if (this.abort?.signal.aborted) throw new Error('发现已取消'); subscriptions.push({ ...current, discoveryError: error.message }); }
    }
    const records = new Map(subscriptions.flatMap(f => [f.url, f.manifestUrl].filter(Boolean).map(url => [url, f])));
    const visited = new Set(records.keys()), queue = subscriptions.map(feed => ({ feed, depth: 0 }));
    const cache = new Map((this.state.feedDiscoveryCache || []).map(f => [f.url, f]));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (this.abort?.signal.aborted) throw new Error('发现已取消');
      const { feed, depth } = queue[cursor];
      for (const reference of feed.knownFeeds || []) {
        if (visited.has(reference.url)) continue;
        if (depth >= 4 || requested >= 32) { limitReached = true; continue; }
        visited.add(reference.url); requested++;
        this.progress({ label: `发现关联源（${requested}/32）：${reference.name}`, percent: null });
        try {
          const linked = records.get(reference.url) || await this.readPluginSource(reference.url, 'auto', true);
          const metadata = { url: linked.url, manifestUrl: linked.manifestUrl, name: linked.name, type: linked.type, knownFeeds: linked.knownFeeds || [], error: null };
          cache.set(linked.url, metadata); records.set(linked.url, metadata);
          if (linked.manifestUrl) { visited.add(linked.manifestUrl); records.set(linked.manifestUrl, metadata); }
          queue.push({ feed: metadata, depth: depth + 1 });
        } catch (error) {
          if (this.abort?.signal.aborted) throw new Error('发现已取消');
          cache.set(reference.url, { ...reference, knownFeeds: [], error: error.message });
        }
      }
    }
    this.state.feedDiscoveryCache = [...cache.values()];
    this.state.pluginFeeds = subscriptions;
    this.updateDiscoveredFeeds();
    this.state.feedDiscoveryStatus = { requested, limitReached };
    await this.save(); return this.snapshot();
  }
  async removePluginFeed(url) {
    this.state.pluginFeeds = (this.state.pluginFeeds || []).filter(feed => feed.url !== url);
    this.updateDiscoveredFeeds();
    await this.save(); return this.snapshot();
  }
  async installFeedPlugin(id, entry) {
    this.ensureStopped(id);
    const v = this.instance(id), root = path.dirname(this.appDir(v));
    const old = v.plugins.find(p => p.kind === 'autoload' && p.file.toLowerCase() === entry.file.toLowerCase());
    if (old && (!old.depctrl || old.namespace !== entry.namespace)) throw new Error('当前版本已有同名脚本，请先卸载后再从此源安装');
    if (old && !old.enabled) throw new Error('该插件已禁用，请先启用后再更新');
    const temp = path.join(this.root, 'cache', 'downloads', crypto.randomUUID());
    await fs.mkdir(temp);
    const created = [], backups = [], records = structuredClone(v.plugins);
    const configFile = inside(root, path.join(root, 'config', 'l0.DependencyControl.json'));
    let originalConfig;
    try {
      if (await exists(configFile)) originalConfig = await fs.readFile(configFile);
      const errors = [];
      const config = originalConfig ? parseJSONC(originalConfig.toString('utf8'), errors, { allowTrailingComma: true }) : {};
      if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error('DependencyControl 配置无法读取，请先修复配置');
      for (const [index, file] of entry.files.entries()) {
        const staged = path.join(temp, String(index));
        await download(file.url, staged, p => this.progress({ label: `下载 ${entry.name} (${index + 1}/${entry.files.length})`, ...p }), 10 * 1024 ** 2, this.fetcher, this.abort?.signal);
        const body = await fs.readFile(staged);
        if (file.sha1 && crypto.createHash('sha1').update(body).digest('hex') !== file.sha1) throw new Error(`插件文件 SHA-1 校验失败：${file.relative}`);
        if (/^\s*<!doctype|^\s*<html/i.test(body.toString('utf8', 0, 128))) throw new Error('下载到了网页，请检查插件源');
        const dest = inside(root, path.join(root, 'automation', 'autoload', file.relative));
        if (await exists(dest) && !(old?.packageFiles || []).includes(path.relative(root, dest))) throw new Error(`已有同名文件：${file.relative}`);
      }
      // Supply DependencyControl and its native/runtime dependencies without overwriting existing modules.
      const copyMissing = async (from, relative = '') => {
        for (const ent of await fs.readdir(from, { withFileTypes: true })) {
          const input = path.join(from, ent.name), rel = path.join(relative, ent.name);
          if (ent.isDirectory()) { await copyMissing(input, rel); continue; }
          if (!ent.isFile()) continue;
          if (!/^(l0[\\/]DependencyControl(?:[\\/.]|$)|l0[\\/]dkjson(?:[\\/.]|$)|lfs\.lua$)/i.test(rel)) continue;
          const dest = inside(root, path.join(root, 'automation', 'include', rel));
          const managed = inside(root, path.join(root, 'automation', 'launcher', 'include', rel));
          if (await exists(dest) || await exists(managed)) continue;
          if (/\.(lua|moon)$/i.test(rel)) { const alternate = rel.replace(/\.(lua|moon)$/i, /\.lua$/i.test(rel) ? '.moon' : '.lua'); if (await exists(path.join(root, 'automation/include', alternate)) || await exists(path.join(root, 'automation/launcher/include', alternate))) continue; }
          await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(input, dest); created.push(dest);
        }
      };
      for (const rel of ['automation/include', 'automation/launcher/include']) if (await exists(path.join(BUNDLED_ROOT, rel))) await copyMissing(path.join(BUNDLED_ROOT, rel));
      const packageFiles = [];
      for (const [index, file] of entry.files.entries()) {
        const dest = inside(root, path.join(root, 'automation', 'autoload', file.relative));
        if (await exists(dest)) { const backup = path.join(temp, `backup-${index}`); await fs.copyFile(dest, backup); backups.push({ dest, backup }); }
        else created.push(dest);
        await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(path.join(temp, String(index)), dest);
        packageFiles.push(path.relative(root, dest));
      }
      for (const previous of old?.packageFiles || []) if (!packageFiles.includes(previous)) {
        const dest = inside(root, path.join(root, previous));
        if (await exists(dest)) { const backup = path.join(temp, `obsolete-${backups.length}`); await fs.copyFile(dest, backup); backups.push({ dest, backup }); await fs.rm(dest); }
      }
      config.config ||= {};
      if (config.$schema) {
        config.config.feeds ||= {}; config.config.feeds.extraFeeds = [...new Set([...(config.config.feeds.extraFeeds || []), entry.feedUrl])];
      } else config.config.extraFeeds = [...new Set([...(config.config.extraFeeds || []), entry.feedUrl])];
      config.macros ||= {}; config.macros[entry.namespace] = { ...config.macros[entry.namespace], userFeed: entry.feedUrl };
      await writeJSON(configFile, config);
      await this.scanInstance(v);
      const plugin = v.plugins.find(p => p.relativePath === path.join('automation', 'autoload', entry.main));
      if (!plugin) throw new Error('源中的主脚本没有正确安装');
      Object.assign(plugin, { depctrl: true, namespace: entry.namespace, requiredModules: entry.requiredModules || [], feedUrl: entry.feedUrl, sourceUrl: entry.sourceUrl || entry.feedUrl, feedType: entry.feedType || 'auto', channel: entry.channel, catalogId: entry.id, version: entry.version, name: entry.name, author: entry.author, description: entry.description, packageFiles, installed: new Date().toISOString() });
      await this.save(); return this.snapshot();
    } catch (error) {
      v.plugins = records;
      for (const file of created.reverse()) await fs.rm(file, { force: true });
      for (const { dest, backup } of backups) await fs.copyFile(backup, dest);
      if (originalConfig) await fs.writeFile(configFile, originalConfig); else await fs.rm(configFile, { force: true });
      throw error;
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  async installLocalPlugin(id, entry) {
    this.ensureStopped(id);
    const target = this.instance(id), source = entry.bundled ? null : this.instance(entry.sourceInstanceId);
    const p = entry.bundled ? entry : source.plugins.find(p => p.id === entry.sourcePluginId);
    if (!p) throw new Error('源插件已不存在，请重新扫描');
    if (target.plugins.some(x => x.kind === 'autoload' && x.file.toLowerCase() === p.file.toLowerCase())) throw new Error('当前版本已安装这个脚本');
    const sourceRoot = entry.bundled ? BUNDLED_ROOT : path.dirname(this.appDir(source)), targetRoot = path.dirname(this.appDir(target));
    const created = [], oldRecords = structuredClone(target.plugins);
    try {
      const copyMissing = async (from, relative = '') => {
        if (!await exists(from)) return;
        for (const ent of await fs.readdir(from, { withFileTypes: true })) {
          const input = path.join(from, ent.name), rel = path.join(relative, ent.name);
          if (ent.isDirectory()) { await copyMissing(input, rel); continue; }
          if (!ent.isFile()) continue;
          const managed = inside(targetRoot, path.join(targetRoot, 'automation', 'launcher', 'include', rel));
          const bundled = inside(targetRoot, path.join(targetRoot, 'automation', 'include', rel));
          if (await exists(managed) || await exists(bundled)) continue;
          await fs.mkdir(path.dirname(bundled), { recursive: true });
          await fs.copyFile(input, bundled, require('node:fs').constants.COPYFILE_EXCL);
          created.push(bundled);
        }
      };
      this.progress({ label: `安装 ${p.name}，补齐缺少的依赖…`, percent: null });
      await copyMissing(path.join(sourceRoot, 'automation', 'include'));
      await copyMissing(path.join(sourceRoot, 'automation', 'launcher', 'include'));
      const plugin = { id: crypto.randomUUID(), name: p.name, file: p.file, kind: 'autoload', enabled: true, version: p.version, author: p.author, description: p.description, catalogId: entry.id, installed: new Date().toISOString(), url: null, copiedFrom: source?.name || '内置插件库', dependencyLayout: 'standard' };
      const dest = this.pluginPath(target, plugin);
      const sourceFile = entry.bundled ? inside(BUNDLED_ROOT, path.join(BUNDLED_ROOT, 'automation', 'autoload', p.file)) : this.pluginPath(source, p);
      await fs.copyFile(sourceFile, dest, require('node:fs').constants.COPYFILE_EXCL);
      created.push(dest); target.plugins.push(plugin);
      await this.repairMotionCompatibility(target);
      await this.scanInstance(target); await this.save();
      return this.snapshot();
    } catch (e) {
      target.plugins = oldRecords;
      for (const file of created.reverse()) await fs.rm(file, { force: true });
      throw e;
    }
  }
  async repairLocalDependencies(v) {
    const legacy = v.plugins.filter(p => p.copiedFrom && !p.dependencyLayout);
    if (!legacy.length) return;
    const root = path.dirname(this.appDir(v));
    for (const plugin of legacy) {
      const source = this.state.instances.find(x => x.name === plugin.copiedFrom);
      if (!source) continue;
      const sourceRoot = path.dirname(this.appDir(source));
      const visit = async (dir, relative = '') => {
        if (!await exists(dir)) return;
        for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
          const input = path.join(dir, ent.name), rel = path.join(relative, ent.name);
          if (ent.isDirectory()) { await visit(input, rel); continue; }
          if (!ent.isFile()) continue;
          const managed = inside(root, path.join(root, 'automation', 'launcher', 'include', rel));
          if (!await exists(managed)) continue;
          const record = v.plugins.find(p => path.resolve(this.pluginPath(v, p)) === managed);
          // Only migrate unchanged copies; preserve separately installed or edited modules.
          if (record && (!record.enabled || record.url || record.installed)) continue;
          if (!(await fs.readFile(input)).equals(await fs.readFile(managed))) continue;
          const standard = inside(root, path.join(root, 'automation', 'include', rel));
          if (await exists(standard)) {
            const backup = inside(this.root, path.join(this.root, 'cache', 'plugin-dependency-backups', v.id, crypto.randomUUID(), rel));
            await fs.mkdir(path.dirname(backup), { recursive: true });
            await fs.rename(managed, backup);
          } else {
            await fs.mkdir(path.dirname(standard), { recursive: true });
            await fs.rename(managed, standard);
            if (record) record.relativePath = path.relative(root, standard);
          }
        }
      };
      await visit(path.join(sourceRoot, 'automation', 'include'));
      await visit(path.join(sourceRoot, 'automation', 'launcher', 'include'));
      plugin.dependencyLayout = 'standard';
    }
    await this.scanInstance(v); await this.save();
  }
  async repairMotionCompatibility(v) {
    if (!v.plugins.some(p => p.kind === 'autoload' && p.enabled && p.file === 'a-mo.Aegisub-Motion.moon')) return;
    const root = path.dirname(this.appDir(v));
    for (const dir of ['automation/include', 'automation/launcher/include']) {
      const file = path.join(root, dir, 'a-mo', 'TrimHandler.moon');
      if (!await exists(file)) continue;
      const original = await fs.readFile(file, 'utf8');
      // A literal pattern must not use MoonScript's interpolating double quotes.
      const fixed = original.replace(/\\gsub\(\s*"#\{\(\.\-\)\}"/g, match => match.replace('"#{(.-)}"', "'#{(.-)}'"));
      if (fixed === original) continue;
      const backup = path.join(this.root, 'cache', 'plugin-dependency-backups', v.id, crypto.randomUUID(), 'TrimHandler.moon');
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(file, backup);
      await fs.writeFile(file, fixed);
    }
  }
  async togglePlugin(id, pluginId) {
    this.ensureStopped(id); const v = this.instance(id), p = v.plugins.find(p => p.id === pluginId);
    if (!p) throw new Error('插件不存在');
    const target = this.pluginPath(v, p, !p.enabled);
    if (await exists(target)) throw new Error('目标目录存在同名文件');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(this.pluginPath(v, p), target);
    p.enabled = !p.enabled; await this.save(); return this.snapshot();
  }
  async removePlugin(id, pluginId) {
    this.ensureStopped(id); const v = this.instance(id), p = v.plugins.find(p => p.id === pluginId);
    if (!p) throw new Error('插件不存在');
    await fs.rm(this.pluginPath(v, p), { force: true });
    for (const file of p.packageFiles || []) await fs.rm(inside(path.dirname(this.appDir(v)), path.join(path.dirname(this.appDir(v)), file)), { force: true });
    v.plugins = v.plugins.filter(x => x.id !== pluginId); await this.save(); return this.snapshot();
  }
}
require('./profiles.cjs').extend(Manager, { inside, exists, writeJSON });
require('./dependencies.cjs').extend(Manager, { inside, exists, writeJSON, download, BUNDLED_ROOT });
require('./platform.cjs').extend(Manager, { inside, exists, writeJSON, executableVersion });
module.exports = { Manager, CATALOG, SOURCES, inside, safeEntry, extractZip, download, findExecutables, executableVersion };
