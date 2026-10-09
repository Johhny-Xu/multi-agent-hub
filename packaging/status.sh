#!/bin/sh
exec "$(dirname -- "$0")/packaging/launch.sh" status "$@"
