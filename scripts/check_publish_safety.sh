#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "error: not in a git repository" >&2
  exit 2
fi
cd "${ROOT}"

fail=0

echo "==> checking tracked file paths for private artifacts"
bad_paths=()
while IFS= read -r file; do
  case "${file}" in
    .env.example)
      continue
      ;;
  esac

  if [[ "${file}" =~ (^|/)\.env($|\.) ]] \
    || [[ "${file}" =~ (^|/)(data|memory)/ ]] \
    || [[ "${file}" == "MEMORY.md" ]] \
    || [[ "${file}" =~ \.(db|sqlite|sqlite3)$ ]] \
    || [[ "${file}" =~ (^|/)(id_rsa|id_ed25519)(\.pub)?$ ]] \
    || [[ "${file}" =~ \.(pem|key|p12|pfx)$ ]]; then
    bad_paths+=("${file}")
  fi
done < <(git ls-files)

if (( ${#bad_paths[@]} > 0 )); then
  fail=1
  printf '%s\n' "error: private/sensitive file paths are tracked:"
  printf '  - %s\n' "${bad_paths[@]}"
fi

echo "==> checking tracked content for high-confidence secrets"
secret_regex='(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----)'
secret_hits="$(git grep -n -I -E "${secret_regex}" -- . ':!*.md' ':!*.lock' ':!*.svg' || true)"
if [[ -n "${secret_hits}" ]]; then
  fail=1
  echo "error: potential secret literals found in tracked content:"
  printf '%s\n' "${secret_hits}"
fi

echo "==> checking tracked content for local absolute paths"
user_name="${USER:-$(id -un 2>/dev/null || true)}"
if [[ -n "${user_name}" && ${#user_name} -ge 3 ]]; then
  escaped_user="$(printf '%s' "${user_name}" | sed -E 's/[][(){}.^$*+?|\\/]/\\&/g')"
  local_path_hits="$(git grep -n -I -i -E "(/Users/${escaped_user}|/home/${escaped_user}|\\\\Users\\\\${escaped_user})" -- . || true)"
  if [[ -n "${local_path_hits}" ]]; then
    fail=1
    echo "error: local user path references found in tracked content:"
    printf '%s\n' "${local_path_hits}"
  fi
fi

if [[ -n "${PRIVACY_NAME_REGEX:-}" ]]; then
  echo "==> checking tracked content for PRIVACY_NAME_REGEX matches"
  name_hits="$(git grep -n -I -i -E "${PRIVACY_NAME_REGEX}" -- . || true)"
  if [[ -n "${name_hits}" ]]; then
    fail=1
    echo "error: PRIVACY_NAME_REGEX matched tracked content:"
    printf '%s\n' "${name_hits}"
  fi
fi

if (( fail != 0 )); then
  echo
  echo "publish-safety check failed."
  exit 1
fi

echo "publish-safety check passed."
