#!/bin/zsh -f
# Lets Gus Assistant's "Awake with the lid closed" switch work without a password.
#
#   sudo ./scripts/install-lid-rule.sh            # for the user running sudo
#   sudo ./scripts/install-lid-rule.sh someone    # for another user
#
# `-f` matters: without it zsh would read the caller's ~/.zshenv, and since sudo
# keeps the caller's HOME, that file would run as root.
#
# The rule grants exactly two literal commands and nothing else:
#   /usr/bin/pmset -a disablesleep 0
#   /usr/bin/pmset -a disablesleep 1
# No wildcard (a `*` would match across spaces and let other pmset settings in),
# no shell, no SETENV. It is written to a temporary file, checked with
# `visudo -c -f`, installed, and the whole sudo config is checked again; a broken
# file in /etc/sudoers.d breaks sudo itself, so checking always comes first.
# Exits 0 only once the allowed command passes and two broader ones are refused.
#
# Remove it with:  sudo ./scripts/uninstall-lid-rule.sh
set -euo pipefail

RULE_FILE="/etc/sudoers.d/pmset-disablesleep"   # no dot in the name: sudo skips files with one
TMP_FILE="$(/usr/bin/mktemp /tmp/pmset-disablesleep.XXXXXX)"
trap '/bin/rm -f "$TMP_FILE"' EXIT
die() { print -u2 -- "ERROR: $*"; exit 1; }

[[ "$(/usr/bin/id -u)" == "0" ]] || die "run it with sudo:  sudo ${0:A}"

TARGET_USER="${1:-${SUDO_USER:-}}"
[[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]] || die "say which user gets the rule:  sudo ${0:A} <short user name>"
# sudoers reads the first word as a user NAME; a bare UID would install a rule that never matches.
[[ "$TARGET_USER" =~ '^[a-z_][a-z0-9_-]*$' ]] || die "'$TARGET_USER' isn't a short user name (a UID like 501 won't do)."
/usr/bin/id -u "$TARGET_USER" >/dev/null 2>&1 || die "user '$TARGET_USER' doesn't exist."
print -- "user: $TARGET_USER"

print -- "\n[1/5] /etc/sudoers reads /etc/sudoers.d?"
INCLUDE_RE='^[[:space:]]*[#@]includedir[[:space:]]+(/private)?/etc/sudoers\.d/?[[:space:]]*$'
/usr/bin/grep -nE "$INCLUDE_RE" /etc/sudoers || die "no includedir line points at /etc/sudoers.d, so the rule would be ignored. Add '@includedir /etc/sudoers.d' with 'sudo visudo' and run this again."

print -- "\n[2/5] writing the rule"
/bin/cat > "$TMP_FILE" <<RULE
$TARGET_USER ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1
RULE
/bin/chmod 0600 "$TMP_FILE"
/bin/cat "$TMP_FILE"

print -- "\n[3/5] checking it with visudo"
/usr/sbin/visudo -c -f "$TMP_FILE" || die "the rule didn't pass visudo. Nothing was installed."

print -- "\n[4/5] installing $RULE_FILE (0440 root:wheel)"
/usr/bin/install -m 0440 -o root -g wheel "$TMP_FILE" "$RULE_FILE"
if ! /usr/sbin/visudo -c >/dev/null 2>&1; then
  /bin/rm -f "$RULE_FILE"
  die "the full sudo config failed visudo with the rule in it, so it was removed again. sudo is unchanged."
fi

print -- "\n[5/5] checking the policy (nothing here changes pmset)"
/usr/bin/sudo -n -l -U "$TARGET_USER" /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1 \
  || die "sudo still doesn't allow 'pmset -a disablesleep 1' for $TARGET_USER. Remove the rule with: sudo ${0:A:h}/uninstall-lid-rule.sh"
print -- "      allowed: pmset -a disablesleep 1"
if /usr/bin/sudo -n -l -U "$TARGET_USER" /usr/bin/pmset -a disablesleep 1 extra 1 >/dev/null 2>&1; then
  die "sudo allowed extra arguments, which is too broad. Remove it now: sudo ${0:A:h}/uninstall-lid-rule.sh"
fi
if /usr/bin/sudo -n -l -U "$TARGET_USER" /usr/bin/pmset -a hibernatemode 0 >/dev/null 2>&1; then
  die "sudo allowed another pmset setting, which is too broad. Remove it now: sudo ${0:A:h}/uninstall-lid-rule.sh"
fi
print -- "      refused: anything broader"
print -- "\nDone and checked. The lid switch in Gus Assistant now works without a password."
