const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Manager } = require('../src/core.cjs');
const { loadSource, normalizeKnownFeeds } = require('../src/plugin-sources.cjs');
const url = name => `https://example.com/${name}.json`;
const feed = (name, links = {}) => ({ name, plugins: [{ file: name + '.lua', url: `https://example.com/${name}.lua` }], knownFeeds: links });
async function fixture(t, documents) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pclaeg-known-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const manager = new Manager(root, () => {}, async request => {
    calls.push(request);
    return documents[request] ? Response.json(documents[request]) : new Response('', { status: 404 });
  });
  await manager.init(); return { manager, calls };
}
test('knownFeeds accepts named maps, URL arrays, relative links and common field aliases', async () => {
  assert.deepEqual(normalizeKnownFeeds({ b: './b.json', duplicate: url('b'), insecure: 'http://example.com/c.json', self: url('a'), missing: null }, url('a')), [{ url: url('b'), name: 'b' }]);
  assert.deepEqual(normalizeKnownFeeds([url('b'), { name: 'C', url: url('c') }, { name: 'D', feed: url('d') }], url('a')).map(f => f.url), [url('b'), url('c'), url('d')]);
  for (const field of ['knownFeeds', 'knownfeeds', 'knownFeed', 'knownfeed']) {
    const parsed = await loadSource(url('a'), 'auto', async () => JSON.stringify({ name: 'A', [field]: { b: url('b') } }));
    assert.equal(parsed.packages.length, 0); assert.equal(parsed.knownFeeds[0].url, url('b'));
  }
});
test('DependencyControl module-only sources retain knownFeeds for mutual discovery', async () => {
  const parsed = await loadSource(url('a'), 'auto', async () => JSON.stringify({ dependencyControlFeedFormatVersion: '0.3.0', knownFeeds: { b: url('b') }, modules: {
    'native.Module': { channels: { stable: { default: true, version: '1.0.0', files: [{ name: '.dll', url: 'https://example.com/native.dll', platform: 'Windows-x64' }] } } }
  } }));
  assert.equal(parsed.type, 'depctrl'); assert.equal(parsed.moduleCount, 1); assert.equal(parsed.knownFeeds[0].url, url('b'));
});

test('legacy JSONC feeds with trailing commas and native module helpers remain discoverable', async () => {
  const text = '{ // legacy feed\n"dependencyControlFeedFormatVersion":"0.2.0","knownFeeds":{"b":"' + url('b') + '",},"modules":{"native.Helper":{"channels":{"main":{"default":true,"files":[{"name":".exe","url":"https://example.com/helper.exe"}],},},},},}';
  const parsed = await loadSource(url('a'), 'auto', async () => text);
  assert.equal(parsed.packages[0].main, 'native/Helper.exe');
  assert.equal(parsed.moduleCount, 1); assert.equal(parsed.knownFeeds[0].url, url('b'));
});
test('recursive discovery handles cycles and diamonds, records parent provenance and leaves subscriptions unchanged', async t => {
  const { manager, calls } = await fixture(t, {
    [url('a')]: feed('A', { b: url('b'), c: url('c') }),
    [url('b')]: feed('B', { a: url('a'), d: url('d') }),
    [url('c')]: feed('C', { d: url('d') }),
    [url('d')]: feed('D', { b: url('b') })
  });
  await manager.addPluginFeed(url('a')); assert.equal(manager.state.discoveredFeeds.length, 2);
  calls.length = 0; await manager.discoverPluginFeeds();
  assert.equal(calls.length, 4); assert.equal(new Set(calls).size, 4);
  assert.equal(manager.state.pluginFeeds.length, 1); assert.equal(manager.catalog().length, 65);
  assert.deepEqual(manager.state.discoveredFeeds.map(f => f.url).sort(), [url('b'), url('c'), url('d')]);
  assert.deepEqual(manager.state.discoveredFeeds.find(f => f.url === url('d')).discoveredFrom.sort(), [url('b'), url('c')]);
  const restored = new Manager(manager.root); await restored.init(); assert.equal(restored.state.discoveredFeeds.length, 3);
  await manager.addPluginFeed(url('b'));
  assert.equal(manager.state.pluginFeeds.length, 2); assert.equal(manager.state.discoveredFeeds.some(f => f.url === url('b')), false);
  await manager.removePluginFeed(url('b')); assert.equal(manager.state.discoveredFeeds.some(f => f.url === url('b')), true);
  await manager.removePluginFeed(url('a')); assert.deepEqual(manager.state.discoveredFeeds, []);
});
test('a failed linked feed is recorded without blocking healthy sources and can be retried', async t => {
  const documents = { [url('a')]: feed('A', { broken: url('broken'), b: url('b') }), [url('b')]: feed('B') };
  const { manager } = await fixture(t, documents);
  await manager.addPluginFeed(url('a')); await manager.discoverPluginFeeds();
  assert.match(manager.state.discoveredFeeds.find(f => f.url === url('broken')).error, /HTTP 404/);
  assert.equal(manager.state.discoveredFeeds.find(f => f.url === url('b')).name, 'B');
  documents[url('broken')] = feed('Fixed');
  await manager.discoverPluginFeeds(); assert.equal(manager.state.discoveredFeeds.find(f => f.url === url('broken')).error, null);
});
test('discovery refreshes old subscriptions and stops at the depth/request bounds', async t => {
  const documents = {};
  for (let n = 0; n < 40; n++) documents[url(String(n))] = feed('Feed' + n, { next: url(String(n + 1)) });
  const { manager, calls } = await fixture(t, documents);
  await manager.addPluginFeed(url('0')); delete manager.state.pluginFeeds[0].knownFeeds;
  calls.length = 0; await manager.discoverPluginFeeds();
  assert.equal(calls.length, 5); assert.equal(manager.state.feedDiscoveryStatus.limitReached, true);
  assert.ok(manager.state.discoveredFeeds.some(f => f.url === url('5')));
  const wide = {}; for (let n = 1; n < 40; n++) wide[String(n)] = url(String(n));
  documents[url('0')].knownFeeds = wide;
  calls.length = 0; await manager.discoverPluginFeeds(); assert.equal(calls.length, 32);
  assert.equal(manager.state.feedDiscoveryStatus.limitReached, true);
});
test('cancelled discovery preserves previously saved source records and removes download staging', async t => {
  const { manager } = await fixture(t, { [url('a')]: feed('A', { b: url('b') }) });
  await manager.addPluginFeed(url('a')); const before = JSON.stringify(manager.state);
  manager.abort = new AbortController(); manager.abort.abort();
  await assert.rejects(manager.discoverPluginFeeds(), /已取消/);
  assert.equal(JSON.stringify(manager.state), before);
  assert.deepEqual(await fs.readdir(path.join(manager.root, 'cache/downloads')), []);
});
