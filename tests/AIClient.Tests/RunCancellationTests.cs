using System.Net;
using System.Text.Json;
using AIClient.Infrastructure;
using AIClient.Server;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AIClient.Tests;

public sealed class RunCancellationTests
{
    [Fact]
    public async Task Cancel_response_waits_until_the_run_finishes_its_cleanup()
    {
        await using var host = await CreateApiAsync();
        var runId = Guid.NewGuid();
        var entry = Assert.IsType<RunEntry>(host.Runs.Start(runId));
        var signalled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = entry.Cancellation.Token.Register(() => signalled.TrySetResult());

        var responseTask = host.Client.PostAsync($"/api/runs/{runId}/cancel", null);
        await signalled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(100);
        Assert.False(responseTask.IsCompleted);

        host.Runs.Finish(runId);
        using var response = await responseTask.WaitAsync(TimeSpan.FromSeconds(5));
        await AssertCompletedAsync(response);
    }

    [Fact]
    public async Task Cancel_timeout_reports_still_stopping_and_a_retry_can_confirm_completion()
    {
        await using var host = await CreateApiAsync();
        var runId = Guid.NewGuid();
        var entry = Assert.IsType<RunEntry>(host.Runs.Start(runId));

        using var response = await host.Client.PostAsync($"/api/runs/{runId}/cancel", null)
            .WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.False(body.RootElement.GetProperty("cancelled").GetBoolean());
        Assert.False(body.RootElement.GetProperty("completed").GetBoolean());
        Assert.True(body.RootElement.GetProperty("stopping").GetBoolean());
        Assert.True(entry.Cancellation.IsCancellationRequested);
        Assert.True(host.Runs.TryGet(runId, out _));

        host.Runs.Finish(runId);
        using var retry = await host.Client.PostAsync($"/api/runs/{runId}/cancel", null);
        await AssertCompletedAsync(retry);
    }

    [Fact]
    public async Task A_missing_run_is_already_complete()
    {
        await using var host = await CreateApiAsync();
        using var response = await host.Client.PostAsync($"/api/runs/{Guid.NewGuid()}/cancel", null);
        await AssertCompletedAsync(response);
    }

    [Fact]
    public void A_cancel_reference_obtained_before_finish_remains_safe_after_disposal()
    {
        var registry = new RunRegistry();
        var runId = Guid.NewGuid();
        var entry = Assert.IsType<RunEntry>(registry.Start(runId));
        registry.Finish(runId);

        entry.Cancel();
        registry.Finish(runId);
        Assert.False(registry.TryGet(runId, out _));
    }

    [Fact]
    public async Task Abandoning_a_cancel_request_does_not_confirm_a_run_that_is_still_finishing()
    {
        await using var host = await CreateApiAsync();
        var runId = Guid.NewGuid();
        var entry = Assert.IsType<RunEntry>(host.Runs.Start(runId));
        var signalled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = entry.Cancellation.Token.Register(() => signalled.TrySetResult());
        using var caller = new CancellationTokenSource();

        var responseTask = host.Client.PostAsync($"/api/runs/{runId}/cancel", null, caller.Token);
        await signalled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await caller.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => responseTask);
        Assert.True(host.Runs.TryGet(runId, out _));
        host.Runs.Finish(runId);
    }

    private static async Task AssertCompletedAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.True(body.RootElement.GetProperty("cancelled").GetBoolean());
        Assert.True(body.RootElement.GetProperty("completed").GetBoolean());
    }

    private static async Task<ApiHost> CreateApiAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddInfrastructure(builder.Configuration);
        var runs = new RunRegistry();
        builder.Services.AddSingleton(runs);
        builder.Services.AddSingleton<GraphPersistence>();
        builder.Services.AddSingleton(new SidecarToken("run-cancellation-tests"));
        builder.Services.AddAuthentication(SidecarTokenHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, SidecarTokenHandler>(SidecarTokenHandler.SchemeName, _ => { });
        SidecarAuthorization.Configure(builder.Services);
        var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        RunEndpoints.Map(app);
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var client = new HttpClient { BaseAddress = new Uri(address) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", "run-cancellation-tests");
        return new ApiHost(app, client, runs);
    }

    private sealed record ApiHost(WebApplication App, HttpClient Client, RunRegistry Runs) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() { Client.Dispose(); await App.DisposeAsync(); }
    }
}
