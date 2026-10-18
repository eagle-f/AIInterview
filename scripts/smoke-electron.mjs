import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { startDesktopModel } from '../tests/helpers/desktopModel.mjs';

const options = process.argv.slice(2);
const executableArgument = options[0] && !options[0].startsWith('--') ? options.shift() : undefined;
const executable = executableArgument ? path.resolve(executableArgument) : electron;
const packaged = !!executableArgument;
const directory = mkdtempSync(path.join(tmpdir(), 'aiinterview-desktop-smoke-'));
const model = await startDesktopModel();
const env = { ...process.env, AIINTERVIEW_SMOKE_DIR: directory, AIINTERVIEW_SMOKE_MODEL_BASE: model.baseUrl };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [...(packaged ? [] : ['.']), '--smoke-test', '--use-fake-device-for-media-stream', ...options], {
  env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let timedOut = false;
child.stdout.on('data', (data) => { output += data.toString(); });
child.stderr.on('data', (data) => { output += data.toString(); });
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 55_000);
try {
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  if (code !== 0 || timedOut || !existsSync(path.join(directory, 'smoke-result.json'))) {
    const logFile = path.join(directory, 'desktop.log');
    throw new Error(`Desktop smoke failed (${code}, timeout=${timedOut})\n${output}\n${existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''}`);
  }
  const result = JSON.parse(readFileSync(path.join(directory, 'smoke-result.json'), 'utf8'));
  if (!model.requests.some((request) => request.stream) || !model.requests.some((request) => !request.stream)) throw new Error('Desktop did not call the local chat and feedback model');
  for (const origin of new Set([result.oldOrigin, result.backendOrigin])) {
    const reachable = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) }).then(() => true).catch(() => false);
    if (reachable) throw new Error('Backend still running after application exit');
  }
  mkdirSync('release', { recursive: true });
  for (const preview of ['desktop', 'settings', 'setup', 'feedback']) {
    copyFileSync(path.join(directory, `${preview}-preview.png`), path.join('release', `${packaged ? 'packaged' : 'source'}-${preview}.png`));
  }
  console.log(JSON.stringify({ executable, ...result, modelRequests: model.requests.length, cleanup: 'backend stopped' }, null, 2));
} finally {
  clearTimeout(timer);
  await model.close();
  // Resolve and check the temporary path before deleting it recursively on Windows.
  const resolved = path.resolve(directory);
  const temporaryRoot = path.resolve(tmpdir()) + path.sep;
  if (!resolved.startsWith(temporaryRoot) || !path.basename(resolved).startsWith('aiinterview-desktop-smoke-')) throw new Error('Unexpected smoke directory');
  rmSync(resolved, { recursive: true, force: true });
}
