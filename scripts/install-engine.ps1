# Black Mirror — engine acquisition helper (optional CLI shortcut)
# Installs an inference engine into Black Mirror's isolated engines folder.
# Equivalent to clicking Install in Inference Engines.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('llamacpp-cpu','llamacpp-vulkan','llamacpp-sycl','lemonade','ollama')][string]$Engine,
  [string]$Tag
)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
node -e "
const os = require('os'), path = require('path');
const dataDir = process.env.BLACK_MIRROR_DATA_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'BlackMirror');
const { EngineRegistry } = require('./main/engines/registry');
const { EngineInstaller } = require('./main/engines/installer');
const { Logger } = require('./main/core/log');
const logger = new Logger(path.join(dataDir, 'logs'));
const reg = new EngineRegistry(dataDir, logger);
const inst = new EngineInstaller(reg, logger, { onProgress: p => {
  if (p.stage === 'downloading') process.stdout.write('\rdownloading... ' + (p.ratio ? Math.round(p.ratio*100) + '%' : Math.round(p.received/1e6) + ' MB'));
  else if (p.stage) console.log('\n' + p.stage);
}});
inst.install('$Engine', { tag: '$Tag' || undefined }).then(r => {
  console.log('\nInstalled', r.tag, '->', r.dir);
  console.log('Black Mirror will use this version automatically.');
}).catch(e => { console.error('Install failed:', e.message); process.exit(1); });
"
