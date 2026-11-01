$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# Original connection mark: two code brackets joined by a bridge.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
  $bitmap = New-Object Drawing.Bitmap($size, $size)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = 'AntiAlias'
  $graphics.ScaleTransform(($size / 128.0), ($size / 128.0))
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc(2, 2, 40, 40, 180, 90)
  $path.AddArc(86, 2, 40, 40, 270, 90)
  $path.AddArc(86, 86, 40, 40, 0, 90)
  $path.AddArc(2, 86, 40, 40, 90, 90)
  $path.CloseFigure()
  $brush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(77, 70, 215))
  $graphics.FillPath($brush, $path)
  $pen = New-Object Drawing.Pen([Drawing.Color]::White, 8)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $graphics.DrawLines($pen, [Drawing.PointF[]]@([Drawing.PointF]::new(44, 40), [Drawing.PointF]::new(24, 64), [Drawing.PointF]::new(44, 88)))
  $graphics.DrawLines($pen, [Drawing.PointF[]]@([Drawing.PointF]::new(84, 40), [Drawing.PointF]::new(104, 64), [Drawing.PointF]::new(84, 88)))
  $graphics.DrawLine($pen, 49, 64, 79, 64)
  $dot = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(156, 236, 222))
  $graphics.FillEllipse($dot, 54, 54, 20, 20)
  $stream = New-Object IO.MemoryStream
  $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
  $images += ,$stream.ToArray()
  if ($size -eq 256) { $bitmap.Save((Join-Path $PSScriptRoot 'logo.png'), [Drawing.Imaging.ImageFormat]::Png) }
  $stream.Dispose(); $dot.Dispose(); $pen.Dispose(); $brush.Dispose(); $path.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
$file = [IO.File]::Create((Join-Path $PSScriptRoot 'app.ico'))
$writer = New-Object IO.BinaryWriter($file)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([uint16]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($image in $images) { $writer.Write([byte[]]$image) }
} finally { $writer.Dispose(); $file.Dispose() }
