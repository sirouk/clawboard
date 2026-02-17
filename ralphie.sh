#!/usr/bin/env bash
#
# Ralphie - Unified autonomous loop for Codex and Claude Code.
# One script handles first-run setup, prompt generation, and iterative execution.
#

# Stream bootstrap:
# When executed via stdin (for example: curl ... | bash), persist the script into
# the current directory and re-exec from disk so relative paths work consistently.
if [ "${RALPHIE_LIB:-0}" != "1" ] && [ -z "${BASH_SOURCE[0]:-}" ]; then
    rb_target_script="$(pwd)/ralphie.sh"
    rb_tmp_script="${rb_target_script}.tmp.$$"
    if {
        printf '%s\n' '#!/usr/bin/env bash'
        printf '%s\n' '#'
        printf '%s\n' '# Ralphie - Unified autonomous loop for Codex and Claude Code.'
        printf '%s\n' '# Installed from stdin stream.'
        printf '%s\n' '#'
        cat
    } > "$rb_tmp_script"; then
        chmod +x "$rb_tmp_script" 2>/dev/null || true
        mv "$rb_tmp_script" "$rb_target_script"
        echo "Installed ralphie.sh to $rb_target_script"
        exec env RALPHIE_SKIP_AUTO_UPDATE=1 "$rb_target_script" "$@"
    else
        echo "Failed to persist streamed ralphie.sh to $rb_target_script" >&2
        rm -f "$rb_tmp_script"
        exit 1
    fi
fi

set -euo pipefail

SCRIPT_VERSION="2.0.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

CONFIG_DIR="$PROJECT_DIR/.ralphie"
CONFIG_FILE="$CONFIG_DIR/config.env"
LOCK_FILE="$CONFIG_DIR/run.lock"
REASON_LOG_FILE="$CONFIG_DIR/reasons.log"
GATE_FEEDBACK_FILE="$CONFIG_DIR/last_gate_feedback.md"
STATE_FILE="$CONFIG_DIR/state.env"
DEFAULT_AUTO_UPDATE_URL="https://raw.githubusercontent.com/sirouk/ralphie/refs/heads/master/ralphie.sh"

SPECIFY_DIR="$PROJECT_DIR/.specify/memory"
CONSTITUTION_FILE="$SPECIFY_DIR/constitution.md"
SPECS_DIR="$PROJECT_DIR/specs"
RESEARCH_DIR="$PROJECT_DIR/research"
RESEARCH_SUMMARY_FILE="$RESEARCH_DIR/RESEARCH_SUMMARY.md"
STACK_SNAPSHOT_FILE="$RESEARCH_DIR/STACK_SNAPSHOT.md"
CONSENSUS_DIR="$PROJECT_DIR/consensus"
LOG_DIR="$PROJECT_DIR/logs"
COMPLETION_LOG_DIR="$PROJECT_DIR/completion_log"
MAPS_DIR="$PROJECT_DIR/maps"
SUBREPOS_DIR_REL="subrepos"
AGENT_SOURCE_MAP_REL="maps/agent-source-map.yaml"
BINARY_STEERING_MAP_REL="maps/binary-steering-map.yaml"
SELF_IMPROVEMENT_LOG_REL="research/SELF_IMPROVEMENT_LOG.md"
SUBREPOS_DIR="$PROJECT_DIR/$SUBREPOS_DIR_REL"
AGENT_SOURCE_MAP_FILE="$PROJECT_DIR/$AGENT_SOURCE_MAP_REL"
BINARY_STEERING_MAP_FILE="$PROJECT_DIR/$BINARY_STEERING_MAP_REL"
SELF_IMPROVEMENT_LOG_FILE="$PROJECT_DIR/$SELF_IMPROVEMENT_LOG_REL"
READY_ARCHIVE_DIR="$CONFIG_DIR/ready-archives"
SETUP_SUBREPOS_SCRIPT="$PROJECT_DIR/engines/setup-agent-subrepos.sh"

PROMPT_BUILD_FILE="$PROJECT_DIR/PROMPT_build.md"
PROMPT_PLAN_FILE="$PROJECT_DIR/PROMPT_plan.md"
PROMPT_TEST_FILE="$PROJECT_DIR/PROMPT_test.md"
PROMPT_REFACTOR_FILE="$PROJECT_DIR/PROMPT_refactor.md"
PROMPT_LINT_FILE="$PROJECT_DIR/PROMPT_lint.md"
PROMPT_DOCUMENT_FILE="$PROJECT_DIR/PROMPT_document.md"
PLAN_FILE="$PROJECT_DIR/IMPLEMENTATION_PLAN.md"
PROJECT_BOOTSTRAP_FILE="$CONFIG_DIR/project-bootstrap.md"

# Shared logic for interactive questions and formatting.
err() { echo -e "\033[1;31m$*\033[0m" >&2; }
warn() { echo -e "\033[1;33m$*\033[0m" >&2; }
info() { echo -e "\033[0;34m$*\033[0m"; }
success() { echo -e "\033[0;32m$*\033[0m"; }
ok() { success "$@"; }

# Logging reasons for failures (doctrinal/state/inference)
log_reason_code() {
    local code="$1"
    local msg="$2"
    mkdir -p "$(dirname "$REASON_LOG_FILE")"
    echo "reason_code=$code message=\"$msg\"" >> "$REASON_LOG_FILE"
}

path_for_display() {
    local p="${1:-}"
    [ -z "$p" ] && echo "unknown" && return 0
    echo "${p#./}"
}

# Boolean helper
is_true() {
    case "${1:-}" in
        1|[Yy]|[Yy][Ee][Ss]|[Tt][Rr][Uu][Ee]|ON|on) return 0 ;;
        *) return 1 ;;
    esac
}

is_bool_like() {
    case "${1:-}" in
        true|TRUE|True|false|FALSE|False|1|0|yes|YES|no|NO|on|ON|off|OFF|y|Y|n|N) return 0 ;;
        *) return 1 ;;
    esac
}

is_number() {
    [[ "$1" =~ ^[0-9]+$ ]]
}

extract_xml_value() {
    local file="$1"
    local tag="$2"
    local default="${3:-}"
    local value=""

    [ -f "$file" ] || { echo "$default"; return 0; }

    value="$(grep -oE "<${tag}>[^<]*</${tag}>" "$file" 2>/dev/null | tail -n 1 | sed -E "s#</?${tag}>##g")"
    value="$(printf '%s' "$value" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | sed 's/^ *//; s/ *$//')"
    if [ -z "$value" ]; then
        echo "$default"
        return 0
    fi
    echo "$value"
}

is_phase_or_done() {
    case "$1" in
        plan|build|test|refactor|lint|document|done) return 0 ;;
        *) return 1 ;;
    esac
}

normalize_phase_name() {
    local phase="${1:-}"
    phase="$(to_lower "$phase")"
    case "$phase" in
        plan) phase="plan" ;;
        build) phase="build" ;;
        test) phase="test" ;;
        refactor) phase="refactor" ;;
        lint) phase="lint" ;;
        document) phase="document" ;;
        done) phase="done" ;;
        *)
            warn "Unrecognized phase name '$phase', defaulting to 'plan'"
            phase="plan"
            ;;
    esac
    echo "$phase"
}

normalize_next_phase_recommendation() {
    local candidate="${1:-}"
    local current_phase="${2:-}"
    local fallback="${3:-done}"

    candidate="$(to_lower "$candidate")"
    current_phase="$(normalize_phase_name "$current_phase")"

    case "$candidate" in
        plan|build|test|refactor|lint|document|done) echo "$candidate" ; return 0 ;;
        next|forward|proceed|continue) echo "$fallback" ; return 0 ;;
        same|retry|retry_current|hold|stay) echo "$current_phase" ; return 0 ;;
        complete|completed|finished|finish|success|goal) echo "done" ; return 0 ;;
        stop|abort|halt) echo "done" ; return 0 ;;
        *)
            echo "$fallback"
            return 1
            ;;
    esac
}

print_array_lines() {
    local -a lines=("$@")
    local line

    [ "${#lines[@]}" -eq 0 ] && return 0
    [ "${#lines[@]}" -eq 1 ] && [ -z "${lines[0]}" ] && return 0
    for line in "${lines[@]}"; do
        printf '%s\n' "$line"
    done
}

# Compatibility layer for environments that still run Bash 3.x (for example, macOS
# default Bash), which lack the `mapfile` builtin used throughout this script.
if ! command -v mapfile >/dev/null 2>&1; then
    mapfile() {
        if [[ "${1:-}" == -t ]]; then
            shift
        fi

        local var_name="${1:-MAPFILE}"
        if [ -z "$var_name" ]; then
            return 1
        fi

        # Safer alternative to eval: use nameref if available (Bash 4.3+),
        # otherwise fall back to a temp file approach
        local __mapfile_idx=0
        local __mapfile_line
        # Reset the target array
        eval "${var_name}=()"

        while IFS= read -r __mapfile_line || [ -n "$__mapfile_line" ]; do
            # Use printf %q for safe escaping of arbitrary content
            printf -v __mapfile_escaped '%q' "$__mapfile_line" 2>/dev/null || __mapfile_escaped="$__mapfile_line"
            eval "${var_name}[${__mapfile_idx}]=${__mapfile_escaped}"
            __mapfile_idx=$((__mapfile_idx + 1))
        done

        return 0
    }
fi

is_phase_noop_policy() {
    case "${1:-}" in
        hard|soft|none) return 0 ;;
        *) return 1 ;;
    esac
}

normalize_phase_noop_policy() {
    local policy="${1:-none}"
    case "$policy" in
        hard|soft|none) echo "$policy" ;;
        *) echo "none" ;;
    esac
}

to_lower() {
    echo "$1" | tr '[:upper:]' '[:lower:]'
}

normalize_phase_noop_profile() {
    local profile="${1:-balanced}"
    case "$profile" in
        strict|balanced|custom) ;;
        read-only-first|read_only_first|readonly)
            profile="read-only-first"
            ;;
        *) profile="custom" ;;
    esac
    echo "$profile"
}

is_phase_noop_profile() {
    case "${1:-}" in
        strict|balanced|read-only-first|read_only_first|readonly|custom) return 0 ;;
        *) return 1 ;;
    esac
}

apply_phase_noop_profile() {
    local profile
    profile="$(normalize_phase_noop_profile "$PHASE_NOOP_PROFILE")"
    PHASE_NOOP_PROFILE="$profile"

    case "$profile" in
        strict)
            [ "$PHASE_NOOP_POLICY_PLAN_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_PLAN="none"
            [ "$PHASE_NOOP_POLICY_BUILD_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_BUILD="hard"
            [ "$PHASE_NOOP_POLICY_TEST_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_TEST="hard"
            [ "$PHASE_NOOP_POLICY_REFACTOR_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_REFACTOR="hard"
            [ "$PHASE_NOOP_POLICY_LINT_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_LINT="hard"
            [ "$PHASE_NOOP_POLICY_DOCUMENT_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_DOCUMENT="hard"
            ;;
        read-only-first|read_only_first|readonly)
            [ "$PHASE_NOOP_POLICY_PLAN_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_PLAN="none"
            [ "$PHASE_NOOP_POLICY_BUILD_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_BUILD="hard"
            [ "$PHASE_NOOP_POLICY_TEST_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_TEST="soft"
            [ "$PHASE_NOOP_POLICY_REFACTOR_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_REFACTOR="none"
            [ "$PHASE_NOOP_POLICY_LINT_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_LINT="soft"
            [ "$PHASE_NOOP_POLICY_DOCUMENT_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_DOCUMENT="none"
            ;;
        balanced|custom|"")
            [ "$PHASE_NOOP_POLICY_PLAN_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_PLAN="none"
            [ "$PHASE_NOOP_POLICY_BUILD_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_BUILD="hard"
            [ "$PHASE_NOOP_POLICY_TEST_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_TEST="soft"
            [ "$PHASE_NOOP_POLICY_REFACTOR_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_REFACTOR="hard"
            [ "$PHASE_NOOP_POLICY_LINT_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_LINT="soft"
            [ "$PHASE_NOOP_POLICY_DOCUMENT_EXPLICIT" != "true" ] && PHASE_NOOP_POLICY_DOCUMENT="hard"
            ;;
        *)
            :
            ;;
    esac

    PHASE_NOOP_POLICY_PLAN="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_PLAN")"
    PHASE_NOOP_POLICY_BUILD="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_BUILD")"
    PHASE_NOOP_POLICY_TEST="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_TEST")"
    PHASE_NOOP_POLICY_REFACTOR="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_REFACTOR")"
    PHASE_NOOP_POLICY_LINT="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_LINT")"
    PHASE_NOOP_POLICY_DOCUMENT="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_DOCUMENT")"
}

finalize_phase_noop_profile_config() {
    PHASE_NOOP_PROFILE="${PHASE_NOOP_PROFILE:-$DEFAULT_PHASE_NOOP_PROFILE}"
    PHASE_NOOP_POLICY_PLAN="${PHASE_NOOP_POLICY_PLAN:-$DEFAULT_PHASE_NOOP_POLICY_PLAN}"
    PHASE_NOOP_POLICY_BUILD="${PHASE_NOOP_POLICY_BUILD:-$DEFAULT_PHASE_NOOP_POLICY_BUILD}"
    PHASE_NOOP_POLICY_TEST="${PHASE_NOOP_POLICY_TEST:-$DEFAULT_PHASE_NOOP_POLICY_TEST}"
    PHASE_NOOP_POLICY_REFACTOR="${PHASE_NOOP_POLICY_REFACTOR:-$DEFAULT_PHASE_NOOP_POLICY_REFACTOR}"
    PHASE_NOOP_POLICY_LINT="${PHASE_NOOP_POLICY_LINT:-$DEFAULT_PHASE_NOOP_POLICY_LINT}"
    PHASE_NOOP_POLICY_DOCUMENT="${PHASE_NOOP_POLICY_DOCUMENT:-$DEFAULT_PHASE_NOOP_POLICY_DOCUMENT}"

    PHASE_NOOP_PROFILE="$(to_lower "$PHASE_NOOP_PROFILE")"
    if ! is_phase_noop_profile "$PHASE_NOOP_PROFILE"; then
        PHASE_NOOP_PROFILE="$DEFAULT_PHASE_NOOP_PROFILE"
    fi
    PHASE_NOOP_PROFILE="$(normalize_phase_noop_profile "$PHASE_NOOP_PROFILE")"
    PHASE_NOOP_POLICY_PLAN="$(normalize_phase_noop_policy "$(to_lower "$PHASE_NOOP_POLICY_PLAN")")"
    PHASE_NOOP_POLICY_BUILD="$(normalize_phase_noop_policy "$(to_lower "$PHASE_NOOP_POLICY_BUILD")")"
    PHASE_NOOP_POLICY_TEST="$(normalize_phase_noop_policy "$(to_lower "$PHASE_NOOP_POLICY_TEST")")"
    PHASE_NOOP_POLICY_REFACTOR="$(normalize_phase_noop_policy "$(to_lower "$PHASE_NOOP_POLICY_REFACTOR")")"
    PHASE_NOOP_POLICY_LINT="$(normalize_phase_noop_policy "$(to_lower "$PHASE_NOOP_POLICY_LINT")")"
    PHASE_NOOP_POLICY_DOCUMENT="$(normalize_phase_noop_policy "$(to_lower "$PHASE_NOOP_POLICY_DOCUMENT")")"

    apply_phase_noop_profile

    if is_true "$STRICT_VALIDATION_NOOP"; then
        PHASE_NOOP_POLICY_TEST="hard"
        PHASE_NOOP_POLICY_LINT="hard"
    fi

    PHASE_NOOP_POLICY_PLAN="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_PLAN")"
    PHASE_NOOP_POLICY_BUILD="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_BUILD")"
    PHASE_NOOP_POLICY_TEST="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_TEST")"
    PHASE_NOOP_POLICY_REFACTOR="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_REFACTOR")"
    PHASE_NOOP_POLICY_LINT="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_LINT")"
    PHASE_NOOP_POLICY_DOCUMENT="$(normalize_phase_noop_policy "$PHASE_NOOP_POLICY_DOCUMENT")"
    PHASE_NOOP_PROFILE="$(normalize_phase_noop_profile "$PHASE_NOOP_PROFILE")"
}

print_usage() {
    cat <<'EOF'
Usage: ./ralphie.sh [options]

Core options:
  --resume                               Resume from previous persisted session state (default: true)
  --no-resume                            Force fresh start; ignore persisted state
  --rebootstrap                          Rebuild project bootstrap context (project type/objective/build consent)
  --max-session-cycles N                 Max total inference attempts in this session (0 = unlimited)
  --session-token-budget N                Max session token budget (0 = unlimited)
  --session-token-rate-cents-per-million N  Cost rate in cents per million tokens
  --session-cost-budget-cents N           Max estimated cost budget in cents (0 = unlimited)
  --max-phase-completion-attempts N       Max completion-signal retries per phase
  --phase-completion-retry-delay-seconds N Delay in seconds between completion retries
  --phase-completion-retry-verbose bool   Verbose phase completion retry logging (true|false)
  --max-consensus-routing-attempts N      Max adaptive consensus reroutes per run (0=unlimited)
  --run-agent-max-attempts N              Max inference retries per agent run
  --run-agent-retry-delay-seconds N       Delay in seconds between inference retries
  --run-agent-retry-verbose bool          Verbose inference retry logging (true|false)
  --engine-output-to-stdout bool          Show or suppress live engine output stream (true|false)
  --auto-repair-markdown-artifacts bool    Auto-sanitize markdown artifacts when gate-blocked (true|false)
  --strict-validation-noop bool           Require worktree mutation for test/lint phases too (true|false)
  --phase-noop-profile strict|balanced|read-only-first|custom
  --phase-noop-policy-plan hard|soft|none  Phase worktree mutation policy for plan
  --phase-noop-policy-build hard|soft|none Phase worktree mutation policy for build
  --phase-noop-policy-test hard|soft|none  Phase worktree mutation policy for test
  --phase-noop-policy-refactor hard|soft|none Phase worktree mutation policy for refactor
  --phase-noop-policy-lint hard|soft|none  Phase worktree mutation policy for lint
  --phase-noop-policy-document hard|soft|none  Phase worktree mutation policy for document
  --help, -h                             Show this help and exit

All options may also be set through config.env (eg. SESSION_TOKEN_BUDGET, MAX_SESSION_CYCLES, etc).
EOF
}

require_non_negative_int() {
    local name="$1"
    local value="$2"
    if ! is_number "$value"; then
        err "Invalid numeric value for $name: $value"
        exit 1
    fi
    if [ "$value" -lt 0 ]; then
        err "Negative values are not supported for $name: $value"
        exit 1
    fi
}

parse_arg_value() {
    local arg_name="$1"
    local arg_value="$2"
    if [ -z "$arg_value" ] || [[ "$arg_value" == --* ]]; then
        err "Missing value for $arg_name"
        exit 1
    fi
    echo "$arg_value"
}

parse_args() {
    while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h)
            print_usage
            exit 0
            ;;
            --resume)
                RESUME_REQUESTED=true
                shift
                ;;
        --no-resume)
            RESUME_REQUESTED=false
            shift
            ;;
        --rebootstrap)
            REBOOTSTRAP_REQUESTED=true
            shift
            ;;
        --max-session-cycles)
            MAX_SESSION_CYCLES="$(parse_arg_value "--max-session-cycles" "${2:-}")"
                require_non_negative_int "MAX_SESSION_CYCLES" "$MAX_SESSION_CYCLES"
                shift 2
                ;;
            --session-token-budget)
                SESSION_TOKEN_BUDGET="$(parse_arg_value "--session-token-budget" "${2:-}")"
                require_non_negative_int "SESSION_TOKEN_BUDGET" "$SESSION_TOKEN_BUDGET"
                shift 2
                ;;
            --session-token-rate-cents-per-million)
                SESSION_TOKEN_RATE_CENTS_PER_MILLION="$(parse_arg_value "--session-token-rate-cents-per-million" "${2:-}")"
                require_non_negative_int "SESSION_TOKEN_RATE_CENTS_PER_MILLION" "$SESSION_TOKEN_RATE_CENTS_PER_MILLION"
                shift 2
                ;;
            --session-cost-budget-cents)
                SESSION_COST_BUDGET_CENTS="$(parse_arg_value "--session-cost-budget-cents" "${2:-}")"
                require_non_negative_int "SESSION_COST_BUDGET_CENTS" "$SESSION_COST_BUDGET_CENTS"
                shift 2
                ;;
            --max-phase-completion-attempts)
                PHASE_COMPLETION_MAX_ATTEMPTS="$(parse_arg_value "--max-phase-completion-attempts" "${2:-}")"
                require_non_negative_int "PHASE_COMPLETION_MAX_ATTEMPTS" "$PHASE_COMPLETION_MAX_ATTEMPTS"
                if [ "$PHASE_COMPLETION_MAX_ATTEMPTS" -eq 0 ]; then
                    PHASE_COMPLETION_MAX_ATTEMPTS=1
                fi
                shift 2
                ;;
            --phase-completion-retry-delay-seconds)
                PHASE_COMPLETION_RETRY_DELAY_SECONDS="$(parse_arg_value "--phase-completion-retry-delay-seconds" "${2:-}")"
                require_non_negative_int "PHASE_COMPLETION_RETRY_DELAY_SECONDS" "$PHASE_COMPLETION_RETRY_DELAY_SECONDS"
                shift 2
                ;;
            --phase-completion-retry-verbose)
                PHASE_COMPLETION_RETRY_VERBOSE="$(parse_arg_value "--phase-completion-retry-verbose" "${2:-}")"
                if ! is_bool_like "$PHASE_COMPLETION_RETRY_VERBOSE"; then
                    err "Invalid boolean value for --phase-completion-retry-verbose: $PHASE_COMPLETION_RETRY_VERBOSE"
                    exit 1
                fi
                shift 2
                ;;
            --max-consensus-routing-attempts)
                MAX_CONSENSUS_ROUTING_ATTEMPTS="$(parse_arg_value "--max-consensus-routing-attempts" "${2:-}")"
                require_non_negative_int "MAX_CONSENSUS_ROUTING_ATTEMPTS" "$MAX_CONSENSUS_ROUTING_ATTEMPTS"
                shift 2
                ;;
            --run-agent-max-attempts)
                RUN_AGENT_MAX_ATTEMPTS="$(parse_arg_value "--run-agent-max-attempts" "${2:-}")"
                require_non_negative_int "RUN_AGENT_MAX_ATTEMPTS" "$RUN_AGENT_MAX_ATTEMPTS"
                shift 2
                ;;
            --run-agent-retry-delay-seconds)
                RUN_AGENT_RETRY_DELAY_SECONDS="$(parse_arg_value "--run-agent-retry-delay-seconds" "${2:-}")"
                require_non_negative_int "RUN_AGENT_RETRY_DELAY_SECONDS" "$RUN_AGENT_RETRY_DELAY_SECONDS"
                shift 2
                ;;
            --run-agent-retry-verbose)
                RUN_AGENT_RETRY_VERBOSE="$(parse_arg_value "--run-agent-retry-verbose" "${2:-}")"
                if ! is_bool_like "$RUN_AGENT_RETRY_VERBOSE"; then
                    err "Invalid boolean value for --run-agent-retry-verbose: $RUN_AGENT_RETRY_VERBOSE"
                    exit 1
                fi
                shift 2
                ;;
            --engine-output-to-stdout)
                ENGINE_OUTPUT_TO_STDOUT="$(parse_arg_value "--engine-output-to-stdout" "${2:-}")"
                if ! is_bool_like "$ENGINE_OUTPUT_TO_STDOUT"; then
                    err "Invalid boolean value for --engine-output-to-stdout: $ENGINE_OUTPUT_TO_STDOUT"
                    exit 1
                fi
                ENGINE_OUTPUT_TO_STDOUT_EXPLICIT="true"
                ENGINE_OUTPUT_TO_STDOUT_OVERRIDE="$ENGINE_OUTPUT_TO_STDOUT"
                shift 2
                ;;
            --auto-repair-markdown-artifacts)
                AUTO_REPAIR_MARKDOWN_ARTIFACTS="$(parse_arg_value "--auto-repair-markdown-artifacts" "${2:-}")"
                if ! is_bool_like "$AUTO_REPAIR_MARKDOWN_ARTIFACTS"; then
                    err "Invalid boolean value for --auto-repair-markdown-artifacts: $AUTO_REPAIR_MARKDOWN_ARTIFACTS"
                    exit 1
                fi
                shift 2
                ;;
            --strict-validation-noop)
                STRICT_VALIDATION_NOOP="$(parse_arg_value "--strict-validation-noop" "${2:-}")"
                if ! is_bool_like "$STRICT_VALIDATION_NOOP"; then
                    err "Invalid boolean value for --strict-validation-noop: $STRICT_VALIDATION_NOOP"
                    exit 1
                fi
                shift 2
                ;;
            --phase-noop-profile)
                local profile_candidate
                profile_candidate="$(to_lower "$(parse_arg_value "--phase-noop-profile" "${2:-}")")"
                if ! is_phase_noop_profile "$profile_candidate"; then
                    err "Invalid phase noop profile: $profile_candidate"
                    exit 1
                fi
                PHASE_NOOP_PROFILE="$(normalize_phase_noop_profile "$profile_candidate")"
                PHASE_NOOP_PROFILE_EXPLICIT=true
                shift 2
                ;;
            --phase-noop-policy-plan)
                PHASE_NOOP_POLICY_PLAN="$(to_lower "$(parse_arg_value "--phase-noop-policy-plan" "${2:-}")")"
                if ! is_phase_noop_policy "$PHASE_NOOP_POLICY_PLAN"; then
                    err "Invalid policy for --phase-noop-policy-plan: $PHASE_NOOP_POLICY_PLAN"
                    exit 1
                fi
                PHASE_NOOP_POLICY_PLAN_EXPLICIT=true
                shift 2
                ;;
            --phase-noop-policy-build)
                PHASE_NOOP_POLICY_BUILD="$(to_lower "$(parse_arg_value "--phase-noop-policy-build" "${2:-}")")"
                if ! is_phase_noop_policy "$PHASE_NOOP_POLICY_BUILD"; then
                    err "Invalid policy for --phase-noop-policy-build: $PHASE_NOOP_POLICY_BUILD"
                    exit 1
                fi
                PHASE_NOOP_POLICY_BUILD_EXPLICIT=true
                shift 2
                ;;
            --phase-noop-policy-test)
                PHASE_NOOP_POLICY_TEST="$(to_lower "$(parse_arg_value "--phase-noop-policy-test" "${2:-}")")"
                if ! is_phase_noop_policy "$PHASE_NOOP_POLICY_TEST"; then
                    err "Invalid policy for --phase-noop-policy-test: $PHASE_NOOP_POLICY_TEST"
                    exit 1
                fi
                PHASE_NOOP_POLICY_TEST_EXPLICIT=true
                shift 2
                ;;
            --phase-noop-policy-refactor)
                PHASE_NOOP_POLICY_REFACTOR="$(to_lower "$(parse_arg_value "--phase-noop-policy-refactor" "${2:-}")")"
                if ! is_phase_noop_policy "$PHASE_NOOP_POLICY_REFACTOR"; then
                    err "Invalid policy for --phase-noop-policy-refactor: $PHASE_NOOP_POLICY_REFACTOR"
                    exit 1
                fi
                PHASE_NOOP_POLICY_REFACTOR_EXPLICIT=true
                shift 2
                ;;
            --phase-noop-policy-lint)
                PHASE_NOOP_POLICY_LINT="$(to_lower "$(parse_arg_value "--phase-noop-policy-lint" "${2:-}")")"
                if ! is_phase_noop_policy "$PHASE_NOOP_POLICY_LINT"; then
                    err "Invalid policy for --phase-noop-policy-lint: $PHASE_NOOP_POLICY_LINT"
                    exit 1
                fi
                PHASE_NOOP_POLICY_LINT_EXPLICIT=true
                shift 2
                ;;
            --phase-noop-policy-document)
                PHASE_NOOP_POLICY_DOCUMENT="$(to_lower "$(parse_arg_value "--phase-noop-policy-document" "${2:-}")")"
                if ! is_phase_noop_policy "$PHASE_NOOP_POLICY_DOCUMENT"; then
                    err "Invalid policy for --phase-noop-policy-document: $PHASE_NOOP_POLICY_DOCUMENT"
                    exit 1
                fi
                PHASE_NOOP_POLICY_DOCUMENT_EXPLICIT=true
                shift 2
                ;;
            --max-iterations)
                MAX_ITERATIONS="$(parse_arg_value "--max-iterations" "${2:-}")"
                require_non_negative_int "MAX_ITERATIONS" "$MAX_ITERATIONS"
                shift 2
                ;;
            *)
                err "Unknown argument: $1"
                print_usage
                exit 1
                ;;
        esac
    done
}

