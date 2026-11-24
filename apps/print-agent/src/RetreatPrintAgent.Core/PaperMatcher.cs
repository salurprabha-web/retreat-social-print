namespace RetreatPrintAgent.Core;

/// <param name="WidthHundredths">Width in hundredths of an inch, as Windows reports paper sizes.</param>
public sealed record DriverPaper(string Name, int WidthHundredths, int HeightHundredths)
{
    public string Describe() => $"{Name} ({WidthHundredths / 100.0:0.##}x{HeightHundredths / 100.0:0.##} in)";
}

/// <summary>
/// Picks the driver's paper size that matches what the event says the printer holds. Never "close enough": a photo printed on the wrong
/// paper is wasted media, so no match means the job fails with a clear message instead.
/// </summary>
public static class PaperMatcher
{
    public static (int W, int H)? Dimensions(string key) => key switch
    {
        "4x6" => (400, 600), "5x7" => (500, 700), "6x8" => (600, 800), "2x6" => (200, 600), "A5" => (583, 827), _ => null,
    };

    public static DriverPaper? Match(IEnumerable<DriverPaper> papers, string key)
    {
        var dim = Dimensions(key); if (dim is null) return null;
        var (w, h) = dim.Value; int tolW = Math.Max(3, w / 50), tolH = Math.Max(3, h / 50);        // 2% (the driver rounds)
        DriverPaper? best = null; int bestScore = int.MinValue;
        foreach (var p in papers)
        {
            bool straight = Math.Abs(p.WidthHundredths - w) <= tolW && Math.Abs(p.HeightHundredths - h) <= tolH;
            bool turned = Math.Abs(p.WidthHundredths - h) <= tolH && Math.Abs(p.HeightHundredths - w) <= tolW;
            if (!straight && !turned) continue;
            var n = p.Name.ToLowerInvariant();
            int score = 0;
            if (n.Contains("borderless") || n.Contains("full bleed") || n.Contains("no margin") || n.Contains("edge to edge")) score += 4;   // photo printers: no white border
            if (n.Contains(key.ToLowerInvariant())) score += 1;
            if (straight) score += 2;                                                                                                      // upright size preferred; orientation is set separately
            if (score > bestScore) { best = p; bestScore = score; }
        }
        return best;
    }

    public static string NoMatchMessage(string key, IEnumerable<DriverPaper> papers)
    {
        var list = papers.Select(p => p.Describe()).Take(12).ToList();
        return $"This printer's driver has no {key} paper size. " + (list.Count == 0 ? "The driver reported no paper sizes." : "It offers: " + string.Join("; ", list) + (papers.Count() > list.Count ? "; ..." : "") + ". Add a custom paper size in the printer settings, or choose another paper size for this printer in the event.");
    }
}
