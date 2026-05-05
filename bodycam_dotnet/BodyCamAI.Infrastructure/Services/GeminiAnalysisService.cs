using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using BodyCamAI.Application.Common.Interfaces;
using BodyCamAI.Application.Common.Models;

namespace BodyCamAI.Infrastructure.Services;

/// <summary>
/// Calls the configured Gemini model (default: gemini-2.5-flash-lite, the
/// latest free-tier multimodal model — see GeminiOptions.Model) at
/// https://generativelanguage.googleapis.com with an audio file + a
/// strict response schema, then parses the structured JSON back into
/// the Application-layer DTO.
///
/// Upload paths:
///   • ≤ 18 MB → inline base64 in generateContent (fastest: one round trip).
///   • &gt; 18 MB → Gemini Files API (raw upload), then generateContent
///     references the returned file URI. There is NO size limit on the
///     analysis itself — long bodycam recordings flow through unchanged.
///
/// In the production flow the AnalyseVideoHandler always extracts audio
/// with ffmpeg before calling this service, so Gemini only ever sees
/// audio — never the source video. The video MIME types in
/// <see cref="GuessMimeType"/> are kept as a safety net for any
/// direct callers, but the prompt assumes audio-only.
///
/// Stays HTTP-level so we don't have to take on the Google.Cloud.AI SDK.
/// </summary>
public class GeminiAnalysisService : IGeminiAnalysisService
{
    /// <summary>
    /// Cut-off above which we switch from inline base64 upload to the
    /// Gemini Files API. Inline is capped by Gemini at ~20 MB total
    /// request size; we leave 2 MB of headroom for the prompt + envelope.
    /// </summary>
    private const long InlineMaxBytes = 18L * 1024 * 1024;

    private readonly HttpClient _http;
    private readonly GeminiOptions _opts;
    private readonly ILogger<GeminiAnalysisService> _log;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public GeminiAnalysisService(HttpClient http, IOptions<GeminiOptions> opts, ILogger<GeminiAnalysisService> log)
    {
        _http = http;
        _opts = opts.Value;
        _log = log;
        _http.Timeout = TimeSpan.FromSeconds(_opts.TimeoutSeconds);
    }

    public async Task<GeminiAnalysisResult?> AnalyseMediaAsync(
        string mediaFilePath, string originalFilename, string officerId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(_opts.ApiKey) || _opts.ApiKey.StartsWith("REPLACE"))
        {
            _log.LogError("Gemini:ApiKey is not configured — cannot analyse media");
            return null;
        }

        if (!File.Exists(mediaFilePath))
        {
            _log.LogWarning("Gemini analyse: media path {Path} does not exist", mediaFilePath);
            return null;
        }

        var size = new FileInfo(mediaFilePath).Length;
        var mimeType = GuessMimeType(originalFilename);
        var isVideo = mimeType.StartsWith("video/", StringComparison.OrdinalIgnoreCase);
        var url = $"{_opts.BaseUrl.TrimEnd('/')}/models/{_opts.Model}:generateContent?key={_opts.ApiKey}";

        try
        {
            // Build the parts. Small files go inline; larger files are
            // uploaded once via the Files API and referenced by URI so
            // there is no practical upload-size limit.
            object mediaPart;
            if (size <= InlineMaxBytes)
            {
                var bytes = await File.ReadAllBytesAsync(mediaFilePath, ct);
                mediaPart = new
                {
                    inlineData = new { mimeType = mimeType, data = Convert.ToBase64String(bytes) }
                };
                _log.LogInformation("Gemini inline upload: {Size} bytes, mime={Mime}", size, mimeType);
            }
            else
            {
                var fileUri = await UploadToFilesApiAsync(mediaFilePath, mimeType, ct);
                if (string.IsNullOrEmpty(fileUri))
                {
                    _log.LogWarning("Gemini Files API upload failed for {File} ({Size} bytes)",
                        originalFilename, size);
                    return null;
                }
                mediaPart = new
                {
                    fileData = new { mimeType = mimeType, fileUri = fileUri }
                };
                _log.LogInformation("Gemini Files API upload: {Size} bytes → {Uri}", size, fileUri);
            }

            var requestBody = BuildRequestBody(officerId, mediaPart, isVideo);

            using var content = new StringContent(JsonSerializer.Serialize(requestBody, JsonOpts), Encoding.UTF8, "application/json");
            using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = content, Version = HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionOrLower };
            using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            var body = await resp.Content.ReadAsStringAsync(ct);

            if (!resp.IsSuccessStatusCode)
            {
                _log.LogWarning("Gemini returned {Status}: {Body}", resp.StatusCode,
                    body[..Math.Min(800, body.Length)]);
                return null;
            }

