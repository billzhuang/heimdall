# Example: deploy Heimdall on EKS with IRSA for AWS CLI read-only access.
#
# Prerequisites:
#   1. An EKS cluster with an OIDC provider associated:
#        aws eks describe-cluster --name <cluster> --query cluster.identity.oidc
#
#   2. An IAM role with ReadOnlyAccess (or a tighter custom policy) and a trust
#      relationship allowing the heimdall ServiceAccount to assume it.
#      Quick setup via eksctl:
#        eksctl create iamserviceaccount \
#          --name heimdall \
#          --namespace heimdall \
#          --cluster <cluster-name> \
#          --region <region> \
#          --attach-policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess \
#          --approve \
#          --override-existing-serviceaccounts
#
#   3. Configure the kubernetes provider, e.g.:
#        export KUBE_CONFIG_PATH=~/.kube/config
#      or supply exec credentials:
#        provider "kubernetes" {
#          host                   = data.aws_eks_cluster.this.endpoint
#          cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
#          exec {
#            api_version = "client.authentication.k8s.io/v1beta1"
#            command     = "aws"
#            args        = ["eks", "get-token", "--cluster-name", var.cluster_name]
#          }
#        }

terraform {
  required_version = ">= 1.3"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.20"
    }
  }
}

# Configure the kubernetes provider with EKS token retrieval.
# Replace the exec block with your preferred auth mechanism if needed.
provider "kubernetes" {
  # The provider reads KUBE_CONFIG_PATH / current kubeconfig context by default.
  # Uncomment and fill in the exec block to use aws-cli-based token auth:
  #
  # host                   = "<EKS_API_ENDPOINT>"
  # cluster_ca_certificate = base64decode("<BASE64_CA_DATA>")
  # exec {
  #   api_version = "client.authentication.k8s.io/v1beta1"
  #   command     = "aws"
  #   args        = ["eks", "get-token", "--cluster-name", var.cluster_name]
  # }
}

module "heimdall" {
  # Point at the module root relative to this example directory.
  source = "../../"

  anthropic_api_key = var.anthropic_api_key
  irsa_role_arn     = var.irsa_role_arn
  slack_webhook_url = var.slack_webhook_url

  # Enable aws_cli tool so Heimdall can query EKS/EC2/IAM read-only via IRSA.
  tools = {
    aws_cli = true
  }
}

output "deployment_name" {
  value = module.heimdall.deployment_name
}

output "service_account_name" {
  value = module.heimdall.service_account_name
}

output "namespace" {
  value = module.heimdall.namespace
}
