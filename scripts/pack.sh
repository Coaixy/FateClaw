#!/usr/bin/env bash
# 分离打包 API 生产运行包、后端源码包、www 静态产物和 admin 静态产物用于部署
# 用法:
#   bash scripts/pack.sh [all|backend-runtime|api-runtime|runtime|backend|api|backend-source|api-source|www|web|admin|source]
#   bash scripts/pack.sh backend-runtime [输出文件名]
#   bash scripts/pack.sh backend [输出文件名]
#   bash scripts/pack.sh www [输出文件名]
#   bash scripts/pack.sh admin [输出文件名]
# 兼容旧打包参数: --light --no-obfuscate --skip-install --jobs N 会被忽略

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
  elif [ "$arg" = "all" ] || [ "$arg" = "backend-runtime" ] || [ "$arg" = "api-runtime" ] || [ "$arg" = "runtime" ] || [ "$arg" = "backend" ] || [ "$arg" = "api" ] || [ "$arg" = "backend-source" ] || [ "$arg" = "api-source" ] || [ "$arg" = "www" ] || [ "$arg" = "web" ] || [ "$arg" = "admin" ] || [ "$arg" = "source" ]; then
    if [ "$arg" = "runtime" ]; then
      MODE="backend-runtime"
    elif [ "$arg" = "web" ]; then
      MODE="www"
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
  echo "❌ all 模式会生成三个文件，不能指定单个输出文件名"
  exit 1
fi

SCRIPT_START=$SECONDS
GENERATED_BACKEND_RUNTIME=""
GENERATED_BACKEND_SOURCE=""
GENERATED_WWW_STATIC=""
GENERATED_ADMIN_STATIC=""

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

# 生产运行包部署时由 1Panel/npm 安装依赖；npm 不识别 pnpm 的 workspace: 协议。
# 这里仅改写临时打包目录里的 package.json，源码工作区仍保持 pnpm workspace 配置。
rewrite_runtime_package_for_npm() {
  local package_file="$1"
  node -e "
    const fs = require('node:fs');
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.dependencies?.['@fateclaw/contracts'] === 'workspace:*') {
      pkg.dependencies['@fateclaw/contracts'] = 'file:../../packages/contracts';
    }
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  " "$package_file"
}

# 前端静态构建不会自动读取仓库根 .env；这里仅导出公开变量，
# 避免把后端密钥类配置带进 Next 构建进程。
load_frontend_public_env() {
  if [ -n "${NEXT_PUBLIC_API_BASE:-}" ]; then
    return
  fi
  if [ ! -f .env ]; then
    return
  fi

  local api_base
  api_base=$(node -e "
    const fs = require('node:fs');
    const env = fs.readFileSync('.env', 'utf8');
    const keys = new Set(['NEXT_PUBLIC_API_BASE', 'PUBLIC_API_BASE_URL']);
    for (const line of env.split(/\\r?\\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index < 0) continue;
      const key = trimmed.slice(0, index).trim();
      if (!keys.has(key)) continue;
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('\"') && value.endsWith('\"')) ||
        (value.startsWith(\"'\") && value.endsWith(\"'\"))
      ) {
        value = value.slice(1, -1);
      }
      process.stdout.write(value);
      break;
    }
  ")

  if [ -n "$api_base" ]; then
    export NEXT_PUBLIC_API_BASE="$api_base"
    echo "ℹ️ 已从根 .env 为前端构建设置 NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE"
  fi
}

if [ "${#LEGACY_ARGS[@]}" -gt 0 ]; then
  echo "ℹ️ 当前为分离部署包，忽略旧的本地混淆参数: ${LEGACY_ARGS[*]}"
fi

pack_backend_source() {
  local outfile="${1:-fateclaw-backend-v${VERSION}-source.tar.gz}"
  local tmp_out="/tmp/$outfile"
  local step_start=$SECONDS

  echo "📦 打包后端源码 v${VERSION} ..."
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
    --exclude="$ROOT_NAME/apps/admin" \
    --exclude="$ROOT_NAME/apps/api/dist" \
    --exclude="$ROOT_NAME/apps/agent-runtime/dist" \
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
  log_duration "生成后端源码包" "$step_start"
  echo "✅ 后端源码包: $outfile ($size)"
  GENERATED_BACKEND_SOURCE="$outfile"
}

pack_backend_runtime() {
  local outfile="${1:-fateclaw-backend-v${VERSION}-runtime.tar.gz}"
  local tmp_out="/tmp/$outfile"
  local stage_dir
  stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/fateclaw-backend-runtime.XXXXXX")
  local app_dir="$stage_dir/$ROOT_NAME"
  local step_start=$SECONDS

  echo "🔨 构建后端生产运行产物 ..."
  pnpm run build:backend

  echo "📦 打包后端生产运行包 v${VERSION} ..."
  mkdir -p "$app_dir/apps/api" "$app_dir/apps/agent-runtime" "$app_dir/packages/contracts"
  cp package.json pnpm-workspace.yaml "$app_dir/"
  if [ -f pnpm-lock.yaml ]; then
    cp pnpm-lock.yaml "$app_dir/pnpm-lock.yaml"
  fi
  if [ -f .npmrc ]; then
    cp .npmrc "$app_dir/.npmrc"
  fi
  if [ -f .env ]; then
    cp .env "$app_dir/.env"
  else
    echo "⚠️ 未找到 .env，后端生产运行包不会携带环境配置"
  fi
  cp apps/api/package.json "$app_dir/apps/api/package.json"
  rewrite_runtime_package_for_npm "$app_dir/apps/api/package.json"
  cp -R apps/api/dist "$app_dir/apps/api/dist"
  cp apps/agent-runtime/package.json "$app_dir/apps/agent-runtime/package.json"
  cp -R apps/agent-runtime/dist "$app_dir/apps/agent-runtime/dist"
  cp packages/contracts/package.json "$app_dir/packages/contracts/package.json"
  cp -R packages/contracts/src "$app_dir/packages/contracts/src"
  find "$app_dir/apps/api/dist" "$app_dir/apps/agent-runtime/dist" \
    \( -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) \
    -delete

  tar czf "$tmp_out" -C "$stage_dir" "$ROOT_NAME"
  rm -rf "$stage_dir"

  mv "$tmp_out" "$outfile"
  local size
  size=$(du -h "$outfile" | cut -f1)
  log_duration "生成后端生产运行包" "$step_start"
  echo "✅ 后端生产运行包: $outfile ($size)"
  GENERATED_BACKEND_RUNTIME="$outfile"
}

pack_www_static() {
  local outfile="${1:-fateclaw-www-v${VERSION}-static.tar.gz}"
  local tmp_out="/tmp/$outfile"
  local step_start=$SECONDS

  echo "🔨 构建 www 静态产物 ..."
  rm -rf apps/web/.next apps/web/out
  load_frontend_public_env
  pnpm run build:www

  echo "📦 打包 www 静态产物 v${VERSION} ..."
  tar czf "$tmp_out" -C apps/web/out .

  mv "$tmp_out" "$outfile"
  local size
  size=$(du -h "$outfile" | cut -f1)
  log_duration "生成 www 静态包" "$step_start"
  echo "✅ www 包: $outfile ($size)"
  GENERATED_WWW_STATIC="$outfile"
}

pack_admin_static() {
  local outfile="${1:-fateclaw-admin-v${VERSION}-static.tar.gz}"
  local tmp_out="/tmp/$outfile"
  local step_start=$SECONDS

  echo "🔨 构建 admin 静态产物 ..."
  rm -rf apps/admin/.next apps/admin/out
  load_frontend_public_env
  pnpm run build:admin

  echo "📦 打包 admin 静态产物 v${VERSION} ..."
  tar czf "$tmp_out" -C apps/admin/out .

  mv "$tmp_out" "$outfile"
  local size
  size=$(du -h "$outfile" | cut -f1)
  log_duration "生成 admin 静态包" "$step_start"
  echo "✅ admin 包: $outfile ($size)"
  GENERATED_ADMIN_STATIC="$outfile"
}

case "$MODE" in
  all)
    pack_backend_runtime
    pack_www_static
    pack_admin_static
    ;;
  backend-runtime)
    pack_backend_runtime "${OUTFILE:-}"
    ;;
  api-runtime)
    pack_backend_runtime "${OUTFILE:-}"
    ;;
  backend)
    pack_backend_source "${OUTFILE:-}"
    ;;
  api)
    pack_backend_source "${OUTFILE:-}"
    ;;
  backend-source)
    pack_backend_source "${OUTFILE:-}"
    ;;
  api-source)
    pack_backend_source "${OUTFILE:-}"
    ;;
  www)
    pack_www_static "${OUTFILE:-}"
    ;;
  admin)
    pack_admin_static "${OUTFILE:-}"
    ;;
  source)
    pack_backend_source "${OUTFILE:-fateclaw-v${VERSION}-source.tar.gz}"
    ;;
