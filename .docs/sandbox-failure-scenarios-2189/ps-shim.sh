#!/bin/sh
# 映像沒有 procps：回 `ps -A -o command=` 的形狀，讀 /proc。
for p in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$p" 2>/dev/null; echo; done
