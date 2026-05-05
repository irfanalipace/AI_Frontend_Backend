using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using BodyCamAI.Infrastructure.Services;

namespace BodyCamAI.Api.Controllers;

/// <summary>
/// Backend endpoints powering the new "Video Analysis" dashboard menu.
/// The actual analysis happens automatically inside VideoFolderWatcherService —
/// drop a file into the configured Inbox/ folder and it flows through the
/// same pipeline as /api/analyse, then lands in the Recordings table.
///
/// This controller exposes:
///   GET  /api/watch-folder/status   — runtime stats + recent items
///   POST /api/watch-folder/trigger  — force an immediate sweep (testing)
/// The "all the details" view is already covered by /api/recordings,
/// /api/recordings/{id}, and /api/recordings/stats; auto-detected
/// recordings appear there alongside uploaded ones.
/// </summary>
[ApiController]
[Route("api/watch-folder")]
public class WatchFolderController : ControllerBase
{
    private readonly IWatchFolderStatus _status;
    private readonly WatchFolderOptions _opts;
    private readonly VideoFolderWatcherService _watcher;

    public WatchFolderController(
        IWatchFolderStatus status,
        IOptions<WatchFolderOptions> opts,
        VideoFolderWatcherService watcher)
    {
        _status  = status;
        _opts    = opts.Value;
        _watcher = watcher;
    }

    /// <summary>
    /// Snapshot of the watcher: configured paths, counters, last error,
    /// and the most recent items (up to 50). Drives the "Video Analysis"
    /// menu in the dashboard.
    /// </summary>
    [HttpGet("status")]
    public IActionResult Status()
    {
        var snap = _status.Snapshot();
        return Ok(new
        {
            enabled         = _opts.Enabled,
            watch_path      = _watcher.ResolvedRootPath,
            inbox_path      = _watcher.ResolvedInboxPath,
            processed_path  = _watcher.ResolvedProcessedPath,
            failed_path     = _watcher.ResolvedFailedPath,
            poll_seconds    = _opts.PollSeconds,
            stable_seconds  = _opts.StableSeconds,
            max_concurrent  = _opts.MaxConcurrent,
            default_officer = _opts.DefaultOfficerId,
            default_station = _opts.DefaultStationId,
            counters = new
            {
                processed = snap.ProcessedCount,
                failed    = snap.FailedCount,
                skipped   = snap.SkippedCount,
                in_flight = snap.InFlight,
            },
            last_processed_at = snap.LastProcessedAt,
            last_failed_at    = snap.LastFailedAt,
            last_error        = snap.LastError,
            recent            = snap.Recent.Reverse().ToArray(),
        });
    }

    /// <summary>
    /// Forces the watcher to sweep the inbox right now instead of waiting
    /// for its next poll tick. Returns 503 if the watcher isn't enabled
    /// or hasn't been registered.
    /// </summary>
    [HttpPost("trigger")]
    public async Task<IActionResult> Trigger(CancellationToken ct)
    {
        if (!_opts.Enabled)
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                new { error = "WatchFolder is disabled (set WatchFolder:Enabled=true in appsettings.json)" });

        await _watcher.TriggerSweepAsync(ct);
        return Ok(new { ok = true, triggered_at = DateTime.UtcNow });
    }
}
