namespace BodyCamAI.Infrastructure.Services;

/// <summary>
/// Bound from the "WatchFolder" section of appsettings.json. Drives the
/// VideoFolderWatcherService — drop a video into Inbox/ and the same
/// analysis pipeline used by /api/analyse runs automatically when the
/// backend is up. Files are then moved to Processed/ or Failed/ so they
/// are never analysed twice.
/// </summary>
public class WatchFolderOptions
{
    public const string SectionName = "WatchFolder";

    /// <summary>
    /// Master switch. If false the BackgroundService logs once and exits —
    /// safe to keep registered in DI on machines where folder-watch isn't
    /// wanted.
    /// </summary>
    public bool Enabled { get; set; } = false;

    /// <summary>
    /// Root folder. Three subfolders (Inbox / Processed / Failed) are
    /// created here on startup.
    ///
    /// If the value is a RELATIVE path it is resolved against the
    /// solution root (parent of the API's ContentRootPath), so the
    /// default lands at <c>&lt;repo&gt;\WatchFolder\</c> alongside the
    /// project folders — not inside BodyCamAI.Api/bin.
    /// Absolute paths (e.g. <c>D:\Bodycam</c>) are used verbatim.
    /// </summary>
    public string Path { get; set; } = "WatchFolder";

    public string InboxSubfolder { get; set; } = "Inbox";
    public string ProcessedSubfolder { get; set; } = "Processed";
    public string FailedSubfolder { get; set; } = "Failed";

    /// <summary>
    /// Officer ID used when the filename has no <c>&lt;officerId&gt;__</c>
    /// prefix. Recordings still get analysed and saved under this ID, so
    /// the dashboard surfaces them.
    /// </summary>
    public string DefaultOfficerId { get; set; } = "EO000";

    /// <summary>
    /// Optional default station ID written onto auto-detected recordings.
    /// Useful for filtering them on the dashboard.
    /// </summary>
    public string? DefaultStationId { get; set; } = "auto:watch-folder";

    /// <summary>How often the watcher sweeps the inbox (seconds).</summary>
    public int PollSeconds { get; set; } = 5;

    /// <summary>
    /// File is considered "stable" once its size is unchanged across two
    /// consecutive sweeps separated by this many seconds. Prevents picking
    /// up half-copied files.
    /// </summary>
    public int StableSeconds { get; set; } = 3;

    /// <summary>
    /// Hard cap on concurrent analyses. Each analysis runs ffmpeg + an
    /// HTTP call to Python / Gemini, so 2 is a sensible default; bump on
    /// beefier machines.
    /// </summary>
    public int MaxConcurrent { get; set; } = 2;

    /// <summary>
    /// File extensions the watcher will consider. Anything else in the
    /// inbox is left alone.
    /// </summary>
    public string[] AllowedExtensions { get; set; } = new[]
    {
        ".mp4", ".mov", ".webm", ".mkv", ".avi", ".3gp", ".flv", ".wmv", ".m4v",
        ".wav", ".mp3", ".m4a", ".ogg", ".flac",
    };
}
