<#
.SYNOPSIS
    Lists and describes all AWS resources provisioned in the account.
.DESCRIPTION
    Queries AWS via the AWS CLI and generates a full inventory of the account: networking,
    compute, containers, storage, databases, application/integration services, developer
    tooling, global services (S3, CloudFront, Route 53, IAM) and secrets/config.
    Does not restrict queries by tags.

    Every region sweep also ends with a Resource Groups Tagging API call, which returns
    every taggable resource in the region regardless of type. That is the safety net for
    resource types this script does not describe explicitly, so a resource can only hide
    from the report if it is both untagged and of an unlisted type.

    When no region is supplied the script prompts for an interactive region selection.
    Choosing nothing scans every supported region, which issues a large number of AWS
    API calls and takes a while.
.PARAMETER Region
    One or more AWS Regions to query (e.g. -Region sa-east-1,us-east-1). If omitted,
    the script prompts for a selection.
.PARAMETER AllRegions
    Skips the interactive prompt and scans every supported region. Use this for
    unattended/CI runs.
.PARAMETER Profile
    The AWS CLI profile to use. If omitted, resolves from AWS_PROFILE, then the .env
    file, then 'default'.
#>
param(
    [string[]]$Region = @(),
    [switch]$AllRegions,
    [string]$Profile = ""
)

$ErrorActionPreference = "SilentlyContinue"

# Collects every AWS CLI failure so they can be printed and appended to the report
$apiErrors = @()

# Regions that simply do not offer a service. Tracked apart from $apiErrors: these are
# not gaps in the report, so counting them as failures would make a complete sweep look
# incomplete and bury the failures that do matter.
$unavailableEndpoints = @()

# Resolve script directory and paths
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = (Get-Item (Join-Path $scriptDir "..")).FullName
$envPath = Join-Path $backendDir ".env"
$reportsDir = Join-Path $backendDir "infra-reports"

# Ensure reports directory exists
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyy-MM-dd-HH-mm"
$reportPath = Join-Path $reportsDir "${timestamp}-cloud-infra-report.md"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "       AWS Infrastructure Resource Reporter         " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. Resolve AWS Regions to check
$availableRegions = @(
    "sa-east-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    "ca-central-1", "eu-central-1", "eu-west-1", "eu-west-2",
    "eu-west-3", "eu-north-1", "ap-northeast-1", "ap-northeast-2",
    "ap-northeast-3", "ap-southeast-1", "ap-southeast-2", "ap-south-1"
)

# Roughly how many AWS CLI calls each region costs (51 fixed describes, plus one
# extra per ECS cluster). Used to size the "this will take a while" alert - keep
# in sync with the query loop below.
$callsPerRegion = 52

# Turns a raw answer ("1,3", "1-4", "sa-east-1", "all") into a region list.
# Returns an empty array when nothing valid was recognised.
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

        # Numeric range, e.g. 1-4. Checked before region names, which also contain '-'.
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

        # Single index, e.g. 3
        if ($t -match '^\d+$') {
            $i = [int]$t
            if ($i -ge 1 -and $i -le $AvailableRegions.Count) {
                $selected += $AvailableRegions[$i - 1]
            } else {
                Write-Host "  Ignoring out-of-range index: $i" -ForegroundColor Yellow
            }
            continue
        }

        # Region name, e.g. sa-east-1
        $match = $AvailableRegions | Where-Object { $_ -eq $t.ToLower() }
        if ($match) {
            $selected += $match
        } else {
            Write-Host "  Ignoring unknown region: $t" -ForegroundColor Yellow
        }
    }

    return ($selected | Select-Object -Unique)
}

# Prints the region menu and reads a selection. Empty input means "scan everything".
function Request-RegionSelection {
    param([string[]]$AvailableRegions)

    while ($true) {
        Write-Host ""
        Write-Host "Which AWS regions should be scanned?" -ForegroundColor Cyan
        for ($i = 0; $i -lt $AvailableRegions.Count; $i++) {
            Write-Host ("  [{0,2}] {1}" -f ($i + 1), $AvailableRegions[$i])
        }
        Write-Host ""
        Write-Host "  Enter indexes (1,3,5), a range (1-4), region names (sa-east-1,us-east-1), or 'all'." -ForegroundColor Gray
        Write-Host ""
        Write-Host "  !! ALERT: pressing ENTER with no selection scans ALL $($AvailableRegions.Count) regions." -ForegroundColor Yellow
        Write-Host "  !! That is roughly $($AvailableRegions.Count * $callsPerRegion) AWS API calls and will take a while." -ForegroundColor Yellow
        Write-Host ""

        $answer = Read-Host "Regions (ENTER = all)"

        if ([string]::IsNullOrWhiteSpace($answer)) {
            Write-Host ""
            Write-Host "No selection made - scanning ALL $($AvailableRegions.Count) regions. This will take a while." -ForegroundColor Yellow
            return $AvailableRegions
        }

        $selected = @(Resolve-RegionSelection -Answer $answer -AvailableRegions $AvailableRegions)
        if ($selected.Count -gt 0) {
            return $selected
        }

        Write-Host "Nothing valid was recognised in '$answer'. Try again, or press ENTER to scan all regions." -ForegroundColor Red
    }
}

if ($Region.Count -gt 0) {
    $regionsToCheck = @(Resolve-RegionSelection -Answer ($Region -join ',') -AvailableRegions $availableRegions)
    if ($regionsToCheck.Count -eq 0) {
        Write-Host "Error: none of the regions passed via -Region are supported: $($Region -join ', ')" -ForegroundColor Red
        exit 1
    }
} elseif ($AllRegions) {
    Write-Host "-AllRegions supplied - scanning ALL $($availableRegions.Count) regions. This will take a while." -ForegroundColor Yellow
    $regionsToCheck = $availableRegions
} elseif ([Console]::IsInputRedirected) {
    # Non-interactive host (CI, piped input): cannot prompt, so fall back to everything.
    Write-Host "Non-interactive session - scanning ALL $($availableRegions.Count) regions. This will take a while." -ForegroundColor Yellow
    $regionsToCheck = $availableRegions
} else {
    $regionsToCheck = @(Request-RegionSelection -AvailableRegions $availableRegions)
}

Write-Host ""
Write-Host "Regions to scan ($($regionsToCheck.Count)): $($regionsToCheck -join ', ')" -ForegroundColor Green
Write-Host "Estimated AWS API calls: ~$($regionsToCheck.Count * $callsPerRegion)" -ForegroundColor Gray

