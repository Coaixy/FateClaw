#!/usr/bin/env bash
# 分离打包 API 生产运行包、API 源码包和 Web 静态产物用于部署
# 用法:
#   bash scripts/pack.sh [all|api-runtime|runtime|api|api-source|web|source]
#   bash scripts/pack.sh api-runtime [输出文件名]
#   bash scripts/pack.sh api [输出文件名]
#   bash scripts/pack.sh web [输出文件名]
# 兼容旧参数: --light --no-obfuscate --skip-install --jobs N 会被忽略

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")
ROOT_NAME="$(basename "$ROOT_DIR")"
MODE="all"
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
  elif [ "$arg" = "all" ] || [ "$arg" = "api-runtime" ] || [ "$arg" = "runtime" ] || [ "$arg" = "api" ] || [ "$arg" = "api-source" ] || [ "$arg" = "web" ] || [ "$arg" = "source" ]; then
    if [ "$arg" = "runtime" ]; then
      MODE="api-runtime"
    else
      MODE="$arg"
    fi
    shift
  else
    if [ -n "$OUTFILE" ]; then
      echo "❌ 只能指定一个输出文件名"
      exit 1
    fi
    OUTFILE="$arg"
    shift
  fi
done

if [ "$MODE" = "all" ] && [ -n "$OUTFILE" ]; then
  echo "❌ all 模式会生成两个文件，不能指定单个输出文件名"
  exit 1
fi

SCRIPT_START=$SECONDS
GENERATED_API_RUNTIME=""
GENERATED_API_SOURCE=""
GENERATED_WEB_STATIC=""

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
  echo "ℹ️ 当前为分离部署包，忽略旧的本地混淆参数: ${LEGACY_ARGS[*]}"
fi

pack_api_source() {
  local outfile="${1:-fateclaw-api-v${VERSION}-source.tar.gz}"
  local tmp_out="/tmp/$outfile"
  local step_start=$SECONDS

  echo "📦 打包 API 源码 v${VERSION} ..."
  tar czf "$tmp_out" \
    --exclude='node_modules' \
    --exclude='.pnpm-store' \
    --exclude='.git' \
    --exclude='.DS_Store' \
    --exclude='.idea' \
    --exclude='.vscode' \
    --exclude='.fateclaw' \
    --exclude='.tmp-*' \
    --exclude='*.keys.json' \
    --exclude='*.tar.gz' \
    --exclude='归档.zip' \
    --exclude='*.tsbuildinfo' \
    --exclude='*.log' \
    --exclude="$ROOT_NAME/apps/web" \
    --exclude="$ROOT_NAME/apps/api/dist" \
    --exclude="$ROOT_NAME/packages/agent-runner/dist" \
    --exclude="$ROOT_NAME/.next" \
    --exclude="$ROOT_NAME/store" \
    --exclude="$ROOT_NAME/data" \
    --exclude="$ROOT_NAME/logs" \
    --exclude="$ROOT_NAME/backups" \
    -C "$(dirname "$ROOT_DIR")" \
    "$ROOT_NAME"

  mv "$tmp_out" "$outfile"
  local size
  size=$(du -h "$outfile" | cut -f1)
  log_duration "生成 API 源码包" "$step_start"
  echo "✅ API 包: $outfile ($size)"
  GENERATED_API_SOURCE="$outfile"
}