esac

log_duration "总耗时" "$SCRIPT_START"
echo ""
echo "部署步骤:"
if [ -n "$GENERATED_BACKEND_RUNTIME" ]; then
  echo "  后端生产运行包（API + Agent Runtime，1Panel 推荐）:"
  echo "    1. scp $GENERATED_BACKEND_RUNTIME user@server:~/"
  echo "    2. mkdir -p fateclaw && tar xzf $GENERATED_BACKEND_RUNTIME --strip-components=1 -C fateclaw"
  echo "    3. cd fateclaw && npm install --omit=dev -f && npm run start"
fi
if [ -n "$GENERATED_BACKEND_SOURCE" ]; then
  echo "  后端源码包:"
  echo "    1. scp $GENERATED_BACKEND_SOURCE user@server:~/"
  echo "    2. mkdir -p fateclaw && tar xzf $GENERATED_BACKEND_SOURCE --strip-components=1 -C fateclaw"
  echo "    3. cd fateclaw && pnpm install && pnpm run build && pnpm run start"
fi
if [ -n "$GENERATED_WWW_STATIC" ]; then
  echo "  www:"
  echo "    1. scp $GENERATED_WWW_STATIC user@server:~/"
  echo "    2. rm -rf /var/www/fateclaw-www/* && mkdir -p /var/www/fateclaw-www"
  echo "    3. tar xzf $GENERATED_WWW_STATIC -C /var/www/fateclaw-www"
fi
if [ -n "$GENERATED_ADMIN_STATIC" ]; then
  echo "  admin:"
  echo "    1. scp $GENERATED_ADMIN_STATIC user@server:~/"
  echo "    2. rm -rf /var/www/fateclaw-admin/* && mkdir -p /var/www/fateclaw-admin"
  echo "    3. tar xzf $GENERATED_ADMIN_STATIC -C /var/www/fateclaw-admin"
fi
echo "  Nginx:"
echo "    api 站点反代到 http://127.0.0.1:3000"
echo "    /_next/static/ 长缓存 immutable"
echo "    *.html 和 *.txt 不缓存 no-store"
echo "    www 站点指向 /var/www/fateclaw-www，并 try_files \$uri \$uri/ /index.html"
echo "    admin 站点指向 /var/www/fateclaw-admin，并 try_files \$uri \$uri/ /index.html"
