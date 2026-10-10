const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Manager } = require('../src/core.cjs');
const { associationValues } = require('../src/platform.cjs');
const { readAssociationStatus, openDefaultSettings, subtitleArguments, SubtitleQueue } = require('../src/ass-integration.cjs');
const executable = 'C:\\字幕 Tools\\Launcher.exe';
const command = associationValues(executable).find(([key]) => key.endsWith('shell\\open\\command'))[2];
const runner = data => async (exe, args, options) => {
  assert.equal(exe, 'powershell.exe'); assert.ok(args.includes('-EncodedCommand')); assert.equal(options.windowsHide, true);
  return { stdout: JSON.stringify(data) };
};
const probe = async () => {};

test('association status distinguishes effective choices for ASS and SSA', { skip: process.platform !== 'win32' }, async () => {
  const result = await readAssociationStatus(executable, [], runner({ registration: command, extensions: [
    { extension: '.ass', progId: 'PCLAeg.ASS', command }, { extension: '.ssa', progId: 'Aegisub.SSA', command: 'other.exe "%1"' }
  ] }), probe);
  assert.equal(result.registration, 'valid'); assert.deepEqual(result.extensions.map(e => e.status), ['launcher', 'other']);
});

test('missing, moved, inaccessible and malformed association queries never report success', { skip: process.platform !== 'win32' }, async () => {
  const registered = { registration: command, extensions: [{ extension: '.ass', progId: 'PCLAeg.ASS', command }] };
  assert.equal((await readAssociationStatus(executable, [], runner({ ...registered, registration: null }), probe)).registration, 'missing');
  assert.equal((await readAssociationStatus(executable, [], runner({ ...registered, registration: 'old.exe' }), probe)).registration, 'stale');
  const missing = await readAssociationStatus(executable, [], runner(registered), async () => { throw Error('missing executable'); });
  assert.equal(missing.registration, 'stale'); assert.equal(missing.extensions[0].status, 'stale');
  for (const failed of [async () => { throw Error('access denied'); }, async () => ({ stdout: '{}' })]) {
    const result = await readAssociationStatus(executable, [], failed, probe);
    assert.equal(result.registration, 'unknown'); assert.ok(result.extensions.every(e => e.status === 'unknown'));
  }
});

test('default settings target the registered user app and retain a generic fallback', async () => {
  const urls = [];
  await openDefaultSettings(async url => { urls.push(url); if (url.includes('?')) throw Error('unsupported'); });
  assert.deepEqual(urls, ['ms-settings:defaultapps?registeredAppUser=Aegisub%20Launcher', 'ms-settings:defaultapps']);
  urls.length = 0; await openDefaultSettings(async url => urls.push(url), true); assert.deepEqual(urls, ['ms-settings:defaultapps']);
});

function managerFixture() {
  const manager = new Manager(path.resolve('.test-data/queue-unused'));
  manager.state = { preferences: { defaultAss: 'fixed' }, selected: 'selected' };
  const calls = [], errors = [];
  manager.launch = async (id, files) => { calls.push({ id, files }); assert.equal(manager.busy, true); if (files[0] === 'bad.ass') throw Error('invalid subtitle'); };
  const queue = new SubtitleQueue(e => errors.push(e.message));
  return { manager, calls, errors, queue };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('cold and warm requests preserve filenames, fixed/following targets, and recover after errors', async () => {
  const { manager, calls, errors, queue } = managerFixture();
  const cwd = path.resolve('.test-data/字幕 空格');
  const files = subtitleArguments(['launcher.exe', '--open-ass', '带 空格.ass', '第二.SSA', 'ignore.txt'], cwd);
  await queue.enqueue(files); assert.equal(calls.length, 0);
  await queue.start(manager); assert.equal(calls[0].id, 'fixed');
  assert.deepEqual(calls[0].files, [path.join(cwd, '带 空格.ass'), path.join(cwd, '第二.SSA')]);
  manager.state.preferences.defaultAss = null;
  await queue.enqueue(['bad.ass']); await queue.enqueue(['good.ssa']);
  assert.deepEqual(errors, ['invalid subtitle']); assert.equal(calls.at(-1).id, 'selected');
  await queue.enqueue(Array.from({ length: 20 }, (_, i) => `${i}.ass`));
  assert.deepEqual(calls.slice(-2).map(c => c.files.length), [16, 4]);
});

test('subtitle requests wait for mutations, serialize, and survive failed operations', async () => {
  const { manager, calls, queue } = managerFixture(); await queue.start(manager);
  let release;
  const changing = manager.mutate(async () => { await new Promise(resolve => release = resolve); throw Error('change failed'); });
  const opened = queue.enqueue(['one.ass']); queue.enqueue(['two.ssa']);
  await tick(); assert.equal(calls.length, 0);
  const rejected = assert.rejects(changing, /change failed/); release(); await rejected; await opened;
  assert.deepEqual(calls.map(c => c.files), [['one.ass'], ['two.ssa']]);
  assert.equal(manager.busy, false);
});

test('migration pauses before waiting requests are consumed so restart can forward them', async () => {
  const { manager, calls, queue } = managerFixture(); await queue.start(manager);
  let release;
  const migrating = manager.mutate(async () => { await new Promise(resolve => release = resolve); queue.pause(); });
  const pending = queue.enqueue(['pending.ass']); await tick(); release(); await migrating; await pending;
  assert.equal(calls.length, 0); assert.deepEqual(queue.pendingFiles(), ['pending.ass']);
  await queue.start(manager); assert.equal(calls.length, 1);
});

test('no default target reports an actionable error without launching', async () => {
  const { manager, calls, errors, queue } = managerFixture(); manager.state.preferences.defaultAss = null; manager.state.selected = null;
  await queue.enqueue(['one.ass']); await queue.start(manager);
  assert.equal(calls.length, 0); assert.match(errors[0], /默认实例/);
});
