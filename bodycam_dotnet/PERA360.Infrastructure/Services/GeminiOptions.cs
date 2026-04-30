namespace PERA360.Infrastructure.Services;

/// <summary>
/// Bound from the "Gemini" section of appsettings.json.
/// </summary>
public class GeminiOptions
{
    public const string SectionName = "Gemini";

    /// <summary>API key for the Generative Language API.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Model id. Default is "gemini-2.5-flash-lite" — the latest free-tier
    /// multimodal model on Google AI Studio as of April 2026 (Pro models
    /// became paid-only on 2026-04-01).
    /// </summary>
    public string Model { get; set; } = "gemini-2.5-flash-lite";

    /// <summary>Base URL for the v1beta REST endpoint.</summary>
    public string BaseUrl { get; set; } = "https://generativelanguage.googleapis.com/v1beta";

    /// <summary>HTTP timeout in seconds for the analysis call.</summary>
    public int TimeoutSeconds { get; set; } = 600;
}
