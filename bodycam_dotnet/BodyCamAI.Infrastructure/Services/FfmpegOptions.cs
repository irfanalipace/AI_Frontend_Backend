namespace BodyCamAI.Infrastructure.Services;

/// <summary>
/// Bound from the "Ffmpeg" section of appsettings.json. Lets us point at
/// a specific ffmpeg binary without relying on PATH — handy in dev
/// machines where Windows PATH inheritance into the dotnet process is
/// unreliable.
/// </summary>
public class FfmpegOptions
{
    public const string SectionName = "Ffmpeg";

    /// <summary>
    /// Absolute path to ffmpeg.exe. If empty, FfmpegAudioExtractor falls
    /// back to the FFMPEG_PATH environment variable, then to plain "ffmpeg"
    /// (PATH lookup).
    /// </summary>
    public string Path { get; set; } = string.Empty;
}