# Global Registry for Background Processes (for atomic cleanup)
declare -a RALPHIE_BG_PIDS=()
INTERRUPT_MENU_ACTIVE="false"
MARKDOWN_ARTIFACTS_CLEANED_LIST=""

# Configuration defaults
DEFAULT_ENGINE="auto"
DEFAULT_CODEX_CMD="codex"
DEFAULT_CLAUDE_CMD="claude"
DEFAULT_YOLO="true"
DEFAULT_AUTO_UPDATE="true"
DEFAULT_COMMAND_TIMEOUT_SECONDS=0 # 0 means disabled
DEFAULT_MAX_ITERATIONS=0          # 0 means infinite
DEFAULT_MAX_SESSION_CYCLES=0      # 0 means infinite across all phases
DEFAULT_RALPHIE_QUALITY_LEVEL="standard" # minimal|standard|high
DEFAULT_RUN_AGENT_MAX_ATTEMPTS=3
DEFAULT_RUN_AGENT_RETRY_DELAY_SECONDS=5
DEFAULT_RUN_AGENT_RETRY_VERBOSE="true"
DEFAULT_RESUME_REQUESTED="true"
DEFAULT_REBOOTSTRAP_REQUESTED="false"
DEFAULT_STRICT_VALIDATION_NOOP="false"
DEFAULT_PHASE_COMPLETION_MAX_ATTEMPTS=3 # bounded retries per phase (0 = one attempt)
DEFAULT_PHASE_COMPLETION_RETRY_DELAY_SECONDS=5
DEFAULT_PHASE_COMPLETION_RETRY_VERBOSE="true"
DEFAULT_MAX_CONSENSUS_ROUTING_ATTEMPTS=2
DEFAULT_ENGINE_OUTPUT_TO_STDOUT="true"
ENGINE_OUTPUT_TO_STDOUT_EXPLICIT="false"
ENGINE_OUTPUT_TO_STDOUT_OVERRIDE=""
DEFAULT_PHASE_NOOP_POLICY_PLAN="none"
DEFAULT_PHASE_NOOP_POLICY_BUILD="hard"
DEFAULT_PHASE_NOOP_POLICY_TEST="soft"
DEFAULT_PHASE_NOOP_POLICY_REFACTOR="hard"
DEFAULT_PHASE_NOOP_POLICY_LINT="soft"
DEFAULT_PHASE_NOOP_POLICY_DOCUMENT="hard"
DEFAULT_PHASE_NOOP_PROFILE="balanced"
PHASE_NOOP_PROFILE_EXPLICIT=false
PHASE_NOOP_POLICY_PLAN_EXPLICIT=false
PHASE_NOOP_POLICY_BUILD_EXPLICIT=false
PHASE_NOOP_POLICY_TEST_EXPLICIT=false
PHASE_NOOP_POLICY_REFACTOR_EXPLICIT=false
PHASE_NOOP_POLICY_LINT_EXPLICIT=false
PHASE_NOOP_POLICY_DOCUMENT_EXPLICIT=false
DEFAULT_SESSION_TOKEN_BUDGET=0               # 0 means unlimited
DEFAULT_SESSION_TOKEN_RATE_CENTS_PER_MILLION=0 # 0 means no cost accounting
DEFAULT_SESSION_COST_BUDGET_CENTS=0           # 0 means unlimited
DEFAULT_AUTO_REPAIR_MARKDOWN_ARTIFACTS="true" # sanitize common local/engine leaks when gate blocked
DEFAULT_SWARM_CONSENSUS_TIMEOUT=600             # max seconds for all reviewers in a consensus round
DEFAULT_ENGINE_HEALTH_MAX_ATTEMPTS=3             # attempts before refusing to proceed
DEFAULT_ENGINE_HEALTH_RETRY_DELAY_SECONDS=5       # exponential backoff base
DEFAULT_ENGINE_HEALTH_RETRY_VERBOSE="true"        # log retry activity at startup/loop boundaries

# Load configuration from environment or file.
COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-$DEFAULT_COMMAND_TIMEOUT_SECONDS}"
MAX_ITERATIONS="${MAX_ITERATIONS:-$DEFAULT_MAX_ITERATIONS}"
MAX_SESSION_CYCLES="${MAX_SESSION_CYCLES:-$DEFAULT_MAX_SESSION_CYCLES}"
YOLO="${YOLO:-$DEFAULT_YOLO}"
AUTO_UPDATE="${AUTO_UPDATE:-$DEFAULT_AUTO_UPDATE}"
RALPHIE_QUALITY_LEVEL="${RALPHIE_QUALITY_LEVEL:-$DEFAULT_RALPHIE_QUALITY_LEVEL}"
SWARM_MAX_PARALLEL="${SWARM_MAX_PARALLEL:-2}"
CONFIDENCE_TARGET="${CONFIDENCE_TARGET:-85}"
CONFIDENCE_STAGNATION_LIMIT="${CONFIDENCE_STAGNATION_LIMIT:-3}"
AUTO_PLAN_BACKFILL_ON_IDLE_BUILD="${AUTO_PLAN_BACKFILL_ON_IDLE_BUILD:-true}"
RUN_AGENT_MAX_ATTEMPTS="${RUN_AGENT_MAX_ATTEMPTS:-$DEFAULT_RUN_AGENT_MAX_ATTEMPTS}"
RUN_AGENT_RETRY_DELAY_SECONDS="${RUN_AGENT_RETRY_DELAY_SECONDS:-$DEFAULT_RUN_AGENT_RETRY_DELAY_SECONDS}"
RUN_AGENT_RETRY_VERBOSE="${RUN_AGENT_RETRY_VERBOSE:-$DEFAULT_RUN_AGENT_RETRY_VERBOSE}"
ENGINE_OUTPUT_TO_STDOUT="${ENGINE_OUTPUT_TO_STDOUT:-$DEFAULT_ENGINE_OUTPUT_TO_STDOUT}"
STRICT_VALIDATION_NOOP="${STRICT_VALIDATION_NOOP:-$DEFAULT_STRICT_VALIDATION_NOOP}"
PHASE_COMPLETION_MAX_ATTEMPTS="${PHASE_COMPLETION_MAX_ATTEMPTS:-$DEFAULT_PHASE_COMPLETION_MAX_ATTEMPTS}"
PHASE_COMPLETION_RETRY_DELAY_SECONDS="${PHASE_COMPLETION_RETRY_DELAY_SECONDS:-$DEFAULT_PHASE_COMPLETION_RETRY_DELAY_SECONDS}"
PHASE_COMPLETION_RETRY_VERBOSE="${PHASE_COMPLETION_RETRY_VERBOSE:-$DEFAULT_PHASE_COMPLETION_RETRY_VERBOSE}"
MAX_CONSENSUS_ROUTING_ATTEMPTS="${MAX_CONSENSUS_ROUTING_ATTEMPTS:-$DEFAULT_MAX_CONSENSUS_ROUTING_ATTEMPTS}"
PHASE_NOOP_POLICY_PLAN="${PHASE_NOOP_POLICY_PLAN:-$DEFAULT_PHASE_NOOP_POLICY_PLAN}"
PHASE_NOOP_POLICY_BUILD="${PHASE_NOOP_POLICY_BUILD:-$DEFAULT_PHASE_NOOP_POLICY_BUILD}"
PHASE_NOOP_POLICY_TEST="${PHASE_NOOP_POLICY_TEST:-$DEFAULT_PHASE_NOOP_POLICY_TEST}"
PHASE_NOOP_POLICY_REFACTOR="${PHASE_NOOP_POLICY_REFACTOR:-$DEFAULT_PHASE_NOOP_POLICY_REFACTOR}"
PHASE_NOOP_POLICY_LINT="${PHASE_NOOP_POLICY_LINT:-$DEFAULT_PHASE_NOOP_POLICY_LINT}"
PHASE_NOOP_POLICY_DOCUMENT="${PHASE_NOOP_POLICY_DOCUMENT:-$DEFAULT_PHASE_NOOP_POLICY_DOCUMENT}"
PHASE_NOOP_PROFILE="${PHASE_NOOP_PROFILE:-$DEFAULT_PHASE_NOOP_PROFILE}"
SESSION_TOKEN_BUDGET="${SESSION_TOKEN_BUDGET:-$DEFAULT_SESSION_TOKEN_BUDGET}"
SESSION_TOKEN_RATE_CENTS_PER_MILLION="${SESSION_TOKEN_RATE_CENTS_PER_MILLION:-$DEFAULT_SESSION_TOKEN_RATE_CENTS_PER_MILLION}"
SESSION_COST_BUDGET_CENTS="${SESSION_COST_BUDGET_CENTS:-$DEFAULT_SESSION_COST_BUDGET_CENTS}"
AUTO_REPAIR_MARKDOWN_ARTIFACTS="${AUTO_REPAIR_MARKDOWN_ARTIFACTS:-$DEFAULT_AUTO_REPAIR_MARKDOWN_ARTIFACTS}"
SWARM_CONSENSUS_TIMEOUT="${SWARM_CONSENSUS_TIMEOUT:-$DEFAULT_SWARM_CONSENSUS_TIMEOUT}"
ENGINE_HEALTH_MAX_ATTEMPTS="${ENGINE_HEALTH_MAX_ATTEMPTS:-$DEFAULT_ENGINE_HEALTH_MAX_ATTEMPTS}"
ENGINE_HEALTH_RETRY_DELAY_SECONDS="${ENGINE_HEALTH_RETRY_DELAY_SECONDS:-$DEFAULT_ENGINE_HEALTH_RETRY_DELAY_SECONDS}"
ENGINE_HEALTH_RETRY_VERBOSE="${ENGINE_HEALTH_RETRY_VERBOSE:-$DEFAULT_ENGINE_HEALTH_RETRY_VERBOSE}"

if [ -f "$CONFIG_FILE" ]; then
    # Validate config file contains only safe KEY=VALUE lines before sourcing
    # POSIX env var names: start with letter or underscore, contain alphanumerics and underscores
    if grep -qvE '^[[:space:]]*(#|$|[A-Za-z_][A-Za-z0-9_]*=)' "$CONFIG_FILE" 2>/dev/null; then
        warn "config.env contains suspicious lines — skipping source for safety."
        warn "Only KEY=VALUE lines and comments are allowed."
    else
        # shellcheck disable=SC1090
        source "$CONFIG_FILE"
    fi
fi

# Override with environment variables if present.
ACTIVE_ENGINE="${RALPHIE_ENGINE:-$DEFAULT_ENGINE}"
CODEX_CMD="${CODEX_ENGINE_CMD:-$DEFAULT_CODEX_CMD}"
CLAUDE_CMD="${CLAUDE_ENGINE_CMD:-$DEFAULT_CLAUDE_CMD}"
RESUME_REQUESTED="${RALPHIE_RESUME_REQUESTED:-$DEFAULT_RESUME_REQUESTED}"
REBOOTSTRAP_REQUESTED="${RALPHIE_REBOOTSTRAP_REQUESTED:-$DEFAULT_REBOOTSTRAP_REQUESTED}"
ENGINE_OUTPUT_TO_STDOUT="${RALPHIE_ENGINE_OUTPUT_TO_STDOUT:-$ENGINE_OUTPUT_TO_STDOUT}"
YOLO="${RALPHIE_YOLO:-$YOLO}"
AUTO_UPDATE="${RALPHIE_AUTO_UPDATE:-$AUTO_UPDATE}"
AUTO_UPDATE_URL="${RALPHIE_AUTO_UPDATE_URL:-$DEFAULT_AUTO_UPDATE_URL}"
PHASE_NOOP_PROFILE="${RALPHIE_PHASE_NOOP_PROFILE:-$PHASE_NOOP_PROFILE}"

# Validate engine selection
case "$(to_lower "$ACTIVE_ENGINE")" in
    claude|codex|auto) ACTIVE_ENGINE="$(to_lower "$ACTIVE_ENGINE")" ;;
    *)
        warn "Unrecognized engine '$ACTIVE_ENGINE'. Falling back to '$DEFAULT_ENGINE'."
        ACTIVE_ENGINE="$DEFAULT_ENGINE"
        ;;
esac

if [ "$ACTIVE_ENGINE" = "codex" ]; then
    ACTIVE_CMD="$CODEX_CMD"
else
    ACTIVE_CMD="$CLAUDE_CMD"
fi

if [ "$ACTIVE_ENGINE" = "auto" ]; then
    if command -v "$CODEX_CMD" >/dev/null 2>&1; then
        ACTIVE_ENGINE="codex"
        ACTIVE_CMD="$CODEX_CMD"
    elif command -v "$CLAUDE_CMD" >/dev/null 2>&1; then
        ACTIVE_ENGINE="claude"
        ACTIVE_CMD="$CLAUDE_CMD"
    fi
fi

# Runtime State variables (these change during the loop)
CURRENT_PHASE="plan"
CURRENT_PHASE_INDEX=0
ITERATION_COUNT=0
SESSION_ID="$(date +%Y%m%d_%H%M%S)"
SESSION_ATTEMPT_COUNT=0
SESSION_TOKEN_COUNT=0
SESSION_COST_CENTS=0
LAST_RUN_TOKEN_COUNT=0
LAST_CONSENSUS_SCORE=0
LAST_CONSENSUS_PASS=false
LAST_CONSENSUS_DIR=""
LAST_CONSENSUS_SUMMARY=""
LAST_CONSENSUS_NEXT_PHASE="done"
LAST_CONSENSUS_NEXT_PHASE_REASON="no consensus recommendation"
LAST_CONSENSUS_RESPONDED_VOTES=0
LAST_HANDOFF_SCORE=0
LAST_HANDOFF_VERDICT="HOLD"
LAST_HANDOFF_GAPS="no explicit gaps"
PHASE_TRANSITION_HISTORY=()

# Capability Probing results (populated by probe_engine_capabilities)
CLAUDE_CAP_PRINT=0
CLAUDE_CAP_YOLO_FLAG=""
CODEX_CAP_OUTPUT_LAST_MESSAGE=0
CODEX_CAP_YOLO_FLAG=0
ENGINE_CAPABILITIES_PROBED=false
CODEX_CAP_NOTE=""
CLAUDE_CAP_NOTE=""
CODEX_HEALTHY="false"
CLAUDE_HEALTHY="false"
ENGINE_SELECTION_REQUESTED="$ACTIVE_ENGINE"
LAST_ENGINE_SELECTION_BLOCK_REASON=""

# Resilience Dial implementation
get_reviewer_count() {
    case "$RALPHIE_QUALITY_LEVEL" in
        minimal) echo 1 ;;
        standard) echo 3 ;;
        high) echo 5 ;;
        *) echo 3 ;;
    esac
}

get_parallel_reviewer_count() {
    case "$RALPHIE_QUALITY_LEVEL" in
        minimal) echo 1 ;;
        standard) echo 2 ;;
        high) echo 4 ;;
        *) echo 2 ;;
    esac
}

get_reviewer_max_retries() {
    case "$RALPHIE_QUALITY_LEVEL" in
        minimal) echo 0 ;;
        standard) echo 1 ;;
        high) echo 2 ;;
        *) echo 1 ;;
    esac
}

