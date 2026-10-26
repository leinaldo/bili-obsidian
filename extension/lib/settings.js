// 设置存在 chrome.storage.local，只在本机，不同步到浏览器账号（里面有 API Key）

// 都走 OpenAI 兼容的 /chat/completions 接口
export const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'doubao', name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-32B' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { id: 'ollama', name: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', noKey: true },
  { id: 'lmstudio', name: 'LM Studio（本机）', baseUrl: 'http://localhost:1234/v1', model: '', noKey: true },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
];

export const DEFAULTS = {
  // 当前用哪个模型：本地命令行 {kind: 'cli', id: 'claude', model: 'sonnet'}，
  // 或 API {kind: 'api', id: <providers 里的 id>, model: '...'}
  engine: { kind: 'cli', id: 'claude', model: 'sonnet' },
  providers: [],          // [{id, name, baseUrl, apiKey, model}]
  customCommand: '',      // 自定义命令行：提示词从标准输入进，标准输出就是笔记
  style: 'standard',
  formats: { toc: false, link: true, transcript: false },
  extraPrompt: '',
  asrModel: 'small',
  exports: {
    folder: { auto: true, dir: '', openObsidian: false },
    download: { auto: false },
    notion: { auto: false, token: '', databaseId: '' },
  },
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return merge(structuredClone(DEFAULTS), settings || {});
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
}

// 只合并普通对象，数组整个替换：以后加了新字段，老用户也能拿到默认值
function merge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return base;
}
