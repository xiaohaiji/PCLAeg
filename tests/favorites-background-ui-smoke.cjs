const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Manager } = require('../src/core.cjs');

(async () => {
  const root = path.resolve('.test-data/favorite-background-ui-' + Date.now());
  const manager = new Manager(root); await manager.init();
  const config = path.resolve('dist/win-unpacked/launcher-paths.json');
  let old; try { old = await fs.readFile(config); } catch {}
  await fs.writeFile(config, JSON.stringify({ dataRoot: root }));
  let app;
  const launch = async () => {
    app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '开始新的创作' }).waitFor();
    return page;
  };
  try {
    let page = await launch();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-page=plugins]').click();
    await page.locator('[data-action=plugin-tab][data-tab=browse]').click();
    const cards = page.locator('.plugin-card');
    await cards.filter({ has: page.getByRole('heading', { name: 'Aegisub-Motion-Mocha追踪', exact: true }) }).getByRole('button', { name: /^收藏 / }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await page.locator('#plugin-search').fill('Typewriter');
    await cards.filter({ has: page.getByRole('heading', { name: /Typewriter/ }) }).getByRole('button', { name: /^收藏 / }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await page.locator('[data-action=plugin-tab][data-tab=favorites]').click();
    assert.equal(await cards.count(), 2);
    assert.equal(await page.getByRole('button', { name: '一键安装到当前实例', exact: true }).isDisabled(), true);
    const state = () => page.evaluate(async () => (await window.launcher.command('state')).data);
    assert.equal((await state()).favorites.length, 2);
    await app.close(); app = null;
    const seeded = new Manager(root); await seeded.init();
    await seeded.create({ name: '收藏安装目标', populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
    await seeded.create({ name: '保持独立的实例', populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
    await seeded.select(seeded.state.instances[0].id);
    page = await launch(); page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-page=plugins]').click();
    await page.locator('[data-action=plugin-tab][data-tab=favorites]').click();
    await page.getByRole('button', { name: '一键安装到当前实例', exact: true }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    assert.equal((await state()).instances[0].plugins.filter(p => p.kind === 'autoload').length, 2);
    assert.equal((await state()).instances[1].plugins.length, 0);
    await page.getByRole('button', { name: '一键安装到当前实例', exact: true }).click();
    await page.getByText('已安装 0 个收藏，跳过 2 个已安装项', { exact: true }).waitFor();
    await fs.mkdir(path.resolve('dist/screenshots'), { recursive: true });
    await page.screenshot({ path: path.resolve('dist/screenshots/favorites-light.png') });
    await page.locator('[data-page=settings]').click();
    assert.equal(await page.locator('#close-behavior').inputValue(), 'background');
    await app.evaluate(({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { Manager } = load('./src/core.cjs'), install = Manager.prototype.installPluginEntry;
      Manager.prototype.installPluginEntry = async function(...args) {
        await new Promise(resolve => globalThis.finishBackgroundInstall = resolve);
        Manager.prototype.installPluginEntry = install;
        return install.apply(this, args);
      };
    });
    await page.evaluate(async () => {
      const state = (await window.launcher.command('state')).data;
      globalThis.pendingBackgroundInstall = window.launcher.command('favoriteInstall', { id: state.instances[1].id, favoriteIds: state.favorites.map(f => f.id) });
    });
    await page.waitForFunction(async () => (await window.launcher.command('state')).ok);
    await app.evaluate(async () => {
      for (let i = 0; i < 100 && !globalThis.finishBackgroundInstall; i++) await new Promise(resolve => setTimeout(resolve, 10));
      if (!globalThis.finishBackgroundInstall) throw new Error('Background install did not start');
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal((await state()).preferences.closeBehavior, 'background');
    await app.evaluate(() => globalThis.finishBackgroundInstall());
    const backgroundResult = await page.evaluate(() => globalThis.pendingBackgroundInstall);
    assert.equal(backgroundResult.ok, true, backgroundResult.error);
    assert.equal(backgroundResult.data.favoriteInstallResult.installed, 2);
    await app.evaluate(({ app }) => app.emit('second-instance', {}, ['launcher.exe'], process.cwd()));
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    await page.locator('#close-behavior').selectOption('quit');
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await page.locator('[data-page=plugins]').click();
    await page.locator('[data-action=plugin-tab][data-tab=favorites]').click();
    await page.screenshot({ path: path.resolve('dist/screenshots/favorites-dark.png') });
    await page.locator('.plugin-card').first().getByRole('button', { name: /^取消收藏 / }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    assert.equal((await state()).favorites.length, 1);
    await app.close(); app = null;
    page = await launch();
    assert.equal((await page.evaluate(async () => (await window.launcher.command('state')).data)).preferences.closeBehavior, 'quit');
    const closed = new Promise(resolve => app.on('close', resolve));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(error => { if (!/closed|destroyed/i.test(error.message)) throw error; });
    await closed; app = null;
    assert.deepEqual(errors, []);
    console.log('Packaged favorites without instances, persisted bulk install, instance isolation, background close/reopen and full exit passed.');
  } finally {
    if (app) await app.close();
    if (old) await fs.writeFile(config, old); else await fs.rm(config, { force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
