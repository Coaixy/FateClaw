#!/usr/bin/env bash
# Usage: bash scripts/pack.sh [all|backend-runtime|backend-source|www|admin|source] [output] [--jobs N]
# Legacy target aliases and --light/--no-obfuscate/--skip-install remain accepted.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")
ROOT_NAME="$(basename "$ROOT_DIR")"
MODE="all"
OUTFILE=""
JOBS=3

while [ "$#" -gt 0 ]; do
  arg="$1"
  if [ "$arg" = "--light" ] || [ "$arg" = "--no-obfuscate" ] || [ "$arg" = "--skip-install" ]; then
    shift
  elif [ "$arg" = "--jobs" ]; then
    if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then
      echo "❌ --jobs 需要一个参数"
      exit 1
    fi
    JOBS="$2"
    shift 2
  elif [[ "$arg" == --jobs=* ]]; then
    JOBS="${arg#--jobs=}"
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

if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "❌ --jobs 需要一个正整数"
  exit 1
fi
if [ "${#JOBS}" -gt 1 ] || [ "$JOBS" -gt 3 ]; then
  JOBS=3
fi

if [ "$MODE" = "all" ] && [ -n "$OUTFILE" ]; then
  echo "❌ all 模式会生成三个文件，不能指定单个输出文件名"
  exit 1
fi

SCRIPT_START=$SECONDS
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fateclaw-pack.XXXXXX")
WORK_DIR=$(cd "$WORK_DIR" && pwd -P)
JOB_PIDS=()
JOB_LABELS=()
JOB_LOGS=()
ACTIVE_JOBS=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local pid
  for pid in ${JOB_PIDS[@]+"${JOB_PIDS[@]}"}; do
    if [ "$pid" -gt 0 ]; then
      kill -TERM -- "-$pid" 2>/dev/null || true
    fi
  done
  for pid in ${JOB_PIDS[@]+"${JOB_PIDS[@]}"}; do
    if [ "$pid" -gt 0 ]; then
      kill -KILL -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Separate process groups let cleanup stop each worker's build subprocesses too.
set -m

wait_pack_job() {
  local index
  while true; do
    for index in "${!JOB_PIDS[@]}"; do
      if [ "${JOB_PIDS[$index]}" -eq 0 ]; then
        continue
      fi
      if [ -f "$WORK_DIR/job-$index.done" ] || ! kill -0 "${JOB_PIDS[$index]}" 2>/dev/null; then
        if wait "${JOB_PIDS[$index]}"; then
          JOB_PIDS[$index]=0
          ACTIVE_JOBS=$((ACTIVE_JOBS - 1))
          sed -n '/^⚠️/p; /^✅/p' "${JOB_LOGS[$index]}"
          return
        else
          local status=$?
          echo "❌ ${JOB_LABELS[$index]}失败" >&2
          cat "${JOB_LOGS[$index]}" >&2
          return "$status"
        fi
      fi
    done
    sleep 0.1
  done
}

run_pack_job() {
  local label="$1"
  shift
  local log_file="$WORK_DIR/job-${#JOB_PIDS[@]}.log"
  local status_file="$WORK_DIR/job-${#JOB_PIDS[@]}.done"
  echo "📦 ${label} ..."
  (
    trap ': > "$status_file"' EXIT
    "$@"
  ) > "$log_file" 2>&1 &
  JOB_PIDS+=("$!")
  JOB_LABELS+=("$label")
  JOB_LOGS+=("$log_file")
  ACTIVE_JOBS=$((ACTIVE_JOBS + 1))
  if [ "$ACTIVE_JOBS" -ge "$JOBS" ]; then
    wait_pack_job
  fi
}

report_archive() {
  local outfile="$1"
  local started_at="$2"
  local size
  size=$(du -h "$outfile" | cut -f1)
  echo "✅ $outfile ($size, $((SECONDS - started_at))s)"
}

# Only staged runtime manifests use npm-compatible local contracts references.
rewrite_runtime_package_for_npm() {
  local package_file="$1"
  node -e "
    const fs = require('node:fs');
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.dependencies?.['@fateclaw/contracts'] === 'workspace:*') {
      pkg.dependencies['@fateclaw/contracts'] = 'file:../../packages/contracts';
    }
    if (process.argv[2]) {
      pkg.overrides = JSON.parse(process.argv[2]);
    }
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  " "$package_file" "${2:-}"
}

# Export only the public API base needed by the frontend builds.
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
  fi
}

pack_backend_source() {
  local outfile="${1:-fateclaw-backend-v${VERSION}-source.tar.gz}"
  local tmp_out="$WORK_DIR/backend-source.tar.gz"
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
    --exclude="$ROOT_NAME/${WORK_DIR#"$ROOT_DIR"/}" \
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
  report_archive "$outfile" "$step_start"
}

