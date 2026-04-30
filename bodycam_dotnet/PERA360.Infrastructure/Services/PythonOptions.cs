namespace PERA360.Infrastructure.Services;

/// <summary>
/// Bound from the "Python" section of appsettings.json. Points at the
/// Flask-based ML pipeline (default :5050) that does voiceprint matching,
/// diarization, SVM tone classification, Whisper transcription, and the
/// Gemini-backed assessment narrative. The .NET backend extracts audio
/// with ffmpeg and forwards it to this URL.
/// </summary>
public class PythonOptions
{
    public const string SectionName = "Python";

    /// <summary>Base URL of the Python backend, e.g. http://localhost:5050.</summary>
    public string BaseUrl { get; set; } = "http://localhost:5050";

    /// <summary>HTTP timeout in seconds. ML pipeline can take a minute or two.</summary>
    public int TimeoutSeconds { get; set; } = 600;
}
