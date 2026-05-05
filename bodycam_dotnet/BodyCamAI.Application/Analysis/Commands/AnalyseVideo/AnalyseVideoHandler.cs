using System.Diagnostics;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using BodyCamAI.Application.Common.Interfaces;
using BodyCamAI.Domain.Entities;

namespace BodyCamAI.Application.Analysis.Commands.AnalyseVideo;

/// <summary>
/// Use case: receive a media file (video or audio) on disk →
///   1. ffmpeg strips the audio track into a small 16 kHz mono MP3
///      (videos are NEVER forwarded — only audio leaves this server).
///   2. Forward the audio to the Python ML pipeline at
///      :5050/api/analyze/upload — that's the system that runs
///      voiceprint matching, diarization, SVM tone, Whisper, the
///      Gemini-backed assessment narrative, and emotion analysis.
///   3. Persist Recording + AnalysisResult + Violations to MSSQL
///      using the rich JSON Python returned.
/// The controller serialises the same JSON straight back so the React
/// Upload page renders every panel identically on the Gemini tab.
/// </summary>
public class AnalyseVideoHandler
{
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".mov", ".webm", ".mkv", ".avi", ".3gp", ".flv", ".wmv", ".m4v",
        ".wav", ".mp3", ".m4a", ".ogg", ".flac",
    };

    private readonly IBodycamDbContext _db;
    private readonly IPythonAnalysisProxyService _python;
    private readonly IAudioExtractor _audio;
    private readonly IMemoryCache _cache;
    private readonly ILogger<AnalyseVideoHandler> _log;

    // Officer rows are tiny and rarely change. Caching them removes a DB
    // round-trip per upload for repeat officers — meaningful when the same
    // officer is uploading bodycam clips back-to-back.
    private static readonly TimeSpan OfficerCacheTtl = TimeSpan.FromMinutes(15);

    public AnalyseVideoHandler(
        IBodycamDbContext db,
        IPythonAnalysisProxyService python,
        IAudioExtractor audio,
        IMemoryCache cache,
        ILogger<AnalyseVideoHandler> log)
    {
        _db = db;
        _python = python;
        _audio = audio;
        _cache = cache;
        _log = log;
    }

    public async Task<AnalyseVideoResult> HandleAsync(AnalyseVideoCommand cmd, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();

        if (string.IsNullOrWhiteSpace(cmd.VideoTempPath) || !File.Exists(cmd.VideoTempPath))
            return Fail("Media file is missing or unreadable");

        if (string.IsNullOrWhiteSpace(cmd.OfficerId))
            return Fail("officerId is required");

        var ext = Path.GetExtension(cmd.OriginalFilename);
        if (!AllowedExtensions.Contains(ext))
            return Fail($"File '{cmd.OriginalFilename}' is not a recognised video/audio format");

        // ── Step 1: ensure officer row exists ──
        var officer = await EnsureOfficerExistsAsync(cmd.OfficerId, ct);

        // ── Step 2: extract audio with ffmpeg ──
        _log.LogInformation("Extracting audio from {File} ({Size} bytes) for officer {Officer}",
            cmd.OriginalFilename, cmd.OriginalSizeBytes, cmd.OfficerId);

        var extracted = await _audio.ExtractAsync(cmd.VideoTempPath, ct);
        if (!extracted.Success)
            return Fail($"Audio extraction failed: {extracted.ErrorMessage}");

        var audioPath = extracted.OutputPath;
        try
        {
            // ── Step 3: forward audio to the Python ML pipeline ──
            var python = await _python.AnalyseAudioAsync(audioPath, cmd.OfficerId, ct);
            if (!python.Success || python.Document is null)
                return Fail(python.ErrorMessage ?? "Python pipeline returned no result");

            var doc = python.Document.Value;

            // ── Step 4: persist Recording + AnalysisResult + Violations ──
            var recording = new Recording
            {
                OfficerId   = cmd.OfficerId,
                Filename    = cmd.OriginalFilename,
                MediaType   = IsVideoExtension(ext) ? "video" : "audio",
                SizeBytes   = cmd.OriginalSizeBytes,
                StationId   = cmd.StationId,
                UploadedAt  = DateTime.UtcNow,
                ProcessedAt = DateTime.UtcNow,
            };

            var analysis = MapAnalysisResult(doc, python.RawJson);
            var violations = MapViolations(doc);

            recording.AnalysisResult = analysis;
            recording.Violations = violations;

            _db.Recordings.Add(recording);
            await _db.SaveChangesAsync(ct);

            sw.Stop();

            _log.LogInformation(
                "Stored recording id={Id} score={Score} severity={Sev} violations={N} elapsed={Sec:F2}s",
                recording.Id, analysis.TotalScore, analysis.Severity, violations.Count, sw.Elapsed.TotalSeconds);

            return new AnalyseVideoResult
            {
                Success           = true,
                RecordingId       = recording.Id,
                IncidentId        = recording.Id.ToString("X").PadLeft(8, '0')[^8..],
                OfficerId         = recording.OfficerId,
                OfficerName       = officer.Name,
                OfficerBadge      = officer.Badge,
                OfficerArea       = officer.Area,
                Filename          = recording.Filename,
                MediaType         = recording.MediaType,
                UploadedAt        = recording.UploadedAt,
                TotalScore        = analysis.TotalScore,
                Severity          = analysis.Severity,
                ToneLabel         = analysis.ToneLabel,
                ViolationCount    = violations.Count,
                ProcessingTimeSec = Math.Round(sw.Elapsed.TotalSeconds, 2),
                RawJson           = python.RawJson,
                Document          = doc,
            };
        }
        finally
        {
            // Always clean up the temp audio file we created.
            TryDelete(audioPath);
        }
    }

    /// <summary>
    /// Pulls just the columns we want to persist (for dashboards / queries)
    /// out of the Python response. Everything else is preserved in RawJson.
    /// Defensive: every field is optional — missing or wrong-type fields
    /// fall back to safe defaults rather than throw.
    /// </summary>
    private static AnalysisResult MapAnalysisResult(JsonElement d, string rawJson)
    {
        // GetObject is safe even when its argument is default(JsonElement)
        // (kind = Undefined) — it just returns default again. Calling
        // .TryGetProperty directly on default(JsonElement) throws
        // InvalidOperationException, which is what the previous version did
        // when Python's response omitted, say, the "emotions" property.
        var ac = GetObject(d, "acoustics");
        var gr = GetObject(d, "greeting");
        var di = GetObject(d, "diarization");
        var em = GetObject(d, "emotions");
        var va = GetObject(d, "video_analysis");
        var br = GetObject(em, "breakdown");

        // Transcript can be "urdu | english" pipe-separated in the Python output.
        var transcriptRaw = GetString(d, "transcript");
        string? transcriptUrdu = null;
        string? transcriptEnglish = null;
        if (!string.IsNullOrWhiteSpace(transcriptRaw))
        {
            var parts = transcriptRaw.Split(" | ", 2);
            transcriptUrdu = parts[0].Trim();
            if (parts.Length > 1) transcriptEnglish = parts[1].Trim();
        }

        return new AnalysisResult
        {
            // Scoring
            TotalScore    = GetInt(d, "total_score"),
            ToneScore     = GetInt(d, "tone_score"),
            KwScore       = GetInt(d, "keyword_score"),
            Severity      = NormaliseSeverity(GetString(d, "severity")),
            CriticalCount = GetInt(d, "critical_count"),
            HighCount     = GetInt(d, "high_count"),
            MediumCount   = GetInt(d, "medium_count"),

            // Tone
            ToneLabel         = string.IsNullOrWhiteSpace(GetString(d, "tone_label"))
                                  ? "NORMAL" : GetString(d, "tone_label")!,

            // Transcripts
            TranscriptUrdu      = transcriptUrdu,
            TranscriptEnglish   = transcriptEnglish,
            TranscriptionMethod = GetString(d, "transcription_method"),

            // EO voiceprint
            EoDetected   = GetBool(d, "eo_detected"),
            EoSimilarity = GetDouble(d, "max_similarity"),

            // Acoustics
            AvgPitchHz      = GetNullableDouble(ac, "avg_pitch_hz"),
            BaselinePitchHz = GetNullableDouble(ac, "enrolled_pitch_hz"),
            PitchRatio      = GetNullableDouble(ac, "pitch_ratio"),
            AvgEnergy       = GetNullableDouble(ac, "avg_energy"),
            LoudDurationSec = GetNullableDouble(ac, "loud_duration_sec"),
            Agitation       = GetNullableDouble(ac, "agitation"),

            // Greeting protocol
            GreetingCompliance = GetString(gr, "greeting_compliance"),
            GreetingScore      = GetNullableInt(gr, "greeting_score"),
            SalamFound         = GetNullableBool(gr, "salam_found"),
            NameIntroduced     = GetNullableBool(gr, "name_introduced"),
            StationMentioned   = GetNullableBool(gr, "station_mentioned"),
            RoleMentioned      = GetNullableBool(gr, "role_mentioned"),
            ExtractedName      = GetString(gr, "extracted_name"),
            ExtractedStation   = GetString(gr, "extracted_station"),
            MatchedOfficerId   = GetString(gr, "matched_officer_id"),

            // Diarization
            SpeakerCount          = GetNullableInt(di, "speaker_count"),
            EoTotalSec            = GetNullableDouble(di, "eo_total_sec"),
            CustomerTotalSec      = GetNullableDouble(di, "customer_total_sec"),
            EoSegmentsCount       = GetNullableInt(di, "eo_segments_count"),
            CustomerSegmentsCount = GetNullableInt(di, "customer_segments_count"),

            // Emotions (8 categories) — `br` was resolved safely up top
            DominantEmotion    = GetString(em, "dominant"),
            EmotionAnger       = GetInt(br, "anger"),
            EmotionFrustration = GetInt(br, "frustration"),
            EmotionContempt    = GetInt(br, "contempt"),
            EmotionIntimidation= GetInt(br, "intimidation"),
            EmotionFear        = GetInt(br, "fear"),
            EmotionCalm        = GetInt(br, "calm"),
            EmotionNeutral     = GetInt(br, "neutral"),
            EmotionAgitation   = GetInt(br, "agitation"),
            EmotionNarrative   = GetString(em, "description"),

            // Narrative
            AiAssessment      = GetString(d, "ai_assessment"),
            RecommendedAction = GetString(d, "recommended_action"),

            // Visual analysis (only meaningful for videos)
            VisualRiskScore           = GetNullableInt(va, "risk_score"),
            VisualSummary             = GetString(va, "summary"),
            BriberyVisualDetected     = GetNullableBool(va, "bribery_visual_detected"),
            AggressivePostureDetected = GetNullableBool(va, "aggressive_posture_detected"),
            PhysicalContactDetected   = GetNullableBool(va, "physical_contact_detected"),
            ConcealedGesturesDetected = GetNullableBool(va, "concealed_gestures_detected"),
            VisualAnalysisStatus      = GetString(va, "status"),
            VisualAnalysisStatusMessage = GetString(va, "status_message"),

            RawJson  = rawJson,
            CreatedAt = DateTime.UtcNow,
        };
    }

    private static List<Violation> MapViolations(JsonElement d)
    {
        var list = new List<Violation>();
        if (!d.TryGetProperty("violations", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return list;

        foreach (var v in arr.EnumerateArray())
        {
            var keywords = new List<string>();
            if (v.TryGetProperty("keywords_found", out var kw) && kw.ValueKind == JsonValueKind.Array)
                foreach (var k in kw.EnumerateArray())
                    if (k.ValueKind == JsonValueKind.String) keywords.Add(k.GetString() ?? "");

            list.Add(new Violation
            {
                Type          = string.IsNullOrWhiteSpace(GetString(v, "type")) ? "OTHER" : GetString(v, "type")!,
                Severity      = NormaliseViolationSeverity(GetString(v, "severity")),
                SeverityLabel = GetString(v, "severity_label") ?? GetString(v, "severity") ?? "LOW",
                Label         = GetString(v, "label") ?? string.Empty,
                Description   = GetString(v, "detail") ?? GetString(v, "description"),
                Score         = GetInt(v, "score"),
                KeywordsFound = keywords.Count == 0 ? null : string.Join(",", keywords),
                Source        = GetString(v, "source") ?? "python_pipeline",
                CreatedAt     = DateTime.UtcNow,
            });
        }
        return list;
    }

    // ── Small JSON helpers (defensive — tolerate missing/null/wrong-type) ──

    /// <summary>
    /// Safely fetches a sub-object. Returns default(JsonElement) (kind =
    /// Undefined) if the parent isn't an object, the property is missing,
    /// or the value isn't an object. All Get* helpers in this file are
    /// safe to call on the result.
    /// </summary>
    private static JsonElement GetObject(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return default;
        if (!e.TryGetProperty(prop, out var v)) return default;
        return v.ValueKind == JsonValueKind.Object ? v : default;
    }

    private static string? GetString(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        if (!e.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }
    private static int GetInt(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return 0;
        if (!e.TryGetProperty(prop, out var v)) return 0;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.TryGetInt32(out var i) ? i : (int)v.GetDouble(),
            _ => 0,
        };
    }
    private static int? GetNullableInt(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        if (!e.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.TryGetInt32(out var i) ? i : (int)v.GetDouble(),
            _ => null,
        };
    }
    private static double GetDouble(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return 0;
        if (!e.TryGetProperty(prop, out var v)) return 0;
        return v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
    }
    private static double? GetNullableDouble(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        if (!e.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
    }
    private static bool GetBool(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return false;
        if (!e.TryGetProperty(prop, out var v)) return false;
        return v.ValueKind == JsonValueKind.True;
    }
    private static bool? GetNullableBool(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object) return null;
        if (!e.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.True  => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    private static string NormaliseSeverity(string? sev) =>
        (sev ?? "NORMAL").Trim().ToUpperInvariant() switch
        {
            "CRITICAL" => "CRITICAL",
            "WARNING"  => "WARNING",
            _ => "NORMAL",
        };

    private static string NormaliseViolationSeverity(string? sev) =>
        (sev ?? "LOW").Trim().ToUpperInvariant() switch
        {
            "CRITICAL" => "CRITICAL",
            "HIGH"     => "HIGH",
            "MEDIUM"   => "MEDIUM",
            _ => "LOW",
        };

    private static bool IsVideoExtension(string ext) => ext.ToLowerInvariant() switch
    {
        ".mp4" or ".mov" or ".webm" or ".mkv" or ".avi" or ".3gp" or ".flv" or ".wmv" or ".m4v" => true,
        _ => false,
    };

    private async Task<Officer> EnsureOfficerExistsAsync(string officerId, CancellationToken ct)
    {
        var cacheKey = $"officer:{officerId}";
        if (_cache.TryGetValue<Officer>(cacheKey, out var cached) && cached is not null)
            return cached;

        var existing = await _db.Officers.AsNoTracking()
            .FirstOrDefaultAsync(o => o.Id == officerId, ct);
        if (existing is not null)
        {
            _cache.Set(cacheKey, existing, OfficerCacheTtl);
            return existing;
        }

        var newOfficer = new Officer
        {
            Id = officerId,
            Name = officerId,
            Badge = officerId,
            Enrolled = false,
        };
        _db.Officers.Add(newOfficer);
        await _db.SaveChangesAsync(ct);
        _cache.Set(cacheKey, newOfficer, OfficerCacheTtl);
        return newOfficer;
    }

    private static void TryDelete(string path)
    {
        try { if (!string.IsNullOrEmpty(path) && File.Exists(path)) File.Delete(path); }
        catch { /* swallow */ }
    }

    private static AnalyseVideoResult Fail(string message) => new()
    {
        Success = false,
        ErrorMessage = message,
    };
}