pack_backend_runtime() {
  local outfile="${1:-fateclaw-backend-v${VERSION}-runtime.tar.gz}"
  local tmp_out="$WORK_DIR/backend-runtime.tar.gz"
  local stage_dir="$WORK_DIR/backend-runtime"
  local app_dir="$stage_dir/$ROOT_NAME"
  local step_start=$SECONDS

  echo "🔨 构建后端生产运行产物 ..."
  pnpm run build:api
  pnpm run build:agent-runtime

  echo "📦 打包后端生产运行包 v${VERSION} ..."
  mkdir -p "$app_dir/apps/api" "$app_dir/apps/agent-runtime" "$app_dir/packages/contracts"
  cp package.json pnpm-workspace.yaml "$app_dir/"
  # npm reads overrides only from its root manifest, not pnpm-workspace.yaml.
  rewrite_runtime_package_for_npm "$app_dir/package.json" "$(pnpm config get overrides --json)"
  if [ -f pnpm-lock.yaml ]; then
    cp pnpm-lock.yaml "$app_dir/pnpm-lock.yaml"
  fi
  cp -R patches "$app_dir/patches"
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
  rewrite_runtime_package_for_npm "$app_dir/apps/agent-runtime/package.json"
  cp -R apps/agent-runtime/dist "$app_dir/apps/agent-runtime/dist"
  cp packages/contracts/package.json "$app_dir/packages/contracts/package.json"
  # Contracts package exports resolve to compiled dist modules at runtime.
  cp -R packages/contracts/dist "$app_dir/packages/contracts/dist"
  find "$app_dir/apps/api/dist" "$app_dir/apps/agent-runtime/dist" \
    \( -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) \
    -delete

  node scripts/write-release-notices.mjs backend "$app_dir"
  tar czf "$tmp_out" -C "$stage_dir" "$ROOT_NAME"
  mv "$tmp_out" "$outfile"
  report_archive "$outfile" "$step_start"
}

pack_www_static() {
  local outfile="${1:-fateclaw-www-v${VERSION}-static.tar.gz}"
  local tmp_out="$WORK_DIR/www-static.tar.gz"
  local step_start=$SECONDS

  echo "🔨 构建 www 静态产物 ..."
  rm -rf apps/web/.next apps/web/out
  pnpm --filter fateclaw-web run build

  node scripts/write-release-notices.mjs www apps/web/out
  echo "📦 打包 www 静态产物 v${VERSION} ..."
  tar czf "$tmp_out" -C apps/web/out .

  mv "$tmp_out" "$outfile"
  report_archive "$outfile" "$step_start"
}

pack_admin_static() {
  local outfile="${1:-fateclaw-admin-v${VERSION}-static.tar.gz}"
  local tmp_out="$WORK_DIR/admin-static.tar.gz"
  local step_start=$SECONDS

  echo "🔨 构建 admin 静态产物 ..."
  rm -rf apps/admin/.next apps/admin/out
  pnpm --filter fateclaw-admin run build

  node scripts/write-release-notices.mjs admin apps/admin/out
  echo "📦 打包 admin 静态产物 v${VERSION} ..."
  tar czf "$tmp_out" -C apps/admin/out .

  mv "$tmp_out" "$outfile"
  report_archive "$outfile" "$step_start"
}

case "$MODE" in
  all|www|admin)
    load_frontend_public_env
    ;;
esac

case "$MODE" in
  backend|api|backend-source|api-source|source)
    ;;
  *)
    echo "🔨 构建共享 contracts ..."
    if pnpm run build:contracts > "$WORK_DIR/contracts.log" 2>&1; then
      :
    else
      status=$?
      cat "$WORK_DIR/contracts.log" >&2
      exit "$status"
    fi
    ;;
esac

case "$MODE" in
  all)
    run_pack_job "后端运行包" pack_backend_runtime
    run_pack_job "www 静态包" pack_www_static
    run_pack_job "admin 静态包" pack_admin_static
    ;;
  backend-runtime|api-runtime)
    run_pack_job "后端运行包" pack_backend_runtime "${OUTFILE:-}"
    ;;
  backend|api|backend-source|api-source)
    run_pack_job "后端源码包" pack_backend_source "${OUTFILE:-}"
    ;;
  www)
    run_pack_job "www 静态包" pack_www_static "${OUTFILE:-}"
    ;;
  admin)
    run_pack_job "admin 静态包" pack_admin_static "${OUTFILE:-}"
    ;;
  source)
    run_pack_job "后端源码包" pack_backend_source "${OUTFILE:-fateclaw-v${VERSION}-source.tar.gz}"
    ;;
esac

while [ "$ACTIVE_JOBS" -gt 0 ]; do
  wait_pack_job
done

echo "⏱ 总耗时: $((SECONDS - SCRIPT_START))s"
