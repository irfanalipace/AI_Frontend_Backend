using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PERA360.Application.Common.Interfaces;

namespace PERA360.Infrastructure.Services;

/// <summary>
/// IAudioExtractor implementation that shells out to a system-installed
/// ffmpeg binary. Produces a 16 kHz mono MP3 at 32 kbps — speech-grade
/// fidelity at roughly half the file size of 64 kbps, so encode time
/// drops, network transfer to the Python pipeline / Gemini is much
/// faster, and long recordings comfortably fit any inline-upload caps.
///
/// Speed knobs:
///   -threads 0          — use all available CPU cores for the encode
///   -b:a 32k            — speech-only target bitrate
///   -ac 1 -ar 16000     — mono / 16 kHz, the standard for speech models
///   -fflags +fastseek   — skip slow seek probing on container open
///
/// Resolution order for the ffmpeg binary:
///   1. Ffmpeg:Path from appsettings.json   (most reliable on Windows)
///   2. FFMPEG_PATH environment variable
///   3. Plain "ffmpeg" (PATH lookup by the OS)
/// </summary>
public class FfmpegAudioExtractor : IAudioExtractor
{
    private readonly ILogger<FfmpegAudioExtractor> _log;
    private readonly FfmpegOptions _opts;

    // Cached after first resolution. Path lookup / env-var reads are cheap
    // but happen on the hot path, so memoising them removes a few syscalls
    // per request and a log line that no one reads twice.
    private string? _resolvedFfmpegPath;
    private string? _resolvedFfmpegSource;
    private readonly object _resolveLock = new();

    public FfmpegAudioExtractor(ILogger<FfmpegAudioExtractor> log, IOptions<FfmpegOptions> opts)
    {
        _log = log;
        _opts = opts.Value;
    }

    public async Task<AudioExtractionResult> ExtractAsync(string inputMediaPath, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(inputMediaPath) || !File.Exists(inputMediaPath))
            return AudioExtractionResult.Fail($"Input media file does not exist: {inputMediaPath}");

        // Pick a fresh temp output path. ffmpeg refuses to overwrite without -y,
        // so we generate a name we know is unused.
        var outputPath = Path.Combine(Path.GetTempPath(),
            $"pera_audio_{Guid.NewGuid():N}.mp3");

        var (ffmpegPath, ffmpegSource) = ResolveFfmpegPath();

        // ─ Input-side speed flags (BEFORE -i) ─
        // -fflags +fastseek                skip slow seek probing on open
        // -probesize 32k -analyzeduration 0   stop scanning streams immediately
        //                                  (big win on long mp4 / mkv inputs;
        //                                  default scans up to 5 MB / 5 sec)
        // -threads 0                       use all available CPU cores
        // -thread_queue_size 1024          avoid stalls on slow disks
        //
        // ─ Output-side flags ─
        // -vn -sn -dn                      drop video / subtitle / data streams
        // -ac 1 -ar 16000                  mono / 16 kHz (speech-model standard)
        // -codec:a libmp3lame              MP3 — universally accepted downstream
        // -b:a 32k                         speech bitrate (~4 KB/sec → 1 hr ≈ 14 MB)
        // -y                               overwrite if exists
        // -hide_banner -loglevel error     keep stderr clean for log capture
        var args = $"-hide_banner -loglevel error -fflags +fastseek " +
                   $"-probesize 32k -analyzeduration 0 -threads 0 -thread_queue_size 1024 " +
                   $"-i \"{inputMediaPath}\" " +
                   $"-vn -sn -dn -ac 1 -ar 16000 -codec:a libmp3lame -b:a 32k " +
                   $"-y \"{outputPath}\"";

        var psi = new ProcessStartInfo
        {
            FileName               = ffmpegPath,
            Arguments              = args,
            RedirectStandardError  = true,
            RedirectStandardOutput = true,
            UseShellExecute        = false,
            CreateNoWindow         = true,
        };

        try
        {
            using var proc = Process.Start(psi);
            if (proc is null)
                return AudioExtractionResult.Fail("Failed to start ffmpeg process");

            // Read stderr in parallel so a verbose ffmpeg can't deadlock the pipe.
            var stderrTask = proc.StandardError.ReadToEndAsync();

            await proc.WaitForExitAsync(ct);
            var stderr = await stderrTask;

            if (proc.ExitCode != 0)
            {
                _log.LogWarning("ffmpeg exited with code {Code}. stderr={Stderr}",
                    proc.ExitCode, Truncate(stderr, 800));
                TryDelete(outputPath);
                return AudioExtractionResult.Fail(
                    $"ffmpeg failed (exit {proc.ExitCode}): {Truncate(stderr, 300)}");
            }

            if (!File.Exists(outputPath))
                return AudioExtractionResult.Fail("ffmpeg reported success but produced no output file");

            var size = new FileInfo(outputPath).Length;
            if (size == 0)
            {
                TryDelete(outputPath);
                return AudioExtractionResult.Fail("ffmpeg produced an empty audio file — does the source have an audio track?");
            }

            _log.LogInformation("ffmpeg extracted audio: {InputSize} bytes → {OutSize} bytes ({OutPath})",
                new FileInfo(inputMediaPath).Length, size, outputPath);

            return AudioExtractionResult.Ok(outputPath, size);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // Thrown when the binary itself can't be located.
            return AudioExtractionResult.Fail(
                $"ffmpeg was not found at \"{ffmpegPath}\" (resolved via {ffmpegSource}). " +
                "Set Ffmpeg:Path in appsettings.json to the full ffmpeg.exe location, " +
                "or set the FFMPEG_PATH environment variable, or add ffmpeg to PATH.");
        }
        catch (OperationCanceledException)
        {
            TryDelete(outputPath);
            throw;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Unexpected error while extracting audio with ffmpeg");
            TryDelete(outputPath);
            return AudioExtractionResult.Fail($"Unexpected ffmpeg error: {ex.Message}");
        }
    }

    /// <summary>
    /// Resolves ffmpeg's binary location once per process, memoising the
    /// result. The resolution itself is cheap, but doing it per request
    /// also re-emitted a log line on every analyse call — noisy and wasteful.
    /// </summary>
    private (string Path, string Source) ResolveFfmpegPath()
    {
        if (_resolvedFfmpegPath is not null && _resolvedFfmpegSource is not null)
            return (_resolvedFfmpegPath, _resolvedFfmpegSource);

        lock (_resolveLock)
        {
            if (_resolvedFfmpegPath is not null && _resolvedFfmpegSource is not null)
                return (_resolvedFfmpegPath, _resolvedFfmpegSource);

            string path, source;
            if (!string.IsNullOrWhiteSpace(_opts.Path))
            {
                path = _opts.Path;
                source = "appsettings:Ffmpeg.Path";
            }
            else if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FFMPEG_PATH")))
            {
                path = Environment.GetEnvironmentVariable("FFMPEG_PATH")!;
                source = "FFMPEG_PATH env var";
            }
            else
            {
                path = "ffmpeg";
                source = "PATH lookup";
            }
            _log.LogInformation("Using ffmpeg at \"{Path}\" (resolved via {Source})", path, source);

            _resolvedFfmpegPath = path;
            _resolvedFfmpegSource = source;
            return (path, source);
        }
    }

    private static string Truncate(string s, int max) =>
        string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s[..max] + "...");

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* swallow */ }
    }
}
