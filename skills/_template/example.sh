#!/usr/bin/env bash
# Skill 脚本示例
#
# 可用环境变量:
#   SKILL_NAME           — 当前 skill 名称
#   SKILL_DIR            — 当前 skill 目录路径
#   FATECLAW_ACCOUNT_ID   — 微信账号 ID
#   FATECLAW_USER_ID      — 用户 ID（用于 API 鉴权）
#   FATECLAW_TIMEZONE     — 用户时区
#
# stdin: AI 传入的数据
# stdout: 返回给 AI 的结果（会被截断到 10000 字符）
# 超时: 30 秒

echo "Hello from ${SKILL_NAME}!"
