# Makefile for wspsend-ms (WhatsApp pending-payments notifier)

# =============================================================================
# VARIABLES
# =============================================================================
DOCKER_USER = williams2022
IMAGE_NAME = $(DOCKER_USER)/wspsend-ms
TAG = latest
CONTAINER_NAME = wspsend-ms
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
docker-build: ## Build production Docker image
	@echo "$(CYAN)🐳 Building Docker image...$(NC)"
	docker build -t $(IMAGE_NAME):$(TAG) .
	@echo "$(GREEN)✅ Built: $(IMAGE_NAME):$(TAG)$(NC)"

.PHONY: docker-push
docker-push: docker-build ## Build and push image to Docker Hub
	docker login
	docker push $(IMAGE_NAME):$(TAG)
	@echo "$(GREEN)✅ Pushed $(IMAGE_NAME):$(TAG)$(NC)"

.PHONY: docker-run
docker-run: ## Run production container with .env
	docker run -d \
		--name $(CONTAINER_NAME) \
		-p $(PORT):$(DOCKER_PORT) \
		--env-file .env \
		--restart unless-stopped \
		$(IMAGE_NAME):$(TAG)
	@echo "$(GREEN)✅ Running at http://localhost:$(PORT)$(NC)"

.PHONY: docker-stop
docker-stop: ## Stop and remove container
	-docker stop $(CONTAINER_NAME)
	-docker rm $(CONTAINER_NAME)

.PHONY: docker-logs
docker-logs: ## Show container logs
	docker logs -f $(CONTAINER_NAME)

.DEFAULT_GOAL := help
