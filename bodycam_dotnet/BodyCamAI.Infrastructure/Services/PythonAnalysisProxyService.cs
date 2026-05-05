using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using BodyCamAI.Application.Common.Interfaces;

namespace BodyCamAI.Infrastructure.Services;

/// <summary>
/// HTTP-level client that uploads an audio file to the Python ML pipeline
/// (POST {BaseUrl}/api/analyze/upload, multipart/form-data with fields
/// "audio" and "officer_id") and returns the rich JSON Python responds with.
///
/// Kept HTTP-level so we don't take on a generated client / OpenAPI deps —
/// the response shape is intentionally opaque from C#'s point of view.
/// </summary>
public class PythonAnalysisProxyService : IPythonAnalysisProxyService
{
    private readonly HttpClient _http;
    private readonly PythonOptions _opts;
    private readonly ILogger<PythonAnalysisProxyService> _log;

    public PythonAnalysisProxyService(
        HttpClient http,
        IOptions<PythonOptions> opts,
        ILogger<PythonAnalysisProxyService> log)
    {
        _http = http;
        _opts = opts.Value;
        _log = log;
        _http.Timeout = TimeSpan.FromSeconds(_opts.TimeoutSeconds);
    }

    public Task<PythonAnalysisProxyResult> AnalyseAudioAsync(
        string audioFilePath, string officerId, CancellationToken ct = default)
        => PostAudioAsync(
            $"{_opts.BaseUrl.TrimEnd('/')}/api/analyze/upload",
            audioFilePath, officerId, ct);

    public Task<PythonAnalysisProxyResult> AnalyseAudioNoGeminiAsync(
        string audioFilePath, string officerId, CancellationToken ct = default)
        => PostAudioAsync(
            $"{_opts.BaseUrl.TrimEnd('/')}/api/analyze/upload_no_gemini",
            audioFilePath, officerId, ct);

    /// <summary>
    /// Shared multipart-POST helper. Both the full and no-Gemini variants
    /// only differ in the URL they hit, so the body, error handling, and
    /// JSON parsing live here once.
    /// </summary>
    private async Task<PythonAnalysisProxyResult> PostAudioAsync(
        string url, string audioFilePath, string officerId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(audioFilePath) || !File.Exists(audioFilePath))
            return PythonAnalysisProxyResult.Fail($"Audio file does not exist: {audioFilePath}");

        try
        {
            await using var fs = File.OpenRead(audioFilePath);
            using var form = new MultipartFormDataContent();

            var fileContent = new StreamContent(fs);
            fileContent.Headers.ContentType = MediaTypeHeaderValue.Parse(GuessMimeType(audioFilePath));
            form.Add(fileContent, "audio", Path.GetFileName(audioFilePath));
            form.Add(new StringContent(officerId), "officer_id");

            _log.LogInformation("Forwarding audio {Path} to Python at {Url} for officer {Officer}",
                audioFilePath, url, officerId);

            // ResponseHeadersRead returns control as soon as the headers
            // arrive, so we can start streaming the body in instead of
            // buffering the whole response before we look at it.
            using var resp = await _http.SendAsync(
                new HttpRequestMessage(HttpMethod.Post, url) { Content = form },
                HttpCompletionOption.ResponseHeadersRead, ct);
            var body = await resp.Content.ReadAsStringAsync(ct);

            if (!resp.IsSuccessStatusCode)
            {
                _log.LogWarning("Python /api/analyze/upload returned {Status}: {Body}",
                    resp.StatusCode, Truncate(body, 800));
                return PythonAnalysisProxyResult.Fail(
                    $"Python pipeline returned {(int)resp.StatusCode}: {Truncate(body, 300)}");
            }

            // Try to parse — if Python returned non-JSON we still want a
            // useful error rather than a raw exception bubbling up.
            try
            {
                var doc = JsonDocument.Parse(body);
                return PythonAnalysisProxyResult.Ok(body, doc.RootElement.Clone());
            }
            catch (JsonException jex)
            {
                _log.LogError(jex, "Python returned non-JSON body: {Body}", Truncate(body, 400));
                return PythonAnalysisProxyResult.Fail(
                    "Python pipeline returned a non-JSON response. Check the Flask server logs.");
            }
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return PythonAnalysisProxyResult.Fail(
                $"Python pipeline timed out after {_http.Timeout.TotalSeconds:F0}s. " +
                "Either the recording is too long or the server is overloaded.");
        }
        catch (HttpRequestException hex)
        {
            return PythonAnalysisProxyResult.Fail(
                $"Could not reach Python backend at {_opts.BaseUrl} — is `python server.py` running? ({hex.Message})");
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Python proxy call failed");
            return PythonAnalysisProxyResult.Fail($"Python proxy call failed: {ex.Message}");
        }
    }

    private static string GuessMimeType(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".wav"  => "audio/wav",
            ".mp3"  => "audio/mpeg",
            ".m4a"  => "audio/mp4",
            ".ogg"  => "audio/ogg",
            ".flac" => "audio/flac",
            ".aac"  => "audio/aac",
            _       => "audio/mpeg",
        };

    private static string Truncate(string s, int max) =>
        string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s[..max] + "...");
}
