# Heimdall — Deployment Guide

This document covers the recommended deployment strategies for Heimdall and
explains the tradeoffs between each option.

## TL;DR

**Recommended: EKS Pod (in-cluster).** Deploy Heimdall as a Kubernetes Deployment
inside your EKS cluster using the provided Terraform module. This gives you full
feature parity, native kubectl access, seamless IRSA credential injection, and no
timeout constraints.

Lambda works only for lightweight, one-shot `/api/diagnose` calls and cannot run
watch, schedule, session, or alert modes.

---

## Option 1: EKS Pod (in-cluster) — Recommended

Run Heimdall as a `Deployment` inside your EKS cluster, exactly like any other
service. The existing `terraform/` module and `deploy/` manifests are built for
this path.

### Why this is the right default

| Concern | Details |
|---------|---------|
| **kubectl access** | In-cluster pod hits the Kubernetes API server directly over the pod network — no VPN, no proxy, no extra hop. |
| **No timeout limit** | Long AI diagnosis sessions, watch mode (continuous event monitoring), and schedule mode (cron sweeps) all run uninterrupted. |
| **All modes available** | `heimdall serve`, `watch`, `schedule`, `alert`, `session`, `triage`, and `mcp` all work as expected. |
| **IRSA** | Annotate the ServiceAccount with an IAM Role ARN (`irsa_role_arn` Terraform variable); the pod automatically gets scoped AWS credentials via the EKS OIDC provider. No long-lived keys needed. |
| **Existing artifacts** | `terraform/`, `deploy/`, and `helm/heimdall/` are ready to use. |

### Deployment paths

#### Raw kubectl manifests

```bash
# 1. Apply RBAC (cluster-wide read-only)
kubectl apply -f deploy/rbac.yaml

# 2. Inject Anthropic API key
kubectl create secret generic heimdall-api-key \
  --namespace heimdall \
  --from-literal=ANTHROPIC_API_KEY=<key>

# 3. Deploy
kubectl apply -f deploy/deployment.yaml
kubectl apply -f deploy/service.yaml
```

After the pod is ready, verify the health endpoint:

```bash
kubectl run --rm curl --image=curlimages/curl --restart=Never -- \
  curl -sf http://heimdall.heimdall/api/health
```

For namespaced-only access use `deploy/rbac-namespaced.yaml` instead of `rbac.yaml`.
For AWS CLI tool support (IRSA), apply `deploy/rbac-irsa.yaml`.

#### Terraform

The `terraform/` module provisions everything: Namespace, ServiceAccount (with
optional IRSA annotation), ClusterRole/Binding, Secrets, ConfigMap, and
Deployment.

```hcl
module "heimdall" {
  source            = "./terraform"
  anthropic_api_key = var.anthropic_api_key
  irsa_role_arn     = aws_iam_role.heimdall.arn   # optional — for aws_cli tool
  image_tag         = "0.2.0"

  tools = {
    aws_cli        = true
    prometheus_url = "http://prometheus.monitoring:9090"
  }
}
```

Key variables: `namespace`, `image_repository`, `image_tag`, `irsa_role_arn`,
`slack_webhook_url`, `model`, `resources`, `tools`.

#### Helm

```bash
helm upgrade --install heimdall helm/heimdall \
  --namespace heimdall --create-namespace \
  --set anthropicApiKey=<key> \
  --set image.tag=0.2.0
```

### Container image

```bash
# Build
docker build -t ghcr.io/billzhuang/heimdall:0.2.0 .

# Push
docker push ghcr.io/billzhuang/heimdall:0.2.0
```

The image runs as a non-root user with a read-only root filesystem; only `/tmp`
is writable (mounted as `emptyDir`). It listens on port 3000.

### IRSA setup (for `aws_cli` tool)

```hcl
# Minimal IAM policy — read-only AWS access
resource "aws_iam_role" "heimdall" {
  name               = "heimdall-eks"
  assume_role_policy = data.aws_iam_policy_document.heimdall_oidc.json
}

locals {
  # Strip the https:// prefix so the OIDC subject condition matches the format
  # used by the EKS token projector.
  oidc_issuer = trimprefix(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://")
}

data "aws_iam_policy_document" "heimdall_oidc" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:heimdall:heimdall"]
    }
  }
}

# Attach AWS-managed read-only policies as needed, e.g.:
resource "aws_iam_role_policy_attachment" "readonly" {
  role       = aws_iam_role.heimdall.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
```

---

## Option 2: AWS Lambda (limited use)

Lambda is viable only for stateless one-shot diagnose calls. Several Heimdall
features cannot run in Lambda:

