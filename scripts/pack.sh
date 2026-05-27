#!/usr/bin/env bash
# 打包混淆后的代码用于远程部署
# 用法: bash scripts/pack.sh [输出文件名] [--light] [--no-obfuscate] [--skip-install] [--jobs N]
#   --light         轻量混淆（仅 terser 压缩，跳过 obfuscator，构建更快）
#   --no-obfuscate  完全跳过混淆步骤，直接打包编译产物
#   --skip-install  跳过依赖安装，适合本地依赖已确认无变化时重复打包
#   --jobs N        混淆/压缩 JS 文件的并发数，默认由 obfuscate.mjs 自动限制

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")

# 解析参数
LIGHT_FLAG=""
NO_OBFUSCATE=""
SKIP_INSTALL=""
OBFUSCATE_JOBS=""
OUTFILE=""
while [ "$#" -gt 0 ]; do
  arg="$1"
  if [ "$arg" = "--light" ]; then
    LIGHT_FLAG="--light"
    shift
  elif [ "$arg" = "--no-obfuscate" ]; then
    NO_OBFUSCATE="1"
    shift
  elif [ "$arg" = "--skip-install" ]; then
    SKIP_INSTALL="1"
    shift
  elif [ "$arg" = "--jobs" ]; then
    if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
      echo "❌ --jobs 需要一个正整数参数"
      exit 1
    fi
    OBFUSCATE_JOBS="$2"
    shift 2
  elif [[ "$arg" == --jobs=* ]]; then
    OBFUSCATE_JOBS="${arg#--jobs=}"
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
OUTFILE="${OUTFILE:-fateclaw-v${VERSION}.tar.gz}"

if [ -n "$OBFUSCATE_JOBS" ] && ! [[ "$OBFUSCATE_JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "❌ --jobs 需要正整数，当前值: $OBFUSCATE_JOBS"
  exit 1
fi

OBFUSCATE_ARGS=()
if [ -n "$LIGHT_FLAG" ]; then
  OBFUSCATE_ARGS+=("$LIGHT_FLAG")
fi
if [ -n "$OBFUSCATE_JOBS" ]; then
  OBFUSCATE_ARGS+=(--jobs "$OBFUSCATE_JOBS")
fi

SCRIPT_START=$SECONDS

log_duration() {
  local label="$1"
  local started_at="$2"
  local elapsed=$((SECONDS - started_at))
  echo "⏱ ${label}: ${elapsed}s"
}

# ── 0. 安装 workspace 依赖 ──
if [ -n "$SKIP_INSTALL" ]; then
  echo "⏭ 跳过 workspace 依赖安装（--skip-install）"
else
  STEP_START=$SECONDS
  echo "📦 安装 workspace 依赖 ..."
  pnpm install --frozen-lockfile
  log_duration "安装 workspace 依赖" "$STEP_START"
fi

# ── 1. 构建后端 ──
STEP_START=$SECONDS
echo "🧹 清理宿主机 dist ..."
rm -rf apps/api/dist
echo "🔨 编译宿主机 TypeScript ..."
pnpm run build
log_duration "编译宿主机 TypeScript" "$STEP_START"

# ── 2. 构建 agent-runner（宿主本地模式共用）──
STEP_START=$SECONDS
echo "🧹 清理 agent-runner dist ..."
rm -rf packages/agent-runner/dist
echo "🔨 编译 agent-runner ..."
pnpm --filter fateclaw-agent-runner run build
log_duration "编译 agent-runner" "$STEP_START"

# ── 3. 构建前端静态文件 ──
STEP_START=$SECONDS
echo "🔨 构建 Web 前端 ..."
echo "🧹 清理 web 构建产物 ..."
# .next/cache 是 Next.js 增量构建缓存；部署包会排除 .next，所以这里只清理最终静态产物，避免每次打包都变成冷构建。
rm -rf apps/web/out
pnpm --filter fateclaw-web run build
log_duration "构建 Web 前端" "$STEP_START"

# ── 4. 混淆后端代码 ──
if [ -n "$NO_OBFUSCATE" ]; then
  echo "⏭ 跳过混淆步骤（--no-obfuscate）"
else
  STEP_START=$SECONDS
  echo "🔒 混淆宿主机后端 (apps/api/dist/) ..."
  node scripts/obfuscate.mjs apps/api/dist "${OBFUSCATE_ARGS[@]}"

  echo "🔒 混淆 Agent Runner (packages/agent-runner/dist/) ..."
  node scripts/obfuscate.mjs packages/agent-runner/dist "${OBFUSCATE_ARGS[@]}"
  log_duration "混淆/压缩后端代码" "$STEP_START"
fi

# ── 5. 打包（排除所有源码）──
STEP_START=$SECONDS
echo "📦 打包 fateclaw v${VERSION} ..."

TMP_OUT="/tmp/$OUTFILE"

tar czf "$TMP_OUT" \
  --exclude='node_modules' \
  --exclude='.pnpm-store' \
  --exclude='apps/web/.next' \
  --exclude='apps/web/node_modules' \
  --exclude="$(basename "$ROOT_DIR")/.next" \
  --exclude="$(basename "$ROOT_DIR")/store" \
  --exclude="$(basename "$ROOT_DIR")/data" \
  --exclude="$(basename "$ROOT_DIR")/logs" \
  --exclude='*.keys.json' \
  --exclude='.DS_Store' \
  --exclude='.idea' \
  --exclude='.vscode' \
  --exclude='.fateclaw' \
  --exclude='*.tsbuildinfo' \
  --exclude='.tmp-*' \
  --exclude='*.tar.gz' \
  --exclude='归档.zip' \
  --exclude='.git' \
  --exclude="$(basename "$ROOT_DIR")/apps/api/src" \
  --exclude="$(basename "$ROOT_DIR")/packages/agent-runner/src" \
  --exclude="$(basename "$ROOT_DIR")/apps/web/app" \
  --exclude="$(basename "$ROOT_DIR")/apps/web/lib" \
  --exclude="$(basename "$ROOT_DIR")/apps/web/components" \
  --exclude="$(basename "$ROOT_DIR")/scripts" \
  --exclude='*.js.map' \
  --exclude='*.d.ts' \
  --exclude='*.d.ts.map' \
  -C "$(dirname "$ROOT_DIR")" \
  "$(basename "$ROOT_DIR")"

mv "$TMP_OUT" "$OUTFILE"
SIZE=$(du -h "$OUTFILE" | cut -f1)
log_duration "生成 tar.gz" "$STEP_START"
echo "✅ 打包完成: $OUTFILE ($SIZE)"
log_duration "总耗时" "$SCRIPT_START"
echo ""
echo "部署步骤:"
echo "  1. scp $OUTFILE user@server:~/"
echo "  2. tar xzf $OUTFILE && cd fateclaw"
echo "  3. pnpm install --frozen-lockfile && pnpm start"
