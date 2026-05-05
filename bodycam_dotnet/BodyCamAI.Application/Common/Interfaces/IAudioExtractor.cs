namespace BodyCamAI.Application.Common.Interfaces;

/// <summary>
/// Strips the audio track out of an uploaded media file before it is sent
/// to Gemini. The Application layer depends only on this abstraction; the
/// Infrastructure layer provides a concrete ffmpeg-backed implementation.
///
/// Why this exists: Gemini's inline-data request is capped at ~20 MB. A
/// raw video clip blows that limit easily, but a 16 kHz mono MP3 of the
/// same recording is tiny — enough room for ~30+ minutes of speech.
/// </summary>
public interface IAudioExtractor
{
    /// <summary>
    /// Extracts audio from <paramref name="inputMediaPath"/> as a small
    /// 16 kHz mono MP3 written to a fresh temp file. Returns the temp path
    /// on success, or an <see cref="AudioExtractionResult"/> with an error
    /// message otherwise. The caller owns the temp file and is responsible
    /// for deleting it.
    /// </summary>
    Task<AudioExtractionResult> ExtractAsync(string inputMediaPath, CancellationToken ct = default);
}

/// <summary>Result of an audio-extraction attempt.</summary>
public class AudioExtractionResult
{
    public bool   Success      { get; set; }
    public string OutputPath   { get; set; } = string.Empty;
    public long   OutputBytes  { get; set; }
    public string? ErrorMessage { get; set; }

    public static AudioExtractionResult Ok(string path, long bytes) =>
        new() { Success = true, OutputPath = path, OutputBytes = bytes };

    public static AudioExtractionResult Fail(string message) =>
        new() { Success = false, ErrorMessage = message };
}
