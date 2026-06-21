variable "anthropic_api_key" {
  description = "Anthropic API key for Heimdall."
  type        = string
  sensitive   = true
}

variable "irsa_role_arn" {
  description = "IAM Role ARN with ReadOnlyAccess to annotate the Heimdall ServiceAccount for IRSA."
  type        = string
}

variable "cluster_name" {
  description = "EKS cluster name (used only in comments; the kubernetes provider is configured externally)."
  type        = string
  default     = "my-eks-cluster"
}

variable "slack_webhook_url" {
  description = "Optional Slack incoming-webhook URL."
  type        = string
  default     = ""
  sensitive   = true
}
