namespace PERA360.Domain.Entities;

/// <summary>
/// Enrolled Enforcement Officer (EO).
/// Pure domain entity — no persistence concerns here.
/// </summary>
public class Officer
{
    public string Id { get; set; } = string.Empty;          // e.g. "EO_001"
    public string Name { get; set; } = string.Empty;
    public string Badge { get; set; } = string.Empty;
    public string? Area { get; set; }
    public bool Enrolled { get; set; }
    public string? VoiceprintPath { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public List<Recording> Recordings { get; set; } = new();
}
