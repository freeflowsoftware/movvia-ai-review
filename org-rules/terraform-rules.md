---
appliesTo:
  - "**/*.tf"
  - "**/*.tfvars"
---

---
description: Regras para Terraform — segurança e convenções
globs: **/*.tf
---

# Terraform — Segurança e Convenções

## Sem Credenciais Hardcoded

Credenciais DEVEM vir de `variable`, `data` sources ou variáveis de ambiente. Nunca inline.

```hcl
# ✅ CORRETO - Variável com sensitive
variable "db_password" {
  type      = string
  sensitive = true
}

resource "aws_db_instance" "main" {
  password = var.db_password
}

# ❌ ERRADO - Credencial hardcoded
resource "aws_db_instance" "main" {
  password = "super-secret-123"
}
```

## Naming Conventions

Use `snake_case` para todos os recursos e variáveis. Nomes descritivos e consistentes.

```hcl
# ✅ CORRETO
resource "aws_ecs_service" "pe_api_core" { ... }
variable "cluster_name" { ... }

# ❌ ERRADO - camelCase ou kebab-case
resource "aws_ecs_service" "peApiCore" { ... }
variable "cluster-name" { ... }
```

## Tags Obrigatórias

Todo recurso que suporta tags DEVE incluir no mínimo:

```hcl
# ✅ CORRETO
resource "aws_instance" "api_server" {
  tags = {
    Name        = "pe-api-core"
    Environment = var.environment
    Project     = "pedagio-eletronico"
    ManagedBy   = "terraform"
  }
}

# ❌ ERRADO - Sem tags ou tags incompletas
resource "aws_instance" "api_server" {
  # nenhuma tag
}
```

## State Remoto Obrigatório

Use S3 + DynamoDB para state remoto com locking. Nunca commite `terraform.tfstate`.

```hcl
# ✅ CORRETO
terraform {
  backend "s3" {
    bucket         = "movvia-terraform-state"
    key            = "pe/infra/terraform.tfstate"
    region         = "sa-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

# ❌ ERRADO - State local (risco de conflito e perda)
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
```

## Plan Antes de Apply

**NUNCA execute `terraform apply` sem `terraform plan` primeiro.** Em CI/CD, salve o plan como artefato.

```bash
# ✅ CORRETO
terraform plan -out=tfplan
terraform apply tfplan

# ❌ ERRADO
terraform apply -auto-approve
```

## Módulos Reutilizáveis

Patterns repetidos (ECS service, RDS, S3 bucket) devem virar módulos.

```hcl
# ✅ CORRETO - Módulo reutilizável
module "api_service" {
  source       = "./modules/ecs-service"
  service_name = "pe-api-core"
  environment  = var.environment
  cpu          = 512
  memory       = 1024
}

# ❌ ERRADO - Copiar/colar blocos de resource idênticos entre serviços
```
