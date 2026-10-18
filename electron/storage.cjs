const fs = require('node:fs');
const path = require('node:path');

const CONFIG_KEYS = ['DEEPSEEK_API_KEY', 'BASE_URL', 'AI_MODEL', 'STT_API_KEY', 'TTS_API_KEY', 'TTS_RESOURCE_ID', 'TTS_VOICE_NAME'];

function normalizeConfig(input, requireModel = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('API 配置格式无效');
  const config = {};
  for (const key of CONFIG_KEYS) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`${key} 格式无效`);
    config[key] = value.trim();
  }
  if (requireModel && (!config.DEEPSEEK_API_KEY || !config.BASE_URL || !config.AI_MODEL)) {
    throw new Error('请填写模型 API 密钥、接口地址和模型名称');
  }
  if (config.BASE_URL) {
    let url;
    try { url = new URL(config.BASE_URL); } catch { throw new Error('接口地址必须是完整的 HTTP 或 HTTPS URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('接口地址需使用 HTTP/HTTPS，且不能包含用户名、密码、查询参数或锚点');
    }
  }
  const speech = [config.TTS_API_KEY, config.TTS_RESOURCE_ID, config.TTS_VOICE_NAME];
  if (requireModel && speech.some(Boolean) && !speech.every(Boolean)) throw new Error('语音合成的三个配置项需要全部填写，或全部留空');
  return config;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validateCache(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 5 * 1024 * 1024) throw new Error('面试缓存超过大小限制');
  const cache = JSON.parse(value);
  if (!cache || typeof cache.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(cache.sessionId) ||
      !Array.isArray(cache.messages) || !Number.isFinite(cache.timeline) || cache.timeline < 0 || typeof cache.draft !== 'string') {
    throw new Error('面试缓存格式无效');
  }
  return value;
}

module.exports = { CONFIG_KEYS, normalizeConfig, atomicWrite, validateCache };
