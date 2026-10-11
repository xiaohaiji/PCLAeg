const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BackgroundController } = require('../src/background.cjs');

function fixture(fail = false) {
  const app = new EventEmitter(), win = new EventEmitter();
  let hidden = false, minimized = false, quit = false, destroyed = false, behavior = 'background';
  win.hide = () => hidden = true; win.show = () => hidden = false;
  win.focus = () => {}; win.isDestroyed = () => false; win.isMinimized = () => minimized;
  win.restore = () => minimized = false;
  app.quit = () => { quit = true; app.emit('before-quit'); };
  class Tray extends EventEmitter {
    constructor() { super(); if (fail) throw Error('no tray'); }
    setToolTip() {} setContextMenu(menu) { this.menu = menu; }
    destroy() { destroyed = true; } isDestroyed() { return destroyed; }
  }
  const controller = new BackgroundController({ app, win, Tray, Menu: { buildFromTemplate: template => template }, getBehavior: () => behavior, icon: 'fixture' });
  const close = () => { let prevented = false; win.emit('close', { preventDefault: () => prevented = true }); return prevented; };
  return { app, win, controller, close, state: () => ({ hidden, minimized, quit, destroyed }), behavior: value => behavior = value, minimize: () => minimized = true };
}
test('close hides silently, tray restores minimized window and explicit exit bypasses hide', () => {
  const f = fixture(); assert.equal(f.close(), true); assert.equal(f.state().hidden, true);
  f.minimize(); f.controller.tray.emit('click'); assert.equal(f.state().hidden, false); assert.equal(f.state().minimized, false);
  f.close(); f.controller.menu[0].click(); assert.equal(f.state().hidden, false);
  f.controller.menu[2].click(); assert.equal(f.state().quit, true); assert.equal(f.close(), false);
  f.app.emit('will-quit'); assert.equal(f.state().destroyed, true);
});
test('quit preference and programmatic update/restart quits close fully', () => {
  const f = fixture(); f.behavior('quit'); assert.equal(f.close(), false);
  f.behavior('background'); f.app.emit('before-quit'); assert.equal(f.close(), false);
});
test('missing tray never leaves an inaccessible background process', () => {
  const f = fixture(true); assert.equal(f.controller.tray, null); assert.equal(f.close(), false);
});
