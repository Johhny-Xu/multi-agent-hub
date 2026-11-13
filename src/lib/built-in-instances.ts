/** The server's default instances by id, with their driver kinds, plus `gemini`, which an enterprise licence restores. */
export const BUILT_IN_INSTANCE_DRIVERS: Readonly<Record<string, string>> = {
  grok: "grokAgent", kimi: "kimiAgent", droid: "droidAgent", cursor: "cursorAgent", githubCopilot: "copilotAgent", commandCode: "commandCodeAgent", kiro: "kiroAgent", claude: "claudeAgent", codex: "codex",
  chatgpt: "codex", antigravity: "antigravityAgent", opencodeGo: "opencodeGo", openaiCompat: "openai-compat",
  mistral: "mistral", cerebras: "cerebras", groq: "groq", greenference: "greenference", modelgo: "modelgo", meta: "meta", museCode: "museCode", deepseek: "deepseekAgent", openai: "openai-compat",
  claudeApi: "claudeAgent", xaiApi: "grok", openrouter: "openai-compat", qwen: "qwenAgent", hermes: "hermesAgent",
  cline: "clineAgent", pi: "piAgent", gemini: "geminiAgent",
  // 本项目自加的国产 CLI / 网页驱动（与 server/instance-fleets.ts 默认实例一致）
  codebuddy: "codebuddyAgent", codebuddyCn: "codebuddyCnAgent", qoder: "qoderAgent", qoderCn: "qoderCnAgent", codearts: "codeartsAcpAgent",
  mcode: "mcodeAgent", meoo: "meooAgent", traecode: "traecodeAgent", doubao: "doubaoAgent", dumate: "dumate", mimocode: "mimocodeAgent",
  perch: "perchAgent", zcode: "zcodeAgent",
  harkWeb: "harkWeb",
};
