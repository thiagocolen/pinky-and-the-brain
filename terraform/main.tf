provider "aws" {
  region = var.aws_region
}

provider "aws" {
  alias  = "ssm_region"
  region = "sa-east-1"
}

# Data sources for secrets stored in SSM Parameter Store
data "aws_ssm_parameter" "github_token" {
  provider = aws.ssm_region
  name     = "/${var.project_name}/${var.environment}/github_token"
}

data "aws_ssm_parameter" "anthropic_api_key" {
  provider = aws.ssm_region
  name     = "/${var.project_name}/${var.environment}/anthropic_api_key"
}

data "aws_ssm_parameter" "app_api_key" {
  provider = aws.ssm_region
  name     = "/${var.project_name}/${var.environment}/app_api_key"
}

# 1. ECR Repository to store the Docker Image
resource "aws_ecr_repository" "agent_server" {
  name                 = "${var.project_name}-server"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Project = var.project_name
  }
}

# 2. ECS Task Execution Role & SSM Policy
resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-apprunner-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_policy" "ecs_ssm_access" {
  name = "${var.project_name}-ecs-ssm-access"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = [
          data.aws_ssm_parameter.github_token.arn,
          data.aws_ssm_parameter.anthropic_api_key.arn,
          data.aws_ssm_parameter.app_api_key.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_ssm" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = aws_iam_policy.ecs_ssm_access.arn
}

# 3. ECS Task Role (for the container to run)
resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-apprunner-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_ssm" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.ecs_ssm_access.arn
}

# 4. ECS Infrastructure Role for Express Gateway Services
resource "aws_iam_role" "ecs_infrastructure" {
  name = "${var.project_name}-apprunner-ecs-infrastructure"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_infrastructure" {
  role       = aws_iam_role.ecs_infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
}

# 5. ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  lifecycle {
    ignore_changes = [
      tags,
      tags_all,
    ]
  }
}

# 6. AWS ECS Express Gateway Service
resource "aws_ecs_express_gateway_service" "agent_service" {
  service_name            = "${var.project_name}-service"
  cluster                 = aws_ecs_cluster.main.name
  execution_role_arn      = aws_iam_role.ecs_execution.arn
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure.arn
  task_role_arn           = aws_iam_role.ecs_task.arn

  # 0.25 vCPU maps to 256 CPU units
  cpu    = "256"
  # 0.5 GB maps to 512 MB
  memory = "512"

  primary_container {
    image          = "${aws_ecr_repository.agent_server.repository_url}:latest"
    container_port = 8080

    # Non-sensitive variables passed as environment
    environment {
      name  = "NODE_ENV"
      value = "production"
    }
    environment {
      name  = "PORT"
      value = "8080"
    }
    environment {
      name  = "SQLITE_DB_PATH"
      value = "state.db"
    }
    environment {
      name  = "LANGCHAIN_TRACING_V2"
      value = var.langchain_tracing_v2
    }
    environment {
      name  = "LANGCHAIN_API_KEY"
      value = var.langchain_api_key
    }
    environment {
      name  = "LANGCHAIN_PROJECT"
      value = var.langchain_project
    }
    environment {
      name  = "LANGSMITH_TRACING"
      value = "true"
    }
    environment {
      name  = "LANGSMITH_API_KEY"
      value = var.langchain_api_key
    }
    environment {
      name  = "LANGSMITH_PROJECT"
      value = var.langchain_project
    }
    environment {
      name  = "LANGSMITH_ENDPOINT"
      value = "https://api.smith.langchain.com"
    }
    environment {
      name  = "LANGSMITH_TRACING_BACKGROUND"
      value = "false"
    }

    # Sensitive variables passed as secrets from SSM Parameter Store
    secret {
      name       = "GITHUB_ACCESS_TOKEN"
      value_from = data.aws_ssm_parameter.github_token.arn
    }
    secret {
      name       = "ANTHROPIC_API_KEY"
      value_from = data.aws_ssm_parameter.anthropic_api_key.arn
    }
    secret {
      name       = "AWS_APP_API_KEY"
      value_from = data.aws_ssm_parameter.app_api_key.arn
    }
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }

  depends_on = [
    aws_iam_role_policy_attachment.ecs_execution,
    aws_iam_role_policy_attachment.ecs_execution_ssm,
    aws_iam_role_policy_attachment.ecs_task_ssm,
    aws_iam_role_policy_attachment.ecs_infrastructure
  ]
}

# CloudFront Distribution pointing to the ECS Express Gateway Service
resource "aws_cloudfront_distribution" "agent_cdn" {
  origin {
    domain_name = replace(
      try(aws_ecs_express_gateway_service.agent_service.ingress_paths[0].endpoint, ""),
      "/^https?://|/.*$/", ""
    )
    origin_id   = "ECSExpressGatewayOrigin"

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "CDN for Pinky and the Brain Agent Service"

  default_cache_behavior {
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "ECSExpressGatewayOrigin"

    forwarded_values {
      query_string = true
      headers      = ["Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Content-Type", "Origin", "X-API-Key"]

      cookies {
        forward = "all"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}
