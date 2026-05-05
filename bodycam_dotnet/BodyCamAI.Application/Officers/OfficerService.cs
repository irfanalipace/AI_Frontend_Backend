using Microsoft.EntityFrameworkCore;
using BodyCamAI.Application.Common.Interfaces;
using BodyCamAI.Domain.Entities;

namespace BodyCamAI.Application.Officers;

public class OfficerService : IOfficerService
{
    private readonly IBodycamDbContext _db;
    public OfficerService(IBodycamDbContext db) => _db = db;

    public async Task<List<OfficerListItem>> ListAsync(CancellationToken ct = default) =>
        await _db.Officers
            .OrderBy(o => o.Id)
            .Select(o => new OfficerListItem
            {
                Id = o.Id,
                Name = o.Name,
                Badge = o.Badge,
                Area = o.Area,
                Enrolled = o.Enrolled,
                Recordings = o.Recordings.Count,
            })
            .ToListAsync(ct);

    public async Task<Officer?> GetAsync(string id, CancellationToken ct = default) =>
        await _db.Officers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);

    public async Task<(bool ok, string? error, Officer? created)> CreateAsync(Officer officer, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(officer.Id))
            return (false, "Id is required", null);
        if (await _db.Officers.AnyAsync(o => o.Id == officer.Id, ct))
            return (false, $"Officer {officer.Id} already exists", null);

        officer.CreatedAt = DateTime.UtcNow;
        officer.UpdatedAt = DateTime.UtcNow;
        _db.Officers.Add(officer);
        await _db.SaveChangesAsync(ct);
        return (true, null, officer);
    }

    public async Task<Officer?> UpdateAsync(string id, Officer patch, CancellationToken ct = default)
    {
        var existing = await _db.Officers.FirstOrDefaultAsync(o => o.Id == id, ct);
        if (existing is null) return null;
        existing.Name = patch.Name;
        existing.Badge = patch.Badge;
        existing.Area = patch.Area;
        existing.Enrolled = patch.Enrolled;
        existing.VoiceprintPath = patch.VoiceprintPath;
        existing.UpdatedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        return existing;
    }
}
