// =================================================================
// MULTI-AGENT-HUB STANDALONE DEMO MOCK ENGINE (ZERO BACKEND DEPS)
// =================================================================
(function() {
  'use strict';
  console.info('[Demo Engine] Initializing standalone in-memory demo environment...');

  // Mock EventSource to eliminate network errors
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      setTimeout(() => { if (typeof this.onopen === 'function') this.onopen(); }, 50);
    }
    addEventListener() {}
    removeEventListener() {}
    close() { this.readyState = 2; }
  }
  window.EventSource = MockEventSource;

  // In-memory data store
  const now = Date.now();
  const DAY = 86400000;
  const HOUR = 3600000;

  const mockArtifacts = {
    'artifacts/architecture_spec.md': {
      text: [
        '# multi-agent-hub 前端交互与架构设计规范',
        '',
        '## 1. 核心视觉准则',
        '- **全平滑连续平角（Squircle R角）**：全站以品牌 Logo 的圆角比例（34px 对应 9px，约 26.5%）为最高基准；',
        '- **深浅双色与天体缓动**：深色模式显月亮，浅色模式显太阳，变形动画顺滑；',
        '- **极简悬浮回底纽**：32px 正圆形胶囊，内部纯净 SVG 箭头，无冗余字样；',
        '',
        '## 2. 交互拓扑',
        '```javascript',
        '// 模型二级气泡自适应锚定逻辑',
        'function anchorPopover(triggerSide) {',
        '  if (triggerSide === "left") {',
        '    popover.style.left = Math.round(targetOffset) + "px";',
        '    popover.style.right = "auto";',
        '  } else {',
        '    popover.style.left = "auto";',
        '    popover.style.right = "0";',
        '  }',
        '}',
        '```',
        '',
        '## 3. 工作台体验',
        '> 点击右上角复制按钮即可一键复制本文档，并弹出绿色 Toast 提示。'
      ].join('\n'),
      truncated: false
    },
    'artifacts/workbench_component.vue': {
      text: [
        '<template>',
        '  <div class="workbench-card">',
        '    <div class="wb-header">',
        '      <span class="pill-accent">Antigravity</span>',
        '      <h3>{{ title }}</h3>',
        '    </div>',
        '    <div class="wb-body">',
        '      <slot name="preview" />',
        '    </div>',
        '  </div>',
        '</template>',
        '',
        '<' + 'script setup>',
        'defineProps({',
        '  title: { type: String, default: "Demo Artifact" }',
        '});',
        '<' + '/script>',
        '',
        '<style scoped>',
        '.workbench-card { border-radius: 9px; border: 1px solid var(--gem-border); padding: 16px; }',
        '</style>'
      ].join('\n'),
      truncated: false
    },
    'artifacts/gateway_routes.yaml': {
      text: [
        'apiVersion: gateway.networking.k8s.io/v1',
        'kind: HTTPRoute',
        'metadata:',
        '  name: agent-hub-router',
        '  namespace: production',
        'spec:',
        '  parentRefs:',
        '    - name: multi-agent-gateway',
        '  rules:',
        '    - matches:',
        '        - path: { type: PathPrefix, value: /api/v1/agents }',
        '      backendRefs:',
        '        - name: hub-dispatch-service',
        '          port: 8080',
        '    - matches:',
        '        - path: { type: PathPrefix, value: /api/v1/stream }',
        '      backendRefs:',
        '        - name: hub-stream-engine',
        '          port: 8081'
      ].join('\n'),
      truncated: false
    },
    'artifacts/regression_suite.json': {
      text: JSON.stringify({
        suite: "AgentHub-Core-Regression",
        timestamp: now,
        totalTests: 42,
        passed: 42,
        failed: 0,
        coverage: {
          statements: "98.4%",
          branches: "95.2%",
          functions: "99.1%",
          lines: "98.6%"
        },
        scenarios: [
          { name: "Model popover left/right anchor", status: "PASS", durationMs: 14 },
          { name: "Theme celestial toggle transition", status: "PASS", durationMs: 22 },
          { name: "Workbench drawer collapse/expand", status: "PASS", durationMs: 18 },
          { name: "Scroll-to-bottom circular fab button", status: "PASS", durationMs: 9 },
          { name: "Settings card button/toggle vertical symmetry", status: "PASS", diffPx: 0.00 }
        ]
      }, null, 2),
      truncated: false
    },
    'artifacts/profiling_analysis.py': {
      text: [
        '# -*- coding: utf-8 -*-',
        '"""',
        'Copilot 建议：高性能协同调度线程池评估脚本',
        '"""',
        'import asyncio',
        'import time',
        '',
        'async def benchmark_dispatch(agents_count=9, concurrency=50):',
        '    start = time.perf_counter()',
        '    tasks = [asyncio.sleep(0.005) for _ in range(concurrency)]',
        '    await asyncio.gather(*tasks)',
        '    elapsed = (time.perf_counter() - start) * 1000',
        '    print(f"Dispatched {concurrency} commands across {agents_count} agents in {elapsed:.2f}ms")',
        '    return {"elapsed_ms": elapsed, "throughput_qps": concurrency / (elapsed / 1000)}',
        '',
        'if __name__ == "__main__":',
        '    asyncio.run(benchmark_dispatch())'
      ].join('\n'),
      truncated: false
    }
  };

  const mockAgents = [
    { name: 'antigravity', active: true, dispatchable: true, disabled: false, models: ['gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-3.1-pro-high', 'claude-sonnet-4.6-thinking'] },
    { name: 'codearts', active: true, dispatchable: true, disabled: false, models: ['huaweicloud-maas/GLM-5.2', 'GLM-5.2-ArkTS-SPARK', 'OpenPangu-2.0-Pro'] },
    { name: 'codebuddy', active: true, dispatchable: true, disabled: false, models: ['deepseek-v4.1-flash', 'codebuddy-pro-v2', 'claude-3.7-sonnet'] },
    { name: 'codebuddy-cn', active: true, dispatchable: true, disabled: false, models: ['deepseek-v4.1-flash', 'codebuddy-cn-code-pro', 'qwen-2.5-coder-32b'] },
    { name: 'github-copilot', active: true, dispatchable: true, disabled: false, models: ['gpt-4o', 'claude-3.7-sonnet', 'o3-mini'] },
    { name: 'mimocode', active: true, dispatchable: true, disabled: false, models: ['mimo-v2.5-code', 'mimo-v2-flash'] },
    { name: 'minimaxcode', active: true, dispatchable: true, disabled: false, models: ['minimax-abab-6.5-chat', 'minimax-text-01'] },
    { name: 'traecode', active: true, dispatchable: true, disabled: false, models: ['trae-claude-3.5-sonnet', 'trae-gpt-4o'] },
    { name: 'zcode', active: true, dispatchable: true, disabled: false, models: ['zcode/GLM-5.3-Flash', 'zcode/GLM-4-Air', 'zcode/GLM-4-Plus'] }
  ];

  const mockModelCatalog = [
    // Antigravity
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash Medium', tags: ['default', 'fast'], contextWindow: 1000000, agent: 'antigravity', default: true },
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', tags: ['high-speed'], contextWindow: 1000000, agent: 'antigravity' },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', tags: ['reasoning'], contextWindow: 2000000, agent: 'antigravity' },
    { id: 'claude-sonnet-4.6-thinking', name: 'Claude Sonnet 4.6 (Thinking)', tags: ['promo'], contextWindow: 200000, agent: 'antigravity' },

    // CodeArts
    { id: 'huaweicloud-maas/GLM-5.2', name: 'GLM-5.2', tags: ['default', 'discount'], contextWindow: 128000, agent: 'codearts', default: true },
    { id: 'GLM-5.2-ArkTS-SPARK', name: 'GLM-5.2-ArkTS-SPARK', tags: ['promo'], contextWindow: 128000, agent: 'codearts' },
    { id: 'OpenPangu-2.0-Pro', name: 'OpenPangu-2.0-Pro', tags: ['credits'], contextWindow: 64000, agent: 'codearts' },

    // CodeBuddy
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', tags: ['free', 'default'], contextWindow: 64000, agent: 'codebuddy', default: true },
    { id: 'codebuddy-pro-v2', name: 'CodeBuddy-Pro-V2', tags: ['credits'], contextWindow: 128000, agent: 'codebuddy' },
    { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', tags: ['promo'], contextWindow: 200000, agent: 'codebuddy' },

    // CodeBuddy-CN
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', tags: ['free', 'default'], contextWindow: 64000, agent: 'codebuddy-cn', default: true },
    { id: 'codebuddy-cn-code-pro', name: 'CodeBuddy-CN Code Pro', tags: ['fast'], contextWindow: 128000, agent: 'codebuddy-cn' },
    { id: 'qwen-2.5-coder-32b', name: 'Qwen 2.5 Coder 32B', tags: ['credits'], contextWindow: 128000, agent: 'codebuddy-cn' },

    // GitHub Copilot
    { id: 'gpt-4o', name: 'GPT-4o (Copilot)', tags: ['default', 'standard'], contextWindow: 128000, agent: 'github-copilot', default: true },
    { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', tags: ['promo'], contextWindow: 200000, agent: 'github-copilot' },
    { id: 'o3-mini', name: 'o3-mini (Reasoning)', tags: ['reasoning'], contextWindow: 200000, agent: 'github-copilot' },

    // MiMo
    { id: 'mimo-v2.5-code', name: 'MiMo v2.5 Code', tags: ['default', 'fast'], contextWindow: 128000, agent: 'mimocode', default: true },
    { id: 'mimo-v2-flash', name: 'MiMo v2 Flash', tags: ['free'], contextWindow: 64000, agent: 'mimocode' },

    // MiniMax
    { id: 'minimax-abab-6.5-chat', name: 'MiniMax abab-6.5', tags: ['default', 'fast'], contextWindow: 245000, agent: 'minimaxcode', default: true },
    { id: 'minimax-text-01', name: 'MiniMax Text 01', tags: ['long-context'], contextWindow: 1000000, agent: 'minimaxcode' },

    // TRAE
    { id: 'trae-claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (TRAE)', tags: ['default', 'editor'], contextWindow: 200000, agent: 'traecode', default: true },
    { id: 'trae-gpt-4o', name: 'GPT-4o (TRAE)', tags: ['fast'], contextWindow: 128000, agent: 'traecode' },

    // ZCode
    { id: 'zcode/GLM-5.3-Flash', name: 'GLM-5.3-Flash', tags: ['free', 'default'], contextWindow: 128000, agent: 'zcode', default: true },
    { id: 'zcode/GLM-4-Air', name: 'GLM-4-Air', tags: ['fast'], contextWindow: 128000, agent: 'zcode' },
    { id: 'zcode/GLM-4-Plus', name: 'GLM-4-Plus', tags: ['flagship'], contextWindow: 128000, agent: 'zcode' }
  ];

  // 虚拟账号数据（每个 Agent 2~3 个独立虚拟账号，支持实时切换与徽章联动）
  const mockAccountsData = {
    workers: {
      antigravity: {
        livePresent: true,
        profiles: [
          { name: 'ag-pro', display: '主力开发 (Pro)', active: true, identity: 'pro-dev@google.internal' },
          { name: 'ag-team', display: '团队共享 (Team)', active: false, identity: 'team-shared@google.internal' },
          { name: 'ag-sandbox', display: '实验沙箱 (Sandbox)', active: false, identity: 'sandbox@google.internal' }
        ]
      },
      codearts: {
        livePresent: true,
        profiles: [
          { name: 'hw-corp', display: '企业主力 (Corp)', active: true, identity: 'huawei-dev-01@corp.hw' },
          { name: 'hw-sandbox', display: '个人测试 (Dev)', active: false, identity: 'hw-tester@dev.hw' }
        ]
      },
      codebuddy: {
        livePresent: true,
        profiles: [
          { name: 'cb-vip', display: '商业授权 (VIP)', active: true, identity: 'vip-member@codebuddy.ai' },
          { name: 'cb-free', display: '免费账号 (Free)', active: false, identity: 'community@codebuddy.ai' }
        ]
      },
      'codebuddy-cn': {
        livePresent: true,
        profiles: [
          { name: 'cb-cn-pro', display: '国内专享 (Pro)', active: true, identity: 'cn-pro@codebuddy.cn' },
          { name: 'cb-cn-dev', display: '测试沙盒 (Dev)', active: false, identity: 'cn-test@codebuddy.cn' }
        ]
      },
      'github-copilot': {
        livePresent: true,
        profiles: [
          { name: 'gh-enterprise', display: '企业组织 (Enterprise)', active: true, identity: 'octocat@github.enterprise' },
          { name: 'gh-individual', display: '个人订阅 (Individual)', active: false, identity: 'coder@github.com' }
        ]
      },
      mimocode: {
        livePresent: true,
        profiles: [
          { name: 'mimo-pro', display: '澎湃OS 终端 (Pro)', active: true, identity: 'mimo-user@xiaomi.com' },
          { name: 'mimo-lab', display: '端侧实验 (Lab)', active: false, identity: 'lab-tester@xiaomi.com' }
        ]
      },
      minimaxcode: {
        livePresent: true,
        profiles: [
          { name: 'mm-ent', display: 'MiniMax 尊享版 (Ent)', active: true, identity: 'enterprise@minimax.ai' },
          { name: 'mm-std', display: '标准推理版 (Std)', active: false, identity: 'standard@minimax.ai' }
        ]
      },
      traecode: {
        livePresent: true,
        profiles: [
          { name: 'trae-main', display: 'TRAE 开发者 (Main)', active: true, identity: 'developer@trae.ai' },
          { name: 'trae-guest', display: '访客体验 (Guest)', active: false, identity: 'guest@trae.ai' }
        ]
      },
      zcode: {
        livePresent: true,
        profiles: [
          { name: 'zc-bigmodel', display: '智谱 BigModel (国内版)', active: true, identity: 'zhipu-vip@zhipu.ai' },
          { name: 'zc-intl', display: 'Z.ai 国际版 (Intl)', active: false, identity: 'global@z.ai' }
        ]
      }
    }
  };

  // 虚拟模型数据（与设置卡片模型配置行及模型选择气泡联动）
  const mockWorkersModelsData = {
    antigravity: {
      default: 'gemini-3.8-flash-medium',
      models: [
        { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash Medium', alias: 'gemini-3.8-flash-medium', isDefault: true, tag: '高速', credits: '1x', ctx: '1M' },
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', alias: 'gemini-3.8-flash-high', tag: '旗舰高速', credits: '1.5x', ctx: '1M' },
        { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', alias: 'gemini-3.1-pro-high', tag: '深度推理', credits: '2x', ctx: '2M' },
        { id: 'claude-sonnet-4.6-thinking', name: 'Claude Sonnet 4.6 (Thinking)', alias: 'claude-sonnet-4.6-thinking', tag: '特惠限免', credits: '1x', ctx: '200K' }
      ]
    },
    codearts: {
      default: 'huaweicloud-maas/GLM-5.2',
      models: [
        { id: 'huaweicloud-maas/GLM-5.2', name: 'GLM-5.2', alias: 'huaweicloud-maas/GLM-5.2', isDefault: true, tag: '限时特惠', credits: '0.8x', ctx: '128K' },
        { id: 'GLM-5.2-ArkTS-SPARK', name: 'GLM-5.2-ArkTS-SPARK', alias: 'GLM-5.2-ArkTS-SPARK', tag: '端云协同', credits: '1x', ctx: '128K' },
        { id: 'OpenPangu-2.0-Pro', name: 'OpenPangu-2.0-Pro', alias: 'OpenPangu-2.0-Pro', tag: '盘古旗舰', credits: '1.5x', ctx: '64K' }
      ]
    },
    codebuddy: {
      default: 'deepseek-v4.1-flash',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', alias: 'deepseek-v4.1-flash', isDefault: true, tag: '免费', credits: '免费', ctx: '64K' },
        { id: 'codebuddy-pro-v2', name: 'CodeBuddy-Pro-V2', alias: 'codebuddy-pro-v2', tag: '代码专属', credits: '1x', ctx: '128K' },
        { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', alias: 'claude-3.7-sonnet', tag: '思考增强', credits: '2x', ctx: '200K' }
      ]
    },
    'codebuddy-cn': {
      default: 'deepseek-v4.1-flash',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', alias: 'deepseek-v4.1-flash', isDefault: true, tag: '免费', credits: '免费', ctx: '64K' },
        { id: 'codebuddy-cn-code-pro', name: 'CodeBuddy-CN Code Pro', alias: 'codebuddy-cn-code-pro', tag: '极速生成', credits: '1x', ctx: '128K' },
        { id: 'qwen-2.5-coder-32b', name: 'Qwen 2.5 Coder 32B', alias: 'qwen-2.5-coder-32b', tag: '开源优选', credits: '1x', ctx: '128K' }
      ]
    },
    'github-copilot': {
      default: 'gpt-4o',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o (Copilot)', alias: 'gpt-4o', isDefault: true, tag: '标准', credits: '1x', ctx: '128K' },
        { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', alias: 'claude-3.7-sonnet', tag: '代码推理', credits: '1.5x', ctx: '200K' },
        { id: 'o3-mini', name: 'o3-mini (Reasoning)', alias: 'o3-mini', tag: '深度思考', credits: '2x', ctx: '200K' }
      ]
    },
    mimocode: {
      default: 'mimo-v2.5-code',
      models: [
        { id: 'mimo-v2.5-code', name: 'MiMo v2.5 Code', alias: 'mimo-v2.5-code', isDefault: true, tag: '端侧专研', credits: '1x', ctx: '128K' },
        { id: 'mimo-v2-flash', name: 'MiMo v2 Flash', alias: 'mimo-v2-flash', tag: '极速低耗', credits: '免费', ctx: '64K' }
      ]
    },
    minimaxcode: {
      default: 'minimax-abab-6.5-chat',
      models: [
        { id: 'minimax-abab-6.5-chat', name: 'MiniMax abab-6.5', alias: 'minimax-abab-6.5-chat', isDefault: true, tag: '推荐', credits: '1x', ctx: '245K' },
        { id: 'minimax-text-01', name: 'MiniMax Text 01', alias: 'minimax-text-01', tag: '百万上下文', credits: '1.5x', ctx: '1M' }
      ]
    },
    traecode: {
      default: 'trae-claude-3.5-sonnet',
      models: [
        { id: 'trae-claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (TRAE)', alias: 'trae-claude-3.5-sonnet', isDefault: true, tag: '结对编程', credits: '1x', ctx: '200K' },
        { id: 'trae-gpt-4o', name: 'GPT-4o (TRAE)', alias: 'trae-gpt-4o', tag: '极速响应', credits: '1x', ctx: '128K' }
      ]
    },
    zcode: {
      default: 'zcode/GLM-5.3-Flash',
      models: [
        { id: 'zcode/GLM-5.3-Flash', name: 'GLM-5.3-Flash', alias: 'zcode/GLM-5.3-Flash', isDefault: true, tag: '免费极速', credits: '免费', ctx: '128K' },
        { id: 'zcode/GLM-4-Air', name: 'GLM-4-Air', alias: 'zcode/GLM-4-Air', tag: '轻量高吞吐', credits: '0.5x', ctx: '128K' },
        { id: 'zcode/GLM-4-Plus', name: 'GLM-4-Plus', alias: 'zcode/GLM-4-Plus', tag: '智谱旗舰', credits: '1.5x', ctx: '128K' }
      ]
    }
  };

  // 虚拟配额与状态数据（提供真实百分比与重置时间进度条）
  const mockWorkersQuotasData = {
    antigravity: {
      account: '主力开发 (Pro)',
      plan: 'Pro 开发者专属版',
      message: '通道健康',
      quotas: {
        'Gemini 3.8 Flash (High)': { used: 3.5, total: 100, remainingPercentage: 96.5, resetAt: now + DAY },
        'Gemini 3.1 Pro (High)': { used: 12.0, total: 100, remainingPercentage: 88.0, resetAt: now + DAY },
        'Claude Sonnet 4.6 (Thinking)': { used: 0, total: 50, remainingPercentage: 100, resetAt: now + 2 * DAY }
      }
    },
    codearts: {
      account: '企业主力 (Corp)',
      plan: '华为云企业专享版',
      message: '通道健康',
      quotas: {
        'GLM-5.2 Maas': { used: 18.2, total: 200, remainingPercentage: 90.9, resetAt: now + DAY },
        'OpenPangu 2.0 Pro': { used: 5.0, total: 50, remainingPercentage: 90.0, resetAt: now + DAY }
      }
    },
    codebuddy: {
      account: '商业授权 (VIP)',
      plan: '商业版授权',
      message: '通道健康',
      quotas: {
        'DeepSeek-V4.1 Flash': { unlimited: true, used: 120, total: 0 },
        'CodeBuddy-Pro-V2': { used: 42, total: 100, remainingPercentage: 58.0, resetAt: now + DAY }
      }
    },
    'codebuddy-cn': {
      account: '国内专享 (Pro)',
      plan: '国内合规版',
      message: '通道健康',
      quotas: {
        'DeepSeek-V4.1 Flash': { unlimited: true, used: 85, total: 0 },
        'Qwen 2.5 Coder 32B': { used: 15, total: 100, remainingPercentage: 85.0, resetAt: now + DAY }
      }
    },
    'github-copilot': {
      account: '企业组织 (Enterprise)',
      plan: 'Copilot Business',
      message: '通道健康',
      quotas: {
        'GPT-4o Requests': { used: 68, total: 300, remainingPercentage: 77.3, resetAt: now + DAY },
        'Claude 3.7 Sonnet': { used: 24, total: 100, remainingPercentage: 76.0, resetAt: now + DAY }
      }
    },
    mimocode: {
      account: '澎湃OS 终端 (Pro)',
      plan: '小米开发者版',
      message: '通道健康',
      quotas: {
        'MiMo v2.5 Code': { used: 10, total: 100, remainingPercentage: 90.0, resetAt: now + DAY }
      }
    },
    minimaxcode: {
      account: 'MiniMax 尊享版 (Ent)',
      plan: 'MiniMax 开放平台',
      message: '通道健康',
      quotas: {
        'MiniMax abab-6.5': { used: 35, total: 100, remainingPercentage: 65.0, resetAt: now + DAY }
      }
    },
    traecode: {
      account: 'TRAE 开发者 (Main)',
      plan: '字节跳动 TRAE 团队版',
      message: '通道健康',
      quotas: {
        'Claude 3.5 Sonnet (TRAE)': { used: 45, total: 150, remainingPercentage: 70.0, resetAt: now + DAY }
      }
    },
    zcode: {
      account: '智谱 BigModel (国内版)',
      plan: 'BigModel 开放平台',
      message: '通道健康',
      quotas: {
        'GLM-5.3-Flash': { unlimited: true, used: 210, total: 0 },
        'GLM-4-Plus': { used: 8, total: 50, remainingPercentage: 84.0, resetAt: now + DAY }
      }
    }
  };

  const mockThreads = [
    {
      agent: 'antigravity',
      unread: 0,
      totalUnread: 0,
      updated: now - 300000,
      last: { role: 'agent', text: '演示数据已就绪，请测试抽屉工作台与底部模型气泡！', ts: now - 300000 },
      sessions: [
        { id: 'sess-ag-1', title: '架构演示与工作台交互', msgCount: 4, ts: now - 300000 },
        { id: 'sess-ag-2', title: '多智能体任务分发验证', msgCount: 2, ts: now - DAY },
        { id: 'sess-ag-3', title: '微前端组件动效评测', msgCount: 2, ts: now - 2 * DAY }
      ]
    },
    {
      agent: 'codearts',
      unread: 0,
      totalUnread: 0,
      updated: now - 2 * HOUR,
      last: { role: 'agent', text: '微服务网关路由重构脚本已准备就绪。', ts: now - 2 * HOUR },
      sessions: [
        { id: 'sess-ca-1', title: '微服务网关重构', msgCount: 2, ts: now - 2 * HOUR },
        { id: 'sess-ca-2', title: 'ArkTS 端云协同状态机', msgCount: 2, ts: now - DAY }
      ]
    },
    {
      agent: 'codebuddy',
      unread: 0,
      totalUnread: 0,
      updated: now - 4 * HOUR,
      last: { role: 'agent', text: '42 项自动化测试套件全部通过。', ts: now - 4 * HOUR },
      sessions: [
        { id: 'sess-cb-1', title: '单元测试与回归套件构建', msgCount: 2, ts: now - 4 * HOUR },
        { id: 'sess-cb-2', title: 'DeepSeek-V4 代码补全评测', msgCount: 2, ts: now - DAY }
      ]
    },
    {
      agent: 'codebuddy-cn',
      unread: 0,
      totalUnread: 0,
      updated: now - 6 * HOUR,
      last: { role: 'agent', text: '国产化算力调度节点已同步。', ts: now - 6 * HOUR },
      sessions: [
        { id: 'sess-cbcn-1', title: '国产化算力环境验证', msgCount: 2, ts: now - 6 * HOUR }
      ]
    },
    {
      agent: 'github-copilot',
      unread: 0,
      totalUnread: 0,
      updated: now - 8 * HOUR,
      last: { role: 'agent', text: '代码性能瓶颈已定位。', ts: now - 8 * HOUR },
      sessions: [
        { id: 'sess-gh-1', title: '性能瓶颈审计', msgCount: 2, ts: now - 8 * HOUR },
        { id: 'sess-gh-2', title: '并发线程锁排查', msgCount: 2, ts: now - DAY }
      ]
    },
    {
      agent: 'mimocode',
      unread: 0,
      totalUnread: 0,
      updated: now - 10 * HOUR,
      last: { role: 'agent', text: '澎湃OS 终端调度就绪。', ts: now - 10 * HOUR },
      sessions: [
        { id: 'sess-mimo-1', title: '移动端混合架构调度', msgCount: 2, ts: now - 10 * HOUR }
      ]
    },
    {
      agent: 'minimaxcode',
      unread: 0,
      totalUnread: 0,
      updated: now - 11 * HOUR,
      last: { role: 'agent', text: 'MiniMax 多模态推理上下文就绪。', ts: now - 11 * HOUR },
      sessions: [
        { id: 'sess-mm-1', title: '多模态语音与视觉理解', msgCount: 2, ts: now - 11 * HOUR }
      ]
    },
    {
      agent: 'traecode',
      unread: 0,
      totalUnread: 0,
      updated: now - 12 * HOUR,
      last: { role: 'agent', text: 'TRAE 编辑器插件协同就绪。', ts: now - 12 * HOUR },
      sessions: [
        { id: 'sess-tr-1', title: '智能编辑器插件协同', msgCount: 2, ts: now - 12 * HOUR }
      ]
    },
    {
      agent: 'zcode',
      unread: 0,
      totalUnread: 0,
      updated: now - 14 * HOUR,
      last: { role: 'agent', text: '智谱科技蓝图标已生效，支持 GLM-5.3-Flash。', ts: now - 14 * HOUR },
      sessions: [
        { id: 'sess-zc-1', title: '状态机调度验证', msgCount: 2, ts: now - 14 * HOUR },
        { id: 'sess-zc-2', title: 'GLM-5.3 智能体工具链', msgCount: 2, ts: now - DAY }
      ]
    }
  ];

  const mockSessionMessages = {
    'sess-ag-1': [
      {
        role: 'me',
        text: '你好！请向我展示 multi-agent-hub 的核心视觉与交互特性。',
        ts: now - 1800000
      },
      {
        role: 'agent',
        text: [
          '# 欢迎体验 multi-agent-hub 演示版！',
          '',
          '这是一个**纯前端独立演示包**（零外部后端依赖），你可以无限制测试各项动效与交互逻辑：',
          '',
          '### 交互测试检查清单',
          '1. **主题天体变形**：点击右上角太阳/月亮，体验平滑旋转缩放；',
          '2. **模型选择器对齐**：',
          '   - 点击底部状态栏左下角模型：**弹窗贴合左侧**；',
          '   - 点击输入框右下角胶囊：**弹窗贴合右侧**；',
          '3. **思考程度呈现**：选择思考程度时只呈现 `· Medium`，无多余冒号；',
          '4. **工作台抽屉**：点击右上角 **「工作台」** 展开右侧产物抽屉；',
          '5. **极简回底圆纽**：向上滚动消息流，体验 32px 纯下箭头圆形回底悬浮按钮；',
          '6. **设置页对称卡片**：切换到「设置」标签，查看简介与套餐已隐藏，[对话] 按钮与开关垂直中线 0.00px 严格对称！',
          '',
          '```javascript',
          '// 演示代码高亮与一键复制',
          'export function checkSymmetry(btnRect, toggleRect) {',
          '  const diff = Math.abs(btnRect.top - toggleRect.top);',
          '  return diff === 0 ? "Perfect Symmetry" : `${diff}px offset`;',
          '}',
          '```',
          '',
          '> 提示：在下方输入框中任意输入文字并发送，将模拟触发流式交互并向工作台自动新增演示产物！'
        ].join('\n'),
        ts: now - 1200000,
        artifact: 'artifacts/architecture_spec.md'
      },
      {
        role: 'me',
        text: '长文本与滚动测试：请给出一份排版说明。',
        ts: now - 600000
      },
      {
        role: 'agent',
        text: [
          '已生成详细测试说明。你可以通过鼠标滚轮向上滚动窗口，观察右下角出现的圆形悬浮回底按钮。点击按钮可直接平滑滑回最新消息处。',
          '',
          '右侧工作台还支持切换标签（全部 / 产物 / 附件），并支持直接在内联预览区代码查看与一键拷贝。',
          '',
          '附带组件原型已同步登记至右侧工作台：`artifacts/workbench_component.vue`。'
        ].join('\n'),
        ts: now - 300000,
        artifact: 'artifacts/workbench_component.vue'
      }
    ],
    'sess-ag-2': [
      { role: 'me', text: '多智能体任务拆解验证会话', ts: now - DAY },
      { role: 'agent', text: '准备就绪，支持通过 @ 语法或切换平台直接测试任务派发流转。', ts: now - DAY }
    ],
    'sess-ag-3': [
      { role: 'me', text: '微前端组件动效评测', ts: now - 2 * DAY },
      { role: 'agent', text: '组件动效库已载入，支持弹性抽屉滑入滑出与 Logo 比例平滑连续角（Squircle R角）测试。', ts: now - 2 * DAY }
    ],
    'sess-ca-1': [
      { role: 'me', text: '微服务网关测试：请生成路由规则', ts: now - 2 * HOUR },
      { role: 'agent', text: '已为 CodeArts 生成微服务路由配置文件，华为专属红色品牌 R 角正常渲染，工件已同步存入工作台。', ts: now - 2 * HOUR, artifact: 'artifacts/gateway_routes.yaml' }
    ],
    'sess-ca-2': [
      { role: 'me', text: 'ArkTS 端云协同状态机', ts: now - DAY },
      { role: 'agent', text: 'ArkTS 状态机定义已就绪，状态跃迁已同步至共享记忆区。', ts: now - DAY }
    ],
    'sess-cb-1': [
      { role: 'me', text: '单元测试执行：请跑一遍核心测试套件', ts: now - 4 * HOUR },
      { role: 'agent', text: '42 项自动化测试已完成，覆盖 DOM、布局、能力检测与安全审计。全部测试通过！', ts: now - 4 * HOUR, artifact: 'artifacts/regression_suite.json' }
    ],
    'sess-cb-2': [
      { role: 'me', text: 'DeepSeek-V4 代码补全评测', ts: now - DAY },
      { role: 'agent', text: 'DeepSeek-V4.1 Flash 推理时延均值 180ms，首字上屏流畅。', ts: now - DAY }
    ],
    'sess-cbcn-1': [
      { role: 'me', text: '国产化算力环境验证', ts: now - 6 * HOUR },
      { role: 'agent', text: '国产化异构加速卡驱动检测正常，算力调度通道已接通。', ts: now - 6 * HOUR }
    ],
    'sess-gh-1': [
      { role: 'me', text: 'Copilot 代码审查：分析并发瓶颈', ts: now - 8 * HOUR },
      { role: 'agent', text: '建议对高频重绘区域应用 will-change 优化，已生成基准评估脚本。', ts: now - 8 * HOUR, artifact: 'artifacts/profiling_analysis.py' }
    ],
    'sess-gh-2': [
      { role: 'me', text: '并发线程锁排查', ts: now - DAY },
      { role: 'agent', text: '无死锁风险，协程调度器处于最佳负载区间。', ts: now - DAY }
    ],
    'sess-mimo-1': [
      { role: 'me', text: '小米澎湃端侧架构调度', ts: now - 10 * HOUR },
      { role: 'agent', text: 'MiMo v2.5 Code 移动端轻量级推理通道就绪。', ts: now - 10 * HOUR }
    ],
    'sess-mm-1': [
      { role: 'me', text: '多模态语音与视觉理解', ts: now - 11 * HOUR },
      { role: 'agent', text: 'MiniMax abab-6.5 支持百万级上下文混合输入。', ts: now - 11 * HOUR }
    ],
    'sess-tr-1': [
      { role: 'me', text: 'TRAE 编辑器插件协同开发', ts: now - 12 * HOUR },
      { role: 'agent', text: 'TRAE 双模型架构协同通道已就绪，支持实时代码上下文穿透。', ts: now - 12 * HOUR }
    ],
    'sess-zc-1': [
      { role: 'me', text: 'ZCode 调度探索', ts: now - 14 * HOUR },
      { role: 'agent', text: '智谱科技蓝图标已生效，支持 GLM-5.3-Flash 快捷直连与函数调用。', ts: now - 14 * HOUR }
    ],
    'sess-zc-2': [
      { role: 'me', text: 'GLM-5.3 智能体工具链', ts: now - DAY },
      { role: 'agent', text: 'Function Calling 工具链已同步注册完毕。', ts: now - DAY }
    ]
  };

  // Mock Fetch Router
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const method = (init && init.method ? init.method : 'GET').toUpperCase();

    // Check if it's an API request
    if (url.startsWith('/api/') || url.includes('/api/')) {
      const urlObj = new URL(url, 'http://demo.local');
      const pathname = urlObj.pathname;
      const searchParams = urlObj.searchParams;

      let reqBody = {};
      if (init && init.body && typeof init.body === 'string') {
        try { reqBody = JSON.parse(init.body); } catch(e) {}
      }

      console.log(`[Demo Mock API] ${method} ${pathname}`, reqBody);

      // 1. Snapshot
      if (pathname === '/api/snapshot') {
        const snap = {
          ok: true,
          latencyMs: 6,
          status: { uptime: 7200, version: '1.0.0-demo-standalone' },
          endpoint: { id: 'demo-local', label: '演示沙箱', host: 'demo.local' },
          endpoints: [
            { id: 'demo-local', label: '本地沙箱 (Demo)', host: 'demo.local' }
          ],
          self: { agent: 'console' },
          agents: mockAgents,
          modelCatalog: mockModelCatalog,
          tasks: [
            { id: 'task-101', title: '微服务网关路由重构回归测试', status: 'done', agent: 'codearts', created: now - HOUR },
            { id: 'task-102', title: 'Antigravity 全平滑 Squircle R角视觉对齐', status: 'done', agent: 'antigravity', created: now - 300000 }
          ],
          taskTotal: 2,
          notes: [
            { key: 'demo-guideline', text: '本演示环境已全面剥离后端，所有交互动效与数据流转在内存中完整仿真。' },
            { key: 'design-squircle', text: '全站圆角以品牌 Logo 连续平角（Squircle R角）为最高基准（26.5% 弧度比）。' }
          ],
          capabilities: {},
          subagent: { url: 'http://127.0.0.1:8790', version: '1.0.0' },
          inbox: []
        };
        return new Response(JSON.stringify(snap), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 2. Chat list
      if (pathname === '/api/chat/list') {
        return new Response(JSON.stringify({ threads: mockThreads }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 3. Chat thread
      if (pathname === '/api/chat/thread') {
        const agent = searchParams.get('agent') || 'antigravity';
        const session = searchParams.get('session');
        const threadObj = mockThreads.find(t => t.agent === agent) || mockThreads[0];
        const activeSessId = session || (threadObj.sessions && threadObj.sessions[0] ? threadObj.sessions[0].id : 'sess-default');
        const msgs = mockSessionMessages[activeSessId] || [];

        return new Response(JSON.stringify({
          thread: {
            agent: agent,
            id: activeSessId,
            messages: msgs
          },
          activeSessionId: activeSessId,
          sessions: threadObj.sessions || []
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 4. Chat send
      if (pathname === '/api/chat/send') {
        const agent = reqBody.agent || 'antigravity';
        const sessId = reqBody.sessionId || 'sess-ag-1';
        const text = reqBody.text || '';

        if (!mockSessionMessages[sessId]) mockSessionMessages[sessId] = [];

        // Add user msg
        mockSessionMessages[sessId].push({
          role: 'me',
          text: text,
          ts: Date.now()
        });

        // Generate response artifact
        const artPath = `artifacts/demo_output_${Date.now()}.md`;
        mockArtifacts[artPath] = {
          text: [
            `# 任务输出结果 (${agent})`,
            '',
            '你发送的消息是：',
            `> ${text}`,
            '',
            '这是本地演示模式自动生成的产物，已同步加入工作台！',
            '```json',
            JSON.stringify({ status: "success", timestamp: Date.now(), agent: agent, model: reqBody.model || "default" }, null, 2),
            '```'
          ].join('\n'),
          truncated: false
        };

        // Add simulated agent response
        mockSessionMessages[sessId].push({
          role: 'agent',
          text: `### 收到指令\n\n已完成任务解析：**「${text}」**。\n\n- 模型：\`${reqBody.model || '默认'}\`\n- 思考程度：\`${reqBody.effort || '默认'}\`\n- 状态：执行完毕，生成演示产物已进入工作台。`,
          ts: Date.now() + 50,
          artifact: artPath
        });

        // Update thread preview
        const targetThread = mockThreads.find(t => t.agent === agent);
        if (targetThread) {
          targetThread.updated = Date.now();
          targetThread.last = { role: 'agent', text: `已完成任务解析：${text}`, ts: Date.now() };
          const sObj = (targetThread.sessions || []).find(s => s.id === sessId);
          if (sObj) sObj.msgCount = mockSessionMessages[sessId].length;
        }

        return new Response(JSON.stringify({ ok: true, id: 'msg-' + Date.now() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 5. New session
      if (pathname === '/api/chat/new-session') {
        const agent = reqBody.agent || 'antigravity';
        const newId = `sess-${agent}-${Date.now().toString(36)}`;
        const targetThread = mockThreads.find(t => t.agent === agent);
        const newSess = { id: newId, title: reqBody.title || '新会话', msgCount: 0, ts: Date.now() };
        if (targetThread) {
          if (!targetThread.sessions) targetThread.sessions = [];
          targetThread.sessions.unshift(newSess);
        }
        mockSessionMessages[newId] = [
          { role: 'agent', text: `已开启针对 **${agent}** 的新会话。请在下方输入框中派发测试指令！`, ts: Date.now() }
        ];
        return new Response(JSON.stringify({ ok: true, id: newId, session: newSess }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 6. Artifact preview
      if (pathname === '/api/artifact') {
        const path = searchParams.get('path') || '';
        const found = mockArtifacts[path] || { text: '/* 演示产物内容示例 */\nconsole.log("Hello from multi-agent-hub");', truncated: false };
        return new Response(JSON.stringify({ ok: true, text: found.text, truncated: found.truncated, path: path }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 7. Toggle agent
      if (pathname === '/api/agents/toggle') {
        const ag = mockAgents.find(a => a.name === reqBody.agent);
        if (ag) ag.disabled = !reqBody.enabled;
        return new Response(JSON.stringify({ ok: true, enabled: reqBody.enabled }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 8. Account switching, model switching & Quotas
      if (pathname === '/api/accounts/switch') {
        const worker = reqBody.worker;
        const name = reqBody.name;
        if (worker && mockAccountsData.workers[worker]) {
          const profiles = mockAccountsData.workers[worker].profiles;
          let target = null;
          profiles.forEach(p => {
            if (p.name === name) { p.active = true; target = p; }
            else { p.active = false; }
          });
          if (mockWorkersQuotasData[worker] && target) {
            mockWorkersQuotasData[worker].account = target.display || target.name;
          }
        }
        return new Response(JSON.stringify({ ok: true, name: name }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/models/default') {
        const worker = reqBody.worker;
        const alias = reqBody.alias;
        if (worker && mockWorkersModelsData[worker]) {
          mockWorkersModelsData[worker].default = alias;
          mockWorkersModelsData[worker].models.forEach(m => {
            m.isDefault = (m.id === alias || m.alias === alias);
          });
        }
        mockModelCatalog.forEach(m => {
          if (m.agent === worker) {
            m.default = (m.id === alias || m.name === alias);
          }
        });
        return new Response(JSON.stringify({ ok: true, default: alias }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/accounts/save') {
        const worker = reqBody.worker;
        const name = reqBody.name;
        if (worker && mockAccountsData.workers[worker]) {
          const profiles = mockAccountsData.workers[worker].profiles;
          if (!profiles.some(p => p.name === name)) {
            profiles.push({ name: name, display: `${name} (自定义)`, active: false, identity: `${name}@demo.local` });
          }
        }
        return new Response(JSON.stringify({ ok: true, name: name }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/accounts/delete') {
        const worker = reqBody.worker;
        const name = reqBody.name;
        if (worker && mockAccountsData.workers[worker]) {
          mockAccountsData.workers[worker].profiles = mockAccountsData.workers[worker].profiles.filter(p => p.name !== name);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/auth/logout') {
        const worker = reqBody.worker;
        if (worker && mockAccountsData.workers[worker]) {
          mockAccountsData.workers[worker].profiles.forEach(p => { p.active = false; });
          if (mockWorkersQuotasData[worker]) {
            mockWorkersQuotasData[worker].account = '';
          }
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/auth/login') {
        return new Response(JSON.stringify({ ok: true, loginId: 'demo-login-' + Date.now(), note: '演示授权会话已就绪' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/auth/poll') {
        return new Response(JSON.stringify({ ok: true, exited: true, exitCode: 0, accountName: 'demo-oauth-user' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/auth/finish') {
        return new Response(JSON.stringify({ ok: true, accountName: 'demo-oauth-user' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/quotas' || pathname === '/api/quota') {
        return new Response(JSON.stringify({
          ok: true,
          workers: mockWorkersQuotasData
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/chat/agent-summary') {
        const mockSummaries = {
          'antigravity': '全栈系统协同就绪 · 双通道监听',
          'codearts': '华为云 Maas 调度就绪 · 网关已校验',
          'codebuddy': '测试套件运行完毕 · 无异常',
          'codebuddy-cn': '国产算力集群同步中 · 延迟 22ms',
          'github-copilot': '代码分析流水线正常 · 活跃中',
          'mimocode': '澎湃OS 终端调度就绪 · 待机',
          'minimaxcode': '多模态推理上下文同步中 · 低延时',
          'traecode': 'TRAE 编辑器协同插件在线',
          'zcode': '智谱科技蓝图模型挂载就绪'
        };
        return new Response(JSON.stringify({
          ok: true,
          summaries: mockSummaries
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/accounts') {
        return new Response(JSON.stringify({
          ok: true,
          workers: mockAccountsData.workers
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/models') {
        return new Response(JSON.stringify({
          ok: true,
          models: mockModelCatalog,
          workers: mockWorkersModelsData
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/usage') {
        return new Response(JSON.stringify({
          ok: true,
          stats: { tot: 15400, pct: 1.5, tps: 42.5 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Default fallback for any other /api route
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return origFetch.apply(this, arguments);
  };

  // Add subtle demo indicator in title once DOM ready
  document.addEventListener('DOMContentLoaded', function() {
    document.title = 'multi-agent-hub (交互与动画演示 Demo)';
    const headerTitle = document.querySelector('header.top .sub');
    if (headerTitle) {
      headerTitle.textContent = '多智能体协同调度中枢 · 交互动效展示 Demo (纯本地运行)';
    }
    const dot = document.getElementById('conn-dot');
    if (dot) {
      dot.className = 'dot ok';
      dot.title = '演示模式 · 本地交互 (Demo Mode)';
    }
  });

})();
