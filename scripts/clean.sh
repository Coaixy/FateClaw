#!/usr/bin/env bash
# 清理本地编译产物（调试用）。
# 当前正式真源是 PostgreSQL + Redis，这里不再处理已废弃的 data/ 目录。
#
# 用法: bash scripts/clean.sh [--all | --dist]
#   无参数  = 删除宿主 / Web 编译产物
#   --all   = 同上，保留为兼容别名
#   --dist  = 同上

set -euo pipefail
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

clean_dist() {
  if [ -d "apps/api/dist" ]; then
    rm -rf apps/api/dist
    echo -e "  ${RED}✕${RESET} apps/api/dist/"
  else
    echo -e "  ${DIM}– apps/api/dist/ (不存在)${RESET}"
  fi

  if [ -d "apps/web/out" ]; then
    rm -rf apps/web/out
    echo -e "  ${RED}✕${RESET} apps/web/out/"
  else
    echo -e "  ${DIM}– apps/web/out/ (不存在)${RESET}"
  fi

  if [ -d "apps/agent-runtime/dist" ]; then
    rm -rf apps/agent-runtime/dist
    echo -e "  ${RED}✕${RESET} apps/agent-runtime/dist/"
  else
    echo -e "  ${DIM}– apps/agent-runtime/dist/ (不存在)${RESET}"
  fi
}

do_dist=false

if [ $# -eq 0 ]; then
  do_dist=true
else
  for arg in "$@"; do
    case "$arg" in
      --all)  do_dist=true ;;
      --dist) do_dist=true ;;
      *)
        echo "未知参数: $arg"
        echo "用法: bash scripts/clean.sh [--all | --dist]"
        exit 1
        ;;
    esac
  done
fi

echo -e "${GREEN}清理本地产物...${RESET}"
$do_dist && clean_dist
echo -e "${GREEN}完成${RESET}"
