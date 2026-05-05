using System.Text.Json;

namespace BodyCamAI.Application.Common.Interfaces;

/// <summary>
/// Forwards an extracted audio file to the Python ML pipeline's
/// POST /api/analyze/upload endpoint and returns the raw JSON response.
/// The .NET handler treats the response as opaque-but-rich: it saves the
/// raw JSON to the database and passes it straight back to the caller so
/// the React Upload page can render every panel without any field-by-field
/// translation in C#.
/// </summary>
public interface IPythonAnalysisProxyService
{
    /// <summary>
    /// Calls the full Python pipeline (POST /api/analyze/upload) — runs the
    /// librosa/SVM/diarization/keyword stack AND every Gemini call (transcription,
    /// behavior assessment, structured analysis, video analysis when applicable).
    /// </summary>
    Task<PythonAnalysisProxyResult> AnalyseAudioAsync(
        string audioFilePath,
        string officerId,
        CancellationToken ct = default);

    /// <summary>
    /// Calls the no-Gemini variant (POST /api/analyze/upload_no_gemini) — same
    /// shape as <see cref="AnalyseAudioAsync"/> but every Gemini call is skipped.
    /// Returns the librosa/VAD/SVM/Whisper-or-Google/keyword/acoustics/greeting/
    /// diarization output only. ai_assessment is empty, gemini_analysis is {},
    /// and video_analysis (if applicable) is a "skipped" stub.
    /// </summary>
    Task<PythonAnalysisProxyResult> AnalyseAudioNoGeminiAsync(
        string audioFilePath,
        string officerId,
        CancellationToken ct = default);
}

/// <summary>Outcome of the Python proxy call.</summary>
public class PythonAnalysisProxyResult
{
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }

    /// <summary>Raw JSON text Python returned (preserved verbatim for storage + replay).</summary>
    public string RawJson { get; set; } = string.Empty;

    /// <summary>
    /// Parsed view of the same JSON. Use TryGetProperty / GetProperty to read
    /// individual fields when persisting to MSSQL columns.
    /// </summary>
    public JsonElement? Document { get; set; }

    public static PythonAnalysisProxyResult Ok(string rawJson, JsonElement doc) =>
        new() { Success = true, RawJson = rawJson, Document = doc };

    public static PythonAnalysisProxyResult Fail(string message) =>
        new() { Success = false, ErrorMessage = message };
}
