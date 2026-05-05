using System.Text.Json.Serialization;

namespace BodyCamAI.Shared.Contracts;

/// <summary>
/// Public response shape returned by POST /api/analyse.
///
/// Field names (snake_case via [JsonPropertyName]) intentionally mirror the
/// Python EO-Bodycam backend's run_analysis() output, so the React Upload
/// page (bodycam_frontend/src/pages/Upload.jsx) can render the result
/// without any frontend changes.
///
/// Fields the .NET/Gemini pipeline does not compute (acoustics, EO voiceprint
/// similarity) are returned as zeros — the Upload page guards on those
/// (`if (r.eo_detected && ac.avg_pitch_hz > 0)`) and simply hides the
/// corresponding panel, so the result page still renders cleanly.
/// </summary>
public class AnalyseVideoResponse
{
    // ── Identity & metadata ────────────────────────────────────────────
    [JsonPropertyName("incident_id")]   public string IncidentId   { get; set; } = string.Empty;
    [JsonPropertyName("recording_id")]  public long   RecordingId  { get; set; }
    [JsonPropertyName("officer_id")]    public string OfficerId    { get; set; } = string.Empty;
    [JsonPropertyName("officer_name")]  public string OfficerName  { get; set; } = string.Empty;
    [JsonPropertyName("officer_badge")] public string OfficerBadge { get; set; } = string.Empty;
    [JsonPropertyName("officer_area")]  public string OfficerArea  { get; set; } = string.Empty;
    [JsonPropertyName("filename")]      public string Filename     { get; set; } = string.Empty;
    [JsonPropertyName("media_type")]    public string MediaType    { get; set; } = "video";
    [JsonPropertyName("source")]        public string Source       { get; set; } = "upload";
    [JsonPropertyName("timestamp")]     public string Timestamp    { get; set; } = string.Empty;

    // ── Duration / segments (not computed by Gemini — defaults to 0) ───
    [JsonPropertyName("total_duration_sec")] public double TotalDurationSec { get; set; }
    [JsonPropertyName("speech_segments")]    public int    SpeechSegments   { get; set; }
    [JsonPropertyName("speech_ratio")]       public double SpeechRatio      { get; set; }

    // ── EO voiceprint identification (not done in this pipeline) ───────
    [JsonPropertyName("eo_detected")]     public bool   EoDetected     { get; set; } = true;
    [JsonPropertyName("eo_speaking_sec")] public double EoSpeakingSec  { get; set; }
    [JsonPropertyName("avg_similarity")]  public double AvgSimilarity  { get; set; }
    [JsonPropertyName("max_similarity")]  public double MaxSimilarity  { get; set; }
    [JsonPropertyName("eo_threshold")]    public double EoThreshold    { get; set; } = 0.82;

    // ── Transcript ─────────────────────────────────────────────────────
    [JsonPropertyName("transcript")]            public string? Transcript           { get; set; }
    [JsonPropertyName("transcript_english")]    public string? TranscriptEnglish    { get; set; }
    [JsonPropertyName("transcription_method")]  public string  TranscriptionMethod  { get; set; } = "gemini";
    [JsonPropertyName("transcript_source")]     public string  TranscriptSource     { get; set; } = "gemini_video_audio_analysis";

    // ── Tone classifier ────────────────────────────────────────────────
    /// <summary>One of NORMAL / HARSH / ANGRY / BRIBE_TONE.</summary>
    [JsonPropertyName("tone_label")] public string ToneLabel { get; set; } = "NORMAL";

    /// <summary>
    /// Per-class probabilities 0.0–1.0, keyed by the same labels the frontend
    /// reads: "NORMAL", "HARSH", "BRIBE_TONE" (and optionally "ANGRY").
    /// </summary>
    [JsonPropertyName("tone_proba")] public Dictionary<string, double> ToneProba { get; set; } = new();

    // ── Acoustics (not computed by Gemini — sent as zeros) ─────────────
    [JsonPropertyName("acoustics")] public AnalyseAcousticsResponse Acoustics { get; set; } = new();

    // ── Violations & scoring ───────────────────────────────────────────
    [JsonPropertyName("violations")]      public List<AnalyseViolationResponse> Violations { get; set; } = new();
    [JsonPropertyName("tone_score")]      public int    ToneScore      { get; set; }
    [JsonPropertyName("keyword_score")]   public int    KeywordScore   { get; set; }
    [JsonPropertyName("total_score")]     public int    TotalScore     { get; set; }
    [JsonPropertyName("severity")]        public string Severity       { get; set; } = "NORMAL";
    [JsonPropertyName("alert_required")]  public bool   AlertRequired  { get; set; }

    [JsonPropertyName("processing_time_sec")] public double ProcessingTimeSec { get; set; }

    // ── Extra Gemini-only narrative fields (frontend ignores unknown keys) ──
    [JsonPropertyName("dominant_emotion")]   public string? DominantEmotion   { get; set; }
    [JsonPropertyName("ai_assessment")]      public string? AiAssessment      { get; set; }
    [JsonPropertyName("recommended_action")] public string? RecommendedAction { get; set; }
    [JsonPropertyName("violation_count")]    public int     ViolationCount    { get; set; }

    /// <summary>Raw JSON Gemini returned, for the frontend to render rich detail.</summary>
    [JsonPropertyName("raw_analysis_json")] public string? RawAnalysisJson { get; set; }
}

/// <summary>
/// Mirrors the Python backend's `acoustics` block (energy, pitch, ZCR,
/// agitation). Gemini does not compute these so they default to 0.0.
/// </summary>
public class AnalyseAcousticsResponse
{
    [JsonPropertyName("avg_energy")]        public double AvgEnergy       { get; set; }
    [JsonPropertyName("avg_pitch_hz")]      public double AvgPitchHz      { get; set; }
    [JsonPropertyName("zcr")]               public double Zcr             { get; set; }
    [JsonPropertyName("pitch_variance")]    public double PitchVariance   { get; set; }
    [JsonPropertyName("loud_duration_sec")] public double LoudDurationSec { get; set; }
    [JsonPropertyName("agitation")]         public double Agitation       { get; set; }
    [JsonPropertyName("enrolled_pitch_hz")] public double EnrolledPitchHz { get; set; }
    [JsonPropertyName("pitch_ratio")]       public double PitchRatio      { get; set; }
}

/// <summary>
/// Single violation entry — shape matches the objects rendered by
/// ViolationCard in the React Upload page.
/// </summary>
public class AnalyseViolationResponse
{
    [JsonPropertyName("type")]           public string       Type          { get; set; } = "OTHER";
    [JsonPropertyName("severity")]       public string       Severity      { get; set; } = "LOW";
    [JsonPropertyName("score")]          public int          Score         { get; set; }
    [JsonPropertyName("label")]          public string?      Label         { get; set; }
    [JsonPropertyName("detail")]         public string?      Detail        { get; set; }
    [JsonPropertyName("keywords_found")] public List<string> KeywordsFound { get; set; } = new();
    [JsonPropertyName("source")]         public string       Source        { get; set; } = "gemini";
}
