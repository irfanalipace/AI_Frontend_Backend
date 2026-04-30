using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using PERA360.Domain.Entities;

namespace PERA360.Infrastructure.Persistence.Configurations;

public class ViolationConfiguration : IEntityTypeConfiguration<Violation>
{
    public void Configure(EntityTypeBuilder<Violation> e)
    {
        e.ToTable("violations");
        e.HasKey(v => v.Id);

        e.Property(v => v.Type).HasMaxLength(64).IsRequired();
        e.Property(v => v.Severity).HasMaxLength(16).IsRequired();
        e.Property(v => v.SeverityLabel).HasMaxLength(16);
        e.Property(v => v.Label).HasMaxLength(256);
        e.Property(v => v.KeywordsFound).HasMaxLength(1024);
        e.Property(v => v.Source).HasMaxLength(64);

        e.Property(v => v.Description).HasColumnType("nvarchar(max)");
        e.Property(v => v.Detail).HasColumnType("nvarchar(max)");

        e.HasOne(v => v.Recording)
            .WithMany(r => r.Violations)
            .HasForeignKey(v => v.RecordingId)
            .OnDelete(DeleteBehavior.Cascade);

        e.HasIndex(v => v.Type);
        e.HasIndex(v => v.Severity);
        e.HasIndex(v => v.RecordingId);
    }
}
