// Explicit network smoke: downloads packages into an isolated fixture, never runs them.
const { Manager } = require('../src/core.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve('.test-data/wenhe-network-' + Date.now());
  const manager = new Manager(root); await manager.init();
  await manager.create({ name: 'Network fixture', populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
  await manager.addPluginFeed('https://raw.githubusercontent.com/WenHe233/WenHe-Aegisub-Scripts/main/DependencyControl.json');
  const feed = manager.state.pluginFeeds[0]; assert.deepEqual(feed.diagnostics, []);
  assert.equal(feed.packages.filter(p => p.section === 'macros').length, 4);
  const id = manager.state.selected, entry = manager.catalog().find(p => p.namespace === 'wenhe.ASSTracker');
  await manager.addPlugin(id, { catalogId: entry.id });
  const v = manager.instance(id); assert.equal(v.dependencyPackages['wenhe.ASSTracker'].files.length, 5);
  for (const file of v.dependencyPackages['wenhe.ASSTracker'].files) await fs.access(path.join(path.dirname(manager.appDir(v)), file));
  assert.equal((await manager.dependencyGraph(id)).conflicts.length, 0);
  console.log('Live WenHe feed: four macros, tracker and five module files installed with hash verification.');
})().catch(e => { console.error(e); process.exitCode = 1; });