# State Management with Integrity Checks
# Returns the highest-preferred available command for SHA-256 checksums.
sha256sum_command() {
    if command -v sha256sum >/dev/null 2>&1; then
        echo "sha256sum"
        return 0
    fi
    if command -v shasum >/dev/null 2>&1; then
        echo "shasum"
        return 0
    fi
    return 1
}

sha256_file_sum() {
    local file="$1"
    local checksum_cmd

    checksum_cmd="$(sha256sum_command)" || {
        warn "No SHA-256 command available for file checksum calculation."
        return 1
    }

    if [ "$checksum_cmd" = "sha256sum" ]; then
        "$checksum_cmd" "$file" | cut -d' ' -f1
    else
        "$checksum_cmd" -a 256 "$file" | cut -d' ' -f1
    fi
}

save_state() {
    mkdir -p "$(dirname "$STATE_FILE")"
    local checksum

    cat <<EOF > "$STATE_FILE"
CURRENT_PHASE="$CURRENT_PHASE"
CURRENT_PHASE_INDEX="$CURRENT_PHASE_INDEX"
ITERATION_COUNT="$ITERATION_COUNT"
SESSION_ID="$SESSION_ID"
SESSION_ATTEMPT_COUNT="$SESSION_ATTEMPT_COUNT"
SESSION_TOKEN_COUNT="$SESSION_TOKEN_COUNT"
SESSION_COST_CENTS="$SESSION_COST_CENTS"
LAST_RUN_TOKEN_COUNT="$LAST_RUN_TOKEN_COUNT"
ENGINE_OUTPUT_TO_STDOUT="$ENGINE_OUTPUT_TO_STDOUT"
EOF
    # Append SHA-256 checksum to the end
    if checksum="$(sha256_file_sum "$STATE_FILE")"; then
        echo "STATE_CHECKSUM=\"$checksum\"" >> "$STATE_FILE"
    else
        warn "Could not calculate state checksum; continuing without integrity metadata."
    fi
}

load_state() {
    if [ ! -f "$STATE_FILE" ]; then return 1; fi

    CURRENT_PHASE="plan"
    CURRENT_PHASE_INDEX=0
    ITERATION_COUNT=0
    SESSION_ID=""
    SESSION_ATTEMPT_COUNT=0
    SESSION_TOKEN_COUNT=0
    SESSION_COST_CENTS=0
    LAST_RUN_TOKEN_COUNT=0
    ENGINE_OUTPUT_TO_STDOUT="$DEFAULT_ENGINE_OUTPUT_TO_STDOUT"
    
    # Verify checksum if present
    if grep -q "STATE_CHECKSUM=" "$STATE_FILE"; then
        local expected actual state_body_file
        expected="$(grep "STATE_CHECKSUM=" "$STATE_FILE" | head -n 1 | cut -d'"' -f2)"
        state_body_file="$(mktemp "$CONFIG_DIR/state-body.XXXXXX")"
        if grep -v "^STATE_CHECKSUM=" "$STATE_FILE" > "$state_body_file" 2>/dev/null && actual="$(sha256_file_sum "$state_body_file")"; then
            if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
                warn "State file checksum mismatch! Corruption detected. Forcing clean state."
                log_reason_code "RB_STATE_CORRUPTION" "checksum mismatch in state file"
                rm -f "$state_body_file"
                return 1
            fi
        else
            warn "Unable to validate state checksum. Proceeding without enforcing integrity."
        fi
        rm -f "$state_body_file"
    fi

    while IFS='=' read -r key value; do
        [ -z "$key" ] && continue
        value="${value%\"}"
        value="${value#\"}"
        case "$key" in
            CURRENT_PHASE) CURRENT_PHASE="$value" ;;
            CURRENT_PHASE_INDEX) is_number "$value" && CURRENT_PHASE_INDEX="$value" ;;
            ITERATION_COUNT) is_number "$value" && ITERATION_COUNT="$value" ;;
            SESSION_ID) SESSION_ID="$value" ;;
            SESSION_ATTEMPT_COUNT) is_number "$value" && SESSION_ATTEMPT_COUNT="$value" ;;
            SESSION_TOKEN_COUNT) is_number "$value" && SESSION_TOKEN_COUNT="$value" ;;
            SESSION_COST_CENTS) is_number "$value" && SESSION_COST_CENTS="$value" ;;
            LAST_RUN_TOKEN_COUNT) is_number "$value" && LAST_RUN_TOKEN_COUNT="$value" ;;
            ENGINE_OUTPUT_TO_STDOUT) [ -n "$value" ] && ENGINE_OUTPUT_TO_STDOUT="$value" ;;
            STATE_CHECKSUM) ;;
            *) ;;
        esac
    done < "$STATE_FILE"

    if ! is_number "$CURRENT_PHASE_INDEX"; then
        CURRENT_PHASE_INDEX=0
    fi
    return 0
}

estimate_file_token_count() {
    local file="$1"
    if [ ! -f "$file" ]; then
        echo 0
        return 0
    fi

    local bytes
    bytes="$(wc -c < "$file" 2>/dev/null | tr -d ' ' || echo 0)"
    if ! is_number "$bytes"; then
        echo 0
        return 0
    fi
    echo $(( (bytes + 3) / 4 ))
}

estimate_run_tokens() {
    local prompt_file="$1"
    local log_file="$2"
    local output_file="$3"

    local tokens
    local prompt_tokens
    local log_tokens
    local output_tokens
    prompt_tokens="$(estimate_file_token_count "$prompt_file")"
    log_tokens="$(estimate_file_token_count "$log_file")"
    output_tokens="$(estimate_file_token_count "$output_file")"
    tokens="$(( prompt_tokens + log_tokens + output_tokens ))"
    echo "$tokens"
}

charge_session_budget() {
    local tokens="$1"
    if ! is_number "$tokens"; then
        tokens=0
    fi
    SESSION_ATTEMPT_COUNT=$((SESSION_ATTEMPT_COUNT + 1))
    SESSION_TOKEN_COUNT=$((SESSION_TOKEN_COUNT + tokens))

    if is_number "$SESSION_TOKEN_RATE_CENTS_PER_MILLION" && [ "$SESSION_TOKEN_RATE_CENTS_PER_MILLION" -gt 0 ]; then
        local run_cost
        run_cost=$(( tokens * SESSION_TOKEN_RATE_CENTS_PER_MILLION / 1000000 ))
        SESSION_COST_CENTS=$((SESSION_COST_CENTS + run_cost))
    fi

    LAST_RUN_TOKEN_COUNT="$tokens"
}

enforce_session_budget() {
    local reason_prefix="${1:-run}"
    if is_number "$MAX_SESSION_CYCLES" && [ "$MAX_SESSION_CYCLES" -gt 0 ] && [ "$SESSION_ATTEMPT_COUNT" -ge "$MAX_SESSION_CYCLES" ]; then
        log_reason_code "RB_SESSION_CYCLE_BUDGET_EXCEEDED" "$reason_prefix: session cycle budget exceeded at $SESSION_ATTEMPT_COUNT/$MAX_SESSION_CYCLES attempts"
        return 1
    fi
    if is_number "$SESSION_TOKEN_BUDGET" && [ "$SESSION_TOKEN_BUDGET" -gt 0 ] && [ "$SESSION_TOKEN_COUNT" -gt "$SESSION_TOKEN_BUDGET" ]; then
        log_reason_code "RB_SESSION_TOKEN_BUDGET_EXCEEDED" "$reason_prefix: session token budget exceeded at $SESSION_TOKEN_COUNT/$SESSION_TOKEN_BUDGET"
        return 1
    fi
    if is_number "$SESSION_COST_BUDGET_CENTS" && [ "$SESSION_COST_BUDGET_CENTS" -gt 0 ] && [ "$SESSION_COST_CENTS" -gt "$SESSION_COST_BUDGET_CENTS" ]; then
        log_reason_code "RB_SESSION_COST_BUDGET_EXCEEDED" "$reason_prefix: session cost budget exceeded at $SESSION_COST_CENTS/$SESSION_COST_BUDGET_CENTS cents"
        return 1
    fi
    return 0
}

# Interactive Questions
is_tty_input_available() {
    [ -t 0 ]
}

prompt_read_line() {
    local prompt="$1"
    local default="$2"
    local response=""

    if [ -t 0 ]; then
        read -rp "$prompt" response
        echo "${response:-$default}"
        return 0
    fi

    if [ -r /dev/tty ] && [ -w /dev/tty ]; then
        read -rp "$prompt" response < /dev/tty > /dev/tty 2>/dev/null
        echo "${response:-$default}"
        return 0
    fi

    echo "$default"
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local response
    local default_marker="[Y/n]"

    case "$(to_lower "$default")" in
        n|no|false|0) default_marker="[y/N]" ;;
        *) default_marker="[Y/n]" ;;
    esac

    response="$(prompt_read_line "$prompt $default_marker: " "$default")"
    case "${response}" in
        [Yy]*) echo "true"; return 0 ;;
        *) echo "false"; return 1 ;;
    esac
}

prompt_line() {
    local prompt="$1"
    local default="$2"
    prompt_read_line "$prompt [$default]: " "$default"
}

prompt_optional_line() {
    local prompt="$1"
    local default="${2:-}"
    prompt_read_line "$prompt: " "$default"
}

bootstrap_prompt_value() {
    local key="$1"
    [ -f "$PROJECT_BOOTSTRAP_FILE" ] || return 1
    awk -F': ' -v key="$key" '
        $1 == key {
            value=$0
            sub(/^"?"/, "", value)
            sub(/^"?[^:]+: /, "", value)
            sub(/"$/, "", value)
            print value
            exit
        }
    ' "$PROJECT_BOOTSTRAP_FILE"
}

bootstrap_context_is_valid() {
    local project_type objective build_consent interactive_prompted
    project_type="$(bootstrap_prompt_value "project_type" 2>/dev/null || true)"
    objective="$(bootstrap_prompt_value "objective" 2>/dev/null || true)"
    build_consent="$(bootstrap_prompt_value "build_consent" 2>/dev/null || true)"
    interactive_prompted="$(bootstrap_prompt_value "interactive_prompted" 2>/dev/null || true)"

    if [ -z "$project_type" ] || [ -z "$objective" ] || [ -z "$build_consent" ] || [ -z "$interactive_prompted" ]; then
        return 1
    fi
    case "$project_type" in
        new|existing) ;;
        *) return 1 ;;
    esac
    if ! is_bool_like "$build_consent"; then
        return 1
    fi
    if ! is_bool_like "$interactive_prompted"; then
        return 1
    fi
    return 0
}

write_bootstrap_context_file() {
    local project_type="$1"
    local objective="$2"
    local build_consent="$3"
    local interactive_source="$4"

    cat > "$PROJECT_BOOTSTRAP_FILE" <<EOF
# Ralphie Project Bootstrap
project_type: $project_type
build_consent: $build_consent
objective: $objective
interactive_prompted: $interactive_source
captured_at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF
}

ensure_project_bootstrap() {
    local project_type objective build_consent interactive_source
    project_type="existing"
    objective="Improve project with a deterministic, evidence-first implementation path."
    build_consent="true"
    interactive_source="false"

    mkdir -p "$(dirname "$PROJECT_BOOTSTRAP_FILE")"
    local existing_project_type=""
    local existing_objective=""
    local existing_build_consent=""
    local existing_interactive_prompted=""
    local needs_prompt="false"

    if [ -f "$PROJECT_BOOTSTRAP_FILE" ]; then
        existing_project_type="$(bootstrap_prompt_value "project_type" 2>/dev/null || true)"
        existing_objective="$(bootstrap_prompt_value "objective" 2>/dev/null || true)"
        existing_build_consent="$(bootstrap_prompt_value "build_consent" 2>/dev/null || true)"
        existing_interactive_prompted="$(bootstrap_prompt_value "interactive_prompted" 2>/dev/null || true)"

        if [ -n "$existing_project_type" ]; then
            project_type="$existing_project_type"
        fi
        if [ -n "$existing_objective" ]; then
            objective="$existing_objective"
        fi
        if [ -n "$existing_build_consent" ]; then
            build_consent="$existing_build_consent"
        fi
        if [ "$existing_interactive_prompted" = "true" ]; then
            interactive_source="true"
        fi
    fi

    if [ "$REBOOTSTRAP_REQUESTED" = true ] || [ ! -f "$PROJECT_BOOTSTRAP_FILE" ] || ! bootstrap_context_is_valid; then
        needs_prompt="true"
    fi
    if is_tty_input_available && [ "$existing_interactive_prompted" = "false" ] && [ -f "$PROJECT_BOOTSTRAP_FILE" ]; then
        needs_prompt="true"
    fi

    if [ "$needs_prompt" = "true" ]; then
        if [ -f "$PROJECT_BOOTSTRAP_FILE" ] && ! bootstrap_context_is_valid; then
            warn "Existing project bootstrap file is invalid or incomplete. Rebuilding context."
        elif [ "$REBOOTSTRAP_REQUESTED" = true ]; then
            warn "Rebuilding project bootstrap context due to --rebootstrap request."
        elif is_tty_input_available && [ "$existing_interactive_prompted" = "false" ]; then
            info "Previous bootstrap was collected non-interactively; refreshing bootstrap context now."
        fi
    fi

    if is_true "$needs_prompt" && is_tty_input_available; then
        interactive_source="true"
        if [ "$REBOOTSTRAP_REQUESTED" = true ] || ! bootstrap_context_is_valid || [ "$existing_interactive_prompted" = "false" ] || [ ! -f "$PROJECT_BOOTSTRAP_FILE" ]; then
            if [ "$(prompt_yes_no "Is this a new project (no established implementation yet)?" "n")" = "true" ]; then
                project_type="new"
            fi
            objective="$(prompt_optional_line "What is the primary objective for this session" "$objective")"
            if [ "$(prompt_yes_no "Proceed automatically from PLAN -> BUILD when all gates pass" "y")" = "true" ]; then
                build_consent="true"
            else
                build_consent="false"
            fi
            info "Project bootstrap captured from interactive input."
        fi
    fi

    if ! is_true "$needs_prompt" && [ -f "$PROJECT_BOOTSTRAP_FILE" ] && is_tty_input_available; then
        info "Loaded existing project bootstrap context: $(path_for_display "$PROJECT_BOOTSTRAP_FILE")"
        info "   - project_type: $project_type"
        info "   - objective: $objective"
        info "   - build_consent: $build_consent"
        return 0
    fi

    if is_true "$needs_prompt" && ! is_tty_input_available; then
        info "Non-interactive bootstrap fallback retained: objective and build consent defaults were applied."
    fi

    write_bootstrap_context_file "$project_type" "$objective" "$build_consent" "$interactive_source"
    info "Captured project bootstrap context: $(path_for_display "$PROJECT_BOOTSTRAP_FILE")"
    REBOOTSTRAP_REQUESTED=false
}

append_bootstrap_context_to_plan_prompt() {
    local source_prompt="$1"
    local target_prompt="$2"
    local project_type objective build_consent

    if [ ! -f "$source_prompt" ] || [ ! -f "$PROJECT_BOOTSTRAP_FILE" ]; then
        cp "$source_prompt" "$target_prompt"
        return 0
    fi

    project_type="$(bootstrap_prompt_value "project_type")"
    objective="$(bootstrap_prompt_value "objective")"
    build_consent="$(bootstrap_prompt_value "build_consent")"

    cat > "$target_prompt" <<EOF
$(cat "$source_prompt")

## Project Bootstrap Context
- Project type: ${project_type:-existing}
- Objective: ${objective:-unspecified}
- Build consent after plan: ${build_consent:-true}

EOF
}

build_is_preapproved() {
    local consent
    consent="$(bootstrap_prompt_value "build_consent" 2>/dev/null)"
    [ "$consent" = "true" ]
}

# Multi-Agent Capability Detection
probe_engine_capabilities() {
    local force_reprobe="${1:-false}"

    if is_true "$ENGINE_CAPABILITIES_PROBED" && ! is_true "$force_reprobe"; then
        return 0
    fi

    CODEX_CAP_OUTPUT_LAST_MESSAGE=0
    CODEX_CAP_YOLO_FLAG=0
    CODEX_CAP_NOTE=""
    CLAUDE_CAP_NOTE=""
    CLAUDE_CAP_PRINT=0
    CLAUDE_CAP_YOLO_FLAG=""
    CODEX_HEALTHY="false"
    CLAUDE_HEALTHY="false"

    # Probing Claude Code
    if command -v "$CLAUDE_CMD" >/dev/null 2>&1; then
        local claude_help
        claude_help="$("$CLAUDE_CMD" --help 2>&1 || true)"
        if echo "$claude_help" | grep -qE -- "-p, --print"; then
            CLAUDE_CAP_PRINT=1
        else
            CLAUDE_CAP_NOTE="missing required --print mode"
        fi

        if echo "$claude_help" | grep -qE -- "--dangerously-skip-permissions"; then
            CLAUDE_CAP_YOLO_FLAG="--dangerously-skip-permissions"
        fi

        if ! echo "$claude_help" | grep -qiE "read|write|tool|file|edit|command"; then
            [ -n "$CLAUDE_CAP_NOTE" ] && CLAUDE_CAP_NOTE="${CLAUDE_CAP_NOTE}; "
            CLAUDE_CAP_NOTE="${CLAUDE_CAP_NOTE}read/write/tool capability hint not present in help output"
        fi

        [ -z "$CLAUDE_CAP_NOTE" ] && CLAUDE_HEALTHY="true"
    else
        CLAUDE_CAP_NOTE="command not found: $CLAUDE_CMD"
    fi

    # Probing Codex
    if command -v "$CODEX_CMD" >/dev/null 2>&1; then
        local codex_help
        codex_help="$("$CODEX_CMD" exec --help 2>&1 || true)"
        if echo "$codex_help" | grep -qE -- "--output-last-message"; then
            CODEX_CAP_OUTPUT_LAST_MESSAGE=1
        else
            CODEX_CAP_NOTE="missing required --output-last-message"
        fi

        if echo "$codex_help" | grep -qE -- "--dangerously-bypass-approvals-and-sandbox"; then
            CODEX_CAP_YOLO_FLAG=1
        fi

        if ! echo "$codex_help" | grep -qiE "read|write|tool|file|edit|command|exec"; then
            [ -n "$CODEX_CAP_NOTE" ] && CODEX_CAP_NOTE="${CODEX_CAP_NOTE}; "
            CODEX_CAP_NOTE="${CODEX_CAP_NOTE}read/write/tool capability hint not present in help output"
        fi

        [ -z "$CODEX_CAP_NOTE" ] && CODEX_HEALTHY="true"
    else
        CODEX_CAP_NOTE="command not found: $CODEX_CMD"
    fi

    ENGINE_CAPABILITIES_PROBED=true
}

log_engine_health_summary() {
    local codex_line
    local claude_line
    if [ "$CODEX_HEALTHY" = "true" ]; then
        codex_line="codex: available"
    else
        codex_line="codex: unavailable (${CODEX_CAP_NOTE})"
    fi
    if [ "$CLAUDE_HEALTHY" = "true" ]; then
        claude_line="claude: available"
    else
        claude_line="claude: unavailable (${CLAUDE_CAP_NOTE})"
    fi
    info "Engine health check: $codex_line; $claude_line"
}

resolve_active_engine() {
    local requested_engine="$1"
    local allow_auto_fallback="${2:-true}"
    LAST_ENGINE_SELECTION_BLOCK_REASON=""

    case "$requested_engine" in
        auto)
            if [ "$CODEX_HEALTHY" = "true" ]; then
                ACTIVE_ENGINE="codex"
                ACTIVE_CMD="$CODEX_CMD"
                ENGINE_SELECTION_REQUESTED="$ACTIVE_ENGINE"
                return 0
            fi
            if [ "$CLAUDE_HEALTHY" = "true" ]; then
                if is_true "$allow_auto_fallback"; then
                    if is_tty_input_available; then
                        if ! prompt_yes_no "AUTO mode preferred codex, but codex is unavailable (${CODEX_CAP_NOTE}). Proceed with CLAUDE instead?" "y"; then
                            LAST_ENGINE_SELECTION_BLOCK_REASON="AUTO mode skipped Claude fallback after user decline."
                            return 1
                        fi
                    else
                        LAST_ENGINE_SELECTION_BLOCK_REASON="AUTO mode preferred codex, but codex is unavailable (${CODEX_CAP_NOTE}) and this is non-interactive."
                        return 1
                    fi
                fi
                ACTIVE_ENGINE="claude"
                ACTIVE_CMD="$CLAUDE_CMD"
                ENGINE_SELECTION_REQUESTED="$ACTIVE_ENGINE"
                return 0
            fi
            LAST_ENGINE_SELECTION_BLOCK_REASON="AUTO requested but neither codex nor claude appears capable."
            return 1
            ;;
        codex)
            if [ "$CODEX_HEALTHY" = "true" ]; then
                ACTIVE_ENGINE="codex"
                ACTIVE_CMD="$CODEX_CMD"
                ENGINE_SELECTION_REQUESTED="$ACTIVE_ENGINE"
                return 0
            fi
            if [ "$CLAUDE_HEALTHY" = "true" ]; then
                if is_tty_input_available; then
                    if prompt_yes_no "Configured engine is codex, but codex is unavailable (${CODEX_CAP_NOTE}). Switch to CLAUDE and continue?" "y"; then
                        ACTIVE_ENGINE="claude"
                        ACTIVE_CMD="$CLAUDE_CMD"
                        ENGINE_SELECTION_REQUESTED="$ACTIVE_ENGINE"
                        return 0
                    fi
                    LAST_ENGINE_SELECTION_BLOCK_REASON="User declined codex fallback to claude."
                    return 1
                fi
                LAST_ENGINE_SELECTION_BLOCK_REASON="Configured engine is codex, but codex is unavailable (${CODEX_CAP_NOTE}) in non-interactive mode."
                return 1
            fi
            LAST_ENGINE_SELECTION_BLOCK_REASON="Configured engine is codex and no fallback is healthy."
            return 1
            ;;
        claude)
            if [ "$CLAUDE_HEALTHY" = "true" ]; then
                ACTIVE_ENGINE="claude"
                ACTIVE_CMD="$CLAUDE_CMD"
                ENGINE_SELECTION_REQUESTED="$ACTIVE_ENGINE"
                return 0
            fi
            if [ "$CODEX_HEALTHY" = "true" ]; then
                if is_tty_input_available; then
                    if prompt_yes_no "Configured engine is claude, but claude is unavailable (${CLAUDE_CAP_NOTE}). Switch to CODEX and continue?" "y"; then
                        ACTIVE_ENGINE="codex"
                        ACTIVE_CMD="$CODEX_CMD"
                        ENGINE_SELECTION_REQUESTED="$ACTIVE_ENGINE"
                        return 0
                    fi
                    LAST_ENGINE_SELECTION_BLOCK_REASON="User declined claude fallback to codex."
                    return 1
                fi
                LAST_ENGINE_SELECTION_BLOCK_REASON="Configured engine is claude, but claude is unavailable (${CLAUDE_CAP_NOTE}) in non-interactive mode."
                return 1
            fi
            LAST_ENGINE_SELECTION_BLOCK_REASON="Configured engine is claude and no fallback is healthy."
            return 1
            ;;
        *)
            LAST_ENGINE_SELECTION_BLOCK_REASON="Unsupported requested engine '$requested_engine' during resolution."
            return 1
            ;;
    esac
}

