namespace PERA360.Application.Common.Models;

/// <summary>
/// Strongly-typed shape Gemini is asked to return via responseSchema
/// (works the same with 2.5 Flash, 2.5 Flash-Lite, etc).
/// Mirrors the columns we persist in AnalysisResult / Violation, so mapping
/// to entities is a 1:1 copy.
/// </summary>
public class GeminiAnalysisDto
{
    public string? TranscriptUrdu { get; set; }
    public string? TranscriptEnglish { get; set; }

    public string ToneLabel { get; set; } = "NORMAL";
    public TonePercentsDto? TonePercents { get; set; }

    public string Severity { get; set; } = "NORMAL";

    public int TotalScore { get; set; }
    public int ToneScore { get; set; }
    public int KwScore { get; set; }

    public int CriticalCount { get; set; }
    public int HighCount { get; set; }
    public int MediumCount { get; set; }

    public EmotionsDto? Emotions { get; set; }

    public string? AiAssessment { get; set; }
    public string? RecommendedAction { get; set; }

    public List<ViolationDto> Violations { get; set; } = new();
}

public class TonePercentsDto
{
    public int Normal { get; set; }
    public int Harsh { get; set; }
    public int Angry { get; set; }
    public int BribeTone { get; set; }
}

public class EmotionsDto
{
    public string? Dominant { get; set; }
    public int Anger { get; set; }
    public int Frustration { get; set; }
    public int Contempt { get; set; }
    public int Intimidation { get; set; }
    public int Fear { get; set; }
    public int Calm { get; set; }
    public int Neutral { get; set; }
    public int Agitation { get; set; }
    public string? Narrative { get; set; }
}

public class ViolationDto
{
    public string Type { get; set; } = "OTHER";
    public string Severity { get; set; } = "LOW";
    public string Label { get; set; } = string.Empty;
    public string? Description { get; set; }
    public int Score { get; set; }
    public List<string> KeywordsFound { get; set; } = new();
}
