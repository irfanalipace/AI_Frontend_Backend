using Microsoft.EntityFrameworkCore;
using BodyCamAI.Application.Common.Interfaces;

namespace BodyCamAI.Application.CriticalIncidents;

public class CriticalIncidentService : ICriticalIncidentService
{
    private readonly IBodycamDbContext _db;
    public CriticalIncidentService(IBodycamDbContext db) => _db = db;

    public async Task<CriticalListResult> ListAsync(string? mediaType, DateTime? since, DateTime? until, string? officerId, int page, int pageSize, CancellationToken ct = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 200);

        var q = _db.Recordings
            .Where(r => r.AnalysisResult != null && r.AnalysisResult.Severity == "CRITICAL")
            .Include(r => r.AnalysisResult)
            .Include(r => r.Officer)
            .OrderByDescending(r => r.UploadedAt)
            .AsQueryable();

        if (!string.IsNullOrWhiteSpace(mediaType))
            q = q.Where(r => r.MediaType == mediaType);
        if (!string.IsNullOrWhiteSpace(officerId))
            q = q.Where(r => r.OfficerId == officerId);
        if (since.HasValue)
            q = q.Where(r => r.UploadedAt >= since.Value);
        if (until.HasValue)
            q = q.Where(r => r.UploadedAt <= until.Value);

        var total = await q.CountAsync(ct);
        var items = await q
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(r => new CriticalIncidentItem
            {
                RecordingId = r.Id,
                OfficerId = r.OfficerId,
                OfficerName = r.Officer != null ? r.Officer.Name : r.OfficerId,
                Filename = r.Filename,
                MediaType = r.MediaType,
                UploadedAt = r.UploadedAt,
                DurationSec = r.DurationSeconds,
                StationId = r.StationId,
                Score = r.AnalysisResult!.TotalScore,
                Severity = r.AnalysisResult.Severity,
                ToneLabel = r.AnalysisResult.ToneLabel,
                DominantEmotion = r.AnalysisResult.DominantEmotion,
                CriticalCount = r.AnalysisResult.CriticalCount,
                HighCount = r.AnalysisResult.HighCount,
                MediumCount = r.AnalysisResult.MediumCount,
                Violations = r.Violations.Count,
                AiAssessment = r.AnalysisResult.AiAssessment,
            })
            .ToListAsync(ct);

        return new CriticalListResult { Total = total, Page = page, PageSize = pageSize, Items = items };
    }

    public async Task<List<CriticalTrendPoint>> TrendAsync(int days, CancellationToken ct = default)
    {
        days = Math.Clamp(days, 1, 365);
        var since = DateTime.UtcNow.Date.AddDays(-days);

        return await _db.Recordings
            .Where(r => r.AnalysisResult != null
                     && r.AnalysisResult.Severity == "CRITICAL"
                     && r.UploadedAt >= since)
            .GroupBy(r => new { Y = r.UploadedAt.Year, M = r.UploadedAt.Month, D = r.UploadedAt.Day })
            .Select(g => new CriticalTrendPoint
            {
                Date = $"{g.Key.Y:D4}-{g.Key.M:D2}-{g.Key.D:D2}",
                Count = g.Count(),
                AvgScore = g.Average(r => (double)r.AnalysisResult!.TotalScore),
            })
            .OrderBy(x => x.Date)
            .ToListAsync(ct);
    }

    public async Task<List<CriticalByOfficer>> ByOfficerAsync(int limit, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 200);
        return await _db.Recordings
            .Where(r => r.AnalysisResult != null && r.AnalysisResult.Severity == "CRITICAL")
            .GroupBy(r => r.OfficerId)
            .Select(g => new CriticalByOfficer
            {
                OfficerId = g.Key,
                CriticalCount = g.Count(),
                AvgScore = g.Average(r => (double)r.AnalysisResult!.TotalScore),
                LastIncident = g.Max(r => r.UploadedAt),
            })
            .OrderByDescending(x => x.CriticalCount)
            .Take(limit)
            .ToListAsync(ct);
    }
}
