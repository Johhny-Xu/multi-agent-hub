// ==============================================================================
// DSH 原生工作流：全代理并发扇出与结果汇总 (hub-fanout)
// DeepSeek Harness Native Workflow: Multi-Agent Parallel Fan-out
// ==============================================================================
// 适用场景：需要将同一任务分发给多个不同厂商的 AI 代理并行执行，并聚合各方结果。
//
// 如何在 DeepSeek Harness (DSH) 中调用：
// 直接向 DSH 助手发送：
//   “请使用 workflow 工具运行 hub-fanout 工作流，
//    参数 task='<你的任务提示词>'，workers='antigravity,codebuddy,traecode'”
// ==============================================================================

const task = (typeof args !== 'undefined' && args && args.task) ? String(args.task) : '请用简洁语言自我介绍你的身份与所使用的模型。';
const workersStr = (typeof args !== 'undefined' && args && args.workers) ? String(args.workers) : 'antigravity,codebuddy,traecode';

const workerList = workersStr.split(/[,，\s]+/).map(w => w.trim()).filter(Boolean);

phase("1. 准备多代理并发分发");
log(`即将并发调度 ${workerList.length} 个 Agent Hub Worker: ${workerList.join('、')}`);

// 2. 利用 DSH 原生 parallel() 扇出子代理
const fanoutTasks = workerList.map(worker => {
  return async () => {
    log(`正在通过 Agent Hub 调度 Worker [${worker}]...`);
    // 调用 DSH 原生子 agent，通过挂载的 MCP 工具 mcp__agenthub__hub_ask 派发给远程 Agent
    const prompt = `你是对接 Agent Hub 的专业代理通道。
请立即调用已挂载的 MCP 工具 mcp__agenthub__hub_ask，参数为：
  worker: "${worker}"
  task: "${task.replace(/"/g, '\\"')}"
  timeout_s: 300
工具执行完毕后，直接提取返回的 JSON 中 answer 字段并输出，不要添加任何多余修饰。`;

    try {
      const response = await agent(prompt);
      return {
        worker,
        status: "success",
        answer: String(response || '').trim()
      };
    } catch (err) {
      return {
        worker,
        status: "failed",
        error: String(err && err.message || err)
      };
    }
  };
});

phase("2. 并发执行与结果汇流");
const results = await parallel(fanoutTasks);

phase("3. 结果汇总与决策输出");
const successes = results.filter(r => r.status === "success");
const failures = results.filter(r => r.status === "failed");

log(`调度完成：成功 ${successes.length} / 失败 ${failures.length}`);

return {
  summary: `已成功聚合 ${successes.length}/${results.length} 个 Agent 的执行结果。`,
  task,
  workers: workerList,
  results: results.map(r => ({
    worker: r.worker,
    status: r.status,
    output: r.answer || r.error
  }))
};