pack_api_runtime() {
  local outfile="${1:-fateclaw-api-v${VERSION}-runtime.tar.gz}"
  local tmp_out="/tmp/$outfile"
  local stage_dir
  stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/fateclaw-api-runtime.XXXXXX")
  local app_dir="$stage_dir/$ROOT_NAME"
  local step_start=$SECONDS

  echo "🔨 构建 API 生产运行产物 ..."
  npm run build

  echo "📦 打包 API 生产运行包 v${VERSION} ..."
  mkdir -p "$app_dir/apps/api" "$app_dir/packages/agent-runner"
  cp package.json pnpm-workspace.yaml "$app_dir/"
  if [ -f .npmrc ]; then
    cp .npmrc "$app_dir/.npmrc"
  fi
  if [ -f .env ]; then
    cp .env "$app_dir/.env"
  else
    echo "⚠️ 未找到 .env，API 生产运行包不会携带环境配置"
  fi
  cp apps/api/package.json "$app_dir/apps/api/package.json"
  cp -R apps/api/dist "$app_dir/apps/api/dist"
  cp packages/agent-runner/package.json "$app_dir/packages/agent-runner/package.json"
  cp -R packages/agent-runner/dist "$app_dir/packages/agent-runner/dist"
  find "$app_dir/apps/api/dist" "$app_dir/packages/agent-runner/dist" \
    \( -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) \
    -delete

  tar czf "$tmp_out" -C "$stage_dir" "$ROOT_NAME"
  rm -rf "$stage_dir"

  mv "$tmp_out" "$outfile"
  local size
  size=$(du -h "$outfile" | cut -f1)
  log_duration "生成 API 生产运行包" "$step_start"
  echo "✅ API 生产运行包: $outfile ($size)"
  GENERATED_API_RUNTIME="$outfile"
}

pack_web_static() {
  local outfile="${1:-fateclaw-web-v${VERSION}-static.tar.gz}"
  local tmp_out="/tmp/$outfile"
  local step_start=$SECONDS

  echo "🔨 构建 Web 静态产物 ..."
  rm -rf apps/web/.next apps/web/out
  npm run build:web

  echo "📦 打包 Web 静态产物 v${VERSION} ..."
  tar czf "$tmp_out" -C apps/web/out .

  mv "$tmp_out" "$outfile"
  local size
  size=$(du -h "$outfile" | cut -f1)
  log_duration "生成 Web 静态包" "$step_start"
  echo "✅ Web 包: $outfile ($size)"
  GENERATED_WEB_STATIC="$outfile"
}

case "$MODE" in
  all)
    pack_api_runtime
    pack_web_static
    ;;
  api-runtime)
    pack_api_runtime "${OUTFILE:-}"
    ;;
  api)
    pack_api_source "${OUTFILE:-}"
    ;;
  api-source)
    pack_api_source "${OUTFILE:-}"
    ;;
  web)
    pack_web_static "${OUTFILE:-}"
    ;;
  source)
    pack_api_source "${OUTFILE:-fateclaw-v${VERSION}-source.tar.gz}"
    ;;
esac

log_duration "总耗时" "$SCRIPT_START"
echo ""
echo "部署步骤:"
if [ -n "$GENERATED_API_RUNTIME" ]; then
  echo "  API 生产运行包（1Panel 推荐）:"
  echo "    1. scp $GENERATED_API_RUNTIME user@server:~/"
  echo "    2. mkdir -p fateclaw && tar xzf $GENERATED_API_RUNTIME --strip-components=1 -C fateclaw"
  echo "    3. cd fateclaw && npm install --omit=dev -f && npm run start"
fi
if [ -n "$GENERATED_API_SOURCE" ]; then
  echo "  API 源码包:"
  echo "    1. scp $GENERATED_API_SOURCE user@server:~/"
  echo "    2. mkdir -p fateclaw && tar xzf $GENERATED_API_SOURCE --strip-components=1 -C fateclaw"
  echo "    3. cd fateclaw && npm install -f && npm run build && npm run start"
fi
if [ -n "$GENERATED_WEB_STATIC" ]; then
  echo "  Web:"
  echo "    1. scp $GENERATED_WEB_STATIC user@server:~/"
  echo "    2. rm -rf /var/www/fateclaw-web/* && mkdir -p /var/www/fateclaw-web"
  echo "    3. tar xzf $GENERATED_WEB_STATIC -C /var/www/fateclaw-web"
fi
echo "  Nginx:"
echo "    /api/ 反代到 http://127.0.0.1:3000"
echo "    /_next/static/ 长缓存 immutable"
echo "    *.html 和 *.txt 不缓存 no-store"
echo "    /     指向 /var/www/fateclaw-web，并 try_files \$uri \$uri/ /index.html"
