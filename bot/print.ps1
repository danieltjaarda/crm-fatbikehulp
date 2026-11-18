# Print een afbeelding (het uitgesneden label) op de labelprinter, passend op het label
# dat in de printer is ingesteld (Zebra ZD220: 100 x 150 mm). Wordt door bot.js aangeroepen.
param(
  [Parameter(Mandatory = $true)][string]$Bestand,
  [Parameter(Mandatory = $true)][string]$Printer,
  [double]$RandMm = 2
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer '$Printer' is niet gevonden op deze pc" }
$doc.DocumentName = 'DHL-label ' + [IO.Path]::GetFileNameWithoutExtension($Bestand)
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController  # geen venster "bezig met afdrukken"
$doc.DefaultPageSettings.Landscape = $false
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$doc.OriginAtMargins = $false

$script:beeld = [System.Drawing.Image]::FromFile($Bestand)
$script:rand = $RandMm / 25.4 * 100   # in honderdsten van een inch, de eenheid van de printer
$doc.add_PrintPage({
  param($afzender, $e)
  # Het bedrukbare vlak van het label, met een kleine rand; het label erin passend zonder te vervormen.
  $vlak = $e.PageSettings.PrintableArea
  $b = $vlak.Width - 2 * $script:rand; $h = $vlak.Height - 2 * $script:rand
  $schaal = [Math]::Min($b / $script:beeld.Width, $h / $script:beeld.Height)
  $bb = $script:beeld.Width * $schaal; $hh = $script:beeld.Height * $schaal
  $x = $script:rand + ($b - $bb) / 2; $y = $script:rand
  $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  # PrintableArea begint bij de harde marge van de printer; tekenen gebeurt vanaf de paginarand.
  $e.Graphics.DrawImage($script:beeld, [single]($x + $vlak.X - $e.PageSettings.HardMarginX), [single]($y + $vlak.Y - $e.PageSettings.HardMarginY), [single]$bb, [single]$hh)
  $e.HasMorePages = $false
})
try { $doc.Print() } finally { $script:beeld.Dispose(); $doc.Dispose() }
"geprint op $Printer"
