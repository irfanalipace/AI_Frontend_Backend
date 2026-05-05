namespace BodyCamAI.Application.CriticalIncidents;

public interface ICriticalIncidentService
{
    Task<CriticalListResult> ListAsync(string? mediaType, DateTime? since, DateTime? until, string? officerId, int page, int pageSize, CancellationToken ct = default);
    Task<List<CriticalTrendPoint>> TrendAsync(int days, CancellationToken ct = default);
    Task<List<CriticalByOfficer>> ByOfficerAsync(int limit, CancellationToken ct = default);
}

public class CriticalListResult
{
    public int Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
    public List<CriticalIncidentItem> Items { get; set; } = new();
}

public class CriticalIncidentItem
{
    public long RecordingId { get; set; }
    public string OfficerId { get; set; } = string.Empty;
    public string OfficerName { get; set; } = string.Empty;
    public string Filename { get; set; } = string.Empty;
    public string MediaType { get; set; } = string.Empty;
    public DateTime UploadedAt { get; set; }
    public double DurationSec { get; set; }
    public string? StationId { get; set; }
    public int Score { get; set; }
    public string Severity { get; set; } = string.Empty;
    public string ToneLabel { get; set; } = string.Empty;
    public string? DominantEmotion { get; set; }
    public int CriticalCount { get; set; }
    public int HighCount { get; set; }
    public int MediumCount { get; set; }
    public int Violations { get; set; }
    public string? AiAssessment { get; set; }
}

public class CriticalTrendPoint
{
    public string Date { get; set; } = string.Empty;
    public int Count { get; set; }
    public double AvgScore { get; set; }
}

public class CriticalByOfficer
{
    public string OfficerId { get; set; } = string.Empty;
    public int CriticalCount { get; set; }
    public double AvgScore { get; set; }
    public DateTime LastIncident { get; set; }
}
