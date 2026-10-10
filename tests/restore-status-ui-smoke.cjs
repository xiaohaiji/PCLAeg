const { _electron: electron } = require('playwright');
const { Manager } = require('../src/core.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve('.test-data/restore-status-ui-' + Date.now());
  const manager = new Manager(root); await manager.init();
  await manager.create({ name: 'Fixture', populate: dir => fs.writeFile(path.join(dir, 'aegisub.exe'), 'fixture') });
  await manager.profileTransaction([manager.state.selected], 'Missing backup', async () => {});
  const point = manager.state.restorePoints[0], backup = path.join(root, 'cache/restore-points', point.id, 'point.json'), saved = await fs.readFile(backup);
  await fs.unlink(backup);
  const config = path.resolve('dist/win-unpacked/launcher-paths.json');
  let old; try { old = await fs.readFile(config); } catch {}
  await fs.writeFile(config, JSON.stringify({ dataRoot: root }));
  let app;
  try {
    app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
    const page = await app.firstWindow(); await page.getByRole('heading', { name: '开始新的创作' }).waitFor();
    await page.locator('[data-page=settings]').click();
    await page.getByText(/备份文件缺失，请从原数据目录恢复备份后重新检查/).waitFor();
    assert.equal(await page.getByRole('button', { name: '回滚', exact: true }).isDisabled(), true);
    await fs.writeFile(backup, saved);
    await page.getByRole('button', { name: '检查恢复点', exact: true }).click();
    await page.locator('#task.hidden').waitFor({ state: 'attached' });
    assert.equal(await page.getByRole('button', { name: '回滚', exact: true }).isEnabled(), true);
    console.log('Packaged missing-backup explanation, blocked rollback and repaired-backup recheck passed.');
  } finally { if (app) await app.close(); if (old) await fs.writeFile(config, old); else await fs.unlink(config); }
})().catch(e => { console.error(e); process.exitCode = 1; });
