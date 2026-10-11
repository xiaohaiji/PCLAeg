const { _electron: electron } = require('playwright');
const { Manager } = require('../src/core.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve('.test-data/ass-ui-' + Date.now());
  const manager = new Manager(root); await manager.init();
  for (const name of ['Fixed', 'Selected']) await manager.create({ name, populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
  const [fixed, selected] = manager.state.instances;
  const config = path.resolve('dist/win-unpacked/launcher-paths.json');
  let old; try { old = await fs.readFile(config); } catch {}
  await fs.writeFile(config, JSON.stringify({ dataRoot: root }));
  let app;
  try {
    app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
    const page = await app.firstWindow(); await page.getByRole('heading', { name: '开始新的创作' }).waitFor();
    await app.evaluate(({ app, dialog, shell }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      globalThis.assLaunches = []; globalThis.assSettingsUrls = [];
      load('./src/core.cjs').Manager.prototype.launch = async function(id, files) { globalThis.assLaunches.push({ id, files }); return this.snapshot(); };
      dialog.showMessageBox = async () => ({ response: 1 });
      shell.openExternal = async url => globalThis.assSettingsUrls.push(url);
    });
    await page.locator('[data-page=versions]').click();
    await page.locator(`[data-action=ass-default][data-id="${fixed.id}"]`).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await page.getByText('默认打开字幕', { exact: true }).waitFor();
    await page.locator('[data-page=settings]').click();
    await page.getByText(/当前目标：Fixed（固定实例）/).waitFor();
    await page.getByRole('button', { name: '选择默认应用', exact: true }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    assert.deepEqual(await app.evaluate(() => globalThis.assSettingsUrls), ['ms-settings:defaultapps?registeredAppUser=Aegisub%20Launcher']);
    const status = await page.evaluate(() => window.launcher.command('assStatus'));
    assert.equal(status.ok, true); assert.equal(status.data.extensions.length, 2);
    await app.evaluate(({ app }, cwd) => app.emit('second-instance', {}, ['launcher.exe', '字幕 文件.ass'], cwd), root);
    await page.waitForFunction(async () => (await window.launcher.command('state')).ok);
    assert.deepEqual(await app.evaluate(() => globalThis.assLaunches), [{ id: fixed.id, files: [path.join(root, '字幕 文件.ass')] }]);
    await page.locator('#ass-instance').selectOption('');
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await app.evaluate(({ app }, cwd) => app.emit('second-instance', {}, ['launcher.exe', '第二.ssa'], cwd), root);
    assert.equal((await app.evaluate(() => globalThis.assLaunches)).at(-1).id, selected.id);
    await page.locator('#ass-instance').selectOption(fixed.id); await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await page.locator('[data-page=versions]').click(); await page.locator(`[data-action=remove][data-id="${fixed.id}"]`).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    await page.getByText('默认打开实例已删除，现已跟随当前选择的实例', { exact: true }).waitFor();
    const after = await page.evaluate(() => window.launcher.command('state'));
    assert.equal(after.data.preferences.defaultAss, null); assert.equal(after.data.selected, selected.id);
    await page.locator('[data-page=settings]').click();
    await page.getByText(/当前目标：Selected（跟随当前选择）/).waitFor();
    await fs.mkdir(path.resolve('dist/screenshots'), { recursive: true });
    await page.screenshot({ path: path.resolve('dist/screenshots/ass-default.png') });
    console.log('Packaged default selection, fixed/follow routing, association status and deletion fallback passed; registry unchanged.');
  } finally { if (app) await app.close(); if (old) await fs.writeFile(config, old); else await fs.unlink(config); }
})().catch(e => { console.error(e); process.exitCode = 1; });
