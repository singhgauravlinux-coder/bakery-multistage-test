.PHONY: up down logs ps smoke k8s-deploy k8s-deploy-fast k8s-diff k8s-delete k8s-status

## ---------- docker compose (local / client demo) ----------
up:            ## Build and start the whole stack
	docker compose up --build -d
	@echo "Frontend  → http://localhost:8080"
	@echo "API       → http://localhost:3000/api/products"
	@echo "Adminer   → http://localhost:8081  (postgres / bakery / bakery)"

down:          ## Stop everything (add -v manually to wipe data)
	docker compose down

logs:          ## Tail JSON logs from every service
	docker compose logs -f --tail=50

ps:
	docker compose ps

smoke:         ## Quick end-to-end check against the local stack
	./scripts/smoke-test.sh

## ---------- kubernetes ----------
# Every k8s-* target takes ENV=dev|uat|production (defaults to dev), e.g.:
#   make k8s-deploy ENV=uat
ENV ?= dev

k8s-deploy:    ## Sequential rollout to $(ENV): each service must be healthy before the next
	./scripts/deploy.sh $(ENV)

k8s-deploy-fast: ## Old behaviour: apply the full $(ENV) overlay at once (no per-service checks)
	kubectl apply -k k8s/overlays/$(ENV)

k8s-diff:      ## Preview what would change in $(ENV) without applying it
	kubectl diff -k k8s/overlays/$(ENV) || true

k8s-delete:    ## Tear down $(ENV)
	kubectl delete namespace bakery-$(if $(filter production,$(ENV)),prod,$(ENV))

k8s-status:
	kubectl -n bakery-$(if $(filter production,$(ENV)),prod,$(ENV)) get pods,svc,ingress,hpa
