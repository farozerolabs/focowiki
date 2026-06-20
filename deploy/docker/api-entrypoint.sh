#!/bin/sh
set -eu

log_dir="${LOG_FILE_DIR:-logs}"

case "${log_dir}" in
  /*)
    resolved_log_dir="${log_dir}"
    ;;
  *)
    resolved_log_dir="/app/${log_dir}"
    ;;
esac

mkdir -p "${resolved_log_dir}"
chown -R node:node "${resolved_log_dir}"

exec su-exec node:node "$@"