ensure_engines_ready() {
    local requested_engine="$1"
    local max_attempts="$ENGINE_HEALTH_MAX_ATTEMPTS"
    local base_delay="$ENGINE_HEALTH_RETRY_DELAY_SECONDS"
    local attempt=1

    if ! is_number "$max_attempts" || [ "$max_attempts" -lt 1 ]; then
        max_attempts=1
    fi
    if ! is_number "$base_delay" || [ "$base_delay" -lt 0 ]; then
        base_delay=5
    fi

    while [ "$attempt" -le "$max_attempts" ]; do
        probe_engine_capabilities "true"
        ENGINE_CAPABILITIES_PROBED=true

        if is_true "$ENGINE_HEALTH_RETRY_VERBOSE"; then
            log_engine_health_summary
        fi

        if resolve_active_engine "$requested_engine" "true"; then
            return 0
        fi

        if [ "$attempt" -ge "$max_attempts" ]; then
            warn "Engine readiness check failed after $attempt/$max_attempts attempts: $LAST_ENGINE_SELECTION_BLOCK_REASON"
            return 1
        fi

        local backoff_delay jitter
        backoff_delay=$(( base_delay * (1 << (attempt - 1)) ))
        [ "$backoff_delay" -gt 120 ] && backoff_delay=120
        jitter=$(( ${RANDOM:-0} % (base_delay + 1) ))
        backoff_delay=$((backoff_delay + jitter))
        warn "Engine readiness blocked (${LAST_ENGINE_SELECTION_BLOCK_REASON}); retrying in ${backoff_delay}s..."
        sleep "$backoff_delay"
        attempt=$((attempt + 1))
        ENGINE_CAPABILITIES_PROBED=false
    done
}

# Lock Management (atomic via mkdir)
acquire_lock() {
    mkdir -p "$(dirname "$LOCK_FILE")"
    # Use a lock directory for atomic acquisition (mkdir is atomic on POSIX)
    local lock_dir="${LOCK_FILE}.d"
    if mkdir "$lock_dir" 2>/dev/null; then
        echo "$$" > "$LOCK_FILE"
        date '+%Y-%m-%d %H:%M:%S' >> "$LOCK_FILE"
        return 0
    fi
    # Lock dir exists — check if holder is still alive
    if [ -f "$LOCK_FILE" ]; then
        local holder_pid
        holder_pid="$(head -n1 "$LOCK_FILE" 2>/dev/null || echo "")"
        if [ -n "$holder_pid" ] && kill -0 "$holder_pid" 2>/dev/null; then
            err "Orchestrator already running with PID $holder_pid."
            log_reason_code "RB_LOCK_ALREADY_HELD" "pid $holder_pid active"
            return 1
        else
            warn "Stale lock file found (PID $holder_pid no longer running). Reclaiming."
        fi
    else
        warn "Stale lock directory found without PID file. Reclaiming."
    fi
    # Reclaim stale lock
    rm -rf "$lock_dir"
    if mkdir "$lock_dir" 2>/dev/null; then
        echo "$$" > "$LOCK_FILE"
        date '+%Y-%m-%d %H:%M:%S' >> "$LOCK_FILE"
        return 0
    fi
    err "Failed to acquire lock after stale reclaim attempt."
    return 1
}

release_lock() {
    rm -f "$LOCK_FILE"
    rm -rf "${LOCK_FILE}.d" 2>/dev/null || true
}

# Interrupt handling
cleanup_managed_processes() {
    if [ "${#RALPHIE_BG_PIDS[@]-0}" -gt 0 ]; then
        for pid in "${RALPHIE_BG_PIDS[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                kill -TERM "$pid" 2>/dev/null || true
            fi
        done
    fi
}

cleanup_resources() {
    save_state 2>/dev/null || true
    cleanup_managed_processes
    release_lock
}

show_interrupt_menu() {
    local choice
    local output_state

    while true; do
        output_state="$(is_true "$ENGINE_OUTPUT_TO_STDOUT" && echo "on" || echo "off")"
        echo
        warn "Ctrl+C received."
        warn "Live engine output: ${output_state}"
        warn "Actions:"
        warn "  [r] resume (default)"
        warn "  [l] toggle live engine output"
        warn "  [p] persist state and pause"
        warn "  [q] immediate stop"
        warn "  [h] help"
        choice="$(prompt_read_line "Action [r/l/p/q/h]: " "r")"
        case "$(to_lower "$choice")" in
            r|"")
                info "Resuming..."
                return 0
                ;;
            l)
                if is_true "$ENGINE_OUTPUT_TO_STDOUT"; then
                    ENGINE_OUTPUT_TO_STDOUT="false"
                else
                    ENGINE_OUTPUT_TO_STDOUT="true"
                fi
                info "Live engine output is now $(is_true "$ENGINE_OUTPUT_TO_STDOUT" && echo enabled || echo suppressed)."
                save_state
                ;;
            p)
                info "Persisted state and paused."
                save_state
                cleanup_resources
                exit 0
                ;;
            q)
                warn "Immediate stop requested."
                cleanup_resources
                exit 130
                ;;
            h)
                warn "Live logs can be toggled here without restarting. Use 'p' to exit cleanly and resume later."
                ;;
            *)
                warn "Unknown option: $choice"
                ;;
        esac
    done
}

handle_interrupt() {
    if [ "$INTERRUPT_MENU_ACTIVE" = "true" ]; then
        warn "Second interrupt received. Exiting immediately."
        cleanup_resources
        exit 130
    fi
    INTERRUPT_MENU_ACTIVE="true"
    if ! is_tty_input_available; then
        warn "Interrupt received in non-interactive context."
        cleanup_resources
        exit 130
    fi
    cleanup_managed_processes
    show_interrupt_menu
    INTERRUPT_MENU_ACTIVE="false"
}

cleanup() {
    info "Received interrupt. Cleaning up..."
    cleanup_resources
    exit 0
}
trap handle_interrupt SIGINT
trap cleanup SIGTERM
trap cleanup_resources EXIT

# Unified Agent Run Function with Exponential Backoff Retries
get_timeout_command() {
    if command -v timeout >/dev/null 2>&1; then echo "timeout"; elif command -v gtimeout >/dev/null 2>&1; then echo "gtimeout"; fi
}

run_agent_with_prompt() {
    local prompt_file="$1"
    local log_file="$2"
    local output_file="$3"
    local yolo_effective="$4"
    local attempt_no="${5:-1}"
    local timeout_cmd=""
    local exit_code=0
    local -a engine_args=()
    local -a yolo_prefix=()

    if [ ! -f "$prompt_file" ]; then
        err "Prompt file not found: $prompt_file"
        return 2
    fi
    if [ -z "${ACTIVE_CMD:-}" ] || ! command -v "$ACTIVE_CMD" >/dev/null 2>&1; then
        err "Active engine command unavailable: ${ACTIVE_CMD:-<unset>}"
        return 2
    fi
    if [ "$ACTIVE_ENGINE" = "codex" ] && [ "$CODEX_HEALTHY" != "true" ]; then
        err "Selected engine 'codex' is currently marked unhealthy: ${CODEX_CAP_NOTE:-missing required capability state}"
        return 2
    fi
    if [ "$ACTIVE_ENGINE" = "claude" ] && [ "$CLAUDE_HEALTHY" != "true" ]; then
        err "Selected engine 'claude' is currently marked unhealthy: ${CLAUDE_CAP_NOTE:-missing required capability state}"
        return 2
    fi

    if [ "$COMMAND_TIMEOUT_SECONDS" -gt 0 ]; then
        timeout_cmd="$(get_timeout_command)"
    fi

    probe_engine_capabilities

    if [ "$ACTIVE_ENGINE" = "codex" ]; then
        if ! is_true "$CODEX_CAP_OUTPUT_LAST_MESSAGE"; then
            err "Codex capability missing: --output-last-message is required."
            return 2
        fi

        engine_args=("$ACTIVE_CMD" "exec")
        [ -n "${CODEX_MODEL:-}" ] && engine_args+=("--model" "$CODEX_MODEL")
        
        if is_true "$yolo_effective" && is_true "$CODEX_CAP_YOLO_FLAG"; then
            engine_args+=("--dangerously-bypass-approvals-and-sandbox")
        fi
    else
        if ! is_true "$CLAUDE_CAP_PRINT"; then
            err "Claude capability missing: print mode is required."
            return 2
        fi

        engine_args=("$ACTIVE_CMD" "-p")
        [ -n "${CLAUDE_MODEL:-}" ] && engine_args+=("--model" "$CLAUDE_MODEL")
        
        if is_true "$yolo_effective"; then
            [ -n "$CLAUDE_CAP_YOLO_FLAG" ] && engine_args+=("$CLAUDE_CAP_YOLO_FLAG")
            yolo_prefix=("env" "IS_SANDBOX=1")
        fi
    fi

    local attempt=1
    local max_run_attempts="${RUN_AGENT_MAX_ATTEMPTS}"
    local retry_delay="${RUN_AGENT_RETRY_DELAY_SECONDS}"
    if ! is_number "$max_run_attempts" || [ "$max_run_attempts" -lt 1 ]; then
        max_run_attempts=3
    fi
    if ! is_number "$retry_delay" || [ "$retry_delay" -lt 0 ]; then
        retry_delay=5
    fi

    while [ "$attempt" -le "$max_run_attempts" ]; do
        info "Dispatching ${ACTIVE_ENGINE} for attempt ${attempt}/${max_run_attempts} (phase attempt ${attempt_no}) with prompt $(path_for_display "$prompt_file")."
        if [ "$ACTIVE_ENGINE" = "codex" ]; then
            if [ -n "$timeout_cmd" ]; then
                if is_true "$ENGINE_OUTPUT_TO_STDOUT"; then
                    if "$timeout_cmd" "$COMMAND_TIMEOUT_SECONDS" "${engine_args[@]}" - --output-last-message "$output_file" 2>&1 < "$prompt_file" | tee "$log_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                else
                    if "$timeout_cmd" "$COMMAND_TIMEOUT_SECONDS" "${engine_args[@]}" - --output-last-message "$output_file" >> "$log_file" 2>&1 < "$prompt_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                fi
            else
                if is_true "$ENGINE_OUTPUT_TO_STDOUT"; then
                    if "${engine_args[@]}" - --output-last-message "$output_file" 2>&1 < "$prompt_file" | tee "$log_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                else
                    if "${engine_args[@]}" - --output-last-message "$output_file" >> "$log_file" 2>&1 < "$prompt_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                fi
            fi
        else
            if [ -n "$timeout_cmd" ]; then
                if is_true "$ENGINE_OUTPUT_TO_STDOUT"; then
                    if "$timeout_cmd" "$COMMAND_TIMEOUT_SECONDS" "${yolo_prefix[@]+"${yolo_prefix[@]}"}" "${engine_args[@]}" - 2>>"$log_file" < "$prompt_file" | tee "$output_file" >> "$log_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                else
                    if "$timeout_cmd" "$COMMAND_TIMEOUT_SECONDS" "${yolo_prefix[@]+"${yolo_prefix[@]}"}" "${engine_args[@]}" - > "$output_file" 2>>"$log_file" < "$prompt_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                fi
            else
                if is_true "$ENGINE_OUTPUT_TO_STDOUT"; then
                    if "${yolo_prefix[@]+"${yolo_prefix[@]}"}" "${engine_args[@]}" - 2>>"$log_file" < "$prompt_file" | tee "$output_file" >> "$log_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                else
                    if "${yolo_prefix[@]+"${yolo_prefix[@]}"}" "${engine_args[@]}" - > "$output_file" 2>>"$log_file" < "$prompt_file"; then
                        exit_code=0
                    else
                        exit_code=$?
                    fi
                fi
            fi
        fi
        if [ "$exit_code" -eq 0 ]; then
            charge_session_budget "$(estimate_run_tokens "$prompt_file" "$log_file" "$output_file")"
            if ! enforce_session_budget "agent attempt"; then
                return 1
            fi
            break
        fi
        charge_session_budget "$(estimate_run_tokens "$prompt_file" "$log_file" "$output_file")"
        if ! enforce_session_budget "agent attempt"; then
            return 1
        fi
        
        local hiccup_detected=false
        local permanent_failure=false
        if grep -qiE "backend error|token error|timeout|connection refused|overloaded|rate.?limit|503|502|429|ECONNRESET|ETIMEDOUT" "$log_file" 2>/dev/null; then
            hiccup_detected=true
        elif [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ] || [ "$exit_code" -eq 143 ]; then
            # 124=timeout, 137=SIGKILL, 143=SIGTERM
            hiccup_detected=true
        elif [ "$exit_code" -ne 0 ]; then
            # Check for permanent failures that should NOT be retried
            if grep -qiE "invalid.*api.?key|authentication.*failed|permission.*denied|model.*not.*found|insufficient.*quota" "$log_file" 2>/dev/null; then
                permanent_failure=true
            else
                # Default: treat unknown non-zero exits as transient (agent crash, OOM, etc.)
                hiccup_detected=true
            fi
        fi

        if is_true "$permanent_failure"; then
            warn "Permanent failure detected on attempt $attempt/$max_run_attempts. Not retrying."
            break
        fi

        if is_true "$hiccup_detected" && [ "$attempt" -lt "$max_run_attempts" ]; then
            # Exponential backoff with jitter: base_delay * 2^(attempt-1) + random(0..base_delay)
            local backoff_delay jitter
            backoff_delay=$((retry_delay * (1 << (attempt - 1))))
            # Cap at 120 seconds
            [ "$backoff_delay" -gt 120 ] && backoff_delay=120
            # Add jitter: 0 to retry_delay seconds (use RANDOM if available, else 0)
            jitter=$(( ${RANDOM:-0} % (retry_delay + 1) ))
            backoff_delay=$((backoff_delay + jitter))
            if is_true "$RUN_AGENT_RETRY_VERBOSE"; then
                warn "Inference hiccup detected (exit=$exit_code) on attempt $attempt/$max_run_attempts. Retrying in ${backoff_delay}s..."
            fi
            sleep "$backoff_delay"
            attempt=$((attempt + 1))
            continue
        fi
        break
    done

    if [ "$exit_code" -ne 0 ]; then
        log_reason_code "RB_RUN_AGENT_RETRY_EXHAUSTED" "run_agent exceeded ${max_run_attempts} attempts for $(path_for_display "$prompt_file") with last_exit=$exit_code"
    fi

    return "$exit_code"
}

consensus_reviewer_persona() {
    local stage="${1:-plan}"
    local reviewer_index="${2:-1}"
    local normalized_index

    is_number "$reviewer_index" || reviewer_index=1
    normalized_index=$(( (reviewer_index - 1) % 6 ))
    if [ "$normalized_index" -lt 0 ]; then
        normalized_index=0
    fi

    case "$normalized_index" in
        0) echo "Architect: validate scope integrity, assumptions, and future maintainability for ${stage}." ;;
        1) echo "Skeptic: challenge edge cases, hidden risks, and silent failure modes in ${stage}." ;;
        2) echo "Execution Reviewer: verify concrete evidence and artifact completeness from this attempt." ;;
        3) echo "Safety Reviewer: enforce policy compliance, guardrails, and regression risk containment." ;;
        4) echo "Operations Reviewer: focus on operational impact, deployment readiness, and reversibility." ;;
        5) echo "Quality Reviewer: prioritize signal quality, confidence, and decision consistency." ;;
    esac
}

run_swarm_reviewer() {
    local reviewer_index="$1"
    local prompt_file="$2"
    local log_file="$3"
    local output_file="$4"
    local status_file="$5"
    local primary_cmd="$6"
    local fallback_cmd="$7"

    local -a candidate_cmds=("$primary_cmd")
    [ -n "$fallback_cmd" ] && [ "$fallback_cmd" != "$primary_cmd" ] && candidate_cmds+=("$fallback_cmd")

    rm -f "$status_file"
    local attempt_cmd
    local attempt_exit=1
    local used_cmd="${primary_cmd}"
    ACTIVE_ENGINE="unknown"
    ACTIVE_CMD=""

    for attempt_cmd in "${candidate_cmds[@]}"; do
        [ -n "$attempt_cmd" ] || continue
        if [ "$attempt_cmd" = "$CODEX_CMD" ] && [ "$CODEX_HEALTHY" != "true" ]; then
            continue
        fi
        if [ "$attempt_cmd" = "$CLAUDE_CMD" ] && [ "$CLAUDE_HEALTHY" != "true" ]; then
            continue
        fi
        command -v "$attempt_cmd" >/dev/null 2>&1 || continue

        if [[ "$attempt_cmd" == *"codex"* ]]; then
            ACTIVE_ENGINE="codex"
        else
            ACTIVE_ENGINE="claude"
        fi
        ACTIVE_CMD="$attempt_cmd"
        used_cmd="$attempt_cmd"

        if run_agent_with_prompt "$prompt_file" "$log_file" "$output_file" "false" "$reviewer_index"; then
            attempt_exit=0
            break
        fi
    done

    {
        echo "reviewer_index=$reviewer_index"
        echo "engine=${ACTIVE_ENGINE:-unknown}"
        echo "command=$used_cmd"
        if [ "$attempt_exit" -eq 0 ]; then
            echo "status=success"
            echo "exit_code=0"
        else
            echo "status=failure"
            echo "exit_code=1"
        fi
    } > "$status_file"
    return "$attempt_exit"
}

