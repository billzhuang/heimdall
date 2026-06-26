# Heimdall — AWS Deployment Guide

This document covers the recommended AWS deployment strategies for Heimdall and
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
  --set secrets.anthropicApiKey=<key> \
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

### Lambda deployment sketch

```bash
# 1. Build the image
docker build -t heimdall-lambda .

# 2. Tag and push to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag heimdall-lambda <account>.dkr.ecr.<region>.amazonaws.com/heimdall:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/heimdall:latest

# 3. Create the function (container image Lambda)
aws lambda create-function \
  --function-name heimdall \
  --package-type Image \
  --code ImageUri=<account>.dkr.ecr.<region>.amazonaws.com/heimdall:latest \
  --role arn:aws:iam::<account>:role/heimdall-lambda \
  --timeout 900 \
  --memory-size 1024 \
  --environment "Variables={ANTHROPIC_API_KEY=<key>,KUBECONFIG=/tmp/kubeconfig}"
```

The container entry point needs a Lambda handler wrapper (not yet included in the
image). The existing Dockerfile targets `flue` CLI mode; a separate Lambda
handler that calls `runHarness()` would be required.

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
