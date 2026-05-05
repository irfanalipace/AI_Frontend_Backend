using BodyCamAI.Application.Common.Models;

namespace BodyCamAI.Application.Common.Interfaces;

/// <summary>
/// Abstraction over the Gemini (default: 2.5 Flash-Lite) multimodal analysis call.
/// Application code hands over a media file (video or audio) and receives
/// a strongly-typed analysis DTO plus the raw JSON; the concrete HTTP client
/// lives in Infrastructure.
/// </summary>
public interface IGeminiAnalysisService
{
    /// <summary>
    /// Sends the media file directly to Gemini (default: 2.5 Flash-Lite) (which natively
    /// understands video + audio in one shot) with a structured-output prompt
    /// and returns the parsed analysis plus the raw JSON for forensic storage.
    /// </summary>
    /// <param name="mediaFilePath">Absolute path to the media file (mp4, mov, mkv, webm, wav, mp3, ...).</param>
    /// <param name="originalFilename">Original filename — used to detect the MIME type.</param>
    /// <param name="officerId">Officer the recording belongs to (for prompt context).</param>
    Task<GeminiAnalysisResult?> AnalyseMediaAsync(
        string mediaFilePath,
        string originalFilename,
        string officerId,
        CancellationToken ct = default);
}

/// <summary>
/// Container for what the Gemini service returns to the use case:
/// the parsed DTO, the raw JSON we persist verbatim, and the model id
/// that produced the result (used as transcription_method on the API
/// response).
/// </summary>
public class GeminiAnalysisResult
{
    public GeminiAnalysisDto Analysis { get; set; } = new();
    public string RawJson { get; set; } = string.Empty;
    public string ModelName { get; set; } = "gemini";
}
