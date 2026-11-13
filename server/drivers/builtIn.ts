import type { AnyProviderDriver } from "../contracts.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokDriver } from "./grok.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { KimiAgentDriver } from "./acp/kimi.ts";
import { DroidAgentDriver } from "./acp/droid.ts";
import { CursorAgentDriver } from "./acp/cursor.ts";
import { OpenCodeDriver } from "./acp/opencode-go.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";
import { CustomAcpDriver } from "./acp/custom.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";
import { DeepSeekAgentDriver } from "./acp/deepseek.ts";
import { ClineAgentDriver } from "./acp/cline.ts";
import { CopilotAgentDriver } from "./acp/copilot.ts";
import { CommandCodeAgentDriver } from "./acp/command-code.ts";
import { KiroAgentDriver } from "./acp/kiro.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";
import { MistralDriver } from "./mistral.ts";
import { CerebrasDriver } from "./cerebras.ts";
import { GroqDriver } from "./groq.ts";
import { GreenferenceDriver } from "./greenference.ts";
import { ModelgoDriver } from "./modelgo.ts";
import { MetaDriver } from "./meta.ts";
import { MuseCodeDriver } from "./muse-code.ts";
import { MinimaxDriver } from "./minimax.ts";
import { CodeBuddyDriver, CodeBuddyCnDriver } from "./acp/codebuddy.ts";
import { QoderDriver, QoderCnDriver } from "./acp/qoder.ts";
import { CodeArtsAgentDriver } from "./acp/codearts.ts";
import { McodeAgentDriver } from "./acp/mcode.ts";
import { MeooAgentDriver } from "./acp/meoo.ts";
import { ZcodeAgentDriver } from "./acp/zcode.ts";
import { PerchAgentDriver } from "./acp/perch.ts";
import { MimocodeAgentDriver } from "./acp/mimocode.ts";
import { TraecodeAgentDriver } from "./traecode.ts";
import { DoubaoAgentDriver } from "./doubao.ts";
import { DumateDriver } from "./dumate.ts";
import { HarkWebDriver } from "./web-chat/hark.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  GrokDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  KimiAgentDriver,
  DroidAgentDriver,
  CursorAgentDriver,
  OpenCodeDriver,
  QwenAgentDriver,
  HermesAgentDriver,
  ClineAgentDriver,
  CopilotAgentDriver,
  CommandCodeAgentDriver,
  KiroAgentDriver,
  CustomAcpDriver,
  PiDriver,
  OpenAICompatDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  MinimaxDriver,
  MistralDriver,
  CerebrasDriver,
  GroqDriver,
  GreenferenceDriver,
  ModelgoDriver,
  MetaDriver,
  MuseCodeDriver,
  DeepSeekAgentDriver,
  // Chinese coding CLIs. CodeBuddy and Qoder each register twice: one international, one CN endpoint.
  CodeBuddyDriver, CodeBuddyCnDriver,
  QoderDriver, QoderCnDriver,
  CodeArtsAgentDriver,
  McodeAgentDriver,
  MeooAgentDriver,
  ZcodeAgentDriver,
  PerchAgentDriver,
  // MiMo Code runs its turns through its own ACP mode; Trae Code is the desktop IDE, whose driver
  // only registers the engine and its accounts and explains that turns cannot run headlessly.
  MimocodeAgentDriver,
  TraecodeAgentDriver,
  DoubaoAgentDriver,
  DumateDriver,
  HarkWebDriver,
];
