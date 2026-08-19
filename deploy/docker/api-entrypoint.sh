#!/bin/sh
set -eu

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

mkdir -p "${resolved_log_dir}"
chown -R node:node "${resolved_log_dir}"

mkdir -p "${runtime_secret_dir}"
chown -R node:node "${runtime_secret_dir}"
chmod 700 "${runtime_secret_dir}"

if [ -n "${OPENSEARCH_SECURITY_DIR:-}" ]; then
  mkdir -p "${OPENSEARCH_SECURITY_DIR}"
  chown -R node:node "${OPENSEARCH_SECURITY_DIR}"
  chmod 700 "${OPENSEARCH_SECURITY_DIR}"
fi

if [ -n "${OPENSEARCH_DATA_DIR:-}" ]; then
  mkdir -p "${OPENSEARCH_DATA_DIR}"
  node_owner="$(id -u node):$(id -g node)"
  data_owner="$(stat -c "%u:%g" "${OPENSEARCH_DATA_DIR}")"
  if [ "${data_owner}" != "${node_owner}" ]; then
    chown -R node:node "${OPENSEARCH_DATA_DIR}"
  fi
  chmod 700 "${OPENSEARCH_DATA_DIR}"
fi

exec gosu node:node "$@"
