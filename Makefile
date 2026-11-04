# Build and test automation for the server, which is the whole repository: the Go
# binaries live under cmd/, and the canvas frontend is a self-contained subtree
# under frontend/.
#
# Two binaries, both statically linked:
#   bin/comfyloft-server  the service (HTTP API, workflows, the canvas's websocket)
#   bin/comfyloft-mcp    the stdio bridge AlayaCore spawns to reach the canvas tools
#
# CGO is disabled for both. That is not a micro optimisation: a cgo build would
# reintroduce a libc dependency that breaks when the host is upgraded. Nothing in
# this module needs cgo, so the constraint costs us nothing.

GO      ?= go
BIN_DIR := bin
BIN     := $(BIN_DIR)/comfyloft-server
MCP_BIN := $(BIN_DIR)/comfyloft-mcp
SERVER_PKG := ./cmd/comfyloft-server
MCP_PKG     := ./cmd/comfyloft-mcp

# The frontend is a separate npm project under frontend/. `build` stays Go-only on
# purpose, so the bundle has its own entry points: `frontend-deps` installs,
# `frontend` builds, `frontend-check` typechecks.
FRONTEND_DIR   := frontend
NPM            ?= npm
FRONTEND_STAMP := $(FRONTEND_DIR)/node_modules/.package-lock.json
# Every Go package lives under cmd/, internal/ or tools/. Listing them keeps the gates
# off the vendored frontend: `./...` would walk frontend/node_modules, and a
# stray .go file in a future npm package would then break `make check`.
PKGS    := ./cmd/... ./internal/... ./tools/...
GO_DIRS := cmd internal
GOFLAGS := -trimpath
LDFLAGS := -s -w

# Force a static, dependency-free binary for every target including tests.
export CGO_ENABLED := 0

.DEFAULT_GOAL := build
.PHONY: build run test test-race test-v vet fmt fmt-check lint check check-full deadcode verify-static size clean tidy frontend frontend-deps frontend-check frontend-clean help

build: ## Compile both binaries into bin/
	@mkdir -p $(BIN_DIR)
	$(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) $(SERVER_PKG)
	$(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(MCP_BIN) $(MCP_PKG)
	@echo "built $(BIN) $(MCP_BIN)"

run: ## Run the server from source, serving the built canvas bundle
	WEB_DIR=$(FRONTEND_DIR)/dist $(GO) run $(SERVER_PKG)

frontend-deps: ## Install frontend dependencies when node_modules is missing or stale
	@if [ ! -f $(FRONTEND_STAMP) ] || [ $(FRONTEND_DIR)/package-lock.json -nt $(FRONTEND_STAMP) ]; then \
		echo "installing frontend dependencies ($(FRONTEND_DIR))"; \
		cd $(FRONTEND_DIR) && $(NPM) ci || exit 1; \
	else \
		echo "frontend dependencies up to date"; \
	fi

frontend: ## Build the canvas bundle into frontend/dist
	@$(MAKE) --no-print-directory frontend-deps
	cd $(FRONTEND_DIR) && $(NPM) run build
	@test -f $(FRONTEND_DIR)/dist/index.html || { echo "ERROR: frontend build produced no dist/index.html"; exit 1; }
	@echo "built $(FRONTEND_DIR)/dist"

frontend-check: ## Typecheck the frontend sources (tsc --noEmit)
	@$(MAKE) --no-print-directory frontend-deps
	cd $(FRONTEND_DIR) && $(NPM) run typecheck

frontend-clean: ## Remove the frontend build output
	rm -rf $(FRONTEND_DIR)/dist

test: ## Run the test suite
	$(GO) test $(PKGS)

# The race detector needs cgo, so this target re-enables it for the test binary
# only. The shipped server stays CGO_ENABLED=0 and fully static.
# The Go half of frontend/scripts/check-exports.cjs: an exported identifier nothing outside its own file can
# reach. `go vet` does not look at reachability, and golangci-lint's `unused` only sees unexported names, so
# without this a function whose last caller a refactor removed stays behind, still compiling and still claiming a
# capability.
deadcode: ## Fail if an exported Go identifier is reachable only from its own file
	@$(GO) run ./tools/deadcode

test-race: ## Run the test suite with the race detector (needs a C toolchain)
	CGO_ENABLED=1 $(GO) test -race $(PKGS)

test-v: ## Run the test suite verbosely
	$(GO) test -v $(PKGS)

vet: ## Run go vet
	$(GO) vet $(PKGS)

fmt: ## Format all Go sources
	gofmt -w $(GO_DIRS)

fmt-check: ## Fail if any file needs formatting
	@needs_format=$$(gofmt -l $(GO_DIRS)); \
	if [ -n "$$needs_format" ]; then \
		echo "gofmt required for:"; echo "$$needs_format"; exit 1; \
	fi

lint: fmt-check vet ## Check formatting and run vet

check: lint test deadcode ## The default gate: no C toolchain required

verify-static: build ## Assert both binaries have no dynamic dependencies
	@for binary in $(BIN) $(MCP_BIN); do \
		if ldd $$binary >/dev/null 2>&1; then \
			echo "ERROR: $$binary is dynamically linked"; ldd $$binary; exit 1; \
		fi; \
		echo "static: $$binary has no dynamic dependencies"; \
		file $$binary; \
	done

check-full: lint test-race ## The strict gate, including the race detector

size: build ## Report the binaries' size
	@ls -lh $(BIN) $(MCP_BIN)

clean: ## Remove build artifacts
	rm -rf $(BIN_DIR)

tidy: ## Prune and verify go.mod
	$(GO) mod tidy

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'