| Feature | Lambda support |
|---------|---------------|
| `POST /api/diagnose` (serve mode) | ✅ Works (with Function URL or API GW) |
| `heimdall triage` | ⚠️ May work for small clusters (< 5 min) |
| `heimdall watch` | ❌ Requires persistent process |
| `heimdall schedule` | ❌ Requires persistent process |
| `heimdall session` | ❌ Requires persistent process |
| `heimdall alert` (PagerDuty) | ✅ Works (Lambda as webhook target) |
| MCP server mode | ❌ Requires stdio transport |

### Constraints

- **15-minute hard timeout.** An AI diagnosis on a busy cluster can exceed this,
  especially when multiple subagents are invoked.
- **Cold starts.** Node.js container Lambda cold starts add 1–5 s of latency,
  frustrating interactive use.
- **VPC access required.** Heimdall needs to reach the EKS API server. Place the
  Lambda in the same VPC and security group, or expose the cluster endpoint
  publicly.
- **No native kubectl credential injection.** IRSA via EKS Pod OIDC is not
  available in Lambda; you must pass a kubeconfig via environment variable or
  Secrets Manager.
- **kubectl binary must be bundled** in the container image (already true with
  the existing Dockerfile).

### When Lambda makes sense

- You want Heimdall only as a CI/CD webhook (e.g., run a triage on every deploy
  and fail the pipeline on critical findings).
- You already have a Lambda-heavy infra and want to minimise new services.
- Traffic is very low (a few calls per day) and cost is a concern.

### Lambda handler

