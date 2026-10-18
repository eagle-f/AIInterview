import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const asar = builderRequire('@electron/asar');
const archive = path.resolve('release/win-unpacked/resources/app.asar');
const files = asar.listPackage(archive).map((file) => file.replaceAll('\\', '/'));
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
for (const file of ['electron/main.cjs', 'electron/preload.cjs', 'electron/settings.html', 'electron/backend-worker.cjs', 'dist/index.html', 'dist-electron/server.mjs', 'node_modules/express/package.json', 'node_modules/ws/package.json', 'node_modules/openai/package.json', 'node_modules/nunjucks/package.json']) {
  if (!files.includes(`/${file}`)) throw new Error(`Missing packaged file: ${file}`);
}
for (const file of files) {
  if (/(^|\/)\.env($|\.)/.test(file) || /(^|\/)(sessions|\.data)(\/|$)/.test(file) || /(^|\/)(api-config\.enc|current-interview\.json|desktop\.log)$/.test(file)) {
    throw new Error(`Private data included in package: ${file}`);
  }
}
if (metadata.main !== 'electron/main.cjs') throw new Error('Packaged main entry is incorrect');
const installer = path.resolve(`release/AIInterview-Setup-${metadata.version}-x64.exe`);
if (!existsSync(installer) || statSync(installer).size < 1_000_000) throw new Error('Installer is missing or incomplete');
console.log(JSON.stringify({ archive, files: files.length, privateData: 'excluded', installer, installerBytes: statSync(installer).size }, null, 2));
