const path = require('node:path');
const { parseFeed } = require('./depctrl.cjs');
const { parse: parseJSONC } = require('jsonc-parser');

const SOURCE_TYPES = ['auto', 'depctrl', 'github', 'json', 'script'];
const parseJSON = text => {
  const errors = [];
  const data = parseJSONC(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error('插件源 JSON 格式错误');
  return data;
};
function sourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('插件源和下载链接必须使用 HTTPS');
  url.hash = '';
  return url.href;
}
function normalizeKnownFeeds(value, baseUrl) {
  const declarations = typeof value === 'string' ? [[value, value]] : Array.isArray(value)
    ? value.map(item => [typeof item === 'string' ? item : item?.name, item])
    : value && typeof value === 'object' ? Object.entries(value) : [];
  const result = new Map();
  for (const [label, item] of declarations) {
    const input = typeof item === 'string' ? item : item?.url || item?.feed;
    if (typeof input !== 'string') continue;
    try {
      const url = sourceUrl(new URL(input, baseUrl).href);
      if (url !== sourceUrl(baseUrl) && !result.has(url)) result.set(url, { url, name: typeof label === 'string' && label !== input ? label : item?.name || url });
    } catch { /* One malformed reference must not prevent a valid source from loading. */ }
  }
  return [...result.values()];
}
function scriptName(value) {
  if (typeof value !== 'string' || !/\.(lua|moon)$/i.test(value) || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) throw new Error('源中的脚本文件名无效，请使用 .lua 或 .moon 文件');
  return value;
}
function rawScriptUrl(input) {
  const url = new URL(sourceUrl(input));
  if (url.hostname.toLowerCase() === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[2] === 'blob' && parts.length >= 5) return sourceUrl(`https://raw.githubusercontent.com/${parts.slice(0, 2).join('/')}/${parts.slice(3).join('/')}`);
  }
  return url.href;
}
function entryForScript(item, feedUrl, type, identity) {
  if (typeof item === 'string') item = { url: item };
  if (!item || typeof item !== 'object') throw new Error('JSON 插件列表中的条目无效');
  const url = rawScriptUrl(new URL(item.url || item.downloadUrl || item.download_url || '', feedUrl).href);
  if (!item.url && !item.downloadUrl && !item.download_url) throw new Error('JSON 插件条目缺少 url 下载链接');
  const file = scriptName(item.file || decodeURIComponent(new URL(url).pathname.split('/').pop()));
  if (item.kind && item.kind !== 'autoload') throw new Error('插件源中的条目需要是自动加载脚本');
  if (item.sha256 && !/^[a-f\d]{64}$/i.test(item.sha256)) throw new Error('插件 SHA-256 校验值无效');
  return { id: `source-${feedUrl}-${identity || file}`, sourcePlugin: true, section: 'macros', feedUrl, feedType: type, file, url, name: item.name || file, author: item.author || '', description: item.description || '从插件源安装到当前版本。', version: item.version || '未声明', category: item.category || '插件源', homepage: item.homepage ? sourceUrl(item.homepage) : undefined, sha256: item.sha256?.toLowerCase(), gitBlobSha: item.gitBlobSha };
}
function parseList(data, url) {
  const declarations = data?.knownFeeds || data?.knownfeeds || data?.knownFeed || data?.knownfeed;
  const list = Array.isArray(data) ? data : data?.plugins || data?.scripts || (declarations ? [] : undefined);
  if (!Array.isArray(list)) throw new Error('JSON 插件源需要 plugins 或 scripts 数组，或直接使用条目数组');
  if (!list.length && !declarations || list.length > 1000) throw new Error('JSON 插件源需要包含脚本或 knownFeeds，最多 1000 个脚本');
  const packages = list.map(item => entryForScript(item, url, 'json'));
  if (new Set(packages.map(p => p.file.toLowerCase())).size !== packages.length) throw new Error('JSON 插件源含有重复文件名，请为每个脚本指定唯一的 file');
  return { url, manifestUrl: url, type: 'json', name: data.name || 'JSON 插件源', packages, knownFeeds: declarations || [] };
}
async function githubSource(url, read, auto) {
  const parsed = new URL(url), parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parsed.hostname.toLowerCase() === 'gist.github.com') {
    const id = parts.at(-1);
    if (!/^[a-f\d]+$/i.test(id || '')) throw new Error('请输入具体的 GitHub Gist 链接');
    const gist = parseJSON(await read(`https://api.github.com/gists/${id}`));
    if (gist.truncated) throw new Error('此 Gist 文件列表不完整，请添加具体脚本链接');
    const files = Object.values(gist.files || {}).filter(f => /\.(lua|moon)$/i.test(f.filename));
    return { url, type: 'github', name: gist.description || `Gist · ${id}`, packages: files.map(f => entryForScript({ file: f.filename, url: f.raw_url, author: gist.owner?.login, homepage: gist.html_url }, url, 'github', f.filename)) };
  }
  if (parsed.hostname.toLowerCase() !== 'github.com' || parts.length < 2 || parts.length > 2 && parts[2] !== 'tree') throw new Error('请输入 GitHub 仓库、目录或 Gist 链接');
  const [owner, repository] = parts, repo = repository.replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('GitHub 仓库地址无效');
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const metadata = parseJSON(await read(base));
  let ref = metadata.default_branch, folder = '', tree;
  if (parts[2] === 'tree') {
    const suffix = parts.slice(3);
    if (!suffix.length) throw new Error('GitHub 目录链接缺少分支名');
    const defaultParts = ref.split('/');
    if (defaultParts.every((part, i) => suffix[i] === part)) { folder = suffix.slice(defaultParts.length).join('/'); }
    else {
      // Resolve a branch/tag containing slashes without mistaking the folder for the ref.
      for (let count = Math.min(suffix.length, 12); count > 0; count--) {
        ref = suffix.slice(0, count).join('/');
        try { tree = parseJSON(await read(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`)); folder = suffix.slice(count).join('/'); break; }
        catch (error) { if (error.status !== 404 && error.status !== 422) throw error; }
      }
      if (!tree) throw new Error('找不到 GitHub 目录对应的分支或标签');
    }
  }
  tree ||= parseJSON(await read(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`));
  if (tree.truncated) throw new Error('GitHub 文件列表被截断，请添加更小仓库或具体脚本链接');
  const files = (tree.tree || []).filter(f => f.type === 'blob' && f.mode !== '120000' && (!folder || f.path.startsWith(folder + '/')));
  const raw = file => `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${file.split('/').map(encodeURIComponent).join('/')}`;
  if (auto) {
    const manifest = files.find(f => f.path === [folder, 'DependencyControl.json'].filter(Boolean).join('/'));
    if (manifest) { const feed = parseFeed(parseJSON(await read(raw(manifest.path))), raw(manifest.path)); return { ...feed, url, type: 'depctrl', detectedFrom: 'github' }; }
  }
  const scripts = files.filter(f => /\.(lua|moon)$/i.test(f.path) && !/(^|\/)(include|modules|tests?|demos?|examples?|vendor|node_modules|\.github)(\/|$)/i.test(f.path));
  const macroFolders = scripts.some(f => /(^|\/)(macros|autoload)\//i.test(f.path));
  const selected = macroFolders ? scripts.filter(f => /(^|\/)(macros|autoload)\//i.test(f.path)) : scripts;
  if (selected.length > 1000) throw new Error('此仓库有超过 1000 个脚本，请添加具体目录');
  return { url, type: 'github', name: `${owner}/${repo}${folder ? ' · ' + folder : ''}`, packages: selected.map(f => entryForScript({ url: raw(f.path), file: path.posix.basename(f.path), author: owner, description: f.path, homepage: `${metadata.html_url || `https://github.com/${owner}/${repo}`}/blob/${encodeURIComponent(ref)}/${f.path.split('/').map(encodeURIComponent).join('/')}`, gitBlobSha: f.sha }, url, 'github', f.path)) };
}
async function loadSource(input, type, read) {
  if (!SOURCE_TYPES.includes(type)) throw new Error('插件源类型无效');
  const url = sourceUrl(input.trim()), parsed = new URL(url);
  let feed;
  if (type === 'github' || type === 'auto' && /^(github\.com|gist\.github\.com)$/i.test(parsed.hostname) && !/\/blob\//.test(parsed.pathname)) feed = await githubSource(url, read, type === 'auto');
  else {
    const remoteUrl = rawScriptUrl(url);
    const text = (await read(remoteUrl)).replace(/^\uFEFF/, '');
    if (/^\s*<!doctype|^\s*<html/i.test(text)) throw new Error('这个地址返回的是网页，请填写仓库链接、JSON 源或脚本的原始下载链接');
    if (type === 'script' || type === 'auto' && /\.(lua|moon)$/i.test(new URL(remoteUrl).pathname)) {
      const field = name => text.match(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?${name}\\s*=\\s*["']([^"'\\r\\n]+)`))?.[1];
      const p = entryForScript({ url: remoteUrl, name: field('script_name'), author: field('script_author'), description: field('script_description'), version: field('script_version') }, url, 'script');
      feed = { url, type: 'script', name: p.name, packages: [p] };
    } else {
      let data; try { data = parseJSON(text); } catch { throw new Error('无法识别此插件源，请提供 GitHub 仓库、JSON 插件列表或 .lua / .moon 脚本链接'); }
      feed = type === 'depctrl' || type === 'auto' && data?.dependencyControlFeedFormatVersion ? { ...parseFeed(data, remoteUrl), url, type: 'depctrl' } : parseList(data, url);
    }
  }
  const knownFeeds = normalizeKnownFeeds(feed.knownFeeds, feed.manifestUrl || url);
  if (!feed.packages.length && !feed.moduleCount && !knownFeeds.length) throw new Error(feed.diagnostics?.length ? `源中没有可用的包：${feed.diagnostics.map(d => `${d.namespace}：${d.message}`).join('；')}` : '这个源没有插件脚本、依赖模块或关联源');
  return { ...feed, knownFeeds, requestedType: type, packages: feed.packages.map(p => ({ ...p, sourceUrl: url, feedType: type })) };
}
module.exports = { loadSource, parseList, sourceUrl, scriptName, normalizeKnownFeeds };
