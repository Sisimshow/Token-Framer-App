// Builds the release zip: `node tools/make-release.mjs` (from app/) -> ../dist/Token-Framer-App-<version>-win-x64.zip
// Same layout as the source: "Token Framer App.bat" at the top and the app in app/, with the node_modules it needs to run already in place (Electron's runtime,
// onnxruntime-node with only its Windows x64 binaries), so there is no npm install and no renamed exe. No dependency: the zip is made with the `tar` that ships
// with Windows 10+. Dev files (.claude, VS Code workspace, tests, converters, fixtures) are left out on purpose.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '..');
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const name = `Token-Framer-App-${pkg.version}-win-x64`;
const dist = join(root, 'dist');
const top = join(dist, 'Token Framer App');
const out = join(top, 'app');

rmSync(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); // Defender can hold a freshly copied exe for a few seconds
mkdirSync(out, { recursive: true });
cpSync(join(root, 'Token Framer App.bat'), join(top, 'Token Framer App.bat'));
for (const f of ['main.cjs', 'modelrun.cjs', 'preload.cjs', 'LICENSE']) cpSync(join(app, f), join(out, f));
for (const d of ['renderer', 'assets']) cpSync(join(app, d), join(out, d), { recursive: true });
mkdirSync(join(out, 'models'));
for (const f of readdirSync(join(app, 'models'))) if (f.endsWith('.json') || f.endsWith('.onnx')) cpSync(join(app, 'models', f), join(out, 'models', f)); // scale/size rules plus the converted models found here (gitignored; licences unchecked: fine while the repo is private, recheck before it goes public)
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, private: true, license: pkg.license, author: pkg.author }, null, 2));

// runtime: Electron (only its dist folder, which is what the .bat starts) + onnxruntime-node (Windows x64 only) + onnxruntime-common
const nm = join(out, 'node_modules');
cpSync(join(app, 'node_modules', 'electron', 'dist'), join(nm, 'electron', 'dist'), { recursive: true });
cpSync(join(app, 'node_modules', 'onnxruntime-common'), join(nm, 'onnxruntime-common'), { recursive: true });
cpSync(join(app, 'node_modules', 'onnxruntime-node'), join(nm, 'onnxruntime-node'), { recursive: true });
const napi = join(nm, 'onnxruntime-node', 'bin', 'napi-v6');
for (const os of readdirSync(napi)) {
  if (os !== 'win32') { rmSync(join(napi, os), { recursive: true, force: true }); continue; }
  for (const arch of readdirSync(join(napi, os))) if (arch !== 'x64') rmSync(join(napi, os, arch), { recursive: true, force: true });
}

writeFileSync(join(top, 'README.txt'), `Token Framer ${pkg.version}\r\n\r\nDouble-click "Token Framer App.bat". No install needed; delete the folder to remove the program.\r\nSettings are kept in %APPDATA%\\${pkg.name}.\r\nThe AI cutout downloads its model (RMBG-2.0, about 0.5 GB, non-commercial licence) the first time you use it.\r\nThe Clean image / Upscale image models are in app\\models (personal use).\r\n`);

const zip = join(dist, `${name}.zip`);
// Windows' own bsdtar (a GNU tar earlier on PATH cannot write zips and reads "F:\..." as a remote host); relative names, run inside dist
execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', `${name}.zip`, 'Token Framer App'], { cwd: dist, stdio: 'inherit' });
console.log('built', zip, existsSync(zip));
