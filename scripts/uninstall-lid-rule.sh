#!/bin/zsh -f
# Removes the rule install-lid-rule.sh added. The lid switch then asks for nothing
# and simply fails with a note on how to install the rule again.
set -euo pipefail
[[ "$(/usr/bin/id -u)" == "0" ]] || { print -u2 -- "run it with sudo:  sudo ${0:A}"; exit 1; }
/bin/rm -f /etc/sudoers.d/pmset-disablesleep
/usr/sbin/visudo -c >/dev/null && print -- "Removed. sudo config checks out."
