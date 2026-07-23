variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "pinky-and-the-brain-agents"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "langchain_tracing_v2" {
  type    = string
  default = "true"
}

variable "langchain_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "langchain_project" {
  type    = string
  default = "pinky-and-the-brain-agents"
}
