using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using PERA360.Domain.Entities;

namespace PERA360.Infrastructure.Persistence.Configurations;

public class AnalysisResultConfiguration : IEntityTypeConfiguration<AnalysisResult>
{
    public void Configure(EntityTypeBuilder<AnalysisResult> e)
    {
        e.ToTable("analysis_results");
        e.HasKey(a => a.Id);

        e.Property(a => a.Severity).HasMaxLength(16).IsRequired();
        e.Property(a => a.ToneLabel).HasMaxLength(32).IsRequired();
        e.Property(a => a.TranscriptionMethod).HasMaxLength(64);
        e.Property(a => a.GreetingCompliance).HasMaxLength(16);
        e.Property(a => a.ExtractedName).HasMaxLength(128);
        e.Property(a => a.ExtractedStation).HasMaxLength(128);
        e.Property(a => a.MatchedOfficerId).HasMaxLength(32);
        e.Property(a => a.DominantEmotion).HasMaxLength(32);
        e.Property(a => a.VisualAnalysisStatus).HasMaxLength(64);

        // Long text columns — MSSQL nvarchar(max).
        e.Property(a => a.TranscriptUrdu).HasColumnType("nvarchar(max)");
        e.Property(a => a.TranscriptEnglish).HasColumnType("nvarchar(max)");
        e.Property(a => a.EmotionNarrative).HasColumnType("nvarchar(max)");
        e.Property(a => a.AiAssessment).HasColumnType("nvarchar(max)");
        e.Property(a => a.RecommendedAction).HasColumnType("nvarchar(max)");
        e.Property(a => a.VisualSummary).HasColumnType("nvarchar(max)");
        e.Property(a => a.VisualAnalysisStatusMessage).HasColumnType("nvarchar(max)");
        e.Property(a => a.RawJson).HasColumnType("nvarchar(max)");

        e.HasOne(a => a.Recording)
            .WithOne(r => r.AnalysisResult)
            .HasForeignKey<AnalysisResult>(a => a.RecordingId)
            .OnDelete(DeleteBehavior.Cascade);

        e.HasIndex(a => a.Severity);
        e.HasIndex(a => a.TotalScore);
    }
}
