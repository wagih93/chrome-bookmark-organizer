[CmdletBinding()]
param()

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$iconDirectory = Join-Path $projectRoot "icons"
New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null

function New-RoundedRectanglePath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

foreach ($size in @(16, 32, 48, 128)) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $tilePath = New-RoundedRectanglePath `
            ($size * 0.05) `
            ($size * 0.05) `
            ($size * 0.90) `
            ($size * 0.90) `
            ($size * 0.22)
        $tileBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.PointF]::new($size * 0.12, $size * 0.05),
            [System.Drawing.PointF]::new($size * 0.88, $size * 0.95),
            [System.Drawing.Color]::FromArgb(255, 99, 102, 241),
            [System.Drawing.Color]::FromArgb(255, 49, 46, 129)
        )
        $graphics.FillPath($tileBrush, $tilePath)

        $bookmarkPoints = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new($size * 0.27, $size * 0.22),
            [System.Drawing.PointF]::new($size * 0.65, $size * 0.22),
            [System.Drawing.PointF]::new($size * 0.68, $size * 0.78),
            [System.Drawing.PointF]::new($size * 0.53, $size * 0.69),
            [System.Drawing.PointF]::new($size * 0.38, $size * 0.79),
            [System.Drawing.PointF]::new($size * 0.27, $size * 0.79)
        )
        $graphics.FillPolygon([System.Drawing.Brushes]::White, $bookmarkPoints)

        $lineBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 79, 70, 229))
        $graphics.FillRectangle($lineBrush, $size * 0.35, $size * 0.34, $size * 0.23, [Math]::Max(1, $size * 0.055))
        $graphics.FillRectangle($lineBrush, $size * 0.35, $size * 0.47, $size * 0.17, [Math]::Max(1, $size * 0.055))

        $statusBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 167, 243, 208))
        $statusRectangle = [System.Drawing.RectangleF]::new($size * 0.58, $size * 0.56, $size * 0.31, $size * 0.31)
        $graphics.FillEllipse($statusBrush, $statusRectangle)

        $checkPen = [System.Drawing.Pen]::new(
            [System.Drawing.Color]::FromArgb(255, 6, 95, 70),
            [Math]::Max(1.2, $size * 0.045)
        )
        $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawLines($checkPen, [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new($size * 0.64, $size * 0.72),
            [System.Drawing.PointF]::new($size * 0.70, $size * 0.78),
            [System.Drawing.PointF]::new($size * 0.83, $size * 0.64)
        ))

        $outputPath = Join-Path $iconDirectory "icon-$size.png"
        $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host "Generated $outputPath"
    } finally {
        $graphics.Dispose()
        $tilePath.Dispose()
        $tileBrush.Dispose()
        $lineBrush.Dispose()
        $statusBrush.Dispose()
        $checkPen.Dispose()
        $bitmap.Dispose()
    }
}
