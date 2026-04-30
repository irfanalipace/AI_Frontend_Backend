using Microsoft.AspNetCore.Mvc;
using PERA360.Application.CriticalIncidents;

namespace PERA360.Api.Controllers;

/// <summary>
/// Read endpoints surfacing CRITICAL recordings to the portal.
/// Thin controller; all logic in ICriticalIncidentService.
/// </summary>
[ApiController]
[Route("api/critical")]
public class CriticalIncidentsController : ControllerBase
{
    private readonly ICriticalIncidentService _service;
    public CriticalIncidentsController(ICriticalIncidentService service) => _service = service;

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? mediaType,
        [FromQuery] DateTime? since,
        [FromQuery] DateTime? until,
        [FromQuery] string? officerId,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        CancellationToken ct = default)
        => Ok(await _service.ListAsync(mediaType, since, until, officerId, page, pageSize, ct));

    [HttpGet("trend")]
    public async Task<IActionResult> Trend([FromQuery] int days = 30, CancellationToken ct = default)
        => Ok(await _service.TrendAsync(days, ct));

    [HttpGet("by-officer")]
    public async Task<IActionResult> ByOfficer([FromQuery] int limit = 20, CancellationToken ct = default)
        => Ok(await _service.ByOfficerAsync(limit, ct));
}
