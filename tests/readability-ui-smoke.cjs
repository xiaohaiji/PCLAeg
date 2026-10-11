const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Manager } = require('../src/core.cjs');

(async () => {
  const root = path.resolve('.test-data/readability-' + Date.now());
  const manager = new Manager(root); await manager.init();
  for (const name of ['日常字幕 · 官方稳定版', '项目备份 · 中文长名称与独立配置']) {
    await manager.create({ name, version: '3.4.2', populate: dest => fs.writeFile(path.join(dest, 'aegisub.exe'), 'fixture') });
  }
  await manager.addPlugin(manager.state.selected, { catalogId: manager.catalog().find(p => p.file === 'a-mo.Aegisub-Motion.moon').id });
  const config = path.resolve('dist/win-unpacked/launcher-paths.json');
  let old; try { old = await fs.readFile(config); } catch {}
  await fs.writeFile(config, JSON.stringify({ dataRoot: root }));
  let app;
  try {
    app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: '开始新的创作' }).waitFor();
    await app.evaluate(({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      load('./src/core.cjs').Manager.prototype.releases = async () => [{ tag: 'v3.4.2', date: '2026-10-10', url: 'https://github.com/TypesettingTools/Aegisub/releases', assets: [{ name: 'Aegisub-3.4.2-Windows-x64.zip', size: 42000000 }] }];
    });
    await fs.mkdir(path.resolve('dist/screenshots'), { recursive: true });
    async function audit(label) {
      // Sample settled colors after the 160ms button/hover transition.
      await page.waitForTimeout(220);
      const issues = await page.evaluate(() => {
        const rgb = value => value.match(/[\d.]+/g).map(Number);
        const luminance = color => color.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
        const issues = [];
        for (const el of document.querySelectorAll('h1,h2,h3,p,small,button,label,span,strong,b,td,th,select,option,input,div.eyebrow,div.status-line,div.aside-bottom')) {
          if (!el.checkVisibility() || el.matches(':disabled,option') || el.closest('.brand-icon,.version-icon,.plugin-icon,.stat-icon,.empty-symbol,.icon-button')) continue;
          const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim() || (el.matches('input') ? el.placeholder : '');
          if (!text) continue;
          const style = getComputedStyle(el), size = parseFloat(style.fontSize);
          if (size < 13) issues.push(`${text}: ${size}px`);
          const ancestors = []; for (let p = el; p; p = p.parentElement) ancestors.unshift(p);
          let bg = [255,255,255];
          for (const p of ancestors) {
            const c = rgb(getComputedStyle(p).backgroundColor), alpha = c[3] ?? 1;
            bg = bg.map((v, i) => c[i] * alpha + v * (1 - alpha));
          }
          const fg = luminance(rgb(style.color)), back = luminance(bg);
          const ratio = (Math.max(fg, back) + .05) / (Math.min(fg, back) + .05);
          const minimum = size >= 24 || size >= 18.66 && Number(style.fontWeight) >= 700 ? 3 : 4.5;
          if (ratio < minimum) issues.push(`${text}: contrast ${ratio.toFixed(2)} (${style.color} on ${bg.join(',')})`);
        }
        if (document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth + 1) issues.push('Page content overflows horizontally');
        return issues;
      });
      assert.deepEqual(issues, [], label);
    }
    for (const width of [1240, 1000]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 820), width);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => window.launcher.command('preference', { key: 'theme', value: theme }), theme);
        await page.locator('[data-page=settings]').click();
        await page.getByRole('button', { name: theme === 'light' ? '浅色' : '深色', exact: true }).click();
        await page.locator('#task.hidden').waitFor({ state: 'attached' });
        for (const section of ['home', 'versions', 'downloads', 'plugins', 'settings']) {
          await page.locator(`[data-page=${section}]`).click();
          if (section === 'downloads') await page.locator('.version-row').first().waitFor();
          if (section === 'plugins') { await page.locator('[data-action=plugin-tab][data-tab=browse]').click(); }
          await audit(`${width}/${theme}/${section}`);
          if (width === 1240 || section === 'versions') await page.screenshot({ path: path.resolve(`dist/screenshots/readability-${width}-${theme}-${section}.png`) });
        }
        await page.locator('[data-page=plugins]').click();
        await page.getByRole('button', { name: '管理源', exact: true }).click();
        await audit(`${width}/${theme}/pluginSources`);
        await page.locator('[data-page=downloads]').click();
        await page.getByRole('button', { name: '管理源', exact: true }).click();
        await audit(`${width}/${theme}/releaseSources`);
        await page.locator('[data-page=versions]').click();
        await page.locator('[data-action=rename]').first().click();
        await page.locator('dialog[open]').waitFor();
        await audit(`${width}/${theme}/dialog`);
        await page.locator('#modal-cancel').click();
      }
    }
    assert.deepEqual(errors, []);
    console.log('Readable typography, text contrast and layouts passed for both themes at 1240px and 1000px.');
  } finally {
    if (app) await app.close();
    if (old) await fs.writeFile(config, old); else await fs.rm(config, { force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
