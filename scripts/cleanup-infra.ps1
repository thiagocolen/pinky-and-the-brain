<#
.SYNOPSIS
    Reads every AWS resource in the account and deletes the ones the chosen mode targets.
.DESCRIPTION
    Discovers live AWS resources, classifies every one of them as KEEP or DELETE, and
    writes the resulting plan to infra-reports/<timestamp>-cleanup-<mode>-report.md.

    THE SCRIPT IS READ-ONLY UNLESS -Apply IS PASSED. Without it, nothing is deleted:
    the plan is computed, printed and written to disk, and every AWS call made is a
    List/Describe. This is the intended way to run it.

    Two modes:

      PROJECT-SAFE (default) - deletes everything that is not part of
      pinky-and-the-brain-agents, so the account holds nothing but the project.

      TEARDOWN (-IncludeProject) - deletes the project too, for a full account
      wipe. Use it to drop the account to zero cost; scripts/create-infra.ps1
      rebuilds the whole stack afterwards.

    Classification is allowlist-based - a resource is deleted only when it fails every
    keep rule, so a resource type the script cannot enumerate is never assumed to be
    junk. The keep rules are:

      1. Its name, ID or ARN matches one of $keepNamePatterns (the project prefix, plus
         the generated names ECS Express Gateway creates on the project's behalf).
         SUSPENDED under -IncludeProject - that is what makes the teardown a teardown.
      2. It is a default VPC, or belongs to one (subnet, route table, IGW, default SG).
         Default VPCs are free and deleting them is not reversible through the console.
      3. It is an AWS service-linked role (path under /aws-service-role/).
      4. It is attached to something else that is kept - an Elastic IP on a kept ENI,
         a security group referenced by a kept service.
      5. It is the caller's own IAM identity, or a policy attached to it. Deleting
         those mid-run would revoke the very credentials doing the deleting.

    Rules 2-5 hold in BOTH modes. Only rule 1 (and the CloudFront pin that goes with
    it) is what -IncludeProject drops.

    The project's own SSM parameters are a special case under -IncludeProject: they are
    planned for deletion but never executed automatically, because the secret values
    they hold cannot be recovered from AWS afterwards. They are free to keep, and
    create-infra.ps1 re-reads them on rebuild.

    Deletion, when -Apply is used, runs in dependency order (services before clusters,
    instances before security groups, security groups before subnets before VPCs) and
    requires typing DELETE at a confirmation prompt.
.PARAMETER Region
    One or more AWS Regions to clean (e.g. -Region sa-east-1,us-east-1). If omitted,
    the script prompts for a selection.
.PARAMETER AllRegions
    Skips the interactive prompt and sweeps every supported region.
.PARAMETER Profile
    The AWS CLI profile to use. If omitted, resolves from AWS_PROFILE, then the .env
    file, then 'default'.
.PARAMETER Apply
    Actually perform the deletions. Omit this to dry-run, which is the default.
.PARAMETER IncludeProject
    Also delete the project's own resources - a full teardown rather than a cleanup.
    Under -Apply this additionally requires typing DELETE EVERYTHING at the prompt,
    and moves terraform/terraform.tfstate aside once the deletions have run, so the
    next terraform apply starts from an empty state.
.PARAMETER Force
    Skip the interactive "type DELETE to confirm" prompt. Only meaningful with -Apply.
.EXAMPLE
    .\cleanup-infra.ps1 -AllRegions
    Dry run across every region. Deletes nothing, writes the plan to infra-reports/.
.EXAMPLE
    .\cleanup-infra.ps1 -Region us-east-2 -Apply
    Reviews and then actually deletes the non-project resources in us-east-2.
.EXAMPLE
    .\cleanup-infra.ps1 -AllRegions -IncludeProject
    Dry run of a full account teardown, project included. Deletes nothing.
#>
param(
    [string[]]$Region = @(),
    [switch]$AllRegions,
    [string]$Profile = "",
    [switch]$Apply,
    [switch]$IncludeProject,
    [switch]$Force
)

$ErrorActionPreference = "SilentlyContinue"

# Collects every AWS CLI failure so they can be printed and appended to the report
$apiErrors = @()

# The plan: one entry per resource, either KEEP or DELETE, with the reason why.
$plan = @()

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = (Get-Item (Join-Path $scriptDir "..")).FullName
$envPath = Join-Path $backendDir ".env"
$reportsDir = Join-Path $backendDir "infra-reports"

if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

# The project itself. Everything Terraform manages is named from this prefix.
$projectPrefix = "pinky-and-the-brain-agents"

$timestamp = Get-Date -Format "yyyy-MM-dd-HH-mm"
$mode = if ($Apply) { "apply" } else { "dry-run" }
$scope = if ($IncludeProject) { "teardown" } else { "cleanup" }
$reportPath = Join-Path $reportsDir "${timestamp}-${scope}-${mode}-report.md"

$title = if ($IncludeProject) { "    AWS FULL TEARDOWN - project resources included   " }
         else { "        AWS Non-Project Infrastructure Cleanup      " }

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host $title -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
if ($Apply) {
    Write-Host "MODE: APPLY - resources WILL be deleted." -ForegroundColor Red
} else {
    Write-Host "MODE: DRY RUN - nothing will be deleted." -ForegroundColor Green
}
if ($IncludeProject) {
    Write-Host "SCOPE: TEARDOWN - the project's own resources are targeted too." -ForegroundColor Red
    Write-Host "       Default VPCs, service-linked roles and the caller's own IAM" -ForegroundColor DarkGray
    Write-Host "       identity still survive. Rebuild with: npm run create-infra" -ForegroundColor DarkGray
} else {
    Write-Host "SCOPE: CLEANUP - everything named '$projectPrefix' is kept." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Keep rules
# ---------------------------------------------------------------------------

# A resource is kept when its name/ID/ARN contains any of these. The entries after the
# project prefix are infrastructure the ECS Express Gateway service creates on the
# project's behalf under generated names that do not carry the prefix - the ALB that
# fronts the service and its target groups. Deleting those breaks the running service.
#
# Under -IncludeProject this list is emptied, which is the single switch that turns the
# cleanup into a teardown: with nothing to match, every project resource falls through
# to the same DELETE branch that non-project resources already take, and so inherits
# the deletion commands and dependency ordering that were written for them.
$keepNamePatterns = @(
    $projectPrefix,
    "ecs-express-gateway-alb",
    "ecs-gateway-tg"
)

# CloudFront distribution from terraform/terraform.tfstate. Listed explicitly because
# CloudFront resources carry no project prefix in their ID.
$keepCloudFrontIds = @("EURDC8IXBZDD5")

# The same two lists, never emptied. Once -IncludeProject switches off the keep rules,
# these are the only way left to tell a project resource from an unrelated one - which
# the plan still needs, to say *why* something is being deleted.
$projectNamePatterns = $keepNamePatterns
$projectCloudFrontIds = $keepCloudFrontIds

if ($IncludeProject) {
    $keepNamePatterns = @()
    $keepCloudFrontIds = @()
}

$availableRegions = @(
    "sa-east-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    "ca-central-1", "eu-central-1", "eu-west-1", "eu-west-2",
    "eu-west-3", "eu-north-1", "ap-northeast-1", "ap-northeast-2",
    "ap-northeast-3", "ap-southeast-1", "ap-southeast-2", "ap-south-1"
)

$callsPerRegion = 20

# Returns true when the supplied text belongs to the project (or to infrastructure the
# project's ECS service owns). Any number of candidate strings can be passed - a name,
# an ID and an ARN - and a match on any of them keeps the resource.
function Test-IsProjectResource {
    param([string[]]$Candidates)

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        foreach ($pattern in $keepNamePatterns) {
            if ($candidate -like "*$pattern*") { return $true }
        }
    }
    return $false
}

# Name matching against the project, independent of the mode. Test-IsProjectResource
# answers "should this be kept", which -IncludeProject deliberately turns off; this
# answers "does this belong to the project", which stays true either way.
function Test-IsProjectName {
    param([string[]]$Candidates)

    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        foreach ($pattern in $projectNamePatterns) {
            if ($candidate -like "*$pattern*") { return $true }
        }
        if ($projectCloudFrontIds -contains $candidate) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Region selection (same contract as report-infra.ps1)
# ---------------------------------------------------------------------------

function Resolve-RegionSelection {
    param(
        [string]$Answer,
        [string[]]$AvailableRegions
    )

    $selected = @()
    $tokens = $Answer -split '[,\s;]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($token in $tokens) {
        $t = $token.Trim()

        if ($t -match '^(all|\*)$') {
            return $AvailableRegions
        }

        if ($t -match '^(\d+)\s*-\s*(\d+)$') {
            $start = [int]$Matches[1]
            $end = [int]$Matches[2]
            if ($start -gt $end) { $start, $end = $end, $start }
            for ($i = $start; $i -le $end; $i++) {
                if ($i -ge 1 -and $i -le $AvailableRegions.Count) {
                    $selected += $AvailableRegions[$i - 1]
                } else {
                    Write-Host "  Ignoring out-of-range index: $i" -ForegroundColor Yellow
                }
            }
            continue
        }

        if ($t -match '^\d+$') {
            $i = [int]$t
            if ($i -ge 1 -and $i -le $AvailableRegions.Count) {
                $selected += $AvailableRegions[$i - 1]
            } else {
                Write-Host "  Ignoring out-of-range index: $i" -ForegroundColor Yellow
            }
            continue
        }

        $match = $AvailableRegions | Where-Object { $_ -eq $t.ToLower() }
        if ($match) {
            $selected += $match
        } else {
            Write-Host "  Ignoring unknown region: $t" -ForegroundColor Yellow
        }
    }

    return ($selected | Select-Object -Unique)
}

function Request-RegionSelection {
    param([string[]]$AvailableRegions)

    while ($true) {
        Write-Host ""
        Write-Host "Which AWS regions should be cleaned up?" -ForegroundColor Cyan
        for ($i = 0; $i -lt $AvailableRegions.Count; $i++) {
            Write-Host ("  [{0,2}] {1}" -f ($i + 1), $AvailableRegions[$i])
        }
        Write-Host ""
        Write-Host "  Enter indexes (1,3,5), a range (1-4), region names (sa-east-1,us-east-1), or 'all'." -ForegroundColor Gray
        Write-Host ""
        Write-Host "  !! ALERT: pressing ENTER with no selection sweeps ALL $($AvailableRegions.Count) regions." -ForegroundColor Yellow
        Write-Host "  !! That is roughly $($AvailableRegions.Count * $callsPerRegion) AWS API calls and will take a while." -ForegroundColor Yellow
        Write-Host ""

        $answer = Read-Host "Regions (ENTER = all)"

        if ([string]::IsNullOrWhiteSpace($answer)) {
            Write-Host ""
            Write-Host "No selection made - sweeping ALL $($AvailableRegions.Count) regions." -ForegroundColor Yellow
            return $AvailableRegions
        }

        $selected = @(Resolve-RegionSelection -Answer $answer -AvailableRegions $AvailableRegions)
        if ($selected.Count -gt 0) {
            return $selected
        }

        Write-Host "Nothing valid was recognised in '$answer'. Try again, or press ENTER to sweep all regions." -ForegroundColor Red
    }
}

if ($Region.Count -gt 0) {
    $regionsToCheck = @(Resolve-RegionSelection -Answer ($Region -join ',') -AvailableRegions $availableRegions)
    if ($regionsToCheck.Count -eq 0) {
        Write-Host "Error: none of the regions passed via -Region are supported: $($Region -join ', ')" -ForegroundColor Red
        exit 1
    }
} elseif ($AllRegions) {
    Write-Host "-AllRegions supplied - sweeping ALL $($availableRegions.Count) regions." -ForegroundColor Yellow
    $regionsToCheck = $availableRegions
} elseif ([Console]::IsInputRedirected) {
    Write-Host "Non-interactive session - sweeping ALL $($availableRegions.Count) regions." -ForegroundColor Yellow
    $regionsToCheck = $availableRegions
} else {
    $regionsToCheck = @(Request-RegionSelection -AvailableRegions $availableRegions)
}

Write-Host ""
Write-Host "Regions to sweep ($($regionsToCheck.Count)): $($regionsToCheck -join ', ')" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Profile + identity
# ---------------------------------------------------------------------------

if (-not [string]::IsNullOrEmpty($env:AWS_PROFILE)) {
    $Profile = $env:AWS_PROFILE
    Write-Host "Using AWS profile from environment (AWS_PROFILE): $Profile" -ForegroundColor Green
} elseif (-not [string]::IsNullOrEmpty($Profile)) {
    Write-Host "Using AWS profile parameter: $Profile" -ForegroundColor Green
} else {
    if (Test-Path $envPath) {
        foreach ($line in (Get-Content $envPath)) {
            if ($line -match '^\s*AWS_PROFILE\s*=\s*(.+)$') {
                $Profile = $Matches[1].Trim()
                Write-Host "Found AWS_PROFILE in .env: $Profile" -ForegroundColor Green
                break
            }
        }
    }
    if ([string]::IsNullOrEmpty($Profile)) {
        $Profile = "default"
        Write-Host "AWS_PROFILE not found in environment or .env. Defaulting to 'default'" -ForegroundColor Yellow
    }
}

if (-not [string]::IsNullOrEmpty($Profile)) {
    $env:AWS_PROFILE = $Profile
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Write-Host "Error: AWS CLI ('aws') is not installed or not in system PATH." -ForegroundColor Red
    exit 1
}

Write-Host "Checking AWS caller identity..." -ForegroundColor Gray
$callerRaw = aws sts get-caller-identity --output json 2>&1
$callerJson = ($callerRaw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($callerJson)) {
    Write-Host "Error: Failed to authenticate with AWS. Ensure you have valid AWS credentials loaded." -ForegroundColor Red
    exit 1
}
$callerObj = $callerJson | ConvertFrom-Json
$callerId = "Arn: $($callerObj.Arn), UserID: $($callerObj.UserId)"
$accountId = $callerObj.Account
$callerArn = $callerObj.Arn
Write-Host "Authenticated as Account: $accountId ($callerArn)" -ForegroundColor Green

# ---------------------------------------------------------------------------
# AWS helpers (same error contract as report-infra.ps1: nothing is swallowed)
# ---------------------------------------------------------------------------

function Get-AwsResource {
    param(
        [string]$Command,
        [string]$QueryName,
        [switch]$AllowEmpty
    )
    Write-Host "  Scanning $QueryName..." -ForegroundColor DarkGray

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = Invoke-Expression "$Command 2>&1"
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }

    $json = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    $stdErr = ($output |
        Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
        ForEach-Object { $_.Exception.Message } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join " "

    if ($AllowEmpty -and $exitCode -eq 0 -and [string]::IsNullOrWhiteSpace($json)) {
        return $null
    }

    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
        $detail = if (-not [string]::IsNullOrWhiteSpace($stdErr)) {
            $stdErr.Trim()
        } elseif ($exitCode -ne 0) {
            "AWS CLI exited with code $exitCode and produced no output."
        } else {
            "AWS CLI returned an empty response."
        }

        Write-Host "    FAILED: $QueryName" -ForegroundColor Red
        Write-Host "      $detail" -ForegroundColor Red

        $script:apiErrors += [PSCustomObject]@{
            Query   = $QueryName
            Command = $Command
            Detail  = $detail
        }
        return $null
    }

    try {
        return $json | ConvertFrom-Json
    } catch {
        $script:apiErrors += [PSCustomObject]@{
            Query   = $QueryName
            Command = $Command
            Detail  = "Response was not valid JSON: $($_.Exception.Message)"
        }
        return $null
    }
}

