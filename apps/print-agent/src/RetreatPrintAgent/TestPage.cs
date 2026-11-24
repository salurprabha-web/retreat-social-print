using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using RetreatPrintAgent.Core;

namespace RetreatPrintAgent;

/// <summary>A calibration page for checking a printer: border, corner marks and a diagonal at the exact paper size, 300 DPI.</summary>
public static class TestPage
{
    public static (string Path, int W, int H) Create(string dir, string printerName, string paperKey, bool landscape)
    {
        var (pw, ph) = PaperMatcher.Dimensions(paperKey) ?? (400, 600);
        int w = pw * 3, h = ph * 3;                                   // hundredths of an inch x 3 = pixels at 300 DPI
        if (landscape) (w, h) = (Math.Max(w, h), Math.Min(w, h)); else (w, h) = (Math.Min(w, h), Math.Max(w, h));
        using var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        bmp.SetResolution(300, 300);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.White);
            int m = (int)(Math.Min(w, h) * 0.03);
            using var pen = new Pen(Color.Black, Math.Max(4, w / 150));
            g.DrawRectangle(pen, m, m, w - 2 * m, h - 2 * m);
            using var thin = new Pen(Color.DimGray, 2) { DashStyle = DashStyle.Dash };
            g.DrawLine(thin, 0, 0, w, h); g.DrawLine(thin, w, 0, 0, h);
            int c = Math.Min(w, h) / 10;                              // corner crosses: all four visible = nothing cropped
            foreach (var (x, y) in new[] { (0, 0), (w, 0), (0, h), (w, h) })
            {
                g.DrawLine(pen, x == 0 ? 0 : x - c, y, x == 0 ? c : x, y); g.DrawLine(pen, x, y == 0 ? 0 : y - c, x, y == 0 ? c : y);
            }
            using var f1 = new Font("Segoe UI", Math.Max(14, w / 28), FontStyle.Bold, GraphicsUnit.Pixel);
            using var f2 = new Font("Segoe UI", Math.Max(11, w / 40), FontStyle.Regular, GraphicsUnit.Pixel);
            var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            var box = new RectangleF(m * 2, h * 0.30f, w - m * 4, h * 0.40f);
            g.DrawString($"RETREAT SOCIAL PRINT\nPRINTER TEST\n\n{printerName}\n{paperKey} {(landscape ? "landscape" : "portrait")}  |  {w}x{h} px @ 300 DPI\n{DateTime.Now:yyyy-MM-dd HH:mm}\n\nAll four corner marks and an even border = good alignment.", f2, Brushes.Black, box, fmt);
            g.DrawString("TEST PAGE", f1, Brushes.Black, new RectangleF(0, h * 0.12f, w, h * 0.12f), fmt);
        }
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"testpage-{Guid.NewGuid():N}.jpg");
        var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), e => e.MimeType == "image/jpeg")!;
        using var ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 95L);
        bmp.Save(path, enc, ep);
        return (path, w, h);
    }
}