run_swarm_consensus() {
    local stage="$1"
    local history_context="${2:-}"
    local count="$(get_reviewer_count)"
    local parallel="$(get_parallel_reviewer_count)"
    local base_stage="${stage%-gate}"
    local default_next_phase
    local next_phase_vote_plan=0
    local next_phase_vote_build=0
    local next_phase_vote_test=0
    local next_phase_vote_refactor=0
    local next_phase_vote_lint=0
    local next_phase_vote_document=0
    local next_phase_vote_done=0
    local total_next_votes=0

    # Preserve global engine state before swarm (reviewers run in subshells
    # but run_swarm_reviewer also modifies globals in the parent fallback path)
    local saved_engine="$ACTIVE_ENGINE"
    local saved_cmd="$ACTIVE_CMD"

    default_next_phase="$(phase_default_next "$base_stage")"
    info "Running deep consensus swarm for '$stage'..."
    local consensus_dir="$CONSENSUS_DIR/$stage/$SESSION_ID"
    LAST_CONSENSUS_DIR="$consensus_dir"
    LAST_CONSENSUS_SUMMARY=""
    LAST_CONSENSUS_NEXT_PHASE="$default_next_phase"
    LAST_CONSENSUS_NEXT_PHASE_REASON="insufficient consensus responses"
    LAST_CONSENSUS_RESPONDED_VOTES=0
    mkdir -p "$consensus_dir"

    local -a prompts=() logs=() outputs=() status_files=()
    local -a primary_cmds=() fallback_cmds=() summary_lines=()
    local claude_available=false
    local codex_available=false
    if [ "$CODEX_HEALTHY" = "true" ] && command -v "$CODEX_CMD" >/dev/null 2>&1; then
        codex_available=true
    fi
    if [ "$CLAUDE_HEALTHY" = "true" ] && command -v "$CLAUDE_CMD" >/dev/null 2>&1; then
        claude_available=true
    fi
    if [ "$claude_available" = false ] && [ "$codex_available" = false ]; then
        warn "No healthy reviewer engines available for consensus."
        LAST_CONSENSUS_SCORE=0
        LAST_CONSENSUS_PASS=false
        LAST_CONSENSUS_NEXT_PHASE="$default_next_phase"
        LAST_CONSENSUS_NEXT_PHASE_REASON="no healthy reviewer engines available"
        LAST_CONSENSUS_RESPONDED_VOTES=0
        ACTIVE_ENGINE="$saved_engine"
        ACTIVE_CMD="$saved_cmd"
        return 1
    fi

    local i
    for i in $(seq 1 "$count"); do
        local primary_cmd="$CLAUDE_CMD"
        local fallback_cmd=""

        if [ "$claude_available" = false ] && [ "$codex_available" = true ]; then
            primary_cmd="$CODEX_CMD"
        elif [ "$claude_available" = true ] && [ "$codex_available" = true ] && [ $(( (i - 1) % 2 )) -eq 0 ]; then
            primary_cmd="$CODEX_CMD"
        fi

        if [ "$primary_cmd" = "$CODEX_CMD" ] && [ "$claude_available" = true ]; then
            fallback_cmd="$CLAUDE_CMD"
        fi
        if [ "$primary_cmd" = "$CLAUDE_CMD" ] && [ "$codex_available" = true ]; then
            fallback_cmd="$CODEX_CMD"
        fi

        prompts+=("$consensus_dir/reviewer_${i}_prompt.md")
        logs+=("$consensus_dir/reviewer_${i}.log")
        outputs+=("$consensus_dir/reviewer_${i}.out")
        status_files+=("$consensus_dir/reviewer_${i}.status")
        primary_cmds+=("$primary_cmd")
        fallback_cmds+=("$fallback_cmd")

        {
            echo "# Consensus Review: $stage"
            consensus_prompt_for_stage "$base_stage" "$history_context" "$(consensus_reviewer_persona "$base_stage" "$i")"
        } > "${prompts[$((i - 1))]}"
    done

    local active=0
    for i in $(seq 0 $((count - 1))); do
        (
            run_swarm_reviewer \
                "$((i + 1))" \
                "${prompts[$i]}" \
                "${logs[$i]}" \
                "${outputs[$i]}" \
                "${status_files[$i]}" \
                "${primary_cmds[$i]}" \
                "${fallback_cmds[$i]}"
        ) &
        RALPHIE_BG_PIDS+=($!)
        active=$((active + 1))
        if [ "$active" -ge "$parallel" ] || [ "$i" -eq $((count - 1)) ]; then
            # wait -n requires Bash 4.3+; use portable fallback
            if [ "${BASH_VERSINFO[0]:-3}" -gt 4 ] || { [ "${BASH_VERSINFO[0]:-3}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 3 ]; }; then
                wait -n 2>/dev/null || true
            else
                # Portable: poll only swarm PIDs until at least one finishes
                while true; do
                    local __alive=0
                    for __pid in "${RALPHIE_BG_PIDS[@]+"${RALPHIE_BG_PIDS[@]}"}"; do
                        kill -0 "$__pid" 2>/dev/null && __alive=$((__alive + 1))
                    done
                    [ "$__alive" -lt "$active" ] && break
                    sleep 0.2 2>/dev/null || sleep 1
                done
            fi
            active=$((active - 1))
        fi
    done
    # Wait for all reviewers with a safety timeout to prevent infinite hangs
    local swarm_timeout="${SWARM_CONSENSUS_TIMEOUT:-600}"
    local swarm_start swarm_elapsed
    swarm_start="$(date +%s)"
    local swarm_timed_out=false
    while true; do
        local running_jobs=0
        local __active_jobs=()
            for __pid in "${RALPHIE_BG_PIDS[@]+"${RALPHIE_BG_PIDS[@]}"}"; do
                if kill -0 "$__pid" 2>/dev/null; then
                    __active_jobs+=("$__pid")
                    running_jobs=$((running_jobs + 1))
                fi
            done
            RALPHIE_BG_PIDS=("${__active_jobs[@]+"${__active_jobs[@]}"}")
            [ "${running_jobs:-0}" -eq 0 ] && break
            swarm_elapsed=$(( $(date +%s) - swarm_start ))
            if [ "$swarm_elapsed" -ge "$swarm_timeout" ]; then
                warn "Swarm consensus timeout after ${swarm_timeout}s. Killing hung reviewers."
                swarm_timed_out=true
                for pid in "${RALPHIE_BG_PIDS[@]+"${RALPHIE_BG_PIDS[@]}"}"; do
                    kill -TERM "$pid" 2>/dev/null || true
                done
                sleep 2
                for pid in "${RALPHIE_BG_PIDS[@]+"${RALPHIE_BG_PIDS[@]}"}"; do
                    kill -KILL "$pid" 2>/dev/null || true
                done
                break
            fi
        sleep 1
    done
    wait 2>/dev/null || true
    # Clean PID registry to prevent stale accumulation
    RALPHIE_BG_PIDS=()

    local total_score=0
    local go_votes=0
    local responded_votes=0
    local required_votes=$((count / 2 + 1))
    local avg_score=0
    local next_phase_vote_reason=""

    local idx=0
    local status_file status engine verdict score verdict_gaps next_phase next_phase_reason
    local recommended_next="$default_next_phase"
    local highest_next_votes=0
    local candidate_votes=0
    for ofile in "${outputs[@]}"; do
        status="failure"
        engine="unknown"
        verdict="HOLD"
        score="0"
        verdict_gaps="no explicit gaps"
        next_phase="$default_next_phase"
        next_phase_reason=""

        status_file="${status_files[$idx]}"
        if [ -f "$status_file" ]; then
            status="$(grep -E "^status=" "$status_file" | head -n 1 | cut -d'=' -f2-)"
            engine="$(grep -E "^engine=" "$status_file" | head -n 1 | cut -d'=' -f2-)"
            [ "$status" = "success" ] || status="failure"
        fi

        if [ -f "$ofile" ]; then
            score="$(grep -oE "<score>[0-9]{1,3}</score>" "$ofile" | sed 's/[^0-9]//g' | tail -n 1)"
            is_number "$score" || score="0"
            if grep -qE "<verdict>(GO|HOLD)</verdict>" "$ofile" 2>/dev/null; then
                verdict="$(grep -oE "<verdict>(GO|HOLD)</verdict>" "$ofile" | tail -n 1 | sed -E 's/<\/?verdict>//g' )"
            elif grep -qE "<decision>(GO|HOLD)</decision>" "$ofile" 2>/dev/null; then
                verdict="$(grep -oE "<decision>(GO|HOLD)</decision>" "$ofile" | tail -n 1 | sed -E 's/<\/?decision>//g' )"
            else
                verdict="HOLD"
            fi

            next_phase="$(extract_xml_value "$ofile" "next_phase" "$default_next_phase")"
            next_phase="$(normalize_next_phase_recommendation "$next_phase" "$base_stage" "$default_next_phase")"
            next_phase_reason="$(extract_xml_value "$ofile" "next_phase_reason" "")"
            if grep -q "<gaps>" "$ofile" 2>/dev/null; then
                verdict_gaps="$(sed -n 's/.*<gaps>\(.*\)<\/gaps>.*/\1/p' "$ofile" | head -n 1)"
            fi
            verdict_gaps="$(echo "$verdict_gaps" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c 1-180)"
            [ -n "$next_phase_reason" ] || next_phase_reason="no explicit phase-routing rationale"
        else
            verdict_gaps="no output artifact"
            next_phase_reason="no output artifact"
        fi

        [ "$status" = "success" ] && responded_votes=$((responded_votes + 1))
        [ "$status" = "success" ] && total_score=$((total_score + score))
        if [ "$status" = "success" ] && is_phase_or_done "$next_phase"; then
            total_next_votes=$((total_next_votes + 1))
            case "$next_phase" in
                plan) next_phase_vote_plan=$((next_phase_vote_plan + 1)) ;;
                build) next_phase_vote_build=$((next_phase_vote_build + 1)) ;;
                test) next_phase_vote_test=$((next_phase_vote_test + 1)) ;;
                refactor) next_phase_vote_refactor=$((next_phase_vote_refactor + 1)) ;;
                lint) next_phase_vote_lint=$((next_phase_vote_lint + 1)) ;;
                document) next_phase_vote_document=$((next_phase_vote_document + 1)) ;;
                done) next_phase_vote_done=$((next_phase_vote_done + 1)) ;;
            esac
            if [ -z "$next_phase_vote_reason" ] && [ -n "$next_phase_reason" ]; then
                next_phase_vote_reason="$next_phase_reason"
            fi
        fi

        [ "$verdict" = "GO" ] && go_votes=$((go_votes + 1))
        summary_lines+=("reviewer_$((idx + 1)):engine=$engine status=$status score=$score verdict=$verdict next=$next_phase reason=$next_phase_reason gaps=$verdict_gaps")
        idx=$((idx + 1))
    done

    if [ "$responded_votes" -gt 0 ]; then
        avg_score=$((total_score / responded_votes))
    fi

    if [ "$total_next_votes" -gt 0 ]; then
        candidate_votes="$next_phase_vote_plan"
        if [ "$candidate_votes" -gt "$highest_next_votes" ]; then
            highest_next_votes="$candidate_votes"
            recommended_next="plan"
        fi
        candidate_votes="$next_phase_vote_build"
        if [ "$candidate_votes" -gt "$highest_next_votes" ]; then
            highest_next_votes="$candidate_votes"
            recommended_next="build"
        fi
        candidate_votes="$next_phase_vote_test"
        if [ "$candidate_votes" -gt "$highest_next_votes" ]; then
            highest_next_votes="$candidate_votes"
            recommended_next="test"
        fi
        candidate_votes="$next_phase_vote_refactor"
        if [ "$candidate_votes" -gt "$highest_next_votes" ]; then
            highest_next_votes="$candidate_votes"
            recommended_next="refactor"
        fi
        candidate_votes="$next_phase_vote_lint"
        if [ "$candidate_votes" -gt "$highest_next_votes" ]; then
            highest_next_votes="$candidate_votes"
            recommended_next="lint"
        fi
        candidate_votes="$next_phase_vote_document"
        if [ "$candidate_votes" -gt "$highest_next_votes" ]; then
            highest_next_votes="$candidate_votes"
            recommended_next="document"
        fi
        candidate_votes="$next_phase_vote_done"
        if [ "$candidate_votes" -gt "$highest_next_votes" ]; then
            highest_next_votes="$candidate_votes"
            recommended_next="done"
        fi
    fi

    LAST_CONSENSUS_NEXT_PHASE="$recommended_next"
    [ -n "$next_phase_vote_reason" ] || next_phase_vote_reason="no explicit routing rationale"
    LAST_CONSENSUS_NEXT_PHASE_REASON="$next_phase_vote_reason"
    LAST_CONSENSUS_RESPONDED_VOTES="$responded_votes"
    LAST_CONSENSUS_SCORE="$avg_score"
    LAST_CONSENSUS_SUMMARY="$(printf '%s; ' "${summary_lines[@]}")"
    if [ "$responded_votes" -ge "$required_votes" ] && [ "$go_votes" -ge "$required_votes" ] && [ "$avg_score" -ge 70 ]; then
        LAST_CONSENSUS_PASS=true
        ACTIVE_ENGINE="$saved_engine"
        ACTIVE_CMD="$saved_cmd"
        return 0
    fi
    LAST_CONSENSUS_PASS=false
    ACTIVE_ENGINE="$saved_engine"
    ACTIVE_CMD="$saved_cmd"
    return 1
}

write_handoff_validation_prompt() {
    local phase="$1"
    local attempt="$2"
    local output_file="$3"
    local log_file="$4"
    local prompt_file="$5"
    local manifest_before_file="$6"
    local manifest_after_file="$7"
    local delta_preview="$8"
    local noop_policy="$9"
    local warning_text="${10}"
    local previous_output="${11}"

    local prior_output_display="none"
    [ -f "$previous_output" ] && prior_output_display="$(path_for_display "$previous_output")"

    {
        echo "# Handoff Validation Prompt"
        echo ""
        echo "You are the on-rail handoff validator."
        echo "Phase: $phase"
        echo "Attempt: $attempt"
        echo "Session: $SESSION_ID"
        echo "Iteration: $ITERATION_COUNT"
        echo "Handoff policy: $noop_policy"
        echo "Execution output: $(path_for_display "$output_file")"
        echo "Execution log: $(path_for_display "$log_file")"
        echo "Previous output: $prior_output_display"
        echo "Manifest before: $(path_for_display "$manifest_before_file")"
        echo "Manifest after: $(path_for_display "$manifest_after_file")"
        echo "Delta preview:"
        if [ -n "$delta_preview" ]; then
            echo "$delta_preview" | sed 's/^/- /'
        else
            echo "- no visible delta preview"
        fi
        echo ""
        echo "Recent warnings:"
        if [ -n "$warning_text" ]; then
            printf '%s\n' "$warning_text" | sed 's/^/- /'
        else
            echo "- none"
        fi
        echo ""
        echo "Rules:"
        echo "- Confirm execution output indicates concrete artifact progress for this phase."
        echo "- Confirm handoff artifacts are coherent and transition intent is explicit."
        echo "- Confirm no policy blockers are hidden."
        echo "- Emit machine-readable signal:"
    echo "  <score>0-100</score>"
    echo "  <verdict>GO|HOLD</verdict>"
    echo "  <gaps>comma-separated blockers or none</gaps>"

    if [ -f "$previous_output" ]; then
        echo "Previous handoff output snippet:"
        sed -n '1,40p' "$previous_output"
    fi

    echo "Current execution output snippet:"
    if [ -f "$output_file" ]; then
        sed -n '1,80p' "$output_file"
    else
        echo "- not available"
    fi

    echo "Current execution log tail:"
    if [ -f "$log_file" ]; then
        tail -n 40 "$log_file"
    else
        echo "- not available"
    fi
    } > "$prompt_file"
}

read_handoff_review_output() {
    local output_file="$1"
    local score=0
    local verdict="HOLD"
    local gaps="no explicit gaps"

    LAST_HANDOFF_SCORE=0
    LAST_HANDOFF_VERDICT="HOLD"
    LAST_HANDOFF_GAPS="no explicit gaps"

    [ -f "$output_file" ] || return 0

    score="$(grep -oE "<score>[0-9]{1,3}</score>" "$output_file" | sed 's/[^0-9]//g' | tail -n 1)"
    is_number "$score" || score="0"

    if grep -qE "<verdict>(GO|HOLD)</verdict>" "$output_file" 2>/dev/null; then
        verdict="$(grep -oE "<verdict>(GO|HOLD)</verdict>" "$output_file" | tail -n 1 | sed -E 's/<\/?verdict>//g')"
    elif grep -qE "<decision>(GO|HOLD)</decision>" "$output_file" 2>/dev/null; then
        verdict="$(grep -oE "<decision>(GO|HOLD)</decision>" "$output_file" | tail -n 1 | sed -E 's/<\/?decision>//g')"
    fi

    if grep -q "<gaps>" "$output_file" 2>/dev/null; then
        gaps="$(sed -n 's/.*<gaps>\(.*\)<\/gaps>.*/\1/p' "$output_file" | head -n 1)"
    fi
    gaps="$(printf '%s' "$gaps" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c 1-180)"
    [ -z "$gaps" ] && gaps="no explicit gaps"

    LAST_HANDOFF_SCORE="$score"
    LAST_HANDOFF_VERDICT="$verdict"
    LAST_HANDOFF_GAPS="$gaps"
}

run_handoff_validation() {
    local phase="$1"
    local prompt_file="$2"
    local log_file="$3"
    local output_file="$4"
    local status_file="$5"
    local primary_cmd="${6:-}"
    local fallback_cmd="${7:-}"

    if [ ! -f "$prompt_file" ]; then
        err "Handoff validation prompt missing: $prompt_file"
        return 1
    fi

    # Preserve engine state — run_swarm_reviewer mutates ACTIVE_ENGINE/ACTIVE_CMD
    local saved_engine="$ACTIVE_ENGINE"
    local saved_cmd="$ACTIVE_CMD"

    run_swarm_reviewer \
        "handoff" \
        "$prompt_file" \
        "$log_file" \
        "$output_file" \
        "$status_file" \
        "$primary_cmd" \
        "$fallback_cmd"
    read_handoff_review_output "$output_file"

    # Restore engine state
    ACTIVE_ENGINE="$saved_engine"
    ACTIVE_CMD="$saved_cmd"

    local status="failure"
    if [ -f "$status_file" ]; then
        status="$(grep -E "^status=" "$status_file" | head -n 1 | cut -d'=' -f2-)"
        [ "$status" = "success" ] || status="failure"
    fi

    if [ "$status" = "success" ] && is_number "$LAST_HANDOFF_SCORE" && [ "$LAST_HANDOFF_SCORE" -ge 70 ] && [ "$LAST_HANDOFF_VERDICT" = "GO" ]; then
        return 0
    fi

    log_reason_code "RB_PHASE_HANDOFF_VALIDATOR_HOLD" "Handoff validation failed for $phase (score=${LAST_HANDOFF_SCORE}, verdict=${LAST_HANDOFF_VERDICT})"
    return 1
}

phase_capture_worktree_manifest() {
    local manifest_file="$1"
    [ -n "$manifest_file" ] || return 1
    : > "$manifest_file"

    if ! git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        return 1
    fi

    {
        git -C "$PROJECT_DIR" diff --name-status --cached -- . | sed 's/^/C /'
        git -C "$PROJECT_DIR" diff --name-status -- . | sed 's/^/W /'
        git -C "$PROJECT_DIR" ls-files --others --exclude-standard -- . | sed 's/^/U /'
    } | sort > "$manifest_file"
    return 0
}

phase_manifest_changed() {
    local before_file="$1"
    local after_file="$2"

    if [ ! -f "$before_file" ] || [ ! -f "$after_file" ]; then
        return 1
    fi

    if cmp -s "$before_file" "$after_file"; then
        return 1
    fi
    return 0
}

phase_noop_policy() {
    local phase="$1"
    case "$phase" in
        plan)
            echo "$PHASE_NOOP_POLICY_PLAN"
            ;;
        build)
            echo "$PHASE_NOOP_POLICY_BUILD"
            ;;
        test)
            if is_true "$STRICT_VALIDATION_NOOP"; then
                echo "hard"
            else
                echo "$PHASE_NOOP_POLICY_TEST"
            fi
            ;;
        refactor)
            echo "$PHASE_NOOP_POLICY_REFACTOR"
            ;;
        lint)
            if is_true "$STRICT_VALIDATION_NOOP"; then
                echo "hard"
            else
                echo "$PHASE_NOOP_POLICY_LINT"
            fi
            ;;
        document)
            echo "$PHASE_NOOP_POLICY_DOCUMENT"
            ;;
        *)
            echo "none"
            ;;
    esac
}

phase_manifest_delta_preview() {
    local before_file="$1"
    local after_file="$2"
    local lines_limit="${3:-8}"

    if [ ! -f "$before_file" ] || [ ! -f "$after_file" ]; then
        echo ""
        return 0
    fi

    comm -3 "$before_file" "$after_file" | sed 's/^[[:space:]]*//' | head -n "$lines_limit"
}

phase_index_from_name() {
    case "$1" in
        plan) echo 0; return 0 ;;
        build) echo 1; return 0 ;;
        test) echo 2; return 0 ;;
        refactor) echo 3; return 0 ;;
        lint) echo 4; return 0 ;;
        document) echo 5; return 0 ;;
        *) echo 0; return 1 ;;
    esac
}

phase_name_from_index() {
    local index="$1"
    if ! is_number "$index"; then
        echo ""
        return 1
    fi
    case "$index" in
        0) echo "plan"; return 0 ;;
        1) echo "build"; return 0 ;;
        2) echo "test"; return 0 ;;
        3) echo "refactor"; return 0 ;;
        4) echo "lint"; return 0 ;;
        5) echo "document"; return 0 ;;
        *) echo ""; return 1 ;;
    esac
}

phase_default_next() {
    local phase="$1"
    case "$phase" in
        plan) echo "build" ;;
        build) echo "test" ;;
        test) echo "refactor" ;;
        refactor) echo "lint" ;;
        lint) echo "document" ;;
        document) echo "done" ;;
        *) echo "done" ;;
    esac
}

phase_index_or_done() {
    case "$1" in
        plan) echo 0; return 0 ;;
        build) echo 1; return 0 ;;
        test) echo 2; return 0 ;;
        refactor) echo 3; return 0 ;;
        lint) echo 4; return 0 ;;
        document) echo 5; return 0 ;;
        done) echo 6; return 0 ;;
        *) echo -1; return 1 ;;
    esac
}

phase_transition_history_append() {
    local phase="${1:-}"
    local attempt="${2:-?}"
    local next_phase="${3:-$phase}"
    local outcome="${4:-hold}"
    local reason="${5:-no explicit rationale}"
    local normalized_reason

    if [ -z "$phase" ]; then
        return 0
    fi

    normalized_reason="$(printf '%s' "$reason" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | sed 's/^ *//; s/ *$//')"
    normalized_reason="${normalized_reason:-no explicit rationale}"
    PHASE_TRANSITION_HISTORY+=("${phase}(attempt ${attempt})->${next_phase}|${outcome}|${normalized_reason}")
}

