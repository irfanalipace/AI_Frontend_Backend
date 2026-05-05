using System.Net;
using System.Net.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using BodyCamAI.Application.Common.Interfaces;
using BodyCamAI.Infrastructure.Persistence;
using BodyCamAI.Infrastructure.Services;

namespace BodyCamAI.Infrastructure;

/// <summary>
/// Wires up DbContext, EF Core and the Gemini HTTP client.
/// The WebApi project only needs to call <c>services.AddInfrastructure(configuration)</c>.
/// </summary>
public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration config)
    {
        // ── EF Core + MSSQL ─────────────────────────────────────────────
        var connStr = config.GetConnectionString("MsSql")
            ?? throw new InvalidOperationException("ConnectionStrings:MsSql is not set");

        services.AddDbContext<BodycamDbContext>(opt =>
            opt.UseSqlServer(connStr,
                sql => sql.EnableRetryOnFailure(maxRetryCount: 3, maxRetryDelay: TimeSpan.FromSeconds(5), errorNumbersToAdd: null)));

        // Application code depends on IBodycamDbContext, not the concrete class.
        services.AddScoped<IBodycamDbContext>(sp => sp.GetRequiredService<BodycamDbContext>());

        // In-memory cache — currently used to skip the officer-existence
        // round trip on repeat uploads from the same officer.
        services.AddMemoryCache();

        // ── Gemini client (default model: 2.5 Flash-Lite, audio inline or Files API) ──
        services.Configure<GeminiOptions>(config.GetSection(GeminiOptions.SectionName));
        services.AddHttpClient<IGeminiAnalysisService, GeminiAnalysisService>()
            .ConfigurePrimaryHttpMessageHandler(BuildFastHandler);

        // ── ffmpeg-backed audio extractor — videos are stripped to a small
        //    16 kHz mono MP3 before they ever leave this server. The Python
        //    pipeline (and Gemini behind it) only sees the audio track.
        services.Configure<FfmpegOptions>(config.GetSection(FfmpegOptions.SectionName));
        services.AddSingleton<IAudioExtractor, FfmpegAudioExtractor>();

        // ── Python ML pipeline proxy — forwards extracted audio to Flask
        //    /api/analyze/upload and returns the rich JSON response.
        services.Configure<PythonOptions>(config.GetSection(PythonOptions.SectionName));
        services.AddHttpClient<IPythonAnalysisProxyService, PythonAnalysisProxyService>()
            .ConfigurePrimaryHttpMessageHandler(BuildFastHandler);

        // ── Folder-watch auto-analysis — drop a video into the configured
        //    inbox and the BackgroundService runs the same pipeline
        //    AnalyseVideoHandler does. Status singleton powers the
        //    "Video Analysis" dashboard menu.
        services.Configure<WatchFolderOptions>(config.GetSection(WatchFolderOptions.SectionName));
        services.AddSingleton<IWatchFolderStatus, WatchFolderStatus>();
        services.AddSingleton<VideoFolderWatcherService>();
        services.AddHostedService(sp => sp.GetRequiredService<VideoFolderWatcherService>());

        return services;
    }

    /// <summary>
    /// Shared HttpMessageHandler tuned for the analysis pipeline:
    ///   • HTTP/2 attempted first, with HTTP/1.1 fallback (Gemini supports H2).
    ///   • Larger connection-per-server pool so concurrent uploads don't queue.
    ///   • Automatic decompression for any gzip'd responses.
    ///   • PooledConnectionLifetime caps DNS staleness in long-running pods.
    /// </summary>
    private static HttpMessageHandler BuildFastHandler() => new SocketsHttpHandler
    {
        AutomaticDecompression  = DecompressionMethods.All,
        MaxConnectionsPerServer = 32,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        EnableMultipleHttp2Connections = true,
    };
}
