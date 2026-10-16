#!/bin/sh
exec sh "$(dirname -- "$0")/packaging/launch.sh" install "$@"
