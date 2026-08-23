#!/usr/bin/env bash
# Always pull origin/test and rebuild the LAN test host.
# Usage on the host:  ~/TraceAI/deploy/remote-update-test.sh
# Usage from Windows: ssh joostvl@192.168.1.185 ~/update-test.sh
set -Eeuo pipefail
export TRACEAI_BRANCH=test
export TRACEAI_LAN_HOST=192.168.1.185
export TRACEAI_PUBLIC_ORIGIN=
exec "$(cd "$(dirname "$0")" && pwd)/remote-update.sh"
