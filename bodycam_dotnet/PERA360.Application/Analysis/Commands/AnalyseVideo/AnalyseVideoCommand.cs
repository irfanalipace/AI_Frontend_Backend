namespace PERA360.Application.Analysis.Commands.AnalyseVideo;

/// <summary>
/// Input to the AnalyseVideo use case.
/// The controller spools the uploaded video to a temp file and hands the path
/// to this command, so the Application layer never touches IFormFile / HTTP types.
/// </summary>
public class AnalyseVideoCommand
{
    public string OfficerId { get; set; } = string.Empty;
    public string OriginalFilename { get; set; } = string.Empty;
    public long OriginalSizeBytes { get; set; }
    public string VideoTempPath { get; set; } = string.Empty;
    public string? StationId { get; set; }
}
