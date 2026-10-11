const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Manager } = require('../src/core.cjs');
const { parseFeed } = require('../src/depctrl.cjs');
const { loadSource } = require('../src/plugin-sources.cjs');
const sample = require('./fixtures/wenhe-dependency-control.json');
const url = 'https://raw.githubusercontent.com/WenHe233/WenHe-Aegisub-Scripts/main/DependencyControl.json';

test('WenHe feed exposes four macros and all five tracker module files', () => {
  const feed = parseFeed(sample, url);
  assert.deepEqual(feed.diagnostics, []);
  assert.equal(feed.packages.filter(p => p.section === 'macros').length, 4);
  assert.equal(feed.moduleCount, 1);
  assert.deepEqual(feed.packages.find(p => p.section === 'modules').files.map(f => f.relative), [
    'wenhe/ASSTracker.lua', 'wenhe/ASSTracker/VERSION', 'wenhe/ASSTracker/bootstrap.ps1',
    'wenhe/ASSTracker/bridge.lua', 'wenhe/ASSTracker/json.lua'
  ]);
});

test('invalid packages are isolated, counted accurately, and all-invalid feeds explain errors', async () => {
  const data = structuredClone(sample);
  data.modules['wenhe.ASSTracker'].channels.stable.files.push({ name: '/../../escape.ps1', url: 'https://example.com/bad' });
  const feed = await loadSource(url, 'auto', async () => JSON.stringify(data));
  assert.equal(feed.packages.length, 4); assert.equal(feed.moduleCount, 0);
  assert.equal(feed.diagnostics[0].namespace, 'wenhe.ASSTracker');
  assert.match(feed.diagnostics[0].message, /不安全/);
  data.macros = {};
  await assert.rejects(loadSource(url, 'depctrl', async () => JSON.stringify(data)), /wenhe.ASSTracker.*不安全/);
  const duplicates = structuredClone(sample);
  duplicates.modules['wenhe.ASSTracker'].channels.stable.files.push({ name: '/version', url: 'https://example.com/duplicate' });
  assert.match(parseFeed(duplicates, url).diagnostics[0].message, /重复/);
});

async function fixture(t) {
  const parent = path.resolve('.test-data'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'resources-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent)); await fs.rm(root, { recursive: true, force: true }); });
  const data = structuredClone(sample), bodies = new Map();
  // Keep the real manifest layout; deterministic bytes avoid network and script execution.
  for (const section of ['macros', 'modules']) for (const [namespace, pkg] of Object.entries(data[section])) {
    for (const file of pkg.channels.stable.files) {
      file.url = `https://example.com/${section}/${namespace}${file.name}`;
      const body = Buffer.from(file.name === '.lua' ? `script_name="${pkg.name}"\nscript_version="${pkg.channels.stable.version}"\nreturn {}` : `resource ${file.name}`);
      file.sha1 = crypto.createHash('sha1').update(body).digest('hex'); bodies.set(file.url, body);
    }
  }
  const manager = new Manager(root, () => {}, async request => request === url ? Response.json(data) : new Response(bodies.get(request), { status: bodies.has(request) ? 200 : 404 }));
  await manager.init(); await manager.create({ name: 'Target', populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
  await manager.addPluginFeed(url);
  return { manager, data, bodies, id: manager.state.selected };
}

test('tracker resource installation, update, and failed update retain complete package state', async t => {
  const { manager, data, bodies, id } = await fixture(t);
  const entry = manager.catalog().find(p => p.namespace === 'wenhe.ASSTracker');
  await manager.addPlugin(id, { catalogId: entry.id });
  const v = manager.instance(id), root = path.dirname(manager.appDir(v));
  const record = v.dependencyPackages['wenhe.ASSTracker']; assert.equal(record.files.length, 5);
  for (const file of record.files) await fs.access(path.join(root, file));
  const release = data.modules['wenhe.ASSTracker'].channels.stable;
  release.version = '0.6.2';
  const main = release.files.find(f => f.name === '.lua');
  const updatedMain = Buffer.from('script_version="0.6.2"\nreturn {}');
  bodies.set(main.url, updatedMain); main.sha1 = crypto.createHash('sha1').update(updatedMain).digest('hex');
  const resource = release.files.find(f => f.name === '/VERSION');
  bodies.set(resource.url, Buffer.from('0.6.2')); resource.sha1 = crypto.createHash('sha1').update('0.6.2').digest('hex');
  data.macros['wenhe.ASSTracker'].channels.stable.requiredModules[0].version = '0.6.2';
  await manager.addPluginFeed(url); await manager.addPlugin(id, { catalogId: entry.id });
  assert.equal(await fs.readFile(path.join(root, 'automation/include/wenhe/ASSTracker/VERSION'), 'utf8'), '0.6.2');
  const previous = structuredClone(v.dependencyPackages);
  const files = new Map(await Promise.all(record.files.map(async f => [f, await fs.readFile(path.join(root, f))])));
  release.version = '0.6.3'; data.macros['wenhe.ASSTracker'].channels.stable.requiredModules[0].version = '0.6.3';
  bodies.set(resource.url, Buffer.from('tampered'));
  await manager.addPluginFeed(url); await assert.rejects(manager.addPlugin(id, { catalogId: entry.id }), /校验失败/);
  assert.deepEqual(v.dependencyPackages, previous);
  for (const [f, bytes] of files) assert.deepEqual(await fs.readFile(path.join(root, f)), bytes);
  assert.equal(manager.state.restorePoints[0].status, 'auto-restored');
});

test('a rejected dependency package cannot install its consumer', async t => {
  const { manager, data, id } = await fixture(t);
  data.modules['wenhe.ASSTracker'].channels.stable.files[0].name = '/../../bad.lua';
  await manager.addPluginFeed(url);
  const entry = manager.catalog().find(p => p.namespace === 'wenhe.ASSTracker');
  await assert.rejects(manager.addPlugin(id, { catalogId: entry.id }), /找不到兼容依赖/);
  assert.equal(manager.instance(id).plugins.some(p => p.namespace === entry.namespace), false);
});
