using Microsoft.AspNetCore.Mvc;
using PERA360.Application.Recordings;

namespace PERA360.Api.Controllers;

/// <summary>
/// Read endpoints for the dashboard — list / detail / stats.
/// Pure controller — all logic lives in IRecordingService.
/// </summary>
[ApiController]
[Route("api/recordings")]
public class RecordingsController : ControllerBase
{
    private readonly IRecordingService _recordings;
    public RecordingsController(IRecordingService recordings) => _recordings = recordings;

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? officerId,
        [FromQuery] string? severity,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        CancellationToken ct = default)
        => Ok(await _recordings.ListAsync(officerId, severity, page, pageSize, ct));

    [HttpGet("{id:long}")]
    public async Task<IActionResult> Detail(long id, CancellationToken ct)
    {
        var rec = await _recordings.DetailAsync(id, ct);
        return rec is null ? NotFound() : Ok(rec);
    }

    [HttpGet("stats")]
    public async Task<IActionResult> Stats(CancellationToken ct)
        => Ok(await _recordings.StatsAsync(ct));
}
