using Microsoft.Extensions.DependencyInjection;
using BodyCamAI.Application.Analysis.Commands.AnalyseVideo;
using BodyCamAI.Application.CriticalIncidents;
using BodyCamAI.Application.Officers;
using BodyCamAI.Application.Recordings;

namespace BodyCamAI.Application;

/// <summary>
/// Registers all Application-layer use cases and services. The WebApi project
/// only needs to call <c>services.AddApplication()</c> to wire them up.
/// </summary>
public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        // Use cases
        services.AddScoped<AnalyseVideoHandler>();

        // Application services
        services.AddScoped<IRecordingService, RecordingService>();
        services.AddScoped<IOfficerService, OfficerService>();
        services.AddScoped<ICriticalIncidentService, CriticalIncidentService>();

        return services;
    }
}
