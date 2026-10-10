const { _electron: electron } = require('playwright');
const { Manager } = require('../src/core.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve('.test-data/source-management-ui-' + Date.now());
  const manager = new Manager(root, () => {}, async url => Response.json({ name: url.endsWith('one') ? 'One' : 'Two', plugins: [{ name: url.endsWith('one') ? 'One plugin' : 'Two plugin', url: url + '.lua' }] }));
  await manager.init(); await manager.addPluginFeed('https://example.com/one'); await manager.addPluginFeed('https://example.com/two');
  manager.state.releaseSources = { custom: { repo: 'example/custom', name: 'Custom', custom: true } }; await manager.save();
  const config = path.resolve('dist/win-unpacked/launcher-paths.json');
  let old; try { old = await fs.readFile(config); } catch {}
  await fs.writeFile(config, JSON.stringify({ dataRoot: root }));
  let app;
  try {
    const launch = async () => {
      app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
      const page = await app.firstWindow(); await page.getByRole('heading', { name: '开始新的创作' }).waitFor();
      await app.evaluate(({ app }) => {
        const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
        load('./src/core.cjs').Manager.prototype.releases = async () => [];
      });
      return page;
    };
    let page = await launch();
    await page.locator('[data-page=plugins]').click();
    await page.getByRole('button', { name: '管理源', exact: true }).click();
    await page.getByRole('heading', { name: '管理插件源' }).waitFor();
    await page.locator('#source-view').selectOption('https://example.com/one');
    await page.getByRole('button', { name: '查看插件', exact: true }).click();
    assert.equal(await page.locator('.plugin-card').count(), 1);
    assert.match(await page.locator('.plugin-card').innerText(), /One plugin/);
    await page.getByRole('button', { name: '管理源', exact: true }).click();
    await page.locator('[data-action=plugin-feed-remove][data-url="https://example.com/one"]').click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-action=plugin-feed-remove]').count(), 1);
    await page.locator('[data-page=downloads]').click();
    await page.getByRole('button', { name: '管理源', exact: true }).click();
    await page.getByRole('heading', { name: '管理下载源' }).waitFor();
    assert.equal(await page.getByText('内置源', { exact: true }).count(), 2);
    await page.getByRole('button', { name: '删除源', exact: true }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    assert.equal(await page.getByRole('button', { name: '删除源', exact: true }).count(), 0);
    await app.close(); app = null; page = await launch();
    const result = await page.evaluate(() => window.launcher.command('state'));
    assert.deepEqual(result.data.pluginFeeds.map(f => f.url), ['https://example.com/two']);
    assert.deepEqual(result.data.releaseSources, {});
    await fs.mkdir(path.resolve('dist/screenshots'), { recursive: true });
    await page.locator('[data-page=plugins]').click(); await page.getByRole('button', { name: '管理源', exact: true }).click();
    await page.screenshot({ path: path.resolve('dist/screenshots/source-management.png') });
    console.log('Packaged management entry points, source filtering without instances, removal and restart passed.');
  } finally { if (app) await app.close(); if (old) await fs.writeFile(config, old); else await fs.unlink(config); }
})().catch(e => { console.error(e); process.exitCode = 1; });
