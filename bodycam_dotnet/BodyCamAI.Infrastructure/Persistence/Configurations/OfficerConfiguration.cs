using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using BodyCamAI.Domain.Entities;

namespace BodyCamAI.Infrastructure.Persistence.Configurations;

public class OfficerConfiguration : IEntityTypeConfiguration<Officer>
{
    public void Configure(EntityTypeBuilder<Officer> e)
    {
        e.ToTable("officers");
        e.HasKey(o => o.Id);

        e.Property(o => o.Id).HasMaxLength(32).IsRequired();
        e.Property(o => o.Name).HasMaxLength(128).IsRequired();
        e.Property(o => o.Badge).HasMaxLength(64).IsRequired();
        e.Property(o => o.Area).HasMaxLength(128);
        e.Property(o => o.VoiceprintPath).HasMaxLength(512);

        e.HasIndex(o => o.Badge).IsUnique();
    }
}
