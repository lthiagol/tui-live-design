# tui-live-design — task runner
# `make` or `make help` lists targets. Long-running targets (dev, logs) Ctrl+C to stop.

TOKEN := $(shell cat .design-token 2>/dev/null)
URL   := http://192.168.69.60:7422
MCP   := $(URL)/mcp
AUTH  := -H "Authorization: Bearer $(TOKEN)" -H "content-type: application/json" -H "accept: application/json, text/event-stream"

.PHONY: help install build test test-watch typecheck check dev serve start stop status restart logs url token bundle mcp-save mcp-load mcp-list clean

help: ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## install dependencies
	npm install --legacy-peer-deps

build: ## bundle the browser client to public/app.js
	npm run build

test: ## run the invariant test suite
	npx vitest run

test-watch: ## run tests in watch mode
	npx vitest

typecheck: ## tsc --noEmit
	npm run typecheck

check: typecheck test ## typecheck + tests (run before committing)

dev: ## dev servers (tsx watch + esbuild watch) — stop the service first
	@launchctl bootout gui/$$(id -u)/com.tui-live-design.canvas 2>/dev/null || true
	npm run dev

serve: ## run the built server once in the foreground (no watchers)
	npm start

start: ## start the launchd service (no-op if already running)
	@launchctl print gui/$$(id -u)/com.tui-live-design.canvas > /dev/null 2>&1 \
		&& echo "service already running" \
		|| { launchctl bootstrap gui/$$(id -u) $$HOME/Library/LaunchAgents/com.tui-live-design.canvas.plist \
			&& echo "service started"; }
	@sleep 1
	@$(MAKE) --no-print-directory status

status: ## check whether the canvas server is up and healthy
	@state=$$(launchctl print gui/$$(id -u)/com.tui-live-design.canvas 2>/dev/null | awk '/state =/ {print $$3; exit}'); \
	if [ -z "$$state" ]; then \
		echo "service:   not loaded"; \
	else \
		echo "service:   $$state"; \
	fi; \
	code=$$(curl -s -o /dev/null -w "%{http_code}" -m 3 "$(URL)/api/spec?token=$(TOKEN)"); \
	case "$$code" in \
		200) echo "canvas:    healthy (200)";; \
		401) echo "canvas:    responding but token rejected (401)";; \
		000) echo "canvas:    unreachable";; \
		*)   echo "canvas:    unexpected ($$code)";; \
	esac

restart: ## restart the launchd service (after server-code changes)
	npm run build
	launchctl kickstart -k gui/$$(id -u)/com.tui-live-design.canvas
	@sleep 1
	@tail -2 /tmp/tui-live-design.log

stop: ## stop the launchd service
	launchctl bootout gui/$$(id -u)/com.tui-live-design.canvas

logs: ## tail server logs
	tail -f /tmp/tui-live-design.log /tmp/tui-live-design.err.log

url: ## print the tokened canvas URL(s)
	@echo "token: $(TOKEN)"
	@for ip in 127.0.0.1 $$(ifconfig | awk '/inet /&&!/127/{print $$2}'); do echo "  http://$$ip:7422/?token=$(TOKEN)"; done

token: ## print the auth token
	@cat .design-token

bundle: ## export the deliverable bundle: make bundle NAME=my-design
	@if [ -z "$(NAME)" ]; then echo "usage: make bundle NAME=my-design"; exit 1; fi
	@sid=$$(curl -s -D - -o /dev/null $(AUTH) $(MCP) -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"make","version":"0"}}}' | grep -i mcp-session-id | awk '{print $$2}' | tr -d '\r'); \
		curl -s $(AUTH) -H "mcp-session-id: $$sid" $(MCP) -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null; \
		curl -s $(AUTH) -H "mcp-session-id: $$sid" $(MCP) -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"export_bundle","arguments":{"name":"$(NAME)"}}}' \
		| python3 -c "import json,sys; print(json.load(sys.stdin)['result']['content'][0]['text'])"

mcp-save: ## snapshot the current design: make mcp-save NAME=my-design
	@if [ -z "$(NAME)" ]; then echo "usage: make mcp-save NAME=my-design"; exit 1; fi
	@curl -s $(AUTH) "$(URL)/api/design/save" -d '{"name":"$(NAME)"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('saved:', d.get('ok'), d.get('file') or d.get('error'))"

mcp-load: ## load a saved design onto the canvas: make mcp-load NAME=my-design
	@if [ -z "$(NAME)" ]; then echo "usage: make mcp-load NAME=my-design"; exit 1; fi
	@curl -s $(AUTH) "$(URL)/api/design/load" -d '{"name":"$(NAME)"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('loaded:', d.get('ok'), 'rev', d.get('rev') or d.get('error'))"

mcp-list: ## list saved designs
	@curl -s $(AUTH) "$(URL)/api/design/list" | python3 -m json.tool

clean: ## remove build artifacts and temp files
	rm -rf public/app.js public/app.js.map
	find . -name "*.tmp-*" -not -path "./node_modules/*" -delete
