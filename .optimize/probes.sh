build | 3 | cd dream-chat && npm run build
agent-tests | 3 | cd dream-chat && npm run test:agent
ui-tests | 3 | cd dream-chat && npm run test:ui
syntax | 3 | node --check dream-chat/electron/main.cjs && node --check dream-chat/electron/preload.cjs && node --check dream-chat/electron/provider_adapters.cjs
maple-health | 1 | zsh .optimize/maple_health_probe.sh
maple-stream-dispatch | 3 | node .optimize/maple_stream_dispatch_probe.cjs
artifact-autopilot | 3 | cd dream-chat && npm run test:e2e:artifact-autopilot
