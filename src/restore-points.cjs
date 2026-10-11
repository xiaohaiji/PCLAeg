const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const PROFILE_PATHS = ['config.json', 'hotkey.json', 'automation', 'config', 'dictionaries'];

function childPath(root, relative) {
  const target = path.resolve(root, relative), rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('备份路径越界');
  return target;
}

async function backupInventory(root, io = fs) {
  const result = [];
  const visit = async (file, relative) => {
    const stat = await io.lstat(file);
    if (stat.isSymbolicLink()) throw new Error('备份包含链接');
    if (stat.isDirectory()) {
      if (relative) result.push({ path: relative, type: 'directory' });
      for (const name of (await io.readdir(file)).sort()) await visit(path.join(file, name), relative ? relative + '/' + name : name);
    } else if (stat.isFile()) result.push({ path: relative, type: 'file', sha256: crypto.createHash('sha256').update(await io.readFile(file)).digest('hex') });
    else throw new Error('备份包含不支持的文件');
  };
  await visit(root, '');
  return result;
}

async function validateRestorePoint(root, point, io = fs) {
  try {
    if (!/^[a-f\d-]{36}$/i.test(point?.id || '') || !Array.isArray(point.records) || !point.records.length) throw new Error('恢复点清单无效');
    const base = childPath(root, path.join('cache/restore-points', point.id));
    childPath(await io.realpath(root), path.relative(await io.realpath(root), await io.realpath(base)));
    const stored = JSON.parse(await io.readFile(path.join(base, 'point.json'), 'utf8'));
    if (stored.id !== point.id || JSON.stringify(stored.records) !== JSON.stringify(point.records)) throw new Error('备份清单与索引不一致');
    const ids = new Set();
    for (const record of point.records) {
      if (typeof record.instanceId !== 'string' || !/^[\w-]+$/.test(record.instanceId) || ids.has(record.instanceId) || !Array.isArray(record.paths) || !Array.isArray(record.plugins)) throw new Error('恢复点实例清单无效');
      ids.add(record.instanceId);
      const recordRoot = childPath(base, record.instanceId), seen = new Set();
      for (const item of record.paths) {
        if (!PROFILE_PATHS.includes(item.relative) || seen.has(item.relative) || typeof item.present !== 'boolean') throw new Error('恢复点路径无效');
        seen.add(item.relative);
        if (item.present) await io.access(childPath(recordRoot, item.relative));
      }
      // Older points only describe top-level paths. New points also verify every file and empty directory.
      let actual = [];
      try { actual = await backupInventory(recordRoot, io); }
      catch (error) { if (error.code !== 'ENOENT' || record.paths.some(p => p.present)) throw error; }
      if (record.backupInventory && JSON.stringify(actual) !== JSON.stringify(record.backupInventory)) throw new Error('备份文件缺失或内容校验失败');
    }
    return true;
  } catch (error) { throw new Error(`恢复点「${point?.label || point?.id || '未知'}」不可用：${error.code === 'ENOENT' ? '备份文件缺失，请从原数据目录恢复备份后重新检查' : error.message}`); }
}
module.exports = { PROFILE_PATHS, childPath, backupInventory, validateRestorePoint };