function Get-RegionalItems {
    param(
        [string]$Command,
        [string]$QueryName,
        [string]$Property,
        [string]$Region
    )

    $result = Get-AwsResource -Command $Command -QueryName $QueryName -AllowEmpty
    if ($null -eq $result) { return @() }

    $items = $result
    if (-not [string]::IsNullOrEmpty($Property)) {
        foreach ($segment in $Property.Split('.')) {
            if ($null -eq $items) { break }
            $items = $items.$segment
        }
    }
    if ($null -eq $items) { return @() }

    $tagged = @()
    foreach ($item in @($items)) {
        if ($null -eq $item) { continue }
        if ($item -is [string]) { $item = [PSCustomObject]@{ Value = $item } }
        $item | Add-Member -MemberType NoteProperty -Name "Region" -Value $Region -Force
        $tagged += $item
    }
    return $tagged
}

function Format-Cell {
    param($Value)
    if ($null -eq $Value) { return "" }
    if ($Value -is [array]) {
        $Value = (@($Value) | Where-Object { $null -ne $_ }) -join ", "
    }
    return (([string]$Value) -replace '\r?\n', ' ' -replace '\|', '\|').Trim()
}

function Get-NameTag {
    param($Item)
    $tags = $Item.Tags
    if ($null -eq $tags) { return "" }
    return (@($tags) | Where-Object { $_.Key -eq "Name" } | Select-Object -First 1).Value
}

