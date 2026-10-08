// ==============================================================================
// DSH 原生工作流：双代理流水线代码审查 (code-audit)
// DeepSeek Harness Native Workflow: Pipeline Multi-Agent Code Audit
// ==============================================================================
// 适用场景：一阶段由 CodeBuddy 实现代码，二阶段由 Antigravity 针对边界安全审查。
//
// 如何在 DeepSeek Harness (DSH) 中调用：
// 直接向 DSH 助手发送：
//   “请使用 workflow 工具运行 code-audit 工作流，
//    参数 code='<待审查代码或需求>'”
// ==============================================================================

const code = (typeof args !== 'undefined' && args && args.code) ? String(args.code) : 'function sum(arr) { return arr.reduce((a,b)=>a+b, 0); }';

phase("1. CodeBuddy 代码架构与实现评审");
log("正在派遣 CodeBuddy 进行第一轮代码实现与性能审查...");

const reviewPrompt1 = `你是资深架构师 CodeBuddy。
请调用 MCP 工具 mcp__agenthub__hub_ask，参数为：
  worker: "codebuddy"
  task: "请对以下代码进行架构与性能审查，列出潜在缺陷与优化建议：\\n\\n${code.replace(/"/g, '\\"')}"
  timeout_s: 300
直接回传审查分析正文。`;

const stage1Output = await agent(reviewPrompt1);
log("第一轮架构审查完成。");

phase("2. Antigravity 边界安全与极值反思");
log("正在派遣 Antigravity (Gemini/Claude) 进行深度边界与安全性复核...");

const reviewPrompt2 = `你是资深安全与算法专家 Antigravity。
请调用 MCP 工具 mcp__agenthub__hub_ask，参数为：
  worker: "antigravity"
  task: "参考上一轮架构评审结论：\\n${String(stage1Output || '').replace(/"/g, '\\"')}\\n\\n针对原始代码：\\n${code.replace(/"/g, '\\"')}\\n\\n请进行严格的边界溢出、异常处理与安全性反思，给出最终裁决方案。"
  timeout_s: 300
直接回传最终安全审查报告。`;

const stage2Output = await agent(reviewPrompt2);
log("第二轮安全审查完成。");

phase("3. 汇总结案");
return {
  status: "completed",
  targetCode: code,
  stage1_architecture_review: String(stage1Output || '').trim(),
  stage2_security_audit: String(stage2Output || '').trim(),
  recommendation: "审查已完成，请参阅 stage1 与 stage2 联合报告实施重构。"
};
