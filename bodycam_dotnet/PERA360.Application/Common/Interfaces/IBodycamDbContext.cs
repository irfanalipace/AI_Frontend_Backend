using Microsoft.EntityFrameworkCore;
using PERA360.Domain.Entities;

namespace PERA360.Application.Common.Interfaces;

/// <summary>
/// Application-facing abstraction over the EF Core DbContext.
/// Application code depends on this — never on the concrete DbContext —
/// so the Application project doesn't reference Infrastructure.
/// </summary>
public interface IBodycamDbContext
{
    DbSet<Officer> Officers { get; }
    DbSet<Recording> Recordings { get; }
    DbSet<AnalysisResult> AnalysisResults { get; }
    DbSet<Violation> Violations { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
