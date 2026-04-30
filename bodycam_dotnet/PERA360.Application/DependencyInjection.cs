using Microsoft.Extensions.DependencyInjection;
using PERA360.Application.Analysis.Commands.AnalyseVideo;
using PERA360.Application.CriticalIncidents;
using PERA360.Application.Officers;
using PERA360.Application.Recordings;

namespace PERA360.Application;

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
