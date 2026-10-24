// Builds the portable Windows release: `node tools/make-portable.mjs` (from app/) -> ../dist/Token-Framer-App-<version>-win-x64.zip
// No dependency: the Electron runtime is copied from node_modules, the app goes in resources/app (no asar), only the Windows x64 onnxruntime binaries are kept,
// and the zip is made with the `tar` that ships with Windows 10+. Dev files (.claude, VS Code workspace, tests, converters, fixtures) are left out on purpose.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit'; // dev dependency: writes the icon and version info into the exe

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '..');
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const name = `Token-Framer-App-${pkg.version}-win-x64`;
const dist = join(root, 'dist');
const dir = join(dist, 'Token Framer');
const res = join(dir, 'resources', 'app');

rmSync(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
mkdirSync(dist, { recursive: true });
cpSync(join(app, 'node_modules', 'electron', 'dist'), dir, { recursive: true });
renameSync(join(dir, 'electron.exe'), join(dir, 'Token Framer.exe'));
rmSync(join(dir, 'resources', 'default_app.asar'), { force: true });
await rcedit(join(dir, 'Token Framer.exe'), {
  icon: join(app, 'assets', 'icon.ico'),
  'version-string': { ProductName: 'Token Framer', FileDescription: 'Token Framer', CompanyName: pkg.author, LegalCopyright: `MIT, ${pkg.author}`, OriginalFilename: 'Token Framer.exe', InternalName: 'Token Framer' },
  'file-version': pkg.version, 'product-version': pkg.version,
});

mkdirSync(res, { recursive: true });
for (const f of ['main.cjs', 'modelrun.cjs', 'preload.cjs', 'LICENSE']) cpSync(join(app, f), join(res, f));
for (const d of ['renderer', 'assets']) cpSync(join(app, d), join(res, d), { recursive: true });
mkdirSync(join(res, 'models'));
for (const f of readdirSync(join(app, 'models'))) if (f.endsWith('.json')) cpSync(join(app, 'models', f), join(res, 'models', f)); // scale/size rules; the .onnx files are not shipped
writeFileSync(join(res, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, license: pkg.license, author: pkg.author }, null, 2));

// runtime dependency: onnxruntime-node (Windows x64 only) + onnxruntime-common
const nm = join(res, 'node_modules');
cpSync(join(app, 'node_modules', 'onnxruntime-common'), join(nm, 'onnxruntime-common'), { recursive: true });
cpSync(join(app, 'node_modules', 'onnxruntime-node'), join(nm, 'onnxruntime-node'), { recursive: true });
const napi = join(nm, 'onnxruntime-node', 'bin', 'napi-v6');
for (const os of readdirSync(napi)) {
  if (os !== 'win32') { rmSync(join(napi, os), { recursive: true, force: true }); continue; }
  for (const arch of readdirSync(join(napi, os))) if (arch !== 'x64') rmSync(join(napi, os, arch), { recursive: true, force: true });
}

writeFileSync(join(dir, 'README.txt'), `Token Framer ${pkg.version}\r\n\r\nDouble-click "Token Framer.exe". No install needed; delete the folder to remove the program.\r\nSettings are kept in %APPDATA%\${pkg.name}.\r\nThe AI cutout downloads its model (RMBG-2.0, about 0.5 GB, non-commercial licence) the first time you use it.\r\nThe Clean image / Upscale image tools need converted .onnx models placed in resources\app\models (see the project README).\r\n`);

const zip = join(dist, `${name}.zip`);
// Windows' own bsdtar (a GNU tar earlier on PATH cannot write zips and reads "F:\..." as a remote host); relative names, run inside dist
execFileSync(join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', `${name}.zip`, 'Token Framer'], { cwd: dist, stdio: 'inherit' });
console.log('built', zip, existsSync(zip));
