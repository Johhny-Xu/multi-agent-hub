#!/usr/bin/env bash
BIN="$HOME/.npm-global/bin/codebuddy"
. "$HOME/.codebuddy/bin/accounts.env"

case "$(basename "$0")" in
  codebuddy-cn)   ac=cn ;;
  codebuddy-intl) ac=intl ;;
  *)
    ac=""
    case "${1:-}" in
      -c|--cn)   ac=cn;  shift ;;
      -i|--intl) ac=intl; shift ;;
    esac
    if [ -z "$ac" ]; then
      for arg in "$@"; do
        if [ "$arg" = "--serve" ]; then
          ac=cn
          break
        fi
      done
    fi
    if [ -z "$ac" ]; then
      [ -f "$HOME/.codebuddy-last" ] && ac=$(tr -dc 'a-z' < "$HOME/.codebuddy-last")
      case "$ac" in c) ac=cn ;; i) ac=intl ;; esac
      [ -n "$ac" ] || ac="$AC_default"
    fi
    ;;
esac

eval "acdir=\$AC_${ac}_dir"
eval "acenv=\$AC_${ac}_env"
if [ -z "${acdir:-}" ]; then echo "codebuddy: unknown account '$ac'" >&2; exit 1; fi
printf '%s\n' "$ac" > "$HOME/.codebuddy-last"

unset CODEBUDDY_AUTH_TOKEN CODEBUDDY_API_KEY
export CODEBUDDY_API_KEY_DISABLED=1 CODEBUDDY_CONFIG_DIR="$acdir" CODEBUDDY_INTERNET_ENVIRONMENT="$acenv"

# Use completely isolated HOME for cn and intl workers so they NEVER touch or stomp
# each other's credentials, nor the persistent 7454 web service credentials!
ISOLATED_HOME="$HOME/.codebuddy-${ac}-home"
ISOLATED_AUTH_DIR="$ISOLATED_HOME/.local/share/CodeBuddyExtension/Data/Public/auth"
ISOLATED_AUTHF="$ISOLATED_AUTH_DIR/Tencent-Cloud.coding-copilot.info"

mkdir -p "$ISOLATED_AUTH_DIR" "$ISOLATED_HOME/.codebuddy"

[ -f "$HOME/.gitconfig" ] && ln -snf "$HOME/.gitconfig" "$ISOLATED_HOME/.gitconfig" 2>/dev/null
[ -d "$HOME/.ssh" ] && ln -snf "$HOME/.ssh" "$ISOLATED_HOME/.ssh" 2>/dev/null

if [ "$ac" = "cn" ]; then
  MAIN_AUTHF="$HOME/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info"
  if [ -f "$MAIN_AUTHF" ] && grep -q '"workbuddy.cn"' "$MAIN_AUTHF" 2>/dev/null; then
    cp -f "$MAIN_AUTHF" "$ISOLATED_AUTHF" 2>/dev/null
  elif [ -f "$acdir/auth.info" ]; then
    cp -f "$acdir/auth.info" "$ISOLATED_AUTHF" 2>/dev/null
  fi
else
  if [ -f "$acdir/auth.info" ]; then
    cp -f "$acdir/auth.info" "$ISOLATED_AUTHF" 2>/dev/null
  fi
fi

export HOME="$ISOLATED_HOME"
exec "$BIN" "$@"
