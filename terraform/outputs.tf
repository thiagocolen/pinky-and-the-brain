output "apprunner_service_url" {
  value       = try(aws_ecs_express_gateway_service.agent_service.ingress_paths[0].endpoint, "")
  description = "The URL of the deployed ECS Express service."
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.agent_server.repository_url
  description = "The ECR repository URL to push the Docker image to."
}
