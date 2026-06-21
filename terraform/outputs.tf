output "deployment_name" {
  description = "Name of the Heimdall Deployment."
  value       = kubernetes_deployment.heimdall.metadata[0].name
}

output "service_account_name" {
  description = "Name of the Heimdall ServiceAccount."
  value       = kubernetes_service_account.heimdall.metadata[0].name
}

output "namespace" {
  description = "Kubernetes namespace where Heimdall is deployed."
  value       = kubernetes_namespace.heimdall.metadata[0].name
}
