using PERA360.Domain.Entities;

namespace PERA360.Application.Officers;

public interface IOfficerService
{
    Task<List<OfficerListItem>> ListAsync(CancellationToken ct = default);
    Task<Officer?> GetAsync(string id, CancellationToken ct = default);
    Task<(bool ok, string? error, Officer? created)> CreateAsync(Officer officer, CancellationToken ct = default);
    Task<Officer?> UpdateAsync(string id, Officer patch, CancellationToken ct = default);
}

public class OfficerListItem
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Badge { get; set; } = string.Empty;
    public string? Area { get; set; }
    public bool Enrolled { get; set; }
    public int Recordings { get; set; }
}
