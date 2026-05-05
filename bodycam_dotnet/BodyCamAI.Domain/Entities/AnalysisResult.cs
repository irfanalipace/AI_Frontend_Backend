namespace BodyCamAI.Domain.Entities;

/// <summary>
/// All non-violation analysis output for a recording — score, transcripts,
/// tone, greeting protocol, emotion, narrative, acoustics, video analysis.
/// One row per Recording. Pure domain entity — persistence shape is configured
/// in the Infrastructure layer.
/// </summary>
public class AnalysisResult
{
    public long Id { get; set; }

    public long RecordingId { get; set; }
    public Recording? Recording { get; set; }

    // ── SCORING ──────────────────────────────────────────────────────
    public int TotalScore { get; set; }
    public int ToneScore { get; set; }
    public int KwScore { get; set; }

    /// <summary>"NORMAL" / "WARNING" / "CRITICAL"</summary>
    public string Severity { get; set; } = "NORMAL";

    public int CriticalCount { get; set; }
    public int HighCount { get; set; }
    public int MediumCount { get; set; }

    // ── TONE CLASSIFIER ──────────────────────────────────────────────
    public string ToneLabel { get; set; } = "NORMAL";

    public int? TonePercentNormal { get; set; }
    public int? TonePercentHarsh { get; set; }
    public int? TonePercentAngry { get; set; }
    public int? TonePercentBribe { get; set; }

    // ── TRANSCRIPTS ──────────────────────────────────────────────────
    public string? TranscriptUrdu { get; set; }
    public string? TranscriptEnglish { get; set; }
    public string? TranscriptionMethod { get; set; }    // "gemini" / "whisper" / etc.

    // ── EO IDENTIFICATION ────────────────────────────────────────────
    public bool EoDetected { get; set; }
    public double EoSimilarity { get; set; }

    // ── ACOUSTICS ────────────────────────────────────────────────────
    public double? AvgPitchHz { get; set; }
    public double? BaselinePitchHz { get; set; }
    public double? PitchRatio { get; set; }
    public double? AvgEnergy { get; set; }
    public double? LoudDurationSec { get; set; }
    public double? Agitation { get; set; }

    // ── GREETING PROTOCOL ────────────────────────────────────────────
    public string? GreetingCompliance { get; set; }     // FULL / PARTIAL / MISSING
    public int? GreetingScore { get; set; }
    public bool? SalamFound { get; set; }
    public bool? NameIntroduced { get; set; }
    public bool? StationMentioned { get; set; }
    public bool? RoleMentioned { get; set; }

    public string? ExtractedName { get; set; }
    public string? ExtractedStation { get; set; }
    public string? MatchedOfficerId { get; set; }

    // ── DIARIZATION ──────────────────────────────────────────────────
    public int? SpeakerCount { get; set; }
    public double? EoTotalSec { get; set; }
    public double? CustomerTotalSec { get; set; }
    public int? EoSegmentsCount { get; set; }
    public int? CustomerSegmentsCount { get; set; }

    // ── EMOTIONS (8 categories) ──────────────────────────────────────
    public string? DominantEmotion { get; set; }

    public int EmotionAnger { get; set; }
    public int EmotionFrustration { get; set; }
    public int EmotionContempt { get; set; }
    public int EmotionIntimidation { get; set; }
    public int EmotionFear { get; set; }
    public int EmotionCalm { get; set; }
    public int EmotionNeutral { get; set; }
    public int EmotionAgitation { get; set; }

    public string? EmotionNarrative { get; set; }

    // ── GEMINI / LLAMA NARRATIVE ─────────────────────────────────────
    public string? AiAssessment { get; set; }
    public string? RecommendedAction { get; set; }

    // ── VIDEO VISUAL ANALYSIS (only when media_type = video) ─────────
    public int? VisualRiskScore { get; set; }
    public string? VisualSummary { get; set; }
    public bool? BriberyVisualDetected { get; set; }
    public bool? AggressivePostureDetected { get; set; }
    public bool? PhysicalContactDetected { get; set; }
    public bool? ConcealedGesturesDetected { get; set; }

    public string? VisualAnalysisStatus { get; set; }    // ok / empty / error / missing
    public string? VisualAnalysisStatusMessage { get; set; }

    /// <summary>
    /// Full raw JSON returned by the AI provider (Gemini), preserved for
    /// forensic re-analysis. Stored as text — no native JSON column dependency.
    /// </summary>
    public string? RawJson { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
