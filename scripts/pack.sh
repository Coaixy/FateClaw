#!/usr/bin/env bash
# 打包源码用于云端部署
# 用法: bash scripts/pack.sh [输出文件名]
# 兼容旧参数: --light --no-obfuscate --skip-install --jobs N 会被忽略

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")

# 解析参数。旧参数只用于兼容 package.json 里的历史 pack 命令，源码包不再本地安装、构建或混淆。
OUTFILE=""
LEGACY_ARGS=()
while [ "$#" -gt 0 ]; do
  arg="$1"
  if [ "$arg" = "--light" ] || [ "$arg" = "--no-obfuscate" ] || [ "$arg" = "--skip-install" ]; then
    LEGACY_ARGS+=("$arg")
    shift
  elif [ "$arg" = "--jobs" ]; then
    if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
      echo "❌ --jobs 需要一个参数"
      exit 1
    fi
    LEGACY_ARGS+=("$arg $2")
    shift 2
  elif [[ "$arg" == --jobs=* ]]; then
    LEGACY_ARGS+=("$arg")
    shift
  elif [[ "$arg" == --* ]]; then
    echo "❌ 未知参数: $arg"
    exit 1
  else
    if [ -n "$OUTFILE" ]; then
      echo "❌ 只能指定一个输出文件名"
      exit 1
    fi
    OUTFILE="$arg"
    shift
  fi
done
OUTFILE="${OUTFILE:-fateclaw-v${VERSION}-source.tar.gz}"

SCRIPT_START=$SECONDS

# 输出步骤耗时。
# 参数:
#   $1: 步骤名称
#   $2: 步骤开始时的 SECONDS 值
# 返回值: 无；仅向标准输出打印耗时。
log_duration() {
  local label="$1"
  local started_at="$2"
  local elapsed=$((SECONDS - started_at))
  echo "⏱ ${label}: ${elapsed}s"
}

if [ "${#LEGACY_ARGS[@]}" -gt 0 ]; then
  echo "ℹ️ 已切换为源码包，忽略本地构建/混淆参数: ${LEGACY_ARGS[*]}"
fi

# ── 1. 打包源码 ──
STEP_START=$SECONDS
echo "📦 打包 FateClaw 源码 v${VERSION} ..."

TMP_OUT="/tmp/$OUTFILE"

tar czf "$TMP_OUT" \
  --exclude='node_modules' \
  --exclude='.pnpm-store' \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='.idea' \
  --exclude='.vscode' \
  --exclude='.fateclaw' \
  --exclude='.tmp-*' \
  --exclude='.env' \
  --exclude='*.keys.json' \
  --exclude='*.tar.gz' \
  --exclude='归档.zip' \
  --exclude='*.tsbuildinfo' \
  --exclude='*.log' \
  --exclude="$(basename "$ROOT_DIR")/apps/api/dist" \
  --exclude="$(basename "$ROOT_DIR")/apps/web/.next" \
  --exclude="$(basename "$ROOT_DIR")/apps/web/out" \
  --exclude="$(basename "$ROOT_DIR")/packages/agent-runner/dist" \
  --exclude="$(basename "$ROOT_DIR")/.next" \
  --exclude="$(basename "$ROOT_DIR")/store" \
  --exclude="$(basename "$ROOT_DIR")/data" \
  --exclude="$(basename "$ROOT_DIR")/logs" \
  --exclude="$(basename "$ROOT_DIR")/backups" \
  -C "$(dirname "$ROOT_DIR")" \
  "$(basename "$ROOT_DIR")"

mv "$TMP_OUT" "$OUTFILE"
SIZE=$(du -h "$OUTFILE" | cut -f1)
log_duration "生成源码 tar.gz" "$STEP_START"
echo "✅ 打包完成: $OUTFILE ($SIZE)"
log_duration "总耗时" "$SCRIPT_START"
echo ""
echo "部署步骤:"
echo "  1. scp $OUTFILE user@server:~/"
echo "  2. tar xzf $OUTFILE && cd fateclaw"
echo "  3. npm install -f && npm run build && npm run start"