phase_transition_history_recent() {
    local limit="${1:-8}"
    local start=0
    local i

    if [ "${#PHASE_TRANSITION_HISTORY[@]}" -eq 0 ]; then
        echo "no transitions yet"
        return 0
    fi

    if ! is_number "$limit" || [ "$limit" -lt 1 ]; then
        limit=8
    fi
    if [ "${#PHASE_TRANSITION_HISTORY[@]}" -gt "$limit" ]; then
        start=$(( ${#PHASE_TRANSITION_HISTORY[@]} - limit ))
    fi

    for (( i = start; i < ${#PHASE_TRANSITION_HISTORY[@]}; i++ )); do
        echo "${PHASE_TRANSITION_HISTORY[$i]}"
    done
}

collect_phase_resume_blockers() {
    local phase="$1"
    local -a blockers=()
    case "$phase" in
        plan)
            ;;
        build)
            mapfile -t blockers < <(collect_build_prerequisites_issues)
            ;;
        test|refactor|lint|document)
            if [ ! -f "$PLAN_FILE" ]; then
                blockers+=("test/build prerequisite missing: IMPLEMENTATION_PLAN.md")
            fi
            if [ ! -f "$STACK_SNAPSHOT_FILE" ]; then
                blockers+=("test/build prerequisite missing: research/STACK_SNAPSHOT.md")
            fi
            if [ -f "$PLAN_FILE" ] && ! plan_is_semantically_actionable "$PLAN_FILE"; then
                blockers+=("plan is not semantically actionable")
            fi
            ;;
        *)
            blockers+=("unknown phase '$phase'")
            ;;
    esac

    print_array_lines "${blockers[@]+"${blockers[@]}"}"
}

summarize_blocks_for_log() {
    local -a blockers=("$@")
    local idx=0
    local output=""
    local item
    for item in "${blockers[@]}"; do
        [ -z "$item" ] && continue
        if [ -z "$output" ]; then
            output="$item"
        else
            output="$output; $item"
        fi
    done
    printf '%s' "$output"
}

# Build gate and artifact validation
gitignore_required_entries() {
    cat <<'EOF'
.env
.env.*
logs/
consensus/
completion_log/
.ralphie/
HUMAN_INSTRUCTIONS.md
research/HUMAN_FEEDBACK.md
coverage/
.nyc_output/
htmlcov/
EOF
}

gitignore_missing_required_entries() {
    local gitignore_file="$PROJECT_DIR/.gitignore"
    local entry
    if [ ! -f "$gitignore_file" ]; then
        gitignore_required_entries
        return 0
    fi

    local required_entries
    required_entries="$(gitignore_required_entries)"
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        if ! grep -qxF "$entry" "$gitignore_file"; then
            echo "$entry"
        fi
    done <<< "$required_entries"
}

ensure_gitignore_guardrails() {
    local gitignore_file="$PROJECT_DIR/.gitignore"
    local required_entries
    required_entries="$(gitignore_required_entries)"

    mkdir -p "$(dirname "$gitignore_file")"
    touch "$gitignore_file"

    local added=false
    local entry
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        if ! grep -qxF "$entry" "$gitignore_file" 2>/dev/null; then
            echo "$entry" >> "$gitignore_file"
            added=true
        fi
    done <<< "$required_entries"

    if [ "$added" = true ]; then
        info "Updated .gitignore with required runtime-safety entries."
    fi
}

file_has_local_identity_leakage() {
    local candidate_file="$1"
    if [ ! -f "$candidate_file" ]; then
        return 1
    fi

    local home_dir
    home_dir="${HOME:-}"

    if [ -n "$home_dir" ] && grep -qF "$home_dir" "$candidate_file" 2>/dev/null; then
        return 0
    fi
    if grep -qiE '(/Users/[A-Za-z0-9._-]+/)|(/home/[A-Za-z0-9._-]+/)|(/root/[A-Za-z0-9._-]+/)' "$candidate_file" 2>/dev/null; then
        return 0
    fi
    return 1
}

markdown_artifacts_are_clean() {
    local leakage_pattern='succeeded in [0-9]+ms:|assistant[[:space:]]+to=|recipient_name[[:space:]]*:|tokens used|mcp startup:'
    local file bad=0
    local files=()

    [ -f "$PLAN_FILE" ] && files+=("$PLAN_FILE")
    [ -f "$PROJECT_DIR/README.md" ] && files+=("$PROJECT_DIR/README.md")

    local research_files spec_files
    research_files="$(find "$RESEARCH_DIR" -maxdepth 2 -type f -name "*.md" 2>/dev/null || true)"
    while IFS= read -r file; do
        [ -n "$file" ] && files+=("$file")
    done <<< "$research_files"

    spec_files="$(find "$SPECS_DIR" -maxdepth 3 -type f -name "*.md" 2>/dev/null || true)"
    while IFS= read -r file; do
        [ -n "$file" ] && files+=("$file")
    done <<< "$spec_files"

    for file in "${files[@]}"; do
        [ -f "$file" ] || continue
        if grep -qiE "$leakage_pattern" "$file" 2>/dev/null; then
            warn "Detected tool transcript leakage in markdown artifact: $(path_for_display "$file")"
            bad=1
        fi
        if file_has_local_identity_leakage "$file"; then
            warn "Detected local identity/path leakage in markdown artifact: $(path_for_display "$file")"
            bad=1
        fi
    done

    [ "$bad" -eq 0 ]
}

sanitize_markdown_artifact_file() {
    local file="$1"
    [ -f "$file" ] || return 0

    local tmp_file
    tmp_file="$(mktemp "$CONFIG_DIR/markdown-clean.XXXXXX")"

    if awk '
        $0 ~ /succeeded in [0-9]+ms:/ || $0 ~ /assistant[[:space:]]+to=/ || $0 ~ /recipient_name[[:space:]]*:/ || $0 ~ /tokens used/ || $0 ~ /mcp startup:/ || $0 ~ /\/Users\/[A-Za-z0-9._-]+\// || $0 ~ /\/root\/[A-Za-z0-9._-]+\// || $0 ~ /\/home\/[A-Za-z0-9._-]+\//
        { next }
        { print }
    ' "$file" > "$tmp_file"; then
        if ! cmp -s "$file" "$tmp_file"; then
            mv "$tmp_file" "$file"
            MARKDOWN_ARTIFACTS_CLEANED_LIST="${MARKDOWN_ARTIFACTS_CLEANED_LIST}${MARKDOWN_ARTIFACTS_CLEANED_LIST:+$'\n'}$(path_for_display "$file")"
            return 0
        fi
        rm -f "$tmp_file"
    else
        rm -f "$tmp_file"
        return 1
    fi
}

sanitize_markdown_artifacts() {
    MARKDOWN_ARTIFACTS_CLEANED_LIST=""
    local file
    local -a targets=("$PLAN_FILE" "$PROJECT_DIR/README.md")

    if [ -d "$RESEARCH_DIR" ]; then
        while IFS= read -r -d '' file; do
            targets+=("$file")
        done < <(find "$RESEARCH_DIR" -maxdepth 3 -type f -name "*.md" -print0)
    fi

    if [ -d "$SPECS_DIR" ]; then
        while IFS= read -r -d '' file; do
            targets+=("$file")
        done < <(find "$SPECS_DIR" -maxdepth 4 -type f -name "*.md" -print0)
    fi

    for file in "${targets[@]}"; do
        [ -f "$file" ] || continue
        sanitize_markdown_artifact_file "$file" || true
    done

    [ -n "$MARKDOWN_ARTIFACTS_CLEANED_LIST" ]
}

markdown_artifact_cleanup_summary() {
    printf '%s' "$MARKDOWN_ARTIFACTS_CLEANED_LIST"
}

stack_primary_from_snapshot() {
    if [ ! -f "$STACK_SNAPSHOT_FILE" ]; then
        echo "Unknown"
        return 0
    fi

    local primary
    primary="$(awk -F': ' '/^[[:space:]]*-?[[:space:]]*primary_stack:/ { gsub(/^[[:space:]]*-?[[:space:]]*primary_stack:[[:space:]]*/, "", $0); print $0; exit }' "$STACK_SNAPSHOT_FILE")"
    primary="${primary:-Unknown}"
    echo "$primary"
}

join_with_commas() {
    local -a items=("$@")
    local IFS=", "
    if [ "${#items[@]}" -eq 0 ]; then
        echo "-"
        return 0
    fi
    echo "${items[*]}"
}

stack_confidence_label() {
    local score="$1"
    if [ "$score" -ge 80 ]; then
        echo "high"
    elif [ "$score" -ge 60 ]; then
        echo "medium"
    elif [ "$score" -ge 35 ]; then
        echo "low"
    else
        echo "very_low"
    fi
}

run_stack_discovery() {
    mkdir -p "$RESEARCH_DIR"
    info "Running deterministic stack discovery scan."

    local pyproject_hits
    local -a node_signal=()
    local -a python_signal=()
    local -a go_signal=()
    local -a rust_signal=()
    local -a java_signal=()
    local -a dotnet_signal=()
    local -a unknown_signal=()
    local node_score=0 python_score=0 go_score=0
    local rust_score=0 java_score=0 dotnet_score=0 unknown_score=0

    local ts_count go_count java_count cs_count py_count rb_count rs_count js_count
    pyproject_hits="$(find "$PROJECT_DIR" -maxdepth 2 -type f \( -name "*.py" -o -name "*.pyi" -o -name "requirements*.txt" \) 2>/dev/null | wc -l | tr -d ' ')"
    ts_count="$(find "$PROJECT_DIR" -maxdepth 3 -type f -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')"
    go_count="$(find "$PROJECT_DIR" -maxdepth 3 -type f -name "*.go" 2>/dev/null | wc -l | tr -d ' ')"
    java_count="$(find "$PROJECT_DIR" -maxdepth 3 -type f \( -name "*.java" -o -name "*.kt" -o -name "*.gradle" -o -name "*.gradle.kts" \) 2>/dev/null | wc -l | tr -d ' ')"
    cs_count="$(find "$PROJECT_DIR" -maxdepth 3 -type f -name "*.csproj" 2>/dev/null | wc -l | tr -d ' ')"
    rs_count="$(find "$PROJECT_DIR" -maxdepth 3 -type f -name "*.rs" 2>/dev/null | wc -l | tr -d ' ')"
    rb_count="$(find "$PROJECT_DIR" -maxdepth 3 -type f -name "*.rb" 2>/dev/null | wc -l | tr -d ' ')"
    js_count="$(find "$PROJECT_DIR" -maxdepth 3 -type f -name "*.js" 2>/dev/null | wc -l | tr -d ' ')"

    # Node / JS / TS
    [ -f "$PROJECT_DIR/package.json" ] && { node_score=$((node_score + 55)); node_signal+=("package.json"); }
    [ -f "$PROJECT_DIR/package-lock.json" ] && { node_score=$((node_score + 10)); node_signal+=("package-lock.json"); }
    [ -f "$PROJECT_DIR/pnpm-lock.yaml" ] && { node_score=$((node_score + 10)); node_signal+=("pnpm-lock.yaml"); }
    [ -f "$PROJECT_DIR/yarn.lock" ] && { node_score=$((node_score + 10)); node_signal+=("yarn.lock"); }
    [ -f "$PROJECT_DIR/tsconfig.json" ] && { node_score=$((node_score + 12)); node_signal+=("tsconfig.json"); }
    [ -d "$PROJECT_DIR/node_modules" ] && { node_score=$((node_score + 3)); node_signal+=("node_modules"); }
    if is_number "$ts_count" && [ "$ts_count" -gt 0 ]; then node_score=$((node_score + 10)); node_signal+=("${ts_count} TS files"); fi
    if is_number "$js_count" && [ "$js_count" -gt 0 ]; then node_score=$((node_score + 8)); node_signal+=("${js_count} JS files"); fi

    # Python
    [ -f "$PROJECT_DIR/pyproject.toml" ] && { python_score=$((python_score + 60)); python_signal+=("pyproject.toml"); }
    [ -f "$PROJECT_DIR/requirements.txt" ] && { python_score=$((python_score + 20)); python_signal+=("requirements.txt"); }
    [ -f "$PROJECT_DIR/requirements-dev.txt" ] && { python_score=$((python_score + 10)); python_signal+=("requirements-dev.txt"); }
    [ -f "$PROJECT_DIR/setup.py" ] && { python_score=$((python_score + 15)); python_signal+=("setup.py"); }
    [ -f "$PROJECT_DIR/Pipfile" ] && { python_score=$((python_score + 10)); python_signal+=("Pipfile"); }
    if is_number "$pyproject_hits" && [ "$pyproject_hits" -gt 0 ]; then python_score=$((python_score + 8)); python_signal+=("${pyproject_hits} python manifest/files"); fi

    # Go
    [ -f "$PROJECT_DIR/go.mod" ] && { go_score=$((go_score + 70)); go_signal+=("go.mod"); }
    [ -f "$PROJECT_DIR/go.sum" ] && { go_score=$((go_score + 15)); go_signal+=("go.sum"); }
    if is_number "$go_count" && [ "$go_count" -gt 0 ]; then go_score=$((go_score + 10)); go_signal+=("${go_count} Go files"); fi

    # Rust
    [ -f "$PROJECT_DIR/Cargo.toml" ] && { rust_score=$((rust_score + 80)); rust_signal+=("Cargo.toml"); }
    [ -f "$PROJECT_DIR/Cargo.lock" ] && { rust_score=$((rust_score + 12)); rust_signal+=("Cargo.lock"); }
    if is_number "$rs_count" && [ "$rs_count" -gt 0 ]; then rust_score=$((rust_score + 10)); rust_signal+=("${rs_count} Rust files"); fi

    # Java / JVM
    [ -f "$PROJECT_DIR/pom.xml" ] && { java_score=$((java_score + 50)); java_signal+=("pom.xml"); }
    [ -f "$PROJECT_DIR/build.gradle" ] && { java_score=$((java_score + 35)); java_signal+=("build.gradle"); }
    [ -f "$PROJECT_DIR/build.gradle.kts" ] && { java_score=$((java_score + 35)); java_signal+=("build.gradle.kts"); }
    if is_number "$java_count" && [ "$java_count" -gt 0 ]; then java_score=$((java_score + 8)); java_signal+=("${java_count} JVM files"); fi

    # .NET
    [ -f "$PROJECT_DIR/Directory.Build.props" ] && { dotnet_score=$((dotnet_score + 35)); dotnet_signal+=("Directory.Build.props"); }
    if is_number "$cs_count" && [ "$cs_count" -gt 0 ]; then dotnet_score=$((dotnet_score + 12)); dotnet_signal+=("${cs_count} csproj files"); fi

    # Ruby
    [ -f "$PROJECT_DIR/Gemfile" ] && { unknown_score=$((unknown_score + 10)); unknown_signal+=("Gemfile"); }
    if is_number "$rb_count" && [ "$rb_count" -gt 0 ]; then unknown_score=$((unknown_score + 4)); unknown_signal+=("${rb_count} Ruby files"); fi

    local ranking_file
    ranking_file="$(mktemp "$CONFIG_DIR/stack-ranking.XXXXXX")"
    printf "%03d|Node.js|%s\n" "$node_score" "$(join_with_commas "${node_signal[@]}")" >> "$ranking_file"
    printf "%03d|Python|%s\n" "$python_score" "$(join_with_commas "${python_signal[@]}")" >> "$ranking_file"
    printf "%03d|Go|%s\n" "$go_score" "$(join_with_commas "${go_signal[@]}")" >> "$ranking_file"
    printf "%03d|Rust|%s\n" "$rust_score" "$(join_with_commas "${rust_signal[@]}")" >> "$ranking_file"
    printf "%03d|Java|%s\n" "$java_score" "$(join_with_commas "${java_signal[@]}")" >> "$ranking_file"
    printf "%03d|.NET|%s\n" "$dotnet_score" "$(join_with_commas "${dotnet_signal[@]}")" >> "$ranking_file"
    printf "%03d|Ruby|%s\n" "$unknown_score" "$(join_with_commas "${unknown_signal[@]}")" >> "$ranking_file"
    printf "%03d|Unknown|-\n" "$unknown_score" >> "$ranking_file"

    local -a ranked_candidates=()
    while IFS='|' read -r candidate_score candidate_stack candidate_signal; do
        ranked_candidates+=( "$candidate_score|$candidate_stack|$candidate_signal" )
    done < <(sort -t'|' -k1,1nr "$ranking_file")

    rm -f "$ranking_file"

    local primary_candidate primary_score primary_signal
    primary_candidate="Unknown"
    primary_score=0
    primary_signal="-"
    if [ "${#ranked_candidates[@]}" -gt 0 ]; then
        IFS='|' read -r primary_score primary_candidate primary_signal <<< "${ranked_candidates[0]}"
    fi

    local primary_confidence
    primary_confidence="$(stack_confidence_label "$primary_score")"
    if ! is_number "$primary_score"; then primary_score=0; fi

    {
        echo "# Stack Snapshot"
        echo ""
        echo "- generated_at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        echo "- project_root: ."
        echo "- primary_stack: $primary_candidate"
        echo "- primary_score: $primary_score/100"
        echo "- confidence: $primary_confidence"
        echo ""
        echo "## Project Stack Ranking"
        echo ""
        echo "| rank | stack | score | evidence |"
        echo "| --- | --- | --- | --- |"
        local idx=1
        for entry in "${ranked_candidates[@]}"; do
            if [ -z "$entry" ]; then
                continue
            fi
            IFS='|' read -r score stack evidence <<< "$entry"
            echo "| $idx | $stack | $score | $evidence |"
            idx=$((idx + 1))
        done
        echo ""
        echo "## Deterministic Alternatives Ranking"
        echo "- Candidate evaluation is based on repository-level manifest and source signals only."
        echo "- Primary decision rule: highest score, then explicit manifest precedence."
        echo ""
        echo "### Top 3 stack alternatives (ranked)"
        local alt_idx=1
        for entry in "${ranked_candidates[@]}"; do
            [ "$alt_idx" -gt 3 ] && break
            IFS='|' read -r score stack evidence <<< "$entry"
            if [ "$stack" = "Unknown" ] && [ "$score" -eq 0 ] && [ "$alt_idx" -eq 1 ]; then
                echo "- 1) Unknown (insufficient deterministic signals)"
            else
                echo "- $alt_idx) $stack: score=$score, evidence=[$evidence]"
            fi
            alt_idx=$((alt_idx + 1))
        done
    } > "$STACK_SNAPSHOT_FILE"

    info "Stack snapshot complete: primary stack ${primary_candidate} (${primary_score}/100, ${primary_confidence})."
}

plan_is_semantically_actionable() {
    local plan_file="$1"
    [ -f "$plan_file" ] || return 1

    local has_goal=false
    local has_validation=false
    local task_count=0

    if grep -qiE '(^|#{1,6}[[:space:]]*)(goal|scope|objectives?|overview|context)\b|^[[:space:]]*(goal|scope|objectives?|overview|context)[[:space:]]*:' "$plan_file" 2>/dev/null; then
        has_goal=true
    fi
    if grep -qiE '(^|#{1,6}[[:space:]]*)(validation|verification|acceptance criteria|success criteria|definition of done|readiness|qa|testing)\b|^[[:space:]]*(validation|verification|acceptance criteria|success criteria|definition of done|readiness|qa|testing)[[:space:]]*:' "$plan_file" 2>/dev/null; then
        has_validation=true
    fi
    task_count="$(plan_task_count "$plan_file")"

    if is_true "$has_goal" && is_true "$has_validation" && [ "${task_count:-0}" -ge 1 ]; then
        return 0
    fi
    return 1
}

plan_task_count() {
    local plan_file="$1"
    if [ ! -f "$plan_file" ]; then
        echo "0"
        return 0
    fi
    local count
    count="$(grep -cE '^[[:space:]]*([0-9]+\.[[:space:]]|-[[:space:]]\[[ x]\][[:space:]]|-[[:space:]](Run|Add|Update|Implement|Fix|Verify|Test|Document|Research|Decide|Refactor|Remove|Deprecate)[[:space:]])' "$plan_file" 2>/dev/null || true)"
    if ! is_number "$count"; then
        count="0"
    fi
    echo "$count"
}

write_gate_feedback() {
    local stage="$1"
    shift
    mkdir -p "$(dirname "$GATE_FEEDBACK_FILE")"
    {
        echo "# Ralphie Gate Feedback"
        echo ""
        echo "- Timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
        echo "- Mode: $stage"
        echo ""
        echo "## Blockers"
        if [ "$#" -eq 0 ]; then
            echo "- None"
        else
            for _entry in "$@"; do
                echo "- $_entry"
            done
        fi
    } > "$GATE_FEEDBACK_FILE"
}

check_build_prerequisites() {
    local -a missing=()
    mapfile -t missing < <(collect_build_prerequisites_issues)
    if [ "${#missing[@]}" -gt 0 ]; then
        warn "Build prerequisites are incomplete:"
        local entry
        for entry in "${missing[@]}"; do
            warn "  - $entry"
        done
        log_reason_code "RB_BUILD_PREREQ_MISSING" "one or more build prerequisites failed"
        write_gate_feedback "build-prerequisites" "${missing[@]}"
        return 1
    fi

    rm -f "$GATE_FEEDBACK_FILE" 2>/dev/null || true
    return 0
}

collect_build_prerequisites_issues() {
    local -a missing=()
    if [ ! -d "$SPECS_DIR" ]; then
        missing+=("spec directory missing: specs/")
    fi
    if [ ! -d "$RESEARCH_DIR" ]; then
        missing+=("research directory missing: research/")
    fi
    if [ ! -f "$PLAN_FILE" ]; then
        missing+=("IMPLEMENTATION_PLAN.md missing before build")
    elif ! plan_is_semantically_actionable "$PLAN_FILE"; then
        missing+=("plan is not semantically actionable")
    fi

    if ! markdown_artifacts_are_clean; then
        missing+=("markdown artifacts must not contain tool transcript leakage or local identity/path leakage")
    fi

    local gitignore_missing_lines
    local -a gitignore_missing=()
    gitignore_missing_lines="$(gitignore_missing_required_entries || true)"
    while IFS= read -r missing_entry; do
        [ -n "$missing_entry" ] && gitignore_missing+=("$missing_entry")
    done <<< "$gitignore_missing_lines"
    if [ "${#gitignore_missing[@]}" -gt 0 ]; then
        local missing_joined
        missing_joined="$(printf '%s,' "${gitignore_missing[@]}" | sed 's/,$//')"
        missing+=(".gitignore must include local/sensitive/runtime guardrails (missing: $missing_joined)")
    fi

    if [ ! -f "$CONSTITUTION_FILE" ]; then
        missing+=("constitution file missing: .specify/memory/constitution.md")
    fi

    print_array_lines "${missing[@]+"${missing[@]}"}"
}

enforce_build_gate() {
    if ! check_build_prerequisites; then
        log_reason_code "RB_BUILD_GATE_PREREQ_FAILED" "build prerequisites failed"
        return 1
    fi
    return 0
}

collect_phase_schema_issues() {
    local phase="$1"
    local log_file="$2"
    local output_file="$3"
    local -a issues=()

    [ -f "$output_file" ] || issues+=("$phase output artifact missing: $output_file")
    [ -f "$log_file" ] || issues+=("$phase log artifact missing: $log_file")
    [ -n "$phase" ] || issues+=("missing phase name for schema check")

    print_array_lines "${issues[@]+"${issues[@]}"}"
}

pick_fallback_engine() { [ "${2:-}" = "claude" ] && echo "codex" || echo "claude"; }
effective_lock_wait_seconds() {
    local wait_seconds="${LOCK_WAIT_SECONDS:-0}"
    echo $(( wait_seconds + 7 ))
}
ensure_prompt_file() {
    local phase="$1"
    local file="$2"
    if [ -f "$file" ]; then
        return 0
    fi

    local phase_name="$phase"
    case "$phase_name" in
        plan|prepare)
            cat > "$file" <<'EOF'
# Ralphie Plan Phase Prompt
You are the autonomous planning engine for this project.

Goal
- Inspect the repository structure and runtime stack.
- Produce missing research artifacts and a concrete implementation plan.

Outputs (required)
- Research summary in `research/RESEARCH_SUMMARY.md` with `<confidence>`.
- `research/CODEBASE_MAP.md` mapping directories, entrypoints, and architecture assumptions.
- `research/DEPENDENCY_RESEARCH.md` documenting stack components and alternatives.
- `research/COVERAGE_MATRIX.md` with coverage against goals.
- `research/STACK_SNAPSHOT.md` with ranked stack hypotheses, deterministic confidence score, and alternatives.
- `IMPLEMENTATION_PLAN.md` with goal, validation criteria, and actionable tasks.
- `consensus/build_gate.md` if needed for blockers.

Behavior
- Compare at least two viable implementation paths when uncertainty exists.
- Keep markdown artifacts portable: no local machine paths, no tool transcripts, no timing output.
- Respond with concise completion notes:
  - What artifacts were updated.
  - What assumptions were made.
  - Any blockers or risks that remain.
- Phase is done when this guidance is satisfied and artifacts are genuinely ready for BUILD handoff.
EOF
            ;;
        build)
            cat > "$file" <<'EOF'
# Ralphie Build Phase Prompt
You are the implementation agent.

Goal
- Execute the highest-priority plan tasks from `IMPLEMENTATION_PLAN.md`.
- Keep changes scoped and validated by existing project patterns.

Behavior
- Prefer minimal diffs and avoid unrelated churn.
- Update implementation and tests to satisfy plan acceptance criteria.
- When external alternatives exist, record rationale in implementation notes.
- Provide a concise completion summary:
  - Files changed and why.
  - Verification actions you ran and outcomes.
  - Any known risks before declaring BUILD complete.
EOF
            ;;
        test)
            cat > "$file" <<'EOF'
