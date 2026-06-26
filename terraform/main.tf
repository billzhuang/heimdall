locals {
  name = "heimdall"

  # tools: section — only emit keys that differ from the built-in defaults.
  tools_section_lines = compact([
    var.tools.prometheus_url != "" ? "  prometheusQuery: true" : "",
    var.tools.loki_url != "" ? "  lokiQuery: true" : "",
    var.tools.jaeger_url != "" ? "  jaegerQuery: true" : "",
    var.tools.kubecost_url != "" ? "  kubecostQuery: true" : "",
    var.tools.aws_cli ? "  awsCli: true" : "",
    var.tools.trivy_scan ? "  trivyScan: true" : "",
    var.tools.datadog_api_key != "" ? "  datadogQuery: true" : "",
  ])

  # Top-level service-config sections for each optional integration.
  prometheus_section = var.tools.prometheus_url != "" ? join("\n", [
    "prometheus:",
    "  url: ${var.tools.prometheus_url}",
  ]) : ""

  loki_section = var.tools.loki_url != "" ? join("\n", [
    "loki:",
    "  url: ${var.tools.loki_url}",
  ]) : ""

  jaeger_section = var.tools.jaeger_url != "" ? join("\n", [
    "jaeger:",
    "  url: ${var.tools.jaeger_url}",
  ]) : ""

  kubecost_section = var.tools.kubecost_url != "" ? join("\n", [
    "kubecost:",
    "  url: ${var.tools.kubecost_url}",
  ]) : ""

  datadog_section = var.tools.datadog_api_key != "" ? join("\n", [
    "datadog:",
    "  apiKey: ${var.tools.datadog_api_key}",
    "  appKey: ${var.tools.datadog_app_key}",
    "  site: ${var.tools.datadog_site}",
  ]) : ""

  # Slack: only emit `slack:\n  enabled: true` in the ConfigMap — the webhook
  # URL is injected via SLACK_WEBHOOK_URL env var from a Secret (see below).
  slack_section = var.slack_webhook_url != "" ? "slack:\n  enabled: true" : ""

  # Track whether a credentials Secret is needed (Slack webhook, Datadog keys).
  need_credentials_secret = var.slack_webhook_url != "" || var.tools.datadog_api_key != ""

  # Emit a ConfigMap only when there is non-sensitive config to provide.
  need_configmap = (
    length(local.tools_section_lines) > 0 ||
    local.slack_section != ""
  )

  # Datadog credentials go into a Secret as env vars — not in the ConfigMap.
  # Only the non-sensitive site setting is written to config if needed.
  heimdall_config_yaml = local.need_configmap ? join("\n", compact([
    length(local.tools_section_lines) > 0 ? "tools:\n${join("\n", local.tools_section_lines)}" : "",
    local.prometheus_section,
    local.loki_section,
    local.jaeger_section,
    local.kubecost_section,
    local.slack_section,
  ])) : ""
}

# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------
resource "kubernetes_namespace" "heimdall" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

# ---------------------------------------------------------------------------
# ServiceAccount
# ---------------------------------------------------------------------------
resource "kubernetes_service_account" "heimdall" {
  metadata {
    name      = local.name
    namespace = kubernetes_namespace.heimdall.metadata[0].name
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
    # Annotate with IRSA role ARN when provided (EKS only).
    annotations = var.irsa_role_arn != "" ? {
      "eks.amazonaws.com/role-arn" = var.irsa_role_arn
    } : {}
  }
  automount_service_account_token = true
}

