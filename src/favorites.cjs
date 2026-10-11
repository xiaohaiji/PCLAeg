const crypto = require('node:crypto');

function favoriteKey(entry) {
  if (entry.depctrl) return `dc:${entry.feedUrl}:${entry.namespace}`;
  if (entry.sourceInstanceId) return `local:${entry.sourceInstanceId}:${entry.sourcePluginId}`;
  if (entry.directUrl) return `url:${entry.url}`;
  return `catalog:${entry.id}`;
}
function matchesInstalled(entry, plugin, instanceId) {
  if (entry.sourceInstanceId === instanceId && entry.sourcePluginId === plugin.id) return true;
  if (entry.depctrl) return plugin.depctrl && plugin.namespace === entry.namespace && plugin.feedUrl === entry.feedUrl;
  if (entry.directUrl) return plugin.url === entry.url && !plugin.feedUrl;
  return !!entry.id && plugin.catalogId === entry.id;
}
function extend(Manager) {
  const init = Manager.prototype.init, snapshot = Manager.prototype.snapshot;
  Manager.prototype.init = async function() {
    await init.call(this);
    this.state.favorites ||= [];
    await this.save(); return this.snapshot();
  };
  Manager.prototype.snapshot = function() {
    const result = snapshot.call(this), favorites = this.state.favorites || [];
    result.catalog = result.catalog.map(entry => ({ ...entry, favoriteId: favorites.find(f => favoriteKey(f.entry) === favoriteKey(entry))?.id }));
    result.favoriteCatalog = favorites.map(f => {
      const entry = result.catalog.find(p => favoriteKey(p) === favoriteKey(f.entry)) || f.entry;
      const source = entry.sourceInstanceId ? this.state.instances.find(v => v.id === entry.sourceInstanceId) : null;
      const unavailable = entry.sourceInstanceId && !source?.plugins.some(p => p.id === entry.sourcePluginId) ? '来源实例或插件已移除，请重新收藏可用插件' : null;
      return { ...entry, favoriteId: f.id, unavailable };
    });
    for (const instance of result.instances) for (const plugin of instance.plugins) {
      plugin.favoriteId = favorites.find(f => matchesInstalled(f.entry, plugin, instance.id))?.id;
    }
    return result;
  };
  Manager.prototype.addFavorite = async function({ catalogId, instanceId, pluginId }) {
    let entry;
    if (catalogId) {
      entry = this.catalog().find(p => p.id === catalogId);
      if (!entry) throw new Error('插件已不在目录中，请刷新后重试');
    } else {
      const plugin = this.instance(instanceId).plugins.find(p => p.id === pluginId && p.kind === 'autoload');
      if (!plugin) throw new Error('只能收藏自动加载插件');
      entry = this.catalog().find(p => p.id === plugin.catalogId);
      if (!entry) {
        entry = { id: plugin.catalogId, name: plugin.name, file: plugin.file, author: plugin.author, description: plugin.description, version: plugin.version, category: '常用插件', section: 'macros' };
        if (plugin.feedUrl) Object.assign(entry, { feedUrl: plugin.feedUrl, sourceUrl: plugin.sourceUrl, feedType: plugin.feedType, namespace: plugin.namespace, depctrl: plugin.depctrl, sourcePlugin: plugin.sourcePlugin });
        else if (plugin.url) Object.assign(entry, { id: `direct-${plugin.url}`, url: plugin.url, directUrl: true });
        else Object.assign(entry, { id: `local-${instanceId}-${pluginId}`, sourceInstanceId: instanceId, sourcePluginId: pluginId });
      }
    }
    const favorites = this.state.favorites || [];
    if (favorites.some(f => favoriteKey(f.entry) === favoriteKey(entry))) return this.snapshot();
    // Store trusted main-process metadata; renderer callers only supply IDs.
    const saved = structuredClone(entry); delete saved.files;
    this.state.favorites = [...favorites, { id: crypto.randomUUID(), created: new Date().toISOString(), entry: saved }];
    try { await this.save(); } catch (error) { this.state.favorites = favorites; throw error; }
    return this.snapshot();
  };
  Manager.prototype.removeFavorite = async function(favoriteId) {
    const previous = this.state.favorites || [];
    if (!previous.some(f => f.id === favoriteId)) throw new Error('收藏已不存在');
    this.state.favorites = previous.filter(f => f.id !== favoriteId);
    try { await this.save(); } catch (error) { this.state.favorites = previous; throw error; }
    return this.snapshot();
  };
  Manager.prototype.resolveFavorite = async function(favorite) {
    const saved = favorite.entry;
    if (saved.feedUrl) {
      const feed = await this.readPluginSource(saved.sourceUrl || saved.feedUrl, saved.feedType || 'auto');
      const entry = feed.packages.find(p => p.section === 'macros' && (saved.depctrl ? p.depctrl && p.namespace === saved.namespace : p.id === saved.id));
      if (!entry) throw new Error(`${saved.name} 已从来源中下架`);
      return entry;
    }
    if (saved.sourceInstanceId) {
      const source = this.state.instances.find(v => v.id === saved.sourceInstanceId);
      if (!source?.plugins.some(p => p.id === saved.sourcePluginId)) throw new Error(`${saved.name} 的来源实例或插件已移除`);
      this.ensureStopped(source.id);
      return saved;
    }
    const live = this.catalog().find(p => favoriteKey(p) === favoriteKey(saved));
    if (!live && !saved.url) throw new Error(`${saved.name} 已不可用，请重新收藏`);
    return live || saved;
  };
  Manager.prototype.installFavorites = async function(id, favoriteIds) {
    this.ensureStopped(id);
    const target = this.instance(id), favorites = this.state.favorites || [];
    if (!Array.isArray(favoriteIds) || !favoriteIds.length) throw new Error('请先收藏插件');
    const selected = [...new Set(favoriteIds)].map(key => {
      const favorite = favorites.find(f => f.id === key);
      if (!favorite) throw new Error('收藏已不存在，请刷新收藏夹');
      return favorite;
    });
    const pending = selected.filter(f => !target.plugins.some(p => matchesInstalled(f.entry, p, id)));
    for (const favorite of pending) {
      if (target.plugins.some(p => p.kind === 'autoload' && p.file.toLowerCase() === favorite.entry.file.toLowerCase())) throw new Error(`当前实例已有来自其他来源的同名插件：${favorite.entry.file}，请先检查并处理`);
    }
    let installed = 0;
    if (pending.length) await this.profileTransaction([id], '安装收藏夹插件', async () => {
      for (const favorite of pending) {
        if (this.abort?.signal.aborted) throw new Error('安装已取消');
        this.progress({ label: `安装收藏 ${installed + 1}/${pending.length}：${favorite.entry.name}`, percent: null });
        const entry = await this.resolveFavorite(favorite);
        await this.installPluginEntry(id, { kind: 'autoload' }, entry);
        installed++;
      }
    });
    return { ...this.snapshot(), favoriteInstallResult: { installed, skipped: selected.length - pending.length } };
  };
}
module.exports = { extend, favoriteKey, matchesInstalled };
