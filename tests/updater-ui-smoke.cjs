const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const currentVersion = require('../package.json').version;
const nextVersion = require('semver').inc(currentVersion, 'patch');
(async () => {
  const root = path.resolve('.test-data/update-ui-' + Date.now());
  await fs.mkdir(root, { recursive: true });
  const config = path.resolve('dist/win-unpacked/launcher-paths.json');
  let old; try { old = await fs.readFile(config); } catch {}
  await fs.writeFile(config, JSON.stringify({ dataRoot: root }));
  const app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '开始新的创作' }).waitFor();
    await app.evaluate(({ app, dialog }, version) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { Updater } = load('./src/updater.cjs');
      Updater.prototype.check = async function () { return this.latest = { version, available: true }; };
      dialog.showMessageBox = async () => ({ response: 0 });
    }, nextVersion);
    await page.locator('[data-page=settings]').click();
    await page.getByRole('heading', { name: `启动器更新 · ${currentVersion}` }).waitFor();
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByText(`发现新版 ${nextVersion}，更新后自动重启，保留实例与插件。`).waitFor();
    await page.getByRole('button', { name: '一键更新', exact: true }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    assert.equal((await page.evaluate(async () => (await window.launcher.command('state')).data)).instances.length, 0);
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.locator('html[data-theme=dark]').waitFor();
    await page.locator('[data-page=home]').click();
    assert.equal(await page.locator('.stat').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 43, 62)');
    assert.equal(await page.locator('.empty-symbol').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(38, 63, 97)');
    console.log('Packaged update check, installation cancel and merged dark theme passed.');
  } finally {
    await app.close();
    if (old) await fs.writeFile(config, old); else await fs.unlink(config);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
