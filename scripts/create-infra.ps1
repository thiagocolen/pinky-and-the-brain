<#
.SYNOPSIS
    Provisions every AWS resource this project needs, from an empty account to a
    running service.
.DESCRIPTION
    The inverse of cleanup-infra.ps1 -IncludeProject. Takes an account with nothing in
    it and leaves a deployed service behind, in the order the dependencies require:

      1. Preflight - aws, terraform, docker and npm on PATH, credentials that resolve,
         a Docker daemon that answers.
      2. SSM parameters - terraform/main.tf reads the three secrets as *data* sources,
         so terraform fails outright if they do not exist yet. Missing ones are seeded
         from .env, or prompted for. Existing ones are never overwritten.
      3. terraform init.
      4. Targeted apply of the ECR repository alone. The ECS service cannot start
         without an image, and the image cannot be pushed without a repository, so the
         repository has to exist before the build.
      5. npm run build, docker build, ECR login, push.
      6. Full terraform apply - IAM roles, ECS cluster, Express Gateway service,
         CloudFront distribution.
      7. Prints the outputs and writes infra-reports/<timestamp>-create-report.md.

    Steps 3-6 mirror what scripts/deploy.js already does; the difference is that this
    script also handles the from-nothing case (secrets, preflight, missing state).
    For an ordinary code deploy onto infrastructure that already exists, npm run deploy
    remains the shorter path.

    Re-running is safe. Terraform converges on the same stack, and every step is
    idempotent, so the script doubles as the recovery path for a half-finished run.
.PARAMETER Region
    The AWS Region to deploy into. Defaults to aws_region in terraform/terraform.tfvars,
    then to the default in terraform/variables.tf (us-east-1).
.PARAMETER Profile
    The AWS CLI profile to use. If omitted, resolves from AWS_PROFILE, then the .env
    file, then 'default'.
.PARAMETER Environment
    The environment segment of the SSM parameter paths. Defaults to 'dev'.
.PARAMETER SkipImage
    Skip the build and push, and apply Terraform against whatever image tag is already
    in ECR. Fails at step 4 if the repository holds no image yet.
.PARAMETER PlanOnly
    Run terraform plan and stop. Creates nothing, pushes nothing. The SSM parameter
    check still runs, read-only - a missing parameter is reported, not created.
.PARAMETER Force
    Skip the confirmation prompt.
.EXAMPLE
    .\create-infra.ps1
    Full provision into the default region, after a confirmation prompt.
.EXAMPLE
    .\create-infra.ps1 -PlanOnly
    Shows what would be created without touching anything.
.EXAMPLE
    .\create-infra.ps1 -Region us-east-1 -SkipImage -Force
    Re-applies the infrastructure without rebuilding the container image.
#>
param(
    [string]$Region = "",
    [string]$Profile = "",
    [string]$Environment = "dev",
    [switch]$SkipImage,
    [switch]$PlanOnly,
    [switch]$Force
)

$ErrorActionPreference = "SilentlyContinue"

$projectPrefix = "pinky-and-the-brain-agents"

# terraform/main.tf pins the SSM provider alias to sa-east-1, so the parameters live
# there no matter which region the rest of the stack is deployed into.
$ssmRegion = "sa-east-1"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = (Get-Item (Join-Path $scriptDir "..")).FullName
$terraformDir = Join-Path $backendDir "terraform"
$envPath = Join-Path $backendDir ".env"
$reportsDir = Join-Path $backendDir "infra-reports"

if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyy-MM-dd-HH-mm"
$mode = if ($PlanOnly) { "plan" } else { "apply" }
$reportPath = Join-Path $reportsDir "${timestamp}-create-${mode}-report.md"

