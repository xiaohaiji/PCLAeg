const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { childPath, backupInventory, validateRestorePoint } = require('./restore-points.cjs');
const LIBRARY_PATHS = ['instances', 'versions', 'trash', 'cache/restore-points'];
const present = async (io, file) => { try { await io.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function copyLibrary(source, target, io) {
  const state = JSON.parse(await io.readFile(path.join(source, 'state.json'), 'utf8'));
  for (const point of state.restorePoints || []) await validateRestorePoint(source, point, io);
  await io.mkdir(target, { recursive: true });
  for (const folder of LIBRARY_PATHS) {
    const from = childPath(source, folder), to = childPath(target, folder);
    if (!await present(io, from)) continue;
    await io.mkdir(path.dirname(to), { recursive: true });
    await io.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    if (folder === 'cache/restore-points' && JSON.stringify(await backupInventory(from, io)) !== JSON.stringify(await backupInventory(to, io))) throw new Error('迁移后的恢复点文件校验失败');
  }
  for (const point of state.restorePoints || []) await validateRestorePoint(target, point, io);
  await io.copyFile(path.join(source, 'state.json'), path.join(target, 'state.json'), fs.constants.COPYFILE_EXCL);
  return state;
}

function resolveStorage({ packaged, executable, portableDir, testRoot, projectRoot }) {
  const launcherDir = path.resolve(packaged ? portableDir || path.dirname(executable) : projectRoot);
  const configFile = path.join(launcherDir, 'launcher-paths.json');
  if (!packaged && testRoot) return { root: path.resolve(testRoot), launcherDir, configFile };
  let root = launcherDir;
  if (fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (typeof config.dataRoot !== 'string' || !config.dataRoot.trim()) throw new Error('launcher-paths.json 的 dataRoot 无效');
    root = path.resolve(launcherDir, config.dataRoot);
  }
  return { root, launcherDir, configFile };
}

function configureStorage(app, root) {
  const paths = {
    userData: path.join(root, 'cache', 'runtime'),
    sessionData: path.join(root, 'cache', 'browser'),
    crashDumps: path.join(root, 'cache', 'crashdumps'),
    temp: path.join(root, 'cache', 'temp')
  };
  for (const [name, dir] of Object.entries(paths)) { fs.mkdirSync(dir, { recursive: true }); app.setPath(name, dir); }
  app.commandLine.appendSwitch('disk-cache-dir', path.join(root, 'cache', 'browser', 'http'));
  process.env.TEMP = paths.temp;
  process.env.TMP = paths.temp;
}

async function migrateLibrary(root, legacyRoots) {
  const io = fs.promises;
  const target = path.join(root, 'state.json');
  if (fs.existsSync(target)) return;
  for (const legacy of legacyRoots) {
    if (path.resolve(legacy) === path.resolve(root) || !fs.existsSync(path.join(legacy, 'state.json'))) continue;
    const state = JSON.parse(await io.readFile(path.join(legacy, 'state.json'), 'utf8'));
    if (!state.instances?.length) continue;
    await copyLibrary(legacy, root, io);
    return;
  }
}
async function relocateLibrary(oldRoot, newRoot, configFile, io = fs.promises) {
  oldRoot = path.resolve(oldRoot); newRoot = path.resolve(newRoot);
  if (oldRoot === newRoot) return false;
  const relative = path.relative(oldRoot, newRoot);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('新目录不能位于当前数据目录内部');
  await io.mkdir(newRoot, { recursive: true });
  oldRoot = await io.realpath(oldRoot); newRoot = await io.realpath(newRoot);
  if (oldRoot.toLowerCase() === newRoot.toLowerCase()) return false;
  const actualRelative = path.relative(oldRoot, newRoot);
  if (!actualRelative.startsWith('..') && !path.isAbsolute(actualRelative)) throw new Error('新目录不能位于当前数据目录内部');
  if (await present(io, path.join(newRoot, 'state.json'))) throw new Error('所选目录已有启动器数据，请选择其他目录');
  const emptyDirectories = [];
  for (const name of LIBRARY_PATHS) {
    const dest = path.join(newRoot, name);
    let current = newRoot;
    for (const part of name.split('/')) { current = childPath(current, part); if (await present(io, current) && (await io.lstat(current)).isSymbolicLink()) throw new Error('目标数据目录包含链接，请选择其他位置'); }
    if (await present(io, dest)) {
      if ((await io.readdir(dest)).length) throw new Error('目标数据目录不是空目录，请选择其他位置');
      emptyDirectories.push(dest);
    }
  }
  const stage = await io.mkdtemp(childPath(newRoot, '.pclaeg-migration-'));
  const temp = configFile + '.' + crypto.randomUUID() + '.tmp', promoted = [];
  let cleanup = true;
  try {
    const state = await copyLibrary(oldRoot, stage, io);
    for (const v of state.instances || []) {
      const folder = v.folder || v.id;
      const base = await present(io, path.join(stage, 'versions', folder)) ? 'versions' : 'instances';
      await io.access(childPath(stage, path.join(base, folder, v.exe)));
    }
    for (const name of [...LIBRARY_PATHS, 'state.json']) {
      const from = childPath(stage, name), dest = childPath(newRoot, name);
      if (!await present(io, from)) continue;
      if (emptyDirectories.includes(dest)) await io.rmdir(dest);
      await io.mkdir(path.dirname(dest), { recursive: true });
      await io.rename(from, dest); promoted.push(name);
    }
    await io.writeFile(temp, JSON.stringify({ dataRoot: newRoot }, null, 2));
    await io.rename(temp, configFile);
    return true;
  } catch (error) {
    try {
      for (const name of promoted.reverse()) {
        await io.mkdir(path.dirname(childPath(stage, name)), { recursive: true });
        await io.rename(childPath(newRoot, name), childPath(stage, name));
      }
      for (const dir of emptyDirectories) await io.mkdir(dir, { recursive: true });
    } catch (rollbackError) { cleanup = false; throw new Error(`${error.message}；迁移暂存目录保留在 ${stage}：${rollbackError.message}`); }
    throw error;
  } finally {
    await io.rm(temp, { force: true }).catch(() => {});
    // Only remove this operation's verified staging directory, never either library root.
    if (cleanup) try { childPath(newRoot, path.relative(newRoot, await io.realpath(stage))); await io.rm(stage, { recursive: true, force: true }); } catch {}
  }
}
module.exports = { resolveStorage, configureStorage, migrateLibrary, relocateLibrary };
