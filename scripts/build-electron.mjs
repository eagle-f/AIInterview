import { build } from 'esbuild';

// Compile our TypeScript into one ESM file. Builder includes the external runtime dependencies.
await build({
  entryPoints: ['backend/server.ts'],
  outfile: 'dist-electron/server.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
});
