variable "namespace" {
  description = "Kubernetes namespace to deploy Heimdall into."
  type        = string
  default     = "heimdall"
}

variable "image_repository" {
  description = "Container image repository."
  type        = string
  default     = "ghcr.io/billzhuang/heimdall"
}

variable "image_tag" {
  description = "Container image tag."
  type        = string
  default     = "latest"
}

variable "anthropic_api_key" {
  description = "Anthropic API key passed to Heimdall as ANTHROPIC_API_KEY."
  type        = string
  sensitive   = true
}

variable "model" {
  description = "Override the Heimdall model (e.g. \"anthropic/claude-opus-4-8\"). Leave empty to use the built-in default."
  type        = string
  default     = ""
}

variable "slack_webhook_url" {
  description = "Optional Slack incoming-webhook URL for alert notifications."
  type        = string
  default     = ""
  sensitive   = true
}

variable "irsa_role_arn" {
  description = "Optional IAM Role ARN to annotate the ServiceAccount for IRSA (EKS only). Leave empty to skip."
  type        = string
  default     = ""
}

variable "tools" {
  description = "Optional tool enablement overrides injected into heimdall.config.yaml. Omit a key to keep the built-in default."
  type = object({
    prometheus_url  = optional(string, "")
    loki_url        = optional(string, "")
    jaeger_url      = optional(string, "")
    kubecost_url    = optional(string, "")
    aws_cli         = optional(bool, false)
    trivy_scan      = optional(bool, false)
    datadog_api_key = optional(string, "")
    datadog_app_key = optional(string, "")
    datadog_site    = optional(string, "datadoghq.com")
  })
  default = {}
}

variable "resources" {
  description = "Container resource requests and limits."
  type = object({
    requests_cpu    = optional(string, "100m")
    requests_memory = optional(string, "256Mi")
    limits_cpu      = optional(string, "500m")
    limits_memory   = optional(string, "512Mi")
  })
  default = {}
}
