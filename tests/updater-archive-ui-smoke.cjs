const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { version } = require('../package.json');

(async () => {
  const root = path.resolve('.test-data/update-archive-' + Date.now());
  const packageFile = path.resolve(`dist/Aegisub-Launcher-${version}-Windows-x64.zip`);
  await fs.access(packageFile);
  let app;
  try {
    app = await electron.launch({ executablePath: path.resolve('dist/win-unpacked/Aegisub Launcher.exe'), env: { ...process.env, PCLAEG_TEST_ROOT: root } });
    await (await app.firstWindow()).getByRole('heading', { name: '开始新的创作' }).waitFor();
    const result = await app.evaluate(async ({ app }, { packageFile, root, version }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const raw = load('original-fs');
      const path = load('node:path');
      const { stageArchive, hash } = load('./src/updater.cjs');
      const AdmZip = load('adm-zip');
      const previousNoAsar = process.noAsar;
      const names = await stageArchive(packageFile, path.join(root, 'stage'), version);
      const zip = new AdmZip(packageFile, { fs: raw });
      const manifest = JSON.parse(zip.getEntry('AegisubLauncher/update-manifest.json').getData());
      for (const record of manifest.files) {
        const content = raw.readFileSync(path.join(root, 'stage/AegisubLauncher', record.path));
        if (hash(content) !== record.sha256) throw new Error('Extracted runtime hash mismatch: ' + record.path);
      }
      const archive = raw.statSync(path.join(root, 'stage/AegisubLauncher/resources/app.asar'));
      return { packaged: app.isPackaged, unchangedAsarMode: process.noAsar === previousNoAsar, archiveIsFile: archive.isFile(), names, files: manifest.files.length };
    }, { packageFile, root, version });
    assert.equal(result.packaged, true);
    assert.equal(result.unchangedAsarMode, true);
    assert.equal(result.archiveIsFile, true);
    assert.ok(result.names.includes('resources'));
    assert.ok(result.files > 100);
    console.log(`Packaged Electron extracted and verified all ${result.files} real update files, including app.asar, without changing global ASAR behavior.`);
  } finally {
    if (app) await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
