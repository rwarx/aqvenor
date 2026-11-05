using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace AIClient.Server;

/// <summary>
/// The ceilings that keep one caller from spending more than the user asked for.
/// </summary>
/// <remarks>
/// <para>
/// The two AI endpoints are the cheapest way to turn a loopback socket into an open tab on the
/// user's provider credit: a runaway retry loop, a bug in the editor path, a ghost-text path firing
/// too eagerly. The bearer token closes the door to strangers; this closes the door to the
/// application's own malfunctions. Both limits are deliberate and explicit instead of the implicit
/// Kestrel default.
/// </para>
/// <para>
/// The rate limit partitions by the bearer token, so one caller's loop does not starve the others;
/// unauthenticated requests share a single bucket rather than getting a free pass. 60 requests per
/// minute is generous for a human driving an editor and tight enough to bound a broken loop.
/// </para>
/// </remarks>
public static class SidecarRateLimiting
{
    /// <summary>The policy name, applied to the credit-spending endpoints.</summary>
    public const string AiCompletePolicy = "ai-complete";

    /// <summary>
    /// Explicit ceiling for request bodies. Comfortably above the application's own payloads (the
    /// widest is a file write bounded by <c>AgentSettings.MaxFileBytes</c>, 512 KB by default) and
    /// well below Kestrel's implicit ~30 MB default.
    /// </summary>
    public const long MaxRequestBodyBytes = 16L * 1024 * 1024;

    /// <summary>Registers the rate limiter and its single policy.</summary>
    public static void Configure(IServiceCollection services) =>
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.AddPolicy(AiCompletePolicy, httpContext =>
                RateLimitPartition.GetFixedWindowLimiter(
                    httpContext.Request.Headers.Authorization.ToString() is { Length: > 0 } key
                        ? key
                        : "anonymous",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 60,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                    }));
        });
}
