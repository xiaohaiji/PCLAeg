const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parse } = require('jsonc-parser');
const { PROFILE_PATHS, backupInventory, validateRestorePoint } = require('./restore-points.cjs');
async function tree(root, relative = '') {
  const result = [];
  let entries; try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return result; throw e; }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) throw new Error('配置或插件目录包含链接，请先处理后再同步');
    const rel = path.join(relative, ent.name);
    if (ent.isDirectory()) result.push(...await tree(root, rel)); else if (ent.isFile()) result.push(rel);
  }
  return result;
}
function extend(Manager, { inside, exists, writeJSON }) {
  const init = Manager.prototype.init;
  Manager.prototype.init = async function() {
    await init.call(this);
    this.state.preferences = { theme: 'system', autoScan: true, defaultAss: null, ...this.state.preferences };
    this.state.restorePoints ||= [];
    const backupRoot = path.join(this.root, 'cache/restore-points');
    if (await exists(backupRoot)) for (const ent of await fs.readdir(backupRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^[a-f\d-]{36}$/i.test(ent.name) || this.state.restorePoints.some(p => p.id === ent.name)) continue;
      try { const point = JSON.parse(await fs.readFile(inside(backupRoot, path.join(backupRoot, ent.name, 'point.json')), 'utf8')); if (point.id === ent.name && Array.isArray(point.records) && point.records.length && point.records.every(r => this.state.instances.some(v => v.id === r.instanceId))) this.state.restorePoints.push({ ...point, status: 'interrupted' }); } catch {}
    }
    this.state.restorePoints.sort((a, b) => b.created.localeCompare(a.created));
    return this.checkRestorePoints();
  };
  Manager.prototype.checkRestorePoints = async function() {
    for (const point of this.state.restorePoints) {
      try { await validateRestorePoint(this.root, point); delete point.backupError; }
      catch (error) { point.backupError = error.message; }
    }
    await this.save(); return this.snapshot();
  };
  Manager.prototype.setPreference = async function(key, value) {
    if (key === 'theme' && !['system', 'light', 'dark'].includes(value) || key === 'autoScan' && typeof value !== 'boolean' || !['theme', 'autoScan', 'defaultAss'].includes(key)) throw new Error('设置值无效');
    if (key === 'defaultAss' && value !== null) this.instance(value);
    this.state.preferences[key] = value; await this.save(); return this.snapshot();
  };
  Manager.prototype.createRestorePoint = async function(ids, label) {
    const id = crypto.randomUUID(), base = inside(path.join(this.root, 'cache', 'restore-points'), path.join(this.root, 'cache', 'restore-points', id));
    const records = [];
    try {
      for (const instanceId of [...new Set(ids)]) {
        this.ensureStopped(instanceId); const v = this.instance(instanceId), root = path.dirname(this.appDir(v));
        const paths = [];
        for (const relative of PROFILE_PATHS) {
          const input = inside(root, path.join(root, relative)), present = await exists(input); paths.push({ relative, present });
          if (present) {
            const stat = await fs.lstat(input); if (stat.isSymbolicLink()) throw new Error('无法备份包含链接的配置');
            if (stat.isDirectory()) await tree(input);
            await fs.cp(input, path.join(base, instanceId, relative), { recursive: stat.isDirectory() });
          }
        }
        const recordRoot = path.join(base, instanceId); await fs.mkdir(recordRoot, { recursive: true });
        records.push({ instanceId, name: v.name, exe: v.exe, plugins: structuredClone(v.plugins), dependencyPackages: structuredClone(v.dependencyPackages), paths, backupInventory: await backupInventory(recordRoot) });
      }
      const point = { id, label, created: new Date().toISOString(), records, status: 'ready' };
      await writeJSON(path.join(base, 'point.json'), point); return point;
    } catch (e) { await fs.rm(base, { recursive: true, force: true }); throw e; }
  };
  Manager.prototype.applyRestorePoint = async function(point) {
    await validateRestorePoint(this.root, point);
    const base = inside(path.join(this.root, 'cache', 'restore-points'), path.join(this.root, 'cache', 'restore-points', point.id));
    for (const record of point.records) {
      this.ensureStopped(record.instanceId); const v = this.instance(record.instanceId), root = path.dirname(this.appDir(v));
      if (v.exe !== record.exe) throw new Error('启动文件已改变，不能将旧配置恢复到其他目录');
      for (const item of record.paths) if (!PROFILE_PATHS.includes(item.relative)) throw new Error('恢复点路径无效');
    }
    for (const record of point.records) {
      const v = this.instance(record.instanceId), root = path.dirname(this.appDir(v));
      for (const { relative, present } of record.paths) {
        const dest = inside(root, path.join(root, relative));
        await fs.rm(dest, { recursive: true, force: true });
        if (present) await fs.cp(inside(base, path.join(base, record.instanceId, relative)), dest, { recursive: true });
      }
      v.plugins = structuredClone(record.plugins); if (record.dependencyPackages === undefined) delete v.dependencyPackages; else v.dependencyPackages = structuredClone(record.dependencyPackages);
    }
    await this.save();
  };
  Manager.prototype.profileTransaction = async function(ids, label, fn) {
    if (this.profileTransactionActive) return fn();
    const point = await this.createRestorePoint(ids, label); this.profileTransactionActive = true;
    try {
      await fn();
      await this.recordRestorePoint(point);
      return this.snapshot();
    } catch (error) {
      try { await this.applyRestorePoint(point); point.status = 'auto-restored'; await this.recordRestorePoint(point); }
      catch (restoreError) { point.status = 'restore-failed'; await this.recordRestorePoint(point); throw new Error(`${error.message}；自动回滚失败：${restoreError.message}，恢复点 ${point.id} 已保留`); }
      throw error;
    } finally { this.profileTransactionActive = false; }
  };
  Manager.prototype.recordRestorePoint = async function(point) {
    const records = this.state.restorePoints.filter(p => p.id !== point.id), retired = records.slice(9);
    this.state.restorePoints = [point, ...records].slice(0, 10); await this.save();
    for (const old of retired) try { await fs.rm(inside(path.join(this.root, 'cache/restore-points'), path.join(this.root, 'cache/restore-points', old.id)), { recursive: true, force: true }); } catch {}
  };
  Manager.prototype.restoreProfile = async function(pointId) {
    const point = this.state.restorePoints.find(p => p.id === pointId); if (!point) throw new Error('找不到恢复点');
    try { await validateRestorePoint(this.root, point); delete point.backupError; }
    catch (error) { point.backupError = error.message; await this.save(); throw error; }
    return this.profileTransaction(point.records.map(r => r.instanceId), '撤销回滚', () => this.applyRestorePoint(point));
  };
  Manager.prototype.previewSync = async function({ sourceId, targetIds, config = true, plugins = true, hotkeys = true, policy = 'keep' }) {
    const source = this.instance(sourceId); this.ensureStopped(sourceId);
    if (!Array.isArray(targetIds) || !targetIds.length || targetIds.includes(sourceId) || !['keep', 'source'].includes(policy) || ![config, plugins, hotkeys].some(Boolean)) throw new Error('请选择其他目标实例及同步内容');
    const from = path.dirname(this.appDir(source)), items = [];
    for (const targetId of [...new Set(targetIds)]) {
      this.ensureStopped(targetId); const target = this.instance(targetId), to = path.dirname(this.appDir(target));
      const files = []; if (config) { files.push('config.json', ...await tree(from, 'config'), ...await tree(from, 'dictionaries')); } if (hotkeys) files.push('hotkey.json'); if (plugins) files.push(...await tree(from, 'automation'));
      const changes = [], conflicts = [];
      for (const rel of [...new Set(files)]) {
        const input = inside(from, path.join(from, rel)); if (!await exists(input)) continue;
        const dest = inside(to, path.join(to, rel)); const present = await exists(dest), bytes = await fs.readFile(input);
        if (present && bytes.equals(await fs.readFile(dest))) continue;
        changes.push({ relative: rel, action: present ? 'replace' : 'add' });
        if (present && /automation[\\/](?:launcher[\\/])?include[\\/]/.test(rel)) conflicts.push(rel);
      }
      items.push({ id: targetId, name: target.name, changes, conflicts });
    }
    return { source: source.name, items, policy, config, plugins, hotkeys };
  };
  Manager.prototype.syncProfiles = async function(options) {
    const preview = await this.previewSync(options), source = this.instance(options.sourceId), from = path.dirname(this.appDir(source));
    return this.profileTransaction(preview.items.map(t => t.id), `从 ${source.name} 同步配置 / 插件`, async () => {
      for (const item of preview.items) {
        const target = this.instance(item.id), to = path.dirname(this.appDir(target));
        let oldDC = null;
        if (await exists(path.join(to, 'config/l0.DependencyControl.json'))) oldDC = parse(await fs.readFile(path.join(to, 'config/l0.DependencyControl.json'), 'utf8'), [], { allowTrailingComma: true });
        if (preview.plugins) {
          for (const p of target.plugins.filter(p => p.kind === 'autoload' && !p.enabled)) await fs.rm(this.pluginPath(target, p), { force: true });
          for (const rel of ['automation/autoload', 'automation/launcher/autoload']) await fs.rm(inside(to, path.join(to, rel)), { recursive: true, force: true });
        }
        for (const change of item.changes) {
          if (preview.policy === 'keep' && item.conflicts.includes(change.relative)) continue;
          const dest = inside(to, path.join(to, change.relative)); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(inside(from, path.join(from, change.relative)), dest);
        }
        // Autoload files deleted above must also be copied when their bytes were unchanged.
        if (preview.plugins) {
          for (const rel of ['automation/autoload', 'automation/launcher/autoload', 'automation/launcher/disabled']) if (await exists(path.join(from, rel))) await fs.cp(path.join(from, rel), inside(to, path.join(to, rel)), { recursive: true });
          const retained = target.plugins.filter(p => p.kind === 'include');
          target.plugins = [...retained, ...source.plugins.filter(p => p.kind === 'autoload' || !p.enabled && !retained.some(q => q.file === p.file)).map(p => ({ ...structuredClone(p), id: crypto.randomUUID() }))];
          target.dependencyPackages ||= {};
          for (const [name, pkg] of Object.entries(source.dependencyPackages || {})) {
            let copied = !!pkg.files?.length;
            for (const file of pkg.files || []) if (!await exists(path.join(to, file)) || !(await fs.readFile(inside(from, path.join(from, file)))).equals(await fs.readFile(inside(to, path.join(to, file))))) { copied = false; break; }
            if (copied) target.dependencyPackages[name] = structuredClone(pkg);
          }
        }
        const dcPath = path.join(to, 'config/l0.DependencyControl.json');
        if (await exists(dcPath)) {
          const errors = [], cfg = parse(await fs.readFile(dcPath, 'utf8'), errors, { allowTrailingComma: true }); if (errors.length || !cfg) throw new Error('DependencyControl 配置格式错误');
          if (!preview.plugins) { cfg.macros = oldDC?.macros || {}; cfg.modules = oldDC?.modules || {}; }
          else if (await exists(path.join(from, 'config/l0.DependencyControl.json'))) {
            const sourceDC = parse(await fs.readFile(path.join(from, 'config/l0.DependencyControl.json'), 'utf8'), [], { allowTrailingComma: true });
            cfg.macros = structuredClone(sourceDC?.macros || {});
            if (preview.policy === 'keep') cfg.modules = { ...sourceDC?.modules, ...oldDC?.modules };
          }
          if (cfg.$schema) { cfg.config ||= {}; cfg.config.paths = { ...cfg.config.paths, config: '?user/config', log: '?user/log', cache: '?user/cache' }; }
          else { cfg.config ||= {}; cfg.config.configDir = '?user/config'; cfg.config.logDir = '?user/log'; }
          await writeJSON(dcPath, cfg);
        }
        await this.portable(this.appDir(target)); await this.scanInstance(target);
        if (preview.plugins) { const graph = await this.dependencyGraph(target.id); if (graph.conflicts.length || graph.missing.length) throw new Error(`${target.name} 的依赖不满足，同步已回滚：${graph.conflicts[0]?.message || graph.missing[0].namespace + ' 缺失'}`); }
      }
      await this.save();
    });
  };
  for (const [method, label] of [['addPlugin', '安装 / 更新插件'], ['togglePlugin', '切换插件状态'], ['removePlugin', '卸载插件'], ['changeExecutable', '更换启动程序']]) {
    const original = Manager.prototype[method];
    Manager.prototype[method] = async function(id, ...args) { return this.profileTransaction([id], label, () => original.call(this, id, ...args)); };
  }
}
module.exports = { extend, tree };
