#!/usr/bin/env bash
# 示例：函数、数组与条件判断。
set -euo pipefail

say() {
  local message="$1"
  echo "[$(date +%H:%M:%S)] ${message}"
}

names=("Alice" "Bob" "Cara")

for name in "${names[@]}"; do
  if [[ "${name}" == B* ]]; then
    say "跳过：${name}"
    continue
  fi
  say "问候：${name}"
done
