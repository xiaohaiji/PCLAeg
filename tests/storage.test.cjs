const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveStorage, configureStorage, migrateLibrary, relocateLibrary } = require('../src/storage.cjs');
const { Manager } = require('../src/core.cjs');

test('packaged storage follows the launcher EXE, including a self-extracting launcher', () => {
  const result = resolveStorage({ packaged: true, executable: 'C:/Temp/random/Aegisub Launcher.exe', portableDir: 'E:/Downloads/PCLAeg' });
  assert.equal(result.root, path.resolve('E:/Downloads/PCLAeg'));
  const direct = resolveStorage({ packaged: true, executable: 'D:/Tools/PCLAeg/Aegisub Launcher.exe' });
  assert.equal(direct.root, path.resolve('D:/Tools/PCLAeg'));
});
test('runtime, browser, crash and temporary paths all stay under selected cache root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pclaeg-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldTemp = process.env.TEMP, oldTmp = process.env.TMP;
  const configured = {};
  try {
    configureStorage({ setPath: (name, target) => configured[name] = target, commandLine: { appendSwitch: (name, target) => configured[name] = target } }, root);
    for (const target of Object.values(configured)) assert.equal(path.relative(path.join(root, 'cache'), target).startsWith('..'), false);
    assert.equal(process.env.TEMP, path.join(root, 'cache', 'temp'));
  } finally {
    if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp;
    if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp;
  }
});
test('legacy version records migrate to readable versions folders with config and selection intact', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pclaeg-migrate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'legacy'), dest = path.join(root, 'new');
  await fs.mkdir(path.join(old, 'instances', 'test-uuid'), { recursive: true });
  await fs.writeFile(path.join(old, 'instances', 'test-uuid', 'aegisub.exe'), 'fixture');
  await fs.writeFile(path.join(old, 'instances', 'test-uuid', 'config.json'), '{"App":{"Language":"zh_CN"}}');
  await fs.writeFile(path.join(old, 'state.json'), JSON.stringify({ selected: 'test-uuid', instances: [{ id: 'test-uuid', name: '9820', exe: 'aegisub.exe', plugins: [] }] }));
  await migrateLibrary(dest, [old]);
  const manager = new Manager(dest); await manager.init();
  assert.equal(manager.state.selected, 'test-uuid');
  const v = manager.instance('test-uuid');
  assert.match(manager.dir(v), /versions[\\/]9820-/);
  assert.equal(await fs.readFile(path.join(manager.dir(v), 'config.json'), 'utf8'), '{"App":{"Language":"zh_CN"}}');
  assert.equal(await fs.readFile(path.join(old, 'instances', 'test-uuid', 'aegisub.exe'), 'utf8'), 'fixture');
  await manager.init(); assert.equal(manager.state.instances.length, 1);
});
test('new versions use unique readable folder names', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pclaeg-folders-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new Manager(root); await manager.init();
  const populate = dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture');
  await manager.create({ name: '9820', populate });
  await manager.create({ name: '9820', populate });
  assert.deepEqual((await fs.readdir(path.join(root, 'versions'))).sort(), ['9820', '9820-2']);
});
test('data relocation preserves versions and selection, keeps backup and persists chosen root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pclaeg-relocate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'), next = path.join(root, 'new'), config = path.join(root, 'launcher-paths.json');
  const manager = new Manager(old); await manager.init();
  await manager.create({ name: '9820', populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
  await relocateLibrary(old, next, config);
  const moved = new Manager(next); await moved.init();
  assert.equal(moved.state.selected, manager.state.selected);
  assert.equal(await fs.readFile(moved.appDir(moved.instance(moved.state.selected)), 'utf8'), 'fixture');
  assert.equal(await fs.readFile(manager.appDir(manager.instance(manager.state.selected)), 'utf8'), 'fixture');
  assert.equal(JSON.parse(await fs.readFile(config)).dataRoot, await fs.realpath(next));
  await assert.rejects(relocateLibrary(old, path.join(old, 'nested'), config), /内部/);
  await assert.rejects(relocateLibrary(old, next, config), /已有启动器数据/);
});