# ---------------------------------------------------------------------------
# ClusterRole — read-only access to every resource Heimdall can inspect
# ---------------------------------------------------------------------------
resource "kubernetes_cluster_role" "heimdall_readonly" {
  metadata {
    name = "${local.name}-${var.namespace}-readonly"
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  # Core resources
  rule {
    api_groups = [""]
    resources = [
      "configmaps",
      "endpoints",
      "events",
      "limitranges",
      "namespaces",
      "nodes",
      "persistentvolumeclaims",
      "persistentvolumes",
      "pods",
      "pods/log",
      "replicationcontrollers",
      "resourcequotas",
      "serviceaccounts",
      "services",
    ]
    verbs = ["get", "list", "watch"]
  }

  # apps
  rule {
    api_groups = ["apps"]
    resources  = ["daemonsets", "deployments", "replicasets", "statefulsets"]
    verbs      = ["get", "list", "watch"]
  }

  # batch
  rule {
    api_groups = ["batch"]
    resources  = ["cronjobs", "jobs"]
    verbs      = ["get", "list", "watch"]
  }

  # autoscaling
  rule {
    api_groups = ["autoscaling"]
    resources  = ["horizontalpodautoscalers"]
    verbs      = ["get", "list", "watch"]
  }

  # networking
  rule {
    api_groups = ["networking.k8s.io"]
    resources  = ["ingressclasses", "ingresses", "networkpolicies"]
    verbs      = ["get", "list", "watch"]
  }

  # storage
  rule {
    api_groups = ["storage.k8s.io"]
    resources  = ["storageclasses", "volumeattachments"]
    verbs      = ["get", "list", "watch"]
  }

  # policy
  rule {
    api_groups = ["policy"]
    resources  = ["poddisruptionbudgets"]
    verbs      = ["get", "list", "watch"]
  }

  # RBAC inspection
  rule {
    api_groups = ["rbac.authorization.k8s.io"]
    resources  = ["clusterrolebindings", "clusterroles", "rolebindings", "roles"]
    verbs      = ["get", "list", "watch"]
  }

  # Metrics API (kubectl top)
  rule {
    api_groups = ["metrics.k8s.io"]
    resources  = ["nodes", "pods"]
    verbs      = ["get", "list"]
  }

  # events.k8s.io (Kubernetes >= 1.26)
  rule {
    api_groups = ["events.k8s.io"]
    resources  = ["events"]
    verbs      = ["get", "list", "watch"]
  }
}

# ---------------------------------------------------------------------------
# ClusterRoleBinding
# ---------------------------------------------------------------------------
resource "kubernetes_cluster_role_binding" "heimdall_readonly" {
  metadata {
    name = "${local.name}-${var.namespace}-readonly"
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role.heimdall_readonly.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account.heimdall.metadata[0].name
    namespace = kubernetes_namespace.heimdall.metadata[0].name
  }
}

# ---------------------------------------------------------------------------
# Secret — Anthropic API key
# ---------------------------------------------------------------------------
resource "kubernetes_secret_v1" "heimdall_api_key" {
  metadata {
    name      = "heimdall-api-key"
    namespace = kubernetes_namespace.heimdall.metadata[0].name
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  data = {
    ANTHROPIC_API_KEY = var.anthropic_api_key
  }
}

# ---------------------------------------------------------------------------
# Secret — sensitive integration credentials (Slack webhook, Datadog keys)
#
# Credentials are mounted as env vars rather than written into the ConfigMap
# (ConfigMaps are not encrypted at rest and may be readable by workloads that
# cannot access Secrets).
# ---------------------------------------------------------------------------
resource "kubernetes_secret_v1" "heimdall_credentials" {
  count = local.need_credentials_secret ? 1 : 0

  metadata {
    name      = "heimdall-credentials"
    namespace = kubernetes_namespace.heimdall.metadata[0].name
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  data = merge(
    var.slack_webhook_url != "" ? { SLACK_WEBHOOK_URL = var.slack_webhook_url } : {},
    var.tools.datadog_api_key != "" ? {
      DD_API_KEY = var.tools.datadog_api_key
      DD_APP_KEY = var.tools.datadog_app_key
      DD_SITE    = var.tools.datadog_site
    } : {},
  )
}

# ---------------------------------------------------------------------------
# ConfigMap — optional heimdall.config.yaml (non-sensitive tool config)
# ---------------------------------------------------------------------------
resource "kubernetes_config_map_v1" "heimdall_config" {
  count = local.need_configmap ? 1 : 0

  metadata {
    name      = "${local.name}-config"
    namespace = kubernetes_namespace.heimdall.metadata[0].name
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  data = {
    "heimdall.config.yaml" = local.heimdall_config_yaml
  }
}

# ---------------------------------------------------------------------------
# Deployment
# ---------------------------------------------------------------------------
resource "kubernetes_deployment" "heimdall" {
  metadata {
    name      = local.name
    namespace = kubernetes_namespace.heimdall.metadata[0].name
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        "app.kubernetes.io/name" = local.name
      }
    }

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name" = local.name
        }
      }

      spec {
        service_account_name            = kubernetes_service_account.heimdall.metadata[0].name
        automount_service_account_token = true

        security_context {
          run_as_non_root = true
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name              = local.name
          image             = "${var.image_repository}:${var.image_tag}"
          image_pull_policy = "Always"

          port {
            name           = "http"
            container_port = 3000
            protocol       = "TCP"
          }

          env {
            name = "ANTHROPIC_API_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.heimdall_api_key.metadata[0].name
                key  = "ANTHROPIC_API_KEY"
              }
            }
          }

          env {
            name  = "HEIMDALL_KUBECTL_CACHE_DIR"
            value = "/tmp/heimdall-cache"
          }

          dynamic "env" {
            for_each = var.model != "" ? [var.model] : []
            content {
              name  = "HEIMDALL_MODEL"
              value = env.value
            }
          }

          dynamic "env" {
            for_each = local.need_configmap ? [1] : []
            content {
              name  = "HEIMDALL_CONFIG"
              value = "/etc/heimdall/heimdall.config.yaml"
            }
          }

          # Inject sensitive credentials from the credentials Secret as env vars.
          dynamic "env" {
            for_each = var.slack_webhook_url != "" ? [1] : []
            content {
              name = "SLACK_WEBHOOK_URL"
              value_from {
                secret_key_ref {
                  name = one(kubernetes_secret_v1.heimdall_credentials[*].metadata[0].name)
                  key  = "SLACK_WEBHOOK_URL"
                }
              }
            }
          }

          dynamic "env" {
            for_each = var.tools.datadog_api_key != "" ? [1] : []
            content {
              name = "DD_API_KEY"
              value_from {
                secret_key_ref {
                  name = one(kubernetes_secret_v1.heimdall_credentials[*].metadata[0].name)
                  key  = "DD_API_KEY"
                }
              }
            }
          }

          dynamic "env" {
            for_each = var.tools.datadog_api_key != "" ? [1] : []
            content {
              name = "DD_APP_KEY"
              value_from {
                secret_key_ref {
                  name = one(kubernetes_secret_v1.heimdall_credentials[*].metadata[0].name)
                  key  = "DD_APP_KEY"
                }
              }
            }
          }

          dynamic "env" {
            for_each = var.tools.datadog_api_key != "" ? [1] : []
            content {
              name = "DD_SITE"
              value_from {
                secret_key_ref {
                  name = one(kubernetes_secret_v1.heimdall_credentials[*].metadata[0].name)
                  key  = "DD_SITE"
                }
              }
            }
          }

          resources {
            requests = {
              cpu    = var.resources.requests_cpu
              memory = var.resources.requests_memory
            }
            limits = {
              cpu    = var.resources.limits_cpu
              memory = var.resources.limits_memory
            }
          }

          security_context {
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities {
              drop = ["ALL"]
            }
          }

          liveness_probe {
            http_get {
              path = "/api/health"
              port = 3000
            }
            initial_delay_seconds = 15
            period_seconds        = 30
          }

          readiness_probe {
            http_get {
              path = "/api/health"
              port = 3000
            }
            initial_delay_seconds = 5
            period_seconds        = 10
          }

          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }

          dynamic "volume_mount" {
            for_each = local.need_configmap ? [1] : []
            content {
              name       = "heimdall-config"
              mount_path = "/etc/heimdall"
              read_only  = true
            }
          }
        }

        volume {
          name = "tmp"
          empty_dir {}
        }

        dynamic "volume" {
          for_each = local.need_configmap ? [1] : []
          content {
            name = "heimdall-config"
            config_map {
              name = one(kubernetes_config_map_v1.heimdall_config[*].metadata[0].name)
            }
          }
        }
      }
    }
  }

  depends_on = [
    kubernetes_cluster_role_binding.heimdall_readonly,
    kubernetes_secret_v1.heimdall_api_key,
    kubernetes_secret_v1.heimdall_credentials,
  ]
}

# ---------------------------------------------------------------------------
# Service — ClusterIP to expose Heimdall inside the cluster
# ---------------------------------------------------------------------------
resource "kubernetes_service_v1" "heimdall" {
  metadata {
    name      = local.name
    namespace = kubernetes_namespace.heimdall.metadata[0].name
    labels = {
      "app.kubernetes.io/name"       = local.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = local.name
    }

    port {
      name        = "http"
      port        = 80
      target_port = 3000
      protocol    = "TCP"
    }

    type = "ClusterIP"
  }

  depends_on = [kubernetes_deployment.heimdall]
}
