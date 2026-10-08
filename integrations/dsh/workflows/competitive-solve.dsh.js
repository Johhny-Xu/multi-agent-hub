// ==============================================================================
// DSH 原生工作流：多模型竞速解题与答案交叉校验 (competitive-solve)
// DeepSeek Harness Native Workflow: Competitive Problem Solving & Verification
// ==============================================================================
// 适用场景：高难度算法题或数学题，同时交由两路不同大模型求解，并由主模型核对答案一致性。
// ==============================================================================

const problem = (typeof args !== 'undefined' && args && args.problem) 
  ? String(args.problem) 
  : '一个圆内接正十二边形，若圆的半径为 10，求正十二边形的面积。';

phase("1. 并行派遣两路 Worker 独立解题");
log("正在同时派遣 Antigravity 与 CodeBuddy 独立计算...");

const solverTasks = [
  async () => {
    const p = `请调用 mcp__agenthub__hub_ask，参数 worker: "antigravity", task: "独立求解以下问题，给出详细步骤与最终答案：\\n${problem.replace(/"/g, '\\"')}", timeout_s: 300。直接回传计算结果。`;
    return { model: "antigravity (Gemini/Claude)", result: await agent(p) };
  },
  async () => {
    const p = `请调用 mcp__agenthub__hub_ask，参数 worker: "codebuddy", task: "独立求解以下问题，给出详细步骤与最终答案：\\n${problem.replace(/"/g, '\\"')}", timeout_s: 300。直接回传计算结果。`;
    return { model: "codebuddy (DeepSeek-V4.1)", result: await agent(p) };
  }
];

const answers = await parallel(solverTasks);
log("两路独立解答均已返回。");

phase("2. 答案交叉对比与裁定");
const verifierPrompt = `请作为首席裁判，比对以下两个独立模型的解答：
问题：${problem}

[解法 1 - ${answers[0].model}]：
${answers[0].result}

[解法 2 - ${answers[1].model}]：
${answers[1].result}

请分析两者的答案是否一致。如果不一致，指出哪一方推导存在漏洞；如果一致，提取出最终公认的最优答案与解题要点。`;

const verdict = await agent(verifierPrompt);

phase("3. 达成共识并输出");
return {
  problem,
  candidates: answers,
  finalVerdict: String(verdict || '').trim()
};
