# Deployment: CI in GitHub Actions, CD in Argo CD

Two systems, one clean boundary:

- **GitHub Actions** builds images and writes the resulting tag into git. That's it. No
  workflow in this repo ever runs `kubectl` or holds a kubeconfig.
- **Argo CD** watches this repo's `k8s/overlays/{dev,uat,production}` paths and reconciles
  the live clusters to match whatever's in git. It owns every actual cluster change.

```
commit to services/<name>/  →  CI builds+pushes image, bumps overlay, commits
                                              │
                                              ▼
                              Argo CD notices the git change, applies the diff
```

## Kubernetes layout

```
k8s/
  base/                     # the 25 Deployments/Services + data layer + HPA/PDB
  overlays/
    dev/          -> namespace bakery-dev,  1 replica, dev.bakery.local
    uat/          -> namespace bakery-uat,  2 replicas, uat.bakery.local
    production/   -> namespace bakery-prod, 2 replicas + more CPU/mem, bakery.local
argocd/
  dev-app.yaml          # Argo Application: syncs k8s/overlays/dev  -> bakery-dev
  uat-app.yaml          # Argo Application: syncs k8s/overlays/uat  -> bakery-uat
  production-app.yaml   # Argo Application: syncs k8s/overlays/production -> bakery-prod
```

Nothing in `base/` names an environment; the overlay's `namespace:`, ingress-host patch, and
replicas/resources patch are the only per-environment knobs — same as before. What changed is
*who* applies the overlay to a cluster: it used to be a GitHub Actions job running `kubectl
apply`, now it's Argo CD's reconcile loop.

## CI: one workflow per service, CI only

```
.github/workflows/
  _service-pipeline.yml     # build + three sequential "bump the tag in git" jobs (reusable)
  auth-service.yml          # thin: "on push to services/auth-service/**, call the pipeline"
  user-service.yml
  ... (25 total, one per services/<name> directory)
.github/actions/bump-image/
  action.yml                 # kustomize edit set image + git commit + push - nothing else
```

### What a run does

For the one service whose files changed:

1. **build** — `docker buildx build` from `services/<name>/`, push to
   `ghcr.io/<org>/<repo>/<name>:<short-sha>`.
2. **bump-dev** — `kustomize edit set image` in `k8s/overlays/dev`, commit that one-line
   change to `main`.
3. **bump-uat** — same, against `k8s/overlays/uat`, only runs if bump-dev succeeded.
4. **bump-production** — same, against `k8s/overlays/production`, only runs if bump-uat
   succeeded.

Each job only ever edits one `image:` line for one service. Argo CD then applies just that
diff to the matching namespace — so even though an Argo Application covers the whole overlay,
the actual change it pushes to the cluster is scoped to the one service, exactly like before.

## Turning on manual approval for uat/production commits

The `bump-uat` and `bump-production` jobs target GitHub Environments named `uat` and
`production`. By default an Environment has no protection, so the tag-bump commit happens
automatically. To require sign-off before a service is even eligible to reach a given cluster:

**Settings → Environments → uat/production → Required reviewers** → add whoever should approve.

The workflow will pause after `bump-dev` succeeds and wait for approval before writing to the
uat overlay, then again before writing to the production overlay.

## Argo CD sync policy per environment

| Environment | Sync | Why |
|---|---|---|
| dev | automated, `prune: true`, `selfHeal: true` | fastest feedback, no gate needed beyond CI passing |
| uat | automated, `prune: true`, `selfHeal: true` | the GitHub Environment reviewer gate already ran before the commit landed |
| production | **manual** (no `automated:` block) | a second, independent action — `argocd app sync bakery-production` or clicking Sync in the UI — on top of the GitHub reviewer gate |

Adjust any of these in `argocd/<env>-app.yaml` to match your risk tolerance — e.g. add
`selfHeal: false` to uat if you want manual drift reconciliation there too.

## One-time setup

1. Install Argo CD in whichever cluster(s) will run it (can be one control cluster syncing to
   remote clusters, or one Argo CD per cluster — this repo doesn't assume either).
2. Edit `repoURL: https://github.com/<OWNER>/<REPO>.git` in all three `argocd/*.yaml` files to
   point at this repo.
3. Register the three Applications once:
   ```bash
   kubectl apply -f argocd/dev-app.yaml -f argocd/uat-app.yaml -f argocd/production-app.yaml \
     -n argocd
   ```
   From then on, Argo CD is the only thing that ever runs `kubectl apply` against dev/uat/prod.
4. Give the GitHub Actions runner a `GITHUB_TOKEN` with `contents: write` (already the case —
   see the `permissions:` block in every `<service>.yml`). No kubeconfig secrets are needed in
   GitHub at all anymore.

## Adding a 26th service

1. `services/<new-service>/` with its Dockerfile, same as any existing one.
2. `k8s/base/services/<new-service>.yaml`, added to `k8s/base/kustomization.yaml`.
3. Copy any existing `.github/workflows/<name>.yml`, sed the service name.

No changes to `_service-pipeline.yml`, the overlays, the Argo Applications, or any other
service's workflow — Argo CD picks up the new resource the next time it reconciles.
