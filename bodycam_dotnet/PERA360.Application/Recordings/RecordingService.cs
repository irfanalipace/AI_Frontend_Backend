using Microsoft.EntityFrameworkCore;
using PERA360.Application.Common.Interfaces;

namespace PERA360.Application.Recordings;

public class RecordingService : IRecordingService
{
    private readonly IBodycamDbContext _db;
    public RecordingService(IBodycamDbContext db) => _db = db;

    public async Task<RecordingListResult> ListAsync(string? officerId, string? severity, int page, int pageSize, CancellationToken ct = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 200);

        var q = _db.Recordings
            .Include(r => r.AnalysisResult)
            .OrderByDescending(r => r.UploadedAt)
            .AsQueryable();

        if (!string.IsNullOrWhiteSpace(officerId))
            q = q.Where(r => r.OfficerId == officerId);

        if (!string.IsNullOrWhiteSpace(severity))
            q = q.Where(r => r.AnalysisResult != null && r.AnalysisResult.Severity == severity);

        var total = await q.CountAsync(ct);
        var items = await q
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(r => new RecordingListItem
            {
                Id = r.Id,
                OfficerId = r.OfficerId,
                Filename = r.Filename,
                MediaType = r.MediaType,
                DurationSeconds = r.DurationSeconds,
                UploadedAt = r.UploadedAt,
                Score = r.AnalysisResult == null ? 0 : r.AnalysisResult.TotalScore,
                Severity = r.AnalysisResult == null ? "NORMAL" : r.AnalysisResult.Severity,
                ToneLabel = r.AnalysisResult == null ? "NORMAL" : r.AnalysisResult.ToneLabel,
                ViolationCount = r.Violations.Count,
            })
            .ToListAsync(ct);

        return new RecordingListResult { Total = total, Page = page, PageSize = pageSize, Items = items };
    }

    public async Task<RecordingDetailResult?> DetailAsync(long id, CancellationToken ct = default)
    {
        var rec = await _db.Recordings
            .Include(r => r.AnalysisResult)
            .Include(r => r.Violations.OrderByDescending(v => v.Score))
            .Include(r => r.Officer)
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == id, ct);

        if (rec is null) return null;

        return new RecordingDetailResult
        {
            Id = rec.Id,
            OfficerId = rec.OfficerId,
            OfficerName = rec.Officer?.Name,
            Filename = rec.Filename,
            MediaType = rec.MediaType,
            DurationSeconds = rec.DurationSeconds,
            UploadedAt = rec.UploadedAt,
            StationId = rec.StationId,
            AnalysisResult = rec.AnalysisResult,
            Violations = rec.Violations.Cast<object>().ToList(),
        };
    }

    public async Task<bool> DeleteAsync(long id, CancellationToken ct = default)
    {
        // Pull the recording with its analysis row + violation rows in one
        // round-trip so EF Core can issue cascading DELETEs in a single
        // SaveChanges. Returns false if nothing was found — the controller
        // turns that into a 404.
        var rec = await _db.Recordings
            .Include(r => r.AnalysisResult)
            .Include(r => r.Violations)
            .FirstOrDefaultAsync(r => r.Id == id, ct);

        if (rec is null) return false;

        if (rec.AnalysisResult is not null)
            _db.AnalysisResults.Remove(rec.AnalysisResult);
        if (rec.Violations.Count > 0)
            foreach (var v in rec.Violations) _db.Violations.Remove(v);
        _db.Recordings.Remove(rec);

        await _db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<RecordingStatsResult> StatsAsync(CancellationToken ct = default)
    {
        var since = DateTime.UtcNow.AddDays(-30);

        var totalRecordings = await _db.Recordings.CountAsync(ct);
        var critical = await _db.AnalysisResults.CountAsync(a => a.Severity == "CRITICAL", ct);
        var warning  = await _db.AnalysisResults.CountAsync(a => a.Severity == "WARNING", ct);
        var last30   = await _db.Recordings.CountAsync(r => r.UploadedAt >= since, ct);

        var topOfficers = await _db.Recordings
            .GroupBy(r => r.OfficerId)
            .Select(g => new TopOfficerCritical
            {
                OfficerId = g.Key,
                Recordings = g.Count(),
                CriticalCount = g.Count(r => r.AnalysisResult != null && r.AnalysisResult.Severity == "CRITICAL"),
            })
            .OrderByDescending(x => x.CriticalCount)
            .Take(10)
            .ToListAsync(ct);

        return new RecordingStatsResult
        {
            TotalRecordings = totalRecordings,
            Critical = critical,
            Warning = warning,
            Normal = totalRecordings - critical - warning,
            Last30Days = last30,
            TopOfficersByCritical = topOfficers,
        };
    }
}