# Ralphie Test Phase Prompt
You are the verification agent.

Goal
- Exercise new/changed functionality with targeted checks.
- Record exact commands, results, and failures in `completion_log`.

Behavior
- Validate assumptions behind plan items before declaring done.
- Note any skipped checks with reason.
- Return concise test completion findings:
  - What was tested and what was not tested (with reason).
  - Whether acceptance checks passed for changed behavior.
  - Risks introduced, if any.
EOF
            ;;
        refactor)
            cat > "$file" <<'EOF'
# Ralphie Refactor Phase Prompt
You are the refactoring agent.

Goal
- Improve structure and maintainability of changed areas only.
- Keep behavior stable and backward-compatible unless explicitly changing requirements.

Behavior
- Remove duplication where risk is low.
- Preserve API boundaries and update only what is needed.
- Return concise refactor completion notes:
  - Scope changed and why.
  - Concrete risks introduced.
  - Verification checks and outcomes.
EOF
            ;;
        lint)
            cat > "$file" <<'EOF'
# Ralphie Lint Phase Prompt
You are the quality gate agent.

Goal
- Evaluate consistency, style, and likely failure modes in recent changes.
- Suggest precise fixes before build/test progression.

Behavior
- Focus on deterministic checks and policy consistency.
- Return concise lint completion notes:
  - Key quality risks/observed issues.
  - Checks run and their outcomes.
  - Whether code is safe to progress based on observed signal.
EOF
            ;;
        document)
            cat > "$file" <<'EOF'
# Ralphie Document Phase Prompt
You are the documentation agent.

Goal
- Update or add project-facing documentation describing current behavior and rationale.
- Ensure `.md` outputs are reproducible and free of local context.

Behavior
- Emphasize assumptions, ownership, and runbook changes.
- Return concise documentation completion notes:
  - Files updated and the rationale.
  - Open questions or risks introduced.
  - Whether docs are clear enough to proceed.
EOF
            ;;
        *)
            touch "$file"
            ;;
    esac
    info "Wrote fallback prompt file: $(path_for_display "$file")"
}

ensure_core_artifacts() {
    mkdir -p "$SPECS_DIR" "$RESEARCH_DIR" "$LOG_DIR" "$COMPLETION_LOG_DIR" "$CONSENSUS_DIR" "$READY_ARCHIVE_DIR" "$SPECIFY_DIR"

    ensure_constitution_bootstrap

    [ -f "$PLAN_FILE" ] || cat > "$PLAN_FILE" <<'EOF'
# Implementation Plan

## Goal
- Bring project into an executable, measurable development plan.

## Research Discovery
- Inspect repository structure and runtime stack for training, OOF, optimization, and live execution surfaces.
- Map execution boundaries between scripts, orchestration, and live service components.

## Stack
- Confirm Python is the canonical workflow runtime and keep dashboard tooling isolated to observability.
- Track deterministic entrypoint ownership for train, OOF, optimization, and parity checks.

## Acceptance Criteria
- `<confidence>` score present in `research/RESEARCH_SUMMARY.md`.
- Research and specs artifacts updated with acceptance criteria.
  - `research/CODEBASE_MAP.md`
  - `research/DEPENDENCY_RESEARCH.md`
  - `research/COVERAGE_MATRIX.md`
  - `research/STACK_SNAPSHOT.md`

## Readiness
- Plan artifacts and build prerequisites remain stable between phase transitions.
- Required artifacts are present and reviewed before build/test gates.

## Risk
- Config drift and checkpoint/model-contract mismatch between train→OOF→optimize→live are high-priority risks.
- Missing handoff consistency checks at phase handoff may cause parity failures.

## Actionable Tasks
- [ ] Inspect repository structure and stack dependencies.
- [ ] Generate or update research artifacts (`research/*`).
- [ ] Produce a concrete implementation plan.
- [ ] Implement phase-safe iteration and guardrails.
EOF

    [ -f "$RESEARCH_SUMMARY_FILE" ] || cat > "$RESEARCH_SUMMARY_FILE" <<'EOF'
# Research Summary

<confidence>0</confidence>
## Current Posture
- Baseline confidence is provisional for a fresh or existing project.
EOF

    [ -f "$RESEARCH_DIR/CODEBASE_MAP.md" ] || cat > "$RESEARCH_DIR/CODEBASE_MAP.md" <<'EOF'
# Codebase Map

## Directory Map
- `.`: Repository root and orchestration script entrypoint
- `./.specify/memory`: governance and constitution context
- `./research`: discovery artifacts and risk signal evidence
- `./specs`: implementation and contract specifications
- `./consensus`: review and arbitration outputs

## Entrypoints
- `ralphie.sh` (root orchestrator entrypoint)
- Additional entrypoints discovered during plan/build phases

## Modules
- orchestration and governance modules mapped during plan execution
- contract and validation surfaces defined in `specs/*.md`

## Architecture
- Module boundaries and ownership are inferred from file structure and explicit contracts.
EOF
    [ -f "$RESEARCH_DIR/DEPENDENCY_RESEARCH.md" ] || cat > "$RESEARCH_DIR/DEPENDENCY_RESEARCH.md" <<'EOF'
# Dependency Research

## Primary Stack Candidates
- Unknown (preliminary until discovery completes)

## Alternatives
- Python (expected orchestration stack)
- Node.js (possible frontend or operational tooling)
- Go (candidate for future performance-sensitive components)

## Risk Register
- Dependency lockfile completeness and version pinning
- Drift between local and committed manifests
- Entrypoint ambiguity across orchestration and scripts

## Dependency Evidence Notes
- Update this file during plan execution with deterministic signal mapping.
- Include rationale and tradeoffs before build gate progression.
EOF
    [ -f "$RESEARCH_DIR/COVERAGE_MATRIX.md" ] || cat > "$RESEARCH_DIR/COVERAGE_MATRIX.md" <<'EOF'
# Coverage Matrix

## Coverage Checklist
- Research coverage for stack and architecture evidence is planned.
- Spec coverage for acceptance criteria is pending.
- Plan readiness gate is tracked by consensus review and transition checks.
EOF
    [ -f "$STACK_SNAPSHOT_FILE" ] || cat > "$STACK_SNAPSHOT_FILE" <<'EOF'
# Stack Snapshot

- generated_at: PLACEHOLDER
- primary_stack: unknown
- primary_score: 0/100
- confidence: unknown

## Project Stack Ranking
| rank | stack | score | evidence |
| --- | --- | --- | --- |
| 1 | Unknown | 0 | no deterministic signals |

## Deterministic Alternatives Ranking
- No deterministic signal snapshot available yet.
EOF

    [ -f "$SPECS_DIR/project_contracts.md" ] || cat > "$SPECS_DIR/project_contracts.md" <<'EOF'
# Project Contracts

## Purpose
- Define the required behavior surface for implementation and validation.

## Acceptance Criteria
- Research artifacts include `RESEARCH_SUMMARY`, `CODEBASE_MAP`, `DEPENDENCY_RESEARCH`, `COVERAGE_MATRIX`, and `STACK_SNAPSHOT`.
- Implementation plan includes semantic actionability and measurable outcomes.

## Quality Gates
- Build gate requires explicit build checks and consensus pass.
- No blocking build prerequisites remain before phase transition.
EOF

}

setup_phase_prompts() {
    ensure_prompt_file "plan" "$PROMPT_PLAN_FILE"
    ensure_prompt_file "build" "$PROMPT_BUILD_FILE"
    ensure_prompt_file "test" "$PROMPT_TEST_FILE"
    ensure_prompt_file "refactor" "$PROMPT_REFACTOR_FILE"
    ensure_prompt_file "lint" "$PROMPT_LINT_FILE"
    ensure_prompt_file "document" "$PROMPT_DOCUMENT_FILE"
}

consensus_prompt_for_stage() {
    local stage="${1%-gate}"
    local loop_context="${2:-}"
    local reviewer_persona="${3:-}"
    local next_phase_choices="plan|build|test|refactor|lint|document|done"
    if [ -n "$loop_context" ] && [ "$loop_context" != "no transitions yet" ]; then
        echo "Recent phase path context:"
        echo "$loop_context"
        echo ""
    fi
    if [ -n "$reviewer_persona" ]; then
        echo "Reviewer Persona: $reviewer_persona"
        echo ""
    fi
    echo "Use this transition history to decide whether to continue, backtrack, or stop."
    echo ""
    case "$stage" in
        plan)
            cat <<EOF
Review the latest PLAN artifacts and agent output from this cycle.
Focus on whether the phase intent is complete, traceable, and safe.
Do not fail on markdown template exactness; judge based on substantive completion.
- Emit <score>(0-100)</score> and <verdict>(GO|HOLD)</verdict>.
- Emit <next_phase>${next_phase_choices}</next_phase>.
- Emit <next_phase_reason>one-sentence rationale for the phase transition.</next_phase_reason>.
- Include unresolved blockers in <gaps> as a concise comma-separated list.
EOF
            ;;
        build)
            cat <<EOF
Evaluate implementation completion and traceability to the plan.
Verify changed behavior and validation intent are coherent.
Do not require strict evidence-tag formatting; use semantic judgment with the phase outputs.
- Emit <score>(0-100)</score> and <verdict>(GO|HOLD)</verdict>.
- Emit <next_phase>${next_phase_choices}</next_phase>.
- Emit <next_phase_reason>one-sentence rationale for the phase transition.</next_phase_reason>.
- Include unresolved blockers in <gaps> as a concise comma-separated list.
EOF
            ;;
        test)
            cat <<EOF
Review test output quality and whether verification intent appears complete.
Treat concrete behavior changes and rationale as higher priority than exact markers.
- Emit <score>(0-100)</score> and <verdict>(GO|HOLD)</verdict>.
- Emit <next_phase>${next_phase_choices}</next_phase>.
- Emit <next_phase_reason>one-sentence rationale for the phase transition.</next_phase_reason>.
- Include unresolved blockers in <gaps> as a concise comma-separated list.
EOF
            ;;
        refactor)
            cat <<EOF
Review refactor output for risk, stability, and meaningful code improvements.
Prioritize actual refactor effect and safety over strict markdown structure.
Do not require strict evidence-tag formatting; use semantic judgment with the phase outputs.
- Emit <score>(0-100)</score> and <verdict>(GO|HOLD)</verdict>.
- Emit <next_phase>${next_phase_choices}</next_phase>.
- Emit <next_phase_reason>one-sentence rationale for the phase transition.</next_phase_reason>.
- Include unresolved blockers in <gaps> as a concise comma-separated list.
EOF
            ;;
        lint)
            cat <<EOF
Validate linting and quality review completeness from available evidence.
Judge whether issues and outcomes are meaningful, not whether they follow exact tag patterns.
- Emit <score>(0-100)</score> and <verdict>(GO|HOLD)</verdict>.
- Emit <next_phase>${next_phase_choices}</next_phase>.
- Emit <next_phase_reason>one-sentence rationale for the phase transition.</next_phase_reason>.
- Include unresolved blockers in <gaps> as a concise comma-separated list.
EOF
            ;;
        document)
            cat <<EOF
Validate documentation updates and decision clarity for this phase.
Prioritize correctness, completeness, and intent over exact template markers.
- Emit <score>(0-100)</score> and <verdict>(GO|HOLD)</verdict>.
- Emit <next_phase>${next_phase_choices}</next_phase>.
- Emit <next_phase_reason>one-sentence rationale for the phase transition.</next_phase_reason>.
- Include unresolved blockers in <gaps> as a concise comma-separated list.
EOF
            ;;
        *)
            cat <<EOF
Run independent quality review.
Emit <score>(0-100)</score> and <verdict>(GO|HOLD)</verdict>.
Emit <next_phase>${next_phase_choices}</next_phase> and <next_phase_reason>.
Include unresolved blockers in <gaps> as a concise comma-separated list.
EOF
            ;;
    esac
}

prompt_file_for_mode() {
    case "$1" in
        build) echo "$PROMPT_BUILD_FILE" ;;
        plan|prepare) echo "$PROMPT_PLAN_FILE" ;;
        test) echo "$PROMPT_TEST_FILE" ;;
        refactor) echo "$PROMPT_REFACTOR_FILE" ;;
        lint) echo "$PROMPT_LINT_FILE" ;;
        document) echo "$PROMPT_DOCUMENT_FILE" ;;
        *) echo "" ;;
    esac
}

build_phase_prompt_with_feedback() {
    local phase="$1"
    local base_prompt="$2"
    local target_prompt="$3"
    local attempt="$4"
    shift 4
    local -a failures=("$@")

    cp "$base_prompt" "$target_prompt"
    {
        echo ""
        echo "---"
        echo "## Retry Guidance (Attempt $attempt)"
        echo "- This phase did not pass machine checks on prior attempt."
        if [ "${#failures[@]}" -eq 0 ]; then
            echo "- Re-attempt with higher care for phase artifacts and explicit completeness."
        else
            echo "- Address all blockers before re-running:"
            for blocker in "${failures[@]}"; do
                [ -n "$blocker" ] || continue
                echo "- $blocker"
            done
        fi
        echo "- Preserve existing work; only generate missing/repairable artifacts and rerun this phase."
        echo "- Provide a concise completion recap with changed artifacts and residual risks."
    } >> "$target_prompt"
}

collect_phase_retry_failures_from_consensus() {
    local -a failures=()
    [ -n "$LAST_CONSENSUS_DIR" ] || { print_array_lines "${failures[@]+"${failures[@]}"}"; return 0; }
    local reviewer_summary ofile
    for ofile in "$LAST_CONSENSUS_DIR"/*.out; do
        [ -f "$ofile" ] || continue
        local score verdict next_phase next_phase_reason
        score="$(grep -oE "<score>[0-9]{1,3}</score>" "$ofile" | sed 's/[^0-9]//g' | tail -n 1)"
        is_number "$score" || score="0"
        verdict="$(grep -oE "<verdict>(GO|HOLD)</verdict>" "$ofile" 2>/dev/null | tail -n 1 | sed -E 's/<\/?verdict>//g')"
        [ "$verdict" = "GO" ] || [ "$verdict" = "HOLD" ] || verdict="HOLD"
        next_phase="$(extract_xml_value "$ofile" "next_phase" "unknown")"
        next_phase_reason="$(extract_xml_value "$ofile" "next_phase_reason" "")"
        [ -n "$next_phase_reason" ] || next_phase_reason="no explicit phase-routing rationale"
        local gaps
        if grep -q "<gaps>" "$ofile" 2>/dev/null; then
            gaps="$(sed -n 's/.*<gaps>\(.*\)<\/gaps>.*/\1/p' "$ofile" | head -n 1)"
            gaps="$(echo "$gaps" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c 1-140)"
            [ -z "$gaps" ] && gaps="no explicit gaps"
        else
            gaps="no explicit gaps"
        fi
        reviewer_summary="$(basename "$ofile"): score=$score verdict=${verdict:-HOLD} next=$next_phase reason=$next_phase_reason gaps=$gaps"
        failures+=("consensus review: $reviewer_summary")
    done
    print_array_lines "${failures[@]+"${failures[@]}"}"
}

ensure_constitution_bootstrap() {
    if [ -f "$CONSTITUTION_FILE" ]; then
        return 0
    fi

    mkdir -p "$SPECIFY_DIR"
    cat > "$CONSTITUTION_FILE" <<'EOF'
# Ralphie Constitution

## Purpose
- Establish deterministic, portable, and reproducible control planes for autonomous execution.
- Define behavior for all phases from planning through documentation.

## Governance
- Keep artifacts machine-readable: avoid local absolute paths, avoid command transcript leakage, and keep logs deterministic.
- Validate phase completion through reviewer-intelligence consensus and execution/build gates; keep semantic checks close to code and outputs.
- Treat gate failures as actionable signals, not terminal failure if bounded retries remain.

## Phase Contracts
- **Plan** produces research artifacts, an explicit implementation plan, and a deterministic stack snapshot.
- **Build** executes plan tasks against evidence in IMPLEMENTATION_PLAN.md.
- **Test** verifies behavior changes and documents validation rationale.
- **Refactor** preserves behavior, reduces complexity, and documents rationale.
- **Lint** enforces deterministic quality and cleanup policies.
- **Document** closes the lifecycle with updated user-facing documentation.

## Recovery and Retry Policy
- Every phase attempt that fails consensus or transition checks is retried within
  `PHASE_COMPLETION_MAX_ATTEMPTS` using feedback from prior blockers.
- Hard stop occurs only after bounded retries are exhausted and gate feedback is persisted.

## Evidence Requirements
- Phase completion is judged by reviewer-intelligence consensus plus execution/build-time gates.
- Plan/research artifacts are reviewed for substantive quality but not by rigid template matching.

## Environment Scope
- Repository-relative paths and relative markdown links are preferred.
- External references are allowed only when version/risk tradeoffs are explicitly documented.
EOF
}

plan_prompt_for_iteration() { echo "$1"; }
run_idle_plan_refresh() { return 0; }
print_session_config_banner() {
    info "=== Ralphie Session Budget & Retry Configuration ==="
    info "max_session_cycles: ${MAX_SESSION_CYCLES:-0} (0=unlimited)"
    info "session_token_budget: ${SESSION_TOKEN_BUDGET:-0} (0=unlimited)"
    info "session_token_rate_cents_per_million: ${SESSION_TOKEN_RATE_CENTS_PER_MILLION:-0}"
    info "session_cost_budget_cents: ${SESSION_COST_BUDGET_CENTS:-0} (0=unlimited)"
    info "session token/cost accounting is heuristic (byte-based estimation, not invoice-accurate)"
    info "phase_completion_max_attempts: ${PHASE_COMPLETION_MAX_ATTEMPTS:-0}"
    info "phase_completion_retry_delay_seconds: ${PHASE_COMPLETION_RETRY_DELAY_SECONDS:-0}"
    info "phase_completion_retry_verbose: ${PHASE_COMPLETION_RETRY_VERBOSE:-false}"
    info "run_agent_max_attempts: ${RUN_AGENT_MAX_ATTEMPTS:-0}"
    info "run_agent_retry_delay_seconds: ${RUN_AGENT_RETRY_DELAY_SECONDS:-0}"
    info "run_agent_retry_verbose: ${RUN_AGENT_RETRY_VERBOSE:-false}"
    info "engine_output_to_stdout: ${ENGINE_OUTPUT_TO_STDOUT:-true}"
    info "max_consensus_routing_attempts: ${MAX_CONSENSUS_ROUTING_ATTEMPTS:-0}"
    info "phase_noop_profile: ${PHASE_NOOP_PROFILE:-$DEFAULT_PHASE_NOOP_PROFILE}"
    info "strict_validation_noop: ${STRICT_VALIDATION_NOOP:-false}"
    info "auto_repair_markdown_artifacts: ${AUTO_REPAIR_MARKDOWN_ARTIFACTS:-false}"
    info "phase noop policies: plan=${PHASE_NOOP_POLICY_PLAN}, build=${PHASE_NOOP_POLICY_BUILD}, test=${PHASE_NOOP_POLICY_TEST}, refactor=${PHASE_NOOP_POLICY_REFACTOR}, lint=${PHASE_NOOP_POLICY_LINT}, document=${PHASE_NOOP_POLICY_DOCUMENT}"
}

emit_phase_transition_banner() {
    local phase="$1"
    local noop_policy
    noop_policy="$(phase_noop_policy "$phase")"
    info ">>> Entering phase '$phase' <<<"
    info "phase completion attempts remaining: ${PHASE_COMPLETION_MAX_ATTEMPTS:-0}"
    if [ "$noop_policy" = "hard" ]; then
        info "worktree mutation policy: hard (attempt must mutate repository contents)"
    elif [ "$noop_policy" = "soft" ]; then
        info "worktree mutation policy: soft (no mutation is allowed but surfaced)"
    else
        info "worktree mutation policy: none"
    fi
}

format_retry_budget_block_reason() {
    local phase="$1"
    local attempt="$2"
    local limit="$3"
    log_reason_code "RB_PHASE_COMPLETION_RETRY_EXHAUSTED" "$phase completion signal exhausted after $attempt/$limit attempts"
}