# 2. Resolve AWS Profile (env -> param -> .env -> default)
if (-not [string]::IsNullOrEmpty($env:AWS_PROFILE)) {
    $Profile = $env:AWS_PROFILE
    Write-Host "Using AWS profile from environment (AWS_PROFILE): $Profile" -ForegroundColor Green
} elseif (-not [string]::IsNullOrEmpty($Profile)) {
    Write-Host "Using AWS profile parameter: $Profile" -ForegroundColor Green
} else {
    if (Test-Path $envPath) {
        $envLines = Get-Content $envPath
        foreach ($line in $envLines) {
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

# Set AWS_PROFILE environment variable if a profile was resolved
if (-not [string]::IsNullOrEmpty($Profile)) {
    $env:AWS_PROFILE = $Profile
}

# Check AWS CLI
$awsCheck = Get-Command aws -ErrorAction SilentlyContinue
if (-not $awsCheck) {
    Write-Host "Error: AWS CLI ('aws') is not installed or not in system PATH. Please install AWS CLI and try again." -ForegroundColor Red
    exit 1
}

# Check AWS authentication/identity
Write-Host "Checking AWS caller identity..." -ForegroundColor Gray
$callerIdOutput = aws sts get-caller-identity --output json 2>&1
$callerIdJson = ($callerIdOutput | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
$callerIdErr = ($callerIdOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($callerIdJson)) {
    Write-Host "Error: Failed to authenticate with AWS. Ensure you have valid AWS credentials loaded." -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($callerIdErr)) {
        Write-Host "AWS CLI said: $callerIdErr" -ForegroundColor Red
    }
    exit 1
} else {
    $callerObj = $callerIdJson | ConvertFrom-Json
    $callerId = "Arn: $($callerObj.Arn), UserID: $($callerObj.UserId)"
    $accountId = $callerObj.Account
    Write-Host "Authenticated as Account: $accountId" -ForegroundColor Green
}

# Initialize collections for all resources
$allVpcs = @()
$allSubnets = @()
$allRouteTables = @()
$allIgws = @()
$allNats = @()
$allEips = @()
$allAlbs = @()
$allTgs = @()
$allSgs = @()
$allEnis = @()
$allInstances = @()
$allEcrRepos = @()
$allEcsClusters = @()
$allRdsDbs = @()
$allSecrets = @()
$allSsmParams = @()
$allLogGroups = @()

# Networking (added)
$allVpcEndpoints = @()
$allPeerings = @()
$allClassicElbs = @()
$allCertificates = @()

# Monitoring (added)
$allAlarms = @()
$allScalableTargets = @()

# Compute & containers (added)
$allVolumes = @()
$allSnapshots = @()
$allImages = @()
$allKeyPairs = @()
$allAsgs = @()
$allEcsServices = @()
$allTaskDefs = @()
$allLambdas = @()
$allAppRunner = @()
$allEksClusters = @()

# Storage & databases (added)
$allRdsClusters = @()
$allRdsSnapshots = @()
$allDynamoTables = @()
$allElastiCache = @()
$allRedshift = @()
$allEfs = @()
$allOpenSearch = @()

# Application & integration (added)
$allRestApis = @()
$allHttpApis = @()
$allSnsTopics = @()
$allSqsQueues = @()
$allEventRules = @()
$allStateMachines = @()
$allKinesisStreams = @()
$allUserPools = @()

# Developer & deployment tooling (added)
$allStacks = @()
$allCodeBuild = @()
$allCodeDeploy = @()
$allPipelines = @()
$allCloud9 = @()

# Catch-all sweep via the Resource Groups Tagging API
$allTaggedResources = @()

# Helper to run AWS CLI command and parse JSON.
# Failures are never swallowed: the AWS CLI stderr is printed and recorded in
# $apiErrors so a sparse report can be told apart from a missing permission.
function Get-AwsResource {
    param(
        [string]$Command,
        [string]$QueryName,
        # Some list APIs print nothing at all when the account has no such resource
        # (sqs list-queues is the usual offender). For those, a clean exit with empty
        # output means "none", not a failure, and must not pollute the error section.
        [switch]$AllowEmpty
    )
    Write-Host "Fetching $QueryName..." -ForegroundColor Gray

    # The 2>&1 must live inside the expression string: applying it to Invoke-Expression
    # itself does not capture the stderr of the native command it runs.
    #
    # $ErrorActionPreference must also be Continue for the duration of the call. Under
    # the script-wide SilentlyContinue, Windows PowerShell 5.1 discards the merged
    # stderr records entirely, which would reduce every AccessDenied to a bare exit
    # code and make a missing IAM permission indistinguishable from any other failure.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = Invoke-Expression "$Command 2>&1"
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }

    $json = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    # Exception.Message holds the raw stderr line; ToString() prefixes it with the
    # RemoteException type name for native commands.
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

        # A region that does not host a service fails to resolve its endpoint entirely.
        # That means "this service does not exist here", not "this call was refused".
        if ($detail -match 'Could not connect to the endpoint URL') {
            Write-Host "  SKIPPED: $QueryName (service not available in this region)" -ForegroundColor DarkGray
            $script:unavailableEndpoints += [PSCustomObject]@{
                Query   = $QueryName
                Command = $Command
            }
            return $null
        }

        Write-Host "  FAILED: $QueryName" -ForegroundColor Red
        Write-Host "    Command: $Command" -ForegroundColor DarkGray
        Write-Host "    $detail" -ForegroundColor Red

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
        Write-Host "  WARNING: $QueryName returned output that is not valid JSON." -ForegroundColor Yellow
        Write-Host "    $($_.Exception.Message)" -ForegroundColor Yellow
        $script:apiErrors += [PSCustomObject]@{
            Query   = $QueryName
            Command = $Command
            Detail  = "Response was not valid JSON: $($_.Exception.Message)"
        }
        return $json
    }
}

# Runs one describe/list call and returns its items with the region stamped on each.
# Collapses the fetch -> null-check -> tag loop that every resource type needs.
# $Property is the JSON key holding the collection; APIs that return bare strings
# (list-task-definitions, list-queues, ...) are wrapped so they still carry a Region.
function Get-RegionalItems {
    param(
        [string]$Command,
        [string]$QueryName,
        [string]$Property,
        [string]$Region
    )

    $result = Get-AwsResource -Command $Command -QueryName $QueryName -AllowEmpty
    if ($null -eq $result) { return @() }

    # $Property may be a dotted path (e.g. "DistributionList.Items"), so walk it.
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
        if ($item -is [string]) {
            $item = [PSCustomObject]@{ Value = $item }
        }
        $item | Add-Member -MemberType NoteProperty -Name "Region" -Value $Region -Force
        $tagged += $item
    }
    return $tagged
}

# Flattens a value into a single markdown cell: arrays are joined, and pipes and
# newlines are escaped so one stray value cannot break the table.
function Format-Cell {
    param($Value)

    if ($null -eq $Value) { return "" }
    if ($Value -is [array]) {
        $Value = (@($Value) | Where-Object { $null -ne $_ }) -join ", "
    }
    return (([string]$Value) -replace '\r?\n', ' ' -replace '\|', '\|').Trim()
}

# Renders one resource collection as a markdown table, or a "nothing found" note.
# $Columns is an ordered dictionary mapping the column header to either a property
# name or a scriptblock evaluated against the item.
function Format-ReportTable {
    param(
        [string]$Title,
        [object[]]$Items,
        $Columns,
        [string]$EmptyNote = ""
    )

    $out = "### $Title`n"

    if (-not $Items -or $Items.Count -eq 0) {
        $note = if ([string]::IsNullOrEmpty($EmptyNote)) { "*No $Title found.*" } else { $EmptyNote }
        return "$out$note`n`n"
    }

    $headers = @($Columns.Keys)
    $out += "| " + ($headers -join " | ") + " |`n"
    $out += "| " + (($headers | ForEach-Object { "---" }) -join " | ") + " |`n"

    foreach ($item in $Items) {
        $cells = @()
        foreach ($h in $headers) {
            $selector = $Columns[$h]
            $value = if ($selector -is [scriptblock]) {
                $item | ForEach-Object $selector
            } else {
                $item.$selector
            }
            $cells += (Format-Cell $value)
        }
        $out += "| " + ($cells -join " | ") + " |`n"
    }

    return "$out`n"
}