# One entry per step, so the report says what ran and what it cost even when the run
# stops halfway.
$steps = @()
$failures = @()

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "        AWS Project Infrastructure Provisioning     " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
if ($PlanOnly) {
    Write-Host "MODE: PLAN ONLY - nothing will be created." -ForegroundColor Green
} else {
    Write-Host "MODE: APPLY - resources WILL be created." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Runs one stage of the provision. Output is streamed rather than captured: these are
# long commands (docker build, terraform apply) and watching them is the only way to
# tell a slow step from a stuck one. Returns $true on success.
function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action,
        [string]$WorkingDirectory = ""
    )

    Write-Host ""
    Write-Host "--- $Name" -ForegroundColor Cyan

    $started = Get-Date
    $previousLocation = $null
    if ($WorkingDirectory) {
        $previousLocation = Get-Location
        Set-Location $WorkingDirectory
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $failed = $false
    $detail = ""
    try {
        & $Action
        if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
            $failed = $true
            $detail = "exit code $LASTEXITCODE"
        }
    } catch {
        $failed = $true
        $detail = $_.Exception.Message
    } finally {
        $ErrorActionPreference = $prevEap
        if ($previousLocation) { Set-Location $previousLocation }
    }

    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)

    $script:steps += [PSCustomObject]@{
        Name    = $Name
        Result  = if ($failed) { "FAILED" } else { "ok" }
        Seconds = $elapsed
        Detail  = $detail
    }

    if ($failed) {
        Write-Host "FAILED: $Name ($detail)" -ForegroundColor Red
        $script:failures += "$Name - $detail"
        return $false
    }

    Write-Host "OK ($elapsed s)" -ForegroundColor Green
    return $true
}

# Writes the report and leaves. Called from every abort path so a failed run still
# produces the same artefact a successful one does.
function Stop-WithReport {
    param([string]$Reason, [int]$Code = 1)

    if ($Reason) {
        Write-Host ""
        Write-Host $Reason -ForegroundColor Red
    }
    Write-CreateReport -Outcome $Reason
    exit $Code
}

# Reads .env into a hashtable. Values may be quoted; anything after an unquoted # on
# its own is a comment line, but # inside a value is kept - API keys contain them.
function Read-DotEnv {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path $Path)) { return $values }

    foreach ($line in (Get-Content $Path)) {
        if ($line -match '^\s*#') { continue }
        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }

        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") {
            $value = $Matches[1]
        }
        $values[$key] = $value
    }
    return $values
}