main() {
    parse_args "$@"
    finalize_phase_noop_profile_config
    REBOOTSTRAP_REQUESTED="$(to_lower "${REBOOTSTRAP_REQUESTED:-$DEFAULT_REBOOTSTRAP_REQUESTED}")"
    is_bool_like "$REBOOTSTRAP_REQUESTED" || REBOOTSTRAP_REQUESTED="$DEFAULT_REBOOTSTRAP_REQUESTED"

    acquire_lock || exit 1

    if is_true "$RESUME_REQUESTED" && load_state; then
        success "Resuming mission..."
    else
        save_state
    fi
    if is_true "$ENGINE_OUTPUT_TO_STDOUT_EXPLICIT"; then
        ENGINE_OUTPUT_TO_STDOUT="$ENGINE_OUTPUT_TO_STDOUT_OVERRIDE"
    fi

    if ! is_number "$MAX_SESSION_CYCLES" || [ "$MAX_SESSION_CYCLES" -lt 0 ]; then
        MAX_SESSION_CYCLES=0
    fi
    if ! is_number "$PHASE_COMPLETION_MAX_ATTEMPTS" || [ "$PHASE_COMPLETION_MAX_ATTEMPTS" -lt 1 ]; then
        PHASE_COMPLETION_MAX_ATTEMPTS=3
    fi
    if ! is_number "$PHASE_COMPLETION_RETRY_DELAY_SECONDS" || [ "$PHASE_COMPLETION_RETRY_DELAY_SECONDS" -lt 0 ]; then
        PHASE_COMPLETION_RETRY_DELAY_SECONDS=5
    fi
    if ! is_number "$MAX_CONSENSUS_ROUTING_ATTEMPTS" || [ "$MAX_CONSENSUS_ROUTING_ATTEMPTS" -lt 0 ]; then
        MAX_CONSENSUS_ROUTING_ATTEMPTS="$DEFAULT_MAX_CONSENSUS_ROUTING_ATTEMPTS"
    fi
    if ! is_number "$MAX_ITERATIONS" || [ "$MAX_ITERATIONS" -lt 0 ]; then
        MAX_ITERATIONS=0
    fi

    local should_exit="false"
    if ! enforce_session_budget "session init"; then
        should_exit="true"
    fi
    if is_true "$should_exit"; then
        save_state
        release_lock
        exit 1
    fi

    print_session_config_banner
    ensure_core_artifacts
    setup_phase_prompts
    ensure_gitignore_guardrails
    ensure_project_bootstrap

    local -a phases=("plan" "build" "test" "refactor" "lint" "document")
    local phase_index=0
    local start_phase_index=0
    local start_phase_name="plan"
    local -a phase_resume_blockers=()
    if is_true "$RESUME_REQUESTED"; then
        start_phase_index="$CURRENT_PHASE_INDEX"
        if ! is_number "$start_phase_index" || [ "$start_phase_index" -lt 0 ] || [ "$start_phase_index" -ge "${#phases[@]}" ]; then
            start_phase_index="$(phase_index_from_name "$CURRENT_PHASE")" || start_phase_index=0
            if ! is_number "$start_phase_index" || [ "$start_phase_index" -lt 0 ] || [ "$start_phase_index" -ge "${#phases[@]}" ]; then
                start_phase_index=0
            fi
        fi
        start_phase_name="$(phase_name_from_index "$start_phase_index")" || start_phase_name="plan"
        mapfile -t phase_resume_blockers < <(collect_phase_resume_blockers "$start_phase_name")
        if [ "${#phase_resume_blockers[@]}" -gt 0 ]; then
            local resume_blockers_summary
            resume_blockers_summary="$(summarize_blocks_for_log "${phase_resume_blockers[@]}")"
            warn "Resumption into '$start_phase_name' is blocked by unmet preconditions: $resume_blockers_summary"
            warn "Falling back to plan phase to rebuild required artifacts and references."
            log_reason_code "RB_PHASE_RESUME_FALLBACK" "resume to $start_phase_name blocked: $resume_blockers_summary"
            write_gate_feedback "resume-recovery" "resumption fallback to plan" "${phase_resume_blockers[@]}"
            start_phase_name="plan"
            start_phase_index=0
            CURRENT_PHASE="$start_phase_name"
            CURRENT_PHASE_INDEX="$start_phase_index"
            save_state
        fi
    fi

    local consensus_route_count=0
    while true; do
        if ! ensure_engines_ready "$ENGINE_SELECTION_REQUESTED"; then
            should_exit="true"
            log_reason_code "RB_ENGINE_SELECTION_FAILED" "$LAST_ENGINE_SELECTION_BLOCK_REASON"
            break
        fi
        for ((phase_index = start_phase_index; phase_index < ${#phases[@]}; phase_index++)); do
            local phase="${phases[$phase_index]}"
            CURRENT_PHASE_INDEX="$phase_index"
            if is_true "$should_exit"; then break 2; fi
            CURRENT_PHASE="$phase"
            ITERATION_COUNT=$((ITERATION_COUNT + 1))
            save_state

            local pfile="$(prompt_file_for_mode "$phase")"
            mkdir -p "$LOG_DIR" "$COMPLETION_LOG_DIR"
            if ! enforce_session_budget "session loop"; then
                should_exit="true"
                break
            fi
            emit_phase_transition_banner "$phase"
            if [ ! -f "$pfile" ]; then
                ensure_prompt_file "$phase" "$pfile"
            fi
            if [ "$phase" = "build" ] && ! build_is_preapproved; then
                warn "Build execution was not pre-approved in project bootstrap context."
                warn "Edit $(path_for_display "$PROJECT_BOOTSTRAP_FILE") and set build_consent: true to continue automatically into BUILD."
                log_reason_code "RB_BUILD_CONSENT_REQUIRED" "bootstrap build_consent is false"
                should_exit="true"
                break 2
            fi
            if [ "$phase" = "plan" ]; then
                run_stack_discovery
                if [ ! -f "$STACK_SNAPSHOT_FILE" ] || ! grep -qE '^##[[:space:]]*Project Stack Ranking' "$STACK_SNAPSHOT_FILE" 2>/dev/null; then
                    warn "Stack discovery could not generate a valid ranking snapshot."
                    log_reason_code "RB_STACK_DISCOVERY_FAILED" "could not generate deterministic stack snapshot"
                    should_exit="true"
                    break
                fi
                save_state
            fi

            local phase_attempt=1
            local -a cumulative_phase_failures=()
            local phase_next_target="$phase"
            local phase_route="false"
            local phase_route_reason=""
            while [ "$phase_attempt" -le "$PHASE_COMPLETION_MAX_ATTEMPTS" ]; do
                local lfile="$LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.log"
                local ofile="$COMPLETION_LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.out"
                local active_prompt="$pfile"
                local -a phase_failures=()
                local -a phase_warnings=()
                local attempt_feedback_file="$LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.prompt.md"
                local bootstrap_prompt_file="$LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.bootstrap.prompt.md"
                local previous_attempt_output_hash=""
                local previous_attempt_output_file=""
                local phase_noop_mode manifest_before_file manifest_after_file
                phase_noop_mode="$(phase_noop_policy "$phase")"
                local phase_delta_preview=""
                local handoff_validator_prompt="$LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.handoff.prompt.md"
                local handoff_validator_log="$LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.handoff.log"
                local handoff_validator_out="$COMPLETION_LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.handoff.out"
                local handoff_validator_status="$COMPLETION_LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}.handoff.status"
                local handoff_validator_primary=""
                local handoff_validator_fallback=""
                local phase_warnings_text=""
                local -a consensus_failures=()

                manifest_before_file="$LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}_manifest_before.txt"
                manifest_after_file="$LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_${phase_attempt}_manifest_after.txt"
                if [ "$phase_noop_mode" != "none" ]; then
                    phase_capture_worktree_manifest "$manifest_before_file" || true
                fi

                if [ "$phase_attempt" -gt 1 ]; then
                    local previous_attempt_file="$COMPLETION_LOG_DIR/${phase}_${SESSION_ID}_${ITERATION_COUNT}_attempt_$((phase_attempt - 1)).out"
                    if [ -f "$previous_attempt_file" ]; then
                        previous_attempt_output_hash="$(sha256_file_sum "$previous_attempt_file" 2>/dev/null || echo "")"
                        previous_attempt_output_file="$previous_attempt_file"
                    fi
                fi

                if [ "$phase" = "plan" ]; then
                    append_bootstrap_context_to_plan_prompt "$pfile" "$bootstrap_prompt_file"
                    active_prompt="$bootstrap_prompt_file"
                fi

                if [ "$phase_attempt" -gt 1 ]; then
                    build_phase_prompt_with_feedback "$phase" "$active_prompt" "$attempt_feedback_file" "$phase_attempt" "${cumulative_phase_failures[@]}"
                    active_prompt="$attempt_feedback_file"
                fi

                if [ "$phase" = "build" ] && ! enforce_build_gate; then
                    local -a gate_issues=()
                    mapfile -t gate_issues < <(collect_build_prerequisites_issues)
                    local repair_summary=""
                    if is_true "$AUTO_REPAIR_MARKDOWN_ARTIFACTS" && ! markdown_artifacts_are_clean; then
                        if sanitize_markdown_artifacts; then
                            repair_summary="$(markdown_artifact_cleanup_summary)"
                            if [ -n "$repair_summary" ]; then
                                phase_warnings+=("pre-build markdown remediation: ${repair_summary//$'\\n'/; }")
                            fi
                        fi
                        if [ -n "$repair_summary" ] && enforce_build_gate; then
                            gate_issues=()
                            phase_warnings+=("build gate passed after markdown artifact remediation")
                        fi
                    fi
                    if [ "${#gate_issues[@]}" -gt 0 ] && [ -n "$repair_summary" ]; then
                        phase_failures+=("pre-build markdown remediation applied before retry")
                        phase_failures+=("pre-build markdown remediation summary: ${repair_summary//$'\\n'/; }")
                    fi
                    for issue in "${gate_issues[@]}"; do
                    phase_failures+=("build gate blocked before build execution: $issue")
                    done
                fi

                if [ "${#phase_failures[@]}" -eq 0 ] && run_agent_with_prompt "$active_prompt" "$lfile" "$ofile" "$YOLO" "$phase_attempt"; then
                    # Verify agent produced meaningful output
                    if [ ! -f "$ofile" ] || [ ! -s "$ofile" ]; then
                        phase_failures+=("agent completed with exit 0 but produced no output artifact")
                    fi

                    if [ -n "$previous_attempt_output_hash" ] && [ "${#phase_failures[@]}" -eq 0 ]; then
                        local phase_output_hash
                        phase_output_hash="$(sha256_file_sum "$ofile" 2>/dev/null || echo "")"
                        if [ -n "$previous_attempt_output_hash" ] && [ -n "$phase_output_hash" ] && [ "$previous_attempt_output_hash" = "$phase_output_hash" ]; then
                            phase_failures+=("phase output did not materially change from prior attempt")
                        fi
                    fi

                    if [ "$phase" = "plan" ] && ! enforce_build_gate; then
                        local -a post_plan_gate_issues=()
                        mapfile -t post_plan_gate_issues < <(collect_build_prerequisites_issues)
                        local post_plan_repair_summary=""
                        if is_true "$AUTO_REPAIR_MARKDOWN_ARTIFACTS" && ! markdown_artifacts_are_clean; then
                            if sanitize_markdown_artifacts; then
                                post_plan_repair_summary="$(markdown_artifact_cleanup_summary)"
                                mapfile -t post_plan_gate_issues < <(collect_build_prerequisites_issues)
                                [ "${#post_plan_gate_issues[@]}" -eq 0 ] && info "Build gate passed after post-plan markdown remediation."
                                [ -n "$post_plan_repair_summary" ] && phase_warnings+=("post-plan markdown remediation: ${post_plan_repair_summary//$'\\n'/; }")
                            fi
                        fi
                        if [ "${#post_plan_gate_issues[@]}" -gt 0 ]; then
                            phase_failures+=("build gate failed after plan->build transition")
                            [ -n "$post_plan_repair_summary" ] && phase_failures+=("post-plan markdown remediation summary: ${post_plan_repair_summary//$'\\n'/; }")
                            for issue in "${post_plan_gate_issues[@]}"; do
                                phase_failures+=("build gate: $issue")
                            done
                        fi
                    fi

                    if [ "$phase_noop_mode" != "none" ]; then
                        phase_capture_worktree_manifest "$manifest_after_file" || true
                        if [ -f "$manifest_before_file" ] && [ -f "$manifest_after_file" ]; then
                            if phase_manifest_changed "$manifest_before_file" "$manifest_after_file"; then
                                phase_delta_preview="$(phase_manifest_delta_preview "$manifest_before_file" "$manifest_after_file" 8)"
                                if [ -n "$phase_delta_preview" ]; then
                                    phase_delta_preview="$(printf '%s' "$phase_delta_preview" | tr '\n' '; ')"
                                    phase_warnings+=("manifest delta preview: $phase_delta_preview")
                                fi
                            else
                                if [ "$phase_noop_mode" = "hard" ]; then
                                    phase_failures+=("$phase completed with no worktree mutation for phase '$phase'")
                                else
                                    phase_warnings+=("soft no-op signal: $phase completed without visible worktree mutation; acceptable for validation-only phases when run outputs are present")
                                fi
                            fi
                        else
                            phase_warnings+=("phase no-op check skipped: could not capture a reliable manifest snapshot for this attempt")
                        fi
                    fi

                    phase_warnings_text="$(printf '%s\n' "${phase_warnings[@]+"${phase_warnings[@]}"}")"
                    write_handoff_validation_prompt \
                        "$phase" \
                        "$phase_attempt" \
                        "$ofile" \
                        "$lfile" \
                        "$handoff_validator_prompt" \
                        "$manifest_before_file" \
                        "$manifest_after_file" \
                        "$phase_delta_preview" \
                        "$phase_noop_mode" \
                        "$phase_warnings_text" \
                        "$previous_attempt_output_file"

                    if [ "${ACTIVE_ENGINE}" = "codex" ]; then
                        handoff_validator_primary="$CLAUDE_CMD"
                        handoff_validator_fallback="$CODEX_CMD"
                    else
                        handoff_validator_primary="$CODEX_CMD"
                        handoff_validator_fallback="$CLAUDE_CMD"
                    fi

                    if [ "$handoff_validator_primary" = "$CODEX_CMD" ] && [ "$CODEX_HEALTHY" != "true" ]; then
                        handoff_validator_primary=""
                    fi
                    if [ "$handoff_validator_primary" = "$CLAUDE_CMD" ] && [ "$CLAUDE_HEALTHY" != "true" ]; then
                        handoff_validator_primary=""
                    fi
                    [ -n "$handoff_validator_primary" ] && command -v "$handoff_validator_primary" >/dev/null 2>&1 || handoff_validator_primary=""

                    if [ -z "$handoff_validator_primary" ]; then
                        if [ "${ACTIVE_ENGINE}" = "codex" ] && [ "$CODEX_HEALTHY" = "true" ] && command -v "$CODEX_CMD" >/dev/null 2>&1; then
                            handoff_validator_primary="$CODEX_CMD"
                        elif [ "${ACTIVE_ENGINE}" = "claude" ] && [ "$CLAUDE_HEALTHY" = "true" ] && command -v "$CLAUDE_CMD" >/dev/null 2>&1; then
                            handoff_validator_primary="$CLAUDE_CMD"
                        fi
                    fi

                    if [ "$handoff_validator_fallback" = "$handoff_validator_primary" ] || [ -z "$handoff_validator_fallback" ]; then
                        handoff_validator_fallback=""
                    elif [ "$handoff_validator_fallback" = "$CODEX_CMD" ] && [ "$CODEX_HEALTHY" != "true" ]; then
                        handoff_validator_fallback=""
                    elif [ "$handoff_validator_fallback" = "$CLAUDE_CMD" ] && [ "$CLAUDE_HEALTHY" != "true" ]; then
                        handoff_validator_fallback=""
                    elif ! command -v "$handoff_validator_fallback" >/dev/null 2>&1; then
                        handoff_validator_fallback=""
                    fi

                    if ! run_handoff_validation \
                        "$phase" \
                        "$handoff_validator_prompt" \
                        "$handoff_validator_log" \
                        "$handoff_validator_out" \
                        "$handoff_validator_status" \
                        "$handoff_validator_primary" \
                        "$handoff_validator_fallback"; then
                        phase_failures+=("handoff validation failed after $phase")
                        phase_failures+=("handoff review: verdict=$LAST_HANDOFF_VERDICT score=$LAST_HANDOFF_SCORE gaps=$LAST_HANDOFF_GAPS")
                    fi

                    if ! run_swarm_consensus "$phase-gate" "$(phase_transition_history_recent 8)"; then
                        phase_failures+=("intelligence validation failed after $phase")
                        mapfile -t consensus_failures < <(collect_phase_retry_failures_from_consensus)
                        for issue in "${consensus_failures[@]+"${consensus_failures[@]}"}"; do
                            phase_failures+=("consensus: $issue")
                        done
                        if [ -n "$LAST_CONSENSUS_SUMMARY" ]; then
                            phase_failures+=("consensus summary: $LAST_CONSENSUS_SUMMARY")
                        fi
                    fi
                else
                    if [ "${#phase_failures[@]}" -eq 0 ]; then
                        phase_failures+=("agent execution failed in $phase")
                    fi
                fi

                if [ "${#phase_failures[@]}" -gt 0 ]; then
                    cumulative_phase_failures=("${phase_failures[@]}")
                    if [ "${LAST_CONSENSUS_RESPONDED_VOTES:-0}" -gt 0 ] && is_phase_or_done "$LAST_CONSENSUS_NEXT_PHASE" && [ "$LAST_CONSENSUS_NEXT_PHASE" != "$phase" ]; then
                        phase_next_target="$LAST_CONSENSUS_NEXT_PHASE"
                        phase_route="true"
                        phase_route_reason="${LAST_CONSENSUS_NEXT_PHASE_REASON:-no explicit phase-routing rationale}"
                        phase_transition_history_append "$phase" "$phase_attempt" "$phase_next_target" "hold" "$phase_route_reason"
                        break
                    fi
                    write_gate_feedback "$phase" "${phase_failures[@]}"
                    for issue in "${phase_failures[@]}"; do
                        warn "$issue"
                    done
                    if [ "${#phase_warnings[@]-0}" -gt 0 ]; then
                        for issue in "${phase_warnings[@]+"${phase_warnings[@]}"}"; do
                            info "note: $issue"
                        done
                    fi
                    log_reason_code "RB_PHASE_RETRYABLE_FAIL" "$phase attempt $phase_attempt/$PHASE_COMPLETION_MAX_ATTEMPTS: ${phase_failures[*]}"

                    phase_attempt=$((phase_attempt + 1))
                    if [ "$phase_attempt" -gt "$PHASE_COMPLETION_MAX_ATTEMPTS" ]; then
                        warn "Phase $phase blocked after ${PHASE_COMPLETION_MAX_ATTEMPTS} attempts."
                        format_retry_budget_block_reason "$phase" "$((phase_attempt - 1))" "$PHASE_COMPLETION_MAX_ATTEMPTS"
                        should_exit="true"
                        break
                    fi
                    if is_true "$PHASE_COMPLETION_RETRY_VERBOSE"; then
                        warn "Phase $phase retrying in ${PHASE_COMPLETION_RETRY_DELAY_SECONDS}s (attempt ${phase_attempt}/${PHASE_COMPLETION_MAX_ATTEMPTS})."
                    fi
                    sleep "$PHASE_COMPLETION_RETRY_DELAY_SECONDS"
                    continue
                fi

                if [ "${#phase_warnings[@]-0}" -gt 0 ]; then
                    for issue in "${phase_warnings[@]+"${phase_warnings[@]}"}"; do
                        info "note: $issue"
                    done
                fi

                phase_next_target="${LAST_CONSENSUS_NEXT_PHASE:-$(phase_default_next "$phase")}"
                [ -n "$phase_next_target" ] || phase_next_target="$(phase_default_next "$phase")"
                phase_transition_history_append "$phase" "$phase_attempt" "$phase_next_target" "pass" "$phase_route_reason"
                if is_phase_or_done "$phase_next_target" && [ "$phase_next_target" != "$phase" ]; then
                    phase_route="true"
                    phase_route_reason="${LAST_CONSENSUS_NEXT_PHASE_REASON:-no explicit phase-routing rationale}"
                fi

                success "Phase $phase completed."
                break
            done
            if [ "$phase_route" = "true" ] && is_phase_or_done "$phase_next_target"; then
                local route_index
                route_index="$(phase_index_or_done "$phase_next_target")"
                if [ "$route_index" = "-1" ] || [ -z "$route_index" ]; then
                    route_index="$((phase_index + 1))"
                fi
                if [ "$route_index" -lt "$phase_index" ]; then
                    consensus_route_count=$((consensus_route_count + 1))
                    if [ "$MAX_CONSENSUS_ROUTING_ATTEMPTS" -gt 0 ] && [ "$consensus_route_count" -gt "$MAX_CONSENSUS_ROUTING_ATTEMPTS" ]; then
                        warn "Consensus routing attempts exceeded limit ($consensus_route_count/$MAX_CONSENSUS_ROUTING_ATTEMPTS)."
                        should_exit="true"
                        break 2
                    fi
                fi
                if [ "$phase_next_target" = "done" ] || [ "$route_index" -ge "${#phases[@]}" ]; then
                    start_phase_index="${#phases[@]}"
                    phase_index="${#phases[@]}"
                else
                    warn "Adaptive phase routing: $phase -> $phase_next_target (${phase_route_reason:-no explicit rationale})."
                    start_phase_index="$route_index"
                    phase_index=$((route_index - 1))
                fi
            fi
        done
        if is_true "$should_exit"; then
            break
        fi
        # If start_phase_index is past all phases (consensus routed to "done"
        # or natural completion of all phases), exit the outer loop
        if [ "$start_phase_index" -ge "${#phases[@]}" ]; then
            info "All phases completed. Session done."
            break
        fi
        if [ "$MAX_ITERATIONS" -gt 0 ] && [ "$ITERATION_COUNT" -ge "$MAX_ITERATIONS" ]; then
            log_reason_code "RB_ITERATION_BUDGET_REACHED" "run iteration budget reached at $ITERATION_COUNT"
            break
        fi
    done

    save_state
    release_lock
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
