using Microsoft.EntityFrameworkCore;
using PERA360.Application.Common.Interfaces;
using PERA360.Domain.Entities;

namespace PERA360.Infrastructure.Persistence;

/// <summary>
/// Concrete EF Core DbContext for the bodycam_ai MSSQL schema.
/// Implements IBodycamDbContext so the Application layer never references
/// EF Core directly through a concrete type.
/// </summary>
public class BodycamDbContext : DbContext, IBodycamDbContext
{
    public BodycamDbContext(DbContextOptions<BodycamDbContext> options) : base(options) { }

    public DbSet<Officer>        Officers        => Set<Officer>();
    public DbSet<Recording>      Recordings      => Set<Recording>();
    public DbSet<AnalysisResult> AnalysisResults => Set<AnalysisResult>();
    public DbSet<Violation>      Violations      => Set<Violation>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        // Apply all IEntityTypeConfiguration<T> classes in this assembly.
        mb.ApplyConfigurationsFromAssembly(typeof(BodycamDbContext).Assembly);
        base.OnModelCreating(mb);
    }
}
