const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig, atomicWrite, validateCache } = require('../electron/storage.cjs');

const config = { DEEPSEEK_API_KEY: 'test-only', BASE_URL: 'https://model.example/v1', AI_MODEL: 'fixture' };

test('desktop settings reject invalid endpoints and incomplete speech configuration', () => {
  for (const BASE_URL of ['file:///secret', 'not a url', 'https://user:secret@model.example', 'https://model.example/v1?key=secret']) {
    assert.throws(() => normalizeConfig({ ...config, BASE_URL }));
  }
  assert.throws(() => normalizeConfig({ ...config, TTS_API_KEY: 'speech' }), /三个配置项/);
  assert.throws(() => normalizeConfig({ ...config, DEEPSEEK_API_KEY: 'key\nPORT=3000' }), /格式无效/);
  assert.throws(() => normalizeConfig({ ...config, AI_MODEL: '' }), /模型/);
  assert.equal(normalizeConfig({ ...config, PORT: '9999' }).PORT, undefined);
});

test('desktop cache survives replacement and rejects corrupted data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiinterview-storage-test-'));
  const file = path.join(directory, 'current-interview.json');
  const first = JSON.stringify({ sessionId: 'fixture', messages: [], timeline: 0, draft: '第一次' });
  const second = JSON.stringify({ sessionId: 'fixture', messages: [], timeline: 2, draft: '更新的草稿' });
  try {
    atomicWrite(file, validateCache(first));
    atomicWrite(file, validateCache(second));
    assert.equal(fs.readFileSync(file, 'utf8'), second);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.throws(() => validateCache('broken'));
    assert.throws(() => validateCache(JSON.stringify({ sessionId: '../escape', messages: [], timeline: 0, draft: '' })));
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
