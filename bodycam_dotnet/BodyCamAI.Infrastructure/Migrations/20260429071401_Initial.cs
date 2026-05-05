using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BodyCamAI.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "officers",
                columns: table => new
                {
                    Id = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Badge = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Area = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    Enrolled = table.Column<bool>(type: "bit", nullable: false),
                    VoiceprintPath = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_officers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "recordings",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    OfficerId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Filename = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    MediaType = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    DurationSeconds = table.Column<double>(type: "float", nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    StationId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    UploadedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ProcessedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    StoragePath = table.Column<string>(type: "nvarchar(1024)", maxLength: 1024, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_recordings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_recordings_officers_OfficerId",
                        column: x => x.OfficerId,
                        principalTable: "officers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "analysis_results",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    RecordingId = table.Column<long>(type: "bigint", nullable: false),
                    TotalScore = table.Column<int>(type: "int", nullable: false),
                    ToneScore = table.Column<int>(type: "int", nullable: false),
                    KwScore = table.Column<int>(type: "int", nullable: false),
                    Severity = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    CriticalCount = table.Column<int>(type: "int", nullable: false),
                    HighCount = table.Column<int>(type: "int", nullable: false),
                    MediumCount = table.Column<int>(type: "int", nullable: false),
                    ToneLabel = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    TonePercentNormal = table.Column<int>(type: "int", nullable: true),
                    TonePercentHarsh = table.Column<int>(type: "int", nullable: true),
                    TonePercentAngry = table.Column<int>(type: "int", nullable: true),
                    TonePercentBribe = table.Column<int>(type: "int", nullable: true),
                    TranscriptUrdu = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    TranscriptEnglish = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    TranscriptionMethod = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    EoDetected = table.Column<bool>(type: "bit", nullable: false),
                    EoSimilarity = table.Column<double>(type: "float", nullable: false),
                    AvgPitchHz = table.Column<double>(type: "float", nullable: true),
                    BaselinePitchHz = table.Column<double>(type: "float", nullable: true),
                    PitchRatio = table.Column<double>(type: "float", nullable: true),
                    AvgEnergy = table.Column<double>(type: "float", nullable: true),
                    LoudDurationSec = table.Column<double>(type: "float", nullable: true),
                    Agitation = table.Column<double>(type: "float", nullable: true),
                    GreetingCompliance = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    GreetingScore = table.Column<int>(type: "int", nullable: true),
                    SalamFound = table.Column<bool>(type: "bit", nullable: true),
                    NameIntroduced = table.Column<bool>(type: "bit", nullable: true),
                    StationMentioned = table.Column<bool>(type: "bit", nullable: true),
                    RoleMentioned = table.Column<bool>(type: "bit", nullable: true),
                    ExtractedName = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    ExtractedStation = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    MatchedOfficerId = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    SpeakerCount = table.Column<int>(type: "int", nullable: true),
                    EoTotalSec = table.Column<double>(type: "float", nullable: true),
                    CustomerTotalSec = table.Column<double>(type: "float", nullable: true),
                    EoSegmentsCount = table.Column<int>(type: "int", nullable: true),
                    CustomerSegmentsCount = table.Column<int>(type: "int", nullable: true),
                    DominantEmotion = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    EmotionAnger = table.Column<int>(type: "int", nullable: false),
                    EmotionFrustration = table.Column<int>(type: "int", nullable: false),
                    EmotionContempt = table.Column<int>(type: "int", nullable: false),
                    EmotionIntimidation = table.Column<int>(type: "int", nullable: false),
                    EmotionFear = table.Column<int>(type: "int", nullable: false),
                    EmotionCalm = table.Column<int>(type: "int", nullable: false),
                    EmotionNeutral = table.Column<int>(type: "int", nullable: false),
                    EmotionAgitation = table.Column<int>(type: "int", nullable: false),
                    EmotionNarrative = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    AiAssessment = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    RecommendedAction = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    VisualRiskScore = table.Column<int>(type: "int", nullable: true),
                    VisualSummary = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    BriberyVisualDetected = table.Column<bool>(type: "bit", nullable: true),
                    AggressivePostureDetected = table.Column<bool>(type: "bit", nullable: true),
                    PhysicalContactDetected = table.Column<bool>(type: "bit", nullable: true),
                    ConcealedGesturesDetected = table.Column<bool>(type: "bit", nullable: true),
                    VisualAnalysisStatus = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    VisualAnalysisStatusMessage = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    RawJson = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_analysis_results", x => x.Id);
                    table.ForeignKey(
                        name: "FK_analysis_results_recordings_RecordingId",
                        column: x => x.RecordingId,
                        principalTable: "recordings",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "violations",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    RecordingId = table.Column<long>(type: "bigint", nullable: false),
                    Type = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Severity = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    SeverityLabel = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    SeverityIndex = table.Column<int>(type: "int", nullable: false),
                    Label = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Description = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Detail = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Score = table.Column<int>(type: "int", nullable: false),
                    ImpactPercent = table.Column<double>(type: "float", nullable: false),
                    KeywordsFound = table.Column<string>(type: "nvarchar(1024)", maxLength: 1024, nullable: true),
                    Source = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_violations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_violations_recordings_RecordingId",
                        column: x => x.RecordingId,
                        principalTable: "recordings",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_analysis_results_RecordingId",
                table: "analysis_results",
                column: "RecordingId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_analysis_results_Severity",
                table: "analysis_results",
                column: "Severity");

            migrationBuilder.CreateIndex(
                name: "IX_analysis_results_TotalScore",
                table: "analysis_results",
                column: "TotalScore");

            migrationBuilder.CreateIndex(
                name: "IX_officers_Badge",
                table: "officers",
                column: "Badge",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_recordings_MediaType",
                table: "recordings",
                column: "MediaType");

            migrationBuilder.CreateIndex(
                name: "IX_recordings_OfficerId",
                table: "recordings",
                column: "OfficerId");

            migrationBuilder.CreateIndex(
                name: "IX_recordings_UploadedAt",
                table: "recordings",
                column: "UploadedAt");

            migrationBuilder.CreateIndex(
                name: "IX_violations_RecordingId",
                table: "violations",
                column: "RecordingId");

            migrationBuilder.CreateIndex(
                name: "IX_violations_Severity",
                table: "violations",
                column: "Severity");

            migrationBuilder.CreateIndex(
                name: "IX_violations_Type",
                table: "violations",
                column: "Type");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "analysis_results");

            migrationBuilder.DropTable(
                name: "violations");

            migrationBuilder.DropTable(
                name: "recordings");

            migrationBuilder.DropTable(
                name: "officers");
        }
    }
}
