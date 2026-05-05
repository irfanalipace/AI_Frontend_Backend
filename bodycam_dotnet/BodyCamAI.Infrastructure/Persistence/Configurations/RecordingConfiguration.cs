using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using BodyCamAI.Domain.Entities;

namespace BodyCamAI.Infrastructure.Persistence.Configurations;

public class RecordingConfiguration : IEntityTypeConfiguration<Recording>
{
    public void Configure(EntityTypeBuilder<Recording> e)
    {
        e.ToTable("recordings");
        e.HasKey(r => r.Id);

        e.Property(r => r.OfficerId).HasMaxLength(32).IsRequired();
        e.Property(r => r.Filename).HasMaxLength(256).IsRequired();
        e.Property(r => r.MediaType).HasMaxLength(16).IsRequired();
        e.Property(r => r.StationId).HasMaxLength(64);
        e.Property(r => r.StoragePath).HasMaxLength(1024);

        e.HasOne(r => r.Officer)
            .WithMany(o => o.Recordings)
            .HasForeignKey(r => r.OfficerId)
            .OnDelete(DeleteBehavior.Restrict);

        e.HasIndex(r => r.UploadedAt);
        e.HasIndex(r => r.OfficerId);
        e.HasIndex(r => r.MediaType);
    }
}