`src/lambda-handler.ts` provides a ready-to-use Lambda handler built on
[Hono's official `aws-lambda` adapter](https://hono.dev/docs/getting-started/aws-lambda).
It wraps `createServeApp()` (the same Hono app as serve mode) and supports:

- Lambda Function URLs
- API Gateway HTTP API (payload format 2.0)
- Application Load Balancer

Export the handler from `dist/server.mjs` as `module.handler`:

```typescript
// dist/server.mjs (built by flue)
export { handler } from './lambda-handler.js';
```

Environment variables read at cold-start:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | **Required.** Anthropic API key |
| `HEIMDALL_API_KEY` | Optional Bearer token auth (all routes except `/api/health`) |
| `HEIMDALL_MODEL` | Optional model override (`provider/model` format) |
| `HEIMDALL_CONFIG_YAML` | Optional raw YAML config (no filesystem needed) |
| `KUBECONFIG` | Path to kubeconfig (e.g. `/tmp/kubeconfig` injected at startup) |
| `OTEL_SERVICE_NAME` | Optional service name for Prometheus metrics labels |

### Container image requirements for `--handler`

The `--handler` flag in `aws lambda create-function` only works when the
container image includes the **Lambda Runtime Interface Client (LRIC)**.  The
standard `Dockerfile` uses `node:22-slim` which does **not** include the LRIC.
Choose one of the two approaches below depending on whether you want to bundle
the LRIC into the image or add it via a Lambda layer at deploy time.

---

#### Approach A: `Dockerfile.lambda` — self-contained (recommended)

`Dockerfile.lambda` uses `public.ecr.aws/lambda/nodejs22.x` as the runtime
base image.  That image ships the LRIC and supports the `--handler` flag
and ESM modules (`.mjs`) out of the box.  No extra Lambda layers are needed.

```bash
# 1. Build the Lambda-specific container image
docker build -f Dockerfile.lambda -t heimdall-lambda .

# 2. Tag and push to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag heimdall-lambda <account>.dkr.ecr.<region>.amazonaws.com/heimdall-lambda:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/heimdall-lambda:latest

# 3. Create the function
aws lambda create-function \
  --function-name heimdall \
  --package-type Image \
  --code ImageUri=<account>.dkr.ecr.<region>.amazonaws.com/heimdall-lambda:latest \
  --role arn:aws:iam::<account>:role/heimdall-lambda \
  --handler dist/server.handler \
  --timeout 900 \
  --memory-size 1024 \
  --environment "Variables={ANTHROPIC_API_KEY=<key>,KUBECONFIG=/tmp/kubeconfig}"

# 4. (Optional) Enable a Function URL for direct HTTPS access
aws lambda create-function-url-config \
  --function-name heimdall \
  --auth-type NONE   # use HEIMDALL_API_KEY for app-level Bearer token auth instead
```

---

#### Approach B: Lambda Web Adapter layer — uses the standard `Dockerfile`

The [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
is a Lambda extension that converts Lambda events into HTTP requests and proxies
them to a local HTTP server.  It works with the standard `Dockerfile` (no LRIC
required) by adding a single Lambda layer at deploy time.  The `--handler` flag
is **not** used with this approach; the Lambda Web Adapter intercepts invocations
before the handler is called and forwards them as HTTP requests to port 3000.

```bash
# 1. Build the standard container image (no changes to Dockerfile needed)
docker build -t heimdall-lambda .

# 2. Tag and push to ECR  (same as above)
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag heimdall-lambda <account>.dkr.ecr.<region>.amazonaws.com/heimdall:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/heimdall:latest

# 3. Create the function with the Lambda Web Adapter layer
#    Replace <region> with your deployment region.
#    x86_64 layer ARN: arn:aws:lambda:<region>:753240598075:layer:LambdaAdapterLayerX86:24
#    arm64  layer ARN: arn:aws:lambda:<region>:753240598075:layer:LambdaAdapterLayerArm64:24
aws lambda create-function \
  --function-name heimdall \
  --package-type Image \
  --code ImageUri=<account>.dkr.ecr.<region>.amazonaws.com/heimdall:latest \
  --role arn:aws:iam::<account>:role/heimdall-lambda \
  --timeout 900 \
  --memory-size 1024 \
  --layers arn:aws:lambda:<region>:753240598075:layer:LambdaAdapterLayerX86:24 \
  --environment "Variables={ANTHROPIC_API_KEY=<key>,KUBECONFIG=/tmp/kubeconfig,AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap,PORT=3000}"

# 4. (Optional) Enable a Function URL for direct HTTPS access
aws lambda create-function-url-config \
  --function-name heimdall \
  --auth-type NONE   # use HEIMDALL_API_KEY for app-level Bearer token auth instead
```

---

For VPC placement (required to reach a private EKS API server):

```bash
aws lambda update-function-configuration \
  --function-name heimdall \
  --vpc-config SubnetIds=<subnet-a>,<subnet-b>,SecurityGroupIds=<sg-id>
```

---

## Option 3: AWS Fargate (middle ground)

Fargate runs the same Kubernetes `Deployment` as Option 1 but on serverless
compute — no EC2 node management. It sits between Lambda (fully serverless, very
limited) and a managed node group (full control, more ops burden).

```bash
# Add Fargate profile for the heimdall namespace
eksctl create fargateprofile \
  --cluster <cluster-name> \
  --name heimdall \
  --namespace heimdall
```

Then deploy using the same manifests as Option 1. The pod runs on Fargate
automatically when its namespace matches the profile selector.

Fargate constraints that matter for Heimdall:
- No `DaemonSet` support (not needed here).
- Slightly higher cold-start latency on pod restarts (~30 s vs ~5 s for node pool).
- No `hostNetwork` or `hostPath` (Heimdall doesn't need either).
- EKS Pod OIDC / IRSA works normally.

---

## Option 4: EC2 (bare metal / simple)

Run the compiled binary directly on an EC2 instance. Suitable for a dev/test
environment or a one-person team that doesn't want Kubernetes overhead.

```bash
# On the EC2 instance
npm run build                       # produces dist/server.mjs
export ANTHROPIC_API_KEY=<key>
export KUBECONFIG=~/.kube/config    # or use aws eks update-kubeconfig
node dist/server.mjs                # or use systemd / pm2 for process management
```

Use an EC2 instance profile (IAM role attached to the instance) for AWS CLI
credentials instead of IRSA.

---

## Decision matrix

| Requirement | EKS Pod | Lambda | Fargate | EC2 |
|-------------|---------|--------|---------|-----|
| Full feature parity | ✅ | ❌ | ✅ | ✅ |
| Watch / schedule / session | ✅ | ❌ | ✅ | ✅ |
| No server management | ✅ (with Terraform) | ✅ | ✅ | ❌ |
| IRSA / native AWS creds | ✅ | ❌ (workaround) | ✅ | ✅ (instance profile) |
| Existing Terraform support | ✅ | ❌ | ✅ (same module) | ❌ |
| Cost at low traffic | Medium | Low | Medium | Low |
| Cold start latency | Low | High | Medium | None |
| Ops complexity | Low | Low | Low | Medium |

**Summary:** Use **EKS Pod** (Option 1) for any production deployment where you
want the full Heimdall feature set. Use **Lambda** (Option 2) only if you need a
lightweight CI webhook and can live without watch/session/schedule modes. Use
**Fargate** (Option 3) if you're already on EKS Fargate and want to avoid mixed
node pool management. Use **EC2** (Option 4) for local dev or a quick trial.
Use **Cloudflare** (Option 5) when you want a globally-distributed edge deployment
with zero infrastructure management and only need HTTP-based observability tools.

---

## Option 5: Cloudflare Workers (edge / observability-only)

Deploy Heimdall as a Cloudflare Durable Object via the
[Flue Cloudflare target](https://blog.cloudflare.com/agents-platform-flue-sdk/).
The Flue runtime maps each agent to a Durable Object class, giving you
stateful, long-lived conversations at the edge with zero server management.

### Limitations

Cloudflare Workers **cannot** spawn subprocesses (`execFile` / `child_process`
is not available). Tools that shell out to external binaries are therefore
incompatible with the Workers runtime:

| Tool | Cloudflare Workers |
|------|--------------------|
| `kubectl` | ❌ Requires subprocess |
| `listContexts` / `listNamespaces` | ❌ Requires subprocess |
| `helmRelease` | ❌ Requires subprocess |
| `awsCli` | ❌ Requires subprocess |
| `trivyScan` | ❌ Requires subprocess |
| `cdkQuery` | ❌ Requires subprocess |
| `prometheusQuery` | ✅ HTTP (fetch) |
| `lokiQuery` | ✅ HTTP (fetch) |
| `jaegerQuery` | ✅ HTTP (fetch) |
| `datadogQuery` | ✅ HTTP (fetch) |
| `newRelicQuery` | ✅ HTTP (fetch) |
| `kubecostQuery` | ✅ HTTP (fetch) |

**Use this deployment when** you want AI-powered analysis of metrics, logs, and
traces from Prometheus/Loki/Jaeger/Datadog/New Relic without needing kubectl
access to a live cluster.

### Prerequisites

```bash
npm install          # installs wrangler from devDependencies
npx wrangler login   # authenticate with your Cloudflare account
```

### Deployment steps

```bash
# 1. Build for Cloudflare Workers target
npm run build:cloudflare

# 2. (Optional) Set ANTHROPIC_API_KEY if you prefer Anthropic over Workers AI
npx wrangler secret put ANTHROPIC_API_KEY

# 3. Set API keys for any observability tools you enable
npx wrangler secret put DD_API_KEY           # Datadog
npx wrangler secret put DD_APP_KEY           # Datadog
npx wrangler secret put NEW_RELIC_API_KEY    # New Relic
npx wrangler secret put NEW_RELIC_ACCOUNT_ID # New Relic (required alongside API key)

# 4. Deploy
npm run deploy:cloudflare
```

`npm run deploy:cloudflare` runs `flue build --target cloudflare` and then
`npx wrangler deploy --config dist/heimdall/wrangler.json`. Flue generates the
final `wrangler.json` (with Durable Object bindings) at build time; always deploy
from that generated config, not the source-root `wrangler.jsonc`.

### Configuration

Cloudflare Workers have no local filesystem, so `HEIMDALL_CONFIG` (file path)
does not work. Instead, pass the raw YAML content via `HEIMDALL_CONFIG_YAML`.
The repo ships `heimdall.config.cloudflare.yaml` as a ready-to-use template.

**Option A — Wrangler secret (recommended):**

```bash
npx wrangler secret put HEIMDALL_CONFIG_YAML
# paste the contents of heimdall.config.cloudflare.yaml when prompted
```

**Option B — inline in `wrangler.jsonc` vars (visible in source, OK for non-sensitive config):**

```jsonc
"vars": {
  "HEIMDALL_CONFIG_YAML": "tools:\n  kubectl: false\n  listContexts: false\n  listNamespaces: false\n  helmRelease: false\n  awsCli: false\n  trivyScan: false\n  cdkQuery: false\n  prometheusQuery: true\nprometheus:\n  url: \"https://prometheus.example.com\"\n"
}
```

Edit `heimdall.config.cloudflare.yaml` to enable the HTTP-based observability
tools you have before pasting, then redeploy.

### Model selection

By default `wrangler.jsonc` uses **Cloudflare Workers AI** — no external API
key is required, and usage is billed through your Workers AI plan:

```jsonc
// wrangler.jsonc
"vars": {
  "HEIMDALL_MODEL": "cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
}
```

To use an Anthropic model instead, update `wrangler.jsonc` and add the key:

```jsonc
// wrangler.jsonc
"vars": {
  "HEIMDALL_MODEL": "anthropic/claude-sonnet-4-6"
}
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

### Architecture: hybrid Cloudflare + in-cluster agent

For full kubectl access combined with edge delivery, run Heimdall in two tiers:

```
User request
    │
    ▼
Cloudflare Worker (edge)
  • Receives webhook / API call
  • Routes to in-cluster Heimdall via service URL
    │
    ▼
EKS Pod (in-cluster Heimdall)
  • Full kubectl + all tools
  • Responds with structured diagnosis
    │
    ▼
Cloudflare Worker
  • Formats and returns the response
```

In this setup the Cloudflare Worker acts as an authenticated API gateway,
while the EKS pod (Option 1) performs the actual cluster diagnosis.
