const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Manager } = require('../src/core.cjs');
const { relocateLibrary, migrateLibrary } = require('../src/storage.cjs');

async function fixture(t) {
  const parent = path.resolve('.test-data'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'restore-relocation-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent)); await fs.rm(root, { recursive: true, force: true }); });
  const old = path.join(root, 'old'), next = path.join(root, 'new'), config = path.join(root, 'launcher-paths.json');
  const manager = new Manager(old); await manager.init();
  for (const name of ['First', 'Second']) await manager.create({ name, populate: dir => fs.writeFile(path.join(dir, 'aegisub.exe'), 'fixture') });
  const ids = manager.state.instances.map(v => v.id), dirs = ids.map(id => path.dirname(manager.appDir(manager.instance(id))));
  for (const dir of dirs) {
    await fs.writeFile(path.join(dir, 'hotkey.json'), 'before');
    await fs.mkdir(path.join(dir, 'automation/include'), { recursive: true });
    await fs.writeFile(path.join(dir, 'automation/include/helper.lua'), 'return {}');
  }
  await manager.profileTransaction(ids, 'Fixture backup', async () => { for (const dir of dirs) await fs.writeFile(path.join(dir, 'hotkey.json'), 'after'); });
  const point = manager.state.restorePoints[0];
  await fs.writeFile(config, JSON.stringify({ dataRoot: old }));
  return { root, old, next, config, manager, ids, dirs, point };
}

test('relocation preserves complete restore points and supports rollback after restart', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.old, 'cache/browser'), { recursive: true }); await fs.writeFile(path.join(f.old, 'cache/browser/transient'), 'skip');
  await relocateLibrary(f.old, f.next, f.config);
  const moved = new Manager(f.next); await moved.init();
  assert.equal(moved.state.restorePoints[0].backupError, undefined);
  await assert.rejects(fs.access(path.join(f.next, 'cache/browser/transient')), { code: 'ENOENT' });
  await moved.restoreProfile(f.point.id);
  for (const id of f.ids) assert.equal(await fs.readFile(path.join(path.dirname(moved.appDir(moved.instance(id))), 'hotkey.json'), 'utf8'), 'before');
  for (const dir of f.dirs) assert.equal(await fs.readFile(path.join(dir, 'hotkey.json'), 'utf8'), 'after');
});

test('legacy startup migration also carries restore payloads', async t => {
  const f = await fixture(t); await migrateLibrary(f.next, [f.old]);
  const moved = new Manager(f.next); await moved.init(); await moved.restoreProfile(f.point.id);
  assert.equal(await fs.readFile(path.join(path.dirname(moved.appDir(moved.instance(f.ids[0]))), 'hotkey.json'), 'utf8'), 'before');
});

for (const damage of ['missing-point', 'missing-file', 'changed-file']) test(`${damage} is detected before any target is changed`, async t => {
  const f = await fixture(t), base = path.join(f.old, 'cache/restore-points', f.point.id);
  if (damage === 'missing-point') await fs.unlink(path.join(base, 'point.json'));
  else {
    const file = path.join(base, f.ids[1], 'automation/include/helper.lua');
    if (damage === 'missing-file') await fs.unlink(file); else await fs.writeFile(file, 'corrupt');
  }
  const before = JSON.stringify(f.manager.state.instances), count = f.manager.state.restorePoints.length;
  await assert.rejects(f.manager.restoreProfile(f.point.id), /恢复点.*不可用/);
  assert.equal(JSON.stringify(f.manager.state.instances), before); assert.equal(f.manager.state.restorePoints.length, count);
  for (const dir of f.dirs) assert.equal(await fs.readFile(path.join(dir, 'hotkey.json'), 'utf8'), 'after');
  const restarted = new Manager(f.old); await restarted.init(); assert.match(restarted.state.restorePoints[0].backupError, /缺失|校验/);
  await assert.rejects(relocateLibrary(f.old, f.next, f.config), /恢复点.*不可用/);
  assert.equal(JSON.parse(await fs.readFile(f.config)).dataRoot, f.old);
});

for (const failure of ['copy', 'corrupt-copy', 'config']) test(`failed ${failure} leaves original selection and allows relocation retry`, async t => {
  const f = await fixture(t), original = await fs.readFile(f.config);
  const io = { ...fs,
    cp: async (...args) => {
      if (failure === 'copy' && args[0].endsWith('restore-points')) throw Error('copy failed');
      await fs.cp(...args);
      if (failure === 'corrupt-copy' && args[0].endsWith('restore-points')) await fs.writeFile(path.join(args[1], f.point.id, f.ids[0], 'hotkey.json'), 'corrupted copy');
    },
    rename: async (...args) => { if (failure === 'config' && args[1] === f.config) throw Error('config switch failed'); return fs.rename(...args); }
  };
  await assert.rejects(relocateLibrary(f.old, f.next, f.config, io), /failed|校验失败/);
  assert.deepEqual(await fs.readFile(f.config), original);
  await assert.rejects(fs.access(path.join(f.next, 'state.json')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(f.next)).some(name => name.startsWith('.pclaeg-migration-')), false);
  await relocateLibrary(f.old, f.next, f.config);
  assert.equal(JSON.parse(await fs.readFile(f.config)).dataRoot, await fs.realpath(f.next));
});

test('old points without per-file inventories remain restorable and repaired backups can be rechecked', async t => {
  const f = await fixture(t), file = path.join(f.old, 'cache/restore-points', f.point.id, 'point.json');
  for (const record of f.point.records) delete record.backupInventory;
  await fs.writeFile(file, JSON.stringify(f.point)); await f.manager.save();
  const saved = await fs.readFile(file); await fs.unlink(file);
  await f.manager.checkRestorePoints(); assert.ok(f.point.backupError);
  await fs.writeFile(file, saved); await f.manager.checkRestorePoints(); assert.equal(f.point.backupError, undefined);
  await f.manager.restoreProfile(f.point.id);
  assert.equal(await fs.readFile(path.join(f.dirs[0], 'hotkey.json'), 'utf8'), 'before');
});
