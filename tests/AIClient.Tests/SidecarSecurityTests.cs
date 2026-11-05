using AIClient.Server;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace AIClient.Tests;

/// <summary>
/// The two controls that turn a loopback socket from "reachable by anything on the machine" into
/// "reachable only by this application".
/// </summary>
/// <remarks>
/// Both are asserted here rather than only in the wiring, because the failure mode is silence: a
/// rejected token and a refused origin both produce a blank panel and an error toast, and nothing
/// about them is visible in a build. A regression should fail a test, not a support request.
/// </remarks>
public sealed class SidecarSecurityTests
{
    [Theory]
    [InlineData("http://127.0.0.1:45639", true)]
    [InlineData("http://0.0.0.0:45639", false)]
    [InlineData("http://127.0.0.1:45639;http://192.168.1.10:45639", false)]
    public async Task Listener_validates_configuration_before_the_host_starts(string url, bool allowed)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = ["--urls", url] });
        await using var app = builder.Build();
        Assert.Empty(app.Urls);
        if (allowed)
        {
            SidecarCors.Bind(app, NullLogger.Instance);
            Assert.Contains(url, app.Urls);
        }
        else { Assert.Throws<InvalidOperationException>(() => SidecarCors.Bind(app, NullLogger.Instance)); }
    }

    [Fact]
    public async Task Kestrel_endpoint_configuration_cannot_bypass_loopback_validation()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Kestrel:Endpoints:Network:Url"] = "http://0.0.0.0:45639",
        });
        await using var app = builder.Build();
        Assert.Throws<InvalidOperationException>(() => SidecarCors.Bind(app, NullLogger.Instance));
    }

    // ----- the token -----

    [Fact]
    public void A_token_presented_exactly_is_accepted()
    {
        var token = new SidecarToken("s3cret-token-value");

        Assert.True(token.Matches("s3cret-token-value"));
    }

    [Theory]
    [InlineData("s3cret-token-valu")]
    [InlineData("s3cret-token-valueX")]
    [InlineData("S3CRET-TOKEN-VALUE")]
    [InlineData("")]
    [InlineData("Bearer s3cret-token-value")]
    public void Anything_that_is_not_the_token_is_refused(string presented)
    {
        var token = new SidecarToken("s3cret-token-value");

        // The case test is the one worth having: a comparison that folds case would accept a token the
        // sidecar never issued, and `Bearer` is already stripped before this point.
        Assert.False(token.Matches(presented));
    }

    [Fact]
    public void A_generated_token_is_not_a_constant()
    {
        // Two sidecars started in the same second must not share a credential. A hardcoded fallback
        // would make this trivially true to fail, which is why there is no fallback.
        var first = new SidecarToken();
        var second = new SidecarToken();

        Assert.NotEqual(first.Value, second.Value);
        Assert.True(first.Value.Length >= 40, "32 random bytes in base64 is at least 43 characters.");
    }

    [Fact]
    public void A_token_is_long_enough_to_not_be_guessable()
    {
        // 32 bytes of CSPRNG output. Anything shorter and the brute-force cost stops being a real
        // answer to "can a web page guess this".
        var token = new SidecarToken();

        Assert.Equal(44, token.Value.Length);
    }

    // ----- CORS -----

    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("http://127.0.0.1:5173")]
    [InlineData("http://localhost:5173")]
    public void An_origin_this_application_produces_is_allowed(string origin) =>
        Assert.True(SidecarCors.IsAllowedOrigin(origin));

    [Theory]
    [InlineData("https://evil.example.com")]
    [InlineData("http://evil.example.com")]
    [InlineData("http://192.168.1.10:8080")]
    [InlineData("http://10.0.0.5")]
    [InlineData("file:///C:/Users/someone/secret.html")]
    public void An_origin_a_web_page_could_carry_is_refused(string origin)
    {
        // This is the list the previous AllowAnyOrigin() permitted. A page served from any of these
        // origins can reach 127.0.0.1 and read the response, which is what made the missing token
        // matter.
        Assert.False(SidecarCors.IsAllowedOrigin(origin));
    }

    [Fact]
    public void A_non_loopback_http_origin_is_refused_even_on_its_own_host()
    {
        // 127.0.0.1.nip.io resolves to loopback but is not loopback as far as the origin string goes,
        // and an origin check that only compared hostnames would wave it through.
        Assert.False(SidecarCors.IsAllowedOrigin("http://127.0.0.1.nip.io"));
    }

    [Fact]
    public void An_https_loopback_origin_is_refused()
    {
        // The sidecar speaks plain HTTP on one address. An https origin is never ours, and allowing
        // "loopback on any scheme" would be a broader rule than the one the app needs.
        Assert.False(SidecarCors.IsAllowedOrigin("https://127.0.0.1:5173"));
    }

    [Fact]
    public async Task Fallback_policy_requires_token_on_unannotated_routes()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddSingleton(new SidecarToken("rt1-test-token"));
        builder.Services
            .AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(
                SidecarTokenHandler.SchemeName,
                _ => { });
        SidecarAuthorization.Configure(builder.Services);

        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/api/thing", () => Results.Ok(new { ok = true }));
        app.MapGet("/api/health", () => Results.Ok(new { ok = true })).AllowAnonymous();
        await app.StartAsync();

        var address = app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        using var client = new HttpClient { BaseAddress = new Uri(address) };

        // No token: the fallback policy refuses an unannotated route.
        var anonymous = await client.GetAsync("/api/thing");
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, anonymous.StatusCode);

        // The token: the same route answers.
        var authorized = new HttpRequestMessage(HttpMethod.Get, "/api/thing");
        authorized.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "rt1-test-token");
        var tokened = await client.SendAsync(authorized);
        Assert.Equal(System.Net.HttpStatusCode.OK, tokened.StatusCode);

        // The readiness probe is the only anonymous route.
        var health = await client.GetAsync("/api/health");
        Assert.Equal(System.Net.HttpStatusCode.OK, health.StatusCode);
    }

    [Fact]
    public async Task Ai_complete_is_rate_limited_after_sixty_requests_per_minute()
    {
        // The credit-spending endpoints must stop a runaway caller after 60 calls in a minute.
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddSingleton(new SidecarToken("rt4-test-token"));
        builder.Services
            .AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(
                SidecarTokenHandler.SchemeName,
                _ => { });
        SidecarAuthorization.Configure(builder.Services);
        SidecarRateLimiting.Configure(builder.Services);

        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseRateLimiter();
        app.MapGet("/api/ai/complete", () => Results.Ok(new { ok = true }))
            .RequireAuthorization()
            .RequireRateLimiting(SidecarRateLimiting.AiCompletePolicy);
        await app.StartAsync();

        var address = app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        using var client = new HttpClient { BaseAddress = new Uri(address) };

        var ok = 0;
        var limited = 0;
        for (var i = 0; i < 61; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/api/ai/complete");
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "rt4-test-token");
            using var response = await client.SendAsync(request);
            if (response.StatusCode == System.Net.HttpStatusCode.OK) { ok++; }
            else if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests) { limited++; }
        }

        Assert.Equal(60, ok);
        Assert.Equal(1, limited);
    }

    [Fact]
    public async Task A_body_over_the_limit_is_refused_with_413()
    {
        // What Kestrel does once the explicit ceiling is configured; production sets 16 MB.
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 1024);
        builder.Services.AddSingleton(new SidecarToken("rt4-test-token"));
        builder.Services
            .AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(
                SidecarTokenHandler.SchemeName,
                _ => { });
        SidecarAuthorization.Configure(builder.Services);

        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapPost("/api/echo", async (HttpRequest request) =>
        {
            // Kestrel enforces the ceiling when the body is actually read, not before.
            await request.Body.CopyToAsync(Stream.Null);
            return Results.Ok(new { ok = true });
        }).RequireAuthorization();
        await app.StartAsync();

        var address = app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        using var client = new HttpClient { BaseAddress = new Uri(address) };

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/echo")
        {
            Content = new ByteArrayContent(new byte[2048]),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "rt4-test-token");
        using var response = await client.SendAsync(request);

        Assert.Equal(System.Net.HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }
}
