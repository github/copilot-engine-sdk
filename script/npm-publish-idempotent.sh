#!/usr/bin/env bash
# Copyright (c) GitHub, Inc.
# Licensed under the MIT License.
#
# npm-publish-idempotent.sh
#
# Wraps `npm publish` so the publish job can be safely retried. If the version
# being published already exists on the registry, npm fails with a
# "cannot publish over the previously published versions" error. This script
# treats that specific error as success (exit 0) so a re-run of the publish
# workflow does not fail on packages that were already published, while still
# surfacing any other publish failure.
#
# Publishing is destructive, so the script is safe by default: it only
# publishes when explicitly opted in with `--run` (or `RUN=true`). Without it
# the script just prints the command it would run and exits without touching
# the registry.

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: npm-publish-idempotent.sh [--run] [npm publish args...]

Wraps `npm publish` so a publish job can be safely retried: if the version is
already published, the registry's "cannot publish over the previously
published versions" error is treated as success (exit 0). Any other failure is
propagated as a non-zero exit code. npm output is streamed to the log in real
time while still being captured for the conflict check.

Flags:
  --run        Actually publish. Without it (and without RUN=true) the script
               does not publish: it only prints the command it would run, so it
               is safe to run locally.
  -h, --help   Show this help.

Environment:
  RUN=true     Equivalent to passing --run.

Examples:
  # Preview only (no publish):
  npm-publish-idempotent.sh --tag latest --access public

  # Real publish:
  npm-publish-idempotent.sh --run --tag latest --access public \
    --registry https://registry.npmjs.org
EOF
}

RUN="${RUN:-false}"
args=()
for arg in "$@"; do
    case "$arg" in
        -h | --help)
            usage
            exit 0
            ;;
        --run)
            RUN=true
            ;;
        *)
            args+=("$arg")
            ;;
    esac
done

if [ "$RUN" != "true" ]; then
    echo "[skipped] Not publishing. Would run: npm publish ${args[*]:-}"
    echo "[skipped] Pass --run (or set RUN=true) to actually publish."
    exit 0
fi

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

# Stream npm output to the log in real time while capturing it for the
# conflict check below. Disable errexit around the pipeline so the script can
# inspect each stage's exit code instead of aborting on failure.
set +e
npm publish ${args[@]+"${args[@]}"} 2>&1 | tee "$tmpfile"
pipestatus=("${PIPESTATUS[@]}")
set -e
status=${pipestatus[0]}
tee_status=${pipestatus[1]}

# If the capture step failed we cannot reliably detect an "already published"
# conflict, so fail loudly rather than risk masking a real publish error.
if [ "$tee_status" -ne 0 ]; then
    echo "::error::Failed to capture npm publish output (tee exited ${tee_status})" >&2
    exit 1
fi

if [ "$status" -eq 0 ]; then
    exit 0
fi

# Registries report immutable-version conflicts with different messages.
# Match known signatures case-insensitively while preserving unrelated failures.
if grep -qiE "cannot publish over the previously published versions|previously published version|EPUBLISHCONFLICT|already contains file '[^']+\.tgz' in package '[^']+'" "$tmpfile"; then
    echo "Version already published; treating as success (idempotent retry)."
    exit 0
fi

exit "$status"