# ---------------------------------------------------------------------------
# Plan building
# ---------------------------------------------------------------------------

# Records a decision about one resource. $Order drives execution sequence so that
# dependencies are removed before the things they depend on (see the table in the
# report footer). $Commands is the exact AWS CLI sequence that would delete it -
# printed in dry-run, executed under -Apply.
function Add-PlanItem {
    param(
        [ValidateSet("DELETE", "KEEP")]
        [string]$Action,
        [string]$ResourceType,
        [string]$Identifier,
        [string]$RegionName,
        [string]$Reason,
        [int]$Order = 500,
        [string[]]$Commands = @(),
        [string]$Detail = ""
    )

    $script:plan += [PSCustomObject]@{
        Action       = $Action
        ResourceType = $ResourceType
        Identifier   = $Identifier
        Region       = $RegionName
        Reason       = $Reason
        Order        = $Order
        Commands     = $Commands
        Detail       = $Detail
        Result       = if ($Action -eq "KEEP") { "n/a" } else { "not executed (dry run)" }
    }
}

Write-Host ""
Write-Host "Discovering and classifying resources..." -ForegroundColor Cyan

foreach ($r in $regionsToCheck) {
    Write-Host "----------------------------------------------------" -ForegroundColor Gray
    Write-Host "Region: $r" -ForegroundColor Cyan

    # --- VPCs, and the scaffolding that hangs off them ---
    $vpcs = Get-RegionalItems "aws ec2 describe-vpcs --region $r --output json" "VPCs in $r" "Vpcs" $r
    $defaultVpcIds = @($vpcs | Where-Object { $_.IsDefault } | ForEach-Object { $_.VpcId })
    $deletableVpcIds = @()

    foreach ($v in $vpcs) {
        $name = Get-NameTag $v
        if ($v.IsDefault) {
            Add-PlanItem KEEP "VPC" $v.VpcId $r "Default VPC - free, and the us-east-1 default VPC hosts the running ECS service"
        } elseif (Test-IsProjectResource @($name, $v.VpcId)) {
            Add-PlanItem KEEP "VPC" $v.VpcId $r "Belongs to the $projectPrefix project"
        } else {
            $deletableVpcIds += $v.VpcId
            Add-PlanItem DELETE "VPC" $v.VpcId $r "Non-default VPC unrelated to the project ($name)" 85 `
                @("aws ec2 delete-vpc --vpc-id $($v.VpcId) --region $r") "CIDR $($v.CidrBlock)"
        }
    }

    # --- EC2 instances ---
    $reservations = Get-RegionalItems "aws ec2 describe-instances --region $r --output json" "EC2 instances in $r" "Reservations" $r
    $instances = @()
    foreach ($res in $reservations) {
        foreach ($ins in @($res.Instances)) { $instances += $ins }
    }

    foreach ($ins in $instances) {
        if ($ins.State.Name -eq "terminated") { continue }
        $name = Get-NameTag $ins
        if (Test-IsProjectResource @($name, $ins.InstanceId)) {
            Add-PlanItem KEEP "EC2 Instance" $ins.InstanceId $r "Belongs to the $projectPrefix project"
        } else {
            $insDetail = "$($ins.InstanceType), state=$($ins.State.Name)"
            # Cloud9 owns its instance. The environment is deleted at order 5, which
            # takes the instance with it, so this terminate-instances call is a no-op
            # fallback rather than the primary route.
            if ($name -like "aws-cloud9-*") {
                $insDetail += " - owned by a Cloud9 environment, which is deleted first and removes this instance"
            }
            Add-PlanItem DELETE "EC2 Instance" $ins.InstanceId $r "Instance '$name' is not part of the project" 35 `
                @("aws ec2 terminate-instances --instance-ids $($ins.InstanceId) --region $r") $insDetail
        }
    }

    # --- ECS clusters and services ---
    $clusterArns = Get-RegionalItems "aws ecs list-clusters --region $r --output json" "ECS clusters in $r" "clusterArns" $r
    foreach ($arn in $clusterArns) {
        $clusterArn = $arn.Value
        $clusterName = $clusterArn.Split('/')[-1]

        if (Test-IsProjectResource @($clusterName, $clusterArn)) {
            Add-PlanItem KEEP "ECS Cluster" $clusterName $r "Belongs to the $projectPrefix project"
            continue
        }

        # Services must go before the cluster that contains them.
        $svcArns = Get-RegionalItems "aws ecs list-services --cluster `"$clusterArn`" --region $r --output json" "ECS services in $clusterName" "serviceArns" $r
        foreach ($svc in $svcArns) {
            $svcName = $svc.Value.Split('/')[-1]
            Add-PlanItem DELETE "ECS Service" $svcName $r "Runs in non-project cluster '$clusterName'" 10 `
                @("aws ecs delete-service --cluster $clusterName --service $svcName --force --region $r")
        }

        Add-PlanItem DELETE "ECS Cluster" $clusterName $r "Cluster is not part of the project" 15 `
            @("aws ecs delete-cluster --cluster $clusterName --region $r")
    }

    # --- ECS task definitions ---
    # Task definitions survive the cluster and service that used them, so leftovers
    # from a deleted project linger indefinitely. They cost nothing but they are
    # exactly the clutter this cleanup exists to remove.
    # list-task-definitions returns ACTIVE only unless asked otherwise. Deregistered
    # definitions are not gone - they stay in the account forever, still show up in the
    # tagging sweep, and need delete-task-definitions rather than deregister. Sweeping
    # only ACTIVE would silently miss every leftover from an already-torn-down project.
    foreach ($tdStatus in @("ACTIVE", "INACTIVE")) {
        $taskDefs = Get-RegionalItems "aws ecs list-task-definitions --status $tdStatus --region $r --output json" "ECS task definitions ($tdStatus) in $r" "taskDefinitionArns" $r
        foreach ($td in $taskDefs) {
            $tdName = $td.Value.Split('/')[-1]

            if (Test-IsProjectResource @($tdName, $td.Value)) {
                Add-PlanItem KEEP "ECS Task Definition" $tdName $r "Belongs to the $projectPrefix project ($tdStatus)"
            } elseif ($tdStatus -eq "ACTIVE") {
                Add-PlanItem DELETE "ECS Task Definition" $tdName $r "Task definition is left over from a project that no longer exists" 18 `
                    @(
                        "aws ecs deregister-task-definition --task-definition `"$tdName`" --region $r",
                        "aws ecs delete-task-definitions --task-definitions `"$tdName`" --region $r"
                    ) "ACTIVE - must be deregistered before it can be deleted"
            } else {
                Add-PlanItem DELETE "ECS Task Definition" $tdName $r "Deregistered leftover from a project that no longer exists" 19 `
                    @("aws ecs delete-task-definitions --task-definitions `"$tdName`" --region $r") `
                    "INACTIVE - already deregistered; this removes it permanently"
            }
        }
    }

    # --- CloudWatch alarms ---
    # ECS target-tracking creates alarms named after the service. When the service
    # goes, the alarms stay behind in INSUFFICIENT_DATA forever.
    $alarms = Get-RegionalItems "aws cloudwatch describe-alarms --region $r --output json" "CloudWatch alarms in $r" "MetricAlarms" $r
    foreach ($alarm in $alarms) {
        if (Test-IsProjectResource @($alarm.AlarmName, $alarm.AlarmArn)) {
            Add-PlanItem KEEP "CloudWatch Alarm" $alarm.AlarmName $r "Auto-scaling alarm for the project's ECS service"
        } else {
            Add-PlanItem DELETE "CloudWatch Alarm" $alarm.AlarmName $r "Alarm does not monitor a project resource" 102 `
                @("aws cloudwatch delete-alarms --alarm-names `"$($alarm.AlarmName)`" --region $r") $alarm.StateValue
        }
    }

    # --- ACM certificates ---
    # A certificate still bound to a load balancer or distribution cannot be deleted
    # (AWS rejects it), so InUseBy is reported rather than trusted as a keep rule.
    $certs = Get-RegionalItems "aws acm list-certificates --region $r --output json" "ACM certificates in $r" "CertificateSummaryList" $r
    foreach ($cert in $certs) {
        if (Test-IsProjectResource @($cert.DomainName, $cert.CertificateArn)) {
            Add-PlanItem KEEP "ACM Certificate" $cert.DomainName $r "Issued for a project domain"
        } elseif ($cert.InUse) {
            Add-PlanItem KEEP "ACM Certificate" $cert.DomainName $r "Currently attached to a load balancer or distribution - deleting it would break TLS"
        } else {
            Add-PlanItem DELETE "ACM Certificate" $cert.DomainName $r "Unused certificate for a non-project domain" 145 `
                @("aws acm delete-certificate --certificate-arn $($cert.CertificateArn) --region $r") $cert.CertificateArn
        }
    }

    # --- Load balancers and target groups ---
    $albs = Get-RegionalItems "aws elbv2 describe-load-balancers --region $r --output json" "Load balancers in $r" "LoadBalancers" $r
    foreach ($lb in $albs) {
        if (Test-IsProjectResource @($lb.LoadBalancerName, $lb.LoadBalancerArn)) {
            Add-PlanItem KEEP "Load Balancer" $lb.LoadBalancerName $r "Fronts the project's ECS Express Gateway service"
        } else {
            Add-PlanItem DELETE "Load Balancer" $lb.LoadBalancerName $r "Load balancer is not part of the project" 20 `
                @("aws elbv2 delete-load-balancer --load-balancer-arn $($lb.LoadBalancerArn) --region $r") $lb.DNSName
        }
    }

    $tgs = Get-RegionalItems "aws elbv2 describe-target-groups --region $r --output json" "Target groups in $r" "TargetGroups" $r
    foreach ($tg in $tgs) {
        if (Test-IsProjectResource @($tg.TargetGroupName, $tg.TargetGroupArn)) {
            Add-PlanItem KEEP "Target Group" $tg.TargetGroupName $r "Belongs to the project's ECS Express Gateway ALB"
        } else {
            Add-PlanItem DELETE "Target Group" $tg.TargetGroupName $r "Target group is not part of the project" 25 `
                @("aws elbv2 delete-target-group --target-group-arn $($tg.TargetGroupArn) --region $r")
        }
    }

    # --- Network interfaces, needed to decide which Elastic IPs are in use ---
    # An EIP attached to a kept ENI (the project ALB's, for instance) must be kept:
    # releasing it would strip the public address off a running service.
    $enis = Get-RegionalItems "aws ec2 describe-network-interfaces --region $r --output json" "Network interfaces in $r" "NetworkInterfaces" $r
    $keptEniIds = @()
    foreach ($eni in $enis) {
        if (Test-IsProjectResource @($eni.Description, $eni.NetworkInterfaceId)) {
            $keptEniIds += $eni.NetworkInterfaceId
        }
    }

    # --- Elastic IPs ---
    $eips = Get-RegionalItems "aws ec2 describe-addresses --region $r --output json" "Elastic IPs in $r" "Addresses" $r
    foreach ($eip in $eips) {
        if ($eip.NetworkInterfaceId -and $keptEniIds -contains $eip.NetworkInterfaceId) {
            Add-PlanItem KEEP "Elastic IP" $eip.PublicIp $r "Attached to project network interface $($eip.NetworkInterfaceId)"
            continue
        }

        $commands = @()
        if ($eip.AssociationId) {
            $commands += "aws ec2 disassociate-address --association-id $($eip.AssociationId) --region $r"
        }
        $commands += "aws ec2 release-address --allocation-id $($eip.AllocationId) --region $r"

        $attachedTo = if ($eip.InstanceId) { "instance $($eip.InstanceId)" }
                      elseif ($eip.NetworkInterfaceId) { "interface $($eip.NetworkInterfaceId)" }
                      else { "nothing" }

        Add-PlanItem DELETE "Elastic IP" $eip.PublicIp $r "Not attached to any project resource (attached to $attachedTo)" 50 `
            $commands "AllocationId $($eip.AllocationId)"
    }

    # --- Security groups ---
    # Default groups cannot be deleted and are removed with their VPC, so they are
    # only ever reported as kept.
    $sgs = Get-RegionalItems "aws ec2 describe-security-groups --region $r --output json" "Security groups in $r" "SecurityGroups" $r
    foreach ($sg in $sgs) {
        if ($sg.GroupName -eq "default") {
            Add-PlanItem KEEP "Security Group" $sg.GroupId $r "Default security group - deleted automatically with its VPC"
        } elseif (Test-IsProjectResource @($sg.GroupName, $sg.GroupId, $sg.Description)) {
            Add-PlanItem KEEP "Security Group" $sg.GroupId $r "Belongs to the $projectPrefix project"
        } else {
            Add-PlanItem DELETE "Security Group" $sg.GroupId $r "Group '$($sg.GroupName)' is not used by the project" 65 `
                @("aws ec2 delete-security-group --group-id $($sg.GroupId) --region $r") $sg.Description
        }
    }

    # --- Subnets, route tables and internet gateways in deletable VPCs ---
    $subnets = Get-RegionalItems "aws ec2 describe-subnets --region $r --output json" "Subnets in $r" "Subnets" $r
    foreach ($s in $subnets) {
        if ($deletableVpcIds -contains $s.VpcId) {
            Add-PlanItem DELETE "Subnet" $s.SubnetId $r "Belongs to non-project VPC $($s.VpcId)" 70 `
                @("aws ec2 delete-subnet --subnet-id $($s.SubnetId) --region $r") "CIDR $($s.CidrBlock)"
        } else {
            Add-PlanItem KEEP "Subnet" $s.SubnetId $r "Belongs to a kept VPC ($($s.VpcId))"
        }
    }

    $rts = Get-RegionalItems "aws ec2 describe-route-tables --region $r --output json" "Route tables in $r" "RouteTables" $r
    foreach ($rt in $rts) {
        $isMain = @($rt.Associations | Where-Object { $_.Main }).Count -gt 0
        if ($deletableVpcIds -contains $rt.VpcId) {
            if ($isMain) {
                # The main route table has no separate delete call; it goes with the VPC.
                Add-PlanItem KEEP "Route Table" $rt.RouteTableId $r "Main route table - removed automatically with VPC $($rt.VpcId)"
            } else {
                Add-PlanItem DELETE "Route Table" $rt.RouteTableId $r "Belongs to non-project VPC $($rt.VpcId)" 75 `
                    @("aws ec2 delete-route-table --route-table-id $($rt.RouteTableId) --region $r")
            }
        } else {
            Add-PlanItem KEEP "Route Table" $rt.RouteTableId $r "Belongs to a kept VPC ($($rt.VpcId))"
        }
    }

    $igws = Get-RegionalItems "aws ec2 describe-internet-gateways --region $r --output json" "Internet gateways in $r" "InternetGateways" $r
    foreach ($igw in $igws) {
        $attachedVpc = if (@($igw.Attachments).Count -gt 0) { $igw.Attachments[0].VpcId } else { "" }
        if ($attachedVpc -and $deletableVpcIds -contains $attachedVpc) {
            Add-PlanItem DELETE "Internet Gateway" $igw.InternetGatewayId $r "Attached to non-project VPC $attachedVpc" 80 `
                @(
                    "aws ec2 detach-internet-gateway --internet-gateway-id $($igw.InternetGatewayId) --vpc-id $attachedVpc --region $r",
                    "aws ec2 delete-internet-gateway --internet-gateway-id $($igw.InternetGatewayId) --region $r"
                )
        } else {
            Add-PlanItem KEEP "Internet Gateway" $igw.InternetGatewayId $r "Attached to a kept VPC ($attachedVpc)"
        }
    }

    # --- NAT gateways (billed hourly, so always worth surfacing) ---
    $nats = Get-RegionalItems "aws ec2 describe-nat-gateways --region $r --output json" "NAT gateways in $r" "NatGateways" $r
    foreach ($nat in $nats) {
        if ($nat.State -in @("deleted", "deleting")) { continue }
        if ($deletableVpcIds -contains $nat.VpcId) {
            Add-PlanItem DELETE "NAT Gateway" $nat.NatGatewayId $r "Belongs to non-project VPC $($nat.VpcId)" 45 `
                @("aws ec2 delete-nat-gateway --nat-gateway-id $($nat.NatGatewayId) --region $r")
        } else {
            Add-PlanItem KEEP "NAT Gateway" $nat.NatGatewayId $r "Belongs to a kept VPC ($($nat.VpcId))"
        }
    }

    # --- ECR repositories ---
    $repos = Get-RegionalItems "aws ecr describe-repositories --region $r --output json" "ECR repositories in $r" "repositories" $r
    foreach ($repo in $repos) {
        if (Test-IsProjectResource @($repo.repositoryName, $repo.repositoryArn)) {
            Add-PlanItem KEEP "ECR Repository" $repo.repositoryName $r "Holds the project's container image"
        } else {
            Add-PlanItem DELETE "ECR Repository" $repo.repositoryName $r "Repository is not part of the project" 90 `
                @("aws ecr delete-repository --repository-name $($repo.repositoryName) --force --region $r")
        }
    }

    # --- SSM parameters ---
    $params = Get-RegionalItems "aws ssm describe-parameters --region $r --output json" "SSM parameters in $r" "Parameters" $r
    foreach ($p in $params) {
        if (Test-IsProjectResource @($p.Name)) {
            Add-PlanItem KEEP "SSM Parameter" $p.Name $r "Secret consumed by the project's ECS task"
        } elseif ($IncludeProject -and $p.Name -like "*$projectPrefix*") {
            # The one thing a teardown cannot undo. Every other project resource is
            # rebuilt from terraform/main.tf, but these hold the GitHub token, the
            # Anthropic key and the app API key - values AWS cannot give back once
            # deleted. Standard parameters are free, so keeping them costs nothing and
            # losing them costs a manual re-issue of three secrets. Ordered into the
            # manual-review band, which never auto-executes even under -Apply.
            Add-PlanItem DELETE "SSM Parameter" $p.Name $r "Project secret - REVIEW MANUALLY, the value cannot be recovered from AWS once deleted" 905 `
                @("aws ssm delete-parameter --name `"$($p.Name)`" --region $r") `
                "$($p.Type) - never executed automatically; free to keep, and create-infra.ps1 reuses it on rebuild"
        } else {
            Add-PlanItem DELETE "SSM Parameter" $p.Name $r "Parameter is not read by the project" 95 `
                @("aws ssm delete-parameter --name `"$($p.Name)`" --region $r") $p.Type
        }
    }

    # --- CloudWatch log groups ---
    $logGroups = Get-RegionalItems "aws logs describe-log-groups --region $r --output json" "Log groups in $r" "logGroups" $r
    foreach ($lg in $logGroups) {
        if (Test-IsProjectResource @($lg.logGroupName)) {
            Add-PlanItem KEEP "Log Group" $lg.logGroupName $r "Named for the project"
        } else {
            Add-PlanItem DELETE "Log Group" $lg.logGroupName $r "Log group is not produced by the project" 100 `
                @("aws logs delete-log-group --log-group-name `"$($lg.logGroupName)`" --region $r") `
                "$($lg.storedBytes) bytes stored"
        }
    }

    # --- Types below need permissions beyond the current inventory policy. When the
    # --- call is denied nothing is planned for that type; the denial is recorded in
    # --- the report's failed-calls section instead of being read as "none exist".
    $volumes = Get-RegionalItems "aws ec2 describe-volumes --region $r --output json" "EBS volumes in $r" "Volumes" $r
    foreach ($vol in $volumes) {
        $name = Get-NameTag $vol
        $attachedInstances = @($vol.Attachments | ForEach-Object { $_.InstanceId })
        if (Test-IsProjectResource @($name, $vol.VolumeId)) {
            Add-PlanItem KEEP "EBS Volume" $vol.VolumeId $r "Belongs to the $projectPrefix project"
        } else {
            $volDetail = "$($vol.Size) GiB $($vol.VolumeType)"
            $reason = if ($attachedInstances.Count -gt 0) {
                # A root volume with DeleteOnTermination disappears with its instance,
                # which is terminated at order 35 - long before this call at 105. Say so,
                # otherwise the explicit delete looks like it failed when it no-ops.
                $alsoDeleted = @($script:plan | Where-Object {
                    $_.Action -eq "DELETE" -and $_.ResourceType -eq "EC2 Instance" -and $attachedInstances -contains $_.Identifier
                })
                if ($alsoDeleted.Count -gt 0) {
                    $volDetail += " - normally removed automatically when instance $($attachedInstances -join ', ') is terminated (DeleteOnTermination)"
                }
                "Attached to non-project instance(s) $($attachedInstances -join ', ')"
            } else {
                "Unattached volume, still billed monthly"
            }
            Add-PlanItem DELETE "EBS Volume" $vol.VolumeId $r $reason 105 `
                @("aws ec2 delete-volume --volume-id $($vol.VolumeId) --region $r") $volDetail
        }
    }

    $snapshots = Get-RegionalItems "aws ec2 describe-snapshots --owner-ids self --region $r --output json" "EBS snapshots in $r" "Snapshots" $r
    foreach ($snap in $snapshots) {
        if (Test-IsProjectResource @($snap.Description, (Get-NameTag $snap))) {
            Add-PlanItem KEEP "EBS Snapshot" $snap.SnapshotId $r "Belongs to the $projectPrefix project"
        } else {
            Add-PlanItem DELETE "EBS Snapshot" $snap.SnapshotId $r "Snapshot is not part of the project" 110 `
                @("aws ec2 delete-snapshot --snapshot-id $($snap.SnapshotId) --region $r") $snap.Description
        }
    }

    $images = Get-RegionalItems "aws ec2 describe-images --owners self --region $r --output json" "AMIs in $r" "Images" $r
    foreach ($img in $images) {
        if (Test-IsProjectResource @($img.Name, $img.ImageId)) {
            Add-PlanItem KEEP "AMI" $img.ImageId $r "Belongs to the $projectPrefix project"
        } else {
            Add-PlanItem DELETE "AMI" $img.ImageId $r "Private AMI '$($img.Name)' is not part of the project" 115 `
                @("aws ec2 deregister-image --image-id $($img.ImageId) --region $r")
        }
    }

    $keyPairs = Get-RegionalItems "aws ec2 describe-key-pairs --region $r --output json" "Key pairs in $r" "KeyPairs" $r
    foreach ($kp in $keyPairs) {
        if (Test-IsProjectResource @($kp.KeyName)) {
            Add-PlanItem KEEP "Key Pair" $kp.KeyName $r "Belongs to the $projectPrefix project"
        } else {
            Add-PlanItem DELETE "Key Pair" $kp.KeyName $r "SSH key pair is not used by the project" 120 `
                @("aws ec2 delete-key-pair --key-name `"$($kp.KeyName)`" --region $r")
        }
    }

    $lambdas = Get-RegionalItems "aws lambda list-functions --region $r --output json" "Lambda functions in $r" "Functions" $r
    foreach ($fn in $lambdas) {
        if (Test-IsProjectResource @($fn.FunctionName, $fn.FunctionArn)) {
            Add-PlanItem KEEP "Lambda Function" $fn.FunctionName $r "Belongs to the $projectPrefix project"
        } else {
            Add-PlanItem DELETE "Lambda Function" $fn.FunctionName $r "Function is not part of the project" 55 `
                @("aws lambda delete-function --function-name $($fn.FunctionName) --region $r") $fn.Runtime
        }
    }

    $asgs = Get-RegionalItems "aws autoscaling describe-auto-scaling-groups --region $r --output json" "Auto Scaling groups in $r" "AutoScalingGroups" $r
    foreach ($asg in $asgs) {
        if (Test-IsProjectResource @($asg.AutoScalingGroupName)) {
            Add-PlanItem KEEP "Auto Scaling Group" $asg.AutoScalingGroupName $r "Belongs to the $projectPrefix project"
        } else {
            # Deleted before instances: otherwise the group replaces what was terminated.
            Add-PlanItem DELETE "Auto Scaling Group" $asg.AutoScalingGroupName $r "Group is not part of the project" 30 `
                @("aws autoscaling delete-auto-scaling-group --auto-scaling-group-name `"$($asg.AutoScalingGroupName)`" --force-delete --region $r")
        }
    }

    $cloud9Ids = Get-RegionalItems "aws cloud9 list-environments --region $r --output json" "Cloud9 environments in $r" "environmentIds" $r
    foreach ($env9 in $cloud9Ids) {
        Add-PlanItem DELETE "Cloud9 Environment" $env9.Value $r "Cloud9 is unrelated to the project; deleting the environment also removes its EC2 instance and volume" 5 `
            @("aws cloud9 delete-environment --environment-id $($env9.Value) --region $r")
    }

    $codebuild = Get-RegionalItems "aws codebuild list-projects --region $r --output json" "CodeBuild projects in $r" "projects" $r
    foreach ($proj in $codebuild) {
        if (Test-IsProjectResource @($proj.Value)) {
            Add-PlanItem KEEP "CodeBuild Project" $proj.Value $r "Belongs to the $projectPrefix project"
        } else {
            Add-PlanItem DELETE "CodeBuild Project" $proj.Value $r "Build project is not part of the project" 125 `
                @("aws codebuild delete-project --name `"$($proj.Value)`" --region $r")
        }
    }

    $codedeploy = Get-RegionalItems "aws deploy list-applications --region $r --output json" "CodeDeploy applications in $r" "applications" $r
    foreach ($app in $codedeploy) {
        if (Test-IsProjectResource @($app.Value)) {
            Add-PlanItem KEEP "CodeDeploy Application" $app.Value $r "Belongs to the $projectPrefix project"
        } else {
            Add-PlanItem DELETE "CodeDeploy Application" $app.Value $r "Deploy application is not part of the project" 130 `
                @("aws deploy delete-application --application-name `"$($app.Value)`" --region $r")
        }
    }

    $stacks = Get-RegionalItems "aws cloudformation describe-stacks --region $r --output json" "CloudFormation stacks in $r" "Stacks" $r
    foreach ($stack in $stacks) {
        if ($stack.StackStatus -like "DELETE_*") { continue }
        if (Test-IsProjectResource @($stack.StackName)) {
            Add-PlanItem KEEP "CloudFormation Stack" $stack.StackName $r "Belongs to the $projectPrefix project"
        } else {
            # A Cloud9 environment is itself backed by a CloudFormation stack named after
            # it. Deleting the environment at order 5 tears the stack down too, so this
            # entry is a fallback - and deleting the stack directly would work equally.
            $stackDetail = $stack.StackStatus
            if ($stack.StackName -like "aws-cloud9-*") {
                $stackDetail += " - backing stack of a Cloud9 environment that is deleted first; this stack goes with it"
            }
            Add-PlanItem DELETE "CloudFormation Stack" $stack.StackName $r "Stack is not part of the project" 140 `
                @("aws cloudformation delete-stack --stack-name `"$($stack.StackName)`" --region $r") $stackDetail
        }
    }
}

# ---------------------------------------------------------------------------
# Global resources
# ---------------------------------------------------------------------------

Write-Host "----------------------------------------------------" -ForegroundColor Gray
Write-Host "Global (account-wide) resources" -ForegroundColor Cyan

# --- The caller's own identity (keep rule 5) ---
# Under -IncludeProject nothing is protected by name any more, which puts the policy
# granting these very credentials their permissions in scope for deletion. Deleting it
# halfway through a teardown revokes the script's own access and leaves the account
# stranded, so the caller's identity and everything attached to it is resolved here and
# excluded in both modes.
$callerUserName = ""
$callerRoleName = ""
if ($callerArn -match '^arn:aws[^:]*:iam::\d+:user/(?:.*/)?(.+)$') {
    $callerUserName = $Matches[1]
} elseif ($callerArn -match '^arn:aws[^:]*:sts::\d+:assumed-role/([^/]+)/') {
    $callerRoleName = $Matches[1]
} elseif ($callerArn -match '^arn:aws[^:]*:iam::\d+:role/(?:.*/)?(.+)$') {
    $callerRoleName = $Matches[1]
}

$callerPolicyArns = @()
if ($callerUserName) {
    $callerAttached = Get-RegionalItems "aws iam list-attached-user-policies --user-name `"$callerUserName`" --output json" `
        "Attached policies of caller $callerUserName" "AttachedPolicies" "global"
    $callerPolicyArns += @($callerAttached | ForEach-Object { $_.PolicyArn })

    $callerGroups = Get-RegionalItems "aws iam list-groups-for-user --user-name `"$callerUserName`" --output json" `
        "Groups of caller $callerUserName" "Groups" "global"
    foreach ($grp in $callerGroups) {
        $grpAttached = Get-RegionalItems "aws iam list-attached-group-policies --group-name `"$($grp.GroupName)`" --output json" `
            "Attached policies of caller group $($grp.GroupName)" "AttachedPolicies" "global"
        $callerPolicyArns += @($grpAttached | ForEach-Object { $_.PolicyArn })
    }
} elseif ($callerRoleName) {
    $callerAttached = Get-RegionalItems "aws iam list-attached-role-policies --role-name `"$callerRoleName`" --output json" `
        "Attached policies of caller role $callerRoleName" "AttachedPolicies" "global"
    $callerPolicyArns += @($callerAttached | ForEach-Object { $_.PolicyArn })
}
$callerPolicyArns = @($callerPolicyArns | Where-Object { $_ } | Select-Object -Unique)

if ($callerPolicyArns.Count -gt 0) {
    Write-Host "  Protecting $($callerPolicyArns.Count) policy(ies) attached to the caller." -ForegroundColor DarkGray
}

$roles = Get-RegionalItems "aws iam list-roles --output json" "IAM roles" "Roles" "global"
foreach ($role in $roles) {
    # Service-linked roles are created and owned by AWS services. They cost nothing,
    # several cannot be deleted while their service is in use, and AWS recreates them
    # on demand - so they are never candidates.
    if ($role.Path -like "/aws-service-role/*") {
        Add-PlanItem KEEP "IAM Role" $role.RoleName "global" "AWS service-linked role - managed by AWS, not deletable by hand"
        continue
    }

    if ($callerRoleName -and $role.RoleName -eq $callerRoleName) {
        Add-PlanItem KEEP "IAM Role" $role.RoleName "global" "The caller's own role - deleting it would revoke the credentials running this script"
        continue
    }

    if (Test-IsProjectResource @($role.RoleName, $role.Arn)) {
        Add-PlanItem KEEP "IAM Role" $role.RoleName "global" "Used by the project's ECS task, execution or infrastructure role"
        continue
    }

    # A role can only be deleted once every attachment is gone, so the plan carries
    # the full detach sequence rather than a bare delete-role. If the enumeration
    # itself is denied the sequence is necessarily incomplete, which the plan has to
    # say out loud - otherwise it reads as "one command and the role is gone".
    $errsBefore = $script:apiErrors.Count
    $commands = @()
    $attached = Get-RegionalItems "aws iam list-attached-role-policies --role-name `"$($role.RoleName)`" --output json" "Attached policies of $($role.RoleName)" "AttachedPolicies" "global"
    foreach ($pol in $attached) {
        $commands += "aws iam detach-role-policy --role-name `"$($role.RoleName)`" --policy-arn $($pol.PolicyArn)"
    }

    $inline = Get-RegionalItems "aws iam list-role-policies --role-name `"$($role.RoleName)`" --output json" "Inline policies of $($role.RoleName)" "PolicyNames" "global"
    foreach ($pol in $inline) {
        $commands += "aws iam delete-role-policy --role-name `"$($role.RoleName)`" --policy-name `"$($pol.Value)`""
    }

    $profiles = Get-RegionalItems "aws iam list-instance-profiles-for-role --role-name `"$($role.RoleName)`" --output json" "Instance profiles of $($role.RoleName)" "InstanceProfiles" "global"
    foreach ($prof in $profiles) {
        $commands += "aws iam remove-role-from-instance-profile --instance-profile-name `"$($prof.InstanceProfileName)`" --role-name `"$($role.RoleName)`""
        $commands += "aws iam delete-instance-profile --instance-profile-name `"$($prof.InstanceProfileName)`""
    }

    $commands += "aws iam delete-role --role-name `"$($role.RoleName)`""

    $detail = if ($script:apiErrors.Count -gt $errsBefore) {
        "INCOMPLETE: listing this role's policies/instance profiles was denied, so the detach steps below are missing. delete-role will fail with DeleteConflict until they are detached."
    } else {
        "$($attached.Count) attached policy(ies), $($inline.Count) inline policy(ies), $($profiles.Count) instance profile(s)"
    }

    Add-PlanItem DELETE "IAM Role" $role.RoleName "global" "Role is not used by the project (created $($role.CreateDate))" 210 `
        $commands $detail
}

$policies = Get-RegionalItems "aws iam list-policies --scope Local --output json" "IAM customer-managed policies" "Policies" "global"
foreach ($pol in $policies) {
    if ($callerPolicyArns -contains $pol.Arn) {
        Add-PlanItem KEEP "IAM Policy" $pol.PolicyName "global" "Attached to the caller - deleting it would revoke the permissions this script is using"
    } elseif (Test-IsProjectResource @($pol.PolicyName, $pol.Arn)) {
        Add-PlanItem KEEP "IAM Policy" $pol.PolicyName "global" "Grants the project's ECS task access to its SSM secrets"
    } else {
        Add-PlanItem DELETE "IAM Policy" $pol.PolicyName "global" "Customer-managed policy is not used by the project" 220 `
            @("aws iam delete-policy --policy-arn $($pol.Arn)") "$($pol.AttachmentCount) attachment(s)"
    }
}

$dists = Get-RegionalItems "aws cloudfront list-distributions --output json" "CloudFront distributions" "DistributionList.Items" "global"
foreach ($d in $dists) {
    if ($keepCloudFrontIds -contains $d.Id -or (Test-IsProjectResource @($d.Comment, $d.Id))) {
        Add-PlanItem KEEP "CloudFront Distribution" $d.Id "global" "The project's CDN (terraform aws_cloudfront_distribution.agent_cdn)"
    } else {
        # CloudFront needs a disable + propagation wait before delete, which cannot be
        # expressed as a single command; the ETag also changes between the two calls.
        Add-PlanItem DELETE "CloudFront Distribution" $d.Id "global" "Distribution is not part of the project" 230 `
            @(
                "aws cloudfront get-distribution-config --id $($d.Id)  # note the ETag, set Enabled=false",
                "aws cloudfront update-distribution --id $($d.Id) --distribution-config file://disabled-config.json --if-match <ETag>",
                "aws cloudfront wait distribution-deployed --id $($d.Id)",
                "aws cloudfront delete-distribution --id $($d.Id) --if-match <new-ETag>"
            ) "Manual multi-step deletion - requires disabling and waiting for propagation first"
    }
}

$buckets = Get-RegionalItems "aws s3api list-buckets --output json" "S3 buckets" "Buckets" "global"
foreach ($b in $buckets) {
    if (Test-IsProjectResource @($b.Name)) {
        Add-PlanItem KEEP "S3 Bucket" $b.Name "global" "Belongs to the $projectPrefix project"
    } else {
        # Emptying a bucket destroys its objects irrecoverably, so this is always
        # reported and never executed, even under -Apply.
        Add-PlanItem DELETE "S3 Bucket" $b.Name "global" "Bucket is not part of the project - REVIEW MANUALLY, contents cannot be recovered" 900 `
            @(
                "aws s3 rm s3://$($b.Name) --recursive",
                "aws s3api delete-bucket --bucket $($b.Name)"
            ) "Never executed automatically - listed for manual review"
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

# Every DELETE reason was written for the cleanup framing ("not part of the project"),
# which reads as nonsense next to the project's own ECR repository. The classification
# is right either way - only the explanation needs to match the mode.
if ($IncludeProject) {
    foreach ($item in $plan) {
        if ($item.Action -ne "DELETE") { continue }
        if ($item.Reason -like "Project *") { continue }
        if (-not (Test-IsProjectName @($item.Identifier, $item.Detail))) { continue }

        $item.Reason = if ($item.Order -ge 900) {
            "Project resource - REVIEW MANUALLY, this cannot be recovered once deleted"
        } else {
            "Project resource - deleted because -IncludeProject was passed"
        }
    }
}

$toDelete = @($plan | Where-Object { $_.Action -eq "DELETE" } | Sort-Object Order, ResourceType, Identifier)
$toKeep = @($plan | Where-Object { $_.Action -eq "KEEP" } | Sort-Object Region, ResourceType, Identifier)

# The 900+ band is destructive in a way nothing else here is - S3 bucket contents and,
# under -IncludeProject, the project's SSM secrets. Neither can be recovered from AWS,
# so the band is reported and never auto-executed.
$manualOnly = @($toDelete | Where-Object { $_.Order -ge 900 })
$executable = @($toDelete | Where-Object { $_.Order -lt 900 })

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "Plan summary" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  KEEP   : $($toKeep.Count) resource(s)" -ForegroundColor Green
Write-Host "  DELETE : $($toDelete.Count) resource(s)" -ForegroundColor Yellow
if ($manualOnly.Count -gt 0) {
    Write-Host "           ($($manualOnly.Count) flagged for manual review and never auto-deleted)" -ForegroundColor Yellow
}
if ($apiErrors.Count -gt 0) {
    Write-Host "  FAILED : $($apiErrors.Count) AWS call(s) - those resource types were NOT classified" -ForegroundColor Red
}
Write-Host ""

foreach ($item in $toDelete) {
    $tag = if ($item.Order -ge 900) { "[MANUAL]" } else { "[DELETE]" }
    Write-Host "$tag $($item.ResourceType) : $($item.Identifier) ($($item.Region))" -ForegroundColor Yellow
    Write-Host "         $($item.Reason)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Execution (only with -Apply)
# ---------------------------------------------------------------------------

$executed = $false

if ($Apply -and $executable.Count -gt 0) {
    Write-Host ""
    Write-Host "!! $($executable.Count) resource(s) are about to be PERMANENTLY DELETED in account $accountId." -ForegroundColor Red

    # A teardown takes the running service with it, so it asks for a phrase that cannot
    # be typed by muscle memory from an ordinary cleanup run.
    $confirmPhrase = if ($IncludeProject) { "DELETE EVERYTHING" } else { "DELETE" }
    if ($IncludeProject) {
        Write-Host "!! This includes the project itself - the live service will be destroyed." -ForegroundColor Red
    }

    $confirmed = $Force
    if (-not $confirmed) {
        $answer = Read-Host "Type $confirmPhrase (in capitals) to proceed, anything else to abort"
        $confirmed = ($answer -ceq $confirmPhrase)
    }

    if (-not $confirmed) {
        Write-Host "Aborted - nothing was deleted." -ForegroundColor Green
    } else {
        $executed = $true
        Write-Host ""
        Write-Host "Executing deletions in dependency order..." -ForegroundColor Yellow

        foreach ($item in $executable) {
            Write-Host "Deleting $($item.ResourceType) $($item.Identifier)..." -ForegroundColor Yellow
            $stepErrors = @()

            foreach ($cmd in $item.Commands) {
                # Comment-only entries are guidance for manual steps, not commands.
                if ($cmd -match '^\s*#') { continue }

                $prevEap = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                try {
                    $out = Invoke-Expression "$cmd 2>&1"
                    $code = $LASTEXITCODE
                } finally {
                    $ErrorActionPreference = $prevEap
                }

                if ($code -ne 0) {
                    $detail = ($out |
                        Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
                        ForEach-Object { $_.Exception.Message }) -join " "
                    $stepErrors += "$cmd -> $detail"
                    Write-Host "  FAILED: $cmd" -ForegroundColor Red
                    Write-Host "    $detail" -ForegroundColor Red
                }
            }

            if ($stepErrors.Count -gt 0) {
                $item.Result = "FAILED: " + ($stepErrors -join " | ")
            } else {
                $item.Result = "deleted"
                Write-Host "  OK" -ForegroundColor Green
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Terraform state
# ---------------------------------------------------------------------------

# After a teardown the local state file describes resources that no longer exist.
# Terraform recovers from that on its own - refresh drops the missing resources - but
# only if every one of them is genuinely gone. A partial teardown leaves a state that
# disagrees with reality in both directions, which is how a later apply ends up trying
# to update something it should be creating. Moving the file aside makes the next
# create-infra run start from empty, and keeps the old state around to read if a
# resource turns out to have survived.
$stateArchivePath = ""
if ($IncludeProject -and $executed) {
    $statePath = Join-Path $backendDir "terraform/terraform.tfstate"
    if (Test-Path $statePath) {
        $stateArchivePath = Join-Path $backendDir "terraform/terraform.tfstate.pre-teardown-$timestamp"
        try {
            Move-Item -Path $statePath -Destination $stateArchivePath -Force -ErrorAction Stop
            Write-Host ""
            Write-Host "Moved terraform.tfstate aside to $(Split-Path -Leaf $stateArchivePath)" -ForegroundColor Yellow
            Write-Host "The next 'npm run create-infra' will build from an empty state." -ForegroundColor DarkGray
        } catch {
            $stateArchivePath = ""
            Write-Host ""
            Write-Host "WARNING: could not move terraform.tfstate aside: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Move it by hand before running create-infra, or terraform will try to update deleted resources." -ForegroundColor Red
        }
    }
}

if (-not $Apply) {
    foreach ($item in $toDelete) { $item.Result = "not executed (dry run)" }
}
foreach ($item in $manualOnly) {
    $item.Result = "not executed (manual review required)"
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

$modeLabel = if ($Apply -and $executed) { "APPLY (resources were deleted)" }
             elseif ($Apply) { "APPLY (aborted at confirmation - nothing deleted)" }
             else { "DRY RUN (nothing was deleted)" }

$scopeLabel = if ($IncludeProject) { "FULL TEARDOWN (the project's own resources are deleted too)" }
              else { "CLEANUP (everything named ``$projectPrefix`` is kept)" }

$reportTitle = if ($IncludeProject) { "AWS Teardown Report" } else { "AWS Cleanup Report" }

# The two mode-dependent keep rules, built here because the nesting they need
# (subexpression, inside a string, inside a subexpression) does not survive being
# written inline in a here-string.
$patternList = ($keepNamePatterns | ForEach-Object { "``$_``" }) -join ', '
$rule1Text = if ($IncludeProject) {
    "**SUSPENDED** - name matching is disabled by ``-IncludeProject``, so project resources are deleted like anything else"
} else {
    "Name, ID or ARN contains one of: $patternList"
}
$rule6Text = if ($IncludeProject) {
    "**SUSPENDED** - the project's CloudFront distribution is deleted too"
} else {
    "It is a CloudFront distribution listed in ``terraform/terraform.tfstate`` ($($keepCloudFrontIds -join ', '))"
}

# Built here rather than inline in the report: a nested here-string inside the report's
# own here-string would be terminated by the parser at the wrong "@.
$rebuildSection = ""
if ($IncludeProject) {
    $rebuildSection = "`n### Rebuilding`n`n"
    $rebuildSection += "``npm run create-infra`` provisions the whole stack again from ``terraform/main.tf``: "
    $rebuildSection += "SSM parameters, ECR repository, IAM roles, ECS cluster and Express Gateway service, "
    $rebuildSection += "and the CloudFront distribution.`n"
    if ($stateArchivePath) {
        $rebuildSection += "`nThe previous Terraform state was moved to ``$(Split-Path -Leaf $stateArchivePath)`` so the rebuild starts from empty.`n"
    }
}

$projectLine = if ($IncludeProject) { "**Project:** targeted for deletion (``-IncludeProject``)" }
               else { "**Project kept:** ``$projectPrefix``" }

$report = @"
# $reportTitle - $modeLabel

**Generated:** $(Get-Date -Format "yyyy-MM-dd HH:mm:ss K")
**Account ID:** $accountId
**Caller Identity:** $callerId
**Regions Swept:** $($regionsToCheck -join ', ')
$projectLine
**Scope:** $scopeLabel
**Mode:** $modeLabel

| Outcome | Count |
| --- | --- |
| Resources kept | $($toKeep.Count) |
| Resources planned for deletion | $($toDelete.Count) |
| Of those, flagged for manual review only | $($manualOnly.Count) |
| AWS calls that failed | $($apiErrors.Count) |

---

## 1. Resources planned for deletion

"@

if ($toDelete.Count -gt 0) {
    $report += "Listed in execution order. Dependencies are removed before the resources they belong to.`n`n"
    $report += "| # | Region | Resource Type | Identifier | Reason | Notes | Status |`n"
    $report += "| --- | --- | --- | --- | --- | --- | --- |`n"
    $i = 1
    foreach ($item in $toDelete) {
        $report += "| $i | $($item.Region) | $($item.ResourceType) | ``$(Format-Cell $item.Identifier)`` | $(Format-Cell $item.Reason) | $(Format-Cell $item.Detail) | $(Format-Cell $item.Result) |`n"
        $i++
    }
    $report += "`n"

    $report += "### Deletion commands`n`n"
    $report += "The exact AWS CLI sequence the script runs under ``-Apply``, in order.`n`n"
    $report += '```bash' + "`n"
    foreach ($item in $toDelete) {
        $report += "# [$($item.Region)] $($item.ResourceType): $($item.Identifier)`n"
        $report += "#   reason: $($item.Reason)`n"
        foreach ($cmd in $item.Commands) {
            $report += "$cmd`n"
        }
        $report += "`n"
    }
    $report += '```' + "`n`n"
} else {
    $report += "*Nothing to delete - every resource found belongs to the project.*`n`n"
}

$report += @"
## 2. Resources kept

"@

if ($toKeep.Count -gt 0) {
    $report += "| Region | Resource Type | Identifier | Why it is kept |`n"
    $report += "| --- | --- | --- | --- |`n"
    foreach ($item in $toKeep) {
        $report += "| $($item.Region) | $($item.ResourceType) | ``$(Format-Cell $item.Identifier)`` | $(Format-Cell $item.Reason) |`n"
    }
    $report += "`n"
} else {
    $report += "*No resources were classified as keep.*`n`n"
}

$report += @"
## 3. Classification rules

A resource is deleted only when it fails every rule below, so anything the script
cannot positively identify as junk survives.

| # | Keep rule |
| --- | --- |
| 1 | $rule1Text |
| 2 | It is a default VPC, or a subnet/route table/IGW/default security group inside one |
| 3 | It is an AWS service-linked role (path under ``/aws-service-role/``) |
| 4 | It is attached to something already kept - e.g. an Elastic IP on a project ENI |
| 5 | It is the caller's own IAM role, or a policy attached to the caller - deleting those would revoke the credentials mid-run |
| 6 | $rule6Text |

Rules 2-5 hold in both modes. ``-IncludeProject`` drops only rules 1 and 6.

### Deletion order

Resources are deleted low-order-first so that dependencies never block their parents.

| Order | Stage |
| --- | --- |
| 5-15 | Cloud9 environments, ECS services, ECS clusters |
| 20-30 | Load balancers, target groups, Auto Scaling groups |
| 35-55 | EC2 instances, NAT gateways, Elastic IPs, Lambda functions |
| 65-85 | Security groups, subnets, route tables, internet gateways, VPCs |
| 90-140 | ECR, SSM parameters, log groups, EBS volumes/snapshots, AMIs, key pairs, CodeBuild, CodeDeploy, CloudFormation |
| 210-230 | IAM roles and policies, CloudFront distributions |
| 900+ | Manual review only - never executed automatically (S3 buckets, and under ``-IncludeProject`` the project's SSM secrets) |
$rebuildSection
## 4. Failed AWS Calls

"@

if ($apiErrors.Count -gt 0) {
    $report += "*$($apiErrors.Count) AWS CLI call(s) failed. The resource types behind them were NOT classified and NOT deleted - "
    $report += "a failure here means the account was not fully inspected, not that the resource type is empty.*`n`n"
    $report += "| Query | Command | Error |`n"
    $report += "| --- | --- | --- |`n"
    foreach ($e in $apiErrors) {
        $report += "| $(Format-Cell $e.Query) | ``$(Format-Cell $e.Command)`` | $(Format-Cell $e.Detail) |`n"
    }
    $report += "`n"
} else {
    $report += "*All AWS CLI calls succeeded - the sweep saw every resource type it checks.*`n`n"
}

$report | Out-File -FilePath $reportPath -Encoding utf8

Write-Host ""
if ($apiErrors.Count -gt 0) {
    Write-Host "$($apiErrors.Count) AWS CLI call(s) failed - see section 4 of the report." -ForegroundColor Yellow
}
Write-Host "$(if ($IncludeProject) { 'Teardown' } else { 'Cleanup' }) report saved to: $reportPath" -ForegroundColor Green
if (-not $Apply) {
    $rerun = if ($IncludeProject) { "-IncludeProject -Apply" } else { "-Apply" }
    Write-Host "Dry run complete - nothing in AWS was changed. Re-run with $rerun to execute." -ForegroundColor Green
} elseif ($IncludeProject -and $executed) {
    Write-Host "Rebuild the stack with: npm run create-infra" -ForegroundColor Cyan
}
Write-Host "Done!" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan
