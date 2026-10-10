const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Manager } = require('../src/core.cjs');
const source = 'https://example.com/plugins.json', scriptUrl = 'https://example.com/tool.lua';
const digest = (bytes, kind = 'sha256') => crypto.createHash(kind).update(bytes).digest('hex');

async function fixture(t, depctrl = false) {
  const parent = path.resolve('.test-data'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'sources-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent)); await fs.rm(root, { recursive: true, force: true }); });
  let revision = 1, corrupt = false, failed = false, absent = false;
  const body = () => `script_name="Tool"\nscript_version="1.0.${revision}"`;
  const fetcher = async url => {
    if (failed) return new Response('unavailable', { status: 404 });
    if (url === source) return Response.json(depctrl ? {
      dependencyControlFeedFormatVersion: '0.4.0', macros: { 'test.Tool': { channels: { stable: {
        default: true, version: `1.0.${revision}`, files: [{ name: '.lua', url: scriptUrl, sha1: digest(body(), 'sha1') }]
      } } } }
    } : { name: 'Custom', plugins: absent ? [] : [{ file: 'tool.lua', url: scriptUrl, sha256: digest(body()) }], knownFeeds: ['https://example.com/related.json'] });
    return new Response(corrupt ? 'bad bytes' : body());
  };
  const manager = new Manager(root, () => {}, fetcher); await manager.init();
  await manager.create({ name: 'Target', populate: dir => fs.writeFile(path.join(dir, 'aegisub.exe'), 'fixture') });
  return { manager, fetcher, id: manager.state.selected, next: () => revision++, corrupt: () => corrupt = true, fail: () => failed = true, absent: () => absent = true };
}

for (const dc of [false, true]) test(`${dc ? 'DC' : 'JSON'} plugin updates after source removal without resubscribing, including restart`, async t => {
  const f = await fixture(t, dc), { manager, id } = f;
  await manager.addPluginFeed(source); const entry = manager.catalog().find(p => p.feedUrl === source);
  await manager.addPlugin(id, { catalogId: entry.id });
  const plugin = manager.instance(id).plugins.find(p => p.catalogId === entry.id);
  await manager.removePluginFeed(source); f.next();
  const restarted = new Manager(manager.root, () => {}, f.fetcher); await restarted.init();
  await restarted.updatePlugin(id, plugin.id);
  assert.equal(restarted.state.pluginFeeds.length, 0);
  assert.equal(restarted.instance(id).plugins.find(p => p.id === plugin.id).version, '1.0.2');
  const v = restarted.instance(id), before = await fs.readFile(restarted.pluginPath(v, plugin));
  f.next(); f.corrupt();
  await assert.rejects(restarted.updatePlugin(id, plugin.id), /校验失败/);
  assert.deepEqual(await fs.readFile(restarted.pluginPath(v, plugin)), before);
  assert.equal(restarted.state.pluginFeeds.length, 0);
  f.fail(); await assert.rejects(restarted.updatePlugin(id, plugin.id), /HTTP 404/);
  assert.deepEqual(await fs.readFile(restarted.pluginPath(v, plugin)), before);
});

test('source update fails when package disappears and refuses disabled/running plugins', async t => {
  const f = await fixture(t), { manager, id } = f;
  await manager.addPluginFeed(source); await manager.addPlugin(id, { catalogId: manager.catalog().find(p => p.feedUrl === source).id });
  const p = manager.instance(id).plugins.find(p => p.sourcePlugin);
  f.absent(); await assert.rejects(manager.updatePlugin(id, p.id), /源中已没有/);
  await manager.togglePlugin(id, p.id); await assert.rejects(manager.updatePlugin(id, p.id), /禁用/);
  manager.running.set(id, {}); await assert.rejects(manager.updatePlugin(id, p.id), /请先关闭/); manager.running.clear();
});

test('direct URL updates accept changed content and retain custom file identity', async t => {
  const f = await fixture(t), { manager, id } = f;
  await manager.addPlugin(id, { url: scriptUrl });
  const p = manager.instance(id).plugins.find(p => p.url === scriptUrl);
  f.next(); await manager.updatePlugin(id, p.id);
  assert.equal(manager.instance(id).plugins.find(item => item.id === p.id).version, '1.0.2');
  assert.equal(manager.state.pluginFeeds?.length || 0, 0);
});
