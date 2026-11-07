// Repairs UTF-8 files that PowerShell re-encoded through cp1252 (mojibake).
// Only files whose every non-ASCII character went through that path are safe.
$root = "C:\Users\Orin\Desktop\New folder\escrow-link"
$files = @(
  "script\Deploy.s.sol",
  "test\EscrowLink.t.sol",
  "test\EscrowLink.invariant.t.sol",
  "test\mocks\MockUSDC.sol",
  "test\mocks\FeeOnTransferUSDC.sol"
)
$cp = [System.Text.Encoding]::GetEncoding(1252)
foreach ($rel in $files) {
  $f = Join-Path $root $rel
  $bytes = [System.IO.File]::ReadAllBytes($f)
  $moji = [System.Text.Encoding]::UTF8.GetString($bytes)
  $origBytes = $cp.GetBytes($moji)
  $fixed = [System.Text.Encoding]::UTF8.GetString($origBytes)
  [System.IO.File]::WriteAllBytes($f, [System.Text.Encoding]::UTF8.GetBytes($fixed))
  $bad = ([regex]::Matches($fixed, [char]0x00E2)).Count
  Write-Output "$rel repaired (remaining mojibake markers: $bad)"
}
