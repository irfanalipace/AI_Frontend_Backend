using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using BodyCamAI.Application.Analysis.Commands.AnalyseVideo;

namespace BodyCamAI.Infrastructure.Services;

/// <summary>
/// Background hosted service that watches a configured folder for newly
/// dropped media files and runs the SAME analysis pipeline used by
/// /api/analyse — meaning a video pasted into the inbox flows through
/// AnalyseVideoHandler exactly as if it had been uploaded over HTTP.
///
/// Layout under WatchFolder.Path:
///   Inbox/      paste videos here
///   Processed/  successful analyses (file moved here)
///   Failed/     failed analyses (file moved here + .error.txt sibling)
///
/// Stability: a file is only picked up once its size has been unchanged
/// across two sweeps separated by StableSeconds — avoids analysing
/// half-copied files.
///
/// Officer ID: parsed from filename prefix <c>&lt;officerId&gt;__rest.mp4</c>.
/// If no double-underscore separator, falls back to DefaultOfficerId.
///
/// Concurrency: a SemaphoreSlim caps how many analyses run in parallel.
/// Each analysis is fired-and-forgotten under that gate so dropping 20
/// files at once doesn't OOM the server.
///
/// Idempotency: an in-flight set prevents the same path being picked up
/// twice between sweeps. Once the analysis completes the file is moved
/// out of Inbox, so the next sweep won't see it.
/// </summary>
public class VideoFolderWatcherService : BackgroundService
{
    private readonly IServiceScopeFactory _scopes;
    private readonly WatchFolderOptions _opts;
    private readonly IWatchFolderStatus _status;
    private readonly ILogger<VideoFolderWatcherService> _log;

    private readonly SemaphoreSlim _gate;

    /// <summary>Absolute path to the watch root (after relative-to-solution resolution).</summary>
    public string ResolvedRootPath { get; }
    public string ResolvedInboxPath => Path.Combine(ResolvedRootPath, _opts.InboxSubfolder);
    public string ResolvedProcessedPath => Path.Combine(ResolvedRootPath, _opts.ProcessedSubfolder);
    public string ResolvedFailedPath => Path.Combine(ResolvedRootPath, _opts.FailedSubfolder);

