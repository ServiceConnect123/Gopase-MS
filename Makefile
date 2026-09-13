# Makefile for wspsend-ms (WhatsApp pending-payments notifier)

# =============================================================================
# VARIABLES
# =============================================================================
DOCKER_USER = williams2022
IMAGE_NAME = $(DOCKER_USER)/wspsend-ms

# Entorno: por defecto se deduce de la rama git actual (qa, main, ...).
# Se puede forzar con: make docker-build ENV=qa
GIT_BRANCH := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null)
ENV ?= $(GIT_BRANCH)

# Tag de la imagen según el entorno:
#   main / master  -> latest
#   qa             -> qa
#   cualquier otro -> el nombre del entorno
ifeq ($(ENV),main)
  TAG ?= latest
else ifeq ($(ENV),master)
  TAG ?= latest
else
  TAG ?= $(ENV)
endif

# Nombre del contenedor local, sufijado por entorno para no colisionar
# (wspsend-ms, wspsend-ms-qa, ...).
ifeq ($(TAG),latest)
  CONTAINER_NAME = wspsend-ms
else
  CONTAINER_NAME = wspsend-ms-$(TAG)
endif

PORT = 3001
DOCKER_PORT = 3001

CYAN = \033[96m
GREEN = \033[92m
YELLOW = \033[93m
RED = \033[91m
NC = \033[0m

.PHONY: help
help: ## Show this help message
	@echo "$(CYAN)wspsend-ms - Available Commands:$(NC)"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; printf "$(GREEN)Usage: make <command>$(NC)\n\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  $(CYAN)%-20s$(NC) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

##@ Development
.PHONY: install
install: ## Install dependencies
	npm install

.PHONY: dev
dev: ## Start dev server with hot reload
	npm run start:dev

.PHONY: build
build: ## Build the project
	npm run build

.PHONY: start
start: ## Start production server
	npm run start:prod

##@ Docker
.PHONY: docker-build
docker-build: ## Build Docker image for current branch/ENV (ENV=qa forces qa)
	@echo "$(CYAN)🐳 Building Docker image ($(YELLOW)env=$(ENV)$(CYAN))...$(NC)"
	docker build \
		--build-arg APP_ENV=$(ENV) \
		-t $(IMAGE_NAME):$(TAG) .
	@echo "$(GREEN)✅ Built: $(IMAGE_NAME):$(TAG)$(NC)"

.PHONY: docker-push
docker-push: docker-build ## Build and push image to Docker Hub (tag from ENV)
	docker login
	docker push $(IMAGE_NAME):$(TAG)
	@echo "$(GREEN)✅ Pushed $(IMAGE_NAME):$(TAG)$(NC)"

##@ Docker (QA)
.PHONY: docker-build-qa
docker-build-qa: ## Build the QA image (wspsend-ms:qa)
	$(MAKE) docker-build ENV=qa

.PHONY: docker-push-qa
docker-push-qa: ## Build and push the QA image (wspsend-ms:qa)
	$(MAKE) docker-push ENV=qa

.PHONY: docker-run-qa
docker-run-qa: ## Run the QA container with .env.qa (falls back to .env)
	$(MAKE) docker-run ENV=qa ENV_FILE=$(if $(wildcard .env.qa),.env.qa,.env)

.PHONY: docker-run
docker-run: ## Run container for ENV (uses ENV_FILE or .env)
	docker run -d \
		--name $(CONTAINER_NAME) \
		-p $(PORT):$(DOCKER_PORT) \
		--env-file $(if $(ENV_FILE),$(ENV_FILE),.env) \
		--restart unless-stopped \
		$(IMAGE_NAME):$(TAG)
	@echo "$(GREEN)✅ Running $(IMAGE_NAME):$(TAG) at http://localhost:$(PORT)$(NC)"

.PHONY: docker-stop
docker-stop: ## Stop and remove container
	-docker stop $(CONTAINER_NAME)
	-docker rm $(CONTAINER_NAME)

.PHONY: docker-logs
docker-logs: ## Show container logs
	docker logs -f $(CONTAINER_NAME)

.DEFAULT_GOAL := help
