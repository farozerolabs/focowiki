#!/bin/sh
set -eu
umask 077

log_dir="${LOG_FILE_DIR:-logs}"
runtime_secret_dir="/app/runtime-secrets"

case "${log_dir}" in
  /*)
    resolved_log_dir="${log_dir}"
    ;;
  *)
    resolved_log_dir="/app/${log_dir}"
    ;;
esac

mkdir -p "${resolved_log_dir}" "${runtime_secret_dir}"
chown -R node:node "${resolved_log_dir}" "${runtime_secret_dir}"
chmod 700 "${runtime_secret_dir}"

exec gosu node:node "$@"
