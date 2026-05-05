using Microsoft.AspNetCore.Mvc;
using BodyCamAI.Application.Officers;
using BodyCamAI.Domain.Entities;

namespace BodyCamAI.Api.Controllers;

[ApiController]
[Route("api/officers")]
public class OfficersController : ControllerBase
{
    private readonly IOfficerService _officers;
    public OfficersController(IOfficerService officers) => _officers = officers;

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct) =>
        Ok(await _officers.ListAsync(ct));

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        var o = await _officers.GetAsync(id, ct);
        return o is null ? NotFound() : Ok(o);
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] Officer officer, CancellationToken ct)
    {
        var (ok, err, created) = await _officers.CreateAsync(officer, ct);
        if (!ok) return err == $"Officer {officer.Id} already exists" ? Conflict(new { error = err }) : BadRequest(new { error = err });
        return CreatedAtAction(nameof(Get), new { id = created!.Id }, created);
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] Officer patch, CancellationToken ct)
    {
        var updated = await _officers.UpdateAsync(id, patch, ct);
        return updated is null ? NotFound() : Ok(updated);
    }
}
