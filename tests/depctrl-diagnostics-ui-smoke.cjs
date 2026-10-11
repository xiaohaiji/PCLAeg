const { _electron: electron } = require('playwright');
const { Manager } = require('../src/core.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve('.test-data/depctrl-diagnostics-' + Date.now());
  const data = structuredClone(require('./fixtures/wenhe-dependency-control.json'));
  data.modules['bad.Package'] = { channels: { stable: { default: true, files: [{ name: '/../bad.lua' }] } } };
  const manager = new Manager(root, () => {}, async () => Response.json(data));
  await manager.init();
  await manager.addPluginFeed('https://example.com/feed.json');
  const config = path.resolve('dist/win-unpacked/launcher-paths.json');
  let old; try { old = await fs.readFile(config); } catch {}
  await fs.writeFile(config, JSON.stringify({ dataRoot: root }));
  let app;
  try {
    app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '开始新的创作' }).waitFor();
    await page.locator('[data-page=plugins]').click();
    const panel = page.locator('.feed-list');
    assert.match(await panel.innerText(), /4 个插件/);
    assert.match(await panel.innerText(), /1 个依赖模块/);
    assert.match(await panel.innerText(), /包不可用：bad.Package：源包含不安全的文件路径/);
    console.log('Packaged source counts and package diagnostics passed.');
  } finally { if (app) await app.close(); if (old) await fs.writeFile(config, old); else await fs.unlink(config); }
})().catch(e => { console.error(e); process.exitCode = 1; });
