#!/usr/bin/env bash
# worker-smoke.sh — 对指定的已启用 worker 经 hub MCP 发送最小探测任务并记录烟测结果。
#
# 用法:
#   scripts/worker-smoke.sh <worker1> [worker2 ...]
#
# 说明:
#   - 必须通过命令行参数显式传入 worker 列表，禁止默认跑全部已配置 worker。
#   - 每个 worker 发送最小任务 {"task": "只回复 OK"}。
#   - 记录：受理状态、首个进度时间、完成状态/耗时、回复是否含 OK、错误原文。
#   - 结果表格输出到 stdout，并保存至 /tmp/worker-smoke-<时间>.md。
#
# 纪律: 绝不自行在无参数时全量运行，写完使用 bash -n 进行语法检查。

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "错误: 未指定任何 worker！禁止默认跑全部 worker。" >&2
  echo "用法: $0 <worker1> [worker2 ...]" >&2
  echo "示例: $0 codebuddy zcode" >&2
  exit 1
fi

HUBCALL="${HUBCALL:-$HOME/.hark/hubcall.py}"
if [ ! -f "$HUBCALL" ]; then
  echo "错误: 找不到 hubcall 脚本: $HUBCALL" >&2
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="/tmp/worker-smoke-${TIMESTAMP}.md"

# 结果收集数组
declare -a TABLE_ROWS=()

echo "=========================================================="
echo "Worker 最小探测烟测 (Worker Smoke Test)"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "测试 Worker 列表: $*"
echo "产物文件: $OUTPUT_FILE"
echo "=========================================================="

for agent in "$@"; do
  echo ""
  echo ">>> [1/2] 正在向 $agent 派发最小任务..."
  t_start=$(date +%s)
  
  # 构造派发参数并调用 hub_dispatch_cli
  dispatch_payload=$(python3 -c "import json, sys; print(json.dumps({'agent': sys.argv[1], 'task': '只回复 OK', 'timeout_s': 60}))" "$agent")
  dispatch_out=$(python3 "$HUBCALL" hub_dispatch_cli "$dispatch_payload" 2>&1 || true)
  
  # 解析受理状态及 ref
  ref=""
  accepted="否"
  first_progress="-"
  completion="失败"
  has_ok="否"
  raw_error=""

  # 匹配 ref: [agent/ref] 或 ref="..."
  ref=$(echo "$dispatch_out" | grep -oP '\[[a-zA-Z0-9_.-]+/\K[a-zA-Z0-9_.-]+(?=\])' | head -n 1 || true)
  if [ -z "$ref" ]; then
    ref=$(echo "$dispatch_out" | sed -n 's/.*ref="\([^"]*\)".*/\1/p' | head -n 1 || true)
  fi

  if [ -n "$ref" ] && echo "$dispatch_out" | grep -q "已异步受理"; then
    accepted="是 ($ref)"
    echo "    受理成功: ref=$ref"
  elif echo "$dispatch_out" | grep -q -i "status="; then
    accepted="是 (直接返回)"
  else
    accepted="否"
    raw_error=$(echo "$dispatch_out" | head -n 3 | tr '\n' ' ' | sed 's/|/\\|/g')
    echo "    派发失败: $raw_error"
  fi

  # 若受理成功且有 ref，调用 hub_wait_result 等待执行结果
  if [ -n "$ref" ]; then
    echo ">>> [2/2] 正在等待 $agent ($ref) 结果..."
    max_wait=120
    elapsed=0
    
    while [ "$elapsed" -lt "$max_wait" ]; do
      wait_payload=$(python3 -c "import json, sys; print(json.dumps({'ref': sys.argv[1], 'wait_s': 5}))" "$ref")
      wait_out=$(python3 "$HUBCALL" hub_wait_result "$wait_payload" 2>&1 || true)
      
      now_t=$(date +%s)
      current_elapsed=$((now_t - t_start))
      
      # 记录首个进度时间
      if [ "$first_progress" = "-" ]; then
        if echo "$wait_out" | grep -q "受控端界面快照" || echo "$wait_out" | grep -q "status=running"; then
          first_progress="${current_elapsed}s"
          echo "    检测到首个进度: ${first_progress}"
        fi
      fi

      # 检查终态
      if echo "$wait_out" | grep -q "status=completed"; then
        completion="完成 (${current_elapsed}s)"
        if [ "$first_progress" = "-" ]; then
          first_progress="${current_elapsed}s"
        fi
        if echo "$wait_out" | grep -qi "OK"; then
          has_ok="是"
        else
          has_ok="否 (未包含OK)"
        fi
        echo "    任务已完成: 耗时 ${current_elapsed}s, 包含OK: $has_ok"
        break
      elif echo "$wait_out" | grep -q -E "status=(error|failed|timeout)"; then
        stat=$(echo "$wait_out" | grep -o -E 'status=[a-zA-Z0-9_-]+' | head -n 1 || echo "status=error")
        completion="失败 ($stat, ${current_elapsed}s)"
        raw_error=$(echo "$wait_out" | head -n 3 | tr '\n' ' ' | sed 's/|/\\|/g')
        echo "    任务异常终态: $completion"
        break
      fi
      
      elapsed=$current_elapsed
    done

    if [ "$elapsed" -ge "$max_wait" ] && [ "$completion" = "失败" ]; then
      completion="超时 (>${max_wait}s)"
      raw_error="等待结果超时未完成"
    fi
  elif [ "$accepted" = "是 (直接返回)" ]; then
    t_end=$(date +%s)
    current_elapsed=$((t_end - t_start))
    first_progress="${current_elapsed}s"
    if echo "$dispatch_out" | grep -q "status=completed"; then
      completion="完成 (${current_elapsed}s)"
      if echo "$dispatch_out" | grep -qi "OK"; then
        has_ok="是"
      else
        has_ok="否"
      fi
    else
      completion="失败"
      raw_error=$(echo "$dispatch_out" | head -n 3 | tr '\n' ' ' | sed 's/|/\\|/g')
    fi
  fi

  TABLE_ROWS+=("| $agent | $accepted | $first_progress | $completion | $has_ok | ${raw_error:-(无)} |")
done

# 生成 Markdown 表格报告
REPORT_CONTENT=$(cat <<EOF
# Worker 最小探测烟测报告

- **执行时间**: $(date '+%Y-%m-%d %H:%M:%S')
- **探测任务**: \`只回复 OK\`
- **测试 Worker 数量**: $#

| Worker (Agent) | 受理 | 首个进度时间 | 完成 | 回复是否含 OK | 错误原文 |
| --- | --- | --- | --- | --- | --- |
$(printf "%s\n" "${TABLE_ROWS[@]}")

EOF
)

# 输出到 stdout
echo ""
echo "=========================================================="
echo "$REPORT_CONTENT"
echo "=========================================================="

# 写入产物文件
mkdir -p "$(dirname "$OUTPUT_FILE")"
echo "$REPORT_CONTENT" > "$OUTPUT_FILE"
echo "报告已写入: $OUTPUT_FILE"