# Pulls the Name tag out of whichever tag collection the service happens to use.
function Get-NameTag {
    param($Item)

    $tags = $Item.Tags
    if ($null -eq $tags) { $tags = $Item.TagList }
    if ($null -eq $tags) { return "" }

    return (@($tags) | Where-Object { $_.Key -eq "Name" } | Select-Object -First 1).Value
}

# Query resources across all specified regions
foreach ($r in $regionsToCheck) {
    Write-Host "----------------------------------------------------" -ForegroundColor Gray
    Write-Host "Querying resources in region: $r" -ForegroundColor Cyan
    Write-Host "----------------------------------------------------" -ForegroundColor Gray

    # Check connectivity/access first by describing VPCs in this region
    $vpcs = Get-AwsResource "aws ec2 describe-vpcs --region $r --output json" "VPCs in $r"
    if ($null -eq $vpcs) {
        Write-Host "Region $r is not accessible or returned no VPC config (see the error above). Skipping." -ForegroundColor Yellow
        continue
    }

    if ($vpcs.Vpcs) {
        foreach ($v in $vpcs.Vpcs) {
            $v | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allVpcs += $v
        }
    }

    $subnets = Get-AwsResource "aws ec2 describe-subnets --region $r --output json" "Subnets in $r"
    if ($subnets -and $subnets.Subnets) {
        foreach ($s in $subnets.Subnets) {
            $s | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allSubnets += $s
        }
    }

    $routeTables = Get-AwsResource "aws ec2 describe-route-tables --region $r --output json" "Route Tables in $r"
    if ($routeTables -and $routeTables.RouteTables) {
        foreach ($rt in $routeTables.RouteTables) {
            $rt | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allRouteTables += $rt
        }
    }

    $igws = Get-AwsResource "aws ec2 describe-internet-gateways --region $r --output json" "Internet Gateways in $r"
    if ($igws -and $igws.InternetGateways) {
        foreach ($igw in $igws.InternetGateways) {
            $igw | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allIgws += $igw
        }
    }

    $nats = Get-AwsResource "aws ec2 describe-nat-gateways --region $r --output json" "NAT Gateways in $r"
    if ($nats -and $nats.NatGateways) {
        foreach ($nat in $nats.NatGateways) {
            $nat | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allNats += $nat
        }
    }

    $eips = Get-AwsResource "aws ec2 describe-addresses --region $r --output json" "Elastic IPs in $r"
    if ($eips -and $eips.Addresses) {
        foreach ($eip in $eips.Addresses) {
            $eip | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allEips += $eip
        }
    }

    $albs = Get-AwsResource "aws elbv2 describe-load-balancers --region $r --output json" "Load Balancers in $r"
    if ($albs -and $albs.LoadBalancers) {
        foreach ($lb in $albs.LoadBalancers) {
            $lb | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allAlbs += $lb
        }
    }

    $tgs = Get-AwsResource "aws elbv2 describe-target-groups --region $r --output json" "Target Groups in $r"
    if ($tgs -and $tgs.TargetGroups) {
        foreach ($tg in $tgs.TargetGroups) {
            $tg | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allTgs += $tg
        }
    }

    $sgs = Get-AwsResource "aws ec2 describe-security-groups --region $r --output json" "Security Groups in $r"
    if ($sgs -and $sgs.SecurityGroups) {
        foreach ($sg in $sgs.SecurityGroups) {
            $sg | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allSgs += $sg
        }
    }

    $enis = Get-AwsResource "aws ec2 describe-network-interfaces --region $r --output json" "Network Interfaces in $r"
    if ($enis -and $enis.NetworkInterfaces) {
        foreach ($eni in $enis.NetworkInterfaces) {
            $eni | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allEnis += $eni
        }
    }

    $instances = Get-AwsResource "aws ec2 describe-instances --region $r --output json" "EC2 Instances in $r"
    if ($instances -and $instances.Reservations) {
        foreach ($res in $instances.Reservations) {
            if ($res.Instances) {
                foreach ($ins in $res.Instances) {
                    $ins | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
                    $allInstances += $ins
                }
            }
        }
    }

    $ecrRepos = Get-AwsResource "aws ecr describe-repositories --region $r --output json" "ECR Repositories in $r"
    if ($ecrRepos -and $ecrRepos.repositories) {
        foreach ($repo in $ecrRepos.repositories) {
            $repo | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allEcrRepos += $repo
        }
    }

    $ecsClusters = Get-AwsResource "aws ecs list-clusters --region $r --output json" "ECS Clusters in $r"
    if ($ecsClusters -and $ecsClusters.clusterArns) {
        foreach ($arn in $ecsClusters.clusterArns) {
            $cDetail = Get-AwsResource "aws ecs describe-clusters --clusters `"$arn`" --region $r --output json" "Cluster Details in $r"
            if ($cDetail -and $cDetail.clusters) {
                foreach ($c in $cDetail.clusters) {
                    $c | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
                    $allEcsClusters += $c
                }
            }
        }
    }

    $rdsDbs = Get-AwsResource "aws rds describe-db-instances --region $r --output json" "RDS Databases in $r"
    if ($rdsDbs -and $rdsDbs.DBInstances) {
        foreach ($db in $rdsDbs.DBInstances) {
            $db | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allRdsDbs += $db
        }
    }

    $secrets = Get-AwsResource "aws secretsmanager list-secrets --region $r --output json" "Secrets in $r"
    if ($secrets -and $secrets.SecretList) {
        foreach ($s in $secrets.SecretList) {
            $s | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allSecrets += $s
        }
    }

    $ssmParams = Get-AwsResource "aws ssm describe-parameters --region $r --output json" "SSM Parameters in $r"
    if ($ssmParams -and $ssmParams.Parameters) {
        foreach ($p in $ssmParams.Parameters) {
            $p | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allSsmParams += $p
        }
    }

    $logGroups = Get-AwsResource "aws logs describe-log-groups --region $r --output json" "Log Groups in $r"
    if ($logGroups -and $logGroups.logGroups) {
        foreach ($lg in $logGroups.logGroups) {
            $lg | Add-Member -MemberType NoteProperty -Name "Region" -Value $r -Force
            $allLogGroups += $lg
        }
    }

    # --- Networking (extended) ---
    $allVpcEndpoints += Get-RegionalItems "aws ec2 describe-vpc-endpoints --region $r --output json" "VPC Endpoints in $r" "VpcEndpoints" $r
    $allPeerings     += Get-RegionalItems "aws ec2 describe-vpc-peering-connections --region $r --output json" "VPC Peering Connections in $r" "VpcPeeringConnections" $r
    # elbv2 above only sees ALB/NLB; classic load balancers live behind a separate API.
    $allClassicElbs  += Get-RegionalItems "aws elb describe-load-balancers --region $r --output json" "Classic Load Balancers in $r" "LoadBalancerDescriptions" $r
    $allCertificates += Get-RegionalItems "aws acm list-certificates --region $r --output json" "ACM Certificates in $r" "CertificateSummaryList" $r

    # --- Monitoring ---
    # Alarms and scaling targets outlive the services that created them and are a
    # common source of orphans. Both were found only via the tagging sweep before.
    $allAlarms += Get-RegionalItems "aws cloudwatch describe-alarms --region $r --output json" "CloudWatch Alarms in $r" "MetricAlarms" $r
    $allScalableTargets += Get-RegionalItems "aws application-autoscaling describe-scalable-targets --service-namespace ecs --region $r --output json" "Application Auto Scaling targets in $r" "ScalableTargets" $r

    # --- Compute & containers (extended) ---
    # Volumes, snapshots and AMIs survive instance termination and keep billing, so
    # they matter far more for cleanup than the instances themselves.
    $allVolumes   += Get-RegionalItems "aws ec2 describe-volumes --region $r --output json" "EBS Volumes in $r" "Volumes" $r
    $allSnapshots += Get-RegionalItems "aws ec2 describe-snapshots --owner-ids self --region $r --output json" "EBS Snapshots in $r" "Snapshots" $r
    $allImages    += Get-RegionalItems "aws ec2 describe-images --owners self --region $r --output json" "AMIs in $r" "Images" $r
    $allKeyPairs  += Get-RegionalItems "aws ec2 describe-key-pairs --region $r --output json" "Key Pairs in $r" "KeyPairs" $r
    $allAsgs      += Get-RegionalItems "aws autoscaling describe-auto-scaling-groups --region $r --output json" "Auto Scaling Groups in $r" "AutoScalingGroups" $r
    $allLambdas   += Get-RegionalItems "aws lambda list-functions --region $r --output json" "Lambda Functions in $r" "Functions" $r
    $allAppRunner += Get-RegionalItems "aws apprunner list-services --region $r --output json" "App Runner Services in $r" "ServiceSummaryList" $r
    $allEksClusters += Get-RegionalItems "aws eks list-clusters --region $r --output json" "EKS Clusters in $r" "clusters" $r
    $allTaskDefs  += Get-RegionalItems "aws ecs list-task-definitions --region $r --output json" "ECS Task Definitions in $r" "taskDefinitionArns" $r

    # ECS services hang off the clusters collected above, so only the clusters found
    # in this region are walked.
    foreach ($cluster in ($allEcsClusters | Where-Object { $_.Region -eq $r })) {
        $svcArns = Get-RegionalItems "aws ecs list-services --cluster `"$($cluster.clusterArn)`" --region $r --output json" "ECS Services in $($cluster.clusterName)" "serviceArns" $r
        foreach ($svc in $svcArns) {
            $svc | Add-Member -MemberType NoteProperty -Name "ClusterName" -Value $cluster.clusterName -Force
            $allEcsServices += $svc
        }
    }

    # --- Storage & databases (extended) ---
    $allRdsClusters  += Get-RegionalItems "aws rds describe-db-clusters --region $r --output json" "RDS Clusters in $r" "DBClusters" $r
    $allRdsSnapshots += Get-RegionalItems "aws rds describe-db-snapshots --snapshot-type manual --region $r --output json" "RDS Manual Snapshots in $r" "DBSnapshots" $r
    $allDynamoTables += Get-RegionalItems "aws dynamodb list-tables --region $r --output json" "DynamoDB Tables in $r" "TableNames" $r
    $allElastiCache  += Get-RegionalItems "aws elasticache describe-cache-clusters --region $r --output json" "ElastiCache Clusters in $r" "CacheClusters" $r
    $allRedshift     += Get-RegionalItems "aws redshift describe-clusters --region $r --output json" "Redshift Clusters in $r" "Clusters" $r
    $allEfs          += Get-RegionalItems "aws efs describe-file-systems --region $r --output json" "EFS File Systems in $r" "FileSystems" $r
    $allOpenSearch   += Get-RegionalItems "aws opensearch list-domain-names --region $r --output json" "OpenSearch Domains in $r" "DomainNames" $r

    # --- Application & integration (extended) ---
    $allRestApis       += Get-RegionalItems "aws apigateway get-rest-apis --region $r --output json" "API Gateway REST APIs in $r" "items" $r
    $allHttpApis       += Get-RegionalItems "aws apigatewayv2 get-apis --region $r --output json" "API Gateway HTTP APIs in $r" "Items" $r
    $allSnsTopics      += Get-RegionalItems "aws sns list-topics --region $r --output json" "SNS Topics in $r" "Topics" $r
    $allSqsQueues      += Get-RegionalItems "aws sqs list-queues --region $r --output json" "SQS Queues in $r" "QueueUrls" $r
    $allEventRules     += Get-RegionalItems "aws events list-rules --region $r --output json" "EventBridge Rules in $r" "Rules" $r
    $allStateMachines  += Get-RegionalItems "aws stepfunctions list-state-machines --region $r --output json" "Step Functions in $r" "stateMachines" $r
    $allKinesisStreams += Get-RegionalItems "aws kinesis list-streams --region $r --output json" "Kinesis Streams in $r" "StreamNames" $r
    $allUserPools      += Get-RegionalItems "aws cognito-idp list-user-pools --max-results 60 --region $r --output json" "Cognito User Pools in $r" "UserPools" $r

    # --- Developer & deployment tooling (extended) ---
    $allStacks    += Get-RegionalItems "aws cloudformation describe-stacks --region $r --output json" "CloudFormation Stacks in $r" "Stacks" $r
    $allCodeBuild += Get-RegionalItems "aws codebuild list-projects --region $r --output json" "CodeBuild Projects in $r" "projects" $r
    $allCodeDeploy += Get-RegionalItems "aws deploy list-applications --region $r --output json" "CodeDeploy Applications in $r" "applications" $r
    $allPipelines += Get-RegionalItems "aws codepipeline list-pipelines --region $r --output json" "CodePipeline Pipelines in $r" "pipelines" $r

    $cloud9Ids = Get-RegionalItems "aws cloud9 list-environments --region $r --output json" "Cloud9 Environments in $r" "environmentIds" $r
    if ($cloud9Ids.Count -gt 0) {
        $idArgs = ($cloud9Ids | ForEach-Object { $_.Value }) -join " "
        $allCloud9 += Get-RegionalItems "aws cloud9 describe-environments --environment-ids $idArgs --region $r --output json" "Cloud9 Environment Details in $r" "environments" $r
    }

    # --- Catch-all sweep ---
    # Returns every taggable resource in the region regardless of type, so resource
    # types not described explicitly above still surface somewhere in the report.
    $allTaggedResources += Get-RegionalItems "aws resourcegroupstaggingapi get-resources --region $r --output json" "Tagged Resource Sweep in $r" "ResourceTagMappingList" $r
}

# Global services (once) - these are account-wide, not region-scoped, and were the
# largest blind spot in earlier versions of this report.
Write-Host "----------------------------------------------------" -ForegroundColor Gray
Write-Host "Querying global (account-wide) resources" -ForegroundColor Cyan
Write-Host "----------------------------------------------------" -ForegroundColor Gray

$roles            = Get-AwsResource "aws iam list-roles --output json" "IAM Roles"
$iamUsers         = Get-RegionalItems "aws iam list-users --output json" "IAM Users" "Users" "global"
$iamGroups        = Get-RegionalItems "aws iam list-groups --output json" "IAM Groups" "Groups" "global"
$iamPolicies      = Get-RegionalItems "aws iam list-policies --scope Local --output json" "IAM Customer-Managed Policies" "Policies" "global"
$iamProfiles      = Get-RegionalItems "aws iam list-instance-profiles --output json" "IAM Instance Profiles" "InstanceProfiles" "global"
$cloudfrontDists  = Get-RegionalItems "aws cloudfront list-distributions --output json" "CloudFront Distributions" "DistributionList.Items" "global"
$route53Zones     = Get-RegionalItems "aws route53 list-hosted-zones --output json" "Route 53 Hosted Zones" "HostedZones" "global"
$s3Buckets        = Get-RegionalItems "aws s3api list-buckets --output json" "S3 Buckets" "Buckets" "global"

# S3 bucket names are global but each bucket lives in one region, which only
# get-bucket-location reveals. Costs one extra call per bucket.
foreach ($bucket in $s3Buckets) {
    $loc = Get-AwsResource "aws s3api get-bucket-location --bucket `"$($bucket.Name)`" --output json" "Location of bucket $($bucket.Name)"
    $bucketRegion = if ($loc -and $loc.LocationConstraint) { $loc.LocationConstraint } else { "us-east-1" }
    $bucket | Add-Member -MemberType NoteProperty -Name "Region" -Value $bucketRegion -Force
}

# Build markdown report
$report = @"
# AWS Infrastructure & Configuration Report (All Regions)

**Generated:** $(Get-Date -Format "yyyy-MM-dd HH:mm:ss K")
**Account ID:** $accountId
**Caller Identity:** $callerId
**Regions Checked:** $($regionsToCheck -join ', ')

---

## 1. Networking Infrastructure

"@

# VPCs
if ($allVpcs.Count -gt 0) {
    $report += "### VPCs`n"
    $report += "| Region | VPC ID | CIDR Block | State | Is Default | Name Tag |`n"
    $report += "| --- | --- | --- | --- | --- | --- |`n"
    foreach ($v in $allVpcs) {
        $nameTag = ($v.Tags | Where-Object { $_.Key -eq "Name" }) | Select-Object -ExpandProperty Value
        $report += "| $($v.Region) | $($v.VpcId) | $($v.CidrBlock) | $($v.State) | $($v.IsDefault) | $nameTag |`n"
    }
    $report += "`n"
} else {
    $report += "### VPCs`n*No VPCs found across checked regions.*`n`n"
}

# Subnets
if ($allSubnets.Count -gt 0) {
    $report += "### Subnets`n"
    $report += "| Region | Subnet ID | VPC ID | CIDR Block | Availability Zone | Name Tag |`n"
    $report += "| --- | --- | --- | --- | --- | --- |`n"
    foreach ($s in $allSubnets) {
        $nameTag = ($s.Tags | Where-Object { $_.Key -eq "Name" }) | Select-Object -ExpandProperty Value
        $report += "| $($s.Region) | $($s.SubnetId) | $($s.VpcId) | $($s.CidrBlock) | $($s.AvailabilityZone) | $nameTag |`n"
    }
    $report += "`n"
} else {
    $report += "### Subnets`n*No subnets found across checked regions.*`n`n"
}

# Route Tables
if ($allRouteTables.Count -gt 0) {
    $report += "### Route Tables`n"
    $report += "| Region | Route Table ID | VPC ID | Associations (Subnets) | Destination -> Target |`n"
    $report += "| --- | --- | --- | --- | --- |`n"
    foreach ($rt in $allRouteTables) {
        $assocSubnets = @()
        foreach ($assoc in $rt.Associations) {
            if ($assoc.SubnetId) { $assocSubnets += $assoc.SubnetId }
        }
        $assocStr = if ($assocSubnets.Count -gt 0) { $assocSubnets -join ", " } else { "Main/Explicitly None" }
        $routesStr = @()
        foreach ($r in $rt.Routes) {
            $target = $r.GatewayId
            if (-not $target) { $target = $r.NatGatewayId }
            if (-not $target) { $target = $r.NetworkInterfaceId }
            $routesStr += "$($r.DestinationCidrBlock) -> $target"
        }
        $report += "| $($rt.Region) | $($rt.RouteTableId) | $($rt.VpcId) | $assocStr | $($routesStr -join '; ') |`n"
    }
    $report += "`n"
} else {
    $report += "### Route Tables`n*No route tables found.*`n`n"
}

# Internet Gateways
if ($allIgws.Count -gt 0) {
    $report += "### Internet Gateways`n"
    $report += "| Region | IGW ID | Attached VPC ID | Attachment State |`n"
    $report += "| --- | --- | --- | --- |`n"
    foreach ($igw in $allIgws) {
        $vpcAttached = if ($igw.Attachments.Count -gt 0) { $igw.Attachments[0].VpcId } else { "Unattached" }
        $state = if ($igw.Attachments.Count -gt 0) { $igw.Attachments[0].State } else { "N/A" }
        $report += "| $($igw.Region) | $($igw.InternetGatewayId) | $vpcAttached | $state |`n"
    }
    $report += "`n"
} else {
    $report += "### Internet Gateways`n*No Internet Gateways found.*`n`n"
}

# NAT Gateways
if ($allNats.Count -gt 0) {
    $report += "### NAT Gateways`n"
    $report += "| Region | NAT Gateway ID | VPC ID | Subnet ID | State | Public IP |`n"
    $report += "| --- | --- | --- | --- | --- | --- |`n"
    foreach ($nat in $allNats) {
        $pubIp = if ($nat.NatGatewayAddresses.Count -gt 0) { $nat.NatGatewayAddresses[0].PublicIp } else { "None" }
        $report += "| $($nat.Region) | $($nat.NatGatewayId) | $($nat.VpcId) | $($nat.SubnetId) | $($nat.State) | $pubIp |`n"
    }
    $report += "`n"
} else {
    $report += "### NAT Gateways`n*No NAT Gateways found.*`n`n"
}

# Elastic IPs
if ($allEips.Count -gt 0) {
    $report += "### Elastic IPs`n"
    $report += "| Region | Public IP | Allocation ID | Association ID | Instance ID |`n"
    $report += "| --- | --- | --- | --- | --- |`n"
    foreach ($eip in $allEips) {
        $report += "| $($eip.Region) | $($eip.PublicIp) | $($eip.AllocationId) | $($eip.AssociationId) | $($eip.InstanceId) |`n"
    }
    $report += "`n"
} else {
    $report += "### Elastic IPs`n*No Elastic IPs allocated.*`n`n"
}

# Load Balancers
if ($allAlbs.Count -gt 0) {
    $report += "### Load Balancers (ALB/NLB)`n"
    $report += "| Region | Name | Type | Scheme | Status | DNS Name |`n"
    $report += "| --- | --- | --- | --- | --- | --- |`n"
    foreach ($lb in $allAlbs) {
        $report += "| $($lb.Region) | $($lb.LoadBalancerName) | $($lb.Type) | $($lb.Scheme) | $($lb.State.Code) | $($lb.DNSName) |`n"
    }
    $report += "`n"
} else {
    $report += "### Load Balancers`n*No Load Balancers found.*`n`n"
}

# Target Groups
if ($allTgs.Count -gt 0) {
    $report += "### Target Groups`n"
    $report += "| Region | Target Group Name | Protocol | Port | Type | VPC ID |`n"
    $report += "| --- | --- | --- | --- | --- | --- |`n"
    foreach ($tg in $allTgs) {
        $report += "| $($tg.Region) | $($tg.TargetGroupName) | $($tg.Protocol) | $($tg.Port) | $($tg.TargetType) | $($tg.VpcId) |`n"
    }
    $report += "`n"
} else {
    $report += "### Target Groups`n*No Target Groups found.*`n`n"
}

# Security Groups
if ($allSgs.Count -gt 0) {
    $report += "### Security Groups`n"
    $report += "| Region | SG ID | SG Name | VPC ID | Description | Inbound Rules |`n"
    $report += "| --- | --- | --- | --- | --- | --- |`n"
    foreach ($sg in $allSgs) {
        $rules = @()
        foreach ($ip in $sg.IpPermissions) {
            $proto = $ip.IpProtocol
            if ($proto -eq "-1") { $proto = "All" }
            $from = $ip.FromPort
            $to = $ip.ToPort
            $ports = if ($from -eq $to) { "$from" } else { "$from-$to" }
            if ($proto -eq "All") { $ports = "All" }
            
            $sources = @()
            foreach ($r in $ip.IpRanges) { $sources += $r.CidrIp }
            foreach ($g in $ip.UserIdGroupPairs) { $sources += $g.GroupId }
            
            $rules += "$proto($ports) from [$($sources -join ', ')]"
        }
        $report += "| $($sg.Region) | $($sg.GroupId) | $($sg.GroupName) | $($sg.VpcId) | $($sg.Description) | $($rules -join '; ') |`n"
    }
    $report += "`n"
} else {
    $report += "### Security Groups`n*No Security Groups found.*`n`n"
}

# ENIs
if ($allEnis.Count -gt 0) {
    $report += "### Network Interfaces (ENIs)`n"
    $report += "| Region | ENI ID | VPC ID | Subnet ID | Private IP | Status | Description |`n"
    $report += "| --- | --- | --- | --- | --- | --- | --- |`n"
    foreach ($eni in $allEnis) {
        $report += "| $($eni.Region) | $($eni.NetworkInterfaceId) | $($eni.VpcId) | $($eni.SubnetId) | $($eni.PrivateIpAddress) | $($eni.Status) | $($eni.Description) |`n"
    }
    $report += "`n"
}

$report += Format-ReportTable "VPC Endpoints" $allVpcEndpoints ([ordered]@{
    "Region"       = "Region"
    "Endpoint ID"  = "VpcEndpointId"
    "VPC ID"       = "VpcId"
    "Service"      = "ServiceName"
    "Type"         = "VpcEndpointType"
    "State"        = "State"
})

$report += Format-ReportTable "VPC Peering Connections" $allPeerings ([ordered]@{
    "Region"        = "Region"
    "Peering ID"    = "VpcPeeringConnectionId"
    "Requester VPC" = { $_.RequesterVpcInfo.VpcId }
    "Accepter VPC"  = { $_.AccepterVpcInfo.VpcId }
    "Status"        = { $_.Status.Code }
})

$report += Format-ReportTable "Classic Load Balancers" $allClassicElbs ([ordered]@{
    "Region"    = "Region"
    "Name"      = "LoadBalancerName"
    "DNS Name"  = "DNSName"
    "VPC ID"    = "VPCId"
    "Instances" = { @($_.Instances).Count }
})

$report += Format-ReportTable "ACM Certificates" $allCertificates ([ordered]@{
    "Region"      = "Region"
    "Domain"      = "DomainName"
    "Status"      = "Status"
    "Type"        = "Type"
    "In Use"      = "InUse"
    "Certificate" = "CertificateArn"
})

$report += @"
## 2. Compute & Containers (EC2 / ECS / ECR / Lambda)

"@

# EC2 Instances
if ($allInstances.Count -gt 0) {
    $report += "### EC2 Instances`n"
    $report += "| Region | Instance ID | Instance Type | State | Private IP | Public IP | Name Tag |`n"
    $report += "| --- | --- | --- | --- | --- | --- | --- |`n"
    foreach ($ins in $allInstances) {
        $nameTag = ($ins.Tags | Where-Object { $_.Key -eq "Name" }) | Select-Object -ExpandProperty Value
        $report += "| $($ins.Region) | $($ins.InstanceId) | $($ins.InstanceType) | $($ins.State.Name) | $($ins.PrivateIpAddress) | $($ins.PublicIpAddress) | $nameTag |`n"
    }
    $report += "`n"
} else {
    $report += "### EC2 Instances`n*No EC2 Instances found.*`n`n"
}

# ECR Repositories
if ($allEcrRepos.Count -gt 0) {
    $report += "### Amazon ECR Repositories`n"
    $report += "| Region | Repository Name | Registry ID | URI |`n"
    $report += "| --- | --- | --- | --- |`n"
    foreach ($repo in $allEcrRepos) {
        $report += "| $($repo.Region) | $($repo.repositoryName) | $($repo.registryId) | $($repo.repositoryUri) |`n"
    }
    $report += "`n"
} else {
    $report += "### Amazon ECR Repositories`n*No ECR Repositories found.*`n`n"
}

# ECS Clusters
if ($allEcsClusters.Count -gt 0) {
    $report += "### ECS Clusters`n"
    $report += "| Region | Cluster Name | Status | Running Tasks | Services |`n"
    $report += "| --- | --- | --- | --- | --- |`n"
    foreach ($c in $allEcsClusters) {
        $report += "| $($c.Region) | $($c.clusterName) | $($c.status) | $($c.runningTasksCount) | $($c.activeServicesCount) |`n"
    }
    $report += "`n"
} else {
    $report += "### ECS Clusters`n*No ECS Clusters found.*`n`n"
}

$report += Format-ReportTable "ECS Services" $allEcsServices ([ordered]@{
    "Region"      = "Region"
    "Cluster"     = "ClusterName"
    "Service ARN" = "Value"
})

$report += Format-ReportTable "ECS Task Definitions" $allTaskDefs ([ordered]@{
    "Region"              = "Region"
    "Task Definition ARN" = "Value"
})

$report += Format-ReportTable "Lambda Functions" $allLambdas ([ordered]@{
    "Region"        = "Region"
    "Function Name" = "FunctionName"
    "Runtime"       = "Runtime"
    "Memory (MB)"   = "MemorySize"
    "Last Modified" = "LastModified"
})

$report += Format-ReportTable "App Runner Services" $allAppRunner ([ordered]@{
    "Region"       = "Region"
    "Service Name" = "ServiceName"
    "Status"       = "Status"
    "Service URL"  = "ServiceUrl"
})

$report += Format-ReportTable "EKS Clusters" $allEksClusters ([ordered]@{
    "Region"       = "Region"
    "Cluster Name" = "Value"
})

$report += Format-ReportTable "Auto Scaling Groups" $allAsgs ([ordered]@{
    "Region"    = "Region"
    "Name"      = "AutoScalingGroupName"
    "Desired"   = "DesiredCapacity"
    "Min/Max"   = { "$($_.MinSize)/$($_.MaxSize)" }
    "Instances" = { @($_.Instances).Count }
})

# EBS volumes, snapshots and AMIs outlive the instances that created them and keep
# billing silently, so they are called out separately rather than folded into EC2.
$report += Format-ReportTable "EBS Volumes" $allVolumes ([ordered]@{
    "Region"      = "Region"
    "Volume ID"   = "VolumeId"
    "Size (GiB)"  = "Size"
    "Type"        = "VolumeType"
    "State"       = "State"
    "Attached To" = { (@($_.Attachments) | ForEach-Object { $_.InstanceId }) -join ", " }
    "Name Tag"    = { Get-NameTag $_ }
})

$report += Format-ReportTable "EBS Snapshots (owned)" $allSnapshots ([ordered]@{
    "Region"      = "Region"
    "Snapshot ID" = "SnapshotId"
    "Volume ID"   = "VolumeId"
    "Size (GiB)"  = "VolumeSize"
    "Started"     = "StartTime"
    "Description" = "Description"
})

$report += Format-ReportTable "AMIs (owned)" $allImages ([ordered]@{
    "Region"   = "Region"
    "Image ID" = "ImageId"
    "Name"     = "Name"
    "State"    = "State"
    "Created"  = "CreationDate"
})

$report += Format-ReportTable "EC2 Key Pairs" $allKeyPairs ([ordered]@{
    "Region"      = "Region"
    "Key Name"    = "KeyName"
    "Key Pair ID" = "KeyPairId"
    "Type"        = "KeyType"
})

$report += @"
## 3. Storage & Databases

"@

# RDS Databases
if ($allRdsDbs.Count -gt 0) {
    $report += "### RDS Database Instances`n"
    $report += "| Region | DB Identifier | Engine | Class | Status | Endpoint | Database Name |`n"
    $report += "| --- | --- | --- | --- | --- | --- | --- |`n"
    foreach ($db in $allRdsDbs) {
        $report += "| $($db.Region) | $($db.DBInstanceIdentifier) | $($db.Engine)($($db.EngineVersion)) | $($db.DBInstanceClass) | $($db.DBInstanceStatus) | $($db.Endpoint.Address):$($db.Endpoint.Port) | $($db.DBName) |`n"
    }
    $report += "`n"
} else {
    $report += "### RDS Databases`n*No RDS Database Instances found.*`n`n"
}

$report += Format-ReportTable "RDS Clusters" $allRdsClusters ([ordered]@{
    "Region"        = "Region"
    "Cluster ID"    = "DBClusterIdentifier"
    "Engine"        = { "$($_.Engine)($($_.EngineVersion))" }
    "Status"        = "Status"
    "Endpoint"      = "Endpoint"
})

$report += Format-ReportTable "RDS Manual Snapshots" $allRdsSnapshots ([ordered]@{
    "Region"      = "Region"
    "Snapshot ID" = "DBSnapshotIdentifier"
    "Instance"    = "DBInstanceIdentifier"
    "Engine"      = "Engine"
    "Size (GiB)"  = "AllocatedStorage"
    "Created"     = "SnapshotCreateTime"
})

$report += Format-ReportTable "DynamoDB Tables" $allDynamoTables ([ordered]@{
    "Region"     = "Region"
    "Table Name" = "Value"
})

$report += Format-ReportTable "ElastiCache Clusters" $allElastiCache ([ordered]@{
    "Region"     = "Region"
    "Cluster ID" = "CacheClusterId"
    "Engine"     = { "$($_.Engine)($($_.EngineVersion))" }
    "Node Type"  = "CacheNodeType"
    "Status"     = "CacheClusterStatus"
})

$report += Format-ReportTable "Redshift Clusters" $allRedshift ([ordered]@{
    "Region"     = "Region"
    "Cluster ID" = "ClusterIdentifier"
    "Node Type"  = "NodeType"
    "Nodes"      = "NumberOfNodes"
    "Status"     = "ClusterStatus"
})

$report += Format-ReportTable "EFS File Systems" $allEfs ([ordered]@{
    "Region"         = "Region"
    "File System ID" = "FileSystemId"
    "Name"           = "Name"
    "Size (Bytes)"   = { $_.SizeInBytes.Value }
    "State"          = "LifeCycleState"
})

$report += Format-ReportTable "OpenSearch Domains" $allOpenSearch ([ordered]@{
    "Region"      = "Region"
    "Domain Name" = "DomainName"
    "Engine Type" = "EngineType"
})

# S3 is a global namespace, but each bucket is pinned to one region - resolved above
# with get-bucket-location so buckets can be matched against the regions scanned.
$report += Format-ReportTable "S3 Buckets" $s3Buckets ([ordered]@{
    "Region"      = "Region"
    "Bucket Name" = "Name"
    "Created"     = "CreationDate"
}) "*No S3 Buckets found. Note: buckets are account-wide, so this covers every region.*"

$report += @"
## 4. Application & Integration Services

"@

$report += Format-ReportTable "API Gateway REST APIs" $allRestApis ([ordered]@{
    "Region"  = "Region"
    "API ID"  = "id"
    "Name"    = "name"
    "Created" = "createdDate"
})

$report += Format-ReportTable "API Gateway HTTP APIs" $allHttpApis ([ordered]@{
    "Region"   = "Region"
    "API ID"   = "ApiId"
    "Name"     = "Name"
    "Protocol" = "ProtocolType"
    "Endpoint" = "ApiEndpoint"
})

$report += Format-ReportTable "SNS Topics" $allSnsTopics ([ordered]@{
    "Region"    = "Region"
    "Topic ARN" = "TopicArn"
})

$report += Format-ReportTable "SQS Queues" $allSqsQueues ([ordered]@{
    "Region"    = "Region"
    "Queue URL" = "Value"
})

$report += Format-ReportTable "EventBridge Rules" $allEventRules ([ordered]@{
    "Region"   = "Region"
    "Name"     = "Name"
    "State"    = "State"
    "Schedule" = "ScheduleExpression"
})

$report += Format-ReportTable "Step Functions State Machines" $allStateMachines ([ordered]@{
    "Region"  = "Region"
    "Name"    = "name"
    "Type"    = "type"
    "Created" = "creationDate"
})

$report += Format-ReportTable "Kinesis Streams" $allKinesisStreams ([ordered]@{
    "Region"      = "Region"
    "Stream Name" = "Value"
})

$report += Format-ReportTable "Cognito User Pools" $allUserPools ([ordered]@{
    "Region"  = "Region"
    "Pool ID" = "Id"
    "Name"    = "Name"
})

$report += @"
## 5. Developer & Deployment Tooling

"@

$report += Format-ReportTable "CloudFormation Stacks" $allStacks ([ordered]@{
    "Region"     = "Region"
    "Stack Name" = "StackName"
    "Status"     = "StackStatus"
    "Created"    = "CreationTime"
})

$report += Format-ReportTable "CodeBuild Projects" $allCodeBuild ([ordered]@{
    "Region"       = "Region"
    "Project Name" = "Value"
})

$report += Format-ReportTable "CodeDeploy Applications" $allCodeDeploy ([ordered]@{
    "Region"           = "Region"
    "Application Name" = "Value"
})

$report += Format-ReportTable "CodePipeline Pipelines" $allPipelines ([ordered]@{
    "Region"  = "Region"
    "Name"    = "name"
    "Created" = "created"
})

$report += Format-ReportTable "Cloud9 Environments" $allCloud9 ([ordered]@{
    "Region" = "Region"
    "ID"     = "id"
    "Name"   = "name"
    "Type"   = "type"
})

$report += @"
## 6. Global Services (CloudFront / Route 53 / IAM)

"@

$report += Format-ReportTable "CloudFront Distributions" $cloudfrontDists ([ordered]@{
    "Distribution ID" = "Id"
    "Domain Name"     = "DomainName"
    "Enabled"         = "Enabled"
    "Status"          = "Status"
    "Comment"         = "Comment"
    "Origins"         = { (@($_.Origins.Items) | ForEach-Object { $_.DomainName }) -join ", " }
})

$report += Format-ReportTable "Route 53 Hosted Zones" $route53Zones ([ordered]@{
    "Zone ID"      = "Id"
    "Name"         = "Name"
    "Private"      = { $_.Config.PrivateZone }
    "Record Count" = "ResourceRecordSetCount"
})

# IAM Roles (Global) - every role in the account, unfiltered
if ($roles -and $roles.Roles.Count -gt 0) {
    $report += "### IAM Roles`n"
    $report += "*All $($roles.Roles.Count) roles in the account (global, not region-scoped).*`n`n"
    $report += "| Role Name | Create Date | Path | Arn |`n"
    $report += "| --- | --- | --- | --- |`n"
    foreach ($role in $roles.Roles) {
        $report += "| $($role.RoleName) | $($role.CreateDate) | $($role.Path) | $($role.Arn) |`n"
    }
    $report += "`n"
} else {
    $report += "### IAM Roles`n*No IAM Roles found.*`n`n"
}

$report += Format-ReportTable "IAM Users" $iamUsers ([ordered]@{
    "User Name" = "UserName"
    "Path"      = "Path"
    "Created"   = "CreateDate"
    "Arn"       = "Arn"
})

$report += Format-ReportTable "IAM Groups" $iamGroups ([ordered]@{
    "Group Name" = "GroupName"
    "Path"       = "Path"
    "Created"    = "CreateDate"
})

$report += Format-ReportTable "IAM Customer-Managed Policies" $iamPolicies ([ordered]@{
    "Policy Name" = "PolicyName"
    "Attachments" = "AttachmentCount"
    "Created"     = "CreateDate"
    "Arn"         = "Arn"
})

$report += Format-ReportTable "IAM Instance Profiles" $iamProfiles ([ordered]@{
    "Profile Name" = "InstanceProfileName"
    "Roles"        = { (@($_.Roles) | ForEach-Object { $_.RoleName }) -join ", " }
    "Created"      = "CreateDate"
})

$report += @"
## 7. Secrets, Systems Manager & Logging

"@

# Secrets
if ($allSecrets.Count -gt 0) {
    $report += "### Secrets Manager Secrets`n"
    $report += "| Region | Name | Description | Last Changed |`n"
    $report += "| --- | --- | --- | --- |`n"
    foreach ($s in $allSecrets) {
        $report += "| $($s.Region) | $($s.Name) | $($s.Description) | $($s.LastChangedDate) |`n"
    }
    $report += "`n"
} else {
    $report += "### Secrets Manager Secrets`n*No Secrets Manager Secrets found.*`n`n"
}

# SSM Parameters
if ($allSsmParams.Count -gt 0) {
    $report += "### SSM Parameters`n"
    $report += "| Region | Name | Type | Last Modified | Description |`n"
    $report += "| --- | --- | --- | --- | --- |`n"
    foreach ($p in $allSsmParams) {
        $report += "| $($p.Region) | $($p.Name) | $($p.Type) | $($p.LastModifiedDate) | $($p.Description) |`n"
    }
    $report += "`n"
} else {
    $report += "### SSM Parameters`n*No SSM Parameters found.*`n`n"
}

# CloudWatch Log Groups
if ($allLogGroups.Count -gt 0) {
    $report += "### CloudWatch Log Groups`n"
    $report += "| Region | Log Group Name | Retention (Days) | Stored Size (Bytes) |`n"
    $report += "| --- | --- | --- | --- |`n"
    foreach ($lg in $allLogGroups) {
        $ret = if ($lg.retentionInDays) { $lg.retentionInDays } else { "Never" }
        $report += "| $($lg.Region) | $($lg.logGroupName) | $ret | $($lg.storedBytes) |`n"
    }
    $report += "`n"
}

$report += Format-ReportTable "CloudWatch Alarms" $allAlarms ([ordered]@{
    "Region" = "Region"
    "Name"   = "AlarmName"
    "State"  = "StateValue"
    "Metric" = { "$($_.Namespace)/$($_.MetricName)" }
    "Actions Enabled" = "ActionsEnabled"
})

$report += Format-ReportTable "Application Auto Scaling Targets (ECS)" $allScalableTargets ([ordered]@{
    "Region"      = "Region"
    "Resource ID" = "ResourceId"
    "Dimension"   = "ScalableDimension"
    "Min/Max"     = { "$($_.MinCapacity)/$($_.MaxCapacity)" }
})

# Catch-all sweep. Anything here that has no home in the sections above is a resource
# type this script does not describe explicitly - that is the signal to add one.
$report += @"
## 8. Tagged Resource Sweep (catch-all)

"@

if ($allTaggedResources.Count -gt 0) {
    $sweepByService = $allTaggedResources | Group-Object {
        # ARN shape: arn:aws:<service>:<region>:<account>:<resource>
        $parts = ([string]$_.ResourceARN).Split(':')
        if ($parts.Count -gt 2) { $parts[2] } else { "unknown" }
    } | Sort-Object Name

    $report += "*$($allTaggedResources.Count) taggable resource(s) found across the scanned regions, grouped by service. "
    $report += "A service listed here with no matching section above is a resource type this report does not yet describe in detail.*`n`n"
    $report += "| Service | Count |`n"
    $report += "| --- | --- |`n"
    foreach ($group in $sweepByService) {
        $report += "| $($group.Name) | $($group.Count) |`n"
    }
    $report += "`n"

    $report += Format-ReportTable "All Tagged Resources" $allTaggedResources ([ordered]@{
        "Region" = "Region"
        "ARN"    = "ResourceARN"
        "Tags"   = { (@($_.Tags) | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "; " }
    })
} else {
    $report += "*No taggable resources returned by the Resource Groups Tagging API.*`n`n"
}

# Failed AWS calls - so an empty section can be told apart from a denied permission
$report += @"
## 9. Failed AWS Calls

"@

if ($apiErrors.Count -gt 0) {
    $report += "*$($apiErrors.Count) AWS CLI call(s) failed. Sections above may be incomplete - a missing resource here can mean a missing IAM permission, not an empty account.*`n`n"
    $report += "| Query | Command | Error |`n"
    $report += "| --- | --- | --- |`n"
    foreach ($e in $apiErrors) {
        $detail = ($e.Detail -replace '\r?\n', ' ' -replace '\|', '\|')
        $report += "| $($e.Query) | ``$($e.Command)`` | $detail |`n"
    }
    $report += "`n"
} else {
    $report += "*All AWS CLI calls succeeded.*`n`n"
}

if ($unavailableEndpoints.Count -gt 0) {
    $report += "### Services not available in a region`n`n"
    $report += "*$($unavailableEndpoints.Count) call(s) were skipped because the service has no endpoint in that region. "
    $report += "These are not failures and leave no gap in the report - the resource type cannot exist there.*`n`n"
    $report += "| Query | Command |`n"
    $report += "| --- | --- |`n"
    foreach ($u in $unavailableEndpoints) {
        $report += "| $($u.Query) | ``$($u.Command)`` |`n"
    }
    $report += "`n"
}

# Write report to file
$report | Out-File -FilePath $reportPath -Encoding utf8

Write-Host ""
if ($apiErrors.Count -gt 0) {
    Write-Host "$($apiErrors.Count) AWS CLI call(s) failed - see section 9 of the report for details." -ForegroundColor Yellow
} else {
    Write-Host "All AWS CLI calls succeeded." -ForegroundColor Green
}
if ($unavailableEndpoints.Count -gt 0) {
    Write-Host "$($unavailableEndpoints.Count) call(s) skipped - service not offered in that region." -ForegroundColor Gray
}
Write-Host "Report successfully generated and saved to: $reportPath" -ForegroundColor Green
Write-Host "Done!" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan
