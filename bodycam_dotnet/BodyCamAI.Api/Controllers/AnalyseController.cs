using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using BodyCamAI.Application.Analysis.Commands.AnalyseVideo;
using BodyCamAI.Application.Common.Interfaces;

namespace BodyCamAI.Api.Controllers;

/// <summary>
/// Analysis pipeline:
///   POST /api/analyse  (multipart)  field "video" = file, "officerId" = string
/// → temp-file spool
/// → ffmpeg strips the audio track into a tiny 16 kHz mono MP3 (videos
///   are NEVER forwarded — only the extracted audio is)
/// → audio is forwarded to the Python ML pipeline at
///   :5050/api/analyze/upload (voiceprint, diarization, SVM tone,
///   Whisper transcript, Gemini assessment, emotion analysis)
/// → result is persisted to MSSQL (Recording + AnalysisResult + Violations)
/// → caller receives the rich Python JSON unchanged (with recording_id and
///   processing_time_sec mixed in) so the React Upload page renders every
///   panel — Greeting, Diarization, Tone, Speech Detected, Officer Behavior
///   Assessment, Visual Analysis, Violations, Acoustics, Emotions —
///   without any frontend changes.
/// </summary>
[ApiController]
[Route("api/analyse")]
public class AnalyseController : ControllerBase
{
    private readonly AnalyseVideoHandler _handler;
    private readonly IGeminiAnalysisService _gemini;
    private readonly IPythonAnalysisProxyService _python;
    private readonly IAudioExtractor _audio;
    private readonly ILogger<AnalyseController> _log;

    public AnalyseController(
        AnalyseVideoHandler handler,
        IGeminiAnalysisService gemini,
        IPythonAnalysisProxyService python,
        IAudioExtractor audio,
        ILogger<AnalyseController> log)
    {
        _handler = handler;
        _gemini = gemini;
        _python = python;
        _audio = audio;
        _log = log;
    }

    [HttpPost]
    [RequestSizeLimit(2L * 1024 * 1024 * 1024)]   // 2 GB
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> Analyse(
        IFormFile video,
        [FromForm(Name = "officerId")] string? officerId,
        [FromForm(Name = "stationId")] string? stationId,
        CancellationToken ct)
    {
        if (video is null || video.Length == 0)
            return BadRequest(new { error = "video file is required" });

        if (string.IsNullOrWhiteSpace(officerId))
            return BadRequest(new { error = "officerId is required" });

        var inputTempPath = Path.Combine(Path.GetTempPath(),
            $"pera_video_{Guid.NewGuid():N}{Path.GetExtension(video.FileName)}");

        try
        {
            await using (var fs = System.IO.File.Create(inputTempPath))
                await video.CopyToAsync(fs, ct);

            var cmd = new AnalyseVideoCommand
            {
                OfficerId         = officerId,
                OriginalFilename  = video.FileName,
                OriginalSizeBytes = video.Length,
                VideoTempPath     = inputTempPath,
                StationId         = stationId,
            };

            var result = await _handler.HandleAsync(cmd, ct);
            if (!result.Success)
            {
                _log.LogWarning("AnalyseVideo failed: {Err}", result.ErrorMessage);
                var msg = result.ErrorMessage ?? "Analysis failed";
                var isUpstream = msg.Contains("Python", StringComparison.OrdinalIgnoreCase)
                              || msg.Contains("Gemini", StringComparison.OrdinalIgnoreCase)
                              || msg.Contains("ffmpeg", StringComparison.OrdinalIgnoreCase);
                return isUpstream
                    ? StatusCode(StatusCodes.Status502BadGateway, new { error = msg })
                    : BadRequest(new { error = msg });
            }

            return Content(BuildResponseJson(result), "application/json");
        }
        finally
        {
            TryDelete(inputTempPath);
        }
    }

    /// <summary>
    /// .NET-only direct-to-Gemini analysis. Bypasses the Python ML pipeline entirely
    /// — the Gemini API key is hit exactly once, from this server.
    ///
    ///   POST /api/analyse/gemini  (multipart)  field "video" = file, "officerId" = string
    /// → temp-file spool
    /// → ffmpeg strips the audio track into a tiny 16 kHz mono MP3 (videos are
    ///   NEVER forwarded — only the extracted audio leaves this server)
    /// → audio is sent inline to Gemini (default model: 2.5 Flash-Lite) with the
    ///   structured-output schema defined in GeminiAnalysisService
    /// → Gemini's parsed JSON is returned to the caller verbatim, with a few
    ///   .NET-supplied identity / timing fields mixed in. NO database writes,
    ///   NO Python call — useful for A/B comparing the .NET-only path against
    ///   the full Python pipeline at /api/analyse.
    /// </summary>
    [HttpPost("gemini")]
    [RequestSizeLimit(2L * 1024 * 1024 * 1024)]   // 2 GB upload cap (ffmpeg shrinks before Gemini)
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> AnalyseWithGemini(
        IFormFile video,
        [FromForm(Name = "officerId")] string? officerId,
        CancellationToken ct)
    {
        if (video is null || video.Length == 0)
            return BadRequest(new { error = "video file is required" });

        if (string.IsNullOrWhiteSpace(officerId))
            return BadRequest(new { error = "officerId is required" });

        var inputTempPath = Path.Combine(Path.GetTempPath(),
            $"pera_gemini_{Guid.NewGuid():N}{Path.GetExtension(video.FileName)}");

        string? extractedAudioPath = null;
        try
        {
            await using (var fs = System.IO.File.Create(inputTempPath))
                await video.CopyToAsync(fs, ct);

            // Step 1 — strip audio with ffmpeg. Keeps the upload under Gemini's
            // 20 MB inline limit and matches the contract that videos never
            // leave this server in raw form.
            var extracted = await _audio.ExtractAsync(inputTempPath, ct);
            if (!extracted.Success)
            {
                _log.LogWarning("Gemini-direct: audio extraction failed: {Err}", extracted.ErrorMessage);
                return StatusCode(StatusCodes.Status502BadGateway,
                    new { error = $"Audio extraction failed: {extracted.ErrorMessage}" });
            }

            extractedAudioPath = extracted.OutputPath;

            // Step 2 — single Gemini call from .NET. The Python pipeline is not invoked.
            var sw = Stopwatch.StartNew();
            var result = await _gemini.AnalyseMediaAsync(
                extractedAudioPath,
                Path.GetFileName(extractedAudioPath),  // .mp3 — drives MIME detection
                officerId,
                ct);
            sw.Stop();

            if (result is null)
            {
                _log.LogWarning("Gemini-direct: service returned null for officer {Officer}", officerId);
                return StatusCode(StatusCodes.Status502BadGateway, new
                {
                    error = "Gemini returned no result. Check the configured API key, quota, " +
                            "or the server logs for upload / parse errors."
                });
            }

            _log.LogInformation(
                "Gemini-direct OK officer={Officer} model={Model} severity={Sev} score={Score} elapsed={Sec:F2}s",
                officerId, result.ModelName, result.Analysis.Severity, result.Analysis.TotalScore, sw.Elapsed.TotalSeconds);

            // Step 3 — wrap Gemini's raw JSON in a thin envelope so the response
            // shape is comparable to /api/analyse (officer_id, filename, timing).
            JsonNode root = string.IsNullOrEmpty(result.RawJson)
                ? new JsonObject()
                : (JsonNode.Parse(result.RawJson) ?? new JsonObject());

            JsonObject obj = root is JsonObject jo
                ? jo
                : new JsonObject { ["data"] = root };

            obj["officer_id"]           = officerId;
            obj["filename"]             = video.FileName;
            obj["model"]                = result.ModelName;
            obj["transcription_method"] = result.ModelName;
            obj["analysis_source"]      = "dotnet_gemini_direct";
            obj["processing_time_sec"]  = Math.Round(sw.Elapsed.TotalSeconds, 2);
            obj["timestamp"]            = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss");

            return Content(obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false }),
                "application/json");
        }
        finally
        {
            TryDelete(inputTempPath);
            if (!string.IsNullOrEmpty(extractedAudioPath))
                TryDelete(extractedAudioPath);
        }
    }

    /// <summary>
    /// Python librosa-only analysis — every Gemini call is skipped on the
    /// Python side. The natural counterpart to /api/analyse/gemini: pair them
    /// when you want the .NET backend to handle Gemini directly while Python
    /// runs only the local audio analytics (VAD, SVM tone, diarization,
    /// Whisper / Google Speech transcription, keyword/acoustics/greeting).
    ///
    ///   POST /api/analyse/no-gemini  (multipart)  field "video" = file, "officerId" = string
    /// → temp-file spool
    /// → ffmpeg strips the audio track into a tiny 16 kHz mono MP3
    /// → audio is forwarded to Python at :5050/api/analyze/upload_no_gemini
    /// → Python's JSON is returned to the caller verbatim. NO database writes,
    ///   NO Gemini calls anywhere in the stack.
    /// </summary>
    [HttpPost("no-gemini")]
    [RequestSizeLimit(2L * 1024 * 1024 * 1024)]   // 2 GB
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> AnalyseWithoutGemini(
        IFormFile video,
        [FromForm(Name = "officerId")] string? officerId,
        CancellationToken ct)
    {
        if (video is null || video.Length == 0)
            return BadRequest(new { error = "video file is required" });

        if (string.IsNullOrWhiteSpace(officerId))
            return BadRequest(new { error = "officerId is required" });

        var inputTempPath = Path.Combine(Path.GetTempPath(),
            $"pera_no_gemini_{Guid.NewGuid():N}{Path.GetExtension(video.FileName)}");

        string? extractedAudioPath = null;
        try
        {
            await using (var fs = System.IO.File.Create(inputTempPath))
                await video.CopyToAsync(fs, ct);

            // Step 1 — same audio-extraction contract as the other endpoints:
            // Python only ever sees a small mono MP3, never the source video.
            var extracted = await _audio.ExtractAsync(inputTempPath, ct);
            if (!extracted.Success)
            {
                _log.LogWarning("No-Gemini: audio extraction failed: {Err}", extracted.ErrorMessage);
                return StatusCode(StatusCodes.Status502BadGateway,
                    new { error = $"Audio extraction failed: {extracted.ErrorMessage}" });
            }

            extractedAudioPath = extracted.OutputPath;

            // Step 2 — forward to Python's no-Gemini route. Single round trip,
            // no LLM calls anywhere in this stack.
            var sw = Stopwatch.StartNew();
            var result = await _python.AnalyseAudioNoGeminiAsync(extractedAudioPath, officerId, ct);
            sw.Stop();

            if (!result.Success || result.Document is null)
            {
                _log.LogWarning("No-Gemini: Python proxy failed: {Err}", result.ErrorMessage);
                return StatusCode(StatusCodes.Status502BadGateway,
                    new { error = result.ErrorMessage ?? "Python pipeline returned no result" });
            }

            // Step 3 — wrap Python's JSON in a thin envelope so the response
            // shape is comparable to the other /api/analyse/* endpoints.
            JsonNode root = string.IsNullOrEmpty(result.RawJson)
                ? new JsonObject()
                : (JsonNode.Parse(result.RawJson) ?? new JsonObject());

            JsonObject obj = root is JsonObject jo
                ? jo
                : new JsonObject { ["data"] = root };

            obj["officer_id"]          = officerId;
            obj["filename"]            = video.FileName;
            obj["analysis_source"]     = "dotnet_python_no_gemini";
            obj["processing_time_sec"] = Math.Round(sw.Elapsed.TotalSeconds, 2);
            if (!obj.ContainsKey("timestamp"))
                obj["timestamp"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss");

            return Content(obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false }),
                "application/json");
        }
        finally
        {
            TryDelete(inputTempPath);
            if (!string.IsNullOrEmpty(extractedAudioPath))
                TryDelete(extractedAudioPath);
        }
    }

    /// <summary>Quick health check for the frontend.</summary>
    [HttpGet("health")]
    public IActionResult Health() => Ok(new { ok = true, service = "BodyCamAI.Api/Analyse", time = DateTime.UtcNow });

    /// <summary>
    /// Take the rich Python JSON, merge in .NET-supplied identity / timing
    /// fields (recording_id, incident_id, officer_name, processing_time_sec),
    /// and serialise it back to a string. We use JsonNode rather than a
    /// typed DTO because the Python response is intentionally rich-and-
    /// open-ended — the React frontend reads dozens of nested fields and
    /// any C# DTO mirror would be a maintenance trap.
    /// </summary>
    private static string BuildResponseJson(AnalyseVideoResult r)
    {
        // Start from the Python JSON if we have it; otherwise an empty object.
        JsonNode root = string.IsNullOrEmpty(r.RawJson)
            ? new JsonObject()
            : (JsonNode.Parse(r.RawJson) ?? new JsonObject());

        // Defensive: only merge into a JsonObject. If Python returned an
        // array or a primitive, wrap it under a "data" key so we still get
        // a usable response.
        JsonObject obj = root is JsonObject jo
            ? jo
            : new JsonObject { ["data"] = root };

        // .NET-supplied fields — these overwrite anything Python sent.
        obj["recording_id"]        = r.RecordingId;
        obj["incident_id"]         = string.IsNullOrEmpty(r.IncidentId)
                                        ? r.RecordingId.ToString("X8") : r.IncidentId;
        obj["officer_id"]          = r.OfficerId;
        obj["officer_name"]        = string.IsNullOrEmpty(r.OfficerName) ? r.OfficerId : r.OfficerName;
        obj["officer_badge"]       = string.IsNullOrEmpty(r.OfficerBadge) ? r.OfficerId : r.OfficerBadge;
        obj["officer_area"]        = r.OfficerArea ?? string.Empty;
        obj["filename"]            = r.Filename;
        obj["media_type"]          = r.MediaType;
        obj["uploaded_at"]         = r.UploadedAt.ToString("yyyy-MM-ddTHH:mm:ss");
        obj["processing_time_sec"] = r.ProcessingTimeSec;

        // Backfill timestamp if Python didn't provide one — the frontend reads it.
        if (!obj.ContainsKey("timestamp"))
            obj["timestamp"] = r.UploadedAt.ToString("yyyy-MM-ddTHH:mm:ss");

        return obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
    }

    private static void TryDelete(string path)
    {
        try { if (System.IO.File.Exists(path)) System.IO.File.Delete(path); } catch { /* swallow */ }
    }
}
