const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Manager } = require('../src/core.cjs');
const url = 'https://example.com/favorites.json', script = 'https://example.com/favorite.lua';
const digest = body => crypto.createHash('sha256').update(body).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pclaeg-favorites-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let revision = 1, corrupt = false;
  const body = () => `script_name="Favorite"\nscript_version="1.0.${revision}"`;
  const fetcher = async address => address === url ? Response.json({ name: 'Favorites source', plugins: [{ file: 'favorite.lua', url: script, sha256: digest(body()) }] }) : new Response(corrupt ? 'bad bytes' : body());
  const manager = new Manager(root, () => {}, fetcher); await manager.init();
  for (const name of ['Source', 'Target']) await manager.create({ name, populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
  return { manager, id: manager.state.selected, fetcher, next: () => revision++, corrupt: () => corrupt = true };
}

test('favorites persist without instances and deduplicate catalog and installed entries', async t => {
  const { manager, id } = await fixture(t);
  const entry = manager.catalog().find(p => p.bundled);
  await manager.addFavorite({ catalogId: entry.id }); await manager.addFavorite({ catalogId: entry.id });
  await manager.addPlugin(id, { catalogId: entry.id });
  const plugin = manager.instance(id).plugins.find(p => p.catalogId === entry.id);
  await manager.addFavorite({ instanceId: id, pluginId: plugin.id });
  assert.equal(manager.state.favorites.length, 1);
  const restarted = new Manager(manager.root); await restarted.init();
  assert.equal(restarted.snapshot().instances.at(-1).plugins.find(p => p.id === plugin.id).favoriteId, manager.state.favorites[0].id);
  await restarted.remove(id); await restarted.remove(restarted.state.instances[0].id);
  assert.equal(restarted.snapshot().favoriteCatalog.length, 1);
  await restarted.removeFavorite(restarted.state.favorites[0].id);
  assert.equal(restarted.snapshot().favoriteCatalog.length, 0);
});

test('bulk installs only into target and skips already installed disabled plugins', async t => {
  const { manager, id } = await fixture(t), source = manager.state.instances[0];
  const entries = manager.catalog().filter(p => p.bundled).slice(0, 2);
  for (const entry of entries) await manager.addFavorite({ catalogId: entry.id });
  const ids = manager.state.favorites.map(f => f.id);
  const result = await manager.installFavorites(id, ids);
  assert.deepEqual(result.favoriteInstallResult, { installed: 2, skipped: 0 });
  assert.equal(source.plugins.length, 0);
  const plugin = manager.instance(id).plugins.find(p => p.catalogId === entries[0].id);
  await manager.togglePlugin(id, plugin.id);
  const retry = await manager.installFavorites(id, ids);
  assert.deepEqual(retry.favoriteInstallResult, { installed: 0, skipped: 2 });
  assert.equal(manager.instance(id).plugins.find(p => p.id === plugin.id).enabled, false);
});

test('unsubscribed favorites download fresh verified content without resubscribing', async t => {
  const f = await fixture(t), { manager, id } = f;
  await manager.addPluginFeed(url); const entry = manager.catalog().find(p => p.feedUrl === url);
  await manager.addFavorite({ catalogId: entry.id }); await manager.removePluginFeed(url); f.next();
  const restarted = new Manager(manager.root, () => {}, f.fetcher); await restarted.init();
  await restarted.installFavorites(id, restarted.state.favorites.map(f => f.id));
  assert.equal(restarted.state.pluginFeeds.length, 0);
  assert.equal(restarted.instance(id).plugins.find(p => p.file === 'favorite.lua').version, '1.0.2');
});

test('DC favorites retain identity after source removal and install declared dependencies', async t => {
  const { manager, id } = await fixture(t);
  const macro = 'script_name="Favorite DC"\nscript_namespace="test.Favorite"\nscript_version="1.0.0"';
  const helper = 'version="1.0.0"\nreturn {}';
  const sha1 = body => crypto.createHash('sha1').update(body).digest('hex');
  manager.fetcher = async address => address === url ? Response.json({ dependencyControlFeedFormatVersion: '0.4.0', macros: {
    'test.Favorite': { channels: { stable: { default: true, version: '1.0.0', requiredModules: [{ moduleName: 'test.Helper', version: '1.0.0', feed: url }], files: [{ name: '.lua', url: script, sha1: sha1(macro) }] } } }
  }, modules: { 'test.Helper': { channels: { stable: { default: true, version: '1.0.0', files: [{ name: '.lua', url: 'https://example.com/helper.lua', sha1: sha1(helper) }] } } } } }) : new Response(address === script ? macro : helper);
  await manager.addPluginFeed(url);
  const entry = manager.catalog().find(p => p.namespace === 'test.Favorite');
  await manager.addFavorite({ catalogId: entry.id }); await manager.removePluginFeed(url);
  await manager.installFavorites(id, manager.state.favorites.map(f => f.id));
  assert.equal(manager.state.pluginFeeds.length, 0);
  assert.equal(manager.instance(id).dependencyPackages['test.Helper'].version, '1.0.0');
  const plugin = manager.instance(id).plugins.find(p => p.namespace === 'test.Favorite');
  assert.equal(manager.snapshot().instances.find(v => v.id === id).plugins.find(p => p.id === plugin.id).favoriteId, manager.state.favorites[0].id);
});

test('failed bulk install rolls back earlier scripts and retains favorites and other instances', async t => {
  const f = await fixture(t), { manager, id } = f;
  await manager.addFavorite({ catalogId: manager.catalog().find(p => p.bundled).id });
  await manager.addPluginFeed(url); await manager.addFavorite({ catalogId: manager.catalog().find(p => p.feedUrl === url).id });
  const before = structuredClone(manager.state.instances); f.corrupt();
  await assert.rejects(manager.installFavorites(id, manager.state.favorites.map(f => f.id)), /校验失败/);
  assert.deepEqual(manager.state.instances, before);
  assert.equal(manager.state.favorites.length, 2);
  assert.equal(manager.state.restorePoints[0].status, 'auto-restored');
});

test('local favorites copy from their original instance and report removed sources', async t => {
  const { manager, id } = await fixture(t), source = manager.state.instances[0];
  await manager.addPlugin(source.id, { url: script });
  const plugin = source.plugins.find(p => p.kind === 'autoload'); delete plugin.url; await manager.save();
  await manager.addFavorite({ instanceId: source.id, pluginId: plugin.id });
  await manager.installFavorites(id, manager.state.favorites.map(f => f.id));
  assert.equal(manager.instance(id).plugins.find(p => p.file === plugin.file).name, 'Favorite');
  await manager.remove(source.id);
  assert.match(manager.snapshot().favoriteCatalog[0].unavailable, /已移除/);
});

test('favorite requests reject invalid IDs, active targets and active local sources', async t => {
  const { manager, id } = await fixture(t);
  await assert.rejects(manager.addFavorite({ catalogId: 'missing' }), /目录/);
  await manager.addFavorite({ catalogId: manager.catalog().find(p => p.bundled).id });
  await assert.rejects(manager.installFavorites(id, ['missing']), /收藏已不存在/);
  manager.running.set(id, {});
  await assert.rejects(manager.installFavorites(id, manager.state.favorites.map(f => f.id)), /请先关闭/);
  manager.running.clear();
  await assert.rejects(manager.installFavorites(id, []), /先收藏/);
  const source = manager.state.instances[0];
  await manager.addPlugin(source.id, { url: script });
  const plugin = source.plugins.find(p => p.kind === 'autoload'); delete plugin.url;
  await manager.addFavorite({ instanceId: source.id, pluginId: plugin.id });
  manager.running.set(source.id, {});
  await assert.rejects(manager.installFavorites(id, [manager.state.favorites.at(-1).id]), /请先关闭/);
  manager.running.clear();
});

test('background mode defaults, persists and rejects invalid close behavior', async t => {
  const { manager } = await fixture(t);
  assert.equal(manager.state.preferences.closeBehavior, 'background');
  await manager.setPreference('closeBehavior', 'quit');
  const restarted = new Manager(manager.root); await restarted.init();
  assert.equal(restarted.state.preferences.closeBehavior, 'quit');
  await assert.rejects(restarted.setPreference('closeBehavior', 'anything'), /设置值无效/);
});