            return ParseGeminiResponse(body);
        }
        catch (TaskCanceledException tex) when (!ct.IsCancellationRequested)
        {
            _log.LogError(tex, "Gemini call timed out after {Sec}s", _http.Timeout.TotalSeconds);
            return null;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Gemini call failed");
            return null;
        }
    }

    /// <summary>
    /// Uploads a media file to the Gemini Files API using the raw single-shot
    /// protocol and returns its file URI. The URI can be referenced directly
    /// in generateContent via fileData, so we never have to base64 the file
    /// into the request body — that's how recordings of any length stay
    /// supported without hitting the 20 MB inline cap.
    ///
    /// Audio files become ACTIVE immediately, so we don't poll. (Long videos
    /// may take a moment to transition; the production flow extracts audio
    /// before this service is called, so polling isn't needed here.)
    /// </summary>
    private async Task<string?> UploadToFilesApiAsync(string mediaFilePath, string mimeType, CancellationToken ct)
    {
        var uploadUrl = $"{_opts.BaseUrl.TrimEnd('/').Replace("/v1beta", "")}/upload/v1beta/files?key={_opts.ApiKey}";

        await using var fs = File.OpenRead(mediaFilePath);
        using var fileContent = new StreamContent(fs);
        fileContent.Headers.ContentType = MediaTypeHeaderValue.Parse(mimeType);

        using var req = new HttpRequestMessage(HttpMethod.Post, uploadUrl)
        {
            Content = fileContent,
            Version = HttpVersion.Version20,
            VersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
        };
        req.Headers.TryAddWithoutValidation("X-Goog-Upload-Protocol", "raw");
        req.Headers.TryAddWithoutValidation("X-Goog-Upload-File-Name", Path.GetFileName(mediaFilePath));

        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            _log.LogWarning("Files API upload failed {Status}: {Body}", resp.StatusCode,
                body[..Math.Min(600, body.Length)]);
            return null;
        }

        using var doc = JsonDocument.Parse(body);
        if (doc.RootElement.TryGetProperty("file", out var file) &&
            file.TryGetProperty("uri", out var uri) &&
            uri.ValueKind == JsonValueKind.String)
        {
            return uri.GetString();
        }
        _log.LogWarning("Files API response missing file.uri: {Body}", body[..Math.Min(400, body.Length)]);
        return null;
    }

    /// <summary>
    /// Maps a filename extension to the MIME type Gemini expects in inlineData.
    /// Defaults to video/mp4 for unknown extensions because the new endpoint
    /// is video-first.
    /// </summary>
    private static string GuessMimeType(string filename) =>
        Path.GetExtension(filename).ToLowerInvariant() switch
        {
            ".mp4"  => "video/mp4",
            ".mov"  => "video/quicktime",
            ".webm" => "video/webm",
            ".mkv"  => "video/x-matroska",
            ".avi"  => "video/x-msvideo",
            ".3gp"  => "video/3gpp",
            ".flv"  => "video/x-flv",
            ".wmv"  => "video/x-ms-wmv",
            ".m4v"  => "video/x-m4v",
            ".wav"  => "audio/wav",
            ".mp3"  => "audio/mpeg",
            ".m4a"  => "audio/mp4",
            ".ogg"  => "audio/ogg",
            ".flac" => "audio/flac",
            _       => "video/mp4",
        };

    /// <summary>
    /// Builds a generateContent request: a single user turn with the media
    /// part (either inlineData base64 or fileData URI) followed by the prompt.
    /// </summary>
    private static object BuildRequestBody(string officerId, object mediaPart, bool isVideo) => new
    {
        contents = new object[]
        {
            new
            {
                role = "user",
                parts = new object[]
                {
                    mediaPart,
                    new { text = BuildPrompt(officerId, isVideo) }
                }
            }
        },
        generationConfig = new
        {
            temperature = 0.2,
            responseMimeType = "application/json",
            responseSchema = ResponseSchema(),
        }
    };

    private static string BuildPrompt(string officerId, bool isVideo)
    {
        var mediaDesc = isVideo
            ? "video clip (with audio) of a bodycam recording"
            : "audio clip of a bodycam recording";
        var visualHint = isVideo
            ? "Use both the visuals (body language, gestures, environment, presence of hand-offs / cash / paperwork) AND the audio when judging severity and violations."
            : "Base your judgement on the audio only.";

        return $$"""
            You are an audit AI for the Punjab Enforcement & Regulatory Authority (PERA).
            The media you have just received is a {{mediaDesc}} of Enforcement Officer {{officerId}}
            interacting with a citizen, mostly in Urdu/Punjabi with code-switched English.
            {{visualHint}}

            Watch/listen to the entire clip and produce a strict JSON object that conforms
            to the provided schema:

            - transcript_urdu: full transcript in Urdu script.
            - transcript_english: an accurate English translation.
            - tone_label: one of NORMAL, HARSH, ANGRY, BRIBE_TONE.
            - tone_percents: integer percentages of speaking time spent in each tone (sum ~100).
            - severity: NORMAL, WARNING, or CRITICAL — your overall judgement.
            - total_score: 0-100 risk score (higher = more concerning).
            - tone_score, kw_score: contributing sub-scores out of total_score.
            - critical_count, high_count, medium_count: count of violations of each severity.
            - emotions: integer percentages 0-100 for each category, plus dominant label and a 1-2 sentence narrative.
            - ai_assessment: 2-4 sentence professional summary of the interaction.
            - recommended_action: e.g. "No action", "Counsel officer", "Escalate to disciplinary panel".
            - violations: array of objects, one per concerning behaviour you detect.
                * type: stable code (RISHWAT, GALI, PROLONGED_SHOUTING, THREAT, INSULT, ABUSE_OF_AUTHORITY, OTHER).
                * severity: CRITICAL, HIGH, MEDIUM, or LOW.
                * label: short human-readable label.
                * description: 1-2 sentences quoting or paraphrasing the offending segment.
                * score: 0-100 contribution to the overall risk.
                * keywords_found: list of trigger words you actually heard.

            If nothing concerning happened, return severity NORMAL, total_score near 0, and an empty violations array.
            Do not include any prose outside the JSON object.
            """;
    }

    /// <summary>
    /// JSON Schema (Gemini's subset of OpenAPI 3.0) used to constrain the response.
    /// </summary>
    private static object ResponseSchema() => new
    {
        type = "OBJECT",
        properties = new Dictionary<string, object>
        {
            ["transcriptUrdu"]    = new { type = "STRING" },
            ["transcriptEnglish"] = new { type = "STRING" },
            ["toneLabel"]         = new { type = "STRING" },
            ["tonePercents"] = new
            {
                type = "OBJECT",
                properties = new Dictionary<string, object>
                {
                    ["normal"]    = new { type = "INTEGER" },
                    ["harsh"]     = new { type = "INTEGER" },
                    ["angry"]     = new { type = "INTEGER" },
                    ["bribeTone"] = new { type = "INTEGER" },
                },
            },
            ["severity"]      = new { type = "STRING" },
            ["totalScore"]    = new { type = "INTEGER" },
            ["toneScore"]     = new { type = "INTEGER" },
            ["kwScore"]       = new { type = "INTEGER" },
            ["criticalCount"] = new { type = "INTEGER" },
            ["highCount"]     = new { type = "INTEGER" },
            ["mediumCount"]   = new { type = "INTEGER" },
            ["emotions"] = new
            {
                type = "OBJECT",
                properties = new Dictionary<string, object>
                {
                    ["dominant"]     = new { type = "STRING" },
                    ["anger"]        = new { type = "INTEGER" },
                    ["frustration"]  = new { type = "INTEGER" },
                    ["contempt"]     = new { type = "INTEGER" },
                    ["intimidation"] = new { type = "INTEGER" },
                    ["fear"]         = new { type = "INTEGER" },
                    ["calm"]         = new { type = "INTEGER" },
                    ["neutral"]      = new { type = "INTEGER" },
                    ["agitation"]    = new { type = "INTEGER" },
                    ["narrative"]    = new { type = "STRING" },
                },
            },
            ["aiAssessment"]      = new { type = "STRING" },
            ["recommendedAction"] = new { type = "STRING" },
            ["violations"] = new
            {
                type = "ARRAY",
                items = new
                {
                    type = "OBJECT",
                    properties = new Dictionary<string, object>
                    {
                        ["type"]          = new { type = "STRING" },
                        ["severity"]      = new { type = "STRING" },
                        ["label"]         = new { type = "STRING" },
                        ["description"]   = new { type = "STRING" },
                        ["score"]         = new { type = "INTEGER" },
                        ["keywordsFound"] = new
                        {
                            type = "ARRAY",
                            items = new { type = "STRING" },
                        },
                    },
                },
            },
        },
        required = new[] { "severity", "totalScore", "toneLabel", "violations" },
    };

    private GeminiAnalysisResult? ParseGeminiResponse(string body)
    {
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("candidates", out var cands) || cands.GetArrayLength() == 0)
        {
            _log.LogWarning("Gemini response had no candidates: {Body}", body[..Math.Min(400, body.Length)]);
            return null;
        }

        var first = cands[0];
        if (!first.TryGetProperty("content", out var content) ||
            !content.TryGetProperty("parts", out var parts) ||
            parts.GetArrayLength() == 0)
        {
            _log.LogWarning("Gemini response missing content.parts");
            return null;
        }

        var sb = new StringBuilder();
        foreach (var p in parts.EnumerateArray())
            if (p.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                sb.Append(t.GetString());

        var jsonText = sb.ToString().Trim();
        if (string.IsNullOrEmpty(jsonText))
        {
            _log.LogWarning("Gemini returned empty text part");
            return null;
        }

        try
        {
            var dto = JsonSerializer.Deserialize<GeminiAnalysisDto>(jsonText, JsonOpts) ?? new GeminiAnalysisDto();
            return new GeminiAnalysisResult
            {
                Analysis  = dto,
                RawJson   = jsonText,
                ModelName = _opts.Model,
            };
        }
        catch (JsonException jex)
        {
            _log.LogError(jex, "Failed to parse Gemini JSON: {Json}", jsonText[..Math.Min(400, jsonText.Length)]);
            return null;
        }
    }
}
