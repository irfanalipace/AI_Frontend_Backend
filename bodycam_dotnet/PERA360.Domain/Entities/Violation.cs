namespace PERA360.Domain.Entities;

/// <summary>
/// One detected violation row. Multiple per Recording.
/// </summary>
public class Violation
{
    public long Id { get; set; }

    public long RecordingId { get; set; }
    public Recording? Recording { get; set; }

    /// <summary>Type code, e.g. "RISHWAT", "GALI", "PROLONGED_SHOUTING"</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>"CRITICAL", "HIGH", "MEDIUM", "LOW"</summary>
    public string Severity { get; set; } = "LOW";

    public string SeverityLabel { get; set; } = string.Empty;     // "CRITICAL 1", "HIGH 2"
    public int SeverityIndex { get; set; }

    public string Label { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Detail { get; set; }

    public int Score { get; set; }
    public double ImpactPercent { get; set; }

    /// <summary>Comma-separated keywords. JSON would be cleaner but text is portable.</summary>
    public string? KeywordsFound { get; set; }

    /// <summary>"keyword_detection" / "tone_analysis" / "greeting_detection" / etc.</summary>
    public string? Source { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
