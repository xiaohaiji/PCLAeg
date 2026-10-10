const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const { associationValues } = require('./platform.cjs');

// Query the Shell's effective association, including Windows UserChoice, without writing it.
const statusScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PCLAegAssociation {
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern int AssocQueryStringW(uint flags, uint kind, string association, string extra, StringBuilder value, ref uint length);
  public static string Query(string extension, uint kind) {
    uint size = 0;
    int result = AssocQueryStringW(0, kind, extension, null, null, ref size);
    if (size == 0 || size > 32768) throw new Exception("Association query failed: " + result);
    var value = new StringBuilder((int)size);
    result = AssocQueryStringW(0, kind, extension, null, value, ref size);
    if (result != 0) throw new Exception("Association query failed: " + result);
    return value.ToString();
  }
}
'@
$taskKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\PCLAeg.ASS\shell\open\command')
$taskCommand = $null
if ($taskKey) { try { $taskCommand = $taskKey.GetValue('') } finally { $taskKey.Dispose() } }
$taskExtensions = @('.ass', '.ssa') | ForEach-Object {
  $taskExtension = $_
  try { @{ extension=$taskExtension; progId=[PCLAegAssociation]::Query($taskExtension,20); command=[PCLAegAssociation]::Query($taskExtension,1) } }
  catch { @{ extension=$taskExtension; error=$_.Exception.Message } }
}
@{ registration=$taskCommand; extensions=@($taskExtensions) } | ConvertTo-Json -Depth 4 -Compress
`;

async function readAssociationStatus(executable, prefix = [], runner = exec, access = fs.access) {
  const unknown = message => ({ registration: 'unknown', error: message, extensions: ['.ass', '.ssa'].map(extension => ({ extension, status: 'unknown' })) });
  if (process.platform !== 'win32') return unknown('文件关联仅支持 Windows');
  try {
    const expected = associationValues(executable, prefix).find(([key]) => key.endsWith('shell\\open\\command'))[2];
    const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(statusScript, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
    const data = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    if (!Object.hasOwn(data, 'registration') || !Array.isArray(data.extensions)) throw new Error('关联查询返回了无效数据');
    let registration = data.registration == null ? 'missing' : typeof data.registration === 'string' && data.registration.toLowerCase() === expected.toLowerCase() ? 'valid' : 'stale';
    if (registration === 'valid') try { await access(executable); for (const file of prefix) await access(file); } catch { registration = 'stale'; }
    return { registration, extensions: ['.ass', '.ssa'].map(extension => {
      const item = data.extensions.find(e => e.extension === extension);
      const status = !item || item.error || typeof item.progId !== 'string' || !item.progId || item.progId.toLowerCase() === 'unknown' || typeof item.command !== 'string' || !item.command ? 'unknown'
        : item.progId.toLowerCase() === 'pclaeg.ass' ? registration === 'valid' && item.command.toLowerCase() === expected.toLowerCase() ? 'launcher' : 'stale' : 'other';
      return { extension, status, progId: item?.progId || null };
    }) };
  } catch (error) { return unknown(error.message); }
}

async function openDefaultSettings(openExternal, general = false) {
  if (!general) try { await openExternal('ms-settings:defaultapps?registeredAppUser=Aegisub%20Launcher'); return; } catch {}
  await openExternal('ms-settings:defaultapps');
}

function subtitleArguments(argv, workingDirectory = process.cwd()) {
  return argv.filter(arg => typeof arg === 'string' && /\.(ass|ssa)$/i.test(arg)).map(file => path.resolve(workingDirectory, file));
}

class SubtitleQueue {
  constructor(onError = () => {}) { this.onError = onError; this.requests = []; this.ready = false; this.draining = null; }
  enqueue(files) { for (let i = 0; i < files.length; i += 16) this.requests.push(files.slice(i, i + 16)); return this.drain(); }
  start(manager) { this.manager = manager; this.ready = true; return this.drain(); }
  pause() { this.ready = false; }
  pendingFiles() { return this.requests.flat(); }
  drain() {
    if (!this.ready || this.draining) return this.draining || Promise.resolve();
    this.draining = (async () => {
      while (this.ready && this.requests.length) {
        await this.manager.mutate(async () => {
          if (!this.ready) return;
          const files = this.requests.shift();
          try {
            const id = this.manager.state.preferences.defaultAss || this.manager.state.selected;
            if (!id) throw new Error('请先导入 Aegisub，并在设置中选择 ASS 默认实例');
            await this.manager.launch(id, files);
            this.manager.progress({ stateChanged: true });
          } catch (error) { this.onError(error); }
        }, { wait: true });
      }
    })().finally(() => { this.draining = null; if (this.ready && this.requests.length) this.drain(); });
    return this.draining;
  }
}
module.exports = { readAssociationStatus, openDefaultSettings, subtitleArguments, SubtitleQueue };
