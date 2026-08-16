#!/bin/zsh

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec "$script_dir/scripts/launch-hemlock.zsh" --repo-root "$script_dir"
