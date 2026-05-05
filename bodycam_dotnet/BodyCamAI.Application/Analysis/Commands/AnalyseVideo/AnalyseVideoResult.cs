using System.Text.Json;

namespace BodyCamAI.Application.Analysis.Commands.AnalyseVideo;

/// <summary>
/// Outcome of the AnalyseVideo use case. The controller serialises the
/// Python pipeline's full JSON response back to the caller (with a few
/// .NET-added fields like recording_id and processing_time_sec mixed in)
/// so the React Upload page renders every panel without translation.
/// </summary>
public class AnalyseVideoResult
{
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }

    // ── Identity (.NET-added) ───────────────────────────────────────
    public long   RecordingId  { get; set; }
    public string IncidentId   { get; set; } = string.Empty;
    public string OfficerId    { get; set; } = string.Empty;
    public string OfficerName  { get; set; } = string.Empty;
    public string OfficerBadge { get; set; } = string.Empty;
    public string? OfficerArea { get; set; }
    public string Filename     { get; set; } = string.Empty;
    public string MediaType    { get; set; } = "video";
    public DateTime UploadedAt { get; set; }

    // ── Top-line scoring (parsed from the Python JSON for legacy
    //    consumers + dashboard queries) ────────────────────────────
    public int    TotalScore  { get; set; }
    public string Severity    { get; set; } = "NORMAL";
    public string ToneLabel   { get; set; } = "NORMAL";
    public int    ViolationCount { get; set; }

    /// <summary>
    /// Wall-clock seconds spent inside the analyse use case, surfaced
    /// to the frontend as `processing_time_sec`.
    /// </summary>
    public double ProcessingTimeSec { get; set; }

    /// <summary>
    /// Raw JSON the Python pipeline returned, persisted verbatim and
    /// echoed back to the caller.
    /// </summary>
    public string RawJson { get; set; } = string.Empty;

    /// <summary>
    /// Parsed view of the same JSON. The controller uses this to build
    /// the final response — the rich Python shape plus .NET-added
    /// recording_id / processing_time_sec.
    /// </summary>
    public JsonElement? Document { get; set; }
}
