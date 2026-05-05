using Microsoft.EntityFrameworkCore;
using BodyCamAI.Application;
using BodyCamAI.Infrastructure;
using BodyCamAI.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

// ── Logging ────────────────────────────────────────────────────────
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddDebug();

// ── Layered DI: Infrastructure first (registers DbContext + IBodycamDbContext),
//    then Application (registers use cases + services that depend on the abstraction).
builder.Services.AddInfrastructure(builder.Configuration);
builder.Services.AddApplication();

// ── CORS so the React frontend can talk to us directly ────────────
var corsOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
    ?? new[] { "http://localhost:5173", "http://localhost:3000" };
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(corsOrigins)
     .AllowAnyMethod()
     .AllowAnyHeader()
     .AllowCredentials()));

// ── Controllers + Swagger ──────────────────────────────────────────
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
    // EF nav properties form Recording↔AnalysisResult↔Officer↔Recordings cycles.
    // IgnoreCycles emits null at the back-edge instead of throwing.
    o.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new()
    {
        Title = "BodyCamAI API",
        Version = "v1",
        Description = "Clean-architecture .NET 8 backend for PERA bodycam analysis. Uses Gemini (default: 2.5 Flash-Lite, the latest free multimodal model) for video + audio analysis."
    });
});

// ── Larger upload limits (videos can be hundreds of MB) ─────────────
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 2L * 1024 * 1024 * 1024);

var app = builder.Build();

// ── Pipeline ───────────────────────────────────────────────────────
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "BodyCamAI API v1"));
}
app.UseCors();
app.UseRouting();
app.MapControllers();
app.MapGet("/", () => Results.Redirect("/swagger"));

// ── Auto-apply pending EF migrations on startup (dev convenience) ──
if (app.Environment.IsDevelopment())
{
    try
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BodycamDbContext>();
        db.Database.Migrate();
        app.Logger.LogInformation("MSSQL schema is up to date.");
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Could not apply EF migrations — make sure MSSQL is reachable.");
    }
}

app.Run();
