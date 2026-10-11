class BackgroundController {
  constructor({ app, win, Tray, Menu, icon, getBehavior }) {
    Object.assign(this, { app, win, getBehavior });
    this.quitting = false;
    try {
      this.tray = new Tray(icon);
      this.tray.setToolTip('Aegisub Launcher');
      this.menu = Menu.buildFromTemplate([
        { label: '打开启动器', click: () => this.show() },
        { type: 'separator' },
        { label: '完全退出', click: () => app.quit() }
      ]);
      this.tray.setContextMenu(this.menu);
      this.tray.on('click', () => this.show());
      this.tray.on('double-click', () => this.show());
    } catch (error) {
      if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
      this.tray = null;
      console.error('无法创建托盘，关闭窗口时将完全退出：', error.message);
    }
    win.on('close', event => {
      if (!this.quitting && getBehavior() === 'background' && this.tray && !this.tray.isDestroyed()) {
        event.preventDefault();
        win.hide();
      }
    });
    app.on('before-quit', () => { this.quitting = true; });
    app.on('will-quit', () => { if (this.tray && !this.tray.isDestroyed()) this.tray.destroy(); });
    app.on('activate', () => this.show());
  }
  show() {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show(); this.win.focus();
  }
}
module.exports = { BackgroundController };
