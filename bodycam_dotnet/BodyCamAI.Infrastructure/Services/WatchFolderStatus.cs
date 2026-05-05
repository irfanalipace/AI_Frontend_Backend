using System.Collections.Concurrent;

namespace BodyCamAI.Infrastructure.Services;

/// <summary>
/// Thread-safe snapshot of the folder watcher's runtime state. Singleton.
/// VideoFolderWatcherService writes; WatchFolderController reads.
///
/// Keeps a small ring of recent items (success or failure) so the
/// "Video Analysis" dashboard can show what just happened without
/// hitting the DB for it.
/// </summary>
public interface IWatchFolderStatus
{
    WatchFolderStatusSnapshot Snapshot();
    void RecordStarted(string filename);
    void RecordSuccess(string filename, long recordingId, double seconds);
    void RecordFailure(string filename, string error);
    void RecordSkipped(string filename, string reason);
}

public class WatchFolderStatus : IWatchFolderStatus
{
    private const int RecentCapacity = 50;

    private long _processedCount;
    private long _failedCount;
    private long _skippedCount;
    private long _inFlight;
    private DateTime? _lastProcessedAt;
    private DateTime? _lastFailedAt;
    private string? _lastError;

    private readonly ConcurrentQueue<WatchFolderRecentItem> _recent = new();

    public WatchFolderStatusSnapshot Snapshot() => new()
    {
        ProcessedCount  = Interlocked.Read(ref _processedCount),
        FailedCount     = Interlocked.Read(ref _failedCount),
        SkippedCount    = Interlocked.Read(ref _skippedCount),
        InFlight        = Interlocked.Read(ref _inFlight),
        LastProcessedAt = _lastProcessedAt,
        LastFailedAt    = _lastFailedAt,
        LastError       = _lastError,
        Recent          = _recent.ToArray(),
    };

    public void RecordStarted(string filename)
    {
        Interlocked.Increment(ref _inFlight);
        Push(new WatchFolderRecentItem
        {
            Filename = filename,
            Status   = "STARTED",
            At       = DateTime.UtcNow,
        });
    }

    public void RecordSuccess(string filename, long recordingId, double seconds)
    {
        Interlocked.Decrement(ref _inFlight);
        Interlocked.Increment(ref _processedCount);
        _lastProcessedAt = DateTime.UtcNow;
        Push(new WatchFolderRecentItem
        {
            Filename          = filename,
            Status            = "SUCCESS",
            At                = DateTime.UtcNow,
            RecordingId       = recordingId,
            ProcessingSeconds = seconds,
        });
    }

    public void RecordFailure(string filename, string error)
    {
        Interlocked.Decrement(ref _inFlight);
        Interlocked.Increment(ref _failedCount);
        _lastFailedAt = DateTime.UtcNow;
        _lastError = error;
        Push(new WatchFolderRecentItem
        {
            Filename = filename,
            Status   = "FAILED",
            At       = DateTime.UtcNow,
            Error    = error,
        });
    }

    public void RecordSkipped(string filename, string reason)
    {
        Interlocked.Increment(ref _skippedCount);
        Push(new WatchFolderRecentItem
        {
            Filename = filename,
            Status   = "SKIPPED",
            At       = DateTime.UtcNow,
            Error    = reason,
        });
    }

    private void Push(WatchFolderRecentItem item)
    {
        _recent.Enqueue(item);
        while (_recent.Count > RecentCapacity && _recent.TryDequeue(out _)) { /* trim */ }
    }
}

public class WatchFolderStatusSnapshot
{
    public long ProcessedCount { get; set; }
    public long FailedCount { get; set; }
    public long SkippedCount { get; set; }
    public long InFlight { get; set; }
    public DateTime? LastProcessedAt { get; set; }
    public DateTime? LastFailedAt { get; set; }
    public string? LastError { get; set; }
    public IReadOnlyList<WatchFolderRecentItem> Recent { get; set; } = Array.Empty<WatchFolderRecentItem>();
}

public class WatchFolderRecentItem
{
    public string Filename { get; set; } = string.Empty;
    public string Status { get; set; } = "STARTED";
    public DateTime At { get; set; }
    public long? RecordingId { get; set; }
    public double? ProcessingSeconds { get; set; }
    public string? Error { get; set; }
}
