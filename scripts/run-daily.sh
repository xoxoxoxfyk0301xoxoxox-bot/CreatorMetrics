#!/bin/zsh
set -u

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
cd "$PROJECT_DIR" || exit 1

NPM_EXECUTABLE="${CMC_NPM_PATH:-npm}"
exec "$NPM_EXECUTABLE" run daily
