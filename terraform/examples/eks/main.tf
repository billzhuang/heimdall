# Example: deploy Heimdall on EKS with IRSA for AWS CLI read-only access.
#
# Prerequisites:
#   1. An EKS cluster with an OIDC provider associated:
#        aws eks describe-cluster --name <cluster> --query cluster.identity.oidc
#
#   2. An IAM role with ReadOnlyAccess and a trust relationship that allows the
#      heimdall ServiceAccount to assume it. Create this BEFORE terraform apply —
#      do NOT use `eksctl create iamserviceaccount` because that command also
#      creates the ServiceAccount, which would conflict with Terraform.
#      Use the AWS CLI instead (see the README "EKS with IRSA" section for the
#      full aws iam create-role + attach-role-policy + trust-policy commands).
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

output "service_name" {
  value = module.heimdall.service_name
}

output "service_cluster_ip" {
  value = module.heimdall.service_cluster_ip
}
