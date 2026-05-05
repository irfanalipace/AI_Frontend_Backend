namespace BodyCamAI.Domain.Entities;

/// <summary>
/// One uploaded bodycam recording. One Recording → one AnalysisResult (1:1).
/// </summary>
public class Recording
{
    public long Id { get; set; }

    public string OfficerId { get; set; } = string.Empty;
    public Officer? Officer { get; set; }

    public string Filename { get; set; } = string.Empty;

    /// <summary>"audio" or "video"</summary>
    public string MediaType { get; set; } = "audio";

    public double DurationSeconds { get; set; }
    public long SizeBytes { get; set; }

    public string? StationId { get; set; }

    public DateTime UploadedAt { get; set; } = DateTime.UtcNow;
    public DateTime ProcessedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Where the original media file is stored (S3 key or local path).
    /// Optional — temp files are deleted after analysis.
    /// </summary>
    public string? StoragePath { get; set; }

    public AnalysisResult? AnalysisResult { get; set; }
    public List<Violation> Violations { get; set; } = new();
}