# Reads a single variable out of terraform.tfvars without parsing HCL properly - the
# file is a flat list of key = "value" lines and nothing here needs more than that.
function Get-TfvarsValue {
    param([string]$Path, [string]$Name)

    if (-not (Test-Path $Path)) { return "" }
    foreach ($line in (Get-Content $Path)) {
        if ($line -match "^\s*$Name\s*=\s*`"([^`"]*)`"") { return $Matches[1] }
    }
    return ""
}

# Writes the run report. Every abort path goes through here, so a run that died at
# preflight leaves the same kind of artefact as one that finished - which is the point:
# the interesting reports are the failed ones. Secret *values* never reach it, only the
# name of the source they came from.
function Write-CreateReport {
    param([string]$Outcome)

    $report = "# AWS Create Report - $Outcome`n`n"
    $report += "**Generated:** $(Get-Date -Format "yyyy-MM-dd HH:mm:ss K")`n"
    $report += "**Account ID:** $(if ($accountId) { $accountId } else { "not resolved" })`n"
    $report += "**Caller Identity:** $(if ($callerArn) { $callerArn } else { "not resolved" })`n"
    $report += "**Region:** $Region`n"
    $report += "**Environment:** $Environment`n"
    $report += "**Project:** ``$projectPrefix```n`n"
    $report += "---`n`n"

    $report += "## 1. Steps`n`n"
    if (@($steps).Count -gt 0) {
        $report += "| # | Step | Result | Seconds | Detail |`n"
        $report += "| --- | --- | --- | --- | --- |`n"
        $n = 1
        foreach ($s in $steps) {
            $report += "| $n | $($s.Name) | $($s.Result) | $($s.Seconds) | $($s.Detail) |`n"
            $n++
        }
    } else {
        $report += "*No steps ran.*`n"
    }
    $report += "`n"

    $report += "## 2. SSM parameters`n`n"
    $report += "Terraform reads these as data sources, so they must exist before the apply. "
    $report += "Existing parameters are never overwritten, and values are never written to this report.`n`n"
    if (@($secretResults).Count -gt 0) {
        $report += "| Parameter | Outcome |`n"
        $report += "| --- | --- |`n"
        foreach ($s in $secretResults) {
            $report += "| ``$($s.Parameter)`` | $($s.Action) |`n"
        }
    } else {
        $report += "*The run stopped before the parameters were checked.*`n"
    }
    $report += "`n"

    $report += "## 3. Outputs`n`n"
    if ($outputs -and $outputs.Count -gt 0) {
        $report += "| Output | Value |`n"
        $report += "| --- | --- |`n"
        foreach ($key in $outputs.Keys) {
            $report += "| $key | $($outputs[$key]) |`n"
        }
    } else {
        $report += "*No Terraform outputs were read - the run did not reach a completed apply.*`n"
    }
    $report += "`n"

    $report += "## 4. Failures`n`n"
    if (@($failures).Count -gt 0) {
        $consequence = if ($PlanOnly) {
            "Nothing was created - a plan run cannot leave the stack in a partial state."
        } else {
            "The stack may be partially provisioned; re-running is safe."
        }
        $report += "*$(@($failures).Count) step(s) failed. $consequence*`n`n"
        foreach ($f in $failures) {
            $report += "- $f`n"
        }
    } else {
        $report += "*Every step succeeded.*`n"
    }
    $report += "`n"

    $report += "## 5. Teardown`n`n"
    $report += "``npm run teardown-infra`` plans the removal of this stack; "
    $report += "``npm run teardown-infra:apply`` executes it. The SSM parameters above are never "
    $report += "deleted automatically - their values cannot be recovered from AWS.`n"

    $report | Out-File -FilePath $reportPath -Encoding utf8
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Preflight checks..." -ForegroundColor Cyan

$requiredTools = @(
    @{ Name = "aws";       Why = "provisioning and ECR login" },
    @{ Name = "terraform"; Why = "applying terraform/main.tf" },
    @{ Name = "npm";       Why = "compiling the service before the image build" }
)
if (-not $SkipImage -and -not $PlanOnly) {
    $requiredTools += @{ Name = "docker"; Why = "building and pushing the container image" }
}

$missingTools = @()
foreach ($tool in $requiredTools) {
    if (Get-Command $tool.Name -ErrorAction SilentlyContinue) {
        Write-Host "  $($tool.Name): found" -ForegroundColor DarkGray
    } else {
        Write-Host "  $($tool.Name): MISSING - needed for $($tool.Why)" -ForegroundColor Red
        $missingTools += $tool.Name
    }
}
if ($missingTools.Count -gt 0) {
    $steps += [PSCustomObject]@{ Name = "Preflight"; Result = "FAILED"; Seconds = 0; Detail = "missing: $($missingTools -join ', ')" }
    $failures += "Preflight - missing tools: $($missingTools -join ', ')"
    Stop-WithReport "Install the missing tool(s) and re-run: $($missingTools -join ', ')"
}

# Resolve the AWS profile the same way report-infra.ps1 and cleanup-infra.ps1 do, so
# all three scripts talk to the same account without being told twice.
$envValues = Read-DotEnv $envPath

if (-not [string]::IsNullOrEmpty($env:AWS_PROFILE)) {
    $Profile = $env:AWS_PROFILE
    Write-Host "  Using AWS profile from environment (AWS_PROFILE): $Profile" -ForegroundColor DarkGray
} elseif (-not [string]::IsNullOrEmpty($Profile)) {
    Write-Host "  Using AWS profile parameter: $Profile" -ForegroundColor DarkGray
} elseif ($envValues.ContainsKey("AWS_PROFILE")) {
    $Profile = $envValues["AWS_PROFILE"]
    Write-Host "  Found AWS_PROFILE in .env: $Profile" -ForegroundColor DarkGray
} else {
    $Profile = "default"
    Write-Host "  AWS_PROFILE not set. Defaulting to 'default'" -ForegroundColor Yellow
}
$env:AWS_PROFILE = $Profile

if ([string]::IsNullOrWhiteSpace($Region)) {
    $Region = Get-TfvarsValue (Join-Path $terraformDir "terraform.tfvars") "aws_region"
}
if ([string]::IsNullOrWhiteSpace($Region)) {
    $Region = "us-east-1"
}
Write-Host "  Deployment region: $Region" -ForegroundColor DarkGray
Write-Host "  Secrets region:    $ssmRegion (fixed by the provider alias in main.tf)" -ForegroundColor DarkGray

$callerRaw = aws sts get-caller-identity --output json 2>&1
$callerJson = ($callerRaw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($callerJson)) {
    $steps += [PSCustomObject]@{ Name = "Preflight"; Result = "FAILED"; Seconds = 0; Detail = "sts get-caller-identity failed" }
    $failures += "Preflight - AWS credentials did not resolve"
    Stop-WithReport "Failed to authenticate with AWS. Check the '$Profile' profile credentials."
}
$callerObj = $callerJson | ConvertFrom-Json
$accountId = $callerObj.Account
$callerArn = $callerObj.Arn
Write-Host "  Authenticated as Account: $accountId ($callerArn)" -ForegroundColor Green

if (-not $SkipImage -and -not $PlanOnly) {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $steps += [PSCustomObject]@{ Name = "Preflight"; Result = "FAILED"; Seconds = 0; Detail = "docker daemon not responding" }
        $failures += "Preflight - Docker daemon not running"
        Stop-WithReport "Docker is installed but the daemon is not responding. Start Docker Desktop, or pass -SkipImage."
    }
    Write-Host "  Docker daemon: responding" -ForegroundColor DarkGray
}

$steps += [PSCustomObject]@{ Name = "Preflight"; Result = "ok"; Seconds = 0; Detail = "account $accountId, region $Region" }

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------

if (-not $PlanOnly -and -not $Force) {
    Write-Host ""
    Write-Host "About to provision the $projectPrefix stack into account $accountId ($Region)." -ForegroundColor Yellow
    Write-Host "This creates billable resources: an ECS Express Gateway service, an ALB and a CloudFront distribution." -ForegroundColor Yellow
    $answer = Read-Host "Type CREATE (in capitals) to proceed, anything else to abort"
    if ($answer -cne "CREATE") {
        Stop-WithReport "Aborted at the confirmation prompt - nothing was created." 0
    }
}

# ---------------------------------------------------------------------------
# 1. SSM parameters
# ---------------------------------------------------------------------------

# main.tf reads these with `data "aws_ssm_parameter"`, which is a hard dependency:
# terraform errors out rather than creating them. They also outlive a teardown by
# design (cleanup-infra.ps1 never auto-deletes them), so on a rebuild this step
# usually finds all three already in place and does nothing.
Write-Host ""
Write-Host "--- SSM parameters (/$projectPrefix/$Environment/*) in $ssmRegion" -ForegroundColor Cyan

# Each parameter, and the .env variable names its value can come from. The app_api_key
# fallback chain matches the one src/config.ts already uses.
$secretSpecs = @(
    @{ Name = "github_token";      Sources = @("GITHUB_ACCESS_TOKEN", "GITHUB_TOKEN") },
    @{ Name = "anthropic_api_key"; Sources = @("ANTHROPIC_API_KEY") },
    @{ Name = "app_api_key";       Sources = @("AWS_APP_API_KEY", "PATBA_API_KEY", "API_KEY") }
)

$secretResults = @()
$secretsBlocked = @()

foreach ($spec in $secretSpecs) {
    $paramPath = "/$projectPrefix/$Environment/$($spec.Name)"

    aws ssm get-parameter --name $paramPath --region $ssmRegion --output json 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  $paramPath : exists, left untouched" -ForegroundColor Green
        $secretResults += [PSCustomObject]@{ Parameter = $paramPath; Action = "reused (already in SSM)" }
        continue
    }

    # Not there. Find a value, without ever echoing one.
    $value = ""
    $source = ""
    foreach ($sourceName in $spec.Sources) {
        $fromProcess = [Environment]::GetEnvironmentVariable($sourceName)
        if (-not [string]::IsNullOrWhiteSpace($fromProcess)) {
            $value = $fromProcess
            $source = "environment ($sourceName)"
            break
        }
        if ($envValues.ContainsKey($sourceName) -and -not [string]::IsNullOrWhiteSpace($envValues[$sourceName])) {
            $value = $envValues[$sourceName]
            $source = ".env ($sourceName)"
            break
        }
    }

    if ([string]::IsNullOrWhiteSpace($value)) {
        if ($PlanOnly) {
            Write-Host "  $paramPath : MISSING (plan only - not created)" -ForegroundColor Yellow
            $secretResults += [PSCustomObject]@{ Parameter = $paramPath; Action = "missing - would need a value" }
            continue
        }
        if ([Console]::IsInputRedirected) {
            Write-Host "  $paramPath : MISSING and no value in .env or the environment" -ForegroundColor Red
            $secretsBlocked += "$paramPath (set one of: $($spec.Sources -join ', '))"
            $secretResults += [PSCustomObject]@{ Parameter = $paramPath; Action = "MISSING - no value available" }
            continue
        }

        Write-Host "  $paramPath : missing. Set one of $($spec.Sources -join ', ') in .env to avoid this prompt." -ForegroundColor Yellow
        $secure = Read-Host "  Value for $($spec.Name) (input hidden, ENTER to skip)" -AsSecureString
        $value = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        $source = "interactive prompt"

        if ([string]::IsNullOrWhiteSpace($value)) {
            $secretsBlocked += "$paramPath (skipped at the prompt)"
            $secretResults += [PSCustomObject]@{ Parameter = $paramPath; Action = "MISSING - skipped at the prompt" }
            continue
        }
    }

    if ($PlanOnly) {
        Write-Host "  $paramPath : would be created from $source" -ForegroundColor Yellow
        $secretResults += [PSCustomObject]@{ Parameter = $paramPath; Action = "would be created from $source" }
        continue
    }

    $putOutput = aws ssm put-parameter --name $paramPath --value $value --type SecureString --region $ssmRegion --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
        $detail = ($putOutput | ForEach-Object { "$_" }) -join " "
        Write-Host "  $paramPath : FAILED to create - $detail" -ForegroundColor Red
        $secretsBlocked += "$paramPath (put-parameter failed)"
        $secretResults += [PSCustomObject]@{ Parameter = $paramPath; Action = "FAILED: $detail" }
        continue
    }

    Write-Host "  $paramPath : created from $source" -ForegroundColor Green
    $secretResults += [PSCustomObject]@{ Parameter = $paramPath; Action = "created from $source" }
}

