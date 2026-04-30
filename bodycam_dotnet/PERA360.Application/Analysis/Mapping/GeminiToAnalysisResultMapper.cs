using PERA360.Application.Common.Interfaces;
using PERA360.Application.Common.Models;
using PERA360.Domain.Entities;

namespace PERA360.Application.Analysis.Mapping;

/// <summary>
/// Pure mapping from Gemini's structured DTO to Domain entities. No I/O, no DI —
/// safe to unit-test in isolation.
/// </summary>
public static class GeminiToAnalysisResultMapper
{
    public static (AnalysisResult analysis, List<Violation> violations) Map(GeminiAnalysisResult source)
    {
        var dto = source.Analysis;

        var analysis = new AnalysisResult
        {
            // ── Scoring
            TotalScore    = dto.TotalScore,
            ToneScore     = dto.ToneScore,
            KwScore       = dto.KwScore,
            Severity      = NormaliseSeverity(dto.Severity),
            CriticalCount = dto.CriticalCount,
            HighCount     = dto.HighCount,
            MediumCount   = dto.MediumCount,

            // ── Tone
            ToneLabel          = string.IsNullOrWhiteSpace(dto.ToneLabel) ? "NORMAL" : dto.ToneLabel,
            TonePercentNormal  = dto.TonePercents?.Normal,
            TonePercentHarsh   = dto.TonePercents?.Harsh,
            TonePercentAngry   = dto.TonePercents?.Angry,
            TonePercentBribe   = dto.TonePercents?.BribeTone,

            // ── Transcripts
            TranscriptUrdu      = dto.TranscriptUrdu,
            TranscriptEnglish   = dto.TranscriptEnglish,
            TranscriptionMethod = string.IsNullOrWhiteSpace(source.ModelName) ? "gemini" : source.ModelName,

            // ── Emotions
            DominantEmotion    = dto.Emotions?.Dominant,
            EmotionAnger       = dto.Emotions?.Anger ?? 0,
            EmotionFrustration = dto.Emotions?.Frustration ?? 0,
            EmotionContempt    = dto.Emotions?.Contempt ?? 0,
            EmotionIntimidation= dto.Emotions?.Intimidation ?? 0,
            EmotionFear        = dto.Emotions?.Fear ?? 0,
            EmotionCalm        = dto.Emotions?.Calm ?? 0,
            EmotionNeutral     = dto.Emotions?.Neutral ?? 0,
            EmotionAgitation   = dto.Emotions?.Agitation ?? 0,
            EmotionNarrative   = dto.Emotions?.Narrative,

            // ── Narrative
            AiAssessment      = dto.AiAssessment,
            RecommendedAction = dto.RecommendedAction,

            RawJson  = source.RawJson,
            CreatedAt = DateTime.UtcNow,
        };

        var violations = dto.Violations.Select(v => new Violation
        {
            Type          = string.IsNullOrWhiteSpace(v.Type) ? "OTHER" : v.Type,
            Severity      = NormaliseViolationSeverity(v.Severity),
            SeverityLabel = $"{NormaliseViolationSeverity(v.Severity)}",
            Label         = v.Label,
            Description   = v.Description,
            Score         = v.Score,
            KeywordsFound = v.KeywordsFound.Count == 0 ? null : string.Join(",", v.KeywordsFound),
            Source        = "gemini",
            CreatedAt     = DateTime.UtcNow,
        }).ToList();

        return (analysis, violations);
    }

    private static string NormaliseSeverity(string sev) =>
        (sev ?? "NORMAL").Trim().ToUpperInvariant() switch
        {
            "CRITICAL" => "CRITICAL",
            "WARNING"  => "WARNING",
            _          => "NORMAL",
        };

    private static string NormaliseViolationSeverity(string sev) =>
        (sev ?? "LOW").Trim().ToUpperInvariant() switch
        {
            "CRITICAL" => "CRITICAL",
            "HIGH"     => "HIGH",
            "MEDIUM"   => "MEDIUM",
            _          => "LOW",
        };
}
