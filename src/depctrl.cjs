const path = require('node:path');

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('DependencyControl 源和文件链接必须使用 HTTPS');
  return url.href;
}
function expand(value, vars) {
  if (typeof value !== 'string') return value;
  for (let i = 0; i < 20; i++) {
    const next = value.replace(/@\{([^{}]+)\}/g, (marker, key) => {
      const split = key.indexOf(':');
      const result = split < 0 ? vars[key] : vars[key.slice(0, split)]?.[key.slice(split + 1)];
      return typeof result === 'string' || typeof result === 'number' ? String(result) : marker;
    });
    if (next === value) break;
    value = next;
  }
  return value;
}
function safeFile(namespace, section, suffix) {
  if (typeof suffix !== 'string' || !/^[./]/.test(suffix) || suffix.includes('\\')) throw new Error('源包含无效文件名');
  const file = (section === 'modules' ? namespace.replace(/\./g, '/') : namespace) + suffix;
  if (file.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error('源包含不安全的文件路径');
  return file;
}
function windowsFile(file) {
  return !file.platform || /^(windows|win)([-_ ]?(x64|64|amd64))?$/i.test(file.platform);
}
function parseFeed(data, feedUrl) {
  httpsUrl(feedUrl);
  if (!data || typeof data !== 'object' || !/^0\.[234]\./.test(data.dependencyControlFeedFormatVersion || '')) throw new Error('不是受支持的 DependencyControl JSON 源（需要 0.2 / 0.3 / 0.4 格式）');
  const packages = [], diagnostics = [];
  for (const section of ['macros', 'modules']) for (const [namespace, pkg] of Object.entries(data[section] || {})) {
    if (!pkg?.channels) continue;
    try {
      if (!/^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u.test(namespace)) throw new Error('源包含无效的插件命名空间');
      const channels = Object.entries(pkg.channels).filter(([, c]) => c && typeof c === 'object' && Array.isArray(c.files));
      const selected = channels.find(([, c]) => c.default === true);
      if (!selected) throw new Error('包缺少包含文件列表的默认频道');
      const [channel, release] = selected;
      if (release.platforms && !release.platforms.some(platform => windowsFile({ platform }))) continue;
      const vars = { ...data.vars, feedName: data.name, baseUrl: data.baseUrl, feed: data.knownFeeds, namespace, namespacePath: namespace.replace(/\./g, '/'), scriptTypeSection: section, scriptType: section === 'macros' ? 'automation' : 'module', scriptName: pkg.name, channel, version: release.version };
      const layers = [data, data[section], pkg, pkg.channels, release];
      let fileBaseUrl = '', fileBaseUrls = {}, homepage = data.url;
      for (const layer of layers) {
        if (layer.fileBaseUrl) fileBaseUrl = expand(layer.fileBaseUrl, { ...vars, fileBaseUrl });
        if (layer.fileBaseUrls) fileBaseUrls = Object.fromEntries(Object.entries(layer.fileBaseUrls).map(([key, value]) => [key, expand(value, { ...vars, fileBaseUrl })]));
        if (layer.url) homepage = layer.url;
      }
      const files = release.files.filter(file => !file.delete && (file.type || 'script') === 'script' && windowsFile(file)).map(file => {
        const relative = safeFile(namespace, section, file.name);
        const context = { ...vars, fileName: file.name, platform: file.platform, fileBaseUrl: expand(file.fileBaseUrl || fileBaseUrls.script || fileBaseUrl, { ...vars, fileName: file.name, platform: file.platform, fileBaseUrl }) };
        const url = expand(file.url || '@{fileBaseUrl}@{fileName}', context);
        if (url.includes('@{')) throw new Error(`插件 ${namespace} 的下载链接包含无法识别的变量`);
        if (file.sha1 && !/^[a-f\d]{40}$/i.test(file.sha1)) throw new Error(`插件 ${namespace} 的 SHA-1 校验值无效`);
        return { relative, url: httpsUrl(url), sha1: file.sha1?.toLowerCase() || null };
      });
      if (!files.length) continue;
      if (new Set(files.map(file => file.relative.toLowerCase())).size !== files.length) throw new Error('包包含重复的 Windows 文件路径');
      const prefix = section === 'modules' ? namespace.replace(/\./g, '/') : namespace;
      const main = files.find(file => file.relative === prefix + '.moon') || files.find(file => file.relative === prefix + '.lua') || (section === 'modules' && files.find(file => file.relative === prefix + '.dll')) || (section === 'modules' && files.find(file => file.relative === prefix + '.exe'));
      if (!main) throw new Error('包缺少可识别的主脚本或模块');
      const expandedHomepage = homepage ? expand(homepage, vars).replace(/^http:/, 'https:') : null;
      const requirements = (release.requiredModules || pkg.requiredModules || []).map(m => typeof m === 'string' ? m : Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'string' ? expand(v, vars) : v])));
      packages.push({ id: `depctrl-${feedUrl}-${namespace}`, depctrl: true, namespace, section, name: pkg.name || namespace, file: path.posix.basename(main.relative), main: main.relative, files, version: release.version || '未声明', author: pkg.author || data.maintainer || '', description: pkg.description || data.description || '', category: 'DependencyControl', homepage: expandedHomepage ? httpsUrl(expandedHomepage) : undefined, feedUrl, channel, requiredModules: requirements, provides: release.provides || pkg.provides || [], compatibility: '依赖版本先在启动器内检查，DependencyControl 保持后续更新。' });
    } catch (error) { diagnostics.push({ section, namespace, message: error.message }); }
  }
  const known = data.knownFeeds || data.knownfeeds || data.knownFeed || data.knownfeed || [];
  const expandKnown = item => typeof item === 'string' ? expand(item, { ...data.vars, baseUrl: data.baseUrl, feedName: data.name }) : item;
  return { url: feedUrl, manifestUrl: feedUrl, name: data.name || feedUrl, packages, diagnostics,
    moduleCount: packages.filter(p => p.section === 'modules').length,
    knownFeeds: Array.isArray(known) ? known.map(expandKnown) : typeof known === 'string' ? expandKnown(known) : Object.fromEntries(Object.entries(known).map(([k, v]) => [k, expandKnown(v)])) };
}
module.exports = { parseFeed, httpsUrl, safeFile };