    // Tracks files we've already started processing. Prevents the next
    // sweep from picking the same file up again before it's been moved.
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.OrdinalIgnoreCase);

    // Two-tick stability check: path → (size, firstSeenUtc).
    private readonly ConcurrentDictionary<string, (long Size, DateTime FirstSeen)> _seen
        = new(StringComparer.OrdinalIgnoreCase);

    public VideoFolderWatcherService(
        IServiceScopeFactory scopes,
        IOptions<WatchFolderOptions> opts,
        IWatchFolderStatus status,
        IHostEnvironment env,
        ILogger<VideoFolderWatcherService> log)
    {
        _scopes = scopes;
        _opts   = opts.Value;
        _status = status;
        _log    = log;
        _gate   = new SemaphoreSlim(Math.Max(1, _opts.MaxConcurrent));

        ResolvedRootPath = ResolveRoot(_opts.Path, env.ContentRootPath);
    }

    /// <summary>
    /// Absolute paths are used verbatim. Relative paths resolve against the
    /// SOLUTION root — i.e. the parent of ContentRootPath (which is the API
    /// project) — so a default of "WatchFolder" lands at
    /// &lt;repo&gt;\WatchFolder\ rather than inside BodyCamAI.Api\bin\...
    /// </summary>
    private static string ResolveRoot(string configured, string contentRoot)
    {
        if (string.IsNullOrWhiteSpace(configured))
            configured = "WatchFolder";

        if (Path.IsPathRooted(configured))
            return Path.GetFullPath(configured);

        // Walk up from ContentRoot until we find the .sln file (or hit the
        // drive root). That's robust to running the API from any directory.
        var dir = new DirectoryInfo(contentRoot);
        while (dir is not null && !dir.GetFiles("*.sln").Any())
            dir = dir.Parent;

        var solutionRoot = dir?.FullName ?? Path.GetFullPath(Path.Combine(contentRoot, ".."));
        return Path.GetFullPath(Path.Combine(solutionRoot, configured));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_opts.Enabled)
        {
            _log.LogInformation("WatchFolder is disabled (WatchFolder:Enabled=false).");
            return;
        }

        EnsureFolders();
        _log.LogInformation(
            "WatchFolder watching {Inbox} (root={Root}, poll={Poll}s, stable={Stable}s, maxConcurrent={Max})",
            InboxDir, ResolvedRootPath, _opts.PollSeconds, _opts.StableSeconds, _opts.MaxConcurrent);

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(1, _opts.PollSeconds)));
        try
        {
            // Run an immediate sweep on startup so leftover files from a
            // previous run get picked up without waiting for the first tick.
            await SweepSafelyAsync(stoppingToken);
            while (await timer.WaitForNextTickAsync(stoppingToken))
                await SweepSafelyAsync(stoppingToken);
        }
        catch (OperationCanceledException) { /* shutdown */ }
    }

    private async Task SweepSafelyAsync(CancellationToken ct)
    {
        try
        {
            await SweepAsync(ct);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "WatchFolder sweep failed");
        }
    }

    /// <summary>
    /// Public so the controller can trigger an immediate sweep on demand
    /// (useful while testing — no need to wait for the next tick).
    /// </summary>
    public Task TriggerSweepAsync(CancellationToken ct = default) => SweepSafelyAsync(ct);

    private async Task SweepAsync(CancellationToken ct)
    {
        if (!Directory.Exists(InboxDir)) return;

        var allowed = new HashSet<string>(_opts.AllowedExtensions, StringComparer.OrdinalIgnoreCase);
        var files = Directory.EnumerateFiles(InboxDir)
            .Where(f => allowed.Contains(Path.GetExtension(f)))
            .ToList();

        // Drop tracking for files no longer present (cleaned up / processed).
        foreach (var key in _seen.Keys.ToArray())
            if (!File.Exists(key)) _seen.TryRemove(key, out _);

        foreach (var path in files)
        {
            if (ct.IsCancellationRequested) return;
            if (_inFlight.ContainsKey(path)) continue;
            if (!IsStable(path)) continue;
            if (IsLocked(path)) continue;          // still being copied

            if (!_inFlight.TryAdd(path, 1)) continue;

            // Fire-and-forget under the concurrency gate. Awaiting here
            // would serialise the whole sweep on a single slow analysis.
            _ = Task.Run(() => ProcessOneAsync(path, CancellationToken.None), CancellationToken.None);
        }
    }

    private async Task ProcessOneAsync(string inboxPath, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        var filename = Path.GetFileName(inboxPath);
        _status.RecordStarted(filename);

        try
        {
            using var scope = _scopes.CreateScope();
            var handler = scope.ServiceProvider.GetRequiredService<AnalyseVideoHandler>();

            var officerId = ParseOfficerIdFromFilename(filename) ?? _opts.DefaultOfficerId;
            var size = SafeFileLength(inboxPath);

            _log.LogInformation("WatchFolder analysing {File} (officer={Officer}, size={Size})",
                filename, officerId, size);

            var cmd = new AnalyseVideoCommand
            {
                OfficerId         = officerId,
                OriginalFilename  = filename,
                OriginalSizeBytes = size,
                VideoTempPath     = inboxPath,
                StationId         = _opts.DefaultStationId,
            };

            var result = await handler.HandleAsync(cmd, ct);

            if (result.Success)
            {
                MoveToProcessed(inboxPath);
                _status.RecordSuccess(filename, result.RecordingId, result.ProcessingTimeSec);
                _log.LogInformation(
                    "WatchFolder OK {File} → recording {Id}, severity={Sev}, score={Score}, took {Sec}s",
                    filename, result.RecordingId, result.Severity, result.TotalScore, result.ProcessingTimeSec);
            }
            else
            {
                var err = result.ErrorMessage ?? "Analysis failed";
                MoveToFailed(inboxPath, err);
                _status.RecordFailure(filename, err);
                _log.LogWarning("WatchFolder FAIL {File}: {Err}", filename, err);
            }
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "WatchFolder unhandled error processing {File}", filename);
            try { MoveToFailed(inboxPath, ex.Message); } catch { /* best effort */ }
            _status.RecordFailure(filename, ex.Message);
        }
        finally
        {
            _inFlight.TryRemove(inboxPath, out _);
            _seen.TryRemove(inboxPath, out _);
            _gate.Release();
        }
    }

    // ─── Stability + locking checks ────────────────────────────────────

    private bool IsStable(string path)
    {
        long size;
        try { size = new FileInfo(path).Length; } catch { return false; }

        var now = DateTime.UtcNow;
        var entry = _seen.AddOrUpdate(path,
            _ => (size, now),
            (_, prev) => prev.Size == size ? prev : (size, now));

        return (now - entry.FirstSeen).TotalSeconds >= _opts.StableSeconds;
    }

    /// <summary>
    /// Try to open the file with no sharing. If it's still being written
    /// to by another process, this throws — and we know to wait.
    /// </summary>
    private static bool IsLocked(string path)
    {
        try
        {
            using var fs = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return false;
        }
        catch (IOException)      { return true; }
        catch (UnauthorizedAccessException) { return true; }
    }

    // ─── File parking ─────────────────────────────────────────────────

    private void MoveToProcessed(string inboxPath)
    {
        var datedDir = Path.Combine(ProcessedDir, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        Directory.CreateDirectory(datedDir);
        var dest = UniqueDestination(datedDir, Path.GetFileName(inboxPath));
        File.Move(inboxPath, dest, overwrite: false);
    }

    private void MoveToFailed(string inboxPath, string error)
    {
        var datedDir = Path.Combine(FailedDir, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        Directory.CreateDirectory(datedDir);
        var dest = UniqueDestination(datedDir, Path.GetFileName(inboxPath));
        File.Move(inboxPath, dest, overwrite: false);

        try { File.WriteAllText(dest + ".error.txt", $"{DateTime.UtcNow:O}\n{error}\n"); }
        catch { /* best effort */ }
    }

    private static string UniqueDestination(string dir, string filename)
    {
        var dest = Path.Combine(dir, filename);
        if (!File.Exists(dest)) return dest;

        var stem = Path.GetFileNameWithoutExtension(filename);
        var ext  = Path.GetExtension(filename);
        return Path.Combine(dir, $"{stem}_{DateTime.UtcNow:HHmmssfff}{ext}");
    }

    // ─── Officer parsing ──────────────────────────────────────────────

    /// <summary>
    /// Filename convention: <c>&lt;officerId&gt;__&lt;anything&gt;.ext</c>.
    /// Example: <c>EO123__patrol-2026-04-30.mp4</c> → officer EO123.
    /// Returns null when no double-underscore separator is found.
    /// </summary>
    private static string? ParseOfficerIdFromFilename(string filename)
    {
        var stem = Path.GetFileNameWithoutExtension(filename);
        var idx = stem.IndexOf("__", StringComparison.Ordinal);
        if (idx <= 0) return null;
        var candidate = stem[..idx].Trim();
        return string.IsNullOrWhiteSpace(candidate) ? null : candidate;
    }

    // ─── Folder bookkeeping ──────────────────────────────────────────

    private string InboxDir     => ResolvedInboxPath;
    private string ProcessedDir => ResolvedProcessedPath;
    private string FailedDir    => ResolvedFailedPath;

    private void EnsureFolders()
    {
        Directory.CreateDirectory(ResolvedRootPath);
        Directory.CreateDirectory(InboxDir);
        Directory.CreateDirectory(ProcessedDir);
        Directory.CreateDirectory(FailedDir);
    }

    private static long SafeFileLength(string path)
    {
        try { return new FileInfo(path).Length; } catch { return 0; }
    }
}
