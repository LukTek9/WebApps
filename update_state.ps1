$projectName = "WEBAPP_TOOLS_SUITE" # À renommer quand tu auras choisi le nom définitif
$root = $PSScriptRoot               # Utilise automatiquement le dossier où se trouve le script (ou remplace par ton chemin)
$out = "$root\Project_State.txt"

# Extensions à inventorier pour la WebApp (vues, styles et scripts)
$treeExtensions = @("*.html", "*.css", "*.tsx", "*.jsx", "*.json")
$codeExtensions = @("*.js", "*.ts", "*.mjs")

# Détection des signatures JS/TS (fonctions, classes, constantes, exports)
$signaturePattern = "^(export\s+)?(async\s+)?(function|class|const|let|interface|type)\s+[a-zA-Z0-9_]+"

# Dossiers à ignorer pour éviter de scanner des milliers de fichiers inutiles
$excludeDirs = @("node_modules", ".git", "dist", "build", ".vscode")

$existingVersion = 0
$oldBody = ""

if (Test-Path $out) {
    $rawOld = [System.IO.File]::ReadAllText($out, [System.Text.Encoding]::UTF8)
    if ($rawOld -match "(?m)^Version:\s*(\d+)\s*$") {
        $existingVersion = [int]$Matches[1]
    }
    $markerIndex = $rawOld.IndexOf("--- FILES / VIEWS ---")
    if ($markerIndex -ge 0) {
        $oldBody = $rawOld.Substring($markerIndex).Replace("`r`n", "`n").Trim()
    }
}

function Should-Include($file) {
    foreach ($dir in $excludeDirs) {
        if ($file.FullName -match "[\\/]$dir[\\/]") {
            return $false
        }
    }
    return $true
}

$bodyBuilder = [System.Text.StringBuilder]::new()
[void]$bodyBuilder.AppendLine("--- FILES / VIEWS ---")
Get-ChildItem -Path $root -Recurse -File -Include $treeExtensions | Where-Object { Should-Include $_ } | Sort-Object FullName | ForEach-Object {
    $relPath = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
    [void]$bodyBuilder.AppendLine($relPath)
}

[void]$bodyBuilder.AppendLine("")
[void]$bodyBuilder.AppendLine("--- SCRIPTS & SIGNATURES ---")
Get-ChildItem -Path $root -Recurse -File -Include $codeExtensions | Where-Object { Should-Include $_ } | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
    [void]$bodyBuilder.AppendLine("")
    [void]$bodyBuilder.AppendLine("[$rel]")
    Select-String -Path $_.FullName -Pattern $signaturePattern | ForEach-Object {
        [void]$bodyBuilder.AppendLine("  " + $_.Line.Trim())
    }
}

$newBodyRaw = $bodyBuilder.ToString()
$newBodyNormalized = $newBodyRaw.Replace("`r`n", "`n").Trim()

if ($existingVersion -eq 0 -or $newBodyNormalized -ne $oldBody) {
    $version = $existingVersion + 1
    $finalBuilder = [System.Text.StringBuilder]::new()
    [void]$finalBuilder.AppendLine("=== PROJECT ARCHITECTURE: $projectName (AUTO-GENERATED) ===")
    [void]$finalBuilder.AppendLine("Version: $version")
    [void]$finalBuilder.AppendLine("Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
    [void]$finalBuilder.AppendLine("")
    [void]$finalBuilder.Append($newBodyRaw)

    [System.IO.File]::WriteAllText($out, $finalBuilder.ToString(), [System.Text.Encoding]::UTF8)
    Write-Host "State mis a jour -> Version $version : $out" -ForegroundColor Green
} else {
    Write-Host "Aucune modification detectee -> Version $existingVersion conservee." -ForegroundColor Yellow
}