if ($secretsBlocked.Count -gt 0 -and -not $PlanOnly) {
    $steps += [PSCustomObject]@{ Name = "SSM parameters"; Result = "FAILED"; Seconds = 0; Detail = "$($secretsBlocked.Count) parameter(s) unavailable" }
    $failures += "SSM parameters - " + ($secretsBlocked -join "; ")
    Stop-WithReport "Terraform reads these parameters as data sources and will fail without them:`n  $($secretsBlocked -join "`n  ")"
}
$steps += [PSCustomObject]@{ Name = "SSM parameters"; Result = "ok"; Seconds = 0; Detail = "$($secretResults.Count) parameter(s) checked" }

# ---------------------------------------------------------------------------
# Terraform variables
# ---------------------------------------------------------------------------

# langchain_api_key is sensitive with no default, so terraform blocks on an interactive
# prompt if it is not supplied - which hangs the script rather than failing it. Passing
# it explicitly, empty if need be, keeps the run non-interactive either way.
$langchainApiKey = $env:LANGCHAIN_API_KEY
if ([string]::IsNullOrWhiteSpace($langchainApiKey) -and $envValues.ContainsKey("LANGCHAIN_API_KEY")) {
    $langchainApiKey = $envValues["LANGCHAIN_API_KEY"]
}
if ([string]::IsNullOrWhiteSpace($langchainApiKey) -and $envValues.ContainsKey("LANGSMITH_API_KEY")) {
    $langchainApiKey = $envValues["LANGSMITH_API_KEY"]
}
if ([string]::IsNullOrWhiteSpace($langchainApiKey)) {
    Write-Host ""
    Write-Host "LANGCHAIN_API_KEY is not set - deploying with tracing credentials empty." -ForegroundColor Yellow
    $langchainApiKey = ""
}

$tfVars = @(
    "-var", "aws_region=$Region",
    "-var", "project_name=$projectPrefix",
    "-var", "environment=$Environment",
    "-var", "langchain_api_key=$langchainApiKey"
)
if ($envValues.ContainsKey("LANGCHAIN_TRACING_V2")) {
    $tfVars += @("-var", "langchain_tracing_v2=$($envValues['LANGCHAIN_TRACING_V2'])")
}
if ($envValues.ContainsKey("LANGCHAIN_PROJECT")) {
    $tfVars += @("-var", "langchain_project=$($envValues['LANGCHAIN_PROJECT'])")
}

# ---------------------------------------------------------------------------
# 2. Terraform init
# ---------------------------------------------------------------------------

if (-not (Invoke-Step "terraform init" { terraform init -input=false } $terraformDir)) {
    Stop-WithReport "terraform init failed - nothing was provisioned."
}

# ---------------------------------------------------------------------------
# 3. Plan-only exit
# ---------------------------------------------------------------------------

if ($PlanOnly) {
    Invoke-Step "terraform plan" { terraform plan -input=false @tfVars } $terraformDir | Out-Null
    Write-Host ""
    Write-Host "Plan complete - nothing was created." -ForegroundColor Green
    Write-CreateReport -Outcome "PLAN ONLY (nothing was created)"
    Write-Host "Report saved to: $reportPath" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# 4. ECR repository, ahead of everything else
# ---------------------------------------------------------------------------

# The ECS service's container definition points at <ecr-url>:latest. Applying the whole
# stack in one go on an empty account would create a service whose image does not
# exist, so the repository is created on its own first and filled before the rest.
if (-not (Invoke-Step "terraform apply (ECR repository only)" {
        terraform apply -target=aws_ecr_repository.agent_server -auto-approve -input=false @tfVars
    } $terraformDir)) {
    Stop-WithReport "Could not create the ECR repository - the image has nowhere to go."
}

$ecrUrl = ""
Push-Location $terraformDir
$ecrRaw = terraform output -raw ecr_repository_url 2>&1
if ($LASTEXITCODE -eq 0) {
    $ecrUrl = (($ecrRaw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "").Trim()
}
Pop-Location

if ([string]::IsNullOrWhiteSpace($ecrUrl)) {
    $steps += [PSCustomObject]@{ Name = "Read ECR URL"; Result = "FAILED"; Seconds = 0; Detail = "terraform output ecr_repository_url was empty" }
    $failures += "Read ECR URL - terraform output was empty"
    Stop-WithReport "Could not read ecr_repository_url from the Terraform outputs."
}
Write-Host "ECR repository: $ecrUrl" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 5. Build and push the image
# ---------------------------------------------------------------------------

if ($SkipImage) {
    Write-Host ""
    Write-Host "-SkipImage - using whatever image tag is already in ECR." -ForegroundColor Yellow
    $steps += [PSCustomObject]@{ Name = "Build and push image"; Result = "skipped"; Seconds = 0; Detail = "-SkipImage" }
} else {
    if (-not (Invoke-Step "npm run build" { npm run build } $backendDir)) {
        Stop-WithReport "TypeScript build failed - the image would ship stale code."
    }

    if (-not (Invoke-Step "docker build" {
            docker build -t "$projectPrefix-server" .
        } $backendDir)) {
        Stop-WithReport "Docker build failed."
    }

    # Region and registry come from the repository URL rather than $Region: the two
    # agree today, but the URL is what docker actually has to authenticate against.
    # Format: <account-id>.dkr.ecr.<region>.amazonaws.com/<repository-name>
    if ($ecrUrl -notmatch '^([^.]+)\.dkr\.ecr\.([^.]+)\.amazonaws\.com') {
        $steps += [PSCustomObject]@{ Name = "ECR login"; Result = "FAILED"; Seconds = 0; Detail = "unparsable ECR URL: $ecrUrl" }
        $failures += "ECR login - could not parse registry from $ecrUrl"
        Stop-WithReport "Could not parse the registry host out of the ECR URL: $ecrUrl"
    }
    $registry = "$($Matches[1]).dkr.ecr.$($Matches[2]).amazonaws.com"
    $ecrRegion = $Matches[2]

    if (-not (Invoke-Step "docker login to ECR" {
            aws ecr get-login-password --region $ecrRegion | docker login --username AWS --password-stdin $registry
        })) {
        Stop-WithReport "ECR login failed."
    }

    if (-not (Invoke-Step "docker tag and push" {
            docker tag "${projectPrefix}-server:latest" "${ecrUrl}:latest"
            if ($LASTEXITCODE -ne 0) { return }
            docker push "${ecrUrl}:latest"
        })) {
        Stop-WithReport "Pushing the image to ECR failed."
    }
}

# ---------------------------------------------------------------------------
# 6. The rest of the stack
# ---------------------------------------------------------------------------

if (-not (Invoke-Step "terraform apply (full stack)" {
        terraform apply -auto-approve -input=false @tfVars
    } $terraformDir)) {
    Stop-WithReport "terraform apply failed - the stack is partially provisioned. Fix the error and re-run; the script is idempotent."
}

# ---------------------------------------------------------------------------
# 7. Outputs
# ---------------------------------------------------------------------------

$outputs = @{}
Push-Location $terraformDir
foreach ($name in @("apprunner_service_url", "ecr_repository_url", "cloudfront_service_url")) {
    $raw = terraform output -raw $name 2>&1
    if ($LASTEXITCODE -eq 0) {
        $outputs[$name] = (($raw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "").Trim()
    } else {
        $outputs[$name] = ""
    }
}
Pop-Location

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "Stack provisioned" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  Service URL    : $($outputs['apprunner_service_url'])" -ForegroundColor Green
Write-Host "  CloudFront URL : $($outputs['cloudfront_service_url'])" -ForegroundColor Green
Write-Host "  ECR repository : $($outputs['ecr_repository_url'])" -ForegroundColor DarkGray
Write-Host ""
Write-Host "CloudFront takes a few minutes to finish propagating before the stable URL answers." -ForegroundColor DarkGray
Write-Host "Verify with: npm run report-infra -- -Region $Region" -ForegroundColor DarkGray

Write-CreateReport -Outcome "APPLIED (stack provisioned)"
Write-Host ""
Write-Host "Create report saved to: $reportPath" -ForegroundColor Green
Write-Host "Done!" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan
