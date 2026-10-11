const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseFeed } = require('../src/depctrl.cjs');
const { Manager } = require('../src/core.cjs');
const url = 'https://example.com/DependencyControl.json';
const script = Buffer.from('script_name="Feed Plugin"\nscript_version="1.2.3"');
const helper = Buffer.from('return {}');
const hash = body => crypto.createHash('sha1').update(body).digest('hex');
function feed() {
  return {
    dependencyControlFeedFormatVersion: '0.4.0', name: 'Test source', baseUrl: 'https://example.com',
    fileBaseUrl: 'https://example.com/', vars: { suffix: { stable: '', alpha: '-alpha' } },
    fileBaseUrls: { script: '@{fileBaseUrl}v@{version}@{suffix:@{channel}}/@{scriptTypeSection}/@{namespacePath}@{fileName}' },
    macros: { 'test.Plugin': { name: 'Feed Plugin', channels: {
      alpha: { version: '2.0.0', files: [{ name: '.moon', url: '@{fileBaseUrl}' }] },
      stable: { default: true, version: '1.2.3', files: [
        { name: '.lua', url: '@{fileBaseUrl}', sha1: hash(script) },
        { name: '/helper.lua', url: '@{fileBaseUrl}', sha1: hash(helper) },
        { name: '/linux.dll', url: '@{fileBaseUrl}', platform: 'Linux-x64' },
        { name: '/test.lua', url: '@{fileBaseUrl}', type: 'test' },
        { name: '/removed.lua', url: '@{fileBaseUrl}', delete: true }
      ] }
    } } }
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pclaeg-feed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = feed(); let corrupt = false;
  const manager = new Manager(root, () => {}, async request => {
    if (request === url) return Response.json(data);
    return new Response(corrupt ? 'corrupt' : request.endsWith('/helper.lua') ? helper : script);
  });
  await manager.init();
  await manager.create({ name: 'Target', populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
  return { manager, data, corrupt: () => { corrupt = true; } };
}
test('DependencyControl parses default channels, nested/map templates and Windows package files', () => {
  const parsed = parseFeed(feed(), url), p = parsed.packages[0];
  assert.equal(p.channel, 'stable'); assert.equal(p.files.length, 2);
  assert.equal(p.files[0].url, 'https://example.com/v1.2.3/macros/test/Plugin.lua');
  assert.equal(p.files[0].relative, 'test.Plugin.lua');
  assert.equal(p.files[1].relative, 'test.Plugin/helper.lua');
});
test('legacy feeds inherit scalar base URLs and support module namespace paths', () => {
  const data = { dependencyControlFeedFormatVersion: '0.2.0', fileBaseUrl: 'https://example.com/@{channel}', modules: {
    'test.Module': { fileBaseUrl: '@{fileBaseUrl}/@{namespacePath}', channels: { main: { default: true, version: '1.0.0', files: [{ name: '.moon', url: '@{fileBaseUrl}@{fileName}' }] } } }
  } };
  const p = parseFeed(data, url).packages[0];
  assert.equal(p.files[0].relative, 'test/Module.moon');
  assert.equal(p.files[0].url, 'https://example.com/main/test/Module.moon');
});
test('DependencyControl rejects traversal, unexpanded URLs and invalid hashes', () => {
  for (const name of ['/../bad.lua', '/../outside.lua', '/NUL.lua', '/bad:stream', '/a\\bad.lua']) {
    const data = feed(); data.macros['test.Plugin'].channels.stable.files[0].name = name;
    assert.equal(parseFeed(data, url).packages.length, 0); assert.equal(parseFeed(data, url).diagnostics.length, 1);
  }
  const missing = feed(); missing.macros['test.Plugin'].channels.stable.files[0].url = 'https://example.com/@{missing}';
  assert.match(parseFeed(missing, url).diagnostics[0].message, /无法识别/);
  const invalid = feed(); invalid.macros['test.Plugin'].channels.stable.files[0].sha1 = 'invalid';
  assert.match(parseFeed(invalid, url).diagnostics[0].message, /SHA-1/);
  assert.throws(() => parseFeed(feed(), 'http://example.com/feed'), /HTTPS/);
});
test('clean library exposes 64 plugins and installs a feed package with runtime, config and companion files', async t => {
  const { manager, data } = await fixture(t), id = manager.state.selected;
  assert.equal(manager.catalog().length, 64);
  await manager.addPluginFeed(url); await manager.addPluginFeed(url);
  assert.equal(manager.state.pluginFeeds.length, 1); assert.equal(manager.catalog().length, 65);
  const entry = manager.catalog().find(p => p.depctrl);
  await manager.addPlugin(id, { catalogId: entry.id });
  const v = manager.instance(id), root = path.dirname(manager.appDir(v));
  assert.equal(await fs.readFile(path.join(root, 'automation/autoload/test.Plugin/helper.lua'), 'utf8'), helper.toString());
  await fs.access(path.join(root, 'automation/include/l0/DependencyControl.moon'));
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/l0.DependencyControl.json')));
  assert.deepEqual(config.config.extraFeeds, [url]); assert.equal(config.macros['test.Plugin'].userFeed, url);
  let plugin = v.plugins.find(p => p.file === 'test.Plugin.lua'); assert.equal(plugin.depctrl, true);
  await manager.togglePlugin(id, plugin.id); await manager.togglePlugin(id, plugin.id);
  data.macros['test.Plugin'].channels.stable.version = '1.2.4';
  await manager.addPluginFeed(url); await manager.addPlugin(id, { catalogId: entry.id });
  plugin = v.plugins.find(p => p.file === 'test.Plugin.lua'); assert.equal(plugin.version, '1.2.4');
  const restored = new Manager(manager.root); await restored.init(); assert.equal(restored.catalog().length, 65);
  await manager.removePlugin(id, plugin.id);
  await assert.rejects(fs.access(path.join(root, 'automation/autoload/test.Plugin/helper.lua')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'automation/autoload/test.Plugin.lua')), { code: 'ENOENT' });
  await manager.scanPlugins(id); assert.equal(v.plugins.some(p => p.file === 'test.Plugin.lua'), false);
  await manager.removePluginFeed(url); assert.equal(manager.catalog().length, 64);
});
test('failed feed package verification leaves the version and existing DependencyControl config untouched', async t => {
  const { manager, corrupt } = await fixture(t), id = manager.state.selected;
  await manager.addPluginFeed(url); corrupt();
  const v = manager.instance(id), root = path.dirname(manager.appDir(v));
  const configFile = path.join(root, 'config/l0.DependencyControl.json'); await fs.mkdir(path.dirname(configFile));
  const existing = '{"config":{"extraFeeds":["https://example.com/other.json"]},"macros":{}}';
  await fs.writeFile(configFile, existing);
  const previous = JSON.stringify({ selected: manager.state.selected, plugins: v.plugins, feeds: manager.state.pluginFeeds });
  await assert.rejects(manager.addPlugin(id, { catalogId: manager.catalog().find(p => p.depctrl).id }), /校验失败/);
  assert.equal(JSON.stringify({ selected: manager.state.selected, plugins: v.plugins, feeds: manager.state.pluginFeeds }), previous);
  assert.equal(manager.state.restorePoints[0].status, 'auto-restored');
  assert.equal(await fs.readFile(configFile, 'utf8'), existing);
  await assert.rejects(fs.access(path.join(root, 'automation/autoload/test.Plugin.lua')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(manager.root, 'cache/downloads')), []);
});
test('feed installer respects stopped versions and never overwrites an existing unmanaged macro', async t => {
  const { manager } = await fixture(t), id = manager.state.selected;
  await manager.addPluginFeed(url); const entry = manager.catalog().find(p => p.depctrl);
  manager.running.set(id, {});
  await assert.rejects(manager.addPlugin(id, { catalogId: entry.id }), /请先关闭/);
  manager.running.delete(id);
  const dir = path.join(path.dirname(manager.appDir(manager.instance(id))), 'automation/autoload'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'test.Plugin.lua'), 'user file');
  await assert.rejects(manager.addPlugin(id, { catalogId: entry.id }), /已有同名/);
  assert.equal(await fs.readFile(path.join(dir, 'test.Plugin.lua'), 'utf8'), 'user file');
});
