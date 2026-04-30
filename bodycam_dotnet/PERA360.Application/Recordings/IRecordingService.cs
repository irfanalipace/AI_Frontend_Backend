namespace PERA360.Application.Recordings;

public interface IRecordingService
{
    Task<RecordingListResult> ListAsync(string? officerId, string? severity, int page, int pageSize, CancellationToken ct = default);
    Task<RecordingDetailResult?> DetailAsync(long id, CancellationToken ct = default);
    Task<RecordingStatsResult> StatsAsync(CancellationToken ct = default);
}

public class RecordingListResult
{
    public int Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
    public List<RecordingListItem> Items { get; set; } = new();
}

public class RecordingListItem
{
    public long Id { get; set; }
    public string OfficerId { get; set; } = string.Empty;
    public string Filename { get; set; } = string.Empty;
    public string MediaType { get; set; } = string.Empty;
    public double DurationSeconds { get; set; }
    public DateTime UploadedAt { get; set; }
    public int Score { get; set; }
    public string Severity { get; set; } = "NORMAL";
    public string ToneLabel { get; set; } = "NORMAL";
    public int ViolationCount { get; set; }
}

public class RecordingDetailResult
{
    public long Id { get; set; }
    public string OfficerId { get; set; } = string.Empty;
    public string? OfficerName { get; set; }
    public string Filename { get; set; } = string.Empty;
    public string MediaType { get; set; } = string.Empty;
    public double DurationSeconds { get; set; }
    public DateTime UploadedAt { get; set; }
    public string? StationId { get; set; }
    public object? AnalysisResult { get; set; }
    public List<object> Violations { get; set; } = new();
}

public class RecordingStatsResult
{
    public int TotalRecordings { get; set; }
    public int Critical { get; set; }
    public int Warning { get; set; }
    public int Normal { get; set; }
    public int Last30Days { get; set; }
    public List<TopOfficerCritical> TopOfficersByCritical { get; set; } = new();
}

public class TopOfficerCritical
{
    public string OfficerId { get; set; } = string.Empty;
    public int Recordings { get; set; }
    public int CriticalCount { get; set; }
}
