const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const AdmZip = require('adm-zip');
// Electron's patched fs treats .asar paths as virtual directories. Update
// archives contain a new physical app.asar, so extraction must bypass that layer.
const archiveFs = process.versions.electron ? require('original-fs') : require('node:fs');
const { safeEntry, download } = require('./core.cjs');
const REPO = 'xiaohaiji/PCLAeg';
const RUNTIME = new Set(['Aegisub Launcher.exe','locales','resources','docs','README.md','LICENSE','THIRD_PARTY_NOTICES.md','CHANGELOG.md','LICENSE.electron.txt','LICENSES.chromium.html','chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','vk_swiftshader_icd.json','vk_swiftshader.dll','vulkan-1.dll']);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function assetUrl(url) {
  const u = new URL(url);
  if (u.origin !== 'https://github.com' || !u.pathname.startsWith(`/${REPO}/releases/download/`)) throw new Error('更新链接不是官方发布资源');
  return u.href;
}
function selectRelease(release, current) {
  const version = semver.valid(String(release.tag_name || '').replace(/^v/, ''));
  if (!version || release.draft || release.prerelease || semver.prerelease(version)) throw new Error('没有可用的稳定更新');
  const name = `Aegisub-Launcher-${version}-Windows-x64.zip`;
  const asset = release.assets?.find(a => a.name === name);
  if (!asset) throw new Error('发布版本尚未提供 Windows x64 更新包，请稍后重试');
  const checksum = release.assets?.find(a => a.name === 'SHA256SUMS.txt');
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase();
  if (!digest && !checksum) throw new Error('更新包缺少 SHA-256 校验信息');
  return { version, available: semver.gt(version, current), name, url: assetUrl(asset.browser_download_url), digest, checksumUrl: checksum ? assetUrl(checksum.browser_download_url) : null, notes: String(release.body || '').slice(0, 6000), page: `https://github.com/${REPO}/releases/tag/v${version}` };
}
async function stageArchive(file, stage, version) {
  const zip = new AdmZip(file, { fs: archiveFs }), entries = zip.getEntries();
  if (entries.length > 10000) throw new Error('更新包文件数量异常');
  let total = 0;
  const seen = new Set();
  for (const e of entries) {
    safeEntry(e.entryName);
    const parts = e.entryName.split('/');
    if (parts[0] !== 'AegisubLauncher' || e.entryName.includes('\\') || (parts[1] && !RUNTIME.has(parts[1]) && parts[1] !== 'update-manifest.json')) throw new Error('更新包包含非程序文件');
    if (((e.header.attr >>> 16) & 0xf000) === 0xa000 || (total += e.header.size) > 2 * 1024 ** 3) throw new Error('更新包内容不安全或过大');
    const key = e.entryName.toLowerCase(); if (seen.has(key)) throw new Error('更新包包含重复路径'); seen.add(key);
  }
  const manifestEntry = zip.getEntry('AegisubLauncher/update-manifest.json');
  if (!manifestEntry) throw new Error('此版本不支持一键更新，请手动下载完整包');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  if (manifest.version !== version || manifest.schema !== 1 || !Array.isArray(manifest.files)) throw new Error('更新包版本或文件清单无效');
  const files = entries.filter(e => !e.isDirectory && e !== manifestEntry);
  if (files.length !== manifest.files.length) throw new Error('更新包文件清单不完整');
  const declared = new Set();
  for (const record of manifest.files) {
    safeEntry(record.path);
    if (!RUNTIME.has(record.path.split('/')[0]) || record.path.includes('\\') || declared.has(record.path.toLowerCase())) throw new Error('更新清单路径无效');
    declared.add(record.path.toLowerCase());
    const entry = zip.getEntry(`AegisubLauncher/${record.path}`);
    if (!entry || entry.isDirectory || !/^[a-f0-9]{64}$/i.test(record.sha256) || hash(entry.getData()) !== record.sha256.toLowerCase()) throw new Error('更新包文件校验失败');
  }
  if (!declared.has('aegisub launcher.exe') || !declared.has('resources/app.asar')) throw new Error('更新包缺少启动器程序');
  await fs.mkdir(stage, { recursive: true });
  zip.extractAllTo(stage, false);
  return [...new Set(manifest.files.map(f => f.path.split('/')[0]))];
}
class Updater {
  constructor({ current, root, launcherDir, fetcher = fetch, progress = () => {} }) { Object.assign(this, { current, root, launcherDir, fetcher, progress }); this.latest = null; }
  async check() {
    const r = await this.fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': `PCLAeg/${this.current}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`检查更新失败：HTTP ${r.status}`);
    this.latest = selectRelease(await r.json(), this.current); return this.latest;
  }
  async lastResult() {
    const folder = path.join(this.root, 'cache', 'launcher-updates');
    let jobs; try { jobs = await fs.readdir(folder); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const results = [];
    for (const job of jobs) {
      if (!/^[a-f0-9-]{36}$/.test(job)) continue;
      try {
        const file = path.join(folder, job, 'result.json');
        const data = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
        if (['installed','rolled-back','restore-failed'].includes(data.status)) results.push({ ...data, time: (await fs.stat(file)).mtimeMs });
      } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    }
    return results.sort((a,b) => b.time-a.time)[0] || null;
  }
  async prepare(signal) {
    const release = await this.check();
    if (!release.available) throw new Error('当前已经是最新版本');
    const job = path.join(this.root, 'cache', 'launcher-updates', crypto.randomUUID());
    await fs.mkdir(job, { recursive: true });
    try {
      let expected = release.digest;
      if (!expected) {
        const r = await this.fetcher(release.checksumUrl, { signal: signal || AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('无法获取更新校验文件');
        const body = await r.text(); if (body.length > 65536) throw new Error('校验文件异常');
        expected = body.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())).find(m => m?.[2] === release.name)?.[1]?.toLowerCase();
        if (!expected) throw new Error('未找到更新包校验值');
      }
      const file = path.join(job, 'package.zip');
      await download(release.url, file, p => this.progress({ label: `下载启动器 ${release.version}`, ...p }), 512 * 1024 ** 2, this.fetcher, signal);
      if (hash(await fs.readFile(file)) !== expected) throw new Error('更新包 SHA-256 校验失败，已停止更新');
      const names = await stageArchive(file, path.join(job, 'stage'), release.version);
      if (signal?.aborted) throw new Error('更新已取消');
      const target = await fs.realpath(this.launcherDir);
      for (const name of names) {
        try { if ((await fs.lstat(path.join(target, name))).isSymbolicLink()) throw new Error('程序目录存在链接，无法安全更新'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      await fs.access(target, require('node:fs').constants.W_OK);
      const plan = { schema: 1, version: release.version, pid: process.pid, target, stage: path.join(job, 'stage', 'AegisubLauncher'), backup: path.join(job, 'backup'), names, restart: true };
      const planFile = path.join(job, 'plan.json'); await fs.writeFile(planFile, JSON.stringify(plan));
      const worker = path.join(job, 'apply-update.ps1'); await fs.copyFile(path.join(__dirname, 'apply-update.ps1'), worker);
      return { job, planFile, worker, version: release.version };
    } catch (e) { await fs.rm(job, { recursive: true, force: true }); throw e; }
  }
}
module.exports = { Updater, selectRelease, stageArchive, RUNTIME, hash };
